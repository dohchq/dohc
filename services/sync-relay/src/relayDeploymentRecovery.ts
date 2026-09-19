import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { validateRelayDeploymentMarker, withRelayDeploymentMaintenance, type DeploymentConfig } from "./relayDeployment";

type Deployment = { config: Readonly<DeploymentConfig>; stamp: number };
const snapshotName = "relay.sqlite";
const normalize = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
function contains(parent: string, child: string): boolean {
  const path = relative(normalize(parent), normalize(child));
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
async function canonical(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || normalize(await realpath(path)) !== normalize(path)) {
    throw new Error("Recovery paths must be absolute, canonical paths without symbolic links.");
  }
}
async function directoryOutsideDeployment(directory: string, deployment: Deployment, creating: boolean, configPath?: string): Promise<void> {
  await canonical(creating ? dirname(directory) : directory);
  if (!isAbsolute(directory) || resolve(directory) !== directory) throw new Error("Use an absolute backup directory.");
  const protectedDirectories = [dirname(deployment.config.relayPath), deployment.config.continuityDirectory];
  if (configPath) protectedDirectories.push(dirname(configPath));
  for (const protectedDirectory of protectedDirectories) {
    if (contains(protectedDirectory, directory) || contains(directory, protectedDirectory)) {
      throw new Error("Keep backups outside relay data and independent continuity directories.");
    }
  }
}
async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function syncFile(path: string): Promise<void> {
  // Windows rejects fsync on a read-only descriptor.
  const handle = await open(path, process.platform === "win32" ? "r+" : "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  // Windows cannot open directory handles for fsync through Node.
  if (process.platform !== "win32") await syncFile(path);
}
async function inspectSnapshot(path: string, deployment: Deployment): Promise<void> {
  await canonical(path);
  if (!(await lstat(path)).isFile()) throw new Error("The relay snapshot must be a regular file.");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (await stat(path + suffix).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
      throw new Error("A completed relay snapshot must not have SQLite side files.");
    }
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const checks = db.prepare("PRAGMA integrity_check").all();
    if (checks.length !== 1 || checks[0]?.integrity_check !== "ok") throw new Error("The relay snapshot failed SQLite integrity checks.");
    validateRelayDeploymentMarker(db, deployment.config, deployment.stamp);
  } finally { db.close(); }
}

/** A cold snapshot contains relay data only. Independent continuity remains on the original host. */
export async function backupRelayDeployment(configPath: string, directory: string): Promise<void> {
  await withRelayDeploymentMaintenance(configPath, async deployment => {
    await directoryOutsideDeployment(directory, deployment, true, configPath);
    await canonical(deployment.config.relayPath);
    for (const suffix of ["-wal", "-journal"]) {
      if (await stat(deployment.config.relayPath + suffix).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
        throw new Error("Stop the relay cleanly before backup. SQLite has an outstanding journal; no snapshot was taken.");
      }
    }
    const source = new DatabaseSync(deployment.config.relayPath, { readOnly: true });
    try {
      validateRelayDeploymentMarker(source, deployment.config, deployment.stamp);
      await mkdir(directory, { mode: 0o700 });
      const path = join(directory, snapshotName);
      await backup(source, path);
      // SQLite backup captures committed WAL pages in the standalone database.
      const snapshot = new DatabaseSync(path);
      try { snapshot.exec("PRAGMA journal_mode=DELETE"); } finally { snapshot.close(); }
      await inspectSnapshot(path, deployment);
      await syncFile(path);
      await writeFile(join(directory, "manifest.json"), JSON.stringify({
        version: 1, kind: "dohc-relay-snapshot", namespace: deployment.config.namespace,
        generation: deployment.config.generation, stamp: deployment.stamp,
        sha256: await digest(path), createdAt: new Date().toISOString(),
      }, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
      await syncDirectory(directory);
      await syncDirectory(dirname(directory));
    } finally { source.close(); }
  });
}

async function checkedSnapshot(directory: string, deployment: Deployment): Promise<{ path: string; sha256: string }> {
  await directoryOutsideDeployment(directory, deployment, false);
  const manifestPath = join(directory, "manifest.json");
  await canonical(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest?.version !== 1 || manifest.kind !== "dohc-relay-snapshot" ||
      manifest.namespace !== deployment.config.namespace || manifest.generation !== deployment.config.generation ||
      manifest.stamp !== deployment.stamp) {
    throw new Error("This snapshot does not match current deployment continuity. Preserve it for recovery; do not reset continuity.");
  }
  const path = join(directory, snapshotName);
  await inspectSnapshot(path, deployment);
  if (manifest.sha256 !== await digest(path)) throw new Error("The relay snapshot checksum changed.");
  return { path, sha256: manifest.sha256 };
}

export async function checkRelayBackup(configPath: string, directory: string): Promise<void> {
  await withRelayDeploymentMaintenance(configPath, async deployment => { await checkedSnapshot(directory, deployment); });
}

/** Restore only current relay authority. Auth, service-host data and continuity are never replaced. */
export async function restoreRelayDeployment(configPath: string, directory: string): Promise<{ preservedDirectory: string }> {
  return withRelayDeploymentMaintenance(configPath, async deployment => {
    const source = await checkedSnapshot(directory, deployment);
    const relayPath = deployment.config.relayPath;
    const parent = dirname(relayPath);
    const preservedDirectory = join(parent, `recovery-${randomUUID()}`);
    await mkdir(preservedDirectory, { mode: 0o700 });
    const candidate = join(preservedDirectory, "candidate.sqlite");
    await copyFile(source.path, candidate, constants.COPYFILE_EXCL);
    // Validate the bytes actually installed, not a source that could change after inspection.
    await inspectSnapshot(candidate, deployment);
    if (await digest(candidate) !== source.sha256) throw new Error("The snapshot changed while copying it.");
    await syncFile(candidate);
    await syncDirectory(preservedDirectory);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const original = relayPath + suffix;
      const exists = await lstat(original).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
      if (!exists) continue;
      await canonical(original);
      if (!(await lstat(original)).isFile()) throw new Error("Refusing to replace a relay path that is not a regular file.");
    }
    // Interruption preserves every original byte. Startup either sees the verified
    // snapshot or refuses a missing database; maintenance never opens the listener.
    try {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        try { await rename(relayPath + suffix, join(preservedDirectory, `original.sqlite${suffix}`)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      await syncDirectory(preservedDirectory);
      await syncDirectory(parent);
      await rename(candidate, relayPath);
      await syncDirectory(parent);
    } catch (error) {
      throw new Error(`Relay files were moved to ${preservedDirectory} before the install failed. ${error instanceof Error ? error.message : String(error)}`);
    }
    return { preservedDirectory };
  });
}
