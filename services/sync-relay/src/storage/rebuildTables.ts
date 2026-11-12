import type { SqliteDb } from "./types";

// SQLite cannot change a CHECK or drop a constrained column in place. Each of
// `tables`, a parent before its children, is copied aside, dropped and created
// again under its own name from `sqlFor`, which receives its current SQL.
// Children drop first, so no drop cascades. The rows return with every old
// column except those named in `dropped`, and a new column takes its default.
// A column the new layout lacks and `dropped` doesn't name refuses. Indexes,
// triggers and AUTOINCREMENT positions return after the rows, so no trigger
// runs on the copy. A table outside `tables` that references one of them would
// lose its rows, so it refuses. Runs inside the caller's transaction, which a
// refusal rolls back.
export function rebuildTables(db: SqliteDb, tables: readonly string[], sqlFor: (table: string, sql: string) => string,
  dropped: readonly string[] = []): void {
  const marks = tables.map(() => "?").join(",");
  const outside = db.prepare(`SELECT s.name FROM sqlite_schema s JOIN pragma_foreign_key_list(s.name) f
    WHERE s.type = 'table' AND f."table" IN (${marks}) AND s.name NOT IN (${marks})`).all(...tables, ...tables);
  if (outside.length) throw new Error("a rebuilt table has an unexpected dependent");
  const created = tables.map(table => {
    const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table);
    if (typeof row?.sql !== "string") throw new Error("a rebuilt table is missing");
    return sqlFor(table, row.sql);
  });
  const columnsOf = (table: string) =>
    db.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(table).map(row => String(row.name));
  const previous = tables.map(columnsOf);
  const dependents = db.prepare(`SELECT sql FROM sqlite_schema
    WHERE type IN ('index', 'trigger') AND sql IS NOT NULL AND tbl_name IN (${marks}) ORDER BY rowid`).all(...tables).map(row => String(row.sql));
  const sequences = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").get()
    ? db.prepare(`SELECT name, seq FROM sqlite_sequence WHERE name IN (${marks})`).all(...tables) : [];
  for (const table of tables) db.exec(`CREATE TEMP TABLE ${table}_previous AS SELECT * FROM main.${table}`);
  for (const table of [...tables].reverse()) db.exec(`DROP TABLE main.${table}`);
  for (const sql of created) db.exec(sql);
  for (const [index, table] of tables.entries()) {
    const kept = new Set(columnsOf(table));
    const lost = previous[index]!.filter(name => !kept.has(name) && !dropped.includes(name));
    if (lost.length) throw new Error(`rebuilding ${table} would lose ${lost.join(", ")}`);
    const columns = previous[index]!.filter(name => kept.has(name)).join(", ");
    db.exec(`INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM temp.${table}_previous`);
  }
  for (const table of tables) db.exec(`DROP TABLE temp.${table}_previous`);
  for (const sql of dependents) db.exec(sql);
  // The copy back can write a position even for an empty table, so each
  // table's position returns exactly as it was, or stays absent.
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").get()) {
    db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${marks})`).run(...tables);
  }
  for (const {name, seq} of sequences) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(name, seq);
}
