import { describe, expect, it } from "vitest";
import type { CloudCredentials } from "./cloudCredentialStore";
import {
  assertSharedChannelMessageIdentity,
  joinedChannelMatchesCredentials,
  resolveChatRelayIdentity,
  resolveWorkspaceRelayAuthorId,
  workspaceRemoteMatchesCredentials,
  type ChatRelayIdentityStore,
} from "./chatRelayIdentity";
import type { JoinedSharedChannel, RegistryEntry } from "./registryStore";

const joinedChannel: JoinedSharedChannel = {
  shareId: "share-1",
  channelWireId: "wire-shared",
  access: "read-write",
  granterEmail: "owner@example.com",
  relayUrl: "https://shared-relay.test",
  recipientUserId: "user-1",
};

const credentials: CloudCredentials = {
  serverUrl: "https://cloud.test",
  relayUrl: "https://shared-relay.test/",
  email: "member@example.com",
  userId: "user-1",
  token: "token",
};

function workspace(
  overrides: Partial<
    Pick<RegistryEntry, "workspaceId" | "remote" | "sharedChannels">
  > = {},
): Pick<RegistryEntry, "workspaceId" | "remote" | "sharedChannels"> {
  return {
    workspaceId: "workspace-1",
    remote: {
      serverUrl: "https://cloud.test/",
      remoteWorkspaceId: "remote-workspace-1",
      ownerUserId: "user-1",
    },
    sharedChannels: [joinedChannel],
    ...overrides,
  };
}

const store: ChatRelayIdentityStore = {
  async findThreadChannelId({ threadId }) {
    return threadId === "thread-shared" ? "channel-shared" : "channel-local";
  },
  async getChannelWireId({ channelId }) {
    return channelId === "channel-shared" ? "wire-shared" : "wire-local";
  },
};

describe("resolveWorkspaceRelayAuthorId", () => {
  it("returns the pinned user only for matching account credentials", () => {
    expect(resolveWorkspaceRelayAuthorId(workspace(), credentials)).toBe("user-1");
    expect(
      resolveWorkspaceRelayAuthorId(workspace(), {
        ...credentials,
        serverUrl: "https://other-cloud.test",
      }),
    ).toBeUndefined();
    expect(
      resolveWorkspaceRelayAuthorId(workspace(), {
        ...credentials,
        userId: "user-2",
      }),
    ).toBeUndefined();
    expect(
      resolveWorkspaceRelayAuthorId(
        workspace({
          remote: {
            serverUrl: "https://cloud.test/",
            remoteWorkspaceId: "remote-workspace-1",
          },
        }),
        credentials,
      ),
    ).toBeUndefined();
    expect(resolveWorkspaceRelayAuthorId(workspace(), null)).toBeUndefined();
    expect(
      resolveWorkspaceRelayAuthorId(workspace({ remote: undefined }), credentials),
    ).toBeUndefined();
  });
});

describe("persisted relay account pins", () => {
  it("rejects legacy workspace remotes and same-server account mismatches", () => {
    expect(workspaceRemoteMatchesCredentials(workspace().remote!, credentials)).toBe(
      true,
    );
    expect(
      workspaceRemoteMatchesCredentials(
        {
          serverUrl: "https://cloud.test/",
          remoteWorkspaceId: "remote-workspace-1",
        },
        credentials,
      ),
    ).toBe(false);
    expect(
      workspaceRemoteMatchesCredentials(
        {
          serverUrl: "https://cloud.test/",
          remoteWorkspaceId: "remote-workspace-1",
          ownerUserId: "user-2",
        },
        credentials,
      ),
    ).toBe(false);
  });

  it("requires the joined channel relay and account pins", () => {
    expect(joinedChannelMatchesCredentials(joinedChannel, credentials)).toBe(true);
    expect(
      joinedChannelMatchesCredentials(
        { ...joinedChannel, recipientUserId: undefined },
        credentials,
      ),
    ).toBe(false);
    expect(
      joinedChannelMatchesCredentials(joinedChannel, {
        ...credentials,
        userId: "user-2",
      }),
    ).toBe(false);
    expect(
      joinedChannelMatchesCredentials(joinedChannel, {
        ...credentials,
        relayUrl: "https://other-relay.test",
      }),
    ).toBe(false);
  });
});

