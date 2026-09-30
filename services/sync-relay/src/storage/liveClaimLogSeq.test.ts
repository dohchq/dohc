import { afterEach, expect, it } from "vitest";
import type { AutomationClaim } from "@dohc/workspace-engine-client";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import { ServerClaimEngine, type LiveClaimLedger } from "../automationLiveClaims";
import { closeTestStorage, closeTestStorages, inspectDatabase, reopenTestStorage, storagePath, testStorage } from "../testing";

afterEach(closeTestStorages);

async function fixture() {
  let storage = await testStorage();
  storage.claimWorkspace({ workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1 });
  const path = storagePath(storage);
  const raw = inspectDatabase(path);
  const binding = { workspaceId: "workspace", mainVersionId: "main", objectId: "record", lineageClaimId: "b".repeat(64) };
  const frame = (cursor: number) => raw.prepare(
    `INSERT INTO sync_relay_live_update_journal (journal_cursor, delivery_id, update_digest, workspace_id, main_version_id, object_id,
       lineage_claim_id, current_path, selector_paths_json, restore_fence_generation, principal_kind, principal_id, accepting_host_epoch,
       received_at_ms, update_bytes, relay_database_namespace, accepted_event_count, accepted_evidence_digest, accepted_metadata_bytes)
     VALUES (?, ?, ?, 'workspace', 'main', 'record', ?, 'Tasks/one.md', '["Tasks"]', 0, 'owner', 'owner', 1, 1, x'01', 'ns', 1, ?, 1)`,
  ).run(cursor, `delivery-${cursor}`, "a".repeat(64), binding.lineageClaimId, "c".repeat(64));
  let originSeq = 0;
  const append = (opKind: string, payload: object) => {
    storage.appendLogBatch({ workspaceId: "workspace", originId: "host", ops: [
      { originSeq: originSeq++, opKind, payloadJson: JSON.stringify(payload), recordedAtMs: 1 },
    ] });
    return storage.automationWorkspaceLogHead("workspace");
  };
  const settlement = (cursor: number, momentId: string, patch: object = {}) => append("live.audit.settlement", {
    formatVersion: 1, record: { binding, relayDatabaseNamespace: "ns", terminalCursor: cursor, momentId, ...patch },
  });
  const moment = (momentId: string) => append("moment.append", {
    objectId: binding.objectId, versionId: binding.mainVersionId, momentId, recordedAtMs: 1,
  });
  return { frame, settlement, moment, binding, get storage() { return storage; },
    seq: (liveCursor: number) => storage.liveClaimLogSeq({ workspaceId: "workspace", liveCursor }),
    restart() { closeTestStorage(storage); storage = reopenTestStorage(path); } };
}

it("recovers a committed settlement after a crash before the host recorded its callback", async () => {
  const f = await fixture();
  f.frame(41);
  // The engine committed and journaled these together. The process died before
  // recordLiveSettlement; ordinary replication publishes the journal on restart.
  f.restart();
  f.settlement(41, "settled");
  expect(f.seq(41)).toBeNull();
  const seq = f.moment("settled");
  f.restart();
  expect(f.seq(41)).toBe(seq);
  f.frame(42);
  expect(f.seq(42)).toBeNull();
});

it("releases an unsettled frame's claim after a live restore settlement reaches the copy", async () => {
  const f = await fixture();
  f.frame(41);
  const claim = { claimId: "before-restore", trigger: { historyId: 7 }, change: { liveCursor: 41 } } as unknown as AutomationClaim;
  let pending = true;
  const ledger: LiveClaimLedger = { incarnation: "host", engine: {
    claimNextAutomation: async () => { if (!pending) return null; pending = false; return claim; },
  } as unknown as LiveClaimLedger["engine"] };
  const copy = { sendRequest: async ({ id }: { id: number }) => ({ id, result: null }) } as unknown as EngineClient;
  const pulled: number[] = [];
  const engine = new ServerClaimEngine([copy, "handle", { workspaceId: "workspace" }], {
    ledger: () => ledger, storage: f.storage,
    sync: async () => { pulled.push(f.storage.automationWorkspaceLogHead("workspace")); },
    onFailuresChanged: () => { throw new Error("Restore must not fail this claim"); },
    onError: (_context, error) => { throw error; },
  });
  expect(await engine.claimNextAutomation({ automationIdPrefix: "collection:" })).toBeNull();
  expect(engine.waiting()).toBe(true);
  // readRestoreAdmission preserves oldBinding's lineage and advances only its fence.
  // with_restore_settlement includes the old interval plus the restore's own cursor.
  f.settlement(42, "restored", {
    binding: { ...f.binding, restoreFenceGeneration: 1 }, previousCursor: 0,
  });
  expect(await engine.claimNextAutomation({ automationIdPrefix: "collection:" })).toBeNull();
  expect(pulled).toEqual([]);
  const seq = f.moment("restored");
  expect(await engine.claimNextAutomation({ automationIdPrefix: "collection:" })).toBe(claim);
  expect(pulled).toEqual([seq]);
  expect(engine.waiting()).toBe(false);
});

it("keeps a logged settlement usable while each newer settlement awaits its moment", async () => {
  const f = await fixture();
  f.frame(41);
  f.settlement(41, "first");
  const first = f.moment("first");
  for (const cursor of [42, 43, 44]) {
    f.frame(cursor);
    f.settlement(cursor, `next-${cursor}`);
    expect(f.seq(41)).toBe(first);
    expect(f.seq(cursor)).toBeNull();
  }
  const latest = f.moment("next-44");
  expect(f.seq(44)).toBe(latest);
});

it("requires a settlement for the frame's namespace, workspace, version, and lineage", async () => {
  const f = await fixture();
  f.frame(41);
  for (const patch of [
    { relayDatabaseNamespace: "foreign" },
    ...["workspaceId", "mainVersionId", "objectId", "lineageClaimId"].map(field => ({
      binding: { workspaceId: "workspace", mainVersionId: "main", objectId: "record", lineageClaimId: "b".repeat(64), [field]: "foreign" },
    })),
    { terminalCursor: "41" },
  ]) {
    f.settlement(41, "settled", patch);
  }
  f.moment("settled");
  expect(f.seq(41)).toBeNull();
  const auditSeq = f.settlement(41, "settled");
  expect(f.seq(41), "the copy must also pull the audit when it follows the moment").toBe(auditSeq);
});
