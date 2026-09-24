import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { DatasetDefinition, DatasetField } from "@dohc/security-contract/dataset";
import { spawn } from "node:child_process";
import {
  datasetChangeFacts,
  decodeChangeset,
  DatasetChangeFactsError,
  type ChangesetRow,
  type ChangesetValue,
} from "./dataset-change-facts.ts";
import { openPersistentAppBackend, PersistentRuntimeError } from "./persistent.ts";
import type { AppRuntimeLauncher } from "./protocol.ts";

// A small, seeded generator, so a failing case names its seed and repeats.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Stored = ChangesetValue;

function sameValue(left: Stored | undefined, right: Stored | undefined): boolean {
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    return left instanceof Uint8Array && right instanceof Uint8Array && Buffer.from(left).equals(Buffer.from(right));
  }
  return typeof left === typeof right && Object.is(left, right);
}

function key(values: readonly (Stored | undefined)[]): string {
  return JSON.stringify(values.map((value) => (value instanceof Uint8Array ? `blob:${Buffer.from(value).toString("hex")}` : typeof value === "bigint" ? `int:${value}` : value)));
}

interface FuzzTable {
  name: string;
  columns: string[];
  primaryKey: boolean[];
  /** Only a trigger writes this table, so a session marks its changes indirect. */
  indirect?: boolean;
}

// Every row of a table, keyed by primary key, with SQLite's own storage types.
function snapshot(db: DatabaseSync, table: FuzzTable): Map<string, Stored[]> {
  const statement = db.prepare(`SELECT ${table.columns.map((column) => `"${column}"`).join(",")} FROM "${table.name}"`);
  statement.setReadBigInts(true);
  const rows = new Map<string, Stored[]>();
  for (const row of statement.all()) {
    const values = table.columns.map((column) => row[column] as Stored);
    rows.set(key(values.filter((_, index) => table.primaryKey[index])), values);
  }
  return rows;
}

// The net change a session records: rows added, rows removed, and for rows
// kept, the primary key and the old and new values of each changed column.
function expectedRows(table: FuzzTable, before: Map<string, Stored[]>, after: Map<string, Stored[]>): Map<string, ChangesetRow> {
  const rows = new Map<string, ChangesetRow>();
  const base = { table: table.name, indirect: table.indirect === true, primaryKey: table.primaryKey };
  for (const [id, values] of after) {
    const old = before.get(id);
    if (!old) {
      rows.set(`${table.name}:${id}`, { ...base, operation: "insert", old: [], new: values });
      continue;
    }
    const changed = values.map((value, index) => !table.primaryKey[index] && !sameValue(value, old[index]));
    if (!changed.includes(true)) continue;
    rows.set(`${table.name}:${id}`, {
      ...base,
      operation: "update",
      old: old.map((value, index) => (table.primaryKey[index] || changed[index] ? value : undefined)),
      new: values.map((value, index) => (changed[index] ? value : undefined)),
    });
  }
  for (const [id, values] of before) {
    if (!after.has(id)) rows.set(`${table.name}:${id}`, { ...base, operation: "delete", old: values, new: [] });
  }
  return rows;
}

function randomValue(next: () => number, numeric = false): Stored {
  if (numeric) return [null, BigInt(Math.floor(next() * 200) - 100), (next() - 0.5) * 1000][Math.floor(next() * 3)]!;
  switch (Math.floor(next() * 8)) {
    case 0:
      return null;
    case 1:
      return BigInt(Math.floor(next() * 200) - 100);
    case 2:
      return (next() < 0.5 ? -1n : 1n) * (2n ** 62n + BigInt(Math.floor(next() * 1_000_000)));
    case 3:
      return (next() - 0.5) * 10 ** Math.floor(next() * 300);
    case 4:
      return ["", "a", "Straße", "日本語", "emoji 🙂", "quote \" and ' and \\", "x".repeat(300)][Math.floor(next() * 7)]!;
    case 5:
      return Uint8Array.from({ length: Math.floor(next() * 5) }, () => Math.floor(next() * 256));
    case 6:
      return 1.5;
    default:
      return `text ${Math.floor(next() * 50)}`;
  }
}

function bind(value: Stored): Stored {
  return value;
}

type ShapedTable = FuzzTable & { sql: string; integerKey: boolean; numeric?: boolean };

