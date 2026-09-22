import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: {
    index: fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    child: fileURLToPath(new URL("../src/child.ts", import.meta.url)),
    persistent: fileURLToPath(new URL("../src/persistent.ts", import.meta.url)),
    journal: fileURLToPath(new URL("../src/journal.ts", import.meta.url)),
    supervisor: fileURLToPath(new URL("../src/supervisor.ts", import.meta.url)),
    "persistent-child": fileURLToPath(new URL("../src/persistent-child.ts", import.meta.url)),
  },
  outdir: fileURLToPath(new URL("../dist", import.meta.url)),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["quickjs-emscripten", "@dohc/app-backend-runtime/child", "@dohc/app-backend-runtime/persistent-child"],
});
