import type {ChildProcess} from "node:child_process";
import {getEventListeners} from "node:events";
import {afterEach, expect, it, vi} from "vitest";
import {createLiveMarkdownJournalValidator} from "@dohc/ydoc-projection/live-journal-validation";
import {cleanupLiveDeliveryFixtures, hash, policy, registered} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {captureNamedLiveFrameHost, createNamedFrameChanges} from "./namedLiveFrameHost";
import {createLiveTickets} from "./liveTickets";
import {liveBrowserActor} from "./liveBrowserContext";
import {createLiveValidationExecutor} from "./liveValidation";
import type {StorageContext} from "./storage/context";
import type {CapacityLiveAdmissionValidator} from "./ownerOutboxDelivery";

// Lets a test intercept the validation pool's children as they start.
const forks = vi.hoisted(() => ({started: undefined as ((child: ChildProcess) => void) | undefined}));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const fork = (...args: Parameters<typeof actual.fork>) => {
    const child = actual.fork(...args); forks.started?.(child); return child;
  };
  return {...actual, fork};
});
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  cleanupLiveDeliveryFixtures(); vi.restoreAllMocks(); vi.useRealTimers();
});
function deferred() {
  let resolve!: () => void;
  return {promise: new Promise<void>(done => {resolve = done;}), resolve: () => resolve()};
}
const validateProjection = createLiveMarkdownJournalValidator(policy);
const validateJournal: CapacityLiveAdmissionValidator = ({retainStateUpdate: _retainStateUpdate, ...input}) => validateProjection(input);
async function fixture(validate = validateJournal, deadlineMs = 5_000) {
  const relay = registered({deployment: true, liveTickets: {retainedTicketsPerPrincipalGrant: 2, expiredTicketCleanupBatchSize: 1, now: () => 1_000}});
  cleanup.push(() => relay.close());
  const update = relay.update("editor", "Pending editor edit"), captured = relay.capture(update, "named-delivery");
  const {binding} = captured.metadata, document = captured.cutToken.document, coordinate = captured.host;
  const scope = {kind: "named" as const, workspaceId: document.workspaceId, shareId: "share", grantId: "grant", userId: "reader"};
  const tickets = createLiveTickets({storage: relay.storage, audience: "https://share.example.test", key: new Uint8Array(32).fill(13),
    hostReports: {currentBinding: async () => ({connection: coordinate, binding})}});
  const minted = await tickets.mint({objectId: document.objectId}, scope);
  const ticket = await tickets.redeem(minted!.token, scope);
  const commit = vi.spyOn(relay.storage, "commitLiveUpdateJournal"), read = vi.spyOn(relay.storage, "readLiveUpdateJournalCut");
  const capture = captureNamedLiveFrameHost({ticket: ticket!, actor: liveBrowserActor(scope), storage: relay.storage, validate,
    native: {client: {async readLiveApplicationAck() {
      const result = commit.mock.results.at(-1)?.value?.result;
      if (result?.kind !== "accepted") throw new Error("Missing admission");
      return {...result.receipt, localYDocSequence: result.receipt.journalCursor, applicationReplayed: result.replayed};
    }} as never, workspace: "handle", registrationId: 1, coordinate, binding, invalidated: new AbortController().signal,
      changes: createNamedFrameChanges(1), deadlineMs, nextRequestId: () => 1, drain: async () => {}},
    bounds: {maxClientVectorBytes: 1_000, maxSyncOutputBytes: 10_000, maxAppliedUpdateBytes: 10_000, maxSubmissionBytes: 10_000, maxAdmissionBytes: 100_000}});
  cleanup.push(() => capture.close());
  const input = {deliveryId: "named-delivery", updateDigest: hash(update), updateBytes: update};
  return {relay, capture, input, commit, read, document, binding};
}
function waitingValidator() {
  const entered = deferred(), release = deferred();
  let signal: AbortSignal | undefined;
  const waitForCapacity = vi.fn(async (caller?: AbortSignal) => {
    signal = caller; entered.resolve();
    caller?.throwIfAborted();
    const abort = deferred();
    const onAbort = () => abort.resolve();
    caller?.addEventListener("abort", onAbort, {once: true});
    try {await Promise.race([release.promise, abort.promise]); caller?.throwIfAborted();}
    finally {caller?.removeEventListener("abort", onAbort);}
  });
  const validate = Object.assign(vi.fn(validateJournal), {waitForCapacity});
  return {entered, release, validate, signal: () => signal};
}
it("waits for either of two busy workers before reading a cut and acknowledges the third editor", async () => {
  const pool = createLiveValidationExecutor(); cleanup.push(() => pool.close());
  const held: Array<() => void> = [];
  let posts = 0;
  forks.started = child => {
    const send = child.send;
    child.send = ((...args: unknown[]) => {
      if (posts++ < 2) {held.push(() => Reflect.apply(send, child, args)); return true;}
      return Reflect.apply(send, child, args);
    }) as typeof child.send;
  };
  cleanup.push(() => {forks.started = undefined;});
  const validate = pool.validator(policy), entered = deferred();
  const wait = validate.waitForCapacity!;
  validate.waitForCapacity = signal => {entered.resolve(); return wait(signal);};
  const f = await fixture(validate);
  const cut = f.relay.storage.readLiveUpdateJournalCut({document: f.document});
  if (cut.kind !== "cut") throw new Error("Missing cut");
  const work = {document: f.document, currentPath: f.binding.currentPath, checkpoint: cut.cut.checkpoint.bytes, suffix: [], candidate: Uint8Array.of(0, 0)};
  const jobs = [Promise.resolve(validate(work)), Promise.resolve(validate(work))];
  f.read.mockClear();
  const submitted = f.capture.submit(f.input, new AbortController().signal);
  cleanup.push(async () => {held.splice(0).forEach(release => release()); await Promise.allSettled([submitted, ...jobs]);});
  await entered.promise;
  expect(held).toHaveLength(2); expect(f.read).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  held.shift()!();
  expect(await submitted).toMatchObject({result: "success"});
  expect(f.relay.journalRows().journal).toMatchObject([{delivery_id: f.input.deliveryId}]);
  expect(f.capture.invalidated.aborted).toBe(false); f.capture.assertCurrent();
  held.shift()!(); await Promise.all(jobs);
  expect((await f.capture.submit(f.input, new AbortController().signal)).result).toBe("success");
  expect(f.relay.journalRows().journal).toHaveLength(1);
});
it("recaptures and revalidates an advanced cut while admitting the same delivery exactly once", async () => {
  const entered = deferred(), release = deferred();
  const validate = vi.fn<CapacityLiveAdmissionValidator>(async input => {
    if (validate.mock.calls.length === 1) {entered.resolve(); await release.promise;}
    return validateJournal(input);
  });
  const f = await fixture(validate), submitted = f.capture.submit(f.input, new AbortController().signal);
  await entered.promise;
  const other = f.relay.storage.commitLiveUpdateJournal(f.relay.capture(Uint8Array.of(0, 0), "other-delivery"));
  expect(other.result.kind).toBe("accepted");
  release.resolve();
  expect(await submitted).toMatchObject({result: "success"});
  expect(validate.mock.calls.map(([input]) => input.suffix.length)).toEqual([0, 1]);
  expect(f.commit.mock.results.map(row => row.value.result.kind)).toEqual(["accepted", "retry", "accepted"]);
  expect(f.relay.journalRows().journal).toMatchObject([{delivery_id: "other-delivery"}, {delivery_id: f.input.deliveryId}]);
  await f.capture.submit(f.input, new AbortController().signal);
  expect(f.relay.journalRows().journal).toHaveLength(2);
});
it.each(["grant", "closed", "cancelled"] as const)("does not admit after %s during capacity wait and releases admission ownership", async kind => {
  const gate = waitingValidator(), f = await fixture(gate.validate), caller = new AbortController();
  const submitted = f.capture.submit(f.input, caller.signal), outcome = Promise.allSettled([submitted]);
  cleanup.push(() => gate.release.resolve());
  await gate.entered.promise;
  if (kind === "grant") (f.relay.storage as StorageContext).db.prepare("UPDATE sync_relay_share_grants SET generation=generation+1 WHERE grant_id='grant'").run();
  if (kind === "closed") f.capture.close();
  if (kind === "cancelled") caller.abort(new Error("cancelled"));
  if (kind === "grant") gate.release.resolve();
  else expect(gate.signal()!.aborted).toBe(true);
  expect((await outcome)[0].status).toBe("rejected");
  expect(f.read).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  expect(getEventListeners(gate.signal()!, "abort")).toHaveLength(0);
  gate.release.resolve();
  if (kind === "cancelled") expect((await f.capture.submit(f.input, new AbortController().signal)).result).toBe("success");
});
it("bounds the whole wait, removes its waiter, and leaves the capture usable for resubmission", async () => {
  const gate = waitingValidator(), f = await fixture(gate.validate, 100);
  vi.useFakeTimers();
  const submitted = f.capture.submit(f.input, new AbortController().signal);
  await gate.entered.promise;
  await vi.advanceTimersByTimeAsync(100);
  expect(await submitted).toEqual({result: "retry", reason: "admission-unavailable"});
  expect(gate.signal()!.aborted).toBe(true);
  expect(getEventListeners(gate.signal()!, "abort")).toHaveLength(0);
  expect(f.commit).not.toHaveBeenCalled(); expect(f.capture.invalidated.aborted).toBe(false);
  gate.release.resolve();
  expect((await f.capture.submit(f.input, new AbortController().signal)).result).toBe("success");
  expect(vi.getTimerCount()).toBe(0);
});

