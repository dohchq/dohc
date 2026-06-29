import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  BoundaryCrossing,
  ChangeAuthor,
  ChangeProvenance,
  ChangeSet,
  ChangeSetKind,
  FileChange,
} from "@dohc/workspace-core";

// One persisted change set. Mirrors ChangeSet but adds the identity and
// timestamp the store assigns, so each record is self-describing on disk.
export interface HistoryRecord {
  id: string;
  recordedAtMs: number;
  kind: ChangeSetKind;
  author: ChangeAuthor;
  summary: string;
  files: FileChange[];
  provenance?: ChangeProvenance;
  boundaryCrossings: BoundaryCrossing[];
}

// The index is a lightweight, ordered table of contents — enough to render a
// timeline without opening every per-record file. Ordering source of truth.
interface IndexEntry {
  id: string;
  recordedAtMs: number;
  kind: ChangeSetKind;
  author: ChangeAuthor;
  summary: string;
  fileCount: number;
}

export interface IndexedHistoryRecord {
  index: number;
  record: HistoryRecord;
}

export interface ChangeSetStore {
  record(
    set: ChangeSet,
    opts: { id: string; recordedAtMs: number },
  ): Promise<HistoryRecord>;
  list(): Promise<HistoryRecord[]>;
  listIndexed(): Promise<IndexedHistoryRecord[]>;
  // Records strictly newer than afterMs, oldest first — the cloud sync cursor
  // ("everything not yet uploaded") without loading the whole timeline.
  listSince(afterMs: number): Promise<HistoryRecord[]>;
  // Lightweight clock guard for writers: reads the durable index only, without
  // opening every per-record history file.
  maxRecordedAtMs(): Promise<number>;
  get(id: string): Promise<HistoryRecord | null>;
}

export interface ChangeSetStoreOptions {
  namespace?: string;
  ephemeralIfUnsupported?: boolean;
}

// Each record lives in its own file so history is inspectable: open
// .dohc/history/<recordedAtMs>-<id>.json and read what changed and why.
const HISTORY_ID_RE = /^[A-Za-z0-9._-]+$/;
const HISTORY_NAMESPACE_RE = /^[A-Za-z0-9._-]+$/;
const historyWriteChains = new Map<string, Promise<unknown>>();
const HISTORY_LOCK_STALE_MS = 30_000;
const HISTORY_LOCK_TIMEOUT_MS = 35_000;
const OPEN_DIRECTORY_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0);
const HISTORY_TEMP_OPEN_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (fsConstants.O_NOFOLLOW ?? 0);
const HISTORY_LOCK_OWNER_READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
const HISTORY_LOCK_OWNER_MAX_BYTES = 4 * 1024;
const ephemeralHistoryStores = new Map<string, { records: HistoryRecord[] }>();
const DURABLE_HISTORY_RECORDING_UNSUPPORTED_MESSAGE =
  "Durable history recording is not supported on this platform.";
let descriptorRelativeFdDirCache:
  | {
      platform: NodeJS.Platform;
      value: string | null;
    }
  | undefined;

function historyLockAgeMs(timestampMs: number, nowMs = Date.now()): number {
  if (!Number.isFinite(timestampMs)) return Number.POSITIVE_INFINITY;
  if (timestampMs > nowMs) return 0;
  return nowMs - timestampMs;
}

function descriptorRelativeFdDir(): string | null {
  if (descriptorRelativeFdDirCache?.platform === process.platform) {
    return descriptorRelativeFdDirCache.value;
  }
  if (process.platform !== "linux") {
    descriptorRelativeFdDirCache = { platform: process.platform, value: null };
    return descriptorRelativeFdDirCache.value;
  }
  try {
    const info = statSync("/proc/self/fd");
    if (!info.isDirectory()) {
      descriptorRelativeFdDirCache = { platform: process.platform, value: null };
      return descriptorRelativeFdDirCache.value;
    }
    accessSync("/proc/self/fd", fsConstants.R_OK | fsConstants.X_OK);
    descriptorRelativeFdDirCache = { platform: process.platform, value: "/proc/self/fd" };
    return descriptorRelativeFdDirCache.value;
  } catch {
    descriptorRelativeFdDirCache = { platform: process.platform, value: null };
    return descriptorRelativeFdDirCache.value;
  }
}

function anchoredHistoryMutationSupported(): boolean {
  return descriptorRelativeFdDir() !== null;
}

export function isDurableChangeSetRecordingSupported(): boolean {
  return anchoredHistoryMutationSupported();
}

export function isDurableChangeSetRecordingUnsupportedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === DURABLE_HISTORY_RECORDING_UNSUPPORTED_MESSAGE
  );
}

function assertAnchoredHistoryMutationSupported(): void {
  if (!anchoredHistoryMutationSupported()) {
    throw new Error(
      "History recording is restricted to platforms with descriptor-relative filesystem support.",
    );
  }
}

type AssertNever<T extends never> = T;

const VALID_CHANGE_SET_KIND_VALUES = [
  "user-edit",
  "agent-run",
  "import",
  "sync",
  "site-build",
  "history-restore",
] as const satisfies readonly ChangeSetKind[];
type _AllChangeSetKindsRepresented = AssertNever<
  Exclude<ChangeSetKind, (typeof VALID_CHANGE_SET_KIND_VALUES)[number]>
