import { describe, expect, it } from "vitest";
import type { OutboxRecord, WriteOutbox } from "../conversation/conversationWrites";
import type { LocalActions } from "../conversation/useOutbox";
import { OutboxError } from "../server/outbox";
import type { ChatMessage, ChatThread } from "../server/workspaceReads";
import {
  answerLookup,
  answerSurface,
  answerView,
  createNoticeEditor,
  type NoticeEditor,
} from "./noticeAnswers";
import {
  shownQuestion,
  verifiedQuestion,
  type MessageTarget,
  type TargetRead,
  type VerifiedQuestion,
} from "./noticeWrites";

const SCOPE = { origin: "https://dohc.example", accountId: "u1" };

const question = (fields: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "q1",
  threadId: "t1",
  authorKind: "agent",
  authorName: "Scout",
  body: "Which return train?",
  createdAtMs: 1,
  parentMessageId: null,
  attachments: [],
  needsDecision: true,
  decisionState: "open",
  options: [],
  chosenOption: null,
  resolvedByMessageId: null,
  reactions: [],
  ...fields,
});
const thread = (messages: readonly ChatMessage[]): ChatThread => ({
  kind: "thread",
  id: "t1",
  title: "",
  messages,
});
// Workspace B: the Notice's own, while A is the one open.
const TARGET: MessageTarget = { workspaceId: "wB", threadId: "t1", messageId: "q1", answer: true };
const readOf = (messages: readonly ChatMessage[], post = false): TargetRead => ({
  kind: "read",
  thread: thread(messages),
  post,
});

