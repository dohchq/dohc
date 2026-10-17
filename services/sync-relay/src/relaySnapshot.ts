import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, open, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

/** One manifest for cold backups and sealed off-site snapshots. Every field comes from the completed copy. */
export interface RelaySnapshotManifest {
  version: 2;
  kind: "dohc-relay-snapshot";
  namespace: string;
  generation: number;
  stamp: number;
  nonce: string;
  schemaSha256: string;
  release: string;
  sha256: string;
  createdAt: string;
}

const manifestKeys = "createdAt,generation,kind,namespace,nonce,release,schemaSha256,sha256,stamp,version";
const packageMagic = Buffer.from("DOHCSNAP");
const packageFormat = "dohc-relay-snapshot-package";
const tagBytes = 16;
const headerLimit = 4096;
const manifestLimit = 64 * 1024;
/** Single-request uploads stop at 5 GiB on S3 and R2; stay below both. */
export const RELAY_SNAPSHOT_UPLOAD_LIMIT = 5_000_000_000;
/** The release image records its source commit; a source checkout reports unknown. */
export const relayRelease = () => process.env.DOHC_REVISION?.trim() || "unknown";

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
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
function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

export function parseRelaySnapshotManifest(value: unknown): RelaySnapshotManifest {
  const manifest = value as RelaySnapshotManifest;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== manifestKeys ||
      manifest.version !== 2 || manifest.kind !== "dohc-relay-snapshot" || !/^[a-f0-9-]{36}$/.test(manifest.namespace) ||
      !Number.isSafeInteger(manifest.generation) || manifest.generation < 1 ||
      !Number.isSafeInteger(manifest.stamp) || manifest.stamp < 0 ||
      typeof manifest.nonce !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(manifest.nonce) ||
      !/^[a-f0-9]{64}$/.test(manifest.schemaSha256) || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      typeof manifest.release !== "string" || !/^[\x21-\x7e]{1,128}$/.test(manifest.release) ||
      typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new Error("This is not a completed relay snapshot manifest.");
  }
  return manifest;
}

/** Integrity of a standalone copy. The caller decides which identity it must carry. */
export async function checkRelaySnapshotDatabase(path: string): Promise<void> {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (await exists(path + suffix)) throw new Error("A completed relay snapshot must not have SQLite side files.");
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const checks = db.prepare("PRAGMA integrity_check").all();
    if (checks.length !== 1 || checks[0]?.integrity_check !== "ok") throw new Error("The relay snapshot failed SQLite integrity checks.");
  } finally { db.close(); }
}

/** Reads identity, schema and checksum from the completed copy, never from live continuity. */
export async function describeRelaySnapshot(path: string, release: string): Promise<RelaySnapshotManifest> {
  const db = new DatabaseSync(path, { readOnly: true });
  let identity: Pick<RelaySnapshotManifest, "namespace" | "generation" | "stamp" | "nonce">, schemaSha256: string;
  try {
    const rows = db.prepare("SELECT * FROM sync_relay_continuity").all();
    const marker = rows[0];
    if (rows.length !== 1 || marker?.singleton !== 1) throw new Error("The relay snapshot has no deployment marker.");
    identity = { namespace: marker.namespace as string, generation: marker.generation as number, stamp: marker.stamp as number, nonce: marker.nonce as string };
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
    schemaSha256 = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
  } finally { db.close(); }
  return parseRelaySnapshotManifest({ version: 2, kind: "dohc-relay-snapshot", ...identity, schemaSha256, release,
    sha256: await digest(path), createdAt: new Date().toISOString() });
}

/** A read-only mount cannot create SQLite's WAL index; a stopped relay uses the cold backup instead. */
async function requireRunningRelay(relayPath: string) {
  if (!(await exists(relayPath + "-wal"))) {
    throw new Error("Online snapshots need the running relay. Use backup while the relay is stopped.");
  }
}

/**
 * Copies a running relay through a separate read-only connection. VACUUM INTO reads one
 * transaction, so the marker in the copy matches the data beside it.
 */
