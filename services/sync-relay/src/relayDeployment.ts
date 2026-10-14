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
const needsSettlement = () => new Error("Relay continuity needs settling after an interrupted write. Start the relay once, then stop it cleanly before backup, check-backup or restore.");
const validNonce = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
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
  constructor(readonly lock: DatabaseSync, readonly side: DatabaseSync) {}
  confirm(stamp: number, nonce: string, previousNonce: string): void {
    this.side.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.side.prepare("UPDATE continuity SET confirmed_stamp=?,confirmed_nonce=? WHERE singleton=1 AND confirmed_stamp=? AND confirmed_nonce=?")
        .run(stamp, nonce, stamp - 1, previousNonce);
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
  const nonce = randomUUID();
  try {
    lock.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE deployment(namespace TEXT NOT NULL); BEGIN EXCLUSIVE");
    lock.prepare("INSERT INTO deployment VALUES(?)").run(config.namespace);
    // Persist the lock identity before taking its lifetime transaction.
    lock.exec("COMMIT; BEGIN EXCLUSIVE");
    side = new DatabaseSync(join(continuityDirectory, "continuity.sqlite"));
    side.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE continuity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), namespace TEXT NOT NULL, generation INTEGER NOT NULL, confirmed_stamp INTEGER NOT NULL, confirmed_nonce TEXT NOT NULL) STRICT");
    side.prepare("INSERT INTO continuity VALUES(1,?,?,0,?)").run(config.namespace, config.generation, nonce);
    const fd = openSync(relayPath, "wx"); closeSync(fd);
    relay = new DatabaseSync(relayPath);
    relay.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE sync_relay_continuity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),namespace TEXT NOT NULL,generation INTEGER NOT NULL,stamp INTEGER NOT NULL,nonce TEXT NOT NULL,previous_nonce TEXT) STRICT");
    relay.prepare("INSERT INTO sync_relay_continuity VALUES(1,?,?,0,?,NULL)").run(config.namespace, config.generation, nonce);
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
    const confirmed = current.confirmed_stamp, nonce = current.confirmed_nonce;
    if (Object.keys(current).sort().join() !== "confirmed_nonce,confirmed_stamp,generation,namespace,singleton" ||
        typeof confirmed !== "number" || !Number.isSafeInteger(confirmed) || confirmed < 0 || !validNonce(nonce)) throw unavailable();
    return { config, lock, side, stamp: confirmed, nonce };
  } catch (error) {
    side?.close();
    try { lock.exec("ROLLBACK"); } catch {}
    lock.close();
    throw error;
  }
}

/** Maintenance owns the writer lock and inspects cold relay storage without settling it. */
export async function withRelayDeploymentMaintenance<T>(configPath: string, operationKind: "backup" | "check-backup" | "restore",
  operation: (deployment: { config: Readonly<DeploymentConfig>; stamp: number; nonce: string }) => Promise<T>): Promise<T> {
  const deployment = acquireDeployment(configPath);
  let operationFailed = false;
  try {
    // A missing or corrupt database can still be repaired from a confirmed snapshot.
    let marker: ReturnType<typeof relayDeploymentMarker> | undefined;
    if (existsSync(deployment.config.relayPath)) {
      let db: DatabaseSync | undefined;
      try {
        if (normalized(realpathSync(deployment.config.relayPath)) !== normalized(deployment.config.relayPath)) throw unavailable();
        const uri = pathToFileURL(deployment.config.relayPath);
        uri.searchParams.set("immutable", "1");
        db = new DatabaseSync(uri.href, { readOnly: true });
        marker = relayDeploymentMarker(db, deployment.config);
      } catch (error) {
        if (!(error instanceof Error && "errcode" in error && (error.errcode === 11 || error.errcode === 26))) throw error;
      } finally { db?.close(); }
    }
    if ((marker || operationKind !== "restore") && ["-wal", "-journal"].some(suffix => existsSync(deployment.config.relayPath + suffix))) throw needsSettlement();
    if (marker) validateRelayDeploymentMarkerValue(marker, deployment.stamp, deployment.nonce);
    return await operation({ config: deployment.config, stamp: deployment.stamp, nonce: deployment.nonce });
  }
  catch (error) { operationFailed = true; throw error; }
  finally {
    const failures: unknown[] = [];
    try { deployment.side.close(); } catch (error) { failures.push(error); }
    try { deployment.lock.exec("ROLLBACK"); } catch (error) { failures.push(error); }
    try { deployment.lock.close(); } catch (error) { failures.push(error); }
    if (!operationFailed && failures.length) throw new AggregateError(failures, "Relay maintenance could not release deployment storage.");
  }
}

