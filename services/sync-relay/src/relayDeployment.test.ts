import { DatabaseSync, backup } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, renameSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRelayDeployment, openRelayDeployment } from "./relayDeployment";
import { openSyncRelayStorage } from "./storage";
import { RelayWriteOwner } from "./storage/writeOwner";
import type { SqliteDb } from "./storage/types";
import { guardRelayResponses } from "./relayResponseStanding";
import { createDeviceHostCredential } from "./deviceHostCredential";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import type { StorageContext } from "./storage/context";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-continuity #%-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const input = { configPath: join(root, "deployment.json"), relayPath: join(root, "volume", "relay.sqlite"), continuityDirectory: join(root, "continuity") };
  initializeRelayDeployment(input);
  return { ...input, root };
}
function read(path: string, table: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(`SELECT * FROM ${table}`).get()!; } finally { db.close(); }
}

describe("relay deployment continuity", () => {
  it("owns storage and maintenance exclusively and keeps history stable across restart", () => {
    const f = fixture(), first = openRelayDeployment(f.configPath);
    try {
      expect(() => openRelayDeployment(f.configPath)).toThrow();
      const contender = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./relayDeploymentCrash.fixture.ts", import.meta.url)), f.configPath, "contender"],
        { encoding: "utf8", windowsHide: true, timeout: 20_000 });
      expect(contender.error).toBeUndefined();
      expect(contender.status, contender.stderr).toBe(0);
      expect(() => openSyncRelayStorage(f.relayPath)).toThrow(/configured relay/);
      expect(first.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "u", createdAtMs: 1 })).toBe("created");
    } finally { first.storage.close(); }
    expect(first.history.reconciled).toBe(false);
    const second = openRelayDeployment(f.configPath);
    try {
      expect(second.history.namespace).toBe(first.history.namespace);
      expect(second.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "u", createdAtMs: 1 })).toBe("owned");
    } finally { second.storage.close(); }
  });

  it("refuses a permission-only rollback with no new journal event", async () => {
    const f = fixture(), current = openRelayDeployment(f.configPath);
    const credential = createDeviceHostCredential("host-one", parseHostEpoch(1));
    const backupPath = join(f.root, "backup.sqlite");
    try {
      expect(current.storage.provisionDeviceHostCredential({ credential, updatedAtMs: 1 }).ok).toBe(true);
      const source = new DatabaseSync(f.relayPath, { readOnly: true });
      try { await backup(source, backupPath); } finally { source.close(); }
      const before = read(f.relayPath,"sync_relay_continuity").stamp;
      expect(current.storage.revokeDeviceHostCredential({ hostId: credential.hostId, instanceId: credential.instanceId, updatedAtMs: 2 }).ok).toBe(true);
      expect(read(f.relayPath,"sync_relay_continuity").stamp).not.toBe(before);
    } finally { current.storage.close(); }
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(f.relayPath + suffix)) renameSync(f.relayPath + suffix, f.relayPath + suffix + ".preserved");
    copyFileSync(backupPath, f.relayPath);
    expect(() => openRelayDeployment(f.configPath)).toThrow(/continuity/);
  });

  it.each(["relay", "continuity", "lock"])("refuses a missing %s file without recreating it", missing => {
    const f = fixture();
    const path = missing === "relay" ? f.relayPath : join(f.continuityDirectory, `${missing}.sqlite`);
    renameSync(path, path + ".preserved");
    expect(() => openRelayDeployment(f.configPath)).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it("refuses foreign metadata and leaves the lock available for inspection", () => {
    const f = fixture(), side = new DatabaseSync(join(f.continuityDirectory, "continuity.sqlite"));
    side.exec("UPDATE continuity SET namespace='foreign'"); side.close();
    expect(() => openRelayDeployment(f.configPath)).toThrow(/continuity/);
    const lock = new DatabaseSync(join(f.continuityDirectory, "lock.sqlite"));
    try { lock.exec("BEGIN EXCLUSIVE; ROLLBACK"); } finally { lock.close(); }
  });

  it("does not initialize over existing data or put continuity inside a relay volume", () => {
    const f = fixture();
    expect(() => initializeRelayDeployment(f)).toThrow();
    const other = join(f.root, "nested"); mkdirSync(other);
    expect(() => initializeRelayDeployment({ configPath: join(f.root,"new.json"), relayPath: join(other,"relay.sqlite"), continuityDirectory: join(other,"continuity") })).toThrow();
    expect(existsSync(join(other, "continuity"))).toBe(false);
  });

  it("read snapshots do not reserve mutation stamps", () => {
    const f = fixture(), current = openRelayDeployment(f.configPath);
    try {
      const side = join(f.continuityDirectory,"continuity.sqlite"), before = read(side,"continuity");
      expect(() => current.storage.getWorkspaceBootstrap("missing")).toThrow(/does not exist/);
      current.storage.getLiveHostControl();
      expect(read(side,"continuity")).toEqual(before);
    } finally { current.storage.close(); }
  });

  it("a no-op write and unchanged schema restart leave continuity unchanged", () => {
    const f = fixture(), current = openRelayDeployment(f.configPath);
    try {
      current.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "u", createdAtMs: 1 });
      const side = join(f.continuityDirectory,"continuity.sqlite"), before = read(side,"continuity");
      expect(current.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "u", createdAtMs: 2 })).toBe("owned");
      expect(read(side,"continuity")).toEqual(before);
    } finally { current.storage.close(); }
    const side = join(f.continuityDirectory,"continuity.sqlite"), before = read(side,"continuity");
    const reopened = openRelayDeployment(f.configPath); reopened.storage.close();
    expect(read(side,"continuity")).toEqual(before);
  });

  it("reopens after a deferred constraint rolls back without reusing its reserved stamp", () => {
    const f = fixture(), current = openRelayDeployment(f.configPath);
    const storage = current.storage as StorageContext;
    const side = join(f.continuityDirectory, "continuity.sqlite");
    try {
      storage.tx(() => storage.db.exec("CREATE TABLE test_parent(id INTEGER PRIMARY KEY); CREATE TABLE test_child(parent_id INTEGER REFERENCES test_parent(id) DEFERRABLE INITIALLY DEFERRED)"));
      const before = read(side, "continuity");
      expect(() => storage.tx(() => storage.db.exec("INSERT INTO test_child VALUES(17)"))).toThrow(/FOREIGN KEY/);
      expect(storage.db.prepare("SELECT * FROM test_child").all()).toHaveLength(0);
      expect(storage.unavailable.aborted).toBe(true);
      expect(read(side, "continuity").expected_stamp).toBe(before.expected_stamp);
      expect(Number(read(side, "continuity").next_stamp)).toBeGreaterThan(Number(before.next_stamp));
    } finally { storage.close(); }
    const reopened = openRelayDeployment(f.configPath);
    try {
      expect(reopened.storage.claimWorkspace({ workspaceId: "after-rollback", ownerUserId: "owner", createdAtMs: 1 })).toBe("created");
    } finally { reopened.storage.close(); }
  });

  it("refuses current-file snapshots after storage retirement", () => {
    let owner!: RelayWriteOwner;
    const root = mkdtempSync(join(tmpdir(), "relay-read-standing-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "relay.sqlite");
    new DatabaseSync(path).close();
    const storage = openSyncRelayStorage(path, {}, db => owner = new RelayWriteOwner(db));
    try {
      owner.invalidate();
      expect(() => storage.readCurrentFileState({ workspaceId: "w", versionId: "main", selectorPaths: ["docs"], limit: 1 })).toThrow(/unavailable/);
    } finally { storage.close(); }
  });

  it.each(["before-commit", "after-commit"])("retains the actual production interruption at %s", boundary => {
    const f = fixture();
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./relayDeploymentCrash.fixture.ts", import.meta.url)), f.configPath, boundary],
      { encoding: "utf8", windowsHide: true, timeout: 20_000 });
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe("");
    expect(child.status).toBe(boundary === "before-commit" ? 81 : 82);
    if (boundary === "before-commit") expect(() => openRelayDeployment(f.configPath)).toThrow(/continuity/);
    else {
      const restarted = openRelayDeployment(f.configPath);
      try { expect(restarted.storage.claimWorkspace({ workspaceId: "interrupted", ownerUserId: "owner", createdAtMs: 2 })).toBe("owned"); }
      finally { restarted.storage.close(); }
    }
  });
});

