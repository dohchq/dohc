import { isAbsolute } from "node:path";
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

// Delegates to the one extension -> media-type table in workspace-core;
// sync metadata needs a concrete type, so unknown extensions become
// octet-stream here.
export function mediaTypeForPath(path: string): string {
  return (
    coreMediaTypeForPath(path) ??
    (isSiteSourcePath(path) ? "text/plain" : "application/octet-stream")
  );
}

// The name after the last "/" or "\", split the way the engine's
// `crates/dohc-engine-files/src/media.rs` splits it on every platform.
function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

export function isSqliteMediaType(mediaType: string, path = "") {
  const type = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  const name = fileName(path).toLowerCase();
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

// The Collection files that dohc reads and writes as text. The media table
// has no entry for `.yaml`, so these names are text by rule. The engine's
// `is_text_media_type` holds the same list, and `text-media-cases.json`
// holds both rules to the same answers.
const COLLECTION_TEXT_FILENAMES = new Set(["collection.yaml", "automations.yaml"]);

export function isTextMediaType(mediaType: string, path = "") {
  const lower = `${mediaType} ${path}`.toLowerCase();
  return (
    !isSqliteMediaType(mediaType, path) &&
    (COLLECTION_TEXT_FILENAMES.has(fileName(path)) ||
      lower.includes("text/") ||
      lower.includes("json") ||
      lower.includes("csv") ||
      isSiteSourcePath(path) ||
      lower.endsWith(".md") ||
      lower.endsWith(".markdown") ||
      lower.endsWith(".sh") ||
      lower.endsWith(".txt"))
  );
}
