import { createHmac, randomBytes } from "node:crypto";
import { actorHueInput, createActorIssuer, deriveLocalActor, deriveMomentActor, deriveRelayChatActor, serializeActorKey } from "@dohc/workspace-contracts/actor-identity";
import type { ActorIssuer, ActorRef, ActorKey, LocalActorIdentity } from "@dohc/workspace-contracts/actor-identity";
import { ACTOR_HUES, actorHueSlot } from "@dohc/workspace-contracts/actor-presentation";
import type { ChatMessage, MomentAuthor } from "@dohc/workspace-contracts/engine";
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
function localAccount(credentials: CloudCredentials | null): LocalActorIdentity["account"] {
  if (!credentials) return null;
  try { return { issuer: createActorIssuer(credentials.serverUrl), userId: credentials.userId }; }
  catch { /* Invalid account metadata leaves the installation hue and cannot establish self. */ return null; }
}
function localPersonKey(installationId: string, account: LocalActorIdentity["account"]): ActorKey {
  return deriveLocalActor({ identity: { installationId, account },
    workspaceId: "", author: { kind: "human" }, displayName: "", origin: "renderer" }).key;
}
// This computer's person signed out and signed in. The two keys stay apart.
function localPersonKeys(installationId: string, account: LocalActorIdentity["account"]): string[] {
  return [localPersonKey(installationId, null), ...(account ? [localPersonKey(installationId, account)] : [])].map(serializeActorKey);
}
// Chat and History share one rule: a group per key, a hue for people only, and self for this computer's person and their agents.
function presentationFor(workspaceId: string, key: ActorKey, unknownIdentity: () => string, own: readonly string[]): ActorPresentation {
  const serialized = serializeActorKey(key);
  const unknown = key.kind === "unknown";
  const group = groupFor(workspaceId, unknown ? unknownIdentity() : serialized, unknown);
  const ownerKey = key.kind === "agent" ? serializeActorKey(key.ownerKey) : serialized;
  const human = key.kind === "account" || key.kind === "installation" || key.kind === "legacy-human";
  return { group, hue: humanHue(key), self: (human || key.kind === "agent") && own.includes(ownerKey) };
}
export function ownActorPresentation(installationId: string, credentials: CloudCredentials | null): ActorPresentation {
  return { group: "own", hue: humanHue(localPersonKey(installationId, localAccount(credentials))), self: true };
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
  const own = localPersonKeys(input.installationId, localAccount(input.credentials));
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
    const workspaceId = input.readWorkspace()?.workspaceId;
    if (workspaceId === undefined) throw new Error("Chat workspace closed.");
    return presentationFor(workspaceId, key,
      () => JSON.stringify(["unknown", threadId, message.authorUserId ?? null, message.author.displayName]), own);
  };
}

/**
 * One History read's tokens, one per author in order. Own-store reads match this installation
 * and the current account, and make the named-author issuer from the workspace's server once.
 * Received authors get no issuer and never borrow credentials, so they stay owner-asserted and never self.
 */
export function createHistoryPresentationRequest(input: { workspaceId: string; assertCurrent(): void } & (
  | { source: "own-store"; serverUrl: string | undefined; installationId: string; credentials: CloudCredentials | null }
  | { source: "received" }
)): (authors: readonly MomentAuthor[]) => ActorPresentation[] {
  let context: Parameters<typeof deriveMomentActor>[1] = { source: "received" };
  let own: string[] = [];
  if (input.source === "own-store") {
    const account = localAccount(input.credentials);
    let relayIssuer: ActorIssuer | undefined;
    try { relayIssuer = input.serverUrl === undefined ? undefined : createActorIssuer(input.serverUrl); }
    catch { /* An invalid server leaves named authors neutral. */ }
    context = { source: "own-store", identity: { installationId: input.installationId, account },
      workspaceId: input.workspaceId, ...(relayIssuer ? { relayIssuer } : {}) };
    own = localPersonKeys(input.installationId, account);
  }
  return (authors) => {
    input.assertCurrent();
    return authors.map(author => presentationFor(input.workspaceId, deriveMomentActor(author, context, "").key,
      () => JSON.stringify(["unknown", author]), own));
  };
}
