import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { attemptOutcome, queuePaths, readJson, writeJson } from "./queue.mjs";
import { defaultMemoryFailGb, runService, trustCheckFailure } from "./queue-service.mjs";

const gates = { rust: true, js: false };
const receipt = {
  verdict: "FAIL",
  failure: { kind: "check", cause: "rust" },
  error: "clippy failed: unused import",
  failed: [],
};
const failure = { outcome: "failed", cause: "check", reason: receipt.error };
const low = { memory: "free memory fell to 1.2 GB" };
const classify = (result = receipt, previous, host = low, selected = gates) =>
  trustCheckFailure(failure, result, selected, previous, host);

test("memory failure default scales to total RAM and caps at 3 GB", () => {
  assert.equal(defaultMemoryFailGb(16 * 1024 ** 3), 1.6);
  assert.equal(defaultMemoryFailGb(32 * 1024 ** 3), 3);
  assert.equal(defaultMemoryFailGb(64 * 1024 ** 3), 3);
});

test("only consecutive matching low-memory failures corroborate a check", () => {
  const first = classify();
  assert.equal(first.outcome, "environment");
  assert.equal(first.cause, "host");
  assert.ok(first.lowMemoryFailure);
  assert.equal(classify(receipt, first).outcome, "failed");
  assert.match(classify(receipt, first).reason, /repeated under low memory/u);
  for (const changed of [
    { ...receipt, error: "clippy failed: another error" },
    { ...receipt, failure: { kind: "check", cause: "repository" } },
    { ...receipt, failed: [{ step: "rust", test: "another test" }] },
    { ...receipt, gates: { js: true, rust: true } },
  ])
    assert.equal(classify(changed, first).outcome, "environment");
  const named = { ...receipt, failed: [{ step: "rust", test: "one" }] };
  const namedFirst = classify(named);
  assert.equal(
    classify({ ...named, failed: [{ step: "rust", test: "two" }] }, namedFirst).outcome,
    "environment",
  );
  assert.equal(classify(receipt, first, low, { js: true, rust: true }).outcome, "environment");
  for (const outcome of ["passed", "cancelled"]) {
    // Even a retained signature cannot match across the immediately previous attempt.
    assert.equal(classify(receipt, { ...first, outcome }).outcome, "environment");
    const attempts = [first, { outcome, cause: outcome }];
    assert.equal(classify(receipt, attempts.at(-1)).outcome, "environment");
  }
  const empty = { failure: { kind: "check", cause: "verification" } };
  assert.equal(classify(empty).lowMemoryFailure, undefined);
  assert.equal(classify(empty, classify(empty)).outcome, "environment");
  const tests = [
    { step: "rust", test: "a" },
    { step: "rust", test: "b" },
  ];
  assert.equal(
    classify({ ...receipt, failed: tests.toReversed() }, classify({ ...receipt, failed: tests }))
      .outcome,
    "failed",
  );
  // A package test failure names a log under the attempt folder, and its step row has no log.
  const commandFailure = (output) => ({
    ...receipt,
    output,
    failure: { kind: "check", cause: "tests" },
    error: `pnpm failed (1). Log: ${output}/js-tests/pkg.log`,
    steps: [{ name: "tests", runner: "testWorkspace" }],
  });
  assert.equal(
    classify(commandFailure("/attempts/2"), classify(commandFailure("/attempts/1"))).outcome,
    "failed",
  );
  assert.equal(
    classify(
      { ...commandFailure("/attempts/2"), output: undefined },
      classify(commandFailure("/attempts/1")),
    ).outcome,
    "environment",
  );
});

test("repeated disk and Docker failures stay untrusted, including alongside low memory", () => {
  for (const host of [
    { disk: "free disk fell to 0.5 GB" },
    { docker: "Docker stopped responding" },
    { ...low, disk: "free disk fell to 0.5 GB" },
    { ...low, docker: "Docker stopped responding" },
  ]) {
    const first = classify(receipt, undefined, host);
    assert.equal(first.lowMemoryFailure, undefined);
    assert.equal(classify(receipt, first, host).outcome, "environment");
    assert.equal(classify(receipt, classify(), host).outcome, "environment");
  }
});

