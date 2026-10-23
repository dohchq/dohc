import {afterEach, expect, it, vi} from "vitest";
import type {AutomationClaimSummary} from "@dohc/workspace-engine-client";
import type {AutomationDeclaration} from "@dohc/live-session-contract/live-authorship";
import {OwnerYDocOutbox} from "@dohc/workspace-engine-client";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";
import {EngineRequestError} from "@dohc/workspace-engine-client/daemon";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {automationRecordDelivery, AutomationRecordBindingChanged} from "./automationRecordDelivery";
import {AutomationRunWait} from "@dohc/automation-executor/button-presser";
import {createAutomationAcceptedRecords} from "./automationAcceptedRecords";
import type {NamedFrameHostSession, NamedFrameSubmissionResult} from "./namedLiveFrameSession";

afterEach(() => vi.restoreAllMocks());
const binding: LiveObjectBinding = {workspaceId: "workspace", mainVersionId: "main", objectId: "record", lineageClaimId: "a".repeat(64),
  currentPath: "Tasks/one.md", selectorPaths: ["Tasks"], restoreFenceGeneration: 0};

function fixture(count = 1, automationDeclaration?: AutomationDeclaration, claim?: AutomationClaimSummary) {
  let head = 0, cursor = 0;
  const entries = Array.from({length: count}, (_, index) => ({sequence: index + 1, appendKey: `key-${index}`, deliveryId: `delivery-${index}`,
    updateDigest: "b".repeat(64), update: Uint8Array.of(1, index), byteLength: 2, createdAtMs: 1, ...(automationDeclaration ? {automationDeclaration} : {})}));
  const descriptor = {binding, relayDatabaseNamespace: "relay", revision: 1, acceptedCursor: 0, nativeHeadSequence: 0,
    nativeUnsettled: false, outboxId: "outbox", pendingBytes: count * 2, state: "active"};
  const client = {
    sendRequest: vi.fn(async () => ({id: 1, result: {claim: claim ?? null}})),
    ownerYDocPrepareEnrollment: vi.fn(async () => ({status: "observed", draft: descriptor})),
    ownerYDocListDrafts: vi.fn(async () => ({drafts: [], next: null})),
    ownerYDocReadState: vi.fn(async () => ({revision: cursor + 1, acceptedCursor: cursor, nativeHeadSequence: cursor, stateVector: Uint8Array.of(0)})),
    ownerYDocApplyInitialSync: vi.fn(), ownerYDocEnroll: vi.fn(),
    ownerYDocApplyAcceptedFrame: vi.fn(async (_request, input: {journalCursor: number}) => {
      cursor = input.journalCursor;
      return {revision: cursor + 1, acceptedCursor: cursor, nativeHeadSequence: cursor};
    }),
    ownerYDocIsReceiptApplied: vi.fn(async () => true), ownerYDocRefuseEntry: vi.fn(async () => {head++;}),
  };
  vi.spyOn(OwnerYDocOutbox.prototype, "readHead").mockImplementation(async () => ({outboxId: "outbox", binding, baseUpdateDigest: binding.lineageClaimId,
    baseUpdate: Uint8Array.of(0, 0), state: "active", pendingBytes: (count - head) * 2, oldestEntryAtMs: 1,
    quarantineReason: null, observedBinding: null, retryDeliveryId: null, entry: entries[head] ?? null}));
  const acknowledge = vi.spyOn(OwnerYDocOutbox.prototype, "acknowledge").mockImplementation(async () => {
    head++; return {acknowledged: 1, pendingBytes: (count - head) * 2, oldestEntryAtMs: head === count ? null : 1};
  });
  const quarantine = vi.spyOn(OwnerYDocOutbox.prototype, "quarantine").mockResolvedValue();
  const sync = {binding, hostVector: Uint8Array.of(0), missingStateUpdate: Uint8Array.of(0, 0), appliedThroughJournalCursor: 0,
    close: vi.fn(), nextApplied: vi.fn(async () => ({value: {journalCursor: cursor + 1, updateBytes: Uint8Array.of(1, 1)}, release: vi.fn()}))};
  const host: NamedFrameHostSession = {hostEpoch: parseHostEpoch(1), invalidated: new AbortController().signal,
    assertCurrent: vi.fn(), openSync: vi.fn(async () => sync), close: vi.fn(),
    submit: vi.fn(async (input): Promise<NamedFrameSubmissionResult> => ({result: "success", ack: {...input,
      journalCursor: cursor + 1, acceptingHostEpoch: parseHostEpoch(1), localYDocSequence: cursor + 1, applicationReplayed: false}})),
  };
  const capture = vi.fn(async () => host);
  let recordChain: Promise<unknown> = Promise.resolve();
  const replica = {client: client as unknown as EngineClient, workspace: "handle", workspaceId: binding.workspaceId, nextRequestId: () => 1,
    ownerUserId: "owner", signal: new AbortController().signal,
    withRecordWork<T>(work: () => Promise<T>): Promise<T> {
      const run = recordChain.then(work);
      recordChain = run.catch(() => undefined);
      return run;
    }};
  const delivery = automationRecordDelivery({replica, namespace: "relay", ownerUserId: "owner", capture});
  return {replica, client, capture, host, sync, acknowledge, quarantine, delivery};
}

