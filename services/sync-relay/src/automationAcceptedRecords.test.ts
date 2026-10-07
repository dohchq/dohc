import {expect, it, vi} from "vitest";
import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import type {AutomationReplica} from "./automationReplicas";
import type {LiveUpdateJournalCutResult} from "./storage/types";
import {createAutomationAcceptedRecords} from "./automationAcceptedRecords";
import {AutomationRunWait} from "@dohc/automation-executor/button-presser";

const binding: LiveObjectBinding = {workspaceId: "work", mainVersionId: "main", objectId: "record", lineageClaimId: "a".repeat(64),
  currentPath: "Tasks/one.md", selectorPaths: ["Tasks"], restoreFenceGeneration: 0};

function fixture() {
  const cursors = new Map([[binding.objectId, 1]]);
  const accepted = new Map([[binding.objectId, 1]]);
  const bindings = new Map([[binding.currentPath, binding]]);
  const list = vi.fn(async () => ({drafts: [{binding, acceptedCursor: 1}], next: null}));
  const read = vi.fn(async (_request, {binding: target}: {binding: LiveObjectBinding}) => ({acceptedCursor: accepted.get(target.objectId)!, revision: 1, nativeHeadSequence: 1}));
  const apply = vi.fn(async (_request, input) => {
    accepted.set(input.binding.objectId, input.journalCursor);
    return {acceptedCursor: input.journalCursor, revision: input.expectedRevision + 1, nativeHeadSequence: input.expectedNativeHeadSequence + 1};
  });
  const readCut = vi.fn(({document}: {document: Pick<LiveObjectBinding, "objectId">}) => {
    const current = [...bindings.values()].find(value => value.objectId === document.objectId)!;
    const highWater = cursors.get(document.objectId)!;
    return {kind: "cut", cut: {currentPath: current.currentPath, restoreFenceGeneration: current.restoreFenceGeneration,
      checkpoint: {cursor: null}, suffix: [{cursor: highWater, bytes: Uint8Array.of(0, 0)}]}} as unknown as LiveUpdateJournalCutResult;
  });
  const replica = {workspaceId: "work", ownerUserId: "owner", workspace: "handle", signal: new AbortController().signal,
    nextRequestId: () => 1, withRecordWork: async <T>(work: () => Promise<T>) => work(),
    client: {ownerYDocListDrafts: list, ownerYDocReadState: read, ownerYDocApplyAcceptedFrame: apply}} as unknown as AutomationReplica;
  const synchronize = vi.fn(async (target: LiveObjectBinding) => {accepted.set(target.objectId, cursors.get(target.objectId)!);});
  const onError = vi.fn();
  const tracker = createAutomationAcceptedRecords({replica, namespace: "relay", synchronize, onError,
    storage: {automationRecordBinding: (_workspace, _owner, path) => {
      const current = bindings.get(path); return current ? {binding: current, shareId: "share"} : null;
    }, automationRecordJournalCursor: target => cursors.get(target.objectId)!, readLiveUpdateJournalCut: readCut}});
  return {tracker, replica, cursors, accepted, bindings, list, read, readCut, apply, synchronize, onError};
}

it("refreshes an enrolled record after another accepted edit, without rescanning unchanged records", async () => {
  const f = fixture();
  await f.tracker.initialize();
  await f.tracker.refreshChanged();
  expect(f.synchronize).not.toHaveBeenCalled();
  // Between two automation writes, the reader's accepted update advances the relay.
  f.cursors.set(binding.objectId, 2);
  await f.tracker.refreshChanged();
  expect(f.accepted.get(binding.objectId)).toBe(2);
  expect(f.apply).toHaveBeenCalledTimes(1);
  await f.tracker.refresh(binding.currentPath);
  await f.tracker.refreshChanged();
  expect(f.apply).toHaveBeenCalledTimes(1);
  expect(f.synchronize).not.toHaveBeenCalled();
  expect(f.list).toHaveBeenCalledTimes(1);
});

it("enrolls a newly read record and tracks a binding change even at the same cursor", async () => {
  const f = fixture();
  const second = {...binding, objectId: "two", currentPath: "Tasks/two.md"};
  f.bindings.set(second.currentPath, second);
  f.cursors.set(second.objectId, 1);
  await f.tracker.refresh(second.currentPath);
  expect(f.synchronize).toHaveBeenCalledWith(second, expect.any(AbortSignal));
  f.bindings.set(second.currentPath, {...second, restoreFenceGeneration: 1});
  await f.tracker.refresh(second.currentPath);
  expect(f.synchronize).toHaveBeenCalledTimes(2);
});

