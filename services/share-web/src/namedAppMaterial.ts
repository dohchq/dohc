import type { AppNamedBrowserMaterial } from "./appLaunch";
import { createHash } from "node:crypto";
import { namedAccountCookie } from "./namedAccountCookie";

/** Bind a signed-in app launch to its workspace and publication on the trusted relay. */
export function createNamedAppMaterialResolver(options: {
  relayUrl: string; publicOrigin: string; exchangeKey: string;
  fetchRelay(request: Request): Promise<Response>;
}) {
  const origin = new URL(options.publicOrigin), relay = new URL(options.relayUrl);
  if (origin.origin !== options.publicOrigin || origin.protocol !== "https:" || options.exchangeKey.length < 32) {
    throw new TypeError("Named apps require an HTTPS viewer origin and relay exchange key.");
  }
  return async (workspaceId: string, publicationId: string, cookie: string | null, signal: AbortSignal): Promise<AppNamedBrowserMaterial> => {
    signal.throwIfAborted();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId) || workspaceId.includes("\n") || publicationId.length !== 64 || !/^[a-f0-9]{64}$/.test(publicationId)) return { ok: false, status: 404 };
    const accountCookie = namedAccountCookie(cookie, options.publicOrigin);
    if (!accountCookie) return { ok: false, status: 401 };
    const prefix = `/sync/link/app-publications/${publicationId}`;
    const target = `/sync/${workspaceId}/app-publications/${publicationId}/backend`;
    return {
      ok: true, kind: "named", admissionKey: createHash("sha256").update(accountCookie).digest("hex"), setCookie: null,
      async fetchRelay(request: Request): Promise<Response> {
        request.signal.throwIfAborted();
        const url = new URL(request.url);
        const refuse = () => new Response(null, { status: 404 });
        if (url.origin !== relay.origin || url.username || url.password || url.hash) return refuse();
        let path: string;
        if (request.method === "GET" && url.pathname === prefix && !url.search) {
          path = target + "/descriptor";
        } else if (request.method === "GET" && url.pathname === prefix + "/summary" && !url.search) {
          path = target + "/summary";
        } else if (request.method === "GET" && url.pathname.startsWith(prefix + "/blobs/") && /^[a-f0-9]{64}$/.test(url.pathname.slice((prefix + "/blobs/").length))) {
          const revision = url.searchParams.get("authorityRevision");
          if ([...url.searchParams.keys()].join() !== "authorityRevision" || !revision || !/^[1-9][0-9]*$/.test(revision) || !Number.isSafeInteger(Number(revision))) return refuse();
          path = target + url.pathname.slice(prefix.length) + url.search;
        } else if (request.method === "POST" && ["invoke", "upload", "file", "attempt"].some(action => url.pathname === prefix + "/backend/" + action) && !url.search) {
          if (request.headers.get("content-type") !== "application/json") return refuse();
          path = target + url.pathname.slice((prefix + "/backend").length);
        } else return refuse();
        const headers = new Headers({ cookie: accountCookie, origin: options.publicOrigin, "x-dohc-relay-exchange-key": options.exchangeKey });
        let body: string | undefined;
        if (request.method === "POST") {
          headers.set("content-type", "application/json");
          body = await request.text();
        }
        request.signal.throwIfAborted();
        return options.fetchRelay(new Request(new URL(path, relay), { method: request.method, body, headers, redirect: "manual", signal: request.signal }));
      },
    };
  };
}