function fuzzTables(next: () => number): ShapedTable[] {
  return Array.from({ length: 1 + Math.floor(next() * 3) }, (_, tableIndex): ShapedTable => {
    const extra = Array.from({ length: 1 + Math.floor(next() * 5) }, (_, index) => `c${index}`);
    const shape = Math.floor(next() * 6);
    const name = `t${tableIndex}`;
    if (shape === 4 || shape === 5) {
      // STRICT keeps each value's type in ANY columns, and stores an integer
      // written to a REAL column as a real.
      const type = shape === 4 ? "ANY" : "REAL";
      return { name, columns: ["id", ...extra], primaryKey: [true, ...extra.map(() => false)], integerKey: false, numeric: shape === 5,
        sql: `CREATE TABLE "${name}"(id TEXT PRIMARY KEY NOT NULL, ${extra.map((column) => `"${column}" ${type}`).join(", ")}) STRICT` };
    }
    if (shape === 0) {
      return { name, columns: ["id", ...extra], primaryKey: [true, ...extra.map(() => false)], integerKey: true,
        sql: `CREATE TABLE "${name}"(id INTEGER PRIMARY KEY, ${extra.map((column) => `"${column}"`).join(", ")})` };
    }
    if (shape === 1) {
      return { name, columns: ["id", ...extra], primaryKey: [true, ...extra.map(() => false)], integerKey: false,
        sql: `CREATE TABLE "${name}"(id TEXT PRIMARY KEY NOT NULL, ${extra.map((column) => `"${column}"`).join(", ")})` };
    }
    // A composite key declared in the other order, so key flags are positions.
    const withoutRowid = shape === 3 ? " WITHOUT ROWID" : "";
    return { name, columns: ["k1", ...extra, "k2"], primaryKey: [true, ...extra.map(() => false), true], integerKey: false,
      sql: `CREATE TABLE "${name}"(k1 INTEGER NOT NULL, ${extra.map((column) => `"${column}"`).join(", ")}, k2 TEXT NOT NULL, PRIMARY KEY(k2, k1))${withoutRowid}` };
  });
}

function randomKey(table: ShapedTable, next: () => number): Stored[] {
  const id = Math.floor(next() * 12);
  if (table.columns[0] === "id") return [table.integerKey ? BigInt(id) : `r${id}`];
  return [BigInt(id % 4), `k${Math.floor(id / 4)}`];
}

function randomChanges(db: DatabaseSync, table: ShapedTable, next: () => number, count: number): void {
  const extras = table.columns.filter((_, index) => !table.primaryKey[index]);
  const keyColumns = table.columns.filter((_, index) => table.primaryKey[index]);
  const where = keyColumns.map((column) => `"${column}"=?`).join(" AND ");
  for (let change = 0; change < count; change += 1) {
    const keyValues = randomKey(table, next);
    const choice = next();
    if (choice < 0.4) {
      const values = table.columns.map((column) => (table.primaryKey[table.columns.indexOf(column)] ? keyValues[keyColumns.indexOf(column)]! : randomValue(next, table.numeric)));
      db.prepare(`INSERT OR IGNORE INTO "${table.name}"(${table.columns.map((column) => `"${column}"`).join(",")}) VALUES(${table.columns.map(() => "?").join(",")})`)
        .run(...values.map(bind));
    } else if (choice < 0.75) {
      const column = extras[Math.floor(next() * extras.length)]!;
      db.prepare(`UPDATE "${table.name}" SET "${column}"=? WHERE ${where}`).run(bind(randomValue(next, table.numeric)), ...keyValues);
    } else if (choice < 0.85) {
      // A change of primary key, which a session records as a delete and an insert.
      const moved = randomKey(table, next);
      db.prepare(`UPDATE OR IGNORE "${table.name}" SET ${keyColumns.map((column) => `"${column}"=?`).join(",")} WHERE ${where}`).run(...moved, ...keyValues);
    } else {
      db.prepare(`DELETE FROM "${table.name}" WHERE ${where}`).run(...keyValues);
    }
  }
}

function rowKey(row: ChangesetRow): string {
  const values = row.operation === "insert" ? row.new : row.old;
  return `${row.table}:${key(values.filter((_, index) => row.primaryKey[index]))}`;
}

