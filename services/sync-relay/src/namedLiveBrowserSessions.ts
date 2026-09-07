import { randomBytes } from "node:crypto";
import { createNamedLiveBrowserResolver, type NamedLiveBrowserContext } from "./namedLiveBrowserAuth";

interface NamedLiveBrowserSession {
  readonly context: NamedLiveBrowserContext;
  readonly expiresAtMs: number;
}

/** Private route lookup. Callers create mappings from server-resolved context. */
export function createNamedLiveBrowserSessions(options: Parameters<typeof createNamedLiveBrowserResolver>[0] & {
  maxSessions: number;
  retentionMs: number;
  now?: () => number;
}) {
  const { maxSessions, retentionMs, now = Date.now, storage, resolveActor } = options;
  for (const [name, value] of Object.entries({ maxSessions, retentionMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid named session ${name}.`);
  }
  const resolveBrowser = createNamedLiveBrowserResolver({ storage, resolveActor });
  const sessions = new Map<string, NamedLiveBrowserSession>();

  function currentTime(): number {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid named session time.");
    return value;
  }

  return {
    create(context: NamedLiveBrowserContext): { discriminator: string; expiresAtMs: number } | null {
      const { userId, workspaceId, shareId, grantId } = context;
      if ([userId, workspaceId, shareId, grantId].some(value => typeof value !== "string" || value.length === 0)) {
        throw new TypeError("Invalid named session context.");
      }
      const createdAtMs = currentTime();
      const expiresAtMs = createdAtMs + retentionMs;
      if (!Number.isSafeInteger(expiresAtMs)) throw new TypeError("Invalid named session expiry.");
      if (sessions.size >= maxSessions) {
        for (const [key, session] of sessions) {
          if (session.expiresAtMs <= createdAtMs) sessions.delete(key);
        }
        if (sessions.size >= maxSessions) return null;
      }
      const discriminator = randomBytes(9).toString("base64url");
      if (sessions.has(discriminator)) throw new Error("Named session discriminator collision.");
      sessions.set(discriminator, {
        context: Object.freeze({ userId, workspaceId, shareId, grantId }), expiresAtMs,
      });
      return { discriminator, expiresAtMs };
    },

    async resolve(request: Request, discriminator: string): Promise<NamedLiveBrowserContext | null> {
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
      return context?.userId === session.context.userId ? context : null;
    },

    remove(discriminator: string): boolean {
      return sessions.delete(discriminator);
    },
  };
}
