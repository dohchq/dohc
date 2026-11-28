import { describe, expect, it } from "vitest";
import { createServerClient } from "./client";
import { testServer } from "./testServer";
import {
  earlierCursor,
  isCursor,
  laterCursor,
  markThreadRead,
  readChats,
  readFileChats,
  readStream,
  readStreamLanes,
  readThread,
} from "./workspaceReads";

// The phone's chat reads keep what later controls need: a reply's parent, attachments, a question or poll with its
// answer, reactions, and the account's unread counts and read place, each checked before it is kept. A field that fails
// a check fails the whole read.

const answered = (result: unknown) => ({
  status: 200,
  body: { ok: true, result, cursor: "0.1.1" },
});

const raw = (more: Record<string, unknown> = {}) => ({
  id: "message-2",
  threadId: "thread-1",
  authorKind: "human",
  authorDisplayName: "Maya Chen",
  body: "Alfama",
  createdAtMs: 5,
  attachments: [],
  needsDecision: false,
  ...more,
});

const poll = raw({
  id: "message-1",
  authorKind: "agent",
  authorDisplayName: "Nova",
  body: "Alfama or Baixa?",
  needsDecision: true,
  decisionState: "resolved",
  options: ["Alfama", "Baixa"],
  optionDetails: ["Closer to the river", null],
  chosenOption: "Alfama",
  resolvedByMessageId: "message-2",
  attachments: [
    { objectId: "object-plan", pathHint: "docs/plan.md" },
    { pathHint: "docs/gone.md" },
  ],
  reactions: [
    {
      emoji: "👍",
      authorId: "user-maya",
      authorKind: "human",
      authorDisplayName: "Maya Chen",
      atMs: 7,
    },
  ],
});
const answer = raw({ parentMessageId: "message-1" });

const kept = {
  poll: {
    id: "message-1",
    threadId: "thread-1",
    authorKind: "agent",
    authorName: "Nova",
    body: "Alfama or Baixa?",
    createdAtMs: 5,
    parentMessageId: null,
    needsDecision: true,
    decisionState: "resolved",
    options: ["Alfama", "Baixa"],
    optionDetails: ["Closer to the river", null],
    chosenOption: "Alfama",
    resolvedByMessageId: "message-2",
    attachments: [
      { objectId: "object-plan", pathHint: "docs/plan.md" },
      { objectId: null, pathHint: "docs/gone.md" },
    ],
    reactions: [
      { emoji: "👍", authorId: "user-maya", authorKind: "human", authorName: "Maya Chen", atMs: 7 },
    ],
  },
  answer: {
    id: "message-2",
    threadId: "thread-1",
    authorKind: "human",
    authorName: "Maya Chen",
    body: "Alfama",
    createdAtMs: 5,
    parentMessageId: "message-1",
    needsDecision: false,
    decisionState: null,
    options: [],
    optionDetails: [],
    chosenOption: null,
    resolvedByMessageId: null,
    attachments: [],
    reactions: [],
  },
};

function serve(result: unknown) {
  const server = testServer();
  server.on("POST", "/sync/ws-a/ops/chat", answered(result));
  const client = createServerClient({
    origin: server.origin,
    token: "tok",
    fetch: server.fetch,
    signal: new AbortController().signal,
  });
  return client;
}

const thread = (...messages: unknown[]) => ({
  ok: true,
  thread: { id: "thread-1", title: "Stay", createdAtMs: 1, updatedAtMs: 1 },
  dispatch: { paused: null, lastRun: null },
  messages,
  projection: { path: "p", readOnly: true, text: "" },
});
const stream = (...messages: unknown[]) => ({
  ok: true,
  stream: {
    group: { id: "channel-1", name: "Trip", kind: "group" },
    items: messages.map((message, index) => ({
      position: { createdAtMs: 5, lane: "chat", id: `message-${index}` },
      message,
    })),
    nextBefore: null,
    readPosition: null,
  },
});

