import { createActorIssuer, parseActorKey } from "@dohc/workspace-contracts/actor-identity";
import type { ActorIssuer, ActorRef } from "@dohc/workspace-contracts/actor-identity";
import type { ChatMessage } from "@dohc/workspace-contracts/engine";
import type { CloudCredentials } from "./cloudCredentialStore";
import type {
  JoinedSharedChannel,
  RegistryEntry,
  RemoteIdentity,
} from "./registryStore";
import { joinedSharedChannelForTarget } from "./sharedChannels";
import { relayUrlsMatch } from "./syncCode";

export interface ChatRelayIdentityStore {
  findThreadChannelId(input: {
    workspaceId: string;
    threadId: string;
  }): Promise<string | null>;
  getChannelWireId(input: {
    workspaceId: string;
    channelId: string;
  }): Promise<string | null>;
}

export type ChatRelayIdentityTarget = { channelId: string } | { threadId: string };

export interface ResolvedChatRelayIdentity {
  joinedChannel: JoinedSharedChannel | null;
  authorUserId?: string;
}

function serverUrlsMatch(left: string, right: string): boolean {
  return left.replace(/\/+$/u, "") === right.replace(/\/+$/u, "");
}

export function workspaceRemoteMatchesCredentials(
  remote: RemoteIdentity,
  credentials: CloudCredentials | null,
): boolean {
  return (
    credentials !== null &&
    serverUrlsMatch(remote.serverUrl, credentials.serverUrl) &&
    remote.ownerUserId === credentials.userId
  );
}

export function joinedChannelMatchesCredentials(
  channel: JoinedSharedChannel,
  credentials: CloudCredentials | null,
): boolean {
  return (
    credentials?.relayUrl !== undefined &&
    channel.recipientUserId === credentials.userId &&
    relayUrlsMatch(credentials.relayUrl, channel.relayUrl)
  );
}

/**
 * The relay identity a SHARE VIEW writes chat under.
 *
 * A share view is not an enrolled workspace — it has no `remote`, and no
 * owner id to write as. Its relay identity is the account that holds the
 * grant: the signed-in user, and only while that session belongs to the
 * share's own relay.
 *
 * This matters more than it looks. A chat op replicates only when its author
 * carries a user id, so an unresolved identity here does not degrade to a
 * local-only comment — it produces a comment that looks sent and never
 * leaves the machine. Callers must refuse the write instead.
 */
export function resolveShareViewRelayAuthorId(
  shareView: { relayUrl?: string },
  credentials: CloudCredentials | null,
): string | undefined {
  if (!credentials?.relayUrl) return;
  if (shareView.relayUrl && !relayUrlsMatch(credentials.relayUrl, shareView.relayUrl)) {
    return;
  }
  return credentials.userId;
}

export function resolveWorkspaceRelayAuthorId(
  workspace: Pick<RegistryEntry, "remote" | "pausedRemote">,
  credentials: CloudCredentials | null,
): string | undefined {
  const remote = workspace.remote ?? workspace.pausedRemote;
  if (!remote || !workspaceRemoteMatchesCredentials(remote, credentials)) {
    return;
  }
  return remote.ownerUserId;
}

export function assertSyncEnrollmentCredentials(
  workspace: Pick<RegistryEntry, "remote" | "pausedRemote">,
  credentials: Pick<CloudCredentials, "serverUrl" | "userId">,
): void {
  const remote = workspace.remote ?? workspace.pausedRemote;
  if (!remote) return;
  if (!serverUrlsMatch(remote.serverUrl, credentials.serverUrl)) {
    throw new Error("Sign in to the cloud server this workspace uses.");
  }
  if (remote.ownerUserId !== credentials.userId) {
    throw new Error("Sign in to the account that synced this workspace.");
  }
}

export async function resolveChatRelayIdentity(input: {
  workspace: Pick<RegistryEntry, "workspaceId" | "remote" | "pausedRemote" | "sharedChannels" | "shareView">;
  credentials: CloudCredentials | null;
  store: ChatRelayIdentityStore;
  target: ChatRelayIdentityTarget;
}): Promise<ResolvedChatRelayIdentity> {
  const joinedChannel =
    (await joinedSharedChannelForTarget({
      workspaceId: input.workspace.workspaceId,
      sharedChannels: input.workspace.sharedChannels,
      store: input.store,
      target: input.target,
    })) ?? null;
  const authorUserId = chatRelayAuthorId(input.workspace, joinedChannel, input.credentials);
  return {
    joinedChannel,
    ...(authorUserId ? { authorUserId } : {}),
  };
}