export async function captureRelaySnapshot(relayPath: string, output: string, release: string): Promise<RelaySnapshotManifest> {
  await requireRunningRelay(relayPath);
  const uri = pathToFileURL(relayPath);
  uri.searchParams.set("mode", "ro");
  const source = new DatabaseSync(uri.href, { readOnly: true });
  try {
    source.exec("PRAGMA busy_timeout=5000");
    source.prepare("VACUUM INTO ?").run(output);
  } finally { source.close(); }
  const copy = new DatabaseSync(output);
  try { copy.exec("PRAGMA journal_mode=DELETE"); } finally { copy.close(); }
  await checkRelaySnapshotDatabase(output);
  return describeRelaySnapshot(output, release);
}

export function relaySnapshotKey(value: string | undefined): Buffer {
  const key = value && /^[A-Za-z0-9_-]{43}$/.test(value) ? Buffer.from(value, "base64url") : undefined;
  if (key?.length !== 32) throw new Error("Set DOHC_SNAPSHOT_KEY to the 32-byte key that bootstrap generated.");
  return key;
}
const keyId = (key: Buffer) => createHash("sha256").update("dohc-relay-snapshot-key\0").update(key).digest("hex").slice(0, 16);

/** AES-256-GCM over the manifest and database together. The plaintext header is authenticated data. */
export async function sealRelaySnapshot(databasePath: string, manifest: RelaySnapshotManifest, key: Buffer, output: string): Promise<void> {
  const iv = randomBytes(12);
  const header = Buffer.from(JSON.stringify({ format: packageFormat, version: 1, cipher: "aes-256-gcm", iv: iv.toString("base64url"), key: keyId(key) }));
  const prefix = Buffer.concat([packageMagic, u32(header.length), header]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(prefix);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const handle = await open(output, "wx", 0o600);
  try {
    await handle.write(prefix);
    await handle.write(cipher.update(Buffer.concat([u32(manifestBytes.length), manifestBytes])));
    for await (const chunk of createReadStream(databasePath, { highWaterMark: 1024 * 1024 })) await handle.write(cipher.update(chunk));
    await handle.write(cipher.final());
    await handle.write(cipher.getAuthTag());
    await handle.sync();
  } finally { await handle.close(); }
}

/**
 * Decrypts a package into a new directory as `relay.sqlite` and `manifest.json`, the layout that
 * check-backup, restore and salvage read. Nothing is kept unless every check passes.
 */
export async function openRelaySnapshot(packagePath: string, key: Buffer, outputDirectory: string): Promise<RelaySnapshotManifest> {
  const source = await open(packagePath, "r");
  let created = false;
  try {
    const { size } = await source.stat();
    const fixed = Buffer.alloc(12);
    await source.read(fixed, 0, 12, 0);
    const headerLength = fixed.readUInt32BE(8);
    if (size < 12 + tagBytes || !fixed.subarray(0, 8).equals(packageMagic) || headerLength > headerLimit || size < 12 + headerLength + tagBytes) {
      throw new Error("This file is not a dohc relay snapshot.");
    }
    const header = Buffer.alloc(headerLength);
    await source.read(header, 0, headerLength, 12);
    let fields: Record<string, unknown>;
    try { fields = JSON.parse(header.toString("utf8")); } catch { throw new Error("This file is not a dohc relay snapshot."); }
    if (Object.keys(fields).sort().join() !== "cipher,format,iv,key,version" || fields.format !== packageFormat ||
        fields.version !== 1 || fields.cipher !== "aes-256-gcm" || typeof fields.iv !== "string" ||
        Buffer.from(fields.iv, "base64url").length !== 12) {
      throw new Error("This relay snapshot uses an unsupported format.");
    }
    if (fields.key !== keyId(key)) throw new Error("This relay snapshot was sealed with a different snapshot key.");
    const prefix = Buffer.concat([fixed, header]);
    const tag = Buffer.alloc(tagBytes);
    await source.read(tag, 0, tagBytes, size - tagBytes);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(fields.iv, "base64url"));
    decipher.setAAD(prefix);
    decipher.setAuthTag(tag);

    await mkdir(outputDirectory, { mode: 0o700 });
    created = true;
    // The final name appears only after every check, so an interrupted run leaves no usable-looking copy.
    const databasePath = join(outputDirectory, "relay.sqlite.partial");
    const database = await open(databasePath, "wx", 0o600);
    let lead = Buffer.alloc(0), manifestLength: number | undefined;
    try {
      const write = async (plain: Buffer) => {
        if (manifestLength === undefined || lead.length < 4 + manifestLength) {
          lead = Buffer.concat([lead, plain]);
          if (manifestLength === undefined && lead.length >= 4) {
            manifestLength = lead.readUInt32BE(0);
            if (manifestLength > manifestLimit) throw new Error("The relay snapshot could not be decrypted. It is damaged or was changed.");
          }
          if (manifestLength === undefined || lead.length < 4 + manifestLength) return;
          plain = lead.subarray(4 + manifestLength);
          lead = lead.subarray(0, 4 + manifestLength);
        }
        if (plain.length) await database.write(plain);
      };
      for await (const chunk of source.createReadStream({ start: prefix.length, end: size - tagBytes - 1, autoClose: false, highWaterMark: 1024 * 1024 })) {
        await write(decipher.update(chunk as Buffer));
      }
      try { await write(decipher.final()); }
      catch { throw new Error("The relay snapshot could not be decrypted. It is damaged or was changed."); }
      await database.sync();
    } finally { await database.close(); }
    if (manifestLength === undefined || lead.length !== 4 + manifestLength) throw new Error("The relay snapshot has no manifest.");
    let manifestValue: unknown;
    try { manifestValue = JSON.parse(lead.subarray(4).toString("utf8")); } catch { throw new Error("The relay snapshot has no manifest."); }
    const manifest = parseRelaySnapshotManifest(manifestValue);
    if (await digest(databasePath) !== manifest.sha256) throw new Error("The relay snapshot checksum does not match its manifest.");
    await checkRelaySnapshotDatabase(databasePath);
    const actual = await describeRelaySnapshot(databasePath, manifest.release);
    if (actual.namespace !== manifest.namespace || actual.generation !== manifest.generation ||
        actual.stamp !== manifest.stamp || actual.nonce !== manifest.nonce || actual.schemaSha256 !== manifest.schemaSha256) {
      throw new Error("The relay snapshot database does not match its manifest.");
    }
    await rename(databasePath, join(outputDirectory, "relay.sqlite"));
    await writeFile(join(outputDirectory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
    await syncDirectory(outputDirectory);
    return manifest;
  } catch (error) {
    // Unauthenticated plaintext must not outlive a failed check.
    if (created) await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  } finally { await source.close(); }
}

export interface SealedRelaySnapshot { path: string; name: string; manifest: RelaySnapshotManifest }
export interface FilesystemSpace { free: number; total: number }

const gib = 1024 ** 3;
const gibText = (bytes: number) => `${(bytes / gib).toFixed(1)} GiB`;
export async function filesystemSpace(path: string): Promise<FilesystemSpace> {
  const { bavail, blocks, bsize } = await statfs(path);
  return { free: bavail * bsize, total: blocks * bsize };
}
const fileSize = (path: string) => stat(path).then(stats => stats.size, error => { if (error.code === "ENOENT") return 0; throw error; });

/**
 * At its peak a snapshot holds the copy and the sealed package, and the copy's read lock makes the
 * relay's WAL grow. The relay's commits get headroom of its own size, between 1 GiB and a tenth of the disk.
 */
export function relaySnapshotSpaceNeeded(databaseBytes: number, filesystemBytes: number): number {
  return 2 * databaseBytes + Math.max(gib, Math.min(Math.ceil(filesystemBytes / 10), databaseBytes));
}

const sqliteBusy = 5;

/**
 * Captures and seals one snapshot in the state directory's staging folder, then removes it. One
 * snapshot runs at a time across processes and containers: an exclusive transaction on a lock
 * database holds SQLite's file lock, which the kernel drops when its process dies.
 */
export async function withRelaySnapshot<T>(options: { relayPath: string; stateDirectory: string; key: Buffer; release: string;
  space?: (path: string) => Promise<FilesystemSpace> }, deliver: (snapshot: SealedRelaySnapshot) => Promise<T>): Promise<T> {
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(join(options.stateDirectory, "snapshot.lock"));
  try {
    try { lock.exec("BEGIN EXCLUSIVE"); } catch (error) {
      if ((error as { errcode?: number }).errcode !== sqliteBusy) throw error;
      throw new Error("Another snapshot is running, so no snapshot was taken. Try again after it finishes.");
    }
    // Only an unfinished copy can be here, and an interrupted run leaves plaintext behind.
    const staging = join(options.stateDirectory, "staging");
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { mode: 0o700 });
    try {
      await requireRunningRelay(options.relayPath);
      const databaseBytes = await fileSize(options.relayPath) + await fileSize(`${options.relayPath}-wal`);
      for (const [path, disk] of [[dirname(options.relayPath), "the relay's disk"], [staging, "the snapshots folder's disk"]] as const) {
        const { free, total } = await (options.space ?? filesystemSpace)(path);
        const needed = relaySnapshotSpaceNeeded(databaseBytes, total);
        if (free < needed) {
          throw new Error(`A snapshot needs ${gibText(needed)} free on ${disk} and ${gibText(free)} is free. ` +
            "No snapshot was taken, so the relay keeps that space. Free space on that disk or move the data to a larger one.");
        }
      }
      const plain = join(staging, "relay.sqlite");
      const manifest = await captureRelaySnapshot(options.relayPath, plain, options.release);
      const time = manifest.createdAt.replace(/[-:]|\.\d{3}/g, "");
      const name = `dohc-relay-${time}-${manifest.stamp}-${randomBytes(4).toString("hex")}.dohc-snapshot`;
      const path = join(staging, name);
      await sealRelaySnapshot(plain, manifest, options.key, path);
      await rm(plain);
      return await deliver({ path, name, manifest });
    } finally { await rm(staging, { recursive: true, force: true }); }
  } finally { lock.close(); }
}

/** Writes the sealed package under its unique name. A partial copy never carries that name. */
export async function saveRelaySnapshot(snapshot: SealedRelaySnapshot, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, snapshot.name), partial = `${destination}.partial`;
  if (await exists(destination)) throw new Error("A snapshot with this name already exists. Existing snapshots are never replaced.");
  await copyFile(snapshot.path, partial, constants.COPYFILE_EXCL);
  await syncFile(partial);
  await rename(partial, destination);
  await syncDirectory(directory);
  return destination;
}

