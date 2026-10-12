import { copyFileSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { engineArtifactMatches, hashFile, repairOwnedEngineExecutable, sourceFingerprint, withBuildBudget } from "./build.mjs";
import { cancellationScope } from "./cancellation.mjs";
import { git, readJson, repoRoot, run } from "./process.mjs";

const receiptPath = join(repoRoot, ".dohc-dev/verification/yrs-interop.json");
const binaryPath = join(dirname(receiptPath), `dohc-yrs-interop${process.platform === "win32" ? ".exe" : ""}`);
const ownedPath = path => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

export function interopArtifact(entries, root = repoRoot) {
  const manifest = ownedPath(join(root, "crates/yrs-interop/Cargo.toml"));
  const artifact = entries.findLast(entry => entry.reason === "compiler-artifact"
    && entry.target?.name === "dohc-yrs-interop" && entry.target?.kind?.includes("bin")
    && entry.profile?.test === false && entry.executable
    && typeof entry.manifest_path === "string" && ownedPath(entry.manifest_path) === manifest);
  if (!artifact || !ownedPath(artifact.executable).startsWith(ownedPath(join(root, "target")) + sep)) {
    throw new Error("Cargo did not report the interop executable in this checkout's target directory.");
  }
  return artifact.executable;
}

export function assertInteropPrepared() {
  const receipt = readJson(receiptPath);
  if (!receipt || typeof receipt.path !== "string" || ownedPath(receipt.path) !== ownedPath(binaryPath)
    || receipt.source !== sourceFingerprint("engine") || !engineArtifactMatches(binaryPath, receipt.artifact)) {
    throw new Error("The yrs interop harness is missing or differs from this checkout. Run node scripts/verification/yrs-interop.mjs before fidelity or fuzz.");
  }
  return receipt;
}

export async function prepareInterop({ output = dirname(receiptPath) } = {}) {
  mkdirSync(output, { recursive: true });
  mkdirSync(dirname(receiptPath), { recursive: true });
  const cancellation = cancellationScope("Yrs interop preparation");
  let failure;
  try {
    const source = sourceFingerprint("engine"), previous = readJson(receiptPath);
    await cancellation.checkpoint();
    if (typeof previous?.path === "string" && ownedPath(previous.path) === ownedPath(binaryPath)
      && previous.source === source && engineArtifactMatches(binaryPath, previous.artifact)) return previous;
    const lock = receiptPath + ".lock";
    try { writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" }); }
    catch (error) { if (error.code === "EEXIST") throw new Error(`Another preparation owns ${lock}. Inspect its PID before removing a stale lock.`); throw error; }
    const temporaryBinary = binaryPath + ".tmp";
    try {
      await withBuildBudget(async env => {
        await cancellation.checkpoint();
        const result = await run("cargo", ["build", "--locked", "--target-dir", join(repoRoot, "target"),
          "-p", "dohc-yrs-interop", "--bin", "dohc-yrs-interop", "--message-format=json-render-diagnostics"],
        { env, log: join(output, "yrs-interop-build.log"), quietStdout: true });
        const entries = result.stdout.split(/\r?\n/).filter(line => line.startsWith("{")).map(line => JSON.parse(line));
        await cancellation.checkpoint();
        copyFileSync(interopArtifact(entries), temporaryBinary);
      });
      repairOwnedEngineExecutable(temporaryBinary);
      if (sourceFingerprint("engine") !== source) throw new Error("Yrs interop inputs changed during its build.");
      await cancellation.checkpoint();
      renameSync(temporaryBinary, binaryPath);
      const receipt = { path: binaryPath, source, artifact: hashFile(binaryPath), commit: git(["rev-parse", "HEAD"]), builtAt: new Date().toISOString() };
      await cancellation.checkpoint();
      writeFileSync(receiptPath + ".tmp", JSON.stringify(receipt, null, 2) + "\n");
      renameSync(receiptPath + ".tmp", receiptPath);
      return receipt;
    } finally {
      rmSync(temporaryBinary, { force: true });
      rmSync(receiptPath + ".tmp", { force: true });
      unlinkSync(lock);
    }
  } catch (error) { failure = error; throw error; }
  finally {
    const interrupted = await cancellation.dispose();
    if (!failure && interrupted) throw interrupted;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  prepareInterop().then(receipt => console.log(receipt.path)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
