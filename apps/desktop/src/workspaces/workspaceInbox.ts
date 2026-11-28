import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import {
  setCollectionRecordFields,
  type CollectionRecordEditAdapter,
} from "@dohc/automation-executor/collection-record-edits";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import {
  parseCollectionRecordFields,
  type CollectionQueryParams,
  type CollectionQueryResult,
  type CollectionRecord,
  type CollectionValue,
} from "@dohc/workspace-contracts";
import type { ChangeAuthor, MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import {
  DEFAULT_INBOX_LIST_LIMIT,
  defaultInboxCaptureTitle,
  formatInboxRecordMarkdown,
  INBOX_COLLECTION_PATH,
  INBOX_COLLECTION_YAML,
  INBOX_FILES_DIR,
  INBOX_KINDS,
  INBOX_SCHEMA_PATH,
  INBOX_SOURCES,
  INBOX_STATUSES,
  isInboxAttachmentPath,
  isInboxRecordPath,
  MAX_INBOX_IMAGE_BYTES,
  MAX_INBOX_LIST_LIMIT,
  MAX_INBOX_MOVE_ATTACHMENTS,
  MAX_INBOX_PATH_CHARS,
  safeInboxSlug,
  sanitizeInboxSingleLine,
  validateInboxUrl,
  type InboxAddInput,
  type InboxAddResult,
  type InboxArchiveInput,
  type InboxArchiveResult,
  type InboxCapturedItem,
  type InboxCaptureFilesInput,
  type InboxCaptureFilesResult,
  type InboxItemSummary,
  type InboxKind,
  type InboxListInput,
  type InboxListResult,
  type InboxMoveInput,
  type InboxMoveResult,
  type InboxPastedImage,
  type InboxPastedImageMimeType,
  type InboxSkippedFile,
  type InboxSource,
  type InboxStatus,
  type InboxUndoArchiveInput,
  type InboxUndoArchiveResult,
  type InboxUndoMoveInput,
  type InboxUndoMoveResult,
} from "@dohc/workspace-contracts/inbox";
import {
  createLocalChangeAuthor,
  isSharedWithMePath,
  validateUserMaterializePath,
  type FsEntryIdentity,
} from "@dohc/workspace-core";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { desktopRecordEditContext, type LocalPersonAuthor } from "./desktopRecordEdits";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";
import {
  AuthoredTextChangedError,
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  requirePublishedWrite,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import {
  openDroppedFile,
  screenDroppedPaths,
  screenPickedPaths,
  type DroppedFolderCheck,
  type DroppedSource,
} from "./workspaceFiles";
import {
  extractInboxAttachmentLinks,
  rewriteInboxMovedNoteMarkdown,
  rewriteInboxRestoredNoteMarkdown,
} from "./workspaceInboxLinks";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const MAX_FALLBACK_SCAN_FILES = 250;
const MAX_FRONTMATTER_HEAD_BYTES = 16 * 1024;
const MAX_INBOX_NOTE_READ_BYTES = 2 * 1024 * 1024;
const SOURCE_READ_CHUNK_BYTES = 64 * 1024;
const INBOX_RECONCILE_TIMEOUT_MS = 5_000;
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
  ".svg",
]);
const MIME_TO_EXTENSION: Record<InboxPastedImageMimeType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export interface InboxWorkspaceLike {
  workspaceId: string;
  rootPath: string;
  readOnly?: boolean;
  shareView?: unknown;
}

export interface InboxOperationLike {
  workspace: InboxWorkspaceLike;
  signal: AbortSignal;
  assertCurrent(): void;
}

export type InboxEngineAdapter = CollectionRecordEditAdapter &
  Pick<VersionedLiveAdapter, "queryCollectionRecords">;

export interface WorkspaceInboxHost {
  capture: Pick<WorkspaceEngineCapture, "writeAuthoredFile" | "openRecordSession">;
  withAdapter<T>(work: (adapter: InboxEngineAdapter) => Promise<T>): Promise<T | null>;
  onCaptureSettled(listener: (paths: readonly string[] | null) => void): () => void;
  moveFile(input: {
    fromPath: string;
    toPath: string;
    author: MomentWriteAuthor;
  }): Promise<{ fromPath: string; toPath: string; operationId?: string }>;
  undoOperation?(operationId: string, author: MomentWriteAuthor): Promise<void>;
  personDisplayName?(): string;
  registeredRoots?(): readonly string[];
  onChanged?(paths?: readonly string[]): void;
}

class SourceTooLargeError extends Error {
  constructor(name: string, actualBytes: number | bigint, limitBytes: number) {
    super(
      `Skipped ${name}: ${actualBytes.toString()} bytes exceeds the ${limitBytes}-byte workspace size limit.`,
    );
    this.name = "SourceTooLargeError";
  }
}

export function mintInboxRecordId(): string {
  const bytes = randomBytes(16);
  let id = "rec_";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      id += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) id += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return id;
}

function assertWritableInboxWorkspace(operation: InboxOperationLike): void {
  operation.assertCurrent();
  if (operation.workspace.readOnly || operation.workspace.shareView !== undefined) {
    throw new Error("Inbox requires the owning writable workspace. Open it to continue.");
  }
}

function hasSecretPathSegment(rawOrResolvedPath: string): boolean {
  const normalized = rawOrResolvedPath.replaceAll("\\", "/");
  const segments = normalized
    .split("/")
    .filter((segment) => segment && !/^[a-zA-Z]:$/u.test(segment));
  if (segments.length === 0) return false;
  if (classifyEngineFilePath(segments.join("/")).kind === "secret") return true;
  for (const segment of segments) {
    if (classifyEngineFilePath(segment).kind === "secret") return true;
  }
  return false;
}

export function isInboxSecretPath(sourceRelativePath: string, destinationPath: string): boolean {
  if (hasSecretPathSegment(sourceRelativePath)) return true;
  if (hasSecretPathSegment(destinationPath)) return true;
  return false;
}

async function hasSecretRawOrResolvedPath(rawPath: string): Promise<boolean> {
  if (hasSecretPathSegment(rawPath)) return true;
  const parentReal = await realpath(dirname(rawPath)).catch(() => null);
  if (parentReal !== null && hasSecretPathSegment(parentReal)) return true;
  const info = await lstat(rawPath).catch(() => null);
  if (info && !info.isSymbolicLink()) {
    const selfReal = await realpath(rawPath).catch(() => null);
    if (selfReal !== null && hasSecretPathSegment(selfReal)) return true;
  }
  return false;
}

function sameResolvedPath(left: string, right: string): boolean {
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  if (process.platform === "darwin") return left.normalize("NFD") === right.normalize("NFD");
  return left === right;
}

function isInsideResolvedDir(containerReal: string, candidateReal: string): boolean {
  const rel = relative(containerReal, candidateReal);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    return false;
  }
  if (process.platform === "win32") {
    const normContainer = containerReal.toLowerCase();
    const normCandidate = candidateReal.toLowerCase();
    return normCandidate === normContainer || normCandidate.startsWith(`${normContainer}\\`);
  }
  return true;
}

