import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { hasIgnoredSegment, isDatabaseSidecar } from "@dohc/workspace-core";
import { assertSafeWorkspacePath, mediaTypeForPath, sha256 } from "./metadata";

export const MAX_INLINE_FILE_SIZE = 10 * 1024 * 1024;

export type ScannedWorkspaceFile = {
  path: string;
  mediaType: string;
  bytes?: Uint8Array;
  size: number;
  sha256: string;
};

// One path the tolerant scan could not read (unreadable directory, a file
// deleted between the directory listing and its stat/read, an unsafe name).
// `path` is workspace-relative ("." when the root itself was unreadable).
export type WorkspaceScanFailure = {
  path: string;
  reason: string;
};

export type TolerantWorkspaceScan = {
  files: ScannedWorkspaceFile[];
  failures: WorkspaceScanFailure[];
};

export async function scanWorkspaceFiles(rootDir: string): Promise<ScannedWorkspaceFile[]> {
  const files: ScannedWorkspaceFile[] = [];
  await scanDir(rootDir, rootDir, files, null);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// Reconciliation-tolerant sibling of scanWorkspaceFiles (WS-H1 gate fix): one
// unreadable or racy path is collected as a failure and SKIPPED instead of
// aborting the whole recursive scan, so startup reconciliation can still seed
// every readable file on a cold adoption. Strict callers (sync, diff) keep
// scanWorkspaceFiles, which still throws on the first error.
export async function scanWorkspaceFilesTolerant(rootDir: string): Promise<TolerantWorkspaceScan> {
  const files: ScannedWorkspaceFile[] = [];
  const failures: WorkspaceScanFailure[] = [];
  await scanDir(rootDir, rootDir, files, failures);
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    failures: failures.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function scanFailureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function scanDir(
  rootDir: string,
  dir: string,
  files: ScannedWorkspaceFile[],
  // null = strict mode: the first error aborts the whole scan (the historical
  // default). Non-null = tolerant mode: per-directory and per-entry errors
  // are collected here and the scan continues.
  failures: WorkspaceScanFailure[] | null,
) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (!failures) throw error;
    const relativeDir = relative(rootDir, dir).replace(/\\/g, "/") || ".";
    failures.push({ path: relativeDir, reason: scanFailureReason(error) });
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relativePath = relative(rootDir, fullPath).replace(/\\/g, "/");
    if (hasIgnoredSegment(relativePath)) continue;
    if (entry.isDirectory()) {
      await scanDir(rootDir, fullPath, files, failures);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isDatabaseSidecar(relativePath)) continue;
    try {
      files.push(await scanFileEntry(relativePath, fullPath));
    } catch (error) {
      if (!failures) throw error;
      failures.push({ path: relativePath, reason: scanFailureReason(error) });
    }
  }
}

async function scanFileEntry(relativePath: string, fullPath: string): Promise<ScannedWorkspaceFile> {
  const rel = assertSafeWorkspacePath(relativePath);
  const size = await fileSize(fullPath);
  const bytes = size <= MAX_INLINE_FILE_SIZE ? await readFile(fullPath) : undefined;
  const mediaType = await mediaTypeForScannedFile(rel, fullPath, bytes);
  return {
    path: rel,
    mediaType,
    bytes,
    size,
    sha256: bytes ? sha256(bytes) : await sha256File(fullPath),
  };
}

async function mediaTypeForScannedFile(path: string, fullPath: string, bytes: Uint8Array | undefined) {
  if (!path.toLowerCase().endsWith(".db")) return mediaTypeForPath(path);
  const header = bytes ? bytes.slice(0, 16) : await readHeader(fullPath, 16);
  return new TextDecoder().decode(header) === "SQLite format 3\0"
    ? "application/vnd.sqlite3"
    : mediaTypeForPath(path);
}

async function readHeader(path: string, length: number) {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { start: 0, end: length - 1 });
    stream.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return Buffer.concat(chunks);
}

async function fileSize(path: string) {
  return (await stat(path)).size;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}
