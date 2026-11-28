import { describe, expect, it, vi } from "vitest";
import type { FieldChange } from "../../modules/chat-composer";
import type { AccountState, SignIn } from "../server/account";
import type { ChatWrite } from "../server/chatWrites";
import { createServerClient } from "../server/client";
import { createOutbox, OutboxError, type Outbox, type OutboxState } from "../server/outbox";
import { phoneWrites } from "../server/phoneWrites";
import { keptDisk } from "../server/testKeptDisk";
import { deferred, testServer, type Answer } from "../server/testServer";
import {
  blockedBy,
  chatWrite,
  clearedBy,
  clearSent,
  clearStatus,
  closePost,
  createConversationWrites,
  createWriteScope,
  fieldChanged,
  groupForStream,
  joinedGroupLanes,
  lanesOf,
  replyParentGone,
  replyWrite,
  routeReply,
  threadReplyTarget,
  writableJoinedThread,
  type Draft,
  type WriteActivation,
  type WriteOutbox,
} from "./conversationWrites";
import {
  askReplacement,
  latestSnapshot,
  NO_REPLACING,
  replacementAnswered,
  type Replacing,
} from "./mentionDraft";

/** A report from the native field: an edit at `revision`, with the caret at the text's end, unless `fields` say more. */
const fieldReport = (
  text: string,
  revision: number,
  sequence: number,
  fields: Partial<FieldChange> = {},
): FieldChange => ({
  text,
  revision,
  sequence,
  selectionStart: text.length,
  selectionEnd: text.length,
  cleared: 0,
  refused: 0,
  ...fields,
});

type Server = ReturnType<typeof testServer>;
type Disk = ReturnType<typeof keptDisk>;

// A thread opened from a Notice's Reply chooses the message the Notice named. If that message is gone by the time the
// thread's read answers, the reply must never go to the thread's top instead.
describe("where a thread's composer replies", () => {
  const shown = [{ id: "m1" }, { id: "m2" }];

  it("replies under a chosen message the read shows, and at the top with none chosen", () => {
    expect(threadReplyTarget("t1", "m2", shown)).toEqual({
      kind: "thread",
      threadId: "t1",
      parentMessageId: "m2",
    });
    expect(threadReplyTarget("t1", null, shown)).toEqual({
      kind: "thread",
      threadId: "t1",
      parentMessageId: null,
    });
  });

  it("has no target for a chosen message the read doesn't show, so nothing goes to the thread's top", () => {
    expect(threadReplyTarget("t1", "gone", shown)).toBeNull();
    expect(threadReplyTarget("t1", "m1", [])).toBeNull();
  });

  it("never carries resolves on an ordinary reply", () => {
    const target = threadReplyTarget("t1", "m1", shown);
    const reply = target && replyWrite(target, "On it");
    expect(reply?.write).toEqual({
      operation: "reply",
      args: { threadId: "t1", body: "On it", parentMessageId: "m1" },
    });
  });
});

