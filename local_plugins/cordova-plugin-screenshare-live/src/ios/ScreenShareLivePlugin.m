/**
 * ============================================================================
 * ScreenShareLivePlugin.m - Implémentation iOS du plugin de partage d'écran
 * ============================================================================
 *
 * ARCHITECTURE GLOBALE :
 * ---------------------
 * Ce plugin implémente deux modes de capture d'écran iOS :
 *
 * 1. MODE BROADCAST EXTENSION (recommandé, style WhatsApp)
 *    • Utilise RPSystemBroadcastPickerView (sélecteur système)
 *    • Capture l'écran COMPLET du téléphone (pas seulement l'app)
 *    • Nécessite une Broadcast Extension iOS séparée
 *    • Communication via App Group (fichiers partagés)
 *    • Plus stable et plus complet
 *
 * 2. MODE IN-APP (fallback)
 *    • Utilise RPScreenRecorder.startCaptureWithHandler
 *    • Capture SEULEMENT l'application en cours
 *    • Pas d'extension iOS nécessaire
 *    • Moins complet (notifications système non capturées)
 *
 * FLUX DE DONNÉES (BROADCAST MODE) :
 * ----------------------------------
 * 1. L'app affiche RPSystemBroadcastPickerView (sélecteur système)
 * 2. L'utilisateur choisit "Cette application" dans le sélecteur
 * 3. iOS lance ScreenShareBroadcastExtension (process séparé)
 * 4. L'extension capture l'écran via ReplayKit
 * 5. L'extension écrit les frames JPEG dans App Group (fichiers partagés)
 * 6. L'extension envoie une notification Darwin à l'app
 * 7. L'app lit le fichier JPEG et l'envoie au JavaScript
 * 8. Le JavaScript dessine sur canvas et crée un MediaStream
 * 9. WebRTC transmet via replaceTrack()
 *
 * COMMUNICATION APP GROUP :
 * ------------------------
 * • App Group : group.com.callapp.terminal.screenshare
 * • Fichiers partagés :
 *   - latest_frame.jpg : La dernière frame capturée
 *   - frame_meta.plist : Métadonnées (numéro de séquence, stop flag)
 *   - stop_request : Fichier vide pour demander l'arrêt à l'extension
 * • Notification Darwin : com.callapp.terminal.screenshare.frame
 *   (déclenchée par l'extension quand une nouvelle frame est disponible)
 *
 * CONFIGURATION REQUISE :
 * -----------------------
 * 1. App Group configuré dans Xcode (Signing & Capabilities)
 * 2. Broadcast Extension créée avec le même App Group
 * 3. Bundle ID de l'extension : com.callapp.terminal.ScreenShareBroadcast
 * 4. Entitlements activés pour l'extension
 * ============================================================================
 */

#import "ScreenShareLivePlugin.h"
#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <ImageIO/ImageIO.h>

// ============================================================================
// CONSTANTES - Identifiants pour App Group et communication
// ============================================================================

// Identifiant App Group — DOIT être identique dans l'extension et dans Xcode
// (Signing & Capabilities → App Groups)
static NSString * const kAppGroupId = @"group.com.callapp.terminal.screenshare";

// Nom du fichier contenant la dernière frame JPEG
static NSString * const kFrameFileName = @"latest_frame.jpg";

// Nom du fichier contenant les métadonnées (numéro de séquence, stop flag)
static NSString * const kMetaFileName = @"frame_meta.plist";

// Nom de la notification Darwin envoyée par l'extension
static NSString * const kDarwinNotificationName = @"com.callapp.terminal.screenshare.frame";

// Fichier déposé par l'app pour demander à l'extension de terminer la diffusion
static NSString * const kStopRequestFileName = @"stop_request";

// ============================================================================
// INTERFACE PRIVÉE - Propriétés internes du plugin
// ============================================================================

@interface ScreenShareLivePlugin ()

// Commande start en cours (pour les callbacks keepCallback)
@property (nonatomic, strong) CDVInvokedUrlCommand *startCommand;

// RPScreenRecorder (pour le mode in-app uniquement)
@property (nonatomic, strong) RPScreenRecorder *screenRecorder;

// Queue de traitement pour les frames (mode in-app)
@property (nonatomic, strong) NSOperationQueue *processQueue;

