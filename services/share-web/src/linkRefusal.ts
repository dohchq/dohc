import {readBoundedJson} from "@dohc/service-http";
import {linkRefusalBody, parseLinkRefusal} from "@dohc/security-contract/link-refusal";
import {asRecord} from "@dohc/workspace-core/records";
import {SHARE_WEB_SECURITY_HEADERS} from "./securityHeaders";

// A link post's refusals that the viewer and agents act on, in this server's
// words. Only the relay's code passes, never its own words.
const LINK_CHAT_REFUSALS: Readonly<Record<string, {status: number; error: string}>> = {
  bad_request: {status: 400, error: "dohc could not post this message. Check its thread and text, then try again."},
  link_discussion_blocked: {status: 403, error: "The owner stopped this link holder from posting. Ask the owner to allow your posts again."},
  link_discussion_paused: {status: 403, error: "The owner paused posts from share links. Try again later."},
  conflict: {status: 409, error: "This message's key was already used for a different message. Send it as a new message."},
  link_name_already_set: {status: 409, error: "This link holder already has a name. Post with that name, or with none."},
  discussion_limit_reached: {status: 413, error: "This link has reached its message limit. Ask the owner if you need to post more."},
  quota_exceeded: {status: 413, error: "The owner's workspace is full. Ask the owner to free space, then send this message again."},
  payload_too_large: {status: 413, error: "This message is too long. Shorten it, then send it again."},
};

/** A relay's refusal of a link post, in this server's words, or null when it is not one. */
export function linkChatRefusalBody(value: unknown, status: number): {ok: false; code: string; error: string} | null {
  const code = asRecord(value)?.code;
  if (typeof code !== "string" || !Object.hasOwn(LINK_CHAT_REFUSALS, code)) return null;
  const refusal = LINK_CHAT_REFUSALS[code];
  return refusal?.status === status ? {ok: false, code, error: refusal.error} : null;
}

const headers = {...SHARE_WEB_SECURITY_HEADERS, "cross-origin-resource-policy": "same-origin"};
export function opaqueLinkRefusal(): Response {
  return Response.json({ok: false, error: "not found"}, {status: 404, headers});
}
export function unavailableLinkRefusal(): Response {
  return Response.json(linkRefusalBody("link_unavailable"), {status: 503, headers});
}
export async function relayLinkRefusal(response: Response, signal: AbortSignal): Promise<Response> {
  if (response.status >= 500 && !response.redirected && !response.headers.has("location")) {
    await response.body?.cancel().catch(() => undefined);
    return unavailableLinkRefusal();
  }
  if (!response.redirected && !response.headers.has("location") && [403, 410, 429].includes(response.status) &&
      response.headers.get("content-type")?.split(";", 1)[0] === "application/json") {
    const code = parseLinkRefusal(await readBoundedJson(response, 4096, signal).catch(() => null), response.status);
    if (code) return Response.json(linkRefusalBody(code), {status: response.status, headers});
  }
  return opaqueLinkRefusal();
}
