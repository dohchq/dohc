import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  lstatSync,
  realpathSync,
  type Dirent,
} from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";
import {
  addFileChanges,
  createChangeSet,
  createLocalChangeAuthor,
  hasIgnoredSegment,
  isDatabaseSidecar,
  parseChangeAuthor,
  validateUserWritePath,
  type ChangeAuthor,
  type ChangeProvenance,
  type ChangeSet,
  type ChangeSetKind,
  type FileChangeSnapshot,
} from "@dohc/workspace-core";
import {
  isTextMediaType,
  mediaTypeForPath,
} from "@dohc/workspace-fs";
import {
  createChangeSetStore,
  type ChangeSetStore,
  type HistoryRecord,
} from "@dohc/workspace-history";
import {
  createVersionedTextStore,
  type ActorNeutralWriteMetadata,
  type FileObjectRecord,
  type TextFileSnapshot,
  type VersionId,
  type VersionRecord,
  type VersionedTextStore,
  type VersionedTextStoreOptions,
  type WorkspaceObjectId,
  type WorkspaceId,
} from "./versionedTextStore";

const MAX_HISTORY_TEXT_SNAPSHOT_BYTES = 128 * 1024;
const MAX_READ_TEXT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PENDING_FILE_MUTATION_JOURNAL_BYTES = 128 * 1024;
const FILE_MUTATION_LOCK_OWNER_MAX_BYTES = 4 * 1024;
const PENDING_FILE_MUTATIONS_RELATIVE_DIR = ".dohc/engine/pending-file-mutations";
const HISTORY_BLOBS_RELATIVE_DIR = ".dohc/engine/history-blobs";
const FILE_MUTATION_LOCK_STALE_MS = 30_000;
const FILE_MUTATION_LOCK_TIMEOUT_MS = 35_000;
const OPEN_READ_NOFOLLOW_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
const OPEN_EXCLUSIVE_WRITE_NOFOLLOW_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (fsConstants.O_NOFOLLOW ?? 0);
const OPEN_DIRECTORY_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
const PROC_SELF_FD_DIR = "/proc/self/fd";
const workspaceMutationChains = new Map<string, Promise<unknown>>();
const pathMutationChains = new Map<string, Promise<unknown>>();

export const LOCAL_FILE_AUTHOR: ChangeAuthor = createLocalChangeAuthor("Local file edit");

export type VersionedFileWorkspaceErrorCode =
  | "file-too-large"
  | "file-not-found"
  | "history-record-failed"
  | "invalid-input"
  | "invalid-path"
  | "invalid-restore-direction"
  | "not-text"
  | "recovery-failed"
  | "restore-file-not-found"
  | "restore-snapshot-unavailable"
  | "restore-stale-live-file"
  | "stale-live-file"
  | "unsupported-filesystem";

export class VersionedFileWorkspaceError extends Error {
  readonly code: VersionedFileWorkspaceErrorCode;

  constructor(code: VersionedFileWorkspaceErrorCode, message: string) {
    super(message);
    this.name = "VersionedFileWorkspaceError";
    this.code = code;
  }
}

function assertSupportedVersionedFileWorkspacePlatform(): void {
  if (process.platform !== "linux") {
    throw new VersionedFileWorkspaceError(
      "unsupported-filesystem",
      "Versioned file workspace requires Linux descriptor-relative filesystem operations.",
    );
  }
  try {
    const procSelfFd = lstatSync(PROC_SELF_FD_DIR);
    if (!procSelfFd.isDirectory()) throw new Error("not a directory");
    accessSync(PROC_SELF_FD_DIR, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    throw new VersionedFileWorkspaceError(
      "unsupported-filesystem",
      "Versioned file workspace requires Linux descriptor-relative filesystem operations.",
    );
  }
}

function canonicalWorkspaceRoot(rootDir: string): { rootDir: string; identity: DirectoryIdentity } {
  const rootPath = realpathSync(rootDir);
  const info = lstatSync(rootPath);
  if (!info.isDirectory()) {
    throw new VersionedFileWorkspaceError(
      "invalid-path",
      `Workspace root ${JSON.stringify(rootDir)} is not a directory.`,
    );
  }
  return {
    rootDir: rootPath,
    identity: { dev: Number(info.dev), ino: Number(info.ino) },
  };
}

export interface VersionedFileStat {
  path: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}

export type VersionedFileReadResult = string | null;
export type VersionedFileListResult = VersionedFileStat[];

export interface VersionedFileWriteResult {
  path: string;
  versionId: VersionId;
  snapshot: TextFileSnapshot;
  history: HistoryRecord;
}

export interface VersionedFileDeleteResult {
  path: string;
  versionId: VersionId;
  deleted: TextFileSnapshot | null;
  history: HistoryRecord;
}

export type VersionedFileRestoreResult = (VersionedFileWriteResult | VersionedFileDeleteResult) & {
  restoredFrom: {
    changeSetId: string;
    path: string;
    direction: "before" | "after";
  };
};

export interface VersionedFileWorkspace {
  ensureMainVersion(): Promise<VersionRecord>;
  createNamedVersion(input: { name: string; fromVersionId: VersionId }): Promise<VersionRecord>;
  writeTextFile(input: {
    path: string;
    text: string;
    versionId?: VersionId;
    metadata?: ActorNeutralWriteMetadata;
    summary?: string;
    provenance?: ChangeProvenance;
  }): Promise<VersionedFileWriteResult>;
  deleteTextFile(input: {
    path: string;
    versionId?: VersionId;
    metadata?: ActorNeutralWriteMetadata;
    summary?: string;
    provenance?: ChangeProvenance;
  }): Promise<VersionedFileDeleteResult>;
  readTextFile(input: { path: string }): Promise<VersionedFileReadResult>;
  listTextFiles(): Promise<VersionedFileListResult>;
  statTextFile(input: { path: string }): Promise<VersionedFileStat | null>;
  restoreTextFile(input: {
    changeSetId: string;
    path: string;
    direction?: "before" | "after";
    versionId?: VersionId;
  }): Promise<VersionedFileRestoreResult>;
  history: VersionedFileHistoryReader;
  versions: VersionedFileVersionReader;
}

export type VersionedFileHistoryReader = Pick<
  ChangeSetStore,
  "get" | "list" | "listIndexed" | "listSince"
>;

export interface VersionedFileVersionReader {
  getMainVersion(): Promise<VersionRecord | null>;
  getObject(input: { objectId: WorkspaceObjectId }): Promise<FileObjectRecord | null>;
  listTextFiles(input: { versionId: VersionId }): Promise<TextFileSnapshot[]>;
  listVersions(): Promise<VersionRecord[]>;
  readTextFile(input: {
    versionId: VersionId;
    path: string;
  }): Promise<TextFileSnapshot | null>;
}

export interface TestableVersionedFileWorkspace extends VersionedFileWorkspace {
  unsafeInternals: {
    history: ChangeSetStore;
    rootDir: string;
    versions: VersionedTextStore;
  };
}

export interface VersionedFileWorkspaceOptions extends VersionedTextStoreOptions {
  rootDir: string;
  workspaceId: WorkspaceId;
  author?: ChangeAuthor;
}

export interface VersionedFileWorkspaceTestHooks {
  afterFileMutationLockAcquired?: () => void | Promise<void>;
  afterFileWriteBeforeHistory?: (path: string) => void | Promise<void>;
  onFileMutationLockWait?: () => void;
  onWorkspaceMutationQueued?: () => void;
}

function normalizeWorkspacePath(path: string): string {
  const result = validateUserWritePath(path);
  if (!result.ok) {
    throw new VersionedFileWorkspaceError(
      "invalid-path",
      `Invalid workspace path ${JSON.stringify(path)}: ${result.reason}`,
    );
  }
  return result.normalized;
}

function normalizeWorkspaceId(workspaceId: WorkspaceId): WorkspaceId {
  if (typeof workspaceId !== "string" || !workspaceId || workspaceId.trim() !== workspaceId) {
    throw new VersionedFileWorkspaceError("invalid-input", "Workspace id is required.");
  }
  return workspaceId;
}

function assertTextWorkspacePath(path: string): void {
  const mediaType = mediaTypeForPath(path);
  if (!isTextMediaType(mediaType, path)) {
    throw new VersionedFileWorkspaceError("not-text", `File ${path} is not text.`);
  }
}

function assertWritableTextSize(path: string, text: string): void {
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > MAX_READ_TEXT_FILE_BYTES) {
    throw new VersionedFileWorkspaceError(
      "file-too-large",
      `File ${path} is too large to write as text.`,
    );
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.toString("utf8") !== text) {
    throw new VersionedFileWorkspaceError(
      "not-text",
      `File ${path} contains text that is not valid UTF-8.`,
    );
  }
}

function isWithinRealRoot(rootRealPath: string, candidateRealPath: string): boolean {
  const offset = relative(rootRealPath, candidateRealPath);
  return (
    offset === "" ||
    (!!offset &&
      offset !== ".." &&
      !offset.startsWith("../") &&
      !offset.startsWith("..\\") &&
      !isAbsolute(offset))
  );
}

function rejectEscapedPath(path: string): never {
  throw new VersionedFileWorkspaceError(
    "invalid-path",
    `Workspace path ${JSON.stringify(path)} resolves outside the workspace root.`,
  );
}

function rejectNonRegularPath(path: string): never {
  throw new VersionedFileWorkspaceError(
    "invalid-path",
    `Workspace path ${JSON.stringify(path)} is not a regular file.`,
  );
}