async function assertInsideResolvedSubtree(
  rootPath: string,
  subtreeRelative: string,
  targetRelative: string,
  access: "entry" | "write",
  label: string,
): Promise<void> {
  const rootReal = await realpath(rootPath);
  const subtreeParts = subtreeRelative.split("/").filter(Boolean);
  const expectedSubtreeReal = join(rootReal, ...subtreeParts);

  let prefixAbs = rootPath;
  let expectedPrefixReal = rootReal;
  for (const part of subtreeParts) {
    prefixAbs = join(prefixAbs, part);
    expectedPrefixReal = join(expectedPrefixReal, part);
    const info = await lstat(prefixAbs).catch(() => null);
    if (!info) break;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Cannot use ${subtreeRelative}/ because ${part} is not a real folder.`);
    }
    const actualReal = await realpath(prefixAbs);
    if (!sameResolvedPath(actualReal, expectedPrefixReal)) {
      throw new Error(`${label} resolves outside ${subtreeRelative}/. Refusing to continue.`);
    }
  }

  const targetParts = targetRelative.split("/").filter(Boolean);
  let walkAbs = rootPath;
  let deepestExistingReal = rootReal;
  for (let i = 0; i < targetParts.length; i += 1) {
    walkAbs = join(walkAbs, targetParts[i]!);
    const info = await lstat(walkAbs).catch(() => null);
    if (!info) break;
    if (info.isSymbolicLink()) {
      throw new Error(`${label} cannot pass through or target a symbolic link.`);
    }
    const actualReal = await realpath(walkAbs);
    deepestExistingReal = actualReal;
    if (i >= subtreeParts.length - 1 && !isInsideResolvedDir(expectedSubtreeReal, actualReal)) {
      throw new Error(`${label} escapes ${subtreeRelative}/. Refusing to continue.`);
    }
  }

  const absolutePath = join(rootPath, ...targetParts);
  await assertResolvedWorkspacePath({
    rootPath,
    absolutePath,
    spelled: targetRelative,
    label,
    access,
  });

  if (access === "entry") {
    const entryReal = await realpath(absolutePath);
    if (!isInsideResolvedDir(expectedSubtreeReal, entryReal)) {
      throw new Error(`${label} resolves outside ${subtreeRelative}/. Refusing to continue.`);
    }
  } else if (deepestExistingReal !== rootReal) {
    if (
      !isInsideResolvedDir(expectedSubtreeReal, deepestExistingReal) &&
      !isInsideResolvedDir(deepestExistingReal, expectedSubtreeReal)
    ) {
      throw new Error(`${label} resolves outside ${subtreeRelative}/. Refusing to continue.`);
    }
  }
}

function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

async function pathExists(absolutePath: string): Promise<boolean> {
  return lstat(absolutePath).then(
    () => true,
    () => false,
  );
}

async function hasInboxSchema(rootPath: string): Promise<boolean> {
  const inboxAbs = join(rootPath, INBOX_COLLECTION_PATH);
  const inboxStat = await lstat(inboxAbs).catch(() => null);
  if (!inboxStat || !inboxStat.isDirectory() || inboxStat.isSymbolicLink()) return false;
  const schemaAbs = join(rootPath, INBOX_SCHEMA_PATH);
  const schemaStat = await lstat(schemaAbs).catch(() => null);
  if (!schemaStat || !schemaStat.isFile() || schemaStat.isSymbolicLink()) return false;
  try {
    await assertInsideResolvedSubtree(
      rootPath,
      INBOX_COLLECTION_PATH,
      INBOX_SCHEMA_PATH,
      "entry",
      "Inbox schema",
    );
    return true;
  } catch {
    return false;
  }
}

async function ensureInboxCollection(
  operation: InboxOperationLike,
  author: MomentWriteAuthor,
  host: WorkspaceInboxHost,
): Promise<boolean> {
  assertWritableInboxWorkspace(operation);
  const rootPath = operation.workspace.rootPath;
  const inboxAbs = join(rootPath, INBOX_COLLECTION_PATH);
  const inboxStat = await lstat(inboxAbs).catch(() => null);
  if (inboxStat) {
    if (inboxStat.isSymbolicLink() || !inboxStat.isDirectory()) {
      throw new Error(
        `Cannot use ${INBOX_COLLECTION_PATH}/ because a file or link already exists at ${INBOX_COLLECTION_PATH}.`,
      );
    }
  }
  await assertInsideResolvedSubtree(
    rootPath,
    INBOX_COLLECTION_PATH,
    INBOX_SCHEMA_PATH,
    "write",
    "Inbox schema",
  );
  const schemaAbs = join(rootPath, INBOX_SCHEMA_PATH);
  const existingSchema = await lstat(schemaAbs).catch(() => null);
  if (existingSchema) {
    if (existingSchema.isSymbolicLink() || !existingSchema.isFile()) {
      throw new Error(`Cannot use ${INBOX_SCHEMA_PATH} because it is not a regular file.`);
    }
    return false;
  }

  try {
    const outcome = await host.capture.writeAuthoredFile(schemaAbs, INBOX_COLLECTION_YAML, author, {
      createOnly: true,
      signal: operation.signal,
    });
    requirePublishedWrite(INBOX_SCHEMA_PATH, outcome);
    return true;
  } catch (error) {
    const existsNow = await hasInboxSchema(rootPath);
    if (existsNow) return false;
    throw error;
  }
}

async function allocateUniqueWorkspacePath(
  rootPath: string,
  dirRelative: string,
  baseName: string,
  ext: string,
  reserved?: Set<string>,
): Promise<string> {
  const safeExt = ext.replace(/[^a-zA-Z0-9._-]/gu, "");
  const maxAttempts = 200;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const candidateName = `${baseName}${suffix}${safeExt}`;
    const relativePath = dirRelative ? `${dirRelative}/${candidateName}` : candidateName;
    const checked = validateUserMaterializePath(relativePath, { platform: "win32" });
    if (!checked.ok) {
      throw new Error(`Invalid Inbox file path (${checked.reason}): ${relativePath}`);
    }
    const reservedKey = checked.normalized.toLowerCase();
    if (reserved?.has(reservedKey)) continue;
    const absolutePath = join(rootPath, checked.normalized);
    if (!(await pathExists(absolutePath))) {
      if (dirRelative === INBOX_COLLECTION_PATH || dirRelative === INBOX_FILES_DIR) {
        await assertInsideResolvedSubtree(
          rootPath,
          dirRelative,
          checked.normalized,
          "write",
          "Inbox path",
        );
      } else {
        await assertResolvedWorkspacePath({
          rootPath,
          absolutePath,
          spelled: checked.normalized,
          label: "Target path",
          access: "write",
        });
      }
      reserved?.add(reservedKey);
      return checked.normalized;
    }
  }
  const folderLabel = dirRelative || "the target folder";
  throw new Error(
    `Could not pick a free file name in ${folderLabel} after ${maxAttempts} attempts (limit ${maxAttempts} collisions). Rename or remove colliding files and try again.`,
  );
}

function asString(value: CollectionValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function asStatus(value: string | null): InboxStatus | null {
  return value !== null && (INBOX_STATUSES as readonly string[]).includes(value)
    ? (value as InboxStatus)
    : null;
}

function asSource(value: string | null): InboxSource | null {
  return value !== null && (INBOX_SOURCES as readonly string[]).includes(value)
    ? (value as InboxSource)
    : null;
}

function asKind(value: string | null): InboxKind | null {
  return value !== null && (INBOX_KINDS as readonly string[]).includes(value)
    ? (value as InboxKind)
    : null;
}

function recordToInboxSummary(record: CollectionRecord): InboxItemSummary {
  const values = new Map(record.values.map((entry) => [entry.field, entry.value]));
  const title = asString(values.get("Title")) ?? basename(record.path, extname(record.path));
  return {
    id: record.id,
    path: record.path,
    title,
    status: asStatus(asString(values.get("Status"))),
    source: asSource(asString(values.get("Source"))),
    kind: asKind(asString(values.get("Kind"))),
    received: asString(values.get("Received")),
    url: asString(values.get("URL")),
    attachment: asString(values.get("Attachment")),
    filedTo: asString(values.get("Filed to")),
  };
}

async function readBoundedRegularFile(
  absolutePath: string,
  maxBytes: number,
  allowTruncation = false,
): Promise<Buffer> {
  const handle = await open(
    absolutePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) {
      throw new Error(`Expected regular file at ${basename(absolutePath)}.`);
    }
    if (!allowTruncation && info.size > BigInt(maxBytes)) {
      throw new SourceTooLargeError(basename(absolutePath), info.size, maxBytes);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const chunkBuf = Buffer.allocUnsafe(Math.min(SOURCE_READ_CHUNK_BYTES, maxBytes + 1));
    while (true) {
      const remaining = allowTruncation ? maxBytes - total : maxBytes + 1 - total;
      if (remaining <= 0) break;
      const toRead = Math.min(chunkBuf.length, remaining);
      const { bytesRead } = await handle.read(chunkBuf, 0, toRead, null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(chunkBuf.subarray(0, bytesRead)));
      total += bytesRead;
      if (!allowTruncation && total > maxBytes) {
        const latest = await handle.stat({ bigint: true }).catch(() => info);
        const reportedBytes = latest.size > BigInt(total) ? latest.size : BigInt(total);
        throw new SourceTooLargeError(basename(absolutePath), reportedBytes, maxBytes);
      }
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readFrontmatterMap(absolutePath: string): Promise<Map<string, CollectionValue>> {
  const head = (
    await readBoundedRegularFile(absolutePath, MAX_FRONTMATTER_HEAD_BYTES, true)
  ).toString("utf8");
  const parsed = parseCollectionRecordFields(head);
  return new Map(Object.entries(parsed ?? {}) as Array<[string, CollectionValue]>);
}

async function scanInboxRecordsFromDisk(
  rootPath: string,
  statusFilter: InboxStatus | undefined,
): Promise<InboxItemSummary[]> {
  try {
    await assertInsideResolvedSubtree(
      rootPath,
      INBOX_COLLECTION_PATH,
      INBOX_SCHEMA_PATH,
      "entry",
      "Inbox folder",
    );
  } catch {
    return [];
  }
  const inboxAbs = join(rootPath, INBOX_COLLECTION_PATH);
  const entries = await readdir(inboxAbs, { withFileTypes: true }).catch(() => []);
  const markdownNames = entries
    .filter((entry) => !entry.isSymbolicLink() && entry.isFile() && /\.md$/iu.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(0, MAX_FALLBACK_SCAN_FILES);

  const items: InboxItemSummary[] = [];
  for (const name of markdownNames) {
    const relativePath = `${INBOX_COLLECTION_PATH}/${name}`;
    const absolutePath = join(inboxAbs, name);
    try {
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      await assertInsideResolvedSubtree(
        rootPath,
        INBOX_COLLECTION_PATH,
        relativePath,
        "entry",
        "Inbox record",
      );
      const fields = await readFrontmatterMap(absolutePath);
      const status = asStatus(asString(fields.get("Status")));
      if (statusFilter !== undefined && status !== statusFilter) continue;
      const id = asString(fields.get("id")) ?? relativePath;
      const title = asString(fields.get("Title")) ?? basename(name, extname(name));
      items.push({
        id,
        path: relativePath,
        title,
        status,
        source: asSource(asString(fields.get("Source"))),
        kind: asKind(asString(fields.get("Kind"))),
        received: asString(fields.get("Received")),
        url: asString(fields.get("URL")),
        attachment: asString(fields.get("Attachment")),
        filedTo: asString(fields.get("Filed to")),
      });
    } catch {
      // Unreadable or invalid record skipped in listing.
    }
  }
  items.sort((left, right) => {
    const byDate = (right.received ?? "").localeCompare(left.received ?? "");
    return byDate !== 0 ? byDate : right.path.localeCompare(left.path);
  });
  return items;
}

export async function listInboxItems(
  workspace: InboxWorkspaceLike,
  input: InboxListInput,
  host: Pick<WorkspaceInboxHost, "withAdapter">,
): Promise<InboxListResult> {
  if (workspace.readOnly || workspace.shareView !== undefined) {
    throw new Error("Inbox requires the owning writable workspace. Open it to continue.");
  }
  if (!(await hasInboxSchema(workspace.rootPath))) {
    return { exists: false, items: [], hasMore: false };
  }
  const limit = Math.min(input.limit ?? DEFAULT_INBOX_LIST_LIMIT, MAX_INBOX_LIST_LIMIT);

  let indexed: CollectionQueryResult | null = null;
  try {
    const query: CollectionQueryParams = {
      collectionPath: INBOX_COLLECTION_PATH,
      sort: [{ field: "Received", direction: "desc" }],
      limit: limit + 1,
    };
    if (input.status) {
      query.filter = { field: "Status", operator: "equals", value: input.status };
    }
    indexed = await host.withAdapter((adapter) => adapter.queryCollectionRecords(query));
  } catch {
    indexed = null;
  }

  if (indexed !== null) {
    const indexedItems = indexed.records.map(recordToInboxSummary);
    const hasMore = indexed.nextCursor !== null || indexedItems.length > limit;
    return {
      exists: true,
      items: indexedItems.slice(0, limit),
      hasMore,
    };
  }

  const diskItems = await scanInboxRecordsFromDisk(workspace.rootPath, input.status);
  return {
    exists: true,
    items: diskItems.slice(0, limit),
    hasMore: diskItems.length > limit,
  };
}

const defaultTitleForCapture = defaultInboxCaptureTitle;

async function waitForInboxIndexed(
  operation: InboxOperationLike,
  host: WorkspaceInboxHost,
  recordIds: readonly string[],
): Promise<void> {
  const probe = async (): Promise<"ready" | "unavailable" | "pending"> => {
    try {
      const result = await host.withAdapter(async (adapter) => {
        await adapter.queryCollectionRecords({ collectionPath: INBOX_COLLECTION_PATH, limit: 1 });
        for (const recordId of recordIds) {
          await adapter.getCollectionRecord({
            collectionPath: INBOX_COLLECTION_PATH,
            recordId,
            historyLimit: 0,
          });
        }
        return true;
      });
      return result === null ? "unavailable" : "ready";
    } catch {
      return "pending";
    }
  };

  if ((await probe()) !== "pending") return;

  await new Promise<void>((resolve) => {
    let done = false;
    let checking = false;
    let rerun = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      operation.signal.removeEventListener("abort", finish);
      unsubscribe();
      resolve();
    };
    const check = () => {
      if (done) return;
      if (checking) {
        rerun = true;
        return;
      }
      checking = true;
      void probe()
        .then((status) => {
          checking = false;
          if (status !== "pending") {
            finish();
          } else if (rerun && !done) {
            rerun = false;
            check();
          }
        })
        .catch(() => {
          checking = false;
        });
    };
    const timer = setTimeout(finish, INBOX_RECONCILE_TIMEOUT_MS);
    operation.signal.addEventListener("abort", finish, { once: true });
    const unsubscribe = host.onCaptureSettled(() => check());
    check();
  });
}

export async function addInboxItem(
  operation: InboxOperationLike,
  input: InboxAddInput,
  author: MomentWriteAuthor,
  source: InboxSource,
  host: WorkspaceInboxHost,
): Promise<InboxAddResult> {
  assertWritableInboxWorkspace(operation);
  const validatedUrl =
    input.url !== undefined && input.url.trim() !== "" ? validateInboxUrl(input.url) : undefined;
  const cleanedTitle = input.title ? sanitizeInboxSingleLine(input.title) : "";
  const body = input.body ?? "";
  if (!cleanedTitle && !validatedUrl && !body.trim()) {
    throw new Error("Enter a title, link, or note to capture into Inbox.");
  }

  const title = defaultTitleForCapture({ title: cleanedTitle, url: validatedUrl, body });
  const kind: InboxKind = input.kind ?? (validatedUrl ? "link" : "note");
  const nowIso = new Date().toISOString();
  const datePrefix = nowIso.slice(0, 10);
  const slug = safeInboxSlug(title, kind);
  const recordId = mintInboxRecordId();
  const markdown = formatInboxRecordMarkdown({
    recordId,
    title,
    source,
    kind,
    receivedIso: nowIso,
    status: "New",
    url: validatedUrl,
    body,
  });

  const written = await withExclusiveWorkspaceOperation(operation.workspace.rootPath, async () => {
    assertWritableInboxWorkspace(operation);
    const createdInbox = await ensureInboxCollection(operation, author, host);
    const relativePath = await allocateUniqueWorkspacePath(
      operation.workspace.rootPath,
      INBOX_COLLECTION_PATH,
      `${datePrefix}-${slug}`,
      ".md",
    );
    const outcome = await host.capture.writeAuthoredFile(
      join(operation.workspace.rootPath, relativePath),
      markdown,
      author,
      {
        createOnly: true,
        signal: operation.signal,
      },
    );
    requirePublishedWrite(relativePath, outcome);
    return {
      path: relativePath,
      recordId,
      title,
      createdInbox,
    };
  });
  await waitForInboxIndexed(operation, host, [written.recordId]);
  host.onChanged?.(written.createdInbox ? [INBOX_SCHEMA_PATH, written.path] : [written.path]);
  return written;
}

interface VerifiedFileSource {
  sourceAbsolute: string;
  displayName: string;
  leafName: string;
  expectedIdentity: FsEntryIdentity;
  parent?: DroppedFolderCheck;
}

async function parentCheckFor(filePath: string): Promise<DroppedFolderCheck | undefined> {
  const parentPath = dirname(filePath);
  const info = await lstat(parentPath, { bigint: true }).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return undefined;
  return { path: parentPath, identity: { dev: info.dev, ino: info.ino } };
}

async function collectSafeDroppedFiles(
  sources: readonly DroppedSource[],
  skips: InboxSkippedFile[],
): Promise<VerifiedFileSource[]> {
  const collected: VerifiedFileSource[] = [];
  for (const item of sources) {
    const rootName = basename(item.source);
    if (
      hasSecretPathSegment(item.source) ||
      isInboxSecretPath(rootName, `${INBOX_FILES_DIR}/${rootName}`)
    ) {
      skips.push({ name: rootName, reason: "secret-file" });
      continue;
    }
    if (item.entries === null) {
      collected.push({
        sourceAbsolute: item.source,
        displayName: rootName,
        leafName: rootName,
        expectedIdentity: item.identity,
        parent: await parentCheckFor(item.source),
      });
      continue;
    }

    for (const entry of item.entries) {
      const displayPath = `${rootName}/${entry.path}`;
      const destCandidate = `${INBOX_FILES_DIR}/${displayPath}`;
      if (isInboxSecretPath(displayPath, destCandidate)) {
        if (!entry.folder) {
          skips.push({ name: displayPath, reason: "secret-file" });
        }
        continue;
      }
      if (entry.folder) continue;
      const leafName = entry.path.split("/").at(-1) ?? entry.path;
      const sourceAbsolute = join(item.source, ...entry.path.split("/"));
      collected.push({
        sourceAbsolute,
        displayName: displayPath,
        leafName,
        expectedIdentity: entry.identity,
        parent: { path: dirname(sourceAbsolute), identity: entry.parent },
      });
    }
  }
  return collected;
}

async function readVerifiedSourceBytes(source: VerifiedFileSource): Promise<Buffer> {
  const handle = await openDroppedFile(
    source.sourceAbsolute,
    source.expectedIdentity,
    source.parent,
  );
  try {
    const info = await handle.stat({ bigint: true });
    if (info.size > BigInt(MAX_ENGINE_CAPTURE_BINARY_BYTES)) {
      throw new SourceTooLargeError(source.displayName, info.size, MAX_ENGINE_CAPTURE_BINARY_BYTES);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const chunkBuf = Buffer.allocUnsafe(SOURCE_READ_CHUNK_BYTES);
    while (true) {
      const remaining = MAX_ENGINE_CAPTURE_BINARY_BYTES + 1 - total;
      const toRead = Math.min(chunkBuf.length, remaining);
      const { bytesRead } = await handle.read(chunkBuf, 0, toRead, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_ENGINE_CAPTURE_BINARY_BYTES) {
        const latest = await handle.stat({ bigint: true }).catch(() => info);
        const reportedBytes = latest.size > BigInt(total) ? latest.size : BigInt(total);
        throw new SourceTooLargeError(
          source.displayName,
          reportedBytes,
          MAX_ENGINE_CAPTURE_BINARY_BYTES,
        );
      }
      chunks.push(Buffer.from(chunkBuf.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function decodePastedImage(image: InboxPastedImage): {
  bytes: Buffer;
  ext: string;
  baseName: string;
} {
  const bytes = Buffer.from(image.bytesBase64, "base64");
  if (
    bytes.byteLength === 0 ||
    bytes.toString("base64") !== image.bytesBase64.replace(/\s+/gu, "")
  ) {
    throw new Error(`Pasted image ${image.name} is not valid base64.`);
  }
  const maxImageBytes = Math.min(MAX_INBOX_IMAGE_BYTES, MAX_ENGINE_CAPTURE_BINARY_BYTES);
  if (bytes.byteLength > maxImageBytes) {
    throw new Error(
      `Pasted image ${image.name} exceeds ${Math.round(maxImageBytes / (1024 * 1024))} MiB.`,
    );
  }
  const ext = MIME_TO_EXTENSION[image.mimeType];
  const rawBase = basename(image.name, extname(image.name));
  const baseName = safeInboxSlug(rawBase, "pasted-image", 48);
  return { bytes, ext, baseName };
}

async function cleanupUnlinkedFiles(
  rootPath: string,
  relativePaths: readonly string[],
  createdSchema: boolean,
): Promise<void> {
  for (const relPath of [...relativePaths].reverse()) {
    const abs = join(rootPath, relPath);
    const info = await lstat(abs).catch(() => null);
    if (info && !info.isSymbolicLink() && info.isFile()) {
      await unlink(abs).catch(() => undefined);
    }
  }
  if (createdSchema) {
    const schemaAbs = join(rootPath, INBOX_SCHEMA_PATH);
    const info = await lstat(schemaAbs).catch(() => null);
    if (info && !info.isSymbolicLink() && info.isFile()) {
      await unlink(schemaAbs).catch(() => undefined);
    }
    await rmdir(join(rootPath, INBOX_FILES_DIR)).catch(() => undefined);
    await rmdir(join(rootPath, INBOX_COLLECTION_PATH)).catch(() => undefined);
  }
}

function computeNormalizedAttachmentParts(leafName: string): {
  baseName: string;
  ext: string;
  candidatePath: string;
} {
  const rawExt = extname(leafName);
  const rawBase = basename(leafName, rawExt);
  const safeExt = rawExt.replace(/[^a-zA-Z0-9._-]/gu, "");
  const safeBase = safeInboxSlug(rawBase, "file", 60);
  return {
    baseName: safeBase,
    ext: safeExt,
    candidatePath: `${INBOX_FILES_DIR}/${safeBase}${safeExt}`,
  };
}

export async function captureFilesToInbox(
  operation: InboxOperationLike,
  input: Omit<InboxCaptureFilesInput, "pick"> & { pickedPaths?: readonly string[] },
  author: MomentWriteAuthor,
  host: WorkspaceInboxHost,
): Promise<InboxCaptureFilesResult> {
  assertWritableInboxWorkspace(operation);

  const validatedUrl =
    input.url !== undefined && input.url.trim() !== "" ? validateInboxUrl(input.url) : undefined;
  const cleanedTitle = input.title ? sanitizeInboxSingleLine(input.title) : "";
  const body = input.body ?? "";
  const hasNoteContent = Boolean(cleanedTitle || validatedUrl || body.trim());

  const skippedSources: InboxSkippedFile[] = [];
  let extraSkippedCount = 0;
  const verifiedFiles: VerifiedFileSource[] = [];
  let sourceKind: InboxSource = "capture";

  if (input.droppedPaths && input.droppedPaths.length > 0) {
    sourceKind = "drop";
    const safeDroppedInput: string[] = [];
    for (const rawPath of input.droppedPaths) {
      if (await hasSecretRawOrResolvedPath(rawPath)) {
        skippedSources.push({ name: basename(rawPath) || rawPath, reason: "secret-file" });
        continue;
      }
      safeDroppedInput.push(rawPath);
    }
    if (safeDroppedInput.length > 0) {
      const roots = host.registeredRoots
        ? [...host.registeredRoots()]
        : [operation.workspace.rootPath];
      const screened = await screenDroppedPaths(safeDroppedInput, roots, INBOX_FILES_DIR, {
        onSecretSkipped: (secretPath) => {
          skippedSources.push({ name: secretPath, reason: "secret-file" });
        },
      });
      const skipOutcome = screened.skips.outcome();
      for (const skipped of skipOutcome.skippedSources ?? []) {
        skippedSources.push({ name: skipped.path, reason: skipped.reason });
      }
      extraSkippedCount += Math.max(
        0,
        skipOutcome.skipped - (skipOutcome.skippedSources?.length ?? 0),
      );
      verifiedFiles.push(...(await collectSafeDroppedFiles(screened.usable, skippedSources)));
    }
  }

  if (input.pickedPaths && input.pickedPaths.length > 0) {
    const safePickedInput: string[] = [];
    for (const rawPath of input.pickedPaths) {
      if (await hasSecretRawOrResolvedPath(rawPath)) {
        skippedSources.push({ name: basename(rawPath) || rawPath, reason: "secret-file" });
        continue;
      }
      safePickedInput.push(rawPath);
    }
    if (safePickedInput.length > 0) {
      const picked = await screenPickedPaths(safePickedInput);
      const skipOutcome = picked.skips.outcome();
      for (const skipped of skipOutcome.skippedSources ?? []) {
        skippedSources.push({ name: skipped.path, reason: skipped.reason });
      }
      extraSkippedCount += Math.max(
        0,
        skipOutcome.skipped - (skipOutcome.skippedSources?.length ?? 0),
      );
      for (const absolutePath of picked.usable) {
        const leafName = basename(absolutePath) || absolutePath;
        if (await hasSecretRawOrResolvedPath(absolutePath)) {
          skippedSources.push({ name: leafName, reason: "secret-file" });
          continue;
        }
        const info = await lstat(absolutePath, { bigint: true }).catch(() => null);
        if (!info || info.isSymbolicLink() || !info.isFile()) {
          skippedSources.push({
            name: leafName,
            reason: info?.isSymbolicLink() ? "link" : "unreadable",
          });
          continue;
        }
        verifiedFiles.push({
          sourceAbsolute: absolutePath,
          displayName: leafName,
          leafName,
          expectedIdentity: { dev: info.dev, ino: info.ino },
          parent: await parentCheckFor(absolutePath),
        });
      }
    }
  }

  const eligibleFiles: Array<{
    source: VerifiedFileSource;
    baseName: string;
    ext: string;
  }> = [];
  for (const file of verifiedFiles) {
    const parts = computeNormalizedAttachmentParts(file.leafName);
    if (
      isInboxSecretPath(file.displayName, parts.candidatePath) ||
      isInboxSecretPath(file.leafName, parts.candidatePath)
    ) {
      skippedSources.push({ name: file.displayName, reason: "secret-file" });
      continue;
    }
    eligibleFiles.push({ source: file, baseName: parts.baseName, ext: parts.ext });
  }

  const decodedImages = (input.pastedImages ?? []).map((image) => ({
    ...decodePastedImage(image),
    originalName: image.name,
  }));

  if (eligibleFiles.length === 0 && decodedImages.length === 0 && !hasNoteContent) {
    return {
      items: [],
      skipped: skippedSources.length + extraSkippedCount,
      skippedSources,
      createdInbox: false,
    };
  }

  const nowIso = new Date().toISOString();
  const datePrefix = nowIso.slice(0, 10);

  const captured = await withExclusiveWorkspaceOperation(operation.workspace.rootPath, async () => {
    assertWritableInboxWorkspace(operation);
    const rootPath = operation.workspace.rootPath;
    let inboxEnsured = false;
    let filesDirChecked = false;
    let createdInbox = false;
    const changedPaths: string[] = [];
    const writtenAttachments: Array<{ path: string; isImage: boolean; label: string }> = [];
    const items: InboxCapturedItem[] = [];
    const batchCreatedFiles: string[] = [];

    const ensureInboxReady = async (needsFilesDir: boolean): Promise<void> => {
      if (needsFilesDir && !filesDirChecked) {
        await assertInsideResolvedSubtree(
          rootPath,
          INBOX_FILES_DIR,
          INBOX_FILES_DIR,
          "write",
          "Inbox files folder",
        );
        filesDirChecked = true;
      }
      if (!inboxEnsured) {
        createdInbox = await ensureInboxCollection(operation, author, host);
        if (createdInbox) changedPaths.push(INBOX_SCHEMA_PATH);
        inboxEnsured = true;
      }
    };

    try {
      if (hasNoteContent) {
        for (const entry of eligibleFiles) {
          operation.assertCurrent();
          let bytes: Buffer;
          try {
            bytes = await readVerifiedSourceBytes(entry.source);
          } catch (error) {
            skippedSources.push({
              name: entry.source.displayName,
              reason: error instanceof SourceTooLargeError ? "too-large" : "unreadable",
            });
            continue;
          }
          await ensureInboxReady(true);
          const attachmentPath = await allocateUniqueWorkspacePath(
            rootPath,
            INBOX_FILES_DIR,
            entry.baseName,
            entry.ext,
          );
          if (isInboxSecretPath(entry.source.leafName, attachmentPath)) {
            skippedSources.push({ name: entry.source.displayName, reason: "secret-file" });
            continue;
          }
          const outcome = await host.capture.writeAuthoredFile(
            join(rootPath, attachmentPath),
            bytes,
            author,
            {
              createOnly: true,
              signal: operation.signal,
            },
          );
          requirePublishedWrite(attachmentPath, outcome);
          batchCreatedFiles.push(attachmentPath);
          changedPaths.push(attachmentPath);
          writtenAttachments.push({
            path: attachmentPath,
            isImage: isImagePath(attachmentPath),
            label: entry.source.leafName,
          });
        }

        for (const image of decodedImages) {
          operation.assertCurrent();
          await ensureInboxReady(true);
          const attachmentPath = await allocateUniqueWorkspacePath(
            rootPath,
            INBOX_FILES_DIR,
            `${datePrefix}-${image.baseName}`,
            image.ext,
          );
          const outcome = await host.capture.writeAuthoredFile(
            join(rootPath, attachmentPath),
            image.bytes,
            author,
            {
              createOnly: true,
              signal: operation.signal,
            },
          );
          requirePublishedWrite(attachmentPath, outcome);
          batchCreatedFiles.push(attachmentPath);
          changedPaths.push(attachmentPath);
          writtenAttachments.push({
            path: attachmentPath,
            isImage: true,
            label: image.originalName,
          });
        }

        await ensureInboxReady(false);
        const title = defaultTitleForCapture({
          title: cleanedTitle,
          url: validatedUrl,
          body,
          fallback: writtenAttachments[0]?.label ?? "Captured item",
        });
        const kind: InboxKind = validatedUrl
          ? "link"
          : writtenAttachments.length > 0
            ? writtenAttachments.every((entry) => entry.isImage)
              ? "image"
              : "file"
            : "note";
        const recordId = mintInboxRecordId();
        const markdown = formatInboxRecordMarkdown({
          recordId,
          title,
          source: sourceKind,
          kind,
          receivedIso: nowIso,
          status: "New",
          url: validatedUrl,
          attachments: writtenAttachments,
          body,
        });
        const notePath = await allocateUniqueWorkspacePath(
          rootPath,
          INBOX_COLLECTION_PATH,
          `${datePrefix}-${safeInboxSlug(title, kind)}`,
          ".md",
        );
        const outcome = await host.capture.writeAuthoredFile(
          join(rootPath, notePath),
          markdown,
          author,
          {
            createOnly: true,
            signal: operation.signal,
          },
        );
        requirePublishedWrite(notePath, outcome);
        batchCreatedFiles.push(notePath);
        changedPaths.push(notePath);
        items.push({
          path: notePath,
          recordId,
          title,
          attachments: writtenAttachments.map((entry) => entry.path),
        });
      } else {
        const writeSingleAttachmentItem = async (entry: {
          label: string;
          baseName: string;
          ext: string;
          bytes: Buffer;
          isImage: boolean;
          displayName: string;
        }): Promise<void> => {
          await ensureInboxReady(true);
          const attachmentPath = await allocateUniqueWorkspacePath(
            rootPath,
            INBOX_FILES_DIR,
            entry.baseName,
            entry.ext,
          );
          if (isInboxSecretPath(entry.label, attachmentPath)) {
            skippedSources.push({ name: entry.displayName, reason: "secret-file" });
            return;
          }
          const attOutcome = await host.capture.writeAuthoredFile(
            join(rootPath, attachmentPath),
            entry.bytes,
            author,
            {
              createOnly: true,
              signal: operation.signal,
            },
          );
          requirePublishedWrite(attachmentPath, attOutcome);
          batchCreatedFiles.push(attachmentPath);
          changedPaths.push(attachmentPath);

          const attachment = { path: attachmentPath, isImage: entry.isImage, label: entry.label };
          const title = sanitizeInboxSingleLine(
            basename(entry.label, extname(entry.label)) || entry.label,
          );
          const kind: InboxKind = entry.isImage ? "image" : "file";
          const recordId = mintInboxRecordId();
          const markdown = formatInboxRecordMarkdown({
            recordId,
            title,
            source: sourceKind,
            kind,
            receivedIso: nowIso,
            status: "New",
            attachments: [attachment],
          });
          const notePath = await allocateUniqueWorkspacePath(
            rootPath,
            INBOX_COLLECTION_PATH,
            `${datePrefix}-${safeInboxSlug(title, kind)}`,
            ".md",
          );
          const noteOutcome = await host.capture.writeAuthoredFile(
            join(rootPath, notePath),
            markdown,
            author,
            {
              createOnly: true,
              signal: operation.signal,
            },
          );
          requirePublishedWrite(notePath, noteOutcome);
          batchCreatedFiles.push(notePath);
          changedPaths.push(notePath);
          items.push({
            path: notePath,
            recordId,
            title,
            attachments: [attachmentPath],
          });
        };

        for (const entry of eligibleFiles) {
          operation.assertCurrent();
          let bytes: Buffer;
          try {
            bytes = await readVerifiedSourceBytes(entry.source);
          } catch (error) {
            skippedSources.push({
              name: entry.source.displayName,
              reason: error instanceof SourceTooLargeError ? "too-large" : "unreadable",
            });
            continue;
          }
          await writeSingleAttachmentItem({
            label: entry.source.leafName,
            baseName: entry.baseName,
            ext: entry.ext,
            bytes,
            isImage: isImagePath(entry.source.leafName),
            displayName: entry.source.displayName,
          });
        }

        for (const image of decodedImages) {
          operation.assertCurrent();
          await writeSingleAttachmentItem({
            label: image.originalName,
            baseName: `${datePrefix}-${image.baseName}`,
            ext: image.ext,
            bytes: image.bytes,
            isImage: true,
            displayName: image.originalName,
          });
        }
      }
    } catch (error) {
      await cleanupUnlinkedFiles(rootPath, batchCreatedFiles, createdInbox);
      throw error;
    }

    return {
      changedPaths,
      result: {
        items,
        skipped: skippedSources.length + extraSkippedCount,
        skippedSources,
        createdInbox,
      },
    };
  });
  if (captured.result.items.length > 0) {
    await waitForInboxIndexed(
      operation,
      host,
      captured.result.items.map((item) => item.recordId),
    );
  }
  if (captured.changedPaths.length > 0) {
    host.onChanged?.(captured.changedPaths);
  }
  return captured.result;
}

async function assertExistingInboxRecord(
  rootPath: string,
  rawPath: string,
): Promise<{
  normalized: string;
  absolutePath: string;
}> {
  const checked = validateUserMaterializePath(rawPath, { platform: process.platform });
  if (!checked.ok || !isInboxRecordPath(checked.normalized)) {
    throw new Error(`Choose a Markdown item directly inside ${INBOX_COLLECTION_PATH}/.`);
  }
  const absolutePath = join(rootPath, checked.normalized);
  const info = await lstat(absolutePath).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Inbox item not found at ${checked.normalized}.`);
  }
  await assertInsideResolvedSubtree(
    rootPath,
    INBOX_COLLECTION_PATH,
    checked.normalized,
    "entry",
    "Inbox item",
  );
  return { normalized: checked.normalized, absolutePath };
}