// Configuration de capture
@property (nonatomic, assign) CGFloat maxWidth;      // Largeur maximale de redimensionnement
@property (nonatomic, assign) NSInteger maxFps;      // Frames par seconde maximum
@property (nonatomic, assign) CGFloat jpegQuality;   // Qualité JPEG (0.0-1.0)

// État de capture
@property (nonatomic, strong) NSDate *lastFrameTime; // Dernière frame envoyée (pour limiter FPS)
@property (nonatomic, assign) BOOL isCapturing;      // true si capture en cours
@property (nonatomic, strong) NSTimer *pollTimer;    // Timer pour vérifier les frames (broadcast mode)
@property (nonatomic, assign) NSInteger lastFrameSequence; // Numéro de séquence de la dernière frame

// UI pour le sélecteur de broadcast
@property (nonatomic, strong) UIView *broadcastPickerContainer;

// Configuration du mode
@property (nonatomic, assign) BOOL useBroadcastExtension; // true = broadcast mode, false = in-app
@property (nonatomic, assign) BOOL didSendStarted;         // true si "started" déjà envoyé au JS

@end

// ============================================================================
// IMPLÉMENTATION
// ============================================================================

@implementation ScreenShareLivePlugin

/**
 * pluginInitialize - Initialisation du plugin au chargement
 */
- (void)pluginInitialize {
    [super pluginInitialize];

    // Initialiser la queue de traitement (une seule frame à la fois)
    self.processQueue = [[NSOperationQueue alloc] init];
    self.processQueue.maxConcurrentOperationCount = 1;
    self.processQueue.name = @"ScreenShareLive.process";

    // Valeurs par défaut de configuration
    self.maxWidth = 720.0;      // Réduire à 720px pour réduire la bande passante
    self.maxFps = 10;          // 10 FPS suffisant pour le partage d'écran
    self.jpegQuality = 0.55;   // Qualité JPEG 55% (bon compromis)

    // État initial
    self.lastFrameTime = [NSDate date];
    self.isCapturing = NO;
    self.lastFrameSequence = 0;

    // Mode WhatsApp (écran système complet) par défaut
    // Utilise Broadcast Extension pour capturer tout l'écran
    self.useBroadcastExtension = YES;
}

#pragma mark - Public API (méthodes appelées depuis JavaScript)

/**
 * ==========================================================================
 * isAvailable - Vérifie si ReplayKit est disponible
 * ==========================================================================
 *
 * Vérifie si l'appareil supporte ReplayKit et si la capture d'écran est possible.
 * ReplayKit nécessite iOS 11.0+ et un appareil compatible.
 *
 * @param command Commande Cordova vide
 */
- (void)isAvailable:(CDVInvokedUrlCommand*)command {
    BOOL available = NO;
    if (@available(iOS 11.0, *)) {
        available = [RPScreenRecorder sharedRecorder].isAvailable;
    }
    CDVPluginResult *result = [CDVPluginResult resultWithStatus:CDVCommandStatus_OK messageAsBool:available];
    [self.commandDelegate sendPluginResult:result callbackId:command.callbackId];
}

/**
 * ==========================================================================
 * start - Démarre la capture d'écran
 * ==========================================================================
 *
 * Démarre la capture d'écran selon le mode configuré :
 * • useBroadcast=true : Mode Broadcast Extension (écran complet, style WhatsApp)
 * • useBroadcast=false : Mode In-App (capture de l'app seulement)
 *
 * OPTIONS :
 * ---------
 * • maxWidth : Largeur maximale de redimensionnement (défaut 720)
 * • maxFps : Frames par seconde maximum (défaut 10)
 * • jpegQuality : Qualité JPEG 0-100 ou 0-1 (défaut 55)
 * • useBroadcast : true pour broadcast mode, false pour in-app (défaut true)
 *
 * @param command Commande Cordova avec les options
 */
