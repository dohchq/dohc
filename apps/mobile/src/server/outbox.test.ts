import { accountWords } from "@dohc/interface-words/account";
import { describe, expect, it, vi } from "vitest";
import type { AccountState, SignIn } from "./account";
import type { ChatWrite } from "./chatWrites";
import { createServerClient } from "./client";
import { createDurableFiles, DurableFileError } from "./durableFiles";
import { createOutbox, OutboxError, type Outbox } from "./outbox";
import { durableDisk } from "./testDurableDisk";
import { deferred, testServer, type Answer } from "./testServer";
import type { ChatMessage } from "./workspaceReads";

type Server = ReturnType<typeof testServer>;
type Disk = ReturnType<typeof durableDisk>;

const ops = (result: unknown): Answer => ({ status: 200, body: { ok: true, result, cursor: "0.1.1" } });
const SAVED = (threadId: string, messageId?: string) => ops({ ok: true, state: "saved", threadId, ...(messageId ? { messageId } : {}) });
const PENDING = ops({ ok: true, state: "pending" });
const REFUSED = (reason: string, extra: object = {}) => ops({ ok: false, refusal: "refused", reason, ...extra });
/** A request the test never answers: it waits until its signal aborts. */
const held = () => new Promise<Answer>(() => {});

const post = (body: string, groupId = "group-1"): ChatWrite => ({ operation: "post", args: { groupId, body } });
const send = (body: string, streamId = "dm-1"): ChatWrite => ({ operation: "send", args: { streamId, body } });
const reply = (body: string, threadId: string | null = "thread-1"): ChatWrite => ({ operation: "reply", args: { threadId, body } });

/** Lets every answer already given land: no timer, only the macrotask after the answers' callbacks. */
const settled = () => new Promise<void>(resolve => setImmediate(resolve));
const path = (operation: string) => `/sync/ws-1/ops/${operation}`;
const requests = (server: Server, operation: string) => server.calls.filter(call => call.path === path(operation)).map(call => call.body);
const records = (disk: Disk) => disk.names().filter(name => /^m-\d{12}$/.test(name));
const temporaries = (disk: Disk) => disk.names().filter(name => name.endsWith(".tmp"));

/** The phone's sign-in, as the account gives it: a generation that ends at sign-out, a 401 and another sign-in. */
function fakeAccount() {
  let state: AccountState = { status: "loading" };
  let generation = 0;
  let controller = new AbortController();
  const listeners = new Set<() => void>();
  const set = (next: AccountState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const advance = () => {
    generation += 1;
    controller.abort();
    controller = new AbortController();
    return generation;
  };
  const account = {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    signIn(server: Server, userId = "u-1"): SignIn {
      const id = advance();
      const signIn: SignIn = {
        origin: server.origin, userId, email: `${userId}@example.com`, isCurrent: () => id === generation,
        client: createServerClient({
          origin: server.origin, token: `tok-${id}`, fetch: server.fetch, signal: controller.signal,
          onSignedOut: () => {
            if (id !== generation) return;
            advance();
            set({ status: "signed-out", origin: server.origin, ended: true, forgetFailed: false });
          },
        }),
      };
      set({ status: "signed-in", signIn });
      return signIn;
    },
    signOut() {
      advance();
      set({ status: "signed-out", origin: null, ended: false, forgetFailed: false });
    },
  };
  return account;
}

/** Retry waits the test ends, by `release` or the outbox's `wake`. */
function waits() {
  const pending: { readonly ms: number; readonly release: () => void }[] = [];
  return {
    pending,
    sleep: (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      pending.push({ ms, release: resolve });
      signal.addEventListener("abort", () => reject(new Error("cut short")));
    }),
    release() {
      for (const wait of pending.splice(0)) wait.release();
    },
  };
}

/** One run of the app over `disk`, signed in to `server` when given. */
function launch(disk: Disk, server?: Server, options: { now?: () => number; stalledAfterMs?: number; stalledRetryMs?: number; retryMs?: (failures: number) => number } = {}) {
  const wait = waits();
  const outbox = createOutbox({ files: createDurableFiles(disk.launch()), sleep: wait.sleep, ...options });
  const account = fakeAccount();
  const stop = outbox.follow(account);
  if (server) account.signIn(server);
  return { outbox, account, stop, wait };
}

