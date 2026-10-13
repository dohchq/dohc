import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseArgs, runHistoryBenchmark } from "./history-query-benchmark.mjs";

async function fixture(t) {
  const parent = resolve(".agent-artifacts/history-page/runner-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exe = join(root, "fixture-executable");
  await writeFile(exe, "fixture");
  return { root, exe, mode: "candidate" };
}

test("History runner validates its executable and arm arguments", () => {
  assert.deepEqual(parseArgs(["--exe", "binary", "--mode", "baseline"]), { exe: resolve("binary"), mode: "baseline" });
  for (const args of [[], ["--exe", "x"], ["--exe", "x", "--mode", "debug"], ["--exe", "x", "--mode", "candidate", "--exe", "y"]])
    assert.throws(() => parseArgs(args), /Usage/u);
});

test("History runner never launches a child after admission refusal or a disk-floor refusal", async t => {
  const spec = await fixture(t);
  let launched = false;
  const execute = async () => { launched = true; };
  await assert.rejects(runHistoryBenchmark(spec, { disk: () => 45, execute, admit() { throw Error("host busy"); } }), /host busy/u);
  await assert.rejects(runHistoryBenchmark(spec, { disk: () => 39, execute, admit() { throw Error("should not admit"); } }), /40 GB/u);
  assert.equal(launched, false);
});

test("History runner passes admission cancellation to the owned child and releases after exit", async t => {
  const spec = await fixture(t);
  const controller = new AbortController();
  let exited = false, released = false;
  await assert.rejects(runHistoryBenchmark(spec, {
    disk: () => 45,
    admit: () => ({ signal: controller.signal, evidence: { samples: 2 }, check() {}, release() { assert.equal(exited, true); released = true; } }),
    async execute(_exe, _args, options) {
      assert.equal(options.signal, controller.signal);
      options.onSpawn({ pid: 123 });
      controller.abort(Error("new gate arrived"));
      exited = true;
      throw Error("child interrupted");
    },
  }), /new gate arrived/u);
  assert.equal(released, true);
});

test("History runner retains release results and rejects debug results or a revoked completion", async t => {
  for (const fault of ["none", "debug", "completion"]) await t.test(fault, async context => {
    const spec = await fixture(context);
    let exited = false, released = false;
    const options = {
      disk: () => 45,
      admit: () => ({ signal: new AbortController().signal, evidence: { samples: 2 },
        check() { if (fault === "completion" && exited) throw Error("completion refused"); },
        release() { assert.equal(exited, true); released = true; } }),
      async execute(exe, args, options) {
        assert.equal(exe, spec.exe);
        assert.deepEqual(args, ["history_page_benchmark", "--exact", "--ignored", "--nocapture"]);
        assert.equal(options.env.HISTORY_BENCH_MODE, "candidate");
        assert.equal(options.env.HISTORY_BENCH_ENTRIES, "100000");
        assert.ok(options.env.DOHC_TEST_SCRATCH_ROOT.startsWith(spec.root));
        options.onSpawn({ pid: 123 });
        exited = true;
        return { stdout: 'test history_page_benchmark ... HISTORY_BENCH ' + JSON.stringify({ build: fault === "debug" ? "debug" : "release", mode: "candidate", entries: 100000, save: { p50Ms: 1 }, importPerMoment: { p50Ms: 0.01 } }) + "\n" };
      },
    };
    if (fault === "none") {
      const { output, measurements } = await runHistoryBenchmark(spec, options);
      const receipt = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
      assert.equal(receipt.state, "passed");
      assert.equal(receipt.pid, 123);
      assert.equal(receipt.sha256.length, 64);
      assert.deepEqual(receipt.measurements, measurements);
      assert.equal(receipt.hostContext.samples, 2);
    } else await assert.rejects(runHistoryBenchmark(spec, options), fault === "debug" ? /release profile/u : /completion refused/u);
    assert.equal(released, true);
  });
});