- (void)start:(CDVInvokedUrlCommand*)command {
    // Empêcher le démarrage multiple
    if (self.isCapturing || self.startCommand) {
        CDVPluginResult *result = [CDVPluginResult resultWithStatus:CDVCommandStatus_ERROR
                                                    messageAsString:@"Screen share already started"];
        [self.commandDelegate sendPluginResult:result callbackId:command.callbackId];
        return;
    }

    // Sauvegarder la commande pour les callbacks keepCallback
    self.startCommand = command;

    // Lire les options depuis la commande
    NSDictionary *options = nil;
    if (command.arguments.count > 0) {
        id arg = [command.arguments objectAtIndex:0];
        if ([arg isKindOfClass:[NSDictionary class]]) options = arg;
    }

    // Appliquer les options de configuration
    if (options) {
        if (options[@"maxWidth"]) self.maxWidth = [options[@"maxWidth"] floatValue];
        if (options[@"maxFps"]) self.maxFps = [options[@"maxFps"] integerValue];
        if (options[@"jpegQuality"]) {
            CGFloat q = [options[@"jpegQuality"] floatValue];
            // Normaliser : si > 1.0, c'est en pourcentage (0-100), sinon c'est 0-1
            self.jpegQuality = (q > 1.0) ? (q / 100.0) : q;
        }
        if (options[@"useBroadcast"] != nil) {
            self.useBroadcastExtension = [options[@"useBroadcast"] boolValue];
        }
    }

    // Vérifier la version iOS et démarrer le mode approprié
    if (@available(iOS 11.0, *)) {
        if (self.useBroadcastExtension) {
            [self startBroadcastMode];  // Mode Broadcast Extension (écran complet)
        } else {
            [self startInAppCaptureMode];  // Mode In-App (app seulement)
        }
    } else {
        [self sendError:@"iOS 11.0+ required for screen sharing"];
    }
}

/**
 * ==========================================================================
 * stop - Arrête la capture d'écran
 * ==========================================================================
 *
 * Arrête la capture en cours et libère toutes les ressources :
 * • Arrête le timer de polling (broadcast mode)
 * • Désenregistre les notifications Darwin
 * • Arrête RPScreenRecorder (in-app mode)
 * • Demande à l'extension de terminer (broadcast mode)
 * • Nettoie l'UI du sélecteur
 *
 * @param command Commande Cordova vide
 */
- (void)stop:(CDVInvokedUrlCommand*)command {
    [self stopCaptureInternal];
    CDVPluginResult *result = [CDVPluginResult resultWithStatus:CDVCommandStatus_OK messageAsString:@"stopped"];
    [self.commandDelegate sendPluginResult:result callbackId:command.callbackId];
}

#pragma mark - Mode Broadcast Extension (WhatsApp style — écran complet du téléphone)

/**
 * ==========================================================================
 * startBroadcastMode - Démarre le mode Broadcast Extension
 * ==========================================================================
 *
 * Ce mode utilise RPSystemBroadcastPickerView pour capturer l'écran COMPLET
 * du téléphone, y compris les notifications et autres applications.
 *
 * PROCESSUS :
 * ----------
 * 1. Réinitialiser l'état (numéro de séquence, flags)
 * 2. Vérifier que l'App Group est configuré
 * 3. Nettoyer les fichiers de l'extension
 * 4. Afficher le sélecteur de broadcast (sélecteur système iOS)
 * 5. Démarrer l'écoute des notifications Darwin
 * 6. L'utilisateur choisit "Cette application" dans le sélecteur
 * 7. iOS lance l'extension qui commence à capturer
 * 8. L'extension écrit les frames dans App Group
 * 9. L'extension envoie une notification pour chaque frame
 * 10. L'app lit la frame et l'envoie au JavaScript
 *
 * COMMUNICATION APP GROUP :
 * ------------------------
 * L'extension et l'app communiquent via des fichiers partagés dans App Group :
 * • latest_frame.jpg : La dernière frame JPEG capturée
 * • frame_meta.plist : Métadonnées (numéro de séquence pour éviter les doublons)
 * • stop_request : Fichier vide pour demander l'arrêt à l'extension
 */
- (void)startBroadcastMode {
    // Repartir d'un état propre : sinon le « stop » et le numéro de frame de la session
    // précédente font arrêter tout de suite / ignorer les frames de la nouvelle diffusion.
    self.lastFrameSequence = 0;
    self.didSendStarted = NO;

    // Obtenir l'URL du App Group (dossier partagé entre app et extension)
    NSURL *groupURL = [[NSFileManager defaultManager] containerURLForSecurityApplicationGroupIdentifier:kAppGroupId];
    if (!groupURL) {
        [self sendError:@"App Group group.com.callapp.terminal.screenshare non configuré (voir README_IOS.md)"];
        return;
    }

    // Nettoyer les fichiers de la session précédente
    [[NSFileManager defaultManager] removeItemAtURL:[groupURL URLByAppendingPathComponent:kStopRequestFileName] error:nil];
    [@{@"seq": @0, @"stop": @NO} writeToURL:[groupURL URLByAppendingPathComponent:kMetaFileName] atomically:YES];

    // Marquer comme capturant
    self.isCapturing = YES;

    // Exécuter sur le thread principal pour l'UI
    dispatch_async(dispatch_get_main_queue(), ^{
        [self showBroadcastPicker];      // Afficher le sélecteur système
        [self startListeningForExtensionFrames];  // Écouter les notifications de l'extension
    });

    // Note : "started" est envoyé à la première frame reçue (après le choix dans le sheet système)
}

