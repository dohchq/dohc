import { DatabaseSync, backup } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, renameSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import { acquireSupervisorOwnership } from "../../../packages/app-backend-runtime/src/worker-ownership";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-continuity #%-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const input = { configPath: join(root, "deployment.json"), relayPath: join(root, "volume", "relay.sqlite"), continuityDirectory: join(root, "continuity") };
  initializeRelayDeployment(input);
  return { ...input, root };
}
function read(path: string, table: string, bigInts = false) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const query = db.prepare(`SELECT * FROM ${table}`);
    query.setReadBigInts(bigInts);
    return query.get()!;
  } finally { db.close(); }
}

// tsx compiles each fixture child on startup; under load that took over 20 s.
// 45 s matches main.integration's tsx startup bound, and each test allows its
// children plus 10 s.
const TSX_CHILD_TIMEOUT_MS = 45_000;

describe("relay deployment continuity", () => {
  it("reuses its private dataset root and reclaims crashed preview directories on restart",async()=>{
    const f=fixture(),first=openRelayDeployment(f.configPath);
    let orphan:string;
    try {
      mkdirSync(first.datasetDirectory,{recursive:true});
      const ownership=await acquireSupervisorOwnership(first.datasetDirectory);
      try {orphan=await ownership.createDirectory();writeFileSync(join(orphan,"report.jsonl"),"private preview");}
      finally {ownership.close();}
    }finally{first.storage.close();}
    expect(existsSync(orphan!)).toBe(true);
    const second=openRelayDeployment(f.configPath);
    try {
      expect(second.datasetDirectory).toBe(first.datasetDirectory);
      const ownership=await acquireSupervisorOwnership(second.datasetDirectory);
      try {expect(existsSync(orphan!)).toBe(false);expect(existsSync(f.relayPath)).toBe(true);}
      finally{ownership.close();}
      expect(existsSync(second.datasetDirectory)).toBe(true);
    }finally{second.storage.close();}
  });
  it("owns storage and maintenance exclusively and keeps history stable across restart", () => {
    const f = fixture(), first = openRelayDeployment(f.configPath);
    try {
      expect(() => openRelayDeployment(f.configPath)).toThrow();
      const contender = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./relayDeploymentCrash.fixture.ts", import.meta.url)), f.configPath, "contender"],
        { encoding: "utf8", windowsHide: true, timeout: TSX_CHILD_TIMEOUT_MS });
      expect(contender.error).toBeUndefined();
      expect(contender.status, contender.stderr).toBe(0);
      const missingConfig = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./relayDeploymentCrash.fixture.ts", import.meta.url)), join(f.root, "missing.json"), "contender"],
        { encoding: "utf8", windowsHide: true, timeout: TSX_CHILD_TIMEOUT_MS });
      expect(missingConfig.error).toBeUndefined();
      expect(missingConfig.status).not.toBe(0);
      expect(missingConfig.stderr).toMatch(/ENOENT|no such file/);
      expect(() => openSyncRelayStorage(f.relayPath)).toThrow(/configured relay/);
      expect(first.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "u", createdAtMs: 1 })).toBe("created");
    } finally { first.storage.close(); }
    expect(first.history.reconciled).toBe(false);
    const second = openRelayDeployment(f.configPath);
    try {
      expect(second.history.namespace).toBe(first.history.namespace);
      expect(second.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "u", createdAtMs: 1 })).toBe("owned");
    } finally { second.storage.close(); }
  }, 2 * TSX_CHILD_TIMEOUT_MS + 10_000);

  it("refuses a database restored to exactly one permission write ago with no new journal event", async () => {
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

  it.each(["older", "ahead", "foreign-namespace", "foreign-generation"])("refuses a %s database while a write is pending", mismatch => {
    const f = fixture(), live = openRelayDeployment(f.configPath);
    live.storage.claimWorkspace({ workspaceId: "acknowledged", ownerUserId: "owner", createdAtMs: 1 });
    live.storage.close();
    const sidePath = join(f.continuityDirectory, "continuity.sqlite");
    const before = read(sidePath, "continuity");
    const confirmed = Number(before.confirmed_stamp), pending = Number(before.next_stamp);
    const side = new DatabaseSync(sidePath);
    try { side.prepare("UPDATE continuity SET pending_stamp=?,next_stamp=?").run(pending, pending + 1); }
    finally { side.close(); }
    const relay = new DatabaseSync(f.relayPath);
    try {
      if (mismatch === "older") relay.prepare("UPDATE sync_relay_continuity SET stamp=?").run(confirmed - 1);
      else if (mismatch === "ahead") relay.prepare("UPDATE sync_relay_continuity SET stamp=?").run(pending + 1);
      else if (mismatch === "foreign-namespace") relay.exec("UPDATE sync_relay_continuity SET namespace='foreign'");
      else relay.exec("UPDATE sync_relay_continuity SET generation=generation+1");
    } finally { relay.close(); }
    const record = read(sidePath, "continuity");
    expect(() => openRelayDeployment(f.configPath)).toThrow(/continuity/);
    expect(read(sidePath, "continuity")).toEqual(record);
  });

  it.each(["behind-confirmed", "at-confirmed", "at-next", "after-next", "unsafe-integer"])("refuses a pending stamp %s", invalid => {
    const f = fixture(), live = openRelayDeployment(f.configPath);
    live.storage.close();
    const sidePath = join(f.continuityDirectory, "continuity.sqlite");
    const before = read(sidePath, "continuity");
    const confirmed = Number(before.confirmed_stamp), next = Number(before.next_stamp);
    const pending = invalid === "behind-confirmed" ? confirmed - 1 : invalid === "at-confirmed" ? confirmed :
      invalid === "at-next" ? next : invalid === "after-next" ? next + 1 : Number.MAX_SAFE_INTEGER + 1;
    const side = new DatabaseSync(sidePath);
    try { side.prepare("UPDATE continuity SET pending_stamp=?").run(pending); } finally { side.close(); }
    const record = read(sidePath, "continuity", invalid === "unsafe-integer");
    expect(() => openRelayDeployment(f.configPath)).toThrow(/continuity|too large/);
    expect(read(sidePath, "continuity", invalid === "unsafe-integer")).toEqual(record);
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
      expect(read(side, "continuity").confirmed_stamp).toBe(before.confirmed_stamp);
      expect(read(side, "continuity").pending_stamp).toBeNull();
      expect(Number(read(side, "continuity").next_stamp)).toBeGreaterThan(Number(before.next_stamp));
    } finally { storage.close(); }
    const reopened = openRelayDeployment(f.configPath);
    try {
      expect(reopened.storage.claimWorkspace({ workspaceId: "after-rollback", ownerUserId: "owner", createdAtMs: 1 })).toBe("created");
    } finally { reopened.storage.close(); }
  });

  it.each(["before", "after"])("reopens committed data when confirmation throws %s its durable commit", boundary => {
    const f = fixture(), live = openRelayDeployment(f.configPath);
    const storage = live.storage as StorageContext;
    storage.claimWorkspace({ workspaceId: "acknowledged", ownerUserId: "owner", createdAtMs: 1 });
    const side = join(f.continuityDirectory, "continuity.sqlite");
    const previous = read(side, "continuity");
    const standing = storage.captureStanding();
    const exec = DatabaseSync.prototype.exec;
    let commits = 0;
    DatabaseSync.prototype.exec = function(sql: string) {
      const confirming = sql === "COMMIT" && this.prepare("SELECT 1 FROM sqlite_schema WHERE name='continuity'").get() && ++commits === 2;
      if (confirming && boundary === "before") throw new Error("lost confirmation result");
      const result = exec.call(this, sql);
      if (confirming) throw new Error("lost confirmation result");
      return result;
    };
    try {
      expect(() => storage.claimWorkspace({ workspaceId: "uncertain", ownerUserId: "owner", createdAtMs: 2 })).toThrow(/lost confirmation/);
      expect(standing).toThrow(/unavailable/);
      expect(live.history.reconciled).toBe(false);
    } finally { DatabaseSync.prototype.exec = exec; storage.close(); }
    const beforeRestart = read(side, "continuity");
    expect(beforeRestart.pending_stamp === null).toBe(boundary === "after");
    const reopened = openRelayDeployment(f.configPath);
    try {
      expect(reopened.storage.claimWorkspace({ workspaceId: "acknowledged", ownerUserId: "owner", createdAtMs: 3 })).toBe("owned");
      expect(reopened.storage.claimWorkspace({ workspaceId: "uncertain", ownerUserId: "owner", createdAtMs: 3 })).toBe("owned");
      const settled = read(side, "continuity");
      expect(settled.pending_stamp).toBeNull();
      expect(Number(settled.confirmed_stamp)).toBeGreaterThan(Number(previous.confirmed_stamp));
      expect(read(f.relayPath, "sync_relay_continuity").stamp).toBe(settled.confirmed_stamp);
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

  it.each(["before-reservation", "before-commit", "after-commit"])("recovers the production interruption at %s without losing acknowledged writes", async boundary => {
    const f = fixture(), live = openRelayDeployment(f.configPath);
    const backupPath = join(f.root, "older.sqlite");
    let confirmed: unknown;
    try {
      live.storage.claimWorkspace({ workspaceId: "first-acknowledged", ownerUserId: "owner", createdAtMs: 1 });
      const source = new DatabaseSync(f.relayPath, { readOnly: true });
      try { await backup(source, backupPath); } finally { source.close(); }
      live.storage.claimWorkspace({ workspaceId: "last-acknowledged", ownerUserId: "owner", createdAtMs: 2 });
      confirmed = read(f.relayPath, "sync_relay_continuity").stamp;
    } finally { live.storage.close(); }
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./relayDeploymentCrash.fixture.ts", import.meta.url)), f.configPath, boundary],
      { encoding: "utf8", windowsHide: true, timeout: TSX_CHILD_TIMEOUT_MS });
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe("");
    expect(child.status).toBe(boundary === "before-reservation" ? 80 : boundary === "before-commit" ? 81 : 82);
    const side = join(f.continuityDirectory, "continuity.sqlite");
    const beforeRestart = read(side, "continuity");
    const pending = beforeRestart.pending_stamp;
    const restarted = openRelayDeployment(f.configPath);
    try {
      expect(beforeRestart.confirmed_stamp).toBe(confirmed);
      expect(pending === null).toBe(boundary === "before-reservation");
      expect(restarted.storage.claimWorkspace({ workspaceId: "first-acknowledged", ownerUserId: "owner", createdAtMs: 3 })).toBe("owned");
      expect(restarted.storage.claimWorkspace({ workspaceId: "last-acknowledged", ownerUserId: "owner", createdAtMs: 3 })).toBe("owned");
      const db = new DatabaseSync(f.relayPath, { readOnly: true });
      try {
        expect(Boolean(db.prepare("SELECT 1 FROM sync_relay_workspaces WHERE workspace_id='interrupted'").get())).toBe(boundary === "after-commit");
      } finally { db.close(); }
      const settled = read(side, "continuity");
      expect(settled.pending_stamp).toBeNull();
      expect(settled.next_stamp).toBe(beforeRestart.next_stamp);
      expect(settled.confirmed_stamp).toBe(boundary === "after-commit" ? pending : confirmed);
      expect(read(f.relayPath, "sync_relay_continuity").stamp).toBe(settled.confirmed_stamp);
    } finally { restarted.storage.close(); }
    const settled = read(side, "continuity");
    const reopened = openRelayDeployment(f.configPath); reopened.storage.close();
    expect(read(side, "continuity")).toEqual(settled);
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(f.relayPath + suffix)) renameSync(f.relayPath + suffix, f.relayPath + suffix + ".preserved");
    copyFileSync(backupPath, f.relayPath);
    expect(() => openRelayDeployment(f.configPath)).toThrow(/continuity/);
    expect(read(side, "continuity")).toEqual(settled);
  }, TSX_CHILD_TIMEOUT_MS + 10_000);
});

