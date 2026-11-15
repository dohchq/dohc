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
// says now, so an answer queued for a workspace that later hides stays in sight, with Discard.

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
  chosenOption: null,
  resolvedByMessageId: null,
});

/** A record whose row needs the person: one withheld, still sending, refused, or whose chat is gone. */
export const needsPerson = (mark: LocalMark) =>
  mark.state.kind === "withheld" ||
  mark.state.kind === "stalled" ||
  mark.state.kind === "refused" ||
  mark.state.kind === "missing";

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
 * What a Notice's row shows of its question and this phone's answers, with what its controls do, or null when it shows
 * neither. `shown` and `verified` come from the latest list, sign-in and read; `answers` from the outbox, whatever the
 * list says now. A new answer goes only while `verified` holds and the question takes one; Send on a withheld answer
 * only while `verified` holds; Discard always.
 */
export function answerView(input: {
  readonly noticeId: string;
  readonly shown: ShownQuestion | null;
  readonly verified: VerifiedQuestion | null;
  readonly named: { readonly threadId: string; readonly messageId: string };
  readonly answers: readonly OutboxRecord[];
  readonly editor: NoticeEditor;
  /** The open visit, or null. */
  readonly visit: AnswerVisit | null;
  readonly actions: LocalActions;
  readonly open?: () => void;
}): NoticeAnswerView | null {
  const { noticeId, shown, verified, answers, editor, actions, open } = input;
  const surface = answerSurface(shown, input.named, answers);
  if (!surface) return null;
  const visit = input.visit?.noticeId === noticeId ? input.visit : null;
  const question = shown?.question;
  return {
    question: question
      ? { id: question.id, authorName: question.authorName, body: question.body }
      : null,
    decision: surface.decision,
    marks: surface.marks,
    editing: visit?.number ?? null,
    answerable: verified !== null && takesAnswer(verified.question, answers),
    sendable: verified !== null,
    cancel: () => editor.close(noticeId),
    ...(open ? { open } : {}),
    submit: (body, option) =>
      visit
        ? editor.submit(visit, body, option)
        : Promise.resolve<SubmitOutcome>({ kind: "stale" }),
    actions,
  };
}

/** One showing of a Notice's in-row answer. Each Answer press is another. */
export interface AnswerVisit {
  readonly noticeId: string;
  readonly target: MessageTarget;
  /** Counts visits, so each has its own field and text. */
  readonly number: number;
}

export interface NoticeEditor {
  /** The open visit, or null. A new object at each change. */
  state(): AnswerVisit | null;
  subscribe(listener: () => void): () => void;
  /** Opens the row's answer, closing any other, when its question is verified and takes an answer now. */
  open(noticeId: string): boolean;
  /** Closes the row's answer, or whichever is open. */
  close(noticeId?: string): void;
  /**
   * Answers the visit's question with `body`, or with a poll's `option`. The visit closes once the outbox keeps it, or
   * may keep it withheld, whose row then offers Send.
   */
  submit(visit: AnswerVisit, body: string, option?: string): Promise<SubmitOutcome>;
  /** Send and Discard on this phone's answers, whatever row they show in, for this sign-in only. */
  readonly recovery: ConversationWrites;
  /** Closes the visit and asks nothing more. */
  stop(): void;
}

const sameTarget = (a: MessageTarget, b: MessageTarget) =>
  a.workspaceId === b.workspaceId && a.threadId === b.threadId && a.messageId === b.messageId;

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
  } | null = null;
  let visits = 0;
  let stopped = false;

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
      const visit: AnswerVisit = { noticeId, target: question.target, number: visits };
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
      shown = { visit, writes, release };
      notify();
      return true;
    },
    close,
    async submit(visit, body, option) {
      const now = shown;
      if (!now || now.visit !== visit) return { kind: "stale" };
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
      const outcome = await now.writes.submit(visit.target.workspaceId, write);
      if ((outcome.kind === "kept" || outcome.kind === "withheld") && shown?.visit === visit)
        close();
      return outcome;
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
