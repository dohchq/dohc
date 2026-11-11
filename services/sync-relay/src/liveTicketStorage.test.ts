import { expect, it, vi } from "vitest";
import { audience, binding, fixture, host, key, marker, report, scope, table, DatabaseSync } from "./liveTickets.test-helper.js";
import { hashLiveTicketToken } from "./liveTicketSecurity.js";
import { openSyncRelayStorage } from "./storage.js";
import type { StorageContext } from "./storage/context.js";
import { consumeLiveTicketInTransaction, storeLiveTicketInTransaction } from "./storage/liveDocumentAuthority.js";
import { LIVE_TICKET_COLUMNS } from "./storage/schema.js";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { parseLiveTicketClaims } from "@dohc/live-session-contract/live-ticket";

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
    expect(state.raw.prepare(`PRAGMA table_info(${table})`).all()).toHaveLength(21);
  } finally { await state.close(); }
});
it("replaces a v1 ticket table, whose tickets expire within 30 seconds, instead of copying it", async () => {
  const state = await fixture();
  try {
    state.raw.exec(`DROP TABLE ${table}; CREATE TABLE ${table} (ticket_id TEXT PRIMARY KEY, link_session_id TEXT) STRICT;
      INSERT INTO ${table} VALUES ('ticket-v1', 'session-1')`);
    state.raw.prepare("UPDATE sync_relay_migrations SET migration_id='live-session-tickets-v1' WHERE migration_id=?").run(marker);
    reopenForSchemaCheck(state.path);
    expect(state.raw.prepare("SELECT migration_id FROM sync_relay_migrations WHERE migration_id LIKE 'live-session-tickets-%'").all())
      .toEqual([{ migration_id: marker }]);
    expect(state.raw.prepare(`PRAGMA table_info(${table})`).all()).toHaveLength(21);
    expect(rows(state)).toEqual([]);
    expect(state.storage.mintLiveTicket(mint)).toEqual({ expiresAtMs: 31000 });
  } finally { await state.close(); }
});
it("refuses a link ticket that names both a link session and an agent connection, or neither", async () => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    expect(() => state.raw.exec(`UPDATE ${table} SET agent_connection_id='connection-1'`)).toThrow(/CHECK/);
    expect(() => state.raw.exec(`UPDATE ${table} SET principal_kind='link'`)).toThrow(/CHECK/);
    expect(() => state.raw.exec(`UPDATE ${table} SET principal_kind='link', agent_connection_id='connection-1'`)).not.toThrow();
    expect(() => state.raw.exec(`UPDATE ${table} SET link_session_id='session-1'`)).toThrow(/CHECK/);
  } finally { await state.close(); }
});
it("commits a ticket and consumes the hashed credential once in real storage", async () => {
  const state = await fixture();
  try {
    expect(state.storage.mintLiveTicket(mint)).toEqual({ expiresAtMs: 31000 });
    expect(state.storage.readLiveTicketTarget({ tokenHash, scope, audience })).toEqual({ workspaceId: scope.workspaceId, objectId: binding.objectId });
    expect(state.storage.redeemLiveTicket(redeem)).toMatchObject({ ticketId: mint.ticketId, redeemedAtMs: 1000 });
    expect(state.storage.redeemLiveTicket(redeem)).toBeNull();
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
    expect(state.storage.mintLiveTicket(mint)).not.toBeNull();
    expect(state.storage.readLiveTicketTarget({ tokenHash, scope, audience, ...changed })).toBeNull();
    expect(state.storage.redeemLiveTicket({ ...redeem, ...changed })).toBeNull();
    expect(state.storage.redeemLiveTicket(redeem)).not.toBeNull();
  } finally { await state.close(); }
});

it.each([999, 1000, 30999, 31000, 31001])("uses the exact issue/expiry interval at %i", async time => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    state.setTime(time);
    const accepted = time >= 1000 && time < 31000;
    expect(state.storage.redeemLiveTicket(redeem) !== null).toBe(accepted);
    if (!accepted) {
      expect(rows(state)).toEqual([{ ticket_id: "ticket-1", redeemed_at_ms: null }]);
    }
  } finally { await state.close(); }
});

