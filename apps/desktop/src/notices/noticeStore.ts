import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { NoticeNotSentError } from "@dohc/automation-executor/automation-chat";
import {
  isNoticeBody,
  isNoticeLine,
  isNoticeTarget,
  NOTICE_DISMISSED_RETENTION_MS,
  NOTICE_FROM_PREFIX,
  NOTICE_KINDS,
  NOTICE_LIST_ROW_LIMIT,
  NOTICE_MARKS_PER_REQUEST,
  NOTICE_PAGE_MAX,
  NOTICE_POSTED_ID_MAX_CHARS,
  NOTICE_READ_RETENTION_MS,
  NOTICE_TITLE_MAX_CHARS,
  NOTICE_UNREAD_RETENTION_MS,
  type NoticeKind,
  type NoticeMark,
  type NoticeReach,
  type NoticeRecipient,
  type NoticeTarget,
  type PostNoticeRequest,
  type SyncRelayConnection,
  type PostableNoticeKind,
} from "@dohc/workspace-contracts/relay";
import { NoticeRow, NoticeTargetShape, RefusalCoordinate, type NoticeRef } from "../ipc/bridgeContract";
import { relayRequest } from "../workspaces/relayRequest";

// The local file holds only this computer's notices, so it keeps fewer rows.
const LOCAL_NOTICE_ROW_LIMIT = 500;
const SERVER_OUTDATED_KIND = "server-outdated";

// The signed-in session a notice list belongs to.
export interface NoticeAccount {
  // Names the server, relay, and user, so each account has its own file.
  key: string;
  userId: string;
  relay: SyncRelayConnection;
}

// One signed-in session, read from one credential snapshot, so the account
// and every reach come from the same credentials. Once `isCurrent` turns
// false, nothing more is queued or sent for the session.
export interface NoticeSession {
  account: NoticeAccount;
  // How this session reaches this computer's workspace on its relay, or
  // null when the workspace does not sync through it.
  reachFor(workspaceId: string): NoticeReach | null;
  isCurrent(): boolean;
}

export interface PostNoticeInput {
  // This computer's workspace id.
  workspaceId: string;
  noticeId: string;
  kind: PostableNoticeKind;
  title: string;
  body: string;
  target?: NoticeTarget;
  // Another person's relay user id. Absent, or your own id, sends the
  // notice to yourself.
  recipientUserId?: string;
  // Sends it to the owner of the workspace instead. From the owner's own
  // computer that is yourself; through a share, the relay finds the owner.
  toWorkspaceOwner?: true;
  // Ends the post before it sends or queues, as when an automation run stops.
  signal?: AbortSignal;
}

export interface NoticeStore {
  // Throws when the notice breaks the relay's rules, before keeping it.
  postNotice(input: PostNoticeInput): Promise<void>;
  // The rows and the key of the signed-in account they belong to, read
  // from one session.
  list(): Promise<{ account: string | null; notices: NoticeRow[] }>;
  // `account` is the key the caller's list showed. Account rows are marked
  // only while that account is signed in; local rows always are.
  mark(refs: readonly NoticeRef[], mark: NoticeMark, account: string | null): Promise<void>;
  // Dismisses one notice now and says whether this was its first dismissal,
  // as Run now needs: "unanswered" when the relay could not say.
  dismissFirst(ref: NoticeRef, account: string | null): Promise<"first" | "not-first" | "unanswered">;
  // Takes back a notice this computer posted: an unsent post goes, and a
  // sent one is dismissed.
  withdraw(noticeId: string): Promise<void>;
  // Sends waiting posts and marks, then pulls changes. Never rejects.
  sync(): Promise<void>;
  refreshRefusals(openedWorkspaceId?: string): Promise<void>;
  // The failure notice the signed-in person sent themselves about one run,
  // dismissed or not, with the computer that posted it, or null. Only read,
  // never shown.
  sentFailure(run: { workspaceId: string; automationId: string; claimId: string }): Promise<SentFailure | null>;
}

export interface SentFailure {
  title: string;
  body: string;
  originInstallId: string;
}

const kindValues = Object.keys(NOTICE_KINDS) as [NoticeKind, ...NoticeKind[]];
// The kinds this computer may post; the relay writes the others itself.
const postableKindValues = kindValues.filter(
  (kind): kind is PostableNoticeKind => NOTICE_KINDS[kind].recipients !== "relay",
) as [PostableNoticeKind, ...PostableNoticeKind[]];
// The relay's rules, checked before a notice is kept anywhere.
const NoticeContent = z.object({
  noticeId: z.string().refine((value) =>
    isNoticeLine(value, NOTICE_POSTED_ID_MAX_CHARS) && !value.startsWith(NOTICE_FROM_PREFIX)),
  workspaceId: z.string().refine((value) => isNoticeLine(value, 256)),
  kind: z.enum(postableKindValues),
  title: z.string().refine((value) => isNoticeLine(value, NOTICE_TITLE_MAX_CHARS)),
  body: z.string().refine(isNoticeBody),
  target: z.custom<NoticeTarget>(isNoticeTarget),
});
type NoticeContent = z.infer<typeof NoticeContent>;

const Reach = z.union([
  z.object({ workspaceId: z.string().min(1), shareId: z.undefined().optional() }),
  z.object({ shareId: z.string().min(1), workspaceId: z.undefined().optional() }),
]);
// Only your own posts wait in the outbox, so each names you.
const PostRequest = z.object({
  noticeId: z.string(),
  recipientUserId: z.string().min(1),
  kind: z.enum(kindValues),
  title: z.string(),
  body: z.string(),
  target: NoticeTargetShape,
  originInstallId: z.string().min(1),
}).and(Reach);

