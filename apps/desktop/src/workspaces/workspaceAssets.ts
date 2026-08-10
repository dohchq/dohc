import {
  validateUserMaterializePath,
  validateUserReadPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { existingAncestor } from "./workspaceFiles";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";

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

function assertWriteNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Workspace write was cancelled.");
}

// Resolves a workspace-relative path to a real absolute path inside the
// workspace, enforcing path-safety and real-path containment — a renderer
// can never resolve a path that escapes the root or follows a symlink out.
// `access` picks the lexical validator: "write" (the default — fail closed)
// refuses the reserved shared-with-me projection; "read" allows it (share
// mounts exist to be read) while keeping every other guard identical.
export async function resolveWorkspaceFile(
  rootPath: string,
  relativePath: string,
  access: "read" | "write" = "write",
): Promise<{ realTarget: string; normalized: string }> {
  const validated =
    access === "read"
      ? validateUserReadPath(relativePath)
      : validateUserWritePath(relativePath);
  if (!validated.ok) {
    throw new Error(`Invalid asset path (${validated.reason}): ${relativePath}`);
  }
  // This resolver FOLLOWS the path (it hands back a path every caller then
  // opens), so an in-workspace alias reads or writes whatever it points at.
  // The reservation is therefore decided on where the path lands, and the
  // caller receives THAT resolution — resolving the spelling a second time
  // would hand back a target no rule was applied to.
  const { resolvedAbsolute } = await assertResolvedWorkspacePath({
    rootPath,
    absolutePath: join(rootPath, validated.normalized),
    spelled: relativePath,
    label: "Asset path",
    access,
  });
  // Every caller needs a file that is already there: the OS opener is handed
  // one, the editor's save renames onto one, and the database paths open one.
  // The walk answers for a target that does not exist yet, so the existence
  // proof is made here, on the canonical path.
  await stat(resolvedAbsolute);
  return { realTarget: resolvedAbsolute, normalized: validated.normalized };
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
    "read",
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

function siblingTempPath(target: string, now: number, uniqueId: string): string {
  return join(
    dirname(target),
    `.dohc-write-${process.pid}-${now}-${uniqueId}.tmp`,
  );
}

export function createAtomicTextWriter(deps: {
  now: () => number;
  uniqueId: () => string;
  writeFile: (temp: string, text: string) => Promise<void>;
  rename: (temp: string, target: string) => Promise<void>;
  remove: (temp: string) => Promise<void>;
}) {
  return async (target: string, text: string): Promise<void> => {
    const temp = siblingTempPath(target, deps.now(), deps.uniqueId());
    let committed = false;
    try {
      await deps.writeFile(temp, text);
      await deps.rename(temp, target);
      committed = true;
    } finally {
      if (!committed) await deps.remove(temp).catch(() => undefined);
    }
  };
}

async function enqueueOrdered(
  tails: Map<string, Promise<void>>,
  key: string,
  run: () => Promise<void>,
): Promise<void> {
  const previous = tails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  try {
    await current;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}

export function createOrderedWorkspaceTextWriter(deps: {
  resolveTarget: (rootPath: string, relativePath: string) => Promise<string>;
  writeTarget: (target: string, text: string) => Promise<void>;
}) {
  const rootTails = new Map<string, Promise<void>>();
  const targetTails = new Map<string, Promise<void>>();
  const pathKey = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;

  return async (rootPath: string, relativePath: string, text: string): Promise<void> => {
    // Different relative spellings can resolve to one file. Queue before
    // resolution at workspace scope, then admit the resolved write in that
    // order. The target queue owns the write so other files can proceed.
    let admittedWrite!: Promise<void>;
    await enqueueOrdered(rootTails, pathKey(rootPath), async () => {
      const target = await deps.resolveTarget(rootPath, relativePath);
      admittedWrite = enqueueOrdered(targetTails, pathKey(target), () =>
        deps.writeTarget(target, text),
      );
    });
    await admittedWrite;
  };
}

const atomicTextWriter = createAtomicTextWriter({
  now: Date.now,
  uniqueId: randomUUID,
  writeFile: async (temp, text) => writeFile(temp, text, "utf8"),
  rename,
  remove: async (temp) => rm(temp, { force: true }),
});

const orderedWorkspaceTextWriter = createOrderedWorkspaceTextWriter({
  resolveTarget: async (rootPath, relativePath) =>
    (await resolveWorkspaceFile(rootPath, relativePath)).realTarget,
  writeTarget: atomicTextWriter,
});

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
  await orderedWorkspaceTextWriter(rootPath, relativePath, text);
}

// Binary sibling of restoreWorkspaceText: writes image (or other asset) bytes
// pasted/dropped into the editor next to the current document. Same validation,
// parent-dir creation, and real-path containment as text writes — a renderer
// can never write outside the workspace or follow a symlink out — plus a 20MB
// cap so a giant paste can't wedge the main process.
const MAX_ASSET_WRITE_BYTES = 20 * 1024 * 1024;

// The security-critical write core shared by asset and restore writes:
// validate → realpath-contain (via the nearest existing ancestor, since the
// target/parent may not exist yet) → mkdir → re-contain the now-real parent
// (defeats a symlink swapped in during mkdir) → atomic temp+rename. Kept in
// ONE place so a future hardening tweak can't be applied to one caller and
// silently miss the other. `kind` only feeds the error strings.
async function writeContainedFile(
  rootPath: string,
  relativePath: string,
  data: Uint8Array | string,
  kind: "asset" | "restore",
  options: { exclusive?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const { exclusive = false, signal } = options;
  assertWriteNotAborted(signal);
  const label = kind === "asset" ? "Asset" : "Restore";
  const validated = validateUserMaterializePath(relativePath);
  if (!validated.ok) {
    throw new Error(`Invalid ${kind} path (${validated.reason}): ${relativePath}`);
  }
  // The commit mode decides the semantics, because the two modes treat the
  // leaf differently. The ordinary path renames over it, which replaces the
  // entry and never follows -- so a tampered leaf is the thing being repaired,
  // and refusing it would fail the restore on the very file it fixes.
  //
  // `wx` does NOT refuse every existing entry: on a DANGLING link it follows
  // the link and creates its target (measured, not assumed). So the exclusive
  // path must judge the leaf, and a planted `note.md -> .dohc/x` is refused
  // rather than followed. A live link there still answers EEXIST.
  const { resolvedAbsolute: absolute } = await assertResolvedWorkspacePath({
    rootPath,
    absolutePath: join(rootPath, validated.normalized),
    spelled: relativePath,
    label: `${label} path`,
    access: exclusive ? "write" : "entry",
  });
  const realRoot = await realpath(rootPath);
  assertWriteNotAborted(signal);
  // Everything below works on the resolution the guard judged: the mkdir, the
  // staging file, and the commit. Rebuilding the path from the spelling would
  // let an ancestor alias swapped after the check redirect all three.
  const parent = dirname(absolute);
  if (!isInside(realRoot, await existingAncestor(parent))) {
    throw new Error(`${label} path escapes workspace: ${relativePath}`);
  }
  assertWriteNotAborted(signal);
  await mkdir(parent, { recursive: true });
  assertWriteNotAborted(signal);
  if (!isInside(realRoot, await realpath(parent))) {
    throw new Error(`${label} path escapes workspace: ${relativePath}`);
  }
  assertWriteNotAborted(signal);
  if (exclusive) {
    const handle = await open(absolute, "wx");
    try {
      assertWriteNotAborted(signal);
      if (typeof data === "string") {
        await handle.writeFile(data, "utf8");
      } else {
        await handle.writeFile(data);
      }
      assertWriteNotAborted(signal);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(absolute, { force: true }).catch(() => undefined);
      throw error;
    }
    await handle.close();
    return;
  }
  const temp = siblingTempPath(absolute, Date.now(), randomUUID());
  try {
    assertWriteNotAborted(signal);
    if (typeof data === "string") {
      await writeFile(temp, data, "utf8");
    } else {
      await writeFile(temp, data);
    }
    assertWriteNotAborted(signal);
    await rename(temp, absolute);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

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
  await writeContainedFile(rootPath, relativePath, bytes, "asset");
}

export async function restoreWorkspaceText(
  rootPath: string,
  relativePath: string,
  text: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new Error(`Text exceeds the ${MAX_TEXT_BYTES}-byte editor limit`);
  }
  await writeContainedFile(rootPath, relativePath, text, "restore", options);
}

// Creates a text file with the filesystem's exclusive-create primitive. This
// keeps `overwrite: false` correct under concurrent callers; a preflight stat
// followed by an ordinary write would allow both requests to win the race.
export async function createWorkspaceTextExclusive(
  rootPath: string,
  relativePath: string,
  text: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new Error(`Text exceeds the ${MAX_TEXT_BYTES}-byte editor limit`);
  }
  await writeContainedFile(rootPath, relativePath, text, "restore", {
    exclusive: true,
    ...options,
  });
}

export async function readWorkspaceText(
  rootPath: string,
  relativePath: string,
): Promise<{ text: string; truncated: boolean }> {
  const { realTarget } = await resolveWorkspaceFile(rootPath, relativePath, "read");
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
