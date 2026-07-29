import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type {
  ActorNeutralWriteMetadata,
  SyncApplyResult,
  SyncReplicationEnvelope,
  SecretFileCompareEntry,
  SecretFileDeleteOutcome,
  SecretFileMaterialization,
  SecretFileMoment,
  SecretFileRestoreOutcome,
  SecretFileStat,
  SecretFileStore,
  SecretFileStoreErrorCode,
  SecretFileStoreOptions,
  SecretFileWriteOutcome,
  SecretVersionForkPayload,
  VersionId,
  WorkspaceId,
} from "@dohc/workspace-contracts/engine";
import { validateUserWritePath } from "@dohc/workspace-core";
import {
  ENGINE_SQLITE_BUSY_TIMEOUT_MS,
  assertEngineSqliteIntegrity,
  initializeOrValidateEngineSchema,
  trackEngineDbHandleForTest,
} from "./engineDbSchema";
import { classifyEngineFilePath } from "./enginePathFloor";
import {
  ackReplicationPeer,
  appliedApplyResult,
  journalLocalReplicationOp,
  journalReplicationOp,
  readReplicationAckedSeq,
  skippedApplyResult,
} from "./syncReplication";
import { VERSIONED_TEXT_STORE_RELATIVE_PATH } from "./versionedTextStore";

// Secret-backed files (PR 08): the dedicated driver for secret-classified
// paths (`.env`-style, decided by the classifyEngineFilePath floor that
// .dohc policy can never unmark).
//
// What this store guarantees:
//   - Content at rest is ALWAYS AES-256-GCM ciphertext (random 96-bit IV per
//     write, auth tag stored, AAD binding workspace+path so ciphertext rows
//     cannot be spliced across files). No plaintext, and nothing derived from
//     the plaintext except its byte length, ever reaches engine.db.
//   - History moments are metadata-only ("Updated .env", origin, timestamps)
//     plus the encrypted after-state that powers restore. The SecretFileMoment
//     type has no content field, by construction.
//   - The ONLY plaintext accessor is materializeSecretFile, used exclusively
//     by dohc's own disk materialization flows (version switch/merge/restore)
//     — the file was already plaintext on disk, so that is the same trust
//     boundary. Every other method returns metadata only.
//   - Tampering fails closed: a flipped ciphertext/auth-tag byte or a wrong
//     key surfaces as a decrypt-failed error, never as garbage plaintext.
//
// Key custody (decision recorded for PR 08): the per-workspace data key lives
// in `<root>/.dohc/engine/secret.key` (0600, dir 0700), NOT in the OS
// credential store. Rationale: the existing cloudCredentialStore pattern is
// an Electron-safeStorage-sealed file in the per-install app-data dir — it is
// not reusable here because (a) @dohc/workspace-engine must run without
// Electron (vitest, MCP, headless Node), (b) it would bind per-workspace
// engine data to a per-install app credential, and (c) on Linux/WSL without a
// secret service it degrades to plaintext-on-disk anyway — the same boundary
// as a 0600 key file. The key file format is versioned so an OS-keychain wrap
// can be layered on later without migration.
//
// Honest downgrade note (plan-honest, per Refined Implementation Default 8):
// a same-user local process can read the key file — and can equally read the
// materialized plaintext `.env` sitting beside it in the workspace folder.
// dohc does not claim per-process enforcement after plaintext
// materialization. The encryption's real job is keeping secrets out of
// dohc's durable, derived, and replicated surfaces: history, search, export,
// sync payloads, chats, and logs.

export const SECRET_FILE_STORE_RELATIVE_PATH = VERSIONED_TEXT_STORE_RELATIVE_PATH;
export const SECRET_KEY_RELATIVE_PATH = ".dohc/engine/secret.key";
export const MAX_SECRET_FILE_BYTES = 1024 * 1024;

const SECRET_KEY_FILE_PREFIX = "dohc-secret-key-v1:";
const SECRET_KEY_BYTES = 32;
const SECRET_IV_BYTES = 12;
const SECRET_AUTH_TAG_BYTES = 16;
const SECRET_AAD_PREFIX = "dohc-secret-v1";
const MAX_METADATA_FIELD_BYTES = 16 * 1024;
const LOWER_SHA256_HEX = /^[0-9a-f]{64}$/u;

export type {
  SecretFileCompareEntry,
  SecretFileDeleteOutcome,
  SecretFileMaterialization,
  SecretFileMoment,
  SecretFileRestoreOutcome,
  SecretFileStat,
  SecretFileStore,
  SecretFileStoreErrorCode,
  SecretFileStoreOptions,
  SecretFileWriteOutcome,
} from "@dohc/workspace-contracts/engine";

export class SecretFileStoreError extends Error {
  readonly code: SecretFileStoreErrorCode;

  constructor(code: SecretFileStoreErrorCode, message: string) {
    super(message);
    this.name = "SecretFileStoreError";
    this.code = code;
  }
}

interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number };
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  readonly isOpen?: boolean;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb;
}

const requireModule = createRequire(import.meta.url);

function nodeSqlite(): SqliteModule {
  return requireModule("node:sqlite") as SqliteModule;
}

function corruptStore(cause?: unknown): SecretFileStoreError {
  const error = new SecretFileStoreError("state-corrupt", "Secret file store is corrupt.");
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
}

function decryptFailed(cause?: unknown): SecretFileStoreError {
  const error = new SecretFileStoreError(
    "decrypt-failed",
    "Protected file contents could not be decrypted (wrong key or tampered data); failing closed.",
  );
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
}

function openDatabase(rootDir: string): SqliteDb {
  const path = join(resolve(rootDir), SECRET_FILE_STORE_RELATIVE_PATH);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = nodeSqlite();
  let db: SqliteDb;
  try {
    db = trackEngineDbHandleForTest(new DatabaseSync(path));
  } catch (error) {
    throw corruptStore(error);
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${ENGINE_SQLITE_BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    // Schema bootstrap + integrity are shared with versionedTextStore and
    // linkedChatStore (one engine.db, one DDL owner — see engineDbSchema.ts).
    initializeOrValidateEngineSchema(db, corruptStore);
    assertEngineSqliteIntegrity(db, corruptStore);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {}
    if (error instanceof SecretFileStoreError) throw error;
    throw corruptStore(error);
  }
}

// --- key custody -------------------------------------------------------------

function keyFilePath(rootDir: string): string {
  return join(resolve(rootDir), SECRET_KEY_RELATIVE_PATH);
}

function parseKeyFile(content: string): Buffer {
  const trimmed = content.trim();
  if (!trimmed.startsWith(SECRET_KEY_FILE_PREFIX)) {
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file is malformed; refusing to touch protected files. (dohc never regenerates a key over an existing file — that would orphan every protected snapshot.)",
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(trimmed.slice(SECRET_KEY_FILE_PREFIX.length), "base64");
  } catch {
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file is malformed; refusing to touch protected files.",
    );
  }
  if (key.length !== SECRET_KEY_BYTES) {
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file is malformed; refusing to touch protected files.",
    );
  }
  return key;
}

