import { jsonResponse, readBoundedJson, TokenBucketLimiter } from "@dohc/service-http";
import {
  AUTOMATION_SERVER_INSTALL_ID,
  SERVER_RUN_FAILED_NOTICE_PREFIX,
  AUTOMATION_WAKE_PREFIX,
  isNoticeBody,
  isNoticeLine,
  isNoticeTarget,
  NOTICE_FROM_PREFIX,
  NOTICE_ID_MAX_CHARS,
  NOTICE_KINDS,
  NOTICE_MARKS_MAX_BODY_BYTES,
  NOTICE_MARKS_PER_REQUEST,
  NOTICE_PAGE_MAX,
  NOTICE_POSTED_ID_MAX_CHARS,
  NOTICE_SCOPES,
  NOTICE_TITLE_MAX_CHARS,
  NOTICE_WAIT_MAX_MS,
  type NoticeKind,
  type NoticeMark,
  type PostableNoticeKind,
  type NoticeMarksResponse,
  type NoticeReach,
  type NoticeScope,
} from "@dohc/workspace-contracts/relay";
import type { ResolveAccountSession } from "@dohc/workspace-auth/session";
import { asRecord } from "@dohc/workspace-core";
import { accountDisplayName } from "./accountDisplayName";
import { bearerAccountSession } from "./accountWorkspaceRoutes";
import { DiscussionActivityCapacityError, type DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, RelayError, relayError } from "./errors";
import { observeNoticeChanges } from "./relayWriteChanges";
import { parseString, parseWorkspaceId, readJsonObject } from "./requestInputs";
import type { SyncRelayStorage } from "./storage";
import { parseNoticeCursor, type NoticeCursor, type PostNoticeInput } from "./storage/notices";
import { MAX_SHARE_ID_CHARS } from "./wireLimits";

export type NoticeRoute = { route: "notices" } | { route: "notice-marks" };

// Posts to other people, per sender: a burst of 30, then one every 2 seconds.
export const NOTICE_POST_BUCKET_CAPACITY = 30;
export const NOTICE_POST_REFILL_PER_SECOND = 0.5;
export const NOTICE_POST_MAX_SENDERS = 10_000;

// Account ids as share creation accepts them; install ids are uuids with room to spare.
const MAX_USER_ID_CHARS = 256;
const MAX_INSTALL_ID_CHARS = 256;
const DEFAULT_NOTICE_PAGE = 100;
// A marks body arrives within this, or the request ends.
export const NOTICE_MARKS_RECEIPT_MS = 10_000;

/** The Notice reads one sign-in may hold waiting at once. */
export const NOTICE_WAITS_PER_SESSION = 2;
/** The Notice reads one account may hold waiting at once, across its sign-ins. */
export const NOTICE_WAITS_PER_ACCOUNT = 16;
/** The Notice reads this server holds waiting at once, so they never fill the slots other waits share. */
export const NOTICE_WAITS_TOTAL = 1_024;

/** Each account's Notice reads wait in their own group. */
function noticeWaitGroup(userId: string): string {
  return `notices:${userId}`;
}

/**
 * Notice reads held for their recipient. A committed change to the list
 * wakes them, after its transaction, and so does a credential change, by
 * wakeAccount. A held read is a parked promise with one timer: it runs no
 * query until something wakes it or its time ends. Past a sign-in's, an
 * account's, or the server's waits, `wait` answers null and parks nothing.
 */
