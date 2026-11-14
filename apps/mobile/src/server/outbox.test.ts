import { accountWords } from "@dohc/interface-words/account";
import { describe, expect, it, vi } from "vitest";
import {
  createAccount,
  type AccountState,
  type SignIn,
  type SignInStore,
  type StoredSignIn,
} from "./account";
import { derivedMessageId, type ChatWrite } from "./chatWrites";
import { createServerClient } from "./client";
import { createDurableFiles, DurableFileError } from "./durableFiles";
import { createOutbox, OutboxError, type Outbox } from "./outbox";
import { durableDisk } from "./testDurableDisk";
import { deferred, memoryStore, testServer, type Answer } from "./testServer";
import type { ChatMessage } from "./workspaceReads";

type Server = ReturnType<typeof testServer>;
type Disk = ReturnType<typeof durableDisk>;

const ORIGIN = "https://dohc.example.com";
const ops = (result: unknown): Answer => ({
  status: 200,
  body: { ok: true, result, cursor: "0.1.1" },
});
const SAVED = (threadId: string, messageId?: string) =>
  ops({ ok: true, state: "saved", threadId, ...(messageId ? { messageId } : {}) });
const PENDING = ops({ ok: true, state: "pending" });
const REFUSED = (reason: string, extra: object = {}) =>
  ops({ ok: false, refusal: "refused", reason, ...extra });
const NOT_FOUND: Answer = { status: 404, body: { ok: false, code: "not_found" } };
/** A request the test never answers: it waits until its signal aborts. */
const held = () => new Promise<Answer>(() => {});

const post = (body: string, groupId = "group-1"): ChatWrite => ({
  operation: "post",
  args: { groupId, body },
});
const send = (body: string, streamId = "dm-1"): ChatWrite => ({
  operation: "send",
  args: { streamId, body },
});
const reply = (body: string, threadId: string | null = "thread-1"): ChatWrite => ({
  operation: "reply",
  args: { threadId, body },
});
const react = (emoji = "👍", messageId = "message-x"): ChatWrite => ({
  operation: "react",
  args: { messageId, emoji, state: "added" },
});

/** Lets every answer already given land: no timer, only the macrotask after the answers' callbacks. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
const path = (operation: string) => `/sync/ws-1/ops/${operation}`;
const requests = (server: Server, operation: string) =>
  server.calls.filter((call) => call.path === path(operation)).map((call) => call.body);
const records = (disk: Disk) => disk.names().filter((name) => /^m-\d{12}$/.test(name));
const temporaries = (disk: Disk) => disk.names().filter((name) => name.endsWith(".tmp"));
const onDisk = (disk: Disk, sequence: number): unknown =>
  JSON.parse(disk.files.get(`m-${String(sequence).padStart(12, "0")}`) ?? "null");
const ME = { origin: ORIGIN, userId: "u-1" };

/** A record as an earlier run left it, for account u-1 in ws-1. */
function placeRecord(disk: Disk, sequence: number, fields: Record<string, unknown>) {
  disk.files.set(
    `m-${String(sequence).padStart(12, "0")}`,
    JSON.stringify({
      format: 1,
      origin: ORIGIN,
      accountId: "u-1",
      workspaceId: "ws-1",
      messageId: null,
      sequence,
      dependsOn: null,
      target: null,
      stage: "queued",
      attempted: false,
      withheld: false,
      pendingSinceMs: null,
      result: null,
      ...fields,
    }),
  );
}

