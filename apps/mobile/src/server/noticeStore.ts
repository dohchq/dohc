import type { ServerProblemKind } from "@dohc/interface-words/account";
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
import { each, isFields } from "./api";
import { ServerError, shownProblem } from "./client";
import { sleep } from "./deviceFlow";
import type { NoticeFiles } from "./noticeFiles";
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
// again. Rows of a workspace hidden on this phone go at once, from memory and disk. A change made on another device is
// seen when the phone next reads its workspace list: at launch, on a return from the background, and on Refresh. The
// relay sends nothing when it stops showing a row for another reason, such as its file becoming secret: that row goes
// at the next whole read, not at once.
//
// Marks. Each mark waits in order, on disk, until the server takes it. One request is on its way at a time. A request
// sends, for each row, only the latest of its read and unread marks and the latest of its dismissal and restore, so a
// later mark always lands after an earlier one, even when the earlier one's answer was lost. The list shows each row
// with its waiting marks applied. A mark the server took is applied to the row held then, unless a newer change to
// the row arrived meanwhile.

export const NOTICE_RETRY_MS = 1000;
export const NOTICE_RETRY_MAX_MS = 30_000;
export const NOTICE_FAILURES_SHOWN = 3;
/** A held read that answers sooner than this with nothing new counts toward backing off. */
export const NOTICE_QUICK_ANSWER_MS = 1000;

export interface PendingMark {
  readonly noticeId: string;
  readonly mark: NoticeMark;
  readonly atMs: number;
}

/** Whether reads or marks are failing: why, and how many times the store has shown so, to report each once. */
export interface NoticeFailure {
  readonly problem: ServerProblemKind | null;
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
  /** Starts, or starts again after `pause`, from a whole read. The first call reads the files. */
  resume(): void;
  pause(): void;
  stop(): void;
  /** Reads the whole list again at once. */
  refresh(): void;
  /** Sends the waiting marks again at once. */
  retryMarks(): void;
  mark(noticeId: string, mark: NoticeMark): void;
  /** Marks read every row shown unread. */
  markAllRead(): void;
}

const NONE: NoticeFailure = { problem: null, failures: 0 };
const EMPTY: NoticeListState = { notices: [], known: false, reads: NONE, marks: NONE };

/** The account's scope, for its files. */
export const noticeScope = (signIn: Pick<SignIn, "origin" | "userId">) =>
  JSON.stringify([signIn.origin, signIn.userId, "phone"]);

const axis = (mark: NoticeMark) => (mark === "read" || mark === "unread" ? "read" : "dismissed");
const keyOf = (mark: PendingMark) => `${axis(mark.mark)}\n${mark.noticeId}`;

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

function pendingMark(item: unknown): PendingMark | null {
  return isFields(item) &&
    isNoticeLine(item.noticeId, NOTICE_ID_MAX_CHARS) &&
    isMark(item.mark) &&
    typeof item.atMs === "number" &&
    Number.isFinite(item.atMs)
    ? { noticeId: item.noticeId, mark: item.mark, atMs: item.atMs }
    : null;
}