const LocalRow = z.object({
  refusalCoordinates: NoticeRow.shape.refusalCoordinates,
  pendingRefusalDismissals: z.array(RefusalCoordinate).optional(),
  noticeId: NoticeRow.shape.noticeId,
  kind: NoticeRow.shape.kind,
  workspaceId: NoticeRow.shape.workspaceId,
  title: NoticeRow.shape.title,
  body: NoticeRow.shape.body,
  detail: NoticeRow.shape.detail,
  target: NoticeTargetShape,
  createdAtMs: NoticeRow.shape.createdAtMs,
  readAtMs: NoticeRow.shape.readAtMs,
  // Kept as a tombstone until its retention ends, so the same notice is
  // not posted again.
  dismissedAtMs: z.number().int().nonnegative().nullable(),
});
type LocalRow = z.infer<typeof LocalRow>;

export const RefusalNotices = z.object({ notices: z.array(z.object({
  refusalCoordinates: z.array(RefusalCoordinate),
  noticeId: z.string(), originId: z.string(), originSeq: z.number(), reason: z.string(),
  document: z.object({ versionId: z.string().nullable(), path: z.string().nullable(), objectId: z.string(),
    lineageClaimId: z.string(), conflictId: z.string().nullable() }).nullable(),
})) });
type RefusalNotice = z.infer<typeof RefusalNotices>["notices"][number];

function coordinateKey(coordinate: RefusalCoordinate): string {
  return JSON.stringify([coordinate.originId, coordinate.originSeq]);
}

function withoutCoordinates(rows: RefusalCoordinate[], removed: RefusalCoordinate[]): RefusalCoordinate[] {
  const keys = new Set(removed.map(coordinateKey));
  return rows.filter(row => !keys.has(coordinateKey(row)));
}

const RelayRow = z.object({
  noticeId: NoticeRow.shape.noticeId,
  changeSeq: z.number().int().positive(),
  workspaceId: NoticeRow.shape.workspaceId,
  recipientShareId: NoticeRow.shape.recipientShareId,
  kind: NoticeRow.shape.kind,
  senderKind: z.enum(["person", "agent", "automation"]),
  senderUserId: z.string().min(1).max(1_024),
  senderLabel: NoticeRow.shape.senderLabel.unwrap(),
  title: NoticeRow.shape.title,
  body: NoticeRow.shape.body,
  target: NoticeRow.shape.target,
  originInstallId: z.string().min(1).max(256),
  createdAtMs: NoticeRow.shape.createdAtMs,
  readAtMs: NoticeRow.shape.readAtMs,
  dismissedAtMs: z.number().int().nonnegative().nullable(),
  removed: z.boolean(),
});
type RelayRow = z.infer<typeof RelayRow>;

const LocalFile = z.object({
  version: z.literal(1), rows: z.array(LocalRow),
});
type LocalFile = z.infer<typeof LocalFile>;

const OutboxMark = z.object({
  noticeId: NoticeRow.shape.noticeId,
  mark: z.enum(["read", "dismissed"]),
  atMs: z.number().int().nonnegative(),
});
type OutboxMark = z.infer<typeof OutboxMark>;

// An account's rows as the relay last served them, dismissed rows kept as
// tombstones, the pull cursor, and the outbox. The outbox holds your own
// posts until a finished pull shows them, and one mark per notice until the
// relay accepts it. Unsent posts are capped at the relay's list size, oldest
// dropped first.
const AccountFile = z.object({
  version: z.literal(1),
  cursor: z.string().max(64).nullable(),
  // The server answered that it has no notice list. Notices for this account
  // stay on this computer until a pull succeeds.
  routesMissing: z.boolean(),
  rows: z.array(RelayRow),
  posts: z.array(z.object({
    request: PostRequest,
    // This computer's workspace, which a notice through a share does not
    // name, so the notice can move to this computer's list.
    workspaceId: z.string().min(1),
    createdAtMs: NoticeRow.shape.createdAtMs,
    // The relay accepted it; the next finished pull settles it.
    sent: z.boolean(),
    // Taken back while unsent. A post never sent is dropped; one that went
    // out is dismissed once the relay confirms it holds it.
    withdrawn: z.literal(true).optional(),
    // It went out at least once, and the relay may hold it even though no
    // answer came back.
    attempted: z.literal(true).optional(),
  })),
  marks: z.array(OutboxMark),
});
type AccountFile = z.infer<typeof AccountFile>;

const RelayPage = z.object({
  ok: z.literal(true),
  notices: z.array(z.unknown()).max(NOTICE_PAGE_MAX),
  nextCursor: z.string().min(1).max(64),
  hasMore: z.boolean(),
  replace: z.boolean(),
});

class RelayRefusal extends Error {
  constructor(readonly reason: "invalid" | "refused" | "rate-limited" | "list-full" | "routes-missing") {
    super(reason);
  }
}

// The signed-in session changed before a notice was queued or sent.
class SessionChanged extends Error {}

/**
 * Notices sent to a person, kept in main under `directory`: one file for this
 * computer and one per signed-in account. Your own account notices go through
 * the account's outbox to its relay list, and every computer pulls that list.
 * A notice stays on this computer when nobody is signed in, when its workspace
 * does not sync through the signed-in server, or when that server has no
 * notice list. A local notice stays local.
 */
