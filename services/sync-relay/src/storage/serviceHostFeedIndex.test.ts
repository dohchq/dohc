import { expect, it, vi } from "vitest";
import { binding, fixture } from "../liveTickets.test-helper";
import { openSyncRelayStorage } from "../storage";
import type { StorageContext } from "./context";
import { RelayWriteOwner } from "./writeOwner";

it.each(["direct", "owned"] as const)(
  "adds the conflict-only index when an existing store opens through %s storage",
  async (mode) => {
    const f = await fixture();
    let reopened: ReturnType<typeof openSyncRelayStorage> | undefined;
    try {
      const name = "idx_sync_relay_log_conflict_effects";
      expect(
        f.raw.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name=?").get(name),
      ).toBeDefined();
      const insert = f.raw
        .prepare(`INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq)
      VALUES (?,'owner',?,?,?,1,?)`);
      const rows = [
        ["ydoc.update", { conflictId: "not-a-moment" }],
        ["moment.append", {}],
        ["moment.append", { conflictId: "conflict" }],
      ] as const;
      for (const [index, [kind, extra]] of rows.entries())
        insert.run(
          binding.workspaceId,
          index,
          kind,
          JSON.stringify({ objectId: binding.objectId, ...extra }),
          index + 1,
        );
      f.raw.exec(`DROP INDEX ${name}`);
      reopened = openSyncRelayStorage(
        f.path,
        {},
        mode === "owned" ? (db) => new RelayWriteOwner(db) : undefined,
      );
      expect(
        f.raw
          .prepare(`SELECT count(*) AS n FROM sync_relay_log INDEXED BY ${name}
      WHERE op_kind='moment.append' AND json_type(payload_json, '$.conflictId')='text'`)
          .get()?.n,
      ).toBe(1);
      const spy = vi.spyOn((reopened as StorageContext).db, "prepare");
      let query: string;
      try {
        expect(
          reopened.hasServiceHostConflictEffect({ ...binding, path: binding.currentPath }),
        ).toBe(false);
        query = spy.mock.calls.find(([sql]) =>
          sql.startsWith(
            "SELECT parent.payload_json, parent.recorded_at_ms FROM sync_relay_log AS effect",
          ),
        )![0];
      } finally {
        spy.mockRestore();
      }
      const plan = f.raw
        .prepare(`EXPLAIN QUERY PLAN ${query}`)
        .all(binding.workspaceId, binding.objectId, 0)
        .map((row) => String(row.detail));
      expect(plan.some((detail) => detail.includes(`USING INDEX ${name}`))).toBe(true);
      expect(plan.some((detail) => detail.includes("idx_sync_relay_log_hosted_documents"))).toBe(
        false,
      );
    } finally {
      reopened?.close();
      await f.close();
    }
  },
);

it("rebuilds the hosted documents index when an existing store opens with an older one", async () => {
  const f = await fixture();
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined;
  try {
    const name = "idx_sync_relay_log_hosted_documents";
    f.raw
      .prepare(`INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq)
      VALUES (?,'owner',0,'conflict.resolve',?,1,1)`)
      .run(
        binding.workspaceId,
        JSON.stringify({ transition: { current: { objectId: binding.objectId } } }),
      );
    f.raw.exec(`DROP INDEX ${name}`);
    f.raw
      .exec(`CREATE INDEX ${name} ON sync_relay_log(workspace_id, json_extract(payload_json, '$.objectId'), relay_seq)
      WHERE op_kind IN ('moment.append','ydoc.update')`);
    reopened = openSyncRelayStorage(f.path, {});
    const read = () =>
      reopened!
        .listServiceHostDocumentRows({
          workspaceId: binding.workspaceId,
          objectId: binding.objectId,
          afterRelaySeq: 0,
          limit: 10,
        })
        .map((row) => row.opKind);
    expect(read()).toEqual(["conflict.resolve"]);
    const definition = () =>
      f.raw.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(name)?.sql;
    const rebuilt = definition();
    reopened.close();
    reopened = openSyncRelayStorage(f.path, {});
    expect(definition()).toBe(rebuilt);
    expect(read()).toEqual(["conflict.resolve"]);
  } finally {
    reopened?.close();
    await f.close();
  }
});
