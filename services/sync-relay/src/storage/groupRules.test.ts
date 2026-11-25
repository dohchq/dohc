import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { initializeSyncRelaySchema } from "./schema";
import type { SqliteDb } from "./types";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

describe("the Group rule table", () => {
  it("keeps an earlier build's rules and lets their author be cleared", () => {
    const db = new DatabaseSync(":memory:");
    initializeSyncRelaySchema(db as unknown as SqliteDb);
    db.exec(`
      INSERT INTO sync_relay_workspaces(workspace_id, owner_user_id, created_at_ms) VALUES ('ws', 'owner', 1);
      DELETE FROM sync_relay_migrations WHERE migration_id = 'workspace-group-rules-v2';
      INSERT INTO sync_relay_migrations(migration_id, completed_at_ms) VALUES ('workspace-group-rules-v1', 1);
      DROP TABLE sync_relay_group_rules;
      CREATE TABLE sync_relay_group_rules (
        workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
        channel_wire_id TEXT NOT NULL CHECK (length(channel_wire_id) BETWEEN 1 AND 256),
        rule_text TEXT,
        created_rule_text TEXT,
        changed_by_user_id TEXT NOT NULL,
        changed_at_ms INTEGER NOT NULL CHECK (changed_at_ms >= 0),
        PRIMARY KEY (workspace_id, channel_wire_id)
      ) STRICT;
      INSERT INTO sync_relay_group_rules VALUES ('ws', 'wire-team', 'members: none\n', NULL, 'ben', 2);
    `);

    initializeSyncRelaySchema(db as unknown as SqliteDb);
    db.exec("UPDATE sync_relay_group_rules SET changed_by_user_id = NULL");

    expect(
      db
        .prepare("SELECT * FROM sync_relay_group_rules")
        .all()
        .map((row) => ({ ...row })),
    ).toEqual([
      {
        workspace_id: "ws",
        channel_wire_id: "wire-team",
        rule_text: "members: none\n",
        created_rule_text: null,
        changed_by_user_id: null,
        changed_at_ms: 2,
      },
    ]);
    initializeSyncRelaySchema(db as unknown as SqliteDb);
  });
});
