import { expect, it, vi } from "vitest";
import {
  audience,
  binding,
  fixture,
  host,
  key,
  marker,
  report,
  scope,
  table,
  DatabaseSync,
} from "./liveTickets.test-helper.js";
import { hashLiveTicketToken } from "./liveTicketSecurity.js";
import { openSyncRelayStorage } from "./storage.js";
import type { StorageContext } from "./storage/context.js";
import {
  consumeLiveTicketInTransaction,
  storeLiveTicketInTransaction,
} from "./storage/liveDocumentAuthority.js";
import { LIVE_TICKET_COLUMNS } from "./storage/schema.js";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { parseLiveTicketClaims } from "@dohc/live-session-contract/live-ticket";

function reopenForSchemaCheck(path: string): void {
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined;
  try {
    reopened = openSyncRelayStorage(path);
  } finally {
    reopened?.close();
  }
}

const tokenHash = hashLiveTicketToken("01".repeat(32), key);
const mint = {
  objectId: binding.objectId,
  scope,
  report,
  audience,
  ticketId: "ticket-1",
  tokenHash,
};
const redeem = { tokenHash, scope, report, audience };
it("creates and validates the complete private named-ticket schema", async () => {
  const state = await fixture();
  try {
    expect(
      state.raw
        .prepare("SELECT migration_id FROM sync_relay_migrations WHERE migration_id=?")
        .get(marker),
    ).toEqual({ migration_id: marker });
    expect(state.raw.prepare(`PRAGMA table_info(${table})`).all()).toHaveLength(21);
  } finally {
    await state.close();
  }
});

it("replaces a v1 ticket table, whose tickets expire within 30 seconds, instead of copying it", async () => {
  const state = await fixture();
  try {
    state.raw
      .exec(`DROP TABLE ${table}; CREATE TABLE ${table} (ticket_id TEXT PRIMARY KEY, link_session_id TEXT) STRICT;
      INSERT INTO ${table} VALUES ('ticket-v1', 'session-1')`);
    state.raw
      .prepare(
        "UPDATE sync_relay_migrations SET migration_id='live-session-tickets-v1' WHERE migration_id=?",
      )
      .run(marker);
    reopenForSchemaCheck(state.path);
    expect(
      state.raw
        .prepare(
          "SELECT migration_id FROM sync_relay_migrations WHERE migration_id LIKE 'live-session-tickets-%'",
        )
        .all(),
    ).toEqual([{ migration_id: marker }]);
    expect(state.raw.prepare(`PRAGMA table_info(${table})`).all()).toHaveLength(21);
    expect(rows(state)).toEqual([]);
    expect(state.storage.mintLiveTicket(mint)).toEqual({ expiresAtMs: 31000 });
  } finally {
    await state.close();
  }
});

it("refuses a link ticket that names both a link session and an agent connection, or neither", async () => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    expect(() => state.raw.exec(`UPDATE ${table} SET agent_connection_id='connection-1'`)).toThrow(
      /CHECK/,
    );
    expect(() => state.raw.exec(`UPDATE ${table} SET principal_kind='link'`)).toThrow(/CHECK/);
    expect(() =>
      state.raw.exec(
        `UPDATE ${table} SET principal_kind='link', agent_connection_id='connection-1'`,
      ),
    ).not.toThrow();
    expect(() => state.raw.exec(`UPDATE ${table} SET link_session_id='session-1'`)).toThrow(
      /CHECK/,
    );
  } finally {
    await state.close();
  }
});
it("commits a ticket and consumes the hashed credential once in real storage", async () => {
  const state = await fixture();
  try {
    expect(state.storage.mintLiveTicket(mint)).toEqual({ expiresAtMs: 31000 });
    expect(state.storage.readLiveTicketTarget({ tokenHash, scope, audience })).toEqual({
      workspaceId: scope.workspaceId,
      objectId: binding.objectId,
    });
    expect(state.storage.redeemLiveTicket(redeem)).toMatchObject({
      ticketId: mint.ticketId,
      redeemedAtMs: 1000,
    });
    expect(state.storage.redeemLiveTicket(redeem)).toBeNull();
  } finally {
    await state.close();
  }
});

const another = (id: number) => ({
  ...mint,
  ticketId: `ticket-${id}`,
  tokenHash: hashLiveTicketToken(id.toString(16).padStart(64, "0"), key),
});
const rows = (state: Awaited<ReturnType<typeof fixture>>) =>
  state.raw.prepare(`SELECT ticket_id, redeemed_at_ms FROM ${table} ORDER BY ticket_id`).all();

