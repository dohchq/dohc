import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

async function publishAtomically(
  sourcePath: string,
  targetPath: string,
  mode?: number,
): Promise<void> {
  const tempPath = `${targetPath}.tmp-${randomUUID()}`;
  try {
    await copyFile(sourcePath, tempPath);
    if (mode !== undefined) await chmod(tempPath, mode);
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function syncLinuxStableCliBin(input: {
  resourcesCliBinDir: string;
  targetDir: string;
}): Promise<void> {
  await mkdir(input.targetDir, { recursive: true });
  await publishAtomically(
    join(input.resourcesCliBinDir, "dohc-mcp.mjs"),
    join(input.targetDir, "dohc-mcp.mjs"),
  );
  await publishAtomically(
    join(input.resourcesCliBinDir, "dohc-mcp"),
    join(input.targetDir, "dohc-mcp"),
    0o755,
  );
}

// publishAtomically's rename-into-place means a file at the real path is
// always the WHOLE thing from some completed publish, never a partial
// write -- existence plus a nonzero size is enough to trust it without
// parsing it.
export async function hasIntactStableCliBin(targetDir: string): Promise<boolean> {
  try {
    const [launcher, module] = await Promise.all([
      stat(join(targetDir, "dohc-mcp")),
      stat(join(targetDir, "dohc-mcp.mjs")),
    ]);
    return launcher.size > 0 && module.size > 0;
  } catch {
    return false;
  }
}

/**
 * One boot's refresh attempt, resolved to whatever the caller should treat
 * as the stable cli-bin directory: the target on a successful sync, the
 * target again when a failed sync still leaves an intact pair a previous
 * boot published (a version mismatch between an old launcher and a newer
 * module is harmless -- the launcher only probes Node and execs the module
 * by path, it isn't coupled to its contents), or undefined only when
 * nothing usable survives, so the caller falls back to the packaged mount
 * for this boot alone.
 */
export async function refreshLinuxStableCliBin(input: {
  resourcesCliBinDir: string;
  targetDir: string;
  onError?: (error: unknown) => void;
}): Promise<string | undefined> {
  try {
    await syncLinuxStableCliBin(input);
    return input.targetDir;
  } catch (error) {
    input.onError?.(error);
    return (await hasIntactStableCliBin(input.targetDir)) ? input.targetDir : undefined;
  }
}
