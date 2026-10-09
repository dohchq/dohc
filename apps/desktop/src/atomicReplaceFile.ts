import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync } from "node:fs";
import { rename, rm } from "node:fs/promises";

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
  }: ReplaceDependencies<(source: string, destination: string) => Promise<void>, (milliseconds: number) => Promise<void>> = {},
): Promise<void> {
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeTemporary(temporary);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await replace(temporary, destination);
        return;
      } catch (error) {
        const delay = retryDelay(error, attempt, platform);
        if (delay === undefined) throw error;
        await wait(delay);
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
