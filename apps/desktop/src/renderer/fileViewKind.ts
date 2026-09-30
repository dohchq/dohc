import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { extensionOf } from "./path";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);
const AUDIO_EXT = new Set(["m4a", "mp3", "wav", "ogg"]);
const DB_EXT = new Set(["sqlite", "sqlite3", "db"]);
const TABLE_EXT = new Set(["csv", "tsv", "tab"]);
const TEXT_EXT = new Set([
  "md",
  "markdown",
  "txt",
  "json",
  "html",
  "htm",
  "xml",
  "css",
  "scss",
  "sass",
  "less",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "log",
  "sql",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
]);

type FileViewKind =
  | "markdown"
  | "drawing"
  | "csv"
  | "json"
  | "text"
  | "image"
  | "audio"
  | "pdf"
  | "database"
  | "binary";

export function classifyForView(path: string): FileViewKind {
  const ext = extensionOf(path);
  if (liveDocumentKindForPath(path) === "richdoc") return "markdown";
  if (ext === "excalidraw") return "drawing";
  if (TABLE_EXT.has(ext)) return "csv";
  if (ext === "json") return "json";
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (DB_EXT.has(ext)) return "database";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}
