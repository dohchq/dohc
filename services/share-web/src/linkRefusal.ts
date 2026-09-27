import {readBoundedJson} from "@dohc/service-http";
import {linkRefusalBody, parseLinkRefusal} from "@dohc/security-contract/link-refusal";

const headers = {"cache-control": "private, no-store", "cross-origin-resource-policy": "same-origin", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer"};
export function opaqueLinkRefusal(): Response {
  return Response.json({ok: false, error: "not found"}, {status: 404, headers});
}
export async function relayLinkRefusal(response: Response, signal: AbortSignal): Promise<Response> {
  if (response.status >= 500 && !response.redirected && !response.headers.has("location")) {
    await response.body?.cancel().catch(() => undefined);
    return Response.json(linkRefusalBody("link_live_unavailable"), {status: 503, headers});
  }
  if (!response.redirected && !response.headers.has("location") && [403, 429].includes(response.status) &&
      response.headers.get("content-type")?.split(";", 1)[0] === "application/json") {
    const code = parseLinkRefusal(await readBoundedJson(response, 4096, signal).catch(() => null), response.status);
    if (code) return Response.json(linkRefusalBody(code), {status: response.status, headers});
  }
  return opaqueLinkRefusal();
}
