import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { accountFeedWaitGroup, DiscussionActivityCapacityError, type DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, RelayError } from "./errors";
import { observeAcceptedLiveUpdates } from "./relayWriteChanges";
import type { SyncRelayStorage } from "./storage";
import type { AccountFeedStanding } from "./storage/accountFeed";

// An account's change feed for one workspace. A cursor names how far the
// relay log and the accepted live-update journal had reached, and the log
// floor the workspace's last restore set. A write to a secret file moves the
// cursor too, so a poll can tell that a hidden change happened, though never
// what or where; only the owner's own credentials reach the cursor. Each read
// through a server copy answers the cursor its copy had synced to, so a feed
// started from the oldest of them misses no change made after the read. The
// feed reads the log and journal only, never a copy, and leaves out every
// hidden file.

// The server's own path rules: the copies live on its disk.
const PLATFORM = process.platform;

/** Whether the server keeps `path` from every account read: a secret file, or a path the engine ignores. */
export function hiddenFile(path: string | undefined): boolean {
  return path !== undefined && classifyEngineFilePathForRead(path, PLATFORM).kind !== "tracked";
}

const isPage = (path: string) => liveDocumentKindForPath(path) === "richdoc";

type Cursor = Pick<AccountFeedStanding, "floor" | "log" | "journal">;
type FeedStorage = Pick<SyncRelayStorage, "accountFeedStanding" | "accountFeedLogRows" | "accountFeedJournalRows" | "accountFeedThreadPaths">;

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

// The log rows, and the journal rows, one answer reads at most. A longer gap answers in parts.
const ROWS_PER_READ = 1_000;
/** The feed requests one account may hold waiting at once, across its sign-ins. */
export const ACCOUNT_FEED_WAITS_PER_ACCOUNT = 16;

function readChanges(storage: FeedStorage, workspaceId: string, since: Cursor, standing: Cursor): { next: Cursor; changed: AccountFeedChanges | null } {
  const files = new Set<string>(), pages = new Set<string>(), chats = new Set<string>();
  let chatsChanged = false;
  const rows = storage.accountFeedLogRows({ workspaceId, after: since.log, through: standing.log, limit: ROWS_PER_READ });
  const log = rows.length === ROWS_PER_READ ? rows.at(-1)!.relaySeq : standing.log;
  const threadShown = new Map<string, boolean>();
  // A thread is judged as its reads judge it: hidden when its create names a hidden path, or the log last put its file at one.
  const shown = (threadId: string) => {
    let known = threadShown.get(threadId);
    if (known === undefined) {
      const paths = storage.accountFeedThreadPaths(workspaceId, threadId);
      known = !(paths.named.some(hiddenFile) || hiddenFile(paths.lastKnownPath ?? undefined));
      threadShown.set(threadId, known);
    }
    return known;
  };
  for (const row of rows) {
    if (row.moment) {
      // An object that moves into or out of a secret path shows as changed, from where it can be seen.
      const visible = [row.moment.path, row.moment.previousPath].filter((path): path is string => path !== null && !hiddenFile(path));
      if (visible.length === 0) continue;
      files.add(row.moment.objectId);
      if (visible.some(isPage)) pages.add(row.moment.objectId);
    } else if (row.chat && (row.threadId === null || shown(row.threadId))) {
      chatsChanged = true;
      if (row.threadId !== null) chats.add(row.threadId);
    }
  }
  const accepted = storage.accountFeedJournalRows({ workspaceId, after: since.journal, through: standing.journal, limit: ROWS_PER_READ });
  const journal = accepted.length === ROWS_PER_READ ? accepted.at(-1)!.journalCursor : standing.journal;
  for (const row of accepted) {
    if (!hiddenFile(row.path)) pages.add(row.objectId);
  }
  const changed: AccountFeedChanges = {
    ...(files.size > 0 ? { files: [...files] } : {}),
    ...(pages.size > 0 ? { pages: [...pages] } : {}),
    ...(chatsChanged ? { chats: [...chats] } : {}),
  };
  return { next: { floor: standing.floor, log, journal }, changed: Object.keys(changed).length > 0 ? changed : null };
}

/**
 * Feed waits, in each workspace's own group. A write to the workspace's log
 * wakes them through the hub's wakeLog, an accepted live edit through the
 * journal, and a credential fence through wakeAccount. A change to the owner,
 * "Show on phone" or the account fence is found at the next check.
 */
export function createAccountFeedWaits(storage: object, hub: Pick<DiscussionActivityHub, "wait" | "wake">) {
  // Each account's held requests, by workspace.
  const accounts = new Map<string, Map<string, number>>();
  const held = (userId: string) => [...accounts.get(userId)?.values() ?? []].reduce((total, count) => total + count, 0);
  const stopObserving = observeAcceptedLiveUpdates(storage, (workspaceId) => hub.wake(accountFeedWaitGroup(workspaceId)));
  const busy = () => new RelayError("server_busy", "Your server is holding as many change requests as it can. Try again shortly.");

  return {
    /** Parks until a wake or `holdMs`. Answers server_busy past the account's or the server's waits. */
    async wait(input: { workspaceId: string; userId: string; caller: string; holdMs: number; signal: AbortSignal; shouldPark(): boolean }): Promise<void> {
      if (held(input.userId) >= ACCOUNT_FEED_WAITS_PER_ACCOUNT) throw busy();
      const workspaces = accounts.get(input.userId) ?? new Map<string, number>();
      accounts.set(input.userId, workspaces);
      workspaces.set(input.workspaceId, (workspaces.get(input.workspaceId) ?? 0) + 1);
      try {
        await hub.wait(accountFeedWaitGroup(input.workspaceId), `account:${input.caller}`,
          { holdMs: input.holdMs, signal: input.signal, shouldPark: input.shouldPark });
      } catch (error) {
        throw error instanceof DiscussionActivityCapacityError ? busy() : error;
      } finally {
        const left = workspaces.get(input.workspaceId)! - 1;
        if (left > 0) workspaces.set(input.workspaceId, left);
        else workspaces.delete(input.workspaceId);
        if (workspaces.size === 0) accounts.delete(input.userId);
      }
    },
    /** The account's credentials changed: its waits check them again. */
    wakeAccount(userId: string): void {
      for (const workspaceId of accounts.get(userId)?.keys() ?? []) hub.wake(accountFeedWaitGroup(workspaceId));
    },
    close: stopObserving,
  };
}

export type AccountFeedWaits = ReturnType<typeof createAccountFeedWaits>;

/**
 * Answers what changed in the workspace after `since`, waiting up to
 * `holdMs` for a change when nothing has. A change on a hidden file never
 * answers, and neither does it end the wait. A gap longer than one part
 * answers each part, changed or not, so one request reads at most one part.
 * `authorize` checks the caller again after every wait; the caller checks it
 * once more before it answers.
 */
export async function readAccountFeed(storage: FeedStorage, waits: AccountFeedWaits, input: {
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
    if (since.log < standing.log || since.journal < standing.journal) return { cursor: format(since), changed: {} };
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
