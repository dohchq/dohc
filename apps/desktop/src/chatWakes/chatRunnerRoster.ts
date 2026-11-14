import type { ChatRunnerDeclaration } from "@dohc/workspace-contracts/chat-wakes";
import { RelayUnauthorizedError } from "@dohc/workspace-contracts/relay";
import type { Agent } from "../settings/userSettings";
import { ChatWakeBusyError, ChatWakeMissingError, type ChatWakeClient } from "./chatWakeClient";
import { chatRunnerDeclaration, type ChatRunnerRefusal } from "./chatRunnerDeclaration";
import {
  ChatRunnerLedgerUnreadableError,
  type ChatRunnerLedger,
  type ChatRunnerLedgerEntry,
} from "./chatRunnerLedger";
import type { ChatWakeSession } from "./chatWakeLifetime";

// Tells the server which of this computer's agents each of the account's
// synced workspaces can wake here, and takes that back when the workspace
// stops syncing here, is removed, or its account signs out.
//
// Every declaration and withdrawal runs on one queue, one at a time, so an
// older one never lands after a newer one. Each publish reads settings and
// the workspace list when it runs, and publishes only what changed. A
// withdrawal goes out with the token of the account it withdraws, never
// another's. The ledger names every workspace that may still hold a
// declaration, so a withdrawal that fails is tried again the next time that
// account signs in here.
//
// The relay names a computer as a wake target only for a lease after its last
// declaration (the relay's CHAT_RUNNER_LEASE_MS, 3 days). So a confirmed
// declaration counts as sent only while it is younger than a day of wall-clock
// time; older, any pass sends it again. That keeps a running computer's lease,
// and repairs a declaration an older, late request overwrote. Its age belongs
// to the account, install, and workspace, so a new token for the same account
// neither resets nor postpones it, and a pass that fails before its PUT leaves
// it due. One hourly check, and a check on power resume, start that pass for
// the current session when something is due. A computer that quits after
// signing out, or never comes back, drops out when its lease ends.

/** How long a sign-out's or account change's withdrawals may take, all together. */
export const CHAT_RUNNER_WITHDRAW_MS = 15_000;
/** How old a confirmed declaration may be, in wall-clock time, before it is sent again: well inside the relay's lease. */
export const CHAT_RUNNER_REFRESH_MS = 24 * 60 * 60 * 1000;
/** How often the roster checks for a declaration that is due. Sleep stops this timer; power resume checks too. */
export const CHAT_RUNNER_CHECK_MS = 60 * 60 * 1000;

export interface ChatRunnerRosterDeps {
  ledger: ChatRunnerLedger;
  client(session: ChatWakeSession): ChatWakeClient;
  /** The session's own synced workspaces on this computer, open in a window or not: not shares, not paused. */
  workspaces(session: ChatWakeSession): readonly string[];
  agents(): Promise<readonly Pick<Agent, "id" | "name" | "enabled" | "launch">[]>;
  computerLabel(): string;
  /** A retry's backoff. Resolves after `ms`, or when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** The wait between due checks, apart from `sleep` so a test can hold one and not the other. Same contract. */
  refreshSleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Wall-clock time, which keeps counting while the computer sleeps. */
  nowMs(): number;
  backoffMs(failures: number): number;
  timeout(ms: number): AbortSignal;
  /** One row in that workspace's Notices: the server can't take this computer's agents as they are. */
  refused(workspaceId: string, refusal: ChatRunnerRefusal): void;
  /** Takes that row back. */
  accepted(workspaceId: string): void;
  /** The ledger can't be read, so nothing is declared or withdrawn: the account's workspaces show a row. */
  ledgerUnreadable(): void;
  /** Takes that row back: the ledger read, or the account it was shown for left. */
  clearLedgerUnreadable(): void;
  log(error: unknown): void;
}

export interface ChatRunnerRoster {
  /** Publishes this session's declarations. Calls before the pass starts share it. */
  reconcile(session: ChatWakeSession): Promise<void>;
  /** Withdraws everything this install declared under the session's account, with its token, within CHAT_RUNNER_WITHDRAW_MS. */
  withdraw(session: ChatWakeSession): Promise<void>;
  /** Publishes again for the current session if a confirmed declaration is due, as after a long sleep. */
  check(): Promise<void>;
  /** Quit: cancels what is in flight and the hourly check, and starts nothing more. Declarations stay. */
  stop(): Promise<void>;
}

