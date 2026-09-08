import { expect, it, vi } from "vitest";
import { audience, binding, fixture, host, key, marker, report, scope, table, DatabaseSync } from "./liveTickets.test-helper.js";
import { hashLiveTicketToken } from "./liveTicketSecurity.js";
import { openSyncRelayStorage } from "./storage.js";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";

function reopenForSchemaCheck(path: string): void {
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined;
  try { reopened = openSyncRelayStorage(path); }
  finally { reopened?.close(); }
}

const tokenHash = hashLiveTicketToken("01".repeat(32), key);
const mint = { objectId: binding.objectId, scope, report, audience, ticketId: "ticket-1", tokenHash };
const redeem = { tokenHash, scope, report, audience };
it("creates and validates the complete private named-ticket schema", async () => {
  const state = await fixture();
  try {
    expect(state.raw.prepare("SELECT migration_id FROM sync_relay_migrations WHERE migration_id=?").get(marker)).toEqual({ migration_id: marker });
    expect(state.raw.prepare(`PRAGMA table_info(${table})`).all()).toHaveLength(18);
  } finally { await state.close(); }
});
it("commits a ticket and consumes the hashed credential once in real storage", async () => {
  const state = await fixture();
  try {
    expect(state.storage.mintNamedLiveTicket(mint)).toEqual({ expiresAtMs: 31000 });
    expect(state.storage.readNamedLiveTicketTarget({ tokenHash, scope, audience })).toEqual({ workspaceId: scope.workspaceId, objectId: binding.objectId });
    expect(state.storage.redeemNamedLiveTicket(redeem)).toMatchObject({ ticketId: mint.ticketId, redeemedAtMs: 1000 });
    expect(state.storage.redeemNamedLiveTicket(redeem)).toBeNull();
  } finally { await state.close(); }
});

const another = (id: number) => ({ ...mint, ticketId: `ticket-${id}`, tokenHash: hashLiveTicketToken(id.toString(16).padStart(64, "0"), key) });
const rows = (state: Awaited<ReturnType<typeof fixture>>) => state.raw.prepare(`SELECT ticket_id, redeemed_at_ms FROM ${table} ORDER BY ticket_id`).all();

it.each([
  ["wrong audience", { audience: "https://other.example.test" }],
  ["wrong user", { scope: { ...scope, userId: "other" } }],
  ["wrong grant", { scope: { ...scope, grantId: "other" } }],
  ["wrong share", { scope: { ...scope, shareId: "other" } }],
  ["wrong workspace", { scope: { ...scope, workspaceId: "other" } }],
])("refuses %s without consuming or disclosing the rightful ticket", async (_name, changed) => {
  const state = await fixture();
  try {
    expect(state.storage.mintNamedLiveTicket(mint)).not.toBeNull();
    expect(state.storage.readNamedLiveTicketTarget({ tokenHash, scope, audience, ...changed })).toBeNull();
    expect(state.storage.redeemNamedLiveTicket({ ...redeem, ...changed })).toBeNull();
    expect(state.storage.redeemNamedLiveTicket(redeem)).not.toBeNull();
  } finally { await state.close(); }
});

it.each([999, 1000, 30999, 31000, 31001])("uses the exact issue/expiry interval at %i", async time => {
  const state = await fixture();
  try {
    state.storage.mintNamedLiveTicket(mint);
    state.setTime(time);
    const accepted = time >= 1000 && time < 31000;
    expect(state.storage.redeemNamedLiveTicket(redeem) !== null).toBe(accepted);
    if (!accepted) {
      expect(rows(state)).toEqual([{ ticket_id: "ticket-1", redeemed_at_ms: null }]);
    }
  } finally { await state.close(); }
});

