import { readBoundedJson, type TokenBucketLimiter } from "@dohc/service-http";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import { APP_BACKEND_REQUEST_BYTES } from "@dohc/security-contract/app-backend";
import type { ResolveAccountSession } from "@dohc/workspace-auth/session";
import { notFound, RelayError } from "./errors";
import type { PhoneCollections } from "./phoneCollections";
import { authorizeShareGrantAction } from "./shareAuthorization";
import type { SyncRelayStorage } from "./storage";
import { accountIsFenced } from "./storage/accountDeletion";

export const NAMED_COLLECTIONS_PATH = "/sync/live/named-collections";

const OPERATIONS = new Set(["collections", "collection", "collectionRecords", "collectionEdit"]);

/**
 * A signed-in browser's transactional Collections through one invitation it holds: share-web forwards the account
 * cookie with its Origin and exchange key. The invitation must be the caller's own, by name, not a redeemed link. The
 * dataset host gives the Collection authority the owner set for that invitation: its data grant and the workspace's
 * defaults. The browser reads a table and changes one field at a time, as the phone does, and nothing else.
 */
export function createNamedCollectionsRoute(options: {
  storage: SyncRelayStorage;
  collections: PhoneCollections;
  resolveAccountSession: ResolveAccountSession;
  publicOrigin: string;
  hasExchangeKey(request: Request): boolean;
  limiter: TokenBucketLimiter;
  nowMs(): number;
}) {
  const { storage } = options;
  return async (request: Request): Promise<Response> => {
    const cookie = request.headers.get("cookie");
    if (
      request.method !== "POST" ||
      new URL(request.url).search ||
      !cookie ||
      request.headers.has("authorization") ||
      request.headers.get("origin") !== options.publicOrigin ||
      !options.hasExchangeKey(request) ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json"
    )
      throw notFound();
    const session = () =>
      options
        .resolveAccountSession(
          new Request(request.url, { headers: { cookie }, signal: request.signal }),
        )
        .catch(() => {
          throw notFound();
        });
    const caller = await session();
    if (caller.clientKind !== "browser" || accountIsFenced(storage, caller.userId))
      throw notFound();
    if (!options.limiter.allow(caller.sessionId, options.nowMs()))
      throw new RelayError(
        "server_busy",
        "This sign-in is asking faster than your server answers. Try again shortly.",
      );
    let body: unknown;
    try {
      body = await readBoundedJson(request, APP_BACKEND_REQUEST_BYTES, request.signal);
    } catch {
      throw notFound();
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).sort().join() !== "args,grantId,operation"
    )
      throw notFound();
    const { grantId: rawGrantId, operation, args } = body as Record<string, unknown>;
    if (typeof operation !== "string" || !OPERATIONS.has(operation)) throw notFound();
    let grantId: string;
    try {
      grantId = parseLiveUpdateIdentifier(rawGrantId);
    } catch {
      throw notFound();
    }
    const invitation = () => {
      const result = authorizeShareGrantAction({
        storage,
        grantId,
        action: "read",
        principal: { kind: "user", userId: caller.userId },
      });
      if (
        !result.ok ||
        result.grant.principalKind !== "user" ||
        result.grant.principalUserId !== caller.userId ||
        result.grant.parentGrantId !== null
      )
        throw notFound();
      return result;
    };
    const first = invitation();
    const workspaceId = first.share.workspaceId;
    const holds = () => {
      const current = invitation();
      if (
        accountIsFenced(storage, caller.userId) ||
        current.share.workspaceId !== workspaceId ||
        current.grant.generation !== first.grant.generation
      )
        throw notFound();
    };
    return options.collections.respond({
      caller,
      member: { grantId },
      holds,
      workspaceId,
      operation,
      args,
      authorize: async () => {
        const current = await session();
        if (current.sessionId !== caller.sessionId || current.userId !== caller.userId)
          throw notFound();
        holds();
      },
      signal: request.signal,
    });
  };
}
