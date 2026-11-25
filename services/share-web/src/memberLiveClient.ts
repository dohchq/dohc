import { readBoundedJson } from "@dohc/service-http";
import { parseLiveTicketToken } from "@dohc/live-session-contract/live-ticket";
import {
  parseLiveUpdateDigest,
  parseLiveUpdateIdentifier,
} from "@dohc/live-session-contract/live-update-admission";
import { namedAccountCookie } from "./namedAccountCookie";
import {
  parseNamedLiveBrowserClientLimits,
  type NamedLiveBrowserClientLimits,
} from "./namedLiveBrowserClient";
import { createNamedRelayCalls } from "./namedRelayCalls";
import { isSessionDiscriminator } from "./sessionDiscriminator";
import { selfHostLiveProfile } from "../../sync-relay/src/selfHostLiveProfile";

export const MEMBER_OPEN_PATH = "/api/live/member-open";
export const MEMBER_READY_PATH = "/api/live/member-ready";
export const OWNER_OPEN_PATH = "/api/live/owner-open";
const READY = "waiting\nready\n",
  UNAVAILABLE = "waiting\nunavailable\n";
const REFUSAL_CODE = /^[a-z][a-z_-]{0,63}$/u;

/**
 * A workspace member's browser opens a page for editing. The relay finds the
 * person from the account cookie, enrolls the page with its host, and answers
 * with a live session this server's socket resolves. A host's refusal keeps
 * its code, so the page can say why. The workspace's owner opens a page as
 * their phone does, through the relay's page open, which answers with a
 * ticket for the owner's live socket.
 */
