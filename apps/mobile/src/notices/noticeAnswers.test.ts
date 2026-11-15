import { describe, expect, it } from "vitest";
import {
  clearedBy,
  clearStatus,
  type OutboxRecord,
  type WriteOutbox,
} from "../conversation/conversationWrites";
import { localOffers, maySend } from "../conversation/outboxMessages";
import type { LocalMark } from "../conversation/types";
import type { LocalActions } from "../conversation/useOutbox";
import { OutboxError } from "../server/outbox";
import type { ChatMessage, ChatThread } from "../server/workspaceReads";
import {
  answerLookup,
  answerSurface,
  answerView,
  createNoticeEditor,
  rereadSaved,
  type NoticeEditor,
} from "./noticeAnswers";
import { isExpanded } from "./rowAccessibility";
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
    // Kept, the answer stays open until its field clears the text sent.
    expect(editor.state()).not.toBeNull();
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
    // Its field clears the text, as for a kept answer, so it never goes again as another: the row's Send retries the
    // same operation.
    expect(editor.state()).not.toBeNull();
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
      showing: shown !== null,
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

describe("an answer the person is still writing or sending", () => {
  const named = { threadId: "t1", messageId: "q1" };
  /** The row's view now, as a recycled row coming back on screen draws it. */
  const rowView = (
    editor: NoticeEditor,
    read: TargetRead,
    answers: readonly OutboxRecord[] = [],
    showing = true,
  ) =>
    answerView({
      noticeId: "relay:n1",
      shown: showing ? shownQuestion(TARGET, read) : null,
      verified: showing ? verifiedQuestion(TARGET, read) : null,
      showing,
      named,
      answers,
      editor,
      visit: editor.state(),
      actions: noActions,
    });

  it("sends one answer when the answer is cancelled and opened again while the outbox keeps the first", async () => {
    const { editor, box } = harness();
    editor.open("relay:n1");
    const gate = deferred();
    box.holdUntil(gate.promise);
    const first = editor.submit(visitOf(editor), "Yes");
    // Cancel reply, then Answer again, before the outbox has the first answer in its records.
    editor.close("relay:n1");
    expect(editor.open("relay:n1")).toBe(true);
    expect(await editor.submit(visitOf(editor), "No")).toEqual({ kind: "blocked" });
    gate.resolve();
    // The first visit ended, so its outcome is stale, but the outbox kept it, once.
    expect(await first).toEqual({ kind: "stale" });
    expect(box.enqueued).toHaveLength(1);
    expect(await editor.submit(visitOf(editor), "No")).toEqual({ kind: "blocked" });
    expect(box.enqueued).toHaveLength(1);
  });

  it("lets a question take an answer again once a submit the outbox refused has ended", async () => {
    const { editor, box } = harness();
    editor.open("relay:n1");
    box.fail(new OutboxError("closed"));
    expect(await editor.submit(visitOf(editor), "Yes")).toEqual({ kind: "blocked" });
    box.fail(null);
    expect(await editor.submit(visitOf(editor), "Yes")).toEqual({ kind: "kept" });
  });

  it("closes a free answer only once its field cleared the text sent, so text typed meanwhile stays", async () => {
    const { editor } = harness();
    editor.open("relay:n1");
    const visit = visitOf(editor);
    editor.keepDraft(visit, "Yes, and");
    expect(await editor.submit(visit, "Yes")).toEqual({ kind: "kept" });
    // Kept, it stays open with what the field holds, until the field says it cleared the body sent.
    expect(editor.state()).toBe(visit);
    expect(editor.draft(visit)).toBe("Yes, and");

    // Sent at revision 3 under token 1. The field's own clear for that request closes it.
    const request = { revision: 3, token: 1 };
    expect(clearedBy({ text: "", revision: 4, cleared: 1, refused: 0 }, request)).toBe(true);
    // Text typed meanwhile: the field refuses, keeps it, and the answer stays open with Send on for the new text.
    const typed = { text: "Yes, and", revision: 5, cleared: 0, refused: 1 };
    expect(clearedBy(typed, request)).toBe(false);
    expect(clearStatus(request, typed.revision, typed.refused)).toBe("settled");
    // Text still being composed: refused unchanged, so Send stays off for the body already kept.
    expect(clearedBy({ text: "Yes", revision: 3, cleared: 0, refused: 1 }, request)).toBe(false);
    expect(clearStatus(request, 3, 1)).toBe("refused");
    // An edit, or an earlier request's clear, closes nothing.
    expect(clearedBy({ text: "Ye", revision: 4, cleared: 0, refused: 0 }, request)).toBe(false);
    expect(
      clearedBy({ text: "", revision: 4, cleared: 1, refused: 0 }, { revision: 6, token: 2 }),
    ).toBe(false);
  });

  it("closes a poll's answer once the outbox keeps the choice", async () => {
    const { editor } = harness(readOf([question({ options: ["17:52", "19:52"] })]));
    editor.open("relay:n1");
    expect(await editor.submit(visitOf(editor), "19:52", "19:52")).toEqual({ kind: "kept" });
    expect(editor.state()).toBeNull();
  });

  it("keeps the open answer's text above its row, and drops it when the answer closes or the sign-in changes", () => {
    const read = readOf([question()]);
    const { editor } = harness(read);
    editor.open("relay:n1");
    const visit = visitOf(editor);
    editor.keepDraft(visit, "Lisbon, then");
    // The row scrolls away and comes back: its new view gives the field the same text.
    expect(rowView(editor, read)?.draft()).toBe("Lisbon, then");
    rowView(editor, read)?.keepDraft("Lisbon, then Porto");
    expect(rowView(editor, read)?.draft()).toBe("Lisbon, then Porto");

    // Cancel reply drops it, and the next visit starts empty.
    editor.close("relay:n1");
    expect(editor.draft(visit)).toBe("");
    editor.open("relay:n1");
    const next = visitOf(editor);
    expect(editor.draft(next)).toBe("");
    // An earlier visit's field keeps nothing.
    editor.keepDraft(visit, "Stale");
    expect(editor.draft(next)).toBe("");

    // A sign-in change stops this sign-in's editor, and its text goes with it.
    editor.keepDraft(next, "Porto");
    editor.stop();
    expect(editor.draft(next)).toBe("");
    expect(rowView(editor, read)?.draft()).toBe("");
  });

  it("keeps an open answer, its question and its text through a failed read, with Send off", async () => {
    const read = readOf([question()]);
    const h = harness(read);
    h.editor.open("relay:n1");
    const visit = visitOf(h.editor);
    h.editor.keepDraft(visit, "Half an answer");
    h.read({ kind: "failed" });
    const failed = rowView(h.editor, { kind: "failed" });
    expect(failed?.editing).toBe(visit.number);
    expect(failed?.question).toEqual({
      id: "q1",
      authorName: "Scout",
      body: "Which return train?",
    });
    expect(failed?.current).toBe(false);
    expect(failed?.answerable).toBe(false);
    expect(failed?.sendable).toBe(false);
    expect(failed?.draft()).toBe("Half an answer");
    expect(await h.editor.submit(visit, "Half an answer")).toEqual({ kind: "blocked" });
    expect(h.editor.state()).toBe(visit);
    // Try again reads it: the question is current again, and Send can go.
    h.read(read);
    expect(rowView(h.editor, read)).toMatchObject({ current: true, answerable: true });
    expect(await h.editor.submit(visit, "Half an answer")).toEqual({ kind: "kept" });

    // Once the workspace stops showing on the phone, the row shows nothing of the question.
    const hidden = harness(read);
    hidden.editor.open("relay:n1");
    expect(rowView(hidden.editor, { kind: "failed" }, [], false)).toBeNull();
  });

  it("offers Discard on an answer still sending in a workspace the phone no longer shows, warning it may still send", async () => {
    const discarded: LocalMark[] = [];
    const { editor } = harness();
    const sending = answerView({
      noticeId: "relay:n1",
      shown: null,
      verified: null,
      showing: false,
      named,
      // Repeated 404s leave it sending, with no result.
      answers: [record({ stage: "sending", attempted: true })],
      editor,
      visit: null,
      actions: { ...noActions, discard: (mark) => void discarded.push(mark) },
    });
    expect(sending?.decision.state.kind).toBe("answering");
    const mark = sending?.marks[0];
    if (!sending || !mark) throw new Error("The row shows no answer");
    expect(mark.state.kind).toBe("sending");
    // The row opens to show it, with Discard and nothing else, and no Done.
    const row = {
      id: "relay:n1",
      relayId: "n1",
      senderKind: "agent" as const,
      senderLabel: "Nova",
      title: "Nova has a question",
      minutesAgo: 0,
      read: true,
      dismissible: true,
      answer: sending,
    };
    expect(isExpanded(row)).toBe(true);
    expect(localOffers(mark, { sendable: sending.sendable, discardsPending: true })).toEqual({
      send: false,
      copy: false,
      discard: true,
    });
    // Its request may have reached the server, so Discard warns that it may still send.
    expect(maySend(mark)).toBe(true);
    sending.actions.discard(mark);
    expect(discarded).toEqual([mark]);
    // Discard goes through this sign-in's recovery, whatever the list says.
    expect(
      await editor.recovery.discard({ kind: "record", operationId: mark.operationId }),
    ).toEqual({ kind: "discarded" });

    // One not yet tried has Discard too, without the warning. Elsewhere, a waiting message offers nothing.
    const waiting = { ...mark, state: { kind: "waiting" as const }, attempted: false };
    expect(localOffers(waiting, { sendable: false, discardsPending: true }).discard).toBe(true);
    expect(maySend(waiting)).toBe(false);
    expect(localOffers(waiting, { sendable: true, discardsPending: false }).discard).toBe(false);
  });

  it("marks a saved answer read again only once a read of its thread started", () => {
    const saved = record({
      stage: "saved",
      result: { kind: "saved", threadId: "t1", messageId: "m-op-1" },
    });
    const done = new Set<string>();
    const started: MessageTarget[] = [];
    let wanted = false;
    const retry = (target: MessageTarget) => {
      if (!wanted) return false;
      started.push(target);
      return true;
    };
    // The person left Notices before the answer saved: no row wants the thread, so no read starts, and it waits.
    rereadSaved([TARGET], () => [saved], retry, done);
    expect(done.size).toBe(0);
    // Wanted again, the next change reads it, once.
    wanted = true;
    rereadSaved([TARGET], () => [saved], retry, done);
    rereadSaved([TARGET], () => [saved], retry, done);
    expect(started).toEqual([TARGET]);
    expect([...done]).toEqual(["op-1"]);
    // An answer not saved yet reads nothing.
    rereadSaved([TARGET], () => [record()], retry, new Set());
    expect(started).toHaveLength(1);
  });
});