function assertNoHardLinks(
  workspacePath: string,
  info: Awaited<ReturnType<typeof stat>>,
): void {
  if (Number(info.nlink) > 1) {
    throw new VersionedFileWorkspaceError(
      "invalid-path",
      `Workspace path ${JSON.stringify(workspacePath)} has multiple hard links.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recoveryFailed(message: string, cause?: unknown): VersionedFileWorkspaceError {
  const error = new VersionedFileWorkspaceError("recovery-failed", message);
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
}

function historyRecordFailed(path: string, cause: unknown): VersionedFileWorkspaceError {
  const error = new VersionedFileWorkspaceError(
    "history-record-failed",
    `Could not record history for ${path}.`,
  );
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

async function nearestExistingRealPath(path: string): Promise<{
  path: string;
  realPath: string;
}> {
  let cursor = path;
  for (;;) {
    try {
      return { path: cursor, realPath: await realpath(cursor) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

async function resolveContainedWorkspacePath(rootDir: string, path: string): Promise<string> {
  const rootRealPath = await realpath(rootDir);
  const absolute = resolve(rootRealPath, path);
  try {
    const targetRealPath = await realpath(absolute);
    if (!isWithinRealRoot(rootRealPath, targetRealPath)) rejectEscapedPath(path);
    if (targetRealPath !== absolute) rejectEscapedPath(path);
    return absolute;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const nearest = await nearestExistingRealPath(dirname(absolute));
    if (!isWithinRealRoot(rootRealPath, nearest.realPath)) rejectEscapedPath(path);
    if (nearest.realPath !== nearest.path) rejectEscapedPath(path);
    return absolute;
  }
}

async function assertResolvedWorkspacePath(
  rootDir: string,
  path: string,
  expectedAbsolute: string,
): Promise<void> {
  const actualAbsolute = await resolveContainedWorkspacePath(rootDir, path);
  if (actualAbsolute !== expectedAbsolute) rejectEscapedPath(path);
}

async function assertContainedRealDirectory(
  rootRealPath: string,
  path: string,
  workspacePath: string,
): Promise<DirectoryIdentity> {
  const info = await lstat(path);
  if (!info.isDirectory()) {
    throw new VersionedFileWorkspaceError(
      "invalid-path",
      `Workspace path parent ${JSON.stringify(path)} is not a directory.`,
    );
  }
  const pathRealPath = await realpath(path);
  if (!isWithinRealRoot(rootRealPath, pathRealPath) || pathRealPath !== path) {
    rejectEscapedPath(workspacePath);
  }
  return { dev: info.dev, ino: info.ino };
}

async function ensureSafeInternalDirectory(
  rootRealPath: string,
  path: string,
  workspacePath: string,
): Promise<void> {
  const handle = await open(path, OPEN_DIRECTORY_FLAGS);
  try {
    const openedInfo = await handle.stat();
    if (!openedInfo.isDirectory()) {
      rejectEscapedPath(workspacePath);
    }
    const pathInfo = await lstat(path);
    if (
      pathInfo.isSymbolicLink() ||
      !pathInfo.isDirectory() ||
      !directoryIdentitiesMatch(
        directoryIdentityFromStats(openedInfo),
        directoryIdentityFromStats(pathInfo),
      )
    ) {
      rejectEscapedPath(workspacePath);
    }
    const pathRealPath = await realpath(path);
    if (!isWithinRealRoot(rootRealPath, pathRealPath) || pathRealPath !== path) {
      rejectEscapedPath(workspacePath);
    }
    const mode = openedInfo.mode & 0o777;
    if (mode !== 0o700) {
      await handle.chmod(0o700);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function mkdirChildInVerifiedDirectory(input: {
  parentPath: string;
  childPath: string;
  workspacePath: string;
  mode?: number;
}): Promise<void> {
  const parentIdentity = await readDirectoryIdentity(input.parentPath);
  const parentHandle = await openDirectoryHandleForMutation(
    input.parentPath,
    parentIdentity,
    input.workspacePath,
  );
  try {
    await mkdir(pathInOpenDirectory(parentHandle, input.childPath), {
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    }).catch((mkdirError: NodeJS.ErrnoException) => {
      if (mkdirError.code !== "EEXIST") throw mkdirError;
    });
  } finally {
    await parentHandle.close().catch(() => undefined);
  }
  await syncParentDirectoryBestEffort(input.childPath);
}

async function ensureWorkspaceParentDir(
  rootDir: string,
  workspacePath: string,
  absolute: string,
): Promise<string> {
  const rootRealPath = await realpath(rootDir);
  const parentDir = dirname(absolute);
  const parentRelativePath = relative(rootRealPath, parentDir);
  if (
    parentRelativePath === ".." ||
    parentRelativePath.startsWith("../") ||
    parentRelativePath.startsWith("..\\") ||
    isAbsolute(parentRelativePath)
  ) {
    rejectEscapedPath(workspacePath);
  }
  let cursor = rootRealPath;
  if (parentRelativePath) {
    for (const segment of parentRelativePath.split(/[\\/]+/).filter(Boolean)) {
      const child = join(cursor, segment);
      try {
        await assertContainedRealDirectory(rootRealPath, child, workspacePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdirChildInVerifiedDirectory({
          parentPath: cursor,
          childPath: child,
          workspacePath,
        });
        await assertContainedRealDirectory(rootRealPath, child, workspacePath);
      }
      cursor = child;
    }
  }
  if (cursor !== parentDir) rejectEscapedPath(workspacePath);
  return parentDir;
}

async function ensureInternalTempDir(rootDir: string): Promise<string> {
  return ensureInternalChildDir(rootDir, ".dohc/tmp", [".dohc", "tmp"]);
}

async function ensureInternalChildDir(
  rootDir: string,
  workspacePath: string,
  segments: string[],
): Promise<string> {
  const rootRealPath = await realpath(rootDir);
  let cursor = rootRealPath;
  for (const segment of segments) {
    const child = join(cursor, segment);
    try {
      await ensureSafeInternalDirectory(rootRealPath, child, workspacePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdirChildInVerifiedDirectory({
        parentPath: cursor,
        childPath: child,
        workspacePath,
        mode: 0o700,
      });
      await ensureSafeInternalDirectory(rootRealPath, child, workspacePath);
    }
    cursor = child;
  }
  return cursor;
}

async function ensurePendingMutationDir(rootDir: string): Promise<string> {
  return ensureInternalChildDir(rootDir, PENDING_FILE_MUTATIONS_RELATIVE_DIR, [
    ".dohc",
    "engine",
    "pending-file-mutations",
  ]);
}

async function existingInternalChildDir(
  rootDir: string,
  workspacePath: string,
  segments: string[],
): Promise<string | null> {
  const rootRealPath = await realpath(rootDir);
  let cursor = rootRealPath;
  for (const segment of segments) {
    const child = join(cursor, segment);
    try {
      await ensureSafeInternalDirectory(rootRealPath, child, workspacePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    cursor = child;
  }
  return cursor;
}

async function ensureHistoryBlobDir(rootDir: string, workspaceId: WorkspaceId): Promise<string> {
  const namespace = workspaceHistoryNamespace(workspaceId);
  return ensureInternalChildDir(rootDir, `${HISTORY_BLOBS_RELATIVE_DIR}/${namespace}`, [
    ".dohc",
    "engine",
    "history-blobs",
    namespace,
  ]);
}

async function pendingMutationStateExists(rootDir: string): Promise<boolean> {
  const pendingDir = await existingInternalChildDir(rootDir, PENDING_FILE_MUTATIONS_RELATIVE_DIR, [
    ".dohc",
    "engine",
    "pending-file-mutations",
  ]);
  if (!pendingDir) return false;
  const entries = await readdir(pendingDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  return entries.some((entry) => entry.endsWith(".json"));
}

async function ensureMutationLockDir(rootDir: string): Promise<string> {
  return ensureInternalChildDir(rootDir, ".dohc/engine/mutation-locks", [
    ".dohc",
    "engine",
    "mutation-locks",
  ]);
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface FileMutationLockOwner {
  token: string;
  pid: number;
  createdAtMs: number;
  heartbeatAtMs: number;
}

function createFileMutationLockOwner(token: string): FileMutationLockOwner {
  const nowMs = Date.now();
  return { token, pid: process.pid, createdAtMs: nowMs, heartbeatAtMs: nowMs };
}

function parseFileMutationLockOwner(text: string): FileMutationLockOwner | null {
  try {
    const value = JSON.parse(text) as Partial<FileMutationLockOwner>;
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
    return value as FileMutationLockOwner;
  } catch {
    return null;
  }
}

function fileMutationLockHeartbeatAgeMs(owner: FileMutationLockOwner): number | null {
  const ageMs = Date.now() - owner.heartbeatAtMs;
  return ageMs < 0 ? null : ageMs;
}

async function writeFileMutationLockOwner(
  rootDir: string,
  ownerPath: string,
  token: string,
): Promise<void> {
  await writeInternalJsonAtomic(rootDir, ownerPath, createFileMutationLockOwner(token));
}

interface FileMutationLockGeneration {
  token: string;
  ownerDir: string;
  ownerPath: string;
  ownerDirIdentity: DirectoryIdentity;
  owner: FileMutationLockOwner;
}

interface MutationFence {
  assertStillOwnsLock(): Promise<void>;
}

interface FileMutationLockLease extends MutationFence {
  release(): Promise<void>;
}

function fileMutationLockOwnerDir(lockDir: string, token: string): string {
  return join(lockDir, token);
}

function fileMutationLockOwnerPath(lockDir: string, token: string): string {
  return join(fileMutationLockOwnerDir(lockDir, token), "owner.json");
}

async function readFileMutationLockGeneration(
  lockDir: string,
): Promise<FileMutationLockGeneration | null> {
  const entries = await readdir(lockDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (entries === null) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const token = entry.name;
    const ownerDir = fileMutationLockOwnerDir(lockDir, token);
    const ownerPath = join(ownerDir, "owner.json");
    const ownerDirInfo = await lstat(ownerDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!ownerDirInfo) continue;
    if (ownerDirInfo.isSymbolicLink() || !ownerDirInfo.isDirectory()) {
      throw recoveryFailed(`File mutation lock owner path ${ownerDir} is not a safe directory.`);
    }
    const owner = await readCurrentFileMutationLockOwner(ownerPath);
    if (owner?.token === token) {
      const ownerDirIdentity = directoryIdentityFromStats(ownerDirInfo);
      return { token, ownerDir, ownerPath, ownerDirIdentity, owner };
    }
  }
  return null;
}

async function readCurrentFileMutationLockOwner(
  ownerPath: string,
): Promise<FileMutationLockOwner | null> {
  let initialInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    initialInfo = await lstat(ownerPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
  if (
    initialInfo.isSymbolicLink() ||
    !initialInfo.isFile() ||
    Number(initialInfo.size) > FILE_MUTATION_LOCK_OWNER_MAX_BYTES
  ) {
    return null;
  }
  const handle = await open(ownerPath, OPEN_READ_NOFOLLOW_FLAGS).catch(
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
    if (
      !openedInfo.isFile() ||
      Number(openedInfo.size) > FILE_MUTATION_LOCK_OWNER_MAX_BYTES ||
      !statsIdentityMatches(initialInfo, openedInfo)
    ) {
      return null;
    }
    const contents = await handle.readFile();
    if (contents.byteLength > FILE_MUTATION_LOCK_OWNER_MAX_BYTES) return null;
    return parseFileMutationLockOwner(contents.toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function assertFileMutationLockStillOwned(input: {
  lockDir: string;
  token: string;
  ownerDir: string;
  ownerPath: string;
  ownerDirIdentity: DirectoryIdentity;
}): Promise<void> {
  const ownerDirInfo = await lstat(input.ownerDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (
    !ownerDirInfo ||
    ownerDirInfo.isSymbolicLink() ||
    !ownerDirInfo.isDirectory() ||
    !directoryIdentitiesMatch(input.ownerDirIdentity, directoryIdentityFromStats(ownerDirInfo))
  ) {
    throw recoveryFailed(`Lost file mutation lock ${input.lockDir}.`);
  }
  const owner = await readCurrentFileMutationLockOwner(input.ownerPath);
  if (!owner || owner.token !== input.token || owner.pid !== process.pid) {
    throw recoveryFailed(`Lost file mutation lock ${input.lockDir}.`);
  }
  const verifiedOwnerDirInfo = await lstat(input.ownerDir).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (
    !verifiedOwnerDirInfo ||
    verifiedOwnerDirInfo.isSymbolicLink() ||
    !verifiedOwnerDirInfo.isDirectory() ||
    !directoryIdentitiesMatch(
      input.ownerDirIdentity,
      directoryIdentityFromStats(verifiedOwnerDirInfo),
    )
  ) {
    throw recoveryFailed(`Lost file mutation lock ${input.lockDir}.`);
  }
}

async function isFileMutationLockActivelyOwned(
  lockDir: string,
  staleMs: number,
): Promise<boolean> {
  const generation = await readFileMutationLockGeneration(lockDir);
  if (!generation) return false;
  const owner = await readCurrentFileMutationLockOwner(generation.ownerPath);
  if (owner?.token !== generation.token) return false;
  const heartbeatAgeMs = fileMutationLockHeartbeatAgeMs(owner);
  if (heartbeatAgeMs === null) {
    return isProcessAlive(owner.pid);
  }
  if (heartbeatAgeMs <= staleMs) return true;
  return false;
}

async function removeEmptyLockDir(lockDir: string): Promise<void> {
  try {
    await rmdir(lockDir);
    await syncParentDirectoryBestEffort(lockDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
}

async function lstatSafeLockDirectory(
  lockDir: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  const info = await lstat(lockDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw recoveryFailed(`File mutation lock path ${lockDir} is not a safe directory.`);
  }
  return info;
}

async function reclaimStaleFileMutationLock(
  lockDir: string,
  staleMs: number,
): Promise<boolean> {
  try {
    const info = await lstatSafeLockDirectory(lockDir);
    if (!info) return false;
    const generation = await readFileMutationLockGeneration(lockDir);
    if (!generation) {
      const entries = await readdir(lockDir, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [] as Dirent[];
          throw error;
        },
      );
      const newestEntryMtimeMs = Math.max(
        Number(info.mtimeMs),
        ...(
          await Promise.all(
            entries.map((entry) =>
              lstat(join(lockDir, entry.name))
                .then((entryInfo) => Number(entryInfo.mtimeMs))
                .catch(() => Number(info.mtimeMs)),
            ),
          )
        ),
      );
      if (Date.now() - newestEntryMtimeMs <= staleMs) return false;
      await rm(lockDir, { recursive: true, force: true });
      await syncParentDirectoryBestEffort(lockDir);
      return true;
    }
    const observedHeartbeatAgeMs = fileMutationLockHeartbeatAgeMs(generation.owner);
    if (observedHeartbeatAgeMs !== null && observedHeartbeatAgeMs <= staleMs) return false;
    const currentOwner = await readCurrentFileMutationLockOwner(generation.ownerPath);
    const currentHeartbeatAgeMs = currentOwner
      ? fileMutationLockHeartbeatAgeMs(currentOwner)
      : null;
    if (
      currentOwner?.token !== generation.token ||
      (currentHeartbeatAgeMs !== null && currentHeartbeatAgeMs <= staleMs)
    ) {
      return false;
    }
    const currentOwnerDirInfo = await lstat(generation.ownerDir).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (
      !currentOwnerDirInfo ||
      currentOwnerDirInfo.isSymbolicLink() ||
      !currentOwnerDirInfo.isDirectory() ||
      !directoryIdentitiesMatch(
        generation.ownerDirIdentity,
        directoryIdentityFromStats(currentOwnerDirInfo),
      )
    ) {
      return false;
    }
    await rm(generation.ownerDir, { recursive: true, force: true });
    await syncParentDirectoryBestEffort(generation.ownerDir);
    await removeEmptyLockDir(lockDir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function acquireDirectoryLock(input: {
  rootDir: string;
  lockDir: string;
  staleMs: number;
  timeoutMs: number;
  onWait?: () => void;
}): Promise<FileMutationLockLease> {
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(input.lockDir);
      const token = randomUUID();
      const ownerDir = fileMutationLockOwnerDir(input.lockDir, token);
      const ownerPath = fileMutationLockOwnerPath(input.lockDir, token);
      try {
        await mkdir(ownerDir);
        const ownerDirIdentity = directoryIdentityFromStats(await stat(ownerDir));
        await writeFileMutationLockOwner(input.rootDir, ownerPath, token);
        const heartbeat = setInterval(() => {
          assertFileMutationLockStillOwned({
            lockDir: input.lockDir,
            token,
            ownerDir,
            ownerPath,
            ownerDirIdentity,
          })
            .then(() => writeFileMutationLockOwner(input.rootDir, ownerPath, token))
            .catch(() => undefined);
        }, 5_000);
        heartbeat.unref?.();
        return {
          assertStillOwnsLock: () =>
            assertFileMutationLockStillOwned({
              lockDir: input.lockDir,
              token,
              ownerDir,
              ownerPath,
              ownerDirIdentity,
            }),
          release: async () => {
            clearInterval(heartbeat);
            const currentOwnerDirInfo = await lstat(ownerDir).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return null;
                throw error;
              },
            );
            if (
              !currentOwnerDirInfo ||
              currentOwnerDirInfo.isSymbolicLink() ||
              !currentOwnerDirInfo.isDirectory() ||
              !directoryIdentitiesMatch(
                ownerDirIdentity,
                directoryIdentityFromStats(currentOwnerDirInfo),
              )
            ) {
              return;
            }
            const owner = await readCurrentFileMutationLockOwner(ownerPath).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return null;
                throw error;
              },
            );
            if (owner?.token === token) {
              await rm(ownerDir, { recursive: true, force: true });
              await syncParentDirectoryBestEffort(ownerDir);
              await removeEmptyLockDir(input.lockDir);
            }
          },
        };
      } catch (error) {
        await rm(ownerDir, { recursive: true, force: true }).catch(() => undefined);
        await removeEmptyLockDir(input.lockDir).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await reclaimStaleFileMutationLock(input.lockDir, input.staleMs)) {
        continue;
      }
      if (Date.now() - startedAt > input.timeoutMs) {
        throw recoveryFailed(`Timed out waiting for file mutation lock ${input.lockDir}.`);
      }
      input.onWait?.();
      await delayMs(25);
    }
  }
}

async function acquireWorkspaceFileMutationLock(
  rootDir: string,
  onWait?: () => void,
): Promise<FileMutationLockLease> {
  const mutationLockDir = await ensureMutationLockDir(rootDir);
  const lockDir = join(mutationLockDir, "workspace.lock");
  const lease = await acquireDirectoryLock({
    rootDir,
    lockDir,
    staleMs: FILE_MUTATION_LOCK_STALE_MS,
    timeoutMs: FILE_MUTATION_LOCK_TIMEOUT_MS,
    onWait,
  });
  return {
    assertStillOwnsLock: lease.assertStillOwnsLock,
    release: async () => {
      await lease.release();
    },
  };
}

async function existingWorkspaceFileMutationLockDir(rootDir: string): Promise<string | null> {
  const rootRealPath = await realpath(rootDir);
  const lockDir = join(rootRealPath, ".dohc", "engine", "mutation-locks", "workspace.lock");
  const info = await stat(lockDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  return info ? lockDir : null;
}

async function waitForWorkspaceFileMutationLockToClear(rootDir: string): Promise<void> {
  const lockDir = await existingWorkspaceFileMutationLockDir(rootDir);
  if (!lockDir) return;
  const startedAt = Date.now();
  while (true) {
    if (await reclaimStaleFileMutationLock(lockDir, FILE_MUTATION_LOCK_STALE_MS)) {
      return;
    }
    const info = await stat(lockDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (!info) return;
    const activelyOwned = await isFileMutationLockActivelyOwned(
      lockDir,
      FILE_MUTATION_LOCK_STALE_MS,
    );
    if (!activelyOwned && Date.now() - startedAt > FILE_MUTATION_LOCK_TIMEOUT_MS) {
      throw recoveryFailed(`Timed out waiting for file mutation lock ${lockDir}.`);
    }
    await delayMs(25);
  }
}

function appendSuppressedError(error: unknown, suppressed: unknown): void {
  if (!(error instanceof Error)) return;
  const errorWithSuppressed = error as Error & { suppressed?: unknown[] };
  errorWithSuppressed.suppressed = [
    ...(Array.isArray(errorWithSuppressed.suppressed)
      ? errorWithSuppressed.suppressed
      : []),
    suppressed,
  ];
}

async function runWithFileMutationLock<T>(
  rootDir: string,
  task: (lease: FileMutationLockLease) => Promise<T>,
  onWait?: () => void,
): Promise<T> {
  const lease = await acquireWorkspaceFileMutationLock(rootDir, onWait);
  let taskResult: T | undefined;
  let taskError: unknown;
  let taskSucceeded = false;
  try {
    await lease.assertStillOwnsLock();
    taskResult = await task(lease);
    taskSucceeded = true;
  } catch (error) {
    taskError = error;
  }
  let releaseError: unknown;
  try {
    await lease.release();
  } catch (error) {
    releaseError = error;
  }
  if (!taskSucceeded) {
    if (releaseError !== undefined && taskError !== undefined) {
      appendSuppressedError(taskError, releaseError);
    }
    throw taskError;
  }
  if (releaseError !== undefined) {
    throw releaseError;
  }
  return taskResult as T;
}

function serializeMutationChain<T>(
  chains: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
  onQueued?: () => void,
): Promise<T> {
  const hadPreviousTask = chains.has(key);
  const previous = chains.get(key) ?? Promise.resolve();
  if (hadPreviousTask) onQueued?.();
  const run = previous.then(task, task);
  const next = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, next);
  next.finally(() => {
    if (chains.get(key) === next) {
      chains.delete(key);
    }
  });
  return run;
}

async function serializeWorkspaceMutation<T>(
  rootDir: string,
  task: (lease: FileMutationLockLease) => Promise<T>,
  afterLockAcquired?: () => void | Promise<void>,
  onQueued?: () => void,
  onFileMutationLockWait?: () => void,
): Promise<T> {
  return serializeMutationChain(workspaceMutationChains, await realpath(rootDir), async () => {
    return runWithFileMutationLock(rootDir, async (lease) => {
      await afterLockAcquired?.();
      await lease.assertStillOwnsLock();
      return await task(lease);
    }, onFileMutationLockWait);
  }, onQueued);
}

async function serializePathMutation<T>(
  rootDir: string,
  path: string,
  task: (lease: FileMutationLockLease) => Promise<T>,
  afterLockAcquired?: () => void | Promise<void>,
  onWorkspaceQueued?: () => void,
  onFileMutationLockWait?: () => void,
): Promise<T> {
  const rootRealPath = await realpath(rootDir);
  return serializeMutationChain(workspaceMutationChains, rootRealPath, () =>
    serializeMutationChain(pathMutationChains, `${rootRealPath}\0${path}`, async () => {
      return runWithFileMutationLock(rootDir, async (lease) => {
        await afterLockAcquired?.();
        await lease.assertStillOwnsLock();
        return await task(lease);
      }, onFileMutationLockWait);
    }),
    onWorkspaceQueued,
  );
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function workspaceHistoryNamespace(workspaceId: WorkspaceId): string {
  return `workspace-${sha256Text(workspaceId).slice(0, 32)}`;
}

function createHistoryReader(
  history: ChangeSetStore,
  read: <T>(task: () => Promise<T>) => Promise<T>,
): VersionedFileHistoryReader {
  return {
    get: (id) => read(() => history.get(id)),
    list: () => read(() => history.list()),
    listIndexed: () => read(() => history.listIndexed()),
    listSince: (afterMs) => read(() => history.listSince(afterMs)),
  };
}

function jsonEquivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function historyRecordMatchesChangeSet(
  record: HistoryRecord,
  changeSet: ChangeSet,
  recordedAtMs: number,
): boolean {
  return (
    record.recordedAtMs === recordedAtMs &&
    record.kind === changeSet.kind &&
    record.summary === changeSet.summary &&
    jsonEquivalent(record.author, changeSet.author) &&
    jsonEquivalent(record.files, changeSet.files) &&
    jsonEquivalent(record.provenance, changeSet.provenance) &&
    jsonEquivalent(record.boundaryCrossings, changeSet.boundaryCrossings)
  );
}

async function assertMutationFence(fence: MutationFence | undefined): Promise<void> {
  await fence?.assertStillOwnsLock();
}

async function recordHistoryOrRecoverCommitted(input: {
  history: ChangeSetStore;
  changeSet: Parameters<ChangeSetStore["record"]>[0];
  id: string;
  recordedAtMs: number;
  path: string;
  fence?: MutationFence;
}): Promise<HistoryRecord> {
  try {
    await assertMutationFence(input.fence);
    return await input.history.record(input.changeSet, {
      id: input.id,
      recordedAtMs: input.recordedAtMs,
    });
  } catch (error) {
    const committed = await input.history.get(input.id).catch(() => null);
    if (committed && historyRecordMatchesChangeSet(committed, input.changeSet, input.recordedAtMs)) {
      return committed;
    }
    if (committed) {
      throw historyRecordFailed(
        input.path,
        new Error(`History id ${input.id} already exists with different content.`),
      );
    }
    throw historyRecordFailed(input.path, error);
  }
}

function createTextFileChangeSet(input: {
  author: ChangeAuthor;
  summary: string;
  provenance?: ChangeProvenance;
  path: string;
  operation: "write" | "delete";
  before: FileChangeSnapshot | null;
  after: FileChangeSnapshot | null;
}): ChangeSet {
  return addFileChanges(
    createChangeSet({
      kind: kindFromProvenance(input.provenance),
      author: input.author,
      summary: input.summary,
      ...(input.provenance ? { provenance: input.provenance } : {}),
    }),
    [
      {
        path: input.path,
        operation: input.operation,
        before: input.before,
        after: input.after,
      },
    ],
  );
}

function createVersionReader(
  versions: VersionedTextStore,
  workspaceId: WorkspaceId,
  read: <T>(task: () => Promise<T>) => Promise<T>,
): VersionedFileVersionReader {
  return {
    getMainVersion: () => read(() => versions.getMainVersion({ workspaceId })),
    getObject: (input) => read(() => versions.getObject({ workspaceId, objectId: input.objectId })),
    listTextFiles: (input) => read(() => versions.listTextFiles({ workspaceId, ...input })),
    listVersions: () => read(() => versions.listVersions({ workspaceId })),
    readTextFile: (input) => read(() => versions.readTextFile({ workspaceId, ...input })),
  };
}

function snapshotForText(text: string, sizeBytes = Buffer.byteLength(text)): FileChangeSnapshot {
  if (sizeBytes > MAX_HISTORY_TEXT_SNAPSHOT_BYTES) {
    return {
      sha256: sha256Text(text),
      sizeBytes,
      truncated: true,
      unavailableReason: "too-large",
    };
  }
  return {
    sha256: sha256Text(text),
    sizeBytes,
    text,
  };
}

function snapshotForBytes(bytes: Uint8Array): FileChangeSnapshot {
  const sizeBytes = bytes.byteLength;
  if (sizeBytes > MAX_HISTORY_TEXT_SNAPSHOT_BYTES) {
    return {
      sha256: sha256Bytes(bytes),
      sizeBytes,
      truncated: true,
      unavailableReason: "too-large",
    };
  }
  try {
    return snapshotForText(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      sizeBytes,
    );
  } catch {
    return {
      sha256: sha256Bytes(bytes),
      sizeBytes,
      unavailableReason: "unreadable",
    };
  }
}

async function snapshotForOpenFile(
  handle: Awaited<ReturnType<typeof open>>,
  info: Awaited<ReturnType<typeof stat>>,
): Promise<FileChangeSnapshot> {
  const infoSizeBytes = Number(info.size);
  if (infoSizeBytes > MAX_HISTORY_TEXT_SNAPSHOT_BYTES) {
    return {
      sha256: await sha256OpenFile(handle),
      sizeBytes: infoSizeBytes,
      truncated: true,
      unavailableReason: "too-large",
    };
  }
  const { bytes, truncated } = await readOpenFileBytesUpTo(
    handle,
    MAX_HISTORY_TEXT_SNAPSHOT_BYTES,
  );
  if (truncated) {
    const currentInfo = await handle.stat();
    return {
      sha256: await sha256OpenFile(handle),
      sizeBytes: Number(currentInfo.size),
      truncated: true,
      unavailableReason: "too-large",
    };
  }
  return snapshotForBytes(bytes);
}

async function assertOpenFileContainsUtf8Text(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
      decoder.decode(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), { stream: true });
    }
    decoder.decode();
  } catch (error) {
    const wrapped = new VersionedFileWorkspaceError(
      "not-text",
      `File ${path} is not valid UTF-8 text.`,
    );
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
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

function statsIdentityMatches(
  left: Awaited<ReturnType<typeof stat>>,
  right: Awaited<ReturnType<typeof stat>>,
): boolean {
  return Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino);
}

async function readDirectoryIdentity(path: string): Promise<DirectoryIdentity> {
  const info = await lstat(path);
  if (!info.isDirectory()) {
    throw new VersionedFileWorkspaceError(
      "invalid-path",
      `Workspace path parent ${JSON.stringify(path)} is not a directory.`,
    );
  }
  return directoryIdentityFromStats(info);
}

async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
  workspacePath: string,
): Promise<void> {
  const actual = await readDirectoryIdentity(path);
  if (!directoryIdentitiesMatch(actual, expected)) {
    rejectEscapedPath(workspacePath);
  }
}

async function openVerifiedDirectoryHandle(
  path: string,
  expected: DirectoryIdentity,
  workspacePath: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  const handle = await open(path, OPEN_DIRECTORY_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || !directoryIdentitiesMatch(directoryIdentityFromStats(info), expected)) {
      rejectEscapedPath(workspacePath);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openDirectoryHandleForRead(
  path: string,
  expected: DirectoryIdentity,
  workspacePath: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  if (process.platform !== "linux") {
    throw new VersionedFileWorkspaceError(
      "unsupported-filesystem",
      "Versioned file workspace requires anchored directory handles for safe local file access.",
    );
  }
  return openVerifiedDirectoryHandle(path, expected, workspacePath);
}

async function openDirectoryHandleForMutation(
  path: string,
  expected: DirectoryIdentity,
  workspacePath: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  if (process.platform !== "linux") {
    throw new VersionedFileWorkspaceError(
      "unsupported-filesystem",
      "Versioned file workspace requires anchored directory handles for safe local file mutation.",
    );
  }
  return openVerifiedDirectoryHandle(path, expected, workspacePath);
}

function pathInOpenDirectory(
  directory: Awaited<ReturnType<typeof open>>,
  targetPath: string,
): string {
  return join(openDirectoryDescriptorPath(directory), basename(targetPath));
}

function openDirectoryDescriptorPath(directory: Awaited<ReturnType<typeof open>>): string {
  return join(PROC_SELF_FD_DIR, String(directory.fd));
}

async function pathInVerifiedOpenDirectory(input: {
  rootDir: string;
  directory: Awaited<ReturnType<typeof open>>;
  targetPath: string;
  workspacePath: string;
}): Promise<string> {
  const rootRealPath = await realpath(input.rootDir);
  const directoryRealPath = await realpath(openDirectoryDescriptorPath(input.directory));
  if (!isWithinRealRoot(rootRealPath, directoryRealPath)) {
    rejectEscapedPath(input.workspacePath);
  }
  const requestedParentRealPath = await realpath(dirname(input.targetPath)).catch(() =>
    rejectEscapedPath(input.workspacePath),
  );
  if (requestedParentRealPath !== directoryRealPath) {
    rejectEscapedPath(input.workspacePath);
  }
  return pathInOpenDirectory(input.directory, input.targetPath);
}

async function syncDirectoryHandleBestEffort(
  directory: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  try {
    await directory.sync();
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

async function renameIntoVerifiedParent(input: {
  rootDir: string;
  workspacePath: string;
  tmpPath: string;
  targetPath: string;
  parentDir: string;
  parentIdentity: DirectoryIdentity;
}): Promise<void> {
  await assertResolvedWorkspacePath(input.rootDir, input.workspacePath, input.targetPath);
  await assertDirectoryIdentity(input.parentDir, input.parentIdentity, input.workspacePath);
  const parentHandle = await openDirectoryHandleForMutation(
    input.parentDir,
    input.parentIdentity,
    input.workspacePath,
  );
  try {
    await assertResolvedWorkspacePath(input.rootDir, input.workspacePath, input.targetPath);
    await assertDirectoryIdentity(input.parentDir, input.parentIdentity, input.workspacePath);
    await rename(
      input.tmpPath,
      await pathInVerifiedOpenDirectory({
        rootDir: input.rootDir,
        directory: parentHandle,
        targetPath: input.targetPath,
        workspacePath: input.workspacePath,
      }),
    );
    await syncDirectoryHandleBestEffort(parentHandle);
  } finally {
    await parentHandle?.close();
  }
}

async function removeFromVerifiedParent(input: {
  rootDir: string;
  workspacePath: string;
  targetPath: string;
  parentDir: string;
  parentIdentity: DirectoryIdentity;
}): Promise<void> {
  await assertResolvedWorkspacePath(input.rootDir, input.workspacePath, input.targetPath);
  await assertDirectoryIdentity(input.parentDir, input.parentIdentity, input.workspacePath);
  const parentHandle = await openDirectoryHandleForMutation(
    input.parentDir,
    input.parentIdentity,
    input.workspacePath,
  );
  try {
    await assertResolvedWorkspacePath(input.rootDir, input.workspacePath, input.targetPath);
    await assertDirectoryIdentity(input.parentDir, input.parentIdentity, input.workspacePath);
    await rm(
      await pathInVerifiedOpenDirectory({
        rootDir: input.rootDir,
        directory: parentHandle,
        targetPath: input.targetPath,
        workspacePath: input.workspacePath,
      }),
      { force: true },
    );
    await syncDirectoryHandleBestEffort(parentHandle);
  } finally {
    await parentHandle?.close();
  }
}

async function renameFromVerifiedParent(input: {
  rootDir: string;
  workspacePath: string;
  targetPath: string;
  destinationPath: string;
  parentDir: string;
  parentIdentity: DirectoryIdentity;
}): Promise<void> {
  await assertResolvedWorkspacePath(input.rootDir, input.workspacePath, input.targetPath);
  await assertDirectoryIdentity(input.parentDir, input.parentIdentity, input.workspacePath);
  const parentHandle = await openDirectoryHandleForMutation(
    input.parentDir,
    input.parentIdentity,
    input.workspacePath,
  );
  try {
    await assertResolvedWorkspacePath(input.rootDir, input.workspacePath, input.targetPath);
    await assertDirectoryIdentity(input.parentDir, input.parentIdentity, input.workspacePath);
    await rename(
      await pathInVerifiedOpenDirectory({
        rootDir: input.rootDir,
        directory: parentHandle,
        targetPath: input.targetPath,
        workspacePath: input.workspacePath,
      }),
      input.destinationPath,
    );
    await syncDirectoryHandleBestEffort(parentHandle);
    await syncParentDirectoryBestEffort(input.destinationPath);
  } finally {
    await parentHandle?.close();
  }
}

async function writeFileExclusiveIntoVerifiedParent(input: {
  rootDir: string;
  workspacePath: string;
  targetPath: string;
  parentDir: string;
  parentIdentity: DirectoryIdentity;
  data: string | Uint8Array;
  mode?: number;
}): Promise<void> {
  await assertResolvedWorkspacePath(input.rootDir, input.workspacePath, input.targetPath);
  await assertDirectoryIdentity(input.parentDir, input.parentIdentity, input.workspacePath);
  const parentHandle = await openDirectoryHandleForMutation(
    input.parentDir,
    input.parentIdentity,
    input.workspacePath,
  );
  let targetDescriptorPath: string | undefined;
  let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
  let createdTarget = false;
  let committedTarget = false;
  try {
    await assertResolvedWorkspacePath(input.rootDir, input.workspacePath, input.targetPath);
    await assertDirectoryIdentity(input.parentDir, input.parentIdentity, input.workspacePath);
    targetDescriptorPath = await pathInVerifiedOpenDirectory({
      rootDir: input.rootDir,
      directory: parentHandle,
      targetPath: input.targetPath,
      workspacePath: input.workspacePath,
    });
    targetHandle = await open(
      targetDescriptorPath,
      OPEN_EXCLUSIVE_WRITE_NOFOLLOW_FLAGS,
      (input.mode ?? 0o666) | 0o600,
    );
    createdTarget = true;
    if (typeof input.data === "string") {
      await targetHandle.writeFile(input.data, "utf8");
    } else {
      await targetHandle.writeFile(input.data);
    }
    if (input.mode !== undefined) await targetHandle.chmod(input.mode);
    await targetHandle.sync();
    committedTarget = true;
    await syncDirectoryHandleBestEffort(parentHandle);
  } catch (error) {
    await targetHandle?.close().catch(() => undefined);
    targetHandle = undefined;
    if (createdTarget && !committedTarget && targetDescriptorPath) {
      await rm(targetDescriptorPath, { force: true }).catch(() => undefined);
      await syncDirectoryHandleBestEffort(parentHandle).catch(() => undefined);
    }
    throw error;
  } finally {
    await targetHandle?.close();
    await parentHandle?.close();
  }
}

async function copyFileExclusiveIntoVerifiedParent(input: {
  rootDir: string;
  workspacePath: string;
  sourcePath: string;
  targetPath: string;
  parentDir: string;
  parentIdentity: DirectoryIdentity;
  mode?: number;
}): Promise<void> {
  await assertResolvedWorkspacePath(input.rootDir, input.workspacePath, input.targetPath);
  await assertDirectoryIdentity(input.parentDir, input.parentIdentity, input.workspacePath);
  const parentHandle = await openDirectoryHandleForMutation(
    input.parentDir,
    input.parentIdentity,
    input.workspacePath,
  );
  try {
    await assertResolvedWorkspacePath(input.rootDir, input.workspacePath, input.targetPath);
    await assertDirectoryIdentity(input.parentDir, input.parentIdentity, input.workspacePath);
    const targetDescriptorPath = await pathInVerifiedOpenDirectory({
      rootDir: input.rootDir,
      directory: parentHandle,
      targetPath: input.targetPath,
      workspacePath: input.workspacePath,
    });
    await copyFile(input.sourcePath, targetDescriptorPath, fsConstants.COPYFILE_EXCL);
    await syncFileDurably(targetDescriptorPath, input.mode);
    await syncDirectoryHandleBestEffort(parentHandle);
  } finally {
    await parentHandle?.close();
  }
}

async function openWorkspaceFileForRead(
  rootDir: string,
  workspacePath: string,
  absolute: string,
): Promise<{ handle: Awaited<ReturnType<typeof open>>; info: Awaited<ReturnType<typeof stat>> } | null> {
  const parentDir = dirname(absolute);
  const parentIdentity = await readDirectoryIdentity(parentDir);
  await assertResolvedWorkspacePath(rootDir, workspacePath, absolute);
  await assertDirectoryIdentity(parentDir, parentIdentity, workspacePath);
  const parentHandle = await openDirectoryHandleForRead(
    parentDir,
    parentIdentity,
    workspacePath,
  );
  try {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(pathInOpenDirectory(parentHandle, absolute), OPEN_READ_NOFOLLOW_FLAGS);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code === "ELOOP") rejectEscapedPath(workspacePath);
      throw error;
    }
    try {
      const info = await handle.stat();
      await assertResolvedWorkspacePath(rootDir, workspacePath, absolute);
      await assertDirectoryIdentity(parentDir, parentIdentity, workspacePath);
      if (!info.isFile()) {
        await handle.close();
        return null;
      }
      assertNoHardLinks(workspacePath, info);
      const currentInfo = await lstat(absolute);
      if (!currentInfo.isFile() || !statsIdentityMatches(info, currentInfo)) {
        rejectEscapedPath(workspacePath);
      }
      return { handle, info };
    } catch (error) {
      await handle.close();
      throw error;
    }
  } finally {
    await parentHandle?.close();
  }
}

async function openWorkspaceFileForReadIfPresent(
  rootDir: string,
  workspacePath: string,
  absolute: string,
): Promise<{ handle: Awaited<ReturnType<typeof open>>; info: Awaited<ReturnType<typeof stat>> } | null> {
  try {
    return await openWorkspaceFileForRead(rootDir, workspacePath, absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function listWorkspaceTextFileStats(rootDir: string): Promise<VersionedFileStat[]> {
  const files: VersionedFileStat[] = [];

  async function scanDir(relativeDir: string): Promise<void> {
    const workspacePath = relativeDir || ".";
    const absoluteDir = relativeDir
      ? await resolveContainedWorkspacePath(rootDir, relativeDir)
      : await realpath(rootDir);
    const directoryIdentity = await readDirectoryIdentity(absoluteDir);
    const directoryHandle = await openDirectoryHandleForRead(
      absoluteDir,
      directoryIdentity,
      workspacePath,
    );
    let entries: Dirent[];
    try {
      entries = await readdir(openDirectoryDescriptorPath(directoryHandle), {
        withFileTypes: true,
      });
    } finally {
      await directoryHandle.close();
    }
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (hasIgnoredSegment(relativePath)) continue;
      if (entry.isDirectory()) {
        await scanDir(relativePath);
        continue;
      }
      if (!entry.isFile() || isDatabaseSidecar(relativePath)) continue;
      const validation = validateUserWritePath(relativePath);
      if (!validation.ok) continue;
      const path = validation.normalized;
      const mediaType = mediaTypeForPath(path);
      if (!isTextMediaType(mediaType, path)) continue;
      const absolute = await resolveContainedWorkspacePath(rootDir, path);
      const opened = await openWorkspaceFileForRead(rootDir, path, absolute);
      if (!opened) continue;
      try {
        const sizeBytes = Number(opened.info.size);
        if (sizeBytes > MAX_READ_TEXT_FILE_BYTES) continue;
        try {
          await assertOpenFileContainsUtf8Text(opened.handle, path);
        } catch (error) {
          if ((error as { code?: string }).code === "not-text") continue;
          throw error;
        }
        files.push({
          path,
          mediaType,
          sizeBytes,
          sha256: await sha256OpenFile(opened.handle),
        });
      } finally {
        await opened.handle.close();
      }
    }
  }

  await scanDir("");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function writeFileAtomic(
  rootDir: string,
  workspacePath: string,
  path: string,
  data: string | Uint8Array,
  tmpDir: string,
  mode?: number,
): Promise<void> {
  const parentDir = dirname(path);
  await ensureWorkspaceParentDir(rootDir, workspacePath, path);
  await assertResolvedWorkspacePath(rootDir, workspacePath, path);
  const parentIdentity = await readDirectoryIdentity(parentDir);
  const tmp = join(tmpDir, `write-${process.pid}-${randomUUID()}.tmp`);
  let existingMode: number | undefined;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) rejectEscapedPath(workspacePath);
    if (!info.isFile()) rejectNonRegularPath(workspacePath);
    assertNoHardLinks(workspacePath, info);
    existingMode = info.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const targetMode = mode ?? existingMode;
  try {
    await writeFileDurably(tmp, data, targetMode ?? 0o666, targetMode);
    await syncParentDirectoryBestEffort(tmp);
    await renameIntoVerifiedParent({
      rootDir,
      workspacePath,
      tmpPath: tmp,
      targetPath: path,
      parentDir,
      parentIdentity,
    });
  } catch (error) {
    await rm(tmp, { force: true });
    await syncParentDirectoryBestEffort(tmp).catch(() => undefined);
    throw error;
  }
}

interface PreservedLivePreimage {
  parentDir: string;
  parentIdentity: DirectoryIdentity;
  preservedPath?: string;
  mode?: number;
}

function staleLiveFileChanged(path: string, operation: string): VersionedFileWorkspaceError {
  return new VersionedFileWorkspaceError(
    "stale-live-file",
    `Live file ${path} changed before ${operation}.`,
  );
}

async function restorePreservedLivePreimage(input: {
  rootDir: string;
  workspacePath: string;
  targetPath: string;
  preserved: PreservedLivePreimage;
}): Promise<void> {
  if (!input.preserved.preservedPath) return;
  await copyFileExclusiveIntoVerifiedParent({
    rootDir: input.rootDir,
    workspacePath: input.workspacePath,
    sourcePath: input.preserved.preservedPath,
    targetPath: input.targetPath,
    parentDir: input.preserved.parentDir,
    parentIdentity: input.preserved.parentIdentity,
    ...(input.preserved.mode !== undefined ? { mode: input.preserved.mode } : {}),
  });
  await rm(input.preserved.preservedPath, { force: true }).catch(() => undefined);
  await syncParentDirectoryBestEffort(input.preserved.preservedPath).catch(() => undefined);
}

async function discardPreservedLivePreimage(input: {
  preserved: PreservedLivePreimage;
}): Promise<void> {
  if (!input.preserved.preservedPath) return;
  await rm(input.preserved.preservedPath, { force: true }).catch(() => undefined);
  await syncParentDirectoryBestEffort(input.preserved.preservedPath).catch(() => undefined);
}

async function preserveLivePreimageForMutation(input: {
  rootDir: string;
  workspacePath: string;
  targetPath: string;
  tmpDir: string;
  expected: FileChangeSnapshot | null;
  operation: string;
}): Promise<PreservedLivePreimage> {
  const parentDir = dirname(input.targetPath);
  await ensureWorkspaceParentDir(input.rootDir, input.workspacePath, input.targetPath);
  await assertResolvedWorkspacePath(input.rootDir, input.workspacePath, input.targetPath);
  const parentIdentity = await readDirectoryIdentity(parentDir);
  const currentInfo = await lstat(input.targetPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (input.expected === null || input.expected?.unavailableReason === "missing") {
    if (currentInfo?.isSymbolicLink()) rejectEscapedPath(input.workspacePath);
    if (currentInfo && !currentInfo.isFile()) rejectNonRegularPath(input.workspacePath);
    if (currentInfo) {
      assertNoHardLinks(input.workspacePath, currentInfo);
      throw staleLiveFileChanged(input.workspacePath, input.operation);
    }
    return { parentDir, parentIdentity };
  }
  if (!currentInfo) throw staleLiveFileChanged(input.workspacePath, input.operation);
  if (currentInfo.isSymbolicLink()) rejectEscapedPath(input.workspacePath);
  if (!currentInfo.isFile()) rejectNonRegularPath(input.workspacePath);
  assertNoHardLinks(input.workspacePath, currentInfo);
  const preservedPath = join(input.tmpDir, `live-${process.pid}-${randomUUID()}.bak`);
  const preserved: PreservedLivePreimage = {
    parentDir,
    parentIdentity,
    preservedPath,
    mode: currentInfo.mode & 0o777,
  };
  let moved = false;
  try {
    await renameFromVerifiedParent({
      rootDir: input.rootDir,
      workspacePath: input.workspacePath,
      targetPath: input.targetPath,
      destinationPath: preservedPath,
      parentDir,
      parentIdentity,
    });
    moved = true;
    const opened = await open(preservedPath, OPEN_READ_NOFOLLOW_FLAGS);
    try {
      const snapshot = await snapshotForOpenFile(opened, await opened.stat());
      if (!snapshotsMatch(snapshot, input.expected)) {
        await restorePreservedLivePreimage({
          rootDir: input.rootDir,
          workspacePath: input.workspacePath,
          targetPath: input.targetPath,
          preserved,
        });
        moved = false;
        throw staleLiveFileChanged(input.workspacePath, input.operation);
      }
    } finally {
      await opened.close();
    }
    return preserved;
  } catch (error) {
    if (moved) {
      await restorePreservedLivePreimage({
        rootDir: input.rootDir,
        workspacePath: input.workspacePath,
        targetPath: input.targetPath,
        preserved,
      }).catch((restoreError) => {
        attachRollbackError(error, restoreError);
      });
    }
    throw error;
  }
}

async function writeFileAtomicAfterPreservingPreimage(input: {
  rootDir: string;
  workspacePath: string;
  path: string;
  data: string | Uint8Array;
  tmpDir: string;
  expected: FileChangeSnapshot | null;
  operation: string;
}): Promise<void> {
  const preserved = await preserveLivePreimageForMutation({
    rootDir: input.rootDir,
    workspacePath: input.workspacePath,
    targetPath: input.path,
    tmpDir: input.tmpDir,
    expected: input.expected,
    operation: input.operation,
  });
  try {
    await writeFileExclusiveIntoVerifiedParent({
      rootDir: input.rootDir,
      workspacePath: input.workspacePath,
      targetPath: input.path,
      parentDir: preserved.parentDir,
      parentIdentity: preserved.parentIdentity,
      data: input.data,
      ...(preserved.mode !== undefined ? { mode: preserved.mode } : {}),
    });
    await discardPreservedLivePreimage({ preserved });
  } catch (error) {
    await restorePreservedLivePreimage({
      rootDir: input.rootDir,
      workspacePath: input.workspacePath,
      targetPath: input.path,
      preserved,
    }).catch((restoreError) => {
      attachRollbackError(error, restoreError);
    });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw staleLiveFileChanged(input.workspacePath, input.operation);
    }
    throw error;
  }
}

async function removeFileAfterPreservingPreimage(input: {
  rootDir: string;
  workspacePath: string;
  path: string;
  tmpDir: string;
  expected: FileChangeSnapshot | null;
  operation: string;
}): Promise<void> {
  const preserved = await preserveLivePreimageForMutation({
    rootDir: input.rootDir,
    workspacePath: input.workspacePath,
    targetPath: input.path,
    tmpDir: input.tmpDir,
    expected: input.expected,
    operation: input.operation,
  });
  try {
    const recreated = await lstat(input.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (recreated) throw staleLiveFileChanged(input.workspacePath, input.operation);
    await discardPreservedLivePreimage({ preserved });
  } catch (error) {
    await restorePreservedLivePreimage({
      rootDir: input.rootDir,
      workspacePath: input.workspacePath,
      targetPath: input.path,
      preserved,
    }).catch((restoreError) => {
      attachRollbackError(error, restoreError);
    });
    throw error;
  }
}

async function writeFileAtomicFromFile(
  rootDir: string,
  workspacePath: string,
  path: string,
  source: Awaited<ReturnType<typeof open>>,
  tmpDir: string,
  mode?: number,
): Promise<void> {
  const parentDir = dirname(path);
  await ensureWorkspaceParentDir(rootDir, workspacePath, path);
  await assertResolvedWorkspacePath(rootDir, workspacePath, path);
  const parentIdentity = await readDirectoryIdentity(parentDir);
  const tmp = join(tmpDir, `write-${process.pid}-${randomUUID()}.tmp`);
  let existingMode: number | undefined;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) rejectEscapedPath(workspacePath);
    if (!info.isFile()) rejectNonRegularPath(workspacePath);
    assertNoHardLinks(workspacePath, info);
    existingMode = info.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const targetMode = mode ?? existingMode;
  try {
    await copyOpenFileContentsDurably(source, tmp, targetMode ?? 0o666, targetMode);
    await syncParentDirectoryBestEffort(tmp);
    await renameIntoVerifiedParent({
      rootDir,
      workspacePath,
      tmpPath: tmp,
      targetPath: path,
      parentDir,
      parentIdentity,
    });
  } catch (error) {
    await rm(tmp, { force: true });
    await syncParentDirectoryBestEffort(tmp).catch(() => undefined);
    throw error;
  }
}

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

async function writeFileDurably(
  path: string,
  data: string | Uint8Array,
  mode = 0o600,
  chmodMode?: number,
): Promise<void> {
  const handle = await open(path, "w", mode);
  try {
    if (typeof data === "string") {
      await handle.writeFile(data, "utf8");
    } else {
      await handle.writeFile(data);
    }
    if (chmodMode !== undefined) await handle.chmod(chmodMode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFileDurably(path: string, chmodMode?: number): Promise<void> {
  const handle = await open(path, "r+");
  try {
    if (chmodMode !== undefined) await handle.chmod(chmodMode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function copyOpenFileContentsDurably(
  source: Awaited<ReturnType<typeof open>>,
  targetPath: string,
  mode = 0o600,
  chmodMode?: number,
): Promise<void> {
  const writableTempMode = mode | 0o600;
  await pipeline(
    source.createReadStream({ start: 0, autoClose: false }),
    createWriteStream(targetPath, { mode: writableTempMode }),
  );
  await syncFileDurably(targetPath, chmodMode);
}

async function sha256Readable(readable: NodeJS.ReadableStream): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of readable) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function sha256OpenFile(source: Awaited<ReturnType<typeof open>>): Promise<string> {
  return sha256Readable(source.createReadStream({ start: 0, autoClose: false }));
}

async function readOpenFileBytesUpTo(
  source: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of source.createReadStream({
    start: 0,
    end: maxBytes,
    autoClose: false,
  })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
    totalBytes += buffer.byteLength;
  }
  const bytes = Buffer.concat(chunks, totalBytes);
  return {
    bytes: totalBytes > maxBytes ? bytes.subarray(0, maxBytes) : bytes,
    truncated: totalBytes > maxBytes,
  };
}

async function readOpenFileBytes(source: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source.createReadStream({ start: 0, autoClose: false })) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function verifyBackupMatchesSnapshot(
  source: Awaited<ReturnType<typeof open>>,
  before: FileChangeSnapshot | null,
  path: string,
): Promise<void> {
  if (before === null || before?.unavailableReason === "missing") {
    throw recoveryFailed(`Cannot restore ${path}: backup exists for a missing preimage.`);
  }
  const info = await source.stat();
  if (!info.isFile()) {
    throw recoveryFailed(`Cannot restore ${path}: disk preimage backup is not a file.`);
  }
  if (typeof before.sizeBytes === "number" && Number(info.size) !== before.sizeBytes) {
    throw recoveryFailed(`Cannot restore ${path}: disk preimage backup size changed.`);
  }
  if (before.sha256 && (await sha256OpenFile(source)) !== before.sha256) {
    throw recoveryFailed(`Cannot restore ${path}: disk preimage backup hash changed.`);
  }
  if (typeof before.text === "string") {
    const bytes = await readOpenFileBytes(source);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
      throw recoveryFailed(`Cannot restore ${path}: disk preimage backup is not text.`, error);
    }
    if (text !== before.text) {
      throw recoveryFailed(`Cannot restore ${path}: disk preimage backup text changed.`);
    }
  }
}

async function openInternalParentHandleForMutation(
  rootDir: string,
  path: string,
): Promise<{
  parentHandle: Awaited<ReturnType<typeof open>>;
  parentDir: string;
  parentIdentity: DirectoryIdentity;
}> {
  const rootRealPath = await realpath(rootDir);
  const parentDir = dirname(path);
  const parentIdentity = await assertContainedRealDirectory(rootRealPath, parentDir, path);
  const parentHandle = await openDirectoryHandleForMutation(parentDir, parentIdentity, path);
  try {
    await assertDirectoryIdentity(parentDir, parentIdentity, path);
    return { parentHandle, parentDir, parentIdentity };
  } catch (error) {
    await parentHandle.close().catch(() => undefined);
    throw error;
  }
}

async function writeInternalFileAtomic(
  rootDir: string,
  path: string,
  writeTemp: (tmpPath: string) => Promise<void>,
): Promise<void> {
  const { parentHandle, parentDir, parentIdentity } =
    await openInternalParentHandleForMutation(rootDir, path);
  const tmp = join(
    openDirectoryDescriptorPath(parentHandle),
    `${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    await writeTemp(tmp);
    await syncDirectoryHandleBestEffort(parentHandle);
    await assertDirectoryIdentity(parentDir, parentIdentity, path);
    await rename(
      tmp,
      await pathInVerifiedOpenDirectory({
        rootDir,
        directory: parentHandle,
        targetPath: path,
        workspacePath: path,
      }),
    );
    await syncDirectoryHandleBestEffort(parentHandle);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    await syncDirectoryHandleBestEffort(parentHandle).catch(() => undefined);
    throw error;
  } finally {
    await parentHandle.close();
  }
}

async function writeInternalJsonAtomic(
  rootDir: string,
  path: string,
  value: unknown,
): Promise<void> {
  await writeInternalBytesAtomic(rootDir, path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeInternalBytesAtomic(
  rootDir: string,
  path: string,
  value: string | Uint8Array,
): Promise<void> {
  await writeInternalFileAtomic(rootDir, path, (tmp) => writeFileDurably(tmp, value));
}

async function writeInternalOpenFileAtomic(
  rootDir: string,
  path: string,
  source: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  await writeInternalFileAtomic(rootDir, path, (tmp) => copyOpenFileContentsDurably(source, tmp));
}

async function removeInternalFile(rootDir: string, path: string): Promise<void> {
  let parent: Awaited<ReturnType<typeof openInternalParentHandleForMutation>> | null;
  try {
    parent = await openInternalParentHandleForMutation(rootDir, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const { parentHandle } = parent;
  try {
    await rm(
      await pathInVerifiedOpenDirectory({
        rootDir,
        directory: parentHandle,
        targetPath: path,
        workspacePath: path,
      }),
      { force: true },
    );
    await syncDirectoryHandleBestEffort(parentHandle);
  } finally {
    await parentHandle.close();
  }
}

function historyBlobFileName(snapshot: FileChangeSnapshot): string | null {
  if (
    snapshot.unavailableReason !== "too-large" ||
    !snapshot.sha256 ||
    !/^[a-f0-9]{64}$/u.test(snapshot.sha256) ||
    typeof snapshot.sizeBytes !== "number" ||
    !Number.isSafeInteger(snapshot.sizeBytes) ||
    snapshot.sizeBytes < 0
  ) {
    return null;
  }
  return `${snapshot.sha256}-${snapshot.sizeBytes}.blob`;
}

async function historyBlobPath(
  rootDir: string,
  workspaceId: WorkspaceId,
  snapshot: FileChangeSnapshot | null | undefined,
): Promise<string | null> {
  if (!snapshot) return null;
  const fileName = historyBlobFileName(snapshot);
  if (!fileName) return null;
  return join(await ensureHistoryBlobDir(rootDir, workspaceId), fileName);
}

async function persistHistoryBlobText(
  rootDir: string,
  workspaceId: WorkspaceId,
  snapshot: FileChangeSnapshot | null | undefined,
  text: string,
): Promise<string | null> {
  const blobPath = await historyBlobPath(rootDir, workspaceId, snapshot);
  if (!blobPath) return null;
  const existed = await lstat(blobPath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  await writeInternalBytesAtomic(rootDir, blobPath, text);
  return existed ? null : blobPath;
}

async function persistHistoryBlobFromBackup(
  rootDir: string,
  workspaceId: WorkspaceId,
  snapshot: FileChangeSnapshot | null | undefined,
  backupPath: string | undefined,
): Promise<string | null> {
  const blobPath = await historyBlobPath(rootDir, workspaceId, snapshot);
  if (!blobPath || !backupPath) return null;
  const existed = await lstat(blobPath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  const backup = await open(backupPath, OPEN_READ_NOFOLLOW_FLAGS);
  try {
    await writeInternalOpenFileAtomic(rootDir, blobPath, backup);
  } finally {
    await backup.close();
  }
  return existed ? null : blobPath;
}

async function discardUnreferencedHistoryBlobs(
  rootDir: string,
  workspaceId: WorkspaceId,
  paths: readonly string[],
): Promise<void> {
  const uniquePaths = [...new Set(paths)];
  if (!uniquePaths.length) return;
  const blobDir = await ensureHistoryBlobDir(rootDir, workspaceId);
  for (const path of uniquePaths) {
    const offset = relative(blobDir, path);
    if (
      offset === "" ||
      offset === ".." ||
      offset.startsWith("../") ||
      offset.startsWith("..\\") ||
      isAbsolute(offset)
    ) {
      throw recoveryFailed("Pending file mutation history blob path is outside the blob store.");
    }
    await removeInternalFile(rootDir, path);
  }
  await rmdir(blobDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
  });
}

async function readHistoryBlobText(
  rootDir: string,
  workspaceId: WorkspaceId,
  snapshot: FileChangeSnapshot,
  changeSetId: string,
  path: string,
): Promise<string> {
  if (typeof snapshot.sizeBytes === "number" && snapshot.sizeBytes > MAX_READ_TEXT_FILE_BYTES) {
    throw new VersionedFileWorkspaceError(
      "file-too-large",
      `History record ${changeSetId} large text content is too large to restore for ${path}.`,
    );
  }
  const blobPath = await historyBlobPath(rootDir, workspaceId, snapshot);
  if (!blobPath) {
    throw new VersionedFileWorkspaceError(
      "restore-snapshot-unavailable",
      `History record ${changeSetId} does not contain restorable text for ${path}.`,
    );
  }
  const blob = await open(blobPath, OPEN_READ_NOFOLLOW_FLAGS).catch((error) => {
    const wrapped = new VersionedFileWorkspaceError(
      "restore-snapshot-unavailable",
      `History record ${changeSetId} is missing large text content for ${path}.`,
    );
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  });
  try {
    await verifyBackupMatchesSnapshot(blob, snapshot, path);
    const bytes = await readOpenFileBytes(blob);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (error instanceof VersionedFileWorkspaceError) throw error;
    const wrapped = new VersionedFileWorkspaceError(
      "restore-snapshot-unavailable",
      `History record ${changeSetId} large text content is invalid for ${path}.`,
    );
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  } finally {
    await blob.close();
  }
}

interface DiskPreimageBackup {
  targetPath: string;
  backupPath?: string;
  mode?: number;
}

interface DiskPreimageCapture {
  snapshot: FileChangeSnapshot | null;
  backup: DiskPreimageBackup;
}

type PendingFileMutationPhase =
  | "prepared"
  | "disk-mutating"
  | "disk-mutated"
  | "version-recording"
  | "version-recorded"
  | "history-recorded"
  | "recovery-conflict";

interface PendingFileMutationJournal {
  schemaVersion: 1;
  id: string;
  workspaceId: WorkspaceId;
  versionId: VersionId;
  path: string;
  operation: "write" | "delete";
  phase: PendingFileMutationPhase;
  before: FileChangeSnapshot | null;
  after: FileChangeSnapshot | null;
  diskBackup: DiskPreimageBackup;
  historyId: string;
  historyRecordedAtMs: number;
  expectedChangeSet?: ChangeSet;
  versionMutationMomentId?: string;
  createdHistoryBlobPaths: string[];
  createdAtMs: number;
}

const PENDING_MUTATION_ID_RE = /^pending_[A-Fa-f0-9-]+$/;

function pendingMutationFileName(id: string): string {
  if (!PENDING_MUTATION_ID_RE.test(id)) {
    throw recoveryFailed(`Pending mutation id ${JSON.stringify(id)} is invalid.`);
  }
  return `${id}.json`;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw recoveryFailed(`${label} is invalid in a pending file mutation.`);
  }
  return value;
}

function assertNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw recoveryFailed(`${label} is invalid in a pending file mutation.`);
  }
  return value;
}

function normalizePendingPhase(value: unknown): PendingFileMutationPhase {
  if (
    value === "prepared" ||
    value === "disk-mutating" ||
    value === "disk-mutated" ||
    value === "version-recording" ||
    value === "version-recorded" ||
    value === "history-recorded" ||
    value === "recovery-conflict"
  ) {
    return value;
  }
  throw recoveryFailed("Pending file mutation phase is invalid.");
}

function normalizePendingOperation(value: unknown): "write" | "delete" {
  if (value === "write" || value === "delete") return value;
  throw recoveryFailed("Pending file mutation operation is invalid.");
}

function isChangeSetKind(value: unknown): value is ChangeSetKind {
  return (
    value === "user-edit" ||
    value === "agent-run" ||
    value === "import" ||
    value === "sync" ||
    value === "site-build" ||
    value === "history-restore"
  );
}

function normalizePendingChangeSet(value: unknown): ChangeSet | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw recoveryFailed("Pending file mutation expected change set is invalid.");
  }
  if (
    !isChangeSetKind(value.kind) ||
    !isRecord(value.author) ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.boundaryCrossings)
  ) {
    throw recoveryFailed("Pending file mutation expected change set is invalid.");
  }
  let author: ChangeAuthor;
  try {
    author = parseChangeAuthor(value.author);
  } catch (error) {
    throw recoveryFailed("Pending file mutation expected change set author is invalid.", error);
  }
  return {
    kind: value.kind,
    author,
    summary: value.summary,
    files: value.files as ChangeSet["files"],
    boundaryCrossings: value.boundaryCrossings as ChangeSet["boundaryCrossings"],
    ...(value.provenance !== undefined
      ? { provenance: value.provenance as ChangeProvenance }
      : {}),
  };
}

function normalizePendingBackup(value: unknown): DiskPreimageBackup {
  if (!isRecord(value)) {
    throw recoveryFailed("Pending file mutation disk backup is invalid.");
  }
  const targetPath = assertString(value.targetPath, "Pending disk target path");
  const backupPath =
    value.backupPath === undefined
      ? undefined
      : assertString(value.backupPath, "Pending disk backup path");
  const mode =
    value.mode === undefined ? undefined : assertNumber(value.mode, "Pending disk backup mode");
  return {
    targetPath,
    ...(backupPath ? { backupPath } : {}),
    ...(mode !== undefined ? { mode } : {}),
  };
}

function normalizePendingBefore(value: unknown): FileChangeSnapshot | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw recoveryFailed("Pending file mutation preimage is invalid.");
  }
  const snapshot: FileChangeSnapshot = {};
  if (value.sha256 !== undefined) {
    snapshot.sha256 = assertString(value.sha256, "Pending preimage sha256");
  }
  if (value.sizeBytes !== undefined) {
    snapshot.sizeBytes = assertNumber(value.sizeBytes, "Pending preimage size");
  }
  if (value.text !== undefined) {
    if (typeof value.text !== "string") {
      throw recoveryFailed("Pending preimage text is invalid in a pending file mutation.");
    }
    snapshot.text = value.text;
  }
  if (value.truncated !== undefined) {
    if (typeof value.truncated !== "boolean") {
      throw recoveryFailed("Pending preimage truncation flag is invalid.");
    }
    snapshot.truncated = value.truncated;
  }
  if (value.unavailableReason !== undefined) {
    if (value.text !== undefined) {
      throw recoveryFailed(
        "Pending file mutation snapshot mixes unavailable state with content.",
      );
    }
    if (
      value.unavailableReason !== "missing" &&
      value.unavailableReason !== "binary" &&
      value.unavailableReason !== "too-large" &&
      value.unavailableReason !== "unreadable"
    ) {
      throw recoveryFailed("Pending preimage unavailable reason is invalid.");
    }
    snapshot.unavailableReason = value.unavailableReason;
  }
  return snapshot;
}

