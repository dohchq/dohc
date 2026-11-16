import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { folderLevel, isAccessRulePath } from "@dohc/security-contract/access-rules";
import { pathCollisionKey as contractCollisionKey } from "@dohc/workspace-contracts/path-floor";
import { pathCollisionKey } from "../pathCollisionKey";
import { closeTestStorages, moment, testStorage } from "../testing";
import { currentAccessRuleSet, initializeAccessRuleSchema } from "./accessRules";
import {
  applyCurrentFileOp,
  currentFileStatements,
  objectMomentFromMomentPayload,
  OBJECT_MOMENT_INSERT_SQL,
} from "./currentFiles";
import { initializeSyncRelaySchema } from "./schema";
import type { SqliteDb } from "./types";
import type { StorageContext } from "./context";
import { workspaceUsageBytes } from "./workspaces";
import { memberReach } from "./memberReach";
import { refreshAccountEmail } from "./accountEmails";
import { filterOpForShare } from "../shareFilter";

afterAll(closeTestStorages);

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
    payload = { recordedAtMs: originSeq + 1, ...payload };
    const json = JSON.stringify(payload);
    const row = db
      .prepare(
        "INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES (?,?,?,?,?,?)",
      )
      .run("ws", "owner", ++originSeq, opKind, json, originSeq);
    applyCurrentFileOp(statements, "ws", opKind, json, Number(row.lastInsertRowid));
    const m = opKind === "moment.append" ? objectMomentFromMomentPayload(json) : null;
    if (m)
      db.prepare(OBJECT_MOMENT_INSERT_SQL).run(
        "ws",
        m.objectId,
        Number(row.lastInsertRowid),
        m.momentId,
        m.versionId,
        m.path,
        m.blobSha256,
        m.contentKind,
        m.byteLength,
        m.recordedAtMs,
      );
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
  it("fails closed on unknown identity and matches a person entry only through a verified email", () => {
    const r = relay();
    try {
      r.write("People/access.yaml", "members: edit\npeople:\n  sam@example.com: view\n");
      const reach = () => memberReach(r.storageDb, "ws", "sam", "member", "comment");
      expect(reach().levelAt("People/note.md")).toBeNull();
      expect(reach().levelAt("Public/note.md")).toBe("comment");
      refreshAccountEmail(r.storageDb, "sam", { verifiedEmail: "sam@example.com" }, 1);
      expect(reach().levelAt("People/note.md")).toBe("view");
      // An unverified address that an entry names lowers nothing (decision 17A).
      refreshAccountEmail(r.storageDb, "sam", { verifiedEmail: null }, 2);
      expect(reach().levelAt("People/note.md")).toBe("edit");
      expect(
        memberReach(r.storageDb, "ws", "admin", "admin", "view").levelAt("People/access.yaml"),
      ).toBe("edit");
    } finally {
      r.db.close();
    }
  });

  it("keeps deleted objects hidden if hidden at deletion", () => {
    const r = relay();
    try {
      r.write("Hidden/access.yaml", "");
      r.write("Hidden/note.md", "secret");
      r.remove("Hidden/note.md");
      r.remove("Hidden/access.yaml");
      r.write("Public/note.md", "hello");
      r.remove("Public/note.md");
      const reach = () => memberReach(r.storageDb, "ws", "sam", "member", "edit");
      expect(reach().objectVisible("o:Hidden/note.md")).toBe(false);
      expect(reach().objectVisible("o:Public/note.md")).toBe(true);
    } finally {
      r.db.close();
    }
  });

  it("serves boundary renames as content-free departures or visible arrivals and withholds hidden object history", () => {
    const r = relay();
    try {
      r.write("Hidden/access.yaml", "");
      const sha = r.blob(Buffer.from("content"));
      const write = {
        objectId: "moving",
        momentId: "create",
        versionId: "main",
        operation: "write",
        path: "Public/note.md",
        payloadAfterPath: "Public/note.md",
        payloadAfterBlobSha256: sha,
      };
      r.append("moment.append", write);
      const move = {
        ...write,
        momentId: "move",
        operation: "rename",
        path: "Hidden/note.md",
        payloadBeforePath: "Public/note.md",
        payloadBeforeBlobSha256: sha,
        payloadAfterPath: "Hidden/note.md",
      };
      r.append("moment.append", move);
      const selector = () => ({
        kind: "workspace" as const,
        role: "member" as const,
        reach: memberReach(r.storageDb, "ws", "sam", "member", "edit"),
      });
      expect(filterOpForShare(selector(), "moment.append", JSON.stringify(write))).toEqual({
        allowed: false,
      });
      const departure = filterOpForShare(selector(), "moment.append", JSON.stringify(move));
      expect(departure).toMatchObject({
        allowed: true,
        payload: { operation: "delete", path: "Public/note.md" },
        blobSha256s: [],
      });
      expect(JSON.stringify(departure)).not.toContain("Hidden");
      expect(JSON.stringify(departure)).not.toContain(sha);
      const arrival = {
        ...move,
        momentId: "return",
        path: "Public/returned.md",
        payloadBeforePath: "Hidden/note.md",
        payloadAfterPath: "Public/returned.md",
      };
      r.append("moment.append", arrival);
      const served = filterOpForShare(selector(), "moment.append", JSON.stringify(arrival));
      expect(served).toMatchObject({
        allowed: true,
        payload: { operation: "write", path: "Public/returned.md" },
        blobSha256s: [sha],
      });
      expect(JSON.stringify(served)).not.toContain("Hidden");
    } finally {
      r.db.close();
    }
  });

  it("signs evaluated reach for rules, identity, level and role, but not ordinary writes", () => {
    const r = relay();
    try {
      const revision = (role: "member" | "admin" = "member", level: "edit" | "view" = "edit") =>
        memberReach(r.storageDb, "ws", "sam", role, level).signature();
      const first = revision();
      r.write("Public/note.md", "hello");
      expect(revision()).toBe(first);
      r.write("Private/access.yaml", "people:\n  sam@example.com: edit\n");
      const hidden = revision();
      expect(hidden).not.toBe(first);
      refreshAccountEmail(r.storageDb, "sam", { verifiedEmail: "sam@example.com" }, 1);
      expect(revision()).not.toBe(hidden);
      expect(revision("member", "view")).not.toBe(revision());
      expect(revision("admin")).not.toBe(revision());
    } finally {
      r.db.close();
    }
  });
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
      const viewer = { role: "member" as const, level: "edit" as const, verifiedEmail: null };
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
      const twin = r.write("B/ACCESS.yaml", "members: edit\n");
      // Between its delete and its put, the respell leaves one readable rule
      // for a moment that no reader saw.
      const respelled = r.rename("B/ACCESS.yaml", "B/Access.yaml");
      expect(r.rows()).toEqual([
        { folder: "A", rule_text: "members: view\n", from_seq: first, to_seq: moved },
        { folder: "B", rule_text: "members: view\n", from_seq: moved, to_seq: twin },
        { folder: "B", rule_text: null, from_seq: twin, to_seq: respelled },
        { folder: "B", rule_text: null, from_seq: respelled, to_seq: null },
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
      expect(
        r.db
          .prepare(
            "SELECT path FROM sync_relay_current_files WHERE version_id = 'draft' ORDER BY path",
          )
          .all()
          .map((row) => row.path),
      ).toEqual(["Drafts/access.yaml", "access.yaml"]);
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

  it("charges the workspace for each rule row it keeps", () => {
    const r = relay();
    try {
      const usage = () =>
        Number(
          r.db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage").get()!.usage_bytes,
        );
      const start = usage();
      r.db
        .prepare("INSERT INTO sync_relay_access_rules VALUES ('ws', 'Team', ?, 1, NULL)")
        .run("members: view\n");
      r.db
        .prepare("INSERT INTO sync_relay_access_rules VALUES ('ws', 'Team', NULL, 2, NULL)")
        .run();
      expect(usage() - start).toBe(2 * "Team".length + "members: view\n".length);
      r.write("Drafts/access.yaml", "members: view\n");
      r.write("Drafts/access.yaml", "members: edit\n");
      const kept = usage();
      r.db.exec("DELETE FROM sync_relay_access_rules");
      expect(kept - usage()).toBe(
        2 * "Team".length +
          2 * "Drafts".length +
          "members: view\n".length * 2 +
          "members: edit\n".length,
      );
    } finally {
      r.db.close();
    }
  });

  it("writes a rule whose keys need quoting so it reads back as the same rule", () => {
    const r = relay();
    try {
      r.write("Drafts/access.yaml", 'members: edit\npeople:\n  "#sam@example.com": view\n');
      const set = currentAccessRuleSet(r.storageDb, "ws");
      const sam = { role: "member", level: "edit", verifiedEmail: "#sam@example.com" } as const;
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

// The log's quota check counts the log row before the rule row exists, so the
// batch checks again once applied.
it("refuses a rule write whose rule row would take the workspace over its quota", async () => {
  const storage = await testStorage(),
    context = storage as unknown as StorageContext;
  expect(storage.claimWorkspace({ workspaceId: "ws", ownerUserId: "owner", createdAtMs: 1 })).toBe(
    "created",
  );
  const text = "members: view\n";
  storage.putBlob({
    workspaceId: "ws",
    sha256: createHash("sha256").update(text).digest("hex"),
    content: Buffer.from(text),
    createdAtMs: 1,
  });
  const op = moment("Team/access.yaml", text, { payload: { payloadAfterContentKind: "text" } });
  const payloadJson = JSON.stringify(op.payload);
  const append = () =>
    storage.appendLogBatch({
      workspaceId: "ws",
      originId: "device",
      ops: [
        { originSeq: op.originSeq, opKind: op.opKind, payloadJson, recordedAtMs: op.recordedAtMs },
      ],
    });
  const before = workspaceUsageBytes(context, "ws");
  // Room for the log row, not for the rule row it adds.
  context.options.workspaceQuotaBytes = before + Buffer.byteLength(payloadJson);
  expect(append).toThrow(/quota exceeded/);
  expect(workspaceUsageBytes(context, "ws")).toBe(before);
  expect(context.db.prepare("SELECT COUNT(*) AS n FROM sync_relay_access_rules").get()!.n).toBe(0);
  context.options.workspaceQuotaBytes += "Team".length + text.length;
  append();
  expect(context.db.prepare("SELECT folder, rule_text FROM sync_relay_access_rules").all()).toEqual(
    [{ folder: "Team", rule_text: text }],
  );
  expect(workspaceUsageBytes(context, "ws")).toBe(context.options.workspaceQuotaBytes);
});