it("captures once and installs each accepted frame before acknowledging a multi-field queue", async () => {
  const f = fixture(2);
  await f.delivery.drain(binding, new AbortController().signal);
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect(f.host.openSync).toHaveBeenCalledTimes(1);
  expect(f.client.ownerYDocApplyInitialSync).not.toHaveBeenCalled();
  expect(f.client.ownerYDocApplyAcceptedFrame).toHaveBeenCalledTimes(2);
  expect(f.acknowledge).toHaveBeenCalledTimes(2);
  expect(f.client.ownerYDocIsReceiptApplied.mock.invocationCallOrder[0]).toBeLessThan(f.acknowledge.mock.invocationCallOrder[0]!);
  expect(f.host.close).toHaveBeenCalledTimes(1);
  expect(f.sync.close).toHaveBeenCalledTimes(1);
});

it.each(["stale-session"] as const)("backs off %s without permanently freezing the record", async reason => {
  const f = fixture();
  vi.mocked(f.host.submit).mockResolvedValue({result: "refused", reason});
  await expect(f.delivery.drain(binding, new AbortController().signal)).rejects.toMatchObject({reason: "busy"});
  expect(f.quarantine).not.toHaveBeenCalled();
  expect(f.client.ownerYDocRefuseEntry).not.toHaveBeenCalled();
  expect(f.acknowledge).not.toHaveBeenCalled();
  vi.mocked(f.host.submit).mockResolvedValue({result: "success", ack: {deliveryId: "delivery-0", updateDigest: "b".repeat(64),
    journalCursor: 1, acceptingHostEpoch: parseHostEpoch(1), localYDocSequence: 1, applicationReplayed: false}});
  await f.delivery.drain(binding, new AbortController().signal);
  expect(f.acknowledge).toHaveBeenCalledTimes(1);
});

it("keeps native live capacity refusal pending and delivers on the next pass", async () => {
  const f = fixture();
  vi.mocked(f.host.submit).mockRejectedValueOnce(new EngineRequestError(1, {
    code: "OVERLOADED", message: "live-settlement-capacity", retry: "afterBackoff",
  }));
  await expect(f.delivery.drain(binding, new AbortController().signal)).rejects.toMatchObject({reason: "busy"});
  expect(f.quarantine).not.toHaveBeenCalled();
  expect(f.client.ownerYDocRefuseEntry).not.toHaveBeenCalled();
  expect(f.acknowledge).not.toHaveBeenCalled();
  await f.delivery.drain(binding, new AbortController().signal);
  expect(f.acknowledge).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.host.submit).mock.calls.map(([input]) => input.deliveryId)).toEqual(["delivery-0", "delivery-0"]);
});

