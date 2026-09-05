// The seam share-links Phase 5 extends with the create-only collection grant
// policy ("The create-only collection contract" in docs/plans/share-links.md):
// the link-create surface, the public access levels, and the grant wire shape.
import { afterEach, describe, expect, it } from "vitest";
import { createSyncRelayHandler, type SyncRelayHandler } from "./server";
import {
  closeTestStorages,
  json,
  jsonBody,
  request,
  testStorage,
} from "./linkTestHelpers";

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
const LINK_KEY = "test-link-key-with-at-least-thirty-two-bytes";
const COLLECTION_PATH = "trips";

afterEach(closeTestStorages);

async function newHandler(): Promise<SyncRelayHandler> {
  const storage = await testStorage();
  let id = 0;
  return createSyncRelayHandler({
    storage,
    resolveActor(incoming: Request, workspaceId: string) {
      const match = /^Bearer user:([^ ]+)$/u.exec(
        incoming.headers.get("authorization") ?? "",
      );
      if (!match) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
      return { userId: match[1]!, workspaceId };
    },
    nowMs: () => 2_000,
    newShareId: () => "share-collection",
    newGrantId: () => `grant-${id++}`,
    newId: () => `id-${id++}`,
    resolveUserIdByEmail: () => null,
    linkKey: LINK_KEY,
    shareWebOrigin: "https://share.example.test",
  });
}

// A named share over the collection folder: the topology the create-only
// grant policy attaches to.
async function seedCollectionShare(h: SyncRelayHandler): Promise<void> {
  expect(
    (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE }))))
      .status,
  ).toBe(200);
  expect(
    (
      await h(
        request(
          OWNER,
          `/sync/${WORKSPACE}/shares`,
          jsonBody({
            recipientUserId: RECIPIENT,
            paths: [COLLECTION_PATH],
            access: "view",
          }),
        ),
      )
    ).status,
  ).toBe(200);
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
