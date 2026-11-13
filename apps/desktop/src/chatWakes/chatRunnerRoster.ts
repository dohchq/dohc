import type { ChatRunnerDeclaration } from "@dohc/workspace-contracts/chat-wakes";
import { RelayUnauthorizedError } from "@dohc/workspace-contracts/relay";
import type { Agent } from "../settings/userSettings";
import { ChatWakeBusyError, ChatWakeMissingError, type ChatWakeClient } from "./chatWakeClient";
import { chatRunnerDeclaration, type ChatRunnerRefusal } from "./chatRunnerDeclaration";
import type { ChatRunnerLedger, ChatRunnerLedgerEntry } from "./chatRunnerLedger";
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

/** How long a sign-out's or account change's withdrawals may take, all together. */
export const CHAT_RUNNER_WITHDRAW_MS = 15_000;

export interface ChatRunnerRosterDeps {
  ledger: ChatRunnerLedger;
  client(session: ChatWakeSession): ChatWakeClient;
  /** The session's own synced workspaces on this computer, open in a window or not: not shares, not paused. */
  workspaces(session: ChatWakeSession): readonly string[];
  agents(): Promise<readonly Pick<Agent, "id" | "name" | "enabled" | "launch">[]>;
  computerLabel(): string;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  backoffMs(failures: number): number;
  /** A signal that aborts after `ms`. */
  timeout(ms: number): AbortSignal;
  /** One row in that workspace's Notices: the server can't take this computer's agents as they are. */
  refused(workspaceId: string, refusal: ChatRunnerRefusal): void;
  /** Takes that row back. */
  accepted(workspaceId: string): void;
  log(error: unknown): void;
}

export interface ChatRunnerRoster {
  /** Publishes this session's declarations. Calls before the pass starts share it. */
  reconcile(session: ChatWakeSession): Promise<void>;
  /** Withdraws everything this install declared under the session's account, with its token, within CHAT_RUNNER_WITHDRAW_MS. */
  withdraw(session: ChatWakeSession): Promise<void>;
  /** Quit: cancels what is in flight and starts nothing more. Declarations stay. */
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
  // What the server last confirmed for each account, install, and workspace.
  const sent = new Map<string, string>();
  // The refusal each workspace's row shows.
  const rows = new Map<string, string>();
  let pending: { session: ChatWakeSession; done: Promise<void> } | null = null;
  let failures = 0;
  let retrying = false;

  const keyOf = (entry: ChatRunnerLedgerEntry) => JSON.stringify([entry.account, entry.installId, entry.workspaceId]);
  const withdrawal = (session: ChatWakeSession, computerLabel: string): ChatRunnerDeclaration =>
    ({ installId: session.account.installId, computerLabel, runners: [] });

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
    session: ChatWakeSession, client: ChatWakeClient, entry: ChatRunnerLedgerEntry,
    declaration: ChatRunnerDeclaration, signal: AbortSignal,
  ): Promise<boolean> {
    const key = keyOf(entry);
    const body = JSON.stringify(declaration);
    if (sent.get(key) === body) return true;
    const declaring = declaration.runners.length > 0;
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
    sent.set(key, body);
    if (!declaring) await deps.ledger.remove(entry);
    return true;
  }

  async function publish(session: ChatWakeSession): Promise<void> {
    if (abort.signal.aborted || !session.isCurrent()) return;
    const { scope: account, installId } = session.account;
    const client = deps.client(session);
    const computerLabel = deps.computerLabel();
    const declared = chatRunnerDeclaration({ installId, computerLabel, agents: await deps.agents() });
    const wanted = new Set(deps.workspaces(session));
    const ledgered = new Set((await deps.ledger.list())
      .filter((entry) => entry.account === account && entry.installId === installId).map((entry) => entry.workspaceId));
    let settled = true;
    // A workspace with a refusal row is checked too, so its row goes when it stops syncing here.
    for (const workspaceId of new Set([...wanted, ...ledgered, ...rows.keys()])) {
      if (abort.signal.aborted || !session.isCurrent()) return;
      const entry = { account, installId, workspaceId };
      // Refused: nothing of this computer's stays declared there, so no old list wakes an agent it no longer has.
      const declaration = wanted.has(workspaceId) && declared.ok ? declared.declaration : withdrawal(session, computerLabel);
      if (wanted.has(workspaceId)) show(workspaceId, declared.ok ? null : declared);
      else show(workspaceId, null);
      // Nothing declared and nothing to take back.
      if (declaration.runners.length === 0 && !ledgered.has(workspaceId)) continue;
      try {
        if (!(await put(session, client, entry, declaration, abort.signal))) settled = false;
      } catch (error) {
        deps.log(error);
        settled = false;
      }
    }
    if (settled) failures = 0;
    else retry(session);
  }

  // A pass that left a step unsettled tries again after a capped backoff, for as long as its session is current.
  function retry(session: ChatWakeSession): void {
    if (retrying) return;
    retrying = true;
    failures += 1;
    void deps.sleep(deps.backoffMs(failures), abort.signal).then(() => {
      retrying = false;
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
      return serial(async () => {
        // Its rows belong to the account that left.
        for (const workspaceId of [...rows.keys()]) show(workspaceId, null);
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
            await client.replaceRunners(entry.workspaceId, withdrawal(session, computerLabel), signal);
          } catch (error) {
            // Kept for the next time this account signs in here, unless the server holds nothing there.
            if (!(error instanceof ChatWakeMissingError)) continue;
          }
          await deps.ledger.remove(entry);
        }
      });
    },
    async stop() {
      abort.abort();
      await queue;
    },
  };
  return roster;
}
