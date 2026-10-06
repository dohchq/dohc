import { jsonResponse } from "@dohc/service-http";
import {
  PresenceCapacityError,
  presenceScopeKey,
  type PresenceHub,
  type PresenceSnapshot,
} from "./presence";
import {
  presenceTopicAllowedForShare,
  fileSideOf,
  chatSideOf,
  parseChatThreadTopic,
  targetVersionId,
  visibleSharePath,
  type ChatShareThreadResolver,
} from "./shareFilter";
import type { AuthorizedShareAction } from "./shareAuthorization";
import type { SyncRelayStorage } from "./storage";
import { parseCursor, parseString, readJsonObject } from "./requestInputs";
import { badRequest, notFound, relayError } from "./errors";
import { createPresenceProjection, sanitizePresenceState } from "./presenceDisclosure";

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
  const json = JSON.stringify(state);
  if (json === undefined) throw badRequest("presence state must be JSON-serializable");
  if (Buffer.byteLength(json, "utf8") > MAX_PRESENCE_STATE_BYTES)
    throw badRequest("presence state is too large");
}

// Both drawing and document object topics carry relay-resolved coordinates, never a client path.
export function parsePresenceObjectTopic(
  topic: string,
): { workspaceId: string; versionId: string; objectId: string } | null {
  const prefix = topic.startsWith("scene:") ? "scene:" : topic.startsWith("doc:") ? "doc:" : null;
  if (prefix === null) return null;
  try {
    const parts: unknown = JSON.parse(topic.slice(prefix.length));
    if (
      !Array.isArray(parts) ||
      parts.length !== 3 ||
      !parts.every((p) => typeof p === "string" && p.length > 0 && !/[\u0000-\u001f\u007f]/.test(p))
    )
      throw new Error();
    const [workspaceId, versionId, objectId] = parts as [string, string, string];
    if (topic !== prefix + JSON.stringify(parts)) throw new Error();
    return { workspaceId, versionId, objectId };
  } catch {
    throw notFound();
  }
}

