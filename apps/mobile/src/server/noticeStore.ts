import type { ServerProblemKind } from "@dohc/interface-words/account";
import { noticeStorageWords } from "@dohc/interface-words/notices";
import {
  NOTICE_DISMISSED_RETENTION_MS,
  NOTICE_ID_MAX_CHARS,
  NOTICE_MARKS_PER_REQUEST,
  NOTICE_READ_RETENTION_MS,
  NOTICE_UNREAD_RETENTION_MS,
  NOTICE_WAIT_MAX_MS,
  isNoticeLine,
  type NoticeMark,
} from "@dohc/workspace-contracts/relay";
import type { AccountState, SignIn } from "./account";
import { each } from "./api";
import { ServerError, shownProblem } from "./client";
import { sleep } from "./deviceFlow";
import type { KeptStore, Row } from "./keptStore";
import {
  noticeRecord,
  readNotices,
  sendNoticeMarks,
  type NoticeChange,
  type NoticePage,
  type NoticeRecord,
} from "./notices";
import type { WorkspaceList, WorkspaceListStore } from "./workspaceList";

// The account's Notices on this phone: one store per sign-in, beside the workspace list, so it outlives whichever
// workspace is open.
//
// The list. Each start, and each return from the background, reads the whole list again from no cursor, then holds a
// caught-up read open for the next change, one at a time. A whole list is taken only once its last page arrives, so a
// list read part way never shows or saves as complete; until then the last complete one stays. A removed row deletes
// the row this phone holds, and is never shown. Rows past their expiry go, offline too.
//
// Show on phone. The relay leaves out rows of a workspace whose owner hid it from the phone, but nothing tells a held
// read that the setting changed, and a cursor already past a row never serves it again. So each change to the
// account's workspace list that shows or hides one, or adds or removes one, cancels the read and starts the whole list
// again. Rows of a workspace hidden on this phone go at once, from memory and disk. So do rows naming a path, thread,
// or message in a workspace that left the list, which the relay serves only to its owner. A change made on another
// device is seen when the phone next reads its workspace list: at launch, on a return from the background, and on
// Refresh. A Notice read through a share goes at the next read after the share is lost, within a held read's wait:
// the relay starts the whole list over without it. The relay sends nothing when it stops showing a row for another
// reason, such as its file becoming secret: that row goes at the next whole read.
//
// Disk. The whole list and the waiting marks are rows of kept.db (keptStore.ts), with the account's server and user.
// Each commit carries everything kept.db lacks: new marks, in order, the removal of marks the server took, and the list
// when it changed, which otherwise waits a moment so a burst of changes saves once. A commit that fails is tried again,
// backing off, and shows meanwhile, since a close then loses what kept.db lacks. Each mark has a key made on the phone
// when it's made, so a retry after a commit that landed yet reported failure finds its row instead of adding another.
// A failed read of the marks at the start is shown and tried again the same way; until it lands no mark sends, so none
// overtakes a mark an earlier run left.
//
// Marks. A mark shows, sends, and resolves `mark` as kept, only once its row has committed. One request is on its way
// at a time, and sends the oldest committed marks in the order they were made, so a later mark always lands after an
// earlier one, even when the earlier one's answer was lost and both go again. The list shows each row with its
// committed marks applied. A mark the server took is applied to the row held then, unless a newer change to the row
// arrived meanwhile, and its row goes in the same commit as the list it left. Once the store has stopped, as after a
// 401, it adds no mark and saves no list, but still removes the rows of marks the server answered: those answered
// before the stop, those whose removal waited on a commit or its backing off, and those whose answer arrived after the
// sign-in ended. A stopped store commits its removals once at the stop, after any commit on its way, and once more
// each time another removal arrives, with no backing off. A removal that failed goes again in that next commit, and
// deleting a row again changes nothing. Only Sign out's hold stops a removal. Marks wait through a 401, and send after
// a sign-in to their own server and account. Only Sign out deletes them, with the outbox's rows, and nothing writes or
// sends while Sign out holds kept.db. The list goes at each change of sign-in.
//
// Sending again. A mark goes again when the server took it but the commit that removes its row never lands: the app
// closed while that commit failed, or a stopped store's tries failed. Each send carries the mark's key, so the relay
// leaves a mark it already applied as it is, even when another device changed the row in between, and names its key
// in the answer. The phone then applies nothing for that mark, and keeps the row as the relay last served it.

