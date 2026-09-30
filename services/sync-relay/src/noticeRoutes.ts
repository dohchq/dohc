import { jsonResponse, TokenBucketLimiter } from "@dohc/service-http";
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
  NOTICE_MARKS_PER_REQUEST,
  NOTICE_PAGE_MAX,
  NOTICE_POSTED_ID_MAX_CHARS,
  NOTICE_TITLE_MAX_CHARS,
  type NoticeKind,
  type NoticeMark,
  type PostableNoticeKind,
  type NoticeMarksResponse,
  type NoticeReach,
} from "@dohc/workspace-contracts/relay";
import { accountDisplayName } from "./discussionRoutes";
import { badRequest, relayError } from "./errors";
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

// A person's notice list: GET pulls changes after a cursor, POST adds a
// notice to someone's list, and POST /marks sets read or dismissed. Every
// route acts for the authenticated caller, who is the sender of a post and
// the owner of the list it pulls or marks.
export function createNoticeRoutes(
  storage: Pick<SyncRelayStorage, "postNotice" | "readNoticeChanges" | "markNotices" | "getShare">,
  nowMs: () => number,
  lookupUserDisplayName: ((userId: string) => Promise<string | null> | string | null) | undefined,
  claimPendingShares: (userId: string, signal?: AbortSignal) => Promise<void>,
  deliverPendingShareNotices: (userId: string) => Promise<void>,
  postRateLimiter: TokenBucketLimiter,
) {
  return async function respondToNotices(
    request: Request,
    route: NoticeRoute,
    userId: string,
  ): Promise<Response> {
    if (route.route === "notices" && request.method === "GET") {
      await deliverPendingShareNotices(userId);
      const url = new URL(request.url);
      const page = storage.readNoticeChanges({
        recipientUserId: userId,
        cursor: parseCursorParam(url.searchParams.get("cursor")),
        limit: parseNoticePageLimit(url.searchParams.get("limit")),
        nowMs: nowMs(),
      });
      return jsonResponse({ ok: true, ...page }, 200);
    }
    if (route.route === "notices" && request.method === "POST") {
      const { toWorkspaceOwner, ...posted } = parsePostNotice(await readJsonObject(request));
      // The share names the owner. The placement check below still decides
      // whether the sender may post through it.
      const recipientUserId = toWorkspaceOwner
        ? storage.getShare(posted.reach.shareId!)?.granterUserId
        : posted.recipientUserId;
      if (recipientUserId === undefined) throw relayError("notice_refused");
      const notice = { ...posted, recipientUserId };
      // Only this server posts as the server, in process.
      if (notice.originInstallId === AUTOMATION_SERVER_INSTALL_ID) throw badRequest("originInstallId is reserved for the server");
      if (notice.noticeId.startsWith(SERVER_RUN_FAILED_NOTICE_PREFIX)) throw badRequest("noticeId is reserved for the server");
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
      const body = await readJsonObject(request);
      if (body.installId !== undefined && !isNoticeLine(body.installId, 256)) throw badRequest("installId is invalid");
      const dismissed = storage.markNotices({
        recipientUserId: userId,
        marks: parseMarks(body.marks),
        ...(typeof body.installId === "string" ? { installId: body.installId } : {}),
        nowMs: nowMs(),
      });
      return jsonResponse({ ok: true, dismissed } satisfies NoticeMarksResponse, 200);
    }
    throw relayError("method_not_allowed");
  };
}

type PostedNotice = Omit<PostNoticeInput, "senderUserId" | "senderLabel" | "nowMs" | "recipientUserId"> &
  ({ recipientUserId: string; toWorkspaceOwner: false } | { recipientUserId?: undefined; toWorkspaceOwner: true });

/** A posted notice as the route accepts it; the server's own automations post through this too. */
export function parsePostNotice(body: Record<string, unknown>): PostedNotice {
  if (
    typeof body.kind !== "string" || !Object.hasOwn(NOTICE_KINDS, body.kind) ||
    NOTICE_KINDS[body.kind as NoticeKind].recipients === "relay"
  ) {
    throw badRequest("kind is not a notice kind anyone may post");
  }
  if (!isNoticeLine(body.noticeId, NOTICE_POSTED_ID_MAX_CHARS)) throw badRequest("noticeId is invalid");
  if (body.noticeId.startsWith(AUTOMATION_WAKE_PREFIX)) throw badRequest("noticeId is reserved for agent wakes");
  if (!isNoticeLine(body.title, NOTICE_TITLE_MAX_CHARS)) throw badRequest("title is invalid");
  if (!isNoticeBody(body.body)) throw badRequest("body is invalid");
  if (!isNoticeTarget(body.target)) throw badRequest("target is invalid");
  const reach = parseReach(body);
  if (body.toWorkspaceOwner !== undefined && (body.toWorkspaceOwner !== true || body.recipientUserId !== undefined || reach.shareId === undefined)) {
    throw badRequest("toWorkspaceOwner takes a shareId and no recipientUserId");
  }
  return {
    ...(body.toWorkspaceOwner === true
      ? { toWorkspaceOwner: true as const }
      : { toWorkspaceOwner: false as const, recipientUserId: parseString(body.recipientUserId, "recipientUserId", MAX_USER_ID_CHARS) }),
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
  if (typeof shareId !== "string" || shareId.length > MAX_SHARE_ID_CHARS || !/^[a-z0-9][a-z0-9-]*$/u.test(shareId)) {
    throw badRequest("shareId is invalid");
  }
  return { shareId };
}

function parseMarks(value: unknown): { noticeId: string; mark: NoticeMark }[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > NOTICE_MARKS_PER_REQUEST) {
    throw badRequest(`marks must list 1 to ${NOTICE_MARKS_PER_REQUEST} notices`);
  }
  return value.map((entry: unknown) => {
    const mark = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    if (mark.mark !== "read" && mark.mark !== "dismissed") {
      throw badRequest("mark must be read or dismissed");
    }
    if (!isNoticeLine(mark.noticeId, NOTICE_ID_MAX_CHARS)) throw badRequest("noticeId is invalid");
    return { noticeId: mark.noticeId, mark: mark.mark };
  });
}

function parseCursorParam(value: string | null): NoticeCursor | null {
  if (value === null || value === "") return null;
  const cursor = parseNoticeCursor(value);
  if (!cursor) throw badRequest("cursor is invalid");
  return cursor;
}

function parseNoticePageLimit(value: string | null): number {
  if (value === null || value === "") return DEFAULT_NOTICE_PAGE;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw badRequest("limit must be a positive integer");
  return Math.min(limit, NOTICE_PAGE_MAX);
}
