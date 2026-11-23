import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { folderMarkerText, isFolderMarkerPath } from "@dohc/security-contract/access-rules";
import { pathCollisionKey as contractCollisionKey } from "@dohc/workspace-contracts/path-floor";
import { pathCollisionKey } from "../pathCollisionKey";
import { closeTestStorages, moment, testStorage } from "../testing";
import { applyCurrentFileOp, currentFileStatements } from "./currentFiles";
import { initializeSyncRelaySchema } from "./schema";
import type { SqliteDb } from "./types";
import type { StorageContext } from "./context";
import { workspaceUsageBytes } from "./workspaces";

afterAll(closeTestStorages);

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

const R = `fr_${"1".repeat(32)}`;
const S = `fr_${"2".repeat(32)}`;
const VIEW = "members: view\n";
const EDIT = "members: edit\n";

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
  const mark = (folder: string, ruleId: string) =>
    write(`${folder}/.dohc-access`, folderMarkerText(ruleId, 1));
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
  const rule = (ruleId: string, text: string | null) =>
    db
      .prepare(
        "INSERT INTO sync_relay_folder_rules(workspace_id,rule_id,revision,rule_text,changed_at_ms) VALUES ('ws',?,1,?,1)",
      )
      .run(ruleId, text);
  const rows = () =>
    db
      .prepare(
        "SELECT folder, rule_text, from_seq, to_seq FROM sync_relay_access_rules ORDER BY folder, from_seq",
      )
      .all()
      .map((row) => ({ ...row }));
  const bindings = () =>
    db
      .prepare("SELECT rule_id, folder FROM sync_relay_folder_rule_bindings ORDER BY folder")
      .all()
      .map((row) => [row.rule_id, row.folder]);
  return { db, blob, append, write, mark, remove, rename, rule, rows, bindings };
}