function toRecordChangeAuthor(
  author: MomentWriteAuthor,
  person: LocalPersonAuthor,
  host: WorkspaceInboxHost,
): ChangeAuthor {
  if (author.kind === "agent") {
    return {
      kind: "agent",
      agentId: author.agentId,
      onBehalfOf: author.onBehalfOf ?? person.humanId,
      ...(author.agentRunId !== undefined ? { agentRunId: author.agentRunId } : {}),
      depth: author.depth ?? 0,
    };
  }
  return createLocalChangeAuthor(host.personDisplayName?.() || "You");
}

export async function archiveInboxItem(
  operation: InboxOperationLike,
  input: InboxArchiveInput,
  author: MomentWriteAuthor,
  person: LocalPersonAuthor,
  host: WorkspaceInboxHost,
): Promise<InboxArchiveResult> {
  assertWritableInboxWorkspace(operation);
  const { normalized } = await assertExistingInboxRecord(operation.workspace.rootPath, input.item);

  const editContext = desktopRecordEditContext({
    capture: host.capture,
    workspaceRoot: operation.workspace.rootPath,
    person,
    withAdapter: host.withAdapter,
    onCaptureSettled: host.onCaptureSettled,
    signal: operation.signal,
  });

  const edited = await setCollectionRecordFields(editContext, {
    recordPath: normalized,
    fields: { Status: "Archived" },
    author: toRecordChangeAuthor(author, person, host),
  });
  const changed = Object.hasOwn(edited.replaced, "Status");
  const previousStatus = changed ? asString(edited.replaced.Status as CollectionValue) : "Archived";
  host.onChanged?.([normalized]);
  return {
    path: normalized,
    previousStatus,
    changed,
  };
}