describe("resolveChatRelayIdentity", () => {
  it("uses the joined channel relay identity for channel and thread targets", async () => {
    await expect(
      resolveChatRelayIdentity({
        workspace: workspace({
          remote: {
            serverUrl: "https://other-cloud.test",
            remoteWorkspaceId: "remote-workspace-1",
            ownerUserId: "user-1",
          },
        }),
        credentials,
        store,
        target: { channelId: "channel-shared" },
      }),
    ).resolves.toEqual({ joinedChannel, authorUserId: "user-1" });

    await expect(
      resolveChatRelayIdentity({
        workspace: workspace(),
        credentials: { ...credentials, relayUrl: "https://other-relay.test" },
        store,
        target: { threadId: "thread-shared" },
      }),
    ).resolves.toEqual({ joinedChannel });

    await expect(
      resolveChatRelayIdentity({
        workspace: workspace(),
        credentials: { ...credentials, userId: "user-2" },
        store,
        target: { channelId: "channel-shared" },
      }),
    ).resolves.toEqual({ joinedChannel });

    const legacyJoinedChannel = {
      ...joinedChannel,
      recipientUserId: undefined,
    };
    await expect(
      resolveChatRelayIdentity({
        workspace: workspace({ sharedChannels: [legacyJoinedChannel] }),
        credentials,
        store,
        target: { channelId: "channel-shared" },
      }),
    ).resolves.toEqual({ joinedChannel: legacyJoinedChannel });
  });

  it("uses the workspace cloud identity outside joined channels", async () => {
    await expect(
      resolveChatRelayIdentity({
        workspace: workspace(),
        credentials,
        store,
        target: { channelId: "channel-local" },
      }),
    ).resolves.toEqual({ joinedChannel: null, authorUserId: "user-1" });

    await expect(
      resolveChatRelayIdentity({
        workspace: workspace(),
        credentials: { ...credentials, serverUrl: "https://other-cloud.test" },
        store,
        target: { threadId: "thread-local" },
      }),
    ).resolves.toEqual({ joinedChannel: null });
  });
});

describe("assertSharedChannelMessageIdentity", () => {
  it("requires sign-in for a joined shared-channel message", () => {
    expect(() =>
      assertSharedChannelMessageIdentity({
        joinedChannel,
        credentials: null,
      }),
    ).toThrowError("Sign in to dohc Cloud to send a message in this shared channel.");
  });

  it("requires credentials from the joined channel relay", () => {
    expect(() =>
      assertSharedChannelMessageIdentity({
        joinedChannel,
        credentials: { ...credentials, relayUrl: "https://other-relay.test" },
        authorUserId: "user-1",
      }),
    ).toThrowError("Sign in to the cloud server this shared channel uses.");
  });

  it("requires the account that joined the shared channel", () => {
    expect(() =>
      assertSharedChannelMessageIdentity({
        joinedChannel,
        credentials: { ...credentials, userId: "user-2" },
      }),
    ).toThrowError("Sign in to the account that joined this shared channel.");
  });

  it("requires legacy channels to be left and joined again", () => {
    expect(() =>
      assertSharedChannelMessageIdentity({
        joinedChannel: { ...joinedChannel, recipientUserId: undefined },
        credentials,
      }),
    ).toThrowError(
      "This shared channel needs a new account link. Leave it, then join it again.",
    );
  });

  it("allows matching shared-channel identity and local messages", () => {
    expect(() =>
      assertSharedChannelMessageIdentity({
        joinedChannel,
        credentials,
        authorUserId: "user-1",
      }),
    ).not.toThrow();
    expect(() =>
      assertSharedChannelMessageIdentity({
        joinedChannel: null,
        credentials: null,
      }),
    ).not.toThrow();
  });
});
