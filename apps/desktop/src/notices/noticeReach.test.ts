import { describe, expect, it } from "vitest";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import { noticeReachFor } from "./noticeReach";

const credentials: CloudCredentials = {
  serverUrl: "https://server.dohc.test",
  relayUrl: "https://relay.dohc.test",
  email: "ana@dohc.test",
  userId: "ana",
  token: "token",
};

const shareView = {
  shareId: "share-1",
  granterEmail: "owner@dohc.test",
  genericChatWritable: true,
  grantedSelector: { paths: ["trip"], versionId: null, access: "comment" as const },
  relayUrl: "https://relay.dohc.test",
};

describe("how a workspace's notices reach the relay", () => {
  it("names an owned workspace synced to the signed-in account", () => {
    const workspace = { workspaceId: "trip", remote: { serverUrl: "https://server.dohc.test", ownerUserId: "ana" } };
    expect(noticeReachFor(workspace, credentials)).toEqual({ workspaceId: "trip" });
    expect(noticeReachFor({ ...workspace, remote: { ...workspace.remote, ownerUserId: "ben" } }, credentials)).toBeNull();
    expect(noticeReachFor({ workspaceId: "local" }, credentials)).toBeNull();
  });

  it("names the share of a share view until the share ends", () => {
    expect(noticeReachFor({ workspaceId: "view", shareView }, credentials)).toEqual({ shareId: "share-1" });
    expect(noticeReachFor({ workspaceId: "view", shareView: { ...shareView, ended: true } }, credentials)).toBeNull();
    expect(noticeReachFor({ workspaceId: "view", shareView: { ...shareView, relayUrl: "https://other.dohc.test" } }, credentials))
      .toBeNull();
  });
});
