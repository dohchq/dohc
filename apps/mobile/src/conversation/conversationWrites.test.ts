import { describe, expect, it, vi } from "vitest";
import type { AccountState, SignIn } from "../server/account";
import type { ChatWrite } from "../server/chatWrites";
import { createServerClient } from "../server/client";
import { createDurableFiles } from "../server/durableFiles";
import { createOutbox, OutboxError, type Outbox, type OutboxState } from "../server/outbox";
import { phoneWrites } from "../server/phoneWrites";
import { durableDisk } from "../server/testDurableDisk";
import { deferred, testServer, type Answer } from "../server/testServer";
import {
  blockedBy,
  chatWrite,
  clearSent,
  createConversationWrites,
  lanesOf,
  type Draft,
  type WriteOutbox,
} from "./conversationWrites";

type Server = ReturnType<typeof testServer>;
type Disk = ReturnType<typeof durableDisk>;

const ORIGIN = "https://dohc.example.com";
const ops = (result: unknown): Answer => ({
  status: 200,
  body: { ok: true, result, cursor: "0.1.1" },
});
const SAVED = ops({ ok: true, state: "saved", threadId: "thread-s" });
const send = (body: string): ChatWrite => ({
  operation: "send",
  args: { streamId: "group-1", body },
});
const requests = (server: Server, operation: string) =>
  server.calls
    .filter((call) => call.path === `/sync/ws-1/ops/${operation}`)
    .map((call) => call.body);

const READY: OutboxState = {
  status: "ready",
  records: [],
  aside: [],
  unreadable: [],
  deletion: "none",
};

/** An outbox that records what it was asked, and answers as each test says. */
function fakeOutbox(state: OutboxState = READY, enqueue?: WriteOutbox["enqueue"]) {
  const asked: string[] = [];
  const outbox: WriteOutbox = {
    state: () => state,
    subscribe: () => () => undefined,
    enqueue: (input) => {
      asked.push("enqueue");
      return enqueue ? enqueue(input) : Promise.reject(new Error("unexpected"));
    },
    retryEnqueue: () => {
      asked.push("retryEnqueue");
      return Promise.reject(new OutboxError("invalid"));
    },
    discard: () => {
      asked.push("discard");
      return Promise.resolve();
    },
    wake: () => {
      asked.push("wake");
    },
  };
  return { outbox, asked };
}

/** The phone's sign-in, as the account gives it, for the real outbox. */
function fakeAccount() {
  let state: AccountState = { status: "loading" };
  const listeners = new Set<() => void>();
  return {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    signIn(server: Server): SignIn {
      const signIn: SignIn = {
        origin: server.origin,
        userId: "u-1",
        email: "u-1@example.com",
        isCurrent: () => true,
        client: createServerClient({
          origin: server.origin,
          token: "tok-1",
          fetch: server.fetch,
          signal: new AbortController().signal,
          onSignedOut: () => undefined,
        }),
      };
      state = { status: "signed-in", signIn };
      for (const listener of listeners) listener();
      return signIn;
    },
  };
}

