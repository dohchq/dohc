import { CHAT_RUNNER_INSTALL_ID_MAX_CHARS, isChatWakeLine } from "@dohc/workspace-contracts/chat-wakes";
import { RelayUnauthorizedError, type SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import { ChatWakeBusyError, ChatWakeMissingError, type ChatWakeClient } from "./chatWakeClient";
import {
  createChatWakeConsumer,
  type ChatWakeAccount,
  type ChatWakeConsumer,
  type ChatWakeStuck,
  type ChatWakeWorkspace,
} from "./chatWakeConsumer";
import { ChatWakeIntentsUnreadableError, type ChatWakeIntent, type ChatWakeIntents } from "./chatWakeIntents";

// Runs one chat wake consumer for each credential lifetime, from startup
// until quit, whether or not a window is open. A new lifetime starts only
// after the one before it has stopped and drained, so two consumers never
// share the intent file. A 401 ends the lifetime that received it.

/**
 * Off until this computer also publishes its runners: without a roster, the
 * relay never lists this computer, and a consumer would wait for nothing.
 */
export const CHAT_WAKES_ON = false;

const BACKOFF_FIRST_MS = 1_000;
export const CHAT_WAKE_BACKOFF_MAX_MS = 5 * 60_000;

/** 1 s, doubling after each failure in a row, up to 5 minutes. */
export function chatWakeBackoffMs(failures: number): number {
  const doublings = Math.min(Math.max(0, failures - 1), 20);
  return Math.min(BACKOFF_FIRST_MS * 2 ** doublings, CHAT_WAKE_BACKOFF_MAX_MS);
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** One credential snapshot, as main reads it. */
export interface ChatWakeSession {
  account: ChatWakeAccount;
  relay: SyncRelayConnection;
  /** This snapshot is still the cache's current one. */
  isCurrent(): boolean;
  /** This snapshot's credentials got a 401. Ends the session only if they are still the current ones. */
  unauthorized(): void;
}

/** A wake failure a person can see. `unreadable` is about the intent file, not one workspace. */
export type ChatWakeProblem = "unreadable" | ChatWakeStuck;

export interface ChatWakeLifetimeDeps {
  /** CHAT_WAKES_ON in production. */
  on: boolean;
  /** The one store for the intent file, kept across lifetimes. */
  intents: ChatWakeIntents;
  client(session: ChatWakeSession): ChatWakeClient;
  openWorkspace(session: ChatWakeSession, workspaceId: string): Promise<ChatWakeWorkspace | null>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  backoffMs(failures: number): number;
  nowMs(): number;
  /** Shows the problem as a toast and a Notices row. Null workspace: the intent file. */
  report(workspaceId: string | null, problem: ChatWakeProblem, intent: ChatWakeIntent | null): void;
  /** Takes back that row. */
  clear(workspaceId: string | null, problem: ChatWakeProblem): void;
  log(error: unknown): void;
}

export interface ChatWakeLifetime {
  /** Each credential snapshot. `settled` is false only for the null a credential load shows while it reads. */
  credentialsChanged(session: ChatWakeSession | null, settled: boolean): void;
  /** Startup: runs the current snapshot's consumer. Snapshots before this are only remembered. */
  start(): void;
  /** Something a deferred wake waits for may have arrived. */
  resume(): void;
  /** Try again: takes back the rows, and starts the current snapshot's consumer afresh. */
  retry(): void;
  /** Quit: starts nothing more, and settles once the running consumer has drained. */
  stop(): Promise<void>;
}

export function createChatWakeLifetime(deps: ChatWakeLifetimeDeps): ChatWakeLifetime {
  let latest: ChatWakeSession | null = null;
  // False while `latest` is a credential load's placeholder null.
  let latestSettled = true;
  let started = false;
  let stopped = false;
  let running: { session: ChatWakeSession; consumer: ChatWakeConsumer } | null = null;
  let transitions: Promise<void> = Promise.resolve();

  // Shown rows, one per workspace and problem, with the wakes each stands for.
  // They belong to one account; another account's lifetime takes them back.
  const rows = new Map<string, { workspaceId: string | null; problem: ChatWakeProblem; wakes: Set<string> }>();
  let rowsScope: string | null = null;
  function report(workspaceId: string | null, problem: ChatWakeProblem, intent: ChatWakeIntent | null): void {
    const key = JSON.stringify([workspaceId, problem]);
    const row = rows.get(key);
    const wake = intent?.wakeId ?? "";
    if (row?.wakes.has(wake)) return;
    if (row) row.wakes.add(wake);
    else rows.set(key, { workspaceId, problem, wakes: new Set([wake]) });
    deps.report(workspaceId, problem, intent);
  }
  // A wake moved on: its rows of these problems go once they stand for no other wake.
  function moved(wake: string, problems: readonly ChatWakeProblem[]): void {
    for (const [key, row] of rows) {
      if (!problems.includes(row.problem) || !row.wakes.delete(wake) || row.wakes.size > 0) continue;
      rows.delete(key);
      deps.clear(row.workspaceId, row.problem);
    }
  }
  function clearRows(): void {
    for (const row of rows.values()) deps.clear(row.workspaceId, row.problem);
    rows.clear();
  }

  // Every lifetime reads and writes the same store. A read that succeeds takes back the unreadable row.
  const watched = async <T>(work: Promise<T>): Promise<T> => {
    try {
      const value = await work;
      moved("", ["unreadable"]);
      return value;
    } catch (error) {
      if (error instanceof ChatWakeIntentsUnreadableError) report(null, "unreadable", null);
      throw error;
    }
  };
  const intents: ChatWakeIntents = {
    list: () => watched(deps.intents.list()),
    save: async (intent) => {
      await watched(deps.intents.save(intent));
      if (intent.phase === "recorded") moved(intent.wakeId, ["parked"]);
    },
    remove: async (intent) => {
      await watched(deps.intents.remove(intent));
      moved(intent.wakeId, ["parked", "unconfirmed"]);
    },
  };

  function consumerFor(session: ChatWakeSession): ChatWakeConsumer {
    return createChatWakeConsumer({
      account: session.account,
      isCurrent: session.isCurrent,
      client: deps.client(session),
      intents,
      openWorkspace: (workspaceId) => deps.openWorkspace(session, workspaceId),
      sleep: deps.sleep,
      backoffMs: deps.backoffMs,
      nowMs: deps.nowMs,
      onError: (error) => {
        if (error instanceof RelayUnauthorizedError) return session.unauthorized();
        // Busy, or a server without wake routes: the backoff answers both, and neither is the person's to fix.
        // An unreadable file has its own row.
        if (error instanceof ChatWakeBusyError || error instanceof ChatWakeMissingError ||
          error instanceof ChatWakeIntentsUnreadableError) return;
        deps.log(error);
      },
      // A workspace looks gone to a session that is no longer current; that is not the person's to fix.
      onStuck: (intent, reason) => { if (session.isCurrent()) report(intent.workspaceId, reason, intent); },
    });
  }

  // Stops the running consumer when it isn't the current snapshot's, or when `again`, then starts the current one.
  function cycle(again: boolean): void {
    transitions = transitions.then(async () => {
      if (running && (again || stopped || running.session !== latest)) {
        const ended = running;
        running = null;
        await ended.consumer.stop();
      }
      if (again) clearRows();
      const next = latest;
      if (next === null && latestSettled) {
        clearRows();
        rowsScope = null;
      }
      if (running || stopped || !started || !deps.on || next === null || !next.isCurrent()) return;
      if (!isChatWakeLine(next.account.installId, CHAT_RUNNER_INSTALL_ID_MAX_CHARS)) {
        deps.log(new Error("This computer's install ID can't be sent with chat wakes."));
        return;
      }
      if (rowsScope !== next.account.scope) {
        clearRows();
        rowsScope = next.account.scope;
      }
      const consumer = consumerFor(next);
      running = { session: next, consumer };
      consumer.start();
    }).catch(deps.log);
  }

  return {
    credentialsChanged(session, settled) {
      latest = session;
      latestSettled = settled;
      cycle(false);
    },
    start() {
      started = true;
      cycle(false);
    },
    resume() {
      void running?.consumer.resume();
    },
    retry() {
      cycle(true);
    },
    stop() {
      stopped = true;
      cycle(false);
      return transitions;
    },
  };
}
