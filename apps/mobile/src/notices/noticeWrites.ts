import type { OutboxRecord } from "../conversation/conversationWrites";
import { decisionOf } from "../conversation/decisionAnswers";
import type { SignIn } from "../server/account";
import type { NoticeRecord } from "../server/notices";
import { readLane } from "../server/readLane";
import { isJoined, type WorkspaceList } from "../server/workspaceList";
import type {
  ChatGroup,
  ChatMessage,
  ChatThread,
  MissingChat,
  Read,
} from "../server/workspaceReads";
import { phoneTarget, type PhoneTarget } from "./phoneNotice";

// Which action a Notice's row offers first, and the reads that decide it. A mention's row offers Reply only once a
// current read of its thread shows the exact message it names. An agent-run Notice's row offers Answer only once a
// current read shows that exact message as an agent's open question, and a read of the workspace's chat list says
// whether its thread is a post's, so the answer goes where the desktop puts it. Without those reads the row keeps
// Open, and a failed read offers Try again in the row. The phone never guesses a target: it doesn't search the thread
// for another message, and a Notice's placement, wording or sender proves nothing.

/** The thread and message a Notice names, in a workspace the phone shows and can open. */
export interface MessageTarget {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly messageId: string;
  /** An agent's question to answer in the row: its read also reads the workspace's chat list, to place the answer. */
  readonly answer?: true;
}

function messageTarget(record: NoticeRecord, list: WorkspaceList): MessageTarget | null {
  const target = phoneTarget(record, list);
  if (target?.kind !== "thread" || target.messageId === null) return null;
  if (list.status !== "ready" || isJoined(list.workspaces, target.workspaceId)) return null;
  return {
    workspaceId: target.workspaceId,
    threadId: target.threadId,
    messageId: target.messageId,
  };
}

/**
 * The message a mention's row would reply to once a read shows it, or null for any other row: phone writes off, another
 * kind of Notice, a target the phone can't open, or one that names no message.
 */
export function replyCandidate(
  record: NoticeRecord,
  list: WorkspaceList,
  writes: boolean,
): MessageTarget | null {
  if (!writes || record.kind !== "mention") return null;
  return messageTarget(record, list);
}

/** The question an agent-run Notice's row would answer once a read verifies it, or null for any other row. */
export function answerCandidate(
  record: NoticeRecord,
  list: WorkspaceList,
  writes: boolean,
): MessageTarget | null {
  if (!writes || record.kind !== "agent-run") return null;
  const target = messageTarget(record, list);
  return target && { ...target, answer: true };
}

/** The read a row's first action needs, if any. */
export const candidateOf = (record: NoticeRecord, list: WorkspaceList, writes: boolean) =>
  replyCandidate(record, list, writes) ?? answerCandidate(record, list, writes);

/** One read per workspace and thread, however many Notices name it. */
export const targetKey = (target: { readonly workspaceId: string; readonly threadId: string }) =>
  JSON.stringify([target.workspaceId, target.threadId]);

/** Whether a chat list names `threadId` as a post's thread. A list that doesn't name it says it's no post. */
export const isPost = (chats: readonly ChatGroup[], threadId: string) =>
  chats.find((group) => group.threadIds.includes(threadId))?.postThreadIds?.includes(threadId) ===
  true;

/** Where the read of a Notice's thread stands. */
export type TargetRead =
  | { readonly kind: "reading" }
  | {
      readonly kind: "read";
      readonly thread: ChatThread | MissingChat;
      /** Whether the thread is a post's, from a read of the chat list made with it. Absent when none was asked. */
      readonly post?: boolean;
    }
  | { readonly kind: "failed" };

/** The target's exact message, when `read` is of the target's own thread and shows it, in that thread. */
function shownMessage(target: MessageTarget, read: TargetRead | undefined) {
  if (read?.kind !== "read" || read.thread.kind !== "thread") return undefined;
  if (read.thread.id !== target.threadId) return undefined;
  return read.thread.messages.find(
    (message) => message.id === target.messageId && message.threadId === target.threadId,
  );
}

/** Whether `read` is of the target's own thread and shows its exact message, in that thread. */
export const shows = (target: MessageTarget, read: TargetRead | undefined) =>
  shownMessage(target, read) !== undefined;