/**
 * ==========================================================================
 * showBroadcastPicker - Affiche le sélecteur de broadcast système
 * ==========================================================================
 *
 * Affiche RPSystemBroadcastPickerView (le sélecteur iOS standard).
 * L'utilisateur peut choisir :
 * • "Cette application" - Capture l'écran complet (ce qu'on veut)
 * • "Microphone" - (désactivé ici, on ne veut que l'écran)
 *
 * AUTO-DÉCLENCHEMENT :
 * ------------------
 * Pour une expérience fluide comme WhatsApp, on simule un clic sur le bouton
 * du sélecteur pour ouvrir automatiquement le sheet système de choix.
 *
 * @note Le sélecteur est affiché pendant 1 seconde puis supprimé (invisibilité)
 */
- (void)showBroadcastPicker {
    // Nettoyer un sélecteur existant
    if (self.broadcastPickerContainer) {
        [self.broadcastPickerContainer removeFromSuperview];
    }

    // Créer un container invisible au centre de l'écran
    UIView *parent = self.viewController.view;
    UIView *container = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 44, 44)];
    container.center = CGPointMake(parent.bounds.size.width / 2.0, parent.bounds.size.height / 2.0);
    container.backgroundColor = [UIColor clearColor];
    container.userInteractionEnabled = YES;
    [parent addSubview:container];
    self.broadcastPickerContainer = container;

    // Créer RPSystemBroadcastPickerView (iOS 12+)
    if (@available(iOS 12.0, *)) {
        RPSystemBroadcastPickerView *picker = [[RPSystemBroadcastPickerView alloc] initWithFrame:container.bounds];

        // Bundle Identifier de l'extension (DOIT correspondre à l'extension créée dans Xcode)
        picker.preferredExtension = @"com.callapp.terminal.ScreenShareBroadcast";

        // Désactiver le bouton microphone (on ne veut que l'écran)
        picker.showsMicrophoneButton = NO;

        [container addSubview:picker];

        // Auto-déclenchement du sheet système (expérience fluide comme WhatsApp)
        // On trouve le bouton UIButton dans les subviews et on simule un clic
        for (UIView *sub in picker.subviews) {
            if ([sub isKindOfClass:[UIButton class]]) {
                [(UIButton *)sub sendActionsForControlEvents:UIControlEventTouchUpInside];
                break;
            }
        }

        // Supprimer le container après 1 seconde (le sheet système reste ouvert)
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            [container removeFromSuperview];
            self.broadcastPickerContainer = nil;
        });
    } else {
        // iOS 11 : RPSystemBroadcastPickerView n'existe pas, fallback vers in-app
        [self startInAppCaptureMode];
    }
}

/**
 * ==========================================================================
 * startListeningForExtensionFrames - Configure l'écoute des frames
 * ==========================================================================
 *
 * Configure deux mécanismes pour détecter les nouvelles frames de l'extension :
 *
 * 1. NOTIFICATION DARWIN :
 *    • L'extension envoie une notification quand une nouvelle frame est disponible
 *    • CFNotificationCenter (Darwin Notify Center) est utilisé pour la communication
 *    • Fonctionne même si l'app est en arrière-plan
 *
 * 2. TIMER DE POLLING :
 *    • Vérifie périodiquement (80ms) si une nouvelle frame est disponible
 *    • Fallback en cas de notification manquée
 *    • Lit le fichier meta.plist pour connaître le numéro de séquence
 *
 * Pourquoi les deux ? Les notifications Darwin sont plus rapides mais peuvent
 * parfois être manquées. Le polling garantit qu'on ne rate pas de frames.
 */