export async function loadSecretDataKey(
  rootDir: string,
  options: { createIfMissing: boolean },
): Promise<Buffer> {
  const path = keyFilePath(rootDir);
  try {
    const content = await readFile(path, "utf8");
    // Heal lax perms on existing key files (the cloudCredentialStore rule):
    // the key must stay owner-only. No-op/ignored on Windows.
    await chmod(path, 0o600).catch(() => undefined);
    return parseKeyFile(content);
  } catch (error) {
    if (error instanceof SecretFileStoreError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SecretFileStoreError(
        "key-corrupt",
        "The workspace secret key file could not be read; refusing to touch protected files.",
      );
    }
  }
  if (!options.createIfMissing) {
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file is missing but protected data exists; failing closed.",
    );
  }
  // First secret capture: generate the per-workspace data key. Exclusive
  // create (wx) settles a two-process first-write race: exactly one writer
  // wins, the loser re-reads the winner's key.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(SECRET_KEY_BYTES);
  const payload = `${SECRET_KEY_FILE_PREFIX}${key.toString("base64")}\n`;
  try {
    await writeFile(path, payload, { flag: "wx", mode: 0o600 });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const content = await readFile(path, "utf8");
      await chmod(path, 0o600).catch(() => undefined);
      return parseKeyFile(content);
    }
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file could not be created; refusing to store protected files.",
    );
  }
}

function protectedRowsExist(txDb: SqliteDb, workspaceId: WorkspaceId): boolean {
  return (
    txDb
      .prepare("SELECT 1 FROM secret_moments WHERE workspace_id = ? LIMIT 1")
      .get(workspaceId) !== undefined ||
    txDb
      .prepare("SELECT 1 FROM secret_files WHERE workspace_id = ? LIMIT 1")
      .get(workspaceId) !== undefined
  );
}

// Reading secret state is a pure query: it must NEVER create the shared engine
// store. An absent engine.db means no protected rows can exist, so the read
// short-circuits before openDatabase (which would mkdir + create the file).
// This upholds the opted-out invariant — a workspace that opted out of the
// engine has no engine.db, and merely probing its secret/enrollment state (the
// cloud-status IPC does this on every workspace open) must not grow one. The
// guard is a plain existence check, identical on every platform.
function engineStoreExists(rootDir: string): boolean {
  return existsSync(join(resolve(rootDir), SECRET_FILE_STORE_RELATIVE_PATH));
}

export async function readWorkspaceDataKeyForEnrollment(
  rootDir: string,
  workspaceIdInput: string,
): Promise<Buffer | null> {
  const workspaceId = normalizeWorkspaceId(workspaceIdInput);
  if (!engineStoreExists(rootDir)) return null;
  const txDb = openDatabase(rootDir);
  try {
    if (!protectedRowsExist(txDb, workspaceId)) return null;
  } finally {
    txDb.close();
  }
  return loadSecretDataKey(rootDir, { createIfMissing: false });
}

export type WorkspaceSecretState = "none" | "protected-key-present" | "protected-key-missing";

export async function readWorkspaceSecretState(
  rootDir: string,
  workspaceIdInput: string,
): Promise<WorkspaceSecretState> {
  const workspaceId = normalizeWorkspaceId(workspaceIdInput);
  if (!engineStoreExists(rootDir)) return "none";
  const txDb = openDatabase(rootDir);
  try {
    if (!protectedRowsExist(txDb, workspaceId)) return "none";
  } finally {
    txDb.close();
  }
  return existsSync(keyFilePath(rootDir)) ? "protected-key-present" : "protected-key-missing";
}

export async function installWorkspaceDataKey(rootDir: string, keyInput: Uint8Array): Promise<void> {
  const key = Buffer.from(keyInput);
  if (key.length !== SECRET_KEY_BYTES) {
    throw new SecretFileStoreError("key-corrupt", "Workspace secret key has an invalid length.");
  }
  const path = keyFilePath(rootDir);
  try {
    const existing = parseKeyFile(await readFile(path, "utf8"));
    await chmod(path, 0o600).catch(() => undefined);
    if (existing.equals(key)) return;
    throw new SecretFileStoreError(
      "key-corrupt",
      "A different workspace secret key already exists locally; refusing to overwrite protected state.",
    );
  } catch (error) {
    if (error instanceof SecretFileStoreError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SecretFileStoreError(
        "key-corrupt",
        "The workspace secret key file could not be read; refusing to install a replacement.",
      );
    }
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const payload = `${SECRET_KEY_FILE_PREFIX}${key.toString("base64")}\n`;
  try {
    await writeFile(path, payload, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return installWorkspaceDataKey(rootDir, key);
    }
    throw new SecretFileStoreError(
      "key-corrupt",
      "The workspace secret key file could not be installed.",
    );
  }
}

// --- crypto ------------------------------------------------------------------

interface SecretCipherText {
  ivBase64: string;
  authTagBase64: string;
  ciphertextBase64: string;
  byteLength: number;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function secretAad(workspaceId: WorkspaceId, path: string): Buffer {
  // Binds ciphertext to its workspace and path so rows cannot be spliced
  // across files. Deliberately NOT version-bound: fork/merge/restore copy
  // ciphertext across versions of the SAME path without re-encryption.
  return Buffer.from(`${SECRET_AAD_PREFIX}\0${workspaceId}\0${path}`, "utf8");
}

function encryptSecretText(
  key: Buffer,
  workspaceId: WorkspaceId,
  path: string,
  text: string,
): SecretCipherText {
  const iv = randomBytes(SECRET_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(secretAad(workspaceId, path));
  const plaintext = Buffer.from(text, "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ivBase64: iv.toString("base64"),
    authTagBase64: cipher.getAuthTag().toString("base64"),
    ciphertextBase64: ciphertext.toString("base64"),
    byteLength: plaintext.length,
  };
}

function decryptSecretText(
  key: Buffer,
  workspaceId: WorkspaceId,
  path: string,
  sealed: SecretCipherText,
): string {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(sealed.ivBase64, "base64"),
    );
    decipher.setAAD(secretAad(workspaceId, path));
    decipher.setAuthTag(Buffer.from(sealed.authTagBase64, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertextBase64, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch (error) {
    throw decryptFailed(error);
  }
}

// --- validation ---------------------------------------------------------------

function normalizeWorkspaceId(workspaceId: string): WorkspaceId {
  if (typeof workspaceId !== "string" || !workspaceId.trim()) {
    throw new SecretFileStoreError("invalid-workspace", "Workspace id is required.");
  }
  return workspaceId.trim();
}

function normalizeSecretPath(path: string): string {
  if (typeof path !== "string") {
    throw new SecretFileStoreError("invalid-path", "Workspace path must be a string.");
  }
  const result = validateUserWritePath(path);
  if (!result.ok) {
    throw new SecretFileStoreError(
      "invalid-path",
      `Invalid workspace path ${JSON.stringify(path)}: ${result.reason}`,
    );
  }
  if (classifyEngineFilePath(result.normalized).kind !== "secret") {
    // Fail closed in BOTH directions: this store must never hold a tracked
    // path (that would hide ordinary text from normal history) and the text
    // store must never hold a secret path (that would leak plaintext).
    throw new SecretFileStoreError(
      "not-secret-path",
      `Path ${JSON.stringify(path)} is not secret-classified; only the secret floor's paths belong in the secret file store.`,
    );
  }
  return result.normalized;
}

function normalizeSecretText(text: string): string {
  if (typeof text !== "string") {
    throw new SecretFileStoreError("invalid-text", "Protected file contents must be a string.");
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_SECRET_FILE_BYTES) {
    throw new SecretFileStoreError(
      "invalid-text",
      "Protected file contents are too large for the secret file store.",
    );
  }
  if (bytes.toString("utf8") !== text) {
    throw new SecretFileStoreError(
      "invalid-text",
      "Protected file contents must round-trip through UTF-8.",
    );
  }
  return text;
}

const WRITE_ORIGINS = new Set(["api", "local-file", "restore", "sync", "unknown"]);

function normalizeMetadata(metadata: ActorNeutralWriteMetadata): ActorNeutralWriteMetadata {
  if (metadata === null || typeof metadata !== "object") {
    throw new SecretFileStoreError("invalid-metadata", "Write metadata is required.");
  }
  if (!WRITE_ORIGINS.has(metadata.origin)) {
    throw new SecretFileStoreError("invalid-metadata", "Write metadata origin is invalid.");
  }
  for (const field of [metadata.summary, metadata.correlationId]) {
    if (field === undefined) continue;
    if (typeof field !== "string" || Buffer.byteLength(field, "utf8") > MAX_METADATA_FIELD_BYTES) {
      throw new SecretFileStoreError("invalid-metadata", "Write metadata field is invalid.");
    }
  }
  return {
    origin: metadata.origin,
    ...(metadata.summary !== undefined ? { summary: metadata.summary } : {}),
    ...(metadata.correlationId !== undefined
      ? { correlationId: metadata.correlationId }
      : {}),
  };
}

function invalidReplicationPayload(): SecretFileStoreError {
  return new SecretFileStoreError("invalid-input", "Secret replication payload is invalid.");
}

function normalizeBase64Field(value: unknown, expectedLength: number): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw invalidReplicationPayload();
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== expectedLength || bytes.toString("base64") !== value) {
    throw invalidReplicationPayload();
  }
  return value;
}

function normalizeCiphertextSha256(value: unknown): string {
  if (typeof value !== "string" || !LOWER_SHA256_HEX.test(value)) {
    throw invalidReplicationPayload();
  }
  return value;
}

function normalizeSecretByteLength(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_SECRET_FILE_BYTES
  ) {
    throw invalidReplicationPayload();
  }
  return value;
}

function normalizeRemoteUpdatedAtMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidReplicationPayload();
  }
  return value;
}