it("leaves a capacity-refused refresh for the next pass without tracking it as current", async () => {
  const f = fixture();
  f.cursors.set(binding.objectId, 2);
  f.synchronize.mockRejectedValueOnce(new AutomationRunWait("Waiting for live capacity"));
  await expect(f.tracker.refresh(binding.currentPath)).rejects.toBeInstanceOf(AutomationRunWait);
  expect(f.synchronize).toHaveBeenCalledOnce();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.accepted.get(binding.objectId)).toBe(1);
  await f.tracker.refresh(binding.currentPath);
  expect(f.synchronize).toHaveBeenCalledTimes(2);
  expect(f.accepted.get(binding.objectId)).toBe(2);
});

it("reports one native guard refusal and still refreshes every other enrolled record", async () => {
  const f = fixture();
  const second = {...binding, objectId: "two", currentPath: "Tasks/two.md"};
  f.bindings.set(second.currentPath, second);
  f.cursors.set(second.objectId, 1); f.accepted.set(second.objectId, 1);
  await f.tracker.initialize(); await f.tracker.track(second);
  f.cursors.set(binding.objectId, 2); f.cursors.set(second.objectId, 2);
  f.apply.mockImplementation(async (_request, input) => {
    if (input.binding.objectId === binding.objectId) throw new Error("parent mismatch");
    f.accepted.set(input.binding.objectId, input.journalCursor);
    return {acceptedCursor: input.journalCursor, revision: 2, nativeHeadSequence: 2};
  });
  await f.tracker.refreshChanged();
  expect(f.onError).toHaveBeenCalledWith(binding.currentPath, expect.any(Error));
  expect(f.accepted.get(second.objectId)).toBe(2);
});

it("refreshes accepted frames while the draft lane never resolves and the owner capture is offline", async () => {
  const f = fixture();
  f.replica.withRecordWork = () => new Promise(() => {});
  f.synchronize.mockRejectedValue(new Error("Device delivery is unavailable."));
  f.cursors.set(binding.objectId, 2);
  await f.tracker.refreshChanged();
  expect(f.accepted.get(binding.objectId)).toBe(2);
  expect(f.synchronize).not.toHaveBeenCalled();
  expect(f.onError).not.toHaveBeenCalled();
});

it("advances from a validated aggregate checkpoint before applying its accepted suffix", async () => {
  const f = fixture();
  f.cursors.set(binding.objectId, 4);
  f.readCut.mockReturnValue({kind: "cut", cut: {currentPath: binding.currentPath, restoreFenceGeneration: 0,
    checkpoint: {cursor: 3, bytes: Uint8Array.of(3)}, suffix: [{cursor: 4, bytes: Uint8Array.of(4)}]}} as unknown as LiveUpdateJournalCutResult);
  await f.tracker.refreshChanged();
  expect(f.apply.mock.calls.map(([, input]) => input)).toEqual([
    expect.objectContaining({previousAcceptedCursor: 1, journalCursor: 3, expectedRevision: 1, updateBytes: Uint8Array.of(3)}),
    expect.objectContaining({previousAcceptedCursor: 3, journalCursor: 4, expectedRevision: 2, updateBytes: Uint8Array.of(4)}),
  ]);
});

it("refuses to advance a record whose path or restore fence changed", async () => {
  const f = fixture();
  f.cursors.set(binding.objectId, 2);
  f.bindings.set(binding.currentPath, {...binding, restoreFenceGeneration: 1});
  await f.tracker.refreshChanged();
  expect(f.apply).not.toHaveBeenCalled();
  expect(f.onError).toHaveBeenCalledWith(binding.currentPath, expect.any(Error));
});

it("loads each persisted draft page only once when a replica restarts", async () => {
  const f = fixture();
  const cursor = {mainVersionId: binding.mainVersionId, objectId: binding.objectId, lineageClaimId: binding.lineageClaimId};
  f.list.mockResolvedValueOnce({drafts: [{binding, acceptedCursor: 1}], next: cursor} as never);
  f.list.mockResolvedValueOnce({drafts: [], next: null});
  await f.tracker.initialize();
  await f.tracker.initialize();
  expect(f.list).toHaveBeenCalledTimes(2);
  expect(f.list.mock.calls[1]).toEqual([expect.anything(), {after: cursor, limit: 64}, expect.any(AbortSignal)]);
});
