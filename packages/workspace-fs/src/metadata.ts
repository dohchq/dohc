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

// Extensions that are text whatever the media type says: data formats and the
// common code and configuration formats. An unlisted extension the media table
// doesn't know stays binary. A file here that isn't valid UTF-8 is still
// stored as binary. The engine's `TEXT_EXTENSIONS` is the same list, and
// `text-media-cases.json` holds both rules to the same answers.
const TEXT_EXTENSIONS = new Set([
  // Data and documents.
  ".json", ".geojson", ".json5", ".json-seq", ".jsonl", ".ndjson", ".csv", ".excalidraw", ".md", ".markdown", ".txt",
  // Code.
  ".ts", ".tsx", ".cts", ".mts", ".vue", ".svelte", ".astro", ".less", ".sass",
  ".py", ".pyi", ".rs", ".go", ".java", ".kt", ".kts", ".scala", ".groovy", ".gradle",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".cs", ".swift",
  ".rb", ".php", ".pl", ".pm", ".lua", ".r", ".dart", ".ex", ".exs", ".erl", ".hrl", ".hs",
  ".clj", ".cljs", ".cljc", ".edn", ".zig", ".sql", ".graphql", ".gql", ".proto",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".bat", ".cmd",
  // Configuration.
  ".toml", ".yaml", ".yml", ".ini", ".cfg", ".conf", ".properties", ".xml", ".tf", ".hcl", ".nix",
  ".editorconfig", ".gitignore", ".gitattributes", ".dockerignore", ".nvmrc",
]);

export function isTextMediaType(mediaType: string, path = "") {
  const type = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = fileName(path).toLowerCase().match(/(\.[^.]+)$/)?.[1] ?? "";
  return (
    !isSqliteMediaType(mediaType, path) &&
    (type.startsWith("text/") ||
      type.endsWith("/json") ||
      type.endsWith("+json") ||
      type === "application/x-ndjson" ||
      type === "application/ndjson" ||
      type === "application/csv" ||
      type === "application/x-csv" ||
      isSiteSourcePath(path) ||
      TEXT_EXTENSIONS.has(extension))
  );
}
