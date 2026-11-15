import type { SignIn } from "../server/account";
import type { NoticeRecord } from "../server/notices";
import type { WorkspaceList } from "../server/workspaceList";
import type { ChatThread, MissingChat, Read } from "../server/workspaceReads";
import { phoneTarget, type PhoneTarget } from "./phoneNotice";

// Which action a Notice's row offers first, and the reads that decide it. A mention's row offers Reply only once a
// current read of its thread shows the exact message it names. Without that read the row keeps Open, and a failed read
// offers Try again in the row. The phone never guesses a target: it doesn't search the thread for another message, and
// a Notice's placement or wording proves nothing.

/** The thread and message a mention names, in a workspace the phone shows and can open. */
export interface MentionTarget {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly messageId: string;
}

/**
 * The message a mention's row would reply to once a read shows it, or null for any other row: phone writes off, another
 * kind of Notice, a target the phone can't open, or one that names no message.
 */
export function replyCandidate(
  record: NoticeRecord,
  list: WorkspaceList,
  writes: boolean,
): MentionTarget | null {
  if (!writes || record.kind !== "mention") return null;
  const target = phoneTarget(record, list);
  if (target?.kind !== "thread" || target.messageId === null) return null;
  return {
    workspaceId: target.workspaceId,
    threadId: target.threadId,
    messageId: target.messageId,
  };
}

/** One read per workspace and thread, however many Notices name it. */
export const targetKey = (target: { readonly workspaceId: string; readonly threadId: string }) =>
  JSON.stringify([target.workspaceId, target.threadId]);

/** Where the read of a mention's thread stands. */
export type TargetRead =
  | { readonly kind: "reading" }
  | { readonly kind: "read"; readonly thread: ChatThread | MissingChat }
  | { readonly kind: "failed" };

/** Whether `read` is of the target's own thread and shows its exact message, in that thread. */
export function shows(target: MentionTarget, read: TargetRead | undefined): boolean {
  if (read?.kind !== "read" || read.thread.kind !== "thread") return false;
  if (read.thread.id !== target.threadId) return false;
  return read.thread.messages.some(
    (message) => message.id === target.messageId && message.threadId === target.threadId,
  );
}

/**
 * What a row's first action does. `reply` opens the thread with the message chosen to reply to. `open` goes to the
 * target, with `readFailed` when the read that would offer Reply failed. `elsewhere`: only a computer opens it.
 */
export type NoticeAction =
  | { readonly kind: "reply"; readonly target: MentionTarget }
  | { readonly kind: "open"; readonly target: PhoneTarget; readonly readFailed: boolean }
  | { readonly kind: "elsewhere" };

/** The row's first action, from the latest list, sign-in and reads. Checked again when the person acts. */
export function noticeAction(
  record: NoticeRecord,
  context: {
    readonly list: WorkspaceList;
    /** The build's phone writes gate. */
    readonly writes: boolean;
    readonly signIn: Pick<SignIn, "isCurrent"> | null;
    readonly reads: ReadonlyMap<string, TargetRead>;
  },
): NoticeAction {
  const target = phoneTarget(record, context.list);
  if (!target) return { kind: "elsewhere" };
  const candidate =
    context.signIn?.isCurrent() === true
      ? replyCandidate(record, context.list, context.writes)
      : null;
  const read = candidate ? context.reads.get(targetKey(candidate)) : undefined;
  if (candidate && shows(candidate, read)) return { kind: "reply", target: candidate };
  return { kind: "open", target, readFailed: candidate !== null && read?.kind === "failed" };
}

export interface NoticeTargets {
  /** A new map at each change. */
  state(): ReadonlyMap<string, TargetRead>;
  subscribe(listener: () => void): () => void;
  /** Reads each target's thread once, unless it's read or being read already. */
  want(targets: readonly MentionTarget[]): void;
  /** Reads the target's thread again, as Try again does. */
  retry(target: MentionTarget): void;
  /** Reads every thread again. A verified read stays until its next answer. */
  refresh(): void;
  /** Ends every read under way: nothing they answer applies. A later `want` asks again. */
  stop(): void;
}

/**
 * The reads behind Reply on the rows a person can see, one per workspace and thread. One sign-in's: an answer applies
 * only while that sign-in is current, no `stop` ended it, and no later read of the same thread replaced it. The
 * read is the server's filtered thread read, which checks ownership and Show on phone; it never marks the thread read.
 */
export function createNoticeTargets(options: {
  readonly signIn: Pick<SignIn, "isCurrent">;
  read(
    workspaceId: string,
    threadId: string,
    signal: AbortSignal,
  ): Promise<Read<ChatThread | MissingChat>>;
}): NoticeTargets {
  const { signIn, read } = options;
  let entries: ReadonlyMap<string, TargetRead> = new Map();
  const targets = new Map<string, MentionTarget>();
  const running = new Map<string, AbortController>();
  const listeners = new Set<() => void>();

  const set = (key: string, entry: TargetRead) => {
    entries = new Map(entries).set(key, entry);
    for (const listener of listeners) listener();
  };

  const start = (key: string, target: MentionTarget) => {
    if (!signIn.isCurrent()) return;
    running.get(key)?.abort();
    const controller = new AbortController();
    running.set(key, controller);
    targets.set(key, target);
    if (entries.get(key)?.kind !== "read") set(key, { kind: "reading" });
    const current = () => signIn.isCurrent() && running.get(key) === controller;
    read(target.workspaceId, target.threadId, controller.signal).then(
      (answer) => {
        if (!current()) return;
        running.delete(key);
        set(key, { kind: "read", thread: answer.value });
      },
      () => {
        if (!current()) return;
        running.delete(key);
        set(key, { kind: "failed" });
      },
    );
  };

  return {
    state: () => entries,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    // The rows wanted now, whole: a thread no row wants any more, as when its row leaves the screen, its workspace hides
    // or the screen does, has its read stopped and its contents dropped. One wanted again is read again.
    want(wanted) {
      const keyed = new Map(wanted.map((target) => [targetKey(target), target] as const));
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
      for (const [key, target] of keyed) if (!entries.has(key)) start(key, target);
    },
    retry: (target) => {
      const key = targetKey(target);
      if (targets.has(key)) start(key, target);
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
