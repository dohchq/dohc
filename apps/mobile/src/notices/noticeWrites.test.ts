import { NOTICE_KINDS, type NoticeKind } from "@dohc/workspace-contracts/relay";
import { describe, expect, it } from "vitest";
import type { OutboxRecord } from "../conversation/conversationWrites";
import type { AccountWorkspace } from "../server/api";
import type { NoticeRecord } from "../server/notices";
import type { WorkspaceList } from "../server/workspaceList";
import type { ChatMessage, ChatThread, MissingChat, Read } from "../server/workspaceReads";
import {
  answerCandidate,
  createNoticeTargets,
  isPost,
  noticeAction,
  replyCandidate,
  targetKey,
  type TargetRead,
} from "./noticeWrites";
import { readLane } from "../server/readLane";

const mention: NoticeRecord = {
  noticeId: "n1",
  changeSeq: 1,
  workspaceId: "w1",
  recipientShareId: null,
  kind: "mention",
  senderKind: "person",
  senderLabel: "Maya Chen",
  title: "Maya Chen mentioned you in #planning",
  body: "Can you check the train times?",
  target: { thread: "t1", message: "m1" },
  createdAtMs: 1000,
  readAtMs: null,
  dismissedAtMs: null,
  expiresAtMs: 10_000,
};

const trip: AccountWorkspace = {
  workspaceId: "w1",
  name: "Trip",
  canOpen: true,
  showOnPhone: true,
};
const listed = (
  workspaces: readonly AccountWorkspace[] = [trip],
  pending: readonly string[] = [],
): WorkspaceList => ({ status: "ready", workspaces, problem: null, pending: new Set(pending) });

const message = (fields: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  threadId: "t1",
  authorKind: "human",
  authorName: "Maya Chen",
  body: "Can you check the train times?",
  createdAtMs: 1,
  parentMessageId: null,
  attachments: [],
  needsDecision: false,
  decisionState: null,
  options: [],
  chosenOption: null,
  resolvedByMessageId: null,
  reactions: [],
  ...fields,
});
const thread = (messages: readonly ChatMessage[], id = "t1"): ChatThread => ({
  kind: "thread",
  id,
  title: "",
  messages,
});
const KEY = targetKey({ workspaceId: "w1", threadId: "t1" });
const readOf = (value: ChatThread | MissingChat): TargetRead => ({ kind: "read", thread: value });
const current = { isCurrent: () => true };

const actionFor = (
  record: NoticeRecord,
  read: TargetRead | undefined,
  overrides: Partial<Parameters<typeof noticeAction>[1]> = {},
) =>
  noticeAction(record, {
    list: listed(),
    writes: true,
    signIn: current,
    reads: new Map(read ? [[KEY, read]] : []),
    ...overrides,
  });