describe("changeset decoder", () => {
  it.each(Array.from({ length: 60 }, (_, seed) => seed + 1))("reads what a SQLite session recorded, seed %i", (seed) => {
    const next = random(seed);
    const db = new DatabaseSync(":memory:");
    try {
      const tables = fuzzTables(next);
      for (const table of tables) db.exec(table.sql);
      // A trigger's writes are indirect changes.
      const audit: FuzzTable = { name: "audit", columns: ["n", "note"], primaryKey: [true, false], indirect: true };
      db.exec(`CREATE TABLE audit(n INTEGER PRIMARY KEY, note TEXT);
        CREATE TRIGGER audit_t0 AFTER INSERT ON t0 BEGIN INSERT INTO audit(note) VALUES('added'); END;`);
      for (const table of tables) randomChanges(db, table, next, 20);
      const before = new Map([...tables, audit].map((table) => [table.name, snapshot(db, table)]));
      const session = db.createSession();
      for (let round = 0; round < 3; round += 1) {
        for (const table of tables) randomChanges(db, table, next, 10);
      }
      const changeset = session.changeset();
      session.close();

      const expected = new Map<string, ChangesetRow>();
      for (const table of [...tables, audit]) {
        for (const [id, row] of expectedRows(table, before.get(table.name)!, snapshot(db, table))) expected.set(id, row);
      }
      const decoded = [...decodeChangeset(changeset)];
      const actual = new Map(decoded.map((row) => [rowKey(row), row]));
      expect(actual.size, "a row appeared twice").toBe(decoded.length);
      expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [id, row] of expected) {
        const found = actual.get(id)!;
        expect(found.operation, id).toBe(row.operation);
        expect(found.indirect, id).toBe(row.indirect);
        expect(found.primaryKey, id).toEqual(row.primaryKey);
        for (const side of ["old", "new"] as const) {
          expect(found[side].length, `${id} ${side}`).toBe(row[side].length);
          found[side].forEach((value, index) => expect(sameValue(value, row[side][index]), `${id} ${side}[${index}]`).toBe(true));
        }
      }
    } finally {
      db.close();
    }
  });

  it("reads an empty changeset as no changes", () => {
    expect([...decodeChangeset(new Uint8Array())]).toEqual([]);
  });

  it("refuses bytes it cannot read exactly, and a patchset", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t(id TEXT PRIMARY KEY NOT NULL, a, b)");
    const session = db.createSession();
    db.exec("INSERT INTO t VALUES('r1', 1, 'x'); INSERT INTO t VALUES('r2', 2.5, x'00ff')");
    const changeset = session.changeset();
    const patchset = session.patchset();
    session.close();
    db.close();

    const refused = (bytes: Uint8Array) => () => [...decodeChangeset(bytes)];
    // A cut changeset either fails or reads as its first whole rows, never as other data.
    const rows = [...decodeChangeset(changeset)];
    for (let length = 1; length < changeset.byteLength; length += 1) {
      let read: ChangesetRow[] | undefined;
      try {
        read = [...decodeChangeset(changeset.subarray(0, length))];
      } catch (error) {
        expect(error, `cut at ${length}`).toBeInstanceOf(DatasetChangeFactsError);
      }
      if (read) {
        expect(read.length, `cut at ${length}`).toBeLessThan(rows.length);
        expect(read, `cut at ${length}`).toEqual(rows.slice(0, read.length));
      }
    }
    expect(refused(patchset)).toThrow("A patchset is not a changeset.");
    const badType = Uint8Array.from(changeset);
    badType[badType.indexOf(0x12) + 2] = 9;
    expect(refused(badType)).toThrow("unknown type");
    const badOperation = Uint8Array.from(changeset);
    badOperation[badOperation.indexOf(0x12)] = 0x13;
    expect(refused(badOperation)).toThrow("unknown operation");
    expect(refused(Uint8Array.of(0x54, 0x01, 0x00, 0x74, 0x00))).toThrow("without a primary key");
    expect(refused(Uint8Array.of(0x41))).toThrow("lacks a table header");
  });

  it("keeps text exactly, a leading U+FEFF included, and refuses text that is not UTF-8", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t(id TEXT PRIMARY KEY NOT NULL, a)");
    const record = (sql: string) => {
      const session = db.createSession();
      db.exec(sql);
      const bytes = session.changeset();
      session.close();
      return bytes;
    };
    const [bom] = [...decodeChangeset(record("INSERT INTO t VALUES(char(65279) || 'r1', char(65279) || 'x')"))];
    expect(bom?.new).toEqual(["\uFEFFr1", "\uFEFFx"]);
    expect(() => [...decodeChangeset(record("INSERT INTO t VALUES('r2', CAST(x'fffe41' AS TEXT))"))]).toThrow("text that is not UTF-8");
    db.close();
  });
});

