import { getCookies, parseSetCookieHeader, splitSetCookieHeader } from "better-auth/cookies";
import { isIP } from "node:net";

export interface AccountAuthConfig {
  upstreamUrl: string;
  publicOrigin: string;
}

interface AccountAuthOptions extends AccountAuthConfig {
  fetchAuth?: (request: Request) => Promise<Response>;
  maxRequestBytes: number;
  maxResponseBytes: number;
  timeoutMs: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function userProjection(value: unknown): { id: string; name: string } | null {
  if (!record(value) || typeof value.id !== "string" || value.id.length === 0 ||
      typeof value.name !== "string") return null;
  return { id: value.id, name: value.name };
}

async function boundedJson(
  message: Request | Response,
  limit: number,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const reader = message.body?.getReader();
  if (!reader) throw new Error("missing body");
  const abort = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      if (next.value.byteLength > limit - length) throw new Error("body too large");
      length += next.value.byteLength;
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createAccountAuthHandler(options: AccountAuthOptions) {
  const origin = new URL(options.publicOrigin);
  const cookies = getCookies({ baseURL: options.publicOrigin });
  const responseCookieNames = new Set(Object.values(cookies).map((cookie) => cookie.name));
  const requestCookieNames = new Set([cookies.sessionToken.name, cookies.dontRememberToken.name]);
  const fetchAuth = options.fetchAuth ?? ((request: Request) => fetch(request));

  function accountCookie(header: string | null): string | null {
    const selected = new Map<string, string>();
    for (const part of (header ?? "").split(";")) {
      const pair = part.trim();
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      if (separator < 1 || !requestCookieNames.has(name)) continue;
      if (selected.has(name)) throw new Error("duplicate account cookie");
      selected.set(name, pair);
    }
    return selected.size ? [...selected.values()].join("; ") : null;
  }

  function checkedCookies(upstream: Response, operation: string): string[] {
    const lines = upstream.headers.getSetCookie();
    let hasSession = false;
    let clearsSession = false;
    const seen = new Set<string>();
    for (const line of lines) {
      const parsed = parseSetCookieHeader(line);
      if (splitSetCookieHeader(line).length !== 1 || parsed.size !== 1) throw new Error("invalid auth cookie");
      const [name, attributes] = [...parsed][0]!;
      if (!responseCookieNames.has(name) || seen.has(name) ||
          attributes.path !== "/" || "domain" in attributes ||
          !attributes.secure || !attributes.httponly || attributes.samesite !== "lax") {
        throw new Error("invalid auth cookie");
      }
      seen.add(name);
      if (name === cookies.sessionToken.name) {
        const maxAge = attributes["max-age"];
        hasSession = attributes.value.length > 0 &&
          (maxAge === undefined || (Number.isSafeInteger(maxAge) && maxAge > 0));
        clearsSession = attributes.value === "" && attributes["max-age"] === 0;
      }
    }
    if (operation === "sign-in" && !hasSession) throw new Error("missing session cookie");
    if (operation === "sign-out" && !clearsSession) throw new Error("missing session expiry");
    return lines;
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const operation = url.pathname.slice("/api/account/".length);
    const mutation = operation === "sign-in" || operation === "sign-out";
    const refuse = (status: number): Response => Response.json({ ok: false }, { status });
    if (url.search || (operation !== "session" && !mutation) ||
        request.method !== (mutation ? "POST" : "GET") ||
        request.headers.get("host") !== origin.host ||
        request.headers.get("sec-fetch-site") === "cross-site" ||
        (mutation && request.headers.get("origin") !== options.publicOrigin) ||
        (!mutation && request.headers.has("origin") && request.headers.get("origin") !== options.publicOrigin) ||
        (mutation && request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")) {
      return refuse(404);
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const deadline = setTimeout(() => controller.abort(), options.timeoutMs);
    let upstreamStarted = false;
    let upstreamResponse: Response | undefined;
    try {
      const headers = new Headers({ accept: "application/json" });
      // main overwrites this header from the socket and configured trusted proxies.
      const clientAddress = request.headers.get("x-dohc-share-web-client-ip");
      if (clientAddress && isIP(clientAddress) !== 0 && !clientAddress.includes("%")) {
        headers.set("x-forwarded-for", clientAddress);
      }
      for (const name of ["origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"]) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      const cookie = accountCookie(request.headers.get("cookie"));
      if (cookie) headers.set("cookie", cookie);
      let body: string | undefined;
      if (mutation) {
        const input = await boundedJson(request, options.maxRequestBytes, controller.signal);
        if (!record(input)) return refuse(404);
        if (operation === "sign-in") {
          if (Object.keys(input).sort().join(",") !== "email,password" ||
              typeof input.email !== "string" || typeof input.password !== "string") return refuse(404);
          body = JSON.stringify({ email: input.email, password: input.password });
        } else {
          if (Object.keys(input).length !== 0) return refuse(404);
          body = "{}";
        }
        headers.set("content-type", "application/json");
      }
      controller.signal.throwIfAborted();
      const path = operation === "session" ? "get-session" : operation === "sign-in" ? "sign-in/email" : "sign-out";
      upstreamStarted = true;
      const upstream = await fetchAuth(new Request(new URL(`/api/auth/${path}`, options.upstreamUrl), {
        method: request.method, headers, body, redirect: "manual", signal: controller.signal,
      }));
      upstreamResponse = upstream;
      if (upstream.status === 429) {
        await upstream.body?.cancel().catch(() => undefined);
        const response = refuse(429);
        const retryAfter = upstream.headers.get("x-retry-after") ?? upstream.headers.get("retry-after");
        if (retryAfter !== null && /^[0-9]{1,16}$/.test(retryAfter) && Number.isSafeInteger(Number(retryAfter))) {
          response.headers.set("retry-after", String(Number(retryAfter)));
        }
        return response;
      }
      if (upstream.status !== 200 || upstream.headers.has("location") || upstream.redirected) {
        await upstream.body?.cancel().catch(() => undefined);
        return refuse(upstream.status >= 400 && upstream.status < 500 ? 401 : 503);
      }
      if (upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        await upstream.body?.cancel().catch(() => undefined);
        return refuse(503);
      }
      const result = await boundedJson(upstream, options.maxResponseBytes, controller.signal);
      const setCookies = checkedCookies(upstream, operation);
      let output: unknown;
      if (operation === "session" && result === null) output = { user: null };
      else if (operation === "sign-out") {
        if (!record(result) || result.success !== true) return refuse(503);
        output = { ok: true };
      } else {
        const user = record(result) ? userProjection(result.user) : null;
        if (!user || !record(result)) return refuse(503);
        if (operation === "sign-in" && result.redirect !== false) return refuse(503);
        if (operation === "session" &&
            (!record(result.session) || result.session.userId !== user.id)) return refuse(503);
        output = operation === "sign-in" ? { ok: true, user } : { user };
      }
      const response = Response.json(output);
      for (const line of setCookies) response.headers.append("set-cookie", line);
      return response;
    } catch {
      return refuse(upstreamStarted ? 503 : 404);
    } finally {
      await upstreamResponse?.body?.cancel().catch(() => undefined);
      clearTimeout(deadline);
      request.signal.removeEventListener("abort", abort);
    }
  };
}
