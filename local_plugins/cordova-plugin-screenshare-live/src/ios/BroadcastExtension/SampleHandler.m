#import "SampleHandler.h"
#import <UIKit/UIKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <ImageIO/ImageIO.h>

static NSString * const kAppGroupId = @"group.com.callapp.terminal.screenshare";
static NSString * const kFrameFileName = @"latest_frame.jpg";
static NSString * const kMetaFileName = @"frame_meta.plist";
static NSString * const kDarwinNotificationName = @"com.callapp.terminal.screenshare.frame";
static NSString * const kStopRequestFileName = @"stop_request";

@interface SampleHandler ()
@property (nonatomic, assign) NSInteger frameSequence;
@property (nonatomic, strong) NSDate *lastWriteTime;
@property (nonatomic, assign) NSInteger targetFps;
@property (nonatomic, assign) CGFloat maxWidth;
@property (nonatomic, assign) CGFloat jpegQuality;
@property (nonatomic, strong) dispatch_queue_t processQueue;
@property (nonatomic, strong) CIContext *ciContext;
@end

@implementation SampleHandler

- (void)broadcastStartedWithSetupInfo:(NSDictionary<NSString *,NSObject *> *)setupInfo {
    self.frameSequence = 0;
    self.lastWriteTime = [NSDate date];
    self.targetFps = 10;
    self.maxWidth = 720.0;
    self.jpegQuality = 0.55;
    self.processQueue = dispatch_queue_create("com.callapp.screenshare.broadcast", DISPATCH_QUEUE_SERIAL);
    // Un seul CIContext : en créer un par frame dépasse la limite mémoire (~50 Mo) de l'extension
    self.ciContext = [CIContext contextWithOptions:@{kCIContextUseSoftwareRenderer: @NO}];

    // Nettoyer le flag stop
    NSURL *groupURL = [[NSFileManager defaultManager] containerURLForSecurityApplicationGroupIdentifier:kAppGroupId];
    if (groupURL) {
        NSDictionary *meta = @{@"seq": @0, @"stop": @NO};
        [meta writeToURL:[groupURL URLByAppendingPathComponent:kMetaFileName] atomically:YES];
        [[NSFileManager defaultManager] removeItemAtURL:[groupURL URLByAppendingPathComponent:kStopRequestFileName] error:nil];
    }
    NSLog(@"[ScreenShareBroadcast] Started");
}

- (void)broadcastPaused {
    NSLog(@"[ScreenShareBroadcast] Paused");
}

- (void)broadcastResumed {
    NSLog(@"[ScreenShareBroadcast] Resumed");
}

- (void)broadcastFinished {
    // Signaler l'arrêt à l'app principale
    NSURL *groupURL = [[NSFileManager defaultManager] containerURLForSecurityApplicationGroupIdentifier:kAppGroupId];
    if (groupURL) {
        NSDictionary *meta = @{@"seq": @(self.frameSequence + 1), @"stop": @YES};
        [meta writeToURL:[groupURL URLByAppendingPathComponent:kMetaFileName] atomically:YES];
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(),
                                             (__bridge CFStringRef)kDarwinNotificationName,
                                             NULL, NULL, true);
    }
    NSLog(@"[ScreenShareBroadcast] Finished");
}

- (void)processSampleBuffer:(CMSampleBufferRef)sampleBuffer withType:(RPSampleBufferType)sampleBufferType {
    if (sampleBufferType != RPSampleBufferTypeVideo) return;
    if (!sampleBuffer) return;

    // L'app a arrêté le partage depuis son bouton : terminer la diffusion système
    NSURL *groupURL = [[NSFileManager defaultManager] containerURLForSecurityApplicationGroupIdentifier:kAppGroupId];
    NSURL *stopURL = [groupURL URLByAppendingPathComponent:kStopRequestFileName];
    if (stopURL && [[NSFileManager defaultManager] fileExistsAtPath:stopURL.path]) {
        [[NSFileManager defaultManager] removeItemAtURL:stopURL error:nil];
        NSError *error = [NSError errorWithDomain:@"com.callapp.terminal.screenshare"
                                             code:0
                                         userInfo:@{NSLocalizedDescriptionKey: @"Partage d'écran arrêté"}];
        [self finishBroadcastWithError:error];
        return;
    }

    // Limiter le FPS
    NSDate *now = [NSDate date];
    NSTimeInterval minInterval = 1.0 / MAX(1, self.targetFps);
    if ([now timeIntervalSinceDate:self.lastWriteTime] < minInterval) return;
    self.lastWriteTime = now;

    // Copier le buffer pour le traiter hors du thread de callback (obligatoire)
    CFRetain(sampleBuffer);
    dispatch_async(self.processQueue, ^{
        [self handleVideoBuffer:sampleBuffer];
        CFRelease(sampleBuffer);
    });
}

- (void)handleVideoBuffer:(CMSampleBufferRef)sampleBuffer {
    CVImageBufferRef imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (!imageBuffer) return;

    CVPixelBufferLockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);

    size_t width = CVPixelBufferGetWidth(imageBuffer);
    size_t height = CVPixelBufferGetHeight(imageBuffer);
    if (width == 0 || height == 0) {
        CVPixelBufferUnlockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
        return;
    }

    CIImage *ciImage = [CIImage imageWithCVPixelBuffer:imageBuffer];
    CVPixelBufferUnlockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);

    CGFloat scale = 1.0;
    if ((CGFloat)width > self.maxWidth) {
        scale = self.maxWidth / (CGFloat)width;
    }

    CIContext *context = self.ciContext;
    CGRect extent = ciImage.extent;
    if (scale < 1.0 - 0.001) {
        ciImage = [ciImage imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)];
        extent = ciImage.extent;
    }

    CGImageRef cgImage = [context createCGImage:ciImage fromRect:extent];
    if (!cgImage) return;

    UIImage *image = [UIImage imageWithCGImage:cgImage scale:1.0 orientation:UIImageOrientationUp];
    CGImageRelease(cgImage);

    NSData *jpegData = UIImageJPEGRepresentation(image, self.jpegQuality);
    if (!jpegData || jpegData.length < 100) return;

    // Écrire dans l'App Group (atomique)
    NSURL *groupURL = [[NSFileManager defaultManager] containerURLForSecurityApplicationGroupIdentifier:kAppGroupId];
    if (!groupURL) return;

    NSURL *frameURL = [groupURL URLByAppendingPathComponent:kFrameFileName];
    NSURL *tmpURL = [groupURL URLByAppendingPathComponent:@"latest_frame.tmp"];

    if (![jpegData writeToURL:tmpURL atomically:YES]) return;
    // Rename atomique
    [[NSFileManager defaultManager] removeItemAtURL:frameURL error:nil];
    NSError *err = nil;
    [[NSFileManager defaultManager] moveItemAtURL:tmpURL toURL:frameURL error:&err];
    if (err) return;

    self.frameSequence += 1;
    NSDictionary *meta = @{
        @"seq": @(self.frameSequence),
        @"stop": @NO,
        @"w": @((NSInteger)(width * scale)),
        @"h": @((NSInteger)(height * scale)),
        @"ts": @([[NSDate date] timeIntervalSince1970])
    };
    [meta writeToURL:[groupURL URLByAppendingPathComponent:kMetaFileName] atomically:YES];

    // Notifier l'app principale
    CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(),
                                         (__bridge CFStringRef)kDarwinNotificationName,
                                         NULL, NULL, true);
}

@end
