import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: {
    index: fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    child: fileURLToPath(new URL("../src/child.ts", import.meta.url)),
  },
  outdir: fileURLToPath(new URL("../dist", import.meta.url)),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["quickjs-emscripten", "@dohc/app-backend-runtime/child"],
});
