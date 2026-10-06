import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dist = fileURLToPath(new URL("../dist", import.meta.url));
const receiptPath = join(root, ".dohc-dev/verification/runtime-build.json");
// Exported self-host builds do not contain Git or desktop QA scripts.
const cache = existsSync(join(root, ".git")) && existsSync(join(root, "scripts/verification/build.mjs"))
  ? await import("../../../scripts/verification/build.mjs") : null;

export function runtimeBuildPrepared() {
  if (!cache) return false;
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    return receipt.version === 1 && receipt.root === resolve(root)
      && receipt.source === cache.artifactSourceFingerprint("runtime", root)
      && receipt.artifact === cache.directoryFingerprint(dist);
  } catch (error) {
    if (error instanceof SyntaxError || ["ENOENT", "EACCES", "EPERM"].includes(error.code)) return false;
    throw error;
  }
}

if (cache && existsSync(receiptPath + ".lock")) {
  throw new Error(`Another runtime build owns ${receiptPath}.lock. Inspect its PID before removing a stale lock.`);
}
if (runtimeBuildPrepared()) {
  console.log("[runtime-build] reuse prepared bundle");
} else {
  if (cache) mkdirSync(resolve(receiptPath, ".."), {recursive: true});
  const lock = receiptPath + ".lock";
  try { if (cache) writeFileSync(lock, JSON.stringify({pid: process.pid}), {flag: "wx"}); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another runtime build owns ${lock}. Inspect its PID before removing a stale lock.`);
    throw error;
  }
  try {
    const source = cache?.artifactSourceFingerprint("runtime", root);
    rmSync(dist, {recursive: true, force: true});

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
        "dataset-automation-claims": fileURLToPath(new URL("../src/dataset-automation-claims.ts", import.meta.url)),
        index: fileURLToPath(new URL("../src/index.ts", import.meta.url)),
        automation: fileURLToPath(new URL("../src/automation.ts", import.meta.url)),
        "automation-worker": fileURLToPath(new URL("../src/automation-worker.ts", import.meta.url)),
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
      external: ["quickjs-emscripten", "@dohc/app-backend-runtime/child", "@dohc/app-backend-runtime/persistent-child", "@dohc/app-backend-runtime/automation-worker"],
    });
    if (cache) {
      if (source !== cache.artifactSourceFingerprint("runtime", root)) throw new Error("Runtime inputs changed during the build. Build again.");
      writeFileSync(receiptPath + ".tmp", JSON.stringify({version: 1, root: resolve(root), source, artifact: cache.directoryFingerprint(dist)}) + "\n");
      renameSync(receiptPath + ".tmp", receiptPath);
    }
  } finally { if (cache) rmSync(lock, {force: true}); }
}
