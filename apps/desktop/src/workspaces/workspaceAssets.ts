import { validateUserWritePath } from "@dohc/workspace-core";
import { open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { join } from "node:path";

// Media types served to the renderer for binary assets. Kept small and
// explicit — anything unknown is served as octet-stream (download, never
// executed in the renderer).
const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
};

export function mediaTypeForExtension(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MEDIA_TYPES[ext] ?? "application/octet-stream";
}

function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return (
    rel.length > 0 &&
    !isAbsolute(rel) &&
    !rel.startsWith("..") &&
    !rel.startsWith(sep)
  );
}

// Resolves a workspace-relative path to a real absolute path inside the
// workspace, enforcing path-safety and real-path containment — a renderer
// can never resolve a path that escapes the root or follows a symlink out.
export async function resolveWorkspaceFile(
  rootPath: string,
  relativePath: string,
): Promise<{ realTarget: string; normalized: string }> {
  const validated = validateUserWritePath(relativePath);
  if (!validated.ok) {
    throw new Error(`Invalid asset path (${validated.reason}): ${relativePath}`);
  }
  const realRoot = await realpath(rootPath);
  const realTarget = await realpath(join(rootPath, validated.normalized));
  if (!isInside(realRoot, realTarget)) {
    throw new Error(`Asset path escapes workspace: ${relativePath}`);
  }
  return { realTarget, normalized: validated.normalized };
}

// Reads a workspace-relative file's bytes.
export async function readWorkspaceAsset(
  rootPath: string,
  relativePath: string,
): Promise<{ bytes: Buffer; mediaType: string }> {
  const { realTarget, normalized } = await resolveWorkspaceFile(
    rootPath,
    relativePath,
  );
  return {
    bytes: await readFile(realTarget),
    mediaType: mediaTypeForExtension(normalized),
  };
}

// Text views (markdown/CSV/JSON/plain) read content over IPC rather than via a
// renderer fetch — a file:// renderer can't fetch a custom scheme. Capped so a
// huge file can't stream megabytes through IPC; oversize falls back to a
// download affordance in the renderer.
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export async function readWorkspaceText(
  rootPath: string,
  relativePath: string,
): Promise<{ text: string; truncated: boolean }> {
  const { realTarget } = await resolveWorkspaceFile(rootPath, relativePath);
  // Bounded read: only the first MAX_TEXT_BYTES (+1 byte to detect overflow)
  // ever enters memory, so a multi-GB file can't freeze the main process.
  const handle = await open(realTarget, "r");
  try {
    const buf = Buffer.alloc(MAX_TEXT_BYTES + 1);
    const { bytesRead } = await handle.read(buf, 0, MAX_TEXT_BYTES + 1, 0);
    const truncated = bytesRead > MAX_TEXT_BYTES;
    const slice = buf.subarray(0, Math.min(bytesRead, MAX_TEXT_BYTES));
    return { text: slice.toString("utf8"), truncated };
  } finally {
    await handle.close();
  }
}
