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
// again. Rows of a workspace hidden on this phone go at once, from memory and disk. So do rows naming a path, thread,
// or message in a workspace that left the list, which the relay serves only to its owner. A change made on another
// device is seen when the phone next reads its workspace list: at launch, on a return from the background, and on
// Refresh. A Notice read through a share goes at the next read after the share is lost, within a held read's wait:
// the relay starts the whole list over without it. The relay sends nothing when it stops showing a row for another
// reason, such as its file becoming secret: that row goes at the next whole read.
//
// Marks. Each mark waits in order, on disk, until the server takes it. One request is on its way at a time, and sends
// the oldest waiting marks in the order they were made, so a later mark always lands after an earlier one, even when
// the earlier one's answer was lost and both go again. The list shows each row with its waiting marks applied. A mark
// the server took is applied to the row held then, unless a newer change to the row arrived meanwhile. Either way it
// stays on disk, marked taken with what it left the row as sent (expiry included), until a list saved after it has
// landed. A relaunch in between gives the list file's row that recorded result, if the row is the one sent or older,
// and never sends the mark again. One whose row the list file lacks stays on disk until the next whole list is saved.
// A failed save of the marks file is owed: the store tries it again, backing off, until a save lands, and shows the
// failure meanwhile, since a close then loses every mark the disk doesn't hold. Each save writes the whole queue, so
// any later save pays it.

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

/** What a mark the server took left its row as, expiry included. */
interface MarkResult {
  readonly readAtMs: number | null;
  readonly dismissedAtMs: number | null;
  readonly expiresAtMs: number;
}

/**
 * A mark the server took, kept until a list file saved after it has landed. `taken` is the change sequence of the row
 * it applied to when sent, and `result` what it left that row as; both null when the phone held no such row.
 */
interface TakenMark extends PendingMark {
  readonly taken: number | null;
  readonly result: MarkResult | null;
}

/** The longest wait a timer takes; a later expiry is checked again then. */
const TIMER_MAX_MS = 2 ** 31 - 1;

/** Why reads or marks are failing: the server's answer, or, for marks, a save to this phone's storage. */
export type NoticeProblem = ServerProblemKind | "storage";

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
  /** Starts, or starts again after `pause`, from a whole read. The first call reads the files. */
  resume(): void;
  pause(): void;
  stop(): void;
  /** Reads the whole list again at once. */
  refresh(): void;
  /** Sends the waiting marks again at once, and saves them again if a save is owed. */
  retryMarks(): void;
  mark(noticeId: string, mark: NoticeMark): void;
  markAllRead(): void;
}

const NONE: NoticeFailure = { problem: null, failures: 0 };
const EMPTY: NoticeListState = { notices: [], known: false, reads: NONE, marks: NONE };

/** The account's scope, for its files. */
export const noticeScope = (signIn: Pick<SignIn, "origin" | "userId">) =>
  JSON.stringify([signIn.origin, signIn.userId, "phone"]);

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

