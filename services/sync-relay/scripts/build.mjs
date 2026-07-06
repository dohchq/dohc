import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const outfile = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const outdir = fileURLToPath(new URL("../dist", import.meta.url));

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["better-auth", "better-auth/*", "pg"],
  logLevel: "info",
});