export function createPresenceRoutes(
  presence: PresenceHub,
  nowMs: () => number,
  storage: Pick<SyncRelayStorage, "workspaceIsOwnedBy" | "currentObjectPath">,
  claimPendingShares: (userId: string) => Promise<void>,
  requireShareAction: (
    shareId: string,
    actorUserId: string,
    action: "presence",
  ) => AuthorizedShareAction,
  chatResolverFor: (workspaceId: string) => ChatShareThreadResolver,
  lookupLabel?: (userId: string) => string | null | Promise<string | null>,
) {
  const project = createPresenceProjection(lookupLabel);
  const authorizeObject = (
    workspaceId: string,
    topic: string,
    authorized?: AuthorizedShareAction,
  ) => {
    const object = parsePresenceObjectTopic(topic);
    if (!object) return false;
    if (object.workspaceId !== workspaceId) throw notFound();
    const files = authorized
      ? fileSideOf(authorized.effectiveSelector)
      : { paths: [], versionId: object.versionId, access: "edit" as const };
    if (!files || object.versionId !== targetVersionId(files)) throw notFound();
    const path = storage.currentObjectPath(object);
    if (!path || visibleSharePath(files, path) !== path) throw notFound();
    return true;
  };
  const authorizeShare = (shareId: string, userId: string, topic: string) => {
    const authorized = requireShareAction(shareId, userId, "presence");
    const resolver = chatResolverFor(authorized.share.workspaceId);
    const objectTopic = authorizeObject(authorized.share.workspaceId, topic, authorized);
    if (!objectTopic) {
      // A path spelled like an existing channel never grants that channel's attribution.
      const thread = parseChatThreadTopic(topic);
      const channelTopic =
        thread !== null
          ? resolver.threadChannelWireId(thread) != null
          : resolver.channelKind(topic) != null;
      const selector = channelTopic
        ? chatSideOf(authorized.effectiveSelector)
        : authorized.effectiveSelector;
      if (!selector || !presenceTopicAllowedForShare(selector, topic, resolver)) throw notFound();
    }
    return authorized;
  };

  const respondPresence = async (
    request: Request,
    workspaceId: string,
    topic: string,
    userId: string,
    shareId?: string,
  ): Promise<Response> => {
    const scopeKey = presenceScopeKey(workspaceId, topic);
    const authorize = () => {
      if (shareId) {
        const authorized = authorizeShare(shareId, userId, topic);
        if (authorized.share.workspaceId !== workspaceId) throw notFound();
        return fileSideOf(authorized.effectiveSelector)?.access === "edit";
      }
      if (!storage.workspaceIsOwnedBy(workspaceId, userId)) throw notFound();
      authorizeObject(workspaceId, topic);
      return true;
    };
    let canEdit = authorize();
    let viewerClientId: string | null = null;
    let snapshot: PresenceSnapshot;
    try {
      if (request.method === "POST") {
        const input = await readJsonObject(request);
        viewerClientId = parseString(input.clientId, "clientId", MAX_CLIENT_ID_CHARS);
        canEdit = authorize();
        if (input.leave === true)
          snapshot = presence.leave(scopeKey, userId, viewerClientId, nowMs());
        else {
          assertPresenceStateSize(input.state);
          const state = sanitizePresenceState(
            input.state,
            canEdit,
            viewerClientId === "agent:" + workspaceId,
          );
          snapshot = presence.publish(scopeKey, userId, viewerClientId, state, nowMs(), shareId);
        }
      } else if (request.method === "GET") {
        const url = new URL(request.url);
        const clientId = url.searchParams.get("clientId");
        if (clientId !== null)
          viewerClientId = parseString(clientId, "clientId", MAX_CLIENT_ID_CHARS);
        snapshot = await presence.wait(scopeKey, parseCursor(url.searchParams.get("since")), {
          holdMs: parsePresenceHold(url.searchParams.get("hold")),
          nowMs: nowMs(),
          signal: request.signal,
          actorId: userId,
        });
        authorize();
      } else throw relayError("method_not_allowed");
    } catch (error) {
      if (error instanceof PresenceCapacityError)
        throw relayError("presence_capacity", error.message);
      throw error;
    }
    const resolver = chatResolverFor(workspaceId);
    const thread = parseChatThreadTopic(topic);
    const objectTopic = parsePresenceObjectTopic(topic) !== null;
    const isChatTopic = () =>
      !objectTopic &&
      (thread !== null
        ? resolver.threadChannelWireId(thread) != null || resolver.threadFileBinding(thread) != null
        : resolver.channelKind(topic) != null);
    const response = await project(snapshot, {
      scopeKey,
      viewerUserId: userId,
      viewerClientId,
      disclose: (peer) =>
        storage.workspaceIsOwnedBy(workspaceId, userId) ||
        peer.userId === userId ||
        storage.workspaceIsOwnedBy(workspaceId, peer.userId) ||
        isChatTopic(),
      canEdit: (peer) => {
        try {
          if (peer.shareId) {
            const auth = authorizeShare(peer.shareId, peer.userId, topic);
            if (auth.share.workspaceId !== workspaceId) return null;
            return fileSideOf(auth.effectiveSelector)?.access === "edit";
          }
          return storage.workspaceIsOwnedBy(workspaceId, peer.userId) ? true : null;
        } catch {
          return null;
        }
      },
    });
    // Account-label lookup can await too. Recheck the viewer immediately before sending.
    authorize();
    return jsonResponse({ ok: true, ...response });
  };

  const respondToSharePresence = async (request: Request, shareId: string, userId: string) => {
    await claimPendingShares(userId);
    const topic = parsePresenceTopic(new URL(request.url).searchParams.get("topic"));
    const authorized = authorizeShare(shareId, userId, topic);
    return await respondPresence(request, authorized.share.workspaceId, topic, userId, shareId);
  };
  const respondToWorkspacePresence = async (
    request: Request,
    workspaceId: string,
    userId: string,
  ) => {
    const topic = parsePresenceTopic(new URL(request.url).searchParams.get("topic"));
    return await respondPresence(request, workspaceId, topic, userId);
  };
  return { respondToSharePresence, respondToWorkspacePresence };
}