it("rejects overflow and invalid clocks without creating rows", async () => {
  const state = await fixture();
  try {
    state.setTime(Number.MAX_SAFE_INTEGER - 29999);
    expect(state.storage.mintNamedLiveTicket(mint)).toBeNull();
    for (const time of [-1, NaN, Infinity, 1.5]) {
      state.setTime(time);
      expect(() => state.storage.mintNamedLiveTicket(mint)).toThrow("Invalid live-ticket clock");
    }
    expect(rows(state)).toEqual([]);
  } finally { await state.close(); }
});

it("requires explicit captured positive policies with no default", async () => {
  const state = await fixture({});
  try {
    expect(() => state.storage.mintNamedLiveTicket(mint)).toThrow("not configured");
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      for (const field of ["retainedTicketsPerPrincipalGrant", "expiredTicketCleanupBatchSize"] as const) {
        expect(() => openSyncRelayStorage(state.path, { liveTickets: {
          retainedTicketsPerPrincipalGrant: 2, expiredTicketCleanupBatchSize: 1, now: () => 1000, [field]: value,
        } })).toThrow("positive safe integers");
      }
    }
    const policy = { retainedTicketsPerPrincipalGrant: 1, expiredTicketCleanupBatchSize: 1, now: () => 1000 };
    const configured = openSyncRelayStorage(state.path, { liveTickets: policy });
    try {
      policy.retainedTicketsPerPrincipalGrant = 99;
      policy.now = () => 999999;
      expect(configured.mintNamedLiveTicket(mint)).toEqual({ expiresAtMs: 31000 });
      expect(configured.mintNamedLiveTicket(another(2))).toBeNull();
    } finally { configured.close(); }
  } finally { await state.close(); }
});

