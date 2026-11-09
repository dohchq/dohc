const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // lib0 (under Yjs) sends React Native to isomorphic-webcrypto, which dohc doesn't
  // install. Use its browser build instead: index.js installs crypto first.
  if (moduleName === "lib0/webcrypto") {
    const random = context.resolveRequest(context, "lib0/random", platform);
    return { type: "sourceFile", filePath: path.join(path.dirname(random.filePath), "webcrypto.js") };
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
