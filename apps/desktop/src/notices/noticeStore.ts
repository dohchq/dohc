import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
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
  type NoticeTarget,
  type PostNoticeRequest,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { NoticeRow, NoticeTargetShape, type NoticeRef } from "../ipc/bridgeContract";
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
  kind: NoticeKind;
  title: string;
  body: string;
  target?: NoticeTarget;
  // Another person's relay user id. Absent, or your own id, sends the
  // notice to yourself.
  recipientUserId?: string;
}

// A notice for another person that did not reach them. The message says why.
export class NoticeNotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoticeNotSentError";
  }
}

export interface NoticeStore {
  // Throws when the notice breaks the relay's rules, before keeping it.
  postNotice(input: PostNoticeInput): Promise<void>;
  list(): Promise<NoticeRow[]>;
  mark(ref: NoticeRef, mark: NoticeMark): Promise<void>;
  // Sends waiting posts and marks, then pulls changes. Never rejects.
  sync(): Promise<void>;
}

const kindValues = Object.keys(NOTICE_KINDS) as [NoticeKind, ...NoticeKind[]];
// The relay's rules, checked before a notice is kept anywhere.
const NoticeContent = z.object({
  noticeId: z.string().refine((value) =>
    isNoticeLine(value, NOTICE_POSTED_ID_MAX_CHARS) && !value.startsWith(NOTICE_FROM_PREFIX)),
  workspaceId: z.string().refine((value) => isNoticeLine(value, 256)),
  kind: z.enum(kindValues),
  title: z.string().refine((value) => isNoticeLine(value, NOTICE_TITLE_MAX_CHARS)),
  body: z.string().refine(isNoticeBody),
  target: z.custom<NoticeTarget>(isNoticeTarget),
});
type NoticeContent = z.infer<typeof NoticeContent>;

const Reach = z.union([
  z.object({ workspaceId: z.string().min(1), shareId: z.undefined().optional() }),
  z.object({ shareId: z.string().min(1), workspaceId: z.undefined().optional() }),
]);
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
  noticeId: NoticeRow.shape.noticeId,
  kind: NoticeRow.shape.kind,
  workspaceId: NoticeRow.shape.workspaceId,
  title: NoticeRow.shape.title,
  body: NoticeRow.shape.body,
  target: NoticeTargetShape,
  createdAtMs: NoticeRow.shape.createdAtMs,
  readAtMs: NoticeRow.shape.readAtMs,
  // Kept as a tombstone until its retention ends, so the same notice is
  // not posted again.
  dismissedAtMs: z.number().int().nonnegative().nullable(),
});
type LocalRow = z.infer<typeof LocalRow>;

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
});
type RelayRow = z.infer<typeof RelayRow>;

