import { chatWords } from "@dohc/interface-words/notices";
import type { PhoneChatWake } from "@dohc/workspace-contracts/chat-wakes";
import type { SignIn } from "../server/account";
import {
  earlierWakeCursor,
  readConversationWakes,
  readWakeChanges,
  WAKE_HOLD_MS,
  type WakeChanges,
  type WakeTarget,
} from "../server/chatWakes";
import { shownProblem, type ServerClient } from "../server/client";

// The wakes of the conversations on screen, one sign-in's, in memory only. Only a visible conversation, or a Notice row
// on screen, wants a conversation's wakes. Each wanted conversation reads its context once, then one held wake-changes
// request per workspace waits from the earliest wake cursor any of them read. A change in a thread a conversation shows
// reads that context again; `replace` reads every one again. Background, a target nobody wants, and stop abort what
// they started, and an answer lands only for the read or wait that is still current. A failed read or wait keeps the
// last wakes, marked failed, until Try again reads them again.

/** A conversation's wakes as its latest read gave them, by message, with each message's wakes kept apart. */
export interface WakeView {
  readonly byMessage: ReadonlyMap<string, readonly PhoneChatWake[]>;
  /** The latest read or wait failed: the wakes are from the read before it. */
  readonly failed: boolean;
}

const NO_WAKES: WakeView = { byMessage: new Map(), failed: false };

export interface ChatWakes {
  /**
   * Wants a conversation's wakes in a workspace until the returned function runs, and reads its context now, again
   * when already wanted. `threads` are the threads its content read shows, whose wake changes read it again.
   */
  want(workspaceId: string, target: WakeTarget, threads: ReadonlySet<string>): () => void;
  /** The conversation's wakes as last read, or null before a read answered. The same object until they change. */
  view(workspaceId: string, target: WakeTarget): WakeView | null;
  /** Counts changes to any view, for a screen that shows several. */
  version(): number;
  subscribe(listener: () => void): () => void;
  /** Try again: reads every wanted context in the workspace again, and waits for changes from there. */
  refresh(workspaceId: string): void;
  /** In the background: aborts every read and wait. */
  pause(): void;
  /** Back from the background: reads every wanted context again. */
  resume(): void;
  /** Aborts everything, for good. */
  stop(): void;
}

export const wakeKey = (target: WakeTarget) =>
  target.kind === "stream" ? `stream:${target.groupId}` : `thread:${target.threadId}`;

interface Entry {
  readonly target: WakeTarget;
  threads: ReadonlySet<string>;
  wanted: number;
  view: WakeView | null;
  /** The wake cursor through which `view` is current, or null while no read answered since it was wanted. */
  cursor: string | null;
  read: AbortController | null;
}

interface Workspace {
  readonly entries: Map<string, Entry>;
  hold: AbortController | null;
  /** The cursor the running wait started from. */
  since: string;
}

const byMessage = (wakes: readonly PhoneChatWake[]) => {
  const map = new Map<string, PhoneChatWake[]>();
  for (const wake of wakes) map.set(wake.messageId, [...(map.get(wake.messageId) ?? []), wake]);
  return map;
};

const laterWakeCursor = (a: string, b: string) => (earlierWakeCursor(a, b) === a ? b : a);