it("rejects overflow and invalid clocks without creating rows", async () => {
  const state = await fixture();
  try {
    state.setTime(Number.MAX_SAFE_INTEGER - 29999);
    expect(state.storage.mintLiveTicket(mint)).toBeNull();
    for (const time of [-1, NaN, Infinity, 1.5]) {
      state.setTime(time);
      expect(() => state.storage.mintLiveTicket(mint)).toThrow("Invalid live-ticket clock");
    }
    expect(rows(state)).toEqual([]);
  } finally { await state.close(); }
});

it("requires explicit captured positive policies with no default", async () => {
  const state = await fixture({});
  try {
    expect(() => state.storage.mintLiveTicket(mint)).toThrow("not configured");
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
      expect(configured.mintLiveTicket(mint)).toEqual({ expiresAtMs: 31000 });
      expect(configured.mintLiveTicket(another(2))).toBeNull();
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
    state.storage.mintLiveTicket(mint);
    expect(second.redeemLiveTicket(redeem)).toBeNull();
    expect(now).toHaveBeenCalledTimes(1);
    expect(second.readLiveTicketTarget({ tokenHash, scope, audience })).toBeNull();
    expect(now).toHaveBeenCalledTimes(2);
    expect(second.mintLiveTicket(another(2))).toEqual({ expiresAtMs: 61000 });
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
    expect(state.storage.mintLiveTicket(mint)).not.toBeNull();
    expect(state.storage.redeemLiveTicket(redeem)).not.toBeNull();
    expect(guard).toHaveBeenCalled();
  } finally { guard.mockRestore(); await state.close(); }
});

it("retains redeemed capacity until expiry and never evicts unexpired tickets", async () => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    state.storage.redeemLiveTicket(redeem);
    state.storage.mintLiveTicket(another(2));
    expect(state.storage.mintLiveTicket(another(3))).toBeNull();
    expect(rows(state)).toHaveLength(2);
    state.setTime(31000);
    expect(state.storage.mintLiveTicket(another(3))).toEqual({ expiresAtMs: 61000 });
    expect(rows(state).map(row => row.ticket_id)).toEqual(["ticket-2", "ticket-3"]);
  } finally { await state.close(); }
});

it("rolls bounded expiry cleanup back when retained capacity refuses", async () => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    state.storage.mintLiveTicket(another(2));
    state.raw.prepare(`UPDATE ${table} SET minted_at_ms=10000, expires_at_ms=40000`).run();
    const stale = another(9);
    state.raw.prepare(`INSERT INTO ${table} SELECT ?, ?, audience, workspace_id, main_version_id, object_id, lineage_claim_id,
      current_path, selector_paths_json, restore_fence_generation, principal_kind, principal_id, grant_id, grant_generation,
      host_epoch, 0, 30000, NULL, link_session_id, agent_connection_id, personal_connection_id FROM ${table} LIMIT 1`).run(stale.ticketId, stale.tokenHash);
    state.setTime(31000);
    const before = rows(state);
    expect(state.storage.mintLiveTicket(another(3))).toBeNull();
    expect(rows(state)).toEqual(before);
  } finally { await state.close(); }
});

it.each(["ticketId", "tokenHash"] as const)("refuses %s collisions before expiry cleanup", async field => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    state.setTime(31000);
    expect(state.storage.mintLiveTicket({ ...another(2), [field]: mint[field] })).toBeNull();
    expect(rows(state)).toEqual([{ ticket_id: "ticket-1", redeemed_at_ms: null }]);
  } finally { await state.close(); }
});

it("does not reset retained capacity when generation or audience changes", async () => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    state.raw.exec("UPDATE sync_relay_share_grants SET generation=5");
    expect(state.storage.mintLiveTicket({ ...another(2), audience: "https://other.example.test" })).not.toBeNull();
    expect(state.storage.mintLiveTicket(another(3))).toBeNull();
  } finally { await state.close(); }
});

