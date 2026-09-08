import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const connectEntry = fileURLToPath(new URL("../src/deviceHostConnectCommand.ts", import.meta.url));
const outdir = fileURLToPath(new URL("../dist", import.meta.url));

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: { main: entry, "device-host-connect": connectEntry },
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["better-auth", "better-auth/*", "pg", "ws"],
  logLevel: "info",
});
