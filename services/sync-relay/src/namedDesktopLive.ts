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
import { type LiveHostChanges } from "./relayWriteChanges";
import { observeDesktopReadiness } from "./desktopReadinessChanges";

/** Desktop bearer admission shares named grant, ticket, and frame-host authority. */
export function createNamedDesktopLive(options: {
  storage: SyncRelayStorage; resolveActor: ResolveActor; publicOrigin: string; hosts: ReadonlySet<string>;
  limits: NamedLiveBrowserHttpLimits; editorLimits: NamedLiveBrowserLimits;
  tickets: ReturnType<typeof createLiveTickets>;
  changes: LiveHostChanges;
  readinessLimits: {maxPendingRequests: number; maxPendingPerUser: number; timeoutMs: number};
}) {
  const { storage } = options, limits = parseNamedLiveBrowserHttpLimits(options.limits);
  const editorLimits = parseNamedLiveBrowserLimits(options.editorLimits);
  const hosts = new Set(options.hosts);
  const readinessLimits = {...options.readinessLimits};
  for (const value of Object.values(readinessLimits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fff_ffff) throw new TypeError("Invalid desktop readiness bound.");
  }
  if (options.changes.maxListeners < limits.maxPendingRequests + readinessLimits.maxPendingRequests) {
    throw new TypeError("Frame listener capacity cannot cover desktop admission and readiness requests.");
  }
  const sessions = createNamedLiveBrowserSessions({ ...options, ...limits, authentication: "bearer" });
  const refuse = () => Response.json({ ok: false }, { status: 404, headers: { "cache-control": "private, no-store" } });
  let pending = 0;
  let readinessPending = 0;
  const pendingByUser = new Map<string, number>();
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const readiness = url.pathname === "/sync/live/desktop-ready";
    if ((!readiness && url.pathname !== "/sync/live/desktop-open") || url.search || request.method !== "POST" ||
      !hosts.has(request.headers.get("host") ?? "") || request.headers.has("cookie") ||
      (request.headers.has("origin") && request.headers.get("origin") !== options.publicOrigin) ||
      !/^Bearer [^\s]+$/.test(request.headers.get("authorization") ?? "") ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" ||
      request.signal.aborted || (readiness ? readinessPending >= readinessLimits.maxPendingRequests : pending >= limits.maxPendingRequests)) return refuse();
    if (readiness) readinessPending++; else pending++;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([request.signal, storage.unavailable, lifetime.signal]);
    const timer = setTimeout(() => lifetime.abort(), readiness ? readinessLimits.timeoutMs : limits.timeoutMs);
    const work = (async () => {
      let created: string | undefined;
      let heldUser: string | undefined;
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
        if (readiness) {
          const count = pendingByUser.get(actor.userId) ?? 0;
          if (count >= readinessLimits.maxPendingPerUser) return refuse();
          heldUser = actor.userId;
          pendingByUser.set(heldUser, count + 1);
        }
        const objectIdAtStart = storage.objectIdAtPathInVersion({workspaceId: share.workspaceId, versionId: "main", path: path.normalized});
        if (!objectIdAtStart) return refuse();
        let wake = () => {};
        const changed = () => wake();
        const removeHost = options.changes.subscribe(changed, {workspaceId: share.workspaceId, objectId: objectIdAtStart});
        const removeWrites = observeDesktopReadiness(storage, {shareId, workspaceId: share.workspaceId, path: path.normalized}, changed);
        signal.addEventListener("abort", changed, {once: true});
        try { for (;;) {
          // Subscribe before the check. A host becoming ready during minting
          // must also wake this request, without a timer or another open.
          const nextChange = new Promise<void>(resolve => { wake = resolve; });
          signal.throwIfAborted(); check();
          const objectId = storage.objectIdAtPathInVersion({ workspaceId: share.workspaceId, versionId: "main", path: path.normalized });
          if (!objectId) return refuse();
          let authorized = false;
          for (const grant of storage.listActiveShareGrantsForRecipient(shareId, actor.userId)) {
            const authority = authorizeNamedLiveEditShareGrant({ storage, actorUserId: actor.userId, grantId: grant.grantId });
            if (!authority.ok || !authority.effectiveSelector.paths.some(root => path.normalized === root || path.normalized.startsWith(`${root}/`))) continue;
            authorized = true;
            const context = { kind: "named" as const, userId: actor.userId, workspaceId: share.workspaceId, shareId, grantId: grant.grantId };
            let session = sessions.create(context);
            if (!session) return refuse();
            created = session.discriminator;
            const ticket = await options.tickets.mint({ objectId }, context, signal).catch(() => null);
            signal.throwIfAborted(); check();
            if (!ticket) { sessions.remove(created); created = undefined; continue; }
            if (readiness) return Response.json({ ready: true });
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
          if (!authorized) return refuse();
          await nextChange;
        }
        } finally {
          removeHost(); removeWrites(); signal.removeEventListener("abort", changed);
        }
      } catch { return refuse(); }
      finally {
        if (created) sessions.remove(created);
        if (heldUser) {
          const remaining = pendingByUser.get(heldUser)! - 1;
          if (remaining) pendingByUser.set(heldUser, remaining); else pendingByUser.delete(heldUser);
        }
        if (readiness) readinessPending--; else pending--;
        clearTimeout(timer);
      }
    })();
    if (readiness) {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("waiting\n"));
          let finished = false;
          const finish = (ready: boolean) => {
            if (finished) return;
            finished = true;
            signal.removeEventListener("abort", aborted);
            try {
              controller.enqueue(encoder.encode(ready ? "ready\n" : "unavailable\n"));
              controller.close();
            } catch { /* The caller already cancelled. */ }
          };
          const aborted = () => finish(false);
          signal.addEventListener("abort", aborted, {once: true});
          if (signal.aborted) aborted();
          void work.then(response => finish(response.status === 200));
        },
        cancel() { lifetime.abort(); return work.then(() => undefined); },
      }), {headers: {"content-type": "text/plain", "cache-control": "private, no-store"}});
    }
    let cancel!: () => void;
    const cancelled = new Promise<Response>(resolve => { cancel = () => resolve(refuse()); signal.addEventListener("abort", cancel, { once: true }); });
    if (signal.aborted) cancel();
    try { return await Promise.race([work, cancelled]); }
    finally { signal.removeEventListener("abort", cancel); }
  }
  return { handle, resolve: sessions.resolve.bind(sessions) };
}
