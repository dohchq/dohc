import {
  CHAT_RUNNER_INSTALL_ID_MAX_CHARS,
  isChatWakeLine,
} from "@dohc/workspace-contracts/chat-wakes";
import { RelayUnauthorizedError, type SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import { ChatWakeBusyError, ChatWakeMissingError, type ChatWakeClient } from "./chatWakeClient";
import {
  createChatWakeConsumer,
  type ChatWakeAccount,
  type ChatWakeConsumer,
  type ChatWakeStuck,
  type ChatWakeWorkspace,
} from "./chatWakeConsumer";
import {
  ChatWakeIntentsUnreadableError,
  type ChatWakeIntent,
  type ChatWakeIntents,
} from "./chatWakeIntents";
import type { ChatRunnerRoster } from "./chatRunnerRoster";

// Runs one chat wake consumer for each credential lifetime, from startup
// until quit, whether or not a window is open. A new lifetime starts only
// after the one before it has stopped and drained, so two consumers never
// share the intent file. A 401 ends the lifetime that received it.
//
// The running session also publishes this computer's agents for its
// workspaces. When an account signs out, or another one signs in, its
// declarations are withdrawn with its own token once its consumer has
// stopped, and before the next account publishes. Quit withdraws nothing:
// the wakes wait for this computer to come back. Signing out stops new
// claims and new triggers here; a run whose trigger was already recorded is
// dispatch's, and goes on under dispatch's own checks.

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
  /** The one store for the intent file, kept across lifetimes. */
  intents: ChatWakeIntents;
  /** This computer's declarations, kept across lifetimes. */
  roster: ChatRunnerRoster;
  client(session: ChatWakeSession): ChatWakeClient;
  openWorkspace(session: ChatWakeSession, workspaceId: string): Promise<ChatWakeWorkspace | null>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  backoffMs(failures: number): number;
  nowMs(): number;
  /**
   * Shows the problem as a toast and a Notices row. Null workspace: the intent file, offered again on each
   * failed read so a workspace that starts syncing meanwhile gets its row; the owner shows it once per workspace.
   */
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
  /** Something a deferred wake waits for may have arrived, or the computer woke: also renews declarations that are due. */
  resume(): void;
  /**
   * A pull finished. Only one that brought changes or reached the relay again resumes: a deferred wake asks
   * for a pull, so resuming on an empty one would ask for another, and another.
   */
  pulled(pull: { applied: boolean; recovered: boolean }): Promise<void>;
  /** This computer's agents, or which workspaces sync here, may have changed: publishes again for the running session. */
  runnersChanged(): Promise<void>;
  /**
   * Try again: takes back the rows a fresh start can fix, and starts the current snapshot's consumer afresh.
   * Presses before that restart begins share it.
   */
  retry(): void;
  /** Quit: starts nothing more, and settles once the running consumer has drained. Declarations stay. */
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
  // The last session that published and stopped, until a settled snapshot says whether its account stays.
  let leaving: ChatWakeSession | null = null;
  let retryQueued = false;

  // Shown rows, one per workspace and problem, with the wakes each stands for.
  // They belong to one account; another account's lifetime takes them back.
  const rows = new Map<
    string,
    { workspaceId: string | null; problem: ChatWakeProblem; wakes: Set<string> }
  >();
  let rowsScope: string | null = null;
  function report(
    workspaceId: string | null,
    problem: ChatWakeProblem,
    intent: ChatWakeIntent | null,
  ): void {
    const key = JSON.stringify([workspaceId, problem]);
    const row = rows.get(key);
    const wake = intent?.wakeId ?? "";
    if (problem !== "unreadable" && row?.wakes.has(wake)) return;
    // A row counts as shown only once its report went through; a failed one is offered again next time.
    try {
      deps.report(workspaceId, problem, intent);
    } catch (error) {
      deps.log(error);
      return;
    }
    if (row) row.wakes.add(wake);
    else rows.set(key, { workspaceId, problem, wakes: new Set([wake]) });
  }
  // Taking a row back never fails the read or step that ended it.
  function takeBack(row: { workspaceId: string | null; problem: ChatWakeProblem }): void {
    try {
      deps.clear(row.workspaceId, row.problem);
    } catch (error) {
      deps.log(error);
    }
  }
  // A wake moved on: its rows of these problems go once they stand for no other wake.
  function moved(wake: string, problems: readonly ChatWakeProblem[]): void {
    for (const [key, row] of rows) {
      if (!problems.includes(row.problem) || !row.wakes.delete(wake) || row.wakes.size > 0)
        continue;
      rows.delete(key);
      takeBack(row);
    }
  }
  function clearRows(problems?: readonly ChatWakeProblem[]): void {
    for (const [key, row] of rows) {
      if (problems && !problems.includes(row.problem)) continue;
      rows.delete(key);
      takeBack(row);
    }
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
        if (
          error instanceof ChatWakeBusyError ||
          error instanceof ChatWakeMissingError ||
          error instanceof ChatWakeIntentsUnreadableError
        )
          return;
        deps.log(error);
      },
      // A workspace looks gone to a session that is no longer current; that is not the person's to fix.
      onStuck: (intent, reason) => {
        if (session.isCurrent()) report(intent.workspaceId, reason, intent);
      },
    });
  }

  // Stops the running consumer when it isn't the current snapshot's, or when `again`, then starts the current one.
  function cycle(again: boolean): void {
    transitions = transitions
      .then(async () => {
        if (again) retryQueued = false;
        if (running && (again || stopped || running.session !== latest)) {
          const ended = running;
          running = null;
          await ended.consumer.stop();
          leaving = ended.session;
        }
        // A dropped wake's row is over, and a fresh start can't change it.
        if (again) clearRows(["unreadable", "parked", "unconfirmed"]);
        const next = latest;
        // Its account signed out, or another one signed in: withdraw with its own token, queued before the next publish.
        // A credential load's placeholder decides nothing, and quit keeps the declarations.
        if (
          leaving &&
          !stopped &&
          (next === null ? latestSettled : next.account.scope !== leaving.account.scope)
        ) {
          void deps.roster.withdraw(leaving);
          leaving = null;
        } else if (leaving && next !== null && next.account.scope === leaving.account.scope) {
          leaving = null;
        }
        if (next === null && latestSettled) {
          clearRows();
          rowsScope = null;
        }
        if (running || stopped || !started || next === null || !next.isCurrent()) return;
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
        void deps.roster.reconcile(next);
      })
      .catch(deps.log);
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
      // Power resume among them: the roster's hourly check stood still while the computer slept.
      void deps.roster.check();
    },
    pulled({ applied, recovered }) {
      // Reaching the relay again is also when a declaration that failed can go out.
      if (recovered && running) void deps.roster.reconcile(running.session);
      return applied || recovered
        ? (running?.consumer.resume() ?? Promise.resolve())
        : Promise.resolve();
    },
    runnersChanged() {
      return running ? deps.roster.reconcile(running.session) : Promise.resolve();
    },
    retry() {
      if (retryQueued) return;
      retryQueued = true;
      cycle(true);
    },
    async stop() {
      stopped = true;
      cycle(false);
      await transitions;
      await deps.roster.stop();
    },
  };
}
