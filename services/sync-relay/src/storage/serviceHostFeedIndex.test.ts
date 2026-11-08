import {expect, it, vi} from "vitest";
import {binding, fixture} from "../liveTickets.test-helper";
import {openSyncRelayStorage} from "../storage";
import type {StorageContext} from "./context";
import {RelayWriteOwner} from "./writeOwner";

it.each(["direct", "owned"] as const)("adds the conflict-only index when an existing store opens through %s storage", async mode => {
  const f = await fixture();
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined;
  try {
    const name = "idx_sync_relay_log_conflict_effects";
    expect(f.raw.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name=?").get(name)).toBeDefined();
    const insert = f.raw.prepare(`INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq)
      VALUES (?,'owner',?,?,?,1,?)`);
    const rows = [
      ["ydoc.update", {conflictId: "not-a-moment"}], ["moment.append", {}], ["moment.append", {conflictId: "conflict"}],
    ] as const;
    for (const [index, [kind, extra]] of rows.entries()) insert.run(binding.workspaceId, index, kind, JSON.stringify({objectId: binding.objectId, ...extra}), index + 1);
    // Simulate a store written before this index existed, then use the same open path as each host.
    f.raw.exec(`DROP INDEX ${name}`);
    reopened = openSyncRelayStorage(f.path, {}, mode === "owned" ? db => new RelayWriteOwner(db) : undefined);
    expect(f.raw.prepare(`SELECT count(*) AS n FROM sync_relay_log INDEXED BY ${name}
      WHERE op_kind='moment.append' AND json_type(payload_json, '$.conflictId')='text'`).get()?.n).toBe(1);
    const spy = vi.spyOn((reopened as StorageContext).db, "prepare");
    let query: string;
    try {
      expect(reopened.hasServiceHostConflictEffect(binding)).toBe(false);
      query = spy.mock.calls.find(([sql]) => sql.startsWith("SELECT 1 FROM sync_relay_log AS effect"))![0];
    } finally {spy.mockRestore();}
    const plan = f.raw.prepare(`EXPLAIN QUERY PLAN ${query}`).all(binding.workspaceId, binding.objectId, 0).map(row => String(row.detail));
    expect(plan.some(detail => detail.includes(`USING INDEX ${name}`))).toBe(true);
    expect(plan.some(detail => detail.includes("idx_sync_relay_log_hosted_documents"))).toBe(false);
  } finally {reopened?.close(); await f.close();}
});
