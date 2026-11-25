import {
  formatAccessRule,
  parseAccessRule,
  type AccessRule,
} from "@dohc/security-contract/access-rules";
import { isWorkspaceGroup } from "@dohc/security-contract/chat-wire-ids";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import type { StorageContext } from "./context";
import { findChannelCreateKind } from "./objectIndex";
import type { SqliteDb } from "./types";
import { workspaceRoleOf } from "./workspaceMembers";

// A Group's rule (docs/engineering/plans/workspace-members.md, piece 4): one
// level for every member, kept by the relay beside the member level and
// roles. The text is a folder rule's text, so person entries can come later
// with no migration; today the action writes only `members`.
//
// `rule_text` is the active rule, or null once it is cleared. A row is never
// deleted while its workspace exists, so `created_rule_text`, the rule the
// Group was created with, outlives the rule: a member's visibility signature
// compares against it.

const V1_MARKER = "workspace-group-rules-v1";
const MARKER = "workspace-group-rules-v2";
const GROUP_RULES = "sync_relay_group_rules";
const groupRulesSql = (changedBy: string) => `CREATE TABLE ${GROUP_RULES} (
  workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  channel_wire_id TEXT NOT NULL CHECK (length(channel_wire_id) BETWEEN 1 AND 256),
  rule_text TEXT,
  created_rule_text TEXT,
  changed_by_user_id ${changedBy},
  changed_at_ms INTEGER NOT NULL CHECK (changed_at_ms >= 0),
  PRIMARY KEY (workspace_id, channel_wire_id)
) STRICT`;
const V1_SQL = groupRulesSql("TEXT NOT NULL");
const GROUP_RULES_SQL = groupRulesSql("TEXT");

const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

export function initializeGroupRuleSchema(db: SqliteDb): void {
  const assert = (expected: string) => {
    const row = db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(GROUP_RULES);
    if (typeof row?.sql !== "string" || normalize(row.sql) !== normalize(expected)) {
      throw new Error("group rule schema is missing or damaged");
    }
  };
  const marked = (marker: string) =>
    db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(marker) !==
    undefined;
  if (marked(MARKER)) return assert(GROUP_RULES_SQL);
  if (marked(V1_MARKER)) {
    assert(V1_SQL);
    db.exec(`ALTER TABLE ${GROUP_RULES} RENAME TO ${GROUP_RULES}_v1;
      ${GROUP_RULES_SQL};
      INSERT INTO ${GROUP_RULES} SELECT * FROM ${GROUP_RULES}_v1;
      DROP TABLE ${GROUP_RULES}_v1;`);
  } else if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(GROUP_RULES)) {
    throw new Error("unmarked group rule schema already exists");
  } else {
    db.exec(GROUP_RULES_SQL);
  }
  assert(GROUP_RULES_SQL);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(
    MARKER,
    Date.now(),
  );
}

/** A Group's level for every member, or null for "No access". */
export type GroupMembersLevel = ShareAccess | null;

/** One Group's row. A rule that can't be read hides the Group, as a folder's does. */
export interface GroupRuleRow {
  channelWireId: string;
  /** The active rule; undefined when it was cleared. */
  rule: AccessRule | null | undefined;
  /** The rule the Group was created with; undefined when it had none. */
  createdRule: AccessRule | null | undefined;
}

const readRule = (text: unknown) =>
  text === null || text === undefined ? undefined : parseAccessRule(String(text));

/** Every Group rule row in the workspace, cleared ones included, by Group. */
export function readGroupRules(db: SqliteDb, workspaceId: string): Map<string, GroupRuleRow> {
  const rows = db
    .prepare(
      `SELECT channel_wire_id, rule_text, created_rule_text FROM ${GROUP_RULES}
       WHERE workspace_id = ? ORDER BY channel_wire_id`,
    )
    .all(workspaceId);
  return new Map(
    rows.map((row) => {
      const channelWireId = String(row.channel_wire_id);
      return [
        channelWireId,
        {
          channelWireId,
          rule: readRule(row.rule_text),
          createdRule: readRule(row.created_rule_text),
        },
      ];
    }),
  );
}