/** The phone's sign-in, as the account gives it: a generation that ends at sign-out, a 401 and another sign-in. */
function fakeAccount(onSignOut: (leave: () => Promise<void>) => Promise<void>) {
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
  return {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    signIn(server: Server, userId = "u-1"): SignIn {
      const id = advance();
      const signIn: SignIn = {
        origin: server.origin,
        userId,
        email: `${userId}@example.com`,
        isCurrent: () => id === generation,
        client: createServerClient({
          origin: server.origin,
          token: `tok-${id}`,
          fetch: server.fetch,
          signal: controller.signal,
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
    /** As the account's Sign out: the outbox's delete, which ends the sign-in when it calls `leave`. */
    signOut() {
      return onSignOut(async () => {
        advance();
        set({ status: "signed-out", origin: null, ended: false, forgetFailed: false });
      });
    },
  };
}

/** Retry waits the test ends, by `release` or the outbox's `wake`. */
function waits() {
  const pending: { readonly ms: number; readonly release: () => void }[] = [];
  return {
    pending,
    sleep: (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        pending.push({ ms, release: resolve });
        signal.addEventListener("abort", () => reject(new Error("cut short")));
      }),
    release() {
      for (const wait of pending.splice(0)) wait.release();
    },
  };
}

/** One run of the app over `disk`, signed in to `server` when given. */
function launch(
  disk: Disk,
  server?: Server,
  options: {
    now?: () => number;
    stalledAfterMs?: number;
    stalledRetryMs?: number;
    retryMs?: (failures: number) => number;
  } = {},
) {
  const wait = waits();
  const outbox = createOutbox({
    files: createDurableFiles(disk.launch()),
    sleep: wait.sleep,
    ...options,
  });
  const account = fakeAccount((leave) => outbox.signOut(leave));
  const stop = outbox.follow(account);
  if (server) account.signIn(server);
  return { outbox, account, stop, wait };
}

const SIGNED_IN: StoredSignIn = {
  origin: ORIGIN,
  token: "tok-1",
  userId: "u-1",
  email: "ice@example.com",
};

/** One run of the app with the real account over `store`, whose Sign out runs the outbox's delete. */
function launchReal(
  disk: Disk,
  server: Server,
  store: SignInStore,
  files = createDurableFiles(disk.launch()),
) {
  const outbox = createOutbox({ files, sleep: waits().sleep });
  const account = createAccount({
    store,
    fetch: server.fetch,
    onSignOut: (leave) => outbox.signOut(leave),
  });
  const stop = outbox.follow(account);
  return { outbox, account, stop };
}

const ready = (outbox: Outbox) => vi.waitFor(() => expect(outbox.state().status).toBe("ready"));
const record = (outbox: Outbox, sequence: number) =>
  outbox.state().records.find((entry) => entry.sequence === sequence);
const stages = (outbox: Outbox) => outbox.state().records.map((entry) => entry.stage);

/** Answers each request to `operation` when the test says. */
function answerLater(server: Server, operation: string) {
  const calls: { readonly body: unknown; readonly answer: (answer: Answer) => void }[] = [];
  server.on("POST", path(operation), (call) => {
    const answer = deferred<Answer>();
    calls.push({ body: call.body, answer: answer.resolve });
    return answer.promise;
  });
  return calls;
}

const message = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  threadId: "thread-1",
  authorKind: "human",
  authorName: "Maya Chen",
  body: "",
  createdAtMs: 1,
  parentMessageId: null,
  attachments: [],
  needsDecision: false,
  decisionState: null,
  options: [],
  chosenOption: null,
  resolvedByMessageId: null,
  reactions: [],
  ...extra,
});

/**
 * Holds the record write of an enqueue until its rename has landed, then makes that write fail its folder sync, and
 * holds the next write. Resolves the release for that next write and the enqueue's outcome.
 */
async function unsyncedEnqueue(disk: Disk, outbox: Outbox, write: ChatWrite) {
  const releaseCounter = disk.holdWrites();
  const outcome = outbox.enqueue({ workspaceId: "ws-1", write }).catch((error: unknown) => error);
  await vi.waitFor(() =>
    expect(temporaries(disk).some((name) => name.startsWith("counter."))).toBe(true),
  );
  releaseCounter();
  const releaseRecord = disk.holdWrites();
  await vi.waitFor(() =>
    expect(temporaries(disk).some((name) => name.startsWith("m-"))).toBe(true),
  );
  disk.failWrites = "sync-folder";
  releaseRecord();
  const releaseNext = disk.holdWrites();
  // The record's rename landed, and the write after it, the withheld mark, has begun.
  await vi.waitFor(() =>
    expect(
      records(disk).length === 1 && temporaries(disk).some((name) => name.startsWith("m-")),
    ).toBe(true),
  );
  return { releaseNext, outcome };
}

describe("enqueue", () => {
  it("resolves once the record is on disk, with its derived message ID, and the record and the order survive a relaunch", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), held);
    const first = launch(disk, server);
    await ready(first.outbox);
    const queued = await first.outbox.enqueue({ workspaceId: "ws-1", write: post("Hello") });
    expect(queued).toMatchObject({
      origin: server.origin,
      accountId: "u-1",
      workspaceId: "ws-1",
      sequence: 1,
      stage: "queued",
      attempted: false,
      dependsOn: null,
    });
    expect(queued.messageId).toBe(
      await derivedMessageId("u-1", "ws-1", queued.operationId, post("Hello")),
    );
    expect(records(disk)).toEqual(["m-000000000001"]);
    await vi.waitFor(() => expect(requests(server, "post")).toHaveLength(1));
    first.stop();

    const second = launch(disk, server);
    await ready(second.outbox);
    expect(second.outbox.state().records).toEqual([
      expect.objectContaining({
        operationId: queued.operationId,
        messageId: queued.messageId,
        sequence: 1,
        write: post("Hello"),
        stage: "sending",
        attempted: true,
      }),
    ]);
    const next = await second.outbox.enqueue({ workspaceId: "ws-1", write: post("Again") });
    expect(next.sequence).toBe(2);
    expect(next.operationId).not.toBe(queued.operationId);
    second.stop();
  });

  it("rejects a write that failed, keeping nothing", async () => {
    const disk = durableDisk();
    const server = testServer();
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);
    disk.failWrites = "write";
    const failed = await outbox
      .enqueue({ workspaceId: "ws-1", write: post("Lost") })
      .catch((error: unknown) => error);
    expect(failed instanceof DurableFileError && failed.kind).toBe("failed");
    expect(outbox.state().records).toEqual([]);
    expect(records(disk)).toEqual([]);
    stop();
  });

  it("calls a record that didn't sync indeterminate, withholds it across a relaunch, and sends it as one operation on retry", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), SAVED("thread-p"));
    const first = launch(disk, server);
    await ready(first.outbox);
    const { releaseNext, outcome } = await unsyncedEnqueue(disk, first.outbox, post("Maybe"));
    disk.failWrites = null;
    releaseNext();
    const error = await outcome;
    expect(error).toBeInstanceOf(OutboxError);
    const operationId = error instanceof OutboxError ? error.operationId : null;
    expect(error instanceof OutboxError && error.kind).toBe("indeterminate");
    expect(first.outbox.state().records).toEqual([
      expect.objectContaining({ operationId, withheld: true, stage: "queued" }),
    ]);
    expect(onDisk(disk, 1)).toMatchObject({ operationId, withheld: true });
    expect(first.outbox.signOutCounts()).toEqual({ unsent: 1, maySend: 0 });
    await settled();
    expect(requests(server, "post")).toHaveLength(0);
    first.stop();

    const second = launch(disk, server);
    await ready(second.outbox);
    await settled();
    expect(second.outbox.state().records).toEqual([
      expect.objectContaining({ operationId, withheld: true }),
    ]);
    expect(requests(server, "post")).toHaveLength(0);
    await expect(second.outbox.retryEnqueue(operationId ?? "")).resolves.toMatchObject({
      operationId,
      withheld: false,
      sequence: 1,
    });
    await vi.waitFor(() => expect(record(second.outbox, 1)?.stage).toBe("saved"));
    expect(requests(server, "post")).toEqual([{ operationId, groupId: "group-1", body: "Maybe" }]);
    second.stop();
  });

  it("keeps trying to mark an indeterminate record withheld until the mark is on disk", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), SAVED("thread-p"));
    const first = launch(disk, server);
    await ready(first.outbox);
    const { releaseNext, outcome } = await unsyncedEnqueue(disk, first.outbox, post("Maybe"));
    disk.failWrites = "write";
    releaseNext();
    const error = await outcome;
    expect(error instanceof OutboxError && error.kind).toBe("indeterminate");
    // The mark failed: the disk still holds the sendable record, so this run withholds it and tries again.
    expect(onDisk(disk, 1)).toMatchObject({ withheld: false });
    expect(record(first.outbox, 1)?.withheld).toBe(true);
    await vi.waitFor(() => expect(first.wait.pending).toHaveLength(1));

    disk.failWrites = null;
    first.outbox.wake();
    await vi.waitFor(() => expect(onDisk(disk, 1)).toMatchObject({ withheld: true }));
    first.stop();
    const second = launch(disk, server);
    await ready(second.outbox);
    await settled();
    expect(record(second.outbox, 1)?.withheld).toBe(true);
    expect(requests(server, "post")).toHaveLength(0);
    second.stop();
  });

  it("refuses with nothing written when no account is signed in, and a reaction without its thread", async () => {
    const disk = durableDisk();
    const { outbox, account } = launch(disk);
    await ready(outbox);
    await expect(outbox.enqueue({ workspaceId: "ws-1", write: post("Hi") })).rejects.toEqual(
      new OutboxError("closed"),
    );
    account.signIn(testServer());
    await expect(outbox.enqueue({ workspaceId: "ws-1", write: react() })).rejects.toEqual(
      new OutboxError("invalid"),
    );
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
    expect(calls.map((call) => call.body)).toEqual([
      { operationId: a.operationId, threadId: "thread-1", body: "A" },
      { operationId: c.operationId, threadId: "thread-2", body: "C" },
    ]);
    calls[0]?.answer(SAVED("thread-1", "message-a"));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]?.body).toEqual({ operationId: b.operationId, threadId: "thread-1", body: "B" });
    expect(record(second.outbox, 1)?.stage).toBe("saved");
    second.stop();
  });

  it("puts a waiting reply in its saved parent's thread before anything starts, so a later reply there can't pass it", async () => {
    const disk = durableDisk();
    placeRecord(disk, 1, {
      operationId: "op-parent",
      write: post("Plans"),
      target: { kind: "stream", id: "group-1" },
      stage: "saved",
      attempted: true,
      result: { kind: "saved", threadId: "thread-t", messageId: "message-p" },
    });
    placeRecord(disk, 2, { operationId: "op-b", write: reply("B", null), dependsOn: "op-parent" });
    placeRecord(disk, 3, {
      operationId: "op-c",
      write: reply("C", "thread-t"),
      target: { kind: "thread", id: "thread-t" },
    });
    const server = testServer();
    const calls = answerLater(server, "reply");
    const { stop } = launch(disk, server);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await settled();
    expect(calls.map((call) => call.body)).toEqual([
      { operationId: "op-b", threadId: "thread-t", body: "B" },
    ]);
    calls[0]?.answer(SAVED("thread-t", "message-b"));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.body).toEqual({ operationId: "op-c", threadId: "thread-t", body: "C" });
    stop();
  });

  it("holds a reaction behind the unfinished reply in its message's thread", async () => {
    const disk = durableDisk();
    const server = testServer();
    const replies = answerLater(server, "reply");
    server.on("POST", path("react"), SAVED("thread-1"));
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);
    await outbox.enqueue({ workspaceId: "ws-1", write: reply("First") });
    const reaction = await outbox.enqueue({
      workspaceId: "ws-1",
      write: react(),
      thread: "thread-1",
    });
    expect(reaction.target).toEqual({ kind: "thread", id: "thread-1" });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    await settled();
    expect(requests(server, "react")).toHaveLength(0);
    replies[0]?.answer(SAVED("thread-1", "message-r"));
    await vi.waitFor(() =>
      expect(requests(server, "react")).toEqual([
        { operationId: reaction.operationId, messageId: "message-x", emoji: "👍", state: "added" },
      ]),
    );
    stop();
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
    const child = await outbox.enqueue({
      workspaceId: "ws-1",
      write: reply("Noon works", null),
      dependsOn: parent.operationId,
    });
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    await settled();
    expect(replies).toHaveLength(0);

    // The send joined a running conversation, not a thread of its own.
    sends[0]?.answer(SAVED("thread-running", "message-s"));
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]?.body).toEqual({
      operationId: child.operationId,
      threadId: "thread-running",
      body: "Noon works",
    });
    expect(onDisk(disk, 2)).toMatchObject({
      write: { args: { threadId: "thread-running" } },
      target: { kind: "thread", id: "thread-running" },
    });
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
    await outbox.enqueue({
      workspaceId: "ws-1",
      write: reply("First", null),
      dependsOn: parent.operationId,
    });
    await outbox.enqueue({
      workspaceId: "ws-1",
      write: reply("Second", null),
      dependsOn: parent.operationId,
    });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    posts[0]?.answer(REFUSED("Couldn't send"));

    const refusal = {
      kind: "refused",
      reason: "The message it replies to wasn't sent",
      threadId: null,
      winnerMessageId: null,
    };
    await vi.waitFor(() => expect(stages(outbox)).toEqual(["refused", "refused", "refused"]));
    expect(outbox.state().records.slice(1)).toEqual([
      expect.objectContaining({ write: reply("First", null), result: refusal, attempted: false }),
      expect.objectContaining({ write: reply("Second", null), result: refusal, attempted: false }),
    ]);
    expect(requests(server, "reply")).toHaveLength(0);
    stop();

    const relaunch = launch(disk);
    await ready(relaunch.outbox);
    expect(
      relaunch.outbox
        .state()
        .records.map((entry) => entry.result?.kind === "refused" && entry.result.reason),
    ).toEqual([
      "Couldn't send",
      "The message it replies to wasn't sent",
      "The message it replies to wasn't sent",
    ]);
  });

  it("refuse a reply without its thread that names no outbox post or send", async () => {
    const disk = durableDisk();
    const server = testServer();
    const { outbox } = launch(disk, server);
    await ready(outbox);
    await expect(
      outbox.enqueue({ workspaceId: "ws-1", write: reply("Hi", null), dependsOn: "op-unknown" }),
    ).rejects.toEqual(new OutboxError("invalid"));
    await expect(outbox.enqueue({ workspaceId: "ws-1", write: reply("Hi", null) })).rejects.toEqual(
      new OutboxError("invalid"),
    );
    expect(disk.names()).toEqual([]);
  });

  it("try a failed thread binding again with backoff and at wake, and keep the parent until the reply has its thread", async () => {
    const disk = durableDisk();
    placeRecord(disk, 1, {
      operationId: "op-parent",
      write: post("Plans"),
      target: { kind: "stream", id: "group-1" },
      stage: "saved",
      attempted: true,
      messageId: "message-p",
      result: { kind: "saved", threadId: "thread-t", messageId: "message-p" },
    });
    placeRecord(disk, 2, {
      operationId: "op-child",
      write: reply("Yes", null),
      dependsOn: "op-parent",
    });
    disk.failWrites = "write";
    const server = testServer();
    const replies = answerLater(server, "reply");
    const { outbox, wait, stop } = launch(disk, server);
    await ready(outbox);
    await vi.waitFor(() => expect(wait.pending).toHaveLength(1));
    // A read shows the parent, but the reply still needs its thread from it.
    outbox.handoff(ME, "ws-1", [message("message-p")]);
    await settled();
    expect(outbox.state().records).toHaveLength(2);
    expect(replies).toHaveLength(0);

    disk.failWrites = null;
    outbox.wake();
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]?.body).toEqual({
      operationId: "op-child",
      threadId: "thread-t",
      body: "Yes",
    });
    outbox.handoff(ME, "ws-1", [message("message-p")]);
    await vi.waitFor(() =>
      expect(outbox.state().records.map((entry) => entry.operationId)).toEqual(["op-child"]),
    );
    stop();
  });

  it("give a reply its saved parent's thread when it's enqueued, even if a read hands the parent off first", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), SAVED("thread-p"));
    server.on("POST", path("send"), held);
    const replies = answerLater(server, "reply");
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);
    const parent = await outbox.enqueue({ workspaceId: "ws-1", write: post("Plans") });
    await vi.waitFor(() => expect(record(outbox, 1)?.stage).toBe("saved"));

    // Another write holds the queue, a read queues the parent's handoff, then the reply comes.
    const release = disk.holdWrites();
    const other = outbox.enqueue({ workspaceId: "ws-1", write: send("Elsewhere") });
    await vi.waitFor(() => expect(temporaries(disk)).toHaveLength(1));
    outbox.handoff(ME, "ws-1", [message(parent.messageId ?? "")]);
    const child = outbox.enqueue({
      workspaceId: "ws-1",
      write: reply("Me too", null),
      dependsOn: parent.operationId,
    });
    release();
    await other;
    await expect(child).resolves.toMatchObject({
      write: { args: { threadId: "thread-p" } },
      target: { kind: "thread", id: "thread-p" },
    });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]?.body).toMatchObject({ threadId: "thread-p", body: "Me too" });
    expect(record(outbox, 1)).toBeUndefined();
    stop();
  });
});