it("keeps capacity independent across grants and named principals", async () => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    state.storage.mintLiveTicket(another(2));
    for (const [grantId, userId, id] of [["edit-2", scope.userId, 3], ["edit-3", "reader-2", 4]] as const) {
      state.raw.prepare(`INSERT INTO sync_relay_share_grants SELECT ?, share_id, principal_kind, ?, principal_email, access,
        generation, status, created_at_ms, revoked_at_ms, parent_grant_id FROM sync_relay_share_grants WHERE grant_id=?`)
        .run(grantId, userId, scope.grantId);
      expect(state.storage.mintLiveTicket({ ...another(id), scope: { ...scope, grantId, userId } })).not.toBeNull();
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
    state.storage.mintLiveTicket(mint);
    state.raw.exec(sql);
    const next = another(2);
    if (_name === "grant generation") {
      expect(state.storage.mintLiveTicket(next)).toEqual({ expiresAtMs: 31000 });
    } else {
      expect(state.storage.mintLiveTicket(next)).toBeNull();
    }
    expect(state.storage.redeemLiveTicket(redeem)).toBeNull();
    if (_name === "grant generation") {
      expect(state.storage.redeemLiveTicket({ ...redeem, tokenHash: next.tokenHash })).toMatchObject({
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
    expect(state.storage.mintLiveTicket({ ...mint, report: { ...report, binding: zero } })).toBeNull();
  } finally { await state.close(); }
});

it("accepts a valid newer main settlement without requiring the registration moment", async () => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    state.raw.prepare(`INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, blob_sha256, content_kind, byte_length, recorded_at_ms) SELECT workspace_id, object_id, 2, 'moment-2', version_id, path,
      ?, content_kind, 9, 2 FROM sync_relay_object_moments`).run("c".repeat(64));
    expect(state.storage.redeemLiveTicket(redeem)).not.toBeNull();
  } finally { await state.close(); }
});

it("allows same-epoch reconnect only with the fresh authenticated report", async () => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    state.storage.disconnectLiveHost({ ...host, updatedAtMs: 3, guard: () => undefined });
    expect(state.storage.redeemLiveTicket(redeem)).toBeNull();
    const connection = { ...host, connectionId: "connection-2" };
    state.storage.registerLiveHost({ ...connection, updatedAtMs: 4, guard: () => undefined });
    expect(state.storage.mintLiveTicket(another(2))).toBeNull();
    expect(state.storage.redeemLiveTicket(redeem)).toBeNull();
    expect(state.storage.redeemLiveTicket({ ...redeem, report: { ...report, connection } })).not.toBeNull();
  } finally { await state.close(); }
});

it.each(["mode", "hostId", "hostEpoch", "instanceId", "connectionId"] as const)("compares host report %s on both operations", async field => {
  const state = await fixture();
  try {
    const changed = { ...report, connection: { ...host, [field]: field === "mode" ? "service" : field === "hostEpoch" ? 2 : "other" } };
    expect(state.storage.mintLiveTicket({ ...mint, report: changed })).toBeNull();
    state.storage.mintLiveTicket(mint);
    expect(state.storage.redeemLiveTicket({ ...redeem, report: changed })).toBeNull();
    expect(state.storage.redeemLiveTicket(redeem)).not.toBeNull();
  } finally { await state.close(); }
});

it.each(["workspaceId", "mainVersionId", "objectId", "lineageClaimId", "currentPath", "selectorPaths", "restoreFenceGeneration"] as const)("compares report binding %s", async field => {
  const state = await fixture();
  try {
    const value = field === "lineageClaimId" ? "a".repeat(64) : field === "selectorPaths" ? ["docs", "other"] : field === "restoreFenceGeneration" ? 8 : "other";
    const changed = { ...report, binding: { ...binding, [field]: value } };
    if (field === "mainVersionId") expect(() => state.storage.mintLiveTicket({ ...mint, report: changed })).toThrow();
    else expect(state.storage.mintLiveTicket({ ...mint, report: changed })).toBeNull();
    state.storage.mintLiveTicket(mint);
    if (field === "mainVersionId") expect(() => state.storage.redeemLiveTicket({ ...redeem, report: changed })).toThrow();
    else expect(state.storage.redeemLiveTicket({ ...redeem, report: changed })).toBeNull();
    expect(state.storage.redeemLiveTicket(redeem)).not.toBeNull();
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
    state.storage.mintLiveTicket(mint);
    state.raw.exec("PRAGMA ignore_check_constraints=ON");
    state.raw.prepare(`UPDATE ${table} SET ${column}=?`).run(value);
    expect(() => state.storage.readLiveTicketTarget({ tokenHash, scope, audience })).toThrow(/stored live ticket is damaged|too large to be represented/);
    expect(() => state.storage.redeemLiveTicket(redeem)).toThrow(/stored live ticket is damaged|too large to be represented/);
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
    state.storage.mintLiveTicket(mint);
    expect(second.readLiveTicketTarget({ tokenHash, scope, audience })).toEqual({ workspaceId: scope.workspaceId, objectId: binding.objectId });
    state.raw.exec("DELETE FROM sync_relay_share_grants; DELETE FROM sync_relay_shares; DELETE FROM sync_relay_live_documents");
    expect(rows(state)).toHaveLength(1);
    state.raw.exec("DELETE FROM sync_relay_workspaces");
    expect(rows(state)).toHaveLength(0);
  } finally { second.close(); await state.close(); }
});