describe("a chat read's messages", () => {
  it("keep a thread's parents, attachments, decisions and reactions", async () => {
    const read = await readThread(
      serve(thread(poll, answer)),
      "ws-a",
      "thread-1",
      new AbortController().signal,
    );
    expect(read.value).toEqual({
      kind: "thread",
      id: "thread-1",
      title: "Stay",
      messages: [kept.poll, kept.answer],
    });
  });

  it("keep the same in a stream's items", async () => {
    const read = await readStream(
      serve(stream(poll, answer)),
      "ws-a",
      "channel-1",
      new AbortController().signal,
    );
    expect(read.value).toMatchObject({
      kind: "stream",
      items: [{ message: kept.poll }, { message: kept.answer }],
    });
  });

  it("fail the whole read when any message's new fields don't check", async () => {
    const broken: Array<[label: string, message: unknown]> = [
      ["a parent that isn't an ID", raw({ parentMessageId: 7 })],
      ["no attachments", raw({ attachments: undefined })],
      ["an attachment that isn't an object", raw({ attachments: ["docs/plan.md"] })],
      ["no needsDecision", raw({ needsDecision: undefined })],
      ["a decision state on a message that asks none", raw({ decisionState: "open" })],
      ["a question with no state", raw({ needsDecision: true })],
      ["an unknown state", raw({ needsDecision: true, decisionState: "closed" })],
      [
        "an empty choice",
        raw({ needsDecision: true, decisionState: "open", options: ["Alfama", ""] }),
      ],
      [
        "an explanation for only some choices",
        raw({
          needsDecision: true,
          decisionState: "open",
          options: ["Alfama", "Baixa"],
          optionDetails: ["Closer"],
        }),
      ],
      [
        "a chosen option that isn't text",
        raw({ needsDecision: true, decisionState: "resolved", chosenOption: 1 }),
      ],
      [
        "a winning reply that isn't an ID",
        raw({ needsDecision: true, decisionState: "resolved", resolvedByMessageId: "" }),
      ],
      ["reactions that aren't a list", raw({ reactions: {} })],
      [
        "a reaction by an automation",
        raw({
          reactions: [
            {
              emoji: "👍",
              authorId: "a",
              authorKind: "automation",
              authorDisplayName: "Bot",
              atMs: 1,
            },
          ],
        }),
      ],
      [
        "a reaction with no time",
        raw({
          reactions: [
            { emoji: "👍", authorId: "a", authorKind: "human", authorDisplayName: "Maya" },
          ],
        }),
      ],
    ];
    for (const [label, message] of broken) {
      await expect(
        readThread(serve(thread(poll, message)), "ws-a", "thread-1", new AbortController().signal),
        label,
      ).rejects.toMatchObject({ problem: "invalid" });
      await expect(
        readStream(serve(stream(poll, message)), "ws-a", "channel-1", new AbortController().signal),
        label,
      ).rejects.toMatchObject({ problem: "invalid" });
    }
  });
});