describe("asking again", () => {
  it("re-asks after offline, busy, unreadable and pending answers with the same ID and arguments", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on(
      "POST",
      path("reply"),
      "offline",
      { status: 503 },
      { status: 200, body: { ok: true } },
      { status: 500 },
      PENDING,
      SAVED("thread-1", "message-r"),
    );
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);
    const queued = await outbox.enqueue({ workspaceId: "ws-1", write: reply("Hi") });
    await vi.waitFor(() => {
      outbox.wake();
      expect(record(outbox, 1)?.stage).toBe("saved");
    });
    const sent = requests(server, "reply");
    expect(sent).toHaveLength(6);
    for (const body of sent)
      expect(body).toEqual({ operationId: queued.operationId, threadId: "thread-1", body: "Hi" });
    expect(record(outbox, 1)).toMatchObject({
      result: { kind: "saved", threadId: "thread-1", messageId: "message-r" },
      pendingSinceMs: null,
    });
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
    expect(onDisk(disk, 1)).toMatchObject({ stage: "sending", attempted: true });

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
    const { outbox, stop, wait } = launch(disk, server, {
      now: () => clock,
      stalledAfterMs: 1000,
      stalledRetryMs: 7000,
      retryMs: (failures) => failures * 10,
    });
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

  it("counts only continuous pending answers toward stalled: a failed request starts the count again", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), PENDING, "offline", PENDING, "offline", PENDING);
    let clock = 0;
    const { outbox, stop, wait } = launch(disk, server, {
      now: () => clock,
      stalledAfterMs: 1000,
      retryMs: () => 10,
    });
    await ready(outbox);
    await outbox.enqueue({ workspaceId: "ws-1", write: post("Hi") });
    await vi.waitFor(() => expect(wait.pending).toHaveLength(1));
    expect(record(outbox, 1)?.pendingSinceMs).toBe(0);

    wait.release();
    await vi.waitFor(() => expect(wait.pending).toHaveLength(1));
    expect(record(outbox, 1)).toMatchObject({ stage: "sending", pendingSinceMs: null });

    // An hour offline, then pending again: a new run, not a stalled write.
    clock = 3_600_000;
    wait.release();
    await vi.waitFor(() => expect(wait.pending).toHaveLength(1));
    expect(record(outbox, 1)).toMatchObject({ stage: "sending", pendingSinceMs: 3_600_000 });

    // Offline again, and this time the reset can't be written, so the record keeps the old start.
    disk.failWrites = "write";
    wait.release();
    await vi.waitFor(() => expect(wait.pending).toHaveLength(1));
    expect(record(outbox, 1)?.pendingSinceMs).toBe(3_600_000);
    // Storage comes back, an hour passes, and pending resumes: still a new run.
    disk.failWrites = null;
    clock = 7_200_000;
    wait.release();
    await vi.waitFor(() => expect(record(outbox, 1)?.pendingSinceMs).toBe(7_200_000));
    expect(record(outbox, 1)?.stage).toBe("sending");
    stop();
  });

  it("settles a write the route refuses as malformed or too large, keeping its text", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), {
      status: 413,
      body: { ok: false, code: "payload_too_large" },
    });
    server.on("POST", path("send"), { status: 400, body: { ok: false, code: "bad_request" } });
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);
    await outbox.enqueue({ workspaceId: "ws-1", write: post("Long") });
    await outbox.enqueue({ workspaceId: "ws-1", write: send("Odd") });
    await vi.waitFor(() => expect(stages(outbox)).toEqual(["refused", "refused"]));
    expect(outbox.state().records.map((entry) => entry.result)).toEqual([
      { kind: "refused", reason: "Couldn't send", threadId: null, winnerMessageId: null },
      { kind: "refused", reason: "Couldn't send", threadId: null, winnerMessageId: null },
    ]);
    outbox.wake();
    await settled();
    expect(server.calls).toHaveLength(2);
    expect(records(disk)).toHaveLength(2);
    stop();
  });

  it("keeps too old, already answered and missing as settled, with the text, and the published reply's own ID", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), REFUSED("too old"));
    server.on(
      "POST",
      path("reply"),
      REFUSED("already answered", { threadId: "thread-1", winnerMessageId: "message-w" }),
    );
    server.on(
      "POST",
      path("react"),
      ops({ ok: false, refusal: "missing", reason: "Message not found" }),
    );
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);
    const answer: ChatWrite = {
      operation: "reply",
      args: { threadId: "thread-1", body: "Friday", resolves: { messageId: "message-q" } },
    };
    await outbox.enqueue({ workspaceId: "ws-1", write: post("Old") });
    const answered = await outbox.enqueue({ workspaceId: "ws-1", write: answer });
    await outbox.enqueue({ workspaceId: "ws-1", write: react(), thread: "thread-x" });
    await vi.waitFor(() => expect(stages(outbox)).toEqual(["refused", "refused", "refused"]));
    expect(outbox.state().records.map((entry) => entry.result)).toEqual([
      { kind: "refused", reason: "too old", threadId: null, winnerMessageId: null },
      {
        kind: "refused",
        reason: "already answered",
        threadId: "thread-1",
        winnerMessageId: "message-w",
      },
      { kind: "missing", reason: "Message not found" },
    ]);
    // The answer's reply published, and a read can find it by its own ID, distinct from the winner.
    expect(record(outbox, 2)).toMatchObject({
      write: { args: { body: "Friday" } },
      messageId: await derivedMessageId("u-1", "ws-1", answered.operationId, answer),
    });
    expect(record(outbox, 2)?.messageId).not.toBe("message-w");
    // Its reply was sent, so Sign out doesn't call it unsent.
    expect(outbox.signOutCounts()).toEqual({ unsent: 2, maySend: 0 });
    outbox.wake();
    await settled();
    expect(server.calls).toHaveLength(3);
    stop();
  });

  it("stops asking for a workspace after repeated 404s, keeping the record uncertain, until a read of it answers", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), NOT_FOUND);
    const { outbox, wait, stop } = launch(disk, server);
    await ready(outbox);
    const queued = await outbox.enqueue({ workspaceId: "ws-1", write: post("Hi") });
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(wait.pending).toHaveLength(1));
      wait.release();
    }
    await vi.waitFor(() => expect(requests(server, "post")).toHaveLength(3));
    await settled();
    expect(wait.pending).toHaveLength(0);
    expect(record(outbox, 1)).toMatchObject({ stage: "sending", operationId: queued.operationId });

    server.on("POST", path("post"), SAVED("thread-p"));
    outbox.handoff(ME, "ws-1", []);
    await vi.waitFor(() => expect(record(outbox, 1)?.stage).toBe("saved"));
    expect(requests(server, "post")[3]).toEqual({
      operationId: queued.operationId,
      groupId: "group-1",
      body: "Hi",
    });
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
    await outbox.enqueue({ workspaceId: "ws-1", write: post("Plans") });
    await outbox.enqueue({ workspaceId: "ws-1", write: react(), thread: "thread-x" });
    await outbox.enqueue({
      workspaceId: "ws-1",
      write: {
        operation: "reply",
        args: { threadId: "thread-1", body: "Friday", resolves: { messageId: "message-q" } },
      },
    });
    await vi.waitFor(() => expect(stages(outbox)).toEqual(["saved", "saved", "saved"]));

    // Reads that don't show the results, or that are another account's or workspace's, keep every record.
    outbox.handoff(ME, "ws-1", [
      message("message-x"),
      message("message-q", { needsDecision: true, decisionState: "open" }),
      message("message-a"),
    ]);
    outbox.handoff({ origin: ORIGIN, userId: "u-2" }, "ws-1", [message("message-p")]);
    outbox.handoff({ origin: "https://other.example.com", userId: "u-1" }, "ws-1", [
      message("message-p"),
    ]);
    outbox.handoff(ME, "ws-2", [message("message-p")]);
    await settled();
    expect(outbox.state().records).toHaveLength(3);
    expect(records(disk)).toHaveLength(3);

    const reaction = {
      emoji: "👍",
      authorId: "u-1",
      authorKind: "human",
      authorName: "Ice",
      atMs: 1,
    } as const;
    outbox.handoff(ME, "ws-1", [
      message("message-p"),
      message("message-x", { reactions: [reaction] }),
      message("message-q", {
        needsDecision: true,
        decisionState: "resolved",
        resolvedByMessageId: "message-a",
      }),
      message("message-a"),
    ]);
    await vi.waitFor(() => expect(outbox.state().records).toEqual([]));
    expect(records(disk)).toEqual([]);
    stop();
  });

  it("matches a reaction by its emoji as the relay stores it, trimmed and in NFC, and sends the arguments as given", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("react"), SAVED("thread-x"));
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);
    const queued = await outbox.enqueue({
      workspaceId: "ws-1",
      write: react(" é "),
      thread: "thread-x",
    });
    await vi.waitFor(() => expect(record(outbox, 1)?.stage).toBe("saved"));
    expect(requests(server, "react")).toEqual([
      { operationId: queued.operationId, messageId: "message-x", emoji: " é ", state: "added" },
    ]);
    outbox.handoff(ME, "ws-1", [
      message("message-x", {
        reactions: [
          { emoji: "é", authorId: "u-1", authorKind: "human", authorName: "Ice", atMs: 1 },
        ],
      }),
    ]);
    await vi.waitFor(() => expect(outbox.state().records).toEqual([]));
    stop();
  });

  it("hands off a write a read showed before its saved answer came, and one recovery finds saved", async () => {
    const disk = durableDisk();
    const server = testServer();
    const posts = answerLater(server, "post");
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);
    const queued = await outbox.enqueue({ workspaceId: "ws-1", write: post("Hello") });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    outbox.handoff(ME, "ws-1", [message(queued.messageId ?? "")]);
    await settled();
    expect(record(outbox, 1)?.stage).toBe("sending");
    posts[0]?.answer(SAVED("thread-p", queued.messageId ?? ""));
    await vi.waitFor(() => expect(outbox.state().records).toEqual([]));
    stop();

    const later = durableDisk();
    placeRecord(later, 1, {
      operationId: "op-p",
      write: post("Plans"),
      target: { kind: "stream", id: "group-1" },
      stage: "saved",
      attempted: true,
      messageId: "message-p",
      result: { kind: "saved", threadId: "thread-p", messageId: "message-p" },
    });
    const relaunch = launch(later, server);
    relaunch.outbox.handoff(ME, "ws-1", [message("message-p")]);
    await ready(relaunch.outbox);
    await vi.waitFor(() => expect(records(later)).toEqual([]));
    relaunch.stop();
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
    await vi.waitFor(() =>
      expect(account.state()).toMatchObject({ status: "signed-out", ended: true }),
    );
    outbox.wake();
    await settled();
    expect(requests(server, "post")).toHaveLength(1);
    expect(outbox.state().records).toEqual([
      expect.objectContaining({
        operationId: queued.operationId,
        stage: "sending",
        attempted: true,
      }),
    ]);
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
    expect(record(outbox, theirs.sequence)).toMatchObject({
      stage: "sending",
      accountId: "u-1",
      origin: a.origin,
    });
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
    await vi.waitFor(() =>
      expect(temporaries(disk).some((name) => name.startsWith("m-000000000001."))).toBe(true),
    );
    const signingOut = account.signOut();
    expect(outbox.state().records).toEqual([]);
    expect(outbox.signOutCounts()).toBeNull();
    release();
    await signingOut;
    expect(disk.names()).toEqual([]);
    expect(outbox.state()).toMatchObject({ status: "ready", records: [] });
    expect(disk.log.lastIndexOf("write m-000000000001")).toBeLessThan(
      disk.log.lastIndexOf("remove m-000000000001"),
    );
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
    const signingOut = account.signOut();
    release();
    await expect(enqueuing).rejects.toEqual(new OutboxError("closed"));
    await signingOut;
    expect(disk.names()).toEqual([]);
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
    const signingOut = account.signOut();
    calls[0]?.answer(SAVED("thread-p", "message-p"));
    await signingOut;
    await settled();
    expect(disk.names()).toEqual([]);
    expect(outbox.state().records).toEqual([]);
    expect(server.calls[0]?.signal.aborted).toBe(true);
  });

  it("keeps the outbox closed when its delete fails, sends nothing on the next sign-in, and finishes at wake", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), held);
    const { outbox, account, stop } = launch(disk, server);
    await ready(outbox);
    await outbox.enqueue({ workspaceId: "ws-1", write: post("Hello") });
    await vi.waitFor(() => expect(requests(server, "post")).toHaveLength(1));

    disk.failRemoves = "unlink";
    await account.signOut();
    expect(outbox.state().status).toBe("failed");
    expect(outbox.signOutCounts()).toBeNull();
    expect(disk.names()).toEqual(expect.arrayContaining(["signing-out", "m-000000000001"]));

    account.signIn(server);
    outbox.wake();
    await settled();
    expect(outbox.state()).toMatchObject({ status: "failed", records: [] });
    await expect(outbox.enqueue({ workspaceId: "ws-1", write: post("No") })).rejects.toEqual(
      new OutboxError("closed"),
    );
    expect(requests(server, "post")).toHaveLength(1);

    disk.failRemoves = null;
    outbox.wake();
    await ready(outbox);
    expect(disk.names()).toEqual([]);
    expect(outbox.signOutCounts()).toEqual({ unsent: 0, maySend: 0 });
    expect(requests(server, "post")).toHaveLength(1);
    stop();
  });

  it("finishes a delete a closed app left mid-way before reading anything at the next launch", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), held);
    const first = launch(disk, server);
    await ready(first.outbox);
    await first.outbox.enqueue({ workspaceId: "ws-1", write: post("Hello") });
    await vi.waitFor(() => expect(requests(server, "post")).toHaveLength(1));
    disk.failRemoves = "unlink";
    await first.account.signOut();
    disk.crash();
    disk.failRemoves = null;

    // The token survived, so the next launch signs in, but the marker means the delete comes first.
    const second = launch(disk, server);
    await ready(second.outbox);
    expect(disk.names()).toEqual([]);
    expect(second.outbox.state().records).toEqual([]);
    await settled();
    expect(requests(server, "post")).toHaveLength(1);
    second.stop();
  });

  it("deletes after a 401 too, from the account's own Sign out, while a launch with no sign-in keeps the records", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on("POST", path("post"), { status: 401, body: { ok: false } });
    server.on("GET", "/sync/account/sessions", "offline");
    const outbox = createOutbox({ files: createDurableFiles(disk.launch()), sleep: waits().sleep });
    const account = createAccount({
      store: memoryStore({
        origin: server.origin,
        token: "tok-1",
        userId: "u-1",
        email: "ice@example.com",
      }).store,
      fetch: server.fetch,
      onSignOut: (leave) => outbox.signOut(leave),
    });
    const stop = outbox.follow(account);
    await account.restore();
    await ready(outbox);
    await outbox.enqueue({ workspaceId: "ws-1", write: post("Hello") });
    await vi.waitFor(() =>
      expect(account.state()).toMatchObject({ status: "signed-out", ended: true }),
    );
    expect(records(disk)).toHaveLength(1);

    const relaunched = createOutbox({
      files: createDurableFiles(disk.launch()),
      sleep: waits().sleep,
    });
    const signedOut = createAccount({
      store: memoryStore(null).store,
      fetch: server.fetch,
      onSignOut: (leave) => relaunched.signOut(leave),
    });
    const stopRelaunched = relaunched.follow(signedOut);
    await signedOut.restore();
    await ready(relaunched);
    expect(relaunched.state().records).toHaveLength(1);
    stopRelaunched();

    await account.signOut();
    expect(disk.names()).toEqual([]);
    expect(outbox.state()).toMatchObject({ status: "ready", records: [] });
    stop();
  });

  it("counts what it would delete, and nothing while it can't read the records", async () => {
    const disk = durableDisk();
    disk.files.set("m-000000000009", "not a record");
    const server = testServer();
    server.on("POST", path("reply"), held);
    server.on("POST", path("post"), REFUSED("Couldn't send"));
    const { outbox, stop } = launch(disk, server);
    expect(outbox.signOutCounts()).toBeNull();
    await ready(outbox);
    await outbox.enqueue({ workspaceId: "ws-1", write: reply("Sending") });
    await outbox.enqueue({ workspaceId: "ws-1", write: reply("Waiting behind it") });
    await outbox.enqueue({ workspaceId: "ws-1", write: post("Refused") });
    await vi.waitFor(() => expect(stages(outbox)).toEqual(["sending", "queued", "refused"]));
    // The unreadable record counts as unsent too: Sign out deletes it.
    expect(outbox.signOutCounts()).toEqual({ unsent: 3, maySend: 1 });
    stop();

    expect(accountWords.signOutBody({ unsent: 3, maySend: 1 })).toBe(
      "3 messages haven't been sent. Signing out deletes them. 1 message may still send.",
    );
    expect(accountWords.signOutBody({ unsent: 1, maySend: 0 })).toBe(
      "1 message hasn't been sent. Signing out deletes it.",
    );
    expect(accountWords.signOutBody({ unsent: 0, maySend: 2 })).toBe("2 messages may still send.");
    expect(accountWords.signOutBody({ unsent: 0, maySend: 0 })).toBe(
      "This phone stops reading your workspaces. Your work stays where it is.",
    );
  });
});

