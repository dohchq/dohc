import { chatWords } from "@dohc/interface-words/notices";
import type { PhoneChatWake, PhoneMentionCandidate } from "@dohc/workspace-contracts/chat-wakes";
import type { SignIn } from "../server/account";
import {
  earlierWakeCursor,
  readConversationWakes,
  readWakeChanges,
  retryWake,
  WAKE_HOLD_MS,
  type WakeChanges,
  type WakeTarget,
} from "../server/chatWakes";
import { shownProblem, type ServerClient } from "../server/client";
import { readLane } from "../server/readLane";

// The wakes of the conversations on screen, one sign-in's, in memory only. Only a visible conversation, or a Notice row
// on screen, wants a conversation's wakes. Each wanted conversation reads its context once, then one held wake-changes
// request per workspace waits from the earliest wake cursor any of them read. A change in a thread a conversation shows
// reads that context again; `replace` reads every one again. Background, a target nobody wants, and stop abort what
// they started, and an answer lands only for the read or wait that is still current. A failed read or wait keeps the
// last wakes, marked failed, until Try again reads them again.
//
// The same read gives who the conversation can mention, which lives and fails with its wakes: it changes only when a
// context read lands, never on a poll of its own.
//
// Try again on a line that didn't start, or wasn't confirmed, sends one request the person asked for, while they watch.
// Its operation ID is minted once, on the press, after the alert for one that wasn't confirmed. A second press, or Try
// again after a lost answer, sends that ID for that exact wake again. Each step, the answer's included, first checks
// that the screen still shows the conversation with writes unblocked, and that its latest read still shows the wake at
// that generation, in that state, with a computer to try; an answer that fails the check is dropped, unused. An answer
// shows nothing of its own: the line stays busy, and Try again waits, until the read it starts lands. Background,
// leaving the conversation, a sign-in change and stop abort it and forget it, so another press needs a fresh read
// first. Nothing of it is stored, and nothing sends it later.

/**
 * A conversation's wakes as its latest read gave them, by message, with each message's wakes kept apart, and who it
 * can mention, from the same read.
 */
export interface WakeView {
  readonly byMessage: ReadonlyMap<string, readonly PhoneChatWake[]>;
  /** The latest read or wait failed: the wakes and mentions are from the read before it. */
  readonly failed: boolean;
  readonly mentions: readonly PhoneMentionCandidate[];
}

const NO_WAKES: WakeView = { byMessage: new Map(), failed: false, mentions: [] };

/**
 * Where a line's Try again stands, for the wake generation it was pressed on. `sending` until its answer and the read
 * after it land; `failed` when the request failed or was refused, offering Try again of the same request; `missing`
 * when the server has no such wake, offering nothing.
 */
export interface WakeRetry {
  readonly generation: number;
  readonly phase: "sending" | "failed" | "missing";
}

/** What a Try again asks of the screen it was pressed on. */
export interface RetryGate {
  /** The screen still shows the conversation, and writes aren't blocked, as they are when it's called. */
  allowed(): boolean;
  /** Asks the person before a wake that wasn't confirmed tries another computer. Resolves true only on confirm. */
  confirm(wake: PhoneChatWake): Promise<boolean>;
}

const NO_RETRIES: ReadonlyMap<string, WakeRetry> = new Map();

/** A line offers Try again: it didn't start, or wasn't confirmed, and another computer could run its agent. */
export const retryable = (wake: PhoneChatWake) =>
  wake.canRetry && (wake.state === "unclaimed" || wake.state === "unconfirmed");

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
  /** The conversation's lines' Try again states, by wake ID. The same object until one changes. */
  retries(workspaceId: string, target: WakeTarget): ReadonlyMap<string, WakeRetry>;
  /**
   * Try again on a line of a wanted conversation, from the person's press. Settles once the press is done: it sent
   * nothing, or its answer landed or was dropped. The read the answer starts lands apart.
   */
  retry(
    workspaceId: string,
    target: WakeTarget,
    wake: PhoneChatWake,
    gate: RetryGate,
  ): Promise<void>;
  /** In the background: aborts every read and wait. */
  pause(): void;
  /** Back from the background: reads every wanted context again. */
  resume(): void;
  /** Aborts everything, for good. */
  stop(): void;
}

export const wakeKey = (target: WakeTarget) =>
  target.kind === "stream" ? `stream:${target.groupId}` : `thread:${target.threadId}`;

/**
 * A screen's one want of its conversation's wakes. Each `want` takes the new want before it lets the last go, so a new
 * content read of the same conversation reads the wakes again without leaving them unwanted, and a Try again on its
 * way survives. `release` lets go, as when the screen hides or closes.
 */