it("captures time once with the writer lock held for every ticket operation", async () => {
  const state = await fixture();
  state.raw.exec("PRAGMA busy_timeout=0");
  const now = vi.fn(() => {
    expect(() => state.raw.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
    return 31000;
  });
  const second = openSyncRelayStorage(state.path, { liveTickets: { retainedTicketsPerPrincipalGrant: 2, expiredTicketCleanupBatchSize: 1, now } });
  try {
    state.storage.mintNamedLiveTicket(mint);
    expect(second.redeemNamedLiveTicket(redeem)).toBeNull();
    expect(now).toHaveBeenCalledTimes(1);
    expect(second.readNamedLiveTicketTarget({ tokenHash, scope, audience })).toBeNull();
    expect(now).toHaveBeenCalledTimes(2);
    expect(second.mintNamedLiveTicket(another(2))).toEqual({ expiresAtMs: 61000 });
    expect(now).toHaveBeenCalledTimes(3);
  } finally { second.close(); await state.close(); }
});

it("excludes a second writer during decisive grant and host authority checks", async () => {
  const state = await fixture();
  state.raw.exec("PRAGMA busy_timeout=0");
  const original = state.storage.getShareGrant.bind(state.storage);
  const guard = vi.spyOn(state.storage, "getShareGrant").mockImplementation(id => {
    expect(() => state.raw.exec("UPDATE sync_relay_share_grants SET generation=generation+1")).toThrow(/locked/);
    expect(() => state.raw.exec("UPDATE sync_relay_session_host_control SET registered_connection_id='racing-connection'")).toThrow(/locked/);
    return original(id);
  });
  try {
    expect(state.storage.mintNamedLiveTicket(mint)).not.toBeNull();
    expect(state.storage.redeemNamedLiveTicket(redeem)).not.toBeNull();
    expect(guard).toHaveBeenCalled();
  } finally { guard.mockRestore(); await state.close(); }
});

it("retains redeemed capacity until expiry and never evicts unexpired tickets", async () => {
  const state = await fixture();
  try {
    state.storage.mintNamedLiveTicket(mint);
    state.storage.redeemNamedLiveTicket(redeem);
    state.storage.mintNamedLiveTicket(another(2));
    expect(state.storage.mintNamedLiveTicket(another(3))).toBeNull();
    expect(rows(state)).toHaveLength(2);
    state.setTime(31000);
    expect(state.storage.mintNamedLiveTicket(another(3))).toEqual({ expiresAtMs: 61000 });
    expect(rows(state).map(row => row.ticket_id)).toEqual(["ticket-2", "ticket-3"]);
  } finally { await state.close(); }
});

it("rolls bounded expiry cleanup back when retained capacity refuses", async () => {
  const state = await fixture();
  try {
    state.storage.mintNamedLiveTicket(mint);
    state.storage.mintNamedLiveTicket(another(2));
    state.raw.prepare(`UPDATE ${table} SET minted_at_ms=10000, expires_at_ms=40000`).run();
    const stale = another(9);
    state.raw.prepare(`INSERT INTO ${table} SELECT ?, ?, audience, workspace_id, main_version_id, object_id, lineage_claim_id,
      current_path, selector_paths_json, restore_fence_generation, principal_kind, principal_id, grant_id, grant_generation,
      host_epoch, 0, 30000, NULL FROM ${table} LIMIT 1`).run(stale.ticketId, stale.tokenHash);
    state.setTime(31000);
    const before = rows(state);
    expect(state.storage.mintNamedLiveTicket(another(3))).toBeNull();
    expect(rows(state)).toEqual(before);
  } finally { await state.close(); }
});

it.each(["ticketId", "tokenHash"] as const)("refuses %s collisions before expiry cleanup", async field => {
  const state = await fixture();
  try {
    state.storage.mintNamedLiveTicket(mint);
    state.setTime(31000);
    expect(state.storage.mintNamedLiveTicket({ ...another(2), [field]: mint[field] })).toBeNull();
    expect(rows(state)).toEqual([{ ticket_id: "ticket-1", redeemed_at_ms: null }]);
  } finally { await state.close(); }
});

it("does not reset retained capacity when generation or audience changes", async () => {
  const state = await fixture();
  try {
    state.storage.mintNamedLiveTicket(mint);
    state.raw.exec("UPDATE sync_relay_share_grants SET generation=5");
    expect(state.storage.mintNamedLiveTicket({ ...another(2), audience: "https://other.example.test" })).not.toBeNull();
    expect(state.storage.mintNamedLiveTicket(another(3))).toBeNull();
  } finally { await state.close(); }
});

it("keeps capacity independent across grants and named principals", async () => {
  const state = await fixture();
  try {
    state.storage.mintNamedLiveTicket(mint);
    state.storage.mintNamedLiveTicket(another(2));
    for (const [grantId, userId, id] of [["edit-2", scope.userId, 3], ["edit-3", "reader-2", 4]] as const) {
      state.raw.prepare(`INSERT INTO sync_relay_share_grants SELECT ?, share_id, principal_kind, ?, principal_email, access,
        generation, status, created_at_ms, revoked_at_ms, parent_grant_id FROM sync_relay_share_grants WHERE grant_id=?`)
        .run(grantId, userId, scope.grantId);
      expect(state.storage.mintNamedLiveTicket({ ...another(id), scope: { ...scope, grantId, userId } })).not.toBeNull();
    }
  } finally { await state.close(); }
});

it.each([
  ["grant generation", "UPDATE sync_relay_share_grants SET generation=5"],
  ["grant revocation", "UPDATE sync_relay_share_grants SET status='revoked', revoked_at_ms=2"],
  ["grant access", "UPDATE sync_relay_share_grants SET access='view'"],
  ["named principal", "UPDATE sync_relay_share_grants SET principal_user_id='other'"],
  ["workspace owner", "UPDATE sync_relay_workspaces SET owner_user_id='other'"],
  ["selector narrowing", `UPDATE sync_relay_shares SET selector_json='{"paths":["docs/b.md"],"versionId":null}'`],
  ["selector widening", `UPDATE sync_relay_shares SET selector_json='{"paths":["docs","more"],"versionId":null}'`],
  ["pinned version", `UPDATE sync_relay_shares SET selector_json='{"paths":["docs"],"versionId":"v1"}'`],
  ["fence generation", "UPDATE sync_relay_live_documents SET restore_fence_generation=8"],
  ["zero fence", "UPDATE sync_relay_live_documents SET restore_fence_generation=0"],
  ["closed document", "UPDATE sync_relay_live_documents SET admission_state='closed'"],
  ["deleted object", "INSERT INTO sync_relay_object_moments SELECT workspace_id, object_id, 2, 'moment-2', version_id, NULL, NULL, NULL, NULL, 2 FROM sync_relay_object_moments"],
  ["moved object", "INSERT INTO sync_relay_object_moments SELECT workspace_id, object_id, 2, 'moment-2', version_id, 'docs/b.md', blob_sha256, content_kind, byte_length, 2 FROM sync_relay_object_moments"],
  ["non-text object", "INSERT INTO sync_relay_object_moments SELECT workspace_id, object_id, 2, 'moment-2', version_id, path, blob_sha256, 'binary', byte_length, 2 FROM sync_relay_object_moments"],
])("rechecks %s when redeeming and leaves the row unconsumed", async (_name, sql) => {
  const state = await fixture();
  try {
    state.storage.mintNamedLiveTicket(mint);
    state.raw.exec(sql);
    const next = another(2);
    if (_name === "grant generation") {
      expect(state.storage.mintNamedLiveTicket(next)).toEqual({ expiresAtMs: 31000 });
    } else {
      expect(state.storage.mintNamedLiveTicket(next)).toBeNull();
    }
    expect(state.storage.redeemNamedLiveTicket(redeem)).toBeNull();
    if (_name === "grant generation") {
      expect(state.storage.redeemNamedLiveTicket({ ...redeem, tokenHash: next.tokenHash })).toMatchObject({
        authority: { principalKind: "named", grantGeneration: 5 },
      });
      expect(rows(state)).toEqual([{ ticket_id: "ticket-1", redeemed_at_ms: null }, { ticket_id: "ticket-2", redeemed_at_ms: 1000 }]);
    } else {
      expect(rows(state)).toEqual([{ ticket_id: "ticket-1", redeemed_at_ms: null }]);
    }
  } finally { await state.close(); }
});

it("requires a nonzero fence only at the ticket boundary", async () => {
  const state = await fixture();
  try {
    state.raw.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=0");
    const zero = { ...binding, restoreFenceGeneration: 0 };
    expect(state.storage.resolveCurrentLiveDocumentBinding({ document: { workspaceId: scope.workspaceId, mainVersionId: "main",
      objectId: binding.objectId, lineageClaimId: binding.lineageClaimId }, actor: { kind: "named", userId: scope.userId, grantId: scope.grantId } }).kind).toBe("current");
    expect(state.storage.mintNamedLiveTicket({ ...mint, report: { ...report, binding: zero } })).toBeNull();
  } finally { await state.close(); }
});

it("accepts a valid newer main settlement without requiring the registration moment", async () => {
  const state = await fixture();
  try {
    state.storage.mintNamedLiveTicket(mint);
    state.raw.prepare(`INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, blob_sha256, content_kind, byte_length, recorded_at_ms) SELECT workspace_id, object_id, 2, 'moment-2', version_id, path,
      ?, content_kind, 9, 2 FROM sync_relay_object_moments`).run("c".repeat(64));
    expect(state.storage.redeemNamedLiveTicket(redeem)).not.toBeNull();
  } finally { await state.close(); }
});

it("allows same-epoch reconnect only with the fresh authenticated report", async () => {
  const state = await fixture();
  try {
    state.storage.mintNamedLiveTicket(mint);
    state.storage.disconnectLiveHost({ ...host, updatedAtMs: 3, guard: () => undefined });
    expect(state.storage.redeemNamedLiveTicket(redeem)).toBeNull();
    const connection = { ...host, connectionId: "connection-2" };
    state.storage.registerLiveHost({ ...connection, updatedAtMs: 4, guard: () => undefined });
    expect(state.storage.mintNamedLiveTicket(another(2))).toBeNull();
    expect(state.storage.redeemNamedLiveTicket(redeem)).toBeNull();
    expect(state.storage.redeemNamedLiveTicket({ ...redeem, report: { ...report, connection } })).not.toBeNull();
  } finally { await state.close(); }
});

it.each(["mode", "hostId", "hostEpoch", "instanceId", "connectionId"] as const)("compares host report %s on both operations", async field => {
  const state = await fixture();
  try {
    const changed = { ...report, connection: { ...host, [field]: field === "mode" ? "service" : field === "hostEpoch" ? 2 : "other" } };
    expect(state.storage.mintNamedLiveTicket({ ...mint, report: changed })).toBeNull();
    state.storage.mintNamedLiveTicket(mint);
    expect(state.storage.redeemNamedLiveTicket({ ...redeem, report: changed })).toBeNull();
    expect(state.storage.redeemNamedLiveTicket(redeem)).not.toBeNull();
  } finally { await state.close(); }
});

it.each(["workspaceId", "mainVersionId", "objectId", "lineageClaimId", "currentPath", "selectorPaths", "restoreFenceGeneration"] as const)("compares report binding %s", async field => {
  const state = await fixture();
  try {
    const value = field === "lineageClaimId" ? "a".repeat(64) : field === "selectorPaths" ? ["docs", "other"] : field === "restoreFenceGeneration" ? 8 : "other";
    const changed = { ...report, binding: { ...binding, [field]: value } };
    if (field === "mainVersionId") expect(() => state.storage.mintNamedLiveTicket({ ...mint, report: changed })).toThrow();
    else expect(state.storage.mintNamedLiveTicket({ ...mint, report: changed })).toBeNull();
    state.storage.mintNamedLiveTicket(mint);
    if (field === "mainVersionId") expect(() => state.storage.redeemNamedLiveTicket({ ...redeem, report: changed })).toThrow();
    else expect(state.storage.redeemNamedLiveTicket({ ...redeem, report: changed })).toBeNull();
    expect(state.storage.redeemNamedLiveTicket(redeem)).not.toBeNull();
  } finally { await state.close(); }
});

it.each([
  ["noncanonical path", "current_path", "docs//a.md"],
  ["noncanonical selector JSON", "selector_paths_json", '[ "docs" ]'],
  ["duplicate selectors", "selector_paths_json", '["docs","docs"]'],
  ["wrong union", "principal_kind", "link"],
  ["wrong main", "main_version_id", "MAIN"],
  ["zero fence", "restore_fence_generation", 0],
  ["invalid lineage", "lineage_claim_id", "A".repeat(64)],
  ["invalid audience", "audience", `${audience}/`],
  ["invalid lifetime", "expires_at_ms", 31001],
  ["invalid redeemed time", "redeemed_at_ms", 31000],
  ["unsafe generation", "grant_generation", Number.MAX_SAFE_INTEGER + 1],
])("treats stored %s as integrity failure", async (_name, column, value) => {
  const state = await fixture();
  try {
    state.storage.mintNamedLiveTicket(mint);
    state.raw.exec("PRAGMA ignore_check_constraints=ON");
    state.raw.prepare(`UPDATE ${table} SET ${column}=?`).run(value);
    expect(() => state.storage.readNamedLiveTicketTarget({ tokenHash, scope, audience })).toThrow(/stored live ticket is damaged|too large to be represented/);
    expect(() => state.storage.redeemNamedLiveTicket(redeem)).toThrow(/stored live ticket is damaged|too large to be represented/);
  } finally { await state.close(); }
});

it.each([
  `DROP INDEX idx_sync_relay_live_session_tickets_hash`,
  `CREATE INDEX extra_ticket_index ON ${table}(audience)`,
  `CREATE TRIGGER extra_ticket_trigger AFTER INSERT ON ${table} BEGIN SELECT 1; END`,
  `DROP TABLE ${table}`,
])("refuses marked schema damage without repair: %s", async sql => {
  const state = await fixture();
  try {
    state.raw.exec(sql);
    const before = state.raw.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
    expect(() => reopenForSchemaCheck(state.path)).toThrow("live-ticket schema is missing or damaged");
    expect(state.raw.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all()).toEqual(before);
  } finally { await state.close(); }
});

it("rejects an unmarked complete schema and a same-name trigger without adopting either", async () => {
  const state = await fixture();
  try {
    state.raw.prepare("DELETE FROM sync_relay_migrations WHERE migration_id=?").run(marker);
    expect(() => reopenForSchemaCheck(state.path)).toThrow("unmarked live-ticket schema");
    state.raw.exec(`DROP TABLE ${table}; CREATE TRIGGER ${table} AFTER INSERT ON sync_relay_workspaces BEGIN SELECT 1; END`);
    expect(() => reopenForSchemaCheck(state.path)).toThrow("unmarked live-ticket schema");
    expect(state.raw.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(marker)).toBeUndefined();
  } finally { await state.close(); }
});

it("reopens valid tickets and cascades only with workspace deletion", async () => {
  const state = await fixture();
  const second = openSyncRelayStorage(state.path, state.config);
  try {
    state.storage.mintNamedLiveTicket(mint);
    expect(second.readNamedLiveTicketTarget({ tokenHash, scope, audience })).toEqual({ workspaceId: scope.workspaceId, objectId: binding.objectId });
    state.raw.exec("DELETE FROM sync_relay_share_grants; DELETE FROM sync_relay_shares; DELETE FROM sync_relay_live_documents");
    expect(rows(state)).toHaveLength(1);
    state.raw.exec("DELETE FROM sync_relay_workspaces");
    expect(rows(state)).toHaveLength(0);
  } finally { second.close(); await state.close(); }
});

it.each(["mint", "redeem"] as const)("returns no %s result and rolls back on commit failure", async operation => {
  const state = await fixture();
  try {
    if (operation === "redeem") state.storage.mintNamedLiveTicket(mint);
    const original = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
      if (sql === "COMMIT") throw new Error("injected commit failure");
      return original.call(this, sql);
    });
    try {
      expect(() => operation === "mint" ? state.storage.mintNamedLiveTicket(mint) : state.storage.redeemNamedLiveTicket(redeem)).toThrow("injected commit failure");
    } finally { spy.mockRestore(); }
    expect(rows(state)).toEqual(operation === "mint" ? [] : [{ ticket_id: "ticket-1", redeemed_at_ms: null }]);
    expect(state.storage.unavailable.aborted).toBe(true);
    expect(() => operation === "mint" ? state.storage.mintNamedLiveTicket(mint) : state.storage.redeemNamedLiveTicket(redeem)).toThrow("Relay storage is unavailable.");
    const reopened = openSyncRelayStorage(state.path, state.config);
    try {
      expect(operation === "mint" ? reopened.mintNamedLiveTicket(mint) : reopened.redeemNamedLiveTicket(redeem)).not.toBeNull();
    } finally { reopened.close(); }
  } finally { await state.close(); }
});

