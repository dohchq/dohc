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

export function resolveWorkspaceRelayAuthorId(
  workspace: Pick<RegistryEntry, "remote">,
  credentials: CloudCredentials | null,
): string | undefined {
  if (
    !workspace.remote ||
    !workspaceRemoteMatchesCredentials(workspace.remote, credentials)
  ) {
    return;
  }
  return workspace.remote.ownerUserId;
}

export function syncEnrollmentRemoteWorkspaceId(
  workspace: Pick<RegistryEntry, "workspaceId" | "remote">,
  credentials: Pick<CloudCredentials, "serverUrl" | "userId">,
): string {
  const remote = workspace.remote;
  if (!remote) return workspace.workspaceId;
  if (!serverUrlsMatch(remote.serverUrl, credentials.serverUrl)) {
    throw new Error("Sign in to the cloud server this workspace uses.");
  }
  if (remote.ownerUserId !== credentials.userId) {
    throw new Error("Sign in to the account that synced this workspace.");
  }
  return remote.remoteWorkspaceId;
}

export async function resolveChatRelayIdentity(input: {
  workspace: Pick<RegistryEntry, "workspaceId" | "remote" | "sharedChannels">;
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
  const authorUserId = joinedChannel
    ? joinedChannelMatchesCredentials(joinedChannel, input.credentials)
      ? joinedChannel.recipientUserId
      : undefined
    : resolveWorkspaceRelayAuthorId(input.workspace, input.credentials);
  return {
    joinedChannel,
    ...(authorUserId ? { authorUserId } : {}),
  };
}

export function assertSharedChannelMessageIdentity(input: {
  joinedChannel: JoinedSharedChannel | null;
  credentials: CloudCredentials | null;
  authorUserId?: string;
}): void {
  if (!input.joinedChannel) return;
  if (!input.credentials) {
    throw new Error("Sign in to dohc Cloud to send a message in this shared channel.");
  }
  if (
    !input.credentials.relayUrl ||
    !relayUrlsMatch(input.credentials.relayUrl, input.joinedChannel.relayUrl)
  ) {
    throw new Error("Sign in to the cloud server this shared channel uses.");
  }
  if (
    input.credentials.userId !== input.joinedChannel.recipientUserId ||
    input.authorUserId !== input.joinedChannel.recipientUserId
  ) {
    throw new Error("Sign in to the account that joined this shared channel.");
  }
}
