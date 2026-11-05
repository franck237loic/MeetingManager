# Plugin ScreenShareLive — iOS (mode WhatsApp)

## Objectif

Partage d'écran **système complet** sur iOS, identique à WhatsApp / Zoom / Teams :

1. L'utilisateur appuie sur "Écran"
2. Le sheet système ReplayKit s'ouvre
3. Il choisit **CallApp Screen Share**
4. Une barre rouge apparaît en haut de l'écran
5. **Tout l'écran du téléphone** (autres apps, écran d'accueil, etc.) est partagé en temps réel via WebRTC

## Architecture

```
┌─────────────────────┐     App Group + Darwin     ┌──────────────────────────┐
│  App principale     │ ◄───────────────────────► │  Broadcast Upload        │
│  (ScreenShareLive   │   frames JPEG + seq       │  Extension               │
│   Plugin)           │                           │  (SampleHandler)         │
│                     │                           │                          │
│  → canvas → WebRTC  │                           │  reçoit CMSampleBuffer   │
└─────────────────────┘                           │  de tout le système      │
                                                  └──────────────────────────┘
```

## Prérequis

- iOS 12.0+ (recommandé iOS 14+)
- Compte développeur Apple (App Groups)
- Xcode 14+

## Installation automatique (par défaut)

Le hook `scripts/ios_add_broadcast_extension.js` (after_prepare) ajoute la target
`ScreenShareBroadcast` au projet Xcode à chaque `cordova prepare ios` (gem Ruby `xcodeproj`,
fournie avec CocoaPods), avec bundle id, App Group, entitlements et embarquement dans l'app.
Les étapes 3 à 7 ci-dessous ne sont donc plus à faire à la main. Il reste seulement à vérifier,
dans Xcode → Signing & Capabilities, que la signature et l'App Group sont valides sur les **deux** targets.

## Installation manuelle (référence)

### 1. Ajouter la plateforme iOS (si pas déjà fait)

```bash
cd app_appel
cordova platform add ios
cordova prepare ios
```

### 2. Ouvrir le projet dans Xcode

```bash
open platforms/ios/*.xcworkspace
```

### 3. Créer la Broadcast Upload Extension

1. Dans Xcode → menu **File → New → Target…**
2. Choisir **Broadcast Upload Extension**
3. Product Name : `ScreenShareBroadcast`
4. Language : **Objective-C**
5. **Décocher** "Include UI Extension"
6. Finish → activer le scheme si demandé

### 4. Remplacer les fichiers générés par ceux du plugin

Copier les fichiers fournis :

```
local_plugins/cordova-plugin-screenshare-live/src/ios/BroadcastExtension/SampleHandler.h
local_plugins/cordova-plugin-screenshare-live/src/ios/BroadcastExtension/SampleHandler.m
local_plugins/cordova-plugin-screenshare-live/src/ios/BroadcastExtension/Info.plist
```

Dans le dossier de la target `ScreenShareBroadcast` (généralement `platforms/ios/ScreenShareBroadcast/`).

### 5. Configurer le Bundle Identifier de l'extension

Dans les **Build Settings** de la target `ScreenShareBroadcast` :

- **Product Bundle Identifier** = `com.callapp.terminal.ScreenShareBroadcast`

(Important : ce doit correspondre à `preferredExtension` dans le plugin.)

### 6. Activer App Groups (OBLIGATOIRE)

#### Sur l'app principale (`CallApp` / `com.callapp.terminal`) :

1. Target principale → **Signing & Capabilities**
2. **+ Capability** → **App Groups**
3. Ajouter : `group.com.callapp.terminal.screenshare`
4. Cocher la case

#### Sur l'extension (`ScreenShareBroadcast`) :

1. Target `ScreenShareBroadcast` → **Signing & Capabilities**
2. **+ Capability** → **App Groups**
3. Ajouter **exactement le même** : `group.com.callapp.terminal.screenshare`
4. Cocher la case

### 7. Vérifier les entitlements

Les deux targets doivent avoir un fichier `.entitlements` contenant :

```xml
<key>com.apple.security.application-groups</key>
<array>
    <string>group.com.callapp.terminal.screenshare</string>
</array>
```

### 8. Minimum deployment target

Mettre **iOS 12.0** (ou 14.0) pour les deux targets.

### 9. Rebuild

```bash
cordova build ios
# ou depuis Xcode : Product → Clean Build Folder puis Run
```

## Utilisation côté JavaScript (déjà intégrée dans CallManager)

```javascript
// Vérifier
ScreenShareLive.isAvailable((ok) => console.log("available", ok));

// Démarrer (mode WhatsApp = useBroadcast: true par défaut)
ScreenShareLive.start(
  { maxWidth: 720, maxFps: 10, jpegQuality: 55, useBroadcast: true },
  (msg) => {
    if (msg === "started") { /* picker affiché */ }
    else if (msg && msg.type === "frame") {
      canvasStream.pushJpegBase64(msg.jpeg);
    }
    else if (msg === "stopped") { /* utilisateur a arrêté via la barre rouge */ }
  },
  (err) => console.error(err)
);

// Arrêter
ScreenShareLive.stop(() => {}, () => {});
```

## Expérience utilisateur (identique à WhatsApp)

1. Bouton "Écran" → le sheet système s'ouvre automatiquement
2. L'utilisateur choisit **CallApp Screen Share**
3. Barre rouge en haut de l'écran iOS
4. Tout ce qui se passe sur le téléphone est partagé
5. L'utilisateur peut arrêter via la barre rouge ou via le bouton dans l'app

## Dépannage

| Problème | Cause | Solution |
|----------|-------|----------|
| Le picker ne s'ouvre pas | Extension absente ou mauvais bundle id | Vérifier `preferredExtension` = `com.callapp.terminal.ScreenShareBroadcast` |
| Aucune frame reçue | App Group mal configuré | Vérifier que les **deux** targets ont le même App Group coché |
| "Screen recording not available" | Simulateur ou iOS < 11 | Tester sur **vrai iPhone** |
| Images floues / lentes | maxWidth / jpegQuality trop bas ou FPS trop haut | Ajuster les options (maxWidth: 540-720, maxFps: 8-12) |
| Extension n'apparaît pas dans le sheet | Bundle id incorrect ou pas signé | Vérifier Signing de l'extension |

## Fichiers importants

```
src/ios/
├── ScreenShareLivePlugin.h
├── ScreenShareLivePlugin.m          ← plugin principal
└── BroadcastExtension/
    ├── SampleHandler.h
    ├── SampleHandler.m              ← reçoit les frames système
    └── Info.plist
```

## Notes de performance

- 10 FPS + JPEG qualité 55 + maxWidth 720 est un bon compromis pour WebRTC
- La conversion se fait dans l'extension (processus séparé) → l'app principale reste fluide
- Pour encore mieux : on pourra plus tard envoyer du H.264 au lieu de JPEG

