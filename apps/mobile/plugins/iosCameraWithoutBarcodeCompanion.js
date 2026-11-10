// expo-camera's own barcodeScannerEnabled option also makes Android's ML Kit scanner compile-only in a source build,
// which stops QR scanning there. So only the iOS companion pod is left out: it adds native ZXing for PDF417, Code39 and
// Codabar, and iOS reads QR codes through AVFoundation without it.
// app.json lists this plugin before expo-camera: Expo runs mods in the reverse of that order, and expo-camera's own
// mod deletes this property when its option is unset, so this one must run after it.
const { withPodfileProperties } = require("expo/config-plugins");

module.exports = function iosCameraWithoutBarcodeCompanion(config) {
  return withPodfileProperties(config, podfile => {
    podfile.modResults["expo.camera.barcode-scanner-enabled"] = "false";
    return podfile;
  });
};
