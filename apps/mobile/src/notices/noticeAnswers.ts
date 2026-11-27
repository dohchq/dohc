import {
  createConversationWrites,
  createWriteScope,
  type ConversationWrites,
  type OutboxRecord,
  type SubmitOutcome,
  type WriteOutbox,
} from "../conversation/conversationWrites";
import {
  answerPlace,
  answerRecords,
  answerWrite,
  decisionOf,
  type Asked,
} from "../conversation/decisionAnswers";
import { localMark, type OutboxScope } from "../conversation/outboxMessages";
import type { Decision, LocalMark } from "../conversation/types";
import type { LocalActions } from "../conversation/useOutbox";
import type { SignIn } from "../server/account";
import type { NoticeRecord } from "../server/notices";
import type { OutboxState } from "../server/outbox";
import {
  takesAnswer,
  type MessageTarget,
  type ShownQuestion,
  type VerifiedQuestion,
} from "./noticeWrites";
import type { NoticeAnswerView } from "./phoneNotice";

// An agent's question answered in its Notice's row. The editor is held above the recycled rows, one per sign-in, and
// shows at most one row's answer at a time. Each Answer press is a new visit with its own write activation, so a
// controller from an earlier visit, a recycled row, or another sign-in asks the outbox nothing. Every write checks the
// sign-in, the visit, and that the latest list and read still verify the same question, and goes to the Notice's own
// workspace, never the open one. What the row shows of its answers comes from the outbox's records, whatever the list
// says now, so an answer queued for a workspace that later hides stays in sight, with Discard. The open answer's text
// is kept here too, so it comes back when its recycled row does, and goes when the answer closes or the sign-in changes.

const NO_RECORDS: readonly OutboxRecord[] = [];

/** This phone's answers in the account's outbox, by workspace and question. Unchanged questions share one empty list. */
export function answerLookup(state: OutboxState | null, scope: OutboxScope) {
  const byWorkspace = new Map<string, ReadonlyMap<string, readonly OutboxRecord[]>>();
  return (workspaceId: string, questionId: string): readonly OutboxRecord[] => {
    if (state === null) return NO_RECORDS;
    let answers = byWorkspace.get(workspaceId);
    if (!answers) {
      answers = answerRecords(state, { ...scope, workspaceId });
      byWorkspace.set(workspaceId, answers);
    }
    return answers.get(questionId) ?? NO_RECORDS;
  };
}

/** The workspace and question an agent-run Notice names, whether or not the phone shows its workspace now. */
export function namedQuestion(
  record: NoticeRecord,
): { readonly workspaceId: string; readonly threadId: string; readonly messageId: string } | null {
  const { workspaceId, target } = record;
  if (record.kind !== "agent-run" || workspaceId === null) return null;
  if (target?.thread === undefined || target.message === undefined) return null;
  return { workspaceId, threadId: target.thread, messageId: target.message };
}

/** A question no current read shows, so only this phone's answers say where it stands. */
const unshown = (id: string, threadId: string): Asked => ({
  id,
  threadId,
  parentMessageId: null,
  decisionState: "open",
  options: [],
  optionDetails: [],
  chosenOption: null,
  resolvedByMessageId: null,
});

/**
 * A record whose row needs the person: any this phone keeps that isn't saved. Each has Discard, whatever the list says
 * now, so an answer for a workspace the phone can no longer open, still sending, can always be taken back.
 */
export const needsPerson = (mark: LocalMark) => mark.state.kind !== "saved";

/**
 * Reads each question's thread again once this phone's answer to it is saved, so the reply shows and the outbox hands
 * the record off. An answer counts as read again only once a read of it started: one whose row no read wants now, as
 * after leaving Notices, is tried again at the outbox's next change, or read with its row when it shows again.
 */
export function rereadSaved(
  questions: readonly MessageTarget[],
  answers: (target: MessageTarget) => readonly OutboxRecord[],
  retry: (target: MessageTarget) => boolean,
  done: Set<string>,
): void {
  for (const target of questions)
    for (const saved of answers(target))
      if (saved.stage === "saved" && !done.has(saved.operationId) && retry(target))
        done.add(saved.operationId);
}

/**
 * Where the Notice's question stands, and this phone's answers that need the person, or null when the row has neither
 * a read that shows the question nor an answer of this phone's. `shown` is the read's question, null in a workspace
 * the phone no longer shows; the outbox's records alone then say Answering, Answered or that another answer won.
 */