/** A mark as the marks file holds it: waiting, or taken with the row's change sequence. */
function savedMark(item: unknown): PendingMark | TakenMark | null {
  if (
    !isFields(item) ||
    !isNoticeLine(item.noticeId, NOTICE_ID_MAX_CHARS) ||
    !isMark(item.mark) ||
    typeof item.atMs !== "number" ||
    !Number.isFinite(item.atMs)
  )
    return null;
  const mark = { noticeId: item.noticeId, mark: item.mark, atMs: item.atMs };
  if (item.taken === undefined) return mark;
  const { taken, result } = item;
  if (taken !== null && !(typeof taken === "number" && Number.isSafeInteger(taken))) return null;
  if (result === null) return { ...mark, taken, result };
  return isFields(result) &&
    (result.readAtMs === null || typeof result.readAtMs === "number") &&
    (result.dismissedAtMs === null || typeof result.dismissedAtMs === "number") &&
    typeof result.expiresAtMs === "number"
    ? {
        ...mark,
        taken,
        result: {
          readAtMs: result.readAtMs,
          dismissedAtMs: result.dismissedAtMs,
          expiresAtMs: result.expiresAtMs,
        },
      }
    : null;
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
  /** Marks the server took whose effect the list file may not hold yet. */
  let settling: TakenMark[] = [];
  /** Taken marks a relaunch found whose row the list file lacks: they settle with the next whole list. */
  let unplaced: TakenMark[] = [];
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
  let loaded = false;
  let running = false;
  let stopped = false;
  let pull: AbortController | null = null;
  let sending = false;
  /** Ends the marks' wait between tries: Try again, and a move to the background. */
  let kick = new AbortController();
  /** Failed saves of the marks file since the last one landed. While above 0, a save is owed. */
  let saveFailures = 0;
  /** The send's failure, shown unless an owed save's failure is. */
  let sendProblem: ServerProblemKind | null = null;
  /** Ends the wait before an owed save's next try: a newer save, or the store's end. */
  let saveWait: AbortController | null = null;
  let lastKey: string | null = null;
  let unsubscribe: (() => void) | null = null;
  /** Shows the list again when its soonest row expires, while the store runs. */
  let expiry: ReturnType<typeof setTimeout> | null = null;

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
    // A result expires no sooner than the row it was sent against, so a late copy of that row is past its expiry too
    // and is pruned without the entry. The held row, given the result's expiry, goes in the same pass.
    for (const [id, entry] of acked) if (entry.result.expiresAtMs <= at) acked.delete(id);
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

  function saveList() {
    if (known && live()) files?.writeList(scope, () => [...rows.values()]);
  }

  /** The marks file: taken marks still settling, then the waiting ones, in order. */
  function saveMarks() {
    if (!live() || !files) return;
    void files.writeMarks(scope, [...unplaced, ...settling, ...marks]).then(marksSaved);
  }

  /**
   * Takes how a save of the whole marks queue ended. The files answer in the order the saves were made, so the last
   * answer is the newest queue's. A failure shows at once and is tried again; a save that lands takes the failure back.
   */
  function marksSaved(landed: boolean) {
    saveWait?.abort();
    saveWait = null;
    if (!live()) return;
    if (landed) {
      if (saveFailures === 0) return;
      saveFailures = 0;
      // A send failure it covered shows again as a new report.
      markFailure =
        sendProblem === null
          ? { ...markFailure, problem: null }
          : { problem: sendProblem, failures: markFailure.failures + 1 };
      return publish();
    }
    saveFailures += 1;
    if (saveFailures === 1) {
      markFailure = { problem: "storage", failures: markFailure.failures + 1 };
      publish();
    }
    const own = new AbortController();
    saveWait = own;
    const delay = Math.min(NOTICE_RETRY_MS * 2 ** (saveFailures - 1), NOTICE_RETRY_MAX_MS);
    void wait(delay, own.signal).then(
      () => {
        if (saveWait === own) saveMarks();
      },
      () => undefined,
    );
  }

  /** Saves the list now, and only once it has landed drops the taken marks it holds from the marks file. */
  function settle() {
    if (settling.length === 0 || !live()) return;
    if (!files || !known) {
      settling = [];
      return saveMarks();
    }
    const done = new Set(settling);
    void files
      .writeListThenMarks(scope, [...rows.values()], () => {
        settling = settling.filter((entry) => !done.has(entry));
        return [...unplaced, ...settling, ...marks];
      })
      .then((result) => {
        // A list that fails leaves the marks file as it was, owed or not.
        if (result !== "list-failed") marksSaved(result === "saved");
      });
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
        // A whole list read since the relaunch holds what the server took.
        if (unplaced.length > 0) {
          settling.push(...unplaced);
          unplaced = [];
          settle();
        }
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

  function add(noticeIds: readonly string[], next: NoticeMark) {
    if (!live() || noticeIds.length === 0) return;
    const at = now();
    for (const noticeId of noticeIds) marks.push({ noticeId, mark: next, atMs: at });
    saveMarks();
    publish();
    void send();
  }

  /** Reports a send failure. While a save is owed, its failure stays shown instead: a close would lose marks. */
  function sendFailed(problem: ServerProblemKind) {
    sendProblem = problem;
    if (saveFailures === 0) markFailure = { problem, failures: markFailure.failures + 1 };
  }

  function nudge() {
    kick.abort();
    kick = new AbortController();
  }

  /**
   * Records what a mark the server took left its row as, from the row as it was sent, after any earlier mark of the
   * same request. Applies that to the row held only if no newer change to it arrived after it was sent.
   */
  function taken(mark: PendingMark, sent: NoticeRecord | undefined): TakenMark {
    if (!sent) return { ...mark, taken: null, result: null };
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
    return { ...mark, taken: sent.changeSeq, result };
  }

  /**
   * After a relaunch, applies a taken mark's recorded result to the list file's row, if that row is the one it applied
   * to or older, as when the list's save was still waiting when the mark went. A newer row is another device's change
   * and keeps its own. The expiry is the one the server's answer set, never one from now. Resolves whether the list now
   * holds the mark's effect; false only when the list file lacks the row.
   */
  function replay(mark: TakenMark): boolean {
    const result = mark.result;
    if (!result || mark.taken === null) return true;
    const row = rows.get(mark.noticeId);
    if (!row) return false;
    if (
      row.changeSeq > mark.taken ||
      (row.readAtMs === result.readAtMs &&
        row.dismissedAtMs === result.dismissedAtMs &&
        row.expiresAtMs === result.expiresAtMs)
    )
      return true;
    rows.set(mark.noticeId, { ...row, ...result });
    return true;
  }

  async function send() {
    if (sending || !loaded || !running || !live()) return;
    sending = true;
    let failures = 0;
    let shown = false;
    try {
      while (marks.length > 0 && running && live()) {
        // In order, with nothing folded together: a Read after an Undo needs the Undo's restore to land first.
        const batch = marks.slice(0, NOTICE_MARKS_PER_REQUEST);
        // Each row as sent, so a taken mark's result never builds on a newer change.
        const sentRows = new Map(batch.map((entry) => [entry.noticeId, rows.get(entry.noticeId)]));
        let refused = false;
        try {
          await sendNoticeMarks(signIn.client, batch, everything.signal);
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
        if (!live()) return;
        // A failure after this one is reported again.
        failures = 0;
        shown = false;
        if (!refused) {
          sendProblem = null;
          if (markFailure.problem !== null && saveFailures === 0)
            markFailure = { ...markFailure, problem: null };
        }
        // The sent marks go. Marks made meanwhile wait for the next request.
        const sent = new Set(batch);
        marks = marks.filter((entry) => !sent.has(entry));
        // Every taken mark settles, whether or not a newer change to its row came first: the marks file records it as
        // taken, then the list as it is now lands, then it leaves the marks file.
        if (!refused)
          for (const entry of batch) {
            const sent = sentRows.get(entry.noticeId);
            const mark = taken(entry, sent);
            if (sent && mark.result) {
              sentRows.set(entry.noticeId, { ...sent, ...mark.result });
              // A newer row held already ends the entry: a read on its way brings that row or a newer one.
              const superseded = [rows, building].some(
                (target) => (target?.get(entry.noticeId)?.changeSeq ?? -1) > sent.changeSeq,
              );
              if (!superseded)
                acked.set(entry.noticeId, { seq: sent.changeSeq, result: mark.result });
            }
            if (known) settling.push(mark);
          }
        saveMarks();
        settle();
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
    // Marks made meanwhile come after the file's. A taken mark's recorded result applies to the list file's row, and
    // settles again so a list saved after it lands before it leaves the marks file.
    const saved = savedMarks === null ? null : each(savedMarks, savedMark);
    const waiting: PendingMark[] = [];
    for (const entry of saved ?? []) {
      if (!("taken" in entry)) waiting.push(entry);
      else if (found && replay(entry)) settling.push(entry);
      // Kept, never sent, until a list holding its effect is saved.
      else unplaced.push(entry);
    }
    marks = [...waiting, ...marks];
    loaded = true;
    // Shown first, so a row past its expiry goes before the list is saved.
    followList();
    settle();
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
      publish();
      restart();
      void send();
    },
    pause() {
      running = false;
      armExpiry();
      nudge();
      pull?.abort();
      pull = null;
      building = null;
    },
    stop() {
      stopped = true;
      running = false;
      if (expiry !== null) clearTimeout(expiry);
      expiry = null;
      unsubscribe?.();
      kick.abort();
      saveWait?.abort();
      pull?.abort();
      everything.abort();
    },
    refresh() {
      if (running) restart();
    },
    retryMarks() {
      nudge();
      if (saveFailures > 0) saveMarks();
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
