import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  NOTICE_BODY_MAX_CHARS,
  NOTICE_KINDS,
  NOTICE_LIST_ROW_LIMIT,
  NOTICE_MARKS_PER_REQUEST,
  NOTICE_PAGE_MAX,
  NOTICE_READ_RETENTION_MS,
  NOTICE_TARGET_MAX_BYTES,
  NOTICE_TITLE_MAX_CHARS,
  NOTICE_UNREAD_RETENTION_MS,
  type NoticeKind,
  type NoticeMark,
  type NoticeTarget,
  type PostNoticeRequest,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { NoticeRow, type NoticeRef } from "../ipc/bridgeContract";
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

export interface PostNoticeInput {
  workspaceId: string;
  noticeId: string;
  kind: NoticeKind;
  title: string;
  body: string;
  target?: NoticeTarget;
  // Another person's relay user id. Absent sends the notice to yourself.
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
  postNotice(input: PostNoticeInput): Promise<void>;
  list(): Promise<NoticeRow[]>;
  mark(ref: NoticeRef, mark: NoticeMark): Promise<void>;
  // Sends waiting posts and marks, then pulls changes. Never rejects.
  sync(): Promise<void>;
}

const Target = NoticeRow.shape.target;
const LocalRow = z.object({
  noticeId: NoticeRow.shape.noticeId,
  kind: NoticeRow.shape.kind,
  workspaceId: NoticeRow.shape.workspaceId,
  title: NoticeRow.shape.title,
  body: NoticeRow.shape.body,
  target: Target,
  createdAtMs: NoticeRow.shape.createdAtMs,
  readAtMs: NoticeRow.shape.readAtMs,
});
type LocalRow = z.infer<typeof LocalRow>;

const RelayRow = z.object({
  noticeId: NoticeRow.shape.noticeId,
  changeSeq: z.number().int().positive(),
  workspaceId: z.string().min(1).max(1_024),
  recipientShareId: NoticeRow.shape.recipientShareId,
  kind: NoticeRow.shape.kind,
  senderKind: z.enum(["person", "agent", "automation"]),
  senderUserId: z.string().min(1).max(1_024),
  senderLabel: z.string().min(1).max(40),
  title: NoticeRow.shape.title,
  body: NoticeRow.shape.body,
  target: Target,
  originInstallId: z.string().min(1).max(256),
  createdAtMs: NoticeRow.shape.createdAtMs,
  readAtMs: NoticeRow.shape.readAtMs,
  dismissedAtMs: z.number().int().nonnegative().nullable(),
});
type RelayRow = z.infer<typeof RelayRow>;

// The relay's bounds, checked before a notice is kept anywhere.
const NoticeContent = z.object({
  noticeId: NoticeRow.shape.noticeId,
  workspaceId: z.string().min(1).max(256),
  kind: z.enum(Object.keys(NOTICE_KINDS) as [NoticeKind, ...NoticeKind[]]),
  title: z.string().min(1).refine((value) => [...value].length <= NOTICE_TITLE_MAX_CHARS),
  body: z.string().refine((value) => [...value].length <= NOTICE_BODY_MAX_CHARS),
  target: Target.refine((value) => Buffer.byteLength(JSON.stringify(value)) <= NOTICE_TARGET_MAX_BYTES),
});
type NoticeContent = z.infer<typeof NoticeContent>;
const PostRequest = NoticeContent.extend({
  recipientUserId: z.string().min(1).max(256),
  originInstallId: z.string().min(1).max(256),
});

const LocalFile = z.object({ version: z.literal(1), rows: z.array(LocalRow) });
type LocalFile = z.infer<typeof LocalFile>;

// An account's rows as the relay last served them, the pull cursor, and the
// outbox: your own notices and the marks the relay has not accepted yet.
const AccountFile = z.object({
  version: z.literal(1),
  cursor: z.number().int().nonnegative(),
  // The server answered that it has no notice list. Notices for this account
  // stay on this computer until a pull succeeds.
  routesMissing: z.boolean(),
  rows: z.array(RelayRow),
  posts: z.array(z.object({ request: PostRequest, createdAtMs: NoticeRow.shape.createdAtMs })),
  marks: z.array(z.object({
    noticeId: NoticeRow.shape.noticeId,
    mark: z.enum(["read", "dismissed"]),
    atMs: z.number().int().nonnegative(),
  })),
});
type AccountFile = z.infer<typeof AccountFile>;

