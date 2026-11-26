import { randomBytes } from "node:crypto";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import {
  accountFeedWaitGroup,
  DiscussionActivityCapacityError,
  type DiscussionActivityHub,
} from "./discussionActivity";
import { badRequest, notFound, RelayError } from "./errors";
import { channelShown, pathShown, type PhoneMember } from "./phoneMember";
import { observeAcceptedLiveUpdates } from "./relayWriteChanges";
import type { SyncRelayStorage } from "./storage";
import type { AccountFeedStanding } from "./storage/accountFeed";

// The server's own path rules: the copies live on its disk.
const PLATFORM = process.platform;

/** Whether the server keeps `path` from every account read: a secret file, or a path the engine ignores. */
export function hiddenFile(path: string | undefined): boolean {
  return path !== undefined && classifyEngineFilePathForRead(path, PLATFORM).kind !== "tracked";
}

const isPage = (path: string) => liveDocumentKindForPath(path) === "richdoc";

/**
 * Whether a thread shows, judged from the relay's log alone as its reads
 * judge it: hidden when its create names a hidden path, or the log last put
 * its file at one. For a Member, a thread on no file shows only in a Group
 * their reach shows.
 */
export function threadShownByLog(
  storage: Pick<SyncRelayStorage, "accountFeedThreadPaths" | "findChannelCreateKind">,
  workspaceId: string,
  threadId: string,
  member: PhoneMember | null = null,
): boolean {
  const paths = storage.accountFeedThreadPaths(workspaceId, threadId);
  if (!paths.named.every((path) => pathShown(member, path))) return false;
  if (!pathShown(member, paths.lastKnownPath ?? undefined)) return false;
  if (member === null) return true;
  if (paths.linkedObjectId !== null) return paths.lastKnownPath !== null;
  return (
    paths.channelWireId !== null &&
    channelShown(
      member,
      paths.channelWireId,
      storage.findChannelCreateKind(workspaceId, paths.channelWireId),
    )
  );
}

type Cursor = Pick<AccountFeedStanding, "floor" | "log" | "journal"> & { reach: string | null };
type FeedStorage = Pick<
  SyncRelayStorage,
  | "accountFeedStanding"
  | "accountFeedLogRows"
  | "accountFeedJournalRows"
  | "accountFeedThreadPaths"
  | "findChannelCreateKind"
>;

const REACH_KEY = randomBytes(32);
const reachMark = (member: PhoneMember | null) =>
  member === null ? null : member.selector.reach.keyedSignature(REACH_KEY).slice(0, 16);

const format = (cursor: Cursor) =>
  `${cursor.floor}.${cursor.log}.${cursor.journal}${cursor.reach === null ? "" : `.${cursor.reach}`}`;

function parseCursor(value: string | null): Cursor {
  const match =
    /^(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})(?:\.([0-9a-f]{16}))?$/u.exec(
      value ?? "",
    );
  const [floor, log, journal] = (match?.slice(1, 4) ?? []).map(Number);
  if (
    floor === undefined ||
    log === undefined ||
    journal === undefined ||
    ![floor, log, journal].every(Number.isSafeInteger)
  ) {
    throw badRequest("since must be a cursor this server answered");
  }
  return { floor, log, journal, reach: match?.[4] ?? null };
}

/** The cursor of everything the workspace's log and journal hold now, for the owner or this Member. */
export function currentAccountFeedCursor(
  storage: Pick<SyncRelayStorage, "accountFeedStanding">,
  workspaceId: string,
  member: PhoneMember | null = null,
): string {
  const standing = storage.accountFeedStanding(workspaceId);
  if (standing === null) throw notFound();
  return format({ ...standing, reach: reachMark(member) });
}

/** What changed, by kind. A kind is present when anything of it changed, and lists the objects or threads known to have. */
export interface AccountFeedChanges {
  files?: string[];
  pages?: string[];
  chats?: string[];
}

/** A cursor this workspace can't continue from answers `replace`: drop what was read and read it again. */
export type AccountFeedAnswer =
  | { cursor: string; replace: true }
  | { cursor: string; changed: AccountFeedChanges };

// The log rows, and the journal rows, one answer reads at most. A longer gap answers in parts.
const ROWS_PER_READ = 1_000;
/** The feed requests one account may hold waiting at once, across its sign-ins. */
export const ACCOUNT_FEED_WAITS_PER_ACCOUNT = 16;

