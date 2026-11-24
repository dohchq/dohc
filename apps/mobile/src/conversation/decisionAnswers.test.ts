import { describe, expect, it, vi } from "vitest";
import type { AccountState, SignIn } from "../server/account";
import type { ChatWrite } from "../server/chatWrites";
import { createServerClient } from "../server/client";
import { createOutbox, OutboxError, type Outbox, type OutboxState } from "../server/outbox";
import { phoneWrites } from "../server/phoneWrites";
import { keptDisk } from "../server/testKeptDisk";
import { testServer, type Answer } from "../server/testServer";
import {
  createConversationWrites,
  replyWrite,
  type OutboxRecord,
  type WriteOutbox,
} from "./conversationWrites";
import {
  answerPlace,
  answerRecords,
  answerTarget,
  answerWrite,
  decisionOf,
  type Asked,
  type Shown,
} from "./decisionAnswers";
import { streamRows } from "./outboxMessages";

type Server = ReturnType<typeof testServer>;

const ORIGIN = "https://dohc.example.com";
const SCOPE = { origin: ORIGIN, accountId: "u-1", workspaceId: "ws-1" } as const;
const READY: OutboxState = {
  status: "ready",
  records: [],
  unreadable: [],
  deletion: "none",
  unconfirmed: [],
};
const ops = (result: unknown): Answer => ({
  status: 200,
  body: { ok: true, result, cursor: "0.1.1" },
});

const question = (fields: Partial<Asked> = {}): Asked => ({
  id: "q-1",
  threadId: "thread-lane",
  parentMessageId: null,
  decisionState: "open",
  options: [],
  chosenOption: null,
  resolvedByMessageId: null,
  ...fields,
});
const poll = (fields: Partial<Asked> = {}) => question({ options: ["Lisbon", "Porto"], ...fields });

/** This phone's answer to `q-1`, as the outbox keeps it. */
function answer(fields: Partial<OutboxRecord> = {}, option?: string): OutboxRecord {
  return {
    ...SCOPE,
    operationId: "op-1",
    messageId: "message-mine",
    sequence: 1,
    dependsOn: null,
    target: { kind: "thread", id: "thread-lane" },
    write: {
      operation: "reply",
      args: {
        threadId: "thread-lane",
        body: option ?? "Mine",
        resolves: { messageId: "q-1", ...(option === undefined ? {} : { chosenOption: option }) },
      },
    },
    stage: "queued",
    attempted: false,
    withheld: false,
    pendingSinceMs: null,
    result: null,
    ...fields,
  };
}

const lostTo = (winnerMessageId: string | null): Partial<OutboxRecord> => ({
  stage: "refused",
  attempted: true,
  result: { kind: "refused", reason: "already answered", threadId: "thread-lane", winnerMessageId },
});

const showing =
  (messages: Record<string, { authorName: string; body: string }>): Shown =>
  (id) =>
    messages[id];

/** An outbox that keeps what it's asked to enqueue, and answers as each test says. */
function fakeOutbox(state: OutboxState = READY, enqueue?: WriteOutbox["enqueue"]) {
  const asked: ChatWrite[] = [];
  const outbox: WriteOutbox = {
    state: () => state,
    subscribe: () => () => undefined,
    enqueue: (input) => {
      asked.push(input.write);
      return enqueue ? enqueue(input) : Promise.resolve(answer());
    },
    retryEnqueue: () => Promise.reject(new OutboxError("invalid")),
    discard: () => Promise.resolve(),
    wake: () => undefined,
  };
  return { outbox, asked };
}

