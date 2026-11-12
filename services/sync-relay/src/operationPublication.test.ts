import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeOrdinaryPublicationState, type JsonValue, type Request } from "@dohc/workspace-engine-client";
import { EngineRequestError, type EngineClient } from "@dohc/workspace-engine-client/daemon";
import {
  COULD_NOT_SEND,
  WORKSPACE_CHANGED,
  publishOnce,
  publishOperation,
  settleOperations,
  tombstoneSettledOperations,
  type PublicationAnswer,
  type PublicationCommand,
  type PublicationCopy,
  type PublicationStage,
  type ReceiptReader,
} from "./operationPublication";
import type { SyncRelayStorage } from "./storage";
import { OPERATION_ACTIVE_MS, OPERATION_TOMBSTONE_BATCH, type OperationRecord, type OperationStage } from "./storage/operationRecords";
import { closeTestStorages, inspectDatabase, storagePath, testStorage } from "./testing";

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeTestStorages();
});

const WORKSPACE = "trip";
const OWNER = "ana";
const THREAD = "thread-1";
const ORIGIN = "server-copy";

// A reply that answers a question: the reply's message, the follow a first
// message may add, then the decision it resolves.
const replyStage = (id = "reply-1"): PublicationStage => ({
  key: `${id}:reply`, role: "reply", records: [
    { kind: "chat.message.append", fields: { messageId: id, threadId: THREAD, body: "Yes", authorUserId: OWNER } },
    { kind: "chat.follow.set", fields: { ownerUserId: OWNER, targetId: THREAD }, optional: true },
  ],
});
const decisionStage = (id = "reply-1"): PublicationStage => ({
  key: `${id}:decision`, role: "decision", records: [
    { kind: "chat.decision.set", fields: { messageId: "question", threadId: THREAD, state: "resolved", resolvedByMessageId: id } },
  ],
});
const answer = (id = "reply-1"): PublicationCommand => ({ stages: [replyStage(id), decisionStage(id)] });

const messagePayload = (id = "reply-1") =>
  ({ messageId: id, threadId: THREAD, authorKind: "human", authorDisplayName: "Ana", authorUserId: OWNER, body: "Yes", createdAtMs: 1 });
const followPayload = { ownerUserId: OWNER, targetKind: "thread", targetId: THREAD, state: "following", atMs: 1 };
const decisionPayload = (by = "reply-1") =>
  ({ threadId: THREAD, messageId: "question", state: "resolved", resolvedByMessageId: by, atMs: 2 });

type Coordinates = Array<[originSeq: number, state: "pushed" | "pending" | "refused"]>;
const written = (stageKey: string, coordinates: Coordinates) => ({
  stageKey, state: "present", outcome: "written", threadId: THREAD,
  coordinates: coordinates.map(([originSeq, state]) => ({ originId: ORIGIN, originSeq, state })),
});
const lost = (stageKey: string, winnerMessageId: string) =>
  ({ stageKey, state: "present", outcome: "lost", threadId: THREAD, winnerMessageId, coordinates: [] });

async function relay() {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: WORKSPACE, ownerUserId: OWNER, createdAtMs: 1 });
  storage.claimWorkspaceIdentity({ workspaceId: WORKSPACE, replicationEpoch: "epoch", streamIdentity: "stream" });
  const raw = inspectDatabase(storagePath(storage));
  // The row the relay accepted at the copy's coordinate.
  const accepted = (originSeq: number, opKind: string, payload: JsonValue) => raw.prepare(
    "INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) VALUES (?, ?, ?, ?, ?, 1)",
  ).run(WORKSPACE, ORIGIN, originSeq, opKind, JSON.stringify(payload));
  // The refusal the relay wrote at the coordinate instead.
  const refused = (originSeq: number) => raw.prepare(
    `INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_admission)
     VALUES (?, ?, ?, 'relay.refused', ?, 1, 'refused')`,
  ).run(WORKSPACE, ORIGIN, originSeq, JSON.stringify({ opKind: "chat.message.append", payloadSha256: "0".repeat(64), reason: "too large" }));
  // The workspace's identity moves on, as after a restore.
  const rotate = () => storage.rotateWorkspaceIdentity({ workspaceId: WORKSPACE, ownerUserId: OWNER, replicationEpoch: "epoch-2",
    streamIdentity: "stream-2", rotatedAtMs: 2 });
  return { storage, accepted, refused, rotate };
}