export function createNoticeWaits(
  storage: object,
  hub: Pick<DiscussionActivityHub, "wait" | "wake">,
) {
  const accounts = new Map<string, Map<string, number>>();
  let total = 0;
  const closing = new AbortController();
  const stopObserving = observeNoticeChanges(storage, (userId) =>
    hub.wake(noticeWaitGroup(userId)),
  );

  return {
    wait(input: {
      userId: string;
      sessionId: string;
      holdMs: number;
      signal: AbortSignal;
      shouldPark(): boolean;
    }): Promise<void> | null {
      const sessions = accounts.get(input.userId) ?? new Map<string, number>();
      const held = [...sessions.values()].reduce((sum, count) => sum + count, 0);
      if (
        closing.signal.aborted ||
        total >= NOTICE_WAITS_TOTAL ||
        held >= NOTICE_WAITS_PER_ACCOUNT ||
        (sessions.get(input.sessionId) ?? 0) >= NOTICE_WAITS_PER_SESSION
      )
        return null;
      let parked: Promise<void>;
      try {
        parked = hub.wait(noticeWaitGroup(input.userId), `notices:${input.sessionId}`, {
          holdMs: input.holdMs,
          signal: AbortSignal.any([input.signal, closing.signal]),
          shouldPark: input.shouldPark,
        });
      } catch (error) {
        if (error instanceof DiscussionActivityCapacityError) return null;
        throw error;
      }
      accounts.set(input.userId, sessions);
      sessions.set(input.sessionId, (sessions.get(input.sessionId) ?? 0) + 1);
      total += 1;
      return parked.finally(() => {
        total -= 1;
        const left = sessions.get(input.sessionId)! - 1;
        if (left > 0) sessions.set(input.sessionId, left);
        else sessions.delete(input.sessionId);
        if (sessions.size === 0) accounts.delete(input.userId);
      });
    },
    /** The account's credentials changed: its reads check them again. */
    wakeAccount(userId: string): void {
      hub.wake(noticeWaitGroup(userId));
    },
    closed: () => closing.signal.aborted,
    /** Ends every held read, which then answers the caught-up page it held, and stops listening. */
    close(): void {
      closing.abort();
      stopObserving();
    },
  };
}

export type NoticeWaits = ReturnType<typeof createNoticeWaits>;