export const NOTICE_RETRY_MS = 1000;
export const NOTICE_RETRY_MAX_MS = 30_000;
export const NOTICE_FAILURES_SHOWN = 3;
/** A held read that answers sooner than this with nothing new counts toward backing off. */
export const NOTICE_QUICK_ANSWER_MS = 1000;

/** A mark in the order made: its kept.db row's key, whether that row has committed, and who waits for it to. */
interface PendingMark {
  readonly key: string;
  readonly noticeId: string;
  readonly mark: NoticeMark;
  readonly atMs: number;
  kept: boolean;
  settle?: (kept: boolean) => void;
}

/** What a mark the server took left its row as, expiry included. */
interface MarkResult {
  readonly readAtMs: number | null;
  readonly dismissedAtMs: number | null;
  readonly expiresAtMs: number;
}

/** The longest wait a timer takes; a later expiry is checked again then. */
const TIMER_MAX_MS = 2 ** 31 - 1;
/** How long a changed list waits to be saved, unless a commit carries it first. */
const NOTICE_LIST_SAVE_MS = 1000;

/** What failed on this phone's storage, by what it means for the person's changes (`noticeStorageWords`). */
export type NoticeStorageProblem = keyof typeof noticeStorageWords;

/** Why reads or marks are failing: the server's answer, or, for marks, this phone's storage. */
export type NoticeProblem = ServerProblemKind | NoticeStorageProblem;

export const isStorageProblem = (problem: NoticeProblem): problem is NoticeStorageProblem =>
  problem in noticeStorageWords;

/** Whether reads or marks are failing: why, and how many times the store has shown so, to report each once. */
export interface NoticeFailure {
  readonly problem: NoticeProblem | null;
  readonly failures: number;
}

export interface NoticeListState {
  /** The Notices this phone shows, newest first, with its waiting marks applied. */
  readonly notices: readonly NoticeRecord[];
  /** A whole list was read, now or before the last launch: an empty one means there are none. */
  readonly known: boolean;
  readonly reads: NoticeFailure;
  readonly marks: NoticeFailure;
}

export interface NoticeStore {
  /** Different for each store, so a failure report belongs to one. */
  readonly instance: number;
  state(): NoticeListState;
  subscribe(listener: () => void): () => void;
  /** Starts, or starts again after `pause`, from a whole read. The first call reads kept.db. */
  resume(): void;
  /** Stops reading, and saves a changed list now, as when the app goes to the background. */
  pause(): void;
  stop(): void;
  /** Reads the whole list again at once. */
  refresh(): void;
  /** Sends the waiting marks again at once, and reads or commits again what failed on kept.db. */
  retryMarks(): void;
  /**
   * Resolves true once the mark's row commits, which may take retries, and only then shows it. Resolves false when it
   * is never kept: Sign out holds kept.db, which the store reports, or the store stops first.
   */
  mark(noticeId: string, mark: NoticeMark): Promise<boolean>;
  markAllRead(): void;
}

const NONE: NoticeFailure = { problem: null, failures: 0 };
const EMPTY: NoticeListState = { notices: [], known: false, reads: NONE, marks: NONE };

/** The row as `mark` leaves it, at `atMs`. */
export function applyMark(row: NoticeRecord, mark: NoticeMark, atMs: number): NoticeRecord {
  switch (mark) {
    case "read":
      return row.readAtMs !== null || row.dismissedAtMs !== null ? row : { ...row, readAtMs: atMs };
    case "unread":
      return row.readAtMs === null ? row : { ...row, readAtMs: null };
    case "dismissed":
      return row.dismissedAtMs !== null ? row : { ...row, dismissedAtMs: atMs };
    case "restore":
      return row.dismissedAtMs === null ? row : { ...row, dismissedAtMs: null };
  }
}

/** How long the relay keeps a row in its state, counted from a mark: until a read gives its own expiry. */
function retention(row: NoticeRecord): number {
  if (row.dismissedAtMs !== null) return NOTICE_DISMISSED_RETENTION_MS;
  return row.readAtMs !== null ? NOTICE_READ_RETENTION_MS : NOTICE_UNREAD_RETENTION_MS;
}

const isMark = (value: unknown): value is NoticeMark =>
  value === "read" || value === "unread" || value === "dismissed" || value === "restore";

