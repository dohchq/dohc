import {isDeepStrictEqual} from "node:util";
import type {SqliteDb} from "./types";

/** Pins the results admission actually read, including absent rows and blob contents. */
export class RestoreAdmissionReads {
  readonly #reads: {sql: string; params: unknown[]; rows: Record<string, unknown>[]}[] = [];
  constructor(private readonly db: SqliteDb) {}

  // Capture is synchronous: no other request can use this connection while its statements are wrapped.
  capture<T>(read: () => T): T {
    const prepare = this.db.prepare;
    this.db.prepare = sql => {
      const statement = prepare.call(this.db, sql);
      if (!/^\s*SELECT\b/i.test(sql)) throw new Error("Restore admission capture must only read.");
      const save = (params: unknown[], rows: Record<string, unknown>[], single: boolean) => {
        const query = single ? `SELECT * FROM (${sql}) LIMIT 1` : sql;
        if (!this.#reads.some(entry => entry.sql === query && isDeepStrictEqual(entry.params, params))) {
          this.#reads.push({sql: query, params: structuredClone(params), rows: structuredClone(rows)});
        }
      };
      return {
        get: (...params) => {const row = statement.get(...params); save(params, row ? [row] : [], true); return row;},
        all: (...params) => {const rows = statement.all(...params); save(params, rows, false); return rows;},
        iterate: () => {throw new Error("Restore admission capture requires bounded reads.");},
        run: () => {throw new Error("Restore admission capture must only read.");},
      };
    };
    try {return read();} finally {this.db.prepare = prepare;}
  }

  assertCurrent(): void {
    const changed = () => {throw new Error("Relay evidence changed during validation.");};
    for (const {sql, params, rows} of this.#reads) {
      // SQLite compares retained blobs; no journal/proposal bytes return to JS in the writer.
      const count = this.db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...params)!.n;
      if (count !== rows.length) changed();
      const checked: Record<string, unknown>[] = [];
      for (const row of rows) {
        if (checked.some(prior => isDeepStrictEqual(prior, row))) continue;
        checked.push(row);
        const columns = Object.keys(row);
        const where = columns.map(name => `"${name.replaceAll('"', '""')}" IS ?`).join(" AND ");
        const actual = this.db.prepare(`SELECT COUNT(*) AS n FROM (${sql}) WHERE ${where}`)
          .get(...params, ...columns.map(name => row[name]))!.n;
        if (actual !== rows.filter(prior => isDeepStrictEqual(prior, row)).length) changed();
      }
    }
  }
}
