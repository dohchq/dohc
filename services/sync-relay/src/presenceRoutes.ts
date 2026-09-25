import { jsonResponse } from "@dohc/service-http";
import {
  PresenceCapacityError,
  presenceScopeKey,
  type PresenceHub,
  type PresenceSnapshot,
} from "./presence";
import {
  presenceTopicAllowedForShare,
  type ChatShareThreadResolver,
} from "./shareFilter";
import type { AuthorizedShareAction } from "./shareAuthorization";
import type { SyncRelayStorage } from "./storage";
import { parseCursor, parseString, readJsonObject } from "./requestInputs";
import { badRequest, notFound, relayError } from "./errors";

// Presence (ephemeral awareness) transport limits.
const MAX_PRESENCE_TOPIC_CHARS = 1024;
const MAX_CLIENT_ID_CHARS = 128;
const MAX_PRESENCE_STATE_BYTES = 8 * 1024;
const DEFAULT_PRESENCE_HOLD_MS = 25_000;
const MAX_PRESENCE_HOLD_MS = 30_000;

function parsePresenceTopic(value: string | null): string {
  if (value === null) throw badRequest("topic is required");
  return parseString(value, "topic", MAX_PRESENCE_TOPIC_CHARS);
}

function parsePresenceHold(value: string | null): number {
  if (value === null || value === "") return DEFAULT_PRESENCE_HOLD_MS;
  const hold = Number(value);
  if (!Number.isInteger(hold) || hold < 0) throw badRequest("hold must be a non-negative integer");
  return Math.min(hold, MAX_PRESENCE_HOLD_MS);
}

function assertPresenceStateSize(state: unknown): void {
  if (state === undefined || state === null) return;
  let json: string | undefined;
  try {
    json = JSON.stringify(state);
  } catch {
    throw badRequest("presence state must be JSON-serializable");
  }
  if (json === undefined) throw badRequest("presence state must be JSON-serializable");
  if (Buffer.byteLength(json, "utf8") > MAX_PRESENCE_STATE_BYTES) {
    throw badRequest("presence state is too large");
  }
}

function presenceResponse(snapshot: PresenceSnapshot): Response {
  return jsonResponse({ ok: true, version: snapshot.version, peers: snapshot.peers });
}

// Capacity refusals (scope/entry/waiter caps) are a client-visible 429 so a
// well-behaved client backs off; anything else re-throws unchanged.
function presenceCapacityAs429(error: unknown): unknown {
  if (error instanceof PresenceCapacityError) {
    return relayError("presence_capacity", error.message);
  }
  return error;
}