/** A mark as its kept.db row holds it, or null for a row this build can't read. */
function savedMark(row: Row): PendingMark | null {
  const { key, notice_id: noticeId, mark, at_ms: atMs } = row;
  return typeof key === "string" &&
    isNoticeLine(noticeId, NOTICE_ID_MAX_CHARS) &&
    isMark(mark) &&
    typeof atMs === "number"
    ? { key, noticeId, mark, atMs, kept: true }
    : null;
}

function parsed(text: unknown): unknown {
  try {
    return typeof text === "string" ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * The rows this phone may not keep, by the list as it stands, a change still on its way included: a row of an owned
 * workspace it hides, and, with `unlisted`, a row naming a path, thread, or message in a workspace the list doesn't
 * hold. The relay serves that second kind only to the workspace's owner, and the list holds every workspace the account
 * owns. A row the relay serves after the list was read is the newer answer, as for a workspace made since, so a read
 * doesn't apply `unlisted`. Nothing while the list isn't read.
 */
function withheld(list: WorkspaceList, unlisted: boolean): (row: NoticeRecord) => boolean {
  if (list.status !== "ready") return () => false;
  const shows = new Map(list.workspaces.map((entry) => [entry.workspaceId, entry.showOnPhone]));
  return (row) => {
    if (row.workspaceId === null) return false;
    const listed = shows.get(row.workspaceId);
    if (listed !== undefined) return !listed;
    if (!unlisted) return false;
    const target = row.target;
    return (
      target !== null &&
      (target.path !== undefined || target.thread !== undefined || target.message !== undefined)
    );
  };
}

/**
 * What decides which rows the relay serves the phone, or null while the list isn't read. A change still on its way
 * counts as its own state, so the change and its answer, or its rollback, each read the whole list again.
 */
function visibilityKey(list: WorkspaceList): string | null {
  if (list.status !== "ready") return null;
  return JSON.stringify(
    list.workspaces
      .map((entry) => [
        entry.workspaceId,
        list.pending.has(entry.workspaceId) ? "pending" : entry.showOnPhone,
      ])
      .sort(([a], [b]) => (String(a) < String(b) ? -1 : 1)),
  );
}

let instances = 0;

/**
 * Deletes every account's Notice list from kept.db each time the account's sign-in changes: sign-out, a 401, or a new
 * sign-in. The saved sign-in read at launch keeps it, and a launch with none deletes it. Marks stay for their account.
 * At Sign out this runs after the checkpoint, but finds nothing: Sign out's own commit deleted every list before it.
 */
export function clearNoticeListsOnSignInChange(
  account: { state(): AccountState; subscribe(listener: () => void): () => void },
  store: Pick<KeptStore, "transaction">,
): () => void {
  const signInOf = (state: AccountState) => (state.status === "signed-in" ? state.signIn : null);
  let serving = account.state();
  return account.subscribe(() => {
    const last = serving;
    const next = account.state();
    serving = next;
    const changed =
      last.status === "loading" ? next.status === "signed-out" : signInOf(next) !== signInOf(last);
    if (changed)
      store.transaction((sql) => sql.run("DELETE FROM notice_lists", [])).catch(() => undefined);
  });
}

export function createNoticeStore(options: {
  readonly signIn: Pick<SignIn, "client" | "isCurrent" | "origin" | "userId">;
  readonly list: Pick<WorkspaceListStore, "state" | "subscribe">;
  readonly store: Pick<KeptStore, "read" | "transaction">;
  /**
   * Sign out holds kept.db's rows (the outbox's `holding`): meanwhile this store adds and removes no row, saves no
   * list, and sends nothing.
   */
  readonly held?: () => boolean;
  readonly listSaveMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): NoticeStore {
  const { signIn, list, store } = options;
  const held = options.held ?? (() => false);
  const listSaveMs = options.listSaveMs ?? NOTICE_LIST_SAVE_MS;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const account = [signIn.origin, signIn.userId];
  const listeners = new Set<() => void>();
  const everything = new AbortController();

  /** The rows of the last whole list, with the changes and taken marks since. */
  let rows = new Map<string, NoticeRecord>();
  /** A whole list being read, page by page, until its last page. */
  let building: Map<string, NoticeRecord> | null = null;
  /** Committed marks first, then those whose rows haven't committed yet, each in the order made. */
  let marks: PendingMark[] = [];
  /** Keys of kept.db rows of marks the server took or refused, or this build can't read, still to delete. */
  let gone: string[] = [];
  /** The list changed since kept.db last took it; `listVersion` counts its changes. */
  let listChanged = false;
  let listVersion = 0;
  let listTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * What the marks the server took left each row as, and the row's sequence when sent. A read the server answered
   * before a mark landed can arrive after its answer: its row, at that sequence or older, takes the result again. A row
   * past that sequence holds the mark, or another device's later change, and ends the entry. So does the result's
   * expiry, and a whole list without the row.
   */
  const acked = new Map<string, { readonly seq: number; readonly result: MarkResult }>();
  let known = false;
  let reads = NONE;
  let markFailure = NONE;
  let state = EMPTY;

  let started = false;
  /** kept.db's list was read, or failed to read: reads may start. */
  let loaded = false;
  /** kept.db's marks were read: marks may send, after every mark an earlier run left. */
  let marksLoaded = false;
  let loading = false;
  let running = false;
  let stopped = false;
  let pull: AbortController | null = null;
  let sending = false;
  /** Ends the marks' wait between tries: Try again, and a move to the background. */
  let kick = new AbortController();
  /** A commit is on its way; `again` when more waits for the next. */
  let saving = false;
  let again = false;
  /** Failed commits since the last one landed. While above 0, a commit is owed. */
  let saveFailures = 0;
  /** Failed reads of the marks since the store started. */
  let loadFailures = 0;
  /** The send's failure, shown unless kept.db's is. */
  let sendProblem: ServerProblemKind | null = null;
  /** What is failing on kept.db, a commit or the read of the marks, shown over a send's failure. */
  let diskProblem: NoticeStorageProblem | null = null;
  /** Ends the wait before an owed commit's next try: a newer commit, or the store's end. */
  let saveWait: AbortController | null = null;
  let lastKey: string | null = null;
  let unsubscribe: (() => void) | null = null;
  /** Shows the list again when its soonest row expires, while the store runs. */
  let expiry: ReturnType<typeof setTimeout> | null = null;

  const live = () => !stopped && signIn.isCurrent();
  const writable = () => live() && !held();
  /** The marks whose rows have committed, which alone show and send. */
  const committed = () => {
    const end = marks.findIndex((mark) => !mark.kept);
    return end < 0 ? marks : marks.slice(0, end);
  };

  /** Shows a failure of kept.db, or takes one back to show the send's failure, if any, as a new report. */
  function diskFailed(problem: NoticeStorageProblem | null) {
    if (problem === diskProblem) return;
    diskProblem = problem;
    const shown = problem ?? sendProblem;
    markFailure =
      shown === null
        ? { ...markFailure, problem: null }
        : { problem: shown, failures: markFailure.failures + 1 };
    publish();
  }
  const ended = (error: unknown) =>
    error instanceof ServerError &&
    (error.problem === "cancelled" || error.problem === "signed-out");

  function publish() {
    if (!live()) return;
    const at = now();
    let pruned = false;
    for (const [id, row] of rows) {
      if (row.expiresAtMs > at) continue;
      rows.delete(id);
      pruned = true;
    }
    if (pruned) saveList();
    // A result expires no sooner than the row it was sent against, so a late copy of that row is past its expiry too
    // and is pruned without the entry. The held row, given the result's expiry, goes in the same pass.
    for (const [id, entry] of acked) if (entry.result.expiresAtMs <= at) acked.delete(id);
    const waiting = new Map<string, PendingMark[]>();
    for (const mark of committed()) {
      const found = waiting.get(mark.noticeId);
      if (found) found.push(mark);
      else waiting.set(mark.noticeId, [mark]);
    }
    const notices: NoticeRecord[] = [];
    for (const row of rows.values()) {
      const shown = (waiting.get(row.noticeId) ?? []).reduce(
        (held, mark) => applyMark(held, mark.mark, mark.atMs),
        row,
      );
      if (shown.dismissedAtMs === null) notices.push(shown);
    }
    notices.sort((a, b) => b.createdAtMs - a.createdAtMs || (a.noticeId < b.noticeId ? -1 : 1));
    state = { notices, known, reads, marks: markFailure };
    for (const listener of listeners) listener();
    armExpiry();
  }

  function armExpiry() {
    if (expiry !== null) clearTimeout(expiry);
    expiry = null;
    if (!running || !live()) return;
    let soonest = Infinity;
    for (const row of rows.values()) soonest = Math.min(soonest, row.expiresAtMs);
    if (soonest === Infinity) return;
    expiry = setTimeout(
      () => {
        expiry = null;
        publish();
      },
      Math.min(Math.max(0, soonest - now()), TIMER_MAX_MS),
    );
  }

  /** The list changed: a commit soon carries it, unless one sooner does. */
  function saveList() {
    if (!known || !live()) return;
    listChanged = true;
    listVersion += 1;
    if (listTimer === null && !saving) listTimer = setTimeout(persist, listSaveMs);
  }

  /**
   * Commits what kept.db lacks, in one transaction: new marks in order, the removal of `gone`, and a changed list. Once
   * the store has stopped, as after a 401, only the removal commits: it records what the server already took.
   */
  function persist() {
    if (listTimer !== null) clearTimeout(listTimer);
    listTimer = null;
    if (held() || (!live() && gone.length === 0)) return;
    if (saving) {
      again = true;
      return;
    }
    saving = true;
    again = false;
    const fresh = marks.filter((mark) => !mark.kept);
    const removed = [...gone];
    const version = listVersion;
    const listed = listChanged && known ? JSON.stringify([...rows.values()]) : null;
    // What the commit means for the person if it fails.
    const failure: NoticeStorageProblem =
      fresh.length > 0 ? "unkept" : removed.length > 0 ? "unrecorded" : "unsaved";
    void store
      .transaction(async (sql) => {
        // A Sign out that started meanwhile deletes the account's rows: none is added or removed after it.
        if (held()) return null;
        const adding = live();
        if (adding)
          for (const mark of fresh)
            await sql.run(
              "INSERT INTO notice_marks (key, origin, account_id, notice_id, mark, at_ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING",
              [mark.key, ...account, mark.noticeId, mark.mark, mark.atMs],
            );
        for (const key of removed) await sql.run("DELETE FROM notice_marks WHERE key = ?", [key]);
        if (adding && listed !== null)
          await sql.run(
            "INSERT INTO notice_lists (origin, account_id, rows) VALUES (?, ?, ?) ON CONFLICT (origin, account_id) DO UPDATE SET rows = excluded.rows",
            [...account, listed],
          );
        return adding;
      })
      .then(
        (added) => {
          saving = false;
          if (added === null) return;
          gone = gone.filter((key) => !removed.includes(key));
          if (added) {
            for (const mark of fresh) {
              mark.kept = true;
              mark.settle?.(true);
            }
            if (listed !== null && listVersion === version) listChanged = false;
          }
          // A stopped store commits the removals that came while this commit was on its way.
          if (!live()) return void (gone.length > 0 && persist());
          saved(null);
        },
        () => {
          saving = false;
          // Stopped, it doesn't back off. It commits again only if the stop or new removals asked for a commit
          // meanwhile, and that commit also carries the ones that just failed.
          if (!live())
            return void ((again || gone.some((key) => !removed.includes(key))) && persist());
          saved(failure);
        },
      );
  }

  /**
   * Takes how a commit ended: null when it landed, or what failed. One that lands shows its marks, sends them, and
   * takes a failure back; one that fails shows at once and is tried again, backing off.
   */
  function saved(failure: NoticeStorageProblem | null) {
    saveWait?.abort();
    saveWait = null;
    if (!live()) return;
    if (failure === null) {
      if (saveFailures > 0) {
        saveFailures = 0;
        diskFailed(loadFailures > 0 && !marksLoaded ? "unread" : null);
      }
      publish();
      if (again || gone.length > 0 || marks.some((mark) => !mark.kept)) persist();
      else if (listChanged && listTimer === null) listTimer = setTimeout(persist, listSaveMs);
      // A commit that lands may follow a read of the marks that failed.
      if (started) void load();
      return void send();
    }
    saveFailures += 1;
    diskFailed(failure);
    const own = new AbortController();
    saveWait = own;
    const delay = Math.min(NOTICE_RETRY_MS * 2 ** (saveFailures - 1), NOTICE_RETRY_MAX_MS);
    void wait(delay, own.signal).then(
      () => {
        if (saveWait === own) persist();
      },
      () => undefined,
    );
  }

  /** Takes one change into `target`, unless it holds a newer one. A row the list withholds isn't kept. */
  function take(
    target: Map<string, NoticeRecord>,
    change: NoticeChange,
    drop: (row: NoticeRecord) => boolean,
  ) {
    const id = change.gone ? change.noticeId : change.record.noticeId;
    const seq = change.gone ? change.changeSeq : change.record.changeSeq;
    const held = target.get(id);
    if (held && held.changeSeq >= seq) return;
    const record = change.gone ? null : change.record;
    const mine = acked.get(id);
    if (mine && (!record || record.changeSeq > mine.seq)) acked.delete(id);
    if (!record || drop(record)) target.delete(id);
    else if (mine && record.changeSeq <= mine.seq) target.set(id, { ...record, ...mine.result });
    else target.set(id, record);
  }

  function startPull() {
    if (!running || !loaded || pull !== null || !live()) return;
    const own = new AbortController();
    pull = own;
    void run(own.signal).finally(() => {
      if (pull === own) pull = null;
    });
  }

  /** Cancels the read on its way, and reads the whole list again. */
  function restart() {
    pull?.abort();
    pull = null;
    building = null;
    startPull();
  }

  async function run(signal: AbortSignal) {
    let cursor: string | null = null;
    let caughtUp = false;
    let failures = 0;
    let shown = false;
    let quick = 0;
    while (!signal.aborted && live()) {
      const asked = now();
      const waitMs = caughtUp ? NOTICE_WAIT_MAX_MS : 0;
      let page: NoticePage;
      try {
        page = await readNotices(signIn.client, { cursor, waitMs }, signal);
      } catch (error) {
        if (signal.aborted || !live() || ended(error)) return;
        failures += 1;
        const delay = Math.min(NOTICE_RETRY_MS * 2 ** (failures - 1), NOTICE_RETRY_MAX_MS);
        const problem = shownProblem(error);
        // With nothing to show, the first failure shows; with a list, a failure keeps happening first.
        if (
          problem !== null &&
          !shown &&
          (!known || failures >= NOTICE_FAILURES_SHOWN || delay >= NOTICE_RETRY_MAX_MS)
        ) {
          shown = true;
          reads = { problem, failures: reads.failures + 1 };
          publish();
        }
        try {
          await wait(delay, signal);
        } catch {
          return;
        }
        continue;
      }
      if (signal.aborted || !live()) return;
      failures = 0;
      shown = false;
      if (reads.problem !== null) reads = { ...reads, problem: null };
      const unchanged =
        caughtUp && !page.replace && page.changes.length === 0 && page.nextCursor === cursor;
      if (page.replace || cursor === null) building = new Map();
      const drop = withheld(list.state(), false);
      for (const change of page.changes) take(building ?? rows, change, drop);
      if (building && !page.hasMore) {
        rows = building;
        building = null;
        known = true;
        for (const id of acked.keys()) if (!rows.has(id)) acked.delete(id);
        saveList();
      } else if (!building && page.changes.length > 0) saveList();
      cursor = page.nextCursor;
      caughtUp = !page.hasMore;
      publish();
      // A held read that answers at once with nothing new, as over the relay's limit on held reads, backs off.
      quick = unchanged && now() - asked < NOTICE_QUICK_ANSWER_MS ? quick + 1 : 0;
      if (quick > 0) {
        try {
          await wait(Math.min(NOTICE_RETRY_MS * 2 ** (quick - 1), NOTICE_RETRY_MAX_MS), signal);
        } catch {
          return;
        }
      }
    }
  }

  /** Shows and sends the marks once their rows commit, and resolves then whether they were kept. */
  function add(noticeIds: readonly string[], next: NoticeMark): Promise<boolean> {
    if (!live() || noticeIds.length === 0) return Promise.resolve(false);
    if (held()) {
      // Each tap says again why nothing happened.
      markFailure = { problem: "held", failures: markFailure.failures + 1 };
      publish();
      return Promise.resolve(false);
    }
    const at = now();
    const kept = noticeIds.map(
      (noticeId) =>
        new Promise<boolean>((settle) =>
          marks.push({
            key: crypto.randomUUID(),
            noticeId,
            mark: next,
            atMs: at,
            kept: false,
            settle,
          }),
        ),
    );
    persist();
    return Promise.all(kept).then((each) => each.every(Boolean));
  }

  /** Reports a send failure. While kept.db is failing, its failure stays shown instead: a close would lose marks. */
  function sendFailed(problem: ServerProblemKind) {
    sendProblem = problem;
    if (diskProblem === null) markFailure = { problem, failures: markFailure.failures + 1 };
  }

  function nudge() {
    kick.abort();
    kick = new AbortController();
  }

  /**
   * What a mark the server took left its row, from the row as it was sent, after any earlier mark of the same request,
   * or null when the phone held no such row. Applies that to the row held only if no newer change to it arrived after
   * it was sent.
   */
  function taken(mark: PendingMark, sent: NoticeRecord | undefined): MarkResult | null {
    if (!sent) return null;
    const next = applyMark(sent, mark.mark, mark.atMs);
    const result: MarkResult = {
      readAtMs: next.readAtMs,
      dismissedAtMs: next.dismissedAtMs,
      expiresAtMs: Math.max(next.expiresAtMs, now() + retention(next)),
    };
    for (const target of [rows, building]) {
      const row = target?.get(mark.noticeId);
      if (target && row && row.changeSeq === sent.changeSeq)
        target.set(mark.noticeId, { ...row, ...result });
    }
    return result;
  }

  async function send() {
    if (sending || !marksLoaded || !running || !writable()) return;
    sending = true;
    let failures = 0;
    let shown = false;
    try {
      while (committed().length > 0 && running && writable()) {
        // In order, with nothing folded together: a Read after an Undo needs the Undo's restore to land first.
        const batch = committed().slice(0, NOTICE_MARKS_PER_REQUEST);
        // Each row as sent, so a taken mark's result never builds on a newer change.
        const sentRows = new Map(batch.map((entry) => [entry.noticeId, rows.get(entry.noticeId)]));
        let refused = false;
        let repeated: ReadonlySet<string> = new Set();
        try {
          repeated = await sendNoticeMarks(signIn.client, batch, everything.signal);
        } catch (error) {
          if (!live() || ended(error)) return;
          // Only a refusal the relay means for good, a 4xx, drops the request's marks. It says so, and the list is
          // read again. A server failure, an answer the phone can't read, or no answer keeps them for the next try.
          refused = error instanceof ServerError && error.problem === "refused";
          if (refused) sendFailed("refused");
          else {
            failures += 1;
            const delay = Math.min(NOTICE_RETRY_MS * 2 ** (failures - 1), NOTICE_RETRY_MAX_MS);
            const problem = shownProblem(error);
            if (
              problem !== null &&
              !shown &&
              (failures >= NOTICE_FAILURES_SHOWN || delay >= NOTICE_RETRY_MAX_MS)
            ) {
              shown = true;
              sendFailed(problem);
              publish();
            }
            try {
              await wait(delay, kick.signal);
            } catch {
              // Try again goes at once, counting failures from none; the background stops here.
              failures = 0;
              shown = false;
            }
            continue;
          }
        }
        if (!live()) {
          // The server took them, though the sign-in ended meanwhile: their rows still go.
          gone.push(...batch.map((entry) => entry.key));
          return persist();
        }
        // A failure after this one is reported again.
        failures = 0;
        shown = false;
        if (!refused) {
          sendProblem = null;
          if (markFailure.problem !== null && diskProblem === null)
            markFailure = { ...markFailure, problem: null };
        }
        // The sent marks go. Marks made meanwhile wait for the next request.
        const sent = new Set(batch);
        marks = marks.filter((entry) => !sent.has(entry));
        gone.push(...batch.map((entry) => entry.key));
        if (!refused)
          for (const entry of batch) {
            if (repeated.has(entry.key)) continue;
            const sent = sentRows.get(entry.noticeId);
            const result = taken(entry, sent);
            if (!sent || !result) continue;
            sentRows.set(entry.noticeId, { ...sent, ...result });
            // A newer row held already ends the entry: a read on its way brings that row or a newer one.
            const superseded = [rows, building].some(
              (target) => (target?.get(entry.noticeId)?.changeSeq ?? -1) > sent.changeSeq,
            );
            if (!superseded) acked.set(entry.noticeId, { seq: sent.changeSeq, result });
          }
        // The marks' rows go in the same commit as the list they left.
        if (!refused) saveList();
        persist();
        publish();
        if (refused) restart();
      }
    } finally {
      sending = false;
    }
  }

  function followList() {
    if (!live()) return;
    const drop = withheld(list.state(), true);
    let dropped = false;
    for (const target of [rows, building ?? new Map<string, NoticeRecord>()]) {
      for (const [id, row] of target) {
        if (!drop(row)) continue;
        target.delete(id);
        dropped = true;
      }
    }
    if (dropped) saveList();
    const key = visibilityKey(list.state());
    // The first list read restarts a read already on its way too: the relay answered that read before this list.
    const changed = key !== null && key !== lastKey && (lastKey !== null || pull !== null);
    if (key !== null) lastKey = key;
    publish();
    if (changed) restart();
  }

  /**
   * Reads the account's list and marks from kept.db. A list that can't be read is the server's to give again. Marks
   * that can't be read show as a failure and are read again, backing off; until then none sends, so none overtakes
   * them.
   */
  async function load() {
    if (loading || marksLoaded) return;
    loading = true;
    let found: readonly NoticeRecord[] | null = null;
    let saved: readonly Row[] | null = null;
    try {
      const [listed] = await store.read(
        "SELECT rows FROM notice_lists WHERE origin = ? AND account_id = ?",
        account,
      );
      found = listed ? each(parsed(listed.rows), noticeRecord) : null;
      saved = await store.read(
        "SELECT key, notice_id, mark, at_ms FROM notice_marks WHERE origin = ? AND account_id = ? ORDER BY sequence",
        account,
      );
    } catch {
      // Reported below.
    }
    loading = false;
    if (!live()) return;
    // Rows read from the server meanwhile are newer than kept.db's.
    if (found && !known) {
      rows = new Map(found.map((row) => [row.noticeId, row]));
      known = true;
    }
    if (saved) {
      // Marks made meanwhile come after kept.db's; one already committed this run is held already.
      const mine = new Set(marks.map((mark) => mark.key));
      const earlier: PendingMark[] = [];
      for (const row of saved) {
        const mark = savedMark(row);
        if (!mark) gone.push(String(row.key));
        else if (!mine.has(mark.key)) earlier.push(mark);
      }
      marks = [...earlier, ...marks];
      marksLoaded = true;
      if (diskProblem === "unread") diskFailed(null);
    } else {
      loadFailures += 1;
      if (saveFailures === 0) diskFailed("unread");
      const delay = Math.min(NOTICE_RETRY_MS * 2 ** (loadFailures - 1), NOTICE_RETRY_MAX_MS);
      void wait(delay, everything.signal).then(load, () => undefined);
    }
    if (!loaded) {
      loaded = true;
      // Shown first, so a row past its expiry goes before the list is saved.
      followList();
      startPull();
    } else publish();
    void send();
  }

  return {
    instance: ++instances,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    resume() {
      if (running || !live()) return;
      running = true;
      if (!started) {
        started = true;
        unsubscribe = list.subscribe(followList);
        void load();
        return;
      }
      publish();
      restart();
      void load();
      void send();
    },
    pause() {
      running = false;
      armExpiry();
      nudge();
      pull?.abort();
      pull = null;
      building = null;
      if (listChanged) persist();
    },
    stop() {
      stopped = true;
      running = false;
      // Marks not kept yet resolve as not kept. A commit whose body already ran may still land their rows; they then
      // send at that account's next sign-in.
      for (const mark of marks) if (!mark.kept) mark.settle?.(false);
      if (expiry !== null) clearTimeout(expiry);
      expiry = null;
      if (listTimer !== null) clearTimeout(listTimer);
      listTimer = null;
      unsubscribe?.();
      kick.abort();
      saveWait?.abort();
      pull?.abort();
      everything.abort();
      persist();
    },
    refresh() {
      if (running) restart();
    },
    retryMarks() {
      nudge();
      if (saveFailures > 0) persist();
      if (started) void load();
      void send();
    },
    mark: (noticeId, next) =>
      isNoticeLine(noticeId, NOTICE_ID_MAX_CHARS) ? add([noticeId], next) : Promise.resolve(false),
    markAllRead() {
      void add(
        state.notices.filter((row) => row.readAtMs === null).map((row) => row.noticeId),
        "read",
      );
    },
  };
}
