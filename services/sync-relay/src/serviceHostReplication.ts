import {authorizeServiceHostReplication} from "./serviceHostCredential";
import {createWorkspaceReplicationRoutes} from "./workspaceReplicationRoutes";
import {createWorkspaceBlobRoutes} from "./workspaceBlobRoutes";
import {DiscussionActivityHub} from "./discussionActivity";
import type {SyncRelayStorage} from "./storage";
import {errorResponse, notFound} from "./errors";

/** This credential enters only ordinary replication, never an account resolver or share route. */
export function createServiceHostReplication(options: {storage: SyncRelayStorage; key: Uint8Array; namespace: string}) {
  // This path parks no reads: with no capacity, a held log read answers at once.
  const replication = createWorkspaceReplicationRoutes(options.storage, Date.now, new DiscussionActivityHub({maxTotalWaiters: 0}));
  const blobs = createWorkspaceBlobRoutes(options.storage, Date.now);
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url), parts = url.pathname.split("/");
      if (parts[1] !== "sync" || parts.length < 4) throw notFound();
      const workspaceId = decodeURIComponent(parts[2]!);
      const authorization = request.headers.get("authorization") ?? "";
      if (!authorization.startsWith("Bearer dohc-service-v1.") || request.headers.has("cookie")) throw notFound();
      const credential = {...options, workspaceId, bearer: authorization.slice(7), method: request.method, pathname: url.pathname};
      const ownerUserId = authorizeServiceHostReplication(options.storage, credential);
      if (!ownerUserId) throw notFound();
      const guard = () => {request.signal.throwIfAborted(); if (authorizeServiceHostReplication(options.storage, credential) !== ownerUserId) throw notFound();};
      const actor = {userId: ownerUserId};
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