const LocalFile = z.object({ version: z.literal(1), rows: z.array(LocalRow) });
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
    createdAtMs: NoticeRow.shape.createdAtMs,
    // The relay accepted it; the next finished pull settles it.
    sent: z.boolean(),
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

  const saveLocal = (file: LocalFile) => save("local.json", file);

  function pruneLocal(file: LocalFile): boolean {
    const kept = retained(file.rows, LOCAL_NOTICE_ROW_LIMIT, nowMs());
    if (kept === file.rows) return false;
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

  const saveAccount = (account: NoticeAccount, file: AccountFile) => save(accountFileName(account), file);

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
      for (const { request, createdAtMs } of file.posts) {
        addLocal(local, {
          noticeId: request.noticeId, kind: request.kind, workspaceId: request.workspaceId ?? null,
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

  // Sends waiting posts one at a time. A refused post is dropped; anything
  // else leaves the rest waiting for the next pass.
  async function sendPosts(session: NoticeSession): Promise<"done" | "routes-missing"> {
    const account = session.account;
    for (;;) {
      const post = await locked(async () => (await loadAccount(account)).posts.find((waiting) => !waiting.sent));
      if (!post) return "done";
      let accepted = true;
      try {
        await relay(session, "/sync/notices", post.request);
      } catch (error) {
        if (error instanceof SessionChanged) throw error;
        if (!(error instanceof RelayRefusal) || error.reason === "rate-limited") {
          console.warn("[notices] a notice could not be sent; the next pass tries again", error);
          return "done";
        }
        if (error.reason === "routes-missing") return "routes-missing";
        console.error("[notices] the server refused a notice; it was dropped", error.reason);
        accepted = false;
      }
      await locked(async () => {
        const file = await loadAccount(account);
        if (accepted) post.sent = true;
        else file.posts = file.posts.filter((waiting) => waiting !== post);
        await saveAccount(account, file);
      });
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
        return await postOnce(input.recipientUserId, content);
      } catch (error) {
        if (!(error instanceof SessionChanged)) throw error;
        if (attempt === 3) throw new NoticeNotSentError("Your server session changed. Try again.");
      }
    }
  }

  async function postOnce(recipientUserId: string | undefined, content: NoticeContent): Promise<void> {
    const session = await deps.session();
    const reach = session?.reachFor(content.workspaceId) ?? null;
    const request = (recipient: string, to: NoticeReach): PostNoticeRequest => ({
      ...to,
      noticeId: content.noticeId,
      recipientUserId: recipient,
      kind: content.kind,
      title: content.title,
      body: content.body,
      target: content.target,
      originInstallId: deps.installId(),
    });
    if (recipientUserId !== undefined && recipientUserId !== session?.account.userId) {
      if (!session || !reach) {
        throw new NoticeNotSentError(
          "Notices reach other people through a server. Sync this workspace with an up-to-date server first.",
        );
      }
      return await postToAnotherPerson(session, request(recipientUserId, reach));
    }
    const createdAtMs = nowMs();
    const queued = await locked(async () => {
      if (session && !session.isCurrent()) throw new SessionChanged();
      const local = await loadLocal();
      // A notice kept on this computer stays here.
      if (local.rows.some((row) => row.noticeId === content.noticeId)) return false;
      const file = session && reach ? await loadAccount(session.account) : null;
      if (session && reach && file && !file.routesMissing) {
        const known = file.rows.some((row) => row.noticeId === content.noticeId) ||
          file.posts.some((post) => post.request.noticeId === content.noticeId);
        if (known) return false;
        dropOldestUnsent(file);
        file.posts.push({ request: request(session.account.userId, reach), createdAtMs, sent: false });
        await saveAccount(session.account, file);
        return true;
      }
      addLocal(local, content, createdAtMs);
      await saveLocal(local);
      return true;
    });
    if (!queued) return;
    deps.onChanged();
    if (session && reach) void sync();
  }

  // Makes room for one more unsent post. The oldest unsent posts go, with
  // any marks waiting on them.
  function dropOldestUnsent(file: AccountFile): void {
    const unsent = file.posts.filter((post) => !post.sent);
    if (unsent.length < outboxPostLimit) return;
    const dropped = new Set(unsent.slice(0, unsent.length - outboxPostLimit + 1));
    const droppedIds = new Set([...dropped].map((post) => post.request.noticeId));
    file.posts = file.posts.filter((post) => !dropped.has(post));
    file.marks = file.marks.filter((waiting) => !droppedIds.has(waiting.noticeId));
  }

  // Sent at once rather than queued, so the caller learns whether the
  // relay accepted it.
  async function postToAnotherPerson(session: NoticeSession, request: PostNoticeRequest): Promise<void> {
    if (await locked(async () => (await loadAccount(session.account)).routesMissing)) {
      throw new NoticeNotSentError("Your server doesn't sync notices. Update the server, then try again.");
    }
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

  async function list(): Promise<NoticeRow[]> {
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
        target: row.target,
        createdAtMs: row.createdAtMs,
        readAtMs: row.readAtMs,
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
          });
        }
      }
      return rows.sort((left, right) => right.createdAtMs - left.createdAtMs);
    });
  }

  async function mark(ref: NoticeRef, mark: NoticeMark): Promise<void> {
    const session = ref.store === "account" ? await deps.session() : null;
    if (ref.store === "account" && !session) return;
    const changed = await locked(async () => {
      if (!session) {
        const file = await loadLocal();
        const row = file.rows.find((candidate) => candidate.noticeId === ref.noticeId);
        if (!row || row.dismissedAtMs !== null || (mark === "read" && row.readAtMs !== null)) return false;
        if (mark === "read") row.readAtMs = nowMs();
        else row.dismissedAtMs = nowMs();
        await saveLocal(file);
        return true;
      }
      // A mark from a list shown for an account that is no longer signed in.
      if (!session.isCurrent()) return false;
      const file = await loadAccount(session.account);
      const row = file.rows.find((candidate) => candidate.noticeId === ref.noticeId);
      const post = file.posts.find((waiting) => waiting.request.noticeId === ref.noticeId);
      if ((!row && !post) || row?.dismissedAtMs != null || (mark === "read" && row?.readAtMs != null)) return false;
      if (!queueMark(file, ref.noticeId, mark)) return false;
      // A dismissed post that has not left never needs to. The mark still
      // goes, in case the post is already on its way.
      if (mark === "dismissed" && post && !post.sent) {
        file.posts = file.posts.filter((waiting) => waiting !== post);
      }
      await saveAccount(session.account, file);
      return true;
    });
    if (!changed) return;
    deps.onChanged();
    if (session) void sync();
  }

  return { postNotice, list, mark, sync };
}

// Folds one page into the stored rows. A page that starts the list over
// replaces every cached row first; the outbox stays. Read and dismissed only
// move forward, so a row marked here stays marked whatever order changes
// arrive in. A pulled row settles the sent post with its id.
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
