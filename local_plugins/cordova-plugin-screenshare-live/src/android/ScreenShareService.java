package com.callapp.screenshare;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import androidx.core.app.NotificationCompat;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Service foreground qui capture l'écran via MediaProjection
 * et envoie des JPEG (base64) au plugin JS à intervalle limité (fps).
 *
 * Pourquoi un Service ?
 * Android 14+ exige un foregroundServiceType=mediaProjection pendant toute
 * la durée de la capture, sinon SecurityException.
 */
public class ScreenShareService extends Service {

    public static final String TAG = "ScreenShareService";
    public static final String ACTION_START = "com.callapp.screenshare.START";
    public static final String ACTION_STOP = "com.callapp.screenshare.STOP";
    /** Arrêt demandé par l'utilisateur depuis la notification : le JS doit être prévenu. */
    public static final String ACTION_STOP_USER = "com.callapp.screenshare.STOP_USER";
    public static final String EXTRA_RESULT_CODE = "resultCode";
    public static final String EXTRA_RESULT_DATA = "resultData";
    public static final String EXTRA_MAX_FPS = "maxFps";
    public static final String EXTRA_JPEG_QUALITY = "jpegQuality";
    public static final String EXTRA_MAX_WIDTH = "maxWidth";

    private static final String CHANNEL_ID = "screenshare_live";
    private static final int NOTIF_ID = 4401;

    /** Référence au plugin pour renvoyer les frames au JS */
    public static volatile ScreenShareLivePlugin pluginRef;

    private MediaProjection mediaProjection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private HandlerThread handlerThread;
    private Handler handler;

    private int maxFps = 8;
    private int jpegQuality = 55;
    private int maxWidth = 720;
    private long lastFrameMs = 0;
    /** true une fois le JS prévenu (ou si c'est lui qui a demandé l'arrêt) : évite les doublons. */
    private volatile boolean stopNotified = false;

    private void notifyJsStopped() {
        if (stopNotified) return;
        stopNotified = true;
        ScreenShareLivePlugin plugin = pluginRef;
        if (plugin != null) plugin.sendStoppedToJs();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        String action = intent.getAction();
        if (ACTION_STOP_USER.equals(action)) {
            notifyJsStopped();
            teardown();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_STOP.equals(action)) {
            stopNotified = true; // arrêt demandé par le JS : inutile de le re-prévenir
            teardown();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_START.equals(action)) {
            stopNotified = false;
            maxFps = intent.getIntExtra(EXTRA_MAX_FPS, 8);
            jpegQuality = intent.getIntExtra(EXTRA_JPEG_QUALITY, 55);
            maxWidth = intent.getIntExtra(EXTRA_MAX_WIDTH, 720);

            // Notification obligatoire avant / avec le service mediaProjection
            startAsForeground();

            int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
            Intent data = intent.getParcelableExtra(EXTRA_RESULT_DATA);
            if (data == null) {
                Log.e(TAG, "resultData null");
                stopSelf();
                return START_NOT_STICKY;
            }

            MediaProjectionManager mpm =
                    (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            mediaProjection = mpm.getMediaProjection(resultCode, data);
            if (mediaProjection == null) {
                Log.e(TAG, "getMediaProjection null");
                stopSelf();
                return START_NOT_STICKY;
            }

            mediaProjection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    Log.i(TAG, "MediaProjection stopped by system");
                    notifyJsStopped();
                    teardown();
                    stopForeground(true);
                    stopSelf();
                }
            }, null);

            startCapture();
        }

        return START_STICKY;
    }

    private void startAsForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID,
                    "Partage d'écran",
                    NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Capture d'écran en cours pour l'appel");
            nm.createNotificationChannel(ch);
        }

        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) piFlags |= PendingIntent.FLAG_IMMUTABLE;

        // Bouton « Arrêter » (comme WhatsApp) : arrête le partage et prévient le JS
        Intent stopIntent = new Intent(this, ScreenShareService.class);
        stopIntent.setAction(ACTION_STOP_USER);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stopIntent, piFlags);

        // Toucher la notification ramène dans l'appel
        PendingIntent openPi = null;
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
            launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            openPi = PendingIntent.getActivity(this, 2, launch, piFlags);
        }

        NotificationCompat.Builder nb = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Vous partagez votre écran")
                .setContentText("Touchez pour revenir à l'appel")
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .setOngoing(true)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Arrêter", stopPi);
        if (openPi != null) nb.setContentIntent(openPi);
        Notification notification = nb.build();

        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTIF_ID, notification);
        }
    }

    private void startCapture() {
        WindowManager wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        DisplayMetrics metrics = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(metrics);

        int width = metrics.widthPixels;
        int height = metrics.heightPixels;
        int density = metrics.densityDpi;

        // Réduire la résolution pour alléger le pont JPEG → JS
        if (width > maxWidth) {
            float scale = maxWidth / (float) width;
            width = maxWidth;
            height = Math.round(height * scale);
        }
        // Largeur paire (encodage)
        width = width & ~1;
        height = height & ~1;

        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);

        handlerThread = new HandlerThread("ScreenShareCapture");
        handlerThread.start();
        handler = new Handler(handlerThread.getLooper());

        imageReader.setOnImageAvailableListener(reader -> {
            Image image = null;
            try {
                image = reader.acquireLatestImage();
                if (image == null) return;

                long now = System.currentTimeMillis();
                long minInterval = 1000L / Math.max(1, maxFps);
                if (now - lastFrameMs < minInterval) {
                    return;
                }
                lastFrameMs = now;

                String b64 = imageToJpegBase64(image, jpegQuality);
                if (b64 != null && pluginRef != null) {
                    pluginRef.sendFrameToJs(b64);
                }
            } catch (Exception e) {
                Log.e(TAG, "onImageAvailable", e);
            } finally {
                if (image != null) image.close();
            }
        }, handler);

        virtualDisplay = mediaProjection.createVirtualDisplay(
                "ScreenShareLive",
                width,
                height,
                density,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader.getSurface(),
                null,
                handler);

        Log.i(TAG, "VirtualDisplay " + width + "x" + height + " fps~" + maxFps);
    }

    private String imageToJpegBase64(Image image, int quality) {
        Image.Plane[] planes = image.getPlanes();
        ByteBuffer buffer = planes[0].getBuffer();
        int pixelStride = planes[0].getPixelStride();
        int rowStride = planes[0].getRowStride();
        int rowPadding = rowStride - pixelStride * image.getWidth();

        Bitmap bitmap = Bitmap.createBitmap(
                image.getWidth() + rowPadding / pixelStride,
                image.getHeight(),
                Bitmap.Config.ARGB_8888);
        bitmap.copyPixelsFromBuffer(buffer);

        Bitmap cropped = Bitmap.createBitmap(bitmap, 0, 0, image.getWidth(), image.getHeight());
        if (cropped != bitmap) bitmap.recycle();

        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        cropped.compress(Bitmap.CompressFormat.JPEG, quality, baos);
        cropped.recycle();
        return Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
    }

    private void teardown() {
        try {
            if (virtualDisplay != null) {
                virtualDisplay.release();
                virtualDisplay = null;
            }
            if (imageReader != null) {
                imageReader.close();
                imageReader = null;
            }
            if (mediaProjection != null) {
                mediaProjection.stop();
                mediaProjection = null;
            }
            if (handlerThread != null) {
                handlerThread.quitSafely();
                handlerThread = null;
            }
        } catch (Exception e) {
            Log.e(TAG, "teardown", e);
        }
    }

    @Override
    public void onDestroy() {
        teardown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}