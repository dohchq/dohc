import { describe, expect, it } from "vitest";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import { mcpCloudEnvironment } from "./mcpCloudEnvironment";

const credentials: CloudCredentials = {
  serverUrl: "https://cloud.test",
  relayUrl: "https://relay.test",
  email: "ice@dohc.test",
  userId: "user-1",
  token: "token-1",
};

describe("mcpCloudEnvironment", () => {
  it("includes the verified user identity for matching workspace credentials", () => {
    expect(
      mcpCloudEnvironment({
        workspace: {
          remote: {
            serverUrl: "https://cloud.test/",
            remoteWorkspaceId: "remote-workspace-1",
            ownerUserId: "user-1",
          },
        },
        credentials,
        ownerName: "Ice",
      }),
    ).toEqual({
      DOHC_MCP_CLOUD_SERVER_URL: "https://cloud.test",
      DOHC_MCP_CLOUD_EMAIL: "ice@dohc.test",
      DOHC_MCP_OWNER_NAME: "Ice",
      DOHC_MCP_CLOUD_TOKEN: "token-1",
      DOHC_MCP_CLOUD_USER_ID: "user-1",
    });
  });

  it("omits cloud credentials while signed out or using another server or account", () => {
    const workspace = {
      remote: {
        serverUrl: "https://cloud.test",
        remoteWorkspaceId: "remote-workspace-1",
        ownerUserId: "user-1",
      },
    };
    expect(
      mcpCloudEnvironment({ workspace, credentials: null, ownerName: "Ice" }),
    ).toBeUndefined();
    expect(
      mcpCloudEnvironment({
        workspace,
        credentials: { ...credentials, serverUrl: "https://other-cloud.test" },
        ownerName: "Ice",
      }),
    ).toBeUndefined();
    expect(
      mcpCloudEnvironment({
        workspace,
        credentials: { ...credentials, userId: "user-2" },
        ownerName: "Ice",
      }),
    ).toBeUndefined();
    expect(
      mcpCloudEnvironment({
        workspace: {
          remote: {
            serverUrl: "https://cloud.test",
            remoteWorkspaceId: "remote-workspace-1",
          },
        },
        credentials,
        ownerName: "Ice",
      }),
    ).toBeUndefined();
  });
});
