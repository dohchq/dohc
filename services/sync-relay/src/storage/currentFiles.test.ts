import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { filterOpForShare } from "../shareFilter";
import { applyCurrentFileOp, currentFileStateQuery, currentFileStatements, initializeCurrentFileKeySchema } from "./currentFiles";
import { initializeSyncRelaySchema } from "./schema";
import type { SqliteDb } from "./types";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

it("maintains and backfills record identities across edits, deletes, and a UTF-8 prefix boundary", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const storageDb = db as unknown as SqliteDb;
    initializeSyncRelaySchema(storageDb);
    db.prepare("INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms) VALUES (?,?,?)").run("ws", "owner", 1);
    const statements = currentFileStatements(storageDb);
    const schemaRow = db.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES(?,?,?,?,?,?)")
      .run("ws", "schema", 0, "moment.append", "{}", 0);
    db.prepare("INSERT INTO sync_relay_current_files(workspace_id,version_id,path,blob_sha256,content_kind,state_relay_seq) VALUES(?,?,?,?,?,?)")
      .run("ws", "main", "Tasks/collection.yaml", "f".repeat(64), "text", Number(schemaRow.lastInsertRowid));
    let sequence = 0;
    const put = (id: string) => {
      const text = Buffer.from(`---\nid: ${id}\n---\n` + "é".repeat(40_000));
      const hash = (++sequence).toString().repeat(64);
      db.prepare("INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES (?,?,?,?)").run("ws", hash, text.length, text);
      const payload = JSON.stringify({ objectId: "record", momentId: `m${sequence}`, versionId: "main", operation: "write",
        path: "Tasks/One.md", payloadBeforePath: sequence > 1 ? "Tasks/One.md" : null,
        payloadBeforeBlobSha256: sequence > 1 ? (sequence - 1).toString().repeat(64) : null,
        payloadAfterPath: "Tasks/One.md", payloadAfterBlobSha256: hash, payloadAfterContentKind: "text" });
      const row = db.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES (?,?,?,?,?,?)")
        .run("ws", "owner", sequence, "moment.append", payload, sequence);
      applyCurrentFileOp(statements, "ws", "moment.append", payload, Number(row.lastInsertRowid));
    };
    const ids = () => db.prepare("SELECT record_id FROM sync_relay_current_record_ids").all();
    put("rec_aaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(ids()).toEqual([{ record_id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa" }]);
    put("rec_bbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(ids()).toEqual([{ record_id: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb" }]);
    db.exec("DELETE FROM sync_relay_current_record_ids; DELETE FROM sync_relay_migrations WHERE migration_id='current-record-identities-v1'");
    initializeCurrentFileKeySchema(storageDb);
    expect(ids()).toEqual([{ record_id: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb" }]);
    applyCurrentFileOp(statements, "ws", "moment.append", JSON.stringify({ objectId: "record", versionId: "main",
      operation: "delete", path: "Tasks/One.md", payloadBeforePath: "Tasks/One.md", payloadBeforeBlobSha256: "2".repeat(64) }), 3);
    expect(ids()).toEqual([]);
  } finally { db.close(); }
});

it("discovers a retained document from its enrolled file artifact and admits it to named-share replay", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const storageDb = db as unknown as SqliteDb;
    initializeSyncRelaySchema(storageDb);
    db.prepare("INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms) VALUES (?,?,?)")
      .run("workspace", "owner", 1);
    const statements = currentFileStatements(storageDb);
    const append = (opKind: string, payload: string, sequence: number) => {
      const row = db.prepare(
        "INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES (?,?,?,?,?,?)",
      ).run("workspace", "owner-origin", sequence, opKind, payload, sequence);
      applyCurrentFileOp(statements, "workspace", opKind, payload, Number(row.lastInsertRowid));
    };
    const selector = { paths: ["trip"], versionId: null, access: "edit" as const };
    const base = JSON.stringify({ versionId: "main", objectId: "record-object", path: "trip/Tasks/first.md",
      contentKind: "richdoc", isBaseState: true, lineageClaimId: "a".repeat(64), updateBlobSha256: "a".repeat(64) });
    append("ydoc.update", base, 0);
    const query = currentFileStateQuery(selector.paths);
    const current = () => db.prepare(query.sql).all("workspace", "main", 0, 100, ...query.selectorParams, 10);
    expect(current()).toEqual([]);
    expect(filterOpForShare(selector, "ydoc.update", base).allowed).toBe(false);

    const artifact = JSON.stringify({ momentId: "captured-head", versionId: "main", objectId: "record-object",
      operation: "write", path: "trip/Tasks/first.md", payloadBeforePath: null, payloadBeforeBlobSha256: null,
      payloadAfterPath: "trip/Tasks/first.md", payloadAfterBlobSha256: "b".repeat(64), payloadAfterContentKind: "text" });
    append("moment.append", artifact, 1);
    expect(current()).toEqual([{ path: "trip/Tasks/first.md", blob_sha256: "b".repeat(64), content_kind: "text" }]);
    expect(filterOpForShare(selector, "moment.append", artifact).allowed).toBe(true);
  } finally { db.close(); }
});