export async function undoArchiveInboxItem(
  operation: InboxOperationLike,
  input: InboxUndoArchiveInput,
  person: LocalPersonAuthor,
  host: WorkspaceInboxHost,
): Promise<InboxUndoArchiveResult> {
  assertWritableInboxWorkspace(operation);
  const { normalized } = await assertExistingInboxRecord(operation.workspace.rootPath, input.item);

  const editContext = desktopRecordEditContext({
    capture: host.capture,
    workspaceRoot: operation.workspace.rootPath,
    person,
    withAdapter: host.withAdapter,
    onCaptureSettled: host.onCaptureSettled,
    signal: operation.signal,
  });

  const edited = await setCollectionRecordFields(editContext, {
    recordPath: normalized,
    fields: { Status: input.previousStatus },
    expectedBefore: { Status: "Archived" },
    author: toRecordChangeAuthor(person, person, host),
  });
  const restored = Object.hasOwn(edited.replaced, "Status");
  const currentStatus = Object.hasOwn(edited.kept, "Status")
    ? asString(edited.kept.Status as CollectionValue)
    : input.previousStatus;
  if (restored) {
    host.onChanged?.([normalized]);
  }
  return {
    path: normalized,
    restored,
    currentStatus,
  };
}

async function validateInboxMoveTargetFolder(rootPath: string, rawFolder: string): Promise<string> {
  const trimmed = rawFolder
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/gu, "");
  if (trimmed === "" || trimmed === ".") return "";
  const checked = validateUserMaterializePath(trimmed, { platform: process.platform });
  if (!checked.ok) {
    throw new Error(`Cannot move into ${rawFolder}: ${checked.reason}. Choose an owned folder.`);
  }
  const normalized = checked.normalized;
  if (normalized === INBOX_COLLECTION_PATH || normalized.startsWith(`${INBOX_COLLECTION_PATH}/`)) {
    throw new Error("Choose a folder outside Inbox/.");
  }
  if (isSharedWithMePath(normalized)) {
    throw new Error("Cannot move Inbox items into a received share under shared-with-me/.");
  }
  if (classifyEngineFilePath(normalized).kind !== "tracked") {
    throw new Error(
      `Cannot move into ${normalized}. Choose a visible, non-secret workspace folder.`,
    );
  }
  const targetAbs = join(rootPath, normalized);
  let walkAbs = rootPath;
  for (const part of normalized.split("/")) {
    walkAbs = join(walkAbs, part);
    const segmentInfo = await lstat(walkAbs).catch(() => null);
    if (!segmentInfo || segmentInfo.isSymbolicLink() || !segmentInfo.isDirectory()) {
      throw new Error(`Folder not found: ${normalized}. Choose an existing folder.`);
    }
  }
  const info = await stat(targetAbs).catch(() => null);
  if (!info || !info.isDirectory()) {
    throw new Error(`Folder not found: ${normalized}. Choose an existing folder.`);
  }
  await assertResolvedWorkspacePath({
    rootPath,
    absolutePath: targetAbs,
    spelled: normalized,
    label: "Target folder",
    access: "write",
  });
  const rootReal = await realpath(rootPath);
  const resolvedRel = relative(rootReal, await realpath(targetAbs)).replaceAll("\\", "/");
  if (
    resolvedRel === INBOX_COLLECTION_PATH ||
    resolvedRel.startsWith(`${INBOX_COLLECTION_PATH}/`) ||
    isSharedWithMePath(resolvedRel)
  ) {
    throw new Error("Choose a folder outside Inbox/ and shared-with-me/.");
  }
  return normalized;
}