/** The stored text for a level, as a folder rule stores it. */
export function groupRuleText(level: GroupMembersLevel): string {
  return formatAccessRule({ members: level, people: new Map() })!;
}

/** The level a rule gives every member, or null when it names people or hides the Group. */
export function groupRuleMembersLevel(rule: AccessRule | null): GroupMembersLevel {
  return rule && rule.people.size === 0 ? rule.members : null;
}

/** Writes a new Group's rule inside its create transaction. */
export function insertCreatedGroupRule(
  db: SqliteDb,
  input: {
    workspaceId: string;
    channelWireId: string;
    level: GroupMembersLevel;
    actorUserId: string;
    nowMs: number;
  },
): void {
  const text = groupRuleText(input.level);
  db.prepare(
    `INSERT INTO ${GROUP_RULES} (workspace_id, channel_wire_id, rule_text, created_rule_text,
       changed_by_user_id, changed_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.workspaceId,
    input.channelWireId,
    text,
    text,
    input.actorUserId,
    Math.trunc(input.nowMs),
  );
}

export type SetGroupRuleResult = { ok: true } | { ok: false; reason: "not-found" };

/**
 * Sets or clears a Group's rule, for the owner or an admin. The role is read
 * here, inside the write. Only an ordinary Group takes a rule; any other
 * channel answers not-found, as a missing Group does.
 */
export function setWorkspaceGroupRule(
  storage: StorageContext,
  input: {
    workspaceId: string;
    channelWireId: string;
    actorUserId: string;
    /** The level, or undefined to clear the rule. */
    level: GroupMembersLevel | undefined;
    nowMs: number;
  },
): SetGroupRuleResult {
  return storage.tx((): SetGroupRuleResult => {
    const actor = workspaceRoleOf(storage, input.workspaceId, input.actorUserId);
    if (!actor || actor.role === "member") return { ok: false, reason: "not-found" };
    if (
      !isWorkspaceGroup(
        input.channelWireId,
        findChannelCreateKind(storage, input.workspaceId, input.channelWireId),
      )
    )
      return { ok: false, reason: "not-found" };
    const text = input.level === undefined ? null : groupRuleText(input.level);
    const nowMs = Math.trunc(input.nowMs);
    const held = storage.db
      .prepare(
        `SELECT rule_text FROM ${GROUP_RULES} WHERE workspace_id = ? AND channel_wire_id = ?`,
      )
      .get(input.workspaceId, input.channelWireId);
    if (held && (held.rule_text ?? null) === text) return { ok: true };
    if (!held && text === null) return { ok: true };
    storage.db
      .prepare(
        `INSERT INTO ${GROUP_RULES} (workspace_id, channel_wire_id, rule_text, created_rule_text,
           changed_by_user_id, changed_at_ms) VALUES (?, ?, ?, NULL, ?, ?)
         ON CONFLICT(workspace_id, channel_wire_id) DO UPDATE SET rule_text = excluded.rule_text,
           changed_by_user_id = excluded.changed_by_user_id, changed_at_ms = excluded.changed_at_ms`,
      )
      .run(input.workspaceId, input.channelWireId, text, input.actorUserId, nowMs);
    return { ok: true };
  });
}

/** Each Group's active level, for the owner's and admins' members read. It names hidden Groups. */
export function readWorkspaceGroupRules(
  storage: StorageContext,
  workspaceId: string,
): Array<{ channelWireId: string; level: GroupMembersLevel }> {
  return [...readGroupRules(storage.db, workspaceId).values()].flatMap((row) =>
    row.rule === undefined
      ? []
      : [{ channelWireId: row.channelWireId, level: groupRuleMembersLevel(row.rule) }],
  );
}