const DATASET_ID = "0a1b2c3d-0000-4000-8000-000000000001";
const TABLE_ID = "0a1b2c3d-0000-4000-8000-000000000002";
const field = (index: number, name: string, sqlColumn: string, type: DatasetField["type"], extra: Partial<DatasetField> = {}): DatasetField =>
  ({ fieldId: `0a1b2c3d-0000-4000-8000-00000000010${index}`, name, sqlColumn, type, required: false, unique: false, ...extra });
const ID = field(0, "Id", "id", "text", { required: true, unique: true });
const NAME = field(1, "Name", "name", "text");
const DONE = field(2, "Done", "done", "checkbox");
const TAGS = field(3, "Tags", "tags", "multi-select", { options: ["a", "b"] });
const ESTIMATE = field(4, "Estimate", "estimate", "number");
const definition: DatasetDefinition = {
  formatVersion: 1,
  datasetId: DATASET_ID,
  name: "Tasks",
  schemaPath: "Tasks/schema.sql",
  operationsPath: "Tasks/operations.js",
  tables: [{ tableId: TABLE_ID, name: "Tasks", sqlName: "tasks", primaryKey: "id", fields: [ID, NAME, DONE, TAGS, ESTIMATE] }],
  operations: [],
};
// The columns in another order than the definition's fields, as after a migration.
const TASKS_SQL = `CREATE TABLE tasks(estimate REAL, id TEXT PRIMARY KEY NOT NULL, done INTEGER CHECK (done IN (0,1)), extra TEXT,
  tags TEXT, name TEXT, _record_version INTEGER NOT NULL DEFAULT 1)`;

function commit(db: DatabaseSync, sql: string): { changeset: Uint8Array; columns: Record<string, string[]> } {
  const session = db.createSession();
  db.exec(sql);
  const changeset = session.changeset();
  session.close();
  const columns = { tasks: db.prepare('PRAGMA table_info("tasks")').all().map((row) => String(row.name)) };
  return { changeset, columns };
}

function facts(db: DatabaseSync, sql: string) {
  return [...datasetChangeFacts({ definition, ...commit(db, sql) })];
}

