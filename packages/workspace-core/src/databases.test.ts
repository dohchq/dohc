import { describe, expect, it } from "vitest";
import {
  classifyDatabaseFile,
  isDatabaseFile,
  sidecarBasePath,
  databaseOpLogPath,
  databaseSyncStrategy,
  isDatabaseSidecar,
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
    for (const name of [".DOHC", ".Dohc", ".do‍hc"]) {
      expect(classifyDatabaseFile(`nested/${name}/engine/store.db`)).toBe("hidden-internal");
      expect(databaseSyncStrategy(`nested/${name}/engine/store.db`)).toBe("ignore");
    }
    expect(classifyDatabaseFile("my-dohc/notes.db")).toBe("visible-user");
  });

  it("treats WAL/SHM/journal sidecars as sidecars regardless of location", () => {
    expect(classifyDatabaseFile("finance/wallet.sqlite-wal")).toBe("sidecar");
    expect(classifyDatabaseFile("finance/wallet.sqlite-shm")).toBe("sidecar");
    expect(classifyDatabaseFile("data/contacts.db-journal")).toBe("sidecar");
    expect(classifyDatabaseFile("notes/log.sqlite3-wal")).toBe("sidecar");
    expect(isDatabaseSidecar("finance/wallet.sqlite-wal")).toBe(true);
    expect(isDatabaseSidecar("finance/wallet.sqlite")).toBe(false);
  });

  it("exposes the single-source helpers the watcher collapse uses", () => {
    // .sqlite3 once diverged between this module and the watcher's local copy
    // of the regex — these helpers are the watcher's rules now.
    expect(isDatabaseFile("notes/log.sqlite3")).toBe(true);
    expect(isDatabaseFile("notes/log.sqlite3-wal")).toBe(false);
    expect(sidecarBasePath("notes/log.sqlite3-wal")).toBe("notes/log.sqlite3");
    expect(sidecarBasePath("finance/wallet.sqlite-journal")).toBe("finance/wallet.sqlite");
    expect(sidecarBasePath("notes/today.md")).toBeNull();
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
});

describe("database operation log", () => {
  it("derives a stable, inspectable op-log path under .dohc for a visible db", () => {
    const p = databaseOpLogPath("finance/wallet.sqlite");
    expect(p.startsWith(".dohc/")).toBe(true);
    expect(p.endsWith(".jsonl")).toBe(true);
    // Deterministic per database path.
    expect(databaseOpLogPath("finance/wallet.sqlite")).toBe(p);
    expect(databaseOpLogPath("data/contacts.db")).not.toBe(p);
  });

  it("never maps two database paths to the same op log (slug ambiguity)", () => {
    // Both slug to a_b.sqlite — the path tag must keep their logs separate, or
    // unrelated operations and versions would interleave in one log.
    expect(databaseOpLogPath("a/b.sqlite")).not.toBe(databaseOpLogPath("a_b.sqlite"));
  });
});
