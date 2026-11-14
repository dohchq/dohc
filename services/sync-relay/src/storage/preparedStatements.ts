import type { SqliteDb, SqliteStatement } from "./types";

/**
 * Keeps each statement's compiled form for the next caller of the same SQL.
 * Compiling cost more than running the reads that every live frame makes of
 * its editor's access. A `get`, `all` or `run` finishes before it returns, so
 * callers can share its statement.
 * An `iterate` stays open while its caller reads rows, so each one gets a
 * statement of its own, as before. The least recently used statements beyond
 * `limit` are dropped.
 */
export function reusePreparedStatements(db: SqliteDb, limit = 1_000): SqliteDb {
  const statements = new Map<string, SqliteStatement>();
  const wrapped = {
    exec: (sql: string) => db.exec(sql),
    close: () => {
      statements.clear();
      db.close();
    },
    // Whether a write is open, read from the database itself.
    get isTransaction() {
      return (db as SqliteDb & { isTransaction?: boolean }).isTransaction;
    },
    prepare(sql: string): SqliteStatement {
      const kept = statements.get(sql);
      const compiled = kept ?? db.prepare(sql);
      if (kept) statements.delete(sql);
      else if (statements.size >= limit) statements.delete(statements.keys().next().value!);
      statements.set(sql, compiled);
      // A new object each time, so a caller that replaces a method changes only its own.
      return {
        get: (...params) => compiled.get(...params),
        all: (...params) => compiled.all(...params),
        run: (...params) => compiled.run(...params),
        iterate: (...params) => db.prepare(sql).iterate(...params),
      };
    },
  };
  return wrapped;
}
