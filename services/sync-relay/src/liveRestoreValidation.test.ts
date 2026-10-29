import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { resolveLiveRestorePoint, validateLiveRestoreProposal } from "@dohc/ydoc-projection/restore-proof";
import { createLiveValidationExecutor } from "./liveValidation.js";
import { LiveRestoreBusy, LiveRestoreTooLarge, liveRestoreValidator, runLiveRestoreWork, type LiveRestoreRun,
  type LiveRestoreWork } from "./liveRestoreValidation.js";

const policy = {maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pools: ReturnType<typeof createLiveValidationExecutor>[] = [];
afterEach(async () => {await Promise.all(pools.splice(0).map(pool => pool.close()));});

/** An engine restore proposal whose stored source is its only artifact. */
function engineProposal(direction: string) {
  const saved = JSON.parse(readFileSync(new URL(`../../../crates/dohc-engine-collab/tests/${direction}.json`, import.meta.url), "utf8"));
  const source = new TextEncoder().encode(saved.source);
  const stored = (digest: string) => digest === hash(source) ? source : undefined;
  const artifact = vi.fn(stored), assertCurrent = vi.fn();
  const point = {journalCursor: saved.receipt.point.journalCursor, receiptDigest: saved.receipt.point.receiptDigest};
  const selected = {binding: saved.receipt.fence.operation.oldBinding, checkpoint: {bytes: Uint8Array.from(saved.pointStateBytes)},
    events: [], point, artifact, assertCurrent};
  const accepted = {...selected, checkpoint: {bytes: Uint8Array.from(saved.acceptedCheckpoint)}};
  const capture = {selected, accepted, receipt: saved.receipt, assertCurrent};
  const bytes = {candidateBytes: Uint8Array.from(saved.candidateBytes), frozenStateBytes: Uint8Array.from(saved.frozenStateBytes),
    pointStateBytes: Uint8Array.from(saved.pointStateBytes), nativeSourceBytes: saved.nativeSourceBytes.map((b: number[]) => Uint8Array.from(b))};
  const budget = {maxBytes: 2_000_000, maxEvents: 100};
  // The same validation on the relay's thread, with direct storage reads.
  const direct = {...selected, target: "selected" as const, artifact: stored, assertCurrent() {}};
  const expected = {point: resolveLiveRestorePoint(direct, policy), validated: validateLiveRestoreProposal({selected: direct,
    accepted: {...direct, ...accepted, target: "accepted"}, receipt: saved.receipt, assertCurrent() {}}, bytes, policy, budget)};
  return {capture, bytes, budget, artifact, assertCurrent, expected};
}
const directions = ["reader-restore", "reader-to-reader", "native-to-reader", "reader-to-native"];
const point = {journalCursor: 0, receiptDigest: "b".repeat(64), markdownDigest: "c".repeat(64), projectionDigest: "d".repeat(64)};
const digest = (index: number) => index.toString(16).padStart(64, "0");
function pointCapture() {
  return {binding: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "lineage", currentPath: "a.md"},
    checkpoint: {bytes: Uint8Array.of(0, 0)}, events: [], point: {journalCursor: 0, receiptDigest: "b".repeat(64)},
    artifact: vi.fn((_digest: string): Uint8Array | undefined => undefined), assertCurrent: vi.fn()};
}

it.each(directions)("validates the %s point, proposal and review, answering each artifact once per job", async direction => {
  const f = engineProposal(direction), runs: LiveRestoreWork[] = [];
  const validator = liveRestoreValidator(async work => {runs.push(work); return runLiveRestoreWork(work, policy);});
  const measure = async <T>(job: () => Promise<T>) => {
    runs.length = 0; f.artifact.mockClear();
    const result = await job(), asked = f.artifact.mock.calls.map(([digest]) => digest);
    expect(new Set(asked).size).toBe(asked.length);
    expect(runs).toHaveLength(asked.length + 1);
    return result;
  };
  expect(await measure(() => validator.point(f.capture.selected))).toEqual(f.expected.point);
  const checked = await measure(() => validator.proposal(f.capture, f.bytes, f.budget));
  const reviewed = await measure(() => validator.proposal(f.capture, f.bytes, {...f.budget, maxOutputBytes: 2_000_000}));
  expect(checked.content).toEqual({...f.expected.validated.content});
  expect(checked.nativeSourceRanges).toEqual(f.expected.validated.nativeSourceRanges);
  expect(checked.candidateBytes).toEqual(f.bytes.candidateBytes);
  expect(checked.review).toBeUndefined();
  expect(reviewed.review).toEqual(f.expected.validated.projectReview(2_000_000));
});

it("runs every restore mode in a validation process", async () => {
  const pool = createLiveValidationExecutor(); pools.push(pool);
  const f = engineProposal("reader-to-reader"), validator = pool.restore(policy);
  expect(await validator.point(f.capture.selected)).toEqual(f.expected.point);
  expect((await validator.proposal(f.capture, f.bytes, f.budget)).content).toEqual({...f.expected.validated.content});
  expect((await validator.proposal(f.capture, f.bytes, {...f.budget, maxOutputBytes: 2_000_000})).review)
    .toEqual(f.expected.validated.projectReview(2_000_000));
  expect(f.artifact).toHaveBeenCalled();
}, 60_000);