/** The real outbox over `disk`, signed in to `server`, with retry waits that never end on their own. */
function launch(disk: Disk, server: Server): Outbox {
  const outbox = createOutbox({
    files: createDurableFiles(disk.launch()),
    sleep: (_ms, signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cut")))),
  });
  const account = fakeAccount();
  outbox.follow(account);
  account.signIn(server);
  return outbox;
}

const ready = (outbox: Outbox) => vi.waitFor(() => expect(outbox.state().status).toBe("ready"));

describe("the phone writes gate", () => {
  it("is off in a build that doesn't turn it on", () => {
    expect(phoneWrites).toBe(false);
    expect(blockedBy(READY, phoneWrites)).toBe("off");
  });

  it("reaches no outbox call while off", async () => {
    const { outbox, asked } = fakeOutbox(READY, () => Promise.reject(new Error("never")));
    const writes = createConversationWrites({
      outbox,
      enabled: phoneWrites,
      isCurrent: () => true,
    });
    expect(await writes.submit("ws-1", send("Hi"))).toEqual({ kind: "blocked" });
    expect(await writes.retry("op-1")).toEqual({ kind: "blocked" });
    expect(await writes.discard({ kind: "record", operationId: "op-1" })).toEqual({
      kind: "blocked",
    });
    expect(asked).toEqual([]);
  });
});

describe("blockedBy", () => {
  it("holds every write while a Sign out's delete is owed, whatever the read says", () => {
    for (const deletion of ["owed", "failed", "failed-unmarked"] as const)
      expect(blockedBy({ ...READY, deletion }, true)).toBe("deleting");
  });

  it("waits for the records to be read", () => {
    for (const status of ["loading", "locked", "failed"] as const)
      expect(blockedBy({ ...READY, status }, true)).toBe(status);
    expect(blockedBy(READY, true)).toBeNull();
  });

  it("asks the outbox nothing while a delete is owed", async () => {
    const { outbox, asked } = fakeOutbox({ ...READY, deletion: "owed" });
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    expect(await writes.submit("ws-1", send("Hi"))).toEqual({ kind: "blocked" });
    expect(await writes.retry("op-1")).toEqual({ kind: "blocked" });
    expect(await writes.discard({ kind: "record", operationId: "op-1" })).toEqual({
      kind: "blocked",
    });
    expect(asked).toEqual([]);
  });
});

describe("a stream's writes", () => {
  it("send to the chat and post to the Group, by the engine channel", () => {
    expect(chatWrite({ kind: "send", streamId: "ch-1" }, "Hi")).toEqual({
      operation: "send",
      args: { streamId: "ch-1", body: "Hi" },
    });
    expect(chatWrite({ kind: "post", groupId: "ch-1" }, "Body", "  Plan  ")).toEqual({
      operation: "post",
      args: { groupId: "ch-1", body: "Body", title: "Plan" },
    });
    expect(chatWrite({ kind: "post", groupId: "ch-1" }, "Body", "   ")).toEqual({
      operation: "post",
      args: { groupId: "ch-1", body: "Body" },
    });
  });

  it("keep the body as typed, and make nothing of spaces alone", () => {
    expect(chatWrite({ kind: "send", streamId: "ch-1" }, "  two\nlines ")).toMatchObject({
      args: { body: "  two\nlines " },
    });
    expect(chatWrite({ kind: "send", streamId: "ch-1" }, " \n ")).toBeNull();
  });

  it("offer New post only in a Group that takes posts", () => {
    expect(lanesOf({ groupKind: "group", canPost: true, canSend: true })).toEqual({
      post: true,
      send: true,
    });
    expect(lanesOf({ groupKind: "group", canPost: true, canSend: false })).toEqual({
      post: true,
      send: false,
    });
    expect(lanesOf({ groupKind: "dm", canPost: true, canSend: true })).toEqual({
      post: false,
      send: true,
    });
    expect(lanesOf({ groupKind: "agent", canPost: false, canSend: true }).post).toBe(false);
  });
});

describe("submit", () => {
  it("keeps the write in the outbox, and says so only once it is durable", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", "/sync/ws-1/ops/send", SAVED);
    const outbox = launch(disk, server);
    await ready(outbox);
    const release = disk.holdWrites();
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    let outcome: unknown = null;
    const pending = writes.submit("ws-1", send("Hello")).then((value) => {
      outcome = value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    // The composer keeps its text until the record would survive a crash.
    expect(outcome).toBeNull();
    release();
    await pending;
    expect(outcome).toEqual({ kind: "kept" });
    await vi.waitFor(() => expect(requests(server, "send")).toHaveLength(1));
    expect(requests(server, "send")[0]).toMatchObject({ streamId: "group-1", body: "Hello" });
  });

  it("does nothing on a second tap while the first is on its way", async () => {
    const answer = deferred<Awaited<ReturnType<WriteOutbox["enqueue"]>>>();
    const { outbox, asked } = fakeOutbox(READY, () => answer.promise);
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    const first = writes.submit("ws-1", send("Once"));
    expect(await writes.submit("ws-1", send("Once"))).toEqual({ kind: "blocked" });
    expect(asked).toEqual(["enqueue"]);
    answer.resolve({} as Awaited<ReturnType<WriteOutbox["enqueue"]>>);
    expect(await first).toEqual({ kind: "kept" });
  });

  it("keeps the text when the outbox kept nothing", async () => {
    const disk = durableDisk();
    const outbox = launch(disk, testServer());
    await ready(outbox);
    disk.failWrites = "write";
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    expect(await writes.submit("ws-1", send("Lost"))).toEqual({ kind: "not-kept" });
    expect(outbox.state().records).toEqual([]);
  });

  it("names a write the outbox may keep withheld, so Send retries that one operation", async () => {
    const { outbox } = fakeOutbox(READY, () =>
      Promise.reject(new OutboxError("indeterminate", "op-7")),
    );
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    expect(await writes.submit("ws-1", send("Maybe"))).toEqual({
      kind: "withheld",
      operationId: "op-7",
    });
  });

  it("does nothing with an answer for an account or workspace no longer shown", async () => {
    const answer = deferred<Awaited<ReturnType<WriteOutbox["enqueue"]>>>();
    const { outbox } = fakeOutbox(READY, () => answer.promise);
    let current = true;
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => current });
    const pending = writes.submit("ws-1", send("Late"));
    current = false;
    answer.resolve({} as Awaited<ReturnType<WriteOutbox["enqueue"]>>);
    expect(await pending).toEqual({ kind: "stale" });
  });
});