function normalizePendingAfter(value: unknown): FileChangeSnapshot | null {
  return normalizePendingBefore(value);
}

function normalizePendingHistoryBlobPaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw recoveryFailed("Pending file mutation history blob paths are invalid.");
  }
  return value.map((path) => assertString(path, "Pending history blob path"));
}

function normalizePendingJournal(raw: unknown): PendingFileMutationJournal {
  if (!isRecord(raw) || raw.schemaVersion !== 1) {
    throw recoveryFailed("Pending file mutation journal is invalid.");
  }
  const id = assertString(raw.id, "Pending mutation id");
  const path = normalizeWorkspacePath(assertString(raw.path, "Pending mutation path"));
  assertTextWorkspacePath(path);
  const operation = normalizePendingOperation(raw.operation);
  const before = normalizePendingBefore(raw.before);
  const after = normalizePendingAfter(raw.after);
  if (operation === "write" && (after === null || after.unavailableReason === "missing")) {
    throw recoveryFailed("Pending write mutation postimage is invalid.");
  }
  if (operation === "delete" && (before === null || before.unavailableReason === "missing")) {
    throw recoveryFailed("Pending delete mutation preimage is invalid.");
  }
  if (operation === "delete" && after !== null) {
    throw recoveryFailed("Pending delete mutation postimage is invalid.");
  }
  return {
    schemaVersion: 1,
    id,
    workspaceId: normalizeWorkspaceId(
      assertString(raw.workspaceId, "Pending mutation workspace id"),
    ),
    versionId: assertString(raw.versionId, "Pending mutation version id"),
    path,
    operation,
    phase: normalizePendingPhase(raw.phase),
    before,
    after,
    diskBackup: normalizePendingBackup(raw.diskBackup),
    historyId: assertString(raw.historyId, "Pending mutation history id"),
    historyRecordedAtMs: assertNumber(
      raw.historyRecordedAtMs,
      "Pending mutation history timestamp",
    ),
    ...(raw.expectedChangeSet !== undefined
      ? { expectedChangeSet: normalizePendingChangeSet(raw.expectedChangeSet) }
      : {}),
    ...(raw.versionMutationMomentId !== undefined
      ? {
          versionMutationMomentId: assertString(
            raw.versionMutationMomentId,
            "Pending mutation moment id",
          ),
        }
      : {}),
    createdHistoryBlobPaths: normalizePendingHistoryBlobPaths(raw.createdHistoryBlobPaths),
    createdAtMs: assertNumber(raw.createdAtMs, "Pending mutation creation timestamp"),
  };
}

