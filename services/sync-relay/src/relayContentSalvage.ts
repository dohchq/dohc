import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateUserMaterializePath } from "@dohc/workspace-core";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function canonical(path: string): Promise<void> {
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (!isAbsolute(path) || resolve(path) !== path || normalize(await realpath(path)) !== normalize(path)) {
    throw new Error("Use absolute recovery paths without symbolic links.");
  }
}
async function syncPath(path: string, directory = false): Promise<void> {
  if (directory && process.platform === "win32") return;
  const handle = await open(path, process.platform === "win32" ? "r+" : "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Export ordinary settled files. The original snapshot remains evidence, never active authority. */
export async function salvageRelayContent(directory: string, output: string): Promise<{ exported: number; skipped: number }> {
  await canonical(directory);
  await canonical(dirname(output));
  if (!isAbsolute(output) || resolve(output) !== output) throw new Error("Use an absolute new output directory.");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (manifest?.version !== 1 || manifest.kind !== "dohc-relay-snapshot" || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error("This is not a completed relay snapshot.");
  }
  const source = join(directory, "relay.sqlite");
  await canonical(source);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (await stat(source + suffix).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
      throw new Error("Use a standalone completed snapshot without SQLite side files.");
    }
  }
  await mkdir(output, { mode: 0o700 });
  const evidence = join(output, "evidence");
  await mkdir(evidence, { mode: 0o700 });
  const directories = new Set([output, evidence]);
  const snapshot = join(evidence, "relay.sqlite");
  await copyFile(source, snapshot, constants.COPYFILE_EXCL);
  if (await fileDigest(snapshot) !== manifest.sha256) throw new Error("The snapshot checksum changed. Partial output remains for inspection.");
  await syncPath(snapshot);
  await writeFile(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
  const db = new DatabaseSync(snapshot, { readOnly: true });
  const inventory = await open(join(output, "files.jsonl"), "wx", 0o600);
  let exported = 0, skipped = 0;
  try {
    const checks = db.prepare("PRAGMA integrity_check").all();
    if (checks.length !== 1 || checks[0]?.integrity_check !== "ok") throw new Error("The snapshot failed SQLite integrity checks.");
    const marker = db.prepare("SELECT * FROM sync_relay_continuity").get();
    if (!marker || marker.namespace !== manifest.namespace || marker.generation !== manifest.generation || marker.stamp !== manifest.stamp) {
      throw new Error("Snapshot provenance does not match its database.");
    }
    const content = db.prepare("SELECT content, byte_length FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?");
    for (const row of db.prepare("SELECT * FROM sync_relay_current_files ORDER BY workspace_id, version_id, path").iterate()) {
      const workspaceId = String(row.workspace_id), versionId = String(row.version_id), path = String(row.path);
      const base = `files/${sha256(workspaceId)}/${sha256(versionId)}`;
      const record = { workspaceId, versionId, path, blobSha256: row.blob_sha256, stateRelaySeq: row.state_relay_seq };
      const validation = validateUserMaterializePath(path);
      let reason: string | undefined;
      if (!validation.ok || validation.normalized !== path || classifyEngineFilePath(path).kind !== "tracked") reason = "path-cannot-be-materialized";
      const blob = reason ? undefined : content.get(workspaceId, String(row.blob_sha256));
      if (!reason && (!blob || !(blob.content instanceof Uint8Array))) reason = "missing-blob";
      if (!reason && (blob!.byte_length !== (blob!.content as Uint8Array).byteLength || sha256(blob!.content as Uint8Array) !== row.blob_sha256)) reason = "blob-integrity-failed";
      if (!reason) {
        const destination = join(output, base, path);
        try {
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          for (let parent = dirname(destination); parent !== output; parent = dirname(parent)) directories.add(parent);
          await writeFile(destination, blob!.content as Uint8Array, { flag: "wx", mode: 0o600, flush: true });
          exported++;
          await inventory.write(JSON.stringify({ ...record, exportedPath: `${base}/${path}` }) + "\n");
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!["EEXIST", "ENOTDIR", "EISDIR", "EINVAL", "ENAMETOOLONG"].includes(code ?? "")) throw error;
          reason = "path-collision-or-unsupported-name";
        }
      }
      if (reason) { skipped++; await inventory.write(JSON.stringify({ ...record, skipped: reason }) + "\n"); }
    }
    await inventory.sync();
  } finally { await inventory.close(); db.close(); }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) await syncPath(directory, true);
  await syncPath(dirname(output), true);
  await writeFile(join(output, "recovery.json"), JSON.stringify({
    version: 1, kind: "dohc-offline-content-salvage", complete: true, exported, skipped,
    source: manifest, createdAt: new Date().toISOString(),
    limitations: [
      "Only settled tracked file contents present in this snapshot are materialized.",
      "Accepted app responses stored as tracked files are included; app collection records are not imported.",
      "Live edits not settled into relay file state, protected files, chats, discussions and history are not imported.",
      "The evidence directory retains the original private database, including historical content and credentials. Keep it offline.",
      "No workspace identity, permissions, shares, sessions or live-edit authority are restored. Create a new local workspace from selected recovered files.",
    ],
  }, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
  await syncPath(output, true);
  await syncPath(dirname(output), true);
  return { exported, skipped };
}
