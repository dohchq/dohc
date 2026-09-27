import {LINK_REFUSALS, linkRefusalBody, parseLinkRefusal, type LinkRefusalCode} from "@dohc/security-contract/link-refusal";

export function opaqueLinkRefusal(): Response {
  return Response.json({ok: false, error: "not found"}, {status: 404, headers: {"cache-control": "private, no-store"}});
}

export function linkRefusal(code: LinkRefusalCode): Response {
  return Response.json(linkRefusalBody(code), {status: LINK_REFUSALS[code].status, headers: {"cache-control": "private, no-store"}});
}

export async function normalizeLinkRefusal(response: Response, liveEditing = false): Promise<Response> {
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    return linkRefusal(liveEditing ? "link_live_unavailable" : "link_unavailable");
  }
  if (![401, 403, 404].includes(response.status)) return response;
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (body && (parseLinkRefusal(body, response.status) ||
      ["link_discussion_blocked", "link_discussion_paused", "discussion_limit_reached"].includes(String(body.code)))) {
    return Response.json(body, {status: response.status, headers: response.headers});
  }
  return opaqueLinkRefusal();
}