it.each(["prepare", "sync", "adopt"] as const)("releases occupied live capacity during %s for a later pass", async stage => {
  const f = fixture();
  const refusal = new EngineRequestError(1, {code: "OVERLOADED", message: "live-settlement-capacity", retry: "afterBackoff"});
  if (stage === "prepare") f.client.ownerYDocPrepareEnrollment.mockRejectedValueOnce(refusal);
  if (stage === "sync") vi.mocked(f.host.openSync).mockRejectedValueOnce(refusal);
  if (stage === "adopt") {
    f.sync.appliedThroughJournalCursor = 1;
    f.client.ownerYDocApplyInitialSync.mockRejectedValueOnce(refusal);
  }
  await expect(f.delivery.synchronize(binding, f.replica.signal)).rejects.toMatchObject({reason: "busy"});
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect(f.host.close).toHaveBeenCalledTimes(1);
  await f.delivery.synchronize(binding, new AbortController().signal);
  expect(f.capture).toHaveBeenCalledTimes(2);
  expect(f.host.close).toHaveBeenCalledTimes(2);
  expect(f.quarantine).not.toHaveBeenCalled();
  expect(f.client.ownerYDocRefuseEntry).not.toHaveBeenCalled();
});

it("returns a refused refresh and lets a queued delivery proceed before retrying the same record", async () => {
  const f = fixture();
  const refusal = new EngineRequestError(1, {code: "OVERLOADED", message: "live-settlement-capacity", retry: "afterBackoff"});
  f.client.ownerYDocPrepareEnrollment.mockRejectedValueOnce(refusal);
  let captured!: () => void;
  const captureStarted = new Promise<void>(resolve => {captured = resolve;});
  f.capture.mockImplementation(async () => {captured(); return f.host;});
  const tracker = createAutomationAcceptedRecords({replica: f.replica, namespace: "relay",
    synchronize: f.delivery.synchronize, onError: vi.fn(),
    storage: {automationRecordBinding: () => ({binding, shareId: "share"}), automationRecordJournalCursor: () => 0,
      readLiveUpdateJournalCut: vi.fn()}});
  const refresh = tracker.refresh(binding.currentPath);
  // Attach the rejection handler before another operation enters the lane.
  const refused = refresh.catch(error => error);
  await captureStarted;
  const nextWork = vi.fn(async () => {
    expect(f.capture).toHaveBeenCalledTimes(1);
    await f.delivery.drain(binding, f.replica.signal);
  });
  await f.replica.withRecordWork(nextWork);
  expect(await refused).toBeInstanceOf(AutomationRunWait);
  expect(nextWork).toHaveBeenCalledOnce();
  expect(f.acknowledge).toHaveBeenCalledOnce();
  await tracker.refresh(binding.currentPath);
  expect(f.capture).toHaveBeenCalledTimes(3);
});

it("cancels preparation without another capture", async () => {
  const f = fixture();
  const lifetime = new AbortController();
  f.client.ownerYDocPrepareEnrollment.mockRejectedValue(new EngineRequestError(1, {
    code: "OVERLOADED", message: "live-settlement-capacity", retry: "afterBackoff",
  }));
  vi.mocked(f.host.close).mockImplementation(() => lifetime.abort());
  await expect(f.delivery.synchronize(binding, lifetime.signal)).rejects.toThrow();
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect(f.quarantine).not.toHaveBeenCalled();
  expect(f.client.ownerYDocRefuseEntry).not.toHaveBeenCalled();
});

it("keeps a draft pending during transient admission contention", async () => {
  const f = fixture();
  vi.mocked(f.host.submit).mockResolvedValue({result: "retry", reason: "admission-unavailable"});
  await expect(f.delivery.drain(binding, new AbortController().signal)).rejects.toThrow("waiting for acceptance");
  expect(f.client.ownerYDocRefuseEntry).not.toHaveBeenCalled();
  expect(f.acknowledge).not.toHaveBeenCalled();
});

