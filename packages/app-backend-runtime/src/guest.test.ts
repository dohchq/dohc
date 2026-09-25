import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { evaluate, hasStatement } from "./guest.ts";
import type { GuestRequest } from "./guest.ts";
import { DEFAULT_LIMITS } from "./protocol.ts";

function request(body: string, overrides: Partial<GuestRequest> = {}): GuestRequest {
  return {
    tables: ["items"], source: `globalThis.operations = { run(ctx, input) { ${body} } };`,
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

  it("finds a statement only where SQLite would prepare one", () => {
    for (const sql of ["", " \t\v\f\r\n", ";", " ; ;", "-- note", "-- note\rSELECT 1", "/* note */", "/* unfinished", "\0SELECT 1", " \0SELECT 1",
      "-- note\0\nSELECT 1", "\uFEFF", "\uFEFF;-- note", " \uFEFF/* note */;\uFEFF"]) {
      expect(hasStatement(sql), JSON.stringify(sql)).toBe(false);
    }
    for (const sql of ["SELECT 1", "-- note\nSELECT 1", "/* note */SELECT 1", ";SELECT 1", "SELECT 1\0", "x", "\uFEFFSELECT 1"]) {
      expect(hasStatement(sql), JSON.stringify(sql)).toBe(true);
    }
  });

  it("refuses SQL with no statement before SQLite prepares it", async () => {
    await withDatabase(async db => {
      const result = await evaluate(db, request(`
        const messages = [];
        for (const sql of ['', '  ', ';', '-- note', '/* note */', '\\uFEFF', '\\uFEFF;-- note', ' \\uFEFF/* note */;\\uFEFF']) {
          try { ctx.db.query(sql); messages.push('prepared'); } catch (error) { messages.push(error.message); }
          try { ctx.db.execute(sql); messages.push('prepared'); } catch (error) { messages.push(error.message); }
        }
        return messages;
      `), { persistentConnection: true });
      expect(JSON.parse(result.resultJson)).toEqual(Array.from({ length: 16 }, () => "SQL statement is empty."));
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

describe("guest memory", () => {
  const marker = "dohc-marker-4111111111111111";
  // Fills memory with a record: many copies of its text, then a large buffer of its bytes.
  const plant = `const notes = ctx.db.query('SELECT value FROM items')[0].value;
    const copies = []; for (let i = 0; i < 4000; i++) copies.push(notes + i);
    const bytes = new Uint8Array(4 << 20); for (let i = 0; i < ${marker.length}; i++) bytes[i] = notes.charCodeAt(i);
    for (let filled = ${marker.length}; filled < bytes.length; filled *= 2) bytes.copyWithin(filled, 0, filled);
    return copies.length;`;
  // The search holds each byte of the marker plus one, so the marker exists only in memory another operation wrote.
  const shifted = String.fromCharCode(...[...marker].map(char => char.charCodeAt(0) + 1));
  const find = `(bytes => { const m = ${JSON.stringify(shifted)}, first = m.charCodeAt(0) - 1;
    for (let i = bytes.indexOf(first); i >= 0; i = bytes.indexOf(first, i + 1)) {
      let j = 1; while (j < m.length && bytes[i + j] === m.charCodeAt(j) - 1) j++;
      if (j === m.length) return true;
    }
    return false; })`;
  const size = 8 << 20;
  // Every way QuickJS hands out buffer memory: new, resized, grown, transferred, and copied.
  const probes = [
    `new Uint8Array(new ArrayBuffer(${size}))`,
    `new Uint8Array(${size})`,
    `new Uint8Array(new Float64Array(${size / 8}).buffer)`,
    `(() => { const b = new ArrayBuffer(16, { maxByteLength: ${size} }); b.resize(${size}); return new Uint8Array(b); })()`,
    `(() => { const b = new ArrayBuffer(16, { maxByteLength: ${size} }); const view = new Uint8Array(b); b.resize(${size}); return view; })()`,
    `new Uint8Array(new ArrayBuffer(16).transfer(${size}))`,
    `new Uint8Array(new ArrayBuffer(16).transferToFixedLength(${size}))`,
    `new Uint8Array(new ArrayBuffer(16, { maxByteLength: ${size} }).transfer(${size}))`,
    `new Uint8Array(new ArrayBuffer(${size / 2}).slice(0))`,
    `new Uint8Array(new SharedArrayBuffer(${size}))`,
    `(() => { const b = new SharedArrayBuffer(16, { maxByteLength: ${size} }); b.grow(${size}); return new Uint8Array(b); })()`,
  ];

  it.each(probes)("keeps a record an earlier operation read out of a later operation's buffer: %s", async probe => {
    await withDatabase(async db => {
      db.prepare("INSERT INTO items VALUES(1, ?)").run(marker.repeat(40));
      expect((await evaluate(db, request(plant), { persistentConnection: true })).resultJson).toBe("4000");
      // The later operation cannot read items, so the record can reach it only through memory.
      const later = request(`return ${find}(${probe});`, { tables: ["dohc_receipts"], readOnly: true });
      expect((await evaluate(db, later, { persistentConnection: true })).resultJson).toBe("false");
    });
  });

  it("stops an operation at its memory limit, however it allocates, and runs the next one", async () => {
    await withDatabase(async db => {
      const many = (count: number) => `const held = []; for (let i = 0; i < ${count}; i++) held.push(new Uint8Array(1 << 20)); return held.length;`;
      const strings = "const held = []; for (let i = 0; i < 64; i++) held.push('x'.repeat(1 << 20) + i); return held.length;";
      for (const body of [many(64), strings, "return new Uint8Array(64 << 20).length;", "return new Uint8Array(2 ** 30).length;",
        // Emscripten refuses to grow memory past 2 GiB before it asks the memory.
        "return new ArrayBuffer(2 ** 31 - 1).byteLength;"]) {
        await expect(evaluate(db, request(body), { persistentConnection: true }))
          .rejects.toThrow("App operation needed more than its 24 MiB memory limit, so it stopped.");
      }
      // QuickJS uses part of the memory, so an operation holds most of its limit.
      expect((await evaluate(db, request(many(16)), { persistentConnection: true })).resultJson).toBe("16");
      const lowered = { limits: { ...DEFAULT_LIMITS, memoryBytes: 16 << 20 } };
      await expect(evaluate(db, request(many(16), lowered), { persistentConnection: true }))
        .rejects.toThrow("App operation needed more than its 16 MiB memory limit, so it stopped.");
      // An operation that runs out of memory can still refuse, and one that recovers returns normally.
      await expect(evaluate(db, request(`try { ${many(64)} } catch { ctx.refuse('full', 'No memory.'); }`), { persistentConnection: true }))
        .rejects.toMatchObject({ refusal: { code: "full", message: "No memory." } });
      expect((await evaluate(db, request(`try { ${many(64)} } catch { return 'recovered'; }`), { persistentConnection: true })).resultJson).toBe('"recovered"');
      expect((await evaluate(db, request("return 'next';"), { persistentConnection: true })).resultJson).toBe('"next"');
    });
  });

  it("names the memory limit only for a failure the full memory caused", async () => {
    await withDatabase(async db => {
      const persistent = { persistentConnection: true };
      const fill = "let held = []; try { for (;;) held.push(new Uint8Array(1 << 20)); } catch {}";
      // The deadline stops a loop that runs after the operation caught its out-of-memory error.
      await expect(evaluate(db, request(`${fill} while (true) {}`, { limits: { ...DEFAULT_LIMITS, evaluationMs: 100 } }), persistent))
        .rejects.toThrow(/^App operation failed\.$/);
      // A host check keeps its own error.
      await expect(evaluate(db, request(`${fill} held = null; return 'x'.repeat(100);`, { limits: { ...DEFAULT_LIMITS, resultBytes: 10 } }), persistent))
        .rejects.toThrow(/^Operation result exceeds the app runtime limit\.$/);
      await expect(evaluate(db, request(`${fill} throw new Error('later');`), persistent))
        .rejects.toThrow(/^App operation needed more than its 24 MiB memory limit, so it stopped\.$/);
      // A query whose result does not fit answers with the limit before the host copies it.
      db.prepare("INSERT INTO items VALUES(1, ?)").run("x".repeat(200 * 1024));
      const read = `let held = [];
        try { for (;;) held.push(new Uint8Array(1 << 20)); } catch {}
        try { for (;;) held.push(new Uint8Array(4096)); } catch {}
        held.length -= 25;
        let message = 'read';
        try { ctx.db.query('SELECT * FROM items'); } catch (error) { message = error.message; }
        held = null;
        return [message, ctx.db.query('SELECT length(value) AS size FROM items')];`;
      expect(JSON.parse((await evaluate(db, request(read), persistent)).resultJson))
        .toEqual(["App operation needed more than its 24 MiB memory limit, so it stopped.", [{ size: 200 * 1024 }]]);
      expect((await evaluate(db, request("return ctx.db.query('SELECT * FROM items')[0].value.length;"), persistent)).resultJson).toBe(String(200 * 1024));
    });
  });

  it("answers a failed database call with a readable error however full the shape table and memory are", async () => {
    await withDatabase(async db => {
      const limit = "App operation needed more than its 24 MiB memory limit, so it stopped.";
      // Many shapes make QuickJS's shape table large. Each step frees a little memory and fails a query with a 1 KiB message.
      const body = `const sql = 'SELECT ' + 'c'.repeat(1000) + ' FROM items';
        const shapes = []; for (let i = 0; i < 20000; i++) shapes.push({ ['p' + i]: i });
        let limited = 0, named = 0, other = 0, steps = 0;
        let held = [];
        try { for (;;) held.push(new Uint8Array(1 << 20)); } catch {}
        try { for (;;) held.push(new Uint8Array(4096)); } catch {}
        try { for (;;) held.push([1]); } catch {}
        for (; steps < 100 && held.length; steps++) {
          held.length -= 1;
          // The operation's own code can run out of memory too, so only a query's error is counted.
          try {
            try { ctx.db.query(sql); other++; }
            catch (error) {
              const message = error.message;
              if (message === ${JSON.stringify(limit)}) limited++;
              else if (typeof message === 'string' && message.startsWith('no such column: ccc')) named++;
              else other++;
            }
          } catch {}
        }
        held = null;
        return { limited: limited > 0, named: named > 0, other, shapes: shapes.length, rows: ctx.db.query('SELECT count(*) AS n FROM items') };`;
      expect(JSON.parse((await evaluate(db, request(body), { persistentConnection: true })).resultJson))
        .toEqual({ limited: true, named: true, other: 0, shapes: 20000, rows: [{ n: 0 }] });
    });
  });
});
