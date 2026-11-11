import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { openSyncRelayStorage } from "../storage";
import { openEmptyRelayTestStorage } from "./emptyRelayStorage";
import { closeTestStorage, closeTestStorages, inspectDatabase, reopenTestStorage, storagePath, testStorage } from "./index";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function path(name: string) {
  const root = mkdtempSync(join(tmpdir(), "dohc-empty-relay-test-"));
  roots.push(root);
  return join(root, name, "relay.sqlite");
}

it("has the fresh schema and initial rows, with independent durable writes and normal WAL settings", () => {
  const freshPath = path("fresh"), firstPath = path("first"), secondPath = path("second");
  const fresh = openSyncRelayStorage(freshPath), first = openEmptyRelayTestStorage(firstPath), second = openEmptyRelayTestStorage(secondPath);
  const databases = [freshPath, firstPath, secondPath].map(file => new DatabaseSync(file));
  try {
    const [original, one, two] = databases;
    const schema = (db: DatabaseSync) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
    expect(schema(one!)).toEqual(schema(original!));
    expect(schema(two!)).toEqual(schema(original!));
    const tables = original!.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
    for (const { name } of tables) {
      const rows = (db: DatabaseSync) => db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all()
        .map(({ completed_at_ms: _timestamp, ...row }) => row);
      expect(rows(one!)).toEqual(rows(original!));
      expect(rows(two!)).toEqual(rows(original!));
    }
    for (const db of databases) {
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    }
    one!.prepare("INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms) VALUES ('one','owner',1)").run();
    expect(two!.prepare("SELECT * FROM sync_relay_workspaces").all()).toEqual([]);
    expect(original!.prepare("SELECT * FROM sync_relay_workspaces").all()).toEqual([]);
  } finally {
    for (const db of databases) db.close();
    fresh.close(); first.close(); second.close();
  }
  const reopened = openSyncRelayStorage(firstPath), read = new DatabaseSync(firstPath);
  try { expect(read.prepare("SELECT workspace_id FROM sync_relay_workspaces").all()).toEqual([{workspace_id: "one"}]); }
  finally { read.close(); reopened.close(); }
  expect(() => openEmptyRelayTestStorage(firstPath)).toThrow(/EEXIST/);
});

it("retains configured storage validation and permits retry after an open failure", () => {
  const target = path("invalid");
  expect(() => openEmptyRelayTestStorage(target, {workspaceQuotaBytes: 0})).toThrow(/workspaceQuotaBytes/);
  expect(existsSync(target)).toBe(false);
  openEmptyRelayTestStorage(target, {workspaceQuotaBytes: 1024}).close();
});

it("refuses an orphaned WAL without creating a database or changing the WAL", () => {
  const target = path("orphaned-wal"), wal = `${target}-wal`, bytes = Buffer.from("leftover WAL");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(wal, bytes);
  expect(() => openEmptyRelayTestStorage(target).close()).toThrow(/existing WAL/);
  expect(existsSync(target)).toBe(false);
  expect(readFileSync(wal)).toEqual(bytes);
});

it("registers fresh fixtures, preserves their writes on reopen, and removes them after closing", async () => {
  const storage = await testStorage(), file = storagePath(storage);
  try {
    inspectDatabase(file).exec("INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms) VALUES ('saved','owner',1)");
    closeTestStorage(storage);
    const reopened = reopenTestStorage(file);
    expect(storagePath(reopened)).toBe(file);
    expect(inspectDatabase(file).prepare("SELECT workspace_id FROM sync_relay_workspaces").all()).toEqual([{workspace_id: "saved"}]);
  } finally { await closeTestStorages(); }
  expect(existsSync(file)).toBe(false);
});