it("does not restart the total deadline when a capacity race requires another wait", async () => {
  const first = waitingValidator(), second = waitingValidator();
  first.validate.mockImplementationOnce(() => ({kind: "retry", reason: "admission-unavailable", waitForCapacity: second.validate.waitForCapacity}));
  const f = await fixture(first.validate, 100);
  vi.useFakeTimers();
  const submitted = f.capture.submit(f.input, new AbortController().signal);
  await first.entered.promise;
  await vi.advanceTimersByTimeAsync(60); first.release.resolve();
  await second.entered.promise;
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.commit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(40);
  expect(await submitted).toEqual({result: "retry", reason: "admission-unavailable"});
  expect(second.signal()!.aborted).toBe(true);
  expect(getEventListeners(second.signal()!, "abort")).toHaveLength(0);
});
it("bounds repeated journal contention and checks authority before trying again", async () => {
  const f = await fixture(validateJournal, 100);
  vi.useFakeTimers();
  const retried = deferred();
  f.commit.mockImplementation(() => {
    if (f.commit.mock.calls.length === 2) retried.resolve();
    return {result: {kind: "retry", reason: "admission-unavailable"}, admitted: null};
  });
  const submitted = f.capture.submit(f.input, new AbortController().signal);
  await retried.promise;
  await vi.advanceTimersByTimeAsync(100);
  expect(await submitted).toEqual({result: "retry", reason: "admission-unavailable"});
  expect(f.commit.mock.calls.length).toBeGreaterThan(1);
  expect(f.relay.journalRows().journal).toHaveLength(0);
  expect(f.capture.invalidated.aborted).toBe(false);
});

