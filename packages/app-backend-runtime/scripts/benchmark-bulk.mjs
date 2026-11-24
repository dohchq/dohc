import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { evaluate } from "../src/guest.ts";
import { DEFAULT_LIMITS } from "../src/protocol.ts";
import {
  bulkFixture,
  importInput,
  insertSql,
  journalParameters,
  reportSql,
  schemaSql,
} from "./bulk-fixture.mjs";

const MiB = 2 ** 20;
const nodes = (value) =>
  value && typeof value === "object"
    ? 1 + Object.values(value).reduce((sum, item) => sum + nodes(item), 0)
    : 1;

async function sample(operation, memoryBytes, standard) {
  const directory = mkdtempSync(join(tmpdir(), "dohc-dataset-bulk-"));
  const path = join(directory, "benchmark.sqlite");
  const db = new DatabaseSync(path, { enableDoubleQuotedStringLiterals: false });
  const run = async (name, limits) => {
    const input = name === "importStatement" ? importInput : null;
    const inputJson = JSON.stringify(input);
    db.exec(name === "importStatement" ? "BEGIN IMMEDIATE" : "BEGIN");
    const writable = name === "importStatement";
    const session = writable ? db.createSession() : undefined;
    try {
      const wall = performance.now();
      const cpu = process.threadCpuUsage();
      const { resultJson } = await evaluate(
        db,
        {
          source: bulkFixture,
          operation: name,
          tables: ["journal_lines"],
          inputJson,
          callerJson: '{"kind":"owner"}',
          nowMs: 0,
          requestId: "benchmark",
          secret: "benchmark",
          readOnly: !writable,
          files: [],
          limits,
        },
        { persistentConnection: true },
      );
      db.setAuthorizer(null);
      const changesetBytes = session?.changeset().byteLength ?? 0;
      db.exec(writable ? "COMMIT" : "ROLLBACK");
      const elapsedCpu = process.threadCpuUsage(cpu);
      const wallMs = performance.now() - wall;
      const result = JSON.parse(resultJson);
      assert.equal(result.length, writable ? 2500 : 10000);
      return {
        inputBytes: Buffer.byteLength(inputJson),
        inputNodes: nodes(input),
        requestBytes: Buffer.byteLength(
          JSON.stringify({
            revision: 1,
            revisionSha256: "0".repeat(64),
            operationId: "00000000-0000-4000-8000-000000000001",
            idempotencyKey: "benchmark",
            input,
          }),
        ),
        resultBytes: Buffer.byteLength(resultJson),
        resultNodes: nodes(result),
        statements: writable ? importInput.rows.length : 1,
        queryRows: writable ? 0 : result.length,
        changesetBytes,
        cpuMs: (elapsedCpu.user + elapsedCpu.system) / 1000,
        wallMs,
      };
    } finally {
      session?.close();
      db.setAuthorizer(null);
      if (db.isTransaction) db.exec("ROLLBACK");
    }
  };
  try {
    db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; ${schemaSql}`,
    );
    const probe = {
      ...DEFAULT_LIMITS,
      inputBytes: 4 * MiB,
      resultBytes: 8 * MiB,
      queryBytes: 8 * MiB,
      queryRows: 20000,
      statements: 5000,
      evaluationMs: 5000,
    };
    if (operation !== "importStatement") {
      await run("importStatement", { ...probe, memoryBytes: 64 * MiB });
      db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA shrink_memory;");
    }
    const sqliteHardHeapBytes = db
      .prepare(`PRAGMA hard_heap_limit=${64 * MiB}`)
      .get().hard_heap_limit;
    assert.equal(sqliteHardHeapBytes, 64 * MiB);
    const sqliteMemstatus = !db
      .prepare("PRAGMA compile_options")
      .all()
      .some((row) => row.compile_options === "DEFAULT_MEMSTATUS=0");
    return {
      operation,
      wasmBytes: memoryBytes,
      sqliteHardHeapBytes,
      sqliteMemstatus,
      ...(await run(operation, standard ? DEFAULT_LIMITS : { ...probe, memoryBytes })),
      databaseBytes: statSync(path).size + statSync(`${path}-wal`).size,
    };
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function sqliteHeap() {
  const directory = mkdtempSync(join(tmpdir(), "dohc-dataset-bulk-heap-"));
  try {
    const path = join(directory, "benchmark.sqlite");
    const query = (sql) =>
      execFileSync("sqlite3", ["-batch", "-bail", path], {
        input: sql,
        encoding: "utf8",
        maxBuffer: 4 * MiB,
        stdio: ["pipe", "pipe", "pipe"],
      });
    const heap = (output) => Number(/Memory Used:\s+\d+\s+\(max\s+(\d+)\)/.exec(output)?.[1]);
    const options =
      "PRAGMA hard_heap_limit=67108864; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;";
    const insert = importInput.rows
      .map((row) => {
        const params = journalParameters(row).values();
        return (
          insertSql.replaceAll("?", () => {
            const value = params.next().value;
            return typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value);
          }) + ";"
        );
      })
      .join("\n");
    const changeset = join(directory, "import.changeset").replaceAll("\\", "/");
    const imported = query(
      `${options} PRAGMA journal_mode=WAL; ${schemaSql}\n.session open main bulk\n.session attach journal_lines\nBEGIN IMMEDIATE;\n${insert}\n.session changeset ${JSON.stringify(changeset)}\nCOMMIT;\n.stats\n`,
    );
    const report = query(`${options}\n.headers off\n${reportSql};\n.stats\n`);
    assert.ok(heap(imported) > 0 && heap(report) > 0, "SQLite CLI did not report heap statistics");
    assert.throws(
      () => query("PRAGMA hard_heap_limit=131072; SELECT length(randomblob(4194304));"),
      /out of memory/i,
    );
    return {
      sqliteCliVersion: query("SELECT sqlite_version();").trim(),
      importHeapHighWaterBytes: heap(imported),
      reportHeapHighWaterBytes: heap(report),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[2]) {
  const [, , operation, wasmMiB, mode] = process.argv;
  console.log(JSON.stringify(await sample(operation, Number(wasmMiB) * MiB, mode === "standard")));
} else {
  const child = (operation, wasmMiB, mode = "probe") =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [fileURLToPath(import.meta.url), operation, String(wasmMiB), mode],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  const minimum = (sample, low, high) => {
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      try {
        sample(mid);
        high = mid;
      } catch {
        low = mid + 1;
      }
    }
    return low;
  };
  for (const operation of ["importStatement", "trialBalance"]) {
    const samples = Array.from({ length: 5 }, () => child(operation, 24));
    const minimumWasmMiB = minimum((size) => child(operation, size), 16, 24);
    let standard;
    try {
      child(operation, 24, "standard");
      standard = "accepted";
    } catch (error) {
      standard = error.stderr
        .toString()
        .split(/\r?\n/)
        .find((line) => /^(?:\w*Error):/.test(line));
    }
    console.log(JSON.stringify({ samples, minimumWasmMiB, standard }, null, 2));
  }
  console.log(JSON.stringify(sqliteHeap(), null, 2));
}