export function createNoticeStore(deps: {
  directory: string;
  // The signed-in session, or null when nobody is signed in to a relay.
  session(): Promise<NoticeSession | null>;
  installId(): string;
  onChanged(): void;
  // Null keeps cached rows for a workspace whose engine could not be read.
  refusalNotices?(openedWorkspaceId?: string): Promise<{ workspaceId: string; notices: RefusalNotice[] | null }[]>;
  dismissRefusal?(workspaceId: string, noticeId: string, refusalCoordinates: RefusalCoordinate[]): Promise<void>;
  nowMs?: () => number;
  outboxPostLimit?: number;
}): NoticeStore {
  const nowMs = deps.nowMs ?? Date.now;
  const outboxPostLimit = deps.outboxPostLimit ?? NOTICE_LIST_ROW_LIMIT;
  let localFile: LocalFile | null = null;
  const accountFiles = new Map<string, AccountFile>();

  // Every read and write of the files runs in this queue, one at a time.
  // Relay calls run outside it.
  let queue: Promise<unknown> = Promise.resolve();
  function locked<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work);
    queue = run.catch(() => undefined);
    return run;
  }

  const accountFileName = (account: NoticeAccount) =>
    `account-${createHash("sha256").update(account.key).digest("hex").slice(0, 32)}.json`;

  async function load<T>(name: string, schema: z.ZodType<T>, empty: T): Promise<T> {
    const path = join(deps.directory, name);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return parsed.data;
    // Keep a damaged file for inspection and start again. An account list
    // refills from the relay because its cursor starts over.
    console.error(`[notices] ${name} is damaged; it was moved aside`, parsed.error);
    await rename(path, `${path}.damaged`);
    return empty;
  }

  async function save(name: string, value: LocalFile | AccountFile): Promise<void> {
    await mkdir(deps.directory, { recursive: true });
    const path = join(deps.directory, name);
    await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }

  async function loadLocal(): Promise<LocalFile> {
    if (!localFile) {
      localFile = await load("local.json", LocalFile, { version: 1, rows: [] });
      if (pruneLocal(localFile)) await saveLocal(localFile);
    }
    return localFile;
  }

  // The cache takes a file only once it is saved. A caller that must not
  // change the cache on a failed save changes a copy and saves that.
  async function saveLocal(file: LocalFile): Promise<void> {
    await save("local.json", file);
    localFile = file;
  }

  function pruneLocal(file: LocalFile): boolean {
    // Dismissed refusal rows also wait for the engine to acknowledge them on next open.
    const pending = file.rows.filter(row => row.kind === "sync-refusal");
    const rest = file.rows.filter(row => row.kind !== "sync-refusal");
    const kept = [...pending, ...retained(rest, LOCAL_NOTICE_ROW_LIMIT, nowMs())];
    if (kept.length === file.rows.length) return false;
    file.rows = kept;
    return true;
  }

  async function loadAccount(account: NoticeAccount): Promise<AccountFile> {
    const name = accountFileName(account);
    let file = accountFiles.get(name);
    if (!file) {
      file = await load(name, AccountFile, {
        version: 1, cursor: null, routesMissing: false, rows: [], posts: [], marks: [],
      });
      accountFiles.set(name, file);
      if (pruneAccount(file)) await saveAccount(account, file);
    }
    return file;
  }

  async function saveAccount(account: NoticeAccount, file: AccountFile): Promise<void> {
    await save(accountFileName(account), file);
    accountFiles.set(accountFileName(account), file);
  }

  // Only cached relay rows age out; the outbox has its own limit.
  function pruneAccount(file: AccountFile): boolean {
    const kept = retained(file.rows, NOTICE_LIST_ROW_LIMIT, nowMs());
    if (kept === file.rows) return false;
    file.rows = kept;
    return true;
  }

  function addLocal(file: LocalFile, content: Omit<LocalRow, "createdAtMs" | "readAtMs" | "dismissedAtMs">, createdAtMs: number): boolean {
    if (file.rows.some((existing) => existing.noticeId === content.noticeId)) return false;
    file.rows.push({ ...content, createdAtMs, readAtMs: null, dismissedAtMs: null });
    return true;
  }

  // One waiting mark per notice. Dismissed takes the place of read, and read
  // adds nothing to dismissed. Returns false when nothing changed.
  function queueMark(file: AccountFile, noticeId: string, mark: NoticeMark): boolean {
    const index = file.marks.findIndex((waiting) => waiting.noticeId === noticeId);
    const waiting = file.marks[index];
    if (waiting && (waiting.mark === "dismissed" || mark === "read")) return false;
    // A new object, so a batch already on its way still names the old mark.
    const entry = { noticeId, mark, atMs: nowMs() };
    if (waiting) file.marks[index] = entry;
    else file.marks.push(entry);
    return true;
  }

  async function relay(session: NoticeSession, path: string, body?: unknown): Promise<Response> {
    if (!session.isCurrent()) throw new SessionChanged();
    const refusal = (reason: RelayRefusal["reason"]) => () => new RelayRefusal(reason);
    return relayRequest({
      relay: session.account.relay,
      path,
      init: body === undefined ? undefined : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      // An older server answers 404 for every notice route.
      errors: {
        400: refusal("invalid"),
        403: refusal("refused"),
        404: refusal("routes-missing"),
        409: refusal("list-full"),
        429: refusal("rate-limited"),
      },
      label: "Notices",
    });
  }

  // The server has no notice list. Waiting notices move to this computer's
  // list, and one local notice says why, once per account.
  async function noteRoutesMissing(account: NoticeAccount): Promise<void> {
    const changed = await locked(async () => {
      const file = await loadAccount(account);
      if (file.routesMissing && file.posts.length === 0 && file.marks.length === 0) return false;
      const local = await loadLocal();
      for (const { request, workspaceId, createdAtMs } of file.posts) {
        addLocal(local, {
          noticeId: request.noticeId, kind: request.kind, workspaceId,
          title: request.title, body: request.body, target: request.target,
        }, createdAtMs);
      }
      file.posts = [];
      file.marks = [];
      if (!file.routesMissing) {
        file.routesMissing = true;
        addLocal(local, {
          noticeId: `${SERVER_OUTDATED_KIND}:${accountFileName(account)}`,
          kind: SERVER_OUTDATED_KIND,
          workspaceId: null,
          title: "Your server doesn't sync notices",
          body: "Notices stay on this computer until the server runs a newer version of dohc.",
          target: {},
        }, nowMs());
      }
      await saveLocal(local);
      await saveAccount(account, file);
      return true;
    });
    if (changed) deps.onChanged();
  }

  // Sends waiting posts one at a time. A post the relay refuses, such as one
  // through a share that ended, moves to this computer's list; an invalid one
  // is dropped. Anything else leaves the rest waiting for the next pass.
  async function sendPosts(session: NoticeSession): Promise<"done" | "routes-missing"> {
    const account = session.account;
    for (;;) {
      const post = await locked(async () => {
        const file = await loadAccount(account);
        // A post taken back before it ever left never needs to go. One that
        // went out may already be on the relay: it goes again, which the
        // relay takes once, so its dismissal can follow.
        const withdrawn = file.posts.filter((waiting) => !waiting.sent && waiting.withdrawn && !waiting.attempted);
        if (withdrawn.length > 0) {
          const ids = new Set(withdrawn.map((waiting) => waiting.request.noticeId));
          file.posts = file.posts.filter((waiting) => !withdrawn.includes(waiting));
          file.marks = file.marks.filter((waiting) => !ids.has(waiting.noticeId));
        }
        const next = file.posts.find((waiting) => !waiting.sent);
        // Recorded before it leaves, so a lost answer leaves it uncertain.
        if (next && !next.attempted) next.attempted = true;
        if (withdrawn.length > 0 || next) await saveAccount(account, file);
        return next;
      });
      if (!post) return "done";
      let outcome: "sent" | "refused" | "invalid" = "sent";
      try {
        await relay(session, "/sync/notices", post.request);
      } catch (error) {
        if (error instanceof SessionChanged) throw error;
        if (!(error instanceof RelayRefusal) || error.reason === "rate-limited") {
          console.warn("[notices] a notice could not be sent; the next pass tries again", error);
          return "done";
        }
        if (error.reason === "routes-missing") return "routes-missing";
        if (error.reason === "invalid") {
          console.error("[notices] the server refused a notice as invalid; it was dropped");
          outcome = "invalid";
        } else {
          outcome = "refused";
        }
      }
      // The outbox as it is now: the person may have read or dismissed the
      // notice while the post was on its way, and a dismissal takes the
      // post out of the outbox.
      const moved = await locked(async () => {
        const file = await loadAccount(account);
        const noticeId = post.request.noticeId;
        const current = file.posts.find((waiting) => waiting.request.noticeId === noticeId);
        if (outcome === "sent") {
          // The relay holds the row now, so a waiting mark goes with the
          // next batch.
          if (current) current.sent = true;
          await saveAccount(account, file);
          return false;
        }
        file.posts = file.posts.filter((waiting) => waiting !== current);
        const mark = file.marks.find((waiting) => waiting.noticeId === noticeId);
        file.marks = file.marks.filter((waiting) => waiting !== mark);
        // A skipped schedule's notice the relay refuses was one it already
        // settled: kept here, its Run now would skip the relay's check.
        if (outcome === "refused" && post.request.kind !== "schedule-skipped") {
          const local = await loadLocal();
          const { request } = post;
          addLocal(local, {
            noticeId, kind: request.kind, workspaceId: post.workspaceId,
            title: request.title, body: request.body, target: request.target,
          }, post.createdAtMs);
          const row = local.rows.find((candidate) => candidate.noticeId === noticeId);
          if (row && mark?.mark === "read") row.readAtMs ??= mark.atMs;
          if (row && mark?.mark === "dismissed") row.dismissedAtMs ??= mark.atMs;
          await saveLocal(local);
        }
        await saveAccount(account, file);
        return outcome === "refused" && post.request.kind !== "schedule-skipped";
      });
      if (moved) deps.onChanged();
    }
  }

  // A mark for one of your posts waits until the relay has accepted the
  // post, or the relay would answer for a row it does not hold yet.
  async function sendMarks(session: NoticeSession): Promise<"done" | "routes-missing"> {
    const account = session.account;
    for (;;) {
      const batch = await locked(async () => {
        const file = await loadAccount(account);
        const unsent = new Set(file.posts.filter((post) => !post.sent).map((post) => post.request.noticeId));
        return file.marks.filter((waiting) => !unsent.has(waiting.noticeId)).slice(0, NOTICE_MARKS_PER_REQUEST);
      });
      if (batch.length === 0) return "done";
      try {
        await relay(session, "/sync/notices/marks", {
          marks: batch.map(({ noticeId, mark }) => ({ noticeId, mark })),
        });
      } catch (error) {
        if (error instanceof SessionChanged) throw error;
        if (error instanceof RelayRefusal && error.reason === "routes-missing") return "routes-missing";
        if (!(error instanceof RelayRefusal) || error.reason === "rate-limited") {
          console.warn("[notices] marks could not be sent; the next pass tries again", error);
          return "done";
        }
        console.error("[notices] the server refused marks; they were dropped", error.reason);
      }
      await locked(async () => {
        const file = await loadAccount(account);
        // A mark replaced while the batch was on its way stays for the next one.
        file.marks = file.marks.filter((waiting) => !batch.includes(waiting));
        // Keep the marks on the rows until the next pull brings them back.
        for (const { noticeId, mark, atMs } of batch) {
          const row = file.rows.find((candidate) => candidate.noticeId === noticeId);
          if (!row) continue;
          if (mark === "read") row.readAtMs ??= atMs;
          else row.dismissedAtMs ??= atMs;
        }
        await saveAccount(account, file);
      });
    }
  }

  async function syncAccount(session: NoticeSession): Promise<void> {
    const account = session.account;
    if (await sendPosts(session) === "routes-missing") return await noteRoutesMissing(account);
    if (await sendMarks(session) === "routes-missing") return await noteRoutesMissing(account);

    let changed = false;
    for (let more = true; more;) {
      const cursor = await locked(async () => (await loadAccount(account)).cursor);
      const query = new URLSearchParams({ limit: String(NOTICE_PAGE_MAX), ...(cursor === null ? {} : { cursor }) });
      let page: z.infer<typeof RelayPage>;
      try {
        page = RelayPage.parse(await (await relay(session, `/sync/notices?${query}`)).json());
      } catch (error) {
        if (error instanceof RelayRefusal && error.reason === "routes-missing") {
          return await noteRoutesMissing(account);
        }
        throw error;
      }
      changed = await locked(async () => {
        const file = await loadAccount(account);
        const merged = merge(file, page);
        if (!merged && file.cursor === page.nextCursor && !file.routesMissing) return false;
        file.cursor = page.nextCursor;
        file.routesMissing = false;
        await saveAccount(account, file);
        return merged;
      }) || changed;
      more = page.hasMore;
    }
    // Every sent post went out before this pull began, so the pull has
    // settled it: its row arrived, or the relay already had that notice.
    changed = await locked(async () => {
      const file = await loadAccount(account);
      const waiting = file.posts.filter((post) => !post.sent);
      const settled = waiting.length !== file.posts.length;
      file.posts = waiting;
      const pruned = pruneAccount(file);
      if (settled || pruned) await saveAccount(account, file);
      return pruned;
    }) || changed;
    if (changed) deps.onChanged();
  }

  let running: Promise<void> | null = null;
  let again = false;
  function sync(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          try {
            const session = await deps.session();
            if (session) await syncAccount(session);
            const pruned = await locked(async () => {
              const local = await loadLocal();
              if (!pruneLocal(local)) return false;
              await saveLocal(local);
              return true;
            });
            if (pruned) deps.onChanged();
          } catch (error) {
            // A pass for a session that ended stops; the next pass uses the new one.
            if (error instanceof SessionChanged) again = true;
            else console.warn("[notices] sync failed; the next pass tries again", error);
          }
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  async function refreshRefusals(openedWorkspaceId?: string): Promise<void> {
    if (!deps.refusalNotices) return;
    const readRefusals = deps.refusalNotices;
    const changed = await locked(async () => {
      const workspaces = await readRefusals(openedWorkspaceId);
      const prior = await loadLocal();
      const previousRows = new Map(prior.rows.map(row => [row.noticeId, row]));
      const failedWorkspaces = new Set(workspaces.filter(row => row.notices === null).map(row => row.workspaceId));
      const rows = prior.rows.filter(row => row.kind !== "sync-refusal" || (row.workspaceId !== null && failedWorkspaces.has(row.workspaceId)));
      for (const { workspaceId, notices } of workspaces) {
        if (notices === null) continue;
        for (const refusal of notices) {
          const previous = previousRows.get(refusal.noticeId);
          const currentKeys = new Set(refusal.refusalCoordinates.map(coordinateKey));
          const pendingRefusalDismissals = (previous?.pendingRefusalDismissals ?? [])
            .filter(row => currentKeys.has(coordinateKey(row)));
          if (pendingRefusalDismissals.length > 0) {
            try {
              await deps.dismissRefusal?.(workspaceId, refusal.noticeId, pendingRefusalDismissals);
            } catch (error) {
              console.warn("[notices] could not apply queued sync refusal dismissal", workspaceId, error);
            }
          }
          const refusalCoordinates = withoutCoordinates(refusal.refusalCoordinates, pendingRefusalDismissals);
          if (refusalCoordinates.length === 0 && previous) {
            // Keep only the shown refusals hidden until an engine read confirms their deletion.
            rows.push({ ...previous, refusalCoordinates, pendingRefusalDismissals,
              dismissedAtMs: previous.dismissedAtMs ?? nowMs() });
            continue;
          }
          const document = refusal.document;
          const name = document?.path ? `“${[...document.path].slice(0, 180).join("")}”` : "a file";
          const tooLarge = /too large|exceeds|projection.*limit/iu.test(refusal.reason);
          const body = `dohc could not update ${name}.${tooLarge ? " The change is too large." : ""} ${document?.conflictId
            ? "Open its conflict and choose a copy."
            : tooLarge ? "Make the file smaller on the other computer, then try sync again." : "Review the file on the other computer, then try sync again."}`;
          rows.push(LocalRow.parse({ noticeId: refusal.noticeId, workspaceId, kind: "sync-refusal",
            refusalCoordinates, pendingRefusalDismissals,
            title: "A change needs your review", body,
            detail: [refusal.reason, `Workspace: ${workspaceId}`, `Object: ${document?.objectId ?? "unknown"}`,
              `Lineage: ${document?.lineageClaimId ?? "unknown"}`, `Origin: ${refusal.originId}:${refusal.originSeq}`].join("\n"),
            target: NoticeTargetShape.safeParse(document?.path ? { path: document.path } : {}).data ?? {},
            createdAtMs: previous?.dismissedAtMs == null ? previous?.createdAtMs ?? nowMs() : nowMs(),
            readAtMs: withoutCoordinates(refusalCoordinates, previous?.refusalCoordinates ?? []).length === 0
              ? previous?.readAtMs ?? null : null, dismissedAtMs: null }));
        }
      }
      if (JSON.stringify(rows) === JSON.stringify(prior.rows)) return false;
      await saveLocal({ ...prior, rows });
      return true;
    });
    if (changed) deps.onChanged();
  }

  async function postNotice(input: PostNoticeInput): Promise<void> {
    const content = NoticeContent.parse({
      noticeId: input.noticeId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      target: input.target ?? {},
    });
    // A session that changes while the notice is placed is read again.
    for (let attempt = 1; ; attempt += 1) {
      try {
        const to: NoticeRecipient | null = input.toWorkspaceOwner
          ? { toWorkspaceOwner: true }
          : input.recipientUserId === undefined ? null : { recipientUserId: input.recipientUserId };
        return await postOnce(to, content, input.signal);
      } catch (error) {
        if (!(error instanceof SessionChanged)) throw error;
        if (attempt === 3) throw new NoticeNotSentError("Your server session changed. Try again.");
      }
    }
  }

  // `to` is null for yourself.
  async function postOnce(to: NoticeRecipient | null, content: NoticeContent, signal?: AbortSignal): Promise<void> {
    const session = await deps.session();
    const reach = session?.reachFor(content.workspaceId) ?? null;
    const fields = {
      noticeId: content.noticeId,
      kind: content.kind,
      title: content.title,
      body: content.body,
      target: content.target,
      originInstallId: deps.installId(),
    };
    // The owner's own computer names the workspace, so its owner is you.
    const toSomeoneElse = to?.toWorkspaceOwner ? reach?.shareId !== undefined : to !== null && to.recipientUserId !== session?.account.userId;
    if (to !== null && toSomeoneElse) {
      if (!session || !reach) {
        throw new NoticeNotSentError(
          "Notices reach other people through a server. Sync this workspace with an up-to-date server first.",
        );
      }
      return await postToAnotherPerson(session, { ...reach, ...to, ...fields }, signal);
    }
    const createdAtMs = nowMs();
    const queued = await locked(async () => {
      const local = await loadLocal();
      const file = session && reach ? await loadAccount(session.account) : null;
      // Checked after the loads, just before either list changes.
      if (session && !session.isCurrent()) throw new SessionChanged();
      signal?.throwIfAborted();
      // A notice kept on this computer stays here.
      if (local.rows.some((row) => row.noticeId === content.noticeId)) return false;
      if (session && reach && file && !file.routesMissing) {
        const known = file.rows.some((row) => row.noticeId === content.noticeId) ||
          file.posts.some((post) => post.request.noticeId === content.noticeId);
        if (known) return false;
        // Copies, so a failed save leaves no post behind that a retry would
        // take for a saved one.
        const next: AccountFile = { ...file, posts: [...file.posts], marks: [...file.marks] };
        dropOldestUnsent(next);
        next.posts.push({
          request: { ...reach, ...fields, recipientUserId: session.account.userId }, workspaceId: content.workspaceId, createdAtMs, sent: false,
        });
        await saveAccount(session.account, next);
        return true;
      }
      const next: LocalFile = { ...local, rows: [...local.rows] };
      addLocal(next, content, createdAtMs);
      await saveLocal(next);
      return true;
    });
    if (!queued) return;
    deps.onChanged();
    if (session && reach) void sync();
  }

  // Makes room for one more unsent post. The oldest unsent posts go, with
  // any marks waiting on them. A skipped schedule's notice never goes: its
  // schedule's mark already moved past what it reports.
  function dropOldestUnsent(file: AccountFile): void {
    const unsent = file.posts.filter((post) => !post.sent && post.request.kind !== "schedule-skipped");
    if (unsent.length < outboxPostLimit) return;
    const dropped = new Set(unsent.slice(0, unsent.length - outboxPostLimit + 1));
    const droppedIds = new Set([...dropped].map((post) => post.request.noticeId));
    file.posts = file.posts.filter((post) => !dropped.has(post));
    file.marks = file.marks.filter((waiting) => !droppedIds.has(waiting.noticeId));
  }

  // Sent at once rather than queued, so the caller learns whether the
  // relay accepted it.
  async function postToAnotherPerson(session: NoticeSession, request: PostNoticeRequest, signal?: AbortSignal): Promise<void> {
    if (await locked(async () => (await loadAccount(session.account)).routesMissing)) {
      throw new NoticeNotSentError("Your server doesn't sync notices. Update the server, then try again.");
    }
    signal?.throwIfAborted();
    try {
      await relay(session, "/sync/notices", request);
    } catch (error) {
      if (!(error instanceof RelayRefusal)) throw error;
      switch (error.reason) {
        case "routes-missing":
          await noteRoutesMissing(session.account);
          throw new NoticeNotSentError("Your server doesn't sync notices. Update the server, then try again.");
        case "refused":
          throw new NoticeNotSentError("This person can't open what the notice points to.");
        case "rate-limited":
          throw new NoticeNotSentError("Too many notices went to other people. Wait a minute, then try again.");
        case "list-full":
          throw new NoticeNotSentError("This person has too many unread notices to get this one.");
        case "invalid":
          throw error;
      }
    }
  }

  async function list(): Promise<{ account: string | null; notices: NoticeRow[] }> {
    await refreshRefusals().catch(error => {
      console.warn("[notices] could not refresh sync refusals", error);
    });
    const account = (await deps.session())?.account ?? null;
    return await locked(async () => {
      const local = await loadLocal();
      if (pruneLocal(local)) await saveLocal(local);
      const rows = local.rows.filter((row) => row.dismissedAtMs === null).map((row): NoticeRow => ({
        store: "local",
        noticeId: row.noticeId,
        kind: row.kind,
        workspaceId: row.workspaceId,
        recipientShareId: null,
        senderKind: Object.hasOwn(NOTICE_KINDS, row.kind)
          ? NOTICE_KINDS[row.kind as NoticeKind].senderKind
          : null,
        senderLabel: null,
        title: row.title,
        body: row.body,
        ...(row.detail === undefined ? {} : { detail: row.detail }),
        ...(row.refusalCoordinates === undefined ? {} : { refusalCoordinates: row.refusalCoordinates }),
        target: row.target,
        createdAtMs: row.createdAtMs,
        readAtMs: row.readAtMs,
        postedHere: true,
      }));
      if (account) {
        const file = await loadAccount(account);
        if (pruneAccount(file)) await saveAccount(account, file);
        const marks = new Map(file.marks.map((waiting) => [waiting.noticeId, waiting]));
        const shown = (noticeId: string) => marks.get(noticeId)?.mark !== "dismissed";
        const readAt = (noticeId: string, readAtMs: number | null) => readAtMs ?? marks.get(noticeId)?.atMs ?? null;
        const pulled = new Set<string>();
        for (const row of file.rows) {
          pulled.add(row.noticeId);
          if (row.dismissedAtMs !== null || !shown(row.noticeId)) continue;
          rows.push({
            store: "account", noticeId: row.noticeId, kind: row.kind, workspaceId: row.workspaceId,
            recipientShareId: row.recipientShareId, senderKind: row.senderKind, senderLabel: row.senderLabel,
            title: row.title, body: row.body, target: row.target, createdAtMs: row.createdAtMs,
            readAtMs: readAt(row.noticeId, row.readAtMs),
            postedHere: row.senderUserId === account.userId && row.originInstallId === deps.installId(),
          });
        }
        for (const { request, createdAtMs } of file.posts) {
          if (pulled.has(request.noticeId) || !shown(request.noticeId)) continue;
          rows.push({
            store: "account", noticeId: request.noticeId, kind: request.kind,
            workspaceId: request.workspaceId ?? null, recipientShareId: request.shareId ?? null,
            senderKind: NOTICE_KINDS[request.kind].senderKind, senderLabel: null,
            title: request.title, body: request.body, target: request.target, createdAtMs,
            readAtMs: readAt(request.noticeId, null),
            postedHere: request.originInstallId === deps.installId(),
          });
        }
      }
      return {
        account: account?.key ?? null,
        notices: rows.sort((left, right) => right.createdAtMs - left.createdAtMs),
      };
    });
  }

  // Marks every named notice in one write per list, so marking a whole list
  // read costs one save and one pass.
  async function mark(refs: readonly NoticeRef[], mark: NoticeMark, account: string | null): Promise<void> {
    const session = refs.some((ref) => ref.store === "account") ? await deps.session() : null;
    const changed = await locked(async () => {
      const localRefs = new Map(refs.filter((ref) => ref.store === "local").map(ref => [ref.noticeId, ref]));
      let localChanged = false;
      if (localRefs.size > 0) {
        const file = await loadLocal();
        for (const row of file.rows) {
          const ref = localRefs.get(row.noticeId);
          if (!ref) continue;
          if (row.dismissedAtMs !== null || (mark === "read" && row.readAtMs !== null)) continue;
          if (mark === "dismissed" && row.kind === "sync-refusal" && row.workspaceId) {
            const shown = ref.refusalCoordinates;
            if (!shown?.length || !deps.dismissRefusal) throw new Error("The engine could not dismiss this Notice. Try again.");
            await deps.dismissRefusal(row.workspaceId, row.noticeId, shown);
            row.pendingRefusalDismissals = [...(row.pendingRefusalDismissals ?? []),
              ...withoutCoordinates(shown, row.pendingRefusalDismissals ?? [])];
            row.refusalCoordinates = withoutCoordinates(row.refusalCoordinates ?? [], shown);
            if (row.refusalCoordinates.length === 0) row.dismissedAtMs = nowMs();
            localChanged = true;
            continue;
          }
          if (mark === "read") row.readAtMs = nowMs();
          else row.dismissedAtMs = nowMs();
          localChanged = true;
        }
        if (localChanged) await saveLocal(file);
      }
      // A mark from a list shown for an account that is no longer signed in
      // changes nothing, even where the new account has a notice with the
      // same id.
      let accountChanged = false;
      if (session?.isCurrent() && session.account.key === account) {
        const file = await loadAccount(session.account);
        const rows = new Map(file.rows.map((row) => [row.noticeId, row]));
        const posts = new Map(file.posts.map((post) => [post.request.noticeId, post]));
        const dropped = new Set<(typeof file.posts)[number]>();
        for (const ref of refs) {
          if (ref.store !== "account") continue;
          const row = rows.get(ref.noticeId);
          const post = posts.get(ref.noticeId);
          if ((!row && !post) || row?.dismissedAtMs != null || (mark === "read" && row?.readAtMs != null)) continue;
          if (!queueMark(file, ref.noticeId, mark)) continue;
          accountChanged = true;
          // A dismissed post that has not left never needs to. The mark
          // still goes, in case the post is already on its way.
          if (mark === "dismissed" && post && !post.sent) dropped.add(post);
        }
        if (dropped.size > 0) file.posts = file.posts.filter((waiting) => !dropped.has(waiting));
        if (accountChanged) await saveAccount(session.account, file);
      }
      return { local: localChanged, account: accountChanged };
    });
    if (!changed.local && !changed.account) return;
    deps.onChanged();
    if (changed.account) void sync();
  }

  async function dismissFirst(
    ref: NoticeRef,
    account: string | null,
  ): Promise<"first" | "not-first" | "unanswered"> {
    if (ref.store === "local") {
      // Only this computer holds the notice, so every dismissal of it is
      // this computer's: asking again after a crash answers "first" again.
      const found = await locked(async () => {
        const file = await loadLocal();
        const row = file.rows.find((candidate) => candidate.noticeId === ref.noticeId);
        if (!row) return "missing";
        if (row.dismissedAtMs !== null) return "kept";
        row.dismissedAtMs = nowMs();
        await saveLocal(file);
        return "dismissed";
      });
      if (found === "dismissed") deps.onChanged();
      return found === "missing" ? "not-first" : "first";
    }
    const session = await deps.session();
    if (!session?.isCurrent() || session.account.key !== account) return "unanswered";
    // The notice's own post goes first, or the relay would not hold it yet.
    await sync();
    let dismissed: unknown;
    try {
      const response = await relay(session, "/sync/notices/marks", {
        marks: [{ noticeId: ref.noticeId, mark: "dismissed" }],
        // The relay names the first to dismiss, and tells this computer
        // "first" again when it asks again.
        installId: deps.installId(),
      });
      dismissed = ((await response.json().catch(() => null)) as { dismissed?: unknown } | null)?.dismissed;
    } catch (error) {
      console.warn("[notices] a dismissal for Run now could not be sent", error);
      return "unanswered";
    }
    // An older relay does not say which dismissal was first.
    if (!Array.isArray(dismissed)) return "unanswered";
    await locked(async () => {
      const file = await loadAccount(session.account);
      const row = file.rows.find((candidate) => candidate.noticeId === ref.noticeId);
      if (row) row.dismissedAtMs ??= nowMs();
      file.marks = file.marks.filter((waiting) => waiting.noticeId !== ref.noticeId);
      await saveAccount(session.account, file);
    });
    deps.onChanged();
    return dismissed.includes(ref.noticeId) ? "first" : "not-first";
  }

  // Takes back a notice this computer posted, as a skipped schedule's notice
  // whose skip did not happen after all: an unsent post goes, and a sent
  // one is dismissed.
  async function withdraw(noticeId: string): Promise<void> {
    const session = await deps.session();
    const changed = await locked(async () => {
      let touched = false;
      const local = await loadLocal();
      const row = local.rows.find((candidate) => candidate.noticeId === noticeId);
      if (row && row.dismissedAtMs === null) {
        row.dismissedAtMs = nowMs();
        await saveLocal(local);
        touched = true;
      }
      if (session?.isCurrent()) {
        const file = await loadAccount(session.account);
        const post = file.posts.find((waiting) => waiting.request.noticeId === noticeId);
        // An unsent post may already be on its way: it stays, marked, and
        // its dismissal waits for the relay to accept it.
        if (post && !post.sent && !post.withdrawn) {
          post.withdrawn = true;
          touched = true;
        }
        if ((post || file.rows.some((candidate) => candidate.noticeId === noticeId)) && queueMark(file, noticeId, "dismissed")) {
          touched = true;
        }
        if (touched) await saveAccount(session.account, file);
      }
      return touched;
    });
    if (!changed) return;
    deps.onChanged();
    void sync();
  }

  async function sentFailure(run: { workspaceId: string; automationId: string; claimId: string }): Promise<SentFailure | null> {
    const session = await deps.session();
    if (!session) return null;
    const names = (kind: string, workspaceId: string | null | undefined, target: NoticeTarget | null) =>
      kind === "automation-failed" && workspaceId === run.workspaceId &&
      target?.automation === run.automationId && target.run === run.claimId;
    return await locked(async () => {
      const file = await loadAccount(session.account);
      // An account that signed out meanwhile names no computer for this one.
      if (!session.isCurrent()) return null;
      const row = file.rows.find((candidate) =>
        candidate.senderUserId === session.account.userId && names(candidate.kind, candidate.workspaceId, candidate.target));
      if (row) return { title: row.title, body: row.body, originInstallId: row.originInstallId };
      // Your own post, not pulled back yet.
      const post = file.posts.find(({ request }) => names(request.kind, request.workspaceId, request.target));
      return post ? { title: post.request.title, body: post.request.body, originInstallId: post.request.originInstallId } : null;
    });
  }

  return { postNotice, list, mark, sync, dismissFirst, withdraw, refreshRefusals, sentFailure };
}

