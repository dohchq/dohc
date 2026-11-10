import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { accountFeedWaitGroup, DiscussionActivityCapacityError, type DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, RelayError } from "./errors";
import { observeRelayWrites } from "./relayWriteChanges";
import type { SyncRelayStorage } from "./storage";
import { accountIsFenced } from "./storage/accountDeletion";
import type { AccountFeedStanding } from "./storage/accountFeed";

// An account's change feed for one workspace. A cursor names how far the
// relay log and the accepted live-update journal had reached, and the log
// floor the workspace's last restore set. Each read through a server copy
// answers the cursor its copy had synced to, so a feed started from the
// oldest of them misses no change made after the read. The feed reads the
// log and journal only, never a copy, and leaves out every secret file.

// The server's own path rules: the copies live on its disk.
const PLATFORM = process.platform;

/** Whether the server keeps `path` from every account read, as a secret file. */
export function secretFile(path: string | undefined): boolean {
  return path !== undefined && classifyEngineFilePathForRead(path, PLATFORM).kind === "secret";
}

const isPage = (path: string) => liveDocumentKindForPath(path) === "richdoc";

type Cursor = Pick<AccountFeedStanding, "floor" | "log" | "journal">;

const format = (cursor: Cursor) => `${cursor.floor}.${cursor.log}.${cursor.journal}`;

function parseCursor(value: string | null): Cursor {
  const match = /^(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})$/u.exec(value ?? "");
  const [floor, log, journal] = (match?.slice(1) ?? []).map(Number);
  if (floor === undefined || log === undefined || journal === undefined || ![floor, log, journal].every(Number.isSafeInteger)) {
    throw badRequest("since must be a cursor this server answered");
  }
  return { floor, log, journal };
}

/** The cursor of everything the workspace's log and journal hold now. */
export function currentAccountFeedCursor(storage: Pick<SyncRelayStorage, "accountFeedStanding">, workspaceId: string): string {
  const standing = storage.accountFeedStanding(workspaceId);
  if (standing === null) throw notFound();
  return format(standing);
}

/** What changed, by kind. A kind is present when anything of it changed, and lists the objects or threads known to have. */
export interface AccountFeedChanges {
  files?: string[];
  pages?: string[];
  chats?: string[];
}

/** A cursor this workspace can't continue from answers `replace`: drop what was read and read it again. */
export type AccountFeedAnswer = { cursor: string; replace: true } | { cursor: string; changed: AccountFeedChanges };

// The log rows one answer reads at most. A longer gap answers in parts.
const LOG_ROWS_PER_READ = 1_000;

function readChanges(storage: SyncRelayStorage, workspaceId: string, since: Cursor, standing: Cursor): { next: Cursor; changed: AccountFeedChanges | null } {
  const files = new Set<string>(), pages = new Set<string>(), chats = new Set<string>();
  let chatsChanged = false;
  const rows = storage.accountFeedLogRows({ workspaceId, after: since.log, through: standing.log, limit: LOG_ROWS_PER_READ });
  const log = rows.length === LOG_ROWS_PER_READ ? rows.at(-1)!.relaySeq : standing.log;
  const threadShown = new Map<string, boolean>();
  // A thread is judged as its reads judge it: by where the log last put its file, or by the paths its create names.
  const shown = (threadId: string) => {
    let known = threadShown.get(threadId);
    if (known === undefined) {
      const paths = storage.accountFeedThreadPaths(workspaceId, threadId);
      known = !(paths.lastKnownPath === null ? paths.named.some(secretFile) : secretFile(paths.lastKnownPath));
      threadShown.set(threadId, known);
    }
    return known;
  };
  for (const row of rows) {
    if (row.moment) {
      // An object that moves into or out of a secret path shows as changed, from where it can be seen.
      const visible = [row.moment.path, row.moment.previousPath].filter((path): path is string => path !== null && !secretFile(path));
      if (visible.length === 0) continue;
      files.add(row.moment.objectId);
      if (visible.some(isPage)) pages.add(row.moment.objectId);
    } else if (row.chat && (row.threadId === null || shown(row.threadId))) {
      chatsChanged = true;
      if (row.threadId !== null) chats.add(row.threadId);
    }
  }
  for (const page of storage.accountFeedJournalPages({ workspaceId, after: since.journal, through: standing.journal })) {
    if (!secretFile(page.path)) pages.add(page.objectId);
  }
  const changed: AccountFeedChanges = {
    ...(files.size > 0 ? { files: [...files] } : {}),
    ...(pages.size > 0 ? { pages: [...pages] } : {}),
    ...(chatsChanged ? { chats: [...chats] } : {}),
  };
  return { next: { floor: standing.floor, log, journal: standing.journal }, changed: Object.keys(changed).length > 0 ? changed : null };
}

