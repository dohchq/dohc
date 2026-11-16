import type { AppNamedBrowserMaterial } from "./appLaunch";
import { createHash } from "node:crypto";
import { namedAccountCookie } from "./namedAccountCookie";

type MaterialOptions = {
  relayUrl: string;
  publicOrigin: string;
  exchangeKey: string;
  fetchRelay(request: Request): Promise<Response>;
};

const WORKSPACE = /^[A-Za-z0-9_-]{1,128}$/;
const PUBLICATION = /^[a-f0-9]{64}$/;

function checked(options: MaterialOptions) {
  const origin = new URL(options.publicOrigin);
  if (
    origin.origin !== options.publicOrigin ||
    origin.protocol !== "https:" ||
    options.exchangeKey.length < 32
  ) {
    throw new TypeError("Named apps require an HTTPS viewer origin and relay exchange key.");
  }
  return new URL(options.relayUrl);
}

/**
 * Sends a launch's request for its publication's descriptor, summary, blobs or
 * backend to the relay's workspace path for that publication, with `credential`
 * and the exchange key. Any other request is refused without reaching the relay.
 */
function relayFetcher(
  options: MaterialOptions,
  relay: URL,
  workspaceId: string,
  publicationId: string,
  credential: Record<string, string>,
  summary: boolean,
) {
  const prefix = `/sync/link/app-publications/${publicationId}`;
  const target = `/sync/${workspaceId}/app-publications/${publicationId}/backend`;
  return async (request: Request): Promise<Response> => {
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    const refuse = () => new Response(null, { status: 404 });
    if (url.origin !== relay.origin || url.username || url.password || url.hash) return refuse();
    let path: string;
    if (request.method === "GET" && url.pathname === prefix && !url.search) {
      path = target + "/descriptor";
    } else if (
      summary &&
      request.method === "GET" &&
      url.pathname === prefix + "/summary" &&
      !url.search
    ) {
      path = target + "/summary";
    } else if (
      request.method === "GET" &&
      url.pathname.startsWith(prefix + "/blobs/") &&
      PUBLICATION.test(url.pathname.slice((prefix + "/blobs/").length))
    ) {
      const revision = url.searchParams.get("authorityRevision");
      if (
        [...url.searchParams.keys()].join() !== "authorityRevision" ||
        !revision ||
        !/^[1-9][0-9]*$/.test(revision) ||
        !Number.isSafeInteger(Number(revision))
      )
        return refuse();
      path = target + url.pathname.slice(prefix.length) + url.search;
    } else if (
      request.method === "POST" &&
      ["invoke", "upload", "file", "attempt"].some(
        (action) => url.pathname === prefix + "/backend/" + action,
      ) &&
      !url.search
    ) {
      if (request.headers.get("content-type") !== "application/json") return refuse();
      path = target + url.pathname.slice((prefix + "/backend").length);
    } else return refuse();
    const headers = new Headers({
      ...credential,
      origin: options.publicOrigin,
      "x-dohc-relay-exchange-key": options.exchangeKey,
    });
    let body: string | undefined;
    if (request.method === "POST") {
      headers.set("content-type", "application/json");
      body = await request.text();
    }
    request.signal.throwIfAborted();
    return options.fetchRelay(
      new Request(new URL(path, relay), {
        method: request.method,
        body,
        headers,
        redirect: "manual",
        signal: request.signal,
      }),
    );
  };
}

/** Bind a signed-in app launch to its workspace and publication on the trusted relay. */
export function createNamedAppMaterialResolver(
  options: MaterialOptions & {
    resolveAccount?(cookie: string, signal: AbortSignal): Promise<string | null>;
  },
) {
  const relay = checked(options);
  return async (
    workspaceId: string,
    publicationId: string,
    cookie: string | null,
    signal: AbortSignal,
  ): Promise<AppNamedBrowserMaterial> => {
    signal.throwIfAborted();
    if (!WORKSPACE.test(workspaceId) || !PUBLICATION.test(publicationId))
      return { ok: false, status: 404 };
    const accountCookie = namedAccountCookie(cookie, options.publicOrigin);
    if (!accountCookie) return { ok: false, status: 401 };
    const userId = await options.resolveAccount?.(accountCookie, signal);
    if (options.resolveAccount && !userId) return { ok: false, status: 401 };
    return {
      ok: true,
      kind: "named",
      ...(userId ? { userId } : {}),
      admissionKey: createHash("sha256").update(accountCookie).digest("hex"),
      setCookie: null,
      fetchRelay: relayFetcher(
        options,
        relay,
        workspaceId,
        publicationId,
        { cookie: accountCookie },
        true,
      ),
    };
  };
}

/**
 * Redeems a phone's launch grant on the relay for `launchHost`. The material
 * holds only the launch ID the relay returns: never the phone's sign-in.
 */
export function createPhoneAppMaterialResolver(options: MaterialOptions) {
  const relay = checked(options);
  return async (
    workspaceId: string,
    publicationId: string,
    grant: string,
    launchHost: string,
    signal: AbortSignal,
  ): Promise<AppNamedBrowserMaterial> => {
    signal.throwIfAborted();
    if (!WORKSPACE.test(workspaceId) || !PUBLICATION.test(publicationId))
      return { ok: false, status: 404 };
    let response: Response;
    try {
      response = await options.fetchRelay(
        new Request(
          new URL(`/sync/${workspaceId}/app-publications/${publicationId}/backend/redeem`, relay),
          {
            method: "POST",
            body: JSON.stringify({ grant, launchHost }),
            headers: {
              "content-type": "application/json",
              origin: options.publicOrigin,
              "x-dohc-relay-exchange-key": options.exchangeKey,
            },
            redirect: "manual",
            signal,
          },
        ),
      );
    } catch {
      signal.throwIfAborted();
      return { ok: false, status: 503 };
    }
    if (response.status >= 500) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, status: 503 };
    }
    const value: unknown = response.ok ? await response.json().catch(() => null) : null;
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).sort().join() !== "authorityRevision,launchId,userId"
    )
      return { ok: false, status: 404 };
    const { launchId, userId } = value as Record<string, unknown>;
    if (
      typeof launchId !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(launchId) ||
      typeof userId !== "string"
    )
      return { ok: false, status: 404 };
    return {
      ok: true,
      kind: "named",
      userId,
      // Rate limits follow the person, not each launch.
      admissionKey: createHash("sha256").update(`phone:${userId}`).digest("hex"),
      setCookie: null,
      // The relay names the launches it ends by this hash.
      phone: { launchHash: createHash("sha256").update(launchId).digest("hex") },
      fetchRelay: relayFetcher(
        options,
        relay,
        workspaceId,
        publicationId,
        { "x-dohc-app-launch": launchId },
        false,
      ),
    };
  };
}
