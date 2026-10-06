import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dist = fileURLToPath(new URL("../dist", import.meta.url));
const receiptPath = join(root, ".dohc-dev/verification/runtime-build.json");
// Exported self-host builds do not contain Git or desktop QA scripts.
const cache = existsSync(join(root, ".git")) && existsSync(join(root, "scripts/verification/build.mjs"))
  ? await import("../../../scripts/verification/build.mjs") : null;

function runtimeBuildPrepared() {
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

function clearInterruptedFileLock() {
  const path = receiptPath + ".lock";
  try {
    const file = lstatSync(path);
    if (!file.isFile() || process.getuid && file.uid !== process.getuid()) {
      throw new Error(`Cannot reclaim runtime build lock ${path}: owner unavailable.`);
    }
    const owner = JSON.parse(readFileSync(path, "utf8"));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
      throw new Error(`Cannot reclaim runtime build lock ${path}: owner unavailable.`);
    }
    try { process.kill(owner.pid, 0); }
    catch (error) { if (error.code === "ESRCH") { unlinkSync(path); return; } }
    throw new Error(`Another runtime build owns ${path}: pid ${owner.pid}.`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

let lease;
if (cache) {
  clearInterruptedFileLock();
  const {acquireExclusiveSlot} = await import("../../../tools/rust-engine-program/build-slot.mjs");
  lease = acquireExclusiveSlot({root: dirname(receiptPath), kind: "runtime-build", cooperativeCancellation: false,
    metadata: {purpose: "runtime build", checkout: resolve(root), phase: "build"}});
}
try {
  if (runtimeBuildPrepared()) {
    console.log("[runtime-build] reuse prepared bundle");
  } else {
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
  }
} finally { lease?.release(); }
