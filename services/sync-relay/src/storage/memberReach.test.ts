import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { accessRuleSet, parseAccessRule } from "@dohc/security-contract/access-rules";
import { refreshAccountEmail, retireRuleEmail } from "./accountEmails";
import { groupRuleText, insertCreatedGroupRule } from "./groupRules";
import { memberReach } from "./memberReach";
import { initializeSyncRelaySchema } from "./schema";
import type { SqliteDb } from "./types";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

const TEAM = "channel_team";
const NEWS = "channel_news";

function relay() {
  const db = new DatabaseSync(":memory:");
  const storageDb = db as unknown as SqliteDb;
  initializeSyncRelaySchema(storageDb);
  db.prepare(
    "INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms) VALUES (?,?,?)",
  ).run("ws", "owner", 1);
  // What the rule action writes, with no channel log behind it.
  const setRule = (channelWireId: string, level: "comment" | "view" | null | undefined) =>
    db
      .prepare(
        `INSERT INTO sync_relay_group_rules (workspace_id, channel_wire_id, rule_text, created_rule_text,
           changed_by_user_id, changed_at_ms) VALUES ('ws', ?, ?, NULL, 'owner', 1)
         ON CONFLICT(workspace_id, channel_wire_id) DO UPDATE SET rule_text = excluded.rule_text`,
      )
      .run(channelWireId, level === undefined ? null : groupRuleText(level));
  const reach = (
    role: "admin" | "member" = "member",
    level: "view" | "comment" | "edit" = "comment",
  ) => memberReach(storageDb, "ws", "ana", role, level);
  return { db, storageDb, setRule, reach };
}

describe("a Group's rule in a member's reach", () => {
  it("gives the rule's level, Edit to an admin, and null for No access", () => {
    const r = relay();
    try {
      expect(r.reach().groupLevel(TEAM)).toBe("comment");
      r.setRule(TEAM, "view");
      expect(r.reach().groupLevel(TEAM)).toBe("view");
      expect(r.reach().groupLevel(NEWS)).toBe("comment");
      expect(r.reach("member", "edit").groupLevel(TEAM)).toBe("view");
      expect(r.reach("admin", "edit").groupLevel(TEAM)).toBe("edit");
      r.setRule(TEAM, null);
      expect(r.reach().groupLevel(TEAM)).toBeNull();
      expect(r.reach("admin", "edit").groupLevel(TEAM)).toBe("edit");
      expect(r.reach().hasGroupLevel("comment")).toBe(true);
      // A cleared rule leaves the member level.
      r.setRule(TEAM, undefined);
      expect(r.reach().groupLevel(TEAM)).toBe("comment");
    } finally {
      r.db.close();
    }
  });

  it("changes the signature and the evaluated reach on a level change, so every reader of either sees it", () => {
    const r = relay();
    try {
      r.setRule(TEAM, "comment");
      const before = r.reach();
      expect(before.evaluated.groups).toEqual([[TEAM, "comment"]]);
      r.setRule(TEAM, "view");
      const after = r.reach();
      expect(after.evaluated.groups).toEqual([[TEAM, "view"]]);
      expect(after.signature()).not.toBe(before.signature());
      // The Notice reach digest and a serialized selector both hold `evaluated`.
      expect(JSON.stringify(after.evaluated)).not.toBe(JSON.stringify(before.evaluated));
      // A level change keeps what the member reaches.
      expect(after.visibilitySignature()).toBe(before.visibilitySignature());
      expect(after.listed("key").groups).toEqual([{ channelWireId: TEAM, level: "view" }]);
      expect(after.listed("key").groupDefault).toBe("comment");
    } finally {
      r.db.close();
    }
  });

  it("changes the signature when the member level moves the Groups no rule names", () => {
    const r = relay();
    try {
      // The root rule sets every folder's level, so only the Groups follow the member level.
      const rules = accessRuleSet([["", parseAccessRule("members: view\n")]]);
      const at = (level: "comment" | "edit") =>
        memberReach(r.storageDb, "ws", "ana", "member", level, rules);
      expect(at("edit").groupLevel(TEAM)).toBe("edit");
      expect(at("edit").levelAt("Plan.md")).toBe(at("comment").levelAt("Plan.md"));
      expect(at("edit").signature()).not.toBe(at("comment").signature());
    } finally {
      r.db.close();
    }
  });

  it("changes the visibility signature on hiding a visible Group and on showing one created hidden, and not on creating one hidden", () => {
    const r = relay();
    try {
      const start = r.reach().visibilitySignature();
      insertCreatedGroupRule(r.storageDb, {
        workspaceId: "ws",
        channelWireId: NEWS,
        level: null,
        actorUserId: "owner",
        nowMs: 1,
      });
      expect(r.reach().groupLevel(NEWS)).toBeNull();
      expect(r.reach().visibilitySignature(), "creating a hidden Group").toBe(start);
      // Showing it, by a level or by clearing the rule, rebuilds the copy once.
      r.setRule(NEWS, "view");
      const shown = r.reach().visibilitySignature();
      expect(shown, "showing a Group created hidden").not.toBe(start);
      r.setRule(NEWS, undefined);
      expect(r.reach().visibilitySignature(), "clearing keeps it shown").toBe(shown);
      expect(r.reach().listed("key").groups, "a hidden Group is never listed").toEqual([]);

      const visible = r.reach().visibilitySignature();
      const admin = r.reach("admin", "edit").visibilitySignature();
      r.setRule(TEAM, null);
      expect(r.reach().visibilitySignature(), "hiding a visible Group").not.toBe(visible);
      expect(JSON.stringify(r.reach().listed("key"))).not.toContain(TEAM);
      // An admin reaches every Group whatever the rules.
      expect(r.reach("admin", "edit").visibilitySignature()).toBe(admin);
    } finally {
      r.db.close();
    }
  });
});

