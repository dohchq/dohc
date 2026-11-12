import { afterEach, describe, expect, it, vi } from "vitest";
import { asRecord } from "@dohc/workspace-core";
import { CHATS_METHOD, ChatsLiveAdapter, type EngineTransport, type JsonValue, type Request, type Response } from "@dohc/workspace-engine-client";
import { EngineRequestError, type EngineClient } from "@dohc/workspace-engine-client/daemon";
import { ChatsLoopbackEngine, VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import {
  OPERATION_ID_MAX_LENGTH, phoneWriteIds, replayUnfinishedWrites, runPhoneWrite, type PhoneWrite, type PhoneWriteAnswer,
} from "./accountChatWrites";
import type { AutomationReplica } from "./automationReplicas";
import { notFound } from "./errors";
import { OPERATION_KEEP_SETTLED_MS } from "./storage/operationRecords";
import { closeTestStorages, inspectDatabase, storagePath, testStorage } from "./testing";

// The phone's chat writes on a copy whose engine is an in-memory stand-in for
// its chats and files. The stand-in writes a receipt for each keyed stage, as
// the engine does, and the copy's step pushes the receipts' rows to the relay.

afterEach(async () => {
  vi.restoreAllMocks();
  await closeTestStorages();
});

const WORKSPACE = "trip";
const OWNER = "ana";
const ORIGIN = "server-copy";
const WRITES = new Set<string>([CHATS_METHOD.threadStart, CHATS_METHOD.messageSend, CHATS_METHOD.decisionResolve, CHATS_METHOD.reactionSet]);

type Row = { originSeq: number; kind: string; payload: { [field: string]: JsonValue }; pushed: boolean };
type Receipt = { threadId: string; outcome: "written" | "lost"; winnerMessageId?: string; rows: Row[] };

class TestEngine implements EngineTransport {
  readonly chats = new ChatsLoopbackEngine();
  readonly files = new VersionedLoopbackEngine();
  readonly failing = new Map<string, Error>();
  /** Each chat write that reached the engine, in order. */
  readonly writes: Request[] = [];
  readonly receipts = new Map<string, Receipt>();
  /** Runs as each chat write reaches the engine, before it changes anything. */
  beforeWrite: () => void = () => undefined;
  private originSeq = 0;
  onEvent() { return () => undefined; }
  close() {}

  async sendRequest(request: Request): Promise<Response> {
    const failure = this.failing.get(request.method);
    if (failure) throw failure;
    if (request.method === "sync.ordinary.publicationState") {
      const stageKeys = asRecord(request.params)?.stageKeys as string[];
      return { id: request.id, result: { stages: stageKeys.map((stageKey) => this.stateOf(stageKey)) } };
    }
    if (!request.method.startsWith("chats.")) return await this.files.sendRequest(request);
    const write = WRITES.has(request.method);
    if (write) {
      this.writes.push(request);
      this.beforeWrite();
    }
    let response: Response;
    try {
      response = await this.chats.sendRequest(request);
    } catch (error) {
      // The engine's own refusal: the request didn't happen, and won't if asked again.
      throw new EngineRequestError(request.id, { code: "INVALID_PARAMS", message: error instanceof Error ? error.message : "refused", retry: "no" },
        request.method);
    }
    if (write && asRecord(request.params)?.stageReceipt === true && typeof request.idempotencyKey === "string") {
      await this.receive(request, request.idempotencyKey);
    }
    return response;
  }

  /** Pushes each row the receipts list that the relay hasn't had yet. */
  push(relay: (row: Row) => void): void {
    for (const receipt of this.receipts.values()) {
      for (const row of receipt.rows.filter((each) => !each.pushed)) {
        relay(row);
        row.pushed = true;
      }
    }
  }

  private stateOf(stageKey: string): JsonValue {
    const receipt = this.receipts.get(stageKey);
    if (receipt === undefined) return { stageKey, state: "absent" };
    return {
      stageKey, state: "present", outcome: receipt.outcome, threadId: receipt.threadId,
      ...(receipt.winnerMessageId === undefined ? {} : { winnerMessageId: receipt.winnerMessageId }),
      coordinates: receipt.rows.map((row) => ({ originId: ORIGIN, originSeq: row.originSeq, state: row.pushed ? "pushed" : "pending" })),
    };
  }

  // What the engine journals for a stage, read back from the stand-in.
  private async receive(request: Request, key: string): Promise<void> {
    if (this.receipts.has(key)) return;
    const params = asRecord(request.params) ?? {};
    const read = new ChatsLiveAdapter(this.chats, String(request.workspace), { workspaceId: WORKSPACE });
    const row = (kind: string, payload: { [field: string]: JsonValue }): Row => ({ originSeq: ++this.originSeq, kind, payload, pushed: false });
    if (request.method === CHATS_METHOD.decisionResolve) {
      const threadId = String(params.threadId);
      const decision = (await read.listThreadDecisions(WORKSPACE, threadId)).find((each) => each.messageId === params.messageId);
      const winner = decision?.resolvedByMessageId ?? "";
      this.receipts.set(key, winner === params.resolvedByMessageId
        ? { threadId, outcome: "written", rows: [row("chat.decision.set",
          { threadId, messageId: String(params.messageId), state: "resolved", resolvedByMessageId: winner, atMs: 2 })] }
        : { threadId, outcome: "lost", winnerMessageId: winner, rows: [] });
      return;
    }
    if (request.method === CHATS_METHOD.reactionSet) {
      const threadId = String(params.threadId);
      this.receipts.set(key, { threadId, outcome: "written", rows: [row("chat.reaction.set", {
        threadId, messageId: String(params.messageId), emoji: String(params.emoji), authorId: String(asRecord(params.author)?.authorId),
        state: String(params.state), atMs: 3,
      })] });
      return;
    }
    const message = await read.getMessage({ workspaceId: WORKSPACE, messageId: String(params.messageId) });
    const rows = [row("chat.message.append", {
      messageId: message.id, threadId: message.threadId, authorKind: message.author.kind, authorDisplayName: message.author.displayName,
      authorUserId: message.authorUserId ?? null, body: message.body, createdAtMs: message.createdAtMs,
    })];
    if (params.needsDecision === true || Array.isArray(params.options)) {
      rows.push(row("chat.decision.set", { threadId: message.threadId, messageId: message.id, state: "open", atMs: 1 }));
    }
    this.receipts.set(key, { threadId: message.threadId, outcome: "written", rows });
  }
}

async function fixture() {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: WORKSPACE, ownerUserId: OWNER, createdAtMs: 1 });
  storage.claimWorkspaceIdentity({ workspaceId: WORKSPACE, replicationEpoch: "epoch", streamIdentity: "stream" });
  storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 1, reasons: ["account"] });
  const raw = inspectDatabase(storagePath(storage));
  const engine = new TestEngine();
  // What the relay does with what the copy pushes.
  let relay: "accept" | "refuse" | "hold" = "accept";
  const pushed = (row: Row) => {
    if (relay === "accept") {
      raw.prepare("INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) VALUES (?, ?, ?, ?, ?, 1)")
        .run(WORKSPACE, ORIGIN, row.originSeq, row.kind, JSON.stringify(row.payload));
    } else {
      raw.prepare(`INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_admission)
        VALUES (?, ?, ?, 'relay.refused', ?, 1, 'refused')`)
        .run(WORKSPACE, ORIGIN, row.originSeq, JSON.stringify({ opKind: row.kind, payloadSha256: "0".repeat(64), reason: "too large" }));
    }
  };
  let requestId = 0;
  const lifetime = new AbortController();
  const copy: AutomationReplica = {
    workspaceId: WORKSPACE, ownerUserId: OWNER, incarnation: 1, reasons: ["account"], startedAtMs: 1, pulledHead: 0,
    root: "unused", metadataDir: "unused", client: engine as unknown as EngineClient, workspace: WORKSPACE, signal: lifetime.signal,
    nextRequestId: () => ++requestId, withRecordWork: (work) => work(), sync: async () => undefined,
    step: async () => {
      if (relay !== "hold") engine.push(pushed);
      return true;
    },
  };
  const chats = new ChatsLiveAdapter(engine.chats, WORKSPACE, { workspaceId: WORKSPACE });
  // A clock that moves only while publication waits between attempts.
  let ms = 0;
  const authorize = vi.fn(async () => undefined);
  const run = (write: PhoneWrite, displayName = "Ana") => runPhoneWrite({
    storage, copy, write, authorize, writer: { accountId: OWNER, displayName, serverUrl: "https://relay.example.test" },
    nowMs: () => ms, pause: async (wait) => { ms += wait; }, deadlineMs: 1_000,
  });
  const rows = () => Number(raw.prepare("SELECT count(*) AS n FROM sync_relay_account_operations").get()?.n);
  const operation = (operationId: string) => raw.prepare(
    "SELECT stage, message_state, result_json, command_json FROM sync_relay_account_operations WHERE operation_id = ?").get(operationId);
  return { storage, raw, engine, copy, chats, run, rows, operation, authorize, relay: (mode: typeof relay) => { relay = mode; } };
}