describe("the relay's folder rule spans", () => {
  it("binds a folder whose marker names a rule it keeps", () => {
    const r = relay();
    try {
      r.rule(R, VIEW);
      const marked = r.mark("Drafts", R);
      r.write("Drafts/notes.md", "hello");
      expect(r.rows()).toEqual([
        { folder: "Drafts", rule_text: VIEW, from_seq: marked, to_seq: null },
      ]);
      expect(r.bindings()).toEqual([[R, "Drafts"]]);
    } finally {
      r.db.close();
    }
  });

  it("hides a folder whose marker names no rule it keeps, can't be read, or has a twin", () => {
    const r = relay();
    try {
      r.rule(R, VIEW);
      r.mark("A", S);
      r.write("B/.dohc-access", folderMarkerText(R, 1), "binary");
      r.write("C/.dohc-access", new Uint8Array([0x72, 0xff, 0x0a]));
      r.write("D/.dohc-access", `${folderMarkerText(R, 1)}#${"x".repeat(1024)}\n`);
      r.write("E/.dohc-access", VIEW);
      r.mark("F", R);
      r.write("F/.DOHC-ACCESS", folderMarkerText(R, 1));
      expect(r.rows().map((row) => [row.folder, row.rule_text, row.to_seq])).toEqual([
        ["A", null, null],
        ["B", null, null],
        ["C", null, null],
        ["D", null, null],
        ["E", null, null],
        ["F", VIEW, expect.any(Number)],
        ["F", null, null],
      ]);
      const back = r.remove("F/.DOHC-ACCESS");
      expect(r.rows().filter((row) => row.to_seq === null && row.folder === "F")).toEqual([
        { folder: "F", rule_text: VIEW, from_seq: back, to_seq: null },
      ]);
    } finally {
      r.db.close();
    }
  });

  it("adds nothing for a marker naming a cleared rule", () => {
    const r = relay();
    try {
      r.rule(R, null);
      r.mark("Drafts", R);
      expect(r.rows()).toEqual([]);
      expect(r.bindings()).toEqual([]);
    } finally {
      r.db.close();
    }
  });

  it("hides a folder two rules cover, and never unbinds one for an edited marker", () => {
    const r = relay();
    try {
      r.rule(R, VIEW);
      r.rule(S, EDIT);
      const first = r.mark("Team", R);
      const edited = r.write("Team/.dohc-access", folderMarkerText(S, 1));
      expect(r.rows()).toEqual([
        { folder: "Team", rule_text: VIEW, from_seq: first, to_seq: edited },
        { folder: "Team", rule_text: null, from_seq: edited, to_seq: null },
      ]);
      expect(r.bindings()).toEqual([
        [R, "Team"],
        [S, "Team"],
      ]);
    } finally {
      r.db.close();
    }
  });

  it("follows a moved folder, and releases the old path once its last file has left", () => {
    const r = relay();
    try {
      r.rule(R, VIEW);
      const first = r.mark("A", R);
      r.write("A/x.md", "x");
      // The owner's computer sends the new marker first and the old one's delete last.
      const moved = r.mark("B", R);
      r.rename("A/x.md", "B/x.md");
      const gone = r.remove("A/.dohc-access");
      expect(r.rows()).toEqual([
        { folder: "A", rule_text: VIEW, from_seq: first, to_seq: gone },
        { folder: "B", rule_text: VIEW, from_seq: moved, to_seq: null },
      ]);
      expect(r.bindings()).toEqual([[R, "B"]]);
    } finally {
      r.db.close();
    }
  });

  it("releases the old path when a move renames the marker before the folder's other files", () => {
    const r = relay();
    try {
      r.rule(R, VIEW);
      const first = r.mark("A", R);
      r.write("A/x.md", "x");
      r.write("A/sub/y.md", "y");
      const moved = r.rename("A/.dohc-access", "B/.dohc-access");
      r.rename("A/x.md", "B/x.md");
      expect(r.bindings()).toEqual([
        [R, "A"],
        [R, "B"],
      ]);
      const last = r.rename("A/sub/y.md", "B/sub/y.md");
      expect(r.rows()).toEqual([
        { folder: "A", rule_text: VIEW, from_seq: first, to_seq: last },
        { folder: "B", rule_text: VIEW, from_seq: moved, to_seq: null },
      ]);
      expect(r.bindings()).toEqual([[R, "B"]]);
    } finally {
      r.db.close();
    }
  });

  it("keeps a copied folder's rule on both paths, and a path ruled while a file is left in it", () => {
    const r = relay();
    try {
      r.rule(R, VIEW);
      r.mark("A", R);
      r.write("A/x.md", "x");
      r.mark("B", R);
      r.write("B/x.md", "x");
      expect(r.bindings()).toEqual([
        [R, "A"],
        [R, "B"],
      ]);
      // A marker deleted before its folder's files keeps the folder ruled.
      r.remove("A/.dohc-access");
      expect(r.bindings()).toEqual([
        [R, "A"],
        [R, "B"],
      ]);
      expect(
        r
          .rows()
          .filter((row) => row.to_seq === null)
          .map((row) => row.folder),
      ).toEqual(["A", "B"]);
    } finally {
      r.db.close();
    }
  });

  it("keeps a deleted folder's rule when no other folder holds its marker", () => {
    const r = relay();
    try {
      r.rule(R, VIEW);
      const first = r.mark("A", R);
      r.write("A/x.md", "x");
      r.remove("A/x.md");
      r.remove("A/.dohc-access");
      expect(r.rows()).toEqual([{ folder: "A", rule_text: VIEW, from_seq: first, to_seq: null }]);
      expect(r.bindings()).toEqual([[R, "A"]]);
    } finally {
      r.db.close();
    }
  });

  it("reads markers in main only, at the root too", () => {
    const r = relay();
    try {
      r.rule(R, VIEW);
      const sha = r.blob(Buffer.from(folderMarkerText(R, 1)));
      const root = r.write(".dohc-access", folderMarkerText(R, 1));
      r.append("version.create", {
        versionId: "draft",
        forkSnapshots: [
          { path: ".dohc-access", blobSha256: sha, contentKind: "text" },
          { path: "Drafts/.dohc-access", blobSha256: sha, contentKind: "text" },
        ],
      });
      expect(r.rows()).toEqual([{ folder: "", rule_text: VIEW, from_seq: root, to_seq: null }]);
    } finally {
      r.db.close();
    }
  });

  it("charges the workspace for each rule, binding and span it keeps", () => {
    const r = relay();
    try {
      const usage = () =>
        Number(
          r.db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage").get()!.usage_bytes,
        );
      const start = usage();
      r.rule(R, VIEW);
      expect(usage() - start).toBe(VIEW.length);
      r.db
        .prepare("UPDATE sync_relay_folder_rules SET rule_text = ? WHERE rule_id = ?")
        .run(null, R);
      expect(usage()).toBe(start);
      r.db
        .prepare("UPDATE sync_relay_folder_rules SET rule_text = ? WHERE rule_id = ?")
        .run(EDIT, R);
      r.mark("Team", R);
      const markerRow = usage();
      r.db.exec(
        "DELETE FROM sync_relay_access_rules; DELETE FROM sync_relay_folder_rule_bindings; DELETE FROM sync_relay_folder_rules",
      );
      expect(markerRow - usage()).toBe(2 * "Team".length + 2 * EDIT.length);
    } finally {
      r.db.close();
    }
  });

  // The relay's key finds a folder's markers; the contract's decides what
  // counts as one. They must fold every spelling the same way.
  it.each([".dohc-access", ".DOHC-ACCESS", "Team/.Dohc-Access", "Team/.dohc-access~"])(
    "folds %s the same way in the relay and the contract",
    (path) => {
      expect(pathCollisionKey(path)).toBe(contractCollisionKey(path));
      expect(isFolderMarkerPath(path)).toBe(!path.endsWith("~"));
    },
  );
});

// The log's quota check counts the log row before the span and binding exist,
// so the batch checks again once applied.
it("refuses a marker write whose span would take the workspace over its quota", async () => {
  const storage = await testStorage(),
    context = storage as unknown as StorageContext;
  expect(storage.claimWorkspace({ workspaceId: "ws", ownerUserId: "owner", createdAtMs: 1 })).toBe(
    "created",
  );
  context.db
    .prepare(
      "INSERT INTO sync_relay_folder_rules(workspace_id,rule_id,revision,rule_text,changed_at_ms) VALUES ('ws',?,1,?,1)",
    )
    .run(R, VIEW);
  const text = folderMarkerText(R, 1);
  storage.putBlob({
    workspaceId: "ws",
    sha256: createHash("sha256").update(text).digest("hex"),
    content: Buffer.from(text),
    createdAtMs: 1,
  });
  const op = moment("Team/.dohc-access", text, { payload: { payloadAfterContentKind: "text" } });
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
  // Room for the log row, not for the span and binding it adds.
  context.options.workspaceQuotaBytes = before + Buffer.byteLength(payloadJson);
  expect(append).toThrow(/quota exceeded/);
  expect(workspaceUsageBytes(context, "ws")).toBe(before);
  expect(context.db.prepare("SELECT COUNT(*) AS n FROM sync_relay_access_rules").get()!.n).toBe(0);
  context.options.workspaceQuotaBytes += 2 * "Team".length + VIEW.length;
  append();
  expect(context.db.prepare("SELECT folder, rule_text FROM sync_relay_access_rules").all()).toEqual(
    [{ folder: "Team", rule_text: VIEW }],
  );
  expect(workspaceUsageBytes(context, "ws")).toBe(context.options.workspaceQuotaBytes);
});
