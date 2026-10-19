import {createWorkspaceReplicationRoutes} from "./workspaceReplicationRoutes";
import {createWorkspaceBlobRoutes} from "./workspaceBlobRoutes";
import {createServiceHostFeed} from "./serviceHostFeed";
import type {SyncRelayLogRow, SyncRelayStorage} from "./storage";
import {badRequest, errorResponse, notFound} from "./errors";
import {jsonResponse} from "@dohc/service-http";
import {REPLICA_LIVE_JOURNAL_MAX_ROWS} from "./storage/liveUpdateJournal";

/**
 * Replication for a credential this server derived for its own replica.
 * `authorize` answers the workspace owner the credential acts for, or null.
 * Workspace replicas can also read the accepted live journal. With
 * `hostedFeed`, the credential also reads the service host's scoped feed
 * under `/sync/:workspaceId/hosted/`. Credentials never enter an account
 * resolver or share route.
 */
export function createServiceHostReplication(options: {
  storage: SyncRelayStorage;
  prefix: string;
  authorize(input: {workspaceId: string; bearer: string; method: string; pathname: string}): string | null;
  revalidate?: (input: {workspaceId: string; bearer: string; method: string; pathname: string}) => string | null;
  onLogRead?: (input: {workspaceId: string; bearer: string}, rows: readonly SyncRelayLogRow[]) => void;
  // Only the service host principal enables this route.
  hostedFeed?: boolean;
  // Only the workspace replica principal enables this route.
  replicaLiveJournal?: boolean;
}) {
  // It passes no session reauthentication, so a held log read answers at once.
  const replication = createWorkspaceReplicationRoutes(options.storage, Date.now, {wakeLog() {}, wait: async () => {}},
    {watched: () => false}, undefined, (request, workspaceId, rows) => options.onLogRead?.({workspaceId,
      bearer: (request.headers.get("authorization") ?? "").slice(7)}, rows));
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
      const guard = () => {request.signal.throwIfAborted(); if ((options.revalidate ?? options.authorize)(credential) !== ownerUserId) throw notFound();};
      const actor = {userId: ownerUserId};
      if (parts[3] === "hosted") {
        if (!feed) throw notFound();
        let route: string[];
        try {route = parts.slice(4).map(decodeURIComponent);} catch {throw notFound();}
        return await feed(request, {workspaceId, route, actor, guard});
      }
      if (parts[3] === "live-journal" && parts.length === 4) {
        if (!options.replicaLiveJournal || request.method !== "GET") throw notFound();
        const after = replicaJournalQueryInteger(url.searchParams, "after", 0, 0);
        const limit = Math.min(replicaJournalQueryInteger(url.searchParams, "limit", 100, 1), REPLICA_LIVE_JOURNAL_MAX_ROWS);
        guard();
        const page = await options.storage.readReplicaLiveJournal({workspaceId, after, limit, signal: request.signal, guard});
        guard();
        return jsonResponse({ok: true, ...page});
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

function replicaJournalQueryInteger(query: URLSearchParams, name: string, fallback: number, minimum: number): number {
  const values = query.getAll(name);
  if (values.length === 0) return fallback;
  const value = values[0]!;
  if (values.length !== 1 || !/^(?:0|[1-9]\d*)$/.test(value)) throw badRequest(`${name} must be an integer`);
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < minimum) throw badRequest(`${name} is outside the page bounds`);
  return integer;
}