it("keeps a refusal's message", async () => {
  const f = engineProposal("reader-to-reader"), validator = liveRestoreValidator(async work => runLiveRestoreWork(work, policy));
  const candidateBytes = f.bytes.candidateBytes.slice(); candidateBytes[0] ^= 1;
  await expect(validator.proposal(f.capture, {...f.bytes, candidateBytes}, f.budget))
    .rejects.toThrow(new Error("Restore proposal content differs from its evidence."));
});

it("caches an authenticated absence and replays it as missing", async () => {
  const capture = pointCapture(), run = vi.fn<LiveRestoreRun>(async work => {
    if (!work.answers.has(digest(1))) return {kind: "needs-artifact", digest: digest(1)};
    expect(work.answers.get(digest(1))).toBeUndefined();
    return {kind: "point", point};
  });
  expect(await liveRestoreValidator(run).point(capture)).toEqual(point);
  expect(capture.artifact).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(2);
});

it("answers 15 artifacts and refuses a job that needs a 16th", async () => {
  const enough = pointCapture();
  const run = vi.fn<LiveRestoreRun>(async work => work.answers.size === 15 ? {kind: "point", point} : {kind: "needs-artifact", digest: digest(work.answers.size)});
  expect(await liveRestoreValidator(run).point(enough)).toEqual(point);
  expect(run).toHaveBeenCalledTimes(16);
  expect(enough.artifact).toHaveBeenCalledTimes(15);
  const more = pointCapture(), endless = vi.fn<LiveRestoreRun>(async work => ({kind: "needs-artifact", digest: digest(work.answers.size)}));
  await expect(liveRestoreValidator(endless).point(more)).rejects.toThrow("Restore validation needs too many artifacts.");
  expect(endless).toHaveBeenCalledTimes(16);
  expect(more.artifact).toHaveBeenCalledTimes(15);
});

it("fails a run that asks again for an answered artifact", async () => {
  const capture = pointCapture(), run = vi.fn<LiveRestoreRun>(async () => ({kind: "needs-artifact", digest: digest(1)}));
  await expect(liveRestoreValidator(run).point(capture)).rejects.toThrow("Restore validation asked again for an answered artifact.");
  expect(capture.artifact).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(2);
});

it("checks freshness before each artifact read and after the final run", async () => {
  const capture = pointCapture(), order: string[] = [];
  capture.assertCurrent.mockImplementation(() => {order.push("current");});
  capture.artifact.mockImplementation(digest => {order.push(digest); return undefined;});
  const run: LiveRestoreRun = async work => work.answers.size === 2 ? {kind: "point", point} : {kind: "needs-artifact", digest: digest(work.answers.size)};
  expect(await liveRestoreValidator(run).point(capture)).toEqual(point);
  expect(order).toEqual(["current", digest(0), "current", digest(1), "current"]);
  const stale = pointCapture();
  stale.assertCurrent.mockImplementation(() => {throw new Error("Relay evidence changed during validation.");});
  await expect(liveRestoreValidator(async () => ({kind: "point", point})).point(stale)).rejects.toThrow("Relay evidence changed during validation.");
  await expect(liveRestoreValidator(run).point(stale)).rejects.toThrow("Relay evidence changed during validation.");
  expect(stale.artifact).not.toHaveBeenCalled();
});

it("refuses a busy pool as busy and heap exhaustion as too large, without running the job again", async () => {
  const busy = vi.fn<LiveRestoreRun>(async () => ({kind: "retry"}));
  const refusal = liveRestoreValidator(busy).point(pointCapture());
  await expect(refusal).rejects.toBeInstanceOf(LiveRestoreBusy);
  await expect(refusal).rejects.toThrow("Live validation is busy.");
  const exhausted = vi.fn<LiveRestoreRun>(async work => work.answers.size === 0 ? {kind: "needs-artifact", digest: digest(0)} : {kind: "capacity-refused"});
  const tooLarge = liveRestoreValidator(exhausted).point(pointCapture());
  await expect(tooLarge).rejects.toBeInstanceOf(LiveRestoreTooLarge);
  await expect(tooLarge).rejects.toThrow("Restore is too large to validate.");
  expect(busy).toHaveBeenCalledTimes(1);
  expect(exhausted).toHaveBeenCalledTimes(2);
});

it("passes one signal to every run and stops between runs once it aborts", async () => {
  const capture = pointCapture(), abort = new AbortController(), signals: (AbortSignal | undefined)[] = [];
  capture.artifact.mockImplementation(() => {if (signals.length === 2) abort.abort(new Error("cancelled")); return undefined;});
  const run = vi.fn<LiveRestoreRun>(async (work, signal) => {signals.push(signal); return {kind: "needs-artifact", digest: digest(work.answers.size)};});
  await expect(liveRestoreValidator(run).point(capture, abort.signal)).rejects.toThrow("cancelled");
  expect(signals).toEqual([abort.signal, abort.signal]);
});