// Folds one page into the stored rows. A page that starts the list over
// replaces every cached row first; the outbox stays. Read and dismissed only
// move forward, so a row marked here stays marked whatever order changes
// arrive in. A row the relay removed to make room is dropped. A pulled row
// settles the sent post with its id.
function merge(file: AccountFile, page: z.infer<typeof RelayPage>): boolean {
  let changed = false;
  if (page.replace && file.rows.length > 0) {
    file.rows = [];
    changed = true;
  }
  for (const notice of page.notices) {
    const parsed = RelayRow.safeParse(notice);
    if (!parsed.success) {
      console.warn("[notices] skipped a notice the relay sent in an unknown shape");
      continue;
    }
    const row = parsed.data;
    file.posts = file.posts.filter((post) => !(post.sent && post.request.noticeId === row.noticeId));
    const index = file.rows.findIndex((existing) => existing.noticeId === row.noticeId);
    const existing = file.rows[index];
    if (row.removed) {
      if (existing) file.rows.splice(index, 1);
      changed = true;
      continue;
    }
    const next = existing
      ? { ...row, readAtMs: row.readAtMs ?? existing.readAtMs, dismissedAtMs: row.dismissedAtMs ?? existing.dismissedAtMs }
      : row;
    if (existing) file.rows[index] = next;
    else file.rows.push(next);
    changed = true;
  }
  return changed;
}

// The relay's retention and row limit, applied to this computer's copy:
// dismissed rows go 30 days after dismissal, read rows 90 days after
// reading, unread rows 180 days after arriving. Past the limit, read and
// dismissed rows go first, oldest first, then the oldest unread. Returns
// `rows` itself when nothing goes.
function retained<Row extends { createdAtMs: number; readAtMs: number | null; dismissedAtMs: number | null }>(
  rows: Row[],
  limit: number,
  nowMs: number,
): Row[] {
  const live = rows.filter((row) =>
    row.dismissedAtMs !== null ? row.dismissedAtMs + NOTICE_DISMISSED_RETENTION_MS > nowMs
    : row.readAtMs !== null ? row.readAtMs + NOTICE_READ_RETENTION_MS > nowMs
    : row.createdAtMs + NOTICE_UNREAD_RETENTION_MS > nowMs);
  if (live.length === rows.length && rows.length <= limit) return rows;
  if (live.length <= limit) return live;
  const removed = new Set([...live]
    .sort((left, right) =>
      Number(left.readAtMs === null) - Number(right.readAtMs === null) ||
      left.createdAtMs - right.createdAtMs)
    .slice(0, live.length - limit));
  return live.filter((row) => !removed.has(row));
}