async function writePendingMutationJournal(
  rootDir: string,
  journal: PendingFileMutationJournal,
): Promise<void> {
  const dir = await ensurePendingMutationDir(rootDir);
  await writeInternalJsonAtomic(rootDir, join(dir, pendingMutationFileName(journal.id)), journal);
}

async function removePendingMutationJournal(
  rootDir: string,
  journal: PendingFileMutationJournal,
  fence?: MutationFence,
): Promise<void> {
  const dir = await ensurePendingMutationDir(rootDir);
  await assertMutationFence(fence);
  await removeInternalFile(rootDir, join(dir, pendingMutationFileName(journal.id)));
}

async function readPendingMutationJournalFile(
  dir: string,
  entry: string,
): Promise<unknown> {
  const path = join(dir, entry);
  let diskInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    diskInfo = await lstat(path);
  } catch (error) {
    throw recoveryFailed(`Pending mutation file ${entry} is unreadable.`, error);
  }
  if (!diskInfo.isFile()) {
    throw recoveryFailed(`Pending mutation file ${entry} is not a regular file.`);
  }
  if (Number(diskInfo.size) > MAX_PENDING_FILE_MUTATION_JOURNAL_BYTES) {
    throw recoveryFailed(`Pending mutation file ${entry} exceeds the maximum supported size.`);
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, OPEN_READ_NOFOLLOW_FLAGS);
  } catch (error) {
    throw recoveryFailed(`Pending mutation file ${entry} is unreadable.`, error);
  }
  try {
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || !statsIdentityMatches(diskInfo, openedInfo)) {
      throw recoveryFailed(`Pending mutation file ${entry} changed before recovery could read it.`);
    }
    if (Number(openedInfo.size) > MAX_PENDING_FILE_MUTATION_JOURNAL_BYTES) {
      throw recoveryFailed(`Pending mutation file ${entry} exceeds the maximum supported size.`);
    }
    const { bytes, truncated } = await readOpenFileBytesUpTo(
      handle,
      MAX_PENDING_FILE_MUTATION_JOURNAL_BYTES,
    );
    if (truncated) {
      throw recoveryFailed(`Pending mutation file ${entry} exceeds the maximum supported size.`);
    }
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw recoveryFailed(`Pending mutation file ${entry} is unreadable or malformed.`, error);
    }
  } finally {
    await handle.close();
  }
}