function normalizeLatestMomentId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidReplicationPayload();
  }
  return value;
}

function normalizeSecretForkPayload(payload: unknown): SecretVersionForkPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalidReplicationPayload();
  }
  const input = payload as Record<string, unknown>;
  if (!Array.isArray(input.rows)) throw invalidReplicationPayload();
  return {
    toVersionId: normalizeLatestMomentId(input.toVersionId),
    fromVersionId: normalizeLatestMomentId(input.fromVersionId),
    rows: input.rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw invalidReplicationPayload();
      }
      const entry = row as Record<string, unknown>;
      return {
        path: normalizeSecretPath(entry.path as string),
        ivBase64: normalizeBase64Field(entry.ivBase64, SECRET_IV_BYTES),
        authTagBase64: normalizeBase64Field(entry.authTagBase64, SECRET_AUTH_TAG_BYTES),
        ciphertextSha256: normalizeCiphertextSha256(entry.ciphertextSha256),
        byteLength: normalizeSecretByteLength(entry.byteLength),
        updatedAtMs: normalizeRemoteUpdatedAtMs(entry.updatedAtMs),
        latestMomentId: normalizeLatestMomentId(entry.latestMomentId),
      };
    }),
  };
}

function requireVersionRow(db: SqliteDb, workspaceId: WorkspaceId, versionId: string): VersionId {
  if (typeof versionId !== "string" || !versionId.trim()) {
    throw new SecretFileStoreError("invalid-version", "Version id is required.");
  }
  const row = db
    .prepare("SELECT 1 FROM versions WHERE workspace_id = ? AND version_id = ?")
    .get(workspaceId, versionId);
  if (!row) {
    throw new SecretFileStoreError(
      "invalid-version",
      `Version ${versionId} was not found in workspace ${workspaceId}.`,
    );
  }
  return versionId;
}

// --- row mapping ---------------------------------------------------------------

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw corruptStore();
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw corruptStore();
  return value;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw corruptStore();
  return value;
}

function operationValue(value: unknown): "write" | "delete" {
  const operation = stringValue(value);
  if (operation !== "write" && operation !== "delete") throw corruptStore();
  return operation;
}

function momentFromRow(row: Record<string, unknown>): SecretFileMoment {
  const summary = optionalString(row.metadata_summary);
  const correlationId = optionalString(row.metadata_correlation_id);
  return {
    id: stringValue(row.moment_id),
    workspaceId: stringValue(row.workspace_id),
    versionId: stringValue(row.version_id),
    path: stringValue(row.path),
    recordedAtMs: numberValue(row.recorded_at_ms),
    operation: operationValue(row.operation),
    metadata: {
      origin: stringValue(row.metadata_origin) as ActorNeutralWriteMetadata["origin"],
      ...(summary !== undefined ? { summary } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
    },
    momentOrder: numberValue(row.moment_order),
    protected: true,
  };
}

function sealedFromRow(row: Record<string, unknown>): SecretCipherText {
  return {
    ivBase64: stringValue(row.iv_base64),
    authTagBase64: stringValue(row.auth_tag_base64),
    ciphertextBase64: stringValue(row.ciphertext_base64),
    byteLength: numberValue(row.byte_length),
  };
}

function sealedFromMomentRow(row: Record<string, unknown>): SecretCipherText | null {
  if (Number(row.after_present) !== 1) return null;
  return {
    ivBase64: stringValue(row.after_iv_base64),
    authTagBase64: stringValue(row.after_auth_tag_base64),
    ciphertextBase64: stringValue(row.after_ciphertext_base64),
    byteLength: numberValue(row.after_byte_length),
  };
}

type SecretMomentRank = [number, number, string, string, string];

function momentRank(recordedAtMs: number, after: SecretCipherText | null): SecretMomentRank {
  return [
    recordedAtMs,
    after ? 1 : 0,
    after?.ciphertextBase64 ?? "",
    after?.ivBase64 ?? "",
    after?.authTagBase64 ?? "",
  ];
}

function compareMomentRank(left: SecretMomentRank, right: SecretMomentRank): number {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    // String elements MUST compare by raw code units (`<`/`>`), never
    // localeCompare: the rank has to be identical on every machine
    // regardless of locale, and it has to agree with the SQLite BINARY
    // collation used by remoteShouldUpdateTip's ORDER BY. Base64 is ASCII,
    // where code-unit order and byte order coincide.
    const compared =
      typeof a === "number" && typeof b === "number" ? a - b : a < b ? -1 : a > b ? 1 : 0;
    if (compared < 0) return -1;
    if (compared > 0) return 1;
  }
  return 0;
}