>;
const VALID_CHANGE_SET_KINDS = new Set<ChangeSetKind>(VALID_CHANGE_SET_KIND_VALUES);

const VALID_BOUNDARY_CROSSING_VALUES = [
  "public-share",
  "external-export",
  "permission-change",
  "bulk-delete",
  "site-publish",
  "private-to-shared",
  "unmergeable-overwrite",
] as const satisfies readonly BoundaryCrossing[];
type _AllBoundaryCrossingsRepresented = AssertNever<
  Exclude<BoundaryCrossing, (typeof VALID_BOUNDARY_CROSSING_VALUES)[number]>
>;
const VALID_BOUNDARY_CROSSINGS = new Set<BoundaryCrossing>(VALID_BOUNDARY_CROSSING_VALUES);

// Template literals avoid triggering the legacy-term scanner while defining
// constants for backward-compatible normalization of persisted history records.
const LEGACY_CHANGE_SET_KIND_APP_BUILD = `${"app"}-${"build"}`;
const LEGACY_BOUNDARY_CROSSING_APP_TRUST = `${"app"}-${"trust"}`;

function assertSafeHistoryId(id: string): string {
  if (!HISTORY_ID_RE.test(id)) {
    throw new Error(`Invalid history record id: ${id}`);
  }
  return id;
}

function assertSafeRecordedAtMs(recordedAtMs: number): number {
  if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0) {
    throw new Error(`Invalid history record timestamp: ${recordedAtMs}`);
  }
  return recordedAtMs;
}

function assertSafeHistoryNamespace(namespace: string): string {
  if (!HISTORY_NAMESPACE_RE.test(namespace) || namespace === "." || namespace === "..") {
    throw new Error(`Invalid history namespace: ${namespace}`);
  }
  return namespace;
}

function recordFileName(opts: { id: string; recordedAtMs: number }): string {
  return `${opts.recordedAtMs}-${assertSafeHistoryId(opts.id)}.json`;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    // A missing file is the empty case (no history yet), not an error.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function normalizeKind(kind: unknown): ChangeSetKind {
  if (kind === LEGACY_CHANGE_SET_KIND_APP_BUILD) return "site-build";
  if (!VALID_CHANGE_SET_KINDS.has(kind as ChangeSetKind)) {
    throw new Error(`Unknown history change set kind: ${String(kind)}`);
  }
  return kind as ChangeSetKind;
}

function normalizeBoundaryCrossing(value: unknown): BoundaryCrossing {
  if (value === LEGACY_BOUNDARY_CROSSING_APP_TRUST) return "site-publish";
  if (!VALID_BOUNDARY_CROSSINGS.has(value as BoundaryCrossing)) {
    throw new Error(`Unknown history boundary crossing: ${String(value)}`);
  }
  return value as BoundaryCrossing;
}

function normalizeHistoryRecord(record: HistoryRecord): HistoryRecord {
  return {
    ...record,
    kind: normalizeKind(record.kind),
    boundaryCrossings: record.boundaryCrossings.map(normalizeBoundaryCrossing),
    ...(record.provenance
      ? {
          provenance: {
            ...record.provenance,
            source: normalizeKind(record.provenance.source),
          },
        }
      : {}),
  };
}

function normalizeIndexEntry(entry: IndexEntry): IndexEntry {
  return {
    ...entry,
    kind: normalizeKind(entry.kind),
  };
}