// The synchronous half of resolveChatRelayIdentity, for a caller that already
// resolved the target's joined channel.
export function chatRelayAuthorId(
  workspace: Pick<RegistryEntry, "remote" | "pausedRemote" | "shareView">,
  joinedChannel: JoinedSharedChannel | null,
  credentials: CloudCredentials | null,
): string | undefined {
  if (joinedChannel) {
    return joinedChannelMatchesCredentials(joinedChannel, credentials)
      ? joinedChannel.recipientUserId
      : undefined;
  }
  return workspace.shareView
    ? resolveShareViewRelayAuthorId(workspace.shareView, credentials)
    : resolveWorkspaceRelayAuthorId(workspace, credentials);
}

export function assertSharedChannelMessageIdentity(input: {
  joinedChannel: JoinedSharedChannel | null;
  credentials: CloudCredentials | null;
  authorUserId?: string;
  resolvedAuthorUserId: string | undefined;
}): void {
  if (!input.joinedChannel) {
    if (input.authorUserId !== input.resolvedAuthorUserId) {
      throw new Error("Your server session changed. Try again.");
    }
    return;
  }
  if (!input.credentials) {
    throw new Error("Sign in to your server to send a message here.");
  }
  if (
    !input.credentials.relayUrl ||
    !relayUrlsMatch(input.credentials.relayUrl, input.joinedChannel.relayUrl)
  ) {
    throw new Error("Sign in to the cloud server this was shared from.");
  }
  if (
    input.credentials.userId !== input.joinedChannel.recipientUserId ||
    input.authorUserId !== input.joinedChannel.recipientUserId
  ) {
    throw new Error("Sign in to the account that joined this.");
  }
}

// Only the native own-store column contains keys this device serialized.
// Assurance comes from admitted origin and author kind, never the key alone.
export function readLocalChatActor(message: Pick<ChatMessage, "authorActorKey" | "author" | "origin">): ActorRef | null {
  const key = message.authorActorKey === undefined ? null : parseActorKey(message.authorActorKey);
  if (key === null) return null;
  const origin = message.origin ?? (message.author.kind === "human" ? "renderer"
    : message.author.kind === "automation" ? "automation" : "unknown");
  return {
    key, displayName: message.author.displayName, origin,
    assurance: key.kind === "unknown" ? "unknown"
      : message.author.kind === "human" && origin === "renderer" ? "local" : "owner-asserted",
  };
}

export async function resolveThreadActorIssuer(input: {
  readWorkspace(): Pick<RegistryEntry, "workspaceId" | "remote" | "pausedRemote" | "sharedChannels" | "shareView"> | null;
  store: ChatRelayIdentityStore;
  threadId: string;
  // Fence caller attachment/session replacement as well as registry replacement.
  assertCurrent?: () => void;
}): Promise<ActorIssuer | null> {
  const { store, threadId } = input;
  const workspace = input.readWorkspace();
  if (workspace === null) return null;
  const workspaceId = workspace.workspaceId;
  const changed = new Error("Chat issuer binding changed");
  const check = () => {
    input.assertCurrent?.();
    if (input.readWorkspace() !== workspace) throw changed;
  };
  const guardedStore: ChatRelayIdentityStore = {
    async findThreadChannelId(target) {
      check();
      const result = await store.findThreadChannelId(target);
      check();
      return result;
    },
    async getChannelWireId(target) {
      check();
      const result = await store.getChannelWireId(target);
      check();
      return result;
    },
  };
  try {
    check();
    // A received file share has no admitted account issuer in its registry.
    if (workspace.shareView) return null;
    const joined = await joinedSharedChannelForTarget({
      workspaceId, sharedChannels: workspace.sharedChannels, store: guardedStore, target: { threadId },
    });
    check();
    const serverUrl = joined ? joined.serverUrl : (workspace.remote ?? workspace.pausedRemote)?.serverUrl;
    if (!serverUrl) return null;
    try {
      return createActorIssuer(serverUrl);
    } catch {
      return null;
    }
  } catch (error) {
    if (error === changed) return null;
    throw error;
  }
}