function readChanges(
  storage: FeedStorage,
  workspaceId: string,
  since: Cursor,
  standing: Omit<Cursor, "reach">,
  member: PhoneMember | null,
): { next: Cursor; changed: AccountFeedChanges | null } {
  const files = new Set<string>(),
    pages = new Set<string>(),
    chats = new Set<string>();
  let chatsChanged = false;
  const rows = storage.accountFeedLogRows({
    workspaceId,
    after: since.log,
    through: standing.log,
    limit: ROWS_PER_READ,
  });
  const log = rows.length === ROWS_PER_READ ? rows.at(-1)!.relaySeq : standing.log;
  const threadShown = new Map<string, boolean>();
  const shown = (threadId: string) => {
    let known = threadShown.get(threadId);
    if (known === undefined) {
      known = threadShownByLog(storage, workspaceId, threadId, member);
      threadShown.set(threadId, known);
    }
    return known;
  };
  for (const row of rows) {
    if (row.moment) {
      // An object that moves into or out of a secret path, or a path a Member's reach hides, shows as changed, from
      // where it can be seen.
      const visible = [row.moment.path, row.moment.previousPath].filter(
        (path): path is string => path !== null && pathShown(member, path),
      );
      if (visible.length === 0) continue;
      files.add(row.moment.objectId);
      if (visible.some(isPage)) pages.add(row.moment.objectId);
    } else if (row.chat && (row.threadId === null ? member === null : shown(row.threadId))) {
      chatsChanged = true;
      if (row.threadId !== null) chats.add(row.threadId);
    }
  }
  const accepted = storage.accountFeedJournalRows({
    workspaceId,
    after: since.journal,
    through: standing.journal,
    limit: ROWS_PER_READ,
  });
  const journal =
    accepted.length === ROWS_PER_READ ? accepted.at(-1)!.journalCursor : standing.journal;
  for (const row of accepted) {
    if (pathShown(member, row.path)) pages.add(row.objectId);
  }
  const changed: AccountFeedChanges = {
    ...(files.size > 0 ? { files: [...files] } : {}),
    ...(pages.size > 0 ? { pages: [...pages] } : {}),
    ...(chatsChanged ? { chats: [...chats] } : {}),
  };
  return {
    next: { floor: standing.floor, log, journal, reach: since.reach },
    changed: Object.keys(changed).length > 0 ? changed : null,
  };
}

/**
 * Feed waits, in each workspace's own group. A write to the workspace's log
 * wakes them through the hub's wakeLog, an accepted live edit through the
 * journal, and a credential fence through wakeAccount. A change to the owner,
 * "Show on phone" or the account fence is found at the next check.
 */
export function createAccountFeedWaits(
  storage: object,
  hub: Pick<DiscussionActivityHub, "wait" | "wake">,
) {
  // Each account's held requests, by workspace.
  const accounts = new Map<string, Map<string, number>>();
  const held = (userId: string) =>
    [...(accounts.get(userId)?.values() ?? [])].reduce((total, count) => total + count, 0);
  const stopObserving = observeAcceptedLiveUpdates(storage, (workspaceId) =>
    hub.wake(accountFeedWaitGroup(workspaceId)),
  );
  const busy = () =>
    new RelayError(
      "server_busy",
      "Your server is holding as many change requests as it can. Try again shortly.",
    );

  return {
    /** Parks until a wake or `holdMs`. Answers server_busy past the account's or the server's waits. */
    async wait(input: {
      workspaceId: string;
      userId: string;
      caller: string;
      holdMs: number;
      signal: AbortSignal;
      shouldPark(): boolean;
    }): Promise<void> {
      if (held(input.userId) >= ACCOUNT_FEED_WAITS_PER_ACCOUNT) throw busy();
      const workspaces = accounts.get(input.userId) ?? new Map<string, number>();
      accounts.set(input.userId, workspaces);
      workspaces.set(input.workspaceId, (workspaces.get(input.workspaceId) ?? 0) + 1);
      try {
        await hub.wait(accountFeedWaitGroup(input.workspaceId), `account:${input.caller}`, {
          holdMs: input.holdMs,
          signal: input.signal,
          shouldPark: input.shouldPark,
        });
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
      for (const workspaceId of accounts.get(userId)?.keys() ?? [])
        hub.wake(accountFeedWaitGroup(workspaceId));
    },
    close: stopObserving,
  };
}

export type AccountFeedWaits = ReturnType<typeof createAccountFeedWaits>;

/**
 * Answers what changed in the workspace after `since`, waiting up to
 * `holdMs` for a change when nothing has. A change on a hidden file, or one
 * a Member's reach hides, never answers, and neither does it end the wait. A
 * Member's cursor from another reach answers `replace`. A gap longer than one part
 * answers each part, changed or not, so one request reads at most one part.
 * `authorize` checks the caller again after every wait; the caller checks it
 * once more before it answers.
 */
export async function readAccountFeed(
  storage: FeedStorage,
  waits: AccountFeedWaits,
  input: {
    workspaceId: string;
    userId: string;
    caller: string;
    since: string | null;
    holdMs: number;
    signal: AbortSignal;
    /** A Member's reach, read again after every wait. Null for the owner. */
    member(): PhoneMember | null;
    authorize(): Promise<void>;
  },
): Promise<AccountFeedAnswer> {
  let since = parseCursor(input.since);
  const deadlineAtMs = Date.now() + input.holdMs;
  for (;;) {
    const standing = storage.accountFeedStanding(input.workspaceId);
    if (standing === null) throw notFound();
    const member = input.member();
    const reach = reachMark(member);
    // A restore since, a cursor outside what the workspace holds, or one from another reach can't be continued.
    if (
      standing.floor !== since.floor ||
      since.log < since.floor ||
      since.log > standing.log ||
      since.journal > standing.journal ||
      since.reach !== reach
    ) {
      return { cursor: format({ ...standing, reach }), replace: true };
    }
    const read = readChanges(storage, input.workspaceId, since, standing, member);
    if (read.changed) return { cursor: format(read.next), changed: read.changed };
    since = read.next;
    if (since.log < standing.log || since.journal < standing.journal)
      return { cursor: format(since), changed: {} };
    const holdMs = deadlineAtMs - Date.now();
    if (holdMs <= 0 || input.signal.aborted) return { cursor: format(since), changed: {} };
    await waits.wait({
      workspaceId: input.workspaceId,
      userId: input.userId,
      caller: input.caller,
      holdMs,
      signal: input.signal,
      shouldPark: () => {
        const now = storage.accountFeedStanding(input.workspaceId);
        return now !== null && format({ ...now, reach: since.reach }) === format(since);
      },
    });
    await input.authorize();
  }
}