function record(storage: SyncRelayStorage, command: PublicationCommand = answer(), operationId = "operation-1", nowMs = 0): OperationRecord {
  const claim = storage.recordAccountOperation({
    accountId: OWNER, operationId, binding: { workspaceId: WORKSPACE, operation: "reply", args: { operationId } },
    incarnation: 1, replicationEpoch: "epoch", streamIdentity: "stream", command, writesMessage: true, nowMs,
  });
  if (claim.kind !== "recorded") throw new Error(`expected a new record, got ${claim.kind}`);
  return claim.record;
}

const advance = (storage: SyncRelayStorage, stage: OperationStage, message?: "published") =>
  storage.advanceAccountOperation({ accountId: OWNER, operationId: "operation-1", stage, nowMs: 1, ...(message ? { message } : {}) })!.record;

// Waits until `signal` aborts, then rejects with its reason, as a request held in the engine or the lane does.
const heldUntil = (signal: AbortSignal | undefined) => new Promise<never>((_, reject) => {
  if (signal === undefined) return;
  if (signal.aborted) reject(signal.reason);
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

/** A copy whose engine answers receipts from `receipts`, by stage key; a key it doesn't hold answers absent. */
function copy(receipts: Map<string, unknown>) {
  const sent: string[] = [];
  let steps = 0;
  let failStep: Error | null = null;
  let failReceipts = false;
  let holdStep = false, holdReceipts = false;
  const signals: Array<AbortSignal | undefined> = [];
  const client = {
    sendRequest: async (request: Request, signal?: AbortSignal) => {
      sent.push(request.method);
      if (request.method !== "sync.ordinary.publicationState") throw new Error(`unexpected ${request.method}`);
      if (failReceipts) throw new Error("the engine is busy");
      if (holdReceipts) { signals.push(signal); return await heldUntil(signal); }
      const { stageKeys } = request.params as { stageKeys: string[] };
      return { id: request.id, result: { stages: stageKeys.map((stageKey) => receipts.get(stageKey) ?? { stageKey, state: "absent" }) } };
    },
  };
  let id = 0;
  const replica: PublicationCopy = {
    workspaceId: WORKSPACE, incarnation: 1, workspace: "handle", signal: new AbortController().signal, nextRequestId: () => ++id,
    client: client as unknown as EngineClient,
    // A step that catches up never says what the relay accepted.
    step: async (signal) => {
      steps += 1;
      if (holdStep) { signals.push(signal); return await heldUntil(signal); }
      if (failStep) throw failStep;
      return true;
    },
  };
  return {
    replica, sent, steps: () => steps, signals,
    failStep: (error: Error | null) => { failStep = error; },
    failReceipts: (fail: boolean) => { failReceipts = fail; },
    /** Steps, or receipt reads, wait in the lane or the engine until their attempt ends. */
    hold: (what: "step" | "receipts") => { if (what === "step") holdStep = true; else holdReceipts = true; },
  };
}

/** Reads receipts as the engine would answer them, decoded as the wrapper decodes them. */
const reader = (receipts: Map<string, unknown>): ReceiptReader => async (stageKeys) =>
  decodeOrdinaryPublicationState({ stages: stageKeys.map((stageKey) => receipts.get(stageKey) ?? { stageKey, state: "absent" }) }, stageKeys);

// Starts a write's publication on fake timers, and tells whether it has answered yet.
function answering(start: () => Promise<PublicationAnswer>) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let answered = false;
  const answer = start().finally(() => { answered = true; });
  return { answer, answered: () => answered };
}

// A clock that moves only when the driver waits.
function clock() {
  let ms = 0;
  return { nowMs: () => ms, pause: async (wait: number) => { ms += wait; }, set: (at: number) => { ms = at; } };
}

describe("a phone write's publication", () => {
  it("saves a write once the relay accepted every record its receipts list, as the command expects them", async () => {
    const { storage, accepted } = await relay();
    const write = record(storage);
    const receipts = new Map<string, unknown>([
      ["reply-1:reply", written("reply-1:reply", [[1, "pushed"], [2, "pushed"]])],
      ["reply-1:decision", written("reply-1:decision", [[3, "pushed"]])],
    ]);
    accepted(1, "chat.message.append", messagePayload());
    accepted(2, "chat.follow.set", followPayload);
    accepted(3, "chat.decision.set", decisionPayload());
    const engine = copy(receipts);
    const authorize = vi.fn(async () => undefined);
    const time = clock();
    const answered = await publishOperation({ storage, copy: engine.replica, record: write, authorize, ...time });
    expect(answered).toMatchObject({ state: "saved", record: { stage: "saved", messageState: "published", result: { threadId: THREAD } } });
    expect(engine.steps()).toBe(1);
    expect(authorize, "the caller is checked again before the answer").toHaveBeenCalledOnce();
    // A retry answers from the record, without another sync or read.
    const again = await publishOperation({ storage, copy: engine.replica, record: answered.record!, ...time });
    expect(again.state).toBe("saved");
    expect(engine.steps()).toBe(1);
    expect(engine.sent).toEqual(["sync.ordinary.publicationState"]);
  });

  it("never takes a sync that caught up for acceptance, and answers pending at its deadline", async () => {
    const { storage, accepted } = await relay();
    const write = record(storage);
    // The reply is pushed but the relay doesn't hold it yet; the decision isn't pushed.
    const receipts = new Map<string, unknown>([
      ["reply-1:reply", written("reply-1:reply", [[1, "pushed"]])],
      ["reply-1:decision", written("reply-1:decision", [[2, "pending"]])],
    ]);
    const engine = copy(receipts);
    const answered = await publishOperation({ storage, copy: engine.replica, record: write, deadlineMs: 1_000, ...clock() });
    expect(answered).toMatchObject({ state: "pending", record: { stage: "publishing", messageState: "pending", result: null } });
    expect(engine.steps()).toBeGreaterThan(1);

    // The relay accepts the reply: its message is published on its own, and the write still waits for the decision.
    accepted(1, "chat.message.append", messagePayload());
    const later = await publishOperation({ storage, copy: engine.replica, record: answered.record!, deadlineMs: 1_000, ...clock() });
    expect(later).toMatchObject({ state: "pending", record: { stage: "publishing", messageState: "published" } });
  });

  it("keeps waiting for a row that isn't what the write made, and for a required record the receipt doesn't list", async () => {
    const { storage, accepted } = await relay();
    const write = record(storage);
    const receipts = new Map<string, unknown>([
      ["reply-1:reply", written("reply-1:reply", [[2, "pushed"]])],
      ["reply-1:decision", written("reply-1:decision", [[3, "pushed"]])],
    ]);
    // Only the optional follow is listed for the reply, and the decision row names another reply.
    accepted(2, "chat.follow.set", followPayload);
    accepted(3, "chat.decision.set", decisionPayload("someone-else"));
    const engine = copy(receipts);
    expect(await publishOperation({ storage, copy: engine.replica, record: write, deadlineMs: 1_000, ...clock() }))
      .toMatchObject({ state: "pending", record: { stage: "publishing", messageState: "pending" } });
  });

  it("refuses a write whose coordinate carries a recorded refusal, or whose row the relay refused", async () => {
    const { storage, refused } = await relay();
    const first = record(storage, { stages: [replyStage()] });
    const refusedAtCopy = copy(new Map([["reply-1:reply", written("reply-1:reply", [[1, "refused"]])]]));
    expect(await publishOperation({ storage, copy: refusedAtCopy.replica, record: first, ...clock() })).toMatchObject({
      state: "refused", record: { stage: "refused", messageState: "pending", result: { threadId: THREAD, reason: COULD_NOT_SEND } },
    });

    const second = record(storage, { stages: [replyStage("reply-2")] }, "operation-2");
    refused(5);
    const refusedAtRelay = copy(new Map([["reply-2:reply", written("reply-2:reply", [[5, "pushed"]])]]));
    expect(await publishOperation({ storage, copy: refusedAtRelay.replica, record: second, ...clock() }))
      .toMatchObject({ state: "refused", record: { result: { reason: COULD_NOT_SEND } } });
  });

  it("answers already answered for a decision another reply won, and keeps its reply published", async () => {
    const { storage, accepted } = await relay();
    const write = record(storage);
    accepted(1, "chat.message.append", messagePayload());
    const engine = copy(new Map<string, unknown>([
      ["reply-1:reply", written("reply-1:reply", [[1, "pushed"]])],
      ["reply-1:decision", lost("reply-1:decision", "winner")],
    ]));
    expect(await publishOperation({ storage, copy: engine.replica, record: write, ...clock() })).toMatchObject({
      state: "refused",
      record: { stage: "refused", messageState: "published", result: { threadId: THREAD, reason: "already answered", winnerMessageId: "winner" } },
    });
  });

  it("stalls a write past its active time, and saves it once it publishes", async () => {
    const { storage, accepted } = await relay();
    const write = record(storage, { stages: [replyStage()] });
    const receipts = new Map<string, unknown>([["reply-1:reply", written("reply-1:reply", [[1, "pending"]])]]);
    const engine = copy(receipts);
    expect(await publishOnce(storage, engine.replica, [write], () => OPERATION_ACTIVE_MS - 1)).toMatchObject([{ stage: "recorded" }]);
    const [stalled] = (await publishOnce(storage, engine.replica, [write], () => OPERATION_ACTIVE_MS))!;
    expect(stalled).toMatchObject({ stage: "stalled", settledAtMs: null });

    receipts.set("reply-1:reply", written("reply-1:reply", [[1, "pushed"]]));
    accepted(1, "chat.message.append", messagePayload());
    expect(await publishOnce(storage, engine.replica, [stalled!], () => OPERATION_ACTIVE_MS + 1))
      .toMatchObject([{ stage: "saved", messageState: "published" }]);
  });

  it("stalls the writes a whole-push relay rejection held up, tells the operator, and leaves the rest to the receipts", async () => {
    const { storage } = await relay();
    const write = record(storage, { stages: [replyStage()] });
    const engine = copy(new Map([["reply-1:reply", written("reply-1:reply", [[1, "pending"]])]]));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    engine.failStep(new EngineRequestError(1, { code: "AUTHORSHIP_MISMATCH", message: "chat op author does not match", retry: "no" }));
    expect(await publishOnce(storage, engine.replica, [write], () => 1)).toMatchObject([{ stage: "stalled" }]);
    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0]![0])).toContain("AUTHORSHIP_MISMATCH");
    // Any other sync failure stalls nothing.
    const other = record(storage, { stages: [replyStage("reply-2")] }, "operation-2");
    engine.failStep(new Error("the relay is unreachable"));
    expect(await publishOnce(storage, engine.replica, [other], () => 1)).toMatchObject([{ stage: "recorded" }]);
    expect(logged).toHaveBeenCalledOnce();
  });

  it("leaves every write as it was when its receipts can't be read, but stalls one past its active time", async () => {
    const { storage } = await relay();
    const write = record(storage);
    const engine = copy(new Map());
    engine.failReceipts(true);
    expect(await publishOnce(storage, engine.replica, [write], () => 1)).toBeNull();
    expect(storage.listUnfinishedAccountOperations({ workspaceId: WORKSPACE })).toMatchObject([{ stage: "recorded" }]);
    expect(await publishOnce(storage, engine.replica, [write], () => OPERATION_ACTIVE_MS)).toBeNull();
    expect(storage.listUnfinishedAccountOperations({ workspaceId: WORKSPACE })).toMatchObject([{ stage: "stalled" }]);
  });

  it("reads the receipts after a step whose pull failed, and saves what its push published", async () => {
    const { storage, accepted } = await relay();
    const write = record(storage, { stages: [replyStage()] });
    accepted(1, "chat.message.append", messagePayload());
    const engine = copy(new Map([["reply-1:reply", written("reply-1:reply", [[1, "pushed"]])]]));
    engine.failStep(new Error("the pull failed"));
    expect(await publishOnce(storage, engine.replica, [write], () => 1)).toMatchObject([{ stage: "saved", messageState: "published" }]);
  });

  it("ends its attempt at the deadline while a step waits in the lane, and answers pending after the caller is checked", async () => {
    const { storage } = await relay();
    const write = record(storage, { stages: [replyStage()] });
    const engine = copy(new Map());
    engine.hold("step");
    const authorize = vi.fn(async () => undefined);
    const caller = new AbortController();
    const publishing = answering(() =>
      publishOperation({ storage, copy: engine.replica, record: write, authorize, signal: caller.signal, deadlineMs: 50, nowMs: () => 1 }));
    await vi.advanceTimersByTimeAsync(49);
    expect(publishing.answered(), "it waits until its deadline").toBe(false);
    expect(authorize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const answered = await publishing.answer;
    expect(answered).toMatchObject({ state: "pending", record: { stage: "publishing" } });
    expect(authorize).toHaveBeenCalledOnce();
    expect(engine.signals[0]?.aborted, "the step heard the deadline").toBe(true);
    expect(caller.signal.aborted, "the deadline isn't the caller's").toBe(false);
  });

  it("ends its attempt at the deadline while a receipt read waits in the engine", async () => {
    const { storage } = await relay();
    const write = record(storage, { stages: [replyStage()] });
    const engine = copy(new Map());
    engine.hold("receipts");
    const publishing = answering(() => publishOperation({ storage, copy: engine.replica, record: write, deadlineMs: 50, nowMs: () => 1 }));
    await vi.advanceTimersByTimeAsync(49);
    expect(publishing.answered(), "it waits until its deadline").toBe(false);
    expect(engine.signals[0]?.aborted, "the read is still waiting").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const answered = await publishing.answer;
    expect(answered).toMatchObject({ state: "pending", record: { stage: "publishing" } });
    expect(engine.signals[0]?.aborted).toBe(true);
  });

  it("rejects when its caller gives up, instead of answering", async () => {
    const { storage } = await relay();
    const write = record(storage, { stages: [replyStage()] });
    const engine = copy(new Map());
    engine.hold("step");
    const caller = new AbortController();
    const authorize = vi.fn(async () => undefined);
    const answering = publishOperation({ storage, copy: engine.replica, record: write, authorize, signal: caller.signal });
    caller.abort(new Error("the phone hung up"));
    await expect(answering).rejects.toThrow("the phone hung up");
    expect(authorize).not.toHaveBeenCalled();
  });

  it("counts only a row inside the log rows the write's own epoch and stream could make", async () => {
    const { storage, accepted, rotate } = await relay();
    // A matching row from before the write was recorded is not its own.
    accepted(1, "chat.message.append", messagePayload());
    const early = record(storage, { stages: [replyStage()] });
    const receipts = new Map<string, unknown>([["reply-1:reply", written("reply-1:reply", [[1, "pushed"]])]]);
    expect(await publishOnce(storage, copy(receipts).replica, [early], () => 1)).toMatchObject([{ stage: "recorded", messageState: "pending" }]);

    // Nor is one the relay logged after the workspace's identity moved on.
    const late = record(storage, { stages: [replyStage("reply-2")] }, "operation-2");
    rotate();
    accepted(2, "chat.message.append", messagePayload("reply-2"));
    await settleOperations(storage, [late], reader(new Map([["reply-2:reply", written("reply-2:reply", [[2, "pushed"]])]])), WORKSPACE_CHANGED, 5);
    expect(storage.advanceAccountOperation({ accountId: OWNER, operationId: "operation-2", nowMs: 6 })!.record)
      .toMatchObject({ stage: "refused", messageState: "pending", result: { reason: WORKSPACE_CHANGED } });
  });

  it("finishes from the record after a crash at each step, without writing a stage again", async () => {
    const { storage, accepted } = await relay();
    const receipts = new Map<string, unknown>([
      ["reply-1:reply", written("reply-1:reply", [[1, "pushed"]])],
      ["reply-1:decision", written("reply-1:decision", [[2, "pending"]])],
    ]);
    const engine = copy(receipts);
    // A crash after both engine stages, before the write host recorded either: their receipts show they committed.
    let current = record(storage);
    accepted(1, "chat.message.append", messagePayload());
    [current] = (await publishOnce(storage, engine.replica, [current], () => 1)) as [OperationRecord];
    expect(current).toMatchObject({ stage: "recorded", messageState: "published" });
    // A crash after the relay accepted the decision, before the verdict was recorded.
    receipts.set("reply-1:decision", written("reply-1:decision", [[2, "pushed"]]));
    accepted(2, "chat.decision.set", decisionPayload());
    current = advance(storage, "answer-written");
    expect(await publishOperation({ storage, copy: engine.replica, record: current, ...clock() })).toMatchObject({ state: "saved" });
    // A crash after the verdict: a retry answers from the record alone.
    const steps = engine.steps(), reads = engine.sent.length;
    expect((await publishOperation({ storage, copy: engine.replica, record: current, ...clock() })).state).toBe("saved");
    expect([engine.steps(), engine.sent.length]).toEqual([steps, reads]);
    // Nothing but receipts was ever asked of the engine.
    expect(new Set(engine.sent)).toEqual(new Set(["sync.ordinary.publicationState"]));
  });

  it("answers pending for a write recorded on another incarnation, which its own folder settles", async () => {
    const { storage } = await relay();
    const write = record(storage);
    const engine = copy(new Map());
    const answered = await publishOperation({ storage, copy: { ...engine.replica, incarnation: 2 }, record: write, ...clock() });
    expect(answered).toMatchObject({ state: "pending", record: { stage: "recorded" } });
    expect(engine.steps()).toBe(0);
  });
});

