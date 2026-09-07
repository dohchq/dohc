import { getCookies } from "better-auth/cookies";
import { readBoundedJson } from "@dohc/service-http";
import { LIVE_UPDATE_IDENTIFIER_MAX_BYTES, parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";

// Quotes and backslashes double in JSON; other permitted identifier bytes do not expand.
const largestIdentifier = "\\".repeat(LIVE_UPDATE_IDENTIFIER_MAX_BYTES);
const minimumRequestBytes = Buffer.byteLength(JSON.stringify({ grantId: largestIdentifier }));
const minimumResponseBytes = Buffer.byteLength(JSON.stringify({ userId: largestIdentifier, workspaceId: largestIdentifier, shareId: largestIdentifier, grantId: largestIdentifier }));

export interface NamedLiveBrowserClientLimits {
  maxPendingRequests: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  timeoutMs: number;
}

export interface NamedLiveBrowserSessionContext {
  userId: string;
  workspaceId: string;
  shareId: string;
  grantId: string;
}

interface NamedLiveBrowserBootstrap {
  discriminator: string;
  expiresAtMs: number;
}

export function parseNamedLiveBrowserClientLimits(value: unknown): NamedLiveBrowserClientLimits {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "maxPendingRequests,maxRequestBytes,maxResponseBytes,timeoutMs") {
    throw new TypeError("Invalid named browser transport limits.");
  }
  const limits = { ...value } as NamedLiveBrowserClientLimits;
  if (Object.values(limits).some(number => !Number.isSafeInteger(number) || number <= 0) || limits.timeoutMs > 2_147_483_647 ||
      limits.maxRequestBytes < minimumRequestBytes || limits.maxResponseBytes < minimumResponseBytes) {
    throw new TypeError("Invalid named browser transport limits.");
  }
  return limits;
}

export function createNamedLiveBrowserClient(options: {
  relayUrl: string;
  publicOrigin: string;
  exchangeKey: string;
  limits: NamedLiveBrowserClientLimits;
  fetchRelay: (request: Request) => Promise<Response>;
}) {
  const limits = parseNamedLiveBrowserClientLimits(options.limits);
  const origin = new URL(options.publicOrigin);
  if (origin.origin !== options.publicOrigin || origin.protocol !== "https:" || options.exchangeKey.length < 32) {
    throw new TypeError("Named browser sessions require an HTTPS origin and relay exchange key.");
  }
  const accountCookies = getCookies({ baseURL: options.publicOrigin });
  const cookieName = accountCookies.sessionToken.name;
  const cookieNames = new Set([cookieName, accountCookies.dontRememberToken.name]);
  let pending = 0;
  const refusal = () => Response.json({ ok: false, error: "not found" }, { status: 404 });

  function exchange(request: Request): Promise<NamedLiveBrowserBootstrap | null>;
  function exchange(request: Request, discriminator: string): Promise<NamedLiveBrowserSessionContext | null>;
  async function exchange(request: Request, discriminator?: string): Promise<NamedLiveBrowserBootstrap | NamedLiveBrowserSessionContext | null> {
    if (request.signal.aborted || pending >= limits.maxPendingRequests) return null;
    pending++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, limits.timeoutMs);
    const cancelled = new Promise<null>(resolve => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
    const work = (async (): Promise<NamedLiveBrowserBootstrap | NamedLiveBrowserSessionContext | null> => {
      let response: Response | undefined;
      try {
        const cookies = new Map<string, string>();
        for (const part of (request.headers.get("cookie") ?? "").split(";")) {
          const pair = part.trim();
          const separator = pair.indexOf("=");
          if (separator < 1) continue;
          const name = pair.slice(0, separator);
          if (!cookieNames.has(name)) continue;
          if (cookies.has(name)) return null;
          cookies.set(name, pair);
        }
        if (!cookies.has(cookieName)) return null;
        let input: unknown;
        if (discriminator === undefined) {
          const value = await readBoundedJson(request, limits.maxRequestBytes, controller.signal);
          if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "grantId") return null;
          input = { grantId: parseLiveUpdateIdentifier((value as Record<string, unknown>).grantId, "grant ID") };
        } else {
          if (!/^[A-Za-z0-9_-]{12}$/u.test(discriminator)) return null;
          input = { discriminator };
        }
        const body = JSON.stringify(input);
        if (Buffer.byteLength(body) > limits.maxRequestBytes) return null;
        response = await options.fetchRelay(new Request(new URL(
          discriminator === undefined ? "/sync/live/named-sessions" : "/sync/live/named-sessions/resolve", options.relayUrl), {
          method: "POST", redirect: "manual", signal: controller.signal, body,
          headers: { "content-type": "application/json", cookie: [...cookies.values()].join("; "), origin: options.publicOrigin,
            "x-dohc-relay-exchange-key": options.exchangeKey },
        }));
        controller.signal.throwIfAborted();
        if (response.status !== 200 || response.redirected || response.headers.has("location") ||
            response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
        const result = await readBoundedJson(response, limits.maxResponseBytes, controller.signal);
        if (!result || typeof result !== "object" || Array.isArray(result)) return null;
        const record = result as Record<string, unknown>;
        if (discriminator === undefined) {
          const expiresAtMs = record.expiresAtMs;
          if (Object.keys(record).sort().join(",") !== "discriminator,expiresAtMs" ||
              typeof record.discriminator !== "string" || !/^[A-Za-z0-9_-]{12}$/u.test(record.discriminator) ||
              typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) return null;
          return { discriminator: record.discriminator, expiresAtMs };
        } else {
          if (Object.keys(record).sort().join(",") !== "grantId,shareId,userId,workspaceId") return null;
          return {
            userId: parseLiveUpdateIdentifier(record.userId, "named session context"),
            workspaceId: parseLiveUpdateIdentifier(record.workspaceId, "named session context"),
            shareId: parseLiveUpdateIdentifier(record.shareId, "named session context"),
            grantId: parseLiveUpdateIdentifier(record.grantId, "named session context"),
          };
        }
      } catch { return null; }
      finally {
        await response?.body?.cancel().catch(() => undefined);
        pending--;
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
      }
    })();
    return Promise.race([work, cancelled]);
  }

  return {
    async bootstrap(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== "/api/live/named-session" || url.search || request.method !== "POST" ||
          request.headers.get("host") !== origin.host || request.headers.get("origin") !== options.publicOrigin ||
          request.headers.get("sec-fetch-site") === "cross-site" ||
          request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return refusal();
      const result = await exchange(request);
      return result ? Response.json(result) : refusal();
    },
    async resolve(request: Request, discriminator: string): Promise<NamedLiveBrowserSessionContext | null> {
      return exchange(request, discriminator);
    },
  };
}
