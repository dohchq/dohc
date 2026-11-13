import { afterEach, describe, expect, it, vi } from "vitest";
import { CHATS_METHOD, ChatsLiveAdapter } from "@dohc/workspace-engine-client";
import { EngineRequestError, type EngineClient } from "@dohc/workspace-engine-client/daemon";
import { readChat } from "@dohc/workspace-operations/chats";
import {
  OPERATION_ID_MAX_LENGTH,
  phoneWriteIds,
  replayUnfinishedWrites,
  runPhoneWrite,
  type PhoneWrite,
  type PhoneWriteAnswer,
} from "./accountChatWrites";
import { serverChats } from "./accountOperations";
import type { AutomationReplica } from "./automationReplicas";
import { notFound } from "./errors";
import { OPERATION_KEEP_SETTLED_MS } from "./storage/operationRecords";
import { closeTestStorages, inspectDatabase, storagePath, testStorage } from "./testing";
import { PhoneWriteEngine, seedPhoneChats, type PhoneWriteRow } from "./testing/phoneWriteEngine";

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

async function fixture() {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: WORKSPACE, ownerUserId: OWNER, createdAtMs: 1 });
  storage.claimWorkspaceIdentity({
    workspaceId: WORKSPACE,
    replicationEpoch: "epoch",
    streamIdentity: "stream",
  });
  storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 1, reasons: ["account"] });
  const raw = inspectDatabase(storagePath(storage));
  const engine = new PhoneWriteEngine(WORKSPACE, ORIGIN);
  // The copy has files, so its active version exists, which placing a chat's file needs.
  engine.files.seedTextFile({
    workspace: WORKSPACE,
    path: "README.md",
    text: "# Trip\n",
    objectId: "object-readme",
  });
  // What the relay does with what the copy pushes.
  let relay: "accept" | "refuse" | "hold" = "accept";
  const pushed = (row: PhoneWriteRow) => {
    if (relay === "accept") {
      raw
        .prepare(
          "INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) VALUES (?, ?, ?, ?, ?, 1)",
        )
        .run(WORKSPACE, ORIGIN, row.originSeq, row.kind, JSON.stringify(row.payload));
    } else {
      raw
        .prepare(`INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_admission)
        VALUES (?, ?, ?, 'relay.refused', ?, 1, 'refused')`)
        .run(
          WORKSPACE,
          ORIGIN,
          row.originSeq,
          JSON.stringify({ opKind: row.kind, payloadSha256: "0".repeat(64), reason: "too large" }),
        );
    }
  };
  let requestId = 0;
  let syncError: Error | null = null;
  let heldSync: { reached(): void; open: Promise<void> } | null = null;
  const lifetime = new AbortController();
  const copy: AutomationReplica = {
    workspaceId: WORKSPACE,
    ownerUserId: OWNER,
    incarnation: 1,
    reasons: ["account"],
    startedAtMs: 1,
    pulledHead: 0,
    root: "unused",
    metadataDir: "unused",
    client: engine as unknown as EngineClient,
    workspace: WORKSPACE,
    signal: lifetime.signal,
    nextRequestId: () => ++requestId,
    withRecordWork: (work) => work(),
    sync: async () => {
      if (heldSync !== null) {
        heldSync.reached();
        await heldSync.open;
      }
      if (syncError !== null) throw syncError;
    },
    step: async () => {
      if (relay !== "hold") engine.push(pushed);
      return true;
    },
  };
  const chats = new ChatsLiveAdapter(engine.chats, WORKSPACE, { workspaceId: WORKSPACE });
  // A clock that moves only while publication waits between attempts.
  let ms = 0;
  const authorize = vi.fn(async () => undefined);
  const run = (write: PhoneWrite, displayName = "Ana") =>
    runPhoneWrite({
      storage,
      copy,
      write,
      authorize,
      writer: { accountId: OWNER, displayName, serverUrl: "https://relay.example.test" },
      nowMs: () => ms,
      pause: async (wait) => {
        ms += wait;
      },
      deadlineMs: 1_000,
    });
  const rows = () =>
    Number(raw.prepare("SELECT count(*) AS n FROM sync_relay_account_operations").get()?.n);
  const operation = (operationId: string) =>
    raw
      .prepare(
        "SELECT stage, message_state, result_json, command_json FROM sync_relay_account_operations WHERE operation_id = ?",
      )
      .get(operationId);
  return {
    storage,
    raw,
    engine,
    copy,
    chats,
    run,
    rows,
    operation,
    authorize,
    relay: (mode: typeof relay) => {
      relay = mode;
    },
    failSync: (error: Error | null) => {
      syncError = error;
    },
    /** Holds the next syncs. `reached` resolves once one is waiting. */
    holdSync: () => {
      let reached!: () => void, release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      heldSync = {
        reached,
        open: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      return {
        reached: waiting,
        release: () => {
          heldSync = null;
          release();
        },
      };
    },
  };
}

const human = { kind: "human" as const, displayName: "Ana" };
const seed = (chats: ChatsLiveAdapter) => seedPhoneChats(chats, WORKSPACE, OWNER);

