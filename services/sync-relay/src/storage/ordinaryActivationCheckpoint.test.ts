import { createHash } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { closeTestStorages, moment, testStorage } from "../testing";
import type { StorageContext } from "./context";
import type { SettlementAdmission } from "./hostedSettlement";

afterAll(closeTestStorages);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const CHARGE = 700;

async function relay() {
  const storage = await testStorage();
  const context = storage as unknown as StorageContext;
  expect(
    storage.claimWorkspace({ workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1 }),
  ).toBe("created");
  context.db
    .prepare(
      "INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','typist',0,'ydoc.update','{}',0)",
    )
    .run();
  const usage = () =>
    Number(
      context.db
        .prepare(
          "SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'",
        )
        .get()!.usage_bytes,
    );
  const stored = (objectId: string) =>
    context.tx(() => {
      context.db
        .prepare(
          `INSERT INTO sync_relay_ordinary_checkpoints(workspace_id,main_version_id,object_id,lineage_claim_id,
            relay_database_namespace,replication_epoch,stream_identity,base_relay_seq,base_origin_id,base_origin_seq,
            through_relay_seq,folded_entries,state_bytes,state_sha256,current_path,projected_sha256,
            projected_byte_length,tail_json,moments_json,moments_from_seq,policy_sha256,accounted_bytes,folded_at_ms)
          VALUES ('workspace','main',?,?,'relay','epoch','stream',1,'typist',0,1,1,x'00',?,'notes/a.md',?,0,'[]','[]',1,?,?,0)`,
        )
        .run(objectId, sha256("base"), sha256("state"), sha256(""), sha256("policy"), CHARGE);
      context.db
        .prepare(
          "UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id='workspace'",
        )
        .run(CHARGE);
    });
  const kept = () =>
    context.db
      .prepare("SELECT object_id FROM sync_relay_ordinary_checkpoints ORDER BY object_id")
      .all()
      .map((row) => String(row.object_id));
  const deleteNote = (settlementAdmission?: SettlementAdmission) => {
    const deleted = moment("notes/a.md", "", {
      originSeq: 0,
      objectId: "note",
      operation: "delete",
      afterContent: null,
      afterPath: null,
    });
    const payloadJson = JSON.stringify(deleted.payload);
    storage.appendLogBatch({
      workspaceId: "workspace",
      originId: "device",
      ops: [
        {
          originSeq: deleted.originSeq,
          opKind: deleted.opKind,
          payloadJson,
          recordedAtMs: deleted.recordedAtMs,
          ...(settlementAdmission ? { settlementAdmission } : {}),
        },
      ],
    });
    return (
      Buffer.byteLength(payloadJson) +
      (settlementAdmission ? Buffer.byteLength(JSON.stringify(settlementAdmission)) : 0)
    );
  };
  return { usage, stored, kept, deleteNote };
}

it("appending a note's delete deletes the note's stored checkpoints and returns their charge", async () => {
  const r = await relay();
  r.stored("other");
  const before = r.usage();
  r.stored("note");
  const row = r.deleteNote();
  expect(r.kept()).toEqual(["other"]);
  expect(r.usage()).toBe(before + row);
});

it("a settlement-refused delete keeps the note's stored checkpoint and its charge", async () => {
  const r = await relay();
  r.stored("note");
  const before = r.usage();
  const row = r.deleteNote({
    status: "refused",
    settlementId: "settlement",
    reason: "authorship-mismatch",
  });
  expect(r.kept()).toEqual(["note"]);
  expect(r.usage()).toBe(before + row);
});
