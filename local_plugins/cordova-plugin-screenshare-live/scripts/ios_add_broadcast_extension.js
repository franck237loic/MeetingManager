/**
 * Hook after_prepare (iOS) : ajoute la Broadcast Upload Extension au projet Xcode.
 * Sans elle, le sheet ReplayKit lance l'enregistrement d'écran Photos au lieu de diffuser vers l'app.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

module.exports = function (context) {
  const platforms = (context.opts && context.opts.platforms) || [];
  if (!platforms.includes("ios")) return;

  const iosDir = path.join(context.opts.projectRoot, "platforms", "ios");
  if (!fs.existsSync(path.join(iosDir, "App.xcodeproj"))) return;

  const pluginDir = path.join(__dirname, "..");
  execFileSync(
    "ruby",
    [
      path.join(pluginDir, "scripts", "add_broadcast_extension.rb"),
      iosDir,
      path.join(pluginDir, "src", "ios", "BroadcastExtension"),
    ],
    { stdio: "inherit" }
  );
};
