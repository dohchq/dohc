import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import {
  isSiteSourcePath,
  mediaTypeForPath as coreMediaTypeForPath,
} from "@dohc/workspace-core";

export function assertSafeWorkspacePath(path: string): string {
  const clean = path.trim().replace(/\\/g, "/");
  if (!clean || isAbsolute(clean) || clean.startsWith("/") || clean.split("/").includes("..")) {
    throw new Error(`invalid path: ${path}`);
  }
  return clean;
}

export function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Delegates to the one extension -> media-type table in workspace-core;
// sync metadata needs a concrete type, so unknown extensions become
// octet-stream here.
export function mediaTypeForPath(path: string): string {
  return (
    coreMediaTypeForPath(path) ??
    (isSiteSourcePath(path) ? "text/plain" : "application/octet-stream")
  );
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
      isSiteSourcePath(path) ||
      lower.endsWith(".md") ||
      lower.endsWith(".markdown") ||
      lower.endsWith(".sh") ||
      lower.endsWith(".txt"))
  );
}