/** Owned workspaces this phone hides, by the list as it stands, a change still on its way included. */
function hiddenWorkspaces(list: WorkspaceList): ReadonlySet<string> {
  return new Set(
    list.status === "ready"
      ? list.workspaces.filter((entry) => !entry.showOnPhone).map((entry) => entry.workspaceId)
      : [],
  );
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
 * Deletes the Notice files each time the account's sign-in changes: sign-out, a 401, or a new sign-in. The saved
 * sign-in read at launch keeps them, and a launch with none deletes them.
 */
export function clearNoticesOnSignInChange(
  account: { state(): AccountState; subscribe(listener: () => void): () => void },
  files: Pick<NoticeFiles, "clear">,
): () => void {
  const signInOf = (state: AccountState) => (state.status === "signed-in" ? state.signIn : null);
  let serving = account.state();
  return account.subscribe(() => {
    const last = serving;
    const next = account.state();
    serving = next;
    const changed =
      last.status === "loading" ? next.status === "signed-out" : signInOf(next) !== signInOf(last);
    if (changed) void files.clear();
  });
}

export function createNoticeStore(options: {
  readonly signIn: Pick<SignIn, "client" | "isCurrent" | "origin" | "userId">;
  readonly list: Pick<WorkspaceListStore, "state" | "subscribe">;
  readonly files?: NoticeFiles | null;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): NoticeStore {
  const { signIn, list } = options;
  const files = options.files ?? null;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const scope = noticeScope(signIn);
  const listeners = new Set<() => void>();
  const everything = new AbortController();

  /** The rows of the last whole list, with the changes and taken marks since. */
  let rows = new Map<string, NoticeRecord>();
  /** A whole list being read, page by page, until its last page. */
  let building: Map<string, NoticeRecord> | null = null;
  let marks: PendingMark[] = [];
  let known = false;
  let reads = NONE;
  let markFailure = NONE;
  let state = EMPTY;

  let started = false;
  let loaded = false;
  let running = false;
  let stopped = false;
  let pull: AbortController | null = null;
  let sending = false;
  /** Ends the marks' wait between tries: Try again, and a move to the background. */
  let kick = new AbortController();
  let lastKey: string | null = null;
  let unsubscribe: (() => void) | null = null;

  const live = () => !stopped && signIn.isCurrent();
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
    const waiting = new Map<string, PendingMark[]>();
    for (const mark of marks) {
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
  }

  function saveList() {
    if (known && live()) files?.writeList(scope, () => [...rows.values()]);
  }

  function saveMarks() {
    if (live()) void files?.writeMarks(scope, marks.slice());
  }

  // Reading.

  /** Takes one change into `target`, unless it holds a newer one. A row of a hidden workspace isn't kept. */
  function take(
    target: Map<string, NoticeRecord>,
    change: NoticeChange,
    hidden: ReadonlySet<string>,
  ) {
    const id = change.gone ? change.noticeId : change.record.noticeId;
    const seq = change.gone ? change.changeSeq : change.record.changeSeq;
    const held = target.get(id);
    if (held && held.changeSeq >= seq) return;
    const record = change.gone ? null : change.record;
    if (!record || (record.workspaceId !== null && hidden.has(record.workspaceId)))
      target.delete(id);
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
      const hidden = hiddenWorkspaces(list.state());
      for (const change of page.changes) take(building ?? rows, change, hidden);
      if (building && !page.hasMore) {
        rows = building;
        building = null;
        known = true;
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

  // Marking.

  function add(noticeIds: readonly string[], next: NoticeMark) {
    if (!live() || noticeIds.length === 0) return;
    const at = now();
    for (const noticeId of noticeIds) marks.push({ noticeId, mark: next, atMs: at });
    saveMarks();
    publish();
    void send();
  }

  function nudge() {
    kick.abort();
    kick = new AbortController();
  }

  /** Applies a mark the server took to the row held, unless a newer change to it arrived after it was sent. */
  function taken(mark: PendingMark, seqAtSend: number | undefined) {
    for (const target of [rows, building]) {
      const row = target?.get(mark.noticeId);
      if (!target || !row || row.changeSeq !== seqAtSend) continue;
      const next = applyMark(row, mark.mark, mark.atMs);
      target.set(mark.noticeId, {
        ...next,
        expiresAtMs: Math.max(next.expiresAtMs, now() + retention(next)),
      });
    }
  }

  async function send() {
    if (sending || !loaded || !running || !live()) return;
    sending = true;
    let failures = 0;
    let shown = false;
    try {
      while (marks.length > 0 && running && live()) {
        const sent = marks.slice();
        const latest = new Map<string, PendingMark>();
        for (const entry of sent) {
          latest.delete(keyOf(entry));
          latest.set(keyOf(entry), entry);
        }
        const batch = [...latest.values()].slice(0, NOTICE_MARKS_PER_REQUEST);
        const keys = new Set(batch.map(keyOf));
        const seqs = new Map(
          batch.map((entry) => [entry.noticeId, rows.get(entry.noticeId)?.changeSeq]),
        );
        let refused = false;
        try {
          await sendNoticeMarks(signIn.client, batch, everything.signal);
        } catch (error) {
          if (!live() || ended(error)) return;
          // A request the server refused is never taken by sending it again: it goes, and the list is read again.
          refused =
            error instanceof ServerError &&
            (error.problem === "refused" || error.problem === "invalid");
          if (!refused) {
            failures += 1;
            const delay = Math.min(NOTICE_RETRY_MS * 2 ** (failures - 1), NOTICE_RETRY_MAX_MS);
            const problem = shownProblem(error);
            if (
              problem !== null &&
              !shown &&
              (failures >= NOTICE_FAILURES_SHOWN || delay >= NOTICE_RETRY_MAX_MS)
            ) {
              shown = true;
              markFailure = { problem, failures: markFailure.failures + 1 };
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
        if (!live()) return;
        if (markFailure.problem !== null) markFailure = { ...markFailure, problem: null };
        // Each sent mark goes, with the earlier ones it stood for. Marks made meanwhile wait for the next request.
        const sentSet = new Set(sent);
        marks = marks.filter((entry) => !(sentSet.has(entry) && keys.has(keyOf(entry))));
        if (!refused) for (const entry of batch) taken(entry, seqs.get(entry.noticeId));
        saveMarks();
        saveList();
        publish();
        if (refused) restart();
      }
    } finally {
      sending = false;
    }
  }

  // Following the account's workspace list.

  function followList() {
    if (!live()) return;
    const hidden = hiddenWorkspaces(list.state());
    let dropped = false;
    for (const target of [rows, building ?? new Map<string, NoticeRecord>()]) {
      for (const [id, row] of target) {
        if (row.workspaceId === null || !hidden.has(row.workspaceId)) continue;
        target.delete(id);
        dropped = true;
      }
    }
    if (dropped) saveList();
    const key = visibilityKey(list.state());
    const changed = key !== null && lastKey !== null && key !== lastKey;
    if (key !== null) lastKey = key;
    publish();
    if (changed) restart();
  }

  async function load() {
    const [savedRows, savedMarks] = await Promise.all([
      files ? files.readList(scope) : null,
      files ? files.readMarks(scope) : null,
    ]);
    if (!live()) return;
    const found = savedRows === null ? null : each(savedRows, noticeRecord);
    // Rows read from the server meanwhile are newer than the file's.
    if (found && !known) {
      rows = new Map(found.map((row) => [row.noticeId, row]));
      known = true;
    }
    // Marks made meanwhile come after the file's.
    const earlier = savedMarks === null ? null : each(savedMarks, pendingMark);
    if (earlier && earlier.length > 0) marks = [...earlier, ...marks];
    loaded = true;
    followList();
    startPull();
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
      restart();
      void send();
    },
    pause() {
      running = false;
      nudge();
      pull?.abort();
      pull = null;
      building = null;
    },
    stop() {
      stopped = true;
      running = false;
      unsubscribe?.();
      kick.abort();
      pull?.abort();
      everything.abort();
    },
    refresh() {
      if (running) restart();
    },
    retryMarks() {
      nudge();
      void send();
    },
    mark(noticeId, next) {
      if (isNoticeLine(noticeId, NOTICE_ID_MAX_CHARS)) add([noticeId], next);
    },
    markAllRead() {
      add(
        state.notices.filter((row) => row.readAtMs === null).map((row) => row.noticeId),
        "read",
      );
    },
  };
}
