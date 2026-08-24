import {
  sameFsEntry,
  type FsEntryIdentity,
  validateUserMaterializePath,
  validateUserReadPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { TextDecoder } from "node:util";
import { isInside } from "../security/pathContainment";
import {
  BoundedFileReadChangedError,
  BoundedFileReadNotFileError,
  BoundedFileReadTooLargeError,
  BoundedFileReadUnverifiableError,
  readFileHandleExact,
  readFileHandleTruncated,
} from "./boundedFileRead";
import { existingAncestor } from "./workspaceFiles";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";
import { WORKSPACE_TEXT_EDITOR_MAX_BYTES } from "./workspaceTextLimits";

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

function assertWriteNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Workspace write was cancelled.");
}

// Resolves a workspace-relative path to a real absolute path inside the
// workspace, enforcing path-safety and real-path containment — a renderer
// can never resolve a path that escapes the root or follows a symlink out.
// `access` picks the lexical validator: "write" (the default — fail closed)
// refuses the reserved shared-with-me projection; "read" allows it (share
// mounts exist to be read) while keeping every other guard identical.
async function resolveWorkspaceFileTarget(
  rootPath: string,
  relativePath: string,
  access: "read" | "write" = "write",
): Promise<{
  realTarget: string;
  normalized: string;
  resolvedPath: string;
}> {
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
  const { relative: resolvedPath, resolvedAbsolute } =
    await assertResolvedWorkspacePath({
      rootPath,
      absolutePath: join(rootPath, validated.normalized),
      spelled: relativePath,
      label: "Asset path",
      access,
    });
  return {
    realTarget: resolvedAbsolute,
    normalized: validated.normalized,
    resolvedPath: resolvedPath.replaceAll("\\", "/"),
  };
}

export async function resolveWorkspaceFile(
  rootPath: string,
  relativePath: string,
  access: "read" | "write" = "write",
): Promise<{
  realTarget: string;
  normalized: string;
  resolvedPath: string;
}> {
  const target = await resolveWorkspaceFileTarget(
    rootPath,
    relativePath,
    access,
  );
  // Public callers need a file that is already there: the OS opener is handed
  // one, the editor's save renames onto one, and the database paths open one.
  // A prepared owner read delays this proof until after owner classification,
  // because canonical share bytes may exist while their projection does not.
  await stat(target.realTarget);
  return target;
}

// Media views buffer the whole file into the privileged main process before
// serving — cap it so one oversized file can't OOM/freeze the app (same
// reasoning as MAX_TEXT_BYTES, sized for real images/audio).
export const WORKSPACE_ASSET_MAX_BYTES = 64 * 1024 * 1024;

export interface WorkspaceAssetSource {
  /** The authoritative workspace-relative path after following aliases. */
  path: string;
  bytes: Buffer;
  mediaType: string;
}

const FILE_CHANGED_DURING_READ =
  "This file changed while dohc was reading it. Try again.";
const FILE_IDENTITY_UNVERIFIABLE =
  "dohc could not confirm this is the same file. Try again.";

function assertSameFile(
  expected: FsEntryIdentity,
  actual: FsEntryIdentity,
): void {
  const comparison = sameFsEntry(expected, actual);
  if (comparison === "replaced") {
    throw new Error(FILE_CHANGED_DURING_READ);
  }
  if (comparison === "unknown") {
    throw new Error(FILE_IDENTITY_UNVERIFIABLE);
  }
}

function throwWorkspaceBoundedReadError(error: unknown): never {
  if (error instanceof BoundedFileReadChangedError) {
    throw new Error(FILE_CHANGED_DURING_READ);
  }
  if (error instanceof BoundedFileReadUnverifiableError) {
    throw new Error(FILE_IDENTITY_UNVERIFIABLE);
  }
  if (error instanceof BoundedFileReadNotFileError) {
    throw new Error("This path is not a file. Choose a file and try again.");
  }
  throw error;
}

/** A read bound to the file identity captured after owner classification. */
export interface PreparedWorkspaceFileRead {
  readonly path: string;
  readAsset(): Promise<WorkspaceAssetSource>;
  readText(): Promise<WorkspaceTextReadResult>;
  withVerifiedPathSync<T>(
    run: (
      absolutePath: string,
    ) => T extends PromiseLike<unknown> ? never : T,
  ): Promise<T>;
}

