/**
 * ============================================================================
 * ScreenShareLive — API JavaScript du plugin de partage d'écran
 * ============================================================================
 *
 * PRINCIPE DE FONCTIONNEMENT :
 * ---------------------------
 * Ce plugin permet de capturer l'écran de l'appareil et de l'envoyer via WebRTC
 * dans un appel vidéo. Il utilise des APIs natives différentes selon la plateforme :
 *
 * - ANDROID : MediaProjection API
 *   • Demande une permission système (dialogue utilisateur)
 *   • Utilise un service foreground pour la capture (obligatoire Android 14+)
 *   • Capture l'écran complet et envoie des frames JPEG au JavaScript
 *
 * - iOS : ReplayKit Broadcast Extension
 *   • Demande une permission système via le sélecteur de broadcast
 *   • Utilise une extension iOS (BroadcastExtension) pour la capture
 *   • Capture l'écran complet et envoie des frames JPEG au JavaScript
 *   • Mode "WhatsApp" : sélection "Cette application" (app screen)
 *
 * FLUX DE DONNÉES :
 * ----------------
 * 1. Plugin natif capture l'écran → frames JPEG (base64)
 * 2. JavaScript reçoit les frames via cordova.exec callback
 * 3. Frames dessinées sur un canvas HTML5
 * 4. canvas.captureStream() crée un MediaStream
 * 5. WebRTC replaceTrack() remplace la caméra par l'écran
 *
 * POURQUOI JPEG + CANVAS ?
 * ------------------------
 * • Les APIs natives (MediaProjection/ReplayKit) ne fournissent pas directement
 *   un MediaStream compatible WebRTC
 * • Le canvas.captureStream() est le moyen le plus portable de créer un stream
 * • JPEG offre un bon compromis compression/qualité pour le partage d'écran
 * ============================================================================
 */
var exec = require("cordova/exec");