describe("a person entry naming a deleted account's address", () => {
  it("hides each folder and Group whose rule names it from a later account there, and leaves other rules", () => {
    const r = relay();
    try {
      const SAM = "sam@example.com";
      const rule = (channelWireId: string, text: string) =>
        r.db
          .prepare(
            `INSERT INTO sync_relay_group_rules (workspace_id, channel_wire_id, rule_text, created_rule_text,
               changed_by_user_id, changed_at_ms) VALUES ('ws', ?, ?, NULL, 'owner', 1)`,
          )
          .run(channelWireId, text);
      rule(TEAM, `members: view\npeople:\n  ${SAM}: edit\n`);
      rule(NEWS, `members: edit\npeople:\n  ${SAM}: view\n`);
      rule("channel_other", "members: view\npeople:\n  ben@example.com: edit\n");
      const rules = accessRuleSet([
        ["up", parseAccessRule(`members: view\npeople:\n  ${SAM}: edit\n`)],
        ["down", parseAccessRule(`members: edit\npeople:\n  ${SAM}: view\n`)],
        ["other", parseAccessRule("members: view\npeople:\n  ben@example.com: edit\n")],
      ]);
      refreshAccountEmail(r.storageDb, "ana", { verifiedEmail: "Sam@Example.com" }, 1);
      const levels = () => {
        const reach = memberReach(r.storageDb, "ws", "ana", "member", "comment", rules);
        return [
          ...["up", "down", "other"].map((folder) => reach.folderLevel(folder)),
          ...[TEAM, NEWS, "channel_other"].map((id) => reach.groupLevel(id)),
        ];
      };
      expect(levels()).toEqual(["edit", "view", "view", "edit", "view", "view"]);
      retireRuleEmail(r.storageDb, SAM);
      expect(levels()).toEqual([null, null, "view", null, null, "view"]);
      expect(
        memberReach(r.storageDb, "ws", "ana", "admin", "edit", rules).folderLevel("down"),
      ).toBe("edit");
    } finally {
      r.db.close();
    }
  });
});
