// The seam share-links Phase 5 extends with the create-only collection grant
// policy ("The create-only collection contract" in docs/plans/share-links.md):
// the link-create surface, the public access levels, and the grant wire shape.
import { afterEach, describe, expect, it } from "vitest";
import type { SyncRelayHandler } from "./server";
import {
  claimWorkspace,
  closeTestStorages,
  createShare,
  json,
  jsonBody,
  request,
  testHandler,
  testStorage,
} from "./testing";

// Lane D conformance: the create-only collection grant policy handed to the
// share-links program ("The create-only collection contract" in
// docs/plans/share-links.md). The policy is share-links Phase 5 work and does
// not exist on the relay yet. The green tests pin the seam Phase 5 extends:
// the link-create surface, the public access levels, and the grant wire
// shape. The todo rows name the assertions the policy must pass; implement
// them with the policy, in this file.

const OWNER = "owner";
const RECIPIENT = "recipient";
const WORKSPACE = "workspace-collection-grant";
const COLLECTION_PATH = "trips";

afterEach(closeTestStorages);

async function newHandler(): Promise<SyncRelayHandler> {
  return testHandler(await testStorage(), { newShareId: () => "share-collection" });
}

// A named share over the collection folder: the topology the create-only
// grant policy attaches to.
async function seedCollectionShare(h: SyncRelayHandler): Promise<void> {
  await claimWorkspace(h, OWNER, WORKSPACE);
  await createShare(h, OWNER, WORKSPACE, { recipientUserId: RECIPIENT, paths: [COLLECTION_PATH] });
}

describe("the seam the create-only grant policy extends", () => {
  it("accepts only an access level on link create: a policy field refuses", async () => {
    const h = await newHandler();
    await seedCollectionShare(h);
    for (const extra of [
      { policy: "create-only" },
      { collectionPath: COLLECTION_PATH },
      { idempotency: true },
    ]) {
      const response = await h(
        request(
          OWNER,
          `/sync/${WORKSPACE}/shares/share-collection/links`,
          jsonBody({ access: "view", ...extra }),
        ),
      );
      expect(response.status).toBe(400);
      expect((await json(response)).error).toBe("A link accepts only access.");
    }
  });

  it('refuses "create-only" as an access value: the policy is not an access level', async () => {
    const h = await newHandler();
    await seedCollectionShare(h);
    const response = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/share-collection/links`,
        jsonBody({ access: "create-only" }),
      ),
    );
    expect(response.status).toBe(400);
    expect((await json(response)).code).toBe("invalid_access");
  });

  it("keeps the link grant wire shape policy-free", async () => {
    const h = await newHandler();
    await seedCollectionShare(h);
    const response = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/share-collection/links`,
        jsonBody({ access: "view" }),
      ),
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(Object.keys(body).sort()).toEqual([
      "access",
      "createdAtMs",
      "generation",
      "grantId",
      "ok",
      "parentGrantId",
      "principalKind",
      "revokedAtMs",
      "shareId",
      "status",
      "url",
    ]);
  });
});
