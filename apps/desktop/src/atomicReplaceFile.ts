import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
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

export async function atomicReplaceFile(
  destination: string,
  writeTemporary: (temporary: string) => Promise<void>,
  {
    rename: replace = rename,
    wait = (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    platform = process.platform,
    syncDirectory = false,
    open: openDirectory = open,
  }: AsyncReplaceDependencies & {
    syncDirectory?: boolean;
    open?: (path: string, flags: string) => Promise<SyncHandle>;
  } = {},
): Promise<void> {
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeTemporary(temporary);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await replace(temporary, destination);
        break;
      } catch (error) {
        const delay = retryDelay(error, attempt, platform);
        if (delay === undefined) throw error;
        await wait(delay);
      }
    }
    if (syncDirectory && platform !== "win32") {
      await syncAndClose(await openDirectory(dirname(destination), "r"));
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