it.each(["mint", "redeem"] as const)("returns no %s result and rolls back on commit failure", async operation => {
  const state = await fixture();
  try {
    if (operation === "redeem") state.storage.mintLiveTicket(mint);
    const original = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
      if (sql === "COMMIT") throw new Error("injected commit failure");
      return original.call(this, sql);
    });
    try {
      expect(() => operation === "mint" ? state.storage.mintLiveTicket(mint) : state.storage.redeemLiveTicket(redeem)).toThrow("injected commit failure");
    } finally { spy.mockRestore(); }
    expect(rows(state)).toEqual(operation === "mint" ? [] : [{ ticket_id: "ticket-1", redeemed_at_ms: null }]);
    expect(state.storage.unavailable.aborted).toBe(true);
    expect(() => operation === "mint" ? state.storage.mintLiveTicket(mint) : state.storage.redeemLiveTicket(redeem)).toThrow("Relay storage is unavailable.");
    const reopened = openSyncRelayStorage(state.path, state.config);
    try {
      expect(operation === "mint" ? reopened.mintLiveTicket(mint) : reopened.redeemLiveTicket(redeem)).not.toBeNull();
    } finally { reopened.close(); }
  } finally { await state.close(); }
});

it("requires a changed row from the conditional consumption update", async () => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    state.raw.exec(`CREATE TRIGGER refuse_redemption BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(IGNORE); END`);
    expect(state.storage.redeemLiveTicket(redeem)).toBeNull();
    expect(rows(state)).toEqual([{ ticket_id: "ticket-1", redeemed_at_ms: null }]);
  } finally { await state.close(); }
});

it.each(["revoked", "narrowed", "wrong-kind", "missing"] as const)("rechecks dependent parent standing: %s", async change => {
  const state = await fixture();
  try {
    state.raw.prepare(`INSERT INTO sync_relay_share_grants SELECT 'parent-1', share_id, 'link', NULL, NULL, access,
      generation, status, created_at_ms, revoked_at_ms, NULL FROM sync_relay_share_grants WHERE grant_id=?`).run(scope.grantId);
    state.raw.exec("UPDATE sync_relay_share_grants SET parent_grant_id='parent-1' WHERE grant_id='edit-1'");
    expect(state.storage.mintLiveTicket(mint)).not.toBeNull();
    if (change === "revoked") state.raw.exec("UPDATE sync_relay_share_grants SET status='revoked', revoked_at_ms=3 WHERE grant_id='parent-1'");
    if (change === "narrowed") state.raw.exec("UPDATE sync_relay_share_grants SET access='comment' WHERE grant_id='parent-1'");
    if (change === "wrong-kind") state.raw.exec("UPDATE sync_relay_share_grants SET principal_kind='user', principal_user_id='owner-1' WHERE grant_id='parent-1'");
    if (change === "missing") state.raw.exec("PRAGMA foreign_keys=OFF; DELETE FROM sync_relay_share_grants WHERE grant_id='parent-1'");
    expect(state.storage.redeemLiveTicket(redeem)).toBeNull();
    expect(state.storage.mintLiveTicket(another(2))).toBeNull();
    expect(rows(state)).toEqual([{ ticket_id: "ticket-1", redeemed_at_ms: null }]);
  } finally { await state.close(); }
});

it("refuses both operations while the host is draining", async () => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    expect(state.storage.beginLiveHostTransition({ from: host, toMode: "service", toHostId: "service-1", transitionId: "transition-1",
      startedAtMs: 5, guard: () => undefined }).ok).toBe(true);
    expect(state.storage.mintLiveTicket(another(2))).toBeNull();
    expect(state.storage.redeemLiveTicket(redeem)).toBeNull();
  } finally { await state.close(); }
});