describe("the account's unread state", () => {
  const signal = new AbortController().signal;
  const listed = (...threads: unknown[]) => ({
    ok: true,
    groups: [
      {
        id: "channel-1",
        name: "Trip",
        slug: "trip",
        kind: "group",
        threadCount: threads.length,
        threads,
      },
    ],
  });
  const listedThread = (id: string, unreadCount: unknown) => ({
    id,
    title: "",
    messageCount: 3,
    unreadCount,
    updatedAtMs: 1,
  });
  function serveOps(name: string, result: unknown) {
    const server = testServer();
    server.on("POST", `/sync/ws-a/ops/${name}`, answered(result));
    return {
      server,
      client: createServerClient({
        origin: server.origin,
        token: "tok",
        fetch: server.fetch,
        signal,
      }),
    };
  }

  it("keeps each chat's unread messages across its threads", async () => {
    const { client } = serveOps(
      "groupsFull",
      listed(listedThread("thread-1", 2), listedThread("thread-2", 0), listedThread("thread-3", 1)),
    );
    expect((await readChats(client, "ws-a", signal)).value).toEqual([
      {
        id: "channel-1",
        name: "Trip",
        kind: "group",
        threadIds: ["thread-1", "thread-2", "thread-3"],
        unreadCount: 3,
        unreadThreadIds: ["thread-1", "thread-3"],
      },
    ]);
  });

  it("keeps which threads are posts, by the lane each names", async () => {
    const { client } = serveOps(
      "groupsFull",
      listed(
        { ...listedThread("thread-1", 0), lane: "posts" },
        { ...listedThread("thread-2", 0), lane: "chat" },
        listedThread("thread-3", 0),
      ),
    );
    expect((await readChats(client, "ws-a", signal)).value).toMatchObject([
      { threadIds: ["thread-1", "thread-2", "thread-3"], postThreadIds: ["thread-1"] },
    ]);
    const bad = serveOps("groupsFull", listed({ ...listedThread("thread-1", 0), lane: "feed" }));
    await expect(readChats(bad.client, "ws-a", signal)).rejects.toMatchObject({
      problem: "invalid",
    });
  });

  it("keeps an agent's chat the server archived, and says whose the default one was", async () => {
    const agent = (id: string, name: string, channelWireId: string, archived?: boolean) => ({
      id,
      channelWireId,
      name,
      slug: id,
      kind: "agent",
      threadCount: 0,
      threads: [],
      ...(archived === undefined ? {} : { archived }),
    });
    const { client } = serveOps("groupsFull", {
      ok: true,
      groups: [
        agent("channel-agent-default", "My agent", "channel_wire_agent_v1", true),
        agent("channel-agent-old", "Old one", "channel_wire_agent_v1_old", true),
        agent("channel-agent-t3", "Nova", "channel_wire_agent_v1_t3"),
      ],
    });
    expect(
      (await readChats(client, "ws-a", signal)).value.map(({ name, archived }) => ({
        name,
        archived,
      })),
    ).toEqual([
      { name: "Your agent", archived: true },
      { name: "Old one", archived: true },
      { name: "Nova", archived: undefined },
    ]);
  });

  it("fails the whole chat list when a thread's unread count doesn't check", async () => {
    for (const unreadCount of [undefined, -1, 1.5, "2", null]) {
      const { client } = serveOps(
        "groupsFull",
        listed(listedThread("thread-1", 0), listedThread("thread-2", unreadCount)),
      );
      await expect(readChats(client, "ws-a", signal), String(unreadCount)).rejects.toMatchObject({
        problem: "invalid",
      });
    }
  });

  it("keeps a stream's lanes and the account's read place", async () => {
    const read = { createdAtMs: 5, lane: "posts", id: "thread-1" };
    const { client } = serveOps("chat", {
      ...stream(answer),
      stream: { ...stream(answer).stream, readPosition: read },
    });
    expect((await readStream(client, "ws-a", "channel-1", signal)).value).toMatchObject({
      readPosition: read,
      items: [{ lane: "chat" }],
    });
  });

  it("takes a read place or an item's place with an engine ID up to 256 units", async () => {
    for (const length of [201, 256]) {
      const long = "x".repeat(length);
      const read = { createdAtMs: 5, lane: "posts", id: long };
      const items = [{ position: { createdAtMs: 5, lane: "chat", id: long }, message: answer }];
      const { client } = serveOps("chat", {
        ok: true,
        stream: { ...stream(answer).stream, items, readPosition: read },
      });
      expect(
        (await readStream(client, "ws-a", "channel-1", signal)).value,
        String(length),
      ).toMatchObject({ readPosition: read });
    }
  });

  it("fails the whole stream when its read place or an item's place doesn't check", async () => {
    const broken: Array<[label: string, change: Record<string, unknown>]> = [
      ["no read place", { readPosition: undefined }],
      [
        "a read place in no lane",
        { readPosition: { createdAtMs: 5, lane: "feed", id: "thread-1" } },
      ],
      ["a read place with no time", { readPosition: { lane: "posts", id: "thread-1" } }],
      [
        "a read place with a 257-unit ID",
        { readPosition: { createdAtMs: 5, lane: "posts", id: "x".repeat(257) } },
      ],
      ["an item with no place", { items: [{ message: answer }] }],
      [
        "an item in no lane",
        {
          items: [{ position: { createdAtMs: 5, lane: "feed", id: "message-2" }, message: answer }],
        },
      ],
    ];
    for (const [label, change] of broken) {
      const { client } = serveOps("chat", {
        ok: true,
        stream: { ...stream(answer).stream, ...change },
      });
      await expect(readStream(client, "ws-a", "channel-1", signal), label).rejects.toMatchObject({
        problem: "invalid",
      });
    }
  });

  it("marks a thread read with exactly its ID and the message's, and takes a missing thread as done", async () => {
    const { server, client } = serveOps("markRead", { ok: true });
    await markThreadRead(client, "ws-a", "thread-1", "message-2", signal);
    expect(server.calls.map((call) => call.body)).toEqual([
      { threadId: "thread-1", messageId: "message-2" },
    ]);
    const missing = serveOps("markRead", {
      ok: false,
      reason: "chat thread not found: thread-1",
      refusal: "missing",
    });
    await expect(
      markThreadRead(missing.client, "ws-a", "thread-1", "message-2", signal),
    ).resolves.toBeUndefined();
    const failed = serveOps("markRead", { ok: false, reason: "failed to mark read: thread-1" });
    await expect(
      markThreadRead(failed.client, "ws-a", "thread-1", "message-2", signal),
    ).rejects.toMatchObject({ problem: "invalid" });
  });
});