async function readPendingMutationJournals(
  rootDir: string,
  workspaceId?: WorkspaceId,
): Promise<PendingFileMutationJournal[]> {
  const dir = await ensurePendingMutationDir(rootDir);
  const entries = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  const journals: PendingFileMutationJournal[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const raw = await readPendingMutationJournalFile(dir, entry);
    if (workspaceId !== undefined && isRecord(raw)) {
      const rawWorkspaceId = raw.workspaceId;
      if (typeof rawWorkspaceId === "string" && rawWorkspaceId !== workspaceId) {
        continue;
      }
    }
    const journal = normalizePendingJournal(raw);
    if (workspaceId !== undefined && journal.workspaceId !== workspaceId) {
      continue;
    }
    if (pendingMutationFileName(journal.id) !== entry) {
      throw recoveryFailed(`Pending mutation file ${entry} does not match its id.`);
    }
    journals.push(journal);
  }
  return journals.sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
}

async function createPendingMutationJournal(input: {
  rootDir: string;
  workspaceId: WorkspaceId;
  versionId: VersionId;
  path: string;
  operation: "write" | "delete";
  before: FileChangeSnapshot | null;
  after: FileChangeSnapshot | null;
  diskBackup: DiskPreimageBackup;
  historyId: string;
  historyRecordedAtMs: number;
  expectedChangeSet: ChangeSet;
  createdAtMs: number;
  fence?: MutationFence;
}): Promise<PendingFileMutationJournal> {
  const journal: PendingFileMutationJournal = {
    schemaVersion: 1,
    id: `pending_${randomUUID()}`,
    workspaceId: input.workspaceId,
    versionId: input.versionId,
    path: input.path,
    operation: input.operation,
    phase: "prepared",
    before: input.before,
    after: input.after,
    diskBackup: input.diskBackup,
    historyId: input.historyId,
    historyRecordedAtMs: input.historyRecordedAtMs,
    expectedChangeSet: input.expectedChangeSet,
    createdHistoryBlobPaths: [],
    createdAtMs: input.createdAtMs,
  };
  await assertMutationFence(input.fence);
  await writePendingMutationJournal(input.rootDir, journal);
  return journal;
}