/** The real outbox over a fresh disk, signed in to `server`, with retry waits that never end on their own. */
function launch(server: Server, disk = keptDisk()): Outbox {
  const outbox = createOutbox({
    store: disk.launch(),
    sleep: (_ms, signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cut")))),
  });
  const signIn: SignIn = {
    origin: server.origin,
    userId: "u-1",
    email: "u-1@example.com",
    name: "Ice",
    isCurrent: () => true,
    client: createServerClient({
      origin: server.origin,
      token: "tok-1",
      fetch: server.fetch,
      signal: new AbortController().signal,
      onSignedOut: () => undefined,
    }),
  };
  const state: AccountState = { status: "signed-in", signIn };
  outbox.follow({ state: () => state, subscribe: () => () => undefined });
  return outbox;
}

const replies = (server: Server) =>
  server.calls.filter((call) => call.path === "/sync/ws-1/ops/reply").map((call) => call.body);

describe("where an answer goes", () => {
  it("puts a free answer under the first message of the question's chain, as the desktop's lane does", () => {
    const parents = new Map<string, string | null>([
      ["root", null],
      ["middle", "root"],
    ]);
    const nested = question({ parentMessageId: "middle" });
    expect(answerPlace(nested, (id) => parents.get(id), { post: false, poll: false })).toEqual({
      threadId: "thread-lane",
      parentMessageId: "root",
    });
    // A question at the top of the conversation takes its answer under itself.
    expect(answerPlace(question(), () => undefined, { post: false, poll: false })).toEqual({
      threadId: "thread-lane",
      parentMessageId: "q-1",
    });
    // A parent the read doesn't show ends the chain at the question.
    expect(
      answerPlace(question({ parentMessageId: "unread" }), () => undefined, {
        post: false,
        poll: false,
      }),
    ).toEqual({ threadId: "thread-lane", parentMessageId: "q-1" });
  });

  it("puts a poll's choice beside the poll, under the poll's own parent", () => {
    expect(answerPlace(poll(), () => undefined, { post: false, poll: true })).toEqual({
      threadId: "thread-lane",
      parentMessageId: null,
    });
    expect(
      answerPlace(poll({ parentMessageId: "root" }), () => null, { post: false, poll: true }),
    ).toEqual({ threadId: "thread-lane", parentMessageId: "root" });
  });

  it("puts a post's answer at the top of the post's own thread", () => {
    const asked = question({ threadId: "thread-post", parentMessageId: "root" });
    for (const isPoll of [true, false])
      expect(answerPlace(asked, () => null, { post: true, poll: isPoll })).toEqual({
        threadId: "thread-post",
        parentMessageId: null,
      });
  });
});

describe("an answer's write", () => {
  it("is a reply that resolves the question, for a free answer", () => {
    expect(
      answerWrite({ threadId: "thread-lane", parentMessageId: "q-1" }, "q-1", "Call it Lisbon"),
    ).toEqual({
      operation: "reply",
      args: {
        threadId: "thread-lane",
        body: "Call it Lisbon",
        parentMessageId: "q-1",
        resolves: { messageId: "q-1" },
      },
    });
    expect(answerWrite({ threadId: "thread-lane", parentMessageId: null }, "q-1", "  ")).toBeNull();
  });

  it("sends a poll's choice as its body, and names the choice", () => {
    expect(
      answerWrite({ threadId: "thread-lane", parentMessageId: null }, "q-1", "Porto", "Porto"),
    ).toEqual({
      operation: "reply",
      args: {
        threadId: "thread-lane",
        body: "Porto",
        resolves: { messageId: "q-1", chosenOption: "Porto" },
      },
    });
  });

  it("is never what an ordinary reply makes", () => {
    for (const parentMessageId of [null, "q-1"])
      expect(
        replyWrite({ kind: "thread", threadId: "thread-lane", parentMessageId }, "Hi")?.write.args,
      ).not.toHaveProperty("resolves");
    expect(
      replyWrite({ kind: "outbox", operationId: "op-p", messageId: "message-p" }, "Hi")?.write.args,
    ).not.toHaveProperty("resolves");
  });

  it("reaches the server through the outbox, with its resolves", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-1/ops/reply", ops({ ok: true, state: "saved", threadId: "t" }));
    const outbox = launch(server);
    await vi.waitFor(() => expect(outbox.state().status).toBe("ready"));
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    const write = answerWrite(
      { threadId: "thread-lane", parentMessageId: null },
      "q-1",
      "Porto",
      "Porto",
    );
    expect(write && (await writes.submit("ws-1", write))).toEqual({ kind: "kept" });
    await vi.waitFor(() => expect(replies(server)).toHaveLength(1));
    expect(replies(server)[0]).toMatchObject({
      threadId: "thread-lane",
      body: "Porto",
      resolves: { messageId: "q-1", chosenOption: "Porto" },
    });
  });
});

