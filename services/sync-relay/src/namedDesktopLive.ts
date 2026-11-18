import { readBoundedJson } from "@dohc/service-http";
import { validateUserWritePath } from "@dohc/workspace-core";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import { LIVE_TICKET_LIFETIME_MS } from "@dohc/live-session-contract/live-ticket";
import {
  parseNamedLiveBrowserLimits,
  type NamedLiveBrowserLimits,
} from "@dohc/ydoc-projection/named-live-browser-transport";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import { createNamedLiveBrowserSessions } from "./namedLiveBrowserSessions";
import {
  parseNamedLiveBrowserHttpLimits,
  type NamedLiveBrowserHttpLimits,
} from "./namedLiveBrowserHttp";
import { authorizeNamedLiveEditShareGrant } from "./shareAuthorization";
import {
  fileWriteSideOf,
  parseStoredAnyShareSelectorJson,
  pathVisibleThroughShare,
} from "./shareFilter";
import { hashRelayExchangeKey, verifyRelayExchangeKey } from "./linkSecurity";
import type { NamedLiveBrowserContext } from "./namedLiveBrowserAuth";
import { LiveHostingRefusal } from "./storage/serviceHostEnrollment";
import type { createLiveTickets } from "./liveTickets";
import type { SyncRelayStorage } from "./storage";
import { type LiveHostChanges } from "./relayWriteChanges";
import { observeDesktopReadiness } from "./desktopReadinessChanges";

/** The browser's live sessions, which share-web's live socket resolves with the account cookie. */
export interface MemberBrowserSessions {
  create(context: NamedLiveBrowserContext): { discriminator: string; expiresAtMs: number } | null;
  remove(discriminator: string): boolean;
}

/**
 * Desktop bearer admission shares named grant, ticket, and frame-host authority.
 * With `browser`, the same admission serves a workspace member's browser
 * through share-web: `/sync/live/member-open` and `/sync/live/member-ready`
 * take the account cookie, the relay exchange key, and the member's grant.
 */