export function createPresenceRoutes(
  presence: PresenceHub,
  nowMs: () => number,
  storage: Pick<SyncRelayStorage, "workspaceIsOwnedBy">,
  claimPendingShares: (userId: string) => Promise<void>,
  requireShareAction: (
    shareId: string,
    actorUserId: string,
    action: "presence",
  ) => AuthorizedShareAction,
  chatResolverFor: (workspaceId: string) => ChatShareThreadResolver,
) {
  // Handle a publish (POST) or long-poll (GET) against an already-authorized
  // presence scope. The actor's user id is the SERVER-DERIVED attribution;
  // the client-supplied `state` is opaque display data only. `reauthorize`
  // re-runs the caller's authorization after a long-poll park: a grant revoked
  // while the poll was parked must fail closed on wake, never return a final
  // snapshot for a scope the caller no longer has.
  const respondPresence = async (
    request: Request,
    scopeKey: string,
    userId: string,
    reauthorize?: () => unknown,
  ): Promise<Response> => {
    if (request.method === "POST") {
      const input = await readJsonObject(request);
      const clientId = parseString(input.clientId, "clientId", MAX_CLIENT_ID_CHARS);
      if (input.leave === true) {
        return presenceResponse(presence.leave(scopeKey, userId, clientId, nowMs()));
      }
      assertPresenceStateSize(input.state);
      try {
        return presenceResponse(
          presence.publish(scopeKey, userId, clientId, input.state ?? null, nowMs()),
        );
      } catch (error) {
        throw presenceCapacityAs429(error);
      }
    }
    if (request.method === "GET") {
      const url = new URL(request.url);
      const since = parseCursor(url.searchParams.get("since"));
      const hold = parsePresenceHold(url.searchParams.get("hold"));
      let snapshot: PresenceSnapshot;
      try {
        snapshot = await presence.wait(scopeKey, since, {
          holdMs: hold,
          nowMs: nowMs(),
          signal: request.signal,
          actorId: userId,
        });
      } catch (error) {
        throw presenceCapacityAs429(error);
      }
      // A 25s park is long enough for a revoke to land mid-poll; re-run the
      // route's authorization before returning anything.
      if (reauthorize) await reauthorize();
      return presenceResponse(snapshot);
    }
    throw relayError("method_not_allowed");
  };

  const respondToSharePresence = async (
    request: Request,
    shareId: string,
    actorUserId: string,
  ): Promise<Response> => {
    // Cross-user presence: a recipient joins the ephemeral scope for a
    // topic their grant exposes. The share is loaded FAIL-CLOSED (generic
    // 404 for no-grant / revoked / wrong-recipient), and the topic is
    // gated by the same visibility check the durable filter uses, so a
    // non-member can neither read nor even confirm presence for a
    // channel/DM they lack a grant for. The scope key resolves to the
    // granter's workspace, so the owner (workspace route) and recipients
    // fan into one scope and see each other.
    await claimPendingShares(actorUserId);
    const topic = parsePresenceTopic(new URL(request.url).searchParams.get("topic"));
    // The share + topic gate, run before joining and re-run after a parked
    // long-poll wakes (respondPresence's reauthorize): a revoke that lands
    // while a recipient's poll is parked fails closed on wake instead of
    // leaking one final snapshot. The resolver lets a chat grant
    // admit a `chat:thread:<threadId>` topic for a thread BOUND (earliest
    // binding, forge-resistant) to the granted channel — the same authority
    // the durable chat filter uses; bare wire presence also resolves kind
    // so an owner-only agent channel can never enter a share scope.
    const authorizeShare = () => {
      const authorized = requireShareAction(shareId, actorUserId, "presence");
      const chatResolver = chatResolverFor(authorized.share.workspaceId);
      if (
        !presenceTopicAllowedForShare(
          authorized.effectiveSelector,
          topic,
          chatResolver,
        )
      ) {
        throw notFound();
      }
      return { ...authorized.share, selector: authorized.effectiveSelector };
    };
    const share = authorizeShare();
    // `await` is load-bearing: respondPresence can reject long after this
    // frame returns (a parked long-poll), and only an awaited rejection
    // flows through the outer catch into errorResponse.
    return await respondPresence(
      request,
      presenceScopeKey(share.workspaceId, topic),
      actorUserId,
      authorizeShare,
    );
  };

  const respondToWorkspacePresence = async (
    request: Request,
    workspaceId: string,
    actorUserId: string,
  ): Promise<Response> => {
    // The owner's own workspace presence (multi-device co-presence in
    // their local channels/docs, and the owner side of a shared channel).
    // Ownership was proven by the caller; any topic in the owner's own
    // workspace is theirs to join. Ownership is also re-proven after a
    // parked long-poll wakes, mirroring the share route's posture.
    const topic = parsePresenceTopic(new URL(request.url).searchParams.get("topic"));
    // `await` is load-bearing: see the share-presence route above.
    return await respondPresence(
      request,
      presenceScopeKey(workspaceId, topic),
      actorUserId,
      () => {
        if (!storage.workspaceIsOwnedBy(workspaceId, actorUserId)) throw notFound();
      },
    );
  };

  return { respondToSharePresence, respondToWorkspacePresence };
}
