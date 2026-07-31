import { describe, expect, it, vi } from "vitest";
import type { CloudCredentials } from "./cloudCredentialStore";
import {
  pinVerifiedLegacyWorkspaceRemotes,
  syncEnrollmentRemoteWorkspaceId,
} from "./legacyWorkspaceRemotePin";
import type { RegistryEntry } from "./registryStore";

const credentials: CloudCredentials = {
  serverUrl: "https://cloud.dohc.example/",
  relayUrl: "https://relay.dohc.example",
  email: "ice@example.com",
  userId: "user-1",
  token: "secret",
};

function workspace(ownerUserId?: string): RegistryEntry {
  return {
    workspaceId: "workspace-1",
    rootPath: "C:\\workspace",
    kind: "personal",
    mode: "local-first",
    remote: {
      serverUrl: "https://cloud.dohc.example",
      remoteWorkspaceId: "remote-1",
      ...(ownerUserId ? { ownerUserId } : {}),
    },
  };
}

describe("legacy workspace remote account pins", () => {
  it("preserves an existing remote id when sync enrollment retries", () => {
    expect(syncEnrollmentRemoteWorkspaceId(workspace(), credentials)).toBe(
      "remote-1",
    );
    expect(
      syncEnrollmentRemoteWorkspaceId(
        { ...workspace(), remote: undefined },
        credentials,
      ),
    ).toBe("workspace-1");
    expect(() =>
      syncEnrollmentRemoteWorkspaceId(
        {
          ...workspace(),
          remote: {
            ...workspace().remote!,
            serverUrl: "https://other.example",
          },
        },
        credentials,
      ),
    ).toThrow("Sign in to the cloud server this workspace uses.");
  });

  it("pins a legacy remote only after the relay verifies ownership", async () => {
    const entry = workspace();
    const verifyOwnership = vi.fn(async () => undefined);
    const pin = vi.fn();

    await expect(
      pinVerifiedLegacyWorkspaceRemotes({
        workspaces: [entry],
        credentials,
        verifyOwnership,
        isCurrent: () => true,
        pin,
      }),
    ).resolves.toEqual({ pinned: ["workspace-1"], unverified: [] });
    expect(verifyOwnership).toHaveBeenCalledWith(entry);
    expect(pin).toHaveBeenCalledWith("workspace-1", {
      ...entry.remote,
      ownerUserId: "user-1",
    });
  });

  it("does not pin when relay verification fails or account state changes", async () => {
    const entry = workspace();
    const pin = vi.fn();

    await expect(
      pinVerifiedLegacyWorkspaceRemotes({
        workspaces: [entry],
        credentials,
        verifyOwnership: async () => {
          throw new Error("not this account");
        },
        isCurrent: () => true,
        pin,
      }),
    ).resolves.toEqual({ pinned: [], unverified: ["workspace-1"] });
    await pinVerifiedLegacyWorkspaceRemotes({
      workspaces: [entry],
      credentials,
      verifyOwnership: async () => undefined,
      isCurrent: () => false,
      pin,
    });
    expect(pin).not.toHaveBeenCalled();
  });

  it("skips pinned remotes, other servers, and sessions without a relay", async () => {
    const verifyOwnership = vi.fn(async () => undefined);
    const pin = vi.fn();
    await pinVerifiedLegacyWorkspaceRemotes({
      workspaces: [
        workspace("user-1"),
        {
          ...workspace(),
          workspaceId: "other-server",
          remote: {
            ...workspace().remote!,
            serverUrl: "https://other.example",
          },
        },
      ],
      credentials,
      verifyOwnership,
      isCurrent: () => true,
      pin,
    });
    await pinVerifiedLegacyWorkspaceRemotes({
      workspaces: [workspace()],
      credentials: { ...credentials, relayUrl: undefined },
      verifyOwnership,
      isCurrent: () => true,
      pin,
    });
    expect(verifyOwnership).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
  });
});
