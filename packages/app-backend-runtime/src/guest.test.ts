import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { evaluate, hasStatement } from "./guest.ts";
import type { GuestRequest } from "./guest.ts";
import { DEFAULT_LIMITS } from "./protocol.ts";

function request(body: string, overrides: Partial<GuestRequest> = {}): GuestRequest {
  return {
    tables: ["items"],
    source: `globalThis.operations = { run(ctx, input) { ${body} } };`,
    operation: "run",
    callerJson: '{"kind":"owner"}',
    inputJson: "null",
    nowMs: 1000,
    requestId: "request-1",
    secret: "",
    readOnly: false,
    files: [],
    limits: { ...DEFAULT_LIMITS },
    ...overrides,
  };
}

async function withDatabase(run: (db: DatabaseSync) => Promise<void>): Promise<void> {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE dohc_receipts(id INTEGER PRIMARY KEY);",
    );
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
  it.each([
    { body: "while (true) {}", source: undefined },
    { body: "return null;", source: "while (true) {}" },
    { body: "return { toJSON() { while (true) {} } };", source: undefined },
  ])("names the time limit when the guest interrupts: $body", async ({ body, source }) => {
    await withDatabase(async (db) => {
      const operation = request(body, {
        limits: { ...DEFAULT_LIMITS, evaluationMs: 100 },
        ...(source === undefined ? {} : { source }),
      });
      await expect(evaluate(db, operation)).rejects.toThrow(
        "App operation took longer than its 0.1-second time limit, so it stopped.",
      );
      expect((await evaluate(db, request("return 'next';"))).resultJson).toBe('"next"');
    });
  });

  it("names the time limit for an expired database callback before preparing SQL", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      await withDatabase(async (db) => {
        const prepare = vi.spyOn(db, "prepare");
        const operation = request("return ctx.db.query('SELECT * FROM items');", {
          limits: {
            ...DEFAULT_LIMITS,
            evaluationMs: 1250,
            // Cross the deadline inside the callback, after any guest interrupt check.
            get statements() {
              clock.mockReturnValue(1251);
              return DEFAULT_LIMITS.statements;
            },
          },
        });
        const failure = await evaluate(db, operation).catch((error: unknown) => error);
        expect(prepare).not.toHaveBeenCalled();
        expect(failure).toMatchObject({
          message: "App operation took longer than its 1.25-second time limit, so it stopped.",
        });
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("names the time limit for a bootstrap failure before loading app source", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      await withDatabase(async (db) => {
        const operation = request("return null;", {
          source: "invalid app source!",
          inputJson: JSON.stringify(Array.from({ length: 10000 }, () => [1])),
          limits: {
            ...DEFAULT_LIMITS,
            // Start the clock at zero, then expire it before bootstrap checks the deadline.
            get evaluationMs() {
              clock.mockReturnValue(1251);
              return 1250;
            },
          },
        });
        await expect(evaluate(db, operation)).rejects.toThrow(
          "App operation took longer than its 1.25-second time limit, so it stopped.",
        );
      });
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    {
      cause: "memory",
      inputJson: JSON.stringify("x".repeat(8 * 1024 * 1024)),
      message: "App operation needed more than its 16 MiB memory limit, so it stopped.",
    },
    {
      cause: "invalid JSON",
      inputJson: "{",
      message: "App operation context could not be initialized.",
    },
  ])(
    "keeps a bootstrap failure's $cause cause before loading app source",
    async ({ inputJson, message }) => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      try {
        await withDatabase(async (db) => {
          await expect(
            evaluate(
              db,
              request("return null;", {
                source: "invalid app source!",
                inputJson,
                limits: { ...DEFAULT_LIMITS, memoryBytes: 16 * 1024 * 1024 },
              }),
            ),
          ).rejects.toThrow(message);
        });
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("keeps a guest exception named interrupted separate from a time limit", async () => {
    await withDatabase(async (db) => {
      await expect(evaluate(db, request("throw new Error('interrupted');"))).rejects.toThrow(
        /^App operation failed\.$/,
      );
    });
  });

  it.each(["changes", "total_changes", "last_insert_rowid"])(
    "hides retained %s counters through every authorizer reset",
    async (counter) => {
      await withDatabase(async (db) => {
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
          expect(JSON.parse(result.resultJson)).toEqual({
            blocked: [true, true, true],
            changed: 1,
          });
          db.setAuthorizer(null);
          expect(session.changeset().byteLength).toBeGreaterThan(0);
        } finally {
          session.close();
        }
      });
    },
  );

  it("preserves snapshot SQL counter behavior", async () => {
    await withDatabase(async (db) => {
      const result = await evaluate(
        db,
        request("return ctx.db.query('SELECT last_insert_rowid() AS id');"),
      );
      expect(JSON.parse(result.resultJson)).toEqual([{ id: 42 }]);
    });
  });

  it("finds a statement only where SQLite would prepare one", () => {
    for (const sql of [
      "",
      " \t\v\f\r\n",
      ";",
      " ; ;",
      "-- note",
      "-- note\rSELECT 1",
      "/* note */",
      "/* unfinished",
      "\0SELECT 1",
      " \0SELECT 1",
      "-- note\0\nSELECT 1",
      "\uFEFF",
      "\uFEFF;-- note",
      " \uFEFF/* note */;\uFEFF",
    ]) {
      expect(hasStatement(sql), JSON.stringify(sql)).toBe(false);
    }
    for (const sql of [
      "SELECT 1",
      "-- note\nSELECT 1",
      "/* note */SELECT 1",
      ";SELECT 1",
      "SELECT 1\0",
      "x",
      "\uFEFFSELECT 1",
    ]) {
      expect(hasStatement(sql), JSON.stringify(sql)).toBe(true);
    }
  });

  it("refuses SQL with no statement before SQLite prepares it", async () => {
    await withDatabase(async (db) => {
      const result = await evaluate(
        db,
        request(`
        const messages = [];
        for (const sql of ['', '  ', ';', '-- note', '/* note */', '\\uFEFF', '\\uFEFF;-- note', ' \\uFEFF/* note */;\\uFEFF']) {
          try { ctx.db.query(sql); messages.push('prepared'); } catch (error) { messages.push(error.message); }
          try { ctx.db.execute(sql); messages.push('prepared'); } catch (error) { messages.push(error.message); }
        }
        return messages;
      `),
        { persistentConnection: true },
      );
      expect(JSON.parse(result.resultJson)).toEqual(
        Array.from({ length: 16 }, () => "SQL statement is empty."),
      );
    });
  });

  it("isolates guest globals and enforces each operation's table and write permissions", async () => {
    await withDatabase(async (db) => {
      await evaluate(
        db,
        request(
          "globalThis.prior = 'private'; ctx.db.execute(\"INSERT INTO items VALUES(1, 'saved')\"); return true;",
        ),
        { persistentConnection: true },
      );
      const result = await evaluate(
        db,
        request(
          `
        const blocked = [];
        for (const sql of ["SELECT * FROM dohc_receipts", "DELETE FROM items", "PRAGMA table_xinfo(items)"]) {
          try { ctx.db.execute(sql); blocked.push(false); } catch { blocked.push(true); }
        }
        return { prior: typeof globalThis.prior, blocked, rows: ctx.db.query('SELECT * FROM items') };
      `,
          { readOnly: true },
        ),
        { persistentConnection: true },
      );
      expect(JSON.parse(result.resultJson)).toEqual({
        prior: "undefined",
        blocked: [true, true, true],
        rows: [{ id: 1, value: "saved" }],
      });
    });
  });

  it("preserves structured refusal across reused connections", async () => {
    await withDatabase(async (db) => {
      await expect(
        evaluate(db, request("ctx.refuse('full', 'No spaces remain.');"), {
          persistentConnection: true,
        }),
      ).rejects.toMatchObject({
        name: "AppBackendRuntimeError",
        refusal: { code: "full", message: "No spaces remain." },
      });
      expect(
        (await evaluate(db, request("return 'next';"), { persistentConnection: true })).resultJson,
      ).toBe('"next"');
    });
  });

  it("names the 128-parameter limit and count separately from non-scalar SQL parameters", async () => {
    await withDatabase(async (db) => {
      const sumSql = (count: number) =>
        `SELECT ${Array.from({ length: count }, () => "?").join("+")} AS total`;
      const atLimit = await evaluate(
        db,
        request(
          `return ctx.db.query(${JSON.stringify(sumSql(128))}, Array.from({ length: 128 }, () => 1));`,
        ),
        { persistentConnection: true },
      );
      expect(JSON.parse(atLimit.resultJson)).toEqual([{ total: 128 }]);

      await expect(
        evaluate(
          db,
          request(
            `return ctx.db.query(${JSON.stringify(sumSql(136))}, Array.from({ length: 136 }, (_, i) => i));`,
          ),
          { persistentConnection: true },
        ),
      ).rejects.toMatchObject({
        name: "AppBackendLimitError",
        message: "SQL statement exceeded its limit of 128 parameters. It used 136 parameters.",
      });

      const caught = await evaluate(
        db,
        request(`
          let overLimit = '', nonScalar = '', nonArray = '';
          try { ctx.db.execute(${JSON.stringify(sumSql(129))}, Array.from({ length: 129 }, () => 'x')); } catch (e) { overLimit = e.message; }
          try { ctx.db.query('SELECT ?', [{ nested: true }]); } catch (e) { nonScalar = e.message; }
          try { ctx.db.query('SELECT ?', 'not-an-array'); } catch (e) { nonArray = e.message; }
          return { overLimit, nonScalar, nonArray };
        `),
        { persistentConnection: true },
      );
      expect(JSON.parse(caught.resultJson)).toEqual({
        overLimit: "SQL statement exceeded its limit of 128 parameters. It used 129 parameters.",
        nonScalar: "SQL parameter 1 must be text, a finite number, or null.",
        nonArray: "SQL parameters must be scalar values.",
      });
    });
  });

  it.each([
    ["an object", "{ nested: true }", 2],
    ["an array", "[1]", 2],
    ["a boolean", "true", 2],
    ["NaN", "NaN", 2],
    ["Infinity", "Infinity", 2],
    ["a BigInt", "1n", 2],
    ["a Date", "new Date(0)", 2],
  ])("refuses %s as a SQL parameter as invalid input", async (_, value, index) => {
    await withDatabase(async (db) => {
      await expect(
        evaluate(db, request(`return ctx.db.query('SELECT ?, ?', ['ok', ${value}]);`), {
          persistentConnection: true,
        }),
      ).rejects.toMatchObject({
        name: "AppBackendRuntimeError",
        refusal: {
          code: "invalid_input",
          message: `SQL parameter ${index} must be text, a finite number, or null.`,
        },
      });
    });
  });

  it("lets an operation catch a refused SQL parameter and refuse in its own words", async () => {
    await withDatabase(async (db) => {
      await expect(
        evaluate(
          db,
          request(
            `
            try { ctx.db.query('SELECT * FROM items WHERE id=?', [input.id]); }
            catch { ctx.refuse('not_found', 'No such item.'); }
          `,
            { inputJson: '{"id":{}}' },
          ),
        ),
      ).rejects.toMatchObject({ refusal: { code: "not_found", message: "No such item." } });
    });
  });

  it("reads json_each and json_tree unless a real table has the name", async () => {
    await withDatabase(async (db) => {
      const listed = await evaluate(
        db,
        request(`
          ctx.db.execute("INSERT INTO items VALUES(1,'a'),(2,'b'),(3,'c')");
          return {
            each: ctx.db.query('SELECT id FROM items WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id', ['[1,3]']),
            tree: ctx.db.query("SELECT count(*) AS n FROM JSON_TREE(?)", ['{"a":[1,2]}']),
          };
        `),
        { persistentConnection: true },
      );
      expect(JSON.parse(listed.resultJson)).toEqual({
        each: [{ id: 1 }, { id: 3 }],
        tree: [{ n: 4 }],
      });
      db.setAuthorizer(null);
      db.exec("CREATE TABLE json_each(id INTEGER PRIMARY KEY, value TEXT)");
      await expect(
        evaluate(db, request("return ctx.db.query('SELECT value FROM json_each');"), {
          schemaTables: ["items", "json_each"],
        }),
      ).rejects.toMatchObject({
        refusal: {
          code: "sql_not_allowed",
          message:
            "App operation can't read json_each: it isn't one of the tables this operation can use.",
        },
      });
    });
  });

  it.each([
    [
      "an undeclared table",
      "ctx.db.query('SELECT * FROM notes')",
      false,
      "App operation can't read notes: it isn't one of the tables this operation can use.",
    ],
    [
      "a write in a read-only operation",
      "ctx.db.execute(\"INSERT INTO items VALUES(9, 'x')\")",
      true,
      "This operation only reads, so it can't change items.",
    ],
    [
      "a denied function",
      "ctx.db.query('SELECT changes() AS n')",
      false,
      "App operations can't call changes().",
    ],
    [
      "a dohc table",
      "ctx.db.query('SELECT * FROM dohc_receipts')",
      false,
      "App operations can't run this kind of SQL statement.",
    ],
  ])("names what SQL the operation can't use: %s", async (_, call, readOnly, message) => {
    await withDatabase(async (db) => {
      db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY)");
      await expect(
        evaluate(db, request(`${call}; return null;`, { readOnly }), {
          persistentConnection: true,
          schemaTables: ["items", "notes"],
        }),
      ).rejects.toMatchObject({
        name: "AppBackendRuntimeError",
        refusal: { code: "sql_not_allowed", message },
      });
    });
  });

  it("keeps a refusal that escapes after a caught one", async () => {
    await withDatabase(async (db) => {
      db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY)");
      await expect(
        evaluate(
          db,
          request(`
            try { ctx.db.query('SELECT * FROM notes'); }
            catch (error) { try { ctx.db.query('SELECT ?', [{}]); } catch {} throw error; }
          `),
        ),
      ).rejects.toMatchObject({ refusal: { code: "sql_not_allowed" } });
    });
  });

  it("reports a caught SQL refusal as the operation's own failure", async () => {
    await withDatabase(async (db) => {
      db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY)");
      await expect(
        evaluate(
          db,
          request("try { ctx.db.query('SELECT * FROM notes'); } catch {} throw new Error('mine');"),
        ),
      ).rejects.toThrow(/^App operation failed\.$/);
    });
  });

  it("binds one statement's parameters up to the query result size, and names the limit past it", async () => {
    await withDatabase(async (db) => {
      const write = (characters: number) =>
        evaluate(
          db,
          request(
            `ctx.db.execute('INSERT OR REPLACE INTO items VALUES(1, ?)', ['x'.repeat(${characters})]); return null;`,
          ),
          { persistentConnection: true },
        );
      await write(150_000);
      expect(db.prepare("SELECT length(value) AS n FROM items WHERE id=1").get()).toMatchObject({
        n: 150_000,
      });
      await expect(write(DEFAULT_LIMITS.queryBytes)).rejects.toThrow(
        `SQL parameters exceeded its limit of ${DEFAULT_LIMITS.queryBytes} bytes. It used ${DEFAULT_LIMITS.queryBytes + 4} bytes.`,
      );
    });
  });

  it("gives the date at the request's time in the caller's time zone", async () => {
    await withDatabase(async (db) => {
      const nowMs = Date.UTC(2026, 10, 24, 20, 30);
      const dates = await evaluate(
        db,
        request(
          `return ['Asia/Singapore', 'america/new_york', 'UTC', 'Pacific/Kiritimati', 'Etc/GMT+12'].map(ctx.localDate);`,
          { nowMs },
        ),
      );
      expect(JSON.parse(dates.resultJson)).toEqual([
        "2026-11-25",
        "2026-11-24",
        "2026-11-24",
        "2026-11-25",
        "2026-11-24",
      ]);
      const fallback = await evaluate(
        db,
        request(
          "try { return ctx.localDate('+08:00'); } catch (error) { return [error.message, ctx.localDate('UTC')]; }",
          { nowMs },
        ),
      );
      expect(JSON.parse(fallback.resultJson)).toEqual([
        '"+08:00" isn\'t a time zone name, such as "Asia/Singapore".',
        "2026-11-24",
      ]);
      for (const zone of ["'Mars/Olympus'", "8", "'x'.repeat(100)"])
        await expect(
          evaluate(db, request(`return ctx.localDate(${zone});`, { nowMs })),
        ).rejects.toMatchObject({
          name: "AppBackendRuntimeError",
          refusal: { code: "invalid_input" },
        });
    });
  });
});