export function createNamedDesktopLive(options: {
  browser?: { exchangeKey: string; sessions: MemberBrowserSessions };
  storage: SyncRelayStorage;
  resolveActor: ResolveActor;
  publicOrigin: string;
  hosts: ReadonlySet<string>;
  limits: NamedLiveBrowserHttpLimits;
  editorLimits: NamedLiveBrowserLimits;
  tickets: ReturnType<typeof createLiveTickets>;
  changes: LiveHostChanges;
  readinessLimits: { maxPendingRequests: number; maxPendingPerUser: number; timeoutMs: number };
  /** Whether this server's own live host hosts the documents workspace members open. */
  hostsMemberDocuments(): boolean;
  /** Why this server's live host stopped trying to host the document, if it did. */
  hostBlocked?(document: { workspaceId: string; objectId: string }): string | undefined;
}) {
  const { storage } = options,
    limits = parseNamedLiveBrowserHttpLimits(options.limits);
  const editorLimits = parseNamedLiveBrowserLimits(options.editorLimits);
  const hosts = new Set(options.hosts);
  const readinessLimits = { ...options.readinessLimits };
  for (const value of Object.values(readinessLimits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fff_ffff)
      throw new TypeError("Invalid desktop readiness bound.");
  }
  if (
    options.changes.maxListeners <
    limits.maxPendingRequests + readinessLimits.maxPendingRequests
  ) {
    throw new TypeError(
      "Frame listener capacity cannot cover desktop admission and readiness requests.",
    );
  }
  // A desktop session only opens its socket, and the desktop asks again before every connect,
  // so it lasts as long as its ticket and ends once the socket opens. It has no per-account
  // limit: a note that keeps failing to connect would push out another note's slow connect.
  const ownSessions = createNamedLiveBrowserSessions({
    ...options,
    ...limits,
    retentionMs: LIVE_TICKET_LIFETIME_MS,
    authentication: "bearer",
  });
  const browser = options.browser;
  const sessions: MemberBrowserSessions = browser?.sessions ?? ownSessions;
  const exchangeHash = browser && hashRelayExchangeKey(browser.exchangeKey);
  const route = browser ? "member" : "desktop";
  const refuse = () =>
    Response.json(
      { ok: false },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    );
  // The host's answer to hosting the document, which the desktop shows instead of waiting.
  const hostRefused = (code: LiveHostingRefusal["reason"] | "live-document-without-lineage") =>
    Response.json(
      { ok: false, code },
      { status: 409, headers: { "cache-control": "private, no-store" } },
    );
  let pending = 0;
  let readinessPending = 0;
  const pendingByUser = new Map<string, number>();
  // An open that waits for a host that is away, or for its account's tickets to expire, holds a
  // request slot. Each account may hold as many of these as readiness allows it, so one account's
  // notes cannot hold up other people's. An open beyond that is refused at once, and the desktop
  // comes back through readiness.
  const waitingOpensByUser = new Map<string, number>();
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const readiness = url.pathname === `/sync/live/${route}-ready`;
    // A desktop sends its bearer token. A browser's request comes only from share-web, with the account cookie.
    const credentialed = exchangeHash
      ? request.headers.has("cookie") &&
        !request.headers.has("authorization") &&
        request.headers.get("origin") === options.publicOrigin &&
        verifyRelayExchangeKey(request.headers.get("x-dohc-relay-exchange-key"), exchangeHash)
      : hosts.has(request.headers.get("host") ?? "") &&
        !request.headers.has("cookie") &&
        (!request.headers.has("origin") ||
          request.headers.get("origin") === options.publicOrigin) &&
        /^Bearer [^\s]+$/.test(request.headers.get("authorization") ?? "");
    if (
      (!readiness && url.pathname !== `/sync/live/${route}-open`) ||
      url.search ||
      request.method !== "POST" ||
      !credentialed ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json" ||
      request.signal.aborted ||
      (readiness
        ? readinessPending >= readinessLimits.maxPendingRequests
        : pending >= limits.maxPendingRequests)
    )
      return refuse();
    if (readiness) readinessPending++;
    else pending++;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([request.signal, storage.unavailable, lifetime.signal]);
    const timer = setTimeout(
      () => lifetime.abort(),
      readiness ? readinessLimits.timeoutMs : limits.timeoutMs,
    );
    const work = (async () => {
      let created: string | undefined;
      let heldUser: string | undefined;
      let waitingUser: string | undefined;
      try {
        const check = storage.captureStanding();
        const input = await readBoundedJson(request, limits.maxRequestBytes, signal);
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).sort().join() !== (browser ? "grantId,path" : "path,shareId")
        )
          return refuse();
        const fields = input as Record<string, unknown>;
        // A browser names its member's grant; a desktop names the share and may hold several grants on it.
        const namedGrant = browser
          ? storage.getShareGrant(parseLiveUpdateIdentifier(fields.grantId))
          : undefined;
        const shareId = browser ? namedGrant?.shareId : parseLiveUpdateIdentifier(fields.shareId);
        if (typeof fields.path !== "string" || !shareId) return refuse();
        const path = validateUserWritePath(fields.path);
        if (!path.ok || path.normalized !== fields.path || !/\.md$/i.test(path.normalized))
          return refuse();
        const share = storage.getShare(shareId);
        if (!share) return refuse();
        const credential: Record<string, string> = browser
          ? { cookie: request.headers.get("cookie")! }
          : { authorization: request.headers.get("authorization")! };
        const actor = await options.resolveActor(
          new Request(request.url, { headers: credential, signal }),
          share.workspaceId,
        );
        signal.throwIfAborted();
        check();
        if (actor.workspaceId !== share.workspaceId) return refuse();
        if (readiness) {
          const count = pendingByUser.get(actor.userId) ?? 0;
          if (count >= readinessLimits.maxPendingPerUser) return refuse();
          heldUser = actor.userId;
          pendingByUser.set(heldUser, count + 1);
        }
        const objectIdAtStart = storage.objectIdAtPathInVersion({
          workspaceId: share.workspaceId,
          versionId: "main",
          path: path.normalized,
        });
        if (!objectIdAtStart) return refuse();
        // A member's open asks this server's host for the document once. Its transaction authorizes the member.
        const selector = parseStoredAnyShareSelectorJson(share.selectorJson);
        const workspace = !!selector && "kind" in selector && selector.kind === "workspace";
        if (browser && !workspace) return refuse();
        if (workspace && options.hostsMemberDocuments()) {
          try {
            storage.ensureOwnedLiveDocument({
              intent: "member-open",
              userId: actor.userId,
              workspaceId: share.workspaceId,
              path: path.normalized,
              nowMs: Date.now(),
              guard: () => {
                signal.throwIfAborted();
                check();
              },
            });
          } catch (error) {
            if (error instanceof LiveHostingRefusal) return hostRefused(error.reason);
            throw error;
          }
        }
        let wake = () => {};
        const changed = () => wake();
        const removeHost = options.changes.subscribe(changed, {
          kind: "object",
          workspaceId: share.workspaceId,
          objectId: objectIdAtStart,
        });
        const removeWrites = observeDesktopReadiness(
          storage,
          { shareId, workspaceId: share.workspaceId, path: path.normalized },
          changed,
        );
        signal.addEventListener("abort", changed, { once: true });
        try {
          for (;;) {
            // Subscribe before the check. A host becoming ready during minting
            // must also wake this request, without a timer or another open.
            const nextChange = new Promise<void>((resolve) => {
              wake = resolve;
            });
            signal.throwIfAborted();
            check();
            const objectId = storage.objectIdAtPathInVersion({
              workspaceId: share.workspaceId,
              versionId: "main",
              path: path.normalized,
            });
            if (!objectId) return refuse();
            let authorized = false,
              counted = false;
            const grants = namedGrant
              ? [namedGrant]
              : storage.listActiveShareGrantsForRecipient(shareId, actor.userId);
            for (const grant of grants) {
              const authority = authorizeNamedLiveEditShareGrant({
                storage,
                actorUserId: actor.userId,
                grantId: grant.grantId,
              });
              if (
                !authority.ok ||
                !pathVisibleThroughShare(
                  fileWriteSideOf(authority.effectiveSelector)!,
                  path.normalized,
                )
              )
                continue;
              authorized = true;
              // A document with no live-editing history waits for its owner's desktop to start one.
              // The open says so at once. The readiness wait keeps waiting for the host.
              if (
                !readiness &&
                options.hostBlocked?.({ workspaceId: share.workspaceId, objectId }) ===
                  "without-lineage"
              ) {
                return hostRefused("live-document-without-lineage");
              }
              const context = {
                kind: "named" as const,
                userId: actor.userId,
                workspaceId: share.workspaceId,
                shareId,
                grantId: grant.grantId,
              };
              let session = sessions.create(context);
              if (!session) return refuse();
              created = session.discriminator;
              // A mint throws when the host changed or went away while it ran, and when the
              // account's tickets for this grant reached their limit.
              const minted = await options.tickets
                .mint({ objectId }, context, signal)
                .catch(() => "failed" as const);
              const ticket = minted === "failed" ? null : minted;
              signal.throwIfAborted();
              check();
              if (!ticket) {
                sessions.remove(created);
                created = undefined;
                // A mint refused while the host stays current, as when its binding moved during
                // the mint, waits uncounted as before.
                counted ||=
                  minted === "failed" ||
                  storage.resolveLiveObjectHostBinding(context, objectId).kind !== "current";
                continue;
              }
              if (readiness) return Response.json({ ready: true });
              // Start the full retention window after ticket minting completes.
              sessions.remove(created);
              created = undefined;
              session = sessions.create(context);
              if (!session) return refuse();
              created = session.discriminator;
              if (
                storage.objectIdAtPathInVersion({
                  workspaceId: share.workspaceId,
                  versionId: "main",
                  path: path.normalized,
                }) !== objectId
              )
                return refuse();
              const body = JSON.stringify({
                ...context,
                workspaceId: `named:${context.grantId}`,
                objectId,
                path: path.normalized,
                ...session,
                ticket,
                editorLimits,
              });
              if (Buffer.byteLength(body) > limits.maxResponseBytes) return refuse();
              signal.throwIfAborted();
              check();
              created = undefined;
              return new Response(body, {
                headers: {
                  "content-type": "application/json",
                  "cache-control": "private, no-store",
                },
              });
            }
            if (!authorized) return refuse();
            if (!readiness && counted && !waitingUser) {
              const count = waitingOpensByUser.get(actor.userId) ?? 0;
              if (count >= readinessLimits.maxPendingPerUser) return refuse();
              waitingUser = actor.userId;
              waitingOpensByUser.set(waitingUser, count + 1);
            }
            await nextChange;
          }
        } finally {
          removeHost();
          removeWrites();
          signal.removeEventListener("abort", changed);
        }
      } catch {
        return refuse();
      } finally {
        if (created) sessions.remove(created);
        if (heldUser) {
          const remaining = pendingByUser.get(heldUser)! - 1;
          if (remaining) pendingByUser.set(heldUser, remaining);
          else pendingByUser.delete(heldUser);
        }
        if (waitingUser) {
          const remaining = waitingOpensByUser.get(waitingUser)! - 1;
          if (remaining) waitingOpensByUser.set(waitingUser, remaining);
          else waitingOpensByUser.delete(waitingUser);
        }
        if (readiness) readinessPending--;
        else pending--;
        clearTimeout(timer);
      }
    })();
    if (readiness) {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
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
              } catch {
                /* The caller already cancelled. */
              }
            };
            const aborted = () => finish(false);
            signal.addEventListener("abort", aborted, { once: true });
            if (signal.aborted) aborted();
            void work.then((response) => finish(response.status === 200));
          },
          cancel() {
            lifetime.abort();
            return work.then(() => undefined);
          },
        }),
        { headers: { "content-type": "text/plain", "cache-control": "private, no-store" } },
      );
    }
    let cancel!: () => void;
    const cancelled = new Promise<Response>((resolve) => {
      cancel = () => resolve(refuse());
      signal.addEventListener("abort", cancel, { once: true });
    });
    if (signal.aborted) cancel();
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  return {
    handle,
    async resolve(request: Request, discriminator: string) {
      const context = await ownSessions.resolve(request, discriminator);
      if (context) ownSessions.remove(discriminator);
      return context;
    },
  };
}