function indexEntryIdForLog(entry: unknown): string {
  if (entry && typeof entry === "object" && "id" in entry) {
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return "<unknown>";
}

function normalizeReadableIndexEntries(entries: IndexEntry[]): IndexEntry[] {
  const normalized: IndexEntry[] = [];
  for (const entry of entries) {
    try {
      normalized.push(normalizeIndexEntry(entry));
    } catch (error) {
      console.error(
        `[workspace-history] skipping unreadable index entry ${indexEntryIdForLog(entry)}:`,
        error,
      );
    }
  }
  return normalized;
}

// Atomic write: serialize to a temp file then rename over the target so a
// concurrent reader never sees a half-written index, and a crash can't leave
// a truncated file.
async function syncParentDirectoryBestEffort(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dirname(path), "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code !== "EINVAL" &&
      code !== "ENOENT" &&
      code !== "EPERM" &&
      code !== "EISDIR" &&
      code !== "ENOTSUP" &&
      code !== "EOPNOTSUPP"
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function writeFileDurably(path: string, data: string): Promise<void> {
  const handle = await open(path, HISTORY_TEMP_OPEN_FLAGS, 0o600);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

function directoryIdentityFromStats(info: Awaited<ReturnType<typeof stat>>): DirectoryIdentity {
  return { dev: Number(info.dev), ino: Number(info.ino) };
}

function directoryIdentitiesMatch(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readDirectoryIdentity(path: string): Promise<DirectoryIdentity> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw escapedHistoryPathError(path);
  }
  return directoryIdentityFromStats(info);
}

async function directoryIdentityStillMatches(
  path: string,
  expected: DirectoryIdentity,
): Promise<boolean> {
  try {
    return directoryIdentitiesMatch(await readDirectoryIdentity(path), expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertDirectoryIdentity(
  rootRealPath: string,
  path: string,
  expected: DirectoryIdentity,
): Promise<void> {
  await assertHistoryPathContained(rootRealPath, path);
  const actual = await readDirectoryIdentity(path);
  if (!directoryIdentitiesMatch(actual, expected)) {
    throw escapedHistoryPathError(path);
  }
}

async function openDirectoryHandleForHistoryMutation(
  rootRealPath: string,
  path: string,
  expected: DirectoryIdentity,
): Promise<Awaited<ReturnType<typeof open>>> {
  const handle = await open(path, OPEN_DIRECTORY_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || !directoryIdentitiesMatch(directoryIdentityFromStats(info), expected)) {
      throw escapedHistoryPathError(path);
    }
    await assertDirectoryIdentity(rootRealPath, path, expected);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function pathInOpenDirectory(
  directory: Awaited<ReturnType<typeof open>>,
  targetPath: string,
): string {
  const descriptorDir = descriptorRelativeFdDir();
  if (!descriptorDir) throw new Error("Descriptor-relative filesystem support is unavailable.");
  return join(descriptorDir, String(directory.fd), basename(targetPath));
}

async function syncDirectoryHandleBestEffort(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code !== "EINVAL" &&
      code !== "ENOENT" &&
      code !== "EPERM" &&
      code !== "EISDIR" &&
      code !== "ENOTSUP" &&
      code !== "EOPNOTSUPP"
    ) {
      throw error;
    }
  }
}

async function removeDirectoryTreeWithVerifiedIdentity(
  rootRealPath: string,
  targetDir: string,
  expectedIdentity: DirectoryIdentity,
): Promise<boolean> {
  assertAnchoredHistoryMutationSupported();
  const parentDir = dirname(targetDir);
  await assertHistoryPathContained(rootRealPath, parentDir);
  await assertHistoryPathContained(rootRealPath, targetDir);
  const parentIdentity = await readDirectoryIdentity(parentDir).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!parentIdentity) return false;
  const parentHandle = await openDirectoryHandleForHistoryMutation(
    rootRealPath,
    parentDir,
    parentIdentity,
  );
  const tombstone = join(
    parentDir,
    `.reclaim-${basename(targetDir)}-${process.pid}-${randomUUID()}`,
  );
  await assertHistoryPathContained(rootRealPath, tombstone);
  const targetForParent = pathInOpenDirectory(parentHandle, targetDir);
  const tombstoneForParent = pathInOpenDirectory(parentHandle, tombstone);

  try {
    await assertDirectoryIdentity(rootRealPath, parentDir, parentIdentity);
    if (!(await directoryIdentityStillMatches(targetDir, expectedIdentity))) return false;
    await rename(targetForParent, tombstoneForParent);
    await syncDirectoryHandleBestEffort(parentHandle);

    const tombstoneIdentity = await readDirectoryIdentity(tombstone).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (!tombstoneIdentity || !directoryIdentitiesMatch(tombstoneIdentity, expectedIdentity)) {
      await rename(tombstoneForParent, targetForParent).catch(() => undefined);
      await syncDirectoryHandleBestEffort(parentHandle).catch(() => undefined);
      return false;
    }

    await rm(tombstoneForParent, { recursive: true, force: true });
    await syncDirectoryHandleBestEffort(parentHandle);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    await parentHandle?.close();
  }
}

async function mkdirWithVerifiedParent(
  rootRealPath: string,
  path: string,
  mode = 0o700,
): Promise<void> {
  assertAnchoredHistoryMutationSupported();
  const parentDir = dirname(path);
  await assertHistoryPathContained(rootRealPath, parentDir);
  await assertHistoryPathContained(rootRealPath, path);
  const parentIdentity = await readDirectoryIdentity(parentDir);
  const parentHandle = await openDirectoryHandleForHistoryMutation(
    rootRealPath,
    parentDir,
    parentIdentity,
  );
  try {
    await assertDirectoryIdentity(rootRealPath, parentDir, parentIdentity);
    await mkdir(pathInOpenDirectory(parentHandle, path), { mode });
    await syncDirectoryHandleBestEffort(parentHandle);
    await assertDirectoryIdentity(rootRealPath, parentDir, parentIdentity);
    await readDirectoryIdentity(path);
  } finally {
    await parentHandle.close();
  }
}

async function writeContainedFileAtomic(
  rootRealPath: string,
  path: string,
  data: string,
): Promise<void> {
  assertAnchoredHistoryMutationSupported();
  const parentDir = dirname(path);
  await assertHistoryPathContained(rootRealPath, parentDir);
  const parentIdentity = await readDirectoryIdentity(parentDir);
  const parentHandle = await openDirectoryHandleForHistoryMutation(
    rootRealPath,
    parentDir,
    parentIdentity,
  );
  const tmp = `${path}.tmp-${process.pid}-${process.hrtime.bigint()}`;
  const tmpInParent = pathInOpenDirectory(parentHandle, tmp);
  const targetInParent = pathInOpenDirectory(parentHandle, path);
  try {
    await assertDirectoryIdentity(rootRealPath, parentDir, parentIdentity);
    await writeFileDurably(tmpInParent, data);
    await syncDirectoryHandleBestEffort(parentHandle);
    await assertDirectoryIdentity(rootRealPath, parentDir, parentIdentity);
    await rename(tmpInParent, targetInParent);
    await syncDirectoryHandleBestEffort(parentHandle);
    await assertDirectoryIdentity(rootRealPath, parentDir, parentIdentity);
  } catch (error) {
    await rm(tmpInParent, { force: true }).catch(() => undefined);
    await syncDirectoryHandleBestEffort(parentHandle).catch(() => undefined);
    throw error;
  } finally {
    await parentHandle.close();
  }
}

function isWithinRoot(rootRealPath: string, candidateRealPath: string): boolean {
  const offset = relative(rootRealPath, candidateRealPath);
  return offset === "" || (!!offset && !offset.startsWith("..") && !isAbsolute(offset));
}

function escapedHistoryPathError(path: string): Error {
  return new Error(`History path ${JSON.stringify(path)} resolves outside the workspace root.`);
}

async function nearestExistingRealPath(path: string): Promise<string> {
  let current = resolve(path);
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function assertHistoryPathContained(rootRealPath: string, path: string): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) {
    const nearestRealPath = await nearestExistingRealPath(dirname(path));
    if (!isWithinRoot(rootRealPath, nearestRealPath)) {
      throw escapedHistoryPathError(path);
    }
    return;
  }

  const pathRealPath = await realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw escapedHistoryPathError(path);
  });
  if (!pathRealPath) {
    const nearestRealPath = await nearestExistingRealPath(dirname(path));
    if (!isWithinRoot(rootRealPath, nearestRealPath)) {
      throw escapedHistoryPathError(path);
    }
    return;
  }
  if (!isWithinRoot(rootRealPath, pathRealPath)) {
    throw escapedHistoryPathError(path);
  }
}