const RelayPage = z.object({
  ok: z.literal(true),
  notices: z.array(z.unknown()).max(NOTICE_PAGE_MAX),
  nextCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

class RelayRefusal extends Error {
  constructor(readonly reason: "invalid" | "refused" | "routes-missing") {
    super(reason);
  }
}

/**
 * Notices sent to a person, kept in main under `directory`: one file for this
 * computer and one per signed-in account. Account notices go through the
 * account's outbox to its relay list, and every computer pulls that list. A
 * notice stays on this computer when nobody is signed in, when its workspace
 * does not sync through the signed-in server, or when that server has no
 * notice list. Local notices never upload later.
 */
export function createNoticeStore(deps: {
  directory: string;
  currentAccount(): Promise<NoticeAccount | null>;
  // The signed-in account when the workspace syncs through it, else null.
  accountForWorkspace(workspaceId: string): Promise<NoticeAccount | null>;
  installId(): string;
  onChanged(): void;
  nowMs?: () => number;
}): NoticeStore {
  const nowMs = deps.nowMs ?? Date.now;
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
    // refills from the relay because its cursor starts at zero.
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
    localFile ??= await load("local.json", LocalFile, { version: 1, rows: [] });
    return localFile;
  }

  async function saveLocal(file: LocalFile): Promise<void> {
    file.rows = keep(file.rows, LOCAL_NOTICE_ROW_LIMIT, nowMs());
    await save("local.json", file);
  }

  async function loadAccount(account: NoticeAccount): Promise<AccountFile> {
    const name = accountFileName(account);
    let file = accountFiles.get(name);
    if (!file) {
      file = await load(name, AccountFile, {
        version: 1, cursor: 0, routesMissing: false, rows: [], posts: [], marks: [],
      });
      accountFiles.set(name, file);
    }
    return file;
  }

  async function saveAccount(account: NoticeAccount, file: AccountFile): Promise<void> {
    file.rows = keep(file.rows, NOTICE_LIST_ROW_LIMIT, nowMs());
    file.posts = file.posts.slice(-NOTICE_LIST_ROW_LIMIT);
    file.marks = file.marks.slice(-NOTICE_LIST_ROW_LIMIT);
    await save(accountFileName(account), file);
  }

  function addLocal(file: LocalFile, content: NoticeContent | LocalRow, createdAtMs: number): boolean {
    if (file.rows.some((existing) => existing.noticeId === content.noticeId)) return false;
    file.rows.push({
      noticeId: content.noticeId, kind: content.kind, workspaceId: content.workspaceId,
      title: content.title, body: content.body, target: content.target, createdAtMs, readAtMs: null,
    });
    return true;
  }

  async function relay(account: NoticeAccount, path: string, body?: unknown): Promise<Response> {
    const refusal = (reason: RelayRefusal["reason"]) => () => new RelayRefusal(reason);
    return relayRequest({
      relay: account.relay,
      path,
      init: body === undefined ? undefined : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      // An older server answers 404 for every notice route.
      errors: { 400: refusal("invalid"), 403: refusal("refused"), 404: refusal("routes-missing") },
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
      for (const { request, createdAtMs } of file.posts) addLocal(local, request, createdAtMs);
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
          createdAtMs: nowMs(),
          readAtMs: null,
        }, nowMs());
      }
      await saveLocal(local);
      await saveAccount(account, file);
      return true;
    });
    if (changed) deps.onChanged();
  }

  async function syncAccount(account: NoticeAccount): Promise<void> {
    let changed = false;
    for (;;) {
      const post = await locked(async () => (await loadAccount(account)).posts[0]);
      if (!post) break;
      try {
        await relay(account, "/sync/notices", post.request);
      } catch (error) {
        if (!(error instanceof RelayRefusal)) throw error;
        if (error.reason === "routes-missing") return await noteRoutesMissing(account);
        console.error("[notices] the server refused a notice; it was dropped", error.reason);
      }
      await locked(async () => {
        const file = await loadAccount(account);
        file.posts = file.posts.filter((waiting) => waiting !== post);
        await saveAccount(account, file);
      });
    }

    for (;;) {
      const marks = await locked(async () =>
        (await loadAccount(account)).marks.slice(0, NOTICE_MARKS_PER_REQUEST));
      if (marks.length === 0) break;
      try {
        await relay(account, "/sync/notices/marks", {
          marks: marks.map(({ noticeId, mark }) => ({ noticeId, mark })),
        });
      } catch (error) {
        if (!(error instanceof RelayRefusal)) throw error;
        if (error.reason === "routes-missing") return await noteRoutesMissing(account);
        console.error("[notices] the server refused marks; they were dropped", error.reason);
      }
      await locked(async () => {
        const file = await loadAccount(account);
        file.marks = file.marks.filter((waiting) => !marks.includes(waiting));
        // Keep the marks on the rows until the next pull brings them back.
        for (const { noticeId, mark, atMs } of marks) {
          const index = file.rows.findIndex((row) => row.noticeId === noticeId);
          if (index < 0) continue;
          if (mark === "dismissed") file.rows.splice(index, 1);
          else file.rows[index]!.readAtMs ??= atMs;
        }
        await saveAccount(account, file);
      });
    }

    for (let more = true; more;) {
      const cursor = await locked(async () => (await loadAccount(account)).cursor);
      let page: z.infer<typeof RelayPage>;
      try {
        const response = await relay(account, `/sync/notices?since=${cursor}&limit=${NOTICE_PAGE_MAX}`);
        page = RelayPage.parse(await response.json());
      } catch (error) {
        if (error instanceof RelayRefusal && error.reason === "routes-missing") {
          return await noteRoutesMissing(account);
        }
        throw error;
      }
      changed = await locked(async () => {
        const file = await loadAccount(account);
        const merged = merge(file, page.notices);
        if (!merged && file.cursor === page.nextCursor && !file.routesMissing) return false;
        file.cursor = page.nextCursor;
        file.routesMissing = false;
        await saveAccount(account, file);
        return merged;
      }) || changed;
      more = page.hasMore;
    }
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
            const account = await deps.currentAccount();
            if (account) await syncAccount(account);
          } catch (error) {
            console.warn("[notices] sync failed; the next pass tries again", error);
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
    const account = await deps.accountForWorkspace(input.workspaceId);
    const request = (recipientUserId: string) =>
      PostRequest.parse({ ...content, recipientUserId, originInstallId: deps.installId() });
    if (input.recipientUserId !== undefined && input.recipientUserId !== account?.userId) {
      return await postToAnotherPerson(account, request(input.recipientUserId));
    }
    const createdAtMs = nowMs();
    const queued = await locked(async () => {
      const file = account ? await loadAccount(account) : null;
      if (account && file && !file.routesMissing) {
        const known = file.rows.some((row) => row.noticeId === content.noticeId) ||
          file.posts.some((post) => post.request.noticeId === content.noticeId);
        if (known) return false;
        file.posts.push({ request: request(account.userId), createdAtMs });
        await saveAccount(account, file);
        return true;
      }
      const local = await loadLocal();
      if (!addLocal(local, content, createdAtMs)) return false;
      await saveLocal(local);
      return true;
    });
    if (!queued) return;
    deps.onChanged();
    if (account) void sync();
  }

  // Sent at once rather than queued, so the caller learns whether the
  // relay accepted it.
  async function postToAnotherPerson(
    account: NoticeAccount | null,
    request: PostNoticeRequest,
  ): Promise<void> {
    if (!account || (await locked(async () => (await loadAccount(account)).routesMissing))) {
      throw new NoticeNotSentError(
        "Notices reach other people through a server. Sync this workspace with an up-to-date server first.",
      );
    }
    try {
      await relay(account, "/sync/notices", request);
    } catch (error) {
      if (!(error instanceof RelayRefusal)) throw error;
      if (error.reason === "routes-missing") {
        await noteRoutesMissing(account);
        throw new NoticeNotSentError("Your server doesn't sync notices. Update the server, then try again.");
      }
      if (error.reason === "refused") {
        throw new NoticeNotSentError("This person can't open what the notice points to.");
      }
      throw error;
    }
  }

  async function list(): Promise<NoticeRow[]> {
    const account = await deps.currentAccount();
    return await locked(async () => {
      const rows = (await loadLocal()).rows.map((row): NoticeRow => ({
        store: "local",
        ...row,
        recipientShareId: null,
        senderKind: Object.hasOwn(NOTICE_KINDS, row.kind)
          ? NOTICE_KINDS[row.kind as NoticeKind].senderKind
          : null,
        senderLabel: null,
      }));
      if (account) {
        const file = await loadAccount(account);
        const dismissed = new Set(file.marks.filter((m) => m.mark === "dismissed").map((m) => m.noticeId));
        const readAt = new Map(file.marks.filter((m) => m.mark === "read").map((m) => [m.noticeId, m.atMs]));
        for (const row of file.rows) {
          if (dismissed.has(row.noticeId)) continue;
          rows.push({
            store: "account", noticeId: row.noticeId, kind: row.kind, workspaceId: row.workspaceId,
            recipientShareId: row.recipientShareId, senderKind: row.senderKind, senderLabel: row.senderLabel,
            title: row.title, body: row.body, target: row.target, createdAtMs: row.createdAtMs,
            readAtMs: row.readAtMs ?? readAt.get(row.noticeId) ?? null,
          });
        }
        for (const { request, createdAtMs } of file.posts) {
          if (dismissed.has(request.noticeId)) continue;
          rows.push({
            store: "account", noticeId: request.noticeId, kind: request.kind, workspaceId: request.workspaceId,
            recipientShareId: null, senderKind: NOTICE_KINDS[request.kind].senderKind, senderLabel: null,
            title: request.title, body: request.body, target: request.target, createdAtMs,
            readAtMs: readAt.get(request.noticeId) ?? null,
          });
        }
      }
      return rows.sort((left, right) => right.createdAtMs - left.createdAtMs);
    });
  }

  async function mark(ref: NoticeRef, mark: NoticeMark): Promise<void> {
    const account = ref.store === "account" ? await deps.currentAccount() : null;
    if (ref.store === "account" && !account) return;
    const changed = await locked(async () => {
      if (!account) {
        const file = await loadLocal();
        const index = file.rows.findIndex((row) => row.noticeId === ref.noticeId);
        const row = file.rows[index];
        if (!row) return false;
        if (mark === "dismissed") file.rows.splice(index, 1);
        else if (row.readAtMs === null) row.readAtMs = nowMs();
        else return false;
        await saveLocal(file);
        return true;
      }
      const file = await loadAccount(account);
      const row = file.rows.find((candidate) => candidate.noticeId === ref.noticeId);
      const waiting = file.posts.some((post) => post.request.noticeId === ref.noticeId);
      const marked = file.marks.some((pending) =>
        pending.noticeId === ref.noticeId && (pending.mark === mark || pending.mark === "dismissed"));
      if ((!row && !waiting) || marked || (mark === "read" && row?.readAtMs != null)) return false;
      // A dismissed post that has not left yet never needs to. The mark still
      // goes, in case the post is already on its way.
      if (mark === "dismissed") {
        file.posts = file.posts.filter((post) => post.request.noticeId !== ref.noticeId);
      }
      file.marks.push({ noticeId: ref.noticeId, mark, atMs: nowMs() });
      await saveAccount(account, file);
      return true;
    });
    if (!changed) return;
    deps.onChanged();
    if (account) void sync();
  }

  return { postNotice, list, mark, sync };
}