describe("recovery", () => {
  it("keeps unreadable records and other files aside, and never deletes them", async () => {
    const disk = durableDisk();
    disk.files.set("m-000000000003", "{ broken");
    disk.files.set("m-000000000004", "{}");
    disk.unreadable.add("m-000000000004");
    disk.files.set("probe-1", "someone else's");
    disk.files.set(`m-000000000005.${"0".repeat(32)}.tmp`, '{"format":');
    const server = testServer();
    server.on("POST", path("post"), held);
    const first = launch(disk, server);
    await ready(first.outbox);
    expect(first.outbox.state()).toMatchObject({
      records: [],
      aside: [
        "m-000000000003",
        "m-000000000004",
        `m-000000000005.${"0".repeat(32)}.tmp`,
        "probe-1",
      ],
    });
    const queued = await first.outbox.enqueue({ workspaceId: "ws-1", write: post("After") });
    expect(queued.sequence).toBe(5);
    first.stop();

    const second = launch(disk);
    await ready(second.outbox);
    expect(second.outbox.state().aside).toHaveLength(4);
    expect(disk.names()).toEqual(
      expect.arrayContaining([
        "m-000000000003",
        "m-000000000004",
        "probe-1",
        `m-000000000005.${"0".repeat(32)}.tmp`,
      ]),
    );
    expect(
      disk.log.some((entry) => entry.startsWith("remove") || entry.startsWith("removeLeftover")),
    ).toBe(false);
  });

  it("waits for the phone's first unlock before reading, deletes nothing meanwhile, and counts nothing", async () => {
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
    expect(second.outbox.signOutCounts()).toBeNull();
    await expect(second.outbox.enqueue({ workspaceId: "ws-1", write: post("No") })).rejects.toEqual(
      new OutboxError("closed"),
    );
    second.outbox.wake();
    await vi.waitFor(() => expect(second.outbox.state().status).toBe("locked"));

    disk.locked = false;
    second.outbox.wake();
    await ready(second.outbox);
    expect(second.outbox.state().records).toEqual([
      expect.objectContaining({ sequence: 1, stage: "sending" }),
    ]);
    await vi.waitFor(() => expect(requests(server, "post")).toHaveLength(2));
    expect(records(disk)).toEqual(["m-000000000001"]);
    second.stop();
  });
});

