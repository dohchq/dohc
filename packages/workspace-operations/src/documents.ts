import type { CliResultByVerb } from "@dohc/cli/protocol";
import {
  hasEngineIgnoredSegment, matchesFileListingScope, validateUserReadPath, type WorkspaceFileListingScope,
} from "@dohc/workspace-contracts/workspace-paths";
import { failure, pathRejected, type ErrorDetail } from "./results";

// Live Markdown documents. The host answers through the session that holds a
// document, and rejects when it cannot read one.
export interface DocumentsHost {
  read(path: string): Promise<{ path: string; markdown: string }>;
}

export function documentsUnavailable() {
  return {
    ok: false as const,
    reason: "documents are not available in this workspace",
  };
}

// `path` is workspace-relative. `platform` is the one whose path rules apply.
// A failed read rejects, so the caller words the failure.
export async function readDocument(
  documents: DocumentsHost | undefined,
  path: string,
  platform: string,
): Promise<CliResultByVerb["documentRead"]> {
  if (!documents) return documentsUnavailable();
  const validated = validateUserReadPath(path, { platform });
  if (!validated.ok) return pathRejected(validated.reason, path);
  return { ok: true as const, ...(await documents.read(validated.normalized)) };
}

/** One file in the workspace. */
export interface WorkspaceFile {
  path: string;
  objectId: string;
  contentKind: "text" | "binary";
  /** Null when the host does not know it. */
  byteLength: number | null;
}

/** What the host found at a path it was asked to read as text. */
export type FileTextRead =
  | { kind: "text"; text: string; byteLength: number }
  | { kind: "binary" }
  | { kind: "missing" };

// The workspace's files, as one snapshot of them holds them. The host lists
// regular files only, never a link, and rejects when it cannot read.
export interface FilesHost {
  list(): Promise<readonly WorkspaceFile[]>;
  readText(path: string): Promise<FileTextRead>;
  /** The largest text file a read answers. */
  maxTextBytes: number;
  errorDetail: ErrorDetail;
}

export type FileListResult =
  | { ok: true; files: WorkspaceFile[]; folders: string[] }
  | { ok: false; reason: string };

export type TextReadResult =
  | { ok: true; path: string; text: string }
  | { ok: false; reason: string; refusal?: "binary" | "too-large" };

const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The files and folders in `scope`, by the desktop's listing rules: a path
 * with an ignored segment is left out, the scope matches literally and
 * case-sensitively, and both lists are in lexical order. A folder is listed
 * when a file below it is. The scope's path is checked as a read path.
 */
export async function listFiles(files: FilesHost, scope: WorkspaceFileListingScope, platform: string): Promise<FileListResult> {
  let root = ".";
  if (scope.path !== undefined && scope.path !== ".") {
    const validated = validateUserReadPath(scope.path, { platform });
    if (!validated.ok) return pathRejected(validated.reason, scope.path);
    root = validated.normalized;
  }
  const within: WorkspaceFileListingScope = { path: root, ...(scope.recursive === undefined ? {} : { recursive: scope.recursive }) };
  let listed: readonly WorkspaceFile[];
  try {
    listed = (await files.list()).filter((file) => !hasEngineIgnoredSegment(file.path, platform));
  } catch (error) {
    return failure(error, "failed to list files", files.errorDetail);
  }
  const folders = new Set<string>();
  for (const file of listed) {
    const segments = file.path.split("/");
    for (let end = 1; end < segments.length; end += 1) {
      const folder = segments.slice(0, end).join("/");
      if (matchesFileListingScope(folder, within)) folders.add(folder);
    }
  }
  return {
    ok: true,
    files: listed.filter((file) => matchesFileListingScope(file.path, within)).map((file) => ({ ...file }))
      .sort((a, b) => lexical(a.path, b.path)),
    folders: [...folders].sort(lexical),
  };
}

/** A text file's contents. A binary file, and one over the host's limit, answer a refusal that names why. */
export async function readText(files: FilesHost, path: string, platform: string): Promise<TextReadResult> {
  const validated = validateUserReadPath(path, { platform });
  if (!validated.ok) return pathRejected(validated.reason, path);
  const normalized = validated.normalized;
  let read: FileTextRead;
  try {
    read = await files.readText(normalized);
  } catch (error) {
    return failure(error, `failed to read file: ${normalized}`, files.errorDetail);
  }
  if (read.kind === "missing") return { ok: false, reason: `dohc: No file at ${normalized}.` };
  if (read.kind === "binary") return { ok: false, reason: `dohc: ${normalized} is not a text file.`, refusal: "binary" };
  if (read.byteLength > files.maxTextBytes) {
    return { ok: false, reason: `dohc: ${normalized} is larger than ${files.maxTextBytes} bytes.`, refusal: "too-large" };
  }
  return { ok: true, path: normalized, text: read.text };
}
