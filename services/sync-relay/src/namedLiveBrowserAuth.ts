import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
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
  storage: Parameters<typeof authorizeNamedLiveEditShareGrant>[0]["storage"];
}) {
  // Callers supply trusted route scope and the production session resolver.
  // This result supplies identity, not authority to commit a ticket or update.
  return async (request: Request, scope: NamedLiveBrowserScope): Promise<NamedLiveBrowserContext | null> => {
    const { workspaceId, shareId, grantId } = scope;
    const headers = new Headers();
    const cookie = request.headers.get("cookie");
    if (cookie !== null) headers.set("cookie", cookie);
    let actor;
    try {
      actor = await options.resolveActor(new Request(request.url, { headers, signal: request.signal }), workspaceId);
    } catch (error) {
      if (error instanceof UnauthorizedError) return null;
      throw error;
    }
    if (actor.workspaceId !== workspaceId) return null;
    const current = authorizeNamedLiveEditShareGrant({
      storage: options.storage, actorUserId: actor.userId, grantId,
    });
    if (!current.ok || current.share.workspaceId !== workspaceId || current.share.shareId !== shareId) return null;
    return { kind: "named", userId: actor.userId, workspaceId, shareId, grantId };
  };
}