it("refuses activation, freezes the ticket epoch, and preserves capacity across host changes", async () => {
  const state = await fixture({ liveTickets: { retainedTicketsPerPrincipalGrant: 3, expiredTicketCleanupBatchSize: 1, now: () => 1000 } });
  try {
    state.storage.mintLiveTicket(mint);
    state.storage.mintLiveTicket(another(2));
    const transition = state.storage.beginLiveHostTransition({ from: host, toMode: "service", toHostId: "service-1",
      transitionId: "transition-1", startedAtMs: 5, guard: () => undefined });
    if (!transition.ok || !transition.snapshot.transition) throw new Error("fixture transition failed");
    const coordinate = { ...host, mode: "service" as const, hostId: "service-1", hostEpoch: parseHostEpoch(2), instanceId: "service-instance", connectionId: "service-connection" };
    const transitionGeneration = transition.snapshot.transition.transitionGeneration;
    expect(state.storage.commitLiveHostTransitionEpoch({ transitionId: "transition-1", transitionGeneration, updatedAtMs: 6 }).ok).toBe(true);
    expect(state.storage.mintLiveTicket({ ...another(3), report: { ...report, connection: coordinate } })).toBeNull();
    expect(state.storage.redeemLiveTicket({ ...redeem, report: { ...report, connection: coordinate } })).toBeNull();
    expect(state.storage.activateLiveHostTransition({ ...coordinate, transitionId: "transition-1", transitionGeneration,
      transitionFromEpoch: host.hostEpoch, updatedAtMs: 7, guard: () => undefined }).ok).toBe(true);
    expect(state.storage.redeemLiveTicket({ ...redeem, report: { ...report, connection: coordinate } })).toBeNull();
    expect(state.storage.mintLiveTicket({ ...another(3), report: { ...report, connection: coordinate } })).not.toBeNull();
    expect(state.storage.mintLiveTicket({ ...another(4), report: { ...report, connection: coordinate } })).toBeNull();
    expect(state.raw.prepare(`SELECT ticket_id FROM ${table} ORDER BY ticket_id`).all()).toEqual([
      { ticket_id: "ticket-1" }, { ticket_id: "ticket-2" }, { ticket_id: "ticket-3" },
    ]);
  } finally { await state.close(); }
});

it("shares retained capacity across objects", async () => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    state.storage.mintLiveTicket(another(2));
    state.raw.exec(`INSERT INTO sync_relay_object_moments SELECT workspace_id, 'object-2', relay_seq, 'moment-2', version_id,
      'docs/b.md', blob_sha256, content_kind, byte_length, recorded_at_ms FROM sync_relay_object_moments;
      INSERT INTO sync_relay_live_documents SELECT workspace_id, main_version_id, 'object-2', lineage_claim_id, replaces_lineage_claim_id,
      'docs/b.md', baseline_moment_relay_seq, baseline_projected_sha256, baseline_projected_byte_length, baseline_digest, baseline_bytes,
      lineage_state, admission_state, restore_fence_generation, registered_at_ms, retired_at_ms FROM sync_relay_live_documents`);
    const otherBinding = { ...binding, objectId: "object-2", currentPath: "docs/b.md" };
    expect(state.storage.mintLiveTicket({ ...another(3), objectId: "object-2", report: { ...report, binding: otherBinding } })).toBeNull();
  } finally { await state.close(); }
});