const ready = (outbox: Outbox) => vi.waitFor(() => expect(outbox.state().status).toBe("ready"));
const record = (outbox: Outbox, sequence: number) => outbox.state().records.find(entry => entry.sequence === sequence);

/** Answers each request to `operation` when the test says. */
function answerLater(server: Server, operation: string) {
  const calls: { readonly body: unknown; readonly answer: (answer: Answer) => void }[] = [];
  server.on("POST", path(operation), call => {
    const answer = deferred<Answer>();
    calls.push({ body: call.body, answer: answer.resolve });
    return answer.promise;
  });
  return calls;
}

const message = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, threadId: "thread-1", authorKind: "human", authorName: "Maya Chen", body: "", createdAtMs: 1, parentMessageId: null, attachments: [],
  needsDecision: false, decisionState: null, options: [], chosenOption: null, resolvedByMessageId: null, reactions: [], ...extra,
});

describe("enqueue", () => {
  it("resolves once the record is on disk, and the record and the order survive a relaunch", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), held);
    const first = launch(disk, server);
    await ready(first.outbox);
    const queued = await first.outbox.enqueue({ workspaceId: "ws-1", write: post("Hello") });
    expect(queued).toMatchObject({ origin: server.origin, accountId: "u-1", workspaceId: "ws-1", sequence: 1, stage: "queued", attempted: false, dependsOn: null });
    expect(records(disk)).toEqual(["m-000000000001"]);
    await vi.waitFor(() => expect(requests(server, "post")).toHaveLength(1));
    first.stop();

    const second = launch(disk, server);
    await ready(second.outbox);
    expect(second.outbox.state().records).toEqual([
      expect.objectContaining({ operationId: queued.operationId, sequence: 1, write: post("Hello"), stage: "sending", attempted: true }),
    ]);
    const next = await second.outbox.enqueue({ workspaceId: "ws-1", write: post("Again") });
    expect(next.sequence).toBe(2);
    expect(next.operationId).not.toBe(queued.operationId);
    second.stop();
  });

  it("never resolves a write that failed or didn't sync, and keeps no record of it", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), held);
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);

    disk.failWrites = "write";
    const failed = await outbox.enqueue({ workspaceId: "ws-1", write: post("Lost") }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(DurableFileError);
    expect(failed instanceof DurableFileError && failed.kind).toBe("failed");
    disk.failWrites = null;

    // The counter lands; the record is renamed into place, then its folder sync fails.
    const releaseCounter = disk.holdWrites();
    const unsynced = outbox.enqueue({ workspaceId: "ws-1", write: post("Maybe") }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(temporaries(disk).some(name => name.startsWith("counter."))).toBe(true));
    releaseCounter();
    const releaseRecord = disk.holdWrites();
    await vi.waitFor(() => expect(temporaries(disk).some(name => name.startsWith("m-"))).toBe(true));
    disk.failWrites = "sync-folder";
    releaseRecord();
    const error = await unsynced;
    expect(error instanceof DurableFileError && error.kind).toBe("unsynced");
    disk.failWrites = null;

    expect(outbox.state().records).toEqual([]);
    expect(records(disk)).toEqual([]);
    expect(requests(server, "post")).toHaveLength(0);
    stop();
    const relaunch = launch(disk);
    await ready(relaunch.outbox);
    expect(relaunch.outbox.state().records).toEqual([]);
  });

  it("refuses with nothing written when no account is signed in", async () => {
    const disk = durableDisk();
    const { outbox } = launch(disk);
    await ready(outbox);
    await expect(outbox.enqueue({ workspaceId: "ws-1", write: post("Hi") })).rejects.toEqual(new OutboxError("closed"));
    expect(disk.names()).toEqual([]);
  });
});