describe("a stream's lanes", () => {
  const signal = new AbortController().signal;
  function serve(result: unknown) {
    const server = testServer();
    server.on("POST", "/sync/ws-a/ops/chatContext", answered(result));
    const client = createServerClient({
      origin: server.origin,
      token: "tok",
      fetch: server.fetch,
      signal,
    });
    return { server, client };
  }
  const context = (conversation: Record<string, unknown>) => ({
    ok: true,
    conversation: {
      kind: "stream",
      groupId: "channel-1",
      groupKind: "group",
      canPost: true,
      canSend: false,
      ...conversation,
    },
    mentions: [],
    // The lanes read ignores wakes; the server sends them named.
    wakes: [
      {
        wakeId: `wake-${"0".repeat(32)}`,
        messageId: "message-1",
        threadId: "thread-1",
        generation: 1,
        state: "waiting",
        winnerLabel: null,
        agentName: "Claude",
        canRetry: false,
      },
    ],
    wakeCursor: "4",
  });

  it("asks the server's context for the stream, and keeps which writes it takes", async () => {
    const { server, client } = serve(context({}));
    await expect(readStreamLanes(client, "ws-a", "channel-1", signal)).resolves.toEqual({
      value: { kind: "lanes", groupKind: "group", canPost: true, canSend: false },
      cursor: "0.1.1",
    });
    expect(server.calls.map((call) => call.body)).toEqual([{ group: "channel-1" }]);
  });

  it("takes a hidden or missing chat as missing, and rejects another stream's answer", async () => {
    const missing = serve({ ok: false, refusal: "missing", reason: "chat not found" });
    await expect(readStreamLanes(missing.client, "ws-a", "channel-1", signal)).resolves.toEqual({
      value: { kind: "missing" },
      cursor: "0.1.1",
    });
    for (const wrong of [{ groupId: "channel-2" }, { canSend: "yes" }, { kind: "thread" }]) {
      const { client } = serve(context(wrong));
      await expect(readStreamLanes(client, "ws-a", "channel-1", signal)).rejects.toMatchObject({
        problem: "invalid",
      });
    }
  });
});

