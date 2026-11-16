import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { folderLevel, isAccessRulePath } from "@dohc/security-contract/access-rules";
import { pathCollisionKey as contractCollisionKey } from "@dohc/workspace-contracts/path-floor";
import { pathCollisionKey } from "../pathCollisionKey";
import { currentAccessRuleSet, initializeAccessRuleSchema } from "./accessRules";
import { applyCurrentFileOp, currentFileStatements } from "./currentFiles";
import { initializeSyncRelaySchema } from "./schema";
import type { SqliteDb } from "./types";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

function relay() {
  const db = new DatabaseSync(":memory:");
  const storageDb = db as unknown as SqliteDb;
  initializeSyncRelaySchema(storageDb);
  db.prepare(
    "INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms) VALUES (?,?,?)",
  ).run("ws", "owner", 1);
  const statements = currentFileStatements(storageDb);
  const heads = new Map<string, string>();
  let originSeq = 0;
  const blob = (content: Uint8Array) => {
    const sha = createHash("sha256").update(content).digest("hex");
    db.prepare(
      "INSERT OR IGNORE INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES (?,?,?,?)",
    ).run("ws", sha, content.byteLength, content);
    return sha;
  };
  const append = (opKind: string, payload: Record<string, unknown>) => {
    const json = JSON.stringify(payload);
    const row = db
      .prepare(
        "INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES (?,?,?,?,?,?)",
      )
      .run("ws", "owner", ++originSeq, opKind, json, originSeq);
    applyCurrentFileOp(statements, "ws", opKind, json, Number(row.lastInsertRowid));
    return Number(row.lastInsertRowid);
  };
  const moment = (
    operation: string,
    before: string | null,
    after: string | null,
    sha: string | null,
    contentKind = "text",
  ) =>
    append("moment.append", {
      objectId: `o:${after ?? before}`,
      momentId: `m${originSeq}`,
      versionId: "main",
      operation,
      path: after ?? before,
      payloadBeforePath: before,
      payloadBeforeBlobSha256: before ? heads.get(before) : null,
      payloadAfterPath: after,
      payloadAfterBlobSha256: sha,
      payloadAfterContentKind: contentKind,
    });
  const write = (path: string, content: string | Uint8Array, contentKind = "text") => {
    const sha = blob(typeof content === "string" ? Buffer.from(content) : content);
    const seq = moment("write", heads.has(path) ? path : null, path, sha, contentKind);
    heads.set(path, sha);
    return seq;
  };
  const remove = (path: string) => {
    const seq = moment("delete", path, null, null);
    heads.delete(path);
    return seq;
  };
  const rename = (from: string, to: string) => {
    const sha = heads.get(from)!;
    const seq = moment("rename", from, to, sha);
    heads.delete(from);
    heads.set(to, sha);
    return seq;
  };
  const rows = () =>
    db
      .prepare(
        "SELECT folder, rule_text, from_seq, to_seq FROM sync_relay_access_rules ORDER BY folder, from_seq",
      )
      .all()
      .map((row) => ({ ...row }));
  return { db, storageDb, statements, heads, append, blob, write, remove, rename, rows };
}