describe("a decision's card", () => {
  it("shows nothing for a message that asks nothing", () => {
    expect(decisionOf(question({ decisionState: null }))).toBeNull();
  });

  it("takes an answer while open", () => {
    expect(decisionOf(poll())).toEqual({ options: ["Lisbon", "Porto"], state: { kind: "open" } });
  });

  it("offers no answer once resolved, and marks the server's choice", () => {
    expect(
      decisionOf(
        poll({ decisionState: "resolved", chosenOption: "Porto", resolvedByMessageId: "m-9" }),
      ),
    ).toEqual({ options: ["Lisbon", "Porto"], state: { kind: "answered", chosen: "Porto" } });
  });

  it("keeps a choice pending until the outbox saves it, then shows it answered", () => {
    for (const stage of ["queued", "sending", "stalled"] as const)
      expect(decisionOf(poll(), [answer({ stage }, "Porto")])?.state).toEqual({
        kind: "answering",
        chosen: "Porto",
      });
    const saved = answer(
      {
        stage: "saved",
        result: { kind: "saved", threadId: "thread-lane", messageId: "message-mine" },
      },
      "Porto",
    );
    expect(decisionOf(poll(), [saved])?.state).toEqual({ kind: "answered", chosen: "Porto" });
  });

  it("keeps this phone's unfinished answer pending when a read shows the question answered", () => {
    const resolved = poll({
      decisionState: "resolved",
      chosenOption: "Lisbon",
      resolvedByMessageId: "m-9",
    });
    for (const stage of ["queued", "sending", "stalled"] as const)
      expect(decisionOf(resolved, [answer({ stage }, "Porto")])?.state).toEqual({
        kind: "answering",
        chosen: "Porto",
      });
  });

  it("lets the server's state win once this phone's answer settles", () => {
    const resolved = poll({
      decisionState: "resolved",
      chosenOption: "Lisbon",
      resolvedByMessageId: "m-9",
    });
    const saved = answer(
      {
        stage: "saved",
        result: { kind: "saved", threadId: "thread-lane", messageId: "message-mine" },
      },
      "Porto",
    );
    expect(decisionOf(resolved, [saved])?.state).toEqual({ kind: "answered", chosen: "Lisbon" });
    // A withheld answer isn't on its way, so the server's state wins over it too.
    expect(decisionOf(resolved, [answer({ withheld: true }, "Porto")])?.state).toEqual({
      kind: "answered",
      chosen: "Lisbon",
    });
  });

  it("holds a withheld answer, so the question takes no other until Send or Discard", () => {
    expect(decisionOf(question(), [answer({ withheld: true })])?.state).toEqual({ kind: "held" });
    // Send again: the same record, sendable, is on its way.
    expect(decisionOf(question(), [answer()])?.state).toEqual({ kind: "answering", chosen: null });
  });

  it("takes an answer again after one the server refused for another reason", () => {
    const refused = answer({
      stage: "refused",
      attempted: true,
      result: { kind: "refused", reason: "Couldn't send", threadId: null, winnerMessageId: null },
    });
    expect(decisionOf(question(), [refused])?.state).toEqual({ kind: "open" });
    expect(
      decisionOf(question(), [
        answer({ stage: "refused", result: { kind: "missing", reason: "gone" } }),
      ])?.state,
    ).toEqual({ kind: "open" });
  });

  it("names the competing winner the server chose, when the read shows it", () => {
    const resolved = poll({
      decisionState: "resolved",
      chosenOption: "Lisbon",
      resolvedByMessageId: "m-9",
    });
    const shown = showing({ "m-9": { authorName: "Sam Ortiz", body: "Lisbon" } });
    expect(decisionOf(resolved, [answer(lostTo("m-9"), "Porto")], shown)?.state).toEqual({
      kind: "lost",
      chosen: "Lisbon",
      winner: { name: "Sam Ortiz", body: "Lisbon" },
      replySent: false,
    });
  });

  it("names nobody when the winning answer isn't loaded", () => {
    expect(decisionOf(question(), [answer(lostTo("m-9"))])?.state).toEqual({
      kind: "lost",
      chosen: null,
      winner: null,
      replySent: false,
    });
    expect(decisionOf(question(), [answer(lostTo(null))])?.state).toMatchObject({ winner: null });
  });

  it("says the reply was sent only once a read shows it", () => {
    const shown = showing({ "message-mine": { authorName: "You", body: "Mine" } });
    expect(decisionOf(question(), [answer(lostTo("m-9"))], shown)?.state).toMatchObject({
      kind: "lost",
      winner: null,
      replySent: true,
    });
  });

  it("reads only the account's own answers in its workspace", () => {
    const state: OutboxState = {
      ...READY,
      records: [
        answer({ operationId: "op-own" }),
        answer({ operationId: "op-other", accountId: "u-2" }),
        answer({ operationId: "op-elsewhere", workspaceId: "ws-2" }),
        {
          ...answer({ operationId: "op-plain" }),
          write: { operation: "reply", args: { threadId: "thread-lane", body: "Plain" } },
        },
      ],
    };
    const byQuestion = answerRecords(state, SCOPE);
    expect(byQuestion.get("q-1")?.map((record) => record.operationId)).toEqual(["op-own"]);
  });
});

describe("an answer in a stream", () => {
  it("shows under the stream, saved or not, until a read shows its reply", () => {
    const waiting = answer({ operationId: "op-wait", messageId: "message-wait" });
    const saved = answer({
      operationId: "op-saved",
      messageId: "message-saved",
      stage: "saved",
      result: { kind: "saved", threadId: "thread-lane", messageId: "message-saved" },
    });
    const state: OutboxState = { ...READY, records: [waiting, saved] };
    const rows = streamRows(state, SCOPE, "group-1", new Set(), new Set(["q-1"]));
    expect(rows.map((row) => row.messageId)).toEqual(["message-wait", "message-saved"]);
    expect(rows[1]?.mark.state).toEqual({ kind: "saved" });
    // A read that shows the reply takes its row, before the outbox hands the record off.
    expect(
      streamRows(state, SCOPE, "group-1", new Set(["message-saved"]), new Set(["q-1"])).map(
        (row) => row.messageId,
      ),
    ).toEqual(["message-wait"]);
    expect(streamRows(state, SCOPE, "group-1", new Set())).toEqual([]);
  });
});