describe("Send on a withheld message", () => {
  it("sends the record's own operation and body", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", "/sync/ws-1/ops/send", SAVED);
    disk.files.set(
      "m-000000000001",
      JSON.stringify({
        format: 1,
        origin: ORIGIN,
        accountId: "u-1",
        workspaceId: "ws-1",
        operationId: "op-kept",
        messageId: "message-kept",
        sequence: 1,
        dependsOn: null,
        target: { kind: "stream", id: "group-1" },
        write: send("Kept text"),
        stage: "queued",
        attempted: false,
        withheld: true,
        pendingSinceMs: null,
        result: null,
      }),
    );
    const outbox = launch(disk, server);
    await ready(outbox);
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    expect(await writes.retry("op-kept")).toEqual({ kind: "kept" });
    await vi.waitFor(() => expect(requests(server, "send")).toHaveLength(1));
    expect(requests(server, "send")).toEqual([
      { operationId: "op-kept", streamId: "group-1", body: "Kept text" },
    ]);
  });

  it("stays withheld with Try again when the outbox can't keep it for sending", async () => {
    const { outbox } = fakeOutbox(READY);
    outbox.retryEnqueue = () => Promise.reject(new OutboxError("indeterminate", "op-1"));
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    expect(await writes.retry("op-1")).toEqual({ kind: "not-kept" });
  });
});

describe("Discard", () => {
  it("says when a relaunch may still send the message", async () => {
    const { outbox } = fakeOutbox(READY);
    outbox.discard = () => Promise.reject(new OutboxError("withheld-in-memory", "op-1"));
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    expect(await writes.discard({ kind: "record", operationId: "op-1" })).toEqual({
      kind: "may-send",
    });
  });

  it("deletes a record that can't be read by its handle", async () => {
    const { outbox, asked } = fakeOutbox(READY);
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    expect(await writes.discard({ kind: "unreadable", handle: "h-1" })).toEqual({
      kind: "discarded",
    });
    expect(asked).toEqual(["discard"]);
  });

  it("deletes nothing when the workspace changes while its confirmation is open", async () => {
    const { outbox, asked } = fakeOutbox(READY);
    let current = true;
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => current });
    const confirmation = deferred<boolean>();
    const pending = confirmation.promise.then(() =>
      writes.discard({ kind: "record", operationId: "op-1" }),
    );
    current = false;
    confirmation.resolve(true);
    expect(await pending).toEqual({ kind: "stale" });
    expect(asked).toEqual([]);
  });
});

describe("a screen no longer shown", () => {
  it("asks the outbox nothing", async () => {
    const { outbox, asked } = fakeOutbox(READY, () => Promise.reject(new Error("never")));
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => false });
    expect(await writes.submit("ws-1", send("Hi"))).toEqual({ kind: "stale" });
    expect(await writes.retry("op-1")).toEqual({ kind: "stale" });
    expect(await writes.discard({ kind: "record", operationId: "op-1" })).toEqual({
      kind: "stale",
    });
    expect(asked).toEqual([]);
  });
});

describe("clearSent", () => {
  const sent: Draft = { text: "A", title: "Plan", chosen: "post" };

  it("empties the title and closes New post when nothing changed meanwhile", () => {
    expect(clearSent(sent, sent)).toEqual({ text: "A", title: "", chosen: "send" });
  });

  it("keeps a newer body a post, without the title sent", () => {
    expect(clearSent({ ...sent, text: "B" }, sent)).toEqual({
      text: "B",
      title: "",
      chosen: "post",
    });
  });

  it("keeps a newer title, and New post with it", () => {
    expect(clearSent({ ...sent, title: "Later" }, sent)).toEqual({
      text: "A",
      title: "Later",
      chosen: "post",
    });
  });

  it("keeps New post chosen after a message was sent", () => {
    const message: Draft = { text: "A", title: "", chosen: "send" };
    expect(clearSent({ ...message, chosen: "post" }, message)).toEqual({
      text: "A",
      title: "",
      chosen: "post",
    });
  });
});
