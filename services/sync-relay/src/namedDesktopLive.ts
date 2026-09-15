import { readBoundedJson } from "@dohc/service-http";
import { validateUserWritePath } from "@dohc/workspace-core";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import { parseNamedLiveBrowserLimits, type NamedLiveBrowserLimits } from "@dohc/ydoc-projection/named-live-browser-transport";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import { createNamedLiveBrowserSessions } from "./namedLiveBrowserSessions";
import { parseNamedLiveBrowserHttpLimits, type NamedLiveBrowserHttpLimits } from "./namedLiveBrowserHttp";
import { authorizeNamedLiveEditShareGrant } from "./shareAuthorization";
import type { createLiveTickets } from "./liveTickets";
import type { SyncRelayStorage } from "./storage";

/** Desktop bearer admission shares named grant, ticket, and frame-host authority. */
export function createNamedDesktopLive(options: {
  storage: SyncRelayStorage; resolveActor: ResolveActor; publicOrigin: string; hosts: ReadonlySet<string>;
  limits: NamedLiveBrowserHttpLimits; editorLimits: NamedLiveBrowserLimits;
  tickets: ReturnType<typeof createLiveTickets>;
}) {
  const { storage } = options, limits = parseNamedLiveBrowserHttpLimits(options.limits);
  const editorLimits = parseNamedLiveBrowserLimits(options.editorLimits);
  const hosts = new Set(options.hosts);
  const sessions = createNamedLiveBrowserSessions({ ...options, ...limits, authentication: "bearer" });
  const refuse = () => Response.json({ ok: false }, { status: 404, headers: { "cache-control": "private, no-store" } });
  let pending = 0;
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/sync/live/desktop-open" || url.search || request.method !== "POST" ||
      !hosts.has(request.headers.get("host") ?? "") || request.headers.has("cookie") ||
      (request.headers.has("origin") && request.headers.get("origin") !== options.publicOrigin) ||
      !/^Bearer [^\s]+$/.test(request.headers.get("authorization") ?? "") ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" ||
      request.signal.aborted || pending >= limits.maxPendingRequests) return refuse();
    pending++;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([request.signal, storage.unavailable, lifetime.signal]);
    const timer = setTimeout(() => lifetime.abort(), limits.timeoutMs);
    const work = (async () => {
      let created: string | undefined;
      try {
        const check = storage.captureStanding();
        const input = await readBoundedJson(request, limits.maxRequestBytes, signal);
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join() !== "path,shareId") return refuse();
        const fields = input as Record<string, unknown>;
        const shareId = parseLiveUpdateIdentifier(fields.shareId);
        if (typeof fields.path !== "string") return refuse();
        const path = validateUserWritePath(fields.path);
        if (!path.ok || path.normalized !== fields.path || !/\.md$/i.test(path.normalized)) return refuse();
        const share = storage.getShare(shareId);
        if (!share) return refuse();
        const actor = await options.resolveActor(new Request(request.url, {
          headers: { authorization: request.headers.get("authorization")! }, signal,
        }), share.workspaceId);
        signal.throwIfAborted(); check();
        if (actor.workspaceId !== share.workspaceId) return refuse();
        const objectId = storage.objectIdAtPathInVersion({ workspaceId: share.workspaceId, versionId: "main", path: path.normalized });
        if (!objectId) return refuse();
        for (const grant of storage.listActiveShareGrantsForRecipient(shareId, actor.userId)) {
          const authority = authorizeNamedLiveEditShareGrant({ storage, actorUserId: actor.userId, grantId: grant.grantId });
          if (!authority.ok) continue;
          const context = { kind: "named" as const, userId: actor.userId, workspaceId: share.workspaceId, shareId, grantId: grant.grantId };
          let session = sessions.create(context);
          if (!session) return refuse();
          created = session.discriminator;
          const ticket = await options.tickets.mint({ objectId }, context, signal);
          signal.throwIfAborted(); check();
          if (!ticket) { sessions.remove(created); created = undefined; continue; }
          // Start the full retention window after ticket minting completes.
          sessions.remove(created);
          created = undefined;
          session = sessions.create(context);
          if (!session) return refuse();
          created = session.discriminator;
          if (storage.objectIdAtPathInVersion({workspaceId: share.workspaceId, versionId: "main", path: path.normalized}) !== objectId) return refuse();
          const body = JSON.stringify({ ...context, objectId, path: path.normalized, ...session, ticket, editorLimits });
          if (Buffer.byteLength(body) > limits.maxResponseBytes) return refuse();
          signal.throwIfAborted(); check();
          created = undefined;
          return new Response(body, { headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
        }
        return refuse();
      } catch { return refuse(); }
      finally { if (created) sessions.remove(created); pending--; clearTimeout(timer); }
    })();
    let cancel!: () => void;
    const cancelled = new Promise<Response>(resolve => { cancel = () => resolve(refuse()); signal.addEventListener("abort", cancel, { once: true }); });
    if (signal.aborted) cancel();
    try { return await Promise.race([work, cancelled]); }
    finally { signal.removeEventListener("abort", cancel); }
  }
  return { handle, resolve: sessions.resolve.bind(sessions) };
}