export interface SnapshotStorage { endpoint: URL; bucket: string; region: string; accessKeyId: string; secretAccessKey: string }

const loopback = (host: string) => ["localhost", "[::1]"].includes(host) || /^127\.\d+\.\d+\.\d+$/.test(host);

/** Off-site upload is opt-in. Returns undefined when no snapshot storage is configured. */
export function snapshotStorageFromEnv(env: Record<string, string | undefined>): SnapshotStorage | undefined {
  const names = ["DOHC_SNAPSHOT_S3_ENDPOINT", "DOHC_SNAPSHOT_S3_BUCKET", "DOHC_SNAPSHOT_S3_ACCESS_KEY_ID", "DOHC_SNAPSHOT_S3_SECRET_ACCESS_KEY"] as const;
  const values = names.map(name => env[name]?.trim() || undefined);
  if (values.every(value => value === undefined)) return undefined;
  const missing = names.filter((_, index) => values[index] === undefined);
  if (missing.length) throw new Error(`Snapshot storage is partly configured. Set ${missing.join(", ")}.`);
  const [endpointValue, bucket, accessKeyId, secretAccessKey] = values as string[];
  let endpoint: URL;
  try { endpoint = new URL(endpointValue!); } catch { throw new Error("Set DOHC_SNAPSHOT_S3_ENDPOINT to the storage service's HTTPS origin."); }
  if (endpoint.origin !== endpointValue || endpoint.username || endpoint.password ||
      !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && loopback(endpoint.hostname)))) {
    throw new Error("Set DOHC_SNAPSHOT_S3_ENDPOINT to the storage service's HTTPS origin.");
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket!)) throw new Error("Set DOHC_SNAPSHOT_S3_BUCKET to a valid bucket name.");
  return { endpoint, bucket: bucket!, region: env.DOHC_SNAPSHOT_S3_REGION?.trim() || "auto", accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! };
}

