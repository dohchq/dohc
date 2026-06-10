import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AssetKind, AtomKind, WorkspaceFile } from "@dohc/workspace-contracts";
import { mediaTypeForPath as coreMediaTypeForPath } from "@dohc/workspace-core";

export type WorkspaceBackendMode = "postgres";

export type WorkspaceManifestEntry = {
  id: string;
  kind: WorkspaceFile["kind"];
  contentType: string;
  revision: string;
  sha256?: string;
};

export type WorkspaceManifest = {
  version: 1;
  workspaceId: string;
  backend: WorkspaceBackendMode;
  // Server binding (Phase 9): the sync baseline is only valid against the
  // server that produced it. Pull REFUSES (no deletes) if the engine is
  // pointed at a different server/workspace — guards "re-point at an empty
  // server -> mass-delete clean local files". Optional for back-compat with
  // pre-binding manifests; initialize() writes them.
  serverUrl?: string;
  remoteWorkspaceId?: string;
  files: Record<string, WorkspaceManifestEntry>;
};

// Thrown by readManifest when the file is present but unparseable/misshapen —
// distinct from ENOENT (absent), which callers treat as "fresh, never synced".
export class CorruptManifestError extends Error {}

// Must never be .dohc/manifest.json: that path is the workspace IDENTITY
// manifest owned by workspace-core/desktop; this file is the sync baseline.
export const MANIFEST_PATH = ".dohc/sync-manifest.json";

export async function readManifest(rootDir: string): Promise<WorkspaceManifest> {
  // ENOENT propagates as a plain Error (code preserved) so callers can tell
  // "absent -> fresh" apart from "corrupt -> refuse". Parse/shape failures
  // become CorruptManifestError and must NEVER be silently reset to empty —
  // that would re-create/conflict-spam every previously-synced file.
  const raw = await readFile(join(rootDir, MANIFEST_PATH), "utf8");
  let parsed: WorkspaceManifest;
  try {
    parsed = JSON.parse(raw) as WorkspaceManifest;
  } catch {
    throw new CorruptManifestError("dohc sync manifest is not valid JSON.");
  }
  if (parsed.version !== 1 || !parsed.workspaceId || !parsed.backend) {
    throw new CorruptManifestError("dohc sync manifest is malformed.");
  }
  return parsed;
}

export async function writeManifest(rootDir: string, manifest: WorkspaceManifest) {
  const path = join(rootDir, MANIFEST_PATH);
  await mkdir(dirname(path), { recursive: true });
  // Atomic: temp + rename so a crash or the quit-path hard-exit never truncates
  // the baseline mid-write (a truncated manifest would wedge sync).
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(tmp, path);
}

export function assertSafeWorkspacePath(path: string): string {
  const clean = path.trim().replace(/\\/g, "/");
  if (!clean || isAbsolute(clean) || clean.startsWith("/") || clean.split("/").includes("..")) {
    throw new Error(`invalid path: ${path}`);
  }
  return clean;
}

export function resolveWorkspacePath(rootDir: string, path: string): string {
  const clean = assertSafeWorkspacePath(path);
  const root = resolve(rootDir);
  const resolved = resolve(root, clean);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path traversal rejected: ${path}`);
  }
  return resolved;
}

export function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Delegates to the ONE extension -> media-type table in workspace-core;
// sync metadata needs a concrete type, so unknown extensions become
// octet-stream here.
export function mediaTypeForPath(path: string): string {
  return coreMediaTypeForPath(path) ?? "application/octet-stream";
}

export function isSqliteMediaType(mediaType: string, path = "") {
  const type = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  const name = basename(path).toLowerCase();
  const extension = name.match(/(\.[^.]+)$/)?.[1] ?? "";
  return (
    type === "application/vnd.sqlite3" ||
    type === "application/x-sqlite3" ||
    type === "application/x-sqlite" ||
    type === "application/sqlite3" ||
    type === "application/sqlite" ||
    type === "sqlite" ||
    type.endsWith("+sqlite") ||
    type.endsWith("/sqlite") ||
    extension === ".sqlite" ||
    extension === ".sqlite3" ||
    extension === ".db"
  );
}

export function isTextMediaType(mediaType: string, path = "") {
  const lower = `${mediaType} ${path}`.toLowerCase();
  return (
    !isSqliteMediaType(mediaType, path) &&
    (lower.includes("text/") ||
      lower.includes("json") ||
      lower.includes("csv") ||
      lower.endsWith(".md") ||
      lower.endsWith(".markdown") ||
      lower.endsWith(".txt"))
  );
}

export function atomKindForMediaType(mediaType: string, path: string): AtomKind {
  const lower = `${mediaType} ${path}`.toLowerCase();
  if (lower.includes("csv") || lower.endsWith(".csv")) return "csv";
  if (lower.includes("json") || lower.endsWith(".json")) return "json";
  if (lower.includes("html") || lower.endsWith(".html")) return "html";
  if (lower.includes("text/plain") || lower.endsWith(".txt")) return "text";
  return "markdown";
}

export function assetKindForMediaType(mediaType: string, path: string): AssetKind {
  const lower = `${mediaType} ${path}`.toLowerCase();
  if (isSqliteMediaType(mediaType, path)) return "sqlite";
  if (lower.includes("image/")) return "image";
  if (lower.includes("audio/")) return "audio";
  if (lower.includes("video/")) return "video";
  if (lower.includes("pdf")) return "pdf";
  if (lower.includes("csv")) return "csv";
  if (lower.includes("json")) return "json";
  return "file";
}
