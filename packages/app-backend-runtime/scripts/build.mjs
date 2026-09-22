import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: {
    recovery: fileURLToPath(new URL("../src/recovery.ts", import.meta.url)),
    "recovery-export": fileURLToPath(new URL("../src/recovery-export.ts", import.meta.url)),
    "recovery-import": fileURLToPath(new URL("../src/recovery-import.ts", import.meta.url)),
    "recovery-install": fileURLToPath(new URL("../src/recovery-install.ts", import.meta.url)),
    "replica-host": fileURLToPath(new URL("../src/replica-host.ts", import.meta.url)),
    replica: fileURLToPath(new URL("../src/replica.ts", import.meta.url)),
    "dataset-host": fileURLToPath(new URL("../src/dataset-host.ts", import.meta.url)),
    "dataset-compiler": fileURLToPath(new URL("../src/dataset-compiler.ts", import.meta.url)),
    "dataset-attempts": fileURLToPath(new URL("../src/dataset-attempts.ts", import.meta.url)),
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