it("requires a changed row from the conditional consumption update", async () => {
  const state = await fixture();
  try {
    state.storage.mintNamedLiveTicket(mint);
    state.raw.exec(`CREATE TRIGGER refuse_redemption BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(IGNORE); END`);
    expect(state.storage.redeemNamedLiveTicket(redeem)).toBeNull();
    expect(rows(state)).toEqual([{ ticket_id: "ticket-1", redeemed_at_ms: null }]);
  } finally { await state.close(); }
});

it.each(["revoked", "narrowed", "wrong-kind", "missing"] as const)("rechecks dependent parent standing: %s", async change => {
  const state = await fixture();
  try {
    state.raw.prepare(`INSERT INTO sync_relay_share_grants SELECT 'parent-1', share_id, 'link', NULL, NULL, access,
      generation, status, created_at_ms, revoked_at_ms, NULL FROM sync_relay_share_grants WHERE grant_id=?`).run(scope.grantId);
    state.raw.exec("UPDATE sync_relay_share_grants SET parent_grant_id='parent-1' WHERE grant_id='edit-1'");
    expect(state.storage.mintNamedLiveTicket(mint)).not.toBeNull();
    if (change === "revoked") state.raw.exec("UPDATE sync_relay_share_grants SET status='revoked', revoked_at_ms=3 WHERE grant_id='parent-1'");
    if (change === "narrowed") state.raw.exec("UPDATE sync_relay_share_grants SET access='comment' WHERE grant_id='parent-1'");
    if (change === "wrong-kind") state.raw.exec("UPDATE sync_relay_share_grants SET principal_kind='user', principal_user_id='owner-1' WHERE grant_id='parent-1'");
    if (change === "missing") state.raw.exec("PRAGMA foreign_keys=OFF; DELETE FROM sync_relay_share_grants WHERE grant_id='parent-1'");
    expect(state.storage.redeemNamedLiveTicket(redeem)).toBeNull();
    expect(state.storage.mintNamedLiveTicket(another(2))).toBeNull();
    expect(rows(state)).toEqual([{ ticket_id: "ticket-1", redeemed_at_ms: null }]);
  } finally { await state.close(); }
});