const human = { kind: "human" as const, displayName: "Ana" };

/** A Group with a post, an agent's poll in it, and a thread on a secret file with a question of the owner's. */
async function seed(chats: ChatsLiveAdapter) {
  const planning = await chats.createChannel({ workspaceId: WORKSPACE, name: "Planning", type: "both" });
  await chats.startChannelThread({ workspaceId: WORKSPACE, channelId: planning.channelId, threadId: "thread-stay", messageId: "message-stay",
    lane: "posts", author: human, authorUserId: OWNER, authorActorKey: null, body: "Where do we stay?" });
  await chats.sendMessage({ workspaceId: WORKSPACE, threadId: "thread-stay", messageId: "message-poll", author: { kind: "agent", displayName: "Nova" },
    authorOwnerDisplayName: "Ana", authorActorKey: null, body: "Alfama or Baixa?", options: ["Alfama", "Baixa"] });
  const onSecret = await chats.createThread({ workspaceId: WORKSPACE, title: "Keys", linkedFile: { objectId: "object-env", pathHint: ".env" } });
  await chats.sendMessage({ workspaceId: WORKSPACE, threadId: onSecret.id, messageId: "message-secret", author: human, authorUserId: OWNER,
    authorActorKey: null, body: "Which key?", needsDecision: true });
  return { planning, onSecret };
}