// Folds one page into the stored rows. Read and dismissed only move forward,
// so a row read here stays read whatever order the changes arrive in.
function merge(file: AccountFile, notices: readonly unknown[]): boolean {
  let changed = false;
  for (const notice of notices) {
    const parsed = RelayRow.safeParse(notice);
    if (!parsed.success) {
      console.warn("[notices] skipped a notice the relay sent in an unknown shape");
      continue;
    }
    const row = parsed.data;
    const index = file.rows.findIndex((existing) => existing.noticeId === row.noticeId);
    if (row.dismissedAtMs !== null) {
      if (index >= 0) file.rows.splice(index, 1);
    } else if (index >= 0) {
      file.rows[index] = { ...row, readAtMs: row.readAtMs ?? file.rows[index]!.readAtMs };
    } else {
      file.rows.push(row);
    }
    changed = true;
  }
  return changed;
}

// The relay's retention and row limit, applied to this computer's copy:
// read rows go after 90 days, unread after 180, and past the limit the
// oldest read rows go first, then the oldest unread.
function keep<Row extends { createdAtMs: number; readAtMs: number | null }>(
  rows: Row[],
  limit: number,
  nowMs: number,
): Row[] {
  const live = rows.filter((row) => row.readAtMs === null
    ? row.createdAtMs + NOTICE_UNREAD_RETENTION_MS > nowMs
    : row.readAtMs + NOTICE_READ_RETENTION_MS > nowMs);
  if (live.length <= limit) return live;
  const removed = new Set([...live]
    .sort((left, right) =>
      Number(left.readAtMs === null) - Number(right.readAtMs === null) ||
      left.createdAtMs - right.createdAtMs)
    .slice(0, live.length - limit));
  return live.filter((row) => !removed.has(row));
}