export function createChatRunnerRoster(deps: ChatRunnerRosterDeps): ChatRunnerRoster {
  const abort = new AbortController();
  let queue: Promise<unknown> = Promise.resolve();
  const serial = (work: () => Promise<void>): Promise<void> => {
    const result = queue.then(work).catch(deps.log);
    queue = result;
    return result;
  };
  // What the server last confirmed for each account, install, and workspace, and when, by the wall clock.
  const sent = new Map<
    string,
    { account: string; installId: string; body: string; atMs: number }
  >();
  // The refusal each workspace's row shows.
  const rows = new Map<string, string>();
  let pending: { session: ChatWakeSession; done: Promise<void> } | null = null;
  // The one session owed a retry, its failures in a row, and its backoff while it sleeps. Another session's
  // failure replaces it and starts its count again, so an old session's backoff never stands in for a current one.
  let owed: { session: ChatWakeSession; failures: number; sleep: AbortController | null } | null =
    null;
  // The session that publishes now: the last one a pass ran for, until it is withdrawn.
  let current: ChatWakeSession | null = null;
  let checking = false;

  const keyOf = (entry: ChatRunnerLedgerEntry) =>
    JSON.stringify([entry.account, entry.installId, entry.workspaceId]);
  // A confirmation from a clock that has since moved back is due, so a corrected clock can't outlast the relay's lease.
  const fresh = (confirmed: { atMs: number }) => {
    const ageMs = deps.nowMs() - confirmed.atMs;
    return ageMs >= 0 && ageMs < CHAT_RUNNER_REFRESH_MS;
  };
  const withdrawal = (session: ChatWakeSession, computerLabel: string): ChatRunnerDeclaration => ({
    installId: session.account.installId,
    computerLabel,
    runners: [],
  });

  function show(workspaceId: string, refusal: ChatRunnerRefusal | null): void {
    const shown = rows.get(workspaceId);
    const now = refusal === null ? undefined : JSON.stringify(refusal);
    if (shown === now) return;
    try {
      if (refusal === null) deps.accepted(workspaceId);
      else deps.refused(workspaceId, refusal);
    } catch (error) {
      deps.log(error);
      return;
    }
    if (now === undefined) rows.delete(workspaceId);
    else rows.set(workspaceId, now);
  }

  // Sends one declaration and keeps the ledger true to it. Answers whether the step is settled.
  async function put(
    session: ChatWakeSession,
    client: ChatWakeClient,
    entry: ChatRunnerLedgerEntry,
    declaration: ChatRunnerDeclaration,
    signal: AbortSignal,
  ): Promise<boolean> {
    const key = keyOf(entry);
    const body = JSON.stringify(declaration);
    const declaring = declaration.runners.length > 0;
    const confirmed = sent.get(key);
    if (confirmed?.body === body && fresh(confirmed)) {
      // The server already confirmed this withdrawal; only the ledger row may be left, if removing it failed.
      if (!declaring) await removed(entry);
      return true;
    }
    // Saved before it goes out, so a declaration that reached the server is always one this computer can withdraw.
    if (declaring) await deps.ledger.add(entry);
    // A request that fails or times out may still land, so nothing counts as sent until one is confirmed.
    sent.delete(key);
    try {
      await client.replaceRunners(entry.workspaceId, declaration, signal);
    } catch (error) {
      // A server without wake routes, or a workspace this account no longer owns: nothing is declared there. Quiet,
      // and the next reconciliation asks again.
      if (error instanceof ChatWakeMissingError) {
        if (!declaring) await deps.ledger.remove(entry);
        return true;
      }
      if (error instanceof RelayUnauthorizedError) session.unauthorized();
      else if (!(error instanceof ChatWakeBusyError) && !signal.aborted) deps.log(error);
      return false;
    }
    sent.set(key, { account: entry.account, installId: entry.installId, body, atMs: deps.nowMs() });
    if (!declaring) await removed(entry);
    return true;
  }

  // A confirmed withdrawal's ledger row goes, and with it the confirmation, which nothing renews any more.
  async function removed(entry: ChatRunnerLedgerEntry): Promise<void> {
    await deps.ledger.remove(entry);
    sent.delete(keyOf(entry));
  }

  // Whether the session's account and install hold a confirmed declaration old enough to send again.
  function due(session: ChatWakeSession): boolean {
    const { scope: account, installId } = session.account;
    for (const confirmed of sent.values()) {
      if (confirmed.account === account && confirmed.installId === installId && !fresh(confirmed))
        return true;
    }
    return false;
  }

  // One hourly check for the roster, from its first pass until stop. Sleep stops its timer, so resume checks too.
  function startChecking(): void {
    if (checking) return;
    checking = true;
    void (async () => {
      while (!abort.signal.aborted) {
        await deps.refreshSleep(CHAT_RUNNER_CHECK_MS, abort.signal);
        void roster.check();
      }
    })().catch(deps.log);
  }

  // A step that failed. An unreadable ledger is the person's to restore, so it shows a row; the rest is logged.
  function failed(error: unknown): void {
    if (error instanceof ChatRunnerLedgerUnreadableError) report(() => deps.ledgerUnreadable());
    else deps.log(error);
  }
  function report(work: () => void): void {
    try {
      work();
    } catch (error) {
      deps.log(error);
    }
  }

  async function publish(session: ChatWakeSession): Promise<void> {
    if (abort.signal.aborted || !session.isCurrent()) return;
    let settled: boolean;
    try {
      settled = await pass(session);
    } catch (error) {
      failed(error);
      settled = false;
    }
    if (abort.signal.aborted || !session.isCurrent()) return;
    if (!settled) retry(session);
    else if (owed?.session === session) {
      owed.sleep?.abort();
      owed = null;
    }
  }

  // Answers whether every step settled. Throws when the settings or the ledger can't be read, before anything goes out.
  async function pass(session: ChatWakeSession): Promise<boolean> {
    current = session;
    startChecking();
    const { scope: account, installId } = session.account;
    const client = deps.client(session);
    const computerLabel = deps.computerLabel();
    const declared = chatRunnerDeclaration({
      installId,
      computerLabel,
      agents: await deps.agents(),
    });
    const wanted = new Set(deps.workspaces(session));
    const ledgered = new Set(
      (await deps.ledger.list())
        .filter((entry) => entry.account === account && entry.installId === installId)
        .map((entry) => entry.workspaceId),
    );
    report(() => deps.clearLedgerUnreadable());
    let settled = true;
    // A workspace with a refusal row is checked too, so its row goes when it stops syncing here.
    for (const workspaceId of new Set([...wanted, ...ledgered, ...rows.keys()])) {
      if (abort.signal.aborted || !session.isCurrent()) return settled;
      const entry = { account, installId, workspaceId };
      // Refused: nothing of this computer's stays declared there, so no old list wakes an agent it no longer has.
      const declaration =
        wanted.has(workspaceId) && declared.ok
          ? declared.declaration
          : withdrawal(session, computerLabel);
      if (wanted.has(workspaceId)) show(workspaceId, declared.ok ? null : declared);
      else show(workspaceId, null);
      if (declaration.runners.length === 0 && !ledgered.has(workspaceId)) continue;
      try {
        if (!(await put(session, client, entry, declaration, abort.signal))) settled = false;
      } catch (error) {
        failed(error);
        settled = false;
      }
    }
    return settled;
  }

  // A pass that left a step unsettled tries again after a capped backoff, for as long as its session is current.
  function retry(session: ChatWakeSession): void {
    // Already sleeping for this session: that pass is the retry.
    if (owed?.session === session && owed.sleep) return;
    const failures = owed?.session === session ? owed.failures + 1 : 1;
    owed?.sleep?.abort();
    const sleep = new AbortController();
    const mine: NonNullable<typeof owed> = { session, failures, sleep };
    owed = mine;
    void deps
      .sleep(deps.backoffMs(failures), AbortSignal.any([abort.signal, sleep.signal]))
      .then(() => {
        // Replaced by another session's retry, or settled meanwhile.
        if (owed !== mine || sleep.signal.aborted) return;
        mine.sleep = null;
        if (!abort.signal.aborted && session.isCurrent()) void roster.reconcile(session);
      });
  }

  const roster: ChatRunnerRoster = {
    reconcile(session) {
      if (abort.signal.aborted) return Promise.resolve();
      if (pending?.session === session) return pending.done;
      const entry: { session: ChatWakeSession; done: Promise<void> } = {
        session,
        done: serial(async () => {
          if (pending === entry) pending = null;
          await publish(session);
        }),
      };
      pending = entry;
      return entry.done;
    },
    withdraw(session) {
      // Anything queued after this belongs to the next session.
      pending = null;
      if (current === session) current = null;
      return serial(async () => {
        // Its rows belong to the account that left: the refusals, and an unreadable ledger's, which the next
        // account's first pass shows again if the file still can't be read.
        for (const workspaceId of [...rows.keys()]) show(workspaceId, null);
        report(() => deps.clearLedgerUnreadable());
        const signal = AbortSignal.any([abort.signal, deps.timeout(CHAT_RUNNER_WITHDRAW_MS)]);
        const { scope: account, installId } = session.account;
        const client = deps.client(session);
        const computerLabel = deps.computerLabel();
        for (const entry of await deps.ledger.list()) {
          if (signal.aborted) return;
          if (entry.account !== account || entry.installId !== installId) continue;
          // Whatever this answers, the server may no longer hold what was last sent.
          sent.delete(keyOf(entry));
          try {
            await client.replaceRunners(
              entry.workspaceId,
              withdrawal(session, computerLabel),
              signal,
            );
          } catch (error) {
            // Kept for the next time this account signs in here, unless the server holds nothing there.
            if (!(error instanceof ChatWakeMissingError)) continue;
          }
          await deps.ledger.remove(entry);
        }
      });
    },
    check() {
      const session = current;
      if (abort.signal.aborted || session === null || !session.isCurrent() || !due(session))
        return Promise.resolve();
      return roster.reconcile(session);
    },
    async stop() {
      abort.abort();
      await queue;
    },
  };
  return roster;
}