it.each(["stale-binding", "restore-fenced", "binding-changed"] as const)("marks %s not accepted using desktop quarantine rules", async reason => {
  const f = fixture();
  f.capture.mockRejectedValue(new AutomationRecordBindingChanged(reason));
  await f.delivery.drain(binding, new AbortController().signal);
  expect(f.quarantine).toHaveBeenCalledWith({outboxId: "outbox", reason});
  expect(f.acknowledge).not.toHaveBeenCalled();
});

it("rejects a moved background draft even after native enrollment no longer resolves its old path", async () => {
  const f = fixture();
  f.client.ownerYDocPrepareEnrollment.mockRejectedValue(new Error("The old native path no longer exists"));
  f.capture.mockRejectedValue(new AutomationRecordBindingChanged("binding-changed"));
  await f.delivery.drain(binding, new AbortController().signal, "outbox");
  expect(f.client.ownerYDocPrepareEnrollment).not.toHaveBeenCalled();
  expect(f.quarantine).toHaveBeenCalledWith({outboxId: "outbox", reason: "binding-changed"});
});

it.each(["authority-refused", "invalid-update", "capacity-refused"] as const)("terminally refuses %s without quarantining other presses", async reason => {
  const f = fixture();
  vi.mocked(f.host.submit).mockResolvedValue({result: "refused", reason});
  await f.delivery.drain(binding, new AbortController().signal);
  expect(f.client.ownerYDocRefuseEntry).toHaveBeenCalledWith(expect.anything(), {outboxId: "outbox", deliveryId: "delivery-0",
    updateDigest: "b".repeat(64), reason: reason === "capacity-refused"
      ? "This update exceeds the shared file's limits. Reduce the change, then try again." : reason}, expect.anything());
  expect(f.quarantine).not.toHaveBeenCalled();
  expect(f.acknowledge).not.toHaveBeenCalled();
});

it("retires a received refusal on a later run instead of submitting its head again", async () => {
  const f = fixture();
  vi.mocked(f.host.submit).mockResolvedValueOnce({result: "refused", reason: "invalid-update"});
  f.client.ownerYDocRefuseEntry.mockRejectedValueOnce(new Error("engine unavailable")).mockRejectedValueOnce(new Error("engine unavailable"));
  const runs: string[] = [];
  for (let run = 0; run < 3; run++) {
    runs.push(await f.delivery.drain(binding, new AbortController().signal).then(() => "retired", (error: Error) => error.message));
  }
  expect(f.host.submit).toHaveBeenCalledTimes(1);
  expect(runs).toEqual(["engine unavailable", "engine unavailable", "retired"]);
  expect(f.client.ownerYDocRefuseEntry).toHaveBeenCalledTimes(3);
  expect(f.client.ownerYDocRefuseEntry).toHaveBeenLastCalledWith(expect.anything(), {outboxId: "outbox", deliveryId: "delivery-0",
    updateDigest: "b".repeat(64), reason: "invalid-update"}, expect.anything());
  expect(f.acknowledge).not.toHaveBeenCalled();
  expect(f.quarantine).not.toHaveBeenCalled();
});

