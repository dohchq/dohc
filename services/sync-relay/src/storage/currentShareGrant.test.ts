import { afterEach, describe, expect, it } from "vitest";
import { closeTestStorages, seedDependentGrant, seedLinkGrant, testStorage } from "../testing";
import type { StorageContext } from "./context";
import {
  currentShareGrantSql,
  readCurrentShareGrant,
  type CurrentShareGrantQuery,
  type CurrentShareGrantStorage,
} from "./currentShareGrant";
import { insertShareGrant } from "./shares";
import type { SyncRelayShareGrantRow, SyncRelayShareRow } from "./types";

afterEach(closeTestStorages);

const selectorJson = JSON.stringify({ paths: ["docs"], versionId: null });
const named: SyncRelayShareGrantRow = {
  grantId: "named", shareId: "s", principalKind: "user", principalUserId: "reader", principalEmail: null,
  access: "edit", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null,
};
const grantIds = ["named", "invite", "link", "dependent"];

// One share holding a named grant, a pending invite, an Edit link, and a
// dependent named grant under that link, all current.
async function fixture() {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
  for (const shareId of ["s", "other"]) {
    storage.createShare({
      share: { shareId, workspaceId: "w", granterUserId: "owner", selectorJson, createdAtMs: 1 },
      grant: { ...named, grantId: `${shareId}-named`, shareId },
    });
  }
  const context = storage as StorageContext;
  insertShareGrant(context, named);
  insertShareGrant(context, {
    ...named, grantId: "invite", principalKind: "email", principalUserId: null, principalEmail: "invitee@example.test",
  });
  seedLinkGrant(storage, { grantId: "link", shareId: "s", secretHash: "link-hash", access: "edit" });
  expect(seedDependentGrant(storage, {
    shareId: "s", parentGrantId: "link", grantId: "dependent", principalUserId: "holder", createdAtMs: 3,
  }).ok).toBe(true);
  const raw = context.db;
  const expectSqlAgrees = () => {
    const current = raw.prepare(`SELECT 1 FROM sync_relay_share_grants AS g
      JOIN sync_relay_shares AS s ON s.share_id = g.share_id
      WHERE g.grant_id = ? AND ${currentShareGrantSql("g", "s")}`);
    for (const grantId of grantIds) {
      expect(current.get(grantId) !== undefined, grantId)
        .toBe(readCurrentShareGrant(storage, { grantId }) !== null);
    }
  };
  return { storage, raw, expectSqlAgrees };
}

describe("readCurrentShareGrant", () => {
  it("returns the share and grant while every clause holds, in both forms", async () => {
    const { storage, expectSqlAgrees } = await fixture();
    const share = storage.getShare("s");
    for (const query of [
      { grantId: "named", principal: { kind: "user", userId: "reader" }, generation: 1 },
      { grantId: "link", principal: { kind: "link" }, generation: 1 },
      { grantId: "dependent", principal: { kind: "user", userId: "holder" } },
      { grantId: "invite" },
    ] satisfies CurrentShareGrantQuery[]) {
      expect(readCurrentShareGrant(storage, query), query.grantId)
        .toEqual({ share, grant: storage.getShareGrant(query.grantId) });
    }
    expectSqlAgrees();
  });

  it.each<[string, CurrentShareGrantQuery, ((f: Awaited<ReturnType<typeof fixture>>) => void)?]>([
    ["a missing grant", { grantId: "missing" }],
    ["a revoked grant", { grantId: "named" }, ({ storage }) => {
      expect(storage.revokeShareGrant({ shareId: "s", grantId: "named", revokedAtMs: 5 }).ok).toBe(true);
    }],
    ["another user", { grantId: "named", principal: { kind: "user", userId: "stranger" } }],
    ["a user grant asked for as a link", { grantId: "named", principal: { kind: "link" } }],
    ["a link grant asked for as a user", { grantId: "link", principal: { kind: "user", userId: "reader" } }],
    ["a pending invite asked for as a user", { grantId: "invite", principal: { kind: "user", userId: "reader" } }],
    ["a stale generation", { grantId: "link", generation: 1 }, ({ raw }) => {
      raw.prepare("UPDATE sync_relay_share_grants SET generation = 2 WHERE grant_id = 'link'").run();
    }],
    ["a transferred workspace", { grantId: "named" }, ({ raw }) => {
      raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'new-owner'").run();
    }],
    ["a dependent whose parent alone was revoked", { grantId: "dependent" }, ({ raw }) => {
      raw.prepare(`UPDATE sync_relay_share_grants SET status = 'revoked', revoked_at_ms = 5, generation = 2
        WHERE grant_id = 'link'`).run();
    }],
    ["a dependent above its parent's access", { grantId: "dependent" }, ({ raw }) => {
      raw.prepare("UPDATE sync_relay_share_grants SET access = 'comment' WHERE grant_id = 'link'").run();
    }],
    ["a dependent whose parent is on another share", { grantId: "dependent" }, ({ raw }) => {
      raw.prepare("UPDATE sync_relay_share_grants SET share_id = 'other' WHERE grant_id = 'link'").run();
    }],
    ["a dependent whose parent is not a link", { grantId: "dependent" }, ({ raw }) => {
      raw.prepare("UPDATE sync_relay_share_grants SET parent_grant_id = 'named' WHERE grant_id = 'dependent'").run();
    }],
  ])("refuses %s, in both forms", async (_name, query, change) => {
    const f = await fixture();
    change?.(f);
    expect(readCurrentShareGrant(f.storage, query)).toBeNull();
    f.expectSqlAgrees();
  });

  it("rechecks the row invariants the schema also enforces", () => {
    const share: SyncRelayShareRow = { shareId: "s", workspaceId: "w", granterUserId: "owner", selectorJson, createdAtMs: 1 };
    const link: SyncRelayShareGrantRow = { ...named, grantId: "link", principalKind: "link", principalUserId: null };
    const reader = (grant: SyncRelayShareGrantRow, stored: SyncRelayShareRow | null = share): CurrentShareGrantStorage => ({
      getShareGrant: (grantId) => [grant, link].find((row) => row.grantId === grantId) ?? null,
      getShare: () => stored,
      workspaceIsOwnedBy: () => true,
    });
    const dependent = { ...named, parentGrantId: "link" };
    expect(readCurrentShareGrant(reader(dependent), { grantId: "named" })).toEqual({ share, grant: dependent });
    expect(readCurrentShareGrant(reader(named, null), { grantId: "named" })).toBeNull();
    for (const changed of [
      { status: "revoked" }, { revokedAtMs: 2 }, { generation: 0 }, { generation: 1.5 },
      { generation: Number.MAX_SAFE_INTEGER + 1 }, { principalUserId: null },
      { principalEmail: "reader@example.test" }, { principalKind: "link" },
      { principalKind: "email", principalUserId: null },
      { principalKind: "link", principalUserId: null, parentGrantId: "link" },
    ] satisfies Partial<SyncRelayShareGrantRow>[]) {
      expect(readCurrentShareGrant(reader({ ...named, ...changed }), { grantId: "named" }), JSON.stringify(changed))
        .toBeNull();
    }
  });
});

