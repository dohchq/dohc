import { relayPathSegments } from "./requestInputs";
import { isLinkEndpointPath } from "./linkEndpointPath";
import {
  LINK_REFUSALS,
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

/** What a link holder is told about a blocked document. */
export function sessionHostRefusal(block: SessionHostBlock): Response {
  return linkRefusal(block === "held" ? "link_live_stopped" : "link_live_unavailable");
}

export async function normalizeLinkRefusal(
  response: Response,
  path: string,
  liveEditing = false,
): Promise<Response> {
  if (!isLinkEndpointPath(path)) return response;
  if (response.status >= 500) {
    // A live route's own answer that only the owner can lift goes through. Every other outage reads the same.
    if (
      liveEditing &&
      response.status === LINK_REFUSALS.link_live_stopped.status &&
      parseLinkRefusal(await response.json().catch(() => null), response.status) ===
        "link_live_stopped"
    )
      return linkRefusal("link_live_stopped");
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