it("retires a recipient chain whose authority changed on a later run even once its presser resolves", async () => {
  const declaration: AutomationDeclaration = {automationId: "collection:Tasks#chained", attribution: {actorKind: "automation", onBehalfOf: "reader", depth: 2,
    run: {claimId: "chained", automationName: "Chain"}}};
  const f = fixture(1, declaration);
  f.client.ownerYDocRefuseEntry.mockRejectedValueOnce(new Error("engine unavailable")).mockRejectedValueOnce(new Error("engine unavailable"));
  await expect(f.delivery.drain(binding, new AbortController().signal)).rejects.toThrow("engine unavailable");
  await expect(f.delivery.drain(binding, new AbortController().signal)).rejects.toThrow("engine unavailable");
  const claim: AutomationClaimSummary = {claimId: "chained", automationId: declaration.automationId, trigger: {historyId: 1}, recordId: "record", collectionPath: "Tasks",
    depth: 2, state: "done", attempts: 1, run: 1, createdAtMs: 1, updatedAtMs: 1, change: {kind: "message", actorKind: "automation", onBehalfOf: "reader", authorOriginId: null,
      sharedAuthor: {kind: "named", userId: "reader", grantId: "original", grantGeneration: 4}, liveCursor: null}};
  f.client.sendRequest.mockResolvedValue({id: 1, result: {claim}});
  await f.delivery.drain(binding, new AbortController().signal);
  expect(f.host.submit).not.toHaveBeenCalled();
  expect(f.client.ownerYDocRefuseEntry).toHaveBeenCalledTimes(3);
  expect(f.client.ownerYDocRefuseEntry).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({deliveryId: "delivery-0",
    reason: "authority-refused"}), expect.anything());
});

it("delivers an independent sibling in the same pass after a terminal refusal", async () => {
  const f = fixture(2);
  vi.mocked(f.host.submit).mockResolvedValueOnce({result: "refused", reason: "capacity-refused"});
  await f.delivery.drain(binding, new AbortController().signal);
  expect(f.client.ownerYDocRefuseEntry).toHaveBeenCalledTimes(1);
  expect(f.acknowledge).toHaveBeenCalledTimes(1);
  expect(f.host.submit).toHaveBeenCalledTimes(2);
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect(f.quarantine).not.toHaveBeenCalled();
});

it("keeps an offline owner's queued draft pending and delivers when the device returns", async () => {
  const f = fixture();
  f.capture.mockRejectedValueOnce(new Error("Device delivery is unavailable."));
  await expect(f.delivery.drain(binding, new AbortController().signal)).rejects.toThrow("Device delivery");
  expect(f.quarantine).not.toHaveBeenCalled();
  expect(f.acknowledge).not.toHaveBeenCalled();
  await f.delivery.drain(binding, new AbortController().signal);
  expect(f.acknowledge).toHaveBeenCalledTimes(1);
});

it.each(["message", "changed"] as const)("carries the original named grant for a %s recipient write to admission", async kind => {
  const declaration: AutomationDeclaration = {automationId: "collection:Tasks#chained", attribution: {actorKind: "automation", onBehalfOf: "reader", depth: 2,
    run: {claimId: "chained", automationName: "Chain"}}};
  const claim: AutomationClaimSummary = {claimId: "chained", automationId: declaration.automationId, trigger: {historyId: 1}, recordId: "record", collectionPath: "Tasks",
    depth: 2, state: "done", attempts: 1, run: 1, createdAtMs: 1, updatedAtMs: 1, change: {kind, actorKind: "automation", onBehalfOf: "reader", authorOriginId: null,
      sharedAuthor: {kind: "named", userId: "reader", grantId: "original", grantGeneration: 4}, liveCursor: null}};
  const f = fixture(1, declaration, claim);
  await f.delivery.drain(binding, new AbortController().signal);
  expect(f.host.submit).toHaveBeenCalledWith(expect.objectContaining({trustedAutomationGrant: {grantId: "original", grantGeneration: 4}}), expect.anything());
  expect(f.acknowledge).toHaveBeenCalledOnce();
});
it("retires an unbound recipient chain instead of submitting it with owner authority", async () => {
  const declaration: AutomationDeclaration = {automationId: "collection:Tasks#chained", attribution: {actorKind: "automation", onBehalfOf: "reader", depth: 2,
    run: {claimId: "chained", automationName: "Chain"}}};
  const f = fixture(1, declaration);
  await f.delivery.drain(binding, new AbortController().signal);
  expect(f.host.submit).not.toHaveBeenCalled();
  expect(f.client.ownerYDocRefuseEntry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({reason: "authority-refused"}), expect.anything());
});