// A person's notice list: GET pulls changes after a cursor, POST adds a
// notice to someone's list, and POST /marks sets read or dismissed. Every
// route acts for the authenticated caller, who is the sender of a post and
// the owner of the list it pulls or marks. A GET with `scope` or `wait` is
// the account's own read: only a Bearer account session makes it.
export function createNoticeRoutes(
  storage: SyncRelayStorage,
  nowMs: () => number,
  lookupUserDisplayName: ((userId: string) => Promise<string | null> | string | null) | undefined,
  claimPendingShares: (userId: string, signal?: AbortSignal) => Promise<void>,
  deliverPendingShareNotices: (userId: string) => Promise<void>,
  postRateLimiter: TokenBucketLimiter,
  account: {
    /** Absent, an account read answers as missing. */
    resolveAccountSession: ResolveAccountSession | undefined;
    /** Keyed by sign-in. */
    limiter: TokenBucketLimiter;
    waits: NoticeWaits;
  },
) {
  /**
   * `GET /sync/notices?cursor=&limit=&scope=phone&wait=`. The sign-in is
   * checked before each read, so after every wait, and nothing is awaited
   * between the last read and its answer. A read parks only while its cursor
   * is caught up: a snapshot, a replacement, a part of a longer pull, or a
   * moved head answers at once, even when the phone's scope left every row
   * out.
   */
  async function readForAccount(request: Request, url: URL): Promise<Response> {
    const scope = parseScope(url.searchParams.get("scope"));
    const waitMs = parseWait(url.searchParams.get("wait"));
    const cursor = parseCursorParam(url.searchParams.get("cursor"));
    const limit = parseNoticePageLimit(url.searchParams.get("limit"));
    const resolveAccountSession = account.resolveAccountSession;
    if (resolveAccountSession === undefined) throw notFound();
    const session = () => bearerAccountSession(storage, resolveAccountSession, request);
    const caller = await session();
    if (!account.limiter.allow(caller.sessionId, nowMs())) {
      throw new RelayError(
        "server_busy",
        "This sign-in is asking faster than your server answers. Try again shortly.",
      );
    }
    const userId = caller.userId;
    const deadlineAtMs = Date.now() + waitMs;
    for (;;) {
      await deliverPendingShareNotices(userId);
      const current = await session();
      if (current.sessionId !== caller.sessionId || current.userId !== userId) throw notFound();
      const page = storage.readNoticeChanges({
        recipientUserId: userId,
        cursor,
        limit,
        nowMs: nowMs(),
        ...(scope ? { scope } : {}),
      });
      const caughtUpAt =
        cursor !== null &&
        cursor.snapshotHead === null &&
        !page.replace &&
        page.nextCursor === String(cursor.seq)
          ? cursor.seq
          : null;
      const holdMs = deadlineAtMs - Date.now();
      const parked =
        caughtUpAt === null || holdMs <= 0 || request.signal.aborted
          ? null
          : account.waits.wait({
              userId,
              sessionId: caller.sessionId,
              holdMs,
              signal: request.signal,
              shouldPark: () => storage.noticeHead(userId) === caughtUpAt,
            });
      if (parked === null) return jsonResponse({ ok: true, ...page }, 200);
      await parked;
      // Closing: the held page is caught up, so it carries no row, and storage may already be gone.
      if (account.waits.closed()) return jsonResponse({ ok: true, ...page }, 200);
    }
  }

  /**
   * `POST /sync/notices/marks?scope=phone`: the owner's phone marks its list
   * with exactly `{ marks: [{ noticeId, mark }] }`, any of the four marks. It
   * names no computer, so it never consumes an automation wake. The sign-in is
   * checked again after the body arrives, right before anything changes.
   */
  async function markForAccount(request: Request, url: URL): Promise<Response> {
    parseScope(url.searchParams.get("scope"));
    const resolveAccountSession = account.resolveAccountSession;
    if (resolveAccountSession === undefined) throw notFound();
    const session = () => bearerAccountSession(storage, resolveAccountSession, request);
    const caller = await session();
    if (!account.limiter.allow(caller.sessionId, nowMs())) {
      throw new RelayError(
        "server_busy",
        "This sign-in is asking faster than your server answers. Try again shortly.",
      );
    }
    const body = await readMarksBody(request);
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "marks"))
      throw badRequest("the body must be exactly { marks }");
    const marks = parseMarks(body.marks, PHONE_MARKS);
    const current = await session();
    if (current.sessionId !== caller.sessionId || current.userId !== caller.userId)
      throw notFound();
    const dismissed = storage.markNotices({
      recipientUserId: caller.userId,
      marks,
      nowMs: nowMs(),
    });
    return jsonResponse({ ok: true, dismissed } satisfies NoticeMarksResponse, 200);
  }

  return async function respondToNotices(
    request: Request,
    route: NoticeRoute,
    caller: () => Promise<string>,
  ): Promise<Response> {
    if (route.route === "notices" && request.method === "GET") {
      const url = new URL(request.url);
      if (url.searchParams.has("scope") || url.searchParams.has("wait"))
        return await readForAccount(request, url);
      const userId = await caller();
      await deliverPendingShareNotices(userId);
      const page = storage.readNoticeChanges({
        recipientUserId: userId,
        cursor: parseCursorParam(url.searchParams.get("cursor")),
        limit: parseNoticePageLimit(url.searchParams.get("limit")),
        nowMs: nowMs(),
      });
      return jsonResponse({ ok: true, ...page }, 200);
    }
    if (route.route === "notices" && request.method === "POST") {
      const userId = await caller();
      const { toWorkspaceOwner, ...posted } = parsePostNotice(await readJsonObject(request));
      // The share names the owner. The placement check below still decides
      // whether the sender may post through it.
      const recipientUserId = toWorkspaceOwner
        ? storage.getShare(posted.reach.shareId!)?.granterUserId
        : posted.recipientUserId;
      if (recipientUserId === undefined) throw relayError("notice_refused");
      const notice = { ...posted, recipientUserId };
      // Only this server posts as the server, in process.
      if (notice.originInstallId === AUTOMATION_SERVER_INSTALL_ID)
        throw badRequest("originInstallId is reserved for the server");
      if (notice.noticeId.startsWith(SERVER_RUN_FAILED_NOTICE_PREFIX))
        throw badRequest("noticeId is reserved for the server");
      if (notice.recipientUserId === userId) {
        if (notice.noticeId.startsWith(NOTICE_FROM_PREFIX)) {
          throw badRequest(`noticeId must not start with ${NOTICE_FROM_PREFIX}`);
        }
      } else {
        if (!postRateLimiter.allow(userId, nowMs())) throw relayError("notice_rate_limited");
        // A grant still addressed to the sender's email counts once claimed.
        await claimPendingShares(userId, request.signal);
      }
      storage.postNotice({
        ...notice,
        senderUserId: userId,
        senderLabel: (await accountDisplayName(lookupUserDisplayName, userId)) ?? "Unnamed",
        nowMs: nowMs(),
      });
      return jsonResponse({ ok: true }, 200);
    }
    if (route.route === "notice-marks" && request.method === "POST") {
      const url = new URL(request.url);
      if (url.searchParams.has("scope")) return await markForAccount(request, url);
      // A computer's marks: read and dismissed, with `installId` and `withdraw`.
      const userId = await caller();
      const body = await readMarksBody(request);
      if (!Object.keys(body).every((key) => key === "marks" || key === "installId"))
        throw badRequest("the body takes only marks and installId");
      if (body.installId !== undefined && !isNoticeLine(body.installId, MAX_INSTALL_ID_CHARS))
        throw badRequest("installId is invalid");
      const dismissed = storage.markNotices({
        recipientUserId: userId,
        marks: parseMarks(body.marks, COMPUTER_MARKS),
        ...(typeof body.installId === "string" ? { installId: body.installId } : {}),
        nowMs: nowMs(),
      });
      return jsonResponse({ ok: true, dismissed } satisfies NoticeMarksResponse, 200);
    }
    throw relayError("method_not_allowed");
  };
}

