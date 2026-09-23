import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { evaluate } from "./guest.ts";
import type { GuestRequest } from "./guest.ts";
import { DEFAULT_LIMITS } from "./protocol.ts";

function request(body: string, overrides: Partial<GuestRequest> = {}): GuestRequest {
  return {
    tables: ["items"], source: `globalThis.operations = { run(ctx) { ${body} } };`,
    operation: "run", callerJson: '{"kind":"owner"}', inputJson: "null",
    nowMs: 1000, requestId: "request-1", secret: "", readOnly: false,
    files: [], limits: { ...DEFAULT_LIMITS }, ...overrides,
  };
}

async function withDatabase(run: (db: DatabaseSync) => Promise<void>): Promise<void> {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE dohc_receipts(id INTEGER PRIMARY KEY);");
    db.exec("INSERT INTO dohc_receipts VALUES(42)");
    db.exec("BEGIN IMMEDIATE");
    await run(db);
  } finally {
    db.setAuthorizer(null);
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
}

describe("reusable guest evaluator", () => {
  it.each(["changes", "total_changes", "last_insert_rowid"])("hides retained %s counters through every authorizer reset", async counter => {
    await withDatabase(async db => {
      const operation = request(`
        const blocked = [];
        function check() { try { ctx.db.query('SELECT ${counter}()'); blocked.push(false); } catch { blocked.push(true); } }
        check();
        ctx.db.query('SELECT * FROM items');
        check();
        const changed = ctx.db.execute("INSERT INTO items VALUES(1, 'item')").changes;
        check();
        return {blocked, changed};
      `);
      const session = db.createSession();
      try {
        const result = await evaluate(db, operation, { persistentConnection: true });
        expect(JSON.parse(result.resultJson)).toEqual({ blocked: [true, true, true], changed: 1 });
        db.setAuthorizer(null);
        expect(session.changeset().byteLength).toBeGreaterThan(0);
      } finally { session.close(); }
    });
  });

  it("preserves snapshot SQL counter behavior", async () => {
    await withDatabase(async db => {
      const result = await evaluate(db, request("return ctx.db.query('SELECT last_insert_rowid() AS id');"));
      expect(JSON.parse(result.resultJson)).toEqual([{ id: 42 }]);
    });
  });

  it("isolates guest globals and enforces each operation's table and write permissions", async () => {
    await withDatabase(async db => {
      await evaluate(db, request("globalThis.prior = 'private'; ctx.db.execute(\"INSERT INTO items VALUES(1, 'saved')\"); return true;"), { persistentConnection: true });
      const result = await evaluate(db, request(`
        const blocked = [];
        for (const sql of ["SELECT * FROM dohc_receipts", "DELETE FROM items", "PRAGMA table_xinfo(items)"]) {
          try { ctx.db.execute(sql); blocked.push(false); } catch { blocked.push(true); }
        }
        return { prior: typeof globalThis.prior, blocked, rows: ctx.db.query('SELECT * FROM items') };
      `, { readOnly: true }), { persistentConnection: true });
      expect(JSON.parse(result.resultJson)).toEqual({ prior: "undefined", blocked: [true, true, true], rows: [{ id: 1, value: "saved" }] });
    });
  });

  it("preserves structured refusal across reused connections", async () => {
    await withDatabase(async db => {
      await expect(evaluate(db, request("ctx.refuse('full', 'No spaces remain.');"), { persistentConnection: true }))
        .rejects.toMatchObject({ name: "AppBackendRuntimeError", refusal: { code: "full", message: "No spaces remain." } });
      expect((await evaluate(db, request("return 'next';"), { persistentConnection: true })).resultJson).toBe('"next"');
    });
  });
});
