import {decodeWorkTarget} from "@dohc/workspace-engine-client/daemon";
import {jsonResponse} from "@dohc/service-http";
import {notFound} from "./errors";
import {parseWorkspaceId, readJsonObject} from "./requestInputs";
import type {SyncRelayStorage} from "./storage";
import type {WorkReferenceReader} from "./storage/workReferences";
import {authorizeShareAction, authorizeShareGrantAction} from "./shareAuthorization";

export type WorkReferenceRoute = {route: "work-reference"; reference: string} |
  {route: "work-references"; workspaceId: string} |
  {route: "share-work-references"; shareId: string} |
  {route: "internal-work-reference"};

export function createWorkReferenceRoutes(storage: SyncRelayStorage, identityKey: string | Uint8Array | undefined, nowMs: () => number) {
  return async (request: Request, route: WorkReferenceRoute, reader: WorkReferenceReader): Promise<Response> => {
    const respond = (body: unknown) => {
      const response = jsonResponse(body);
      response.headers.set("cache-control", "no-store");
      return response;
    };
    // The dispatcher checks the exchange key before authenticating the target's reader.
    if (route.route === "internal-work-reference") {
      if (request.method !== "POST") throw notFound();
      const input = await readJsonObject(request);
      let target;
      try { target = decodeWorkTarget(input.target); } catch { throw notFound(); }
      let workspaceId: string;
      if (reader.kind === "link") {
        reader.requireSession();
        const grant = storage.getShareGrant(reader.grantId), share = grant && storage.getShare(grant.shareId);
        if (!share || input.workspaceId !== undefined && input.workspaceId !== share.workspaceId) throw notFound();
        workspaceId = share.workspaceId;
      } else workspaceId = parseWorkspaceId(input.workspaceId);
      return respond(await storage.makeWorkReference({workspaceId, reader,
        identityKey, target, createdAtMs: nowMs()}));
    }
    if (request.method !== "GET") throw notFound();
    if (route.route === "share-work-references") {
      if (reader.kind === "link") reader.requireSession();
      const granted = reader.kind === "user"
        ? authorizeShareAction({storage, actorUserId: reader.userId, shareId: route.shareId, action: "read"})
        : authorizeShareGrantAction({storage, grantId: reader.grantId, generation: reader.generation, principal: {kind: "link"}, action: "read"});
      if (!granted.ok || granted.share.shareId !== route.shareId) throw notFound();
      reader = {...reader, grantId: granted.grant.grantId};
      route = {route: "work-references", workspaceId: granted.share.workspaceId};
    }
    if (route.route === "work-reference") {
      const resolved = await storage.resolveWorkReference({reference: route.reference, reader, identityKey});
      if (resolved.status !== "found") throw notFound();
      return respond(resolved);
    }
    return respond(await storage.listWorkReferences({workspaceId: route.workspaceId, reader, identityKey,
      after: new URL(request.url).searchParams.get("after") ?? undefined}));
  };
}