async function collectValidInboxAttachmentsForMove(
  rootPath: string,
  noteText: string,
): Promise<string[]> {
  const parsedFields = parseCollectionRecordFields(noteText) ?? {};
  const candidates: string[] = [];
  const rawFrontmatterAttachment =
    typeof parsedFields.Attachment === "string" ? parsedFields.Attachment : null;
  if (rawFrontmatterAttachment) candidates.push(rawFrontmatterAttachment);
  candidates.push(...extractInboxAttachmentLinks(noteText));

  const valid: string[] = [];
  const seen = new Set<string>();
  for (const rawAttachment of candidates) {
    if (!isInboxAttachmentPath(rawAttachment)) continue;
    const checkedAttachment = validateUserMaterializePath(rawAttachment, {
      platform: process.platform,
    });
    if (!checkedAttachment.ok || !isInboxAttachmentPath(checkedAttachment.normalized)) continue;
    if (seen.has(checkedAttachment.normalized)) continue;
    if (checkedAttachment.normalized.length > MAX_INBOX_PATH_CHARS) {
      throw new Error(
        `Inbox attachment path is ${checkedAttachment.normalized.length} characters, exceeding the ${MAX_INBOX_PATH_CHARS}-character limit. Move it manually first.`,
      );
    }
    const attachmentAbs = join(rootPath, checkedAttachment.normalized);
    const attachmentInfo = await lstat(attachmentAbs).catch(() => null);
    if (!attachmentInfo || attachmentInfo.isSymbolicLink() || !attachmentInfo.isFile()) continue;
    await assertInsideResolvedSubtree(
      rootPath,
      INBOX_FILES_DIR,
      checkedAttachment.normalized,
      "entry",
      "Inbox attachment",
    );
    seen.add(checkedAttachment.normalized);
    valid.push(checkedAttachment.normalized);
  }
  return valid;
}

