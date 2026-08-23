import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
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