export function answerSurface(
  shown: ShownQuestion | null,
  named: { readonly threadId: string; readonly messageId: string },
  answers: readonly OutboxRecord[],
): { readonly decision: Decision; readonly marks: readonly LocalMark[] } | null {
  if (!shown && answers.length === 0) return null;
  const asked = shown?.question ?? unshown(named.messageId, named.threadId);
  const decision = decisionOf(asked, answers, (id) => shown?.byId.get(id));
  if (!decision) return null;
  const marks = answers.filter((record) => record.stage !== "saved").map(localMark);
  return { decision, marks };
}

/**
 * The reply a read shows as the question's chosen answer, by its message ID, or null. Its wakes are the row's. A reply
 * of this phone's that lost is never the chosen one, and a reply the read doesn't show has no wakes to show.
 */
export function answerReply(shown: ShownQuestion | null): string | null {
  const question = shown?.question;
  const id = question?.decisionState === "resolved" ? question.resolvedByMessageId : null;
  return id !== null && id !== undefined && shown?.byId.has(id) === true ? id : null;
}

/**
 * What a Notice's row shows of its question and this phone's answers, with what its controls do, or null when it shows
 * neither. `shown` and `verified` come from the latest list, sign-in and read; `answers` from the outbox, whatever the
 * list says now. A new answer goes only while `verified` holds and the question takes one; Send on a withheld answer
 * only while `verified` holds; Discard always. An open answer keeps its question, as its visit verified it, and its text
 * through a failed read, with Send off until a read shows the question again, but only while `showing`.
 */
export function answerView(input: {
  readonly noticeId: string;
  readonly shown: ShownQuestion | null;
  readonly verified: VerifiedQuestion | null;
  /** The phone shows the Notice's workspace now, for the current sign-in. */
  readonly showing: boolean;
  readonly named: { readonly threadId: string; readonly messageId: string };
  readonly answers: readonly OutboxRecord[];
  readonly editor: NoticeEditor;
  /** The open visit, or null. */
  readonly visit: AnswerVisit | null;
  readonly actions: LocalActions;
  readonly open?: () => void;
}): NoticeAnswerView | null {
  const { noticeId, shown, verified, answers, editor, actions, open } = input;
  const visit = input.visit?.noticeId === noticeId ? input.visit : null;
  const held = shown ?? (visit && input.showing ? visit.question : null);
  const surface = answerSurface(held, input.named, answers);
  if (!surface) return null;
  const question = held?.question;
  return {
    question: question
      ? { id: question.id, authorName: question.authorName, body: question.body }
      : null,
    decision: surface.decision,
    marks: surface.marks,
    editing: visit?.number ?? null,
    current: shown !== null,
    answerable: verified !== null && takesAnswer(verified.question, answers),
    sendable: verified !== null,
    cancel: () => editor.close(noticeId),
    ...(open ? { open } : {}),
    submit: (body, option) =>
      visit
        ? editor.submit(visit, body, option)
        : Promise.resolve<SubmitOutcome>({ kind: "stale" }),
    draft: () => (visit ? editor.draft(visit) : ""),
    keepDraft: (text) => {
      if (visit) editor.keepDraft(visit, text);
    },
    actions,
  };
}

/** One showing of a Notice's in-row answer. Each Answer press is another. */
export interface AnswerVisit {
  readonly noticeId: string;
  readonly target: MessageTarget;
  /** The question as the latest list and read verified it when the visit opened. */
  readonly question: ShownQuestion;
  /** Counts visits, so each has its own field and text. */
  readonly number: number;
}

export interface NoticeEditor {
  /** The open visit, or null. A new object at each change. */
  state(): AnswerVisit | null;
  subscribe(listener: () => void): () => void;
  /** Opens the row's answer, closing any other, when its question is verified and takes an answer now. */
  open(noticeId: string): boolean;
  /** Closes the row's answer, or whichever is open, and drops its text. */
  close(noticeId?: string): void;
  /**
   * Answers the visit's question with `body`, or with a poll's `option`. One at a time per question, across visits, until
   * the outbox answers. A poll's visit closes once the outbox keeps the choice, or may keep it withheld, whose row then
   * offers Send. A free answer's stays open until its field cleared the text sent, so text typed meanwhile stays.
   */
  submit(visit: AnswerVisit, body: string, option?: string): Promise<SubmitOutcome>;
  /** The open visit's text, as its field last reported it, or "" for any other visit. */
  draft(visit: AnswerVisit): string;
  /** Keeps the open visit's text above the recycled rows. It draws nothing. */
  keepDraft(visit: AnswerVisit, text: string): void;
  /** Send and Discard on this phone's answers, whatever row they show in, for this sign-in only. */
  readonly recovery: ConversationWrites;
  /** Closes the visit and asks nothing more. */
  stop(): void;
}