export function createMemberLiveClient(options: {
  relayUrl: string;
  publicOrigin: string;
  exchangeKey: string;
  limits: NamedLiveBrowserClientLimits;
  /** The relay's bounds on readiness waits. Defaults to the self-hosted relay's. */
  readiness?: { maxPendingRequests: number; maxPendingPerUser: number };
  fetchRelay(request: Request): Promise<Response>;
}) {
  const limits = parseNamedLiveBrowserClientLimits(options.limits),
    origin = new URL(options.publicOrigin);
  const readiness = options.readiness ?? selfHostLiveProfile().desktopReadiness;
  if (
    origin.protocol !== "https:" ||
    origin.origin !== options.publicOrigin ||
    options.exchangeKey.length < 32
  )
    throw new TypeError("Invalid member live transport.");
  const refusal = () =>
    Response.json(
      { ok: false, error: "not found" },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    );
  const unavailable = () =>
    Response.json(
      { ok: false, error: "unavailable" },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  const calls = createNamedRelayCalls({
    maxPending: limits.maxPendingRequests,
    timeoutMs: limits.timeoutMs,
    unrefDeadline: true,
    refuse: refusal,
    unavailable,
    fetchRelay: (input) => options.fetchRelay(input),
  });
  // A readiness wait holds its slot until the host is ready, so waits have their own pool and never hold up an open.
  const readyCalls = createNamedRelayCalls({
    maxPending: readiness.maxPendingRequests,
    timeoutMs: limits.timeoutMs,
    unrefDeadline: true,
    refuse: refusal,
    unavailable,
    fetchRelay: (input) => options.fetchRelay(input),
  });
  const readyByCookie = new Map<string, number>();
  const answer = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
  // The relay's page open answers the owner's browser as it answers the phone, with a ticket for the owner's socket.
  const ownerAnswer = (result: unknown) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) return refusal();
    const row = result as Record<string, unknown>;
    if (row.status === "preparing") return answer({ preparing: true });
    if (row.status === "refused")
      return typeof row.reason === "string" && REFUSAL_CODE.test(row.reason)
        ? answer({ ok: false, code: row.reason }, 409)
        : refusal();
    if (
      row.status !== "ready" ||
      typeof row.expiresAtMs !== "number" ||
      row.expiresAtMs <= Date.now() ||
      !row.editorLimits ||
      typeof row.editorLimits !== "object"
    )
      return refusal();
    parseLiveTicketToken(row.ticket);
    return answer({
      objectId: parseLiveUpdateIdentifier(row.objectId, "object ID"),
      lineageClaimId: parseLiveUpdateDigest(row.lineageClaimId),
      token: row.ticket,
      limits: row.editorLimits,
    });
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const ready = url.pathname === MEMBER_READY_PATH,
      owner = url.pathname === OWNER_OPEN_PATH;
    const pool = ready ? readyCalls : calls;
    if (
      (!ready && !owner && url.pathname !== MEMBER_OPEN_PATH) ||
      url.search ||
      request.method !== "POST" ||
      request.signal.aborted ||
      request.headers.get("host") !== origin.host ||
      request.headers.get("origin") !== options.publicOrigin ||
      request.headers.get("sec-fetch-site") === "cross-site" ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json" ||
      pool.full
    )
      return refusal();
    const cookie = namedAccountCookie(request.headers.get("cookie"), options.publicOrigin);
    if (!cookie) return refusal();
    if (ready && (readyByCookie.get(cookie) ?? 0) >= readiness.maxPendingPerUser) return refusal();
    if (ready) readyByCookie.set(cookie, (readyByCookie.get(cookie) ?? 0) + 1);
    return pool.run(request, async (signal, relay) => {
      try {
        const input = await readBoundedJson(request, limits.maxRequestBytes, signal);
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).sort().join() !== (owner ? "path,workspaceId" : "grantId,path")
        )
          return refusal();
        const value = input as Record<string, unknown>;
        if (typeof value.path !== "string" || !/\.md$/iu.test(value.path)) return refusal();
        const body = JSON.stringify(
          owner
            ? { path: value.path }
            : { grantId: parseLiveUpdateIdentifier(value.grantId, "grant ID"), path: value.path },
        );
        if (Buffer.byteLength(body) > limits.maxRequestBytes) return refusal();
        const response = await relay(
          new Request(
            new URL(
              owner
                ? `/sync/${encodeURIComponent(parseLiveUpdateIdentifier(value.workspaceId, "workspace ID"))}/ops/openPage`
                : ready
                  ? "/sync/live/member-ready"
                  : "/sync/live/member-open",
              options.relayUrl,
            ),
            {
              method: "POST",
              redirect: "manual",
              signal,
              body,
              headers: {
                "content-type": "application/json",
                cookie,
                origin: options.publicOrigin,
                "x-dohc-relay-exchange-key": options.exchangeKey,
              },
            },
          ),
        );
        const kind = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (response.redirected || response.headers.has("location")) return refusal();
        if (ready) {
          // The relay holds the wait open until the host is ready. Only its last line matters here.
          if (response.status !== 200 || kind !== "text/plain") return refusal();
          const reader = response.body!.getReader(),
            decoder = new TextDecoder("utf-8", { fatal: true });
          let text = "";
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            text += decoder.decode(chunk.value, { stream: true });
            if (!READY.startsWith(text) && !UNAVAILABLE.startsWith(text)) return refusal();
          }
          return answer({ ready: text === READY });
        }
        if (!owner && response.status === 409 && kind === "application/json") {
          const refused = await readBoundedJson(response, 1024, signal).catch(() => null);
          const code =
            refused && typeof refused === "object" && !Array.isArray(refused)
              ? (refused as Record<string, unknown>).code
              : undefined;
          return typeof code === "string" && REFUSAL_CODE.test(code)
            ? answer({ ok: false, code }, 409)
            : refusal();
        }
        if (response.status !== 200 || kind !== "application/json") return refusal();
        const parsed = await readBoundedJson(response, limits.maxResponseBytes, signal);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return refusal();
        const row = parsed as Record<string, unknown>,
          ticket = row.ticket as Record<string, unknown> | null;
        if (owner) return ownerAnswer(row.ok === true ? row.result : null);
        if (
          row.kind !== "named" ||
          typeof row.discriminator !== "string" ||
          !isSessionDiscriminator(row.discriminator) ||
          row.path !== value.path ||
          row.grantId !== value.grantId ||
          !ticket ||
          typeof ticket !== "object" ||
          typeof ticket.expiresAtMs !== "number" ||
          ticket.expiresAtMs <= Date.now() ||
          !row.editorLimits ||
          typeof row.editorLimits !== "object"
        )
          return refusal();
        parseLiveTicketToken(ticket.token);
        // The browser gets what its editor needs: its session, the ticket, the document, and who it records as.
        return answer({
          discriminator: row.discriminator,
          objectId: parseLiveUpdateIdentifier(row.objectId, "object ID"),
          userId: parseLiveUpdateIdentifier(row.userId, "user ID"),
          token: ticket.token,
          limits: row.editorLimits,
        });
      } finally {
        if (ready) {
          const count = (readyByCookie.get(cookie) ?? 1) - 1;
          if (count === 0) readyByCookie.delete(cookie);
          else readyByCookie.set(cookie, count);
        }
      }
    });
  };
}
