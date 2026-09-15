import {readBoundedJson} from "@dohc/service-http";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import type {ResolveActor} from "@dohc/workspace-auth/session";
import {createNamedLiveBrowserResolver} from "./namedLiveBrowserAuth";
import {authorizeNamedLiveEditShareGrant} from "./shareAuthorization";
import {hashRelayExchangeKey, verifyRelayExchangeKey} from "./linkSecurity";
import {parseNamedLiveBrowserHttpLimits, type NamedLiveBrowserHttpLimits} from "./namedLiveBrowserHttp";
import type {SyncRelayStorage} from "./storage";

/** Named invitation navigation. Coordinates identify a selection; only the account cookie authorizes it. */
export function createNamedRecipientDocuments(options: {storage: SyncRelayStorage; resolveActor: ResolveActor;
  publicOrigin: string; exchangeKey: string; limits: NamedLiveBrowserHttpLimits; maxFiles: number}) {
  const {storage, publicOrigin} = options, limits = parseNamedLiveBrowserHttpLimits(options.limits);
  if (new URL(publicOrigin).origin !== publicOrigin || !publicOrigin.startsWith("https://") ||
    options.exchangeKey.length < 32 || !Number.isSafeInteger(options.maxFiles) || options.maxFiles < 1) throw new TypeError("Invalid named navigation configuration.");
  const exchangeHash = hashRelayExchangeKey(options.exchangeKey), resolveBrowser = createNamedLiveBrowserResolver(options);
  const refuse = () => Response.json({ok: false, error: "not found"}, {status: 404, headers: {"cache-control": "private, no-store"}});
  let pending = 0;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== "/sync/live/named-documents" || url.search || request.method !== "POST" || request.signal.aborted ||
      request.headers.get("origin") !== publicOrigin || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" ||
      !verifyRelayExchangeKey(request.headers.get("x-dohc-relay-exchange-key"), exchangeHash) || pending >= limits.maxPendingRequests) return refuse();
    pending++;
    const controller = new AbortController(), abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, {once: true});
    if (request.signal.aborted) abort();
    const timer = setTimeout(abort, limits.timeoutMs);
    const cancelled = new Promise<Response>(resolve => controller.signal.addEventListener("abort", () => resolve(refuse()), {once: true}));
    const work = (async () => {
      try {
        const input = await readBoundedJson(request, limits.maxRequestBytes, controller.signal);
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).join() !== "grantId") return refuse();
        const grantId = parseLiveUpdateIdentifier((input as Record<string, unknown>).grantId);
        const grant = storage.getShareGrant(grantId), share = grant && storage.getShare(grant.shareId);
        if (!share) return refuse();
        const context = await resolveBrowser(new Request(request.url, {headers: {cookie: request.headers.get("cookie") ?? ""}, signal: controller.signal}),
          {workspaceId: share.workspaceId, shareId: share.shareId, grantId});
        controller.signal.throwIfAborted();
        if (!context) return refuse();
        const authority = authorizeNamedLiveEditShareGrant({storage, actorUserId: context.userId, grantId});
        if (!authority.ok || authority.grant.access !== "edit" || authority.share.shareId !== context.shareId || authority.share.workspaceId !== context.workspaceId) return refuse();
        const snapshot = storage.readCurrentFileState({workspaceId: context.workspaceId, versionId: "main",
          selectorPaths: authority.effectiveSelector.paths, limit: options.maxFiles});
        if (snapshot.tooMany) return refuse();
        const files: {objectId: string; path: string}[] = [];
        for (const file of snapshot.files) {
          if (file.contentKind !== "text" || !/\.md$/i.test(file.path)) continue;
          const objectId = storage.objectIdAtPathInVersion({workspaceId: context.workspaceId, versionId: "main", path: file.path});
          if (!objectId) return refuse();
          files.push({objectId, path: file.path});
        }
        const current = authorizeNamedLiveEditShareGrant({storage, actorUserId: context.userId, grantId});
        if (!current.ok || current.grant.access !== "edit" || current.share.shareId !== context.shareId || current.share.workspaceId !== context.workspaceId ||
          current.grant.generation !== authority.grant.generation) return refuse();
        controller.signal.throwIfAborted();
        const body = JSON.stringify({ userId: context.userId, workspaceId: context.workspaceId,
          shareId: context.shareId, grantId: context.grantId, files });
        if (Buffer.byteLength(body) > limits.maxResponseBytes) return refuse();
        return new Response(body, {headers: {"content-type": "application/json", "cache-control": "private, no-store"}});
      } catch {return refuse();}
      finally {pending--; clearTimeout(timer); request.signal.removeEventListener("abort", abort);}
    })();
    return Promise.race([work, cancelled]);
  };
}