it("rechecks revocation after journal retry backoff before waiting for capacity again", async () => {
  const attempted = deferred(), preflight = vi.fn(async () => {});
  const f = await fixture(Object.assign(vi.fn(validateJournal), {waitForCapacity: preflight}));
  f.commit.mockImplementationOnce(() => {
    attempted.resolve();
    return {result: {kind: "retry", reason: "admission-unavailable"}, admitted: null};
  });
  const submitted = f.capture.submit(f.input, new AbortController().signal), rejected = expect(submitted).rejects.toThrow("standing changed");
  await attempted.promise;
  (f.relay.storage as StorageContext).db.prepare("UPDATE sync_relay_share_grants SET generation=generation+1 WHERE grant_id='grant'").run();
  await rejected;
  expect(preflight).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(1); expect(f.commit).toHaveBeenCalledTimes(1);
  expect(f.relay.journalRows().journal).toHaveLength(0);
});

it("lets revoked authority win over an admission timeout", async () => {
  const gate = waitingValidator(), f = await fixture(gate.validate, 100);
  vi.useFakeTimers();
  const submitted = f.capture.submit(f.input, new AbortController().signal), outcome = Promise.allSettled([submitted]);
  await gate.entered.promise;
  (f.relay.storage as StorageContext).db.prepare("UPDATE sync_relay_share_grants SET generation=generation+1 WHERE grant_id='grant'").run();
  await vi.advanceTimersByTimeAsync(100);
  expect((await outcome)[0]).toMatchObject({status: "rejected"});
  expect(f.capture.invalidated.aborted).toBe(true);
  expect(f.read).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
});

it("keeps a long native deadline from overflowing the admission timer", async () => {
  const gate = waitingValidator(), f = await fixture(gate.validate, 0xffff_ffff);
  vi.useFakeTimers();
  const submitted = f.capture.submit(f.input, new AbortController().signal);
  await gate.entered.promise;
  await vi.advanceTimersByTimeAsync(1);
  expect(gate.signal()!.aborted).toBe(false);
  gate.release.resolve();
  expect(await submitted).toMatchObject({result: "success"});
  expect(vi.getTimerCount()).toBe(0);
});
