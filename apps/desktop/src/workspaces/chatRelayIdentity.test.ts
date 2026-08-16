import { describe, expect, it } from "vitest";
import type { CloudCredentials } from "./cloudCredentialStore";
import {
  assertSharedChannelMessageIdentity,
  joinedChannelMatchesCredentials,
  resolveChatRelayIdentity,
  resolveShareViewRelayAuthorId,
  resolveWorkspaceRelayAuthorId,
  syncEnrollmentRemoteWorkspaceId,
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
    expect(resolveWorkspaceRelayAuthorId(workspace(), null)).toBeUndefined();
    expect(
      resolveWorkspaceRelayAuthorId(workspace({ remote: undefined }), credentials),
    ).toBeUndefined();
  });
});

describe("persisted relay account pins", () => {
  it("rejects same-server account mismatches", () => {
    expect(workspaceRemoteMatchesCredentials(workspace().remote!, credentials)).toBe(
      true,
    );
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

  it("requires the joined channel relay and account", () => {
    expect(joinedChannelMatchesCredentials(joinedChannel, credentials)).toBe(true);
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
        resolvedAuthorUserId: undefined,
      }),
    ).toThrowError("Sign in to dohc Cloud to send a message in this shared channel.");
  });

  it("requires credentials from the joined channel relay", () => {
    expect(() =>
      assertSharedChannelMessageIdentity({
        joinedChannel,
        credentials: { ...credentials, relayUrl: "https://other-relay.test" },
        authorUserId: "user-1",
        resolvedAuthorUserId: "user-1",
      }),
    ).toThrowError("Sign in to the cloud server this shared channel uses.");
  });

  it("requires the account that joined the shared channel", () => {
    expect(() =>
      assertSharedChannelMessageIdentity({
        joinedChannel,
        credentials: { ...credentials, userId: "user-2" },
        resolvedAuthorUserId: undefined,
      }),
    ).toThrowError("Sign in to the account that joined this shared channel.");
  });

  it("allows matching shared-channel identity and local messages", () => {
    expect(() =>
      assertSharedChannelMessageIdentity({
        joinedChannel,
        credentials,
        authorUserId: "user-1",
        resolvedAuthorUserId: "user-1",
      }),
    ).not.toThrow();
    expect(() =>
      assertSharedChannelMessageIdentity({
        joinedChannel: null,
        credentials: null,
        resolvedAuthorUserId: undefined,
      }),
    ).not.toThrow();
  });

  it("rejects a stale author outside joined channels", () => {
    expect(() =>
      assertSharedChannelMessageIdentity({
        joinedChannel: null,
        credentials,
        authorUserId: "user-1",
        resolvedAuthorUserId: "user-2",
      }),
    ).toThrowError("Your dohc Cloud session changed. Try again.");
  });
});

describe("syncEnrollmentRemoteWorkspaceId", () => {
  it("reuses the current account's remote id", () => {
    expect(syncEnrollmentRemoteWorkspaceId(workspace(), credentials)).toBe(
      "remote-workspace-1",
    );
    expect(
      syncEnrollmentRemoteWorkspaceId(
        workspace({ remote: undefined }),
        credentials,
      ),
    ).toBe("workspace-1");
  });

  it("rejects a different server or account", () => {
    expect(() =>
      syncEnrollmentRemoteWorkspaceId(workspace(), {
        ...credentials,
        serverUrl: "https://other-cloud.test",
      }),
    ).toThrowError("Sign in to the cloud server this workspace uses.");
    expect(() =>
      syncEnrollmentRemoteWorkspaceId(workspace(), {
        ...credentials,
        userId: "user-2",
      }),
    ).toThrowError("Sign in to the account that synced this workspace.");
  });
});

// #646 PR2 — a share view's chat identity. A share view is not an enrolled
// workspace: it has no `remote` and no owner id to write as, so the account
// that holds the grant is the one it writes under.
describe("share view chat identity (#646 PR2)", () => {
  const credentials = {
    serverUrl: "https://cloud.dohc.test",
    relayUrl: "https://relay.dohc.test",
    email: "recipient@dohc.test",
    userId: "recipient",
    token: "token",
  };

  it("writes as the signed-in account that holds the grant", () => {
    expect(
      resolveShareViewRelayAuthorId({ relayUrl: "https://relay.dohc.test" }, credentials),
    ).toBe("recipient");
    // A record with no recorded relay predates the field; the session's own
    // relay is the only one it could have come from.
    expect(resolveShareViewRelayAuthorId({}, credentials)).toBe("recipient");
  });

  it("resolves nothing when signed out or signed into another relay", () => {
    // Both answers must be undefined, and the CALLER must refuse rather than
    // write: a chat op with no author never replicates, so a comment written
    // here would look sent and never leave the machine.
    expect(
      resolveShareViewRelayAuthorId({ relayUrl: "https://relay.dohc.test" }, null),
    ).toBeUndefined();
    expect(
      resolveShareViewRelayAuthorId(
        { relayUrl: "https://relay.dohc.test" },
        { ...credentials, relayUrl: undefined },
      ),
    ).toBeUndefined();
    expect(
      resolveShareViewRelayAuthorId(
        { relayUrl: "https://relay.dohc.test" },
        { ...credentials, relayUrl: "https://other-relay.dohc.test" },
      ),
      "MUTATION: writing under a session from another relay claims an identity that relay never issued",
    ).toBeUndefined();
  });

  it("prefers the share view's account over the enrolled-workspace rule", async () => {
    // The two rules would answer differently, and only one of them is this
    // workspace's: a share view's `remote` is absent, and reading the owner
    // id of a workspace it is not would be someone else's identity.
    const identity = await resolveChatRelayIdentity({
      workspace: {
        workspaceId: "share-view-workspace",
        shareView: {
          shareId: "share-1",
          granterEmail: "granter@dohc.test",
          grantedSelector: { paths: ["docs"], versionId: null, access: "comment" },
          relayUrl: "https://relay.dohc.test",
        },
      },
      credentials,
      store: {
        findThreadChannelId: async () => null,
        getChannelWireId: async () => null,
      },
      target: { threadId: "thread-1" },
    });
    expect(identity.joinedChannel).toBeNull();
    expect(identity.authorUserId).toBe("recipient");
  });
});