- (void)startListeningForExtensionFrames {
    // Enregistrer l'observateur pour les notifications Darwin
    CFNotificationCenterRef center = CFNotificationCenterGetDarwinNotifyCenter();
    CFNotificationCenterAddObserver(center,
                                    (__bridge const void *)(self),
                                    onFrameNotification,  // Callback quand notification reçue
                                    (__bridge CFStringRef)kDarwinNotificationName,
                                    NULL,
                                    CFNotificationSuspensionBehaviorDeliverImmediately);

    // Démarrer le timer de polling (vérifie toutes les 80ms)
    self.pollTimer = [NSTimer scheduledTimerWithTimeInterval:0.08
                                                      target:self
                                                    selector:@selector(pollLatestFrame)
                                                    userInfo:nil
                                                     repeats:YES];
}

/**
 * Callback appelé quand une notification Darwin est reçue de l'extension
 * (déclenchée quand une nouvelle frame est disponible)
 */
static void onFrameNotification(CFNotificationCenterRef center, void *observer, CFStringRef name, const void *object, CFDictionaryRef userInfo) {
    ScreenShareLivePlugin *plugin = (__bridge ScreenShareLivePlugin *)observer;
    dispatch_async(dispatch_get_main_queue(), ^{
        [plugin pollLatestFrame];  // Lire la frame immédiatement
    });
}

/**
 * ==========================================================================
 * pollLatestFrame - Lit la dernière frame depuis App Group
 * ==========================================================================
 *
 * Cette méthode est appelée par :
 * • La notification Darwin (quand l'extension signale une nouvelle frame)
 * • Le timer de polling (périodiquement toutes les 80ms)
 *
 * PROCESSUS :
 * ----------
 * 1. Lire le fichier meta.plist pour connaître le numéro de séquence
 * 2. Si le numéro n'a pas changé → frame déjà traitée, ignorer
 * 3. Si le flag "stop" est présent → l'extension a arrêté, arrêter aussi
 * 4. Lire le fichier latest_frame.jpg
 * 5. Vérifier le FPS (ne pas envoyer trop de frames)
 * 6. Convertir en base64 et envoyer au JavaScript
 *
 * NUMÉRO DE SÉQUENCE :
 * -------------------
 * L'extension incrémente un compteur pour chaque frame.
 * Cela permet d'éviter d'envoyer plusieurs fois la même frame
 * (le polling peut lire le même fichier plusieurs fois).
 */
- (void)pollLatestFrame {
    // Ne rien faire si pas en capture ou pas de commande active
    if (!self.isCapturing || !self.startCommand) return;

    // Obtenir l'URL du App Group
    NSURL *groupURL = [[NSFileManager defaultManager] containerURLForSecurityApplicationGroupIdentifier:kAppGroupId];
    if (!groupURL) return;

    // URLs des fichiers partagés
    NSURL *metaURL = [groupURL URLByAppendingPathComponent:kMetaFileName];
    NSURL *frameURL = [groupURL URLByAppendingPathComponent:kFrameFileName];

    // Lire les métadonnées (numéro de séquence, stop flag)
    NSDictionary *meta = [NSDictionary dictionaryWithContentsOfURL:metaURL];
    if (!meta) return;

    // Si l'extension a signalé un arrêt (stop flag = true)
    if ([meta[@"stop"] boolValue]) {
        [self sendSuccess:@"stopped"];
        [self stopCaptureInternal];
        return;
    }

    // Vérifier le numéro de séquence pour éviter les doublons
    NSInteger seq = [meta[@"seq"] integerValue];
    if (seq <= self.lastFrameSequence) return;  // Frame déjà traitée
    self.lastFrameSequence = seq;

    // Envoyer "started" au JavaScript à la première frame reçue
    // (après que l'utilisateur a choisi dans le sélecteur système)
    if (!self.didSendStarted) {
        self.didSendStarted = YES;
        [self sendSuccess:@"started"];
    }

    // Lire le fichier JPEG de la frame
    NSData *jpegData = [NSData dataWithContentsOfURL:frameURL];
    if (!jpegData || jpegData.length < 100) return;  // Ignorer les fichiers vides/corrompus

    // Limiter le FPS (ne pas envoyer plus de maxFps frames par seconde)
    NSDate *now = [NSDate date];
    NSTimeInterval minInterval = 1.0 / MAX(1, self.maxFps);
    if ([now timeIntervalSinceDate:self.lastFrameTime] < minInterval) return;
    self.lastFrameTime = now;

    // Convertir en base64 et envoyer au JavaScript
    NSString *base64 = [jpegData base64EncodedStringWithOptions:0];
    [self sendFrame:base64];
}