describe("guest memory", () => {
  const marker = "dohc-marker-4111111111111111";
  const plant = `const notes = ctx.db.query('SELECT value FROM items')[0].value;
    const copies = []; for (let i = 0; i < 4000; i++) copies.push(notes + i);
    const bytes = new Uint8Array(4 << 20); for (let i = 0; i < ${marker.length}; i++) bytes[i] = notes.charCodeAt(i);
    for (let filled = ${marker.length}; filled < bytes.length; filled *= 2) bytes.copyWithin(filled, 0, filled);
    return copies.length;`;
  // The search holds each byte of the marker plus one, so the marker exists only in memory another operation wrote.
  const shifted = String.fromCharCode(...[...marker].map((char) => char.charCodeAt(0) + 1));
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

  it.each(probes)(
    "keeps a record an earlier operation read out of a later operation's buffer: %s",
    async (probe) => {
      await withDatabase(async (db) => {
        db.prepare("INSERT INTO items VALUES(1, ?)").run(marker.repeat(40));
        expect(
          (await evaluate(db, request(plant), { persistentConnection: true })).resultJson,
        ).toBe("4000");
        // The later operation cannot read items, so the record can reach it only through memory.
        const later = request(`return ${find}(${probe});`, {
          tables: ["dohc_receipts"],
          readOnly: true,
        });
        expect((await evaluate(db, later, { persistentConnection: true })).resultJson).toBe(
          "false",
        );
      });
    },
  );

  it("stops an operation at its memory limit, however it allocates, and runs the next one", async () => {
    await withDatabase(async (db) => {
      const many = (count: number) =>
        `const held = []; for (let i = 0; i < ${count}; i++) held.push(new Uint8Array(1 << 20)); return held.length;`;
      const strings =
        "const held = []; for (let i = 0; i < 64; i++) held.push('x'.repeat(1 << 20) + i); return held.length;";
      for (const body of [
        many(64),
        strings,
        "return new Uint8Array(64 << 20).length;",
        "return new Uint8Array(2 ** 30).length;",
        // Emscripten refuses to grow memory past 2 GiB before it asks the memory.
        "return new ArrayBuffer(2 ** 31 - 1).byteLength;",
      ]) {
        await expect(evaluate(db, request(body), { persistentConnection: true })).rejects.toThrow(
          "App operation needed more than its 24 MiB memory limit, so it stopped.",
        );
      }
      // QuickJS uses part of the memory, so an operation holds most of its limit.
      expect(
        (await evaluate(db, request(many(16)), { persistentConnection: true })).resultJson,
      ).toBe("16");
      const lowered = { limits: { ...DEFAULT_LIMITS, memoryBytes: 16 << 20 } };
      await expect(
        evaluate(db, request(many(16), lowered), { persistentConnection: true }),
      ).rejects.toThrow("App operation needed more than its 16 MiB memory limit, so it stopped.");
      await expect(
        evaluate(db, request(`try { ${many(64)} } catch { ctx.refuse('full', 'No memory.'); }`), {
          persistentConnection: true,
        }),
      ).rejects.toMatchObject({ refusal: { code: "full", message: "No memory." } });
      expect(
        (
          await evaluate(db, request(`try { ${many(64)} } catch { return 'recovered'; }`), {
            persistentConnection: true,
          })
        ).resultJson,
      ).toBe('"recovered"');
      expect(
        (await evaluate(db, request("return 'next';"), { persistentConnection: true })).resultJson,
      ).toBe('"next"');
    });
  });

  it("names the memory limit only for a failure the full memory caused", async () => {
    await withDatabase(async (db) => {
      const persistent = { persistentConnection: true };
      const fill = "let held = []; try { for (;;) held.push(new Uint8Array(1 << 20)); } catch {}";
      await expect(
        evaluate(
          db,
          request(`${fill} while (true) {}`, { limits: { ...DEFAULT_LIMITS, evaluationMs: 100 } }),
          persistent,
        ),
      ).rejects.toThrow("App operation took longer than its 0.1-second time limit, so it stopped.");
      await expect(
        evaluate(
          db,
          request(`${fill} held = null; return 'x'.repeat(100);`, {
            limits: { ...DEFAULT_LIMITS, resultBytes: 10 },
          }),
          persistent,
        ),
      ).rejects.toThrow(/^Operation result exceeded its limit of 10 bytes\. It used 102 bytes\.$/);
      await expect(
        evaluate(db, request(`${fill} throw new Error('later');`), persistent),
      ).rejects.toThrow(
        /^App operation needed more than its 24 MiB memory limit, so it stopped\.$/,
      );
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
      expect(JSON.parse((await evaluate(db, request(read), persistent)).resultJson)).toEqual([
        "App operation needed more than its 24 MiB memory limit, so it stopped.",
        [{ size: 200 * 1024 }],
      ]);
      expect(
        (
          await evaluate(
            db,
            request("return ctx.db.query('SELECT * FROM items')[0].value.length;"),
            persistent,
          )
        ).resultJson,
      ).toBe(String(200 * 1024));
    });
  });

  it("answers a failed database call with a readable error however full the shape table and memory are", async () => {
    await withDatabase(async (db) => {
      const limit = "App operation needed more than its 24 MiB memory limit, so it stopped.";
      // Many shapes make QuickJS's shape table large. Each step frees a little memory and fails a query with a 1 KiB message.
      const body = `const sql = 'SELECT ' + 'c'.repeat(1000) + ' FROM items';
        const shapes = []; for (let i = 0; i < 20000; i++) shapes.push({ ['p' + i]: i });
        let limited = 0, named = 0, other = 0, steps = 0;
        let held = [];
        try { for (;;) held.push(new Uint8Array(1 << 20)); } catch {}
        try { for (;;) held.push(new Uint8Array(4096)); } catch {}
        // Fill the last bytes too, so early steps leave less than the 1 KiB message free.
        // Smaller objects can leave the operation's own code no room to finish.
        try { for (;;) held.push(new Uint8Array(64)); } catch {}
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
      expect(
        JSON.parse((await evaluate(db, request(body), { persistentConnection: true })).resultJson),
      ).toEqual({ limited: true, named: true, other: 0, shapes: 20000, rows: [{ n: 0 }] });
    });
  });
});