export async function moveInboxItem(
  operation: InboxOperationLike,
  input: InboxMoveInput,
  author: MomentWriteAuthor,
  host: WorkspaceInboxHost,
): Promise<InboxMoveResult> {
  assertWritableInboxWorkspace(operation);
  const rootPath = operation.workspace.rootPath;
  const { normalized } = await assertExistingInboxRecord(rootPath, input.item);
  const targetFolder = await validateInboxMoveTargetFolder(rootPath, input.targetFolder);

  const reserved = new Set<string>();
  const noteExt = extname(normalized);
  const noteBase = basename(normalized, noteExt);
  const targetNotePath = await allocateUniqueWorkspacePath(
    rootPath,
    targetFolder,
    noteBase,
    noteExt,
    reserved,
  );
  if (targetNotePath.length > MAX_INBOX_PATH_CHARS) {
    throw new Error(
      `Destination path is ${targetNotePath.length} characters, exceeding the ${MAX_INBOX_PATH_CHARS}-character limit. Choose a shorter folder path.`,
    );
  }

  const completedMoves: Array<{ fromPath: string; toPath: string; operationId?: string }> = [];
  const movedAttachments: Array<{ fromPath: string; toPath: string; operationId?: string }> = [];
  let movedNote: { fromPath: string; toPath: string; operationId?: string };

  try {
    // Move the note first so beforeMove flushes live edits before we discover attachments.
    movedNote = await host.moveFile({
      fromPath: normalized,
      toPath: targetNotePath,
      author,
    });
    completedMoves.push(movedNote);
    reserved.add(movedNote.toPath.toLowerCase());

    const settledNoteText = (
      await readBoundedRegularFile(
        join(rootPath, movedNote.toPath),
        MAX_INBOX_NOTE_READ_BYTES,
        false,
      )
    ).toString("utf8");
    const attachmentsToMove = await collectValidInboxAttachmentsForMove(rootPath, settledNoteText);
    if (attachmentsToMove.length > MAX_INBOX_MOVE_ATTACHMENTS) {
      throw new Error(
        `This Inbox item links ${attachmentsToMove.length} attachments, exceeding the ${MAX_INBOX_MOVE_ATTACHMENTS}-attachment limit. Move some files manually first.`,
      );
    }

    const plannedAttachments: Array<{ fromPath: string; toPath: string }> = [];
    for (const attachmentPath of attachmentsToMove) {
      const attachmentExt = extname(attachmentPath);
      const attachmentBase = basename(attachmentPath, attachmentExt);
      const targetAttachmentPath = await allocateUniqueWorkspacePath(
        rootPath,
        targetFolder,
        attachmentBase,
        attachmentExt,
        reserved,
      );
      if (targetAttachmentPath.length > MAX_INBOX_PATH_CHARS) {
        throw new Error(
          `Destination attachment path is ${targetAttachmentPath.length} characters, exceeding the ${MAX_INBOX_PATH_CHARS}-character limit. Choose a shorter folder path.`,
        );
      }
      plannedAttachments.push({ fromPath: attachmentPath, toPath: targetAttachmentPath });
    }

    for (const plan of plannedAttachments) {
      const moved = await host.moveFile({
        fromPath: plan.fromPath,
        toPath: plan.toPath,
        author,
      });
      completedMoves.push(moved);
      movedAttachments.push(moved);
    }

    await rewriteNoteWithHashGuard(
      join(rootPath, movedNote.toPath),
      movedNote.toPath,
      (currentText) =>
        rewriteInboxMovedNoteMarkdown(currentText, movedAttachments, {
          fromPath: movedNote.fromPath,
          toPath: movedNote.toPath,
        }),
      author,
      operation.signal,
      host,
    );
  } catch (error) {
    for (const move of [...completedMoves].reverse()) {
      try {
        if (move.operationId && host.undoOperation) {
          try {
            await host.undoOperation(move.operationId, author);
            if (
              (await pathExists(join(rootPath, move.fromPath))) ||
              !(await pathExists(join(rootPath, move.toPath)))
            ) {
              continue;
            }
          } catch {
            // Fall back to direct reverse move if History undo cannot run.
          }
        }
        await host.moveFile({
          fromPath: move.toPath,
          toPath: move.fromPath,
          author,
        });
      } catch {
        // Best-effort rollback so the original failure is preserved.
      }
    }
    throw error;
  }

  host.onChanged?.([
    normalized,
    movedNote.toPath,
    ...movedAttachments.flatMap((entry) => [entry.fromPath, entry.toPath]),
  ]);

  return {
    fromPath: movedNote.fromPath,
    toPath: movedNote.toPath,
    ...(movedNote.operationId ? { operationId: movedNote.operationId } : {}),
    attachments: movedAttachments,
  };
}

