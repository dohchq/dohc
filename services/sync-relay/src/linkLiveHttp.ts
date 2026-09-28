import type {BinaryLike} from "node:crypto";
import {readBoundedJson} from "@dohc/service-http";
import {createLinkLiveBrowserResolver} from "./linkLiveBrowserAuth";
import {createAccountlessPathProjection} from "./accountlessPathProjection";
import {authorizeLinkShareAction} from "./shareAuthorization";
import {hashRelayExchangeKey, verifyRelayExchangeKey} from "./linkSecurity";
import {parseNamedLiveRouteLimits, type NamedLiveRouteLimits} from "./namedLiveRoutes";
import type {SyncRelayStorage} from "./storage";
import {linkRefusal, opaqueLinkRefusal} from "./linkRefusal";

/** Private relay metadata. The viewer receives only the selected object ID. */
export function createLinkLiveHttp(options: {storage: SyncRelayStorage; linkKey: BinaryLike;
  hosts: ReadonlySet<string>; publicOrigin: string; exchangeKey: string; limits: NamedLiveRouteLimits}) {
  const limits = parseNamedLiveRouteLimits(options.limits), hosts = new Set(options.hosts);
  const origin = new URL(options.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin || options.exchangeKey.length < 32 || !hosts.size) throw new TypeError("Invalid link live metadata configuration.");
  const exchangeHash = hashRelayExchangeKey(options.exchangeKey), resolver = createLinkLiveBrowserResolver(options);
  const refused = opaqueLinkRefusal;
  let pending = 0;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url), document = url.pathname === "/sync/live/link-document";
    if ((!document && url.pathname !== "/sync/live/link-session") || url.search || request.method !== "POST" ||
      !hosts.has(request.headers.get("host") ?? "") || request.headers.get("origin") !== options.publicOrigin ||
      !verifyRelayExchangeKey(request.headers.get("x-dohc-relay-exchange-key"), exchangeHash) ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" ||
      request.signal.aborted || pending >= limits.maxPendingRequests) return refused();
    pending++;
    const signal = AbortSignal.any([request.signal, options.storage.unavailable, AbortSignal.timeout(limits.upgradeTimeoutMs)]);
    try {
      const input: unknown = await readBoundedJson(request, limits.maxRequestBytes, signal);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join() !== (document ? "discriminator,path" : "discriminator")) return refused();
      const value = input as Record<string, unknown>;
      if (typeof value.discriminator !== "string") return refused();
      const context = await resolver.resolve(new Request(request.url, {headers: request.headers, signal}), value.discriminator, document ? "read" : "edit");
      signal.throwIfAborted();
      if (!context) return refused();
      const body = (() => {
        if (document) {
          if (typeof value.path !== "string" || value.path.length > 1024 || !/\.md$/i.test(value.path)) return null;
          const authority = authorizeLinkShareAction({storage: options.storage, grantId: context.grantId, action: "read"});
          if (!authority.ok) return null;
          const path = createAccountlessPathProjection(authority.effectiveSelector).resolvePath(value.path);
          if (path === null) return null;
          const objectId = options.storage.objectIdAtPathInVersion({workspaceId: context.workspaceId, versionId: authority.effectiveSelector.versionId ?? "main", path});
          if (!objectId) return null;
          if (authority.effectiveSelector.access === "view") return linkRefusal("link_view_access");
          if (authority.effectiveSelector.access === "comment") return linkRefusal("link_comment_access");
          if (!authorizeLinkShareAction({storage: options.storage, grantId: context.grantId, action: "live-edit"}).ok) return null;
          const current = options.storage.resolveLiveObjectHostBinding(context, objectId);
          if (current.kind === "refused" && (current.reason === "host-unavailable" || current.reason === "stale-document")) return linkRefusal("link_live_unavailable");
          return current.kind === "current" && current.binding.currentPath === path ? {objectId} : null;
        }
        // Ticket minting has already enrolled this profile before a gateway can open.
        const principal = options.storage.getLinkPrincipalForGrantProfile(context.grantId, context.profileTokenHash);
        const session = options.storage.findLinkSessionByCapabilityHash(context.capabilityHash);
        if (!principal || principal.blockedAtMs !== null || session?.principalId !== principal.principalId || session.sessionId !== context.sessionId) return null;
        return {kind: "link", workspaceId: context.workspaceId, shareId: context.shareId, grantId: context.grantId,
          principalId: principal.principalId, sessionId: context.sessionId};
      })();
      signal.throwIfAborted();
      if (!body) return refused();
      if (body instanceof Response) return body;
      const encoded = JSON.stringify(body);
      if (Buffer.byteLength(encoded) > limits.maxResponseBytes) return refused();
      return new Response(encoded, {headers: {"content-type": "application/json", "cache-control": "private, no-store"}});
    } catch {return refused();}
    finally {pending--;}
  };
}