describe("which Notice offers Reply", () => {
  const verified = readOf(thread([message()]));

  it("offers Reply on a mention whose exact message a read of its thread shows", () => {
    expect(actionFor(mention, verified)).toEqual({
      kind: "reply",
      target: { workspaceId: "w1", threadId: "t1", messageId: "m1" },
    });
  });

  it("offers Reply on no other kind of Notice, whatever its target", () => {
    for (const kind of Object.keys(NOTICE_KINDS) as NoticeKind[]) {
      const action = actionFor({ ...mention, kind }, verified);
      expect(action.kind, kind).toBe(kind === "mention" ? "reply" : "open");
      expect(replyCandidate({ ...mention, kind }, listed(), true) !== null, kind).toBe(
        kind === "mention",
      );
    }
  });

  it("checks the exact message ID and thread, never another message or its author", () => {
    // Another message in the thread, even by the same author, isn't the one the Notice names.
    expect(actionFor(mention, readOf(thread([message({ id: "m2" })]))).kind).toBe("open");
    // The message as another thread holds it, or a read of another thread.
    expect(actionFor(mention, readOf(thread([message({ threadId: "t2" })]))).kind).toBe("open");
    expect(actionFor(mention, readOf(thread([message()], "t2"))).kind).toBe("open");
    // Whoever wrote the message, an ordinary reply to it is a reply.
    expect(
      actionFor(mention, readOf(thread([message({ authorKind: "agent", authorName: "Nova" })])))
        .kind,
    ).toBe("reply");
    // A question in the message doesn't make Reply an answer.
    expect(
      actionFor(mention, readOf(thread([message({ needsDecision: true, decisionState: "open" })]))),
    ).toMatchObject({ kind: "reply" });
  });

  it("keeps Open while phone writes are off, without a current sign-in, or before a read", () => {
    expect(actionFor(mention, verified, { writes: false })).toMatchObject({
      kind: "open",
      readFailed: false,
    });
    expect(actionFor(mention, verified, { signIn: null }).kind).toBe("open");
    expect(actionFor(mention, verified, { signIn: { isCurrent: () => false } }).kind).toBe("open");
    expect(actionFor(mention, undefined)).toMatchObject({ kind: "open", readFailed: false });
    expect(actionFor(mention, { kind: "reading" })).toMatchObject({
      kind: "open",
      readFailed: false,
    });
    expect(replyCandidate(mention, listed(), false)).toBeNull();
  });

  it("offers neither in a workspace the phone hides, can't open, doesn't own, or is still changing", () => {
    for (const list of [
      listed([{ ...trip, showOnPhone: false }]),
      listed([{ ...trip, canOpen: false }]),
      listed([]),
      listed([trip], ["w1"]),
      { status: "loading" } as const,
    ]) {
      expect(actionFor(mention, verified, { list })).toEqual({ kind: "elsewhere" });
      expect(replyCandidate(mention, list, true)).toBeNull();
    }
  });

  it("keeps Open with Try again when the read failed, and plain Open when the thread is gone", () => {
    expect(actionFor(mention, { kind: "failed" })).toMatchObject({
      kind: "open",
      readFailed: true,
    });
    expect(actionFor(mention, readOf({ kind: "missing" }))).toMatchObject({
      kind: "open",
      readFailed: false,
    });
  });

  it("keeps Open for a mention that names no message, or only a page", () => {
    const noMessage = { ...mention, target: { thread: "t1" } };
    expect(replyCandidate(noMessage, listed(), true)).toBeNull();
    expect(actionFor(noMessage, verified)).toMatchObject({ kind: "open", readFailed: false });
    const page = { ...mention, target: { path: "plans/day.md" } };
    expect(replyCandidate(page, listed(), true)).toBeNull();
    expect(actionFor(page, verified)).toMatchObject({ kind: "open", target: { kind: "page" } });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const answer = (value: ChatThread | MissingChat): Read<ChatThread | MissingChat> => ({
  value,
  cursor: "0.1.1",
});

function harness(isCurrent = () => true) {
  const calls: {
    workspaceId: string;
    threadId: string;
    signal: AbortSignal;
    answer: ReturnType<typeof deferred<Read<ChatThread | MissingChat>>>;
  }[] = [];
  const targets = createNoticeTargets({
    signIn: { isCurrent },
    read: (workspaceId, threadId, signal) => {
      const next = deferred<Read<ChatThread | MissingChat>>();
      calls.push({ workspaceId, threadId, signal, answer: next });
      return next.promise;
    },
  });
  return { targets, calls };
}
const T1 = { workspaceId: "w1", threadId: "t1", messageId: "m1" };

describe("the reads behind Reply", () => {
  it("reads each workspace and thread once, however many rows name it", async () => {
    const { targets, calls } = harness();
    targets.want([T1, { ...T1, messageId: "m2" }, T1]);
    targets.want([T1]);
    expect(calls.map(({ workspaceId, threadId }) => [workspaceId, threadId])).toEqual([
      ["w1", "t1"],
    ]);
    expect(targets.state().get(KEY)).toEqual({ kind: "reading" });
    calls[0]?.answer.resolve(answer(thread([message(), message({ id: "m2" })])));
    await settle();
    // Both rows' messages are in the one read, and each is checked by its own ID.
    const reads = targets.state();
    expect(actionFor(mention, reads.get(KEY)).kind).toBe("reply");
    expect(
      actionFor({ ...mention, target: { thread: "t1", message: "m2" } }, reads.get(KEY)).kind,
    ).toBe("reply");
    expect(
      actionFor({ ...mention, target: { thread: "t1", message: "m3" } }, reads.get(KEY)).kind,
    ).toBe("open");
  });

  it("abort the sign-in's read-ahead, and hold more until they settle", async () => {
    const signIn = { isCurrent: () => true };
    const shown = deferred<Read<ChatThread | MissingChat>>();
    const targets = createNoticeTargets({ signIn, read: () => shown.promise });
    const lane = readLane(signIn);
    const ahead = lane.ahead(
      new AbortController().signal,
      (signal) =>
        new Promise<boolean>((done) => signal.addEventListener("abort", () => done(true))),
    );
    targets.want([T1]);
    expect(await ahead).toBe(true);
    expect(lane.free()).toBe(false);
    shown.resolve(answer(thread([message()])));
    await settle();
    expect(lane.free()).toBe(true);
  });

  it("reads another workspace's thread of the same ID on its own", () => {
    const { targets, calls } = harness();
    targets.want([T1, { ...T1, workspaceId: "w2" }]);
    expect(calls).toHaveLength(2);
  });

  it("records a failed read, and Try again reads again", async () => {
    const { targets, calls } = harness();
    targets.want([T1]);
    calls[0]?.answer.reject(new Error("offline"));
    await settle();
    expect(targets.state().get(KEY)).toEqual({ kind: "failed" });
    // A failed read isn't read again just by showing the row again; Try again does it.
    targets.want([T1]);
    expect(calls).toHaveLength(1);
    expect(targets.retry(T1)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal.aborted).toBe(false);
    calls[1]?.answer.resolve(answer(thread([message()])));
    await settle();
    expect(actionFor(mention, targets.state().get(KEY)).kind).toBe("reply");
  });

  it("applies only the latest read of a thread", async () => {
    const { targets, calls } = harness();
    targets.want([T1]);
    targets.retry(T1);
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[1]?.answer.resolve(answer(thread([])));
    calls[0]?.answer.resolve(answer(thread([message()])));
    await settle();
    expect(actionFor(mention, targets.state().get(KEY)).kind).toBe("open");
  });

  it("drops an answer that comes after the sign-in changed, or after it stopped", async () => {
    let signedIn = true;
    const { targets, calls } = harness(() => signedIn);
    targets.want([T1, { ...T1, threadId: "t2" }]);
    signedIn = false;
    calls[0]?.answer.resolve(answer(thread([message()])));
    await settle();
    expect(targets.state().get(KEY)).toEqual({ kind: "reading" });
    // A sign-in that has ended asks nothing more.
    targets.want([{ ...T1, threadId: "t3" }]);
    expect(targets.retry(T1)).toBe(false);
    expect(calls).toHaveLength(2);

    const second = harness();
    second.targets.want([T1]);
    second.targets.stop();
    expect(second.calls[0]?.signal.aborted).toBe(true);
    second.calls[0]?.answer.resolve(answer(thread([message()])));
    await settle();
    expect(second.targets.state().get(KEY)).toBeUndefined();
    // The row on screen again, as when the screen's effect runs again, asks again.
    second.targets.want([T1]);
    expect(second.calls).toHaveLength(2);
  });

  it("offers no Reply once the workspace stops showing on the phone, even with a read that showed the message", async () => {
    const { targets, calls } = harness();
    targets.want([T1]);
    calls[0]?.answer.resolve(answer(thread([message()])));
    await settle();
    const read = targets.state().get(KEY);
    expect(actionFor(mention, read).kind).toBe("reply");
    expect(actionFor(mention, read, { list: listed([{ ...trip, showOnPhone: false }]) })).toEqual({
      kind: "elsewhere",
    });
    expect(actionFor(mention, read, { list: listed([trip], ["w1"]) })).toEqual({
      kind: "elsewhere",
    });
  });

  it("keeps a verified read through a refresh until the next answer, which wins", async () => {
    const { targets, calls } = harness();
    targets.want([T1]);
    calls[0]?.answer.resolve(answer(thread([message()])));
    await settle();
    targets.refresh();
    expect(calls).toHaveLength(2);
    expect(actionFor(mention, targets.state().get(KEY)).kind).toBe("reply");
    calls[1]?.answer.resolve(answer({ kind: "missing" }));
    await settle();
    expect(actionFor(mention, targets.state().get(KEY))).toMatchObject({
      kind: "open",
      readFailed: false,
    });
  });

  it("stops and drops the read of a thread no row wants any more, and reads it again when one does", async () => {
    const { targets, calls } = harness();
    const T2 = { ...T1, threadId: "t2" };
    targets.want([T1, T2]);
    calls[0]?.answer.resolve(answer(thread([message()])));
    await settle();
    // T1's row leaves the screen, its workspace hides, or the screen does: T1's thread goes, T2's read is stopped.
    targets.want([]);
    expect(calls[1]?.signal.aborted).toBe(true);
    expect(targets.state().size).toBe(0);
    calls[1]?.answer.resolve(answer(thread([message({ threadId: "t2" })])));
    await settle();
    expect(targets.state().size).toBe(0);
    // Refresh and Try again read nothing nobody wants, and Try again says it started nothing.
    targets.refresh();
    expect(targets.retry(T1)).toBe(false);
    expect(calls).toHaveLength(2);
    // Wanted again, it's read again, never answered from the dropped read.
    targets.want([T1]);
    expect(calls).toHaveLength(3);
    expect(targets.state().get(KEY)).toEqual({ kind: "reading" });
  });

  it("keeps a thread's read while another row still names it", async () => {
    const { targets, calls } = harness();
    targets.want([T1, { ...T1, messageId: "m2" }]);
    calls[0]?.answer.resolve(answer(thread([message(), message({ id: "m2" })])));
    await settle();
    targets.want([{ ...T1, messageId: "m2" }]);
    expect(calls).toHaveLength(1);
    expect(targets.state().get(KEY)?.kind).toBe("read");
  });

  it("drops every read on stop, finished ones too", async () => {
    const { targets, calls } = harness();
    targets.want([T1]);
    calls[0]?.answer.resolve(answer(thread([message()])));
    await settle();
    targets.stop();
    expect(targets.state().size).toBe(0);
    targets.refresh();
    expect(calls).toHaveLength(1);
  });

  it("tells its listeners at each change, with a new map", async () => {
    const { targets, calls } = harness();
    let changes = 0;
    const unsubscribe = targets.subscribe(() => void (changes += 1));
    const before = targets.state();
    targets.want([T1]);
    calls[0]?.answer.resolve(answer(thread([message()])));
    await settle();
    expect(changes).toBe(2);
    expect(targets.state()).not.toBe(before);
    unsubscribe();
  });
});

// An agent-run Notice from Nova whose target names an agent's open question.
const asked: NoticeRecord = {
  ...mention,
  noticeId: "n2",
  kind: "agent-run",
  senderKind: "agent",
  senderLabel: "Nova",
  title: "Nova is waiting for your answer",
  body: "Which return train?",
  target: { thread: "t1", run: "r1", message: "m1" },
};
const question = (fields: Partial<ChatMessage> = {}) =>
  message({
    authorKind: "agent",
    authorName: "Nova",
    body: "Which return train?",
    needsDecision: true,
    decisionState: "open",
    ...fields,
  });
const listedRead = (messages: readonly ChatMessage[], post = false): TargetRead => ({
  kind: "read",
  thread: thread(messages),
  post,
});

describe("which Notice offers Answer", () => {
  const open = listedRead([question()]);

  it("offers Answer on an agent-run Notice whose exact message a read shows as an agent's open question", () => {
    expect(actionFor(asked, open)).toMatchObject({
      kind: "answer",
      question: {
        target: { workspaceId: "w1", threadId: "t1", messageId: "m1", answer: true },
        question: { id: "m1", authorName: "Nova" },
        post: false,
      },
    });
  });

  it("offers Answer on no other kind of Notice, and a mention's question stays a Reply", () => {
    for (const kind of Object.keys(NOTICE_KINDS) as NoticeKind[]) {
      const action = actionFor({ ...asked, kind }, open);
      expect(action.kind, kind).toBe(
        kind === "agent-run" ? "answer" : kind === "mention" ? "reply" : "open",
      );
    }
  });

  it("checks the exact message, its thread, its author's kind and the decision, never a name or the prose", () => {
    for (const read of [
      listedRead([question({ id: "m2" })]),
      listedRead([question({ threadId: "t2" })]),
      { kind: "read", thread: thread([question()], "t2"), post: false } as const,
      listedRead([question({ authorKind: "human" })]),
      listedRead([question({ authorKind: "automation" })]),
      listedRead([question({ needsDecision: false, decisionState: null })]),
      listedRead([question({ decisionState: "resolved" })]),
      // A message that reads like a question, but asks no decision.
      listedRead([message({ authorKind: "agent", body: "Which return train should I use?" })]),
    ])
      expect(actionFor(asked, read).kind).toBe("open");
    // The Notice's sender doesn't have to be the question's author: the exact target decides, not a name.
    expect(actionFor({ ...asked, senderLabel: "Scout" }, open).kind).toBe("answer");
  });

  it("waits for the chat list before it offers Answer, so the answer's place is known", () => {
    expect(actionFor(asked, { kind: "read", thread: thread([question()]) })).toMatchObject({
      kind: "open",
      readFailed: false,
    });
    expect(actionFor(asked, { kind: "failed" })).toMatchObject({ kind: "open", readFailed: true });
  });

  it("keeps Open once this phone has an answer on its way, held, saved or lost", () => {
    const kept = (fields: Partial<OutboxRecord>): OutboxRecord => ({
      origin: "o",
      accountId: "u",
      workspaceId: "w1",
      operationId: "op",
      messageId: "mo",
      sequence: 1,
      dependsOn: null,
      target: { kind: "thread", id: "t1" },
      write: {
        operation: "reply",
        args: { threadId: "t1", body: "x", resolves: { messageId: "m1" } },
      },
      stage: "queued",
      attempted: false,
      withheld: false,
      pendingSinceMs: null,
      result: null,
      ...fields,
    });
    for (const fields of [
      {},
      { withheld: true },
      { stage: "saved", result: { kind: "saved", threadId: "t1", messageId: "mo" } },
      {
        stage: "refused",
        result: {
          kind: "refused",
          reason: "already answered",
          threadId: "t1",
          winnerMessageId: null,
        },
      },
    ] as const)
      expect(actionFor(asked, open, { answers: () => [kept(fields)] }).kind).toBe("open");
  });

  it("answers in the Notice's own workspace, whichever is open", () => {
    const fundraiser: AccountWorkspace = { ...trip, workspaceId: "w2", name: "Fundraiser" };
    const action = noticeAction(
      { ...asked, workspaceId: "w2" },
      {
        list: listed([trip, fundraiser]),
        writes: true,
        signIn: current,
        reads: new Map([[targetKey({ workspaceId: "w2", threadId: "t1" }), open]]),
      },
    );
    expect(action).toMatchObject({ kind: "answer", question: { target: { workspaceId: "w2" } } });
    // Hidden, it isn't a candidate at all, so its read is dropped.
    expect(
      answerCandidate(
        { ...asked, workspaceId: "w2" },
        listed([trip, { ...fundraiser, showOnPhone: false }]),
        true,
      ),
    ).toBeNull();
  });

  it("tells a post's thread from its list, and an unlisted thread is no post", () => {
    const group = (postThreadIds?: readonly string[]) => ({
      id: "g1",
      name: "planning",
      kind: "group" as const,
      threadIds: ["t1", "t2"],
      ...(postThreadIds ? { postThreadIds } : {}),
      unreadCount: 0,
      unreadThreadIds: [],
    });
    expect(isPost([group(["t1"])], "t1")).toBe(true);
    expect(isPost([group(["t2"])], "t1")).toBe(false);
    expect(isPost([group()], "t1")).toBe(false);
    expect(isPost([], "t1")).toBe(false);
  });
});

describe("the reads behind Answer", () => {
  const ANSWER = { ...T1, answer: true as const };

  function answerHarness(isCurrent = () => true) {
    const threads: ReturnType<typeof deferred<Read<ChatThread | MissingChat>>>[] = [];
    const lists: ReturnType<typeof deferred<boolean>>[] = [];
    const handed: { workspaceId: string; messages: readonly ChatMessage[] }[] = [];
    const targets = createNoticeTargets({
      signIn: { isCurrent },
      read: () => {
        const next = deferred<Read<ChatThread | MissingChat>>();
        threads.push(next);
        return next.promise;
      },
      readPost: () => {
        const next = deferred<boolean>();
        lists.push(next);
        return next.promise;
      },
      onThread: (workspaceId, shown) => void handed.push({ workspaceId, messages: shown.messages }),
    });
    return { targets, threads, lists, handed };
  }

  it("reads the chat list with an answer's thread, and offers Answer only once both answer", async () => {
    const { targets, threads, lists } = answerHarness();
    targets.want([ANSWER]);
    expect(lists).toHaveLength(1);
    threads[0]?.resolve(answer(thread([question()])));
    await settle();
    expect(targets.state().get(KEY)).toEqual({ kind: "reading" });
    lists[0]?.resolve(true);
    await settle();
    expect(targets.state().get(KEY)).toMatchObject({ kind: "read", post: true });
    expect(actionFor(asked, targets.state().get(KEY))).toMatchObject({
      kind: "answer",
      question: { post: true },
    });
  });

  it("counts a failed chat list as a failed read, with Try again", async () => {
    const { targets, threads, lists } = answerHarness();
    targets.want([ANSWER]);
    threads[0]?.resolve(answer(thread([question()])));
    lists[0]?.reject(new Error("offline"));
    await settle();
    expect(targets.state().get(KEY)).toEqual({ kind: "failed" });
  });

  it("reads a mention's thread again with its list once an answer needs it too", async () => {
    const { targets, threads, lists } = answerHarness();
    targets.want([T1]);
    expect(lists).toHaveLength(0);
    threads[0]?.resolve(answer(thread([question()])));
    await settle();
    targets.want([T1, ANSWER]);
    expect(threads).toHaveLength(2);
    expect(lists).toHaveLength(1);
    // Once read with its list, the same rows read nothing more.
    targets.want([ANSWER, T1]);
    expect(threads).toHaveLength(2);
  });

  it("hands each current read's messages to the outbox, for its own workspace, and drops a late one", async () => {
    let signedIn = true;
    const { targets, threads, lists, handed } = answerHarness(() => signedIn);
    targets.want([ANSWER, { ...ANSWER, workspaceId: "w2" }]);
    threads[0]?.resolve(answer(thread([question()])));
    lists[0]?.resolve(false);
    await settle();
    expect(handed).toEqual([{ workspaceId: "w1", messages: [question()] }]);
    signedIn = false;
    threads[1]?.resolve(answer(thread([question()])));
    lists[1]?.resolve(false);
    await settle();
    expect(handed).toHaveLength(1);
  });

  it("drops a workspace's threads once it stops showing, and every thread at a sign-in change", async () => {
    const { targets, threads, lists } = answerHarness();
    targets.want([ANSWER]);
    threads[0]?.resolve(answer(thread([question()])));
    lists[0]?.resolve(false);
    await settle();
    expect(targets.state().size).toBe(1);
    // Show on phone turned off, here or elsewhere: the screen's next want names no target in that workspace.
    const hidden = listed([{ ...trip, showOnPhone: false }]);
    targets.want(answerCandidate(asked, hidden, true) ? [ANSWER] : []);
    expect(targets.state().size).toBe(0);
    // Wanted again once it shows, it reads again from nothing.
    targets.want([ANSWER]);
    expect(targets.state().get(KEY)).toEqual({ kind: "reading" });
    // A sign-in change stops this sign-in's reads, and the next sign-in's start empty.
    targets.stop();
    expect(targets.state().size).toBe(0);
    expect(answerHarness().targets.state().size).toBe(0);
  });
});
