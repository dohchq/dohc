import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const connectEntry = fileURLToPath(new URL("../src/deviceHostConnectCommand.ts", import.meta.url));
const deploymentEntry = fileURLToPath(new URL("../src/relayDeploymentCommand.ts", import.meta.url));
const credentialEntry = fileURLToPath(new URL("../src/deviceHostCredentialCommand.ts", import.meta.url));
const outdir = fileURLToPath(new URL("../dist", import.meta.url));

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: { main: entry, liveValidationWorker: fileURLToPath(new URL("../src/liveValidationWorker.ts", import.meta.url)), "device-host-connect": connectEntry, "relay-deployment": deploymentEntry, "device-host-credential": credentialEntry },
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  external: ["@dohc/app-backend-runtime", "better-auth", "better-auth/*", "pg", "ws"],
  logLevel: "info",
});