const sameTarget = (a: MessageTarget, b: MessageTarget) =>
  a.workspaceId === b.workspaceId && a.threadId === b.threadId && a.messageId === b.messageId;

const questionKey = (target: MessageTarget) =>
  JSON.stringify([target.workspaceId, target.threadId, target.messageId]);

export function createNoticeEditor(options: {
  readonly signIn: Pick<SignIn, "isCurrent">;
  readonly outbox: WriteOutbox | null;
  /** The build's phone writes gate. */
  readonly enabled: boolean;
  /** The question the Notice names, as the latest list, sign-in and read verify it now, or null. */
  verify(noticeId: string): VerifiedQuestion | null;
  /** This phone's answers to the question, from the outbox now. */
  answers(target: MessageTarget): readonly OutboxRecord[];
}): NoticeEditor {
  const { signIn, outbox, enabled, verify, answers } = options;
  const scope = createWriteScope();
  const listeners = new Set<() => void>();
  let shown: {
    readonly visit: AnswerVisit;
    readonly writes: ConversationWrites;
    release(): void;
    draft: string;
  } | null = null;
  let visits = 0;
  let stopped = false;
  // The questions whose answer the outbox is keeping now. A visit closed and opened again meanwhile, or another Notice
  // naming the same question, sends no second answer: the first isn't in the outbox's records until it answers.
  const submitting = new Set<string>();

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const close = (noticeId?: string) => {
    if (!shown || (noticeId !== undefined && shown.visit.noticeId !== noticeId)) return;
    shown.release();
    shown = null;
    notify();
  };
  // The list, read and sign-in still verify the question this visit opened for.
  const stillVerified = (visit: AnswerVisit) => {
    const now = verify(visit.noticeId);
    return now !== null && sameTarget(now.target, visit.target) ? now : null;
  };

  const editor: NoticeEditor = {
    state: () => shown?.visit ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    open(noticeId) {
      if (stopped || !enabled || !signIn.isCurrent()) return false;
      const question = verify(noticeId);
      if (!question || !takesAnswer(question.question, answers(question.target))) return false;
      close();
      visits += 1;
      const visit: AnswerVisit = { noticeId, target: question.target, question, number: visits };
      const { workspaceId, threadId, messageId } = question.target;
      const activation = {
        store: editor,
        target: JSON.stringify([noticeId, workspaceId, threadId, messageId, visit.number]),
      };
      const release = scope.show(activation);
      const writes = createConversationWrites({
        outbox,
        enabled,
        isCurrent: () =>
          !stopped &&
          signIn.isCurrent() &&
          scope.shows(activation) &&
          stillVerified(visit) !== null,
      });
      shown = { visit, writes, release, draft: "" };
      notify();
      return true;
    },
    close,
    async submit(visit, body, option) {
      const now = shown;
      if (!now || now.visit !== visit) return { kind: "stale" };
      const key = questionKey(visit.target);
      if (submitting.has(key)) return { kind: "blocked" };
      const question = stillVerified(visit);
      if (!question || !takesAnswer(question.question, answers(visit.target)))
        return { kind: "blocked" };
      const asked = question.question;
      if (option !== undefined && !asked.options.includes(option)) return { kind: "blocked" };
      const place = answerPlace(asked, (id) => question.byId.get(id)?.parentMessageId, {
        post: question.post,
        poll: option !== undefined,
      });
      const write = answerWrite(place, asked.id, body, option);
      if (!write) return { kind: "blocked" };
      submitting.add(key);
      try {
        const outcome = await now.writes.submit(visit.target.workspaceId, write);
        if (
          option !== undefined &&
          (outcome.kind === "kept" || outcome.kind === "withheld") &&
          shown?.visit === visit
        )
          close();
        return outcome;
      } finally {
        submitting.delete(key);
      }
    },
    draft(visit) {
      const now = shown;
      return now && now.visit === visit ? now.draft : "";
    },
    keepDraft(visit, text) {
      const now = shown;
      if (now && now.visit === visit) now.draft = text;
    },
    recovery: createConversationWrites({
      outbox,
      enabled,
      isCurrent: () => !stopped && signIn.isCurrent(),
    }),
    stop() {
      stopped = true;
      close();
    },
  };
  return editor;
}
