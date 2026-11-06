import {decodeWorkReferenceMapping, decodeWorkTarget} from "@dohc/workspace-engine-client/daemon";
import {jsonResponse} from "@dohc/service-http";
import {notFound} from "./errors";
import {readJsonObject} from "./requestInputs";
import type {SyncRelayStorage} from "./storage";
import {WORK_REFERENCE_BATCH, type WorkReferenceReader} from "./storage/workReferences";
import {authorizeShareAction, authorizeShareGrantAction} from "./shareAuthorization";

export type WorkReferenceRoute = {route: "work-reference"; reference: string} |
  {route: "work-references"; workspaceId: string; make: boolean} |
  {route: "share-work-references"; shareId: string; make: boolean};

export function createWorkReferenceRoutes(storage: SyncRelayStorage, identityKey: string | Uint8Array | undefined, nowMs: () => number) {
  return async (request: Request, route: WorkReferenceRoute, reader: WorkReferenceReader): Promise<Response> => {
    if (route.route === "share-work-references") {
      if (reader.kind === "link") reader.requireSession();
      const granted = reader.kind === "user"
        ? authorizeShareAction({storage, actorUserId: reader.userId, shareId: route.shareId, action: "read"})
        : authorizeShareGrantAction({storage, grantId: reader.grantId, generation: reader.generation, principal: {kind: "link"}, action: "read"});
      if (!granted.ok || granted.share.shareId !== route.shareId) throw notFound();
      reader = {...reader, grantId: granted.grant.grantId};
      route = {route: "work-references", workspaceId: granted.share.workspaceId, make: route.make};
    }
    const respond = (body: unknown) => {
      const response = jsonResponse(body);
      response.headers.set("cache-control", "no-store");
      return response;
    };
    if (route.route === "work-reference") {
      if (request.method !== "GET") throw notFound();
      const resolved = await storage.resolveWorkReference({reference: route.reference, reader, identityKey});
      if (resolved.status !== "found") throw notFound();
      return respond(resolved);
    }
    if (request.method === "GET" && !route.make) {
      return respond(await storage.listWorkReferences({workspaceId: route.workspaceId, reader, identityKey,
        after: new URL(request.url).searchParams.get("after") ?? undefined}));
    }
    if (request.method !== "POST") throw notFound();
    // Registration has workspace write authority. Server minting has the reader's target authority.
    if (!route.make && (reader.kind !== "user" || !storage.workspaceIsOwnedBy(route.workspaceId, reader.userId))) throw notFound();
    const input = await readJsonObject(request);
    if (route.make) {
      let target;
      try { target = decodeWorkTarget(input.target); } catch { throw notFound(); }
      return respond(await storage.makeWorkReference({workspaceId: route.workspaceId, reader, identityKey, target, createdAtMs: nowMs()}));
    }
    if (!Array.isArray(input.references) || input.references.length > WORK_REFERENCE_BATCH || reader.kind !== "user") throw notFound();
    let references;
    try { references = input.references.map(row => decodeWorkReferenceMapping(row)); } catch { throw notFound(); }
    return respond({registered: await storage.registerWorkReferences({workspaceId: route.workspaceId, userId: reader.userId, references})});
  };
}
