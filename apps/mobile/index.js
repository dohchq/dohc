// Install Web Crypto before any module reads it. Yjs's lib0 reads crypto when it loads.
require("./src/webCrypto").installWebCrypto();
require("expo-router/entry");
