import { createHmac, randomBytes } from "node:crypto";
import { actorHueInput, createActorIssuer, deriveLocalActor, deriveRelayChatActor, serializeActorKey } from "@dohc/workspace-contracts/actor-identity";
import type { ActorIssuer, ActorRef, ActorKey } from "@dohc/workspace-contracts/actor-identity";
import { ACTOR_HUES, actorHueSlot } from "@dohc/workspace-contracts/actor-presentation";
import type { ChatMessage } from "@dohc/workspace-contracts/engine";
import type { ActorPresentation } from "../ipc/bridgeContract";
import type { CloudCredentials } from "./cloudCredentialStore";
import { readLocalChatActor, resolveThreadActorIssuer } from "./chatRelayIdentity";

type DisplayMessage = Pick<ChatMessage, "author" | "authorActorKey" | "authorUserId" | "origin">;
const groups = new Map<string, { known: Map<string, string>; unknownSecret: Buffer }>();
let nextGroup = 0;

export function forgetWorkspacePresentation(workspaceId: string): void {
  groups.delete(workspaceId);
}
function groupFor(workspaceId: string, identity: string, unknown: boolean): string {
  let workspace = groups.get(workspaceId);
  if (!workspace) {
    workspace = { known: new Map(), unknownSecret: randomBytes(32) };
    groups.set(workspaceId, workspace);
  }
  // Untrusted labels get stable opaque groups without retaining each label.
  if (unknown) return "unknown:" + createHmac("sha256", workspace.unknownSecret).update(identity).digest("hex");
  let group = workspace.known.get(identity);
  if (group === undefined) { group = String(nextGroup++); workspace.known.set(identity, group); }
  return group;
}
function humanHue(key: ActorKey): ActorPresentation["hue"] {
  const human = key.kind === "account" || key.kind === "installation" || key.kind === "legacy-human";
  const input = human ? actorHueInput(key) : null;
  return input ? ACTOR_HUES[actorHueSlot(input.value)]! : null;
}
export function ownActorPresentation(installationId: string, credentials: CloudCredentials | null): ActorPresentation {
  let account: { issuer: ActorIssuer; userId: string } | null = null;
  if (credentials) {
    try { account = { issuer: createActorIssuer(credentials.serverUrl), userId: credentials.userId }; }
    catch { /* Invalid account metadata leaves the installation hue available. */ }
  }
  const key = deriveLocalActor({ identity: { installationId, account },
    workspaceId: "", author: { kind: "human" }, displayName: "", origin: "renderer" }).key;
  return { group: "own", hue: humanHue(key), self: true };
}

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
    const identity = key.kind === "unknown"
      ? JSON.stringify(["unknown", threadId, message.authorUserId ?? null, message.author.displayName]) : serialized;
    const workspaceId = input.readWorkspace()?.workspaceId;
    if (workspaceId === undefined) throw new Error("Chat workspace closed.");
    const group = groupFor(workspaceId, identity, key.kind === "unknown");
    const ownerKey = key.kind === "agent" ? serializeActorKey(key.ownerKey) : serialized;
    const human = key.kind === "account" || key.kind === "installation" || key.kind === "legacy-human";
    return { group, hue: humanHue(key),
      self: (human || key.kind === "agent") && (ownerKey === installationKey || ownerKey === account) };
  };
}
