import {afterEach, expect, it} from "vitest";
import {createAccountDeletionRoute} from "./accountDeletionRoute";
import type {StorageContext} from "./storage/context";
import {claimWorkspace, closeTestStorages, json, jsonBody, request, testHandler, testStorage} from "./testing";

afterEach(closeTestStorages);
const OWNER = "owner", DELETED = "deleted", WORKSPACE = "workspace";

async function fencedFixture() {
  const storage = await testStorage() as StorageContext;
  const deletion = createAccountDeletionRoute({storage, key: "bearer-test", fenceKey: "fence-test", invalidate() {}, deleteRuntime: async () => {}});
  const h = testHandler(storage);
  await claimWorkspace(h, OWNER, WORKSPACE);
  deletion.fence(DELETED, `${DELETED}@dohc.test`);
  const share = (body: Record<string, unknown>) =>
    h(request(OWNER, `/sync/${WORKSPACE}/shares`, jsonBody({paths: ["docs"], access: "view", ...body})));
  return {storage, share};
}

it("refuses a share to a deleted account by user id and writes no grant", async () => {
  const {storage, share} = await fencedFixture();
  const refused = await share({recipientUserId: DELETED});
  expect(refused.status).toBe(404);
  expect(storage.getShare("share-0")).toBeNull();
  expect(storage.getShareGrant("grant-0")).toBeNull();
  expect((await share({recipientUserId: "survivor"})).status).toBe(200);
});

it("refuses a deleted account inside the transaction that writes the grant", async () => {
  const {storage} = await fencedFixture();
  const created = storage.createShare({
    share: {shareId: "direct", workspaceId: WORKSPACE, granterUserId: OWNER, selectorJson: JSON.stringify({paths: ["docs"], versionId: null}), createdAtMs: 1},
    grant: {grantId: "direct-grant", shareId: "direct", principalKind: "user", principalUserId: DELETED, principalEmail: null,
      access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null},
  });
  expect(created).toBe(false);
  expect(storage.getShare("direct")).toBeNull();
  expect(storage.getShareGrant("direct-grant")).toBeNull();
});

it("invites a deleted account's email as an address with no account, with the same reply", async () => {
  const {storage, share} = await fencedFixture();
  const toDeleted = await share({recipientEmail: `${DELETED}@dohc.test`});
  const toNobody = await share({recipientEmail: "nobody@example.test"});
  expect(toDeleted.status).toBe(200);
  expect(toNobody.status).toBe(200);
  const shape = (body: Record<string, unknown>) => Object.keys(body).sort();
  expect(shape(await json(toDeleted))).toEqual(shape(await json(toNobody)));
  expect(storage.getShareGrant("grant-0")).toMatchObject({
    principalKind: "email", principalUserId: null, principalEmail: `${DELETED}@dohc.test`, status: "active",
  });
});

it("keeps that invite from a request the deleted account started before deletion", async () => {
  const {storage, share} = await fencedFixture();
  expect((await share({recipientEmail: `${DELETED}@dohc.test`})).status).toBe(200);
  // The claim a request makes once its email lookup returns.
  expect(storage.claimPendingSharesForEmail(`${DELETED}@dohc.test`, DELETED)).toBe(0);
  expect(storage.getShareGrant("grant-0")).toMatchObject({principalKind: "email", principalUserId: null});
});
