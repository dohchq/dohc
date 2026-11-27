const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const sketchManifest = path.join(__dirname, "src/sketches/sketchAssets.generated.ts");
const sketchHtml = path.join(__dirname, "assets/sketch/sketch.html");
if (!fs.existsSync(sketchManifest) || !fs.existsSync(sketchHtml)) {
  execFileSync(process.execPath, [path.join(__dirname, "scripts/build-sketch.mjs")], {
    stdio: "inherit",
  });
}

const config = getDefaultConfig(__dirname);
for (const ext of ["html", "css", "woff2", "sketchjs"]) {
  if (!config.resolver.assetExts.includes(ext)) config.resolver.assetExts.push(ext);
  config.resolver.sourceExts = config.resolver.sourceExts.filter((item) => item !== ext);
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // lib0 (under Yjs) sends React Native to isomorphic-webcrypto, which dohc doesn't
  // install. Use its browser build instead: index.js installs crypto first.
  if (moduleName === "lib0/webcrypto") {
    const random = context.resolveRequest(context, "lib0/random", platform);
    return {
      type: "sourceFile",
      filePath: path.join(path.dirname(random.filePath), "webcrypto.js"),
    };
  }
  // dohc's shared packages ship TypeScript source and import siblings as "./name.js".
  // Metro looks for a real .js file, so retry the import as its .ts source.
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    } catch {
      // Fall through to the import as written.
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