#pragma mark - Mode In-App (fallback - capture de l'app seulement)

/**
 * ==========================================================================
 * startInAppCaptureMode - Démarre le mode In-App
 * ==========================================================================
 *
 * Fallback utilisé si Broadcast Extension n'est pas disponible ou désactivé.
 * Capture SEULEMENT l'application en cours (pas les notifications ni autres apps).
 *
 * DIFFÉRENCES AVEC BROADCAST MODE :
 * --------------------------------
 * • Plus simple (pas d'extension iOS nécessaire)
 * • Capture seulement l'app (pas l'écran complet)
 * • Ne capture pas les notifications système
 * • Ne capture pas les autres applications
 *
 * UTILISATION :
 * -------------
 * • iOS 11 (Broadcast Extension non disponible)
 * • Tests/Développement (plus simple à configurer)
 * • Cas où on ne veut capturer que l'app
 */
- (void)startInAppCaptureMode {
    RPScreenRecorder *recorder = [RPScreenRecorder sharedRecorder];
    if (!recorder.isAvailable) {
        [self sendError:@"Screen recording not available on this device"];
        return;
    }

    // Configurer le délégué pour recevoir les événements ReplayKit
    recorder.delegate = self;
    self.screenRecorder = recorder;

    // Démarrer la capture avec un handler pour chaque frame
    __weak typeof(self) weakSelf = self;
    [recorder startCaptureWithHandler:^(CMSampleBufferRef sampleBuffer, RPSampleBufferType bufferType, NSError *error) {
        // Handler appelé pour chaque frame capturée
        if (error || !sampleBuffer) return;
        if (bufferType == RPSampleBufferTypeVideo) {
            [weakSelf processVideoSampleBuffer:sampleBuffer];
        }
    } completionHandler:^(NSError *error) {
        // CompletionHandler appelé quand la capture démarre ou échoue
        if (error) {
            [weakSelf sendError:[NSString stringWithFormat:@"Failed to start: %@", error.localizedDescription]];
        } else {
            weakSelf.isCapturing = YES;
            [weakSelf sendSuccess:@"started"];
        }
    }];
}

/**
 * ==========================================================================
 * processVideoSampleBuffer - Traite une frame vidéo (mode in-app)
 * ==========================================================================
 *
 * Convertit un CMSampleBuffer (frame brute ReplayKit) en JPEG base64.
 *
 * PROCESSUS :
 * ----------
 * 1. Vérifier le FPS (limiter à maxFps)
 * 2. Extraire CVPixelBuffer du CMSampleBuffer
 * 3. Convertir en CIImage (Core Image)
 * 4. Redimensionner si nécessaire (maxWidth)
 * 5. Convertir en UIImage
 * 6. Compresser en JPEG
 * 7. Encoder en base64
 * 8. Envoyer au JavaScript
 *
 * OPTIMISATIONS :
 * --------------
 * • Utilise le GPU pour le rendu (kCIContextUseSoftwareRenderer: NO)
 * • Limite le FPS pour réduire la charge CPU
 * • Redimensionne pour réduire la taille des données
 *
 * @param sampleBuffer Frame vidéo brute de ReplayKit
 */