export function createChatWakes(options: {
  readonly signIn: Pick<SignIn, "isCurrent"> & { readonly client: ServerClient };
  readonly holdMs?: number;
}): ChatWakes {
  const { signIn } = options;
  const holdMs = options.holdMs ?? WAKE_HOLD_MS;
  const workspaces = new Map<string, Workspace>();
  const listeners = new Set<() => void>();
  let changes = 0;
  let paused = false;
  let stopped = false;

  const live = () => !stopped && !paused && signIn.isCurrent();
  const notify = () => {
    changes += 1;
    for (const listener of listeners) listener();
  };
  const workspace = (workspaceId: string) => {
    let found = workspaces.get(workspaceId);
    if (!found) {
      found = { entries: new Map(), hold: null, since: "0" };
      workspaces.set(workspaceId, found);
    }
    return found;
  };
  const setView = (entry: Entry, view: WakeView) => {
    if (entry.view === view) return;
    entry.view = view;
    notify();
  };
  const markFailed = (entry: Entry) => {
    if (entry.view && !entry.view.failed) setView(entry, { ...entry.view, failed: true });
  };

  function read(workspaceId: string, entry: Entry) {
    entry.read?.abort();
    entry.read = null;
    if (!live() || entry.wanted === 0) return;
    const controller = new AbortController();
    entry.read = controller;
    const current = () => entry.read === controller && live();
    readConversationWakes(signIn.client, workspaceId, entry.target, controller.signal).then(
      (answer) => {
        if (!current()) return;
        entry.read = null;
        if ("kind" in answer) {
          entry.cursor = null;
          setView(entry, NO_WAKES);
          return;
        }
        entry.cursor = answer.wakeCursor;
        setView(entry, { byMessage: byMessage(answer.wakes), failed: false });
        hold(workspaceId);
      },
      (error: unknown) => {
        if (!current()) return;
        entry.read = null;
        if (shownProblem(error) === null) return;
        if (entry.view) markFailed(entry);
        else setView(entry, { ...NO_WAKES, failed: true });
      },
    );
  }

  /**
   * Waits for the workspace's wake changes from the earliest cursor its wanted contexts read. A wait already running
   * from that cursor or before it keeps running; a context read older than its start starts it again from there.
   */
  function hold(workspaceId: string) {
    const place = workspace(workspaceId);
    let from: string | null = null;
    for (const entry of place.entries.values())
      if (entry.wanted > 0 && entry.cursor !== null)
        from = from === null ? entry.cursor : earlierWakeCursor(from, entry.cursor);
    if (place.hold && from !== null && earlierWakeCursor(place.since, from) === place.since) return;
    place.hold?.abort();
    place.hold = null;
    if (from === null || !live()) return;
    const controller = new AbortController();
    place.hold = controller;
    place.since = from;
    readWakeChanges(signIn.client, workspaceId, from, { holdMs, signal: controller.signal }).then(
      (answer) => {
        if (place.hold !== controller || !live()) return;
        place.hold = null;
        changed(workspaceId, answer);
      },
      (error: unknown) => {
        if (place.hold !== controller || !live()) return;
        place.hold = null;
        if (shownProblem(error) === null) return;
        // The wait failed: what's shown may be out of date. Try again reads it all again.
        for (const entry of place.entries.values()) if (entry.wanted > 0) markFailed(entry);
      },
    );
  }

  function changed(workspaceId: string, answer: WakeChanges) {
    const place = workspace(workspaceId);
    const named = answer.replace ? null : new Set(answer.threads);
    for (const entry of place.entries.values()) {
      if (entry.wanted === 0 || entry.cursor === null) continue;
      // `replace` may move the cursor back, past a reset head.
      entry.cursor = answer.replace ? answer.cursor : laterWakeCursor(entry.cursor, answer.cursor);
      if (named === null || [...entry.threads].some((thread) => named.has(thread)))
        read(workspaceId, entry);
    }
    hold(workspaceId);
  }

  const restart = (workspaceId: string) => {
    for (const entry of workspace(workspaceId).entries.values())
      if (entry.wanted > 0) read(workspaceId, entry);
  };

  return {
    want(workspaceId, target, threads) {
      if (stopped) return () => undefined;
      const place = workspace(workspaceId);
      const key = wakeKey(target);
      let entry = place.entries.get(key);
      if (!entry) {
        entry = { target, threads, wanted: 0, view: null, cursor: null, read: null };
        place.entries.set(key, entry);
      }
      const wanted = entry;
      wanted.wanted += 1;
      wanted.threads = threads;
      read(workspaceId, wanted);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        wanted.wanted -= 1;
        if (wanted.wanted > 0) return;
        // Nobody shows it: its read stops, and so does the wait once no context needs it. Its last wakes stay in
        // memory, shown again until a new read answers.
        wanted.read?.abort();
        wanted.read = null;
        wanted.cursor = null;
        if (![...place.entries.values()].some((each) => each.wanted > 0)) {
          place.hold?.abort();
          place.hold = null;
        }
      };
    },
    view: (workspaceId, target) =>
      workspaces.get(workspaceId)?.entries.get(wakeKey(target))?.view ?? null,
    version: () => changes,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh(workspaceId) {
      const place = workspace(workspaceId);
      place.hold?.abort();
      place.hold = null;
      restart(workspaceId);
    },
    pause() {
      paused = true;
      for (const place of workspaces.values()) {
        place.hold?.abort();
        place.hold = null;
        for (const entry of place.entries.values()) {
          entry.read?.abort();
          entry.read = null;
          entry.cursor = null;
        }
      }
    },
    resume() {
      if (!paused) return;
      paused = false;
      for (const workspaceId of workspaces.keys()) restart(workspaceId);
    },
    stop() {
      stopped = true;
      for (const place of workspaces.values()) {
        place.hold?.abort();
        place.hold = null;
        for (const entry of place.entries.values()) entry.read?.abort();
      }
      listeners.clear();
    },
  };
}

/** One wake's status line, or null for a state that shows none. */
export interface WakeLine {
  readonly wakeId: string;
  readonly state: "waiting" | "claimed" | "unclaimed" | "unconfirmed";
  readonly text: string;
  /** "No other computer can run this agent.", for an ended wake no computer could try again. */
  readonly note: string | null;
}

/**
 * The line a wake shows. `held` shows none: the outbox already says Waiting to send. `queued` shows none either: the
 * computer took it, which says nothing of whether the agent runs or finished. The name is the latest read's, or "An
 * agent" when it has none. Two wakes with the same name keep two lines.
 */
export function wakeLine(wake: PhoneChatWake): WakeLine | null {
  const { wakeId, state, agentName: name, winnerLabel: computer } = wake;
  // Didn't start, or not confirmed: the line says when no other computer could run the agent.
  const note = wake.canRetry ? null : chatWords.wakeNoOtherComputer;
  switch (state) {
    case "held":
    case "queued":
      return null;
    case "waiting":
      return { wakeId, state, text: chatWords.wakeWaiting(name), note: null };
    case "claimed":
      return { wakeId, state, text: chatWords.wakeStarting(name, computer), note: null };
    case "unclaimed":
      return { wakeId, state, text: chatWords.wakeNotStarted(name), note };
    case "unconfirmed":
      return { wakeId, state, text: chatWords.wakeUnconfirmed(name, computer), note };
  }
}

export const wakeLines = (wakes: readonly PhoneChatWake[]): readonly WakeLine[] =>
  wakes.flatMap((wake) => wakeLine(wake) ?? []);

/** What a surface shows of its wakes, in order: each line and its note, then a failed read. Empty without a line. */
export function wakeWords(wakes: readonly PhoneChatWake[], failed: boolean): readonly string[] {
  const lines = wakeLines(wakes);
  // A failed read says so even with no line to keep, as when the first read failed.
  if (lines.length === 0) return failed ? [chatWords.wakeReadFailed] : [];
  return [
    ...lines.flatMap((line) => (line.note ? [line.text, line.note] : [line.text])),
    ...(failed ? [chatWords.wakeReadFailed] : []),
  ];
}
