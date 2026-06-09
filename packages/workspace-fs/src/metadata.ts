import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AssetKind, AtomKind, WorkspaceFile } from "@dohc/workspace-contracts";

export type WorkspaceBackendMode = "convex" | "postgres";

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
  files: Record<string, WorkspaceManifestEntry>;
};

export const MANIFEST_PATH = ".dohc/manifest.json";

export async function readManifest(rootDir: string): Promise<WorkspaceManifest> {
  const raw = await readFile(join(rootDir, MANIFEST_PATH), "utf8");
  const parsed = JSON.parse(raw) as WorkspaceManifest;
  if (parsed.version !== 1 || !parsed.workspaceId || !parsed.backend) {
    throw new Error("Invalid dohc workspace manifest.");
  }
  return parsed;
}

export async function writeManifest(rootDir: string, manifest: WorkspaceManifest) {
  const path = join(rootDir, MANIFEST_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
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

export function mediaTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".jsonl")) return "application/x-ndjson";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".sqlite") || lower.endsWith(".sqlite3") || lower.endsWith(".db")) {
    return "application/vnd.sqlite3";
  }
  return "application/octet-stream";
}

export function isSqliteMediaType(mediaType: string, path = "") {
  const lower = `${mediaType} ${path}`.toLowerCase();
  return lower.includes("sqlite") || lower.endsWith(".sqlite") || lower.endsWith(".sqlite3") || lower.endsWith(".db");
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