/** The question an agent-run Notice names, as a read shows it: the exact message, an agent's, asking a decision. */
export interface ShownQuestion {
  readonly target: MessageTarget;
  readonly question: ChatMessage;
  /** The messages the read shows, by ID, to name a winning answer and find a reply's chain. */
  readonly byId: ReadonlyMap<string, ChatMessage>;
}

/** The exact message the target names as an agent's question or poll, in any state, or null. Never matched by name. */
export function shownQuestion(
  target: MessageTarget,
  read: TargetRead | undefined,
): ShownQuestion | null {
  if (target.answer !== true) return null;
  const question = shownMessage(target, read);
  if (!question || question.authorKind !== "agent" || !question.needsDecision) return null;
  const messages =
    read?.kind === "read" && read.thread.kind === "thread" ? read.thread.messages : [];
  return { target, question, byId: new Map(messages.map((entry) => [entry.id, entry])) };
}

/** A question the row may answer: open on the server, with its thread's kind known from a fresh chat list. */
export interface VerifiedQuestion extends ShownQuestion {
  readonly post: boolean;
}

/**
 * The target's question when a current read shows it open and says whether its thread is a post's, or null. It says
 * nothing of this phone's own answers, which `decisionOf` adds.
 */
export function verifiedQuestion(
  target: MessageTarget,
  read: TargetRead | undefined,
): VerifiedQuestion | null {
  const shown = shownQuestion(target, read);
  if (!shown || shown.question.decisionState !== "open") return null;
  if (read?.kind !== "read" || read.post === undefined) return null;
  return { ...shown, post: read.post };
}

/** Whether the question takes a new answer from this phone: none of its answers is on its way, held, saved or lost. */
export const takesAnswer = (question: ChatMessage, answers: readonly OutboxRecord[]) =>
  decisionOf(question, answers)?.state.kind === "open";

/**
 * What a row's first action does. `reply` opens the thread with the message chosen to reply to. `answer` opens the
 * row's own answer to the agent's question. `open` goes to the target, with `readFailed` when the read that would offer
 * Reply or Answer failed. `elsewhere`: only a computer opens it.
 */
export type NoticeAction =
  | { readonly kind: "reply"; readonly target: MessageTarget }
  | { readonly kind: "answer"; readonly question: VerifiedQuestion }
  | { readonly kind: "open"; readonly target: PhoneTarget; readonly readFailed: boolean }
  | { readonly kind: "elsewhere" };

/** The row's first action, from the latest list, sign-in, reads and this phone's answers. Checked again on action. */
export function noticeAction(
  record: NoticeRecord,
  context: {
    readonly list: WorkspaceList;
    /** The build's phone writes gate. */
    readonly writes: boolean;
    readonly signIn: Pick<SignIn, "isCurrent"> | null;
    readonly reads: ReadonlyMap<string, TargetRead>;
    /** This phone's answers to the target's question, from the outbox. None when absent. */
    readonly answers?: (target: MessageTarget) => readonly OutboxRecord[];
  },
): NoticeAction {
  const target = phoneTarget(record, context.list);
  if (!target) return { kind: "elsewhere" };
  const candidate =
    context.signIn?.isCurrent() === true ? candidateOf(record, context.list, context.writes) : null;
  const read = candidate ? context.reads.get(targetKey(candidate)) : undefined;
  if (candidate && candidate.answer !== true && shows(candidate, read))
    return { kind: "reply", target: candidate };
  const question = candidate ? verifiedQuestion(candidate, read) : null;
  if (candidate && question && takesAnswer(question.question, context.answers?.(candidate) ?? []))
    return { kind: "answer", question };
  return { kind: "open", target, readFailed: candidate !== null && read?.kind === "failed" };
}

export interface NoticeTargets {
  /** A new map at each change. */
  state(): ReadonlyMap<string, TargetRead>;
  subscribe(listener: () => void): () => void;
  /** Reads each target's thread once, unless it's read or being read already. */
  want(targets: readonly MessageTarget[]): void;
  /** Reads the target's thread again, as Try again does, and says whether a read started: none for a thread no row wants. */
  retry(target: MessageTarget): boolean;
  /** Reads every thread again. A verified read stays until its next answer. */
  refresh(): void;
  /** Ends every read under way: nothing they answer applies. A later `want` asks again. */
  stop(): void;
}

