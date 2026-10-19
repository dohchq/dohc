import { afterEach, expect, it } from "vitest";
import { request } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createReplicaReadPrincipal } from "./replicaReadPrincipal";
import { serveReplicaRelay } from "./replicaRelaySocket";
import { closeTestStorages, tempRoot, testHandler, testStorage } from "./testing";

afterEach(closeTestStorages);
async function fixture() {
  const storage = await testStorage();
  for (const workspaceId of ["w", "other"]) {
    storage.claimWorkspace({workspaceId, ownerUserId: "owner", createdAtMs: 1});
    storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
    storage.createShare({share: {shareId: workspaceId, workspaceId, granterUserId: "owner", selectorJson: '{"paths":[],"versionId":"main"}', createdAtMs: 1},
      grant: {grantId: workspaceId, shareId: workspaceId, principalKind: "user", principalUserId: "reader", principalEmail: null,
        access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null}});
  }
  const principal = createReplicaReadPrincipal(storage);
  return {storage, principal, lease: principal.issue("w", "child"), other: principal.issue("other", "other-child")};
}

it("the public relay refuses replica credentials", async () => {
  const {storage, lease} = await fixture();
  for (const path of ["bootstrap", "log?replicationEpoch=epoch&streamIdentity=stream", "live-journal?after=0"]) {
    const response = await testHandler(storage)(new Request(`https://relay.test/sync/w/${path}`, {
      headers: {authorization: `Bearer ${lease.bearer}`}}));
    expect(response.status).not.toBe(200);
  }
});

it.skipIf(process.platform === "win32")("serves only this lease through relay.sock and removes the listener on close", async () => {
  const {principal, lease, other} = await fixture();
  const root = await tempRoot("replica-socket");
  const listener = await serveReplicaRelay(root, lease, principal.handle);
  const read = (path: string, method = "GET", bearer = lease.bearer) => new Promise<number>((resolve, reject) => {
    const req = request({socketPath: listener.socketPath, path, method, headers: {authorization: `Bearer ${bearer}`}}, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode!)); response.on("error", reject);
    }); req.on("error", reject); req.end();
  });
  try {
    expect(listener.socketPath).toBe(join(root, "relay.sock"));
    expect(await read("/sync/w/bootstrap")).toBe(200);
    expect(await read("/sync/w/live-journal?after=0&limit=500")).toBe(200);
    expect(await read("/sync/w/bootstrap", "POST")).toBe(404);
    expect(await read("/sync/other/bootstrap", "GET", other.bearer)).toBe(404);
    expect(await read("/sync/other/bootstrap")).toBe(404);
    expect(await read(`/sync/w/blobs/${"f".repeat(64)}`)).toBe(404);
    principal.revoke(lease);
    expect(await read("/sync/w/bootstrap")).toBe(404);
  } finally { await listener.close(); }
  expect(existsSync(listener.socketPath)).toBe(false);
});
