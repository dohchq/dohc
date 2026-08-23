import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { posixMcpLauncher } from "../../scripts/mcp-launchers.mjs";

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

async function publishContentAtomically(
  content: string,
  targetPath: string,
  mode?: number,
): Promise<void> {
  const tempPath = `${targetPath}.tmp-${randomUUID()}`;
  try {
    await writeFile(tempPath, content);
    if (mode !== undefined) await chmod(tempPath, mode);
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function contentHash(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex").slice(0, 16);
}

export async function syncLinuxStableCliBin(input: {
  resourcesCliBinDir: string;
  targetDir: string;
}): Promise<void> {
  await mkdir(input.targetDir, { recursive: true });
  const hash = await contentHash(join(input.resourcesCliBinDir, "dohc-mcp.mjs"));
  const moduleFileName = `dohc-mcp-${hash}.mjs`;
  // The content-addressed name keeps a published module immutable. If this
  // boot fails later, the previous launcher still names its previous module.
  // A failed update can leave one unreferenced module. Removing old modules
  // is separate disk cleanup, not part of adopting a generation safely.
  await publishAtomically(
    join(input.resourcesCliBinDir, "dohc-mcp.mjs"),
    join(input.targetDir, moduleFileName),
  );
  // Every caller resolves the fixed launcher name. Publishing it last is the
  // one atomic swap that adopts the module this generation just published.
  await publishContentAtomically(
    posixMcpLauncher(moduleFileName),
    join(input.targetDir, "dohc-mcp"),
    0o755,
  );
}

// Atomic publication keeps each real path complete. The launcher's content
// names its exact module, so checking that referenced file proves the two
// files belong to one generation.
export async function hasIntactStableCliBin(targetDir: string): Promise<boolean> {
  try {
    const launcherPath = join(targetDir, "dohc-mcp");
    const [launcherStat, launcherContent] = await Promise.all([
      stat(launcherPath),
      readFile(launcherPath, "utf8"),
    ]);
    if (!launcherStat.isFile() || launcherStat.size === 0) return false;
    const referencedModule = /exec node "\$\{0%\/\*\}\/([^"]+)" "\$@"/.exec(
      launcherContent,
    )?.[1];
    if (!referencedModule) return false;
    const moduleStat = await stat(join(targetDir, referencedModule));
    return moduleStat.isFile() && moduleStat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Returns the stable target after a successful sync or when a failed sync
 * leaves a complete pair from an earlier boot. Returns undefined when no
 * usable pair survives, so callers report the launcher unavailable instead
 * of exposing the AppImage mount path.
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