export function screenWant() {
  let held: (() => void) | null = null;
  return {
    want(wakes: ChatWakes, workspaceId: string, target: WakeTarget, threads: ReadonlySet<string>) {
      const last = held;
      held = wakes.want(workspaceId, target, threads);
      last?.();
    },
    release() {
      held?.();
      held = null;
    },
  };
}

interface Entry {
  readonly target: WakeTarget;
  threads: ReadonlySet<string>;
  wanted: number;
  view: WakeView | null;
  /** The wake cursor through which `view` is current, or null while no read answered since it was wanted. */
  cursor: string | null;
  read: AbortController | null;
  /** Its lines' Try again requests, by source wake ID. */
  readonly intents: Map<string, Intent>;
  retries: ReadonlyMap<string, WakeRetry>;
}

/** One Try again, on one wake generation, in memory only. */
interface Intent {
  readonly source: PhoneChatWake;
  /** Minted on the press, or after the alert's confirm; null while the alert shows. */
  operationId: string | null;
  /** `retried`: the server took it, and it's done once the read after it lands. */
  phase: "confirming" | "sending" | "retried" | "failed" | "missing";
  send: AbortController | null;
  /** The read its answer started hasn't landed: the line stays busy, and Try again waits for it. */
  reading: boolean;
}

/** The latest read still shows the wake as it was pressed on, at that generation, in that state, with a computer to try. */
const stillShows = (entry: Entry, source: PhoneChatWake) => {
  const { view } = entry;
  if (!view || view.failed || entry.cursor === null) return false;
  const now = view.byMessage.get(source.messageId)?.find((each) => each.wakeId === source.wakeId);
  return (
    now !== undefined &&
    now.generation === source.generation &&
    now.state === source.state &&
    retryable(now)
  );
};

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

  /** Shows the entry's Try again states as they stand now. */
  const publish = (entry: Entry) => {
    const next = new Map<string, WakeRetry>();
    for (const [wakeId, intent] of entry.intents) {
      if (intent.phase === "confirming") continue;
      const phase: WakeRetry["phase"] =
        (intent.phase === "failed" || intent.phase === "missing") && !intent.reading
          ? intent.phase
          : "sending";
      next.set(wakeId, { generation: intent.source.generation, phase });
    }
    if (next.size === 0 && entry.retries.size === 0) return;
    entry.retries = next.size === 0 ? NO_RETRIES : next;
    notify();
  };

  /** Aborts and forgets the entry's Try again requests. */
  const drop = (entry: Entry) => {
    for (const intent of entry.intents.values()) intent.send?.abort();
    entry.intents.clear();
    publish(entry);
  };

  /**
   * A read landed, or failed: a request that answered `retried` is done, and one waiting for the read stops waiting. A
   * failed one stays only while a read that worked still shows its wake as it was pressed on, and a missing one while
   * its line shows. After a failed read, a failed one stays, and its Try again waits for a read that works.
   */
  const settle = (entry: Entry) => {
    let changedAny = false;
    const worked = entry.view?.failed === false;
    for (const [wakeId, intent] of entry.intents) {
      const shown = entry.view?.byMessage
        .get(intent.source.messageId)
        ?.some((each) => each.wakeId === wakeId);
      if (
        intent.phase === "retried" ||
        (intent.phase === "failed" && worked && !stillShows(entry, intent.source)) ||
        (intent.phase === "missing" && !shown)
      ) {
        entry.intents.delete(wakeId);
        changedAny = true;
      } else if (intent.reading) {
        intent.reading = false;
        changedAny = true;
      }
    }
    if (changedAny) publish(entry);
  };

  function read(workspaceId: string, entry: Entry) {
    entry.read?.abort();
    entry.read = null;
    if (!live() || entry.wanted === 0) return;
    const controller = new AbortController();
    entry.read = controller;
    const current = () => entry.read === controller && live();
    const reading = readLane(signIn).screen(
      () => readConversationWakes(signIn.client, workspaceId, entry.target, controller.signal),
      false,
    );
    reading.then(
      (answer) => {
        if (!current()) return;
        entry.read = null;
        if ("kind" in answer) {
          entry.cursor = null;
          setView(entry, NO_WAKES);
          settle(entry);
          return;
        }
        entry.cursor = answer.wakeCursor;
        setView(entry, {
          byMessage: byMessage(answer.wakes),
          failed: false,
          mentions: answer.mentions,
        });
        settle(entry);
        hold(workspaceId);
      },
      (error: unknown) => {
        if (!current()) return;
        entry.read = null;
        if (shownProblem(error) === null) return;
        if (entry.view) markFailed(entry);
        else setView(entry, { ...NO_WAKES, failed: true });
        // The lines offer nothing until a read works; a request that answered `retried` is done.
        settle(entry);
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

  /**
   * Whether a Try again may still act: this sign-in's controller runs, the screen wants the conversation, the intent is
   * still the line's, its gate allows it now, and the latest read still shows its wake as it was pressed on.
   */
  const mayAct = (entry: Entry, intent: Intent, gate: RetryGate) =>
    live() &&
    entry.wanted > 0 &&
    entry.intents.get(intent.source.wakeId) === intent &&
    gate.allowed() &&
    stillShows(entry, intent.source);

  /**
   * Sends a Try again with its own operation ID and wake, through this sign-in's client, and reads the conversation
   * again once it answers. An answer lands only while the request is the one current and `mayAct` still holds; one
   * that fails the check ends the Try again without its answer, and reads nothing.
   */
  function send(
    workspaceId: string,
    entry: Entry,
    intent: Intent,
    operationId: string,
    gate: RetryGate,
  ): Promise<void> {
    const { client } = signIn;
    const controller = new AbortController();
    intent.send = controller;
    intent.phase = "sending";
    publish(entry);
    const answered = (phase: "retried" | "failed" | "missing") => {
      if (entry.intents.get(intent.source.wakeId) !== intent || intent.send !== controller) return;
      intent.send = null;
      if (!mayAct(entry, intent, gate)) {
        entry.intents.delete(intent.source.wakeId);
        publish(entry);
        return;
      }
      intent.phase = phase;
      intent.reading = true;
      publish(entry);
      read(workspaceId, entry);
    };
    return retryWake(
      client,
      workspaceId,
      operationId,
      intent.source.wakeId,
      controller.signal,
    ).then(
      (answer) => {
        if (answer.kind === "missing") return answered("missing");
        if (answer.kind === "refused") return answered("failed");
        // A generation of another message or thread isn't this wake's.
        const { messageId, threadId } = answer.wake;
        answered(
          messageId === intent.source.messageId && threadId === intent.source.threadId
            ? "retried"
            : "failed",
        );
      },
      () => answered("failed"),
    );
  }

  return {
    want(workspaceId, target, threads) {
      if (stopped) return () => undefined;
      const place = workspace(workspaceId);
      const key = wakeKey(target);
      let entry = place.entries.get(key);
      if (!entry) {
        entry = {
          target,
          threads,
          wanted: 0,
          view: null,
          cursor: null,
          read: null,
          intents: new Map(),
          retries: NO_RETRIES,
        };
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
        drop(wanted);
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
    retries: (workspaceId, target) =>
      workspaces.get(workspaceId)?.entries.get(wakeKey(target))?.retries ?? NO_RETRIES,
    retry(workspaceId, target, wake, gate) {
      const entry = workspaces.get(workspaceId)?.entries.get(wakeKey(target));
      if (!entry) return Promise.resolve();
      const known = entry.intents.get(wake.wakeId);
      if (known) {
        // A second press while it asks, sends, or waits for the read after its answer does nothing. After a failure,
        // once that read landed, it sends the same request again.
        return known.phase === "failed" &&
          !known.reading &&
          known.operationId !== null &&
          mayAct(entry, known, gate)
          ? send(workspaceId, entry, known, known.operationId, gate)
          : Promise.resolve();
      }
      const intent: Intent = {
        source: wake,
        operationId: null,
        phase: "confirming",
        send: null,
        reading: false,
      };
      entry.intents.set(wake.wakeId, intent);
      if (!mayAct(entry, intent, gate)) {
        entry.intents.delete(wake.wakeId);
        return Promise.resolve();
      }
      if (wake.state === "unclaimed") {
        intent.operationId = crypto.randomUUID();
        return send(workspaceId, entry, intent, intent.operationId, gate);
      }
      // It may have started: the person says to try another computer first. Cancel sends nothing.
      return gate.confirm(wake).then(
        (yes) => {
          if (entry.intents.get(wake.wakeId) !== intent) return;
          if (!yes || !mayAct(entry, intent, gate)) {
            entry.intents.delete(wake.wakeId);
            return;
          }
          intent.operationId = crypto.randomUUID();
          return send(workspaceId, entry, intent, intent.operationId, gate);
        },
        () => {
          if (entry.intents.get(wake.wakeId) === intent) entry.intents.delete(wake.wakeId);
        },
      );
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
          drop(entry);
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
        for (const entry of place.entries.values()) {
          entry.read?.abort();
          for (const intent of entry.intents.values()) intent.send?.abort();
          entry.intents.clear();
          entry.retries = NO_RETRIES;
        }
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
