import { actorHueInput, createActorIssuer, deriveLocalActor, deriveRelayChatActor, serializeActorKey } from "@dohc/workspace-contracts/actor-identity";
import type { ActorIssuer, ActorRef } from "@dohc/workspace-contracts/actor-identity";
import { ACTOR_HUES, actorHueSlot } from "@dohc/workspace-contracts/actor-presentation";
import type { ChatMessage } from "@dohc/workspace-contracts/engine";
import type { ActorPresentation } from "../ipc/bridgeContract";
import type { CloudCredentials } from "./cloudCredentialStore";
import { readLocalChatActor, resolveThreadActorIssuer } from "./chatRelayIdentity";

type DisplayMessage = Pick<ChatMessage, "author" | "authorActorKey" | "authorUserId" | "origin">;
const groups = new Map<string, string>();

export function chatActorForPresentation(message: DisplayMessage, issuer: ActorIssuer | null): ActorRef {
  return readLocalChatActor(message) ?? deriveRelayChatActor({
    issuer, authorUserId: message.authorUserId, displayName: message.author.displayName,
    ...(message.origin ? { origin: message.origin } : {}),
    ...(message.author.kind === "agent"
      ? { kind: "agent", claimedName: message.author.displayName }
      : { kind: message.author.kind }),
  });
}

// A request owns one issuer lookup per thread, including one retry for registry replacement.
export function createActorPresentationRequest(input: Omit<Parameters<typeof resolveThreadActorIssuer>[0], "threadId"> & {
  installationId: string;
  credentials: CloudCredentials | null;
}) {
  const issuers = new Map<string, Promise<ActorIssuer | null>>();
  const installation = deriveLocalActor({ identity: { installationId: input.installationId, account: null },
    workspaceId: "", author: { kind: "human" }, displayName: "", origin: "renderer" }).key;
  let account: string | null = null;
  if (input.credentials) {
    try {
      account = serializeActorKey(deriveLocalActor({
        identity: { installationId: input.installationId, account: {
          issuer: createActorIssuer(input.credentials.serverUrl), userId: input.credentials.userId,
        } }, workspaceId: "", author: { kind: "human" }, displayName: "", origin: "renderer",
      }).key);
    } catch { /* Malformed account metadata cannot establish self. */ }
  }
  const installationKey = serializeActorKey(installation);
  const issuerFor = (threadId: string) => {
    let pending = issuers.get(threadId);
    if (!pending) {
      pending = (async () => {
        const first = await resolveThreadActorIssuer({ ...input, threadId });
        return first ?? await resolveThreadActorIssuer({ ...input, threadId });
      })();
      issuers.set(threadId, pending);
    }
    return pending;
  };
  return async (message: DisplayMessage, threadId: string): Promise<ActorPresentation> => {
    const issuer = await issuerFor(threadId);
    input.assertCurrent?.();
    const { key } = chatActorForPresentation(message, issuer);
    const serialized = serializeActorKey(key);
    let group = groups.get(serialized);
    if (group === undefined) { group = String(groups.size); groups.set(serialized, group); }
    const ownerKey = key.kind === "agent" ? serializeActorKey(key.ownerKey) : serialized;
    const human = key.kind === "account" || key.kind === "installation" || key.kind === "legacy-human";
    const hueInput = human ? actorHueInput(key) : null;
    return { group, hue: hueInput ? ACTOR_HUES[actorHueSlot(hueInput.value)]! : null,
      self: (human || key.kind === "agent") && (ownerKey === installationKey || ownerKey === account) };
  };
}
