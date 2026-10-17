import { describe, expect, it } from "vitest";
import type { CloudCredentials } from "./cloudCredentialStore";
import { localPersonOwnsWorkspace } from "./localPersonOwns";

const credentials: CloudCredentials = {
  serverUrl: "https://cloud.test",
  userId: "owner",
  email: "owner@example.com",
  token: "token",
};
const remote = { serverUrl: "https://cloud.test/", ownerUserId: "owner" };

describe("localPersonOwnsWorkspace", () => {
  describe.each(["remote", "pausedRemote"] as const)("with %s", field => {
    const workspace = { [field]: remote };

    it("refuses a signed-out person", () => {
      expect(localPersonOwnsWorkspace(workspace, null)).toBe(false);
    });

    it("refuses another account", () => {
      expect(localPersonOwnsWorkspace(workspace, { ...credentials, userId: "other" })).toBe(false);
    });

    it("refuses the same user id on another server", () => {
      expect(localPersonOwnsWorkspace(workspace, { ...credentials, serverUrl: "https://other.test" })).toBe(false);
    });

    it("accepts the owning account on its server", () => {
      expect(localPersonOwnsWorkspace(workspace, credentials)).toBe(true);
    });

    it("refuses a shared view even for the owning account", () => {
      const shareView = {
        shareId: "share-1",
        granterEmail: credentials.email,
        genericChatWritable: false,
        grantedSelector: { paths: [], versionId: "main", access: "view" as const },
      };
      expect(localPersonOwnsWorkspace({ ...workspace, shareView }, credentials)).toBe(false);
    });
  });

  it("accepts this computer's person for a never-synced workspace", () => {
    expect(localPersonOwnsWorkspace({}, null)).toBe(true);
    expect(localPersonOwnsWorkspace({}, credentials)).toBe(true);
  });

  it("refuses a missing workspace", () => {
    expect(localPersonOwnsWorkspace(null, credentials)).toBe(false);
    expect(localPersonOwnsWorkspace(undefined, credentials)).toBe(false);
  });
});