describe("settling a write whose folder goes", () => {
  it("takes the required stages from the command: one with no receipt is unpublished, and a published reply stays", async () => {
    const { storage, accepted } = await relay();
    const write = record(storage);
    accepted(1, "chat.message.append", messagePayload());
    await settleOperations(storage, [write], reader(new Map([["reply-1:reply", written("reply-1:reply", [[1, "pushed"]])]])), COULD_NOT_SEND, 5);
    expect(storage.listUnfinishedAccountOperations({ workspaceId: WORKSPACE })).toEqual([]);
    expect(advance(storage, "saved")).toMatchObject({
      stage: "refused", messageState: "published", settledAtMs: 5, result: { threadId: THREAD, reason: COULD_NOT_SEND },
    });
  });

  it("saves a write the relay already holds, answers a lost decision, and refuses one with the reason it was given", async () => {
    const { storage, accepted } = await relay();
    const done = record(storage, answer(), "done");
    const beaten = record(storage, answer("reply-2"), "beaten");
    const unpushed = record(storage, { stages: [replyStage("reply-3")] }, "unpushed");
    accepted(1, "chat.message.append", messagePayload());
    accepted(2, "chat.decision.set", decisionPayload());
    accepted(3, "chat.message.append", messagePayload("reply-2"));
    const receipts = new Map<string, unknown>([
      ["reply-1:reply", written("reply-1:reply", [[1, "pushed"]])],
      ["reply-1:decision", written("reply-1:decision", [[2, "pushed"]])],
      ["reply-2:reply", written("reply-2:reply", [[3, "pushed"]])],
      ["reply-2:decision", lost("reply-2:decision", "reply-1")],
      ["reply-3:reply", written("reply-3:reply", [[4, "pending"]])],
    ]);
    await settleOperations(storage, [done, beaten, unpushed], reader(receipts), WORKSPACE_CHANGED, 5);
    const final = (operationId: string) => storage.advanceAccountOperation({ accountId: OWNER, operationId, stage: "saved", nowMs: 6 })!.record;
    expect(final("done")).toMatchObject({ stage: "saved", messageState: "published", result: { threadId: THREAD } });
    expect(final("beaten")).toMatchObject({ stage: "refused", messageState: "published", result: { reason: "already answered", winnerMessageId: "reply-1" } });
    expect(final("unpushed")).toMatchObject({ stage: "refused", messageState: "pending", result: { threadId: THREAD, reason: WORKSPACE_CHANGED } });
  });

  it("saves a write whose push reached the relay though its answer was lost, from a receipt still pending", async () => {
    const { storage, accepted } = await relay();
    const write = record(storage, { stages: [replyStage()] });
    accepted(1, "chat.message.append", messagePayload());
    const receipts = new Map([["reply-1:reply", written("reply-1:reply", [[1, "pending"]])]]);
    // The driver waits for the copy to see its push.
    expect(await publishOnce(storage, copy(receipts).replica, [write], () => 1)).toMatchObject([{ stage: "recorded" }]);
    await settleOperations(storage, [write], reader(receipts), COULD_NOT_SEND, 5);
    expect(advance(storage, "saved")).toMatchObject({ stage: "saved", messageState: "published", result: { threadId: THREAD } });
  });

  it("throws, and changes nothing, when the receipts can't be read; a folder already gone leaves none", async () => {
    const { storage } = await relay();
    const write = record(storage);
    await expect(settleOperations(storage, [write], async () => { throw new Error("the engine is busy"); }, COULD_NOT_SEND, 5))
      .rejects.toThrow("the engine is busy");
    expect(storage.listUnfinishedAccountOperations({ workspaceId: WORKSPACE })).toMatchObject([{ stage: "recorded" }]);
    await settleOperations(storage, [write], null, COULD_NOT_SEND, 5);
    expect(advance(storage, "saved")).toMatchObject({ stage: "refused", messageState: "pending", result: { threadId: null, reason: COULD_NOT_SEND } });
  });
});

it("turns settled writes into tombstones a batch at a time", async () => {
  const batches = [OPERATION_TOMBSTONE_BATCH, OPERATION_TOMBSTONE_BATCH, 3];
  const pause = vi.fn(async () => undefined);
  const storage = { tombstoneSettledAccountOperations: vi.fn(() => batches.shift() ?? 0) };
  expect(await tombstoneSettledOperations(storage, 10, pause)).toBe(2 * OPERATION_TOMBSTONE_BATCH + 3);
  expect(pause).toHaveBeenCalledTimes(2);
  expect(storage.tombstoneSettledAccountOperations).toHaveBeenCalledWith(10);
});
