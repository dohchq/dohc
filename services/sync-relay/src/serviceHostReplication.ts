import {createWorkspaceReplicationRoutes} from "./workspaceReplicationRoutes";
import {createWorkspaceBlobRoutes} from "./workspaceBlobRoutes";
import {createServiceHostFeed} from "./serviceHostFeed";
import type {SyncRelayStorage} from "./storage";
import {errorResponse, notFound} from "./errors";

/**
 * Ordinary replication for a credential this server derived for one of its
 * own replicas: a service host's, or an automation replica's. `authorize`
 * answers the workspace owner the credential acts for, or null. It enters
 * only replication, never an account resolver or share route. With
 * `hostedFeed`, the same credential also reads the service host's scoped feed
 * under `/sync/:workspaceId/hosted/`.
 */
export function createServiceHostReplication(options: {
  storage: SyncRelayStorage;
  prefix: string;
  authorize(input: {workspaceId: string; bearer: string; method: string; pathname: string}): string | null;
  hostedFeed?: boolean;
}) {
  // It passes no session reauthentication, so a held log read answers at once.
  const replication = createWorkspaceReplicationRoutes(options.storage, Date.now, {wakeLog() {}, wait: async () => {}});
  const blobs = createWorkspaceBlobRoutes(options.storage, Date.now);
  const feed = options.hostedFeed ? createServiceHostFeed(options.storage) : undefined;
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url), parts = url.pathname.split("/");
      if (parts[1] !== "sync" || parts.length < 4) throw notFound();
      const workspaceId = decodeURIComponent(parts[2]!);
      const authorization = request.headers.get("authorization") ?? "";
      if (!authorization.startsWith(`Bearer ${options.prefix}`) || request.headers.has("cookie")) throw notFound();
      const credential = {workspaceId, bearer: authorization.slice(7), method: request.method, pathname: url.pathname};
      const ownerUserId = options.authorize(credential);
      if (!ownerUserId) throw notFound();
      const guard = () => {request.signal.throwIfAborted(); if (options.authorize(credential) !== ownerUserId) throw notFound();};
      const actor = {userId: ownerUserId};
      if (parts[3] === "hosted") {
        if (!feed) throw notFound();
        let route: string[];
        try {route = parts.slice(4).map(decodeURIComponent);} catch {throw notFound();}
        return await feed(request, {workspaceId, route, actor, guard});
      }
      if (parts[3] === "bootstrap") return await replication.respondToWorkspaceReplication(request, {route: "bootstrap", workspaceId}, actor, guard);
      if (parts[3] === "log" && parts.length === 4) return await replication.respondToWorkspaceReplication(request, {route: "log", workspaceId}, actor, guard);
      if (parts[3] === "log" && parts.length === 6) return await replication.respondToWorkspaceReplication(request,
        {route: "log-coordinate", workspaceId, originId: decodeURIComponent(parts[4]!), originSeq: Number(parts[5])}, actor, guard);
      if (parts[3] === "blobs" && parts[4] === "have") return await blobs(request, {route: "blob-have", workspaceId}, guard);
      if (parts[3] === "blobs" && parts[4]) return await blobs(request, {route: "blob", workspaceId, sha256: parts[4]}, guard);
      throw notFound();
    } catch (error) {return errorResponse(error);}
  };
}