describe("signing out with the account's token store", () => {
  /** A signed-in run with one queued record whose request the server holds. */
  async function signedInWithRecord(disk: Disk, server: Server, store: SignInStore) {
    server.on("POST", path("post"), held);
    const run = launchReal(disk, server, store);
    await run.account.restore();
    await ready(run.outbox);
    await run.outbox.enqueue({ workspaceId: "ws-1", write: post("Hello") });
    await vi.waitFor(() => expect(requests(server, "post")).toHaveLength(1));
    return run;
  }

  it("writes the marker, then deletes the token, then the records, then the marker", async () => {
    const disk = durableDisk();
    const server = testServer();
    const tokens = memoryStore(SIGNED_IN);
    let atClear: string[] = [];
    const store: SignInStore = {
      load: () => tokens.store.load(),
      save: (next) => tokens.store.save(next),
      clear: async () => {
        atClear = disk.names();
        await tokens.store.clear();
      },
    };
    const first = await signedInWithRecord(disk, server, store);
    await first.account.signOut();
    expect(atClear).toEqual(expect.arrayContaining(["signing-out", "m-000000000001"]));
    expect(tokens.current()).toBeNull();
    expect(disk.names()).toEqual([]);
    first.stop();

    const next = launchReal(disk, server, tokens.store);
    await next.account.restore();
    await ready(next.outbox);
    expect(next.account.state().status).toBe("signed-out");
    expect(next.outbox.state().records).toEqual([]);
    next.stop();
  });

  it("completes when the marker can't be written but every record goes, and a later sign-in sends nothing", async () => {
    const disk = durableDisk();
    const server = testServer();
    const tokens = memoryStore(SIGNED_IN);
    const first = await signedInWithRecord(disk, server, tokens.store);
    disk.failWrites = "write";
    await first.account.signOut();
    expect(first.account.state()).toMatchObject({ status: "signed-out", ended: false });
    expect(tokens.current()).toBeNull();
    expect(disk.names()).toEqual([]);
    first.stop();
    disk.failWrites = null;

    const again = launchReal(disk, server, memoryStore(SIGNED_IN).store);
    await again.account.restore();
    await ready(again.outbox);
    await settled();
    expect(again.outbox.state().records).toEqual([]);
    expect(requests(server, "post")).toHaveLength(1);
    again.stop();
  });

  it("fails, keeping the sign-in, the token and the records, paused, when neither the marker nor every delete lands", async () => {
    const disk = durableDisk();
    const server = testServer();
    const tokens = memoryStore(SIGNED_IN);
    const first = await signedInWithRecord(disk, server, tokens.store);
    disk.failWrites = "write";
    disk.failRemoves = "unlink";
    const error = await first.account.signOut().catch((reason: unknown) => reason);
    expect(error instanceof OutboxError && error.kind).toBe("not-deleted");
    expect(first.account.state().status).toBe("signed-in");
    expect(tokens.current()).toEqual(SIGNED_IN);
    expect(records(disk)).toEqual(["m-000000000001"]);
    expect(first.outbox.state()).toMatchObject({
      status: "ready",
      records: [expect.objectContaining({ sequence: 1 })],
    });
    expect(first.outbox.signOutCounts()).toEqual({ unsent: 0, maySend: 1 });
    first.outbox.wake();
    await settled();
    expect(requests(server, "post")).toHaveLength(1);

    // Try again, once the deletes work.
    disk.failRemoves = null;
    await first.account.signOut();
    expect(first.account.state().status).toBe("signed-out");
    expect(tokens.current()).toBeNull();
    expect(disk.names()).toEqual([]);
    first.stop();
  });

  it("keeps only the sign-in when the app closes after the marker and before the token goes", async () => {
    const disk = durableDisk();
    const server = testServer();
    const tokens = memoryStore(SIGNED_IN);
    const gate = deferred<void>();
    const store: SignInStore = {
      load: () => tokens.store.load(),
      save: (next) => tokens.store.save(next),
      clear: async () => {
        await gate.promise;
        await tokens.store.clear();
      },
    };
    const first = await signedInWithRecord(disk, server, store);
    void first.account.signOut();
    await vi.waitFor(() => expect(first.account.state().status).toBe("signed-out"));
    expect(disk.files.has("signing-out")).toBe(true);
    expect(tokens.current()).toEqual(SIGNED_IN);
    disk.crash();

    const second = launchReal(disk, server, tokens.store);
    await second.account.restore();
    expect(second.account.state().status).toBe("signed-in");
    await ready(second.outbox);
    expect(disk.names()).toEqual([]);
    await settled();
    expect(requests(server, "post")).toHaveLength(1);
    second.stop();
  });

  it("finishes the delete at the next launch when the app closes after the token went, and a new sign-in sends nothing", async () => {
    const disk = durableDisk();
    const server = testServer();
    const tokens = memoryStore(SIGNED_IN);
    const first = await signedInWithRecord(disk, server, tokens.store);
    disk.failRemoves = "unlink";
    await first.account.signOut();
    expect(tokens.current()).toBeNull();
    expect(disk.names()).toEqual(expect.arrayContaining(["signing-out", "m-000000000001"]));
    disk.crash();
    disk.failRemoves = null;

    const second = launchReal(disk, server, tokens.store);
    await second.account.restore();
    await ready(second.outbox);
    expect(second.account.state().status).toBe("signed-out");
    expect(disk.names()).toEqual([]);
    second.stop();

    const third = launchReal(disk, server, memoryStore(SIGNED_IN).store);
    await third.account.restore();
    await ready(third.outbox);
    await settled();
    expect(requests(server, "post")).toHaveLength(1);
    third.stop();
  });

  it("shows the cautious sheet text when the records couldn't be read", async () => {
    const disk = durableDisk();
    const files = createDurableFiles(disk.launch());
    const failing = {
      ...files,
      list: () => Promise.reject(new DurableFileError("failed", "Input/output error")),
    };
    const { outbox, stop } = launchReal(disk, testServer(), memoryStore(SIGNED_IN).store, failing);
    await vi.waitFor(() => expect(outbox.state().status).toBe("failed"));
    expect(outbox.signOutCounts()).toBeNull();
    expect(accountWords.signOutBody(outbox.signOutCounts())).toBe(
      "dohc could not check this phone for unsent messages. Signing out deletes any it has.",
    );
    stop();
  });
});

