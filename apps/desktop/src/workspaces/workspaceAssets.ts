import { validateUserWritePath } from "@dohc/workspace-core";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { join } from "node:path";
import { existingAncestor } from "./workspaceFiles";

// Media types served to the renderer for binary assets. Kept small and
// explicit — only types a view actually renders (image/audio src, pdf);
// anything unknown is served as octet-stream (download, never executed).
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

// Media views buffer the whole file into the privileged main process before
// serving — cap it so one oversized file can't OOM/freeze the app (same
// reasoning as MAX_TEXT_BYTES, sized for real images/audio).
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

// Reads a workspace-relative file's bytes.
export async function readWorkspaceAsset(
  rootPath: string,
  relativePath: string,
): Promise<{ bytes: Buffer; mediaType: string }> {
  const { realTarget, normalized } = await resolveWorkspaceFile(
    rootPath,
    relativePath,
  );
  const { size } = await stat(realTarget);
  if (size > MAX_ASSET_BYTES) {
    throw new Error(`Asset too large to serve (${size} bytes): ${relativePath}`);
  }
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

// The editor's save path: same validation + real-path containment as reads,
// atomic temp+rename so the watcher (and any reader) never sees a torn file,
// and the same byte bound as reads — the editor can never write a file it
// couldn't have loaded.
export async function writeWorkspaceText(
  rootPath: string,
  relativePath: string,
  text: string,
): Promise<void> {
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new Error(`Text exceeds the ${MAX_TEXT_BYTES}-byte editor limit`);
  }
  const { realTarget } = await resolveWorkspaceFile(rootPath, relativePath);
  const { writeFile, rename } = await import("node:fs/promises");
  // .tmp.<suffix> matches the watcher's editor-noise filter, so autosave
  // staging files never pollute history.
  const temp = `${realTarget}.tmp.${process.pid}-${Date.now()}`;
  await writeFile(temp, text, "utf8");
  await rename(temp, realTarget);
}

// Binary sibling of restoreWorkspaceText: writes image (or other asset) bytes
// pasted/dropped into the editor next to the current document. Same validation,
// parent-dir creation, and real-path containment as text writes — a renderer
// can never write outside the workspace or follow a symlink out — plus a 20MB
// cap so a giant paste can't wedge the main process.
const MAX_ASSET_WRITE_BYTES = 20 * 1024 * 1024;

export async function writeWorkspaceAsset(
  rootPath: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.byteLength > MAX_ASSET_WRITE_BYTES) {
    throw new Error(
      `Asset exceeds the ${MAX_ASSET_WRITE_BYTES}-byte write limit`,
    );
  }
  const validated = validateUserWritePath(relativePath);
  if (!validated.ok) {
    throw new Error(`Invalid asset path (${validated.reason}): ${relativePath}`);
  }
  const realRoot = await realpath(rootPath);
  const absolute = join(rootPath, validated.normalized);
  const parent = dirname(absolute);
  if (!isInside(realRoot, await existingAncestor(parent))) {
    throw new Error(`Asset path escapes workspace: ${relativePath}`);
  }
  await mkdir(parent, { recursive: true });
  if (!isInside(realRoot, await realpath(parent))) {
    throw new Error(`Asset path escapes workspace: ${relativePath}`);
  }
  const { rename, writeFile } = await import("node:fs/promises");
  const temp = `${absolute}.tmp.${process.pid}-${Date.now()}`;
  await writeFile(temp, bytes);
  await rename(temp, absolute);
}

export async function restoreWorkspaceText(
  rootPath: string,
  relativePath: string,
  text: string,
): Promise<void> {
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new Error(`Text exceeds the ${MAX_TEXT_BYTES}-byte editor limit`);
  }
  const validated = validateUserWritePath(relativePath);
  if (!validated.ok) {
    throw new Error(`Invalid restore path (${validated.reason}): ${relativePath}`);
  }
  const realRoot = await realpath(rootPath);
  const absolute = join(rootPath, validated.normalized);
  const parent = dirname(absolute);
  if (!isInside(realRoot, await existingAncestor(parent))) {
    throw new Error(`Restore path escapes workspace: ${relativePath}`);
  }
  await mkdir(parent, { recursive: true });
  if (!isInside(realRoot, await realpath(parent))) {
    throw new Error(`Restore path escapes workspace: ${relativePath}`);
  }
  const { rename, writeFile } = await import("node:fs/promises");
  const temp = `${absolute}.tmp.${process.pid}-${Date.now()}`;
  await writeFile(temp, text, "utf8");
  await rename(temp, absolute);
}

export async function readWorkspaceText(
  rootPath: string,
  relativePath: string,
): Promise<{ text: string; truncated: boolean }> {
  const { realTarget } = await resolveWorkspaceFile(rootPath, relativePath);
  const info = await stat(realTarget);
  if (!info.isFile()) {
    throw new Error(`Text path is not a file: ${relativePath}`);
  }
  // Bounded read: only the first MAX_TEXT_BYTES (+1 byte to detect overflow)
  // ever enters memory, so a multi-GB file can't freeze the main process.
  const handle = await open(realTarget, "r");
  try {
    const buf = Buffer.alloc(MAX_TEXT_BYTES + 1);
    let totalBytesRead = 0;
    while (totalBytesRead < buf.length) {
      const { bytesRead } = await handle.read(
        buf,
        totalBytesRead,
        buf.length - totalBytesRead,
        totalBytesRead,
      );
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
    }
    const truncated = totalBytesRead > MAX_TEXT_BYTES || info.size > MAX_TEXT_BYTES;
    const slice = buf.subarray(0, Math.min(totalBytesRead, MAX_TEXT_BYTES));
    return { text: slice.toString("utf8"), truncated };
  } finally {
    await handle.close();
  }
}