/**
 * The reads behind Reply and Answer on the rows a person can see, one per workspace and thread. One sign-in's: an
 * answer applies only while that sign-in is current, no `stop` ended it, and no later read of the same thread replaced
 * it. The read is the server's filtered thread read, which checks ownership and Show on phone; it never marks the
 * thread read. A thread an answer needs also has the workspace's chat list read with it, and both must answer.
 *
 * What it keeps is whole threads, in memory only, never on disk. A thread no row wants any more is dropped at once, as
 * when its workspace stops showing on the phone, and `stop` drops them all, as at a sign-in change.
 */
export function createNoticeTargets(options: {
  readonly signIn: Pick<SignIn, "isCurrent">;
  read(
    workspaceId: string,
    threadId: string,
    signal: AbortSignal,
  ): Promise<Read<ChatThread | MissingChat>>;
  /** Whether the thread is a post's, from a fresh read of the workspace's chat list (`isPost`). */
  readPost?(workspaceId: string, threadId: string, signal: AbortSignal): Promise<boolean>;
  /** Each current read that shows a thread, for the outbox's handoff. */
  onThread?(workspaceId: string, thread: ChatThread): void;
}): NoticeTargets {
  const { signIn, read, readPost, onThread } = options;
  const lane = readLane(signIn);
  let entries: ReadonlyMap<string, TargetRead> = new Map();
  const targets = new Map<string, MessageTarget>();
  const running = new Map<string, AbortController>();
  const listeners = new Set<() => void>();

  const set = (key: string, entry: TargetRead) => {
    entries = new Map(entries).set(key, entry);
    for (const listener of listeners) listener();
  };

  /** Starts the target's read, unless the sign-in has ended, and says whether it did. */
  const start = (key: string, target: MessageTarget): boolean => {
    if (!signIn.isCurrent()) return false;
    running.get(key)?.abort();
    const controller = new AbortController();
    running.set(key, controller);
    targets.set(key, target);
    if (entries.get(key)?.kind !== "read") set(key, { kind: "reading" });
    const current = () => signIn.isCurrent() && running.get(key) === controller;
    const { workspaceId, threadId } = target;
    const post =
      target.answer === true && readPost
        ? lane.screen(() => readPost(workspaceId, threadId, controller.signal), true)
        : undefined;
    Promise.all([
      lane.screen(() => read(workspaceId, threadId, controller.signal), true),
      post,
    ]).then(
      ([answer, isPostThread]) => {
        if (!current()) return;
        running.delete(key);
        if (answer.value.kind === "thread") onThread?.(workspaceId, answer.value);
        set(key, {
          kind: "read",
          thread: answer.value,
          ...(isPostThread === undefined ? {} : { post: isPostThread }),
        });
      },
      () => {
        if (!current()) return;
        running.delete(key);
        set(key, { kind: "failed" });
      },
    );
    return true;
  };

  return {
    state: () => entries,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    // The rows wanted now, whole: a thread no row wants any more, as when its row leaves the screen, its workspace hides
    // or the screen does, has its read stopped and its contents dropped. One wanted again is read again. A thread an
    // answer now needs, read before only for Reply, is read again with its chat list.
    want(wanted) {
      const keyed = new Map<string, MessageTarget>();
      for (const target of wanted) {
        const key = targetKey(target);
        const known = keyed.get(key);
        keyed.set(key, known && (known.answer === true || target.answer !== true) ? known : target);
      }
      const gone = [...targets.keys()].filter((key) => !keyed.has(key));
      for (const key of gone) {
        running.get(key)?.abort();
        running.delete(key);
        targets.delete(key);
      }
      if (gone.some((key) => entries.has(key))) {
        const next = new Map(entries);
        for (const key of gone) next.delete(key);
        entries = next;
        for (const listener of listeners) listener();
      }
      for (const [key, target] of keyed) {
        const known = targets.get(key);
        if (!entries.has(key)) start(key, target);
        else if (target.answer === true && known?.answer !== true) start(key, target);
      }
    },
    retry: (target) => {
      const known = targets.get(targetKey(target));
      return known ? start(targetKey(target), known) : false;
    },
    refresh() {
      for (const [key, target] of targets) start(key, target);
    },
    // Ends every read and drops every thread it read. The next `want` reads again, as when an effect runs again.
    stop() {
      for (const controller of running.values()) controller.abort();
      running.clear();
      targets.clear();
      if (entries.size === 0) return;
      entries = new Map();
      for (const listener of listeners) listener();
    },
  };
}