async function updatePendingMutationJournal(
  rootDir: string,
  journal: PendingFileMutationJournal,
  patch: Partial<
    Pick<PendingFileMutationJournal, "phase" | "versionMutationMomentId" | "createdHistoryBlobPaths">
  >,
  fence?: MutationFence,
): Promise<PendingFileMutationJournal> {
  const next = { ...journal, ...patch };
  await assertMutationFence(fence);
  await writePendingMutationJournal(rootDir, next);
  return next;
}

async function rememberCreatedHistoryBlobPath(
  rootDir: string,
  journal: PendingFileMutationJournal,
  createdHistoryBlobPaths: string[],
  blobPath: string | null,
  fence?: MutationFence,
): Promise<PendingFileMutationJournal> {
  if (!blobPath) return journal;
  createdHistoryBlobPaths.push(blobPath);
  return updatePendingMutationJournal(
    rootDir,
    journal,
    { createdHistoryBlobPaths: [...createdHistoryBlobPaths] },
    fence,
  );
}

async function createDiskPreimageBackup(
  rootDir: string,
  workspacePath: string,
  path: string,
  tmpDir: string,
): Promise<DiskPreimageCapture> {
  try {
    const opened = await openWorkspaceFileForRead(rootDir, workspacePath, path);
    if (!opened) return { snapshot: null, backup: { targetPath: path } };
    const backupPath = join(tmpDir, `backup-${process.pid}-${randomUUID()}.bak`);
    try {
      if (Number(opened.info.size) > MAX_READ_TEXT_FILE_BYTES) {
        throw new VersionedFileWorkspaceError(
          "file-too-large",
          `File ${workspacePath} is too large to read as text.`,
        );
      }
      await assertOpenFileContainsUtf8Text(opened.handle, workspacePath);
      const snapshot = await snapshotForOpenFile(opened.handle, opened.info);
      try {
        await copyOpenFileContentsDurably(opened.handle, backupPath);
        await syncParentDirectoryBestEffort(backupPath);
        const backup = await open(backupPath, "r");
        try {
          await verifyBackupMatchesSnapshot(backup, snapshot, workspacePath);
        } finally {
          await backup.close();
        }
        const liveInfo = await opened.handle.stat();
        if (typeof snapshot.sizeBytes === "number" && Number(liveInfo.size) !== snapshot.sizeBytes) {
          throw recoveryFailed(
            `Cannot capture ${workspacePath}: live file changed while backing up its preimage.`,
          );
        }
        if (snapshot.sha256 && (await sha256OpenFile(opened.handle)) !== snapshot.sha256) {
          throw recoveryFailed(
            `Cannot capture ${workspacePath}: live file changed while backing up its preimage.`,
          );
        }
        const currentOpened = await openWorkspaceFileForRead(rootDir, workspacePath, path);
        try {
          if (!currentOpened || !statsIdentityMatches(opened.info, currentOpened.info)) {
            throw recoveryFailed(
              `Cannot capture ${workspacePath}: live file was replaced while backing up its preimage.`,
            );
          }
        } finally {
          await currentOpened?.handle.close();
        }
      } catch (error) {
        await rm(backupPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return {
        snapshot,
        backup: { targetPath: path, backupPath, mode: Number(opened.info.mode) & 0o777 },
      };
    } finally {
      await opened.handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { snapshot: null, backup: { targetPath: path } };
    }
    throw error;
  }
}

async function resolveDiskPreimageBackupPath(
  rootDir: string,
  backupPath: string,
): Promise<string> {
  const tempDir = await ensureInternalTempDir(rootDir);
  const tempRealPath = await realpath(tempDir);
  const backupRealPath = await realpath(backupPath);
  if (!isWithinRealRoot(tempRealPath, backupRealPath) || backupRealPath !== backupPath) {
    throw recoveryFailed("Disk preimage backup path resolves outside the engine temp directory.");
  }
  return backupPath;
}

async function backupPathForRemoval(rootDir: string, backupPath: string): Promise<string | null> {
  try {
    return await resolveDiskPreimageBackupPath(rootDir, backupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function discardDiskPreimageBackup(
  rootDir: string,
  backup: DiskPreimageBackup,
  fence?: MutationFence,
): Promise<void> {
  if (backup.backupPath) {
    const backupPath = await backupPathForRemoval(rootDir, backup.backupPath);
    if (backupPath) {
      await assertMutationFence(fence);
      await rm(backupPath, { force: true });
      await syncParentDirectoryBestEffort(backupPath);
    }
  }
}

async function discardDiskPreimageBackupBestEffort(
  rootDir: string,
  backup: DiskPreimageBackup,
  fence?: MutationFence,
): Promise<void> {
  try {
    await discardDiskPreimageBackup(rootDir, backup, fence);
  } catch {
    // Backup cleanup happens after the history entry commits; failure must not roll back.
  }
}

async function assertPendingBackupTargetMatchesJournal(
  rootDir: string,
  journal: PendingFileMutationJournal,
): Promise<void> {
  const expectedTargetPath = await resolveContainedWorkspacePath(rootDir, journal.path);
  if (journal.diskBackup.targetPath !== expectedTargetPath) {
    throw recoveryFailed("Pending file mutation disk target path does not match its workspace path.");
  }
}

function attachRollbackError(error: unknown, rollbackError: unknown): void {
  if (error instanceof Error) {
    (error as Error & { rollbackError?: unknown }).rollbackError = rollbackError;
  }
}

async function restoreDiskPreimage(
  rootDir: string,
  path: string,
  before: FileChangeSnapshot | null,
  backup: DiskPreimageBackup,
  fence?: MutationFence,
): Promise<void> {
  if (backup.backupPath) {
    const tmpDir = await ensureInternalTempDir(rootDir);
    const source = await open(backup.backupPath, OPEN_READ_NOFOLLOW_FLAGS);
    try {
      await verifyBackupMatchesSnapshot(source, before, path);
      await assertMutationFence(fence);
      await writeFileAtomicFromFile(rootDir, path, backup.targetPath, source, tmpDir, backup.mode);
    } finally {
      await source.close();
    }
    return;
  }
  await assertMutationFence(fence);
  await restoreSnapshotToDisk(rootDir, path, before);
}

async function pendingHistoryRecordMatchesJournal(
  history: ChangeSetStore,
  journal: PendingFileMutationJournal,
): Promise<boolean> {
  const record = await history.get(journal.historyId);
  if (!record || !journal.expectedChangeSet) return false;
  return historyRecordMatchesChangeSet(
    record,
    journal.expectedChangeSet,
    journal.historyRecordedAtMs,
  );
}

async function restoreBackupForJournal(
  rootDir: string,
  journal: PendingFileMutationJournal,
  fence?: MutationFence,
): Promise<void> {
  const targetPath = await resolveContainedWorkspacePath(rootDir, journal.path);
  let backupPath: string | undefined;
  if (journal.diskBackup.backupPath) {
    backupPath = await resolveDiskPreimageBackupPath(rootDir, journal.diskBackup.backupPath);
  }
  await restoreDiskPreimage(rootDir, journal.path, journal.before, {
    targetPath,
    ...(backupPath ? { backupPath } : {}),
    ...(journal.diskBackup.mode !== undefined ? { mode: journal.diskBackup.mode } : {}),
  }, fence);
}

function phaseHasCompletedDiskMutation(phase: PendingFileMutationPhase): boolean {
  return (
    phase === "disk-mutated" ||
    phase === "version-recording" ||
    phase === "version-recorded" ||
    phase === "history-recorded"
  );
}

function phaseHasCompletedVersionMutation(phase: PendingFileMutationPhase): boolean {
  return (
    phase === "version-recording" ||
    phase === "version-recorded" ||
    phase === "history-recorded"
  );
}

async function diskPreimageStillMatches(
  rootDir: string,
  journal: PendingFileMutationJournal,
): Promise<boolean> {
  const targetPath = await resolveContainedWorkspacePath(rootDir, journal.path);
  const opened = await openWorkspaceFileForReadIfPresent(rootDir, journal.path, targetPath);
  if (journal.diskBackup.backupPath) {
    if (!opened) return false;
    try {
      const backupPath = await resolveDiskPreimageBackupPath(rootDir, journal.diskBackup.backupPath);
      const backup = await open(backupPath, OPEN_READ_NOFOLLOW_FLAGS);
      try {
        await verifyBackupMatchesSnapshot(backup, journal.before, journal.path);
        const backupInfo = await backup.stat();
        if (Number(opened.info.size) !== Number(backupInfo.size)) return false;
        const targetHash = await sha256OpenFile(opened.handle);
        const backupHash = await sha256OpenFile(backup);
        return targetHash === backupHash;
      } finally {
        await backup.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    } finally {
      await opened.handle.close();
    }
  }
  if (typeof journal.before?.text === "string") {
    if (!opened) return false;
    try {
      return snapshotsMatch(await snapshotForOpenFile(opened.handle, opened.info), journal.before);
    } finally {
      await opened.handle.close();
    }
  }
  if (opened) {
    await opened.handle.close();
    return false;
  }
  return journal.before === null || journal.before?.unavailableReason === "missing";
}

async function diskPostimageStillMatches(
  rootDir: string,
  journal: PendingFileMutationJournal,
): Promise<boolean> {
  const targetPath = await resolveContainedWorkspacePath(rootDir, journal.path);
  const opened = await openWorkspaceFileForReadIfPresent(rootDir, journal.path, targetPath);
  if (!opened) return snapshotsMatch(null, journal.after);
  try {
    return snapshotsMatch(await snapshotForOpenFile(opened.handle, opened.info), journal.after);
  } finally {
    await opened.handle.close();
  }
}

async function failPendingMutationRecoveryConflict(
  rootDir: string,
  journal: PendingFileMutationJournal,
  fence?: MutationFence,
): Promise<never> {
  await updatePendingMutationJournal(rootDir, journal, { phase: "recovery-conflict" }, fence);
  throw recoveryFailed(
    `Pending mutation for ${journal.path} no longer matches its recorded postimage.`,
  );
}

async function rollbackVersionMutationForJournal(
  versions: VersionedTextStore,
  journal: PendingFileMutationJournal,
  fence?: MutationFence,
): Promise<void> {
  if (!journal.versionMutationMomentId) return;
  try {
    await assertMutationFence(fence);
    await versions.rollbackTextFileMutation({
      workspaceId: journal.workspaceId,
      versionId: journal.versionId,
      path: journal.path,
      mutationMomentId: journal.versionMutationMomentId,
      legacyBeforeText: typeof journal.before?.text === "string" ? journal.before.text : undefined,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "file-not-found" || code === "version-not-found") {
      return;
    }
    throw error;
  }
}

async function rollbackPendingFileMutation(input: {
  rootDir: string;
  versions: VersionedTextStore;
  history: ChangeSetStore;
  journal: PendingFileMutationJournal;
  skipHistoryCheck?: boolean;
  fence?: MutationFence;
}): Promise<void> {
  const { rootDir, versions, history, journal, skipHistoryCheck = false, fence } = input;
  await assertPendingBackupTargetMatchesJournal(rootDir, journal);
  if (!skipHistoryCheck && (await pendingHistoryRecordMatchesJournal(history, journal))) {
    await removePendingMutationJournal(rootDir, journal, fence);
    await discardDiskPreimageBackupBestEffort(rootDir, journal.diskBackup, fence);
    return;
  }

  if (journal.phase === "prepared") {
    await discardDiskPreimageBackup(rootDir, journal.diskBackup, fence);
    await removePendingMutationJournal(rootDir, journal, fence);
    await discardUnreferencedHistoryBlobs(
      rootDir,
      journal.workspaceId,
      journal.createdHistoryBlobPaths,
    );
    return;
  }

  if (journal.phase === "recovery-conflict") {
    throw recoveryFailed(`Pending mutation for ${journal.path} is in recovery conflict.`);
  }

  if (await diskPreimageStillMatches(rootDir, journal)) {
    if (phaseHasCompletedVersionMutation(journal.phase)) {
      await rollbackVersionMutationForJournal(versions, journal, fence);
    }
    await removePendingMutationJournal(rootDir, journal, fence);
    await discardDiskPreimageBackup(rootDir, journal.diskBackup, fence);
    await discardUnreferencedHistoryBlobs(
      rootDir,
      journal.workspaceId,
      journal.createdHistoryBlobPaths,
    );
    return;
  }

  if (journal.phase === "disk-mutating") {
    await restoreBackupForJournal(rootDir, journal, fence);
  } else if (phaseHasCompletedDiskMutation(journal.phase)) {
    if (!(await diskPostimageStillMatches(rootDir, journal))) {
      await failPendingMutationRecoveryConflict(rootDir, journal, fence);
    }
    await restoreBackupForJournal(rootDir, journal, fence);
  } else {
    await removePendingMutationJournal(rootDir, journal, fence);
    await discardDiskPreimageBackup(rootDir, journal.diskBackup, fence);
    await discardUnreferencedHistoryBlobs(
      rootDir,
      journal.workspaceId,
      journal.createdHistoryBlobPaths,
    );
    return;
  }
  if (phaseHasCompletedVersionMutation(journal.phase)) {
    await rollbackVersionMutationForJournal(versions, journal, fence);
  }
  await removePendingMutationJournal(rootDir, journal, fence);
  await discardDiskPreimageBackup(rootDir, journal.diskBackup, fence);
  await discardUnreferencedHistoryBlobs(rootDir, journal.workspaceId, journal.createdHistoryBlobPaths);
}

async function cleanupCommittedPendingMutation(
  rootDir: string,
  journal: PendingFileMutationJournal,
  fence?: MutationFence,
): Promise<void> {
  let cleanupJournal = journal;
  try {
    cleanupJournal = await updatePendingMutationJournal(rootDir, cleanupJournal, {
      phase: "history-recorded",
    }, fence);
  } catch {
    // The history record is committed; leftover journals are recovered later.
  }
  await discardDiskPreimageBackupBestEffort(rootDir, cleanupJournal.diskBackup, fence);
  try {
    await removePendingMutationJournal(rootDir, cleanupJournal, fence);
  } catch {
    // Best-effort post-commit cleanup. Recovery will clear this if it remains.
  }
}

async function recoverPendingFileMutations(input: {
  rootDir: string;
  workspaceId: WorkspaceId;
  versions: VersionedTextStore;
  history: ChangeSetStore;
  fence?: MutationFence;
}): Promise<void> {
  const histories = new Map<WorkspaceId, ChangeSetStore>([[input.workspaceId, input.history]]);
  const journals = await readPendingMutationJournals(input.rootDir);
  for (const journal of journals) {
    let history = histories.get(journal.workspaceId);
    if (!history) {
      history = createChangeSetStore(input.rootDir, {
        namespace: workspaceHistoryNamespace(journal.workspaceId),
      });
      histories.set(journal.workspaceId, history);
    }
    try {
      await rollbackPendingFileMutation({
        rootDir: input.rootDir,
        versions: input.versions,
        history,
        journal,
        fence: input.fence,
      });
    } catch (error) {
      throw recoveryFailed(`Could not recover pending mutation for ${journal.path}.`, error);
    }
  }
}

async function restoreSnapshotToDisk(
  rootDir: string,
  path: string,
  before: FileChangeSnapshot | null,
): Promise<void> {
  const absolute = await resolveContainedWorkspacePath(rootDir, path);
  if (typeof before?.text === "string") {
    const tmpDir = await ensureInternalTempDir(rootDir);
    await writeFileAtomic(rootDir, path, absolute, before.text, tmpDir);
    return;
  }
  if (before === null || before.unavailableReason === "missing") {
    const parentDir = dirname(absolute);
    let parentIdentity: DirectoryIdentity | null;
    try {
      parentIdentity = await readDirectoryIdentity(parentDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await assertResolvedWorkspacePath(rootDir, path, absolute);
    await removeFromVerifiedParent({
      rootDir,
      workspacePath: path,
      targetPath: absolute,
      parentDir,
      parentIdentity,
    });
    return;
  }
  throw recoveryFailed(
    `Cannot restore ${path}: preimage snapshot is unavailable and no disk backup exists.`,
  );
}

function kindFromProvenance(provenance?: ChangeProvenance): ChangeSetKind {
  return provenance?.source ?? "user-edit";
}

function defaultSummary(path: string, provenance?: ChangeProvenance): string {
  if (provenance?.source === "history-restore") {
    switch (provenance.restoreDirection) {
      case "undo":
        return `Undid restore for ${path}`;
      case "redo":
        return `Redid restore for ${path}`;
      case "restore":
      case undefined:
        return `Restored ${path}`;
      default: {
        const exhaustive: never = provenance.restoreDirection;
        return exhaustive;
      }
    }
  }
  return `Saved ${path}`;
}

function defaultDeleteSummary(path: string, provenance?: ChangeProvenance): string {
  if (provenance?.source === "history-restore") {
    return defaultSummary(path, provenance);
  }
  return `Deleted ${path}`;
}

async function restorableTextSnapshot(
  rootDir: string,
  workspaceId: WorkspaceId,
  snapshot: FileChangeSnapshot | null | undefined,
  changeSetId: string,
  path: string,
): Promise<string> {
  if (typeof snapshot?.text === "string") return snapshot.text;
  if (snapshot?.unavailableReason === "too-large") {
    return readHistoryBlobText(rootDir, workspaceId, snapshot, changeSetId, path);
  }
  throw new VersionedFileWorkspaceError(
    "restore-snapshot-unavailable",
    `History record ${changeSetId} does not contain restorable text for ${path}.`,
  );
}

function snapshotsMatch(
  current: FileChangeSnapshot | null,
  expected: FileChangeSnapshot | null | undefined,
): boolean {
  if (expected === null || expected?.unavailableReason === "missing") {
    return current === null || current?.unavailableReason === "missing";
  }
  if (!expected) return false;
  if (typeof expected.sha256 === "string") {
    return current?.sha256 === expected.sha256;
  }
  if (typeof expected.text === "string") {
    return current?.text === expected.text;
  }
  return false;
}

function normalizeRestoreDirection(direction: unknown): "before" | "after" {
  if (direction === undefined || direction === "before") return "before";
  if (direction === "after") return "after";
  throw new VersionedFileWorkspaceError(
    "invalid-restore-direction",
    "Restore direction is invalid.",
  );
}

async function readCurrentWorkspaceSnapshot(
  rootDir: string,
  path: string,
  absolute: string,
): Promise<FileChangeSnapshot | null> {
  const opened = await openWorkspaceFileForReadIfPresent(rootDir, path, absolute);
  if (!opened) return null;
  try {
    return await snapshotForOpenFile(opened.handle, opened.info);
  } finally {
    await opened.handle.close();
  }
}

async function assertLivePreimageStillMatches(input: {
  rootDir: string;
  path: string;
  absolute: string;
  expected: FileChangeSnapshot | null;
  operation: string;
}): Promise<void> {
  const current = await readCurrentWorkspaceSnapshot(input.rootDir, input.path, input.absolute);
  if (!snapshotsMatch(current, input.expected)) {
    throw new VersionedFileWorkspaceError(
      "stale-live-file",
      `Live file ${input.path} changed before ${input.operation}.`,
    );
  }
}

export function createVersionedFileWorkspace({
  rootDir,
  workspaceId,
  author = LOCAL_FILE_AUTHOR,
  nowMs,
  createId,
}: VersionedFileWorkspaceOptions): VersionedFileWorkspace {
  const { unsafeInternals: _unsafeInternals, ...workspace } = createVersionedFileWorkspaceWithHooks(
    { rootDir, workspaceId, author, nowMs, createId },
    {},
  );
  return workspace;
}

function createVersionedFileWorkspaceWithHooks(
  {
    rootDir: inputRootDir,
    workspaceId: inputWorkspaceId,
    author = LOCAL_FILE_AUTHOR,
    nowMs,
    createId,
  }: VersionedFileWorkspaceOptions,
  testHooks: VersionedFileWorkspaceTestHooks = {},
): TestableVersionedFileWorkspace {
  assertSupportedVersionedFileWorkspacePlatform();
  const workspaceId = normalizeWorkspaceId(inputWorkspaceId);
  const canonicalRoot = canonicalWorkspaceRoot(inputRootDir);
  const rootDir = canonicalRoot.rootDir;
  const rootIdentity = canonicalRoot.identity;
  let changeAuthor: ChangeAuthor | undefined;
  const configuredChangeAuthor = (): ChangeAuthor => {
    changeAuthor ??= parseChangeAuthor(author);
    return changeAuthor;
  };
  const versionIdFactory = createId as VersionedTextStoreOptions["createId"] | undefined;
  const versions = createVersionedTextStore(rootDir, {
    ...(nowMs ? { nowMs } : {}),
    ...(versionIdFactory ? { createId: versionIdFactory } : {}),
  });
  const history = createChangeSetStore(rootDir, {
    namespace: workspaceHistoryNamespace(workspaceId),
  });
  const nextHistoryId = () => `history_${createId?.("moment") ?? randomUUID()}`;
  const nextVersionMomentId = () => createId?.("moment") ?? `moment_${randomUUID()}`;
  let lastRecordedAtMs = 0;
  const nextRecordedAtMs = async () => {
    const persistedMax = await history.maxRecordedAtMs();
    const wallClockMs = nowMs?.() ?? Date.now();
    const recordedAtMs = Math.max(wallClockMs, persistedMax + 1, lastRecordedAtMs + 1);
    lastRecordedAtMs = recordedAtMs;
    return recordedAtMs;
  };

  async function activeVersion(
    versionId: VersionId | undefined,
    fence: MutationFence,
  ): Promise<VersionId> {
    if (versionId) return versionId;
    await fence.assertStillOwnsLock();
    const version = await versions.ensureMainVersion({ workspaceId });
    await fence.assertStillOwnsLock();
    return version.id;
  }

  async function recoverPendingMutationsForWorkspace(fence?: MutationFence): Promise<void> {
    await assertRootStillPinned();
    await assertMutationFence(fence);
    await recoverPendingFileMutations({ rootDir, workspaceId, versions, history, fence });
    await assertMutationFence(fence);
  }

  async function assertRootStillPinned(): Promise<void> {
    await assertDirectoryIdentity(rootDir, rootIdentity, ".");
  }

  async function readWithWorkspaceLock<T>(task: () => Promise<T>): Promise<T> {
    await assertRootStillPinned();
    return serializeWorkspaceMutation(rootDir, async (lease) => {
      await assertRootStillPinned();
      await lease.assertStillOwnsLock();
      if (await pendingMutationStateExists(rootDir)) {
        await recoverPendingMutationsForWorkspace(lease);
      }
      await lease.assertStillOwnsLock();
      const result = await task();
      await lease.assertStillOwnsLock();
      await assertRootStillPinned();
      return result;
    }, undefined, testHooks.onWorkspaceMutationQueued, testHooks.onFileMutationLockWait);
  }

  async function rollbackPendingMutation(
    journal: PendingFileMutationJournal,
    options: { skipHistoryCheck?: boolean } = {},
    fence?: MutationFence,
  ): Promise<void> {
    await rollbackPendingFileMutation({
      rootDir,
      versions,
      history,
      journal,
      fence,
      ...options,
    });
  }

  async function rollbackShouldSkipHistoryCheck(
    journal: PendingFileMutationJournal,
  ): Promise<boolean> {
    return !(await pendingHistoryRecordMatchesJournal(history, journal));
  }

  async function writeTextFileUnlocked(
    input: {
      path: string;
      text: string;
      versionId?: VersionId;
      metadata?: ActorNeutralWriteMetadata;
      summary?: string;
      provenance?: ChangeProvenance;
    },
    path: string,
    fence: MutationFence,
    preimage?: DiskPreimageCapture,
  ): Promise<VersionedFileWriteResult> {
    const authorForChange = configuredChangeAuthor();
    await recoverPendingMutationsForWorkspace(fence);
    assertWritableTextSize(path, input.text);
    const absolute = await resolveContainedWorkspacePath(rootDir, path);
    const tmpDir = await ensureInternalTempDir(rootDir);
    await assertResolvedWorkspacePath(rootDir, path, absolute);
    await fence.assertStillOwnsLock();
    const capture = preimage ?? (await createDiskPreimageBackup(rootDir, path, absolute, tmpDir));
    const before = capture.snapshot;
    const backup = capture.backup;
    const metadata = input.metadata ?? { origin: "local-file" as const };
    const after = snapshotForText(input.text);
    const historyId = nextHistoryId();
    const changeSet = createTextFileChangeSet({
      author: authorForChange,
      summary: input.summary ?? defaultSummary(path, input.provenance),
      ...(input.provenance ? { provenance: input.provenance } : {}),
      path,
      operation: "write",
      before,
      after,
    });
    let versionSnapshot: TextFileSnapshot | undefined;
    let journal: PendingFileMutationJournal | undefined;
    const createdHistoryBlobPaths: string[] = [];
    try {
      await fence.assertStillOwnsLock();
      const historyRecordedAtMs = await nextRecordedAtMs();
      await fence.assertStillOwnsLock();
      const versionId = await activeVersion(input.versionId, fence);
      journal = await createPendingMutationJournal({
        rootDir,
        workspaceId,
        versionId,
        path,
        operation: "write",
        before,
        after,
        diskBackup: backup,
        historyId,
        historyRecordedAtMs,
        expectedChangeSet: changeSet,
        createdAtMs: historyRecordedAtMs,
        fence,
      });
      await fence.assertStillOwnsLock();
      const beforeBlobPath = await persistHistoryBlobFromBackup(
        rootDir,
        workspaceId,
        before,
        backup.backupPath,
      );
      journal = await rememberCreatedHistoryBlobPath(
        rootDir,
        journal,
        createdHistoryBlobPaths,
        beforeBlobPath,
        fence,
      );
      await fence.assertStillOwnsLock();
      const afterBlobPath = await persistHistoryBlobText(rootDir, workspaceId, after, input.text);
      journal = await rememberCreatedHistoryBlobPath(
        rootDir,
        journal,
        createdHistoryBlobPaths,
        afterBlobPath,
        fence,
      );
      journal = await updatePendingMutationJournal(rootDir, journal, {
        phase: "disk-mutating",
      }, fence);
      await fence.assertStillOwnsLock();
      await writeFileAtomicAfterPreservingPreimage({
        rootDir,
        workspacePath: path,
        path: absolute,
        data: input.text,
        tmpDir,
        expected: before,
        operation: "writing",
      });
      journal = await updatePendingMutationJournal(rootDir, journal, {
        phase: "disk-mutated",
      }, fence);
      const versionMutationMomentId = nextVersionMomentId();
      journal = await updatePendingMutationJournal(rootDir, journal, {
        phase: "version-recording",
        versionMutationMomentId,
      }, fence);
      await fence.assertStillOwnsLock();
      const versionWrite = await versions.writeTextFile({
        workspaceId,
        versionId,
        path,
        text: input.text,
        metadata,
        momentId: versionMutationMomentId,
      });
      journal = await updatePendingMutationJournal(rootDir, journal, {
        phase: "version-recorded",
      }, fence);
      versionSnapshot = versionWrite.snapshot;
      await testHooks.afterFileWriteBeforeHistory?.(path);
      await fence.assertStillOwnsLock();
      const historyRecord = await recordHistoryOrRecoverCommitted({
        history,
        changeSet,
        id: historyId,
        recordedAtMs: historyRecordedAtMs,
        path,
        fence,
      });
      await cleanupCommittedPendingMutation(rootDir, journal, fence);
      return {
        path,
        versionId,
        snapshot: versionSnapshot,
        history: historyRecord,
      };
    } catch (error) {
      let rollbackError: unknown;
      try {
        if (journal) {
          const skipHistoryCheck = await rollbackShouldSkipHistoryCheck(journal);
          await rollbackPendingMutation(journal, {
            skipHistoryCheck,
          }, fence);
          if (skipHistoryCheck) {
            await discardUnreferencedHistoryBlobs(rootDir, workspaceId, createdHistoryBlobPaths);
          }
        } else {
          await discardDiskPreimageBackup(rootDir, backup, fence);
          await discardUnreferencedHistoryBlobs(rootDir, workspaceId, createdHistoryBlobPaths);
        }
      } catch (pendingRollbackError) {
        rollbackError = pendingRollbackError;
      }
      if (rollbackError) attachRollbackError(error, rollbackError);
      throw error;
    }
  }

  async function writeTextFile(input: {
    path: string;
    text: string;
    versionId?: VersionId;
    metadata?: ActorNeutralWriteMetadata;
    summary?: string;
    provenance?: ChangeProvenance;
  }): Promise<VersionedFileWriteResult> {
    const path = normalizeWorkspacePath(input.path);
    assertTextWorkspacePath(path);
    assertWritableTextSize(path, input.text);
    await assertRootStillPinned();
    return serializePathMutation(rootDir, path, (fence) =>
      writeTextFileUnlocked(input, path, fence),
      testHooks.afterFileMutationLockAcquired,
      testHooks.onWorkspaceMutationQueued,
      testHooks.onFileMutationLockWait,
    );
  }

  async function deleteTextFileUnlocked(
    input: {
      path: string;
      versionId?: VersionId;
      metadata?: ActorNeutralWriteMetadata;
      summary?: string;
      provenance?: ChangeProvenance;
    },
    path: string,
    fence: MutationFence,
    preimage?: DiskPreimageCapture,
  ): Promise<VersionedFileDeleteResult> {
    const authorForChange = configuredChangeAuthor();
    await recoverPendingMutationsForWorkspace(fence);
    const absolute = await resolveContainedWorkspacePath(rootDir, path);
    const tmpDir = await ensureInternalTempDir(rootDir);
    await assertResolvedWorkspacePath(rootDir, path, absolute);
    await fence.assertStillOwnsLock();
    const capture = preimage ?? (await createDiskPreimageBackup(rootDir, path, absolute, tmpDir));
    const before = capture.snapshot;
    if (before === null || before.unavailableReason === "missing") {
      throw new VersionedFileWorkspaceError("file-not-found", `File ${path} was not found.`);
    }
    const backup = capture.backup;
    const metadata = input.metadata ?? { origin: "local-file" as const };
    const after: FileChangeSnapshot | null = null;
    const historyId = nextHistoryId();
    const changeSet = createTextFileChangeSet({
      author: authorForChange,
      summary: input.summary ?? defaultDeleteSummary(path, input.provenance),
      ...(input.provenance ? { provenance: input.provenance } : {}),
      path,
      operation: "delete",
      before,
      after,
    });
    let deletedSnapshot: TextFileSnapshot | null | undefined;
    let journal: PendingFileMutationJournal | undefined;
    const createdHistoryBlobPaths: string[] = [];
    try {
      await fence.assertStillOwnsLock();
      const historyRecordedAtMs = await nextRecordedAtMs();
      await fence.assertStillOwnsLock();
      const versionId = await activeVersion(input.versionId, fence);
      await fence.assertStillOwnsLock();
      journal = await createPendingMutationJournal({
        rootDir,
        workspaceId,
        versionId,
        path,
        operation: "delete",
        before,
        after,
        diskBackup: backup,
        historyId,
        historyRecordedAtMs,
        expectedChangeSet: changeSet,
        createdAtMs: historyRecordedAtMs,
        fence,
      });
      await fence.assertStillOwnsLock();
      const beforeBlobPath = await persistHistoryBlobFromBackup(
        rootDir,
        workspaceId,
        before,
        backup.backupPath,
      );
      journal = await rememberCreatedHistoryBlobPath(
        rootDir,
        journal,
        createdHistoryBlobPaths,
        beforeBlobPath,
        fence,
      );
      await fence.assertStillOwnsLock();
      const versionBefore = await versions.readTextFile({ workspaceId, versionId, path });
      journal = await updatePendingMutationJournal(rootDir, journal, {
        phase: "disk-mutating",
      }, fence);
      await fence.assertStillOwnsLock();
      await removeFileAfterPreservingPreimage({
        rootDir,
        workspacePath: path,
        path: absolute,
        tmpDir,
        expected: before,
        operation: "deleting",
      });
      journal = await updatePendingMutationJournal(rootDir, journal, {
        phase: "disk-mutated",
      }, fence);
      if (versionBefore) {
        const versionMutationMomentId = nextVersionMomentId();
        journal = await updatePendingMutationJournal(rootDir, journal, {
          phase: "version-recording",
          versionMutationMomentId,
        }, fence);
        await fence.assertStillOwnsLock();
        const versionDelete = await versions.deleteTextFile({
          workspaceId,
          versionId,
          path,
          metadata,
          momentId: versionMutationMomentId,
        });
        journal = await updatePendingMutationJournal(rootDir, journal, {
          phase: "version-recorded",
        }, fence);
        deletedSnapshot = versionDelete.before;
      } else {
        deletedSnapshot = null;
        journal = await updatePendingMutationJournal(rootDir, journal, {
          phase: "version-recorded",
        }, fence);
      }
      await fence.assertStillOwnsLock();
      const historyRecord = await recordHistoryOrRecoverCommitted({
        history,
        changeSet,
        id: historyId,
        recordedAtMs: historyRecordedAtMs,
        path,
        fence,
      });
      await cleanupCommittedPendingMutation(rootDir, journal, fence);
      return {
        path,
        versionId,
        deleted: deletedSnapshot,
        history: historyRecord,
      };
    } catch (error) {
      let rollbackError: unknown;
      try {
        if (journal) {
          const skipHistoryCheck = await rollbackShouldSkipHistoryCheck(journal);
          await rollbackPendingMutation(journal, {
            skipHistoryCheck,
          }, fence);
          if (skipHistoryCheck) {
            await discardUnreferencedHistoryBlobs(rootDir, workspaceId, createdHistoryBlobPaths);
          }
        } else {
          await discardDiskPreimageBackup(rootDir, backup, fence);
          await discardUnreferencedHistoryBlobs(rootDir, workspaceId, createdHistoryBlobPaths);
        }
      } catch (pendingRollbackError) {
        rollbackError = pendingRollbackError;
      }
      if (rollbackError) attachRollbackError(error, rollbackError);
      throw error;
    }
  }

  async function deleteTextFile(input: {
    path: string;
    versionId?: VersionId;
    metadata?: ActorNeutralWriteMetadata;
    summary?: string;
    provenance?: ChangeProvenance;
  }): Promise<VersionedFileDeleteResult> {
    const path = normalizeWorkspacePath(input.path);
    assertTextWorkspacePath(path);
    await assertRootStillPinned();
    return serializePathMutation(rootDir, path, (fence) =>
      deleteTextFileUnlocked(input, path, fence),
      testHooks.afterFileMutationLockAcquired,
      testHooks.onWorkspaceMutationQueued,
      testHooks.onFileMutationLockWait,
    );
  }

  return {
    history: createHistoryReader(history, readWithWorkspaceLock),
    versions: createVersionReader(versions, workspaceId, readWithWorkspaceLock),
    unsafeInternals: { history, rootDir, versions },

    async ensureMainVersion() {
      await assertRootStillPinned();
      return serializeWorkspaceMutation(
        rootDir,
        async (fence) => {
          await recoverPendingMutationsForWorkspace(fence);
          await fence.assertStillOwnsLock();
          const version = await versions.ensureMainVersion({ workspaceId });
          await fence.assertStillOwnsLock();
          return version;
        },
        testHooks.afterFileMutationLockAcquired,
        testHooks.onWorkspaceMutationQueued,
        testHooks.onFileMutationLockWait,
      );
    },

    async createNamedVersion(input) {
      await assertRootStillPinned();
      return serializeWorkspaceMutation(
        rootDir,
        async (fence) => {
          await recoverPendingMutationsForWorkspace(fence);
          await fence.assertStillOwnsLock();
          const version = await versions.createNamedVersion({
            workspaceId,
            name: input.name,
            fromVersionId: input.fromVersionId,
          });
          await fence.assertStillOwnsLock();
          return version;
        },
        testHooks.afterFileMutationLockAcquired,
        testHooks.onWorkspaceMutationQueued,
        testHooks.onFileMutationLockWait,
      );
    },

    writeTextFile,
    deleteTextFile,

    readTextFile(input) {
      return readWithWorkspaceLock(async () => {
        const path = normalizeWorkspacePath(input.path);
        assertTextWorkspacePath(path);
        const absolute = await resolveContainedWorkspacePath(rootDir, path);
        try {
          const opened = await openWorkspaceFileForRead(rootDir, path, absolute);
          if (!opened) return null;
          try {
            if (Number(opened.info.size) > MAX_READ_TEXT_FILE_BYTES) {
              throw new VersionedFileWorkspaceError(
                "file-too-large",
                `File ${path} is too large to read as text.`,
              );
            }
            const { bytes, truncated } = await readOpenFileBytesUpTo(
              opened.handle,
              MAX_READ_TEXT_FILE_BYTES,
            );
            if (truncated) {
              throw new VersionedFileWorkspaceError(
                "file-too-large",
                `File ${path} is too large to read as text.`,
              );
            }
            try {
              return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
            } catch {
              throw new VersionedFileWorkspaceError(
                "not-text",
                `File ${path} is not valid UTF-8 text.`,
              );
            }
          } finally {
            await opened.handle.close();
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      });
    },

    listTextFiles() {
      return readWithWorkspaceLock(async () => {
        return listWorkspaceTextFileStats(rootDir);
      });
    },

    statTextFile(input) {
      return readWithWorkspaceLock(async () => {
        const path = normalizeWorkspacePath(input.path);
        assertTextWorkspacePath(path);
        const absolute = await resolveContainedWorkspacePath(rootDir, path);
        try {
          const opened = await openWorkspaceFileForRead(rootDir, path, absolute);
          if (!opened) return null;
          const mediaType = mediaTypeForPath(path);
          try {
            const sizeBytes = Number(opened.info.size);
            if (sizeBytes > MAX_READ_TEXT_FILE_BYTES) {
              throw new VersionedFileWorkspaceError(
                "file-too-large",
                `File ${path} is too large to stat as text.`,
              );
            }
            await assertOpenFileContainsUtf8Text(opened.handle, path);
            return {
              path,
              mediaType,
              sizeBytes,
              sha256: await sha256OpenFile(opened.handle),
            };
          } finally {
            await opened.handle.close();
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      });
    },

    async restoreTextFile(input) {
      const direction = normalizeRestoreDirection(input.direction);
      const path = normalizeWorkspacePath(input.path);
      assertTextWorkspacePath(path);
      await assertRootStillPinned();
      return serializePathMutation(
        rootDir,
        path,
        async (fence) => {
          await recoverPendingMutationsForWorkspace(fence);
          const absolute = await resolveContainedWorkspacePath(rootDir, path);
          const record = await history.get(input.changeSetId);
          if (!record) {
            throw new VersionedFileWorkspaceError(
              "restore-file-not-found",
              `History record ${input.changeSetId} does not contain ${path}.`,
            );
          }
          const file = record.files.find((candidate) => candidate.path === path);
          if (!file) {
            throw new VersionedFileWorkspaceError(
              "restore-file-not-found",
              `History record ${input.changeSetId} does not contain ${path}.`,
            );
          }
          const expectedLive = direction === "before" ? file.after : file.before;
          const tmpDir = await ensureInternalTempDir(rootDir);
          await fence.assertStillOwnsLock();
          const preimage = await createDiskPreimageBackup(rootDir, path, absolute, tmpDir);
          let preimageConsumed = false;
          try {
            if (!snapshotsMatch(preimage.snapshot, expectedLive)) {
              throw new VersionedFileWorkspaceError(
                "restore-stale-live-file",
                `Live file ${path} no longer matches history record ${input.changeSetId}.`,
              );
            }
            const target = file[direction];
            const provenance: ChangeProvenance = {
              source: "history-restore",
              restoreOfChangeSetId: input.changeSetId,
              restoreOfPath: path,
              restoreDirection:
                direction === "after"
                  ? "redo"
                  : record.provenance?.source === "history-restore"
                    ? "undo"
                    : "restore",
            };
            const summary = defaultSummary(path, provenance);
            const restored = await (async () => {
              if (target === null || target?.unavailableReason === "missing") {
                const deleted = await deleteTextFileUnlocked(
                  {
                    path,
                    versionId: input.versionId,
                    metadata: { origin: "restore", summary: `restore ${path}` },
                    summary,
                    provenance,
                  },
                  path,
                  fence,
                  preimage,
                );
                preimageConsumed = true;
                return deleted;
              }
              const text = await restorableTextSnapshot(
                rootDir,
                workspaceId,
                target,
                input.changeSetId,
                path,
              );
              const written = await writeTextFileUnlocked(
                {
                  path,
                  text,
                  versionId: input.versionId,
                  metadata: { origin: "restore", summary: `restore ${path}` },
                  summary,
                  provenance,
                },
                path,
                fence,
                preimage,
              );
              preimageConsumed = true;
              return written;
            })();
            return {
              ...restored,
              restoredFrom: {
                changeSetId: input.changeSetId,
                path,
                direction,
              },
            };
          } finally {
            if (!preimageConsumed) {
              await discardDiskPreimageBackupBestEffort(rootDir, preimage.backup, fence);
            }
          }
        },
        testHooks.afterFileMutationLockAcquired,
        testHooks.onWorkspaceMutationQueued,
        testHooks.onFileMutationLockWait,
      );
    },
  };
}

export function createTestableVersionedFileWorkspace(
  options: VersionedFileWorkspaceOptions,
  testHooks: VersionedFileWorkspaceTestHooks = {},
): TestableVersionedFileWorkspace {
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    throw new VersionedFileWorkspaceError(
      "recovery-failed",
      "Versioned file workspace test hooks are only available during tests.",
    );
  }
  return createVersionedFileWorkspaceWithHooks(options, testHooks);
}
