import type { ChatLinksEnginePage } from "@dohc/workspace-contracts/chat-links";
import { createHmac, randomBytes } from "node:crypto";
import { actorHueInput, createActorIssuer, deriveLocalActor, deriveMomentActor, deriveRelayChatActor, parseActorKey, serializeActorKey } from "@dohc/workspace-contracts/actor-identity";
import type { ActorIssuer, ActorRef, ActorKey, LocalActorIdentity } from "@dohc/workspace-contracts/actor-identity";
import { ACTOR_HUES, actorHueSlot } from "@dohc/workspace-contracts/actor-presentation";
import type { ChatMessage, MomentAuthor } from "@dohc/workspace-contracts/engine";
import type { ActorPresentation } from "../ipc/bridgeContract";
import type { AgentColors } from "../settings/userSettings";
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
type AgentColorSource = () => AgentColors | undefined;
function agentColorsReader(source: AgentColorSource | undefined) {
  let previous: AgentColors | undefined;
  let colors = admittedAgentColors();
  return () => {
    const current = source?.();
    if (current !== previous) { previous = current; colors = admittedAgentColors(current); }
    return colors;
  };
}
function admittedAgentColors(colors: AgentColors = {}): Map<string, ActorPresentation["hue"]> {
  const admitted = new Map<string, ActorPresentation["hue"]>();
  for (const [serialized, hue] of Object.entries(colors)) {
    const key = parseActorKey(serialized);
    if (key?.kind === "agent" && serializeActorKey(key) === serialized) admitted.set(serialized, hue);
  }
  return admitted;
}

export function agentKeyForGroup(workspaceId: string, group: string): string {
  const serialized = [...(groups.get(workspaceId)?.known ?? [])].find(([, issued]) => issued === group)?.[0];
  if (serialized === undefined || parseActorKey(serialized)?.kind !== "agent") {
    throw new Error("Choose an agent shown in this workspace.");
  }
  return serialized;
}

export function agentColorChanges(previous: AgentColors = {}, next: AgentColors = {}) {
  const before = admittedAgentColors(previous), after = admittedAgentColors(next);
  const changes: Array<{ workspaceId: string; group: string; hue: ActorPresentation["hue"] }> = [];
  for (const [workspaceId, workspace] of groups) {
    for (const [key, group] of workspace.known) {
      const hue = after.get(key) ?? null;
      if ((before.get(key) ?? null) !== hue) changes.push({ workspaceId, group, hue });
    }
  }
  return changes;
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
// Chat and History share one rule: a group per key, a personal agent hue or a human hash, and self for this computer's person and their agents.
function presentationFor(workspaceId: string, key: ActorKey, unknownIdentity: () => string, own: readonly string[], colors: Map<string, ActorPresentation["hue"]>): ActorPresentation {
  const serialized = serializeActorKey(key);
  const unknown = key.kind === "unknown";
  const group = groupFor(workspaceId, unknown ? unknownIdentity() : serialized, unknown);
  const ownerKey = key.kind === "agent" ? serializeActorKey(key.ownerKey) : serialized;
  const human = key.kind === "account" || key.kind === "installation" || key.kind === "legacy-human";
  return { group, hue: key.kind === "agent" ? colors.get(serialized) ?? null : humanHue(key), self: (human || key.kind === "agent") && own.includes(ownerKey) };
}
export function ownActorPresentation(installationId: string, credentials: CloudCredentials | null): ActorPresentation {
  return { group: "own", hue: humanHue(localPersonKey(installationId, localAccount(credentials))), self: true };
}

export function chatActorForPresentation(message: DisplayMessage, issuer: ActorIssuer | null): ActorRef {
  // A link holder is its link alone: no local key, issuer, or account.
  if (message.author.kind === "link") {
    const { displayName, grantId, principalId } = message.author;
    return deriveRelayChatActor({ issuer: null, kind: "link", grantId, principalId, displayName });
  }
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
  agentColors?: AgentColorSource;
}) {
  const colors = agentColorsReader(input.agentColors);
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
      () => JSON.stringify(["unknown", threadId, message.authorUserId ?? null, message.author.displayName]), own, colors());
  };
}

/**
 * One History read's tokens, one per author in order. Own-store reads match this installation
 * and the current account on the workspace's server, and make the named-author issuer from that server once.
 * Received authors get no issuer and never borrow credentials, so they stay owner-asserted and never self.
 */
export function createHistoryPresentationRequest(input: { workspaceId: string; assertCurrent(): void; agentColors?: AgentColorSource } & (
  | { source: "own-store"; serverUrl: string | undefined; synced: boolean; installationId: string; credentials: CloudCredentials | null }
  | { source: "received" }
)): (authors: readonly MomentAuthor[]) => ActorPresentation[] {
  const colors = agentColorsReader(input.agentColors);
  let context: Parameters<typeof deriveMomentActor>[1] = { source: "received" };
  let own: string[] = [];
  if (input.source === "own-store") {
    let relayIssuer: ActorIssuer | undefined;
    try { relayIssuer = input.serverUrl === undefined ? undefined : createActorIssuer(input.serverUrl); }
    catch { /* An invalid server leaves named authors neutral. */ }
    // Moments name people by user id alone. A synced store's ids belong to its server, so an
    // account on another server, beside a server that can't be read, or in a folder that
    // synced and has no remote now, is not you here.
    const signedIn = localAccount(input.credentials);
    const account = signedIn && (input.serverUrl === undefined ? !input.synced : signedIn.issuer === relayIssuer) ? signedIn : null;
    context = { source: "own-store", identity: { installationId: input.installationId, account },
      workspaceId: input.workspaceId, ...(relayIssuer ? { relayIssuer } : {}) };
    own = localPersonKeys(input.installationId, account);
  }
  return (authors) => {
    input.assertCurrent();
    return authors.map(author => presentationFor(input.workspaceId, deriveMomentActor(author, context, "").key,
      () => JSON.stringify(["unknown", author]), own, colors()));
  };
}

export function chatLinkMessageForPresentation(
  author: NonNullable<ChatLinksEnginePage>["entries"][number]["author"],
): DisplayMessage {
  if (author.authorKind === "link") {
    return { author: { kind: "link", displayName: author.authorDisplayName, grantId: author.linkGrantId, principalId: author.linkPrincipalId } };
  }
  // Relay origin changes assurance, not the key used for grouping, hue and self.
  return {
    author: { kind: author.authorKind, displayName: author.authorDisplayName },
    ...(author.authorUserId === undefined ? {} : { authorUserId: author.authorUserId }),
    ...(author.authorActorKey === undefined ? {} : { authorActorKey: author.authorActorKey }),
  };
}