- (void)processVideoSampleBuffer:(CMSampleBufferRef)sampleBuffer {
    // Limiter le FPS
    NSDate *now = [NSDate date];
    NSTimeInterval minInterval = 1.0 / MAX(1, self.maxFps);
    if ([now timeIntervalSinceDate:self.lastFrameTime] < minInterval) return;
    self.lastFrameTime = now;

    // Extraire le buffer de pixel de la frame
    CVImageBufferRef imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (!imageBuffer) return;

    // Verrouiller le buffer en lecture seule
    CVPixelBufferLockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);

    size_t width = CVPixelBufferGetWidth(imageBuffer);
    size_t height = CVPixelBufferGetHeight(imageBuffer);
    if (width == 0 || height == 0) {
        CVPixelBufferUnlockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
        return;
    }

    // Convertir en CIImage
    CIImage *ciImage = [CIImage imageWithCVPixelBuffer:imageBuffer];
    CVPixelBufferUnlockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);

    // Calculer le facteur de redimensionnement
    CGFloat scale = 1.0;
    if ((CGFloat)width > self.maxWidth) {
        scale = self.maxWidth / (CGFloat)width;
    }

    // Créer un contexte Core Image (utilise le GPU si disponible)
    CIContext *context = [CIContext contextWithOptions:@{kCIContextUseSoftwareRenderer: @NO}];
    CGImageRef cgImage = [context createCGImage:ciImage fromRect:ciImage.extent];
    if (!cgImage) return;

    // Convertir en UIImage
    UIImage *image = [UIImage imageWithCGImage:cgImage scale:1.0 orientation:UIImageOrientationUp];
    CGImageRelease(cgImage);

    // Redimensionner si nécessaire
    if (scale < 1.0 - 0.001) {
        CGSize newSize = CGSizeMake(image.size.width * scale, image.size.height * scale);
        image = [self resizeImage:image toSize:newSize];
    }

    // Compresser en JPEG
    NSData *jpegData = UIImageJPEGRepresentation(image, self.jpegQuality);
    if (!jpegData) return;

    // Encoder en base64 et envoyer
    NSString *base64 = [jpegData base64EncodedStringWithOptions:0];
    [self sendFrame:base64];
}

/**
 * ==========================================================================
 * resizeImage - Redimensionne une UIImage
 * ==========================================================================
 *
 * Redimensionne une image à une nouvelle taille en utilisant UIGraphics.
 * Garde la qualité avec un scale de 1.0.
 *
 * @param image Image à redimensionner
 * @param newSize Nouvelle taille
 * @return Image redimensionnée (ou l'originale si échec)
 */
- (UIImage *)resizeImage:(UIImage *)image toSize:(CGSize)newSize {
    UIGraphicsBeginImageContextWithOptions(newSize, YES, 1.0);
    [image drawInRect:CGRectMake(0, 0, newSize.width, newSize.height)];
    UIImage *resized = UIGraphicsGetImageFromCurrentImageContext();
    UIGraphicsEndImageContext();
    return resized ?: image;
}

#pragma mark - Stop

/**
 * ==========================================================================
 * stopCaptureInternal - Arrête la capture et libère les ressources
 * ==========================================================================
 *
 * Arrête tous les mécanismes de capture et nettoie les ressources :
 *
 * BROADCAST MODE :
 * ---------------
 * • Arrête le timer de polling
 * • Désenregistre l'observateur de notifications Darwin
 * • Crée le fichier stop_request pour signaler à l'extension de s'arrêter
 * • Supprime l'UI du sélecteur
 *
 * IN-APP MODE :
 * -------------
 * • Arrête RPScreenRecorder
 * • Libère les ressources ReplayKit
 *
 * COMMUN :
 * --------
 * • Réinitialise l'état de capture
 * • Nettoie la commande start
 */
- (void)stopCaptureInternal {
    // Marquer comme non capturant
    self.isCapturing = NO;

    // Arrêter le timer de polling (broadcast mode)
    [self.pollTimer invalidate];
    self.pollTimer = nil;

    // Désenregistrer l'observateur de notifications Darwin
    CFNotificationCenterRef center = CFNotificationCenterGetDarwinNotifyCenter();
    CFNotificationCenterRemoveObserver(center, (__bridge const void *)(self), (__bridge CFStringRef)kDarwinNotificationName, NULL);

    // Arrêter RPScreenRecorder (in-app mode)
    if (self.screenRecorder && [self.screenRecorder isRecording]) {
        [self.screenRecorder stopCaptureWithHandler:nil];
    }
    self.screenRecorder = nil;

    // Nettoyer l'UI du sélecteur
    if (self.broadcastPickerContainer) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self.broadcastPickerContainer removeFromSuperview];
            self.broadcastPickerContainer = nil;
        });
    }

    // Demander à l'extension de terminer la diffusion (broadcast mode)
    // L'extension vérifie ce fichier et arrête la capture
    // Cela fait disparaître la barre rouge de broadcast en haut de l'écran
    NSURL *groupURL = [[NSFileManager defaultManager] containerURLForSecurityApplicationGroupIdentifier:kAppGroupId];
    if (groupURL && self.useBroadcastExtension) {
        [[NSData data] writeToURL:[groupURL URLByAppendingPathComponent:kStopRequestFileName] atomically:YES];
    }

    // Réinitialiser l'état
    self.didSendStarted = NO;
    self.startCommand = nil;
}