describe("fault schedules", () => {
  it("holds a later reply in the thread while an earlier one is still taking its thread", async () => {
    const disk = durableDisk();
    placeRecord(disk, 1, {
      operationId: "op-parent",
      write: post("Plans"),
      target: { kind: "stream", id: "group-1" },
      stage: "saved",
      attempted: true,
      result: { kind: "saved", threadId: "thread-t", messageId: "message-p" },
    });
    placeRecord(disk, 2, { operationId: "op-b", write: reply("B", null), dependsOn: "op-parent" });
    placeRecord(disk, 3, {
      operationId: "op-c",
      write: reply("C", "thread-t"),
      target: { kind: "thread", id: "thread-t" },
    });
    const server = testServer();
    const calls = answerLater(server, "reply");
    const release = disk.holdWrites();
    const { stop } = launch(disk, server);
    await vi.waitFor(() =>
      expect(temporaries(disk).some((name) => name.startsWith("m-000000000002."))).toBe(true),
    );
    await settled();
    expect(calls).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ operationId: "op-b", threadId: "thread-t", body: "B" });
    stop();
  });

  it("refuses a waiting reply after a failed refusal write, with backoff and at wake, and never sends it", async () => {
    const disk = durableDisk();
    placeRecord(disk, 1, {
      operationId: "op-parent",
      write: post("Plans"),
      target: { kind: "stream", id: "group-1" },
      stage: "refused",
      attempted: true,
      result: { kind: "refused", reason: "Couldn't send", threadId: null, winnerMessageId: null },
    });
    placeRecord(disk, 2, {
      operationId: "op-child",
      write: reply("Yes", null),
      dependsOn: "op-parent",
    });
    disk.failWrites = "write";
    const server = testServer();
    server.on("POST", path("reply"), held);
    const { outbox, wait, stop } = launch(disk, server);
    await ready(outbox);
    await vi.waitFor(() => expect(wait.pending).toHaveLength(1));
    expect(record(outbox, 2)?.stage).toBe("queued");

    disk.failWrites = null;
    outbox.wake();
    await vi.waitFor(() =>
      expect(record(outbox, 2)).toMatchObject({
        stage: "refused",
        result: { reason: "The message it replies to wasn't sent" },
      }),
    );
    expect(onDisk(disk, 2)).toMatchObject({ stage: "refused" });
    await settled();
    expect(requests(server, "reply")).toHaveLength(0);
    stop();
  });

  it("forgets the oldest observation past 1000 messages, and never reuses observations from another account or workspace", async () => {
    const disk = durableDisk();
    const server = testServer();
    const posts = answerLater(server, "post");
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);

    const first = await outbox.enqueue({ workspaceId: "ws-1", write: post("First") });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    outbox.handoff(ME, "ws-1", [message(first.messageId ?? "")]);
    outbox.handoff(
      ME,
      "ws-1",
      Array.from({ length: 1000 }, (_, i) => message(`other-${i}`)),
    );
    posts[0]?.answer(SAVED("thread-1"));
    await vi.waitFor(() => expect(record(outbox, first.sequence)?.stage).toBe("saved"));
    await settled();
    expect(record(outbox, first.sequence)).toBeDefined();
    outbox.handoff(ME, "ws-1", [message(first.messageId ?? "")]);
    await vi.waitFor(() => expect(record(outbox, first.sequence)).toBeUndefined());

    const second = await outbox.enqueue({ workspaceId: "ws-1", write: post("Second") });
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    outbox.handoff(ME, "ws-1", [message(second.messageId ?? "")]);
    // The person opens another workspace, then another account's read comes: neither keeps the first read.
    outbox.handoff(ME, "ws-2", []);
    posts[1]?.answer(SAVED("thread-2"));
    await vi.waitFor(() => expect(record(outbox, second.sequence)?.stage).toBe("saved"));
    outbox.handoff({ origin: ORIGIN, userId: "u-2" }, "ws-1", []);
    await settled();
    expect(record(outbox, second.sequence)).toBeDefined();
    outbox.handoff(ME, "ws-1", [message(second.messageId ?? "")]);
    await vi.waitFor(() => expect(record(outbox, second.sequence)).toBeUndefined());
    stop();
  });

  it("keeps a parent saved while its reply was accepted ahead of the parent's handoff, until the reply takes its thread", async () => {
    const disk = durableDisk();
    const server = testServer();
    const posts = answerLater(server, "post");
    server.on("POST", path("send"), held);
    const replies = answerLater(server, "reply");
    const { outbox, stop } = launch(disk, server);
    await ready(outbox);
    const parent = await outbox.enqueue({ workspaceId: "ws-1", write: post("Plans") });
    await vi.waitFor(() => expect(posts).toHaveLength(1));

    // The reply is queued while the parent is still sending, then the parent's answer and a read showing it arrive.
    const release = disk.holdWrites();
    const other = outbox.enqueue({ workspaceId: "ws-1", write: send("Elsewhere") });
    await vi.waitFor(() => expect(temporaries(disk)).toHaveLength(1));
    const child = outbox.enqueue({
      workspaceId: "ws-1",
      write: reply("Me too", null),
      dependsOn: parent.operationId,
    });
    posts[0]?.answer(SAVED("thread-p", parent.messageId ?? ""));
    outbox.handoff(ME, "ws-1", [message(parent.messageId ?? "")]);
    release();
    await other;
    await expect(child).resolves.toMatchObject({ target: null });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]?.body).toMatchObject({ threadId: "thread-p", body: "Me too" });
    expect(record(outbox, parent.sequence)?.stage).toBe("saved");
    stop();
  });

  it("counts 404s only in a row: another answer between them starts the count again", async () => {
    const disk = durableDisk();
    const server = testServer();
    server.on(
      "POST",
      path("post"),
      NOT_FOUND,
      NOT_FOUND,
      { status: 503 },
      NOT_FOUND,
      NOT_FOUND,
      NOT_FOUND,
    );
    const { outbox, wait, stop } = launch(disk, server);
    await ready(outbox);
    await outbox.enqueue({ workspaceId: "ws-1", write: post("Hi") });
    for (let i = 0; i < 5; i++) {
      await vi.waitFor(() => expect(wait.pending).toHaveLength(1));
      wait.release();
    }
    await vi.waitFor(() => expect(requests(server, "post")).toHaveLength(6));
    await settled();
    expect(wait.pending).toHaveLength(0);
    stop();
  });
});
