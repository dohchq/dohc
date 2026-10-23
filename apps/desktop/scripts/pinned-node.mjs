export const NODE_VERSION = "24.16.0";
// https://nodejs.org/dist/v24.16.0/SHASUMS256.txt names each download.
// Archives are verified before extraction, then their Node binary is verified.
const release = `https://nodejs.org/dist/v${NODE_VERSION}`;
export const PINNED_NODE = {
  "win32-x64": { url: `${release}/win-x64/node.exe`, file: "node.exe", sha256: "b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3" },
  "darwin-arm64": {
    url: `${release}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`, archiveSha256: "39189dab4eeb15706c424af0ac08a3044c9e48f7db12a7d77f6b7aafc7dd5df6",
    member: `node-v${NODE_VERSION}-darwin-arm64/bin/node`, file: "node", sha256: "1ee75375e33b94fc34b3b19aede049e11dae90efb63b374dc96d6bdace70c4b8",
  },
  "darwin-x64": {
    url: `${release}/node-v${NODE_VERSION}-darwin-x64.tar.gz`, archiveSha256: "298b4c7b3cb80765c8703e42b90324a4ece3b6634947b89e769c3c980ab55185",
    member: `node-v${NODE_VERSION}-darwin-x64/bin/node`, file: "node", sha256: "47483a524a057d93e246bb0e63867e2b4d189810aef53a6978d9e708a3d0f453",
  },
  "linux-x64": {
    url: `${release}/node-v${NODE_VERSION}-linux-x64.tar.gz`, archiveSha256: "2faf6a387e9b62b888e21c54f01249fb27537ffecf1842f29f4c919d0a59a0ff",
    member: `node-v${NODE_VERSION}-linux-x64/bin/node`, file: "node", sha256: "b2959781cc5a74c357ffa02367efa8a0330cbb1c9cb347732fdfaaaca381cbcd",
  },
};
