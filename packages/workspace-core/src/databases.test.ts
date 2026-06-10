import { describe, expect, it } from "vitest";
import {
  classifyDatabaseFile,
  createDatabaseOperation,
  databaseOpLogPath,
  databaseSyncStrategy,
  isDatabaseMaterializationPoint,
  isDatabaseSidecar,
  serializeDatabaseOperation,
  shouldSyncAsStandaloneFile,
} from "./databases";

describe("classifyDatabaseFile", () => {
  it("treats a user .sqlite/.db outside .dohc as visible user data", () => {
    expect(classifyDatabaseFile("finance/wallet.sqlite")).toBe("visible-user");
    expect(classifyDatabaseFile("data/contacts.db")).toBe("visible-user");
    expect(classifyDatabaseFile("notes/log.sqlite3")).toBe("visible-user");
  });

  it("treats databases under .dohc as hidden internal caches", () => {
    expect(classifyDatabaseFile(".dohc/databases/index.sqlite")).toBe("hidden-internal");
    expect(classifyDatabaseFile(".dohc/cache/thumbs.db")).toBe("hidden-internal");
  });

  it("treats WAL/SHM/journal sidecars as sidecars regardless of location", () => {
    expect(classifyDatabaseFile("finance/wallet.sqlite-wal")).toBe("sidecar");
    expect(classifyDatabaseFile("finance/wallet.sqlite-shm")).toBe("sidecar");
    expect(classifyDatabaseFile("data/contacts.db-journal")).toBe("sidecar");
    expect(isDatabaseSidecar("finance/wallet.sqlite-wal")).toBe(true);
    expect(isDatabaseSidecar("finance/wallet.sqlite")).toBe(false);
  });

  it("is not fooled by db-like substrings in non-db names", () => {
    expect(classifyDatabaseFile("notes/database-design.md")).toBe("not-a-database");
    expect(classifyDatabaseFile("data/walmart.csv")).toBe("not-a-database");
  });
});

describe("databaseSyncStrategy (raw bytes are never CRDT-synced)", () => {
  it("syncs a visible user database via its operation log, not raw bytes", () => {
    expect(databaseSyncStrategy("finance/wallet.sqlite")).toBe("operation-log");
  });

  it("never syncs sidecars or hidden internal databases as files", () => {
    expect(databaseSyncStrategy("finance/wallet.sqlite-wal")).toBe("ignore");
    expect(databaseSyncStrategy(".dohc/databases/index.sqlite")).toBe("ignore");
  });

  it("syncs ordinary files as normal file content", () => {
    expect(databaseSyncStrategy("notes/today.md")).toBe("file-content");
  });

  it("never treats a sidecar (or a db's raw bytes) as a standalone synced file", () => {
    expect(shouldSyncAsStandaloneFile("finance/wallet.sqlite-wal")).toBe(false);
    expect(shouldSyncAsStandaloneFile("finance/wallet.sqlite")).toBe(false);
    expect(shouldSyncAsStandaloneFile("notes/today.md")).toBe(true);
  });
});

describe("database operation log", () => {
  it("records a structured row edit as an inspectable, append-only operation", () => {
    const op = createDatabaseOperation({
      operationId: "op_1",
      databasePath: "finance/wallet.sqlite",
      table: "transactions",
      op: "update",
      rowId: "txn_001",
      payload: { category: "Groceries" },
      version: 2,
      appliedAt: 1_700_000_000_000,
      author: { kind: "user", userId: "local" },
    });
    expect(op.op).toBe("update");
    expect(op.rowId).toBe("txn_001");
    expect(op.version).toBe(2);
    expect(op.payload).toEqual({ category: "Groceries" });

    // Serializes to one inspectable JSON line (JSONL append).
    const line = serializeDatabaseOperation(op);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ operationId: "op_1", op: "update", version: 2 });
  });

  it("derives a stable, inspectable op-log path under .dohc for a visible db", () => {
    const p = databaseOpLogPath("finance/wallet.sqlite");
    expect(p.startsWith(".dohc/")).toBe(true);
    expect(p.endsWith(".jsonl")).toBe(true);
    // Deterministic per database path.
    expect(databaseOpLogPath("finance/wallet.sqlite")).toBe(p);
    expect(databaseOpLogPath("data/contacts.db")).not.toBe(p);
  });
});

describe("materialization points", () => {
  it("materializes a visible db only at a safe point — import, explicit save, or close", () => {
    expect(isDatabaseMaterializationPoint("import-complete")).toBe(true);
    expect(isDatabaseMaterializationPoint("explicit-save")).toBe(true);
    expect(isDatabaseMaterializationPoint("close")).toBe(true);
  });

  it("never materializes mid-write or while the WAL is active", () => {
    expect(isDatabaseMaterializationPoint("mid-write")).toBe(false);
    expect(isDatabaseMaterializationPoint("wal-active")).toBe(false);
  });
});
