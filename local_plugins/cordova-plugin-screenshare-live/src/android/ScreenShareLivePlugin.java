package com.callapp.screenshare;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.util.Log;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Plugin Cordova : pont JS ↔ MediaProjection Android.
 *
 * Actions :
 *  - start : demande le consentement système puis démarre ScreenShareService
 *  - stop  : arrête le service / la projection
 *
 * Ordre Android 14+ (IMPORTANT) :
 *  1) createScreenCaptureIntent() → dialogue utilisateur
 *  2) onActivityResult avec RESULT_OK
 *  3) startForegroundService (type mediaProjection)
 *  4) getMediaProjection dans le service
 */
public class ScreenShareLivePlugin extends CordovaPlugin {

    private static final String TAG = "ScreenShareLive";
    private static final int REQUEST_MEDIA_PROJECTION = 9001;

    private CallbackContext startCallback;
    private JSONObject startOptions;

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callbackContext)
            throws JSONException {

        if ("start".equals(action)) {
            this.startCallback = callbackContext;
            this.startOptions = args.optJSONObject(0);
            if (this.startOptions == null) {
                this.startOptions = new JSONObject();
            }
            requestScreenCapture();
            // Résultat asynchrone (après le dialogue système)
            PluginResult pending = new PluginResult(PluginResult.Status.NO_RESULT);
            pending.setKeepCallback(true);
            callbackContext.sendPluginResult(pending);
            return true;
        }

        if ("stop".equals(action)) {
            stopCapture();
            callbackContext.success("stopped");
            return true;
        }

        if ("isAvailable".equals(action)) {
            // MediaProjection existe depuis Android 5.0 (API 21)
            boolean available = Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP;
            // Better: use PluginResult
            PluginResult r = new PluginResult(PluginResult.Status.OK, available);
            callbackContext.sendPluginResult(r);
            return true;
        }

        return false;
    }

    /**
     * Étape 1 : ouvrir le dialogue système « Partager l'écran ? »
     */
    private void requestScreenCapture() {
        Activity activity = cordova.getActivity();
        MediaProjectionManager mpm =
                (MediaProjectionManager) activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) {
            failStart("MediaProjectionManager indisponible");
            return;
        }
        Intent intent = mpm.createScreenCaptureIntent();
        cordova.setActivityResultCallback(this);
        activity.startActivityForResult(intent, REQUEST_MEDIA_PROJECTION);
    }

    /**
     * Étape 2 : résultat du dialogue utilisateur
     */
    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_MEDIA_PROJECTION) {
            return;
        }
        if (resultCode != Activity.RESULT_OK || data == null) {
            failStart("Permission partage d'écran refusée");
            return;
        }

        // Étape 3 : démarrer le service foreground avec l'Intent de projection
        Activity activity = cordova.getActivity();
        Intent serviceIntent = new Intent(activity, ScreenShareService.class);
        serviceIntent.setAction(ScreenShareService.ACTION_START);
        serviceIntent.putExtra(ScreenShareService.EXTRA_RESULT_CODE, resultCode);
        serviceIntent.putExtra(ScreenShareService.EXTRA_RESULT_DATA, data);

        // Options (fps, qualité) optionnelles
        if (startOptions != null) {
            serviceIntent.putExtra(
                    ScreenShareService.EXTRA_MAX_FPS,
                    startOptions.optInt("maxFps", 8));
            serviceIntent.putExtra(
                    ScreenShareService.EXTRA_JPEG_QUALITY,
                    startOptions.optInt("jpegQuality", 55));
            serviceIntent.putExtra(
                    ScreenShareService.EXTRA_MAX_WIDTH,
                    startOptions.optInt("maxWidth", 720));
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(serviceIntent);
            } else {
                activity.startService(serviceIntent);
            }
            // Mémoriser le plugin pour que le service puisse envoyer des frames
            ScreenShareService.pluginRef = this;
            if (startCallback != null) {
                PluginResult ok = new PluginResult(PluginResult.Status.OK, "started");
                ok.setKeepCallback(true);
                startCallback.sendPluginResult(ok);
            }
            Log.i(TAG, "ScreenShareService démarré");
        } catch (Exception e) {
            Log.e(TAG, "startForegroundService failed", e);
            failStart("Impossible de démarrer le service: " + e.getMessage());
        }
    }

    private void stopCapture() {
        Activity activity = cordova.getActivity();
        Intent serviceIntent = new Intent(activity, ScreenShareService.class);
        serviceIntent.setAction(ScreenShareService.ACTION_STOP);
        activity.startService(serviceIntent);
        ScreenShareService.pluginRef = null;
    }

    private void failStart(String message) {
        Log.w(TAG, message);
        if (startCallback != null) {
            startCallback.error(message);
            startCallback = null;
        }
    }

    /**
     * Appelé par ScreenShareService pour pousser une frame JPEG (base64) vers le JS.
     * Le JS écoute via le callback keepCallback ou un event.
     */
    public void sendFrameToJs(String jpegBase64) {
        if (startCallback == null) return;
        try {
            JSONObject payload = new JSONObject();
            payload.put("type", "frame");
            payload.put("jpeg", jpegBase64);
            PluginResult r = new PluginResult(PluginResult.Status.OK, payload);
            r.setKeepCallback(true);
            startCallback.sendPluginResult(r);
        } catch (JSONException e) {
            Log.e(TAG, "sendFrameToJs", e);
        }
    }

    /**
     * Appelé par ScreenShareService quand le partage est arrêté côté natif
     * (bouton « Arrêter » de la notification, ou arrêt par le système) : le JS doit
     * repasser en affichage normal et remettre la caméra.
     */
    public void sendStoppedToJs() {
        if (startCallback == null) return;
        PluginResult r = new PluginResult(PluginResult.Status.OK, "stopped");
        r.setKeepCallback(true);
        startCallback.sendPluginResult(r);
    }

    @Override
    public void onDestroy() {
        stopCapture();
        super.onDestroy();
    }
}