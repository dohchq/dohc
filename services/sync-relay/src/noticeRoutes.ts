import { jsonResponse } from "@dohc/service-http";
import {
  NOTICE_BODY_MAX_CHARS,
  NOTICE_ID_MAX_CHARS,
  NOTICE_KINDS,
  NOTICE_MARKS_PER_REQUEST,
  NOTICE_PAGE_MAX,
  NOTICE_TARGET_FIELDS,
  NOTICE_TARGET_MAX_BYTES,
  NOTICE_TITLE_MAX_CHARS,
  type NoticeKind,
  type NoticeMark,
  type NoticeTarget,
} from "@dohc/workspace-contracts/relay";
import { accountDisplayName } from "./discussionRoutes";
import { badRequest, relayError } from "./errors";
import { parseCursor, parseString, parseWorkspaceId, readJsonObject } from "./requestInputs";
import type { SyncRelayStorage } from "./storage";
import type { PostNoticeInput } from "./storage/notices";

export type NoticeRoute = { route: "notices" } | { route: "notice-marks" };

// Account ids as share creation accepts them; install ids are uuids with room to spare.
const MAX_USER_ID_CHARS = 256;
const MAX_INSTALL_ID_CHARS = 256;
const MAX_TARGET_FIELD_CHARS = 1_024;
const DEFAULT_NOTICE_PAGE = 100;
// Control characters other than tab and newline, which a body may carry.
const BODY_CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/u;

// A person's notice list: GET pulls changes after a cursor, POST adds a
// notice to someone's list, and POST /marks sets read or dismissed. Every
// route acts for the authenticated caller, who is the sender of a post and
// the owner of the list it pulls or marks.
export function createNoticeRoutes(
  storage: Pick<SyncRelayStorage, "postNotice" | "readNoticeChanges" | "markNotices">,
  nowMs: () => number,
  lookupUserDisplayName: ((userId: string) => Promise<string | null> | string | null) | undefined,
  claimPendingShares: (userId: string, signal?: AbortSignal) => Promise<void>,
) {
  return async function respondToNotices(
    request: Request,
    route: NoticeRoute,
    userId: string,
  ): Promise<Response> {
    if (route.route === "notices" && request.method === "GET") {
      const url = new URL(request.url);
      const page = storage.readNoticeChanges({
        recipientUserId: userId,
        since: parseCursor(url.searchParams.get("since")),
        limit: parseNoticePageLimit(url.searchParams.get("limit")),
        nowMs: nowMs(),
      });
      return jsonResponse({ ok: true, ...page }, 200);
    }
    if (route.route === "notices" && request.method === "POST") {
      const notice = parsePostNotice(await readJsonObject(request));
      // A grant still addressed to the sender's email counts once claimed.
      await claimPendingShares(userId, request.signal);
      storage.postNotice({
        ...notice,
        senderUserId: userId,
        senderLabel: await accountDisplayName(lookupUserDisplayName, userId),
        nowMs: nowMs(),
      });
      return jsonResponse({ ok: true }, 200);
    }
    if (route.route === "notice-marks" && request.method === "POST") {
      storage.markNotices({
        recipientUserId: userId,
        marks: parseMarks((await readJsonObject(request)).marks),
        nowMs: nowMs(),
      });
      return jsonResponse({ ok: true }, 200);
    }
    throw relayError("method_not_allowed");
  };
}

type PostedNotice = Omit<PostNoticeInput, "senderUserId" | "senderLabel" | "nowMs">;

function parsePostNotice(body: Record<string, unknown>): PostedNotice {
  if (typeof body.kind !== "string" || !Object.hasOwn(NOTICE_KINDS, body.kind)) {
    throw badRequest("kind is not a notice kind");
  }
  return {
    noticeId: parseString(body.noticeId, "noticeId", NOTICE_ID_MAX_CHARS),
    recipientUserId: parseString(body.recipientUserId, "recipientUserId", MAX_USER_ID_CHARS),
    workspaceId: parseWorkspaceId(body.workspaceId),
    kind: body.kind as NoticeKind,
    title: parseText(body.title, "title", NOTICE_TITLE_MAX_CHARS),
    body: parseBody(body.body),
    target: parseTarget(body.target),
    originInstallId: parseString(body.originInstallId, "originInstallId", MAX_INSTALL_ID_CHARS),
  };
}

function parseText(value: unknown, name: string, maxCodePoints: number): string {
  const text = parseString(value, name, maxCodePoints * 2);
  if ([...text].length > maxCodePoints) throw badRequest(`${name} is too long`);
  return text;
}

function parseBody(value: unknown): string {
  if (typeof value !== "string") throw badRequest("body must be a string");
  if ([...value].length > NOTICE_BODY_MAX_CHARS) throw badRequest("body is too long");
  if (BODY_CONTROL_CHARS.test(value)) throw badRequest("body must not contain control characters");
  return value;
}

function parseTarget(value: unknown): NoticeTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("target must be an object");
  }
  const target: NoticeTarget = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    if (!(NOTICE_TARGET_FIELDS as readonly string[]).includes(field)) {
      throw badRequest("target has an unknown field");
    }
    target[field as keyof NoticeTarget] = parseString(fieldValue, `target.${field}`, MAX_TARGET_FIELD_CHARS);
  }
  if (Buffer.byteLength(JSON.stringify(target)) > NOTICE_TARGET_MAX_BYTES) {
    throw badRequest("target is too large");
  }
  return target;
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
    return { noticeId: parseString(mark.noticeId, "noticeId", NOTICE_ID_MAX_CHARS), mark: mark.mark };
  });
}

function parseNoticePageLimit(value: string | null): number {
  if (value === null || value === "") return DEFAULT_NOTICE_PAGE;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw badRequest("limit must be a positive integer");
  return Math.min(limit, NOTICE_PAGE_MAX);
}