const reply = (operationId: string, threadId: string, more: { parentMessageId?: string; resolves?: { messageId: string; chosenOption?: string } } = {}):
  PhoneWrite => ({ operation: "reply", args: { operationId, threadId, body: "Alfama", ...more } });
const react = (operationId: string, messageId: string): PhoneWrite =>
  ({ operation: "react", args: { operationId, messageId, emoji: "👍", state: "added" } });
const missing = (reason: string) => ({ ok: false, reason, refusal: "missing" });
// An answer with the ID it names put aside, to compare a hidden target's answer with a missing one's.
const shape = (answer: PhoneWriteAnswer, id: string) => JSON.stringify(answer).replaceAll(id, "<id>");

describe("a phone's chat write through the server's copy", () => {
  it("saves a post once the relay holds its records, with its row written before the engine changes anything", async () => {
    const f = await fixture();
    const { planning } = await seed(f.chats);
    const rowsAtWrite: number[] = [];
    f.engine.beforeWrite = () => rowsAtWrite.push(f.rows());
    const post: PhoneWrite = { operation: "post", args: { operationId: "op-post", groupId: planning.channelId, title: "Dinner", body: "Where?" } };
    const ids = phoneWriteIds(OWNER, WORKSPACE, "op-post");
    const answer = await f.run(post);
    expect(answer).toEqual({ ok: true, state: "saved", threadId: ids.threadId, messageId: ids.messageId("post") });
    expect(rowsAtWrite, "the row came first").toEqual([1]);
    expect(f.engine.writes).toMatchObject([{ method: CHATS_METHOD.threadStart, idempotencyKey: ids.key("post"), params: {
      channelId: planning.channelId, lane: "posts", threadId: ids.threadId, messageId: ids.messageId("post"), title: "Dinner", body: "Where?",
      authorKind: "human", authorDisplayName: "Ana", authorUserId: OWNER, stageReceipt: true,
    } }]);
    const row = f.operation("op-post");
    expect(row).toMatchObject({ stage: "saved", message_state: "published" });
    expect(JSON.parse(String(row?.command_json))).toMatchObject({
      author: { accountId: OWNER, displayName: "Ana" },
      write: { kind: "start", lane: "posts", channelId: planning.channelId, threadId: ids.threadId, messageId: ids.messageId("post") },
      stages: [{ key: ids.key("post"), role: "post" }],
    });
    expect(f.authorize.mock.calls.length, "access is checked before the row, each stage, and the answer").toBeGreaterThanOrEqual(4);

    // A retry answers from the row and writes nothing, whatever the account is called now.
    expect(await f.run(post, "Ana Maria")).toEqual(answer);
    expect(f.engine.writes).toHaveLength(1);
  });

  it("answers with the thread a send joined, when its group already has a running conversation", async () => {
    const f = await fixture();
    const { planning } = await seed(f.chats);
    await f.chats.startChannelThread({ workspaceId: WORKSPACE, channelId: planning.channelId, threadId: "thread-running", messageId: "message-hi",
      lane: "chat", author: human, authorUserId: OWNER, authorActorKey: null, body: "Hi" });
    const answer = await f.run({ operation: "send", args: { operationId: "op-send", streamId: planning.channelId, body: "Lunch?" } });
    expect(answer).toMatchObject({ ok: true, state: "saved", threadId: "thread-running" });
  });

  it("answers pending while the relay hasn't the write's records, and saved on a retry once it has, without writing again", async () => {
    const f = await fixture();
    await seed(f.chats);
    f.relay("hold");
    const write = reply("op-pending", "thread-stay");
    const ids = phoneWriteIds(OWNER, WORKSPACE, "op-pending");
    expect(await f.run(write)).toEqual({ ok: true, state: "pending", threadId: "thread-stay", messageId: ids.messageId("reply") });
    expect(f.operation("op-pending")).toMatchObject({ stage: "publishing", message_state: "pending" });
    f.relay("accept");
    expect(await f.run(write)).toEqual({ ok: true, state: "saved", threadId: "thread-stay", messageId: ids.messageId("reply") });
    expect(f.engine.writes).toHaveLength(1);
  });

  it("refuses with only the closed list's words: a relay refusal, an engine refusal, an answer that lost, other arguments, and a write long settled", async () => {
    const f = await fixture();
    const { planning } = await seed(f.chats);

    f.relay("refuse");
    expect(await f.run(reply("op-refused", "thread-stay"))).toEqual({ ok: false, refusal: "refused", reason: "Couldn't send", threadId: "thread-stay" });
    f.relay("accept");

    // The engine's refusal of the first stage: nothing of the write can publish, and its words stay on the server.
    f.engine.failing.set(CHATS_METHOD.messageSend, new EngineRequestError(1, {
      code: "INVALID_PARAMS", message: "The engine could not open /srv/dohc/automations/trip/.dohc/engine/engine.db.", retry: "no",
    }, CHATS_METHOD.messageSend));
    const refusedByEngine = await f.run(reply("op-engine", "thread-stay"));
    expect(refusedByEngine).toEqual({ ok: false, refusal: "refused", reason: "Couldn't send" });
    expect(JSON.stringify(refusedByEngine)).not.toContain("/srv/");
    expect(f.operation("op-engine")).toMatchObject({ stage: "refused" });
    f.engine.failing.clear();

    // Another reply answered the poll first: this reply stays, and the answer names the winner.
    await f.chats.sendMessage({ workspaceId: WORKSPACE, threadId: "thread-stay", messageId: "message-first", author: human, authorUserId: OWNER,
      authorActorKey: null, body: "Baixa" });
    await f.chats.resolveChatDecision({ workspaceId: WORKSPACE, threadId: "thread-stay", messageId: "message-poll",
      resolvedByMessageId: "message-first", chosenOption: "Baixa", idempotencyKey: "seed-resolve" });
    expect(await f.run(reply("op-lost", "thread-stay", { resolves: { messageId: "message-poll", chosenOption: " Alfama " } })))
      .toEqual({ ok: false, refusal: "refused", reason: "already answered", threadId: "thread-stay", winnerMessageId: "message-first" });
    expect(f.operation("op-lost"), "the reply itself published").toMatchObject({ message_state: "published" });

    const writes = f.engine.writes.length;
    expect(await f.run({ operation: "post", args: { operationId: "op-lost", groupId: planning.channelId, body: "Other" } }), "other arguments")
      .toEqual({ ok: false, refusal: "refused", reason: "Couldn't send" });
    f.storage.tombstoneSettledAccountOperations(OPERATION_KEEP_SETTLED_MS + 60_000);
    expect(await f.run(reply("op-refused", "thread-stay")), "a tombstone").toEqual({ ok: false, refusal: "refused", reason: "too old" });
    expect(f.engine.writes).toHaveLength(writes);
  });

  it("refuses a hidden target before any row, exactly as a missing one, as reads answer", async () => {
    const f = await fixture();
    const { onSecret } = await seed(f.chats);
    const cases: Array<[label: string, hidden: PhoneWrite, hiddenId: string, absent: PhoneWrite, absentId: string, reason: (id: string) => string]> = [
      ["a reply with no parent", reply("op-1", onSecret.id), onSecret.id, reply("op-2", "thread-nowhere"), "thread-nowhere",
        (id) => `chat thread not found: ${id}`],
      ["a reply under a parent", reply("op-3", "thread-stay", { parentMessageId: "message-secret" }), "message-secret",
        reply("op-4", "thread-stay", { parentMessageId: "message-nowhere" }), "message-nowhere", (id) => `dohc: no such message in this thread: ${id}`],
      ["an answer", reply("op-5", onSecret.id, { resolves: { messageId: "message-secret" } }), onSecret.id,
        reply("op-6", "thread-nowhere", { resolves: { messageId: "message-secret" } }), "thread-nowhere", (id) => `chat thread not found: ${id}`],
      ["a reaction", react("op-7", "message-secret"), "message-secret", react("op-8", "message-nowhere"), "message-nowhere",
        (id) => `dohc: no such message in this thread: ${id}`],
    ];
    for (const [label, hidden, hiddenId, absent, absentId, reason] of cases) {
      const answered = await f.run(hidden);
      expect(answered, label).toEqual(missing(reason(hiddenId)));
      expect(shape(answered, hiddenId), label).toBe(shape(await f.run(absent), absentId));
    }
    // A Group no ID names answers as the read of one does.
    for (const write of [
      { operation: "post", args: { operationId: "op-9", groupId: "channel-nowhere", body: "Hi" } },
      { operation: "send", args: { operationId: "op-10", streamId: "channel-nowhere", body: "Hi" } },
    ] satisfies PhoneWrite[]) {
      expect(await f.run(write), write.operation).toEqual(missing("dohc: no such group: channel-nowhere"));
    }
    expect(f.rows()).toBe(0);
    expect(f.engine.writes).toEqual([]);
  });

  it("refuses a new thread or message whose derived ID a hidden row already holds, as missing", async () => {
    const f = await fixture();
    const { planning, onSecret } = await seed(f.chats);
    const posted = phoneWriteIds(OWNER, WORKSPACE, "op-thread");
    await f.chats.request(CHATS_METHOD.threadCreate,
      { threadId: posted.threadId, title: "Keys", linkedFile: { objectId: "object-env", pathHint: ".env" } }, { idempotencyKey: posted.threadId });
    expect(await f.run({ operation: "post", args: { operationId: "op-thread", groupId: planning.channelId, body: "Hi" } }))
      .toEqual(missing(`chat thread not found: ${posted.threadId}`));
    const replied = phoneWriteIds(OWNER, WORKSPACE, "op-message");
    await f.chats.sendMessage({ workspaceId: WORKSPACE, threadId: onSecret.id, messageId: replied.messageId("reply"), author: human,
      authorActorKey: null, body: "Taken" });
    expect(await f.run(reply("op-message", "thread-stay")))
      .toEqual(missing(`dohc: no such message in this thread: ${replied.messageId("reply")}`));
    expect(f.rows()).toBe(0);
    expect(f.engine.writes).toEqual([]);
  });

  it("finishes an answer whose reply saved by resolving with that reply, and refuses it as missing once its thread is hidden", async () => {
    for (const hide of [false, true]) {
      const f = await fixture();
      await seed(f.chats);
      // A thread on a page, with an agent's question.
      const onPage = await f.chats.createThread({ workspaceId: WORKSPACE, title: "Plan", linkedFile: { objectId: "object-plan", pathHint: "docs/plan.md" } });
      await f.chats.sendMessage({ workspaceId: WORKSPACE, threadId: onPage.id, messageId: "message-q", author: { kind: "agent", displayName: "Nova" },
        authorOwnerDisplayName: "Ana", authorActorKey: null, body: "Ship it?", needsDecision: true });
      const write = reply("op-answer", onPage.id, { resolves: { messageId: "message-q" } });
      const ids = phoneWriteIds(OWNER, WORKSPACE, "op-answer");
      // The resolve's answer is lost, so it isn't known to have happened.
      f.engine.failing.set(CHATS_METHOD.decisionResolve, new Error("the engine went away"));
      expect(await f.run(write)).toEqual({ ok: true, state: "pending", threadId: onPage.id, messageId: ids.messageId("reply") });
      expect(f.operation("op-answer")).toMatchObject({ stage: "publishing", message_state: "published" });
      f.engine.failing.clear();
      // The relay last saw the page's file at a secret path.
      if (hide) f.raw.prepare(`INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, recorded_at_ms)
        VALUES (?, 'object-plan', 1, 'moment-1', 'main', '.env', 1)`).run(WORKSPACE);

      const retried = await f.run(write);
      const resolves = f.engine.writes.filter((request) => request.method === CHATS_METHOD.decisionResolve);
      if (hide) {
        expect(retried).toEqual(missing("dohc: no such message in this thread: message-q"));
        expect(resolves).toEqual([]);
      } else {
        expect(retried).toEqual({ ok: true, state: "saved", threadId: onPage.id, messageId: ids.messageId("reply") });
        expect(resolves).toMatchObject([{ idempotencyKey: ids.key("decision"), params: {
          threadId: onPage.id, messageId: "message-q", resolvedByMessageId: ids.messageId("reply"), stageReceipt: true,
        } }]);
        expect(f.engine.writes.filter((request) => request.method === CHATS_METHOD.messageSend), "the reply is written once").toHaveLength(1);
      }
    }
  });

  it("replays a stage that never committed when the copy opens, from the stored author, while the account may still publish it", async () => {
    const f = await fixture();
    await seed(f.chats);
    const ids = phoneWriteIds(OWNER, WORKSPACE, "op-replay");
    // The send's answer is lost, so the stage never committed as far as anything knows.
    f.engine.failing.set(CHATS_METHOD.messageSend, new Error("the engine went away"));
    expect(await f.run(reply("op-replay", "thread-stay"))).toMatchObject({ ok: true, state: "pending" });
    f.engine.failing.clear();
    const errors: unknown[] = [];
    const replay = async () => await replayUnfinishedWrites({ storage: f.storage, copy: f.copy, nowMs: () => 0, onError: (error) => errors.push(error),
      records: f.storage.listUnfinishedAccountOperations({ workspaceId: WORKSPACE, incarnation: 1 }) });

    f.storage.setShowOnPhone({ ownerUserId: OWNER, workspaceId: WORKSPACE, showOnPhone: false });
    await replay();
    expect(f.engine.writes, "hidden from the phone, nothing replays").toEqual([]);
    f.storage.setShowOnPhone({ ownerUserId: OWNER, workspaceId: WORKSPACE, showOnPhone: true });

    await replay();
    expect(f.engine.writes).toMatchObject([{ method: CHATS_METHOD.messageSend, idempotencyKey: ids.key("reply"), params: {
      threadId: "thread-stay", messageId: ids.messageId("reply"), authorDisplayName: "Ana", authorUserId: OWNER, stageReceipt: true,
    } }]);
    await replay();
    expect(f.engine.writes, "a stage with a receipt doesn't replay").toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("refuses a message the shared rules refuse, and an operation ID outside its bounds, as bad requests, writing nothing", async () => {
    const f = await fixture();
    await seed(f.chats);
    expect(OPERATION_ID_MAX_LENGTH).toBe(128);
    for (const write of [
      { operation: "reply", args: { operationId: "op-empty", threadId: "thread-stay", body: " \n " } } satisfies PhoneWrite,
      reply("op-choice", "thread-stay", { resolves: { messageId: "message-poll", chosenOption: "Belém" } }),
      reply("x".repeat(129), "thread-stay"),
      reply("", "thread-stay"),
    ]) {
      await expect(f.run(write), JSON.stringify(write.args)).rejects.toMatchObject({ code: "bad_request" });
    }
    expect(await f.run(reply("x".repeat(128), "thread-stay"))).toMatchObject({ ok: true, state: "saved" });
    expect(f.rows()).toBe(1);
  });

  it("answers as missing, with no row, when access ends before the row", async () => {
    const f = await fixture();
    await seed(f.chats);
    // Before the copy syncs, after it, then as the host admits the write.
    let checks = 0;
    f.authorize.mockImplementation(async () => {
      if (++checks === 3) throw notFound();
    });
    await expect(f.run(reply("op-gone", "thread-stay"))).rejects.toMatchObject({ code: "not_found" });
    expect(f.rows()).toBe(0);
    expect(f.engine.writes).toEqual([]);
  });
});