// The relay refuses a write to a workspace that isn't the one open, but the phone never builds one.
describe("a thread opened to reply", () => {
  it("chooses the route's message when the route names the open workspace", () => {
    expect(routeReply("m1", "ws-1", "ws-1")).toBe("m1");
  });

  it("chooses nothing for a route that names another workspace, or none", () => {
    expect(routeReply("m1", "ws-2", "ws-1")).toBeNull();
    expect(routeReply("m1", undefined, "ws-1")).toBeNull();
    expect(routeReply("m1", "ws-1", null)).toBeNull();
  });

  it("chooses nothing without a reply", () => {
    expect(routeReply(undefined, "ws-1", "ws-1")).toBeNull();
  });
});

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
  unreadable: [],
  deletion: "none",
  unconfirmed: [],
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
        accountName: async () => "Ice",
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
    store: disk.launch(),
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
  it("holds every write while a Sign out's delete has failed, whatever the read says", () => {
    expect(blockedBy({ ...READY, deletion: "failed" }, true)).toBe("deleting");
  });

  it("waits for the records to be read", () => {
    for (const status of ["loading", "locked", "failed", "damaged"] as const)
      expect(blockedBy({ ...READY, status }, true)).toBe(status);
    expect(blockedBy(READY, true)).toBeNull();
  });

  it("asks the outbox nothing while a delete has failed", async () => {
    const { outbox, asked } = fakeOutbox({ ...READY, deletion: "failed" });
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
    const disk = keptDisk();
    const server = testServer();
    server.on("POST", "/sync/ws-1/ops/send", SAVED);
    const outbox = launch(disk, server);
    await ready(outbox);
    const release = disk.holdCommits();
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
    const disk = keptDisk();
    const outbox = launch(disk, testServer());
    await ready(outbox);
    disk.failWrites = /./;
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
    const disk = keptDisk();
    const server = testServer();
    server.on("POST", "/sync/ws-1/ops/send", SAVED);
    disk.sql(
      "INSERT INTO outbox (origin, account_id, record) VALUES (?, 'u-1', ?)",
      ORIGIN,
      JSON.stringify({
        format: 1,
        origin: ORIGIN,
        accountId: "u-1",
        workspaceId: "ws-1",
        operationId: "op-kept",
        messageId: "message-kept",
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

describe("a sent draft", () => {
  const sent: Draft = {
    text: "A",
    textRevision: 5,
    title: "Plan",
    titleRevision: 2,
    chosen: "post",
    chosenRevision: 1,
  };
  // What the native field reports when it clears the body sent: its next revision.
  const fieldCleared = (draft: Draft): Draft => ({
    ...draft,
    text: "",
    textRevision: sent.textRevision + 1,
  });
  const keptAndCleared = (current: Draft) =>
    closePost(fieldCleared(clearSent(current, sent)), sent);

  it("empties the title, then closes New post once the field clears, when nothing changed meanwhile", () => {
    const kept = clearSent(sent, sent);
    expect(kept).toEqual({ ...sent, title: "" });
    expect(closePost(fieldCleared(kept), sent)).toMatchObject({
      text: "",
      title: "",
      chosen: "send",
    });
  });

  it("keeps a newer body a post, without the title sent, as the field keeps the body", () => {
    const current = { ...sent, text: "B", textRevision: 6 };
    expect(clearSent(current, sent)).toEqual({ ...current, title: "" });
  });

  it("keeps a newer title, and New post with it", () => {
    const current = { ...sent, title: "Later", titleRevision: 3 };
    expect(keptAndCleared(current)).toMatchObject({ title: "Later", chosen: "post" });
  });

  it("keeps a title edited away and back, and New post with it", () => {
    const current = { ...sent, titleRevision: 4 };
    expect(keptAndCleared(current)).toMatchObject({ title: "Plan", chosen: "post" });
  });

  it("keeps New post when it was closed and chosen again", () => {
    const current = { ...sent, chosenRevision: 3 };
    expect(keptAndCleared(current)).toMatchObject({ title: "", chosen: "post" });
  });

  it("keeps New post chosen after a message was sent", () => {
    const message: Draft = { ...sent, title: "", chosen: "send" };
    const current = { ...message, chosen: "post" as const, chosenRevision: 2 };
    expect(closePost(fieldCleared(clearSent(current, message)), message)).toMatchObject({
      chosen: "post",
    });
  });
});

describe("a clear asked of the field", () => {
  const request = { revision: 5, token: 1 };

  it("waits until the field answers, so a second Send can't replace it", () => {
    expect(clearStatus(request, 5, 0)).toBe("waiting");
  });

  it("settles when the field clears for it", () => {
    expect(clearStatus(request, 6, 0)).toBe("settled");
  });

  it("settles when a newer edit made the field refuse it", () => {
    expect(clearStatus(request, 9, 0)).toBe("settled");
  });

  it("keeps waiting through an older change, or another request's refusal", () => {
    expect(clearStatus(request, 4, 0)).toBe("waiting");
    expect(clearStatus({ revision: 5, token: 2 }, 5, 1)).toBe("waiting");
  });

  it("asks nothing before the first send", () => {
    expect(clearStatus({ revision: 0, token: 0 }, 0, 0)).toBe("settled");
  });

  it("stops waiting when the field refuses it at the same revision, and keeps Send off for that body", () => {
    expect(clearStatus(request, 5, 1)).toBe("refused");
  });

  it("lets Send again once the body refused is edited", () => {
    expect(clearStatus(request, 6, 1)).toBe("settled");
  });
});

describe("a field change", () => {
  const sent: Draft = {
    text: "A",
    textRevision: 5,
    title: "",
    titleRevision: 2,
    chosen: "post",
    chosenRevision: 1,
  };
  const request = { revision: 5, token: 1 };

  it("keeps New post open when the field refuses the clear", () => {
    const refusal = fieldReport("A", 5, 3, { refused: 1 });
    expect(fieldChanged(sent, refusal, request, sent)).toEqual(sent);
  });

  it("closes New post only once the field clears for the request", () => {
    const edit = fieldReport("", 6, 3);
    expect(fieldChanged(sent, edit, request, sent)).toMatchObject({ chosen: "post" });
    const accepted = fieldReport("", 6, 3, { cleared: 1 });
    expect(fieldChanged(sent, accepted, request, sent)).toMatchObject({
      text: "",
      textRevision: 6,
      chosen: "send",
    });
  });

  // Moving the caret, selecting, or composing reports the field without an edit: the body sent is still the field's.
  it("leaves the clear waiting through a selection or composition alone", () => {
    for (const moved of [
      fieldReport("A", 5, 4, { selectionStart: 0, selectionEnd: 0 }),
      fieldReport("A", 5, 4, { selectionStart: 0, selectionEnd: 1 }),
      fieldReport("A", 5, 4, { composing: { start: 0, end: 1 } }),
    ]) {
      const draft = fieldChanged(sent, moved, request, sent);
      expect(draft).toEqual(sent);
      expect(clearedBy(moved, request)).toBe(false);
      expect(clearStatus(request, draft.textRevision, 0)).toBe("waiting");
    }
  });

  it("still closes New post on the clear after a selection alone", () => {
    const moved = fieldChanged(sent, fieldReport("A", 5, 4, { selectionStart: 0 }), request, sent);
    const accepted = fieldReport("", 6, 5, { cleared: 1 });
    expect(fieldChanged(moved, accepted, request, sent)).toMatchObject({
      text: "",
      chosen: "send",
    });
  });

  it("lets Send again for a body edited away and back, which the field refused to clear", () => {
    let draft = sent;
    draft = fieldChanged(draft, fieldReport("AB", 6, 4), request, sent);
    draft = fieldChanged(draft, fieldReport("A", 7, 5), request, sent);
    const refusal = fieldReport("A", 7, 6, { refused: 1 });
    draft = fieldChanged(draft, refusal, request, sent);
    expect(draft).toMatchObject({ text: "A", textRevision: 7, chosen: "post" });
    expect(clearStatus(request, draft.textRevision, 1)).toBe("settled");
  });
});

// A replacement and a clear each check the field's revision, so whichever the field takes first, the other changes
// nothing, and the body the outbox kept never loses a replacement made after it was sent.
describe("a replacement and a clear together", () => {
  const sent: Draft = {
    text: "Hi @sa",
    textRevision: 5,
    title: "",
    titleRevision: 0,
    chosen: "post",
    chosenRevision: 1,
  };
  const request = { revision: 5, token: 1 };
  const snapshot = latestSnapshot(null, fieldReport("Hi @sa", 5, 3));
  const asked = askReplacement(NO_REPLACING, snapshot, {
    start: 3,
    end: 6,
    replacement: "@sam ",
    caret: 8,
  });
  if (asked.kind !== "asked") throw new Error("no request");
  const replacing: Replacing = asked.replacing;

  it("keeps the replaced body when the replacement lands before the clear", () => {
    const applied = fieldReport("Hi @sam ", 6, 4, { replaced: { token: 1, applied: true } });
    let draft = fieldChanged(sent, applied, request, sent);
    expect(replacementAnswered(replacing, applied).answer).toEqual({ token: 1, applied: true });
    // The clear is owed nothing now: the field will refuse it, as its body changed since it was sent.
    expect(clearStatus(request, draft.textRevision, 0)).toBe("settled");
    const refusal = fieldReport("Hi @sam ", 6, 5, { refused: 1 });
    draft = fieldChanged(draft, refusal, request, sent);
    expect(draft).toMatchObject({ text: "Hi @sam ", textRevision: 6, chosen: "post" });
  });

  it("closes New post when the clear lands first, and the replacement is refused", () => {
    const cleared = fieldReport("", 6, 4, { cleared: 1 });
    let draft = fieldChanged(sent, cleared, request, sent);
    const refused = fieldReport("", 6, 5, { replaced: { token: 1, applied: false } });
    draft = fieldChanged(draft, refused, request, sent);
    expect(draft).toMatchObject({ text: "", textRevision: 6, chosen: "send" });
    expect(clearedBy(refused, request)).toBe(false);
    expect(replacementAnswered(replacing, refused).answer).toEqual({ token: 1, applied: false });
  });

  it("makes no clear of a replacement's answer", () => {
    const applied = fieldReport("Hi @sam ", 6, 4, { replaced: { token: 1, applied: true } });
    expect(clearedBy(applied, request)).toBe(false);
    expect(fieldChanged(sent, applied, request, sent)).toMatchObject({ chosen: "post" });
  });
});

describe("a write scope", () => {
  /** A controller for `activation`, as the screen makes one. */
  const controller = (
    outbox: WriteOutbox,
    scope: ReturnType<typeof createWriteScope>,
    activation: WriteActivation,
  ) =>
    createConversationWrites({ outbox, enabled: true, isCurrent: () => scope.shows(activation) });

  it("stops a controller made for another chat in the same store", async () => {
    const { outbox, asked } = fakeOutbox(READY);
    const scope = createWriteScope();
    const store = {};
    const a = { store, target: "group-a" };
    const b = { store, target: "group-b" };
    const leave = scope.show(a);
    const forA = controller(outbox, scope, a);
    const confirmation = deferred<boolean>();
    const pending = confirmation.promise.then(() =>
      forA.discard({ kind: "record", operationId: "op-1" }),
    );
    leave();
    scope.show(b);
    confirmation.resolve(true);
    expect(await pending).toEqual({ kind: "stale" });
    expect(asked).toEqual([]);
    expect(scope.shows(b)).toBe(true);
  });

  it("keeps a controller stopped when its chat is shown again", async () => {
    const { outbox, asked } = fakeOutbox(READY);
    const scope = createWriteScope();
    const store = {};
    const first = { store, target: "group-a" };
    const leaveFirst = scope.show(first);
    const forA = controller(outbox, scope, first);
    const confirmation = deferred<boolean>();
    const pending = confirmation.promise.then(() =>
      forA.discard({ kind: "record", operationId: "op-1" }),
    );
    leaveFirst();
    scope.show({ store, target: "group-b" })();
    const again = { store, target: "group-a" };
    scope.show(again);
    confirmation.resolve(true);
    expect(await pending).toEqual({ kind: "stale" });
    expect(asked).toEqual([]);
    expect(scope.shows(again)).toBe(true);
  });

  it("calls a held enqueue stale when its chat is shown again before it lands", async () => {
    const answer = deferred<Awaited<ReturnType<WriteOutbox["enqueue"]>>>();
    const { outbox } = fakeOutbox(READY, () => answer.promise);
    const scope = createWriteScope();
    const store = {};
    const first = { store, target: "group-a" };
    const leaveFirst = scope.show(first);
    const pending = controller(outbox, scope, first).submit("ws-1", send("Late"));
    leaveFirst();
    scope.show({ store, target: "group-b" })();
    scope.show({ store, target: "group-a" });
    answer.resolve({} as Awaited<ReturnType<WriteOutbox["enqueue"]>>);
    expect(await pending).toEqual({ kind: "stale" });
  });

  it("keeps a newer chat shown when an older one's end comes late", () => {
    const scope = createWriteScope();
    const store = {};
    const leaveA = scope.show({ store, target: "group-a" });
    const b = { store, target: "group-b" };
    scope.show(b);
    leaveA();
    expect(scope.shows(b)).toBe(true);
  });

  it("shows nothing once the screen closes", () => {
    const scope = createWriteScope();
    const a = { store: {}, target: "group-a" };
    scope.show(a)();
    expect(scope.shows(a)).toBe(false);
  });
});

type Enqueued = Parameters<WriteOutbox["enqueue"]>[0];
type Kept = Awaited<ReturnType<WriteOutbox["enqueue"]>>;

/** A fake outbox that keeps every enqueue's input, and answers each as `answer` says. */
function recordingOutbox(
  state: OutboxState = READY,
  answer: () => Promise<Kept> = async () => ({}) as Kept,
) {
  const inputs: Enqueued[] = [];
  const { outbox, asked } = fakeOutbox(state, (input) => {
    inputs.push(input);
    return answer();
  });
  return { outbox, asked, inputs };
}

const react = (messageId: string, state: "added" | "removed" = "added"): ChatWrite => ({
  operation: "react",
  args: { messageId, emoji: "👍", state },
});

describe("a reply's write", () => {
  it("goes at the top of a thread without a parent, and under one when chosen", () => {
    expect(
      replyWrite({ kind: "thread", threadId: "thread-1", parentMessageId: null }, "Top"),
    ).toEqual({ write: { operation: "reply", args: { threadId: "thread-1", body: "Top" } } });
    expect(
      replyWrite({ kind: "thread", threadId: "thread-1", parentMessageId: "m-2" }, "Under"),
    ).toEqual({
      write: {
        operation: "reply",
        args: { threadId: "thread-1", body: "Under", parentMessageId: "m-2" },
      },
    });
  });

  it("to an outbox post or send names no thread, and waits for that record", () => {
    expect(
      replyWrite({ kind: "outbox", operationId: "op-1", messageId: "message-1" }, "Soon"),
    ).toEqual({
      write: {
        operation: "reply",
        args: { threadId: null, body: "Soon", parentMessageId: "message-1" },
      },
      dependsOn: "op-1",
    });
  });

  it("makes nothing of spaces alone, and never answers a question", () => {
    expect(replyWrite({ kind: "thread", threadId: "t", parentMessageId: null }, " \n ")).toBeNull();
    const reply = replyWrite({ kind: "thread", threadId: "t", parentMessageId: "q" }, "Hi");
    expect(reply?.write.operation === "reply" && reply.write.args.resolves).toBeUndefined();
  });

  it("passes its record to wait for to the outbox", async () => {
    const { outbox, inputs } = recordingOutbox();
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    const reply = replyWrite({ kind: "outbox", operationId: "op-1", messageId: "message-1" }, "Hi");
    if (!reply) throw new Error("no reply");
    expect(await writes.submit("ws-1", reply.write, reply.dependsOn)).toEqual({ kind: "kept" });
    expect(inputs).toEqual([{ workspaceId: "ws-1", write: reply.write, dependsOn: "op-1" }]);
  });

  it("is sent in the thread the outbox post or send names once it's saved", async () => {
    const disk = keptDisk();
    const server = testServer();
    server.on("POST", "/sync/ws-1/ops/send", SAVED);
    server.on(
      "POST",
      "/sync/ws-1/ops/reply",
      ops({ ok: true, state: "saved", threadId: "thread-s" }),
    );
    const outbox = launch(disk, server);
    await ready(outbox);
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    expect(await writes.submit("ws-1", send("Parent"))).toEqual({ kind: "kept" });
    const parent = outbox.state().records[0];
    if (!parent?.messageId) throw new Error("no parent");
    const reply = replyWrite(
      { kind: "outbox", operationId: parent.operationId, messageId: parent.messageId },
      "Child",
    );
    if (!reply) throw new Error("no reply");
    expect(await writes.submit("ws-1", reply.write, reply.dependsOn)).toEqual({ kind: "kept" });
    await vi.waitFor(() => expect(requests(server, "reply")).toHaveLength(1));
    expect(requests(server, "reply")[0]).toMatchObject({
      threadId: "thread-s",
      parentMessageId: parent.messageId,
      body: "Child",
    });
  });

  it("can't wait for a post or send the server refused, and keeps the text", async () => {
    const disk = keptDisk();
    const server = testServer();
    server.on(
      "POST",
      "/sync/ws-1/ops/send",
      ops({ ok: false, refusal: "refused", reason: "Couldn't send" }),
    );
    const outbox = launch(disk, server);
    await ready(outbox);
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    await writes.submit("ws-1", send("Parent"));
    await vi.waitFor(() => expect(outbox.state().records[0]?.stage).toBe("refused"));
    const parent = outbox.state().records[0];
    if (!parent?.messageId) throw new Error("no parent");
    const reply = replyWrite(
      { kind: "outbox", operationId: parent.operationId, messageId: parent.messageId },
      "Child",
    );
    if (!reply) throw new Error("no reply");
    expect(await writes.submit("ws-1", reply.write, reply.dependsOn)).toEqual({
      kind: "parent-gone",
    });
    expect(outbox.state().records).toHaveLength(1);
  });
});

describe("a reaction", () => {
  const target = { messageId: "m-1", threadId: "thread-1" };
  const HERE = { origin: ORIGIN, accountId: "u-1", workspaceId: "ws-1" };

  it("reaches no outbox while phone writes are off", async () => {
    const { outbox, asked } = recordingOutbox();
    const writes = createConversationWrites({
      outbox,
      enabled: phoneWrites,
      isCurrent: () => true,
    });
    expect(await writes.react(HERE, target, "👍", "added")).toEqual({ kind: "blocked" });
    expect(asked).toEqual([]);
  });

  it("asks nothing while a Sign out's delete has failed, or for a screen no longer shown", async () => {
    const owed = recordingOutbox({ ...READY, deletion: "failed" });
    expect(
      await createConversationWrites({
        outbox: owed.outbox,
        enabled: true,
        isCurrent: () => true,
      }).react(HERE, target, "👍", "added"),
    ).toEqual({ kind: "blocked" });
    const gone = recordingOutbox();
    expect(
      await createConversationWrites({
        outbox: gone.outbox,
        enabled: true,
        isCurrent: () => false,
      }).react(HERE, target, "👍", "added"),
    ).toEqual({ kind: "stale" });
    expect([...owed.asked, ...gone.asked]).toEqual([]);
  });

  it("asks for the state it should end in, in its message's thread", async () => {
    const { outbox, inputs } = recordingOutbox();
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    expect(await writes.react(HERE, target, "👍", "removed")).toEqual({ kind: "kept" });
    expect(inputs).toEqual([
      { workspaceId: "ws-1", write: react("m-1", "removed"), thread: "thread-1" },
    ]);
  });

  it("takes one at a time per message, while the first is being kept", async () => {
    const held = deferred<Kept>();
    const { outbox, inputs } = recordingOutbox(READY, () => held.promise);
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    const first = writes.react(HERE, target, "👍", "added");
    expect(await writes.react(HERE, target, "👍", "removed")).toEqual({ kind: "blocked" });
    // Another message's reaction doesn't wait for it.
    const other = writes.react(HERE, { ...target, messageId: "m-2" }, "👍", "added");
    held.resolve({} as Kept);
    expect(await first).toEqual({ kind: "kept" });
    expect(await other).toEqual({ kind: "kept" });
    expect(inputs.map((input) => input.write)).toEqual([react("m-1"), react("m-2")]);
  });

  it("takes none while the outbox has one for the message unsettled, a stalled one included", async () => {
    for (const fields of [
      { stage: "queued" as const },
      { stage: "queued" as const, withheld: true },
      { stage: "sending" as const, attempted: true },
      { stage: "stalled" as const, attempted: true },
    ]) {
      const waiting = { ...outboxRecord(react("m-1")), ...fields };
      const { outbox, asked } = recordingOutbox({ ...READY, records: [waiting] });
      const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
      expect(await writes.react(HERE, target, "👍", "removed")).toEqual({ kind: "blocked" });
      expect(asked).toEqual([]);
    }
  });

  it("isn't held by another account's, server's or workspace's reaction to the same message ID", async () => {
    const waiting = outboxRecord(react("m-1"));
    const elsewhere = [
      { ...waiting, accountId: "u-2" },
      { ...waiting, origin: "https://other.example.com" },
      { ...waiting, workspaceId: "ws-2" },
    ];
    const { outbox, inputs } = recordingOutbox({ ...READY, records: elsewhere });
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    expect(await writes.react(HERE, target, "👍", "added")).toEqual({ kind: "kept" });
    expect(inputs).toEqual([{ workspaceId: "ws-1", write: react("m-1"), thread: "thread-1" }]);
  });

  it("takes another once the last is settled", async () => {
    const saved = {
      ...outboxRecord(react("m-1")),
      stage: "saved" as const,
      result: { kind: "saved" as const, threadId: null, messageId: null },
    };
    const { outbox, inputs } = recordingOutbox({ ...READY, records: [saved] });
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    expect(await writes.react(HERE, target, "👍", "removed")).toEqual({ kind: "kept" });
    expect(inputs).toHaveLength(1);
  });

  it("says the outbox may keep it withheld, so its Send retries that one", async () => {
    const { outbox } = recordingOutbox(READY, () =>
      Promise.reject(new OutboxError("indeterminate", "op-9")),
    );
    const writes = createConversationWrites({ outbox, enabled: true, isCurrent: () => true });
    expect(await writes.react(HERE, target, "👍", "added")).toEqual({ kind: "withheld" });
  });
});

describe("a reply whose post or send can't take it", () => {
  const to = { name: "Sam", excerpt: "Plans" };

  it("keeps Send off while it's still chosen, so its text never goes elsewhere", () => {
    expect(replyParentGone({ kind: "parent-gone", replyTo: to }, to)).toBe(true);
  });

  it("lets Send go once the person cancels Reply or chooses another message", () => {
    const failure = { kind: "parent-gone", replyTo: to } as const;
    expect(replyParentGone(failure, null)).toBe(false);
    expect(replyParentGone(failure, { ...to })).toBe(false);
  });

  it("keeps nothing off for text the outbox didn't keep, or with no failure", () => {
    expect(replyParentGone({ kind: "not-kept" }, to)).toBe(false);
    expect(replyParentGone(null, to)).toBe(false);
  });
});

describe("a reply's clear", () => {
  it("leaves New post as it was", () => {
    const draft: Draft = {
      text: "A",
      textRevision: 5,
      title: "",
      titleRevision: 0,
      chosen: "post",
      chosenRevision: 1,
    };
    const accepted = fieldReport("", 6, 3, { cleared: 1 });
    expect(fieldChanged(draft, accepted, { revision: 5, token: 1 }, null)).toMatchObject({
      text: "",
      chosen: "post",
    });
  });
});

describe("joined Member per-Group chat gating", () => {
  const groups = [
    {
      id: "g-rw",
      channelWireId: "wire-rw",
      kind: "group" as const,
      access: "read-write" as const,
      threadIds: ["thread-rw"],
    },
    {
      id: "g-ro",
      channelWireId: "wire-ro",
      kind: "group" as const,
      access: "read-only" as const,
      threadIds: ["thread-ro"],
    },
    { id: "g-nowire", kind: "group" as const, access: "read-write" as const, threadIds: ["t-nw"] },
    {
      id: "dm-1",
      channelWireId: "wire-dm",
      kind: "dm" as const,
      access: "read-write" as const,
      threadIds: ["thread-dm"],
    },
  ];

  it("matches streams by engine ID or wire ID and allows writes only on read-write Groups", async () => {
    expect(groupForStream(groups, "g-rw")?.id).toBe("g-rw");
    expect(groupForStream(groups, "wire-rw")?.id).toBe("g-rw");
    expect(groupForStream(groups, "missing")).toBeNull();
    expect(joinedGroupLanes({ type: "both" })).toEqual({ post: true, send: false });
    expect(joinedGroupLanes({ type: "posts" })).toEqual({ post: true, send: false });
    expect(joinedGroupLanes({})).toEqual({ post: true, send: false });
    expect(joinedGroupLanes({ type: "chat" })).toEqual({ post: false, send: false });
    expect(writableJoinedThread(groups, "thread-rw")).toBe(true);
    expect(writableJoinedThread(groups, "thread-ro")).toBe(false);
    expect(writableJoinedThread(groups, "t-nw")).toBe(false);
    expect(writableJoinedThread(groups, "thread-dm")).toBe(false);
    expect(writableJoinedThread(groups, "thread-file-comment")).toBe(false);

    vi.stubEnv("EXPO_PUBLIC_DOHC_PHONE_WRITES", "1");
    vi.resetModules();
    try {
      const phone = await import("../server/phoneWrites");
      expect(phone.writesIn({ joined: true })).toBe(false);
      expect(phone.canWriteGroupChat({ joined: true }, groups[0])).toBe(true);
      expect(phone.canWriteGroupChat({ joined: true }, groups[1])).toBe(false);
      expect(phone.canWriteGroupChat({ joined: true }, groups[2])).toBe(false);
      expect(phone.canWriteGroupChat({ joined: true }, groups[3])).toBe(false);
      expect(phone.canWriteGroupChat({ joined: true }, null)).toBe(false);
      expect(phone.canWriteGroupChat({ joined: false }, null)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

/** An outbox record of this account, for a fake outbox's state. */
function outboxRecord(write: ChatWrite): OutboxState["records"][number] {
  return {
    origin: ORIGIN,
    accountId: "u-1",
    workspaceId: "ws-1",
    operationId: "op-r",
    messageId: null,
    sequence: 1,
    dependsOn: null,
    target: { kind: "thread", id: "thread-1" },
    write,
    stage: "queued",
    attempted: false,
    withheld: false,
    pendingSinceMs: null,
    result: null,
  };
}
