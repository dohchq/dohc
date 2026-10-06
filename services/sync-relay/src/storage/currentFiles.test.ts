import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { filterOpForShare } from "../shareFilter";
import { applyCurrentFileOp, currentFileStateQuery, currentFileStatements } from "./currentFiles";
import { initializeSyncRelaySchema } from "./schema";
import type { SqliteDb } from "./types";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

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