it("refuses both operations while the host is draining", async () => {
  const state = await fixture();
  try {
    state.storage.mintNamedLiveTicket(mint);
    expect(state.storage.beginLiveHostTransition({ from: host, toMode: "service", toHostId: "service-1", transitionId: "transition-1",
      startedAtMs: 5, guard: () => undefined }).ok).toBe(true);
    expect(state.storage.mintNamedLiveTicket(another(2))).toBeNull();
    expect(state.storage.redeemNamedLiveTicket(redeem)).toBeNull();
  } finally { await state.close(); }
});

it("refuses activation, freezes the ticket epoch, and preserves capacity across host changes", async () => {
  const state = await fixture({ liveTickets: { retainedTicketsPerPrincipalGrant: 3, expiredTicketCleanupBatchSize: 1, now: () => 1000 } });
  try {
    state.storage.mintNamedLiveTicket(mint);
    state.storage.mintNamedLiveTicket(another(2));
    const transition = state.storage.beginLiveHostTransition({ from: host, toMode: "service", toHostId: "service-1",
      transitionId: "transition-1", startedAtMs: 5, guard: () => undefined });
    if (!transition.ok || !transition.snapshot.transition) throw new Error("fixture transition failed");
    const coordinate = { ...host, mode: "service" as const, hostId: "service-1", hostEpoch: parseHostEpoch(2), instanceId: "service-instance", connectionId: "service-connection" };
    const transitionGeneration = transition.snapshot.transition.transitionGeneration;
    expect(state.storage.commitLiveHostTransitionEpoch({ transitionId: "transition-1", transitionGeneration, updatedAtMs: 6 }).ok).toBe(true);
    expect(state.storage.mintNamedLiveTicket({ ...another(3), report: { ...report, connection: coordinate } })).toBeNull();
    expect(state.storage.redeemNamedLiveTicket({ ...redeem, report: { ...report, connection: coordinate } })).toBeNull();
    expect(state.storage.activateLiveHostTransition({ ...coordinate, transitionId: "transition-1", transitionGeneration,
      transitionFromEpoch: host.hostEpoch, updatedAtMs: 7, guard: () => undefined }).ok).toBe(true);
    expect(state.storage.redeemNamedLiveTicket({ ...redeem, report: { ...report, connection: coordinate } })).toBeNull();
    expect(state.storage.mintNamedLiveTicket({ ...another(3), report: { ...report, connection: coordinate } })).not.toBeNull();
    expect(state.storage.mintNamedLiveTicket({ ...another(4), report: { ...report, connection: coordinate } })).toBeNull();
    expect(state.raw.prepare(`SELECT ticket_id FROM ${table} ORDER BY ticket_id`).all()).toEqual([
      { ticket_id: "ticket-1" }, { ticket_id: "ticket-2" }, { ticket_id: "ticket-3" },
    ]);
  } finally { await state.close(); }
});

