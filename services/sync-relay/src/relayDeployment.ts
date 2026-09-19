import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { openSyncRelayStorage } from "./storage";
import type { OpenSyncRelayStorageOptions, SqliteDb } from "./storage/types";
import { RelayWriteOwner, type RelayContinuity } from "./storage/writeOwner";
import { createLiveJournalHistoryAuthority, attachLiveJournalHistory } from "./storage/liveJournalHistory";
import type { StorageContext } from "./storage/context";

export interface DeploymentConfig {
  version: 1;
  namespace: string;
  generation: number;
  relayPath: string;
  continuityDirectory: string;
}

const unavailable = () => new Error("Relay deployment continuity is unavailable.");
const normalized = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
function contained(parent: string, path: string): boolean {
  const rel = relative(normalized(parent), normalized(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
function absolute(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) throw unavailable();
  return path;
}
function canonicalDirectory(path: string): void {
  if (normalized(realpathSync(path)) !== normalized(path)) throw unavailable();
}
function validateLayout(configPath: string, relayPath: string, continuityDirectory: string): void {
  absolute(configPath); absolute(relayPath); absolute(continuityDirectory);
  const relayDirectory = dirname(relayPath);
  if (contained(relayDirectory, continuityDirectory) ||
      contained(continuityDirectory, relayDirectory) || contained(relayDirectory, configPath)) {
    throw new Error("Deployment config and continuity must be outside the relay database directory; neither data directory may contain the other.");
  }
}
function validate(configPath: string, value: unknown): DeploymentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const config = value as DeploymentConfig;
  if (Object.keys(config).sort().join() !== "continuityDirectory,generation,namespace,relayPath,version" ||
      config.version !== 1 || !/^[a-f0-9-]{36}$/.test(config.namespace) ||
      !Number.isSafeInteger(config.generation) || config.generation < 1) throw unavailable();
  validateLayout(configPath, config.relayPath, config.continuityDirectory);
  const relayDirectory = dirname(config.relayPath);
  canonicalDirectory(relayDirectory);
  canonicalDirectory(config.continuityDirectory);
  canonicalDirectory(dirname(configPath));
  return Object.freeze({ ...config });
}
function openExisting(path: string): DatabaseSync {
  if (normalized(realpathSync(path)) !== normalized(path)) throw unavailable();
  // A raw descriptor close releases this process's existing POSIX SQLite locks.
  // Let SQLite open without CREATE and manage its own descriptor lifetime.
  const uri = pathToFileURL(path);
  uri.searchParams.set("mode", "rw");
  const db = new DatabaseSync(uri.href, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL");
    return db;
  } catch (error) { db.close(); throw error; }
}
function row(db: SqliteDb | DatabaseSync, table: string): Record<string, unknown> {
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  if (rows.length !== 1 || rows[0]?.singleton !== 1) throw unavailable();
  return rows[0]!;
}
function matches(record: Record<string, unknown>, config: DeploymentConfig): void {
  if (record.namespace !== config.namespace || record.generation !== config.generation) throw unavailable();
}

class DeploymentContinuity implements RelayContinuity {
  constructor(readonly lock: DatabaseSync, readonly side: DatabaseSync, readonly config: DeploymentConfig) {}
  reserve(previous: number): number {
    this.side.exec("BEGIN IMMEDIATE");
    try {
      const current = row(this.side, "continuity");
      matches(current, this.config);
      const next = current.next_stamp;
      if (current.expected_stamp !== previous || typeof next !== "number" ||
          !Number.isSafeInteger(next) || next <= previous || next >= Number.MAX_SAFE_INTEGER) throw unavailable();
      this.side.prepare("UPDATE continuity SET next_stamp=?,expected_stamp=? WHERE singleton=1").run(next + 1, next);
      this.side.exec("COMMIT");
      return next;
    } catch (error) { try { this.side.exec("ROLLBACK"); } catch {} throw error; }
  }
  cancel(stamp: number, previous: number): void {
    this.side.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.side.prepare("UPDATE continuity SET expected_stamp=? WHERE singleton=1 AND expected_stamp=? AND next_stamp>?")
        .run(previous, stamp, stamp);
      if (Number(changed.changes) !== 1) throw unavailable();
      this.side.exec("COMMIT");
    } catch (error) { try { this.side.exec("ROLLBACK"); } catch {} throw error; }
  }
  close(): void {
    this.side.close();
    this.lock.exec("ROLLBACK");
    this.lock.close();
  }
}

