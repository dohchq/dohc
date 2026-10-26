import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync } from "node:fs";
import { link, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

const WINDOWS_RENAME_RETRY_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

// Six attempts, with 8 + 16 + 32 + 64 + 128 = 248 ms of requested waits.
// The success path never waits or allocates a wait buffer.
function retryDelay(error: unknown, attempt: number, platform: NodeJS.Platform): number | undefined {
  const code = typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
  if (platform !== "win32" || attempt >= 5 || typeof code !== "string" || !WINDOWS_RENAME_RETRY_CODES.has(code)) {
    return undefined;
  }
  return 8 * 2 ** attempt;
}

function waitSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

interface ReplaceDependencies<Operation, Wait> {
  rename?: Operation;
  wait?: Wait;
  platform?: NodeJS.Platform;
}

type AsyncReplaceDependencies = ReplaceDependencies<
  (source: string, destination: string) => Promise<void>,
  (milliseconds: number) => Promise<void>
>;

interface SyncHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface DurableFileOperations extends AsyncReplaceDependencies {
  open?: (path: string, flags: string, mode?: number) => Promise<SyncHandle & {
    writeFile(data: string): Promise<void>;
  }>;
}

async function syncAndClose(handle: SyncHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await handle.close();
}

/** Opt-in durable data and, on POSIX, directory replacement. */
export async function atomicWriteFile(
  destination: string,
  data: string,
  { open: openFile = open, ...dependencies }: DurableFileOperations = {},
): Promise<void> {
  await atomicReplaceFile(destination, async (temporary) => {
    const handle = await openFile(temporary, "w", 0o600);
    try {
      await handle.writeFile(data);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    await syncAndClose(handle);
  }, { ...dependencies, open: openFile, syncDirectory: true });
}

/** The writer must close its temp file, including any required fsync, before returning. */
export function atomicReplaceFileSync(
  destination: string,
  writeTemporary: (temporary: string) => void,
  {
    rename: replace = renameSync,
    wait = waitSync,
    platform = process.platform,
  }: ReplaceDependencies<(source: string, destination: string) => void, (milliseconds: number) => void> = {},
): void {
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeTemporary(temporary);
    for (let attempt = 0; ; attempt += 1) {
      try {
        replace(temporary, destination);
        return;
      } catch (error) {
        const delay = retryDelay(error, attempt, platform);
        if (delay === undefined) throw error;
        wait(delay);
      }
    }
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Cleanup must not replace the write or rename error.
    }
    throw error;
  }
}

function waitAsync(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function renameWithRetry(
  source: string,
  destination: string,
  {
    rename: replace = rename,
    wait = waitAsync,
    platform = process.platform,
  }: AsyncReplaceDependencies = {},
  beforeRetry?: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await replace(source, destination);
      return;
    } catch (error) {
      const delay = retryDelay(error, attempt, platform);
      if (delay === undefined) throw error;
      await wait(delay);
      if (beforeRetry) await beforeRetry();
    }
  }
}

export async function atomicReplaceFile(
  destination: string,
  writeTemporary: (temporary: string) => Promise<void>,
  dependencies: AsyncReplaceDependencies & {
    syncDirectory?: boolean;
    open?: (path: string, flags: string) => Promise<SyncHandle>;
  } = {},
): Promise<void> {
  const { syncDirectory = false, open: openDirectory = open, platform = process.platform } = dependencies;
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeTemporary(temporary);
    await renameWithRetry(temporary, destination, dependencies);
    if (syncDirectory && platform !== "win32") {
      await syncAndClose(await openDirectory(dirname(destination), "r"));
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Create without replacing an existing entry. True means this creator won.
 * Hard links publish complete, flushed bytes. Failed direct writes remove
 * their new entry; a crash during a direct write can still leave it cut off.
 * Node cannot open directories for fsync on Windows.
 */
export async function atomicCreateFile(
  destination: string,
  data: string,
  mode: number,
  {
    open: openFile = open,
    link: publish = link,
    rm: remove = rm,
    allowDirectWrite = false,
    platform = process.platform,
    temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`,
  }: Pick<DurableFileOperations, "open" | "platform"> & {
    link?: (source: string, destination: string) => Promise<void>;
    rm?: typeof rm;
    allowDirectWrite?: boolean;
    /** A sibling of `destination` that nothing else uses. */
    temporary?: string;
  } = {},
): Promise<boolean> {
  const writeAndFlush = async (handle: SyncHandle & { writeFile(data: string): Promise<void> }) => {
    try {
      await handle.writeFile(data);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    await syncAndClose(handle);
  };
  try {
    await writeAndFlush(await openFile(temporary, "wx", mode));
    let created = true;
    try {
      await publish(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        created = false;
      } else {
        if (!allowDirectWrite) throw error;
        let handle;
        try {
          handle = await openFile(destination, "wx", mode);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          created = false;
        }
        if (handle) {
          try {
            await writeAndFlush(handle);
          } catch (error) {
            await remove(destination, { force: true }).catch(() => undefined);
            throw error;
          }
        }
      }
    }
    await remove(temporary).catch(() => undefined);
    if (platform !== "win32") {
      await syncAndClose(await openFile(dirname(destination), "r"));
    }
    return created;
  } catch (error) {
    await remove(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