it.each([["wrong workspace", { scope: { ...scope, workspaceId: "other" } }]])(
  "refuses %s without consuming or disclosing the rightful ticket",
  async (_name, changed) => {
    const state = await fixture();
    try {
      expect(state.storage.mintLiveTicket(mint)).not.toBeNull();
      expect(state.storage.readLiveTicketTarget({ tokenHash, audience, ...changed })).toBeNull();
      expect(state.storage.redeemLiveTicket({ ...redeem, ...changed })).toBeNull();
      expect(state.storage.redeemLiveTicket(redeem)).not.toBeNull();
    } finally {
      await state.close();
    }
  },
);

it.each([31000])("uses the exact issue/expiry interval at %i", async (time) => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    state.setTime(time);
    const accepted = time >= 1000 && time < 31000;
    expect(state.storage.redeemLiveTicket(redeem) !== null).toBe(accepted);
    if (!accepted) {
      expect(rows(state)).toEqual([{ ticket_id: "ticket-1", redeemed_at_ms: null }]);
    }
  } finally {
    await state.close();
  }
});

it("excludes a second writer during decisive grant and host authority checks", async () => {
  const state = await fixture();
  state.raw.exec("PRAGMA busy_timeout=0");
  const original = state.storage.getShareGrant.bind(state.storage);
  const guard = vi.spyOn(state.storage, "getShareGrant").mockImplementation((id) => {
    expect(() =>
      state.raw.exec("UPDATE sync_relay_share_grants SET generation=generation+1"),
    ).toThrow(/locked/);
    expect(() =>
      state.raw.exec(
        "UPDATE sync_relay_session_host_control SET registered_connection_id='racing-connection'",
      ),
    ).toThrow(/locked/);
    return original(id);
  });
  try {
    expect(state.storage.mintLiveTicket(mint)).not.toBeNull();
    expect(state.storage.redeemLiveTicket(redeem)).not.toBeNull();
    expect(guard).toHaveBeenCalled();
  } finally {
    guard.mockRestore();
    await state.close();
  }
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
    expect(rows(state).map((row) => row.ticket_id)).toEqual(["ticket-2", "ticket-3"]);
  } finally {
    await state.close();
  }
});

it.each([
  ["grant generation", "UPDATE sync_relay_share_grants SET generation=5"],
  ["grant revocation", "UPDATE sync_relay_share_grants SET status='revoked', revoked_at_ms=2"],
  [
    "selector losing the document",
    `UPDATE sync_relay_shares SET selector_json='{"paths":["docs/b.md"],"versionId":null}'`,
  ],
  ["fence generation", "UPDATE sync_relay_live_documents SET restore_fence_generation=8"],
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
      expect(
        state.storage.redeemLiveTicket({ ...redeem, tokenHash: next.tokenHash }),
      ).toMatchObject({
        authority: { principalKind: "named", grantGeneration: 5 },
      });
      expect(rows(state)).toEqual([
        { ticket_id: "ticket-1", redeemed_at_ms: null },
        { ticket_id: "ticket-2", redeemed_at_ms: 1000 },
      ]);
    } else {
      expect(rows(state)).toEqual([{ ticket_id: "ticket-1", redeemed_at_ms: null }]);
    }
  } finally {
    await state.close();
  }
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
    expect(
      state.storage.redeemLiveTicket({ ...redeem, report: { ...report, connection } }),
    ).not.toBeNull();
  } finally {
    await state.close();
  }
});

it.each([["invalid lifetime", "expires_at_ms", 31001]])(
  "treats stored %s as integrity failure",
  async (_name, column, value) => {
    const state = await fixture();
    try {
      state.storage.mintLiveTicket(mint);
      state.raw.exec("PRAGMA ignore_check_constraints=ON");
      state.raw.prepare(`UPDATE ${table} SET ${column}=?`).run(value);
      expect(() => state.storage.readLiveTicketTarget({ tokenHash, scope, audience })).toThrow(
        /stored live ticket is damaged|too large to be represented/,
      );
      expect(() => state.storage.redeemLiveTicket(redeem)).toThrow(
        /stored live ticket is damaged|too large to be represented/,
      );
    } finally {
      await state.close();
    }
  },
);