/**
 * Feed waits, in each workspace's own group. A relay write wakes a
 * workspace's waits only when its log, journal, owner, "Show on phone", or
 * fence changed. A credential fence wakes its account's waits.
 */
export function createAccountFeedWaits(storage: SyncRelayStorage, hub: Pick<DiscussionActivityHub, "wait" | "wake">) {
  const watched = new Map<string, { key: string; waiting: number }>();
  const accounts = new Map<string, Map<string, number>>();
  let stopObserving: (() => void) | undefined;
  const keyOf = (workspaceId: string) => {
    const standing = storage.accountFeedStanding(workspaceId);
    if (standing === null) return "gone";
    return JSON.stringify([standing, storage.showsOnPhone(standing.ownerUserId, workspaceId), accountIsFenced(storage, standing.ownerUserId)]);
  };
  const changed = () => {
    for (const [workspaceId, entry] of watched) {
      const key = keyOf(workspaceId);
      if (key === entry.key) continue;
      entry.key = key;
      hub.wake(accountFeedWaitGroup(workspaceId));
    }
  };
  const count = (counts: Map<string, number>, key: string, by: number) => {
    const next = (counts.get(key) ?? 0) + by;
    if (next > 0) counts.set(key, next);
    else counts.delete(key);
  };

  return {
    /** Parks until a wake or `holdMs`. Answers server_busy when the feed's waits are full. */
    async wait(input: { workspaceId: string; userId: string; caller: string; holdMs: number; signal: AbortSignal; shouldPark(): boolean }): Promise<void> {
      const entry = watched.get(input.workspaceId) ?? { key: keyOf(input.workspaceId), waiting: 0 };
      watched.set(input.workspaceId, entry);
      entry.waiting += 1;
      const workspaces = accounts.get(input.userId) ?? new Map<string, number>();
      accounts.set(input.userId, workspaces);
      count(workspaces, input.workspaceId, 1);
      stopObserving ??= observeRelayWrites(storage, changed);
      try {
        await hub.wait(accountFeedWaitGroup(input.workspaceId), `account:${input.caller}`,
          { holdMs: input.holdMs, signal: input.signal, shouldPark: input.shouldPark });
      } catch (error) {
        if (error instanceof DiscussionActivityCapacityError) {
          throw new RelayError("server_busy", "Your server is holding as many change requests as it can. Try again shortly.");
        }
        throw error;
      } finally {
        entry.waiting -= 1;
        if (entry.waiting === 0) watched.delete(input.workspaceId);
        count(workspaces, input.workspaceId, -1);
        if (workspaces.size === 0) accounts.delete(input.userId);
        if (watched.size === 0) {
          stopObserving?.();
          stopObserving = undefined;
        }
      }
    },
    /** The account's credentials changed: its waits check them again. */
    wakeAccount(userId: string): void {
      for (const workspaceId of accounts.get(userId)?.keys() ?? []) hub.wake(accountFeedWaitGroup(workspaceId));
    },
  };
}

export type AccountFeedWaits = ReturnType<typeof createAccountFeedWaits>;

/**
 * Answers what changed in the workspace after `since`, waiting up to
 * `holdMs` for a change when nothing has. A change on a secret file never
 * answers, and neither does it end the wait. `authorize` checks the caller
 * again after every wait; the caller checks it once more before it answers.
 */
export async function readAccountFeed(storage: SyncRelayStorage, waits: AccountFeedWaits, input: {
  workspaceId: string; userId: string; caller: string; since: string | null; holdMs: number; signal: AbortSignal;
  authorize(): Promise<void>;
}): Promise<AccountFeedAnswer> {
  let since = parseCursor(input.since);
  const deadlineAtMs = Date.now() + input.holdMs;
  for (;;) {
    const standing = storage.accountFeedStanding(input.workspaceId);
    if (standing === null) throw notFound();
    // A restore since, or a cursor outside what the workspace holds, can't be continued.
    if (standing.floor !== since.floor || since.log < since.floor || since.log > standing.log || since.journal > standing.journal) {
      return { cursor: format(standing), replace: true };
    }
    const read = readChanges(storage, input.workspaceId, since, standing);
    if (read.changed) return { cursor: format(read.next), changed: read.changed };
    since = read.next;
    if (since.log < standing.log) continue;
    const holdMs = deadlineAtMs - Date.now();
    if (holdMs <= 0 || input.signal.aborted) return { cursor: format(since), changed: {} };
    await waits.wait({
      workspaceId: input.workspaceId, userId: input.userId, caller: input.caller, holdMs, signal: input.signal,
      shouldPark: () => {
        const now = storage.accountFeedStanding(input.workspaceId);
        return now !== null && format(now) === format(since);
      },
    });
    await input.authorize();
  }
}
