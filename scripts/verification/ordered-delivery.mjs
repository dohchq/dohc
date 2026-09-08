import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { sourceFingerprint } from "./build.mjs";
import { cancellationScope } from "./cancellation.mjs";
import { assertOrderedDeliveryFixture, prepareOrderedDeliveryFixture } from "./ordered-delivery-fixture.mjs";
import { git, pnpm, repoRoot, run } from "./process.mjs";

export async function verifyOrderedDelivery() {
  const output = join(repoRoot, ".agent-artifacts/ordered-delivery", new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID().slice(0, 8));
  mkdirSync(output, { recursive: true });
  const report = { commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "", output,
    startedAt: new Date().toISOString(), verdict: "RUNNING", steps: [] };
  const startingSource = { engine: sourceFingerprint("engine"), desktop: sourceFingerprint("desktop") };
  const cancellation = cancellationScope("Ordered delivery verification");
  const save = () => writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  save();
  async function step(name, command, args, env = process.env) {
    await cancellation.checkpoint();
    const row = { name, startedAt: new Date().toISOString(), verdict: "RUNNING" };
    report.steps.push(row); save();
    try {
      await run(command, args, { cwd: repoRoot, env, log: join(output, name + ".log"), onSpawn: child => { row.pid = child.pid; save(); } });
      row.verdict = "PASS";
    } catch (error) { row.verdict = "FAIL"; throw error; }
    finally { row.closedAt = new Date().toISOString(); save(); }
  }
  try {
    await step("preparation-tests", process.execPath, ["--test", "scripts/verification/ordered-delivery-fixture.test.mjs"]);
    report.fixture = await prepareOrderedDeliveryFixture({ output }); save();
    await cancellation.checkpoint();
    const tests = join(output, "vitest.json"), evidence = join(output, "evidence");
    await step("integration", ...pnpm(["exec", "vitest", "run", "--config", "scripts/verification/ordered-delivery.vitest.mjs", "--reporter=json", "--outputFile", tests]),
      { ...process.env, DOHC_ORDERED_DELIVERY_FIXTURE: report.fixture.path, DOHC_ORDERED_DELIVERY_EVIDENCE: evidence });
    const result = JSON.parse(readFileSync(tests, "utf8"));
    assert.equal(result.success, true);
    assert.equal(result.numTotalTests, 1);
    assert.equal(result.numPassedTests, 1);
    assert.equal(result.numPendingTests, 0);
    report.proof = JSON.parse(readFileSync(join(evidence, "result.json"), "utf8"));
    assert.equal(report.proof.verdict, "PASS");
    assert.equal(report.proof.results.length, 4);
    report.closure = [1, 2, 3, 4].map(round => JSON.parse(readFileSync(join(evidence, `round-${round}`, "closed.json"), "utf8")));
    for (const closed of report.closure) assert.equal(closed.code, 0);
    assertOrderedDeliveryFixture(report.fixture.path);
    for (const [kind, source] of Object.entries(startingSource)) assert.equal(sourceFingerprint(kind), source, `${kind} source changed during verification`);
    assert.equal(git(["rev-parse", "HEAD"]), report.commit);
    await cancellation.checkpoint();
    report.verdict = "PASS";
    return report;
  } catch (error) { report.verdict = "FAIL"; report.error = String(error); throw error; }
  finally {
    const interrupted = await cancellation.dispose();
    if (interrupted) { report.verdict = "FAIL"; report.error ??= interrupted.message; }
    report.closedAt = new Date().toISOString(); save();
    console.log(`[ordered-delivery] ${report.verdict}: ${join(output, "result.json")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  verifyOrderedDelivery().catch(error => { console.error(error.message); process.exitCode = 1; });
}