function importedReplicationLogExists(txDb: SqliteDb, input: SyncReplicationEnvelope): boolean {
  return (
    txDb
      .prepare(
        `SELECT 1 FROM replication_log
         WHERE workspace_id = ? AND origin_id = ? AND origin_seq = ?`,
      )
      .get(input.workspaceId, input.originId, input.originSeq) !== undefined
  );
}

function journalImportedReplicationOp(txDb: SqliteDb, input: SyncReplicationEnvelope): void {
  journalReplicationOp(txDb, {
    workspaceId: input.workspaceId,
    originId: input.originId,
    originSeq: input.originSeq,
    opKind: input.opKind,
    payload: input.payload,
    recordedAtMs: input.recordedAtMs,
  });
}

function persistSecretCiphertextBlob(txDb: SqliteDb, sealed: SecretCipherText): string {
  const bytes = Buffer.from(sealed.ciphertextBase64, "base64");
  const sha = sha256Bytes(bytes);
  txDb
    .prepare("INSERT OR IGNORE INTO binary_blobs (sha256, byte_length, content) VALUES (?, ?, ?)")
    .run(sha, bytes.byteLength, bytes);
  txDb
    .prepare("INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?, ?, '')")
    .run(sha, bytes.byteLength);
  return sha;
}

function ciphertextBlobBySha(txDb: SqliteDb, sha: string): Buffer {
  const row = txDb.prepare("SELECT content FROM binary_blobs WHERE sha256 = ?").get(sha);
  const content = row?.content;
  const bytes = Buffer.isBuffer(content)
    ? content
    : content instanceof Uint8Array
      ? Buffer.from(content)
      : null;
  if (!bytes || sha256Bytes(bytes) !== sha) throw corruptStore();
  return bytes;
}

// Secret ciphertext refs ride the shared binary-blob transport, whose cap
// (5 MiB, MAX_VERSIONED_BINARY_FILE_BYTES) is far above the secret plaintext
// cap (1 MiB). AES-256-GCM here is length-preserving — the 16-byte auth tag
// and 12-byte IV travel in their own payload fields — so the honest GCM
// overhead allowance is exactly ZERO bytes: ciphertext length must equal the
// declared plaintext byteLength, which normalizeSecretByteLength already caps
// at MAX_SECRET_FILE_BYTES. Enforce both before any moment/tip/fork-base
// insert so a poison op cannot park a 5 MiB blob behind a small declaration
// (or a short blob behind a large one).
function secretCiphertextBlobBySha(
  txDb: SqliteDb,
  sha: string,
  declaredByteLength: number,
): Buffer {
  const bytes = ciphertextBlobBySha(txDb, sha);
  if (bytes.byteLength > MAX_SECRET_FILE_BYTES || bytes.byteLength !== declaredByteLength) {
    throw new SecretFileStoreError(
      "invalid-input",
      `Secret ciphertext blob ${sha} is ${bytes.byteLength} bytes but the payload declares ` +
        `${declaredByteLength}; rejecting the replication op.`,
    );
  }
  return bytes;
}

function journalSecretFileMoment(
  txDb: SqliteDb,
  input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
    metadata: ActorNeutralWriteMetadata;
    after: SecretCipherText | null;
    recordedAtMs: number;
  },
): void {
  if (input.after) {
    const ciphertextSha256 = persistSecretCiphertextBlob(txDb, input.after);
    journalLocalReplicationOp(txDb, {
      workspaceId: input.workspaceId,
      opKind: "secret.file.put",
      payload: {
        versionId: input.versionId,
        path: input.path,
        metadata: input.metadata,
        ivBase64: input.after.ivBase64,
        authTagBase64: input.after.authTagBase64,
        ciphertextSha256,
        byteLength: input.after.byteLength,
      },
      recordedAtMs: input.recordedAtMs,
    });
    return;
  }
  journalLocalReplicationOp(txDb, {
    workspaceId: input.workspaceId,
    opKind: "secret.file.delete",
    payload: {
      versionId: input.versionId,
      path: input.path,
      metadata: input.metadata,
    },
    recordedAtMs: input.recordedAtMs,
  });
}

function defaultCreateId(kind: "moment"): string {
  return `secret-${kind}_${randomUUID()}`;
}