it("shares retained capacity across objects", async () => {
  const state = await fixture();
  try {
    state.storage.mintNamedLiveTicket(mint);
    state.storage.mintNamedLiveTicket(another(2));
    state.raw.exec(`INSERT INTO sync_relay_object_moments SELECT workspace_id, 'object-2', relay_seq, 'moment-2', version_id,
      'docs/b.md', blob_sha256, content_kind, byte_length, recorded_at_ms FROM sync_relay_object_moments;
      INSERT INTO sync_relay_live_documents SELECT workspace_id, main_version_id, 'object-2', lineage_claim_id, replaces_lineage_claim_id,
      'docs/b.md', baseline_moment_relay_seq, baseline_projected_sha256, baseline_projected_byte_length, baseline_digest, baseline_bytes,
      lineage_state, admission_state, restore_fence_generation, registered_at_ms, retired_at_ms FROM sync_relay_live_documents`);
    const otherBinding = { ...binding, objectId: "object-2", currentPath: "docs/b.md" };
    expect(state.storage.mintNamedLiveTicket({ ...another(3), objectId: "object-2", report: { ...report, binding: otherBinding } })).toBeNull();
  } finally { await state.close(); }
});

it("compares frozen binding with a fresh report after a fence change", async () => {
  const state = await fixture();
  try {
    state.storage.mintNamedLiveTicket(mint);
    state.raw.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=8");
    const fresh = { ...report, binding: { ...binding, restoreFenceGeneration: 8 } };
    expect(state.storage.redeemNamedLiveTicket({ ...redeem, report: fresh })).toBeNull();
    expect(state.storage.mintNamedLiveTicket({ ...another(2), report: fresh })).not.toBeNull();
  } finally { await state.close(); }
});

