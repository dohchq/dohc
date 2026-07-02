import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { hasIgnoredSegment } from "@dohc/workspace-core";
import { assertSafeWorkspacePath, mediaTypeForPath, sha256 } from "./metadata";

export const MAX_INLINE_FILE_SIZE = 10 * 1024 * 1024;

export type ScannedWorkspaceFile = {
  path: string;
  mediaType: string;
  bytes?: Uint8Array;
  size: number;
  sha256: string;
};

export async function scanWorkspaceFiles(rootDir: string): Promise<ScannedWorkspaceFile[]> {
  const files: ScannedWorkspaceFile[] = [];
  await scanDir(rootDir, rootDir, files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function scanDir(rootDir: string, dir: string, files: ScannedWorkspaceFile[]) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");
    if (hasIgnoredSegment(relPath)) continue;
    if (entry.isDirectory()) {
      await scanDir(rootDir, fullPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = assertSafeWorkspacePath(relPath);
    const size = await fileSize(fullPath);
    const bytes = size <= MAX_INLINE_FILE_SIZE ? await readFile(fullPath) : undefined;
    const mediaType = await mediaTypeForScannedFile(rel, fullPath, bytes);
    files.push({
      path: rel,
      mediaType,
      bytes,
      size,
      sha256: bytes ? sha256(bytes) : await sha256File(fullPath),
    });
  }
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