it.each([
  `DROP INDEX idx_sync_relay_live_session_tickets_hash`,
  `CREATE INDEX extra_ticket_index ON ${table}(audience)`,
  `CREATE TRIGGER extra_ticket_trigger AFTER INSERT ON ${table} BEGIN SELECT 1; END`,
  `DROP TABLE ${table}`,
])("refuses marked schema damage without repair: %s", async (sql) => {
  const state = await fixture();
  try {
    state.raw.exec(sql);
    const before = state.raw
      .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
      .all();
    expect(() => reopenForSchemaCheck(state.path)).toThrow(
      "live-ticket schema is missing or damaged",
    );
    expect(
      state.raw
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
        .all(),
    ).toEqual(before);
  } finally {
    await state.close();
  }
});

it("rejects an unmarked complete schema and a same-name trigger without adopting either", async () => {
  const state = await fixture();
  try {
    state.raw.prepare("DELETE FROM sync_relay_migrations WHERE migration_id=?").run(marker);
    expect(() => reopenForSchemaCheck(state.path)).toThrow("unmarked live-ticket schema");
    state.raw.exec(
      `DROP TABLE ${table}; CREATE TRIGGER ${table} AFTER INSERT ON sync_relay_workspaces BEGIN SELECT 1; END`,
    );
    expect(() => reopenForSchemaCheck(state.path)).toThrow("unmarked live-ticket schema");
    expect(
      state.raw.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(marker),
    ).toBeUndefined();
  } finally {
    await state.close();
  }
});

it("reopens valid tickets and cascades only with workspace deletion", async () => {
  const state = await fixture();
  const second = openSyncRelayStorage(state.path, state.config);
  try {
    state.storage.mintLiveTicket(mint);
    expect(second.readLiveTicketTarget({ tokenHash, scope, audience })).toEqual({
      workspaceId: scope.workspaceId,
      objectId: binding.objectId,
    });
    state.raw.exec(
      "DELETE FROM sync_relay_share_grants; DELETE FROM sync_relay_shares; DELETE FROM sync_relay_live_documents",
    );
    expect(rows(state)).toHaveLength(1);
    state.raw.exec("DELETE FROM sync_relay_workspaces");
    expect(rows(state)).toHaveLength(0);
  } finally {
    second.close();
    await state.close();
  }
});

it("rolls back redemption on commit failure and recovers after reopening", async () => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    const original = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: InstanceType<typeof DatabaseSync>,
      sql: string,
    ) {
      if (sql === "COMMIT") throw new Error("injected commit failure");
      return original.call(this, sql);
    });
    try {
      expect(() => state.storage.redeemLiveTicket(redeem)).toThrow("injected commit failure");
    } finally {
      spy.mockRestore();
    }
    expect(rows(state)).toEqual([{ ticket_id: "ticket-1", redeemed_at_ms: null }]);
    expect(state.storage.unavailable.aborted).toBe(true);
    expect(() => state.storage.redeemLiveTicket(redeem)).toThrow("Relay storage is unavailable.");
    const reopened = openSyncRelayStorage(state.path, state.config);
    try {
      expect(reopened.redeemLiveTicket(redeem)).not.toBeNull();
    } finally {
      reopened.close();
    }
  } finally {
    await state.close();
  }
});