describe("dataset change facts", () => {
  function tasks(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec(TASKS_SQL);
    return db;
  }

  it("names every field of an added and a removed record, as the field's type reads it", () => {
    const db = tasks();
    const [added] = facts(db, `INSERT INTO tasks(id,name,done,tags,estimate,extra) VALUES('t1','Plan',1,'["a","b"]',2.5,'hidden')`);
    const values = { [ID.fieldId]: "t1", [NAME.fieldId]: "Plan", [DONE.fieldId]: true, [TAGS.fieldId]: ["a", "b"], [ESTIMATE.fieldId]: 2.5 };
    expect(added).toEqual({
      kind: "added", datasetId: DATASET_ID, tableId: TABLE_ID, recordId: "t1", version: 1,
      fields: definition.tables[0]!.fields.map(({ fieldId }) => ({ fieldId, previous: null, next: values[fieldId] })),
    });
    const [removed] = facts(db, "DELETE FROM tasks WHERE id='t1'");
    expect(removed).toEqual({
      kind: "removed", datasetId: DATASET_ID, tableId: TABLE_ID, recordId: "t1", version: 1,
      fields: definition.tables[0]!.fields.map(({ fieldId }) => ({ fieldId, previous: values[fieldId], next: null })),
    });
  });

  it("names only the changed fields of a changed record, with the new version", () => {
    const db = tasks();
    db.exec(`INSERT INTO tasks(id,name,done) VALUES('t1','Plan',0)`);
    expect(facts(db, `UPDATE tasks SET done=1, name='Ship', _record_version=_record_version+1 WHERE id='t1'`)).toEqual([{
      kind: "changed", datasetId: DATASET_ID, tableId: TABLE_ID, recordId: "t1", version: 2,
      fields: [
        { fieldId: NAME.fieldId, previous: "Plan", next: "Ship" },
        { fieldId: DONE.fieldId, previous: false, next: true },
      ],
    }]);
  });

  it("says nothing of a change that touched no approved field", () => {
    const db = tasks();
    db.exec(`INSERT INTO tasks(id,name) VALUES('t1','Plan')`);
    expect(facts(db, "UPDATE tasks SET extra='x', _record_version=2 WHERE id='t1'")).toEqual([]);
    expect(facts(db, "UPDATE tasks SET name='Plan' WHERE id='t1'")).toEqual([]);
  });

  it("reads a changed id as a removed record and an added one", () => {
    const db = tasks();
    db.exec(`INSERT INTO tasks(id,name) VALUES('t1','Plan')`);
    const changed = facts(db, "UPDATE tasks SET id='t2' WHERE id='t1'");
    expect(changed.map(({ kind, recordId }) => [kind, recordId]).sort()).toEqual([["added", "t2"], ["removed", "t1"]]);
  });

  it("reads a list's numbers only when they read back exactly", () => {
    const db = tasks();
    const [exact] = facts(db, `INSERT INTO tasks(id,tags) VALUES('t1','[1, 0.1, -2.5e3, "a", [true, null]]')`);
    expect(exact?.fields.find(({ fieldId }) => fieldId === TAGS.fieldId)?.next).toEqual([1, 0.1, -2500, "a", [true, null]]);
    for (const list of ["[9007199254740993]", "[1e400]", "[0.10000000000000000555]", "[1e-400]"]) {
      expect(() => facts(tasks(), `INSERT INTO tasks(id,tags) VALUES('t1','${list}')`), list).toThrow("cannot hold exactly");
    }
    const [notList] = facts(tasks(), `INSERT INTO tasks(id,tags) VALUES('t1','9007199254740993')`);
    expect(notList?.fields.find(({ fieldId }) => fieldId === TAGS.fieldId)?.next, "text that is not a list stays text").toBe("9007199254740993");
  });

  it("refuses a table the changeset keys by another column, or by several", () => {
    const refusal = "The changeset keys tasks by other columns than its approved primary key, id.";
    const byName = new DatabaseSync(":memory:");
    byName.exec("CREATE TABLE tasks(id TEXT NOT NULL, name TEXT PRIMARY KEY NOT NULL, done, tags, estimate)");
    expect(() => facts(byName, "INSERT INTO tasks VALUES('t1','Plan',0,NULL,NULL)")).toThrow(refusal);
    byName.exec("INSERT INTO tasks VALUES('t2','Ship',0,NULL,NULL)");
    expect(() => facts(byName, "UPDATE tasks SET done=1 WHERE name='Ship'")).toThrow(refusal);
    const composite = new DatabaseSync(":memory:");
    composite.exec("CREATE TABLE tasks(id TEXT NOT NULL, name TEXT NOT NULL, done, tags, estimate, PRIMARY KEY(id, name))");
    expect(() => facts(composite, "INSERT INTO tasks VALUES('t1','Plan',0,NULL,NULL); INSERT INTO tasks VALUES('t1','Ship',0,NULL,NULL)")).toThrow(refusal);
  });

  it("reads an integer a STRICT table stored as a real as that number", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY NOT NULL, name TEXT, done INTEGER, tags TEXT, estimate REAL) STRICT");
    const [added] = facts(db, "INSERT INTO tasks VALUES('t1','Plan',1,NULL,3)");
    expect(added?.fields.find(({ fieldId }) => fieldId === ESTIMATE.fieldId)?.next).toBe(3);
    expect(facts(db, "UPDATE tasks SET estimate=4 WHERE id='t1'")).toEqual([expect.objectContaining({
      kind: "changed", fields: [{ fieldId: ESTIMATE.fieldId, previous: 3, next: 4 }],
    })]);
  });

  it("keeps stored text that is not an array as text, and a checkbox outside 0 and 1 as stored", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY NOT NULL, name, done, tags, estimate)");
    const [added] = facts(db, `INSERT INTO tasks VALUES('t1', NULL, 7, 'not json', 3)`);
    expect(added?.fields.map(({ next }) => next)).toEqual(["t1", null, 7, "not json", 3]);
    expect(added?.version, "a table with no version column").toBeNull();
  });

  it("refuses what it cannot read exactly", () => {
    const db = tasks();
    const { changeset, columns } = commit(db, `INSERT INTO tasks(id,name) VALUES('t1','Plan')`);
    const refused = (input: Partial<Parameters<typeof datasetChangeFacts>[0]>) => () =>
      [...datasetChangeFacts({ definition, changeset, columns, ...input })];
    expect(refused({ columns: {} })).toThrow("do not match its changes");
    expect(refused({ columns: { tasks: columns.tasks!.slice(1) } })).toThrow("do not match its changes");
    expect(refused({ columns: { tasks: columns.tasks!.map((name) => (name === "tags" ? "labels" : name)) } })).toThrow("lack an approved field");
    expect(refused({ columns: { tasks: [...columns.tasks!.slice(0, -1), "NAME"] } })).toThrow("do not match its changes");
    expect(refused({ definition: { ...definition, tables: [{ ...definition.tables[0]!, sqlName: "other" }] } })).toThrow("does not have");

    const blob = new DatabaseSync(":memory:");
    blob.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY NOT NULL, name, done, tags, estimate)");
    expect(() => facts(blob, "INSERT INTO tasks VALUES('t1', x'00', 0, NULL, NULL)")).toThrow("holds bytes");
    expect(() => facts(blob, "INSERT INTO tasks VALUES('t2', NULL, 0, NULL, 9007199254740993)")).toThrow("cannot hold exactly");
  });
});

