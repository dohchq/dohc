import { randomBytes } from "node:crypto";
import {
  createNamedLiveBrowserResolver,
  type NamedLiveBrowserContext,
} from "./namedLiveBrowserAuth";
import { authorizeNamedLiveEditShareGrant } from "./shareAuthorization";

interface NamedLiveBrowserSession {
  readonly context: NamedLiveBrowserContext;
  readonly expiresAtMs: number;
  readonly grantGeneration: number;
  readonly grantAccess: "edit";
}

/** Private route lookup. Callers create mappings from server-resolved context. */
export function createNamedLiveBrowserSessions(
  options: Parameters<typeof createNamedLiveBrowserResolver>[0] & {
    maxSessions: number;
    retentionMs: number;
    /**
     * When set, an account's new session past this many replaces its least recently used one,
     * which neither refuses that account nor touches another account.
     */
    maxSessionsPerAccount?: number;
    now?: () => number;
  },
) {
  const { maxSessions, retentionMs, now = Date.now, storage, resolveActor } = options;
  const perAccount = options.maxSessionsPerAccount ?? Infinity;
  for (const [name, value] of Object.entries({
    maxSessions,
    retentionMs,
    ...(options.maxSessionsPerAccount === undefined ? {} : { maxSessionsPerAccount: perAccount }),
  })) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new TypeError(`Invalid named session ${name}.`);
  }
  const resolveBrowser = createNamedLiveBrowserResolver({
    storage,
    resolveActor,
    authentication: options.authentication,
  });
  const sessions = new Map<string, NamedLiveBrowserSession>();

  function currentTime(): number {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TypeError("Invalid named session time.");
    return value;
  }

  return {
    create(
      context: NamedLiveBrowserContext,
    ): { discriminator: string; expiresAtMs: number } | null {
      const { userId, workspaceId, shareId, grantId } = context;
      if (
        context.kind !== "named" ||
        [userId, workspaceId, shareId, grantId].some(
          (value) => typeof value !== "string" || value.length === 0,
        )
      ) {
        throw new TypeError("Invalid named session context.");
      }
      const current = authorizeNamedLiveEditShareGrant({ storage, actorUserId: userId, grantId });
      if (
        !current.ok ||
        current.grant.grantId !== grantId ||
        current.share.shareId !== shareId ||
        current.share.workspaceId !== workspaceId ||
        current.grant.access !== "edit" ||
        !Number.isSafeInteger(current.grant.generation) ||
        current.grant.generation <= 0
      ) {
        throw new TypeError("Invalid named session grant.");
      }
      const { generation: grantGeneration, access: grantAccess } = current.grant;
      const createdAtMs = currentTime();
      const expiresAtMs = createdAtMs + retentionMs;
      if (!Number.isSafeInteger(expiresAtMs)) throw new TypeError("Invalid named session expiry.");
      let held = 0,
        oldest: string | undefined;
      for (const [key, session] of sessions) {
        if (session.expiresAtMs <= createdAtMs) sessions.delete(key);
        else if (session.context.userId === userId) {
          held += 1;
          oldest ??= key;
        }
      }
      const discriminator = randomBytes(9).toString("base64url");
      if (sessions.has(discriminator)) throw new Error("Named session discriminator collision.");
      if (held >= perAccount && oldest !== undefined) sessions.delete(oldest);
      if (sessions.size >= maxSessions) return null;
      sessions.set(discriminator, {
        context: Object.freeze({ kind: "named", userId, workspaceId, shareId, grantId }),
        expiresAtMs,
        grantGeneration,
        grantAccess,
      });
      return { discriminator, expiresAtMs };
    },

    async resolve(
      request: Request,
      discriminator: string,
    ): Promise<NamedLiveBrowserContext | null> {
      const session = sessions.get(discriminator);
      if (!session || request.signal.aborted) return null;
      if (session.expiresAtMs <= currentTime()) {
        sessions.delete(discriminator);
        return null;
      }
      const context = await resolveBrowser(request, session.context);
      if (request.signal.aborted || sessions.get(discriminator) !== session) return null;
      if (session.expiresAtMs <= currentTime()) {
        sessions.delete(discriminator);
        return null;
      }
      if (context?.userId !== session.context.userId) return null;
      const grant = storage.getShareGrant(session.context.grantId);
      if (grant?.generation !== session.grantGeneration || grant.access !== session.grantAccess) {
        sessions.delete(discriminator);
        return null;
      }
      // The map keeps insertion order, so moving a resolved session to the end keeps each
      // account's least recently used session first.
      sessions.delete(discriminator);
      sessions.set(discriminator, session);
      return context;
    },

    deleteAccount(userId: string, workspaceIds: readonly string[]) {
      for (const [key, session] of sessions)
        if (session.context.userId === userId || workspaceIds.includes(session.context.workspaceId))
          sessions.delete(key);
    },
    remove(discriminator: string): boolean {
      return sessions.delete(discriminator);
    },
  };
}