describe("a composer answering a question", () => {
  const top = () => undefined;

  it("answers an open question at its place", () => {
    expect(answerTarget(question(), [], top, false)).toEqual({
      kind: "answer",
      place: { threadId: "thread-lane", parentMessageId: "q-1" },
    });
    expect(answerTarget(question(), [], top, true)).toEqual({
      kind: "answer",
      place: { threadId: "thread-lane", parentMessageId: null },
    });
  });

  it("closes, never falling back to a reply, once a read shows the question answered or gone", () => {
    const resolved = question({ decisionState: "resolved", resolvedByMessageId: "m-9" });
    for (const post of [false, true, null]) {
      expect(answerTarget(resolved, [], top, post)).toEqual({ kind: "closed" });
      expect(answerTarget(undefined, [], top, post)).toEqual({ kind: "closed" });
    }
    // This phone's own answer is on its way, or withheld: the question takes no other.
    expect(answerTarget(question(), [answer()], top, false)).toEqual({ kind: "closed" });
    expect(answerTarget(question(), [answer({ withheld: true })], top, false)).toEqual({
      kind: "closed",
    });
    // A poll takes a choice, never a free answer.
    expect(answerTarget(poll(), [], top, false)).toEqual({ kind: "closed" });
  });

  it("waits while it isn't known whether the thread is a post's", () => {
    expect(answerTarget(question(), [], top, null)).toEqual({ kind: "waiting" });
  });
});

describe("answers that wait", () => {
  const write = answerWrite(
    { threadId: "thread-lane", parentMessageId: null },
    "q-1",
    "Porto",
    "Porto",
  );
  if (write === null) throw new Error("The answer should have a write");

  it("reach no outbox call while phone writes are off", async () => {
    const { outbox, asked } = fakeOutbox();
    const writes = createConversationWrites({
      outbox,
      enabled: phoneWrites,
      isCurrent: () => true,
    });
    expect(await writes.submit("ws-1", write)).toEqual({ kind: "blocked" });
    expect(asked).toEqual([]);
  });

  it("reach no outbox call while a Sign out's delete has failed", async () => {
    const { outbox, asked } = fakeOutbox({ ...READY, deletion: "failed" });
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    expect(await writes.submit("ws-1", write)).toEqual({ kind: "blocked" });
    expect(asked).toEqual([]);
  });

  it("go to the outbox as the one write the card made", async () => {
    const { outbox, asked } = fakeOutbox();
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    expect(await writes.submit("ws-1", write)).toEqual({ kind: "kept" });
    expect(asked).toEqual([write]);
  });

  it("stay withheld under their own operation, which Send sends again with its resolves", async () => {
    const { outbox } = fakeOutbox(READY, () =>
      Promise.reject(new OutboxError("indeterminate", "op-7")),
    );
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    expect(await writes.submit("ws-1", write)).toEqual({ kind: "withheld", operationId: "op-7" });

    const disk = keptDisk();
    disk.sql(
      "INSERT INTO outbox (origin, account_id, record) VALUES (?, 'u-1', ?)",
      ORIGIN,
      JSON.stringify({
        format: 1,
        ...SCOPE,
        operationId: "op-7",
        messageId: "message-7",
        dependsOn: null,
        target: { kind: "thread", id: "thread-lane" },
        write,
        stage: "queued",
        attempted: false,
        withheld: true,
        pendingSinceMs: null,
        result: null,
      }),
    );
    const server = testServer();
    server.on("POST", "/sync/ws-1/ops/reply", ops({ ok: true, state: "saved", threadId: "t" }));
    const real = launch(server, disk);
    await vi.waitFor(() => expect(real.state().status).toBe("ready"));
    expect(decisionOf(poll(), answerRecords(real.state(), SCOPE).get("q-1"))?.state).toEqual({
      kind: "held",
    });
    const retried = createConversationWrites({
      outbox: real,
      enabled: true,
      isCurrent: () => true,
    });
    expect(await retried.retry("op-7")).toEqual({ kind: "kept" });
    await vi.waitFor(() => expect(replies(server)).toHaveLength(1));
    expect(replies(server)).toEqual([
      {
        operationId: "op-7",
        threadId: "thread-lane",
        body: "Porto",
        resolves: { messageId: "q-1", chosenOption: "Porto" },
      },
    ]);
  });
});