const encodeSegment = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();

/** AWS Signature Version 4 for one request with no query string. Header names must be lowercase. */
export function signS3Request(input: { method: string; path: string; headers: Record<string, string>; region: string;
  accessKeyId: string; secretAccessKey: string }): string {
  const amzDate = input.headers["x-amz-date"]!, payload = input.headers["x-amz-content-sha256"]!;
  const names = Object.keys(input.headers).sort();
  const canonical = [input.method, input.path, "", ...names.map(name => `${name}:${input.headers[name]!.trim()}`), "",
    names.join(";"), payload].join("\n");
  const scope = `${amzDate.slice(0, 8)}/${input.region}/s3/aws4_request`;
  const signing = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  let key = hmac(`AWS4${input.secretAccessKey}`, amzDate.slice(0, 8));
  for (const part of [input.region, "s3", "aws4_request"]) key = hmac(key, part);
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${hmac(key, signing).toString("hex")}`;
}

/**
 * One signed PUT under a unique key. S3 stores an object only after the whole body arrives and
 * matches its signed SHA-256, so an interrupted upload leaves nothing under the name.
 */
export async function uploadRelaySnapshot(snapshot: SealedRelaySnapshot, storage: SnapshotStorage, now = new Date()): Promise<string> {
  const { size } = await stat(snapshot.path);
  if (size > RELAY_SNAPSHOT_UPLOAD_LIMIT) throw new Error("The sealed snapshot is larger than 5 GB, the single upload limit. Save it with --directory instead.");
  const objectKey = `${snapshot.manifest.namespace}/${snapshot.name}`;
  const path = `/${encodeSegment(storage.bucket)}/${objectKey.split("/").map(encodeSegment).join("/")}`;
  const sha256 = createHash("sha256"), md5 = createHash("md5");
  for await (const chunk of createReadStream(snapshot.path)) { sha256.update(chunk); md5.update(chunk); }
  const headers: Record<string, string> = {
    // S3 refuses uploads to a bucket with Object Lock retention without Content-MD5.
    "content-md5": md5.digest("base64"),
    host: storage.endpoint.host,
    "x-amz-content-sha256": sha256.digest("hex"),
    "x-amz-date": now.toISOString().replace(/[-:]|\.\d{3}/g, ""),
  };
  const authorization = signS3Request({ method: "PUT", path, headers, ...storage });
  const send = storage.endpoint.protocol === "https:" ? httpsRequest : httpRequest;
  await new Promise<void>((resolve, reject) => {
    const request = send(new URL(path, storage.endpoint), {
      method: "PUT", timeout: 60_000, headers: { ...headers, authorization, "content-length": String(size) },
    }, (response: IncomingMessage) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { if (body.length < 4096) body += chunk; });
      response.on("error", reject);
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) return resolve();
        const code = /<Code>([A-Za-z0-9]{1,64})<\/Code>/.exec(body)?.[1];
        reject(new Error(`Snapshot storage refused the upload (HTTP ${status}${code ? ` ${code}` : ""}). Check the bucket, credentials and endpoint.`));
      });
    });
    request.on("timeout", () => request.destroy(new Error("The snapshot upload timed out.")));
    pipeline(createReadStream(snapshot.path), request).catch(reject);
  });
  return objectKey;
}