describe("the relay's access rule index", () => {
  it("keeps each folder's rule by the span it held for", () => {
    const r = relay();
    try {
      const first = r.write("Drafts/access.yaml", "# Drafts\nmembers: view\n");
      r.write("Drafts/notes.md", "hello");
      const edited = r.write("Drafts/access.yaml", "members: edit\n");
      const unreadable = r.write("Drafts/access.yaml", "members: everyone\n");
      const removed = r.remove("Drafts/access.yaml");
      expect(r.rows()).toEqual([
        { folder: "Drafts", rule_text: "members: view\n", from_seq: first, to_seq: edited },
        { folder: "Drafts", rule_text: "members: edit\n", from_seq: edited, to_seq: unreadable },
        { folder: "Drafts", rule_text: null, from_seq: unreadable, to_seq: removed },
      ]);
    } finally {
      r.db.close();
    }
  });

  it("reads a binary, non-UTF-8 or oversized rule as unreadable", () => {
    const r = relay();
    try {
      r.write("A/access.yaml", "members: view\n", "binary");
      r.write("B/access.yaml", new Uint8Array([0x6d, 0xff, 0x0a]));
      r.write("C/access.yaml", `members: view\n#${"x".repeat(64 * 1024)}\n`);
      expect(r.rows().map((row) => [row.folder, row.rule_text])).toEqual([
        ["A", null],
        ["B", null],
        ["C", null],
      ]);
    } finally {
      r.db.close();
    }
  });

  it("reads two spellings of one rule in a folder as unreadable, and its own folder's rule only", () => {
    const r = relay();
    try {
      r.write("Team/access.yaml", "");
      const twin = r.write("Team/ACCESS.yaml", "members: edit\n");
      // A rule in a folder spelled differently is that folder's own rule.
      r.write("team/access.yaml", "members: edit\n");
      expect(r.rows().filter((row) => row.to_seq === null)).toEqual([
        { folder: "Team", rule_text: null, from_seq: twin, to_seq: null },
        {
          folder: "team",
          rule_text: "members: edit\n",
          from_seq: expect.any(Number),
          to_seq: null,
        },
      ]);
      const back = r.remove("Team/ACCESS.yaml");
      expect(r.rows().filter((row) => row.folder === "Team" && row.to_seq === null)).toEqual([
        { folder: "Team", rule_text: "", from_seq: back, to_seq: null },
      ]);
      // The case twin "team" can't widen the hidden "Team".
      const viewer = {
        role: "member" as const,
        level: "edit" as const,
        verifiedEmail: null,
        unverifiedEmail: null,
      };
      expect(folderLevel(currentAccessRuleSet(r.storageDb, "ws"), viewer, "team")).toBeNull();
    } finally {
      r.db.close();
    }
  });

  it("moves a renamed rule between folders, and keeps nothing for a rename within one op", () => {
    const r = relay();
    try {
      const first = r.write("A/access.yaml", "members: view\n");
      const moved = r.rename("A/access.yaml", "B/access.yaml");
      const respelled = r.rename("B/access.yaml", "B/Access.yaml");
      expect(r.rows()).toEqual([
        { folder: "A", rule_text: "members: view\n", from_seq: first, to_seq: moved },
        { folder: "B", rule_text: "members: view\n", from_seq: moved, to_seq: respelled },
        { folder: "B", rule_text: "members: view\n", from_seq: respelled, to_seq: null },
      ]);
    } finally {
      r.db.close();
    }
  });

  it("keeps main's rules only, at the root too", () => {
    const r = relay();
    try {
      const sha = r.blob(Buffer.from("members: view\n"));
      const root = r.write("access.yaml", "members: view\n");
      r.append("version.create", {
        versionId: "draft",
        forkSnapshots: [
          { path: "access.yaml", blobSha256: sha, contentKind: "text" },
          { path: "Drafts/access.yaml", blobSha256: sha, contentKind: "text" },
        ],
      });
      expect(r.rows()).toEqual([
        { folder: "", rule_text: "members: view\n", from_seq: root, to_seq: null },
      ]);
    } finally {
      r.db.close();
    }
  });

  it("fills the table from rule files written before it existed", () => {
    const r = relay();
    try {
      const seq = r.write("Drafts/access.yaml", "members: comment\n");
      r.write("Drafts/notes.md", "hello");
      r.db.exec(
        "DROP TABLE sync_relay_access_rules; DELETE FROM sync_relay_migrations WHERE migration_id = 'access-rules-v1'",
      );
      initializeAccessRuleSchema(r.storageDb);
      expect(r.rows()).toEqual([
        { folder: "Drafts", rule_text: "members: comment\n", from_seq: seq, to_seq: null },
      ]);
    } finally {
      r.db.close();
    }
  });

  it("writes a rule whose keys need quoting so it reads back as the same rule", () => {
    const r = relay();
    try {
      r.write("Drafts/access.yaml", 'members: edit\npeople:\n  "#sam@example.com": view\n');
      const set = currentAccessRuleSet(r.storageDb, "ws");
      const sam = {
        role: "member",
        level: "edit",
        verifiedEmail: "#sam@example.com",
        unverifiedEmail: null,
      } as const;
      expect(folderLevel(set, sam, "Drafts")).toBe("view");
    } finally {
      r.db.close();
    }
  });

  // The relay's key finds a folder's rule files; the contract's decides what
  // counts as one. They must fold every spelling the same way.
  it.each([
    "access.yaml",
    "ACCESS.YAML",
    "Access.yaml.",
    "ａccess.yaml",
    "Team/ACCESS.yaml",
    "Team/access.yaml~",
  ])("folds %s the same way in the relay and the contract", (path) => {
    expect(pathCollisionKey(path)).toBe(contractCollisionKey(path));
    expect(isAccessRulePath(path)).toBe(path.endsWith("~") ? false : true);
  });
});