// The service runs only on private files, a stub worker, and a virtual clock.
async function serviceHarness(
  t,
  { memory = 1.2, memoryFailGb = 1.6, freeDisk = () => 100, docker = async () => true } = {},
) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
  const root = mkdtempSync(join(tmpdir(), "dohc-queue-memory-"));
  const paths = queuePaths(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { windowsHide: true });
  const stop = new AbortController();
  const pending = [];
  const pump = async (condition) => {
    for (let i = 0; i < 2000; i++) {
      await setImmediate();
      t.mock.timers.tick(20);
      if (condition()) return;
    }
    assert.fail("virtual service did not reach the expected condition");
  };
  const service = runService({
    root,
    repo,
    stop: stop.signal,
    tickMs: 20,
    heartbeatMs: 20,
    floorGb: 1,
    memoryFailGb,
    freeDisk,
    freeMemory: () => memory,
    docker,
    prepare: async () => {},
    sweep: async () => {},
    holdLane: async () => ({ release() {} }),
    strays: async () => {},
    keepAwake: () => () => {},
    threadOf: () => null,
    log: () => {},
    retryDelay: () => 100,
    worker: ({ grant, output }) => new Promise((done) => pending.push({ grant, output, done })),
  });
  t.after(async () => {
    stop.abort();
    for (const run of pending.splice(0)) run.done();
    let ended = false;
    service.finally(() => {
      ended = true;
    });
    await pump(() => ended);
    await service;
    rmSync(root, { recursive: true, force: true });
  });
  const status = (id) => readJson(join(paths.request(id), "status.json"));
  const submit = async (id, selected = gates) => {
    mkdirSync(paths.request(id), { recursive: true });
    await writeJson(join(paths.request(id), "request.json"), {
      id,
      head: "a".repeat(40),
      base: "b".repeat(40),
      gates: selected,
      checkout: id,
      scope: "rust",
      acceptedAt: new Date().toISOString(),
    });
    await writeJson(join(paths.request(id), "status.json"), { state: "queued", attempts: [] });
    await pump(() => pending.length > 0);
  };
  const complete = async (fields = receipt, { javascript = false } = {}) => {
    const run = pending.shift();
    // One clock sample while the worker is held records the injected free memory.
    t.mock.timers.tick(20);
    // A package test failure names a log in a folder of the attempt, and its step row has no log.
    const log = javascript ? join(run.output, "js-tests", "pkg.log") : join(run.output, "rust.log");
    const result = {
      ...fields,
      ...(javascript ? { failure: { kind: "check", cause: "tests" } } : {}),
      output: run.output,
      error: `${fields.error} Log: ${log}`,
      steps: javascript
        ? [{ name: "tests", runner: "testWorkspace" }]
        : [{ name: fields.failure.cause, log }],
      grant: run.grant,
      commit: run.grant.head,
      baseCommit: run.grant.base,
      final: true,
    };
    writeFileSync(join(run.output, "result.json"), JSON.stringify(result));
    run.done();
    await pump(() => status(run.grant.request)?.attempts.at(-1)?.endedAt);
    return result;
  };
  return { submit, complete, status, pending, pump, paths };
}

test("service trusts the second low-memory failure, keeps its verdict, and resets host health", async (t) => {
  const h = await serviceHarness(t);
  await h.submit("first");
  await h.complete();
  const first = h.status("first");
  assert.equal(first.state, "queued");
  assert.match(first.waiting, /Retrying/u);
  assert.equal(first.attempts[0].outcome, "environment");
  assert.equal(first.attempts[0].cause, "host");
  assert.ok(first.attempts[0].lowMemoryFailure);
  await h.pump(() => h.pending.length > 0);
  const result = await h.complete();
  const final = h.status("first");
  assert.equal(final.state, "failed");
  assert.equal(final.verdict, "FAIL");
  assert.equal(final.attempts[1].cause, "check");
  assert.match(final.reason, /repeated under low memory/u);
  assert.deepEqual(readJson(final.result), result);
  assert.equal(attemptOutcome(result, result.grant).outcome, "failed");
  await h.submit("next");
  await h.complete();
  await h.pump(() => h.pending.length > 0);
  assert.equal(
    readJson(h.paths.service).health.pausedUntil,
    null,
    "one new environment failure does not pause admission after the trusted failure",
  );
  await h.complete();
});

test("service trusts a repeated JavaScript test failure whose log sits in the attempt folder", async (t) => {
  const h = await serviceHarness(t);
  await h.submit("javascript", { rust: false, js: true });
  await h.complete(receipt, { javascript: true });
  assert.equal(h.status("javascript").state, "queued");
  await h.pump(() => h.pending.length > 0);
  await h.complete(receipt, { javascript: true });
  const final = h.status("javascript");
  assert.equal(final.state, "failed");
  assert.equal(final.attempts[1].cause, "check");
  assert.match(final.attempts[0].lowMemoryFailure, /^[0-9a-f]{64}$/u);
});

for (const [memory, expected] of [
  [2.8, "failed"],
  [1.2, "queued"],
]) {
  test(`service on the 16 GiB default records ${memory} GB free as ${expected}`, async (t) => {
    const h = await serviceHarness(t, {
      memory,
      memoryFailGb: defaultMemoryFailGb(16 * 1024 ** 3),
    });
    await h.submit("default");
    await h.complete();
    assert.equal(h.status("default").state, expected);
  });
}

for (const changed of [
  { ...receipt, failed: [{ step: "rust", test: "another test" }] },
  { ...receipt, failure: { kind: "check", cause: "repository" } },
]) {
  test(`service retries a different low-memory failure: ${changed.failure.cause}, ${changed.failed[0]?.test ?? "no test"}`, async (t) => {
    const h = await serviceHarness(t);
    await h.submit("different");
    await h.complete();
    await h.pump(() => h.pending.length > 0);
    await h.complete(changed);
    const status = h.status("different");
    assert.equal(status.state, "queued");
    assert.equal(status.attempts.length, 2);
    assert.ok(
      status.attempts.every((row) => row.outcome === "environment" && row.cause === "host"),
    );
  });
}

for (const cause of ["disk", "docker"]) {
  test(`service keeps repeated ${cause} failures untrusted even with low memory`, async (t) => {
    let failing = false;
    const h = await serviceHarness(t, {
      freeDisk: () => (cause === "disk" && failing ? 0.5 : 100),
      docker: async () => cause !== "docker" || !failing,
    });
    await h.submit("host", { js: true, rust: true });
    failing = true;
    await h.complete();
    failing = false;
    await h.pump(() => h.pending.length > 0);
    failing = true;
    await h.complete();
    const status = h.status("host");
    assert.equal(status.state, "queued");
    assert.equal(status.attempts.length, 2);
    for (const row of status.attempts) {
      assert.equal(row.outcome, "environment");
      assert.equal(row.lowMemoryFailure, undefined);
      assert.match(row.reason, cause === "disk" ? /free disk/u : /Docker/u);
    }
  });
}
