import { afterEach, expect, it } from "vitest";
import { hashLinkBearer } from "./linkSecurity";
import {
  closeTestStorages,
  LINK_KEY,
  request,
  seedDependentGrant,
  seedLinkGrant,
  testHandler,
  testStorage,
} from "./testing";

afterEach(closeTestStorages);

const NAMED = {
  shareId: "s",
  principalKind: "user" as const,
  principalEmail: null,
  generation: 1,
  status: "active" as const,
  createdAtMs: 1,
  revokedAtMs: null,
  parentGrantId: null,
};

async function fixture() {
  const storage = await testStorage({ blobGraceMs: 0 });
  storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
  storage.claimWorkspace({ workspaceId: "other", ownerUserId: "owner", createdAtMs: 1 });
  storage.createShare({
    share: {
      shareId: "s",
      workspaceId: "w",
      granterUserId: "owner",
      selectorJson: JSON.stringify({ paths: ["notes"], versionId: null }),
      createdAtMs: 1,
    },
    grant: { ...NAMED, grantId: "named", principalUserId: "reader", access: "view" },
  });
  seedLinkGrant(storage, {
    shareId: "s",
    grantId: "link",
    secretHash: hashLinkBearer("a".repeat(43), LINK_KEY),
    access: "comment",
  });
  expect(
    seedDependentGrant(storage, {
      shareId: "s",
      parentGrantId: "link",
      grantId: "dependent",
      principalUserId: "holder",
      createdAtMs: 3,
    }).ok,
  ).toBe(true);
  const handle = testHandler(storage, { nowMs: () => 3000 });
  const retune = (userId: string | null, grantId: string, body: unknown, shareId = "s") =>
    handle(
      request(userId, `/sync/shares/${shareId}/grants/${grantId}/retune`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  return { storage, handle, retune };
}

it("changes a person's access in place and raises the generation each time", async () => {
  const { storage, handle, retune } = await fixture();

  const widened = await retune("owner", "named", { workspaceId: "w", access: "edit" });
  expect(widened.status).toBe(200);
  expect(await widened.json()).toMatchObject({
    ok: true,
    grantId: "named",
    access: "edit",
    generation: 2,
    status: "active",
    revokedAtMs: null,
    parentGrantId: null,
  });
  expect(storage.getShareGrant("named")).toMatchObject({
    shareId: "s",
    principalUserId: "reader",
    access: "edit",
    generation: 2,
    status: "active",
  });
  const asReader = await handle(request("reader", "/sync/shares/s/access"));
  expect(await asReader.json()).toMatchObject({ status: "current", access: "edit" });

  const narrowed = await retune("owner", "named", { workspaceId: "w", access: "view" });
  expect(narrowed.status).toBe(200);
  expect(storage.getShareGrant("named")).toMatchObject({ access: "view", generation: 3 });
  expect(await (await handle(request("reader", "/sync/shares/s/access"))).json()).toMatchObject({
    access: "view",
  });
});

it("changes a pending email invitation's access", async () => {
  const { storage, retune } = await fixture();
  storage.createShare({
    share: { ...storage.getShare("s")!, shareId: "invited" },
    grant: {
      ...NAMED,
      shareId: "invited",
      grantId: "pending",
      principalKind: "email",
      principalUserId: null,
      principalEmail: "new@dohc.test",
      access: "view",
    },
  });

  const response = await retune(
    "owner",
    "pending",
    { workspaceId: "w", access: "edit" },
    "invited",
  );

  expect(response.status).toBe(200);
  expect(storage.getShareGrant("pending")).toMatchObject({
    principalKind: "email",
    access: "edit",
    generation: 2,
  });
});

it("keeps a grant that came from a link at or below the link's access", async () => {
  const { storage, retune } = await fixture();
  const before = storage.getShareGrant("dependent")!;
  expect(before.access).toBe("comment");

  expect((await retune("owner", "dependent", { workspaceId: "w", access: "edit" })).status).toBe(
    404,
  );
  expect(storage.getShareGrant("dependent")).toEqual(before);

  expect((await retune("owner", "dependent", { workspaceId: "w", access: "view" })).status).toBe(
    200,
  );
  expect(storage.getShareGrant("dependent")).toMatchObject({
    access: "view",
    generation: before.generation + 1,
    parentGrantId: "link",
  });
});

it("refuses everyone but the owner, and every request that is not a change", async () => {
  const { storage, retune } = await fixture();
  const before = storage.getShareGrant("named")!;
  const refused: Array<[string | null, string, unknown, number]> = [
    ["reader", "named", { workspaceId: "w", access: "edit" }, 404],
    ["stranger", "named", { workspaceId: "w", access: "edit" }, 404],
    [null, "named", { workspaceId: "w", access: "edit" }, 401],
    ["owner", "named", { workspaceId: "other", access: "edit" }, 404],
    ["owner", "named", { workspaceId: "w", access: "view" }, 404],
    ["owner", "named", { workspaceId: "w", access: "owner" }, 400],
    ["owner", "named", { workspaceId: "w", access: "edit", generation: 9 }, 400],
    ["owner", "link", { workspaceId: "w", access: "edit" }, 404],
    ["owner", "missing", { workspaceId: "w", access: "edit" }, 404],
  ];
  for (const [userId, grantId, body, status] of refused) {
    expect(
      (await retune(userId, grantId, body)).status,
      `${userId} ${grantId} ${JSON.stringify(body)}`,
    ).toBe(status);
  }
  expect(storage.getShareGrant("named")).toEqual(before);
  expect(storage.getShareGrant("link")).toMatchObject({ access: "comment", generation: 1 });
});

it("refuses a revoked grant and a share that is not of files", async () => {
  const { storage, retune } = await fixture();
  storage.createShare({
    share: {
      ...storage.getShare("s")!,
      shareId: "members",
      selectorJson: JSON.stringify({ kind: "workspace" }),
    },
    grant: {
      ...NAMED,
      shareId: "members",
      grantId: "member",
      principalUserId: "reader",
      access: "view",
    },
  });
  expect(
    (await retune("owner", "member", { workspaceId: "w", access: "edit" }, "members")).status,
  ).toBe(404);
  expect(storage.getShareGrant("member")).toMatchObject({ access: "view", generation: 1 });

  expect(
    storage.removeShareAccess({ shareId: "s", grantId: "named", actorUserId: "owner", nowMs: 3000 })
      .ok,
  ).toBe(true);
  expect((await retune("owner", "named", { workspaceId: "w", access: "edit" })).status).toBe(404);
  expect(storage.getShareGrant("named")).toMatchObject({ status: "revoked", access: "view" });
});

it("answers only POST", async () => {
  const { handle } = await fixture();
  expect((await handle(request("owner", "/sync/shares/s/grants/named/retune"))).status).toBe(405);
});