type PostedNotice = Omit<
  PostNoticeInput,
  "senderUserId" | "senderLabel" | "nowMs" | "recipientUserId"
> &
  (
    | { recipientUserId: string; toWorkspaceOwner: false }
    | { recipientUserId?: undefined; toWorkspaceOwner: true }
  );

/** A posted notice as the route accepts it; the server's own automations post through this too. */
export function parsePostNotice(body: Record<string, unknown>): PostedNotice {
  if (
    typeof body.kind !== "string" ||
    !Object.hasOwn(NOTICE_KINDS, body.kind) ||
    NOTICE_KINDS[body.kind as NoticeKind].recipients === "relay"
  ) {
    throw badRequest("kind is not a notice kind anyone may post");
  }
  if (!isNoticeLine(body.noticeId, NOTICE_POSTED_ID_MAX_CHARS))
    throw badRequest("noticeId is invalid");
  if (body.noticeId.startsWith(AUTOMATION_WAKE_PREFIX))
    throw badRequest("noticeId is reserved for agent wakes");
  if (!isNoticeLine(body.title, NOTICE_TITLE_MAX_CHARS)) throw badRequest("title is invalid");
  if (!isNoticeBody(body.body)) throw badRequest("body is invalid");
  if (!isNoticeTarget(body.target)) throw badRequest("target is invalid");
  const reach = parseReach(body);
  if (
    body.toWorkspaceOwner !== undefined &&
    (body.toWorkspaceOwner !== true ||
      body.recipientUserId !== undefined ||
      reach.shareId === undefined)
  ) {
    throw badRequest("toWorkspaceOwner takes a shareId and no recipientUserId");
  }
  return {
    ...(body.toWorkspaceOwner === true
      ? { toWorkspaceOwner: true as const }
      : {
          toWorkspaceOwner: false as const,
          recipientUserId: parseString(body.recipientUserId, "recipientUserId", MAX_USER_ID_CHARS),
        }),
    noticeId: body.noticeId,
    reach,
    kind: body.kind as PostableNoticeKind,
    title: body.title,
    body: body.body,
    target: body.target,
    originInstallId: parseString(body.originInstallId, "originInstallId", MAX_INSTALL_ID_CHARS),
  };
}