/** Explicit fresh deployment only. Interrupted initialization stays preserved and unavailable. */
export function initializeRelayDeployment(input: { configPath: string; relayPath: string; continuityDirectory: string }): void {
  const configPath = absolute(input.configPath), relayPath = absolute(input.relayPath);
  const continuityDirectory = absolute(input.continuityDirectory);
  validateLayout(configPath, relayPath, continuityDirectory);
  if (existsSync(configPath) || existsSync(relayPath) || existsSync(continuityDirectory)) throw unavailable();
  mkdirSync(dirname(relayPath), { recursive: true });
  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(continuityDirectory, { mode: 0o700 });
  const config = validate(configPath, { version: 1, namespace: randomUUID(), generation: 1, relayPath, continuityDirectory });
  const lock = new DatabaseSync(join(continuityDirectory, "lock.sqlite"));
  let side: DatabaseSync | undefined, relay: DatabaseSync | undefined;
  try {
    lock.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE deployment(namespace TEXT NOT NULL); BEGIN EXCLUSIVE");
    lock.prepare("INSERT INTO deployment VALUES(?)").run(config.namespace);
    // Persist the lock identity before taking its lifetime transaction.
    lock.exec("COMMIT; BEGIN EXCLUSIVE");
    side = new DatabaseSync(join(continuityDirectory, "continuity.sqlite"));
    side.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE continuity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), namespace TEXT NOT NULL, generation INTEGER NOT NULL, next_stamp INTEGER NOT NULL, expected_stamp INTEGER NOT NULL) STRICT");
    side.prepare("INSERT INTO continuity VALUES(1,?,?,1,0)").run(config.namespace, config.generation);
    const fd = openSync(relayPath, "wx"); closeSync(fd);
    relay = new DatabaseSync(relayPath);
    relay.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE sync_relay_continuity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),namespace TEXT NOT NULL,generation INTEGER NOT NULL,stamp INTEGER NOT NULL) STRICT");
    relay.prepare("INSERT INTO sync_relay_continuity VALUES(1,?,?,0)").run(config.namespace, config.generation);
    relay.close(); relay = undefined;
    side.close(); side = undefined;
    // The external config is published last and never overwrites an existing deployment.
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
  } finally {
    relay?.close(); side?.close();
    try { lock.exec("ROLLBACK"); } finally { lock.close(); }
  }
}

function acquireDeployment(configPath: string) {
  const config = validate(absolute(configPath), JSON.parse(readFileSync(configPath, "utf8")));
  const lock = openExisting(join(config.continuityDirectory, "lock.sqlite"));
  let side: DatabaseSync | undefined;
  try {
    if (lock.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") throw unavailable();
    lock.exec("BEGIN EXCLUSIVE");
    const identities = lock.prepare("SELECT namespace FROM deployment").all();
    if (identities.length !== 1 || identities[0]?.namespace !== config.namespace) throw unavailable();
    side = openExisting(join(config.continuityDirectory, "continuity.sqlite"));
    if (side.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") throw unavailable();
    const current = row(side, "continuity"); matches(current, config);
    if (!Number.isSafeInteger(current.expected_stamp) || (current.expected_stamp as number) < 0 ||
        !Number.isSafeInteger(current.next_stamp) || (current.next_stamp as number) <= (current.expected_stamp as number)) throw unavailable();
    return { config, lock, side, stamp: current.expected_stamp as number };
  } catch (error) {
    side?.close();
    try { lock.exec("ROLLBACK"); } catch {}
    lock.close();
    throw error;
  }
}

/** Maintenance owns the same writer lock as ordinary startup, without opening or creating relay storage. */
export async function withRelayDeploymentMaintenance<T>(configPath: string,
  operation: (deployment: { config: Readonly<DeploymentConfig>; stamp: number }) => Promise<T>): Promise<T> {
  const deployment = acquireDeployment(configPath);
  try { return await operation({ config: deployment.config, stamp: deployment.stamp }); }
  finally {
    deployment.side.close();
    try { deployment.lock.exec("ROLLBACK"); } finally { deployment.lock.close(); }
  }
}

export function validateRelayDeploymentMarker(db: SqliteDb | DatabaseSync, config: Readonly<DeploymentConfig>, stamp: number): void {
  const marker = row(db, "sync_relay_continuity");
  matches(marker, config);
  if (marker.stamp !== stamp) throw unavailable();
}

export function openRelayDeployment(configPath: string, options: OpenSyncRelayStorageOptions = {}) {
  const { config, lock, side, stamp } = acquireDeployment(configPath);
  let transferred = false;
  try {
    if (normalized(realpathSync(config.relayPath)) !== normalized(config.relayPath)) throw unavailable();
    const storage = openSyncRelayStorage(config.relayPath, options, db => {
      validateRelayDeploymentMarker(db, config, stamp);
      const continuity = new DeploymentContinuity(lock, side, config);
      const owner = new RelayWriteOwner(db, continuity, stamp);
      transferred = true;
      return owner;
    });
    const history = createLiveJournalHistoryAuthority({ namespace: config.namespace, reconciled: true });
    attachLiveJournalHistory(storage as StorageContext, history);
    storage.unavailable.addEventListener("abort", () => history.markUnreconciled(), { once: true });
    return { storage, history };
  } catch (error) {
    if (!transferred) {
      side.close();
      try { lock.exec("ROLLBACK"); } catch {}
      lock.close();
    }
    throw error;
  }
}