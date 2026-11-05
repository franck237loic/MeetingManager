/**
 * ============================================================================
 * ScreenShareLivePlugin.h - Plugin Cordova iOS pour le partage d'écran
 * ============================================================================
 *
 * PRINCIPE :
 * ---------
 * Ce plugin utilise ReplayKit (API native iOS) pour capturer l'écran de
 * l'appareil et envoyer les frames au JavaScript via Cordova.
 *
 * ARCHITECTURE :
 * -------------
 * 1. JavaScript appelle start() → lance ReplayKit
 * 2. ReplayKit capture l'écran via RPScreenRecorder
 * 3. Les frames (CMSampleBuffer) sont converties en JPEG
 * 4. Les JPEG sont encodés en base64 et envoyés au JS
 * 5. Le JS dessine les frames sur un canvas et crée un MediaStream
 * 6. WebRTC utilise replaceTrack() pour envoyer l'écran
 *
 * MÉTHODES EXPORTÉES :
 * -------------------
 * • start() - Démarre la capture d'écran
 * • stop() - Arrête la capture
 * • isAvailable() - Vérifie si ReplayKit est disponible
 *
 * DÉLÉGATS :
 * ----------
 * RPScreenRecorderDelegate - Reçoit les événements ReplayKit
 * (disponibilité, arrêt de capture, erreurs)
 * ============================================================================
 */

#import <Cordova/CDV.h>
#import <ReplayKit/ReplayKit.h>

@interface ScreenShareLivePlugin : CDVPlugin <RPScreenRecorderDelegate>

/**
 * Démarre la capture d'écran via ReplayKit
 * @param command Commande Cordova avec les options (maxWidth, maxFps, jpegQuality)
 */
- (void)start:(CDVInvokedUrlCommand*)command;

/**
 * Arrête la capture d'écran et libère les ressources
 * @param command Commande Cordova vide
 */
- (void)stop:(CDVInvokedUrlCommand*)command;

/**
 * Vérifie si ReplayKit est disponible sur l'appareil
 * @param command Commande Cordova vide
 */
- (void)isAvailable:(CDVInvokedUrlCommand*)command;

@end