describe("order", () => {
  it("sends one record at a time per thread, in sequence, across a relaunch", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("reply"), held);
    const first = launch(disk, server);
    await ready(first.outbox);
    const a = await first.outbox.enqueue({ workspaceId: "ws-1", write: reply("A") });
    const b = await first.outbox.enqueue({ workspaceId: "ws-1", write: reply("B") });
    const c = await first.outbox.enqueue({ workspaceId: "ws-1", write: reply("C", "thread-2") });
    await vi.waitFor(() => expect(requests(server, "reply")).toHaveLength(2));
    expect(requests(server, "reply")).toEqual([
      { operationId: a.operationId, threadId: "thread-1", body: "A" },
      { operationId: c.operationId, threadId: "thread-2", body: "C" },
    ]);
    first.stop();

    server.calls.length = 0;
    const calls = answerLater(server, "reply");
    const second = launch(disk, server);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map(call => call.body)).toEqual([
      { operationId: a.operationId, threadId: "thread-1", body: "A" },
      { operationId: c.operationId, threadId: "thread-2", body: "C" },
    ]);
    calls[0]?.answer(SAVED("thread-1", "message-a"));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]?.body).toEqual({ operationId: b.operationId, threadId: "thread-1", body: "B" });
    expect(record(second.outbox, 1)?.stage).toBe("saved");
    second.stop();
  });
});

describe("dependencies", () => {
  it("hold a reply until its outbox send is saved, then send it to the thread the send joined", async () => {
    const disk = durableDisk();
    const server = testServer();
    const sends = answerLater(server, "send");
    const replies = answerLater(server, "reply");
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);
    const parent = await outbox.enqueue({ workspaceId: "ws-1", write: send("Lunch?") });
    const child = await outbox.enqueue({ workspaceId: "ws-1", write: reply("Noon works", null), dependsOn: parent.operationId });
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    await settled();
    expect(replies).toHaveLength(0);

    // The send joined a running conversation, not a thread of its own.
    sends[0]?.answer(SAVED("thread-running", "message-s"));
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]?.body).toEqual({ operationId: child.operationId, threadId: "thread-running", body: "Noon works" });
    expect(JSON.parse(disk.files.get("m-000000000002") ?? "null")).toMatchObject({ write: { args: { threadId: "thread-running" } } });
    stop();
  });

  it("refuse every reply waiting on a refused post, keeping their text, and send none of them", async () => {
    const disk = durableDisk();
    const server = testServer();
    const posts = answerLater(server, "post");
    server.on("POST", path("reply"), held);
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);
    const parent = await outbox.enqueue({ workspaceId: "ws-1", write: post("Plans") });
    await outbox.enqueue({ workspaceId: "ws-1", write: reply("First", null), dependsOn: parent.operationId });
    await outbox.enqueue({ workspaceId: "ws-1", write: reply("Second", null), dependsOn: parent.operationId });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    posts[0]?.answer(REFUSED("Couldn't send"));

    const refusal = { kind: "refused", reason: "The message it replies to wasn't sent", threadId: null, winnerMessageId: null };
    await vi.waitFor(() => expect(outbox.state().records.map(entry => entry.stage)).toEqual(["refused", "refused", "refused"]));
    expect(outbox.state().records.slice(1)).toEqual([
      expect.objectContaining({ write: reply("First", null), result: refusal, attempted: false }),
      expect.objectContaining({ write: reply("Second", null), result: refusal, attempted: false }),
    ]);
    expect(requests(server, "reply")).toHaveLength(0);
    stop();

    const relaunch = launch(disk);
    await ready(relaunch.outbox);
    expect(relaunch.outbox.state().records.map(entry => entry.result?.kind === "refused" && entry.result.reason))
      .toEqual(["Couldn't send", "The message it replies to wasn't sent", "The message it replies to wasn't sent"]);
  });

  it("refuse a reply without its thread that names no outbox post or send", async () => {
    const disk = durableDisk();
    const server = testServer();
    const { outbox } = launch(disk, server);
    await ready(outbox);
    await expect(outbox.enqueue({ workspaceId: "ws-1", write: reply("Hi", null), dependsOn: "op-unknown" })).rejects.toEqual(new OutboxError("invalid"));
    await expect(outbox.enqueue({ workspaceId: "ws-1", write: reply("Hi", null) })).rejects.toEqual(new OutboxError("invalid"));
    expect(disk.names()).toEqual([]);
  });
});