export function createSecretFileStore(
  rootDir: string,
  options: SecretFileStoreOptions = {},
): SecretFileStore {
  const nowMs = options.nowMs ?? (() => Date.now());
  const createId = options.createId ?? defaultCreateId;
  let writeChain: Promise<unknown> = Promise.resolve();
  let dbHandle: SqliteDb | null = null;
  let cachedKey: Buffer | null = null;

  function db(): SqliteDb {
    if (!dbHandle || dbHandle.isOpen === false) {
      // A handle can be closed out from under the store (the test-teardown
      // sweep releases Windows file locks between tests); reopen instead of
      // returning a dead handle.
      dbHandle = openDatabase(rootDir);
    }
    return dbHandle;
  }

  async function dataKey(createIfMissing: boolean): Promise<Buffer> {
    if (cachedKey) return cachedKey;
    cachedKey = await loadSecretDataKey(rootDir, { createIfMissing });
    return cachedKey;
  }

  function serialize<T>(task: (db: SqliteDb) => Promise<T>): Promise<T> {
    const run = writeChain.then(
      () => withTransaction(task),
      () => withTransaction(task),
    );
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function afterWrites<T>(task: (db: SqliteDb) => Promise<T>): Promise<T> {
    await writeChain;
    return task(db());
  }

  async function withTransaction<T>(task: (db: SqliteDb) => Promise<T>): Promise<T> {
    const txDb = db();
    try {
      txDb.exec("BEGIN IMMEDIATE");
      const result = await task(txDb);
      txDb.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        txDb.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  function selectTip(
    txDb: SqliteDb,
    workspaceId: WorkspaceId,
    versionId: VersionId,
    path: string,
  ): SecretCipherText | null {
    const row = txDb
      .prepare(
        "SELECT * FROM secret_files WHERE workspace_id = ? AND version_id = ? AND path = ?",
      )
      .get(workspaceId, versionId, path);
    return row ? sealedFromRow(row) : null;
  }

  function selectForkBase(
    txDb: SqliteDb,
    workspaceId: WorkspaceId,
    versionId: VersionId,
    path: string,
  ): { present: boolean; sealed: SecretCipherText | null } {
    const row = txDb
      .prepare(
        "SELECT * FROM secret_fork_bases WHERE workspace_id = ? AND version_id = ? AND path = ?",
      )
      .get(workspaceId, versionId, path);
    if (!row) return { present: false, sealed: null };
    return { present: true, sealed: sealedFromRow(row) };
  }

  // True when ANY protected data exists for the workspace. The data key may
  // only ever be CREATED while this is false: generating a fresh key beside
  // rows sealed under a lost key would silently orphan them — the missing-key
  // case must fail closed instead.
  function hasProtectedRows(txDb: SqliteDb, workspaceId: WorkspaceId): boolean {
    return protectedRowsExist(txDb, workspaceId);
  }

  function nextMomentOrder(txDb: SqliteDb, workspaceId: WorkspaceId): number {
    const row = txDb
      .prepare(
        "SELECT COALESCE(MAX(moment_order) + 1, 0) AS next FROM secret_moments WHERE workspace_id = ?",
      )
      .get(workspaceId);
    return Number(row?.next ?? 0);
  }

  function insertMoment(
    txDb: SqliteDb,
    input: {
      workspaceId: WorkspaceId;
      versionId: VersionId;
      path: string;
      operation: "write" | "delete";
      metadata: ActorNeutralWriteMetadata;
      after: SecretCipherText | null;
      recordedAtMs?: number;
      updateTip?: boolean;
    },
  ): SecretFileMoment {
    const momentId = createId("moment");
    const recordedAtMs = input.recordedAtMs ?? nowMs();
    const momentOrder = nextMomentOrder(txDb, input.workspaceId);
    txDb
      .prepare(
        `INSERT INTO secret_moments (
          workspace_id, moment_order, moment_id, version_id, path,
          recorded_at_ms, operation, metadata_origin, metadata_summary,
          metadata_correlation_id, after_present, after_iv_base64,
          after_auth_tag_base64, after_ciphertext_base64, after_byte_length
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.workspaceId,
        momentOrder,
        momentId,
        input.versionId,
        input.path,
        recordedAtMs,
        input.operation,
        input.metadata.origin,
        input.metadata.summary ?? null,
        input.metadata.correlationId ?? null,
        input.after ? 1 : 0,
        input.after?.ivBase64 ?? null,
        input.after?.authTagBase64 ?? null,
        input.after?.ciphertextBase64 ?? null,
        input.after?.byteLength ?? null,
      );
    const updateTip = input.updateTip ?? true;
    // Local engine writes are authoritative for the local materialized tip
    // regardless of rank. That means a machine whose clock is behind an
    // already-imported remote moment can display a lower-ranked local tip
    // until its next replicated/imported change. This is accepted for alpha
    // as clock-skew weirdness, and must remain documented as a residual risk.
    if (input.after && updateTip) {
      txDb
        .prepare(
          `INSERT INTO secret_files (
            workspace_id, version_id, path, iv_base64, auth_tag_base64,
            ciphertext_base64, byte_length, updated_at_ms, latest_moment_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, version_id, path) DO UPDATE SET
            iv_base64 = excluded.iv_base64,
            auth_tag_base64 = excluded.auth_tag_base64,
            ciphertext_base64 = excluded.ciphertext_base64,
            byte_length = excluded.byte_length,
            updated_at_ms = excluded.updated_at_ms,
            latest_moment_id = excluded.latest_moment_id`,
        )
        .run(
          input.workspaceId,
          input.versionId,
          input.path,
          input.after.ivBase64,
          input.after.authTagBase64,
          input.after.ciphertextBase64,
          input.after.byteLength,
          recordedAtMs,
          momentId,
        );
    } else if (updateTip) {
      txDb
        .prepare(
          "DELETE FROM secret_files WHERE workspace_id = ? AND version_id = ? AND path = ?",
        )
        .run(input.workspaceId, input.versionId, input.path);
    }
    return {
      id: momentId,
      workspaceId: input.workspaceId,
      versionId: input.versionId,
      path: input.path,
      recordedAtMs,
      operation: input.operation,
      metadata: input.metadata,
      momentOrder,
      protected: true,
    };
  }

  function remoteShouldUpdateTip(
    txDb: SqliteDb,
    workspaceId: WorkspaceId,
    versionId: VersionId,
    path: string,
    recordedAtMs: number,
    after: SecretCipherText | null,
  ): boolean {
    const latest = txDb
      .prepare(
        `SELECT recorded_at_ms, after_present, after_iv_base64, after_auth_tag_base64,
           after_ciphertext_base64, after_byte_length
         FROM secret_moments
         WHERE workspace_id = ? AND version_id = ? AND path = ?
         ORDER BY recorded_at_ms DESC, after_present DESC,
           COALESCE(after_ciphertext_base64, '') DESC,
           COALESCE(after_iv_base64, '') DESC,
           COALESCE(after_auth_tag_base64, '') DESC
         LIMIT 1`,
      )
      .get(workspaceId, versionId, path);
    if (latest === undefined) return true;
    // Imported tips use a deterministic content rank instead of machine-local
    // moment_order. On exact timestamp ties a write beats a delete
    // (after_present 1 > 0) on both machines; two same-time writes are won by
    // the lexicographically larger ciphertext on both machines. Equal rank is
    // byte-identical sealed content, so >= is idempotent-safe.
    return compareMomentRank(
      momentRank(recordedAtMs, after),
      momentRank(numberValue(latest.recorded_at_ms), sealedFromMomentRow(latest)),
    ) >= 0;
  }

  // Internal-only plaintext comparison; the decrypted value never leaves this
  // closure. A decrypt failure fails closed (loud), never "assume different".
  function decryptTip(
    key: Buffer,
    workspaceId: WorkspaceId,
    path: string,
    sealed: SecretCipherText | null,
  ): string | null {
    if (!sealed) return null;
    return decryptSecretText(key, workspaceId, path, sealed);
  }

  return {
    applyReplicationOp(input): Promise<SyncApplyResult> {
      return serialize(async (txDb) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        if (
          input.workspaceId !== workspaceId ||
          typeof input.originId !== "string" ||
          !input.originId ||
          !Number.isInteger(input.originSeq) ||
          input.originSeq < 0 ||
          typeof input.recordedAtMs !== "number" ||
          !Number.isFinite(input.recordedAtMs)
        ) {
          throw new SecretFileStoreError("invalid-input", "Replication envelope is invalid.");
        }
        const ackedSeq = readReplicationAckedSeq(txDb, workspaceId, input.originId);
        if (input.originSeq <= ackedSeq) return skippedApplyResult();
        if (importedReplicationLogExists(txDb, input)) {
          ackReplicationPeer(txDb, workspaceId, input.originId, input.originSeq);
          return skippedApplyResult();
        }
        if (input.originSeq !== ackedSeq + 1) {
          throw new SecretFileStoreError(
            "state-corrupt",
            `Replication origin ${input.originId} has a gap before sequence ${input.originSeq}.`,
          );
        }

        switch (input.opKind) {
          case "secret.file.put": {
            const payload = input.payload;
            const versionId = requireVersionRow(txDb, workspaceId, payload.versionId);
            const path = normalizeSecretPath(payload.path);
            const metadata = normalizeMetadata(payload.metadata);
            const ivBase64 = normalizeBase64Field(payload.ivBase64, SECRET_IV_BYTES);
            const authTagBase64 = normalizeBase64Field(
              payload.authTagBase64,
              SECRET_AUTH_TAG_BYTES,
            );
            const ciphertextSha256 = normalizeCiphertextSha256(payload.ciphertextSha256);
            const byteLength = normalizeSecretByteLength(payload.byteLength);
            const ciphertext = secretCiphertextBlobBySha(txDb, ciphertextSha256, byteLength);
            const after = {
              ivBase64,
              authTagBase64,
              ciphertextBase64: ciphertext.toString("base64"),
              byteLength,
            };
            insertMoment(txDb, {
              workspaceId,
              versionId,
              path,
              operation: "write",
              metadata,
              after,
              recordedAtMs: input.recordedAtMs,
              updateTip: remoteShouldUpdateTip(
                txDb,
                workspaceId,
                versionId,
                path,
                input.recordedAtMs,
                after,
              ),
            });
            break;
          }
          case "secret.file.delete": {
            const payload = input.payload;
            const versionId = requireVersionRow(txDb, workspaceId, payload.versionId);
            const path = normalizeSecretPath(payload.path);
            const metadata = normalizeMetadata(payload.metadata);
            insertMoment(txDb, {
              workspaceId,
              versionId,
              path,
              operation: "delete",
              metadata,
              after: null,
              recordedAtMs: input.recordedAtMs,
              updateTip: remoteShouldUpdateTip(
                txDb,
                workspaceId,
                versionId,
                path,
                input.recordedAtMs,
                null,
              ),
            });
            break;
          }
          case "secret.version.fork": {
            const payload = normalizeSecretForkPayload(input.payload);
            const fromVersionId = requireVersionRow(txDb, workspaceId, payload.fromVersionId);
            const toVersionId = requireVersionRow(txDb, workspaceId, payload.toVersionId);
            if (fromVersionId === toVersionId) {
              throw new SecretFileStoreError(
                "invalid-version",
                "Fork source and destination versions must differ.",
              );
            }
            // No-key-safe fork verification: the importer cannot decrypt
            // anything, but it CAN insist that every fork row is byte-equal to
            // its own sealed source tip at the same path for fromVersionId
            // (ciphertext hash + IV + auth tag + length), with no extra and no
            // missing rows. A poison fork that swaps rows between paths, drops
            // a path, or invents one is rejected before the destination wipe
            // below — and the whole apply runs inside one transaction, so a
            // later failure also rolls the wipe back. Honest residual: under
            // cross-origin clock skew a legitimate fork could disagree with
            // the importer's converged source tips and be rejected; that fails
            // the pull loudly (fail closed), never corrupts state.
            const sourceRows = txDb
              .prepare(
                `SELECT path, iv_base64, auth_tag_base64, ciphertext_base64, byte_length
                 FROM secret_files WHERE workspace_id = ? AND version_id = ?`,
              )
              .all(workspaceId, fromVersionId);
            const sourceByPath = new Map(
              sourceRows.map((row) => [stringValue(row.path), row]),
            );
            const forkRejected = (reason: string): SecretFileStoreError =>
              new SecretFileStoreError(
                "invalid-input",
                `Secret fork payload does not match the local sealed source state ` +
                  `for version ${fromVersionId}: ${reason}.`,
              );
            if (payload.rows.length !== sourceByPath.size) {
              throw forkRejected(
                `payload has ${payload.rows.length} rows, source has ${sourceByPath.size}`,
              );
            }
            const seenPaths = new Set<string>();
            for (const row of payload.rows) {
              if (seenPaths.has(row.path)) throw forkRejected(`duplicate path ${row.path}`);
              seenPaths.add(row.path);
              const source = sourceByPath.get(row.path);
              if (!source) throw forkRejected(`no source row for path ${row.path}`);
              const sourceCiphertext = Buffer.from(
                stringValue(source.ciphertext_base64),
                "base64",
              );
              if (
                source.iv_base64 !== row.ivBase64 ||
                source.auth_tag_base64 !== row.authTagBase64 ||
                sha256Bytes(sourceCiphertext) !== row.ciphertextSha256 ||
                numberValue(source.byte_length) !== row.byteLength
              ) {
                throw forkRejected(`sealed content mismatch at path ${row.path}`);
              }
            }
            txDb
              .prepare(
                "DELETE FROM secret_files WHERE workspace_id = ? AND version_id = ?",
              )
              .run(workspaceId, toVersionId);
            txDb
              .prepare(
                "DELETE FROM secret_fork_bases WHERE workspace_id = ? AND version_id = ?",
              )
              .run(workspaceId, toVersionId);
            for (const row of payload.rows) {
              const ciphertextBase64 = secretCiphertextBlobBySha(
                txDb,
                row.ciphertextSha256,
                row.byteLength,
              ).toString("base64");
              txDb
                .prepare(
                  `INSERT INTO secret_files (
                    workspace_id, version_id, path, iv_base64, auth_tag_base64,
                    ciphertext_base64, byte_length, updated_at_ms, latest_moment_id
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  workspaceId,
                  toVersionId,
                  row.path,
                  row.ivBase64,
                  row.authTagBase64,
                  ciphertextBase64,
                  row.byteLength,
                  row.updatedAtMs,
                  row.latestMomentId,
                );
              txDb
                .prepare(
                  `INSERT INTO secret_fork_bases (
                    workspace_id, version_id, path, iv_base64, auth_tag_base64,
                    ciphertext_base64, byte_length
                  ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  workspaceId,
                  toVersionId,
                  row.path,
                  row.ivBase64,
                  row.authTagBase64,
                  ciphertextBase64,
                  row.byteLength,
                );
            }
            break;
          }
          default:
            throw new SecretFileStoreError(
              "invalid-input",
              `Secret store cannot apply replication op ${input.opKind}.`,
            );
        }
        journalImportedReplicationOp(txDb, input);
        ackReplicationPeer(txDb, workspaceId, input.originId, input.originSeq);
        return appliedApplyResult();
      });
    },

    writeSecretFile(input) {
      return serialize(async (txDb) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const path = normalizeSecretPath(input.path);
        const text = normalizeSecretText(input.text);
        const metadata = normalizeMetadata(input.metadata);
        const versionId = requireVersionRow(txDb, workspaceId, input.versionId);
        // Only the FIRST secret capture may generate the per-workspace data
        // key; once protected rows exist, a missing key fails closed rather
        // than silently orphaning them under a fresh key.
        const key = await dataKey(!hasProtectedRows(txDb, workspaceId));
        const currentSealed = selectTip(txDb, workspaceId, versionId, path);
        if (currentSealed !== null) {
          const currentText = decryptTip(key, workspaceId, path, currentSealed);
          // Content equality is the no-op rule (same as the text store): one
          // moment per real change, idempotent reconciliation.
          if (currentText === text) return { changed: false };
        }
        const sealed = encryptSecretText(key, workspaceId, path, text);
        const moment = insertMoment(txDb, {
          workspaceId,
          versionId,
          path,
          operation: "write",
          metadata,
          after: sealed,
        });
        const ciphertextSha256 = persistSecretCiphertextBlob(txDb, sealed);
        journalLocalReplicationOp(txDb, {
          workspaceId,
          opKind: "secret.file.put",
          payload: {
            versionId,
            path,
            metadata,
            ivBase64: sealed.ivBase64,
            authTagBase64: sealed.authTagBase64,
            ciphertextSha256,
            byteLength: sealed.byteLength,
          },
          recordedAtMs: moment.recordedAtMs,
        });
        return { changed: true, moment };
      });
    },

    deleteSecretFile(input) {
      return serialize(async (txDb) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const path = normalizeSecretPath(input.path);
        const metadata = normalizeMetadata(input.metadata);
        const versionId = requireVersionRow(txDb, workspaceId, input.versionId);
        const currentSealed = selectTip(txDb, workspaceId, versionId, path);
        if (currentSealed === null) return { moment: null };
        const moment = insertMoment(txDb, {
          workspaceId,
          versionId,
          path,
          operation: "delete",
          metadata,
          after: null,
        });
        journalLocalReplicationOp(txDb, {
          workspaceId,
          opKind: "secret.file.delete",
          payload: { versionId, path, metadata },
          recordedAtMs: moment.recordedAtMs,
        });
        return { moment };
      });
    },

    listSecretFiles(input) {
      return afterWrites(async (txDb) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = requireVersionRow(txDb, workspaceId, input.versionId);
        return txDb
          .prepare(
            `SELECT workspace_id, version_id, path, byte_length, updated_at_ms, latest_moment_id
             FROM secret_files WHERE workspace_id = ? AND version_id = ?
             ORDER BY path`,
          )
          .all(workspaceId, versionId)
          .map(
            (row): SecretFileStat => ({
              workspaceId: stringValue(row.workspace_id),
              versionId: stringValue(row.version_id),
              path: stringValue(row.path),
              byteLength: numberValue(row.byte_length),
              updatedAtMs: numberValue(row.updated_at_ms),
              latestMomentId: stringValue(row.latest_moment_id),
            }),
          );
      });
    },

    listSecretMoments(input) {
      return afterWrites(async (txDb) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const rows = input.versionId
          ? txDb
              .prepare(
                `SELECT * FROM secret_moments
                 WHERE workspace_id = ? AND version_id = ?
                 ORDER BY moment_order DESC`,
              )
              .all(workspaceId, requireVersionRow(txDb, workspaceId, input.versionId))
          : txDb
              .prepare(
                "SELECT * FROM secret_moments WHERE workspace_id = ? ORDER BY moment_order DESC",
              )
              .all(workspaceId);
        return rows.map(momentFromRow);
      });
    },

    getSecretMoment(input) {
      return afterWrites(async (txDb) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        if (typeof input.momentId !== "string" || !input.momentId) {
          throw new SecretFileStoreError("invalid-input", "Moment id is required.");
        }
        const row = txDb
          .prepare(
            "SELECT * FROM secret_moments WHERE workspace_id = ? AND moment_id = ?",
          )
          .get(workspaceId, input.momentId);
        return row ? momentFromRow(row) : null;
      });
    },

    forkVersion(input) {
      return serialize(async (txDb) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const fromVersionId = requireVersionRow(txDb, workspaceId, input.fromVersionId);
        const toVersionId = requireVersionRow(txDb, workspaceId, input.toVersionId);
        if (fromVersionId === toVersionId) {
          throw new SecretFileStoreError(
            "invalid-version",
            "Fork source and destination versions must differ.",
          );
        }
        // The new version starts as an identical encrypted copy of the source
        // tips, and the SAME copy becomes its fork base (used by merges to
        // tell "changed in this version" from "gained later in the target").
        // Ciphertext copies verbatim: the AAD binds workspace+path, not
        // version, precisely so forks never need plaintext.
        txDb
          .prepare(
            "DELETE FROM secret_files WHERE workspace_id = ? AND version_id = ?",
          )
          .run(workspaceId, toVersionId);
        txDb
          .prepare(
            "DELETE FROM secret_fork_bases WHERE workspace_id = ? AND version_id = ?",
          )
          .run(workspaceId, toVersionId);
        txDb
          .prepare(
            `INSERT INTO secret_files (
              workspace_id, version_id, path, iv_base64, auth_tag_base64,
              ciphertext_base64, byte_length, updated_at_ms, latest_moment_id
            )
            SELECT workspace_id, ?, path, iv_base64, auth_tag_base64,
              ciphertext_base64, byte_length, updated_at_ms, latest_moment_id
            FROM secret_files WHERE workspace_id = ? AND version_id = ?`,
          )
          .run(toVersionId, workspaceId, fromVersionId);
        txDb
          .prepare(
            `INSERT INTO secret_fork_bases (
              workspace_id, version_id, path, iv_base64, auth_tag_base64,
              ciphertext_base64, byte_length
            )
            SELECT workspace_id, ?, path, iv_base64, auth_tag_base64,
              ciphertext_base64, byte_length
            FROM secret_files WHERE workspace_id = ? AND version_id = ?`,
          )
          .run(toVersionId, workspaceId, fromVersionId);
        const rows = txDb
          .prepare(
            `SELECT path, iv_base64, auth_tag_base64, ciphertext_base64, byte_length,
               updated_at_ms, latest_moment_id
             FROM secret_files
             WHERE workspace_id = ? AND version_id = ?
             ORDER BY path`,
          )
          .all(workspaceId, toVersionId)
          .map((row) => {
            const sealed = sealedFromRow(row);
            return {
              path: stringValue(row.path),
              ivBase64: sealed.ivBase64,
              authTagBase64: sealed.authTagBase64,
              ciphertextSha256: persistSecretCiphertextBlob(txDb, sealed),
              byteLength: sealed.byteLength,
              updatedAtMs: numberValue(row.updated_at_ms),
              latestMomentId: stringValue(row.latest_moment_id),
            };
          });
        if (rows.length === 0) {
          // Empty secret forks are a no-op for replicas; skip journaling to
          // avoid replication noise for versions without protected files.
          return;
        }
        journalLocalReplicationOp(txDb, {
          workspaceId,
          opKind: "secret.version.fork",
          payload: { toVersionId, fromVersionId, rows },
          recordedAtMs: nowMs(),
        });
      });
    },

    compareSecretFileVersions(input) {
      return afterWrites(async (txDb) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const targetVersionId = requireVersionRow(txDb, workspaceId, input.targetVersionId);
        const sourceVersionId = requireVersionRow(txDb, workspaceId, input.sourceVersionId);
        const paths = txDb
          .prepare(
            `SELECT DISTINCT path FROM secret_files
             WHERE workspace_id = ? AND version_id IN (?, ?)
             ORDER BY path`,
          )
          .all(workspaceId, targetVersionId, sourceVersionId)
          .map((row) => stringValue(row.path));
        const entries: SecretFileCompareEntry[] = [];
        let key: Buffer | null = null;
        for (const path of paths) {
          const target = selectTip(txDb, workspaceId, targetVersionId, path);
          const source = selectTip(txDb, workspaceId, sourceVersionId, path);
          if (target === null && source === null) continue;
          if (target === null) {
            entries.push({ path, status: "added" });
            continue;
          }
          if (source === null) {
            entries.push({ path, status: "deleted" });
            continue;
          }
          // Identical ciphertext (fork/apply copies verbatim) is identical
          // content without touching the key; different ciphertext still
          // needs an INTERNAL plaintext comparison because re-encryption of
          // the same content never reuses an IV.
          if (
            target.ciphertextBase64 === source.ciphertextBase64 &&
            target.ivBase64 === source.ivBase64 &&
            target.authTagBase64 === source.authTagBase64
          ) {
            continue;
          }
          key ??= await dataKey(false);
          const targetText = decryptTip(key, workspaceId, path, target);
          const sourceText = decryptTip(key, workspaceId, path, source);
          if (targetText !== sourceText) {
            entries.push({ path, status: "modified" });
          }
        }
        return entries;
      });
    },

    applySecretFileFromVersion(input) {
      return serialize(async (txDb) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const path = normalizeSecretPath(input.path);
        const metadata = normalizeMetadata(input.metadata);
        const targetVersionId = requireVersionRow(txDb, workspaceId, input.targetVersionId);
        const sourceVersionId = requireVersionRow(txDb, workspaceId, input.sourceVersionId);
        const source = selectTip(txDb, workspaceId, sourceVersionId, path);
        const target = selectTip(txDb, workspaceId, targetVersionId, path);
        const base = selectForkBase(txDb, workspaceId, sourceVersionId, path);
        // Neither side has the file: nothing to merge (and no key needed).
        if (source === null && target === null) return { changed: false };
        // Merging requires existing protected data, so the key must already
        // exist — never create one here.
        const key = await dataKey(false);
        const sourceText = decryptTip(key, workspaceId, path, source);
        const targetText = decryptTip(key, workspaceId, path, target);
        const baseText = decryptTip(key, workspaceId, path, base.sealed);
        // Already identical: nothing to merge.
        if (sourceText === targetText) return { changed: false };
        // Unchanged in the source since its fork: the difference belongs to
        // the target (for example Main gained a new .env after the fork) —
        // merging must NOT delete or overwrite it.
        if (sourceText === baseText) return { changed: false };
        // Whole-file incoming-wins (secrets never produce conflict records —
        // conflict records carry side texts, which protected contents must
        // never ride). The target's previous state stays one protected moment
        // back in its history, so nothing is lost.
        if (source !== null) {
          const moment = insertMoment(txDb, {
            workspaceId,
            versionId: targetVersionId,
            path,
            operation: "write",
            metadata,
            after: source,
          });
          journalSecretFileMoment(txDb, {
            workspaceId,
            versionId: targetVersionId,
            path,
            metadata,
            after: source,
            recordedAtMs: moment.recordedAtMs,
          });
          return { changed: true, moment };
        }
        const moment = insertMoment(txDb, {
          workspaceId,
          versionId: targetVersionId,
          path,
          operation: "delete",
          metadata,
          after: null,
        });
        journalSecretFileMoment(txDb, {
          workspaceId,
          versionId: targetVersionId,
          path,
          metadata,
          after: null,
          recordedAtMs: moment.recordedAtMs,
        });
        return { changed: true, moment };
      });
    },

    restoreSecretFileToBeforeMoment(input) {
      return serialize(async (txDb) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const metadata = normalizeMetadata(input.metadata);
        if (typeof input.momentId !== "string" || !input.momentId) {
          throw new SecretFileStoreError("invalid-input", "Moment id is required.");
        }
        const row = txDb
          .prepare(
            "SELECT * FROM secret_moments WHERE workspace_id = ? AND moment_id = ?",
          )
          .get(workspaceId, input.momentId);
        if (!row) {
          throw new SecretFileStoreError(
            "moment-not-found",
            "This protected history moment is no longer available.",
          );
        }
        const moment = momentFromRow(row);
        // The state BEFORE this moment = the after-state of the previous
        // moment for the same path in the same version (absent when this
        // moment created the file). Ciphertext copies forward verbatim; the
        // restore never produces plaintext.
        const previous = txDb
          .prepare(
            `SELECT * FROM secret_moments
             WHERE workspace_id = ? AND version_id = ? AND path = ? AND moment_order < ?
             ORDER BY moment_order DESC LIMIT 1`,
          )
          .get(workspaceId, moment.versionId, moment.path, moment.momentOrder);
        const targetSealed = previous ? sealedFromMomentRow(previous) : null;
        const currentSealed = selectTip(txDb, workspaceId, moment.versionId, moment.path);
        if (targetSealed === null) {
          if (currentSealed === null) {
            // Already absent: idempotent no-op (same rule as the text store).
            return {
              restored: "deleted" as const,
              restoredMomentId: moment.id,
              path: moment.path,
            };
          }
          const recorded = insertMoment(txDb, {
            workspaceId,
            versionId: moment.versionId,
            path: moment.path,
            operation: "delete",
            metadata,
            after: null,
          });
          journalSecretFileMoment(txDb, {
            workspaceId,
            versionId: moment.versionId,
            path: moment.path,
            metadata,
            after: null,
            recordedAtMs: recorded.recordedAtMs,
          });
          return {
            restored: "deleted" as const,
            restoredMomentId: recorded.id,
            path: moment.path,
          };
        }
        if (
          currentSealed !== null &&
          currentSealed.ciphertextBase64 === targetSealed.ciphertextBase64 &&
          currentSealed.ivBase64 === targetSealed.ivBase64 &&
          currentSealed.authTagBase64 === targetSealed.authTagBase64
        ) {
          // Already in the pre-moment state: idempotent no-op.
          return {
            restored: "text" as const,
            restoredMomentId: moment.id,
            path: moment.path,
          };
        }
        const recorded = insertMoment(txDb, {
          workspaceId,
          versionId: moment.versionId,
          path: moment.path,
          operation: "write",
          metadata,
          after: targetSealed,
        });
        journalSecretFileMoment(txDb, {
          workspaceId,
          versionId: moment.versionId,
          path: moment.path,
          metadata,
          after: targetSealed,
          recordedAtMs: recorded.recordedAtMs,
        });
        return {
          restored: "text" as const,
          restoredMomentId: recorded.id,
          path: moment.path,
        };
      });
    },

    // THE single authorized plaintext accessor. Callers are dohc's own disk
    // materialization flows only (version switch/merge/restore); every other
    // surface of this store is metadata-only by type.
    materializeSecretFile(input) {
      return afterWrites(async (txDb) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const path = normalizeSecretPath(input.path);
        const versionId = requireVersionRow(txDb, workspaceId, input.versionId);
        const sealed = selectTip(txDb, workspaceId, versionId, path);
        if (sealed === null) return { present: false } as SecretFileMaterialization;
        const key = await dataKey(false);
        return {
          present: true,
          text: decryptSecretText(key, workspaceId, path, sealed),
        };
      });
    },

    // Releases the SQLite handle (and its WAL locks) after in-flight writes
    // drain. The store stays usable: a later call lazily reopens.
    async close() {
      await writeChain;
      if (dbHandle) {
        try {
          dbHandle.close();
        } catch {}
        dbHandle = null;
      }
    },
  };
}