it("compares frozen binding with a fresh report after a fence change", async () => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    state.raw.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=8");
    const fresh = { ...report, binding: { ...binding, restoreFenceGeneration: 8 } };
    expect(state.storage.redeemLiveTicket({ ...redeem, report: fresh })).toBeNull();
    expect(state.storage.mintLiveTicket({ ...another(2), report: fresh })).not.toBeNull();
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

// Nothing issues a personal agent's ticket yet, so these store and consume one directly.
const personalAgent = "p-agent-1";
const personalHash = (id: number) => hashLiveTicketToken(id.toString(16).padStart(64, "f"), key);
const personalClaims = (ticketId: string, mintedAtMs: number) => parseLiveTicketClaims({ ticketId, audience,
  authority: { principalKind: "personal", principalId: personalAgent, grantId: null, grantGeneration: null },
  binding, hostEpoch: host.hostEpoch, mintedAtMs, expiresAtMs: mintedAtMs + 30000 });
type State = Awaited<ReturnType<typeof fixture>>;
const storePersonal = (state: State, ticketId: string, hash: string, personalConnectionId: string | null) => {
  const storage = state.storage as StorageContext;
  return storage.ticketTransaction((now, policy) => {
    storeLiveTicketInTransaction(storage, { claims: personalClaims(ticketId, now), tokenHash: hash,
      linkSessionId: null, agentConnectionId: null, personalConnectionId }, now, policy);
    return true;
  });
};
const consumePersonal = (state: State, ticketId: string, hash: string, personalConnectionId: string | null) => {
  const storage = state.storage as StorageContext;
  return storage.ticketTransaction(now =>
    consumeLiveTicketInTransaction(storage, { claims: personalClaims(ticketId, 1000), tokenHash: hash, personalConnectionId }, now));
};

it("stores a personal agent's ticket only with no grant and the connection that may redeem it", async () => {
  const state = await fixture();
  try {
    expect(() => storePersonal(state, "ticket-p", personalHash(1), null)).toThrow(/CHECK/);
    expect(rows(state)).toEqual([]);
    expect(storePersonal(state, "ticket-p", personalHash(1), "personal-connection-1")).toBe(true);
    expect(state.raw.prepare(`SELECT principal_kind, principal_id, grant_id, grant_generation, link_session_id, agent_connection_id,
      personal_connection_id FROM ${table}`).get()).toEqual({ principal_kind: "personal", principal_id: personalAgent, grant_id: null,
      grant_generation: null, link_session_id: null, agent_connection_id: null, personal_connection_id: "personal-connection-1" });
    expect(() => state.raw.exec(`UPDATE ${table} SET grant_id='edit-1', grant_generation=4`)).toThrow(/CHECK/);
    expect(() => state.raw.exec(`UPDATE ${table} SET principal_id='agent-1'`)).toThrow(/CHECK/);
    expect(() => state.raw.exec(`UPDATE ${table} SET agent_connection_id='connection-1'`)).toThrow(/CHECK/);
    state.storage.mintLiveTicket(mint);
    expect(() => state.raw.exec(`UPDATE ${table} SET personal_connection_id='personal-connection-1' WHERE principal_kind='named'`)).toThrow(/CHECK/);
  } finally { await state.close(); }
});

it("retains a personal agent's tickets per agent, which holds no grant", async () => {
  const state = await fixture();
  try {
    expect(storePersonal(state, "ticket-p1", personalHash(1), "personal-connection-1")).toBe(true);
    expect(storePersonal(state, "ticket-p2", personalHash(2), "personal-connection-2")).toBe(true);
    expect(storePersonal(state, "ticket-p3", personalHash(3), "personal-connection-1")).toBeNull();
    expect(state.storage.mintLiveTicket(mint)).toEqual({ expiresAtMs: 31000 });
    expect(rows(state).map(row => row.ticket_id)).toEqual(["ticket-1", "ticket-p1", "ticket-p2"]);
  } finally { await state.close(); }
});

it("redeems a personal agent's ticket only from the connection it names", async () => {
  const state = await fixture();
  try {
    storePersonal(state, "ticket-p", personalHash(1), "personal-connection-1");
    expect(consumePersonal(state, "ticket-p", personalHash(1), "personal-connection-2")).toBeNull();
    expect(consumePersonal(state, "ticket-p", personalHash(1), null)).toBeNull();
    expect(state.storage.readLiveTicketTarget({ tokenHash: personalHash(1), scope, audience })).toBeNull();
    expect(state.storage.redeemLiveTicket({ ...redeem, tokenHash: personalHash(1) })).toBeNull();
    expect(rows(state)).toEqual([{ ticket_id: "ticket-p", redeemed_at_ms: null }]);
    expect(consumePersonal(state, "ticket-p", personalHash(1), "personal-connection-1")).toMatchObject({ ticketId: "ticket-p", redeemedAtMs: 1000 });
    expect(consumePersonal(state, "ticket-p", personalHash(1), "personal-connection-1")).toBeNull();
  } finally { await state.close(); }
});

// The v2 table, before personal agents.
const V2_TICKET_TABLE = `CREATE TABLE ${table} (
  ticket_id TEXT NOT NULL CHECK (length(CAST(ticket_id AS BLOB)) BETWEEN 1 AND 512),
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 43 AND length(CAST(token_hash AS BLOB)) = 43 AND token_hash NOT GLOB '*[^A-Za-z0-9_-]*'),
  audience TEXT NOT NULL CHECK (length(CAST(audience AS BLOB)) BETWEEN 1 AND 2048),
  workspace_id TEXT NOT NULL CHECK (length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 512),
  main_version_id TEXT NOT NULL CHECK (main_version_id = 'main'),
  object_id TEXT NOT NULL CHECK (length(CAST(object_id AS BLOB)) BETWEEN 1 AND 512),
  lineage_claim_id TEXT NOT NULL CHECK (length(lineage_claim_id) = 64 AND length(CAST(lineage_claim_id AS BLOB)) = 64 AND lineage_claim_id NOT GLOB '*[^0-9a-f]*'),
  current_path TEXT NOT NULL CHECK (length(CAST(current_path AS BLOB)) BETWEEN 1 AND 1024),
  selector_paths_json TEXT NOT NULL CHECK (length(CAST(selector_paths_json AS BLOB)) BETWEEN 2 AND (100 * (6 * 1024 + 3) + 1)),
  restore_fence_generation INTEGER NOT NULL CHECK (restore_fence_generation BETWEEN 1 AND 9007199254740991),
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('named', 'link')),
  principal_id TEXT NOT NULL CHECK (length(CAST(principal_id AS BLOB)) BETWEEN 1 AND 512),
  grant_id TEXT NOT NULL CHECK (length(CAST(grant_id AS BLOB)) BETWEEN 1 AND 512),
  grant_generation INTEGER NOT NULL CHECK (grant_generation BETWEEN 1 AND 9007199254740991),
  host_epoch INTEGER NOT NULL CHECK (host_epoch BETWEEN 1 AND 9007199254740991),
  minted_at_ms INTEGER NOT NULL CHECK (minted_at_ms BETWEEN 0 AND 9007199254710991),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms BETWEEN 0 AND 9007199254740991 AND expires_at_ms = minted_at_ms + 30000),
  redeemed_at_ms INTEGER CHECK (redeemed_at_ms IS NULL OR (redeemed_at_ms BETWEEN 0 AND 9007199254740991
    AND minted_at_ms <= redeemed_at_ms AND redeemed_at_ms < expires_at_ms)),
  link_session_id TEXT CHECK (link_session_id IS NULL OR length(CAST(link_session_id AS BLOB)) BETWEEN 1 AND 512),
  agent_connection_id TEXT CHECK (agent_connection_id IS NULL OR length(CAST(agent_connection_id AS BLOB)) BETWEEN 1 AND 512),
  CHECK ((principal_kind = 'named' AND link_session_id IS NULL AND agent_connection_id IS NULL) OR
    (principal_kind = 'link' AND (link_session_id IS NULL) <> (agent_connection_id IS NULL))),
  PRIMARY KEY (ticket_id),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
) STRICT`;

it("keeps v2 tickets, which name no personal connection, when it rebuilds the table", async () => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    const indexes = () => state.raw.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name").all(table);
    const before = { rows: state.raw.prepare(`SELECT * FROM ${table}`).all(), indexes: indexes() };
    const v2Columns = LIVE_TICKET_COLUMNS.filter(column => column !== "personal_connection_id").join(", ");
    state.raw.exec(`CREATE TEMP TABLE kept AS SELECT ${v2Columns} FROM ${table}; DROP TABLE ${table}; ${V2_TICKET_TABLE};
      INSERT INTO ${table} SELECT * FROM temp.kept; DROP TABLE temp.kept`);
    for (const { sql } of before.indexes) state.raw.exec(String(sql));
    state.raw.prepare("UPDATE sync_relay_migrations SET migration_id='live-session-tickets-v2' WHERE migration_id=?").run(marker);
    reopenForSchemaCheck(state.path);
    expect(state.raw.prepare("SELECT migration_id FROM sync_relay_migrations WHERE migration_id LIKE 'live-session-tickets-%'").all())
      .toEqual([{ migration_id: marker }]);
    expect({ rows: state.raw.prepare(`SELECT * FROM ${table}`).all(), indexes: indexes() }).toEqual(before);
    expect(state.storage.redeemLiveTicket(redeem)).toMatchObject({ ticketId: mint.ticketId, redeemedAtMs: 1000 });
  } finally { await state.close(); }
});