describe("link transitions derived from a grant", () => {
  it("refuse sessions and handoff codes once the granter lost the workspace", async () => {
    const { storage, raw } = await fixture();
    const session = (sessionId: string) => ({
      sessionId, capabilityHash: `${sessionId}-hash`, grantId: "link", generation: 1, mintedAtMs: 10, expiresAtMs: 100,
    });
    const code = (codeId: string) => ({
      codeId, codeHash: `${codeId}-hash`, grantId: "link", generation: 1, mintedAtMs: 10, expiresAtMs: 100,
    });
    const redeem = () => storage.redeemLinkHandoffCode({
      codeHash: "held-hash", principalUserId: "visitor", redeemedAtMs: 20, mintGrantId: () => "redeemed", guard: () => true,
    });
    expect(storage.mintLinkSession({ session: session("before") })).toBe(true);
    expect(storage.mintLinkHandoffCode({ code: code("held"), guard: () => true })).toBe(true);

    raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'new-owner'").run();
    expect(storage.mintLinkSession({ session: session("after") })).toBe(false);
    expect(storage.mintLinkHandoffCode({ code: code("late"), guard: () => true })).toBe(false);
    expect(redeem()).toEqual({ ok: false });
    expect(storage.hasLinkHandoffCode("held-hash")).toBe(false);

    raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'owner'").run();
    expect(storage.mintLinkHandoffCode({ code: code("held"), guard: () => true })).toBe(true);
    expect(redeem()).toMatchObject({ ok: true, grant: { grantId: "redeemed", parentGrantId: "link" } });
  });

  it("return an existing named grant from a handoff code only while it is current", async () => {
    const { storage, raw } = await fixture();
    const code = { codeId: "held", codeHash: "held-hash", grantId: "link", generation: 1, mintedAtMs: 10, expiresAtMs: 100 };
    const redeem = () => storage.redeemLinkHandoffCode({
      codeHash: "held-hash", principalUserId: "holder", redeemedAtMs: 20, mintGrantId: () => "unused", guard: () => true,
    });
    const setLinkAccess = (access: string) =>
      raw.prepare("UPDATE sync_relay_share_grants SET access = ? WHERE grant_id = 'link'").run(access);

    // The holder's Edit dependent outranks its View link at first redemption.
    setLinkAccess("view");
    expect(storage.mintLinkHandoffCode({ code, guard: () => true })).toBe(true);
    expect(redeem()).toEqual({ ok: false });
    expect(storage.hasLinkHandoffCode("held-hash")).toBe(false);

    // The same drift after a successful first redemption refuses the replay.
    setLinkAccess("edit");
    expect(storage.mintLinkHandoffCode({ code, guard: () => true })).toBe(true);
    expect(redeem()).toMatchObject({ ok: true, grant: { grantId: "dependent" } });
    expect(redeem()).toMatchObject({ ok: true, grant: { grantId: "dependent" } });
    setLinkAccess("view");
    expect(redeem()).toEqual({ ok: false });
    expect(storage.hasLinkHandoffCode("held-hash")).toBe(false);
    expect(storage.getShareGrant("unused")).toBeNull();
  });
});