it.each([
  "CREATE INDEX idx_sync_relay_live_session_tickets_hash ON sync_relay_live_session_tickets(token_hash)",
  "CREATE UNIQUE INDEX idx_sync_relay_live_session_tickets_hash ON sync_relay_live_session_tickets(token_hash) WHERE redeemed_at_ms IS NULL",
  "CREATE UNIQUE INDEX idx_sync_relay_live_session_tickets_hash ON sync_relay_live_session_tickets(audience)",
])("refuses altered index definitions: %s", async sql => {
  const state = await fixture();
  try {
    state.raw.exec(`DROP INDEX idx_sync_relay_live_session_tickets_hash; ${sql}`);
    expect(() => reopenForSchemaCheck(state.path)).toThrow("live-ticket schema is missing or damaged");
  } finally { await state.close(); }
});

it("preserves literal constraint case when validating the schema", async () => {
  const state = await fixture();
  try {
    const schema = state.raw.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name=? AND sql IS NOT NULL ORDER BY type DESC").all(table);
    state.raw.exec(`DROP TABLE ${table}`);
    for (const row of schema) state.raw.exec(String(row.sql).replace("main_version_id = 'main'", "main_version_id = 'MAIN'"));
    expect(() => reopenForSchemaCheck(state.path)).toThrow("live-ticket schema is missing or damaged");
  } finally { await state.close(); }
});

it("refuses same-name trigger collisions even when the reserved index exists", async () => {
  const state = await fixture();
  try {
    state.raw.exec("CREATE TRIGGER idx_sync_relay_live_session_tickets_hash AFTER INSERT ON sync_relay_workspaces BEGIN SELECT 1; END");
    expect(() => reopenForSchemaCheck(state.path)).toThrow("live-ticket schema is missing or damaged");
  } finally { await state.close(); }
});