describe("asking again", () => {
  it("re-asks after offline, busy, unreadable and pending answers with the same ID and arguments", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("reply"), "offline", { status: 503 }, { status: 200, body: { ok: true } }, { status: 500 }, PENDING, SAVED("thread-1", "message-r"));
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);
    const queued = await outbox.enqueue({ workspaceId: "ws-1", write: reply("Hi") });
    await vi.waitFor(() => {
      outbox.wake();
      expect(record(outbox, 1)?.stage).toBe("saved");
    });
    const sent = requests(server, "reply");
    expect(sent).toHaveLength(6);
    for (const body of sent) expect(body).toEqual({ operationId: queued.operationId, threadId: "thread-1", body: "Hi" });
    expect(record(outbox, 1)).toMatchObject({ result: { kind: "saved", threadId: "thread-1", messageId: "message-r" }, pendingSinceMs: null });
    stop();
  });

  it("re-asks a record a relaunch finds sending, with its own ID", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), held);
    const first = launch(disk, server);
    await ready(first.outbox);
    const queued = await first.outbox.enqueue({ workspaceId: "ws-1", write: post("Hello") });
    await vi.waitFor(() => expect(requests(server, "post")).toHaveLength(1));
    first.stop();
    expect(JSON.parse(disk.files.get("m-000000000001") ?? "null")).toMatchObject({ stage: "sending", attempted: true });

    server.on("POST", path("post"), SAVED("thread-p", "message-p"));
    const second = launch(disk, server);
    await vi.waitFor(() => expect(record(second.outbox, 1)?.stage).toBe("saved"));
    expect(requests(server, "post")).toEqual([
      { operationId: queued.operationId, groupId: "group-1", body: "Hello" },
      { operationId: queued.operationId, groupId: "group-1", body: "Hello" },
    ]);
    second.stop();
  });

  it("calls a write stalled once the server has answered pending past the threshold, and asks it more slowly", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), PENDING);
    let clock = 5000;
    const { outbox, stop, wait } = launch(disk, server, { now: () => clock, stalledAfterMs: 1000, stalledRetryMs: 7000, retryMs: failures => failures * 10 });
    await ready(outbox);
    await outbox.enqueue({ workspaceId: "ws-1", write: post("Hi") });
    await vi.waitFor(() => expect(wait.pending).toHaveLength(1));
    expect(wait.pending[0]?.ms).toBe(10);
    expect(record(outbox, 1)).toMatchObject({ stage: "sending", pendingSinceMs: 5000 });

    clock = 6000;
    wait.release();
    await vi.waitFor(() => expect(wait.pending).toHaveLength(1));
    expect(wait.pending[0]?.ms).toBe(7000);
    expect(record(outbox, 1)).toMatchObject({ stage: "stalled", pendingSinceMs: 5000 });
    expect(outbox.signOutCounts()).toEqual({ unsent: 0, maySend: 1 });
    stop();
  });

  it("settles a write the route refuses as malformed or too large, keeping its text", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), { status: 413, body: { ok: false, code: "payload_too_large" } });
    server.on("POST", path("send"), { status: 400, body: { ok: false, code: "bad_request" } });
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);
    await outbox.enqueue({ workspaceId: "ws-1", write: post("Long") });
    await outbox.enqueue({ workspaceId: "ws-1", write: send("Odd") });
    await vi.waitFor(() => expect(outbox.state().records.map(entry => entry.stage)).toEqual(["refused", "refused"]));
    expect(outbox.state().records.map(entry => entry.result)).toEqual([
      { kind: "refused", reason: "Couldn't send", threadId: null, winnerMessageId: null },
      { kind: "refused", reason: "Couldn't send", threadId: null, winnerMessageId: null },
    ]);
    outbox.wake();
    await settled();
    expect(server.calls).toHaveLength(2);
    expect(records(disk)).toHaveLength(2);
    stop();
  });

  it("keeps too old, already answered and missing as settled, with the text", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), REFUSED("too old"));
    server.on("POST", path("reply"), REFUSED("already answered", { threadId: "thread-1", winnerMessageId: "message-w" }));
    server.on("POST", path("react"), ops({ ok: false, refusal: "missing", reason: "Message not found" }));
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);
    await outbox.enqueue({ workspaceId: "ws-1", write: post("Old") });
    await outbox.enqueue({ workspaceId: "ws-1", write: { operation: "reply", args: { threadId: "thread-1", body: "Friday", resolves: { messageId: "message-q" } } } });
    await outbox.enqueue({ workspaceId: "ws-1", write: { operation: "react", args: { messageId: "message-x", emoji: "👍", state: "added" } } });
    await vi.waitFor(() => expect(outbox.state().records.map(entry => entry.stage)).toEqual(["refused", "refused", "refused"]));
    expect(outbox.state().records.map(entry => entry.result)).toEqual([
      { kind: "refused", reason: "too old", threadId: null, winnerMessageId: null },
      { kind: "refused", reason: "already answered", threadId: "thread-1", winnerMessageId: "message-w" },
      { kind: "missing", reason: "Message not found" },
    ]);
    expect(record(outbox, 2)?.write).toMatchObject({ args: { body: "Friday" } });
    outbox.wake();
    await settled();
    expect(server.calls).toHaveLength(3);
    stop();
  });
});

