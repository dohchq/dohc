import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { rebuildTables } from "./rebuildTables";
import type { SqliteDb } from "./types";
import { RelayWriteOwner } from "./writeOwner";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function withTable(run: (db: SqliteDb) => void): void {
  const raw = new DatabaseSync(":memory:");
  try {
    raw.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, share_id TEXT)");
    raw.exec("INSERT INTO notes (id, body, share_id) VALUES (1, 'kept', 'share')");
    run(raw as unknown as SqliteDb);
  } finally {
    raw.close();
  }
}

const withoutShare = "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)";

it("drops a column only when the caller names it, and keeps every other column's rows", () => {
  withTable(db => {
    // The relay's write transaction rolls the refused rebuild back, so the table keeps its row and column.
    expect(() => new RelayWriteOwner(db).write(() => rebuildTables(db, ["notes"], () => withoutShare)))
      .toThrow("rebuilding notes would lose share_id");
    expect(db.prepare("SELECT id, body, share_id FROM notes").all()).toEqual([{ id: 1, body: "kept", share_id: "share" }]);
  });
  withTable(db => {
    rebuildTables(db, ["notes"], () => withoutShare, ["share_id"]);
    expect(db.prepare("SELECT id, body FROM notes").all()).toEqual([{ id: 1, body: "kept" }]);
  });
});