describe("dataset worker prepare result", () => {
  vi.setConfig({ testTimeout: 30_000 });
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");

  it("names each approved table's columns in database order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dohc-change-facts-"));
    const worker = await openPersistentAppBackend({
      directory, schemaSql: `${TASKS_SQL};`, tables: ["tasks"], cursor: { revision: 0, digest: hash("initial") },
      scope: { workspaceId: "workspace", datasetId: "dataset", hostEpoch: "epoch-1", approvedRevisionHash: hash("approved") },
    });
    try {
      const prepared = await worker.prepare({
        expected: { revision: 0, digest: hash("initial") }, operation: "add", input: {}, caller: { kind: "owner" }, nowMs: 1, requestId: "request",
        source: "globalThis.operations={add(ctx){ctx.db.execute(\"INSERT INTO tasks(id,name,done) VALUES('t1','Plan',1)\");return null}}",
      });
      expect(prepared.columns).toEqual({ tasks: ["estimate", "id", "done", "extra", "tags", "name", "_record_version"] });
      expect([...datasetChangeFacts({ definition, changeset: prepared.changeset, columns: prepared.columns })]).toMatchObject([
        { kind: "added", recordId: "t1", version: 1, fields: expect.arrayContaining([{ fieldId: DONE.fieldId, previous: null, next: true }]) },
      ]);
      await worker.discard(prepared.proposalId);
      const read = await worker.prepare({
        expected: { revision: 0, digest: hash("initial") }, operation: "list", input: {}, caller: { kind: "owner" }, nowMs: 1, requestId: "read", readOnly: true,
        source: "globalThis.operations={list(ctx){return ctx.db.query('SELECT id FROM tasks')}}",
      });
      expect(read.columns, "a read names the columns too").toEqual(prepared.columns);
    } finally {
      await worker.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  });

  it.each([
    ["no columns", undefined],
    ["a list", [["id"]]],
    ["another table", { tasks: ["id"], other: ["id"] }],
    ["a table left out", {}],
    ["an empty list", { tasks: [] }],
    ["a name that is not text", { tasks: ["id", 7] }],
    ["an empty name", { tasks: ["id", ""] }],
  ])("refuses a prepare result with %s as a protocol error", async (_case, columns) => {
    const directory = await mkdtemp(join(tmpdir(), "dohc-change-facts-"));
    // The real worker, with its prepare reply's columns replaced.
    const launch: AppRuntimeLauncher = (options) => {
      const child = spawn(process.execPath, [options.entryPath], { cwd: options.cwd, env: options.env, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced", windowsHide: true });
      child.on("message", (message) => {
        const reply = message as { ok: boolean; result?: Record<string, unknown> };
        if (reply.ok && reply.result && "proposalId" in reply.result) {
          if (columns === undefined) delete reply.result.columns;
          else reply.result.columns = columns;
        }
        options.onMessage(reply);
      });
      child.on("error", options.onError);
      child.on("close", options.onExit);
      return { postMessage(message) { child.send(message as object, (error) => { if (error) options.onError(error); }); }, kill() { child.kill("SIGKILL"); } };
    };
    const worker = await openPersistentAppBackend({
      directory, schemaSql: `${TASKS_SQL};`, tables: ["tasks"], cursor: { revision: 0, digest: hash("initial") },
      scope: { workspaceId: "workspace", datasetId: "dataset", hostEpoch: "epoch-1", approvedRevisionHash: hash("approved") },
    }, { launch });
    try {
      const prepared = worker.prepare({
        expected: { revision: 0, digest: hash("initial") }, operation: "list", input: {}, caller: { kind: "owner" }, nowMs: 1, requestId: "read", readOnly: true,
        source: "globalThis.operations={list(ctx){return null}}",
      });
      await expect(prepared).rejects.toBeInstanceOf(PersistentRuntimeError);
      await expect(prepared).rejects.toMatchObject({ code: "worker_protocol" });
    } finally {
      await worker.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  });
});