describe("the handoff to reads", () => {
  it("keeps a saved record until a read of its own account and workspace shows its result", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), SAVED("thread-p", "message-p"));
    server.on("POST", path("react"), SAVED("thread-1"));
    server.on("POST", path("reply"), SAVED("thread-1", "message-a"));
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);
    const account = { origin: server.origin, userId: "u-1" };
    await outbox.enqueue({ workspaceId: "ws-1", write: post("Plans") });
    await outbox.enqueue({ workspaceId: "ws-1", write: { operation: "react", args: { messageId: "message-x", emoji: "👍", state: "added" } } });
    await outbox.enqueue({ workspaceId: "ws-1", write: { operation: "reply", args: { threadId: "thread-1", body: "Friday", resolves: { messageId: "message-q" } } } });
    await vi.waitFor(() => expect(outbox.state().records.map(entry => entry.stage)).toEqual(["saved", "saved", "saved"]));

    // Reads that don't show the results, or that are another account's or workspace's, keep every record.
    outbox.handoff(account, "ws-1", [message("message-x"), message("message-q", { needsDecision: true, decisionState: "open" }), message("message-a")]);
    outbox.handoff({ origin: server.origin, userId: "u-2" }, "ws-1", [message("message-p")]);
    outbox.handoff({ origin: "https://other.example.com", userId: "u-1" }, "ws-1", [message("message-p")]);
    outbox.handoff(account, "ws-2", [message("message-p")]);
    await settled();
    expect(outbox.state().records).toHaveLength(3);
    expect(records(disk)).toHaveLength(3);

    const reaction = { emoji: "👍", authorId: "u-1", authorKind: "human", authorName: "Ice", atMs: 1 } as const;
    outbox.handoff(account, "ws-1", [
      message("message-p"),
      message("message-x", { reactions: [reaction] }),
      message("message-q", { needsDecision: true, decisionState: "resolved", resolvedByMessageId: "message-a" }),
      message("message-a"),
    ]);
    await vi.waitFor(() => expect(outbox.state().records).toEqual([]));
    expect(records(disk)).toEqual([]);
    stop();
  });
});