describe("relay write and response lifetime", () => {
  it("retires after an uncertain rollback and does not cancel its reservation", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("CREATE TABLE work(value INTEGER); CREATE TABLE sync_relay_continuity(singleton INTEGER,stamp INTEGER); INSERT INTO sync_relay_continuity VALUES(1,0)");
    let cancelled = false;
    const db: SqliteDb = { prepare: sql => raw.prepare(sql) as unknown as ReturnType<SqliteDb["prepare"]>, close: () => raw.close(),
      exec(sql) { if (sql === "COMMIT") throw new Error("commit failed"); raw.exec(sql); if (sql === "ROLLBACK") throw new Error("lost rollback result"); } };
    const owner = new RelayWriteOwner(db, { reserve: () => 1, confirm() {}, cancel: () => { cancelled = true; }, close() {} });
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
    const owner = new RelayWriteOwner(db, { reserve: () => 1, confirm() {}, cancel: () => { cancelled = true; }, close() {} });
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
    const before = Number(read(side, "continuity").confirmed_stamp);
    expect(storage.claimPendingSharesForEmail("reader@example.test", "reader")).toBe(1);
    expect(storage.getShareGrant("g")?.principalUserId).toBe("reader");
    const after = read(side, "continuity");
    expect(Number(after.confirmed_stamp)).toBeGreaterThan(before);
    expect(read(f.relayPath, "sync_relay_continuity").stamp).toBe(after.confirmed_stamp);
    expect(storage.claimPendingSharesForEmail("reader@example.test", "reader")).toBe(0);
    expect(read(side, "continuity")).toEqual(after);
  } finally { storage.close(); }
});