async function rewriteNoteWithHashGuard(
  absolutePath: string,
  relativePath: string,
  transform: (currentText: string) => string,
  author: MomentWriteAuthor,
  signal: AbortSignal,
  host: WorkspaceInboxHost,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const currentText = (
      await readBoundedRegularFile(absolutePath, MAX_INBOX_NOTE_READ_BYTES, false)
    ).toString("utf8");
    const rewritten = transform(currentText);
    if (rewritten === currentText) return undefined;
    const expectedContentHash = createHash("sha256").update(currentText, "utf8").digest("hex");
    try {
      const written = await host.capture.writeAuthoredFile(absolutePath, rewritten, author, {
        signal,
        expectedContentHash,
      });
      requirePublishedWrite(relativePath, written);
      return written.momentId;
    } catch (error) {
      if (error instanceof AuthoredTextChangedError && attempt === 0) continue;
      throw error;
    }
  }
  return undefined;
}

async function assertRegularWorkspaceFileForUndo(
  rootPath: string,
  rawPath: string,
  label: string,
): Promise<string> {
  const checked = validateUserMaterializePath(rawPath, { platform: process.platform });
  if (!checked.ok) {
    throw new Error(`Invalid ${label.toLowerCase()} path: ${rawPath}`);
  }
  const absolutePath = join(rootPath, checked.normalized);
  const info = await lstat(absolutePath).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Cannot undo move. ${checked.normalized} is no longer available.`);
  }
  await assertResolvedWorkspacePath({
    rootPath,
    absolutePath,
    spelled: checked.normalized,
    label,
    access: "entry",
  });
  return checked.normalized;
}

export async function undoMoveInboxItem(
  operation: InboxOperationLike,
  input: InboxUndoMoveInput,
  person: LocalPersonAuthor,
  host: WorkspaceInboxHost,
): Promise<InboxUndoMoveResult> {
  assertWritableInboxWorkspace(operation);
  const rootPath = operation.workspace.rootPath;

  const checkedFrom = validateUserMaterializePath(input.fromPath, { platform: process.platform });
  if (!checkedFrom.ok || !isInboxRecordPath(checkedFrom.normalized)) {
    throw new Error(`Cannot undo move. ${input.fromPath} is not a valid Inbox item path.`);
  }
  const fromPath = checkedFrom.normalized;
  await assertInsideResolvedSubtree(
    rootPath,
    INBOX_COLLECTION_PATH,
    fromPath,
    "write",
    "Inbox item",
  );
  const toPath = await assertRegularWorkspaceFileForUndo(rootPath, input.toPath, "Moved item");

  const validatedAttachments: Array<{
    fromPath: string;
    toPath: string;
    operationId?: string;
  }> = [];
  for (const att of input.attachments) {
    const checkedAttFrom = validateUserMaterializePath(att.fromPath, {
      platform: process.platform,
    });
    if (!checkedAttFrom.ok || !isInboxAttachmentPath(checkedAttFrom.normalized)) {
      throw new Error(`Cannot undo move. ${att.fromPath} is not a valid Inbox attachment path.`);
    }
    await assertInsideResolvedSubtree(
      rootPath,
      INBOX_FILES_DIR,
      checkedAttFrom.normalized,
      "write",
      "Inbox attachment",
    );
    const attTo = await assertRegularWorkspaceFileForUndo(rootPath, att.toPath, "Moved attachment");
    validatedAttachments.push({
      fromPath: checkedAttFrom.normalized,
      toPath: attTo,
      ...(att.operationId ? { operationId: att.operationId } : {}),
    });
  }

  // Refuse before any mutation if any original path is now occupied.
  if (await pathExists(join(rootPath, fromPath))) {
    throw new Error(`Cannot undo move. ${fromPath} now occupies the old path. Move it first.`);
  }
  for (const att of validatedAttachments) {
    if (await pathExists(join(rootPath, att.fromPath))) {
      throw new Error(
        `Cannot undo move. ${att.fromPath} now occupies the old path. Move it first.`,
      );
    }
  }

  const undoSteps: Array<{ fromPath: string; toPath: string; operationId?: string }> = [
    { fromPath, toPath, ...(input.operationId ? { operationId: input.operationId } : {}) },
    ...[...validatedAttachments].reverse(),
  ];
  const undoneSteps: Array<{ fromPath: string; toPath: string }> = [];

  try {
    for (const step of undoSteps) {
      let movedBack = false;
      if (step.operationId && host.undoOperation) {
        try {
          await host.undoOperation(step.operationId, person);
          movedBack =
            (await pathExists(join(rootPath, step.fromPath))) ||
            !(await pathExists(join(rootPath, step.toPath)));
        } catch (error) {
          const alreadyUndone =
            error instanceof Error && /operation already undone/iu.test(error.message);
          if (!alreadyUndone) throw error;
        }
      }
      if (!movedBack) {
        await host.moveFile({
          fromPath: step.toPath,
          toPath: step.fromPath,
          author: person,
        });
      }
      undoneSteps.push({ fromPath: step.fromPath, toPath: step.toPath });
    }

    await rewriteNoteWithHashGuard(
      join(rootPath, fromPath),
      fromPath,
      (currentText) =>
        rewriteInboxRestoredNoteMarkdown(currentText, validatedAttachments, {
          fromPath,
          toPath,
        }),
      person,
      operation.signal,
      host,
    );
  } catch (error) {
    for (const step of [...undoneSteps].reverse()) {
      try {
        await host.moveFile({
          fromPath: step.fromPath,
          toPath: step.toPath,
          author: person,
        });
      } catch {
        // Best-effort rollback so the original failure is preserved.
      }
    }
    throw error;
  }

  host.onChanged?.([
    fromPath,
    toPath,
    ...validatedAttachments.flatMap((entry) => [entry.fromPath, entry.toPath]),
  ]);

  return { ok: true };
}