function parseReach(body: Record<string, unknown>): NoticeReach {
  if ((body.workspaceId === undefined) === (body.shareId === undefined)) {
    throw badRequest("name exactly one of workspaceId and shareId");
  }
  if (body.workspaceId !== undefined) return { workspaceId: parseWorkspaceId(body.workspaceId) };
  const shareId = body.shareId;
  if (
    typeof shareId !== "string" ||
    shareId.length > MAX_SHARE_ID_CHARS ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(shareId)
  ) {
    throw badRequest("shareId is invalid");
  }
  return { shareId };
}

// What each sender may mark with, and the fields each of its marks takes.
interface MarkSender {
  marks: readonly NoticeMark[];
  fields: readonly string[];
}
const PHONE_MARKS: MarkSender = {
  marks: ["read", "dismissed", "unread", "restore"],
  fields: ["noticeId", "mark"],
};
const COMPUTER_MARKS: MarkSender = {
  marks: ["read", "dismissed"],
  fields: ["noticeId", "mark", "withdraw"],
};

// A body that stops arriving ends at the deadline, which cancels its stream. The deadline is a
// timer the request clears, so nothing outlives the read.
async function readMarksBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), NOTICE_MARKS_RECEIPT_MS);
  try {
    body = await readBoundedJson(
      request,
      NOTICE_MARKS_MAX_BODY_BYTES,
      AbortSignal.any([request.signal, deadline.signal]),
    );
  } catch (error) {
    throw error instanceof RangeError
      ? relayError("payload_too_large")
      : badRequest("request body must be valid JSON");
  } finally {
    clearTimeout(timer);
  }
  const object = asRecord(body);
  if (object === null) throw badRequest("request body must be a JSON object");
  return object;
}

function parseMarks(
  value: unknown,
  sender: MarkSender,
): { noticeId: string; mark: NoticeMark; withdraw?: true }[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > NOTICE_MARKS_PER_REQUEST) {
    throw badRequest(`marks must list 1 to ${NOTICE_MARKS_PER_REQUEST} notices`);
  }
  return value.map((entry: unknown) => {
    const mark = asRecord(entry);
    if (mark === null || !Object.keys(mark).every((key) => sender.fields.includes(key))) {
      throw badRequest(`each mark takes only ${sender.fields.join(", ")}`);
    }
    const named = mark.mark;
    const kind = sender.marks.find((known) => known === named);
    if (kind === undefined) throw badRequest(`mark must be ${sender.marks.join(", ")}`);
    if (!isNoticeLine(mark.noticeId, NOTICE_ID_MAX_CHARS)) throw badRequest("noticeId is invalid");
    // A withdrawal dismisses the copies the sender posted to others; nothing else reaches another list.
    if (mark.withdraw !== undefined && (mark.withdraw !== true || kind !== "dismissed"))
      throw badRequest("withdraw requires a dismissal");
    return {
      noticeId: mark.noticeId,
      mark: kind,
      ...(mark.withdraw === true ? { withdraw: true as const } : {}),
    };
  });
}

function parseCursorParam(value: string | null): NoticeCursor | null {
  if (value === null || value === "") return null;
  const cursor = parseNoticeCursor(value);
  if (!cursor) throw badRequest("cursor is invalid");
  return cursor;
}

function parseScope(value: string | null): NoticeScope | null {
  if (value === null) return null;
  const scope = NOTICE_SCOPES.find((known) => known === value);
  if (scope === undefined) throw badRequest(`scope must be ${NOTICE_SCOPES.join(" or ")}`);
  return scope;
}

// Whole milliseconds, 0 to NOTICE_WAIT_MAX_MS; absent answers at once.
function parseWait(value: string | null): number {
  if (value === null) return 0;
  const waitMs = Number(value);
  if (!/^(?:0|[1-9]\d{0,5})$/u.test(value) || waitMs > NOTICE_WAIT_MAX_MS) {
    throw badRequest(`wait must be whole milliseconds from 0 to ${NOTICE_WAIT_MAX_MS}`);
  }
  return waitMs;
}

function parseNoticePageLimit(value: string | null): number {
  if (value === null || value === "") return DEFAULT_NOTICE_PAGE;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw badRequest("limit must be a positive integer");
  return Math.min(limit, NOTICE_PAGE_MAX);
}
