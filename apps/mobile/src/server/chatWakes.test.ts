import { describe, expect, it } from "vitest";
import {
  CHAT_WAKE_WAIT_MAX_MS,
  ChatWakeView,
  PhoneChatContext,
  PhoneChatWake,
  PhoneWakeChanges,
} from "@dohc/workspace-contracts/chat-wakes";
import {
  chatWakeView,
  earlierWakeCursor,
  phoneChatContext,
  phoneChatWake,
  phoneWakeChanges,
  readChatContext,
  readConversationWakes,
  readWakeChanges,
  retryWake,
  WAKE_HOLD_MS,
} from "./chatWakes";
import { createServerClient, ServerError } from "./client";
import { testServer } from "./testServer";

// The phone reads a conversation's wakes from the server's context, and the account's wake changes, each checked against
// the relay's contract before it keeps any of it. A thread's pages are followed to its first message.

const wake = (sequence: number, fields: Record<string, unknown> = {}) => ({
  wakeId: `wake-${String(sequence).padStart(32, "0")}`,
  messageId: "m-1",
  threadId: "thread-1",
  generation: 1,
  state: "waiting",
  winnerLabel: null,
  agentName: "Nova",
  canRetry: false,
  ...fields,
});

const stream = { kind: "stream", groupId: "g-1", groupKind: "group", canPost: true, canSend: true };
const thread = (nextBefore: number | null) => ({
  kind: "thread",
  threadId: "thread-1",
  groupKind: "group",
  nextBefore,
});
const context = (conversation: unknown, wakes: unknown[] = [], wakeCursor: unknown = "7") => ({
  ok: true,
  conversation,
  mentions: [],
  wakes,
  wakeCursor,
});
const answered = (result: unknown) => ({
  status: 200,
  body: { ok: true, result, cursor: "0.1.1" },
});

function serve() {
  const server = testServer();
  const client = createServerClient({
    origin: server.origin,
    token: "tok",
    fetch: server.fetch,
    signal: new AbortController().signal,
  });
  return { server, client };
}

const signal = new AbortController().signal;
const CONTEXT = "/sync/w1/ops/chatContext";

