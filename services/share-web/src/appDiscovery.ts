import { readBoundedJson } from "@dohc/service-http";
import { isSessionDiscriminator } from "./sessionDiscriminator";
import type { LinkBrowserMaterial } from "./server";
import {linkRefusalBody, parseLinkRefusal} from "@dohc/security-contract/link-refusal";

const headers = {"content-type": "application/json", "cache-control": "private, no-store", "cross-origin-resource-policy": "same-origin", "x-content-type-options": "nosniff"};
const refuse = () => Response.json({ok: false, error: "not found"}, {status: 404, headers});
const hash = /^[a-f0-9]{64}$/;

export function createAppDiscovery(options: {viewerOrigin?: string; relayUrl: string;
  fetchRelay(request: Request): Promise<Response>;
  resolveMaterial(discriminator: string, cookie: string | null, signal: AbortSignal): Promise<LinkBrowserMaterial>;
}) {
  let pending = 0;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url), query = url.searchParams;
    const viewer = new URL(options.viewerOrigin ?? request.url);
    if (request.method !== "GET" || request.headers.get("host") !== viewer.host ||
        (request.headers.has("origin") && request.headers.get("origin") !== viewer.origin) ||
        (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") ||
        [...query.keys()].some(key => key !== "session" && key !== "cursor") || query.getAll("session").length !== 1 || query.getAll("cursor").length > 1) return refuse();
    const session = query.get("session")!, cursor = query.get("cursor");
    if (!isSessionDiscriminator(session) || (cursor !== null && !hash.test(cursor))) return refuse();
    if (pending >= 16) return refuse();
    pending++;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
    let relay: Response | undefined;
    try {
      signal.throwIfAborted();
      const material = await options.resolveMaterial(session, request.headers.get("cookie"), signal);
      signal.throwIfAborted();if (!material.ok) return refuse();
      if (!options.viewerOrigin) return Response.json({publications: [], nextCursor: null}, {
        headers: {...headers, ...(material.setCookie ? {"set-cookie": material.setCookie} : {})},
      });
      const path = "/sync/link/app-publications" + (cursor ? `?cursor=${cursor}` : "");
      relay = await options.fetchRelay(new Request(new URL(path, options.relayUrl), {redirect: "manual", signal,
        headers: {authorization: `LinkCapability ${material.capabilityToken}`, "x-dohc-link-profile-secret": material.profileSecret}}));
      signal.throwIfAborted();
      if (relay.redirected || relay.headers.has("location")) return refuse();
      if (relay.status !== 200) {
        const code = parseLinkRefusal(await readBoundedJson(relay, 4096, signal), relay.status);
        return code ? Response.json(linkRefusalBody(code), {status: relay.status, headers}) : refuse();
      }
      const value = await readBoundedJson(relay, 32_768, signal);
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "nextCursor,publications") return refuse();
      const page = value as {publications: unknown; nextCursor: unknown};
      if (!Array.isArray(page.publications) || page.publications.length > 25 ||
          (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !hash.test(page.nextCursor) || (cursor !== null && page.nextCursor <= cursor)))) return refuse();
      const seen = new Set<string>();
      for (const row of page.publications) {
        if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join() !== "name,publicationId" ||
            typeof row.publicationId !== "string" || !hash.test(row.publicationId) || seen.has(row.publicationId) ||
            typeof row.name !== "string" || !row.name || row.name.length > 128 || /[\u0000-\u001f\u007f]/.test(row.name)) return refuse();
        seen.add(row.publicationId);
      }
      const fresh = await options.resolveMaterial(session, request.headers.get("cookie"), signal);
      signal.throwIfAborted();
      if (!fresh.ok || fresh.capabilityToken !== material.capabilityToken || fresh.profileSecret !== material.profileSecret) return refuse();
      return Response.json(page, {headers: {...headers, ...(fresh.setCookie ?? material.setCookie ? {"set-cookie": fresh.setCookie ?? material.setCookie!} : {})}});
    } catch {return refuse();}
    finally {await relay?.body?.cancel().catch(() => {});pending--;}
  };
}
