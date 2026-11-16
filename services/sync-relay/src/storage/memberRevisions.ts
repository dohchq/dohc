import { randomUUID } from "node:crypto";
import type { SqliteDb } from "./types";
import type { AccessRuleSet } from "@dohc/security-contract/access-rules";
import { currentAccessRuleSet } from "./accessRules";
import { memberReach, nearestRuleFolder } from "./memberReach";
import { isShareAccessValue } from "@dohc/security-contract/share-selector";

export function initializeMemberRevisions(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_relay_member_revisions (
    workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, signature TEXT NOT NULL, revision TEXT NOT NULL,
    PRIMARY KEY(workspace_id, user_id)
  ) STRICT`);
}

/**
 * Mark only writes that can change reach; content edits leave revisions alone.
 * The caller settles once, inside its write owner.
 */
export function watchMemberReachWrites(db: SqliteDb): void {
  db.exec("CREATE TEMP TABLE member_reach_dirty(workspace_id TEXT PRIMARY KEY) STRICT");
  // A main-Version rename this transaction made. Settle judges it per member
  // only when it crosses a rule boundary.
  db.exec(
    "CREATE TEMP TABLE member_reach_moves(workspace_id TEXT NOT NULL, before_path TEXT NOT NULL, after_path TEXT NOT NULL) STRICT",
  );
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
    const changed =
      event === "UPDATE" ? "WHEN OLD.verified_email IS NOT NEW.verified_email" : "";
    db.exec(`CREATE TEMP TRIGGER member_reach_email_${event} AFTER ${event} ON sync_relay_account_emails ${changed}
      BEGIN INSERT OR IGNORE INTO member_reach_dirty SELECT workspace_id FROM sync_relay_workspace_members WHERE user_id = ${row}.user_id; END`);
  }
  db.exec(`CREATE TEMP TRIGGER member_reach_move AFTER INSERT ON sync_relay_log
    WHEN NEW.op_kind = 'moment.append' AND json_valid(NEW.payload_json)
      AND json_extract(NEW.payload_json, '$.operation') = 'rename'
      AND json_extract(NEW.payload_json, '$.versionId') = 'main'
      AND json_type(NEW.payload_json, '$.payloadBeforePath') = 'text'
      AND json_type(NEW.payload_json, '$.payloadAfterPath') = 'text'
    BEGIN
      INSERT INTO member_reach_moves VALUES (NEW.workspace_id,
        json_extract(NEW.payload_json, '$.payloadBeforePath'), json_extract(NEW.payload_json, '$.payloadAfterPath'));
    END`);
  db.exec(
    "INSERT OR IGNORE INTO member_reach_dirty SELECT workspace_id FROM sync_relay_workspace_memberships",
  );
}

/**
 * A member's revision advances when their evaluated folder levels change, or
 * when a rename this transaction made crossed a rule boundary and changed its
 * level for them. A rename that crosses no boundary costs one lookup per path.
 * Other costs grow with members and rules, never with History.
 */
export function settleMemberRevisions(db: SqliteDb): void {
  const rulesByWorkspace = new Map<string, AccessRuleSet>();
  const rulesOf = (workspaceId: string) => {
    let rules = rulesByWorkspace.get(workspaceId);
    if (!rules) {
      rules = currentAccessRuleSet(db, workspaceId);
      rulesByWorkspace.set(workspaceId, rules);
    }
    return rules;
  };
  const crossedByWorkspace = new Map<string, { before: string; after: string }[]>();
  for (const row of db.prepare("SELECT workspace_id, before_path, after_path FROM temp.member_reach_moves").all()) {
    const workspaceId = String(row.workspace_id);
    const move = { before: String(row.before_path), after: String(row.after_path) };
    const rules = rulesOf(workspaceId);
    if (nearestRuleFolder(rules, move.before) === nearestRuleFolder(rules, move.after)) continue;
    crossedByWorkspace.set(workspaceId, [...(crossedByWorkspace.get(workspaceId) ?? []), move]);
  }
  const workspaces = new Set([
    ...db.prepare("SELECT workspace_id FROM temp.member_reach_dirty").all().map((row) => String(row.workspace_id)),
    ...crossedByWorkspace.keys(),
  ]);
  const members =
    db.prepare(`SELECT m.user_id, m.role, ms.member_level, s.signature FROM sync_relay_workspace_members m
    JOIN sync_relay_workspace_memberships ms ON ms.workspace_id = m.workspace_id
    LEFT JOIN sync_relay_member_revisions s ON s.workspace_id = m.workspace_id AND s.user_id = m.user_id
    WHERE m.workspace_id = ? AND m.state = 'active'`);
  const save =
    db.prepare(`INSERT INTO sync_relay_member_revisions(workspace_id, user_id, signature, revision) VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_id, user_id) DO UPDATE SET signature = excluded.signature, revision = excluded.revision`);
  for (const workspaceId of workspaces) {
    const crossed = crossedByWorkspace.get(workspaceId) ?? [];
    for (const m of members.all(workspaceId)) {
      if ((m.role !== "admin" && m.role !== "member") || !isShareAccessValue(m.member_level)) continue;
      const reach = memberReach(db, workspaceId, String(m.user_id), m.role, m.member_level, rulesOf(workspaceId));
      const signature = reach.signature();
      const moved = crossed.some(({ before, after }) => reach.levelAt(before) !== reach.levelAt(after));
      if (m.signature === signature && !moved) continue;
      save.run(workspaceId, m.user_id, signature, randomUUID());
    }
  }
  db.exec("DELETE FROM temp.member_reach_dirty");
  db.exec("DELETE FROM temp.member_reach_moves");
}