describe("readChatContext", () => {
  it("reads a stream's wakes, keeping each target of a message apart, a missing name included", async () => {
    const { server, client } = serve();
    const wakes = [
      wake(1),
      wake(2, { state: "claimed", winnerLabel: "Ice's Mac", agentName: null }),
      wake(3, { messageId: "m-2", threadId: "thread-2", state: "unclaimed", canRetry: true }),
    ];
    server.on("POST", CONTEXT, answered(context(stream, wakes)));
    const page = await readChatContext(client, "w1", { kind: "stream", groupId: "g-1" }, signal);
    expect(server.calls[0]?.body).toEqual({ group: "g-1" });
    expect(page).toEqual({ kind: "context", wakes, wakeCursor: "7", nextBefore: null });
  });

  it("answers a chat or thread the server doesn't have as missing", async () => {
    const { server, client } = serve();
    server.on("POST", CONTEXT, answered({ ok: false, refusal: "missing", reason: "gone" }));
    await expect(
      readChatContext(client, "w1", { kind: "thread", threadId: "thread-1" }, signal),
    ).resolves.toEqual({ kind: "missing" });
  });

  it("fails a read the server's copy couldn't do", async () => {
    const { server, client } = serve();
    server.on("POST", CONTEXT, answered({ ok: false, reason: "engine failed" }));
    await expect(
      readChatContext(client, "w1", { kind: "stream", groupId: "g-1" }, signal),
    ).rejects.toMatchObject({ problem: "refused" });
  });

  it.each([
    [
      "a wake with a field the contract doesn't name",
      context(stream, [wake(1, { installId: "x" })]),
    ],
    ["a seventh state", context(stream, [wake(1, { state: "running" })])],
    ["an empty name", context(stream, [wake(1, { agentName: "" })])],
    ["the feed's dotted cursor as the wake cursor", context(stream, [], "0.1.1")],
    ["another chat's context", context({ ...stream, groupId: "g-2" })],
    ["a thread's context for a stream", context(thread(null))],
  ])("rejects %s", async (_case, result) => {
    const { server, client } = serve();
    server.on("POST", CONTEXT, answered(result));
    const error = await readChatContext(
      client,
      "w1",
      { kind: "stream", groupId: "g-1" },
      signal,
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({ problem: "invalid" });
  });

  it("rejects a thread page with another thread's wake, and an older page that doesn't start earlier", async () => {
    const { server, client } = serve();
    const target = { kind: "thread", threadId: "thread-1" } as const;
    server.on(
      "POST",
      CONTEXT,
      answered(context(thread(null), [wake(1, { threadId: "thread-2" })])),
    );
    await expect(readChatContext(client, "w1", target, signal)).rejects.toMatchObject({
      problem: "invalid",
    });
    server.on("POST", CONTEXT, answered(context(thread(120))));
    await expect(readChatContext(client, "w1", target, signal, 120)).rejects.toMatchObject({
      problem: "invalid",
    });
  });
});

describe("readConversationWakes", () => {
  it("follows a thread's pages to its first message, and keeps the earliest page's cursor", async () => {
    const { server, client } = serve();
    server.on("POST", CONTEXT, (call) => {
      const before = (call.body as { before?: number }).before;
      if (before === undefined) return answered(context(thread(150), [wake(1)], "9"));
      if (before === 150)
        return answered(context(thread(50), [wake(2, { messageId: "m-0" })], "10"));
      return answered(context(thread(null), [wake(3, { messageId: "m-a" })], "11"));
    });
    const read = await readConversationWakes(
      client,
      "w1",
      { kind: "thread", threadId: "thread-1" },
      signal,
    );
    expect(server.calls.map((call) => call.body)).toEqual([
      { threadId: "thread-1" },
      { threadId: "thread-1", before: 150 },
      { threadId: "thread-1", before: 50 },
    ]);
    expect(read).toEqual({
      wakes: [wake(1), wake(2, { messageId: "m-0" }), wake(3, { messageId: "m-a" })],
      wakeCursor: "9",
    });
  });

  it("reads a stream once", async () => {
    const { server, client } = serve();
    server.on("POST", CONTEXT, answered(context(stream, [wake(1)], "4")));
    await expect(
      readConversationWakes(client, "w1", { kind: "stream", groupId: "g-1" }, signal),
    ).resolves.toEqual({ wakes: [wake(1)], wakeCursor: "4" });
    expect(server.calls).toHaveLength(1);
  });
});

describe("readWakeChanges", () => {
  const PATH = "/sync/w1/ops/wakeChanges?since=7&hold=25000";

  it("answers the threads that changed, none, or replace, each with its cursor", async () => {
    const { server, client } = serve();
    const options = { holdMs: 25_000, signal };
    server.on(
      "GET",
      PATH,
      { status: 200, body: { ok: true, cursor: "8", threads: ["thread-1"] } },
      { status: 200, body: { ok: true, cursor: "9", threads: [] } },
      { status: 200, body: { ok: true, cursor: "2", replace: true } },
    );
    await expect(readWakeChanges(client, "w1", "7", options)).resolves.toEqual({
      cursor: "8",
      replace: false,
      threads: ["thread-1"],
    });
    await expect(readWakeChanges(client, "w1", "7", options)).resolves.toEqual({
      cursor: "9",
      replace: false,
      threads: [],
    });
    await expect(readWakeChanges(client, "w1", "7", options)).resolves.toEqual({
      cursor: "2",
      replace: true,
    });
  });

  it("rejects an answer outside the contract", async () => {
    const { server, client } = serve();
    server.on("GET", PATH, { status: 200, body: { ok: true, cursor: "0.1.1", threads: [] } });
    await expect(
      readWakeChanges(client, "w1", "7", { holdMs: 25_000, signal }),
    ).rejects.toMatchObject({ problem: "invalid" });
  });
});

/** A generation as the retry route answers it. */
const view = (fields: Record<string, unknown> = {}) => ({
  wakeId: `wake-${"2".padStart(32, "0")}`,
  workspaceId: "w1",
  messageId: "m-1",
  threadId: "thread-1",
  generation: 2,
  state: "waiting",
  prerequisiteMessageId: null,
  winnerLabel: null,
  ...fields,
});

describe("retryWake", () => {
  const RETRY = "/sync/w1/ops/retryWake";
  const send = (client: ReturnType<typeof serve>["client"]) =>
    retryWake(client, "w1", "op-1", wake(1).wakeId, signal);

  it("sends only the operation ID and the wake, and answers the generation", async () => {
    const { server, client } = serve();
    server.on("POST", RETRY, answered({ ok: true, wake: view() }));
    await expect(send(client)).resolves.toEqual({ kind: "retried", wake: view() });
    expect(server.calls[0]?.body).toEqual({ operationId: "op-1", wakeId: wake(1).wakeId });
  });

  it("answers a refusal and a wake the server doesn't have", async () => {
    const { server, client } = serve();
    server.on(
      "POST",
      RETRY,
      answered({ ok: false, refusal: "refused", reason: "Couldn't send" }),
      answered({ ok: false, refusal: "refused", reason: "too old" }),
      answered({ ok: false, refusal: "missing", reason: "no such wake" }),
    );
    await expect(send(client)).resolves.toEqual({ kind: "refused" });
    await expect(send(client)).resolves.toEqual({ kind: "refused" });
    await expect(send(client)).resolves.toEqual({ kind: "missing" });
  });

  it("takes any cursor the route sends, and never keeps it", async () => {
    const { server, client } = serve();
    server.on("POST", RETRY, {
      status: 200,
      body: { ok: true, result: { ok: true, wake: view() }, cursor: "0.4.7" },
    });
    const answer = await send(client);
    expect(answer).toEqual({ kind: "retried", wake: view() });
    expect(JSON.stringify(answer)).not.toContain("0.4.7");
  });

  it.each([
    ["another workspace's generation", { ok: true, wake: view({ workspaceId: "w2" }) }],
    ["a generation with a field the contract doesn't name", { ok: true, wake: view({ x: 1 }) }],
    ["a phone wake in place of the generation", { ok: true, wake: wake(2) }],
    ["a refusal outside the closed list", { ok: false, refusal: "refused", reason: "nope" }],
    ["a missing wake without a reason", { ok: false, refusal: "missing" }],
    ["no result", undefined],
  ])("rejects %s", async (_case, result) => {
    const { server, client } = serve();
    server.on("POST", RETRY, answered(result));
    await expect(send(client)).rejects.toMatchObject({ problem: "invalid" });
  });

  it("rejects an answer without a cursor", async () => {
    const { server, client } = serve();
    server.on("POST", RETRY, {
      status: 200,
      body: { ok: true, result: { ok: true, wake: view() } },
    });
    await expect(send(client)).rejects.toMatchObject({ problem: "invalid" });
  });
});

describe("earlierWakeCursor", () => {
  it("compares decimal cursors by value", () => {
    expect(earlierWakeCursor("9", "10")).toBe("9");
    expect(earlierWakeCursor("12", "11")).toBe("11");
    expect(earlierWakeCursor("9007199254740993", "9007199254740992")).toBe("9007199254740992");
  });
});

// The phone checks these answers by hand, so the app doesn't carry zod. These hold the hand checks to the contract's.
describe("the hand checks agree with the contract", () => {
  it("holds a wake-changes request as long as the contract allows", () => {
    expect(WAKE_HOLD_MS).toBe(CHAT_WAKE_WAIT_MAX_MS);
  });

  const wakes: Record<string, unknown>[] = [
    wake(1),
    wake(2, { state: "claimed", winnerLabel: "Ice's Mac", agentName: null }),
    wake(3, { state: "unconfirmed", winnerLabel: "Ice's Mac", canRetry: true }),
    wake(4, { state: "sleeping" }),
    wake(5, { wakeId: "wake-1" }),
    wake(6, { generation: 0 }),
    wake(7, { generation: 1.5 }),
    wake(8, { agentName: "" }),
    wake(9, { agentName: "n".repeat(257) }),
    wake(10, { agentName: "n".repeat(256) }),
    wake(11, { winnerLabel: " Mac" }),
    wake(12, { winnerLabel: "m".repeat(65) }),
    wake(13, { messageId: "" }),
    wake(14, { canRetry: "yes" }),
    wake(15, { installId: "i-1" }),
    (({ agentName: _, ...rest }) => rest)(wake(16)),
  ];
  for (const [index, item] of wakes.entries())
    it(`agrees on wake ${index + 1}`, () => {
      expect(phoneChatWake(item) !== null).toBe(PhoneChatWake.safeParse(item).success);
    });

  const contexts: unknown[] = [
    context(stream, [wake(1)]),
    context(thread(4), [wake(1)]),
    context(thread(null)),
    context(thread(0)),
    context(stream, [], "01"),
    context(stream, [], 7),
    context({ kind: "file", id: "f" }),
    { ...context(stream), ok: false },
    { ...context(stream), mentions: undefined },
    context(stream, [wake(1, { state: "nope" })]),
  ];
  for (const [index, item] of contexts.entries())
    it(`agrees on context ${index + 1}`, () => {
      expect(phoneChatContext(item) !== null).toBe(PhoneChatContext.safeParse(item).success);
    });

  const changes: unknown[] = [
    { ok: true, cursor: "9", replace: true },
    { ok: true, cursor: "9", threads: [] },
    { ok: true, cursor: "9", threads: ["thread-1", "thread-2"] },
    { ok: true, cursor: "09", threads: [] },
    { ok: true, cursor: "9", threads: [""] },
    { ok: true, cursor: "9", replace: false },
    { ok: true, cursor: "9", replace: true, threads: [] },
    { ok: true, cursor: "9", threads: [], extra: 1 },
  ];
  for (const [index, item] of changes.entries())
    it(`agrees on wake changes ${index + 1}`, () => {
      expect(phoneWakeChanges(item) !== null).toBe(PhoneWakeChanges.safeParse(item).success);
    });

  // A Try again answers its generation as the account's computers see it.
  const views: unknown[] = [
    view(),
    view({ state: "unconfirmed", winnerLabel: "Ice's Mac", prerequisiteMessageId: "q-1" }),
    view({ generation: Number.MAX_SAFE_INTEGER }),
    view({ generation: 0 }),
    view({ wakeId: "wake-2" }),
    view({ workspaceId: "" }),
    view({ state: "running" }),
    view({ prerequisiteMessageId: " q-1" }),
    view({ winnerLabel: "m".repeat(65) }),
    view({ canRetry: true }),
    (({ prerequisiteMessageId: _, ...rest }) => rest)(view()),
    wake(1),
  ];
  for (const [index, item] of views.entries())
    it(`agrees on retried generation ${index + 1}`, () => {
      expect(chatWakeView(item) !== null).toBe(ChatWakeView.safeParse(item).success);
    });
});