var ScreenShareLive = {
  /**
   * ==========================================================================
   * isAvailable() - Vérifie si le plugin de partage d'écran est disponible
   * ==========================================================================
   *
   * FONCTION :
   * ---------
   * Détermine si le plugin natif est chargé et fonctionnel sur la plateforme.
   *
   * DÉTAILS :
   * --------
   * • Sur iOS : appelle ReplayKit.isAvailable() pour vérifier si ReplayKit
   *             est supporté (iOS 11+ et appareil compatible)
   * • Sur Android : retourne true si le plugin est compilé dans le build
   * • Sur navigateur : retourne false (pas de plugin natif)
   *
   * UTILISATION :
   * -------------
   * Appelé par CallManager.isScreenShareSupported() pour décider d'utiliser
   * getDisplayMedia (navigateur) ou le plugin natif (mobile).
   *
   * @param {function} success - Callback avec true/false
   * @param {function} error - Callback en cas d'erreur
   */
  isAvailable: function (success, error) {
    if (typeof window === "undefined" || !window.cordova) {
      if (typeof success === "function") success(false);
      return false;
    }
    // Appelle toujours le natif pour avoir la vraie réponse (surtout iOS)
    exec(
      function (available) {
        if (typeof success === "function") success(!!available);
      },
      function (err) {
        // Classe native absente (plugin non compilé dans la plateforme) : ne pas prétendre que ça marche
        console.warn("[ScreenShareLive] isAvailable natif en échec :", err);
        if (typeof success === "function") success(false);
      },
      "ScreenShareLive",
      "isAvailable",
      []
    );
  },

  /**
   * ==========================================================================
   * start() - Démarre la capture d'écran native
   * ==========================================================================
   *
   * FONCTION :
   * ---------
   * Lance la capture d'écran via l'API native de la plateforme.
   *
   * PROCESSUS ANDROID :
   * ------------------
   * 1. Appelle MediaProjectionManager.createScreenCaptureIntent()
   * 2. Affiche le dialogue système "Commencer à capturer l'écran ?"
   * 3. Si l'utilisateur accepte → démarre ScreenShareService (foreground)
   * 4. Le service capture l'écran et envoie des frames JPEG au JS
   *
   * PROCESSUS iOS :
   * --------------
   * 1. Appelle RPSystemBroadcastPickerView (sélecteur de broadcast)
   * 2. Affiche le sélecteur système (choisir "Cette application")
   * 3. Si l'utilisateur sélectionne → lance BroadcastExtension
   * 4. L'extension capture l'écran et envoie des frames JPEG au JS
   *
   * CALLBACKS :
   * ----------
   * Le callback success reçoit des messages successifs :
   * • "started" - La capture a démarré avec succès
   * • {type: "frame", jpeg: "base64..."} - Une nouvelle frame est disponible
   * • "stopped" - La capture a été arrêtée (par l'utilisateur ou le système)
   *
   * @param {object} options - Configuration de la capture
   *   • maxWidth: number (défaut 720) - Largeur maximale de redimensionnement
   *   • maxFps: number (défaut 10) - Images par seconde maximum
   *   • jpegQuality: number (défaut 55) - Qualité JPEG 0-100
   *   • useBroadcast: boolean (iOS only, défaut true) - Mode Broadcast Extension
   * @param {function} success - Callback pour les messages (keepCallback: true)
   * @param {function} error - Callback en cas d'erreur
   */
  start: function (options, success, error) {
    var opts = options || {};
    exec(success, error, "ScreenShareLive", "start", [opts]);
  },

  /**
   * ==========================================================================
   * stop() - Arrête la capture d'écran
   * ==========================================================================
   *
   * FONCTION :
   * ---------
   * Arrête la capture d'écran et libère les ressources natives.
   *
   * PROCESSUS ANDROID :
   * ------------------
   * • Arrête ScreenShareService (foreground service)
   * • Libère MediaProjection et VirtualDisplay
   * • Supprime la notification système
   *
   * PROCESSUS iOS :
   * --------------
   * • Arrête RPSystemBroadcastPickerView
   * • Termine BroadcastExtension
   * • Libère ReplayKit resources
   *
   * @param {function} success - Callback quand arrêt terminé
   * @param {function} error - Callback en cas d'erreur
   */
  stop: function (success, error) {
    exec(success, error, "ScreenShareLive", "stop", []);
  },

  /**
   * ==========================================================================
   * createCanvasStream() - Crée un MediaStream pour WebRTC
   * ==========================================================================
   *
   * FONCTION :
   * ---------
   * Crée un MediaStream WebRTC à partir des frames JPEG reçues du natif.
   * Ce stream peut être utilisé avec peerConnection.replaceTrack().
   *
   * POURQUOI UN CANVAS ?
   * --------------------
   * • Les APIs natives ne fournissent pas directement un MediaStream
   * • Le canvas.captureStream() est l'API standard pour créer un stream
   * • Compatible avec tous les navigateurs modernes
   *
   * FONCTIONNEMENT :
   * --------------
   * 1. Crée un élément <canvas> HTML5 (invisible)
   * 2. canvas.captureStream(fps) crée un MediaStream à 10 FPS
   * 3. Chaque frame JPEG reçue est dessinée sur le canvas
   * 4. Le stream contient une piste vidéo qui reflète le canvas
   * 5. WebRTC transmet ce stream via replaceTrack()
   *
   * FLUX DE DONNÉES :
   * ----------------
   * Native (JPEG base64) → pushJpegBase64() → canvas.drawImage() →
   * canvas.captureStream() → MediaStream → WebRTC replaceTrack()
   *
   * @param {number} fps - Frames par seconde du stream (défaut 10)
   * @returns {object} - { stream, pushJpegBase64, destroy, canvas }
   *   • stream: MediaStream - Stream WebRTC à utiliser
   *   • pushJpegBase64: function(string) - Fonction pour ajouter une frame
   *   • destroy: function() - Fonction pour nettoyer les ressources
   *   • canvas: HTMLCanvasElement - Canvas visible (optionnel pour debug)
   */
  createCanvasStream: function (fps) {
    fps = fps || 10;
    var canvas = document.createElement("canvas");
    canvas.width = 720;
    canvas.height = 1280;
    var ctx = canvas.getContext("2d");
    var stream = canvas.captureStream(fps);
    var img = new Image();

    /**
     * pushJpegBase64() - Ajoute une frame JPEG au canvas
     *
     * @param {string} b64 - Image JPEG encodée en base64 (sans le préfixe data:)
     */
    function pushJpegBase64(b64) {
      if (!b64) return;
      img.onload = function () {
        if (img.width && img.height) {
          // Redimensionne le canvas si l'image a une taille différente
          if (canvas.width !== img.width || canvas.height !== img.height) {
            canvas.width = img.width;
            canvas.height = img.height;
          }
          // Dessine l'image sur le canvas
          ctx.drawImage(img, 0, 0);
        }
      };
      // Charge l'image depuis la chaîne base64
      img.src = "data:image/jpeg;base64," + b64;
    }

    /**
     * destroy() - Nettoie les ressources du canvas stream
     *
     * Arrête toutes les pistes du MediaStream pour libérer la caméra virtuelle
     */
    function destroy() {
      try {
        stream.getTracks().forEach(function (t) {
          t.stop();
        });
      } catch (e) {}
    }

    return { stream: stream, pushJpegBase64: pushJpegBase64, destroy: destroy, canvas: canvas };
  },
};

module.exports = ScreenShareLive;