const reply = (
  operationId: string,
  threadId: string,
  more: { parentMessageId?: string; resolves?: { messageId: string; chosenOption?: string } } = {},
): PhoneWrite => ({ operation: "reply", args: { operationId, threadId, body: "Alfama", ...more } });
const react = (operationId: string, messageId: string): PhoneWrite => ({
  operation: "react",
  args: { operationId, messageId, emoji: "👍", state: "added" },
});
const missing = (reason: string) => ({ ok: false, reason, refusal: "missing" });
// An answer with the ID it names put aside, to compare a hidden target's answer with a missing one's.
const shape = (answer: PhoneWriteAnswer, id: string) =>
  JSON.stringify(answer).replaceAll(id, "<id>");

describe("a phone's chat write through the server's copy", () => {
  it("saves a post once the relay holds its records, with its row written before the engine changes anything", async () => {
    const f = await fixture();
    const { planning } = await seed(f.chats);
    const rowsAtWrite: number[] = [];
    f.engine.beforeWrite = () => rowsAtWrite.push(f.rows());
    const post: PhoneWrite = {
      operation: "post",
      args: {
        operationId: "op-post",
        groupId: planning.channelId,
        title: "Dinner",
        body: "Where?",
      },
    };
    const ids = phoneWriteIds(OWNER, WORKSPACE, "op-post");
    const answer = await f.run(post);
    expect(answer).toEqual({
      ok: true,
      state: "saved",
      threadId: ids.threadId,
      messageId: ids.messageId("post"),
    });
    expect(rowsAtWrite, "the row came first").toEqual([1]);
    expect(f.engine.writes).toMatchObject([
      {
        method: CHATS_METHOD.threadStart,
        idempotencyKey: ids.key("post"),
        params: {
          channelId: planning.channelId,
          lane: "posts",
          threadId: ids.threadId,
          messageId: ids.messageId("post"),
          title: "Dinner",
          body: "Where?",
          authorKind: "human",
          authorDisplayName: "Ana",
          authorUserId: OWNER,
          stageReceipt: true,
        },
      },
    ]);
    const row = f.operation("op-post");
    expect(row).toMatchObject({ stage: "saved", message_state: "published" });
    expect(JSON.parse(String(row?.command_json))).toMatchObject({
      author: { accountId: OWNER, displayName: "Ana" },
      write: {
        kind: "start",
        lane: "posts",
        channelId: planning.channelId,
        threadId: ids.threadId,
        messageId: ids.messageId("post"),
      },
      stages: [{ key: ids.key("post"), role: "post" }],
    });
    expect(
      f.authorize.mock.calls.length,
      "access is checked before the row, each stage, and the answer",
    ).toBeGreaterThanOrEqual(4);

    // A retry answers from the row and writes nothing, whatever the account is called now.
    expect(await f.run(post, "Ana Maria")).toEqual(answer);
    expect(f.engine.writes).toHaveLength(1);
  });

  it("saves a post, a reply, and an answer whose receipts also hold the account's read mark", async () => {
    const f = await fixture();
    f.engine.readMarks = true;
    const { planning } = await seed(f.chats);
    expect(
      await f.run({
        operation: "post",
        args: { operationId: "op-read-post", groupId: planning.channelId, body: "Where?" },
      }),
    ).toMatchObject({ ok: true, state: "saved" });
    expect(await f.run(reply("op-read-reply", "thread-stay"))).toMatchObject({
      ok: true,
      state: "saved",
    });
    expect(
      await f.run(
        reply("op-read-answer", "thread-stay", {
          resolves: { messageId: "message-poll", chosenOption: "Alfama" },
        }),
      ),
    ).toMatchObject({ ok: true, state: "saved" });
    const marks = f.raw
      .prepare("SELECT count(*) AS n FROM sync_relay_log WHERE op_kind = 'chat.thread.read.set'")
      .get();
    expect(Number(marks?.n), "each message's receipt held a read mark").toBe(3);
  });

  it("answers with the thread a send joined, when its group already has a running conversation", async () => {
    const f = await fixture();
    const { planning } = await seed(f.chats);
    await f.chats.startChannelThread({
      workspaceId: WORKSPACE,
      channelId: planning.channelId,
      threadId: "thread-running",
      messageId: "message-hi",
      lane: "chat",
      author: human,
      authorUserId: OWNER,
      authorActorKey: null,
      body: "Hi",
    });
    const answer = await f.run({
      operation: "send",
      args: { operationId: "op-send", streamId: planning.channelId, body: "Lunch?" },
    });
    expect(answer).toMatchObject({ ok: true, state: "saved", threadId: "thread-running" });
  });

  it("answers pending while the relay hasn't the write's records, and saved on a retry once it has, without writing again", async () => {
    const f = await fixture();
    await seed(f.chats);
    f.relay("hold");
    const write = reply("op-pending", "thread-stay");
    const ids = phoneWriteIds(OWNER, WORKSPACE, "op-pending");
    expect(await f.run(write)).toEqual({
      ok: true,
      state: "pending",
      threadId: "thread-stay",
      messageId: ids.messageId("reply"),
    });
    expect(f.operation("op-pending")).toMatchObject({
      stage: "publishing",
      message_state: "pending",
    });
    f.relay("accept");
    expect(await f.run(write)).toEqual({
      ok: true,
      state: "saved",
      threadId: "thread-stay",
      messageId: ids.messageId("reply"),
    });
    expect(f.engine.writes).toHaveLength(1);
  });

  it("refuses with only the closed list's words: a relay refusal, an engine refusal, an answer that lost, other arguments, and a write long settled", async () => {
    const f = await fixture();
    const { planning } = await seed(f.chats);

    f.relay("refuse");
    expect(await f.run(reply("op-refused", "thread-stay"))).toEqual({
      ok: false,
      refusal: "refused",
      reason: "Couldn't send",
      threadId: "thread-stay",
    });
    f.relay("accept");

    // The engine's refusal of the first stage: nothing of the write can publish, and its words stay on the server.
    f.engine.failing.set(
      CHATS_METHOD.messageSend,
      new EngineRequestError(
        1,
        {
          code: "INVALID_PARAMS",
          message: "The engine could not open /srv/dohc/automations/trip/.dohc/engine/engine.db.",
          retry: "no",
        },
        CHATS_METHOD.messageSend,
      ),
    );
    const refusedByEngine = await f.run(reply("op-engine", "thread-stay"));
    expect(refusedByEngine).toEqual({ ok: false, refusal: "refused", reason: "Couldn't send" });
    expect(JSON.stringify(refusedByEngine)).not.toContain("/srv/");
    expect(f.operation("op-engine")).toMatchObject({ stage: "refused" });
    f.engine.failing.clear();

    // Another reply answered the poll first: this reply stays, and the answer names the winner.
    await f.chats.sendMessage({
      workspaceId: WORKSPACE,
      threadId: "thread-stay",
      messageId: "message-first",
      author: human,
      authorUserId: OWNER,
      authorActorKey: null,
      body: "Baixa",
    });
    await f.chats.resolveChatDecision({
      workspaceId: WORKSPACE,
      threadId: "thread-stay",
      messageId: "message-poll",
      resolvedByMessageId: "message-first",
      chosenOption: "Baixa",
      idempotencyKey: "seed-resolve",
    });
    expect(
      await f.run(
        reply("op-lost", "thread-stay", {
          resolves: { messageId: "message-poll", chosenOption: " Alfama " },
        }),
      ),
    ).toEqual({
      ok: false,
      refusal: "refused",
      reason: "already answered",
      threadId: "thread-stay",
      winnerMessageId: "message-first",
    });
    expect(f.operation("op-lost"), "the reply itself published").toMatchObject({
      message_state: "published",
    });

    const writes = f.engine.writes.length;
    expect(
      await f.run({
        operation: "post",
        args: { operationId: "op-lost", groupId: planning.channelId, body: "Other" },
      }),
      "other arguments",
    ).toEqual({ ok: false, refusal: "refused", reason: "Couldn't send" });
    f.storage.tombstoneSettledAccountOperations(OPERATION_KEEP_SETTLED_MS + 60_000);
    expect(await f.run(reply("op-refused", "thread-stay")), "a tombstone").toEqual({
      ok: false,
      refusal: "refused",
      reason: "too old",
    });
    expect(f.engine.writes).toHaveLength(writes);
  });

  it("refuses a hidden target before any row, exactly as a missing one, as reads answer", async () => {
    const f = await fixture();
    const { onSecret } = await seed(f.chats);
    const cases: Array<
      [
        label: string,
        hidden: PhoneWrite,
        hiddenId: string,
        absent: PhoneWrite,
        absentId: string,
        reason: (id: string) => string,
      ]
    > = [
      [
        "a reply with no parent",
        reply("op-1", onSecret.id),
        onSecret.id,
        reply("op-2", "thread-nowhere"),
        "thread-nowhere",
        (id) => `chat thread not found: ${id}`,
      ],
      [
        "a reply under a parent",
        reply("op-3", "thread-stay", { parentMessageId: "message-secret" }),
        "message-secret",
        reply("op-4", "thread-stay", { parentMessageId: "message-nowhere" }),
        "message-nowhere",
        (id) => `dohc: no such message in this thread: ${id}`,
      ],
      [
        "an answer",
        reply("op-5", onSecret.id, { resolves: { messageId: "message-secret" } }),
        onSecret.id,
        reply("op-6", "thread-nowhere", { resolves: { messageId: "message-secret" } }),
        "thread-nowhere",
        (id) => `chat thread not found: ${id}`,
      ],
      [
        "a reaction",
        react("op-7", "message-secret"),
        "message-secret",
        react("op-8", "message-nowhere"),
        "message-nowhere",
        (id) => `dohc: no such message in this thread: ${id}`,
      ],
    ];
    for (const [label, hidden, hiddenId, absent, absentId, reason] of cases) {
      const answered = await f.run(hidden);
      expect(answered, label).toEqual(missing(reason(hiddenId)));
      expect(shape(answered, hiddenId), label).toBe(shape(await f.run(absent), absentId));
    }
    // A Group no ID names answers as the read of one does.
    for (const write of [
      { operation: "post", args: { operationId: "op-9", groupId: "channel-nowhere", body: "Hi" } },
      {
        operation: "send",
        args: { operationId: "op-10", streamId: "channel-nowhere", body: "Hi" },
      },
    ] satisfies PhoneWrite[]) {
      expect(await f.run(write), write.operation).toEqual(
        missing("dohc: no such group: channel-nowhere"),
      );
    }
    expect(f.rows()).toBe(0);
    expect(f.engine.writes).toEqual([]);
  });

  it("refuses a new thread or message whose derived ID a hidden row already holds, as missing", async () => {
    const f = await fixture();
    const { planning, onSecret } = await seed(f.chats);
    const posted = phoneWriteIds(OWNER, WORKSPACE, "op-thread");
    await f.chats.request(
      CHATS_METHOD.threadCreate,
      {
        threadId: posted.threadId,
        title: "Keys",
        linkedFile: { objectId: "object-env", pathHint: ".env" },
      },
      { idempotencyKey: posted.threadId },
    );
    expect(
      await f.run({
        operation: "post",
        args: { operationId: "op-thread", groupId: planning.channelId, body: "Hi" },
      }),
    ).toEqual(missing(`chat thread not found: ${posted.threadId}`));
    const replied = phoneWriteIds(OWNER, WORKSPACE, "op-message");
    await f.chats.sendMessage({
      workspaceId: WORKSPACE,
      threadId: onSecret.id,
      messageId: replied.messageId("reply"),
      author: human,
      authorActorKey: null,
      body: "Taken",
    });
    expect(await f.run(reply("op-message", "thread-stay"))).toEqual(
      missing(`dohc: no such message in this thread: ${replied.messageId("reply")}`),
    );
    expect(f.rows()).toBe(0);
    expect(f.engine.writes).toEqual([]);
  });

  it("finishes an answer whose reply saved by resolving with that reply, and refuses it as missing once its thread is hidden", async () => {
    for (const hide of [false, true]) {
      const f = await fixture();
      await seed(f.chats);
      // A thread on a page, with an agent's question.
      const onPage = await f.chats.createThread({
        workspaceId: WORKSPACE,
        title: "Plan",
        linkedFile: { objectId: "object-plan", pathHint: "docs/plan.md" },
      });
      await f.chats.sendMessage({
        workspaceId: WORKSPACE,
        threadId: onPage.id,
        messageId: "message-q",
        author: { kind: "agent", displayName: "Nova" },
        authorOwnerDisplayName: "Ana",
        authorActorKey: null,
        body: "Ship it?",
        needsDecision: true,
      });
      const write = reply("op-answer", onPage.id, { resolves: { messageId: "message-q" } });
      const ids = phoneWriteIds(OWNER, WORKSPACE, "op-answer");
      // The resolve's answer is lost, so it isn't known to have happened.
      f.engine.failing.set(CHATS_METHOD.decisionResolve, new Error("the engine went away"));
      expect(await f.run(write)).toEqual({
        ok: true,
        state: "pending",
        threadId: onPage.id,
        messageId: ids.messageId("reply"),
      });
      expect(f.operation("op-answer")).toMatchObject({
        stage: "publishing",
        message_state: "published",
      });
      f.engine.failing.clear();
      // The relay last saw the page's file at a secret path.
      if (hide)
        f.raw
          .prepare(`INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, recorded_at_ms)
        VALUES (?, 'object-plan', 1, 'moment-1', 'main', '.env', 1)`)
          .run(WORKSPACE);

      const retried = await f.run(write);
      const resolves = f.engine.writes.filter(
        (request) => request.method === CHATS_METHOD.decisionResolve,
      );
      if (hide) {
        expect(retried).toEqual(missing("dohc: no such message in this thread: message-q"));
        expect(resolves).toEqual([]);
      } else {
        expect(retried).toEqual({
          ok: true,
          state: "saved",
          threadId: onPage.id,
          messageId: ids.messageId("reply"),
        });
        expect(resolves).toMatchObject([
          {
            idempotencyKey: ids.key("decision"),
            params: {
              threadId: onPage.id,
              messageId: "message-q",
              resolvedByMessageId: ids.messageId("reply"),
              stageReceipt: true,
            },
          },
        ]);
        expect(
          f.engine.writes.filter((request) => request.method === CHATS_METHOD.messageSend),
          "the reply is written once",
        ).toHaveLength(1);
      }
    }
  });

  it("replays a stage that never committed when the copy opens, from the stored author, while the account may still publish it", async () => {
    const f = await fixture();
    await seed(f.chats);
    const ids = phoneWriteIds(OWNER, WORKSPACE, "op-replay");
    // The send's answer is lost, so the stage never committed as far as anything knows.
    f.engine.failing.set(CHATS_METHOD.messageSend, new Error("the engine went away"));
    expect(await f.run(reply("op-replay", "thread-stay"))).toMatchObject({
      ok: true,
      state: "pending",
    });
    f.engine.failing.clear();
    const errors: unknown[] = [];
    const replay = async () =>
      await replayUnfinishedWrites({
        storage: f.storage,
        copy: f.copy,
        nowMs: () => 0,
        onError: (error) => errors.push(error),
        records: f.storage.listUnfinishedAccountOperations({
          workspaceId: WORKSPACE,
          incarnation: 1,
        }),
      });

    f.storage.setShowOnPhone({ ownerUserId: OWNER, workspaceId: WORKSPACE, showOnPhone: false });
    await replay();
    expect(f.engine.writes, "hidden from the phone, nothing replays").toEqual([]);
    f.storage.setShowOnPhone({ ownerUserId: OWNER, workspaceId: WORKSPACE, showOnPhone: true });

    await replay();
    expect(f.engine.writes).toMatchObject([
      {
        method: CHATS_METHOD.messageSend,
        idempotencyKey: ids.key("reply"),
        params: {
          threadId: "thread-stay",
          messageId: ids.messageId("reply"),
          authorDisplayName: "Ana",
          authorUserId: OWNER,
          stageReceipt: true,
        },
      },
    ]);
    await replay();
    expect(f.engine.writes, "a stage with a receipt doesn't replay").toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("saves a write whose stage committed though the engine then answered with an error", async () => {
    for (const failure of [
      new EngineRequestError(
        1,
        { code: "INTERNAL", message: "persist-failed", retry: "no" },
        CHATS_METHOD.threadStart,
      ),
      new EngineRequestError(
        1,
        { code: "INVALID_PARAMS", message: "invalid-input", retry: "no" },
        CHATS_METHOD.threadStart,
      ),
    ]) {
      const f = await fixture();
      const { planning } = await seed(f.chats);
      f.engine.failAfter.set(CHATS_METHOD.threadStart, failure);
      const ids = phoneWriteIds(OWNER, WORKSPACE, "op-committed");
      expect(
        await f.run({
          operation: "post",
          args: { operationId: "op-committed", groupId: planning.channelId, body: "Where?" },
        }),
        failure.message,
      ).toEqual({
        ok: true,
        state: "saved",
        threadId: ids.threadId,
        messageId: ids.messageId("post"),
      });
      expect(f.operation("op-committed")).toMatchObject({
        stage: "saved",
        message_state: "published",
      });
    }
  });

  it("keeps a write pending, not refused, when the engine fails a stage with an error that isn't a refusal of its content", async () => {
    const f = await fixture();
    await seed(f.chats);
    f.engine.failing.set(
      CHATS_METHOD.messageSend,
      new EngineRequestError(
        1,
        { code: "INTERNAL", message: "persist-failed", retry: "no" },
        CHATS_METHOD.messageSend,
      ),
    );
    expect(await f.run(reply("op-internal", "thread-stay"))).toMatchObject({
      ok: true,
      state: "pending",
    });
    expect(f.operation("op-internal")).toMatchObject({ stage: "publishing" });
  });

  it("answers a failed message read as not sent, not as a missing message, when finding a target and when checking a new ID", async () => {
    const f = await fixture();
    const { planning } = await seed(f.chats);
    f.engine.failing.set(
      CHATS_METHOD.messageGet,
      new EngineRequestError(
        1,
        { code: "INTERNAL", message: "state-corrupt", retry: "no" },
        CHATS_METHOD.messageGet,
      ),
    );
    const notSent = { ok: false, refusal: "refused", reason: "Couldn't send" };
    expect(await f.run(react("op-react", "message-stay")), "a reacted message").toEqual(notSent);
    expect(
      await f.run({
        operation: "post",
        args: { operationId: "op-post", groupId: planning.channelId, body: "Hi" },
      }),
      "a new message's ID",
    ).toEqual(notSent);
    expect(f.rows()).toBe(0);
    expect(f.engine.writes).toEqual([]);
  });

  it("answers a settled write, another write under its ID, and one long settled without its copy, and refuses a new one whose copy won't sync", async () => {
    const f = await fixture();
    const { planning } = await seed(f.chats);
    const post: PhoneWrite = {
      operation: "post",
      args: { operationId: "op-known", groupId: planning.channelId, body: "Where?" },
    };
    const saved = await f.run(post);
    expect(saved).toMatchObject({ ok: true, state: "saved" });
    f.failSync(new Error("The relay at https://relay.internal refused the push."));
    expect(await f.run(post), "a settled write").toEqual(saved);
    expect(
      await f.run({ ...post, args: { ...post.args, body: "Other" } }),
      "other arguments",
    ).toEqual({ ok: false, refusal: "refused", reason: "Couldn't send" });
    f.storage.tombstoneSettledAccountOperations(OPERATION_KEEP_SETTLED_MS + 60_000);
    expect(await f.run(post), "a tombstone").toEqual({
      ok: false,
      refusal: "refused",
      reason: "too old",
    });
    const unsynced = await f.run(reply("op-new", "thread-stay"));
    expect(unsynced, "a new write").toEqual({
      ok: false,
      refusal: "refused",
      reason: "Couldn't send",
    });
    expect(JSON.stringify(unsynced)).not.toContain("relay.internal");
    expect(f.engine.writes).toHaveLength(1);
    expect(f.operation("op-new")).toBeUndefined();
  });

  it("keeps a write's replay owed while a request holds it, and replays it once the request's own stage failed", async () => {
    const f = await fixture();
    await seed(f.chats);
    const write = reply("op-locked", "thread-stay");
    const ids = phoneWriteIds(OWNER, WORKSPACE, "op-locked");
    // The first attempt's send is lost.
    f.engine.failing.set(CHATS_METHOD.messageSend, new Error("the engine went away"));
    expect(await f.run(write)).toMatchObject({ ok: true, state: "pending" });
    const errors: unknown[] = [];
    const replay = async () =>
      await replayUnfinishedWrites({
        storage: f.storage,
        copy: f.copy,
        nowMs: () => 0,
        onError: (error) => errors.push(error),
        records: f.storage.listUnfinishedAccountOperations({
          workspaceId: WORKSPACE,
          incarnation: 1,
        }),
      });

    // The phone retries while the engine still fails, and the retry holds the write while its copy syncs.
    const held = f.holdSync();
    const retry = f.run(write);
    await held.reached;
    expect(await replay(), "a request holds it, so the replay stays owed").toBe(false);
    expect(f.engine.writes).toEqual([]);
    held.release();
    expect(await retry, "the retry's own stage failed").toMatchObject({
      ok: true,
      state: "pending",
    });

    f.engine.failing.clear();
    expect(await replay(), "a later pass replays it").toBe(true);
    expect(f.engine.writes).toMatchObject([
      { method: CHATS_METHOD.messageSend, idempotencyKey: ids.key("reply") },
    ]);
    expect(errors).toEqual([]);
  });

  it("refuses a message the shared rules refuse, and an operation ID outside its bounds, as bad requests, writing nothing", async () => {
    const f = await fixture();
    await seed(f.chats);
    expect(OPERATION_ID_MAX_LENGTH).toBe(128);
    for (const write of [
      {
        operation: "reply",
        args: { operationId: "op-empty", threadId: "thread-stay", body: " \n " },
      } satisfies PhoneWrite,
      reply("op-choice", "thread-stay", {
        resolves: { messageId: "message-poll", chosenOption: "Belém" },
      }),
      reply("x".repeat(129), "thread-stay"),
      reply("", "thread-stay"),
    ]) {
      await expect(f.run(write), JSON.stringify(write.args)).rejects.toMatchObject({
        code: "bad_request",
      });
    }
    expect(await f.run(reply("x".repeat(128), "thread-stay"))).toMatchObject({
      ok: true,
      state: "saved",
    });
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
    await expect(f.run(reply("op-gone", "thread-stay"))).rejects.toMatchObject({
      code: "not_found",
    });
    expect(f.rows()).toBe(0);
    expect(f.engine.writes).toEqual([]);
  });

  it("makes no row and no change when access ends while a target read waits", async () => {
    const cases: Array<[label: string, method: string, write: PhoneWrite]> = [
      ["a reply's thread", CHATS_METHOD.threadsList, reply("op-thread", "thread-stay")],
      ["a reply's thread, placed by its file", "files.resolve", reply("op-file", "thread-stay")],
      ["a reacted message", CHATS_METHOD.messageGet, react("op-message", "message-stay")],
    ];
    for (const [label, method, write] of cases) {
      const f = await fixture();
      await seed(f.chats);
      const held = f.engine.hold(method);
      const writing = f.run(write);
      await held.reached;
      f.authorize.mockImplementation(async () => {
        throw notFound();
      });
      held.release();
      await expect(writing, label).rejects.toMatchObject({ code: "not_found" });
      expect(f.rows(), label).toBe(0);
      expect(f.engine.writes, label).toEqual([]);
    }
  });

  it("starts no decision once access ends after an answer's reply, on the first attempt and on a retry's replay", async () => {
    const answer = reply("op-answer", "thread-stay", {
      resolves: { messageId: "message-poll", chosenOption: "Alfama" },
    });
    const resolves = (f: Awaited<ReturnType<typeof fixture>>) =>
      f.engine.asked.filter((method) => method === CHATS_METHOD.decisionResolve).length;

    // The first attempt: access ends while the reply is written, the last wait before the decision.
    const first = await fixture();
    await seed(first.chats);
    const sending = first.engine.hold(CHATS_METHOD.messageSend);
    const answering = first.run(answer);
    await sending.reached;
    first.authorize.mockImplementation(async () => {
      throw notFound();
    });
    sending.release();
    await expect(answering).rejects.toMatchObject({ code: "not_found" });
    expect(
      first.engine.writes.map((request) => request.method),
      "the reply exists",
    ).toEqual([CHATS_METHOD.messageSend]);
    expect(resolves(first)).toBe(0);

    // A retry: the reply saved and the decision's answer was lost; access ends while replay reads the question.
    const retry = await fixture();
    await seed(retry.chats);
    retry.engine.failing.set(CHATS_METHOD.decisionResolve, new Error("the engine went away"));
    expect(await retry.run(answer)).toMatchObject({ ok: true, state: "pending" });
    retry.engine.failing.clear();
    const reading = retry.engine.hold(CHATS_METHOD.messageGet);
    const retrying = retry.run(answer);
    await reading.reached;
    retry.authorize.mockImplementation(async () => {
      throw notFound();
    });
    reading.release();
    await expect(retrying).rejects.toMatchObject({ code: "not_found" });
    expect(resolves(retry), "only the first attempt's").toBe(1);
  });

  it("replays nothing once access ends while a replay's target read waits, from a retry or in the background", async () => {
    const replies = (f: Awaited<ReturnType<typeof fixture>>) =>
      f.engine.asked.filter((method) => method === CHATS_METHOD.messageSend).length;
    // A reply whose send's answer was lost, so its stage never committed as far as anything knows.
    const unsent = async () => {
      const f = await fixture();
      await seed(f.chats);
      f.engine.failing.set(CHATS_METHOD.messageSend, new Error("the engine went away"));
      expect(await f.run(reply("op-replay", "thread-stay"))).toMatchObject({
        ok: true,
        state: "pending",
      });
      f.engine.failing.clear();
      return f;
    };

    const retried = await unsent();
    const held = retried.engine.hold(CHATS_METHOD.threadsList);
    const retrying = retried.run(reply("op-replay", "thread-stay"));
    await held.reached;
    retried.authorize.mockImplementation(async () => {
      throw notFound();
    });
    held.release();
    await expect(retrying).rejects.toMatchObject({ code: "not_found" });
    expect(replies(retried), "only the lost send").toBe(1);

    const background = await unsent();
    const errors: unknown[] = [];
    const replay = () =>
      replayUnfinishedWrites({
        storage: background.storage,
        copy: background.copy,
        nowMs: () => 0,
        onError: (error) => errors.push(error),
        records: background.storage.listUnfinishedAccountOperations({
          workspaceId: WORKSPACE,
          incarnation: 1,
        }),
      });
    const reading = background.engine.hold(CHATS_METHOD.threadsList);
    const replaying = replay();
    await reading.reached;
    background.storage.setShowOnPhone({
      ownerUserId: OWNER,
      workspaceId: WORKSPACE,
      showOnPhone: false,
    });
    reading.release();
    await replaying;
    expect(replies(background), "only the lost send").toBe(1);
    background.storage.setShowOnPhone({
      ownerUserId: OWNER,
      workspaceId: WORKSPACE,
      showOnPhone: true,
    });
    expect(await replay()).toBe(true);
    expect(replies(background), "replayed once access is back").toBe(2);
    expect(errors).toEqual([]);
  });

  it("reads a visible thread's reactions and decisions through the reads' filter, and never a hidden thread's", async () => {
    const f = await fixture();
    const { onSecret } = await seed(f.chats);
    expect(await f.run(react("op-react", "message-stay"))).toMatchObject({
      ok: true,
      state: "saved",
    });
    const read = await readChat(serverChats(f.storage, f.copy, WORKSPACE), {
      threadId: "thread-stay",
    });
    if (!read.ok || !("thread" in read)) throw new Error("expected a thread");
    expect(read.messages.find((message) => message.id === "message-stay")?.reactions).toEqual([
      expect.objectContaining({
        emoji: "👍",
        authorId: OWNER,
        authorKind: "human",
        authorDisplayName: "Ana",
      }),
    ]);
    expect(read.messages.find((message) => message.id === "message-poll")).toMatchObject({
      needsDecision: true,
      decisionState: "open",
      options: ["Alfama", "Baixa"],
    });

    await f.chats.setReaction({
      workspaceId: WORKSPACE,
      threadId: onSecret.id,
      messageId: "message-secret",
      emoji: "🔑",
      author: { authorId: OWNER, kind: "human", displayName: "Ana" },
      state: "added",
    });
    f.engine.asked.length = 0;
    const hidden = serverChats(f.storage, f.copy, WORKSPACE).store;
    await expect(
      hidden.listReactions({ workspaceId: WORKSPACE, threadId: onSecret.id }),
    ).rejects.toThrow(`chat thread not found: ${onSecret.id}`);
    await expect(hidden.listThreadDecisions(WORKSPACE, onSecret.id)).rejects.toThrow(
      `chat thread not found: ${onSecret.id}`,
    );
    expect(f.engine.asked).not.toContain(CHATS_METHOD.reactionsList);
    expect(f.engine.asked).not.toContain(CHATS_METHOD.decisionsListForThread);
  });
});

describe("an answer whose decision the engine refused", () => {
  const answer = reply("op-answer", "thread-stay", {
    resolves: { messageId: "message-poll", chosenOption: "Alfama" },
  });
  const ids = phoneWriteIds(OWNER, WORKSPACE, "op-answer");
  const refusal = () =>
    new EngineRequestError(
      1,
      { code: "INVALID_PARAMS", message: "decision-not-found", retry: "no" },
      CHATS_METHOD.decisionResolve,
    );
  const refused = {
    ok: false,
    refusal: "refused",
    reason: "Couldn't send",
    threadId: "thread-stay",
  };
  const resolves = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.engine.asked.filter((method) => method === CHATS_METHOD.decisionResolve).length;

  it("stays pending until its reply is published, then settles refused, and never asks for that decision again", async () => {
    const f = await fixture();
    await seed(f.chats);
    const errors: unknown[] = [];
    const replay = () =>
      replayUnfinishedWrites({
        storage: f.storage,
        copy: f.copy,
        nowMs: () => 0,
        onError: (error) => errors.push(error),
        records: f.storage.listUnfinishedAccountOperations({
          workspaceId: WORKSPACE,
          incarnation: 1,
        }),
      });
    f.engine.failing.set(CHATS_METHOD.decisionResolve, refusal());
    f.relay("hold");
    expect(await f.run(answer), "the reply isn't published yet").toEqual({
      ok: true,
      state: "pending",
      threadId: "thread-stay",
      messageId: ids.messageId("reply"),
    });
    expect(f.operation("op-answer")).toMatchObject({
      stage: "publishing",
      message_state: "pending",
    });
    // Another write on the same copy, unpublished too.
    expect(await f.run(reply("op-other", "thread-stay"))).toMatchObject({
      ok: true,
      state: "pending",
    });
    expect(resolves(f)).toBe(1);

    // A background replay, then a retry, while the engine would take the decision now: neither asks for it.
    f.engine.failing.clear();
    expect(await replay()).toBe(true);
    expect(resolves(f)).toBe(1);
    f.relay("accept");
    expect(await f.run(answer), "settled once its reply is published").toEqual(refused);
    expect(f.operation("op-answer")).toMatchObject({
      stage: "refused",
      message_state: "published",
    });
    expect(await f.run(answer)).toEqual(refused);
    await replay();
    expect(resolves(f)).toBe(1);
    expect(errors).toEqual([]);

    // The other write is still unfinished, and saves.
    expect(
      f.storage
        .listUnfinishedAccountOperations({ workspaceId: WORKSPACE })
        .map((row) => row.operationId),
    ).toEqual(["op-other"]);
    expect(await f.run(reply("op-other", "thread-stay"))).toMatchObject({
      ok: true,
      state: "saved",
    });
  });

  it("settles refused when a retry's replayed decision is refused after the reply published", async () => {
    const f = await fixture();
    await seed(f.chats);
    f.engine.failing.set(CHATS_METHOD.decisionResolve, new Error("the engine went away"));
    expect(await f.run(answer)).toMatchObject({ ok: true, state: "pending" });
    expect(f.operation("op-answer")).toMatchObject({ message_state: "published" });
    f.engine.failing.set(CHATS_METHOD.decisionResolve, refusal());
    expect(await f.run(answer)).toEqual(refused);
    expect(f.operation("op-answer")).toMatchObject({
      stage: "refused",
      message_state: "published",
    });
    f.engine.failing.clear();
    expect(await f.run(answer)).toEqual(refused);
    expect(resolves(f), "the lost one and the refused one").toBe(2);
  });

  it("saves from its receipt when the decision committed though the engine then refused", async () => {
    const f = await fixture();
    await seed(f.chats);
    f.engine.failAfter.set(CHATS_METHOD.decisionResolve, refusal());
    expect(await f.run(answer)).toEqual({
      ok: true,
      state: "saved",
      threadId: "thread-stay",
      messageId: ids.messageId("reply"),
    });
    expect(resolves(f)).toBe(1);
  });

  it("stays pending, and asks again on a retry, after an internal error or a refusal whose receipt can't be read", async () => {
    const cases: Array<[label: string, failures: Array<[method: string, error: Error]>]> = [
      [
        "an internal error",
        [
          [
            CHATS_METHOD.decisionResolve,
            new EngineRequestError(
              1,
              { code: "INTERNAL", message: "persist-failed", retry: "no" },
              CHATS_METHOD.decisionResolve,
            ),
          ],
        ],
      ],
      [
        "an unreadable receipt",
        [
          [CHATS_METHOD.decisionResolve, refusal()],
          ["sync.ordinary.publicationState", new Error("the engine is busy")],
        ],
      ],
    ];
    for (const [label, failures] of cases) {
      const f = await fixture();
      await seed(f.chats);
      for (const [method, error] of failures) f.engine.failing.set(method, error);
      expect(await f.run(answer), label).toMatchObject({ ok: true, state: "pending" });
      expect(f.operation("op-answer"), label).toMatchObject({ stage: "publishing" });
      expect(JSON.parse(String(f.operation("op-answer")?.result_json)), label).not.toHaveProperty(
        "refusedStage",
      );
      f.engine.failing.clear();
      expect(await f.run(answer), label).toMatchObject({ ok: true, state: "saved" });
      expect(resolves(f), label).toBe(2);
    }
  });
});