describe("a joined workspace's cursor", () => {
  it("takes the mark of what the account reaches, and keeps it through earlier and later", () => {
    const reach = "0123456789abcdef";
    expect(isCursor(`0.5.2.${reach}`)).toBe(true);
    expect(isCursor("0.5.2.NOTHEX0123456789")).toBe(false);
    expect(earlierCursor(`0.5.2.${reach}`, `0.4.3.${reach}`)).toBe(`0.4.2.${reach}`);
    expect(laterCursor(`0.5.2.${reach}`, `0.4.3.${reach}`)).toBe(`0.5.3.${reach}`);
    expect(laterCursor("0.5.2", "0.4.3")).toBe("0.5.3");
    expect(earlierCursor(`0.5.2.${reach}`, "0.4.3.fedcba9876543210")).toBe("0.4.2");
    expect(earlierCursor(`0.5.2.${reach}`, "0.4.3")).toBe("0.4.2");
  });

  it("preserves per-Group channelWireId, type, and access from groupsFull", async () => {
    const server = testServer();
    server.on(
      "POST",
      "/sync/ws-a/ops/groupsFull",
      answered({
        ok: true,
        groups: [
          {
            id: "channel-1",
            channelWireId: "wire-team",
            name: "Team",
            kind: "group",
            type: "both",
            access: "read-write",
            threads: [],
          },
          {
            id: "channel-2",
            channelWireId: "wire-news",
            name: "News",
            kind: "group",
            type: "chat",
            access: "read-only",
            threads: [],
          },
          {
            id: "channel-3",
            name: "No wire",
            kind: "group",
            type: "invalid",
            access: "unknown",
            threads: [],
          },
        ],
      }),
    );
    const client = createServerClient({
      origin: server.origin,
      token: "tok",
      fetch: server.fetch,
      signal: new AbortController().signal,
    });
    const read = await readChats(client, "ws-a", new AbortController().signal);
    expect(read.value).toEqual([
      expect.objectContaining({
        id: "channel-1",
        channelWireId: "wire-team",
        type: "both",
        access: "read-write",
      }),
      expect.objectContaining({
        id: "channel-2",
        channelWireId: "wire-news",
        type: "chat",
        access: "read-only",
      }),
      expect.not.objectContaining({
        channelWireId: expect.anything(),
        type: expect.anything(),
        access: expect.anything(),
      }),
    ]);
  });

  it("reads fileChats with optional Member access and parses thread access on readThread", async () => {
    const server = testServer();
    server.on(
      "POST",
      "/sync/ws-a/ops/fileChats",
      answered({
        ok: true,
        path: "docs/plan.md",
        fileObjectId: "obj-plan",
        access: "read-write",
        threads: [{ id: "thread-1", title: "Plan", createdAtMs: 10, updatedAtMs: 20 }],
      }),
      answered({ ok: true, path: "docs/missing.md", fileObjectId: null, threads: [] }),
    );
    server.on(
      "POST",
      "/sync/ws-a/ops/chat",
      answered({
        ok: true,
        thread: { id: "thread-1", title: "Plan", access: "read-write" },
        messages: [raw({ id: "msg-1", threadId: "thread-1" })],
      }),
    );
    const client = createServerClient({
      origin: server.origin,
      token: "tok",
      fetch: server.fetch,
      signal: new AbortController().signal,
    });
    const signal = new AbortController().signal;
    expect(await readFileChats(client, "ws-a", "docs/plan.md", signal)).toEqual({
      value: {
        fileObjectId: "obj-plan",
        access: "read-write",
        threads: [{ id: "thread-1", title: "Plan", updatedAtMs: 20 }],
      },
      cursor: "0.1.1",
    });
    expect(await readFileChats(client, "ws-a", "docs/missing.md", signal)).toEqual({
      value: { fileObjectId: null, threads: [] },
      cursor: "0.1.1",
    });
    expect((await readThread(client, "ws-a", "thread-1", signal)).value).toMatchObject({
      kind: "thread",
      id: "thread-1",
      access: "read-write",
    });
  });
});
