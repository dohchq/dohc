import { randomBytes } from "node:crypto";
import {
  createNamedLiveBrowserResolver,
  type NamedLiveBrowserContext,
} from "./namedLiveBrowserAuth";
import { authorizeNamedLiveEditShareGrant } from "./shareAuthorization";

/** One account's browser editor sessions past this number replace its least recently used one. */
export const NAMED_SESSIONS_PER_ACCOUNT = 16;

interface NamedLiveBrowserSession {
  readonly context: NamedLiveBrowserContext;
  readonly expiresAtMs: number;
  readonly grantGeneration: number;
  readonly grantAccess: "edit";
  /** A session unused until this elapsed time is removed. */
  idleUntilMs: number;
  windowMs: number;
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
    /**
     * When set, a session is removed once it goes unused this long, until a check sets its own
     * window. Without it a session lasts its whole retention.
     */
    idleMs?: number;
    now?: () => number;
    /**
     * A clock that only moves forward at the rate time passes, for idle windows, so a
     * correction to the wall clock neither ends a session in use nor keeps an unused one.
     */
    elapsedNow?: () => number;
  },
) {
  const {
    maxSessions,
    retentionMs,
    now = Date.now,
    elapsedNow = () => performance.now(),
    storage,
    resolveActor,
  } = options;
  const perAccount = options.maxSessionsPerAccount ?? Infinity;
  const idleMs = options.idleMs ?? Infinity;
  for (const [name, value] of Object.entries({
    maxSessions,
    retentionMs,
    ...(options.maxSessionsPerAccount === undefined ? {} : { maxSessionsPerAccount: perAccount }),
    ...(options.idleMs === undefined ? {} : { idleMs }),
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
  const live = (session: NamedLiveBrowserSession, time: number) =>
    session.expiresAtMs > time && session.idleUntilMs > elapsedNow();
  const grantChanged = (session: NamedLiveBrowserSession) => {
    const grant = storage.getShareGrant(session.context.grantId);
    return grant?.generation !== session.grantGeneration || grant.access !== session.grantAccess;
  };

  async function resolve(
    request: Request,
    discriminator: string,
    windowMs?: number,
  ): Promise<NamedLiveBrowserContext | null> {
    const session = sessions.get(discriminator);
    if (!session || request.signal.aborted) return null;
    // A changed grant ends the session before the sign-in is read, so it reads as unknown.
    if (!live(session, currentTime()) || grantChanged(session)) {
      sessions.delete(discriminator);
      return null;
    }
    const context = await resolveBrowser(request, session.context);
    if (request.signal.aborted || sessions.get(discriminator) !== session) return null;
    const time = currentTime();
    if (!live(session, time) || grantChanged(session)) {
      sessions.delete(discriminator);
      return null;
    }
    if (context?.userId !== session.context.userId) return null;
    // Only a use that passed every check keeps the session.
    if (windowMs !== undefined) session.windowMs = windowMs;
    session.idleUntilMs = elapsedNow() + session.windowMs;
    // The map keeps insertion order, so moving a resolved session to the end keeps each
    // account's least recently used session first.
    sessions.delete(discriminator);
    sessions.set(discriminator, session);
    return context;
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
        if (!live(session, createdAtMs)) sessions.delete(key);
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
        idleUntilMs: elapsedNow() + idleMs,
        windowMs: idleMs,
      });
      return { discriminator, expiresAtMs };
    },

    /** A use inside the relay, which keeps the session's window. */
    resolve(request: Request, discriminator: string) {
      return resolve(request, discriminator);
    },
    /** share-web's check, which sets the session's window: Infinity when it announced no interval. */
    check(request: Request, discriminator: string, windowMs: number) {
      return resolve(request, discriminator, windowMs);
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
