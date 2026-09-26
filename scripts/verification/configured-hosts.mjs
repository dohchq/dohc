import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cancellationScope } from "./cancellation.mjs";
import { git, pnpm, repoRoot, run } from "./process.mjs";

const usage = "pnpm verify:configured-hosts --binary ABSOLUTE_ENGINE_PATH --build-receipt ABSOLUTE_BUILD_JSON";
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const nativeInputs = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo", "crates", "vendor"];

export function readConfiguredHostProof(kind, tests, evidence, binary, sha256) {
  assert(["service", "device"].includes(kind), "Unknown configured host proof.");
  const expectedCases = kind === "service" ? 2 : 1;
  const result = JSON.parse(readFileSync(tests, "utf8"));
  assert.equal(result.success, true);
  assert.equal(result.numTotalTests, expectedCases);
  assert.equal(result.numPassedTests, expectedCases);
  assert.equal(result.numFailedTests, 0);
  assert.equal(result.numPendingTests, 0);
  assert.equal(result.numTodoTests, 0);
  const cases = readdirSync(evidence, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith("case-"));
  assert.equal(cases.length, expectedCases);
  for (const entry of cases) {
    const proof = JSON.parse(readFileSync(join(evidence, entry.name, "result.json"), "utf8"));
    assert.equal(proof.verdict, "PASS", entry.name);
    assert.equal(proof.sha256, sha256, entry.name);
    assert.equal(proof.executable, binary, entry.name);
  }
}

export async function verifyConfiguredHosts(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { binary: { type: "string" },
    "build-receipt": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) { console.log(usage); return; }
  assert(values.binary && isAbsolute(values.binary), usage);
  assert(values["build-receipt"] && isAbsolute(values["build-receipt"]), usage);
  const buildEvidence = realpathSync(values["build-receipt"]);
  const receipt = JSON.parse(readFileSync(buildEvidence, "utf8"));
  assert.equal(receipt.version, 1, "Expected a repository verification build receipt.");
  assert(/^[a-f0-9]{64}$/i.test(receipt.engine?.artifact ?? ""), "Build receipt lacks an engine hash.");
  assert(/^[a-f0-9]{40}$/i.test(receipt.engine?.commit ?? ""), "Build receipt lacks an engine commit.");
  const binary = realpathSync(values.binary), sha256 = receipt.engine.artifact.toLowerCase();
  const sourceCommit = git(["rev-parse", `${receipt.engine.commit}^{commit}`]);
  assert.equal(hash(binary), sha256, "Native executable differs from the supplied build hash.");
  assert.equal(git(["diff", sourceCommit, "--", ...nativeInputs]), "", "Native source differs from the supplied build commit.");
  assert.equal(git(["ls-files", "--others", "--exclude-standard", "--", ...nativeInputs]), "", "Untracked native inputs are not covered by the build commit.");
  const output = join(repoRoot, ".agent-artifacts/configured-hosts", new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID().slice(0, 8));
  mkdirSync(output, { recursive: true });
  const report = { commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "", output,
    binary: { path: binary, sha256, sourceCommit, buildEvidence, buildEvidenceSha256: hash(buildEvidence) },
    startedAt: new Date().toISOString(), verdict: "RUNNING", steps: [] };
  const source = () => {
    const digest = createHash("sha256");
    const paths = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
    for (const path of [...new Set(paths)].sort()) {
      digest.update(path + "\0");
      try {
        const file = join(repoRoot, path);
        digest.update(lstatSync(file).isSymbolicLink() ? readlinkSync(file) : readFileSync(file));
      }
      catch (error) { if (error.code !== "ENOENT") throw error; digest.update("<deleted>"); }
      digest.update("\0");
    }
    return digest.digest("hex");
  };
  const startingSource = source();
  const cancellation = cancellationScope("Configured host verification");
  const save = () => writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  save();
  async function step(name, args, env = process.env) {
    await cancellation.checkpoint();
    const row = { name, startedAt: new Date().toISOString(), verdict: "RUNNING" };
    report.steps.push(row); save();
    try {
      await run(...pnpm(args), { cwd: repoRoot, env, timeoutMs: 180_000,
        log: join(output, name + ".log"), onSpawn: child => { row.pid = child.pid; save(); } });
      row.verdict = "PASS";
    } catch (error) { row.verdict = "FAIL"; throw error; }
    finally { row.closedAt = new Date().toISOString(); save(); }
  }
  try {
    await step("relay-build", ["--filter", "@dohc/sync-relay", "build"]);
    for (const kind of ["service", "device"]) {
      const tests = join(output, `${kind}-vitest.json`), evidence = join(output, kind);
      const prefix = `DOHC_${kind.toUpperCase()}_HOST_PROOF_`;
      await step(kind, ["exec", "vitest", "run", "--config", `scripts/verification/${kind}-host.vitest.mjs`,
        "--maxWorkers=1", "--reporter=json", "--outputFile", tests],
      { ...process.env, [prefix + "BINARY"]: binary, [prefix + "SHA256"]: sha256, [prefix + "OUTPUT"]: evidence });
      readConfiguredHostProof(kind, tests, evidence, binary, sha256);
    }
    assert.equal(hash(binary), sha256);
    assert.equal(hash(buildEvidence), report.binary.buildEvidenceSha256);
    assert.equal(source(), startingSource, "Source changed during configured host verification.");
    assert.equal(git(["rev-parse", "HEAD"]), report.commit);
    await cancellation.checkpoint();
    report.verdict = "PASS";
    return report;
  } catch (error) { report.verdict = "FAIL"; report.error = String(error); throw error; }
  finally {
    const interrupted = await cancellation.dispose();
    if (interrupted) { report.verdict = "FAIL"; report.error ??= interrupted.message; }
    report.closedAt = new Date().toISOString(); save();
    console.log(`[configured-hosts] ${report.verdict}: ${join(output, "result.json")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  verifyConfiguredHosts().catch(error => { console.error(error.message); process.exitCode = 1; });
}