describe("account isolation", () => {
  it("pauses at a 401 and keeps every record, then sends with the same ID when the account signs in again", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), { status: 401, body: { ok: false } });
    const { outbox, account, stop } = launch(disk, server);
    await ready(outbox);
    const queued = await outbox.enqueue({ workspaceId: "ws-1", write: post("Hello") });
    await vi.waitFor(() => expect(account.state()).toMatchObject({ status: "signed-out", ended: true }));
    outbox.wake();
    await settled();
    expect(requests(server, "post")).toHaveLength(1);
    expect(outbox.state().records).toEqual([expect.objectContaining({ operationId: queued.operationId, stage: "sending", attempted: true })]);
    expect(records(disk)).toEqual(["m-000000000001"]);
    expect(outbox.signOutCounts()).toEqual({ unsent: 0, maySend: 1 });

    server.on("POST", path("post"), SAVED("thread-p", "message-p"));
    account.signIn(server);
    await vi.waitFor(() => expect(record(outbox, 1)?.stage).toBe("saved"));
    expect(requests(server, "post")).toEqual([
      { operationId: queued.operationId, groupId: "group-1", body: "Hello" },
      { operationId: queued.operationId, groupId: "group-1", body: "Hello" },
    ]);
    stop();
  });

  it("never sends a record with another account's session, or the same account's on another server", async () => {
    const disk = durableDisk();
    const a = testServer("https://a.example.com");
    const b = testServer("https://b.example.com");
    a.on("POST", path("post"), held);
    b.on("POST", path("post"), SAVED("thread-p", "message-p"));
    const { outbox, account, stop } = launch(disk, a);
    await ready(outbox);
    const theirs = await outbox.enqueue({ workspaceId: "ws-1", write: post("From u-1") });
    await vi.waitFor(() => expect(requests(a, "post")).toHaveLength(1));

    // Another account signs in on the same server, as after a 401.
    a.on("POST", path("post"), SAVED("thread-p", "message-p"));
    account.signIn(a, "u-2");
    expect(a.calls[0]?.signal.aborted).toBe(true);
    const mine = await outbox.enqueue({ workspaceId: "ws-1", write: post("From u-2") });
    await vi.waitFor(() => expect(record(outbox, mine.sequence)?.stage).toBe("saved"));
    outbox.wake();
    await settled();
    expect(requests(a, "post")).toEqual([
      { operationId: theirs.operationId, groupId: "group-1", body: "From u-1" },
      { operationId: mine.operationId, groupId: "group-1", body: "From u-2" },
    ]);
    expect(mine.accountId).toBe("u-2");

    // The first account, on another server.
    account.signIn(b, "u-1");
    outbox.wake();
    await settled();
    expect(b.calls).toHaveLength(0);
    expect(record(outbox, theirs.sequence)).toMatchObject({ stage: "sending", accountId: "u-1", origin: a.origin });
    stop();
  });
});

describe("signing out", () => {
  it("wins over a disk write in flight: the record goes once the write lands", async () => {
    const disk = durableDisk();
    const server = testServer();
    const calls = answerLater(server, "post");
    const { outbox, account } = launch(disk, server);
    await ready(outbox);
    await outbox.enqueue({ workspaceId: "ws-1", write: post("Hello") });
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const release = disk.holdWrites();
    calls[0]?.answer(SAVED("thread-p", "message-p"));
    await vi.waitFor(() => expect(temporaries(disk).some(name => name.startsWith("m-000000000001."))).toBe(true));
    account.signOut();
    expect(outbox.state().records).toEqual([]);
    release();
    await vi.waitFor(() => expect(disk.names()).toEqual([]));
    await ready(outbox);
    expect(outbox.state().records).toEqual([]);
    expect(disk.log.lastIndexOf("write m-000000000001")).toBeLessThan(disk.log.lastIndexOf("remove m-000000000001"));
  });

  it("wins over an enqueue in flight, which rejects", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), held);
    const { outbox, account } = launch(disk, server);
    await ready(outbox);
    const release = disk.holdWrites();
    const enqueuing = outbox.enqueue({ workspaceId: "ws-1", write: post("Hello") });
    await vi.waitFor(() => expect(temporaries(disk)).toHaveLength(1));
    account.signOut();
    release();
    await expect(enqueuing).rejects.toEqual(new OutboxError("closed"));
    await vi.waitFor(() => expect(disk.names()).toEqual([]));
    expect(requests(server, "post")).toHaveLength(0);
  });

  it("wins over a late answer, which brings nothing back", async () => {
    const disk = durableDisk();
    const server = testServer();
    const calls = answerLater(server, "post");
    const { outbox, account } = launch(disk, server);
    await ready(outbox);
    await outbox.enqueue({ workspaceId: "ws-1", write: post("Hello") });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    account.signOut();
    calls[0]?.answer(SAVED("thread-p", "message-p"));
    await vi.waitFor(() => expect(disk.names()).toEqual([]));
    await ready(outbox);
    await settled();
    expect(disk.names()).toEqual([]);
    expect(outbox.state().records).toEqual([]);
    expect(server.calls[0]?.signal.aborted).toBe(true);
  });

  it("counts what it would delete: never sent or refused, and sent but not confirmed", async () => {
    const disk = durableDisk();
    disk.files.set("m-000000000009", "not a record");
    const server = testServer();
    server.on("POST", path("reply"), held);
    server.on("POST", path("post"), REFUSED("Couldn't send"));
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);
    await outbox.enqueue({ workspaceId: "ws-1", write: reply("Sending") });
    await outbox.enqueue({ workspaceId: "ws-1", write: reply("Waiting behind it") });
    await outbox.enqueue({ workspaceId: "ws-1", write: post("Refused") });
    await vi.waitFor(() => expect(outbox.state().records.map(entry => entry.stage)).toEqual(["sending", "queued", "refused"]));
    // The unreadable record counts as unsent too: Sign out deletes it.
    expect(outbox.signOutCounts()).toEqual({ unsent: 3, maySend: 1 });
    stop();

    expect(accountWords.signOutBody(3, 1)).toBe("3 messages haven't been sent. Signing out deletes them. 1 message may still send.");
    expect(accountWords.signOutBody(1, 0)).toBe("1 message hasn't been sent. Signing out deletes it.");
    expect(accountWords.signOutBody(0, 2)).toBe("2 messages may still send.");
    expect(accountWords.signOutBody(0, 0)).toBe("This phone stops reading your workspaces. Your work stays where it is.");
  });
});

