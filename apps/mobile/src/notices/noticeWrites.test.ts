import { NOTICE_KINDS, type NoticeKind } from "@dohc/workspace-contracts/relay";
import { describe, expect, it } from "vitest";
import type { AccountWorkspace } from "../server/api";
import type { NoticeRecord } from "../server/notices";
import type { WorkspaceList } from "../server/workspaceList";
import type { ChatMessage, ChatThread, MissingChat, Read } from "../server/workspaceReads";
import {
  createNoticeTargets,
  noticeAction,
  replyCandidate,
  targetKey,
  type TargetRead,
} from "./noticeWrites";

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
    targets.retry(T1);
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
    // Refresh and Try again read nothing nobody wants.
    targets.refresh();
    targets.retry(T1);
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