function record(fields: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    ...SCOPE,
    workspaceId: "wB",
    operationId: "op-1",
    messageId: "m-op-1",
    sequence: 1,
    dependsOn: null,
    target: { kind: "thread", id: "t1" },
    write: {
      operation: "reply",
      args: { threadId: "t1", body: "19:52", resolves: { messageId: "q1", chosenOption: "19:52" } },
    },
    stage: "queued",
    attempted: false,
    withheld: false,
    pendingSinceMs: null,
    result: null,
    ...fields,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function fakeOutbox() {
  const records: OutboxRecord[] = [];
  const enqueued: Parameters<WriteOutbox["enqueue"]>[0][] = [];
  const retried: string[] = [];
  let failure: OutboxError | null = null;
  let hold: Promise<void> | null = null;
  const outbox: WriteOutbox = {
    state: () => ({
      status: "ready",
      records,
      aside: [],
      unreadable: [],
      deletion: "none",
      unconfirmed: [],
    }),
    subscribe: () => () => undefined,
    async enqueue(input) {
      enqueued.push(input);
      if (hold) await hold;
      if (failure) throw failure;
      const kept = record({ write: input.write, operationId: `op-${enqueued.length}` });
      records.push(kept);
      return kept;
    },
    async retryEnqueue(operationId) {
      retried.push(operationId);
      return record({ operationId });
    },
    discard: async () => undefined,
    wake: () => undefined,
  };
  return {
    outbox,
    records,
    enqueued,
    retried,
    fail: (error: OutboxError | null) => void (failure = error),
    holdUntil: (gate: Promise<void> | null) => void (hold = gate),
  };
}

function harness(read: TargetRead = readOf([question()])) {
  let signedIn = true;
  let current: TargetRead = read;
  let showing = true;
  const box = fakeOutbox();
  const editor = createNoticeEditor({
    signIn: { isCurrent: () => signedIn },
    outbox: box.outbox,
    enabled: true,
    // As the Notices screen verifies: the Notice's workspace still shows on the phone and the latest read shows the
    // question open.
    verify: (noticeId) =>
      noticeId === "relay:n1" && showing ? verifiedQuestion(TARGET, current) : null,
    answers: (target) =>
      answerLookup(box.outbox.state(), SCOPE)(target.workspaceId, target.messageId),
  });
  return {
    editor,
    box,
    signOut: () => void (signedIn = false),
    hide: () => void (showing = false),
    read: (next: TargetRead) => void (current = next),
  };
}

const visitOf = (editor: NoticeEditor) => {
  const visit = editor.state();
  if (!visit) throw new Error("No answer is open");
  return visit;
};

describe("answering a Notice's question in its row", () => {
  it("sends only to the Notice's own workspace, under the question's place, with resolves", async () => {
    const { editor, box } = harness();
    expect(editor.open("relay:n1")).toBe(true);
    expect(await editor.submit(visitOf(editor), "The 19:52")).toEqual({ kind: "kept" });
    expect(box.enqueued).toEqual([
      {
        workspaceId: "wB",
        write: {
          operation: "reply",
          args: {
            threadId: "t1",
            body: "The 19:52",
            parentMessageId: "q1",
            resolves: { messageId: "q1" },
          },
        },
      },
    ]);
    // Kept, the row's answer closes.
    expect(editor.state()).toBeNull();
  });

  it("places a poll's choice beside the poll, and a post's answer at its thread's top", async () => {
    const poll = question({ options: ["17:52", "19:52"], parentMessageId: "p0" });
    const { editor, box } = harness(
      readOf([question({ id: "p0", needsDecision: false, decisionState: null }), poll]),
    );
    editor.open("relay:n1");
    await editor.submit(visitOf(editor), "19:52", "19:52");
    expect(box.enqueued[0]?.write).toEqual({
      operation: "reply",
      args: {
        threadId: "t1",
        body: "19:52",
        parentMessageId: "p0",
        resolves: { messageId: "q1", chosenOption: "19:52" },
      },
    });

    const post = harness(readOf([question()], true));
    post.editor.open("relay:n1");
    await post.editor.submit(visitOf(post.editor), "Yes");
    expect(post.box.enqueued[0]?.write).toEqual({
      operation: "reply",
      args: { threadId: "t1", body: "Yes", resolves: { messageId: "q1" } },
    });
  });

  it("refuses a choice the poll doesn't offer", async () => {
    const { editor, box } = harness(readOf([question({ options: ["17:52"] })]));
    editor.open("relay:n1");
    expect(await editor.submit(visitOf(editor), "21:07", "21:07")).toEqual({ kind: "blocked" });
    expect(box.enqueued).toHaveLength(0);
  });

  it("sends once on a double tap", async () => {
    const { editor, box } = harness();
    editor.open("relay:n1");
    const gate = deferred();
    box.holdUntil(gate.promise);
    const visit = visitOf(editor);
    const first = editor.submit(visit, "Yes");
    const second = editor.submit(visit, "Yes");
    expect(await second).toEqual({ kind: "blocked" });
    gate.resolve();
    expect(await first).toEqual({ kind: "kept" });
    expect(box.enqueued).toHaveLength(1);
    // The question now has this phone's answer on its way, so it takes no other.
    expect(editor.open("relay:n1")).toBe(false);
  });

  it("asks nothing for an earlier visit, after the row's answer closed and opened again", async () => {
    const { editor, box } = harness();
    editor.open("relay:n1");
    const earlier = visitOf(editor);
    editor.close("relay:n1");
    editor.open("relay:n1");
    const later = visitOf(editor);
    expect(later.number).toBeGreaterThan(earlier.number);
    expect(await editor.submit(earlier, "Stale")).toEqual({ kind: "stale" });
    expect(box.enqueued).toHaveLength(0);
    expect(await editor.submit(later, "Fresh")).toEqual({ kind: "kept" });
  });

  it("asks nothing once the sign-in changed, the workspace hid, or a fresh read closed the question", async () => {
    const signedOut = harness();
    signedOut.editor.open("relay:n1");
    signedOut.signOut();
    expect(await signedOut.editor.submit(visitOf(signedOut.editor), "Yes")).toEqual({
      kind: "stale",
    });
    expect(signedOut.editor.open("relay:n1")).toBe(false);

    const hidden = harness();
    hidden.editor.open("relay:n1");
    hidden.hide();
    expect(await hidden.editor.submit(visitOf(hidden.editor), "Yes")).toEqual({ kind: "blocked" });

    const closed = harness();
    closed.editor.open("relay:n1");
    closed.read(readOf([question({ decisionState: "resolved" })]));
    expect(await closed.editor.submit(visitOf(closed.editor), "Yes")).toEqual({ kind: "blocked" });

    for (const { box } of [signedOut, hidden, closed]) expect(box.enqueued).toHaveLength(0);
  });

  it("drops a stale outcome when the sign-in changes during the enqueue", async () => {
    const { editor, box, signOut } = harness();
    editor.open("relay:n1");
    const gate = deferred();
    box.holdUntil(gate.promise);
    const pending = editor.submit(visitOf(editor), "Yes");
    signOut();
    gate.resolve();
    expect(await pending).toEqual({ kind: "stale" });
  });

  it("opens nothing for a question a read hasn't verified, or that waits for its chat list", () => {
    const unread = harness({ kind: "reading" });
    expect(unread.editor.open("relay:n1")).toBe(false);
    const noList = harness({ kind: "read", thread: thread([question()]) });
    expect(noList.editor.open("relay:n1")).toBe(false);
    expect(harness().editor.open("relay:other")).toBe(false);
  });

  it("keeps a withheld answer under its operation ID, and Send retries that one", async () => {
    const { editor, box } = harness();
    editor.open("relay:n1");
    box.fail(new OutboxError("indeterminate", "op-held"));
    expect(await editor.submit(visitOf(editor), "Yes")).toEqual({
      kind: "withheld",
      operationId: "op-held",
    });
    // It closes, so its text never goes again as another answer: the row's Send retries the same operation.
    expect(editor.state()).toBeNull();
    expect(await editor.recovery.retry("op-held")).toEqual({ kind: "kept" });
    expect(box.retried).toEqual(["op-held"]);
    expect(box.enqueued).toHaveLength(1);
  });

  it("closes, and asks nothing more, once stopped at a sign-in change", async () => {
    // Each sign-in has its own editor: the old one stops, so its open answer and field go with it.
    const { editor, box } = harness();
    editor.open("relay:n1");
    const visit = visitOf(editor);
    editor.stop();
    expect(editor.state()).toBeNull();
    expect(editor.open("relay:n1")).toBe(false);
    expect(await editor.submit(visit, "Yes")).toEqual({ kind: "stale" });
    expect(await editor.recovery.retry("op-1")).toEqual({ kind: "stale" });
    expect(box.enqueued).toHaveLength(0);
    // The next sign-in's editor starts with nothing open.
    expect(harness().editor.state()).toBeNull();
  });
});

const noActions: LocalActions = {
  blocked: false,
  problems: new Map(),
  send: () => undefined,
  discard: () => undefined,
  discardReaction: () => undefined,
  discardUnreadable: () => undefined,
  copy: () => undefined,
};

describe("what a Notice's row shows of its question", () => {
  const named = { threadId: "t1", messageId: "q1" };
  const view = (
    shown: ReturnType<typeof shownQuestion>,
    verified: VerifiedQuestion | null,
    answers: readonly OutboxRecord[],
  ) =>
    answerView({
      noticeId: "relay:n1",
      shown,
      verified,
      named,
      answers,
      editor: harness().editor,
      visit: null,
      actions: noActions,
    });

  it("shows this phone's answers for a workspace the phone no longer shows, from the outbox alone", () => {
    const held = view(null, null, [record({ withheld: true })]);
    expect(held?.decision.state.kind).toBe("held");
    expect(held?.marks.map((mark) => mark.state.kind)).toEqual(["withheld"]);
    // Discard stays; Send and a new answer don't.
    expect(held?.sendable).toBe(false);
    expect(held?.answerable).toBe(false);
    expect(held?.question).toBeNull();

    expect(view(null, null, [record({ stage: "sending" })])?.decision.state.kind).toBe("answering");
    const saved = view(null, null, [
      record({ stage: "saved", result: { kind: "saved", threadId: "t1", messageId: "m-op-1" } }),
    ]);
    expect(saved?.decision.state.kind).toBe("answered");
    expect(saved?.marks).toEqual([]);
    // Without a read or an answer, the row shows nothing of it.
    expect(view(null, null, [])).toBeNull();
  });

  it("names the competing answer that won, when a read shows it", () => {
    const read = readOf([
      question({ decisionState: "resolved", resolvedByMessageId: "w1" }),
      question({
        id: "w1",
        authorKind: "human",
        authorName: "Maya Chen",
        body: "21:07",
        needsDecision: false,
        decisionState: null,
      }),
    ]);
    const lost = record({
      stage: "refused",
      result: {
        kind: "refused",
        reason: "already answered",
        threadId: "t1",
        winnerMessageId: "w1",
      },
    });
    const surface = answerSurface(shownQuestion(TARGET, read), named, [lost]);
    expect(surface?.decision.state).toEqual({
      kind: "lost",
      chosen: null,
      winner: { name: "Maya Chen", body: "21:07" },
      replySent: false,
    });
    // Its row keeps Copy and Discard.
    expect(surface?.marks.map((mark) => mark.state.kind)).toEqual(["refused"]);
  });

  it("names the verified message's author, never the Notice's sender", () => {
    // The Notice came from Nova; the question its target names is Scout's.
    const read = readOf([question({ authorName: "Scout" })]);
    const shown = view(shownQuestion(TARGET, read), verifiedQuestion(TARGET, read), []);
    expect(shown?.question?.authorName).toBe("Scout");
    expect(shown?.answerable).toBe(true);
  });

  it("finds only the account's answers in the Notice's workspace", () => {
    const box = fakeOutbox();
    box.records.push(
      record({ operationId: "mine" }),
      record({ operationId: "other-workspace", workspaceId: "wA" }),
      record({ operationId: "other-account", accountId: "u2" }),
    );
    const answers = answerLookup(box.outbox.state(), SCOPE)("wB", "q1");
    expect(answers.map((each) => each.operationId)).toEqual(["mine"]);
    expect(answerLookup(null, SCOPE)("wB", "q1")).toEqual([]);
  });
});
