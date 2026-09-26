import assert from "node:assert/strict";
import test from "node:test";
import { timed } from "./timing.mjs";

test("timing records synchronous failure and preserves the thrown error", async () => {
  const row = {}, snapshots = [], failure = new Error("fingerprint failed");
  await assert.rejects(timed(row, () => { throw failure; }, () => snapshots.push({...row})), error => error === failure);
  assert.equal(snapshots[0].verdict, "RUNNING");
  assert.equal(snapshots[0].finishedAt, undefined);
  assert.equal(row.verdict, "FAIL");
  assert.equal(row.error, failure.message);
  assert.ok(Number.isFinite(Date.parse(row.startedAt)));
  assert.ok(Number.isFinite(Date.parse(row.finishedAt)));
  assert.ok(row.seconds >= 0);
});

test("timing stays open until asynchronous cleanup completes", async () => {
  const row = {};
  let release;
  const pending = timed(row, () => new Promise(resolve => { release = resolve; }));
  assert.equal(row.verdict, "RUNNING");
  assert.equal(row.finishedAt, undefined);
  release("removed");
  assert.equal(await pending, "removed");
  assert.equal(row.verdict, "PASS");
  assert.ok(row.seconds >= 0);
  assert.ok(Number.isFinite(Date.parse(row.finishedAt)));
});