#pragma mark - Communication avec JavaScript

/**
 * ==========================================================================
 * sendFrame - Envoie une frame JPEG au JavaScript
 * ==========================================================================
 *
 * Envoie une frame JPEG encodée en base64 au JavaScript via Cordova.
 * Le JavaScript dessine cette frame sur un canvas et crée un MediaStream.
 *
 * FORMAT DU PAYLOAD :
 * ------------------
 * {
 *   "type": "frame",
 *   "jpeg": "base64_encoded_jpeg_string"
 * }
 *
 * @param jpegBase64 Image JPEG encodée en base64 (sans préfixe data:)
 */
- (void)sendFrame:(NSString *)jpegBase64 {
    if (!self.startCommand || !jpegBase64) return;

    NSDictionary *payload = @{@"type": @"frame", @"jpeg": jpegBase64};
    CDVPluginResult *result = [CDVPluginResult resultWithStatus:CDVCommandStatus_OK messageAsDictionary:payload];

    // keepCallback: true permet d'envoyer plusieurs messages avec la même commande
    [result setKeepCallbackAsBool:YES];
    [self.commandDelegate sendPluginResult:result callbackId:self.startCommand.callbackId];
}

/**
 * ==========================================================================
 * sendSuccess - Envoie un message de succès au JavaScript
 * ==========================================================================
 *
 * Envoie un message de succès (ex: "started", "stopped") au JavaScript.
 *
 * MESSAGES POSSIBLES :
 * -------------------
 * • "started" - La capture a démarré avec succès
 * • "stopped" - La capture a été arrêtée
 *
 * @param message Message de succès
 */
- (void)sendSuccess:(NSString *)message {
    if (!self.startCommand) return;

    CDVPluginResult *result = [CDVPluginResult resultWithStatus:CDVCommandStatus_OK messageAsString:message];
    [result setKeepCallbackAsBool:YES];
    [self.commandDelegate sendPluginResult:result callbackId:self.startCommand.callbackId];
}

/**
 * ==========================================================================
 * sendError - Envoie une erreur au JavaScript
 * ==========================================================================
 *
 * Envoie un message d'erreur au JavaScript et arrête la capture.
 *
 * @param message Message d'erreur
 */
- (void)sendError:(NSString *)message {
    if (!self.startCommand) return;

    CDVPluginResult *result = [CDVPluginResult resultWithStatus:CDVCommandStatus_ERROR messageAsString:message];
    [self.commandDelegate sendPluginResult:result callbackId:self.startCommand.callbackId];

    // En cas d'erreur, arrêter la capture et nettoyer
    self.startCommand = nil;
    self.isCapturing = NO;
}

#pragma mark - RPScreenRecorderDelegate (ReplayKit events)

/**
 * ==========================================================================
 * screenRecorderDidChangeAvailability - Disponibilité ReplayKit changée
 * ==========================================================================
 *
 * ReplayKit peut devenir indisponible (ex: limitation système, batterie faible).
 * Ce delegate est appelé quand la disponibilité change.
 *
 * @param screenRecorder Instance de RPScreenRecorder
 */
- (void)screenRecorderDidChangeAvailability:(RPScreenRecorder *)screenRecorder {
    NSLog(@"ScreenShareLive: availability changed → %@", screenRecorder.isAvailable ? @"YES" : @"NO");
}

/**
 * ==========================================================================
 * screenRecorder:didStopRecordingWithError - ReplayKit a arrêté la capture
 * ==========================================================================
 *
 * ReplayKit peut arrêter la capture automatiquement (ex: pression home,
 * interruption système, erreur). Ce delegate est appelé dans ce cas.
 *
 * @param screenRecorder Instance de RPScreenRecorder
 * @param error Erreur qui a causé l'arrêt (si applicable)
 * @param previewViewController Controlleur de prévisualisation (non utilisé)
 */
- (void)screenRecorder:(RPScreenRecorder *)screenRecorder
didStopRecordingWithError:(NSError *)error
 previewViewController:(UIViewController *)previewViewController {
    NSLog(@"ScreenShareLive: recording stopped: %@", error.localizedDescription);

    // Informer le JavaScript que la capture a été arrêtée
    [self sendSuccess:@"stopped"];

    // Nettoyer les ressources
    [self stopCaptureInternal];
}

@end
