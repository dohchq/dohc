import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { relayError } from "./errors";
import { authorizeNamedLiveEditShareGrant } from "./shareAuthorization";

export interface NamedLiveBrowserScope {
  readonly workspaceId: string;
  readonly shareId: string;
  readonly grantId: string;
}

export interface NamedLiveBrowserContext extends NamedLiveBrowserScope {
  readonly kind: "named";
  readonly userId: string;
}

export function createNamedLiveBrowserResolver(options: {
  resolveActor: ResolveActor;
  authentication?: "cookie" | "bearer";
  explainRemoval?: boolean;
  storage: Parameters<typeof authorizeNamedLiveEditShareGrant>[0]["storage"];
}) {
  // Callers supply trusted route scope and the production session resolver.
  // This result supplies identity, not authority to commit a ticket or update.
  return async (request: Request, scope: NamedLiveBrowserScope): Promise<NamedLiveBrowserContext | null> => {
    const { workspaceId, shareId, grantId } = scope;
    const headers = new Headers();
    const field = options.authentication === "bearer" ? "authorization" : "cookie";
    const credential = request.headers.get(field);
    if (credential !== null) headers.set(field, credential);
    let actor;
    try {
      actor = await options.resolveActor(new Request(request.url, { headers, signal: request.signal }), workspaceId);
    } catch (error) {
      if (error instanceof UnauthorizedError) return null;
      throw error;
    }
    if (actor.workspaceId !== workspaceId) return null;
    if (options.explainRemoval) {
      const grant = options.storage.getShareGrant(grantId);
      const share = grant && options.storage.getShare(grant.shareId);
      if (grant?.principalKind === "user" && grant.principalUserId === actor.userId && grant.status === "revoked" &&
        share?.shareId === shareId && share.workspaceId === workspaceId && options.storage.workspaceIsOwnedBy(workspaceId, share.granterUserId)) {
        throw relayError("share_access_removed");
      }
    }
    const current = authorizeNamedLiveEditShareGrant({
      storage: options.storage, actorUserId: actor.userId, grantId,
    });
    if (!current.ok || current.share.workspaceId !== workspaceId || current.share.shareId !== shareId) return null;
    return { kind: "named", userId: actor.userId, workspaceId, shareId, grantId };
  };
}