export interface ResolvedWorkspaceFileRead {
  /** Canonical path for owner classification; no local file is opened yet. */
  readonly path: string;
  prepare(): Promise<PreparedWorkspaceFileRead>;
}

class PreparedWorkspaceFileReadCapability implements PreparedWorkspaceFileRead {
  readonly #rootPath: string;
  readonly #realTarget: string;
  readonly #resolvedPath: string;
  readonly #spelledPath: string;
  readonly #requestedPath: string;
  readonly #identity: FsEntryIdentity;

  constructor(input: {
    rootPath: string;
    realTarget: string;
    resolvedPath: string;
    spelledPath: string;
    requestedPath: string;
    identity: FsEntryIdentity;
  }) {
    this.#rootPath = input.rootPath;
    this.#realTarget = input.realTarget;
    this.#resolvedPath = input.resolvedPath;
    this.#spelledPath = input.spelledPath;
    this.#requestedPath = input.requestedPath;
    this.#identity = input.identity;
  }

  get path(): string {
    return this.#resolvedPath;
  }

  async #openVerified(): Promise<FileHandle> {
    let handle: FileHandle;
    try {
      handle = await open(this.#realTarget, "r");
    } catch {
      throw new Error(FILE_IDENTITY_UNVERIFIABLE);
    }
    try {
      let info;
      try {
        info = await handle.stat({ bigint: true });
      } catch {
        throw new Error(FILE_IDENTITY_UNVERIFIABLE);
      }
      assertSameFile(this.#identity, info);
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #withVerifiedHandle<T>(
    run: (handle: FileHandle) => T | Promise<T>,
  ): Promise<T> {
    const handle = await this.#openVerified();
    try {
      return await run(handle);
    } finally {
      await handle.close();
    }
  }

  readAsset(): Promise<WorkspaceAssetSource> {
    return this.#withVerifiedHandle(async (handle) => {
      let bytes: Buffer;
      try {
        bytes = (
          await readFileHandleExact(handle, WORKSPACE_ASSET_MAX_BYTES)
        ).bytes;
      } catch (error) {
        if (error instanceof BoundedFileReadTooLargeError) {
          throw new Error(
            `Asset too large to serve (${error.size} bytes): ${this.#spelledPath}`,
          );
        }
        throwWorkspaceBoundedReadError(error);
      }
      return {
        path: this.#resolvedPath,
        bytes,
        mediaType: mediaTypeForExtension(this.#requestedPath),
      };
    });
  }

  readText(): Promise<WorkspaceTextReadResult> {
    return withOrderedWorkspaceTargetPath(
      this.#rootPath,
      this.#realTarget,
      () => this.#withVerifiedHandle(readTextHandle),
    );
  }

  withVerifiedPathSync<T>(
    run: (
      absolutePath: string,
    ) => T extends PromiseLike<unknown> ? never : T,
  ): Promise<T> {
    return this.#withVerifiedHandle(async () => {
      await this.#assertCanonicalPath();
      try {
        const result = run(this.#realTarget);
        if (
          (typeof result === "object" || typeof result === "function") &&
          result !== null &&
          "then" in result &&
          typeof result.then === "function"
        ) {
          throw new Error(
            "Verified file path operations must finish synchronously.",
          );
        }
        return result;
      } finally {
        await this.#assertCanonicalPath();
      }
    });
  }

