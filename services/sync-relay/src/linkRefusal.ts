import { relayPathSegments } from "./requestInputs";
import { isLinkEndpointPath } from "./linkEndpointPath";
import type { LiveNoteState } from "./storage/serviceHostEnrollment";
import type { ServiceHostDocumentState } from "./serviceHostEnrollmentRoutes";
import {
  LINK_REFUSALS,
  NAMED_LIVE_STOPPED,
  NAMED_LIVE_STOPPED_STATUS,
  linkRefusalBody,
  parseLinkRefusal,
  type LinkRefusalCode,
} from "@dohc/security-contract/link-refusal";

export function opaqueLinkRefusal(): Response {
  return Response.json(
    { ok: false, error: "not found" },
    { status: 404, headers: { "cache-control": "private, no-store" } },
  );
}

export function linkRefusal(code: LinkRefusalCode): Response {
  return Response.json(linkRefusalBody(code), {
    status: LINK_REFUSALS[code].status,
    headers: { "cache-control": "private, no-store" },
  });
}

/**
 * Why the session host can't continue a document for browsers: its copy here held an owner edit it
 * could not apply, which only the owner's Resume clears, or it stopped for another reason.
 */
export type SessionHostBlock = "held" | "stopped";

/** Where a note stands in going live, as its record and its host say, while it is not live. */
export type LiveNoteStanding = "starting" | "off";

const OWNER_CLEARED_REASONS = new Set([
  "session-host-refused",
  "live-document-without-lineage",
  "live-edit-unadmitted",
]);

/** Where a note stands, from its record's state and its owner's readiness. No record, or a note its host serves, gives no answer. */
export function liveNoteStanding(
  state: LiveNoteState | undefined,
  readiness?: () => { status: ServiceHostDocumentState["status"]; reason?: string },
): LiveNoteStanding | undefined {
  if (state === "off" || state === "stopping") return "off";
  if (state === undefined) return undefined;
  const ready = readiness?.();
  if (ready?.reason !== undefined && OWNER_CLEARED_REASONS.has(ready.reason)) return "off";
  return state === "starting" ||
    ready?.status === "preparing" ||
    ready?.reason === "live-start-failing"
    ? "starting"
    : undefined;
}

/** What a link holder is told about a blocked document. */
export function sessionHostRefusal(block: SessionHostBlock): Response {
  return linkRefusal(block === "held" ? "link_live_stopped" : "link_live_unavailable");
}

export function liveNoteRefusal(
  note: LiveNoteStanding | undefined,
  block: SessionHostBlock | undefined,
): Response | undefined {
  if (note === "starting" && block !== "held") return linkRefusal("link_live_starting");
  if (note === "off") return sessionHostRefusal("held");
  return block ? sessionHostRefusal(block) : undefined;
}

/** What a link holder is told about a document with no binding. */
export function unboundLinkRefusal(
  note: LiveNoteStanding | undefined,
  block: SessionHostBlock | undefined,
): Response {
  return liveNoteRefusal(note, block) ?? sessionHostRefusal("stopped");
}

/** What an invited editor is told about a held document. */
export function namedLiveStoppedRefusal(): Response {
  return Response.json(NAMED_LIVE_STOPPED, {
    status: NAMED_LIVE_STOPPED_STATUS,
    headers: { "cache-control": "private, no-store" },
  });
}

export async function normalizeLinkRefusal(
  response: Response,
  path: string,
  liveEditing = false,
): Promise<Response> {
  if (!isLinkEndpointPath(path)) return response;
  if (response.status >= 500) {
    const code =
      liveEditing && response.status === 503
        ? parseLinkRefusal(await response.json().catch(() => null), response.status)
        : null;
    if (code === "link_live_stopped" || code === "link_live_starting") return linkRefusal(code);
    await response.body?.cancel().catch(() => undefined);
    return linkRefusal(liveEditing ? "link_live_unavailable" : "link_unavailable");
  }
  if (![401, 403, 404].includes(response.status)) return response;
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const parts = relayPathSegments(path);
  const collectionWrites =
    parts.length === 3 &&
    parts[0] === "sync" &&
    parts[1] === "link" &&
    parts[2] === "collection-writes";
  if (
    body &&
    ((collectionWrites && response.status === 403 && body.code === "share_op_rejected") ||
      parseLinkRefusal(body, response.status) ||
      ["link_discussion_blocked", "link_discussion_paused", "discussion_limit_reached"].includes(
        String(body.code),
      ))
  ) {
    return Response.json(body, { status: response.status, headers: response.headers });
  }
  return opaqueLinkRefusal();
}