describe("relay write and response lifetime", () => {
  it("retires after an uncertain rollback and does not cancel its reservation", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("CREATE TABLE work(value INTEGER); CREATE TABLE sync_relay_continuity(singleton INTEGER,stamp INTEGER); INSERT INTO sync_relay_continuity VALUES(1,0)");
    let cancelled = false;
    const db: SqliteDb = { prepare: sql => raw.prepare(sql) as unknown as ReturnType<SqliteDb["prepare"]>, close: () => raw.close(),
      exec(sql) { if (sql === "COMMIT") throw new Error("commit failed"); raw.exec(sql); if (sql === "ROLLBACK") throw new Error("lost rollback result"); } };
    const owner = new RelayWriteOwner(db, { reserve: () => 1, cancel: () => { cancelled = true; }, close() {} });
    try {
      expect(() => owner.write(() => raw.exec("INSERT INTO work VALUES(1)"))).toThrow(/commit failed/);
      expect(owner.unavailable.aborted).toBe(true);
      expect(cancelled).toBe(false);
    } finally { owner.close(); }
  });

  it("fences an uncertain COMMIT even when SQLite committed before throwing", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("CREATE TABLE work(value INTEGER); CREATE TABLE sync_relay_continuity(singleton INTEGER,stamp INTEGER); INSERT INTO sync_relay_continuity VALUES(1,0)");
    let cancelled = false;
    const db: SqliteDb = { prepare: sql => raw.prepare(sql) as unknown as ReturnType<SqliteDb["prepare"]>, close: () => raw.close(),
      exec(sql) { raw.exec(sql); if (sql === "COMMIT") throw new Error("lost COMMIT result"); } };
    const owner = new RelayWriteOwner(db, { reserve: () => 1, cancel: () => { cancelled = true; }, close() {} });
    try {
      const standing = owner.captureStanding();
      expect(() => owner.write(() => raw.exec("INSERT INTO work VALUES(1)"))).toThrow(/lost COMMIT/);
      expect(raw.prepare("SELECT * FROM work").all()).toHaveLength(1);
      expect(raw.prepare("SELECT stamp FROM sync_relay_continuity").get()?.stamp).toBe(1);
      expect(cancelled).toBe(false);
      expect(standing).toThrow(/unavailable/);
      expect(() => owner.write(() => {})).toThrow(/unavailable/);
    } finally { owner.close(); }
  });

  it("rolls back a failed callback and refuses transaction nesting", () => {
    const raw = new DatabaseSync(":memory:"); raw.exec("CREATE TABLE work(value INTEGER)");
    const owner = new RelayWriteOwner(raw as unknown as SqliteDb);
    try {
      expect(() => owner.write(() => { raw.exec("INSERT INTO work VALUES(1)"); owner.write(() => {}); })).toThrow(/Nested/);
      expect(raw.prepare("SELECT * FROM work").all()).toHaveLength(0);
      expect(owner.unavailable.aborted).toBe(false);
    } finally { owner.close(); }
  });

  it("suppresses an authorized response that finishes after its owner retires", async () => {
    const raw = new DatabaseSync(":memory:"), owner = new RelayWriteOwner(raw as unknown as SqliteDb);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const handler = guardRelayResponses(owner, async () => { await pending; return Response.json({ secret: "private" }); });
    const result = handler(new Request("https://relay.test/share"));
    owner.invalidate(); release();
    expect((await result).status).toBe(503);
    owner.close();
  });

  it("cancels an established stream before forwarding a later chunk", async () => {
    const raw = new DatabaseSync(":memory:"), owner = new RelayWriteOwner(raw as unknown as SqliteDb);
    let cancelled = false;
    const handler = guardRelayResponses(owner, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    const response = await handler(new Request("https://relay.test/blob"));
    const read = response.body!.getReader().read();
    owner.invalidate();
    await expect(read).rejects.toThrow(/unavailable/);
    expect(cancelled).toBe(true);
    owner.close();
  });
});

it("includes a claimed email grant in the independent mutation record", () => {
  const f = fixture(), { storage } = openRelayDeployment(f.configPath);
  try {
    storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
    storage.createShare({
      share: { shareId: "s", workspaceId: "w", granterUserId: "owner", selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }), createdAtMs: 1 },
      grant: { grantId: "g", shareId: "s", principalKind: "email", principalUserId: null, principalEmail: "reader@example.test",
        access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null },
    });
    const side = join(f.continuityDirectory, "continuity.sqlite");
    const before = Number(read(side, "continuity").expected_stamp);
    expect(storage.claimPendingSharesForEmail("reader@example.test", "reader")).toBe(1);
    expect(storage.getShareGrant("g")?.principalUserId).toBe("reader");
    const after = read(side, "continuity");
    expect(Number(after.expected_stamp)).toBeGreaterThan(before);
    expect(read(f.relayPath, "sync_relay_continuity").stamp).toBe(after.expected_stamp);
    expect(storage.claimPendingSharesForEmail("reader@example.test", "reader")).toBe(0);
    expect(read(side, "continuity")).toEqual(after);
  } finally { storage.close(); }
});
