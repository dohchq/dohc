import { expect, it, vi } from "vitest";
import { createShareCopyHandler } from "./shareCopyHandler";
import { shareCopyOperations, ShareCopyInput, ShareCopyResult } from "./shareCopyOperations";
import { operationBridge, registerOperations } from "./operationTable";
import { workspaceRemoteMatchesCredentials } from "../workspaces/chatRelayIdentity";
import { deferred } from "../testing/deferred";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";

const input = { shareId: "share", grantId: "grant" };
const active = { workspaceId: "workspace", ...input, status: "active" as const,
  browserInvitationUrl: "https://share.test/s/edit/grant", credentials: "must-not-cross" };
function harness() {
  let current = true, generation = 1;
  let credentials: CloudCredentials | null = { serverUrl: "https://account.test", relayUrl: "https://relay.test",
    userId: "owner", email: "owner@test", token: "secret" };
  const workspace = { workspaceId: "workspace", shareView: undefined as unknown };
  const relay = vi.fn(async (_credentials: CloudCredentials, _path: string): Promise<unknown> => active);
  const remote = vi.fn(async () => {
    if (!credentials) throw Error("Sign in to your server first.");
    // Use the same account/server check as main's remoteForWorkspace.
    if (!workspaceRemoteMatchesCredentials({ serverUrl: "https://account.test", ownerUserId: "owner" }, credentials))
      throw Error("Sign in to the account that synced this workspace.");
    return { credentials, credentialGeneration: generation };
  });
  const handler = createShareCopyHandler({
    currentSession: () => ({workspaceId: workspace.workspaceId, isCurrent: () => current}),
    withRendererWorkspaceOperation: async (_sender: {trusted: boolean}, id, _message, work) => {
      expect(id).toBe(workspace.workspaceId);
      const assertCurrent = () => {if (!current) throw Error("workspace changed");};
      assertCurrent(); const result = await work({workspace, assertCurrent}); assertCurrent(); return result;
    },
    remoteForWorkspace: remote, currentCredentialGeneration: () => generation, relayJson: relay,
  });
  const listeners = new Map<string, (event: {trusted: boolean}, payload: unknown) => Promise<unknown>>();
  registerOperations({
    handle: (channel, listener) => listeners.set(channel, listener),
    assertTrustedSender: (event: {trusted: boolean}) => {if (!event.trusted) throw Error("untrusted");},
    withActiveWorkspace: async () => {throw Error("unexpected boundary");},
  }, shareCopyOperations, {getShareCopyDetails: (payload, {event}) => handler(event, payload)});
  const bridge = operationBridge(shareCopyOperations, (channel, payload) => listeners.get(channel)!({trusted: true}, payload));
  return {bridge, relay, remote, workspace, listeners,
    retire: () => {current = false;}, rotate: () => {generation++;},
    signOut: () => {credentials = null;}, otherAccount: () => {credentials = {...credentials!, userId: "other"};}};
}
it("derives the workspace and account in main, formats the code, and allowlists the result through the bridge", async () => {
  const h = harness();
  expect(await h.bridge.getShareCopyDetails(input)).toEqual({status: "active", shareCode: "dohc-share:share:https://relay.test",
    browserInvitationUrl: active.browserInvitationUrl});
  expect(h.relay.mock.lastCall?.[1]).toBe("/sync/workspace/shares/share/grants/grant/copy");
  expect(h.relay.mock.lastCall?.[0].userId).toBe("owner");
});
it.each(["workspaceId", "ownerUserId", "userId", "credentials", "relayUrl"])("refuses renderer scope widening through %s before any read", async key => {
  const h = harness();
  await expect(h.bridge.getShareCopyDetails({...input, [key]: "other"})).rejects.toThrow();
  expect(h.remote).not.toHaveBeenCalled(); expect(h.relay).not.toHaveBeenCalled();
});
it.each(["signOut", "otherAccount"] as const)("refuses %s before contacting the relay", async action => {
  const h = harness(); h[action]();
  await expect(h.bridge.getShareCopyDetails(input)).rejects.toThrow("Sign in");
  expect(h.relay).not.toHaveBeenCalled();
});
it.each(["workspaceId", "shareId", "grantId"])("refuses another %s in the response", async key => {
  const h = harness(); h.relay.mockResolvedValue({...active, [key]: "other"});
  await expect(h.bridge.getShareCopyDetails(input)).rejects.toThrow("share changed");
});
it("passes relay authorization refusals through without constructing a share code", async () => {
  const h = harness(); h.relay.mockRejectedValue(Error("not found"));
  await expect(h.bridge.getShareCopyDetails(input)).rejects.toThrow("not found");
});
it("returns only ended for a revoked grant", async () => {
  const h = harness(); h.relay.mockResolvedValue({workspaceId: "workspace", ...input, status: "ended"});
  expect(await h.bridge.getShareCopyDetails(input)).toEqual({status: "ended"});
});
it.each(["retire", "rotate"] as const)("discards an in-flight reply after %s", async action => {
  const h = harness(); const reply = deferred<unknown>(); const started = deferred<void>();
  h.relay.mockImplementation(async () => {started.resolve(); return reply.promise;});
  const pending = h.bridge.getShareCopyDetails(input); await started.promise;
  h[action](); reply.resolve(active);
  await expect(pending).rejects.toThrow();
});
it("rejects untrusted senders and received workspaces before reading credentials", async () => {
  const h = harness();
  await expect(h.listeners.get("desktop:get-share-copy-details")!({trusted: false}, input)).rejects.toThrow("untrusted");
  h.workspace.shareView = {};
  await expect(h.bridge.getShareCopyDetails(input)).rejects.toThrow("original workspace");
  expect(h.remote).not.toHaveBeenCalled(); expect(h.relay).not.toHaveBeenCalled();
});
it("pins strict action and result contracts, including no copy data on ended replies", () => {
  expect(ShareCopyInput.safeParse({...input, grantId: ""}).success).toBe(false);
  expect(ShareCopyResult.safeParse({status: "ended", shareCode: "stale"}).success).toBe(false);
  expect(ShareCopyResult.safeParse({status: "active", shareCode: "code", token: "secret"}).success).toBe(false);
});
