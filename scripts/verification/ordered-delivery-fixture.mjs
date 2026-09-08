import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { engineArtifactMatches, hashFile, repairOwnedEngineExecutable, sourceFingerprint, withBuildBudget } from "./build.mjs";
import { git, readJson, repoRoot, run } from "./process.mjs";
import { cancellationScope } from "./cancellation.mjs";

const receiptPath = join(repoRoot, ".dohc-dev/verification/ordered-delivery-fixture.json");
const fixturePath = join(repoRoot, ".dohc-dev/verification", `ordered-delivery-fixture${process.platform === "win32" ? ".exe" : ""}`);

export function orderedDeliveryArtifact(entries, root = repoRoot) {
  const expectedManifest = resolve(root, "crates/dohc-workspace-engine/Cargo.toml");
  const artifact = entries.findLast(entry => entry.reason === "compiler-artifact" && entry.target?.name === "dohc-workspace-engine"
    && entry.target?.kind?.includes("bin") && entry.profile?.test === true && entry.executable
    && typeof entry.manifest_path === "string" && resolve(entry.manifest_path) === expectedManifest);
  if (!artifact || !resolve(artifact.executable).startsWith(resolve(root, "target") + (process.platform === "win32" ? "\\" : "/"))) {
    throw new Error("Cargo did not report the native ordered delivery test executable in this checkout's target directory.");
  }
  return artifact.executable;
}

function fixtureSource() {
  const hash = createHash("sha256").update(sourceFingerprint("engine"));
  const vendor = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "vendor"]).split("\0").filter(Boolean);
  for (const path of [...new Set(vendor)].sort()) {
    hash.update(path + "\0");
    const file = join(repoRoot, path);
    hash.update(existsSync(file) ? readFileSync(file) : "<deleted>");
  }
  return hash.digest("hex");
}

export function assertOrderedDeliveryFixture(path = process.env.DOHC_ORDERED_DELIVERY_FIXTURE) {
  const receipt = readJson(receiptPath);
  if (!path || resolve(path) !== resolve(fixturePath) || receipt?.source !== fixtureSource()
    || !engineArtifactMatches(fixturePath, receipt?.artifact)) {
    throw new Error("The ordered delivery fixture is missing or differs from this checkout. Run node scripts/verification/ordered-delivery-fixture.mjs and set DOHC_ORDERED_DELIVERY_FIXTURE to its reported executable.");
  }
  return receipt;
}

export async function prepareOrderedDeliveryFixture({ output = dirname(receiptPath) } = {}) {
  mkdirSync(output, { recursive: true });
  mkdirSync(dirname(receiptPath), { recursive: true });
  const cancellation = cancellationScope("Ordered delivery fixture preparation");
  let failure;
  try {
  const source = fixtureSource(), previous = readJson(receiptPath);
  await cancellation.checkpoint();
  if (previous?.source === source && engineArtifactMatches(fixturePath, previous.artifact)) return previous;
  const lock = receiptPath + ".lock";
  writeFileSync(lock, JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}), {flag:"wx"});
  try {
  await withBuildBudget(async env => {
    await cancellation.checkpoint();
    const result = await run("cargo", ["test", "--locked", "--target-dir", join(repoRoot, "target"), "-p", "dohc-workspace-engine",
      "--bin", "dohc-workspace-engine", "--features", "harness", "--no-run", "--message-format=json-render-diagnostics"],
    { env, log: join(output, "ordered-delivery-fixture-build.log"), quietStdout: true });
    const artifacts = result.stdout.split(/\r?\n/).filter(line => line.startsWith("{")).map(line => JSON.parse(line));
    await cancellation.checkpoint();
    copyFileSync(orderedDeliveryArtifact(artifacts), fixturePath);
  });
  repairOwnedEngineExecutable(fixturePath);
  if (fixtureSource() !== source) throw new Error("Ordered delivery fixture inputs changed during its build.");
  const receipt = { path: fixturePath, source, artifact: hashFile(fixturePath), commit: git(["rev-parse", "HEAD"]), builtAt: new Date().toISOString() };
  await cancellation.checkpoint();
  writeFileSync(receiptPath + ".tmp", JSON.stringify(receipt, null, 2) + "\n");
  renameSync(receiptPath + ".tmp", receiptPath);
  return receipt;
  } finally { unlinkSync(lock); }
  } catch (error) { failure = error; throw error; }
  finally {
    const interrupted = await cancellation.dispose();
    if (!failure && interrupted) throw interrupted;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  prepareOrderedDeliveryFixture().then(receipt => console.log(receipt.path)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
