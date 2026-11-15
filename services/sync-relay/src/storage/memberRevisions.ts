import { randomUUID } from "node:crypto";
import type { SqliteDb } from "./types";
import { memberReach } from "./memberReach";
import { isShareAccessValue } from "@dohc/security-contract/share-selector";

export function initializeMemberRevisions(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_relay_member_revisions (
    workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, signature TEXT NOT NULL, revision TEXT NOT NULL,
    PRIMARY KEY(workspace_id, user_id)
  ) STRICT`);
}

/** Mark only writes that can change reach; content edits leave revisions alone. */
export function watchMemberReachWrites(db: SqliteDb): void {
  db.exec("CREATE TEMP TABLE member_reach_dirty(workspace_id TEXT PRIMARY KEY) STRICT");
  for (const table of [
    "sync_relay_access_rules",
    "sync_relay_workspace_members",
    "sync_relay_workspace_memberships",
  ] as const) {
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      const row = event === "DELETE" ? "OLD" : "NEW";
      db.exec(`CREATE TEMP TRIGGER member_reach_${table}_${event} AFTER ${event} ON ${table}
        BEGIN INSERT OR IGNORE INTO member_reach_dirty VALUES (${row}.workspace_id); END`);
    }
  }
  for (const event of ["INSERT", "UPDATE", "DELETE"]) {
    const row = event === "DELETE" ? "OLD" : "NEW";
    db.exec(`CREATE TEMP TRIGGER member_reach_email_${event} AFTER ${event} ON sync_relay_account_emails
      BEGIN INSERT OR IGNORE INTO member_reach_dirty SELECT workspace_id FROM sync_relay_workspace_members WHERE user_id = ${row}.user_id; END`);
  }
  db.exec(`CREATE TEMP TRIGGER member_reach_move AFTER INSERT ON sync_relay_object_moments
    WHEN EXISTS (SELECT 1 FROM sync_relay_log WHERE relay_seq = NEW.relay_seq AND json_valid(payload_json)
      AND json_extract(payload_json, '$.operation') = 'rename')
    BEGIN INSERT OR IGNORE INTO member_reach_dirty VALUES (NEW.workspace_id); END`);
  db.exec(
    "INSERT OR IGNORE INTO member_reach_dirty SELECT workspace_id FROM sync_relay_workspace_memberships",
  );
  settleMemberRevisions(db);
}

export function settleMemberRevisions(db: SqliteDb): void {
  const members =
    db.prepare(`SELECT m.workspace_id, m.user_id, m.role, ms.member_level FROM sync_relay_workspace_members m
    JOIN sync_relay_workspace_memberships ms ON ms.workspace_id = m.workspace_id
    JOIN temp.member_reach_dirty d ON d.workspace_id = m.workspace_id WHERE m.state = 'active'`);
  const save =
    db.prepare(`INSERT INTO sync_relay_member_revisions(workspace_id, user_id, signature, revision) VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_id, user_id) DO UPDATE SET signature = excluded.signature, revision = excluded.revision
    WHERE signature != excluded.signature`);
  for (const m of members.all()) {
    if ((m.role !== "admin" && m.role !== "member") || !isShareAccessValue(m.member_level))
      continue;
    const reach = memberReach(
      db,
      String(m.workspace_id),
      String(m.user_id),
      m.role,
      m.member_level,
    );
    save.run(m.workspace_id, m.user_id, reach.signature, randomUUID());
  }
  db.exec("DELETE FROM temp.member_reach_dirty");
}