function relayDeploymentMarker(db: SqliteDb | DatabaseSync, config: Readonly<DeploymentConfig>) {
  const marker = row(db, "sync_relay_continuity");
  matches(marker, config);
  if (Object.keys(marker).sort().join() !== "generation,namespace,nonce,previous_nonce,singleton,stamp" ||
      typeof marker.stamp !== "number" || !Number.isSafeInteger(marker.stamp) || marker.stamp < 0 ||
      !validNonce(marker.nonce) || (marker.stamp === 0 ? marker.previous_nonce !== null : !validNonce(marker.previous_nonce))) throw unavailable();
  return { stamp: marker.stamp, nonce: marker.nonce, previousNonce: marker.previous_nonce };
}
function committedSuccessor(marker: ReturnType<typeof relayDeploymentMarker>, stamp: number, nonce: string): boolean {
  return marker.stamp === stamp + 1 && marker.previousNonce === nonce;
}
function validateRelayDeploymentMarkerValue(marker: ReturnType<typeof relayDeploymentMarker>, stamp: number, nonce: string): void {
  if (marker.stamp === stamp && marker.nonce === nonce) return;
  if (committedSuccessor(marker, stamp, nonce)) throw needsSettlement();
  throw unavailable();
}
export function validateRelayDeploymentMarker(db: SqliteDb | DatabaseSync, config: Readonly<DeploymentConfig>, stamp: number, nonce: string): void {
  validateRelayDeploymentMarkerValue(relayDeploymentMarker(db, config), stamp, nonce);
}

export function openRelayDeployment(configPath: string, options: OpenSyncRelayStorageOptions = {}) {
  const { config, lock, side, stamp: confirmed, nonce } = acquireDeployment(configPath);
  let transferred = false;
  try {
    if (normalized(realpathSync(config.relayPath)) !== normalized(config.relayPath)) throw unavailable();
    const storage = openSyncRelayStorage(config.relayPath, options, db => {
      const marker = relayDeploymentMarker(db, config);
      const continuity = new DeploymentContinuity(lock, side);
      const confirmedMarker = marker.stamp === confirmed && marker.nonce === nonce;
      if (!confirmedMarker && !committedSuccessor(marker, confirmed, nonce)) throw unavailable();
      // Sync a record recovered from an interrupted COMMIT before accepting writes.
      const recordCheckpoint = side.prepare("PRAGMA wal_checkpoint(FULL)").get();
      if (recordCheckpoint?.busy !== 0 || recordCheckpoint.log !== recordCheckpoint.checkpointed) throw unavailable();
      if (!confirmedMarker) {
        // Sync recovered WAL pages before the independent record can cover them.
        const checkpoint = db.prepare("PRAGMA wal_checkpoint(FULL)").get();
        if (checkpoint?.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) throw unavailable();
        continuity.confirm(marker.stamp, marker.nonce, nonce);
      }
      const owner = new RelayWriteOwner(db, continuity, marker.stamp, marker.nonce);
      transferred = true;
      return owner;
    });
    const history = createLiveJournalHistoryAuthority({ namespace: config.namespace, reconciled: true });
    attachLiveJournalHistory(storage as StorageContext, history);
    storage.unavailable.addEventListener("abort", () => history.markUnreconciled(), { once: true });
    // Keep worker ownership manifests across process restarts so startup can reclaim crashed previews.
    return { storage, history, datasetDirectory: join(dirname(config.relayPath), "dataset-workers") };
  } catch (error) {
    if (!transferred) {
      side.close();
      try { lock.exec("ROLLBACK"); } catch {}
      lock.close();
    }
    throw error;
  }
}