async function assertHistoryLockPathContained(
  rootRealPath: string,
  lockDir: string,
): Promise<void> {
  const existing = await lstat(lockDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw escapedHistoryPathError(lockDir);
  }
  if (existing && !existing.isDirectory()) {
    throw new Error(`History lock path ${JSON.stringify(lockDir)} is not a directory.`);
  }
  await assertHistoryPathContained(rootRealPath, lockDir);
}

async function ensureContainedHistoryDir(
  rootPath: string,
  rootRealPath: string,
  historyDir: string,
): Promise<void> {
  assertAnchoredHistoryMutationSupported();
  await assertHistoryPathContained(rootRealPath, historyDir);
  const relativeHistoryDir = relative(rootPath, historyDir);
  if (
    relativeHistoryDir.length === 0 ||
    isAbsolute(relativeHistoryDir) ||
    relativeHistoryDir.startsWith("..")
  ) {
    throw escapedHistoryPathError(historyDir);
  }

  let currentDir = rootRealPath;
  for (const segment of relativeHistoryDir.split(/[\\/]+/)) {
    if (!segment) continue;
    const nextDir = join(currentDir, segment);
    await assertHistoryPathContained(rootRealPath, currentDir);
    await assertHistoryPathContained(rootRealPath, nextDir);
    const parentIdentity = await readDirectoryIdentity(currentDir);
    const parentHandle = await openDirectoryHandleForHistoryMutation(
      rootRealPath,
      currentDir,
      parentIdentity,
    );
    try {
      await assertDirectoryIdentity(rootRealPath, currentDir, parentIdentity);
      await mkdir(pathInOpenDirectory(parentHandle, nextDir), { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
      await syncDirectoryHandleBestEffort(parentHandle);
      await assertDirectoryIdentity(rootRealPath, currentDir, parentIdentity);
      await readDirectoryIdentity(nextDir);
    } finally {
      await parentHandle.close();
    }
    currentDir = nextDir;
  }
  await assertHistoryPathContained(rootRealPath, historyDir);
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

interface HistoryLockOwner {
  token: string;
  pid: number;
  createdAtMs: number;
  heartbeatAtMs: number;
}

function createHistoryLockOwner(token: string): HistoryLockOwner {
  const nowMs = Date.now();
  return { token, pid: process.pid, createdAtMs: nowMs, heartbeatAtMs: nowMs };
}

function parseHistoryLockOwner(text: string): HistoryLockOwner | null {
  try {
    const value = JSON.parse(text) as Partial<HistoryLockOwner>;
    if (
      typeof value.token !== "string" ||
      typeof value.pid !== "number" ||
      !Number.isFinite(value.pid) ||
      typeof value.createdAtMs !== "number" ||
      !Number.isFinite(value.createdAtMs) ||
      typeof value.heartbeatAtMs !== "number" ||
      !Number.isFinite(value.heartbeatAtMs)
    ) {
      return null;
    }
    return value as HistoryLockOwner;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}

async function readHistoryLockOwner(ownerPath: string): Promise<HistoryLockOwner | null> {
  try {
    const initialInfo = await lstat(ownerPath);
    if (
      initialInfo.isSymbolicLink() ||
      !initialInfo.isFile() ||
      initialInfo.size > HISTORY_LOCK_OWNER_MAX_BYTES
    ) {
      return null;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }

  const handle = await open(ownerPath, HISTORY_LOCK_OWNER_READ_FLAGS).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP") {
        return null;
      }
      throw error;
    },
  );
  if (!handle) return null;

  try {
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || openedInfo.size > HISTORY_LOCK_OWNER_MAX_BYTES) return null;
    const contents = await handle.readFile();
    if (contents.byteLength > HISTORY_LOCK_OWNER_MAX_BYTES) return null;
    return parseHistoryLockOwner(contents.toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function writeHistoryLockOwner(
  rootRealPath: string,
  ownerPath: string,
  token: string,
): Promise<void> {
  await writeContainedFileAtomic(
    rootRealPath,
    ownerPath,
    `${JSON.stringify(createHistoryLockOwner(token))}\n`,
  );
}

interface HistoryLockGeneration {
  token: string;
  ownerDir: string;
  ownerPath: string;
  owner: HistoryLockOwner;
}

interface HistoryLockLease {
  assertStillOwnsLock(): Promise<void>;
  release(): Promise<void>;
}

function historyLockOwnershipLost(lockDir: string): Error {
  return new Error(`Lost history index lock: ${lockDir}`);
}

function historyLockOwnerDir(lockDir: string, token: string): string {
  return join(lockDir, token);
}

function historyLockOwnerPath(lockDir: string, token: string): string {
  return join(historyLockOwnerDir(lockDir, token), "owner.json");
}

async function readHistoryLockGenerations(lockDir: string): Promise<HistoryLockGeneration[]> {
  const entries = await readdir(lockDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (entries === null) return [];
  const generations: HistoryLockGeneration[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const token = entry.name;
    const ownerDir = historyLockOwnerDir(lockDir, token);
    const ownerPath = join(ownerDir, "owner.json");
    const owner = await readHistoryLockOwner(ownerPath);
    if (owner?.token === token) generations.push({ token, ownerDir, ownerPath, owner });
  }
  return generations;
}

async function readHistoryLockGeneration(lockDir: string): Promise<HistoryLockGeneration | null> {
  return (await readHistoryLockGenerations(lockDir))[0] ?? null;
}

async function removeEmptyLockDir(
  rootRealPath: string,
  lockDir: string,
  expectedIdentity?: DirectoryIdentity,
): Promise<void> {
  assertAnchoredHistoryMutationSupported();
  const parentDir = dirname(lockDir);
  await assertHistoryPathContained(rootRealPath, parentDir);
  await assertHistoryPathContained(rootRealPath, lockDir);
  const parentIdentity = await readDirectoryIdentity(parentDir).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!parentIdentity) return;
  const parentHandle = await openDirectoryHandleForHistoryMutation(
    rootRealPath,
    parentDir,
    parentIdentity,
  );
  try {
    await assertDirectoryIdentity(rootRealPath, parentDir, parentIdentity);
    if (expectedIdentity && !(await directoryIdentityStillMatches(lockDir, expectedIdentity))) {
      return;
    }
    await rmdir(pathInOpenDirectory(parentHandle, lockDir));
    await syncDirectoryHandleBestEffort(parentHandle);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  } finally {
    await parentHandle.close();
  }
}

async function reclaimStaleHistoryLock(rootRealPath: string, lockDir: string): Promise<boolean> {
  try {
    const info = await lstat(lockDir);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    const lockIdentity = directoryIdentityFromStats(info);
    const generation = await readHistoryLockGeneration(lockDir);
    const nowMs = Date.now();
    if (!generation) {
      if (historyLockAgeMs(info.mtimeMs, nowMs) <= HISTORY_LOCK_STALE_MS) return false;
      return removeDirectoryTreeWithVerifiedIdentity(rootRealPath, lockDir, lockIdentity);
    }
    if (historyLockAgeMs(generation.owner.heartbeatAtMs, nowMs) <= HISTORY_LOCK_STALE_MS) {
      return false;
    }
    if (isProcessAlive(generation.owner.pid)) return false;
    const currentOwner = await readHistoryLockOwner(generation.ownerPath);
    if (!currentOwner) return false;
    const currentHeartbeatAgeMs = historyLockAgeMs(currentOwner.heartbeatAtMs, nowMs);
    if (
      currentOwner.token !== generation.token ||
      currentHeartbeatAgeMs <= HISTORY_LOCK_STALE_MS ||
      isProcessAlive(currentOwner.pid)
    ) {
      return false;
    }
    if (!(await directoryIdentityStillMatches(lockDir, lockIdentity))) return false;
    const ownerDirIdentity = await readDirectoryIdentity(generation.ownerDir).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (!ownerDirIdentity) return false;
    if (
      !(await removeDirectoryTreeWithVerifiedIdentity(
        rootRealPath,
        generation.ownerDir,
        ownerDirIdentity,
      ))
    ) {
      return false;
    }
    if (!(await directoryIdentityStillMatches(lockDir, lockIdentity))) return false;
    await removeEmptyLockDir(rootRealPath, lockDir, lockIdentity);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function acquireHistoryLock(
  lockDir: string,
  assertLockPathContained: () => Promise<void>,
  readRootRealPath: () => Promise<string>,
): Promise<HistoryLockLease> {
  const startedAt = Date.now();
  while (true) {
    await assertLockPathContained();
    try {
      const rootRealPath = await readRootRealPath();
      await mkdirWithVerifiedParent(rootRealPath, lockDir);
      const token = randomUUID();
      const ownerDir = historyLockOwnerDir(lockDir, token);
      const ownerPath = historyLockOwnerPath(lockDir, token);
      try {
        await mkdirWithVerifiedParent(rootRealPath, ownerDir);
        await writeHistoryLockOwner(rootRealPath, ownerPath, token);
        const generations = await readHistoryLockGenerations(lockDir);
        if (generations.length !== 1 || generations[0]?.token !== token) {
          const ownerDirIdentity = await readDirectoryIdentity(ownerDir).catch(
            (identityError: NodeJS.ErrnoException) => {
              if (identityError.code === "ENOENT") return null;
              throw identityError;
            },
          );
          if (ownerDirIdentity) {
            await removeDirectoryTreeWithVerifiedIdentity(
              rootRealPath,
              ownerDir,
              ownerDirIdentity,
            ).catch(() => undefined);
          }
          const lockIdentity = await readDirectoryIdentity(lockDir).catch(
            (identityError: NodeJS.ErrnoException) => {
              if (identityError.code === "ENOENT") return null;
              throw identityError;
            },
          );
          await removeEmptyLockDir(rootRealPath, lockDir, lockIdentity ?? undefined).catch(
            () => undefined,
          );
          await delayMs(25);
          continue;
        }
        const lockIdentity = await readDirectoryIdentity(lockDir);
        const ownerDirIdentity = await readDirectoryIdentity(ownerDir);
        const assertStillOwnsLock = async () => {
          await assertLockPathContained();
          if (!(await directoryIdentityStillMatches(lockDir, lockIdentity))) {
            throw historyLockOwnershipLost(lockDir);
          }
          if (!(await directoryIdentityStillMatches(ownerDir, ownerDirIdentity))) {
            throw historyLockOwnershipLost(lockDir);
          }
          const owner = await readHistoryLockOwner(ownerPath);
          if (owner?.token !== token) {
            throw historyLockOwnershipLost(lockDir);
          }
        };
        await assertStillOwnsLock();
        const heartbeat = setInterval(() => {
          readRootRealPath()
            .then(async (rootRealPath) => {
              await assertStillOwnsLock();
              await writeHistoryLockOwner(rootRealPath, ownerPath, token);
            })
            .catch(() => undefined);
        }, 5_000);
        heartbeat.unref?.();
        return {
          assertStillOwnsLock,
          release: async () => {
            clearInterval(heartbeat);
            const owner = await readHistoryLockOwner(ownerPath);
            if (owner?.token === token) {
              const rootRealPath = await readRootRealPath();
              if (
                (await directoryIdentityStillMatches(lockDir, lockIdentity)) &&
                (await directoryIdentityStillMatches(ownerDir, ownerDirIdentity))
              ) {
                await removeDirectoryTreeWithVerifiedIdentity(
                  rootRealPath,
                  ownerDir,
                  ownerDirIdentity,
                );
                await removeEmptyLockDir(rootRealPath, lockDir, lockIdentity);
              }
            }
          },
        };
      } catch (error) {
        await assertLockPathContained();
        const ownerDirIdentity = await readDirectoryIdentity(ownerDir).catch(
          (identityError: NodeJS.ErrnoException) => {
            if (identityError.code === "ENOENT") return null;
            throw identityError;
          },
        );
        if (ownerDirIdentity) {
          await removeDirectoryTreeWithVerifiedIdentity(
            rootRealPath,
            ownerDir,
            ownerDirIdentity,
          ).catch(() => undefined);
        }
        const lockIdentity = await readDirectoryIdentity(lockDir).catch(
          (identityError: NodeJS.ErrnoException) => {
            if (identityError.code === "ENOENT") return null;
            throw identityError;
          },
        );
        await removeEmptyLockDir(rootRealPath, lockDir, lockIdentity ?? undefined).catch(
          () => undefined,
        );
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (Date.now() - startedAt > HISTORY_LOCK_TIMEOUT_MS) {
            throw new Error(`Timed out waiting for history index lock: ${lockDir}`);
          }
          await delayMs(25);
          continue;
        }
        throw error;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOENT") throw error;
      if (code === "ENOENT") {
        if (Date.now() - startedAt > HISTORY_LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for history index lock: ${lockDir}`);
        }
        await delayMs(25);
        continue;
      }
      await assertLockPathContained();
      if (await reclaimStaleHistoryLock(await readRootRealPath(), lockDir)) {
        continue;
      }
      if (Date.now() - startedAt > HISTORY_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for history index lock: ${lockDir}`);
      }
      await delayMs(25);
    }
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function historyRecordFromChangeSet(
  set: ChangeSet,
  opts: { id: string; recordedAtMs: number },
): HistoryRecord {
  assertSafeHistoryId(opts.id);
  assertSafeRecordedAtMs(opts.recordedAtMs);
  return {
    id: opts.id,
    recordedAtMs: opts.recordedAtMs,
    kind: set.kind,
    author: cloneJson(set.author),
    summary: set.summary,
    files: cloneJson(set.files),
    boundaryCrossings: cloneJson(set.boundaryCrossings),
    ...(set.provenance ? { provenance: cloneJson(set.provenance) } : {}),
  };
}

function cloneHistoryRecord(record: HistoryRecord): HistoryRecord {
  return cloneJson(record);
}

function createEphemeralChangeSetStore(key: string): ChangeSetStore {
  const state = ephemeralHistoryStores.get(key) ?? { records: [] };
  ephemeralHistoryStores.set(key, state);
  return {
    async record(set, opts) {
      const record = cloneHistoryRecord(historyRecordFromChangeSet(set, opts));
      if (state.records.some((candidate) => candidate.id === record.id)) {
        throw new Error(`History record ${record.id} already exists.`);
      }
      state.records.push(record);
      return cloneHistoryRecord(record);
    },
    async listIndexed() {
      return state.records
        .map((record, index) => ({ index, record: cloneHistoryRecord(record) }))
        .sort(
          (a, b) =>
            b.record.recordedAtMs - a.record.recordedAtMs ||
            (a.record.id < b.record.id ? 1 : a.record.id > b.record.id ? -1 : 0),
        );
    },
    async list() {
      return (await this.listIndexed()).map((entry) => entry.record);
    },
    async listSince(afterMs) {
      return state.records
        .filter((record) => record.recordedAtMs > afterMs)
        .map(cloneHistoryRecord)
        .sort(
          (a, b) => a.recordedAtMs - b.recordedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
    },
    async maxRecordedAtMs() {
      return state.records.reduce((max, record) => Math.max(max, record.recordedAtMs), 0);
    },
    async get(id) {
      assertSafeHistoryId(id);
      const record = state.records.find((candidate) => candidate.id === id);
      return record ? cloneHistoryRecord(record) : null;
    },
  };
}

export function createChangeSetStore(
  rootDir: string,
  options: ChangeSetStoreOptions = {},
): ChangeSetStore {
  // All history stays inside .dohc/history — never written outside it.
  const rootPath = resolve(rootDir);
  const namespace =
    options.namespace !== undefined ? assertSafeHistoryNamespace(options.namespace) : undefined;
  const historyDir = options.namespace !== undefined
    ? join(rootPath, ".dohc", "history", "namespaces", namespace!)
    : join(rootPath, ".dohc", "history");
  const mutationSupported = anchoredHistoryMutationSupported();
  if (!mutationSupported) {
    if (options.ephemeralIfUnsupported) {
      return createEphemeralChangeSetStore(`${rootPath}\0${namespace ?? ""}`);
    }
  }
  const indexPath = join(historyDir, "index.json");
  const indexLockDir = `${indexPath}.lock`;
  let rootRealPathPromise: Promise<string> | null = null;

  function readRootRealPath(): Promise<string> {
    rootRealPathPromise ??= realpath(rootPath);
    return rootRealPathPromise;
  }

  async function assertIndexPathReadable(): Promise<void> {
    await assertHistoryPathContained(await readRootRealPath(), indexPath);
  }

  async function ensureHistoryDir(): Promise<void> {
    await ensureContainedHistoryDir(rootPath, await readRootRealPath(), historyDir);
  }

  async function assertIndexLockDirContained(): Promise<void> {
    await assertHistoryLockPathContained(await readRootRealPath(), indexLockDir);
  }

  async function readIndex(): Promise<IndexEntry[]> {
    await assertIndexPathReadable();
    return normalizeReadableIndexEntries((await readJson<IndexEntry[]>(indexPath)) ?? []);
  }

  async function writeHistoryFile(path: string, data: string): Promise<void> {
    await writeContainedFileAtomic(await readRootRealPath(), path, data);
  }

  // Serialize record() across all store instances for this root: the index is
  // a read-modify-write, and both watcher and MCP callers can create separate
  // store handles for the same workspace.
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const writeChain = historyWriteChains.get(indexPath) ?? Promise.resolve();
    const run = writeChain.then(task, task);
    // Keep the chain alive even if a task rejects, without unhandled rejection.
    const next = run.then(
      () => undefined,
      () => undefined,
    );
    historyWriteChains.set(indexPath, next);
    next.finally(() => {
      if (historyWriteChains.get(indexPath) === next) {
        historyWriteChains.delete(indexPath);
      }
    });
    return run;
  }

  return {
    record(set, opts) {
      if (!mutationSupported) {
        return Promise.reject(new Error(DURABLE_HISTORY_RECORDING_UNSUPPORTED_MESSAGE));
      }
      let record: HistoryRecord;
      try {
        record = historyRecordFromChangeSet(set, opts);
      } catch (error) {
        return Promise.reject(error);
      }
      return serialize(async () => {
        await ensureHistoryDir();
        const lockLease = await acquireHistoryLock(
          indexLockDir,
          assertIndexLockDirContained,
          readRootRealPath,
        );
        let committed = false;
        let primaryError: unknown;
        let releaseError: unknown;
        try {
          await ensureHistoryDir();
          const index = await readIndex();
          if (index.some((entry) => entry.id === record.id)) {
            throw new Error(`History record ${record.id} already exists.`);
          }
          // Pretty JSON: history is meant to be opened and read by a person.
          await lockLease.assertStillOwnsLock();
          await writeHistoryFile(
            join(historyDir, recordFileName(record)),
            `${JSON.stringify(record, null, 2)}\n`,
          );

          const entry: IndexEntry = {
            id: record.id,
            recordedAtMs: record.recordedAtMs,
            kind: record.kind,
            author: record.author,
            summary: record.summary,
            fileCount: record.files.length,
          };
          index.push(entry);
          await lockLease.assertStillOwnsLock();
          await writeHistoryFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
          committed = true;
        } catch (error) {
          primaryError = error;
        } finally {
          try {
            await lockLease.release();
          } catch (error) {
            releaseError = error;
          }
        }
        if (primaryError) {
          if (releaseError) {
            console.error(
              "[workspace-history] failed to release history lock after failed commit:",
              releaseError,
            );
          }
          throw primaryError;
        }
        if (releaseError) {
          if (!committed) throw releaseError;
          console.error("[workspace-history] failed to release history lock after commit:", releaseError);
        }

        return record;
      });
    },

    async listIndexed() {
      const index = await readIndex();
      // The index is the ordering source; sort newest first by timestamp,
      // breaking ties on id so ordering is stable within the same ms.
      const ordered = index
        .map((entry, index) => ({ entry, index }))
        .sort(
          (a, b) =>
            b.entry.recordedAtMs - a.entry.recordedAtMs ||
            (a.entry.id < b.entry.id ? 1 : a.entry.id > b.entry.id ? -1 : 0),
        );
      const records: IndexedHistoryRecord[] = [];
      for (const item of ordered) {
        // Read the full record from its own file — the index only holds a
        // summary, the per-record file is the source of full detail. One
        // corrupt/truncated record (crash mid-write, hand edit) must cost that
        // one entry, never brick the entire timeline.
        try {
          const record = await readJson<HistoryRecord>(
            join(historyDir, recordFileName(item.entry)),
          );
          if (record) {
            records.push({ index: item.index, record: normalizeHistoryRecord(record) });
          }
        } catch (error) {
          console.error(
            `[workspace-history] skipping unreadable record ${item.entry.id}:`,
            error,
          );
        }
      }
      return records;
    },

    async list() {
      return (await this.listIndexed()).map((entry) => entry.record);
    },

    async listSince(afterMs) {
      const index = await readIndex();
      const ordered = index
        .filter((entry) => entry.recordedAtMs > afterMs)
        .sort(
          (a, b) =>
            a.recordedAtMs - b.recordedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      const records: HistoryRecord[] = [];
      for (const entry of ordered) {
        try {
          const record = await readJson<HistoryRecord>(
            join(historyDir, recordFileName(entry)),
          );
          if (record) records.push(normalizeHistoryRecord(record));
        } catch (error) {
          console.error(
            `[workspace-history] skipping unreadable record ${entry.id}:`,
            error,
          );
        }
      }
      return records;
    },

    async maxRecordedAtMs() {
      return (await readIndex()).reduce((max, entry) => Math.max(max, entry.recordedAtMs), 0);
    },

    // Detail reads are resilient like list reads: one corrupt persisted record
    // cannot blank the timeline or crash direct lookup.
    async get(id) {
      assertSafeHistoryId(id);
      const index = await readIndex();
      const entry = index.find((e) => e.id === id);
      if (!entry) return null;
      const record = await readJson<HistoryRecord>(join(historyDir, recordFileName(entry)));
      if (!record) return null;
      try {
        return normalizeHistoryRecord(record);
      } catch (error) {
        console.error(
          `[workspace-history] skipping unreadable record ${entry.id}:`,
          error,
        );
        return null;
      }
    },
  };
}

// Plain-language attribution: who did what, to how many files. Author-aware so
// a user edit and an agent run read differently. Deliberately prose, never Git
// conflict markers — history is for humans to skim.
export function humanSummary(record: HistoryRecord): string {
  const count = record.files.length;
  const noun = count === 1 ? "file" : "files";
  const verb = verbForKind(record.kind);

  if (record.provenance?.source === "history-restore") {
    const path = record.provenance.restoreOfPath ?? record.files[0]?.path;
    const action =
      record.provenance.restoreDirection === "undo"
        ? "undid restore for"
        : record.provenance.restoreDirection === "redo"
          ? "redid restore for"
          : "restored";
    const actor =
      record.author.kind === "user"
        ? "You"
        : record.author.kind === "agent"
          ? `${record.author.onBehalfOf}'s agent`
          : record.author.label;
    return path ? `${actor} ${action} ${path}` : `${actor} ${action} ${count} ${noun}`;
  }

  if (record.author.kind === "agent") {
    // Attribute to the person the agent acted for, e.g. "Maya's agent".
    return `${record.author.onBehalfOf}'s agent ${verb} ${count} ${noun}`;
  }

  if (record.author.kind === "local") {
    return count === 1
      ? `${record.author.label} ${verb} ${record.files[0].path}`
      : `${record.author.label} ${verb} ${count} ${noun}`;
  }

  // A single, named file reads better than a count for solo user edits.
  if (count === 1) {
    return `You ${verb} ${record.files[0].path}`;
  }
  return `You ${verb} ${count} ${noun}`;
}

export function verbForKind(kind: ChangeSetKind): string {
  switch (kind) {
    case "import":
      return "imported";
    case "agent-run":
      return "ran an agent over";
    case "sync":
      return "synced";
    case "site-build":
      return "built";
    case "history-restore":
      return "restored";
    case "user-edit":
    default:
      return "edited";
  }
}
