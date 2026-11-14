import { afterEach, expect, it, vi } from "vitest";
import { liveBrowserActor } from "../liveBrowserContext.js";
import { binding, DatabaseSync, fixture, scope } from "../liveTickets.test-helper.js";
import { reusePreparedStatements } from "./preparedStatements";
import type { SqliteDb } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
});

it("reads an editor's access again without compiling its statements again", async () => {
  const f = await fixture();
  try {
    const read = () =>
      f.storage.resolveCurrentLiveDocumentBinding({
        document: {
          workspaceId: binding.workspaceId,
          mainVersionId: binding.mainVersionId,
          objectId: binding.objectId,
          lineageClaimId: binding.lineageClaimId,
        },
        actor: liveBrowserActor(scope),
      });
    expect(read()).toMatchObject({ kind: "current" });
    const compiled = vi.spyOn(DatabaseSync.prototype, "prepare");
    expect(read()).toMatchObject({ kind: "current" });
    expect(compiled).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it("gives each row-by-row read its own statement, so the same SQL can run inside it", () => {
  const raw = new DatabaseSync(":memory:");
  const db = reusePreparedStatements(raw as unknown as SqliteDb);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1), (2), (3)");
  const sql = "SELECT id FROM t ORDER BY id";
  const seen: unknown[] = [];
  for (const outer of db.prepare(sql).iterate()) {
    expect(db.prepare(sql).all()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    for (const inner of db.prepare(sql).iterate()) seen.push([outer.id, inner.id]);
  }
  expect(seen).toHaveLength(9);
  db.close();
});

it("compiles again only the statements it dropped beyond its limit", () => {
  const raw = new DatabaseSync(":memory:");
  const compiled = vi.spyOn(raw, "prepare");
  const db = reusePreparedStatements(raw as unknown as SqliteDb, 2);
  const run = (n: number) => db.prepare(`SELECT ${n} AS n`).get();
  for (const n of [1, 2, 1, 3, 1, 2]) run(n);
  // 2 was the least recently used when 3 arrived, so only it is compiled twice.
  expect(compiled.mock.calls.map(([sql]) => sql)).toEqual([
    "SELECT 1 AS n",
    "SELECT 2 AS n",
    "SELECT 3 AS n",
    "SELECT 2 AS n",
  ]);
  expect(run(3)).toEqual({ n: 3 });
  db.close();
});