describe("recovery", () => {
  it("keeps unreadable records and other files aside, and never deletes them", async () => {
    const disk = durableDisk();
    disk.files.set("m-000000000003", "{ broken");
    disk.files.set("m-000000000004", "{}");
    disk.unreadable.add("m-000000000004");
    disk.files.set("probe-1", "someone else's");
    disk.files.set(`m-000000000005.${"0".repeat(32)}.tmp`, "{\"format\":");
    const server = testServer();
    server.on("POST", path("post"), held);
    const first = launch(disk, server);
    await ready(first.outbox);
    expect(first.outbox.state()).toMatchObject({
      records: [], aside: ["m-000000000003", "m-000000000004", `m-000000000005.${"0".repeat(32)}.tmp`, "probe-1"],
    });
    const queued = await first.outbox.enqueue({ workspaceId: "ws-1", write: post("After") });
    expect(queued.sequence).toBe(5);
    first.stop();

    const second = launch(disk);
    await ready(second.outbox);
    expect(second.outbox.state().aside).toHaveLength(4);
    expect(disk.names()).toEqual(expect.arrayContaining(["m-000000000003", "m-000000000004", "probe-1", `m-000000000005.${"0".repeat(32)}.tmp`]));
    expect(disk.log.some(entry => entry.startsWith("remove") || entry.startsWith("removeLeftover"))).toBe(false);
  });

  it("waits for the phone's first unlock before reading, and deletes nothing meanwhile", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), held);
    const first = launch(disk, server);
    await ready(first.outbox);
    await first.outbox.enqueue({ workspaceId: "ws-1", write: post("Hello") });
    await vi.waitFor(() => expect(requests(server, "post")).toHaveLength(1));
    first.stop();

    disk.locked = true;
    const second = launch(disk, server);
    await vi.waitFor(() => expect(second.outbox.state().status).toBe("locked"));
    expect(second.outbox.state()).toMatchObject({ records: [], aside: [] });
    await expect(second.outbox.enqueue({ workspaceId: "ws-1", write: post("No") })).rejects.toEqual(new OutboxError("closed"));
    second.outbox.wake();
    await vi.waitFor(() => expect(second.outbox.state().status).toBe("locked"));

    disk.locked = false;
    second.outbox.wake();
    await ready(second.outbox);
    expect(second.outbox.state().records).toEqual([expect.objectContaining({ sequence: 1, stage: "sending" })]);
    await vi.waitFor(() => expect(requests(server, "post")).toHaveLength(2));
    expect(records(disk)).toEqual(["m-000000000001"]);
    second.stop();
  });
});