it("requires a changed row from the conditional consumption update", async () => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    state.raw.exec(
      `CREATE TRIGGER refuse_redemption BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
    );
    expect(state.storage.redeemLiveTicket(redeem)).toBeNull();
    expect(rows(state)).toEqual([{ ticket_id: "ticket-1", redeemed_at_ms: null }]);
  } finally {
    await state.close();
  }
});

it("refuses a ticket after its dependent parent is revoked", async () => {
  const state = await fixture();
  try {
    state.raw
      .prepare(`INSERT INTO sync_relay_share_grants SELECT 'parent-1', share_id, 'link', NULL, NULL, access,
      generation, status, created_at_ms, revoked_at_ms, NULL FROM sync_relay_share_grants WHERE grant_id=?`)
      .run(scope.grantId);
    state.raw.exec(
      "UPDATE sync_relay_share_grants SET parent_grant_id='parent-1' WHERE grant_id='edit-1'",
    );
    expect(state.storage.mintLiveTicket(mint)).not.toBeNull();
    state.raw.exec(
      "UPDATE sync_relay_share_grants SET status='revoked', revoked_at_ms=3 WHERE grant_id='parent-1'",
    );
    expect(state.storage.redeemLiveTicket(redeem)).toBeNull();
    expect(state.storage.mintLiveTicket(another(2))).toBeNull();
    expect(rows(state)).toEqual([{ ticket_id: "ticket-1", redeemed_at_ms: null }]);
  } finally {
    await state.close();
  }
});

it("refuses activation, freezes the ticket epoch, and preserves capacity across host changes", async () => {
  const state = await fixture({
    liveTickets: {
      retainedTicketsPerPrincipalGrant: 3,
      expiredTicketCleanupBatchSize: 1,
      now: () => 1000,
    },
  });
  try {
    state.storage.mintLiveTicket(mint);
    state.storage.mintLiveTicket(another(2));
    const transition = state.storage.beginLiveHostTransition({
      from: host,
      toMode: "service",
      toHostId: "service-1",
      transitionId: "transition-1",
      startedAtMs: 5,
      guard: () => undefined,
    });
    if (!transition.ok || !transition.snapshot.transition)
      throw new Error("fixture transition failed");
    const coordinate = {
      ...host,
      mode: "service" as const,
      hostId: "service-1",
      hostEpoch: parseHostEpoch(2),
      instanceId: "service-instance",
      connectionId: "service-connection",
    };
    const transitionGeneration = transition.snapshot.transition.transitionGeneration;
    expect(
      state.storage.commitLiveHostTransitionEpoch({
        transitionId: "transition-1",
        transitionGeneration,
        updatedAtMs: 6,
      }).ok,
    ).toBe(true);
    expect(
      state.storage.mintLiveTicket({
        ...another(3),
        report: { ...report, connection: coordinate },
      }),
    ).toBeNull();
    expect(
      state.storage.redeemLiveTicket({ ...redeem, report: { ...report, connection: coordinate } }),
    ).toBeNull();
    expect(
      state.storage.activateLiveHostTransition({
        ...coordinate,
        transitionId: "transition-1",
        transitionGeneration,
        transitionFromEpoch: host.hostEpoch,
        updatedAtMs: 7,
        guard: () => undefined,
      }).ok,
    ).toBe(true);
    expect(
      state.storage.redeemLiveTicket({ ...redeem, report: { ...report, connection: coordinate } }),
    ).toBeNull();
    expect(
      state.storage.mintLiveTicket({
        ...another(3),
        report: { ...report, connection: coordinate },
      }),
    ).not.toBeNull();
    expect(
      state.storage.mintLiveTicket({
        ...another(4),
        report: { ...report, connection: coordinate },
      }),
    ).toBeNull();
    expect(state.raw.prepare(`SELECT ticket_id FROM ${table} ORDER BY ticket_id`).all()).toEqual([
      { ticket_id: "ticket-1" },
      { ticket_id: "ticket-2" },
      { ticket_id: "ticket-3" },
    ]);
  } finally {
    await state.close();
  }
});

it("compares frozen binding with a fresh report after a fence change", async () => {
  const state = await fixture();
  try {
    state.storage.mintLiveTicket(mint);
    state.raw.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=8");
    const fresh = { ...report, binding: { ...binding, restoreFenceGeneration: 8 } };
    expect(state.storage.redeemLiveTicket({ ...redeem, report: fresh })).toBeNull();
    expect(state.storage.mintLiveTicket({ ...another(2), report: fresh })).not.toBeNull();
  } finally {
    await state.close();
  }
});

it.each([
  "CREATE INDEX idx_sync_relay_live_session_tickets_hash ON sync_relay_live_session_tickets(token_hash)",
  "CREATE UNIQUE INDEX idx_sync_relay_live_session_tickets_hash ON sync_relay_live_session_tickets(token_hash) WHERE redeemed_at_ms IS NULL",
  "CREATE UNIQUE INDEX idx_sync_relay_live_session_tickets_hash ON sync_relay_live_session_tickets(audience)",
])("refuses altered index definitions: %s", async (sql) => {
  const state = await fixture();
  try {
    state.raw.exec(`DROP INDEX idx_sync_relay_live_session_tickets_hash; ${sql}`);
    expect(() => reopenForSchemaCheck(state.path)).toThrow(
      "live-ticket schema is missing or damaged",
    );
  } finally {
    await state.close();
  }
});

it("refuses same-name trigger collisions even when the reserved index exists", async () => {
  const state = await fixture();
  try {
    state.raw.exec(
      "CREATE TRIGGER idx_sync_relay_live_session_tickets_hash AFTER INSERT ON sync_relay_workspaces BEGIN SELECT 1; END",
    );
    expect(() => reopenForSchemaCheck(state.path)).toThrow(
      "live-ticket schema is missing or damaged",
    );
  } finally {
    await state.close();
  }
});

// These store and consume a personal agent's ticket in storage directly. personalLiveRoutes.test.ts
// covers minting and redeeming one through its routes.
const personalAgent = "p-agent-1";
const personalHash = (id: number) => hashLiveTicketToken(id.toString(16).padStart(64, "f"), key);
const personalClaims = (ticketId: string, mintedAtMs: number) =>
  parseLiveTicketClaims({
    ticketId,
    audience,
    authority: {
      principalKind: "personal",
      principalId: personalAgent,
      grantId: null,
      grantGeneration: null,
    },
    binding,
    hostEpoch: host.hostEpoch,
    mintedAtMs,
    expiresAtMs: mintedAtMs + 30000,
  });
type State = Awaited<ReturnType<typeof fixture>>;
const storePersonal = (
  state: State,
  ticketId: string,
  hash: string,
  personalConnectionId: string | null,
) => {
  const storage = state.storage as StorageContext;
  return storage.ticketTransaction((now, policy) => {
    storeLiveTicketInTransaction(
      storage,
      {
        claims: personalClaims(ticketId, now),
        tokenHash: hash,
        linkSessionId: null,
        agentConnectionId: null,
        personalConnectionId,
      },
      now,
      policy,
    );
    return true;
  });
};
const consumePersonal = (
  state: State,
  ticketId: string,
  hash: string,
  personalConnectionId: string | null,
) => {
  const storage = state.storage as StorageContext;
  return storage.ticketTransaction((now) =>
    consumeLiveTicketInTransaction(
      storage,
      { ticketId, tokenHash: hash, personalConnectionId },
      now,
    ),
  );
};

it("redeems a personal agent's ticket only from the connection it names", async () => {
  const state = await fixture();
  try {
    storePersonal(state, "ticket-p", personalHash(1), "personal-connection-1");
    expect(consumePersonal(state, "ticket-p", personalHash(1), "personal-connection-2")).toBeNull();
    expect(consumePersonal(state, "ticket-p", personalHash(1), null)).toBeNull();
    expect(
      state.storage.readLiveTicketTarget({ tokenHash: personalHash(1), scope, audience }),
    ).toBeNull();
    expect(state.storage.redeemLiveTicket({ ...redeem, tokenHash: personalHash(1) })).toBeNull();
    expect(rows(state)).toEqual([{ ticket_id: "ticket-p", redeemed_at_ms: null }]);
    expect(
      consumePersonal(state, "ticket-p", personalHash(1), "personal-connection-1"),
    ).toMatchObject({ ticketId: "ticket-p", redeemedAtMs: 1000 });
    expect(consumePersonal(state, "ticket-p", personalHash(1), "personal-connection-1")).toBeNull();
  } finally {
    await state.close();
  }
});

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
    const indexes = () =>
      state.raw
        .prepare(
          "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name",
        )
        .all(table);
    const before = { rows: state.raw.prepare(`SELECT * FROM ${table}`).all(), indexes: indexes() };
    const v2Columns = LIVE_TICKET_COLUMNS.filter(
      (column) => column !== "personal_connection_id",
    ).join(", ");
    state.raw
      .exec(`CREATE TEMP TABLE kept AS SELECT ${v2Columns} FROM ${table}; DROP TABLE ${table}; ${V2_TICKET_TABLE};
      INSERT INTO ${table} SELECT * FROM temp.kept; DROP TABLE temp.kept`);
    for (const { sql } of before.indexes) state.raw.exec(String(sql));
    state.raw
      .prepare(
        "UPDATE sync_relay_migrations SET migration_id='live-session-tickets-v2' WHERE migration_id=?",
      )
      .run(marker);
    reopenForSchemaCheck(state.path);
    expect(
      state.raw
        .prepare(
          "SELECT migration_id FROM sync_relay_migrations WHERE migration_id LIKE 'live-session-tickets-%'",
        )
        .all(),
    ).toEqual([{ migration_id: marker }]);
    expect({ rows: state.raw.prepare(`SELECT * FROM ${table}`).all(), indexes: indexes() }).toEqual(
      before,
    );
    expect(state.storage.redeemLiveTicket(redeem)).toMatchObject({
      ticketId: mint.ticketId,
      redeemedAtMs: 1000,
    });
  } finally {
    await state.close();
  }
});