  async #assertCanonicalPath(): Promise<void> {
    let currentCanonical: string;
    let pathInfo;
    try {
      currentCanonical = await realpath(this.#realTarget);
      pathInfo = await stat(this.#realTarget, { bigint: true });
    } catch {
      throw new Error(FILE_IDENTITY_UNVERIFIABLE);
    }
    const pathKey = (value: string) =>
      process.platform === "win32" ? value.toLowerCase() : value;
    if (pathKey(currentCanonical) !== pathKey(this.#realTarget)) {
      throw new Error(FILE_CHANGED_DURING_READ);
    }
    assertSameFile(this.#identity, pathInfo);
  }
}

class ResolvedWorkspaceFileReadCapability implements ResolvedWorkspaceFileRead {
  readonly #rootPath: string;
  readonly #realTarget: string;
  readonly #resolvedPath: string;
  readonly #requestedPath: string;
  readonly #spelledPath: string;

  constructor(
    rootPath: string,
    realTarget: string,
    resolvedPath: string,
    requestedPath: string,
    spelledPath: string,
  ) {
    this.#rootPath = rootPath;
    this.#realTarget = realTarget;
    this.#resolvedPath = resolvedPath;
    this.#requestedPath = requestedPath;
    this.#spelledPath = spelledPath;
  }

  get path(): string {
    return this.#resolvedPath;
  }

  async prepare(): Promise<PreparedWorkspaceFileRead> {
    let handle: FileHandle;
    try {
      handle = await open(this.#realTarget, "r");
    } catch {
      throw new Error(FILE_IDENTITY_UNVERIFIABLE);
    }
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile()) {
        throw new Error(
          `This path is not a file: ${this.#spelledPath}. Choose a file and try again.`,
        );
      }
      let current: Awaited<ReturnType<typeof assertResolvedWorkspacePath>>;
      try {
        current = await assertResolvedWorkspacePath({
          rootPath: this.#rootPath,
          absolutePath: this.#realTarget,
          spelled: this.#spelledPath,
          label: "File path",
          access: "read",
        });
      } catch {
        throw new Error(FILE_IDENTITY_UNVERIFIABLE);
      }
      if (current.relative.replaceAll("\\", "/") !== this.#resolvedPath) {
        throw new Error(FILE_CHANGED_DURING_READ);
      }
      const identity: FsEntryIdentity = info;
      let pathInfo;
      try {
        pathInfo = await stat(current.resolvedAbsolute, { bigint: true });
      } catch {
        throw new Error(FILE_IDENTITY_UNVERIFIABLE);
      }
      assertSameFile(identity, pathInfo);
      return new PreparedWorkspaceFileReadCapability({
        rootPath: this.#rootPath,
        realTarget: this.#realTarget,
        resolvedPath: this.#resolvedPath,
        requestedPath: this.#requestedPath,
        spelledPath: this.#spelledPath,
        identity,
      });
    } finally {
      await handle.close();
    }
  }
}

export async function resolveWorkspaceFileRead(
  rootPath: string,
  relativePath: string,
): Promise<ResolvedWorkspaceFileRead> {
  const { realTarget, normalized, resolvedPath } =
    await resolveWorkspaceFileTarget(rootPath, relativePath, "read");
  return new ResolvedWorkspaceFileReadCapability(
    rootPath,
    realTarget,
    resolvedPath,
    normalized,
    relativePath,
  );
}

export function prepareWorkspaceFileRead(
  rootPath: string,
  relativePath: string,
): Promise<PreparedWorkspaceFileRead> {
  return resolveWorkspaceFileRead(rootPath, relativePath).then((source) =>
    source.prepare(),
  );
}

// Text views (markdown/CSV/JSON/plain) read content over IPC rather than via a
// renderer fetch — a file:// renderer can't fetch a custom scheme. Capped so a
// huge file can't stream megabytes through IPC; oversize falls back to a
// download affordance in the renderer.
const MAX_TEXT_BYTES = WORKSPACE_TEXT_EDITOR_MAX_BYTES;

export type WorkspaceTextReadResult =
  | { text: string; truncated: false; contentHash: string }
  | { text: string; truncated: true; contentHash: null };

export type WorkspaceTextWriteResult =
  | { status: "written"; contentHash: string }
  | { status: "conflict"; currentContentHash: string | null };

function hashContent(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function workspaceTextReadResultFromBytes(
  bytes: Buffer,
  totalByteLength = bytes.byteLength,
): WorkspaceTextReadResult {
  const truncated = totalByteLength > MAX_TEXT_BYTES;
  const content = bytes.subarray(0, Math.min(bytes.byteLength, MAX_TEXT_BYTES));
  if (truncated) {
    return {
      text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(content, {
        stream: true,
      }),
      truncated: true,
      contentHash: null,
    };
  }
  return {
    text: content.toString("utf8"),
    truncated: false,
    contentHash: hashContent(content),
  };
}

function isMissingTargetError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

class WorkspaceTextTargetMissingError extends Error {}

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
  readCurrentContentHash: (target: string) => Promise<string | null>;
}) {
  return async (
    target: string,
    text: string,
    expectedContentHash: string,
  ): Promise<WorkspaceTextWriteResult> => {
    const temp = siblingTempPath(target, deps.now(), deps.uniqueId());
    let committed = false;
    try {
      await deps.writeFile(temp, text);
      // Optimistic preimage check, not a filesystem compare-and-swap. An
      // uncooperative process can still change the target between this read
      // and the rename. A conflict means we observed a mismatch before the
      // atomic replacement; written means that replacement landed. The Rust
      // materializer records the same portable-filesystem limit as R04.
      const currentContentHash = await deps.readCurrentContentHash(target);
      if (currentContentHash !== expectedContentHash) {
        return { status: "conflict", currentContentHash };
      }
      await deps.rename(temp, target);
      committed = true;
      return { status: "written", contentHash: hashContent(text) };
    } finally {
      if (!committed) await deps.remove(temp).catch(() => undefined);
    }
  };
}

async function enqueueOrdered<T>(
  tails: Map<string, Promise<void>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  try {
    return await current;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}

type WorkspaceOperationEntry = {
  mode: "shared" | "exclusive";
  run: () => Promise<{ changed: boolean }>;
};

type WorkspaceOperationState = {
  activeShared: number;
  activeExclusive: boolean;
  generation: number;
  queue: WorkspaceOperationEntry[];
};

declare const workspaceOperationLeaseBrand: unique symbol;

/**
 * Proof that an operation holds the process-wide scheduler for one workspace
 * root. Received-share mutations require this proof so they cannot bypass the
 * same admission boundary used by ordinary workspace writes.
 */
export interface WorkspaceOperationLease {
  readonly rootPath: string;
  readonly [workspaceOperationLeaseBrand]: true;
}

class WorkspaceOperationSupersededError extends Error {
  constructor() {
    super(
      "A file or folder changed before this write started. Try the action again.",
    );
    this.name = "WorkspaceOperationSupersededError";
  }
}

export function createWorkspaceOperationScheduler() {
  const states = new Map<string, WorkspaceOperationState>();
  const activeLeases = new WeakMap<WorkspaceOperationLease, string>();
  const pathKey = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;

  const drain = (key: string, state: WorkspaceOperationState): void => {
    if (state.activeExclusive) return;
    if (state.queue.length === 0) {
      if (state.activeShared === 0) states.delete(key);
      return;
    }

    const releaseShared = () => {
      state.activeShared -= 1;
      drain(key, state);
    };
    const releaseExclusive = () => {
      state.activeExclusive = false;
      drain(key, state);
    };
    if (state.queue[0]?.mode === "exclusive") {
      if (state.activeShared > 0) return;
      const entry = state.queue.shift();
      if (!entry) return;
      state.activeExclusive = true;
      void entry.run().then(
        (outcome) => {
          if (outcome.changed) state.generation += 1;
          releaseExclusive();
        },
        releaseExclusive,
      );
      return;
    }

    // Admit the contiguous shared prefix together. Once an exclusive request
    // reaches the head, later shared requests wait behind it instead of
    // starving the workspace mutation.
    while (state.queue[0]?.mode === "shared") {
      const entry = state.queue.shift();
      if (!entry) break;
      state.activeShared += 1;
      void entry.run().then(releaseShared, releaseShared);
    }
  };

  const enqueue = <T>(
    rootPath: string,
    mode: "shared" | "exclusive",
    operation: (
      markChanged: () => void,
      lease: WorkspaceOperationLease,
    ) => Promise<T>,
    staleSensitive = false,
  ): Promise<T> => {
    const key = pathKey(rootPath);
    const state = states.get(key) ?? {
      activeShared: 0,
      activeExclusive: false,
      generation: 0,
      queue: [],
    };
    states.set(key, state);
    const admittedGeneration = state.generation;
    const result = new Promise<T>((resolve, reject) => {
      state.queue.push({
        mode,
        run: async () => {
          if (staleSensitive && state.generation !== admittedGeneration) {
            reject(new WorkspaceOperationSupersededError());
            return { changed: false };
          }
          let changed = false;
          const lease = Object.freeze({ rootPath }) as WorkspaceOperationLease;
          activeLeases.set(lease, key);
          try {
            const value = await operation(
              () => {
                changed = true;
              },
              lease,
            );
            if (mode === "exclusive") changed = true;
            resolve(value);
          } catch (error) {
            reject(error);
          } finally {
            activeLeases.delete(lease);
          }
          return { changed };
        },
      });
    });
    drain(key, state);
    return result;
  };

  return {
    shared: <T>(rootPath: string, operation: () => Promise<T>) =>
      enqueue(rootPath, "shared", () => operation()),
    staleSensitiveShared: <T>(
      rootPath: string,
      operation: (lease: WorkspaceOperationLease) => Promise<T>,
    ) =>
      enqueue(
        rootPath,
        "shared",
        (_markChanged, lease) => operation(lease),
        true,
      ),
    exclusive: <T>(
      rootPath: string,
      operation: (
        markChanged: () => void,
        lease: WorkspaceOperationLease,
      ) => Promise<T>,
    ) => enqueue(rootPath, "exclusive", operation),
    assertActiveLease: (
      rootPath: string,
      lease: WorkspaceOperationLease,
    ): void => {
      if (activeLeases.get(lease) !== pathKey(rootPath)) {
        throw new Error(
          "Workspace operation lease is inactive or belongs to another root.",
        );
      }
    },
  };
}

export type WorkspaceOperationScheduler = ReturnType<
  typeof createWorkspaceOperationScheduler
>;

export function createOrderedWorkspaceTextAccess(deps: {
  resolveTarget: (
    rootPath: string,
    relativePath: string,
    access: "read" | "write",
  ) => Promise<string>;
  readTarget: (target: string) => Promise<WorkspaceTextReadResult>;
  writeTarget: (
    target: string,
    text: string,
    expectedContentHash: string,
  ) => Promise<WorkspaceTextWriteResult>;
  scheduler?: WorkspaceOperationScheduler;
}) {
  const rootTails = new Map<string, Promise<void>>();
  const targetTails = new Map<string, Promise<void>>();
  const scheduler = deps.scheduler ?? createWorkspaceOperationScheduler();
  const pathKey = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;

  const admit = async <T>(
    rootPath: string,
    relativePath: string,
    access: "read" | "write",
    run: (target: string) => Promise<T>,
  ): Promise<T> => {
    // Different relative spellings can resolve to one file. Queue before
    // resolution at workspace scope, then admit the resolved operation in
    // that order. The target queue owns the operation so other files proceed.
    let admittedOperation!: Promise<T>;
    await enqueueOrdered(rootTails, pathKey(rootPath), async () => {
      const target = await deps.resolveTarget(rootPath, relativePath, access);
      admittedOperation = enqueueOrdered(targetTails, pathKey(target), () => run(target));
    });
    return admittedOperation;
  };

  return {
    read: (rootPath: string, relativePath: string) =>
      scheduler.shared(rootPath, () =>
        admit(rootPath, relativePath, "read", deps.readTarget),
      ),
    write: (
      rootPath: string,
      relativePath: string,
      text: string,
      expectedContentHash: string,
    ) =>
      scheduler.shared(rootPath, () =>
        admit(rootPath, relativePath, "write", (target) =>
          deps.writeTarget(target, text, expectedContentHash),
        ),
      ),
    // The same admission, for a save that does NOT land on disk here. A share
    // view's save goes through its engine store and then projects the result,
    // so it cannot call `write` — but two saves racing on one path must be
    // ordered just the same, or the second reads the first's stale bytes and
    // both pass their compare. Same queue, same key, same containment check.
    //
    // The operation is handed a reader for the ALREADY-RESOLVED target. It
    // must not reach back through `read`: that queues on this very target,
    // which this operation is holding, and the two wait on each other for
    // ever.
    ordered: <T>(
      rootPath: string,
      relativePath: string,
      run: (readCurrent: () => Promise<WorkspaceTextReadResult>) => Promise<T>,
    ) =>
      scheduler.shared(rootPath, () =>
        admit(rootPath, relativePath, "write", (target) =>
          run(() => deps.readTarget(target)),
        ),
      ),
    // The callback must not call read, write, or ordered for this resolved
    // target. Re-entering targetTails would deadlock on the lock it holds.
    orderedOnResolvedTarget: <T>(
      rootPath: string,
      resolvedTarget: string,
      run: () => Promise<T>,
    ): Promise<T> =>
      scheduler.shared(rootPath, () =>
        enqueueOrdered(targetTails, pathKey(resolvedTarget), run),
      ),
    // The caller already owns scheduler admission for this exact root. Taking
    // another shared admission can deadlock behind a queued exclusive request.
    orderedOnResolvedTargetInLease: <T>(
      rootPath: string,
      lease: WorkspaceOperationLease,
      resolvedTarget: string,
      run: () => Promise<T>,
    ): Promise<T> => {
      try {
        scheduler.assertActiveLease(rootPath, lease);
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueueOrdered(targetTails, pathKey(resolvedTarget), run);
    },
  };
}

async function readTextHandle(
  handle: FileHandle,
): Promise<WorkspaceTextReadResult> {
  try {
    const result = await readFileHandleTruncated(handle, MAX_TEXT_BYTES);
    return workspaceTextReadResultFromBytes(
      result.bytes,
      result.totalByteLength,
    );
  } catch (error) {
    throwWorkspaceBoundedReadError(error);
  }
}

async function readTextTarget(target: string): Promise<WorkspaceTextReadResult> {
  const handle = await open(target, "r");
  try {
    return await readTextHandle(handle);
  } finally {
    await handle.close();
  }
}

async function readCurrentContentHash(target: string): Promise<string | null> {
  try {
    return (await readTextTarget(target)).contentHash;
  } catch (error) {
    if (isMissingTargetError(error)) return null;
    throw error;
  }
}

const atomicTextWriter = createAtomicTextWriter({
  now: Date.now,
  uniqueId: randomUUID,
  writeFile: async (temp, text) => writeFile(temp, text, "utf8"),
  rename,
  remove: async (temp) => rm(temp, { force: true }),
  readCurrentContentHash,
});

const workspaceOperationScheduler = createWorkspaceOperationScheduler();

const orderedWorkspaceTextAccess = createOrderedWorkspaceTextAccess({
  resolveTarget: async (rootPath, relativePath, access) => {
    try {
      return (await resolveWorkspaceFile(rootPath, relativePath, access)).realTarget;
    } catch (error) {
      if (access === "write" && isMissingTargetError(error)) {
        throw new WorkspaceTextTargetMissingError();
      }
      throw error;
    }
  },
  readTarget: readTextTarget,
  writeTarget: atomicTextWriter,
  scheduler: workspaceOperationScheduler,
});

/**
 * Run an operation under the SAME per-file ordering the editor's own save
 * takes. For a writer whose bytes do not reach disk through
 * `writeWorkspaceText` — today, a share view's save, which writes an engine
 * moment and then projects it.
 *
 * The operation reads the file through the `readCurrent` it is handed, never
 * through `readWorkspaceText`: that would queue on the target this operation
 * is holding and deadlock.
 *
 * A target that is not there resolves to `null` rather than throwing, which is
 * the same answer the disk writer turns into a conflict.
 */
export function withOrderedWorkspaceTextPath<T>(
  rootPath: string,
  relativePath: string,
  run: (readCurrent: () => Promise<WorkspaceTextReadResult>) => Promise<T>,
): Promise<T | { status: "conflict"; currentContentHash: null }> {
  return orderedWorkspaceTextAccess
    .ordered(rootPath, relativePath, run)
    .catch((error: unknown) => {
      if (error instanceof WorkspaceTextTargetMissingError) {
        return { status: "conflict" as const, currentContentHash: null };
      }
      throw error;
    });
}

export function withOrderedWorkspaceTargetPath<T>(
  rootPath: string,
  resolvedTarget: string,
  run: () => Promise<T>,
): Promise<T> {
  return orderedWorkspaceTextAccess.orderedOnResolvedTarget(
    rootPath,
    resolvedTarget,
    run,
  );
}

export function withOrderedWorkspaceTargetPathInLease<T>(
  rootPath: string,
  lease: WorkspaceOperationLease,
  resolvedTarget: string,
  run: () => Promise<T>,
): Promise<T> {
  return orderedWorkspaceTextAccess.orderedOnResolvedTargetInLease(
    rootPath,
    lease,
    resolvedTarget,
    run,
  );
}

export function withExclusiveWorkspaceOperation<T>(
  rootPath: string,
  operation: (
    markChanged: () => void,
    lease: WorkspaceOperationLease,
  ) => Promise<T>,
): Promise<T> {
  return workspaceOperationScheduler.exclusive(rootPath, operation);
}

export function withStaleSensitiveWorkspaceOperation<T>(
  rootPath: string,
  operation: (lease: WorkspaceOperationLease) => Promise<T>,
): Promise<T> {
  return workspaceOperationScheduler.staleSensitiveShared(rootPath, operation);
}

// The editor's save path: same validation + real-path containment as reads,
// atomic temp+rename so the watcher (and any reader) never sees a torn file,
// and the same byte bound as reads — the editor can never write a file it
// couldn't have loaded.
export async function writeWorkspaceText(
  rootPath: string,
  relativePath: string,
  text: string,
  expectedContentHash: string,
): Promise<WorkspaceTextWriteResult> {
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new Error(`Text exceeds the ${MAX_TEXT_BYTES}-byte editor limit`);
  }
  try {
    return await orderedWorkspaceTextAccess.write(
      rootPath,
      relativePath,
      text,
      expectedContentHash,
    );
  } catch (error) {
    if (error instanceof WorkspaceTextTargetMissingError) {
      return { status: "conflict", currentContentHash: null };
    }
    throw error;
  }
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
  options: {
    exclusive?: boolean;
    signal?: AbortSignal;
    resolvedPathPolicy?: (workspaceRelativePath: string) => void;
  } = {},
): Promise<void> {
  const { exclusive = false, signal, resolvedPathPolicy } = options;
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
  const { relative: resolvedRelative, resolvedAbsolute: absolute } =
    await assertResolvedWorkspacePath({
      rootPath,
      absolutePath: join(rootPath, validated.normalized),
      spelled: relativePath,
      label: `${label} path`,
      access: exclusive ? "write" : "entry",
    });
  resolvedPathPolicy?.(resolvedRelative.replaceAll("\\", "/"));
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
  await workspaceOperationScheduler.staleSensitiveShared(rootPath, () =>
    writeContainedFile(rootPath, relativePath, bytes, "asset"),
  );
}

export async function restoreWorkspaceText(
  rootPath: string,
  relativePath: string,
  text: string,
  options: {
    signal?: AbortSignal;
    resolvedPathPolicy?: (workspaceRelativePath: string) => void;
  } = {},
): Promise<void> {
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new Error(`Text exceeds the ${MAX_TEXT_BYTES}-byte editor limit`);
  }
  await workspaceOperationScheduler.staleSensitiveShared(rootPath, () =>
    writeContainedFile(rootPath, relativePath, text, "restore", options),
  );
}

// Creates a text file with the filesystem's exclusive-create primitive. This
// keeps `overwrite: false` correct under concurrent callers; a preflight stat
// followed by an ordinary write would allow both requests to win the race.
export async function createWorkspaceTextExclusive(
  rootPath: string,
  relativePath: string,
  text: string,
  options: {
    signal?: AbortSignal;
    resolvedPathPolicy?: (workspaceRelativePath: string) => void;
  } = {},
): Promise<void> {
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new Error(`Text exceeds the ${MAX_TEXT_BYTES}-byte editor limit`);
  }
  await workspaceOperationScheduler.staleSensitiveShared(rootPath, () =>
    writeContainedFile(rootPath, relativePath, text, "restore", {
      exclusive: true,
      ...options,
    }),
  );
}

export async function readWorkspaceText(
  rootPath: string,
  relativePath: string,
): Promise<WorkspaceTextReadResult> {
  return orderedWorkspaceTextAccess.read(rootPath, relativePath);
}
