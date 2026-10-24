import {LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES} from "@dohc/live-session-contract/live-frame";
import {createHash} from "node:crypto";
import {setTimeout as backoff} from "node:timers/promises";
import {afterEach, expect, it, vi} from "vitest";
import {EngineRequestError} from "@dohc/workspace-engine-client/daemon";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {createNamedLiveFrameSession, type NamedFrameAppliedUpdate, type NamedFrameSubmissionResult} from "../../../../services/sync-relay/src/namedLiveFrameSession";
import {OwnerYDocFrameDelivery, type OwnerAcceptedState, type OwnerYDocFrameDeliveryOptions} from "./ownerYDocFrameDelivery";
import type {OwnerYDocDeliveryEnvelope} from "./ownerYDocOutbox";

vi.mock("node:timers/promises", async importOriginal => {
  const timers = await importOriginal<typeof import("node:timers/promises")>();
  return {...timers, setTimeout: vi.fn(timers.setTimeout)};
});

const binding = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
  currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1};
const frames = {receive: {maxFrameBytes: 4096, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
  maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const envelope: OwnerYDocDeliveryEnvelope = {outboxId: "outbox", binding, baseUpdate: new Uint8Array([0,0]), baseUpdateDigest: hash(new Uint8Array([0,0])),
  personEdit: true, sequence: 4, appendKey: "append", deliveryId: "stable-delivery", update: new Uint8Array([1,2,3]), updateDigest: hash(new Uint8Array([1,2,3]))};
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
const disposals: (() => void)[] = [];
afterEach(() => {for (const close of disposals.splice(0)) close(); vi.mocked(backoff).mockReset(); vi.useRealTimers();});

function fixture(overrides: {binding?: typeof binding; initialCursor?: number; initialResult?: "applied" | "retry"; retained?: boolean;
  accountId?: string | null; result?: NamedFrameSubmissionResult; state?: Partial<OwnerAcceptedState>; connect?: OwnerYDocFrameDeliveryOptions["connect"]} = {}) {
  const controller = new AbortController(), submitted = deferred<void>(), receiptChecked = deferred<void>(), feedApplied = deferred<void>();
  const queue: NamedFrameAppliedUpdate[] = [], waiters: (() => void)[] = [], retained = new Map<number,string>();
  const receipt = {deliveryId: envelope.deliveryId, updateDigest: envelope.updateDigest, journalCursor: 9, acceptingHostEpoch: parseHostEpoch(2)};
  if (overrides.retained) retained.set(receipt.journalCursor, receipt.updateDigest);
  const acceptedState: OwnerAcceptedState = {
    readState: vi.fn(async () => ({stateVector: new Uint8Array([0]), journalCursor: 0})),
    applyInitialSync: vi.fn(async () => overrides.initialResult ?? "applied"),
    applyAcceptedFrame: vi.fn(async input => {retained.set(input.journalCursor, hash(input.updateBytes)); feedApplied.resolve(); return "applied" as const;}),
    isReceiptApplied: vi.fn(async input => {receiptChecked.resolve(); return retained.get(input.receipt.journalCursor) === input.receipt.updateDigest;}),
    ...overrides.state,
  };
  const submit = vi.fn(async input => {submitted.resolve(); return overrides.result ?? {result: "success" as const, ack: {...receipt, localYDocSequence: 4, applicationReplayed: false}};});
  let server: ReturnType<typeof createNamedLiveFrameSession> | undefined;
  const connect = vi.fn<NonNullable<OwnerYDocFrameDeliveryOptions["connect"]>>(overrides.connect ?? (async input => {
    server = createNamedLiveFrameSession({frames, host: {hostEpoch: parseHostEpoch(3), invalidated: input.signal, assertCurrent: () => input.signal.throwIfAborted(), close() {}, submit,
      openSync: async () => ({binding: overrides.binding ?? binding, hostVector: new Uint8Array([0]), missingStateUpdate: new Uint8Array([0,0]), appliedThroughJournalCursor: overrides.initialCursor ?? 0, close() {},
        nextApplied: async signal => {
          if (!queue.length) await new Promise<void>((resolve, reject) => {
            const abort = () => {signal.removeEventListener("abort", abort); reject(new Error("closed"));};
            signal.addEventListener("abort", abort, {once: true});
            waiters.push(() => {signal.removeEventListener("abort", abort); resolve();});
          });
          signal.throwIfAborted(); return {value: queue.shift()!, release() {}};
        }}),
    }, transport: {send: async bytes => input.receive(bytes), close: input.closed}});
    return {send: async bytes => server!.receive(bytes), close: () => server!.close()};
  }));
  const delivery = new OwnerYDocFrameDelivery({relayUrl: "https://relay.example.test", shareId: "share", frames, attemptTimeoutMs: 10_000,
    signal: controller.signal, freshBearer: async () => "actual-owner-bearer", authenticatedAccountId: async () => overrides.accountId === null ? undefined : overrides.accountId ?? "owner", acceptedState, connect});
  disposals.push(() => {delivery.dispose(); controller.abort(); server?.close();});
  return {delivery, acceptedState, connect, submit, submitted, receiptChecked, feedApplied, receipt, controller,
    feed: (update: NamedFrameAppliedUpdate = {journalCursor: 9, updateBytes: envelope.update}) => {queue.push(update); waiters.shift()?.();}};
}

it("uses owner bearer route and exact stored delivery bytes; waits for durable ordered application after ACK", async () => {
  const f = fixture(), fresh = await f.delivery.freshOwnerAuthority(binding);
  expect(fresh.kind).toBe("authority"); if (fresh.kind !== "authority") return;
  const call = f.connect.mock.calls[0]![0];
  expect(call.url.toString()).toBe(`wss://relay.example.test/sync/workspaces/workspace/live/owner?objectId=object&lineageClaimId=${binding.lineageClaimId}&shareId=share`);
  expect(call.bearer).toBe("actual-owner-bearer"); expect(call.url.toString()).not.toContain("bearer");
  let settled = false;
  const work = f.delivery.deliver(fresh.authority, envelope).then(result => {settled = true; return result;});
  await f.receiptChecked.promise;
  expect(settled).toBe(false);
  expect(f.submit).toHaveBeenCalledWith({deliveryId: envelope.deliveryId, updateDigest: envelope.updateDigest, updateBytes: envelope.update,
    authorContext: {kind: "account", accountId: "owner"}}, expect.any(AbortSignal));
  f.feed();
  expect(await work).toEqual({kind: "receipt", receipt: f.receipt});
  expect(f.acceptedState.applyAcceptedFrame).toHaveBeenCalledWith({binding, previousAcceptedCursor: 0, journalCursor: 9, updateBytes: envelope.update}, expect.any(AbortSignal));
});

it("submits the agent a queued edit declared, owned before transport, beside its stored bytes", async () => {
  const f = fixture({retained: true}), fresh = await f.delivery.freshOwnerAuthority(binding);
  if (fresh.kind !== "authority") throw new Error("Missing authority");
  const agentDeclaration = {agentId: "trip-agent-ü", onBehalfOf: "local-person", depth: 2};
  const work = f.delivery.deliver(fresh.authority, {...envelope, agentDeclaration});
  (agentDeclaration as {agentId: string}).agentId = "changed";
  expect(await work).toEqual({kind: "receipt", receipt: f.receipt});
  expect(f.submit).toHaveBeenCalledWith({deliveryId: envelope.deliveryId, updateDigest: envelope.updateDigest, updateBytes: envelope.update,
    authorContext: {kind: "account", accountId: "owner", agent: {agentId: "trip-agent-ü", onBehalfOf: "local-person", depth: 2}}}, expect.any(AbortSignal));
});

it.each([{}, {agentDeclaration: {agentId: "trip-agent", onBehalfOf: null, depth: 0}}])("retries a credited entry while the recording account is unavailable (%j)", async declaration => {
  const f = fixture({retained: true, accountId: null}), fresh = await f.delivery.freshOwnerAuthority(binding);
  if (fresh.kind !== "authority") throw new Error("Missing authority");
  const work = f.delivery.deliver(fresh.authority, {...envelope, ...declaration});
  expect(await work).toEqual({kind: "retry"});
  expect(f.submit).not.toHaveBeenCalled();
});

it("freezes a conflicting delivery for explicit recovery instead of retrying forever", async () => {
  const f = fixture({result: {result: "refused", reason: "delivery-conflict"}}), fresh = await f.delivery.freshOwnerAuthority(binding);
  if (fresh.kind !== "authority") throw new Error("Missing authority");
  expect(await f.delivery.deliver(fresh.authority, envelope)).toEqual({kind: "quarantine", reason: "delivery-conflict"});
});

it.each(["provenance-refused", "capacity-refused"] as const)("freezes a %s refusal for visible recovery", async reason => {
  const f = fixture({result: {result: "refused", reason}}), fresh = await f.delivery.freshOwnerAuthority(binding);
  if (fresh.kind !== "authority") throw new Error("Missing authority");
  expect(await f.delivery.deliver(fresh.authority, envelope)).toEqual({kind: "quarantine", reason});
});

it("requires an owner frame policy that carries the largest declared submission", () => {
  const options = {relayUrl: "https://relay.example.test", shareId: "share", attemptTimeoutMs: 10_000, signal: new AbortController().signal,
    freshBearer: async () => "bearer", acceptedState: {} as OwnerAcceptedState};
  expect(() => new OwnerYDocFrameDelivery({...options, frames: {...frames, receive: {...frames.receive, maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES - 1}}})).toThrow("owner frame policy");
  expect(() => new OwnerYDocFrameDelivery({...options, frames: {...frames, maxControlBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES - 1}})).toThrow("owner frame policy");
  new OwnerYDocFrameDelivery({...options, frames: {...frames, receive: {...frames.receive, maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES}, maxControlBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES}}).dispose();
});

it("refuses a malformed agent declaration before sending any submission", async () => {
  const f = fixture(), fresh = await f.delivery.freshOwnerAuthority(binding);
  if (fresh.kind !== "authority") throw new Error("Missing authority");
  expect(await f.delivery.deliver(fresh.authority, {...envelope, agentDeclaration: {agentId: "", onBehalfOf: null, depth: 0}})).toEqual({kind: "retry"});
  expect(f.submit).not.toHaveBeenCalled();
});

it.each(["currentPath", "selectorPaths", "restoreFenceGeneration", "lineageClaimId"] as const)("compares %s before any pending submission", async field => {
  const changed = {...binding, [field]: field === "selectorPaths" ? ["b.md"] : field === "restoreFenceGeneration" ? 2 : field === "lineageClaimId" ? "b".repeat(64) : "b.md"};
  const f = fixture({binding: changed});
  expect(await f.delivery.freshOwnerAuthority(binding)).toEqual({kind: "quarantine", reason: "binding-changed", observedBinding: changed});
  expect(f.submit).not.toHaveBeenCalled(); expect(f.acceptedState.applyInitialSync).not.toHaveBeenCalled();
});

it("keeps upgrade404 as retry without inferring a changed binding", async () => {
  const f = fixture({connect: async () => {throw new Error("Unexpected server response: 404");}});
  expect(await f.delivery.freshOwnerAuthority(binding)).toEqual({kind: "retry"});
  expect(f.submit).not.toHaveBeenCalled();
});

it("does not advance an unsupported initial native checkpoint or send pending bytes", async () => {
  const f = fixture({initialCursor: 12, initialResult: "retry"});
  expect(await f.delivery.freshOwnerAuthority(binding)).toEqual({kind: "retry"}); expect(f.submit).not.toHaveBeenCalled();
});

it("a later checkpoint alone cannot release a pending delta after lost ACK", async () => {
  const f = fixture({initialCursor: 12}), fresh = await f.delivery.freshOwnerAuthority(binding);
  if (fresh.kind !== "authority") throw new Error("Missing authority");
  let settled = false; const work = f.delivery.deliver(fresh.authority, envelope).then(result => {settled = true; return result;});
  await f.receiptChecked.promise; expect(settled).toBe(false);
  f.delivery.dispose(); expect(await work).toEqual({kind: "retry"});
});

it("retained exact native application proof permits an older replayed receipt", async () => {
  const f = fixture({initialCursor: 12, retained: true}), fresh = await f.delivery.freshOwnerAuthority(binding);
  if (fresh.kind !== "authority") throw new Error("Missing authority");
  expect(await f.delivery.deliver(fresh.authority, envelope)).toMatchObject({kind: "receipt", receipt: f.receipt});
  expect(f.acceptedState.applyAcceptedFrame).not.toHaveBeenCalled();
});

it("disposal aborts a stalled native read and prevents bearer or transport work", async () => {
  const read = deferred<{stateVector: Uint8Array; journalCursor: number}>(), f = fixture({state: {readState: () => read.promise}});
  const work = f.delivery.freshOwnerAuthority(binding); f.delivery.dispose();
  expect(await work).toEqual({kind: "retry"}); expect(f.connect).not.toHaveBeenCalled();
  read.resolve({stateVector: new Uint8Array([0]), journalCursor: 0});
});

it("rejects mutated envelope binding, digest and a replaced authority", async () => {
  const f = fixture(), first = await f.delivery.freshOwnerAuthority(binding), second = await f.delivery.freshOwnerAuthority(binding);
  if (first.kind !== "authority" || second.kind !== "authority") throw new Error("Missing authority");
  expect(await f.delivery.deliver(first.authority, envelope)).toEqual({kind: "retry"});
  expect(await f.delivery.deliver(second.authority, {...envelope, binding: {...binding, restoreFenceGeneration: 2}})).toEqual({kind: "retry"});
  expect(await f.delivery.deliver(second.authority, {...envelope, updateDigest: "f".repeat(64)})).toEqual({kind: "retry"});
  expect(f.submit).not.toHaveBeenCalled();
});

it("retains pending when native ordered application refuses", async () => {
  const f = fixture({state: {applyAcceptedFrame: async () => "retry"}}), fresh = await f.delivery.freshOwnerAuthority(binding);
  if (fresh.kind !== "authority") throw new Error("Missing authority");
  const work = f.delivery.deliver(fresh.authority, envelope); await f.receiptChecked.promise; f.feed();
  expect(await work).toEqual({kind: "retry"});
});

const capacityRefusal = () => new EngineRequestError(1, {code: "OVERLOADED", message: "live-settlement-capacity", retry: "afterBackoff"});

it("backs off repeated receipt proof refusals without reconnecting or resubmitting", async () => {
  const proof = vi.fn().mockResolvedValue(true);
  for (let refusal = 0; refusal < 6; refusal++) {
    proof.mockRejectedValueOnce(capacityRefusal());
    vi.mocked(backoff).mockResolvedValueOnce(undefined);
  }
  const f = fixture({state: {isReceiptApplied: proof}}), fresh = await f.delivery.freshOwnerAuthority(binding);
  if (fresh.kind !== "authority") throw new Error("Missing authority");
  expect(await f.delivery.deliver(fresh.authority, envelope)).toEqual({kind: "receipt", receipt: f.receipt});
  expect(proof).toHaveBeenCalledTimes(7);
  expect(vi.mocked(backoff).mock.calls.map(([ms]) => ms)).toEqual([25, 50, 100, 200, 250, 250]);
  for (const [input] of proof.mock.calls) expect(input).toEqual({binding, receipt: f.receipt});
  expect(f.connect).toHaveBeenCalledTimes(1); expect(f.submit).toHaveBeenCalledTimes(1);
});

it("keeps a refused then false receipt pending until the accepted frame proves it", async () => {
  vi.useFakeTimers();
  let applied = false;
  const checked = deferred<void>();
  const proof = vi.fn().mockRejectedValueOnce(capacityRefusal()).mockImplementation(async () => {checked.resolve(); return applied;});
  const f = fixture({state: {isReceiptApplied: proof, applyAcceptedFrame: async () => {applied = true; return "applied";}}});
  const fresh = await f.delivery.freshOwnerAuthority(binding);
  if (fresh.kind !== "authority") throw new Error("Missing authority");
  let settled = false;
  const work = f.delivery.deliver(fresh.authority, envelope).then(result => {settled = true; return result;});
  await Promise.race([checked.promise, work]);
  expect(proof).toHaveBeenCalledTimes(2); expect(settled).toBe(false);
  f.feed();
  expect(await work).toEqual({kind: "receipt", receipt: f.receipt});
  expect(proof).toHaveBeenCalledTimes(3);
});

it.each(["deadline", "cancellation", "replacement"])("bounds repeated proof overloads by %s", async ending => {
  vi.useFakeTimers();
  const waiting = deferred<void>();
  vi.mocked(backoff).mockResolvedValueOnce(undefined).mockImplementationOnce((_ms, _value, options) => new Promise<never>((_resolve, reject) => {
    const signal = options!.signal!;
    signal.addEventListener("abort", () => reject(signal.reason), {once: true});
    waiting.resolve();
  }));
  const proof = vi.fn().mockRejectedValue(capacityRefusal());
  const f = fixture({state: {isReceiptApplied: proof}}), fresh = await f.delivery.freshOwnerAuthority(binding);
  if (fresh.kind !== "authority") throw new Error("Missing authority");
  let settled = false;
  const work = f.delivery.deliver(fresh.authority, envelope).then(result => {settled = true; return result;});
  await Promise.race([waiting.promise, work]);
  expect(proof).toHaveBeenCalledTimes(2); expect(settled).toBe(false);
  const waits = vi.mocked(backoff).mock.calls.length;
  const pendingWait = vi.mocked(backoff).mock.results.at(-1)!.value;
  const rejectedWait = expect(pendingWait).rejects.toMatchObject({name: "AbortError"});
  if (ending === "deadline") await vi.advanceTimersByTimeAsync(10_000);
  else if (ending === "cancellation") f.controller.abort();
  else await f.delivery.freshOwnerAuthority(binding);
  await rejectedWait;
  expect(await work).toEqual({kind: "retry"});
  const calls = proof.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(vi.mocked(backoff)).toHaveBeenCalledTimes(waits);
  expect(proof).toHaveBeenCalledTimes(calls); expect(f.submit).toHaveBeenCalledTimes(1);
});

it.each([
  new Error("unclassified failure"),
  new EngineRequestError(1, {code: "OVERLOADED", message: "capacity", retry: "no"}),
  new EngineRequestError(1, {code: "DEADLINE_EXCEEDED", message: "deadline", retry: "afterBackoff"}),
])("does not locally retry an undeclared receipt overload: %s", async error => {
  const proof = vi.fn().mockRejectedValue(error), f = fixture({state: {isReceiptApplied: proof}});
  const fresh = await f.delivery.freshOwnerAuthority(binding);
  if (fresh.kind !== "authority") throw new Error("Missing authority");
  expect(await f.delivery.deliver(fresh.authority, envelope)).toEqual({kind: "retry"});
  expect(proof).toHaveBeenCalledTimes(1);
});

it("owns Buffer-backed pending bytes before an asynchronous transport can observe caller mutation", async () => {
  const f = fixture({retained: true}), fresh = await f.delivery.freshOwnerAuthority(binding);
  if (fresh.kind !== "authority") throw new Error("Missing authority");
  const update = Buffer.from(envelope.update), work = f.delivery.deliver(fresh.authority, {...envelope, update});
  update.fill(9);
  expect(await work).toEqual({kind: "receipt", receipt: f.receipt});
  expect(f.submit.mock.calls[0]![0].updateBytes).toEqual(envelope.update);
});

// These entries carry no retained person or agent provenance.
it.each(["seed", "automation", "actorless", "Collection adoption", "owner delivery"])("leaves %s entries unattributed", async () => {
  const f = fixture({retained: true}), fresh = await f.delivery.freshOwnerAuthority(binding);
  if (fresh.kind !== "authority") throw new Error("Missing authority");
  const {personEdit: _, ...uncredited} = envelope;
  expect(await f.delivery.deliver(fresh.authority, uncredited)).toEqual({kind: "receipt", receipt: f.receipt});
  expect(f.submit.mock.calls[0]![0]).not.toHaveProperty("authorContext");
});

it("keeps an entry's submitted account through a missing lookup", async () => {
  const options: Parameters<typeof fixture>[0] = {retained: true, accountId: "owner", result: {result: "retry", reason: "admission-unavailable"}};
  const f = fixture(options);
  const pass = async () => {
    const fresh = await f.delivery.freshOwnerAuthority(binding);
    if (fresh.kind !== "authority") throw new Error("Missing authority");
    return f.delivery.deliver(fresh.authority, envelope);
  };
  expect(await pass()).toEqual({kind: "retry"});
  const submitted = f.submit.mock.calls[0]![0];
  options.accountId = null;
  expect(await pass()).toEqual({kind: "retry"});
  expect(f.submit).toHaveBeenCalledTimes(1);
  options.accountId = "owner"; options.result = undefined;
  expect(await pass()).toEqual({kind: "receipt", receipt: f.receipt});
  expect(f.submit.mock.calls[1]![0]).toEqual(submitted);
});
