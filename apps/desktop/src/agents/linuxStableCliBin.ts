import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, constants, copyFile, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { atomicReplaceFile } from "../atomicReplaceFile";
import { join } from "node:path";
import { agentRuntimeTarget, bundledPosixLauncher, posixMcpLauncher } from "../../scripts/mcp-launchers.mjs";
import { PINNED_NODE } from "../../scripts/pinned-node.mjs";

async function publishAtomically(
  sourcePath: string,
  targetPath: string,
  mode?: number,
): Promise<void> {
  await atomicReplaceFile(targetPath, async (tempPath) => {
    await copyFile(sourcePath, tempPath);
    if (mode !== undefined) await chmod(tempPath, mode);
  });
}

async function publishContentAtomically(
  content: string,
  targetPath: string,
  mode?: number,
): Promise<void> {
  await atomicReplaceFile(targetPath, async (tempPath) => {
    await writeFile(tempPath, content);
    if (mode !== undefined) await chmod(tempPath, mode);
  });
}

async function contentHash(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex").slice(0, 16);
}

async function streamedSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const file = await lstat(filePath);
    if (!file.isFile() || file.size === 0) return false;
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// dohc's Node.js is about 120 MB, so it is copied and hashed only when its
// pinned release isn't published yet. Its name holds that release's hash,
// and a published copy was checked before its rename.
async function publishNode(sourcePath: string, targetPath: string, sha256: string): Promise<void> {
  const [source, published] = await Promise.all([stat(sourcePath), lstat(targetPath).catch(() => undefined)]);
  if (published?.isFile() && published.size === source.size && await isExecutableFile(targetPath)) return;
  await atomicReplaceFile(targetPath, async (tempPath) => {
    await copyFile(sourcePath, tempPath);
    await chmod(tempPath, 0o755);
    if (await streamedSha256(tempPath) !== sha256) {
      throw new Error("dohc's Node.js does not match its pinned release.");
    }
  });
}

export async function syncLinuxStableCliBin(input: {
  resourcesCliBinDir: string;
  targetDir: string;
  arch?: string;
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
  let launcher = posixMcpLauncher(moduleFileName);
  const arch = input.arch ?? process.arch;
  if (agentRuntimeTarget("linux", arch) === "bundled") {
    const pinned = PINNED_NODE[`linux-${arch}` as keyof typeof PINNED_NODE];
    const nodeFileName = `node-${pinned.sha256}`;
    await publishNode(
      join(input.resourcesCliBinDir, "..", "app-compiler", "node"),
      join(input.targetDir, nodeFileName),
      pinned.sha256,
    );
    launcher = bundledPosixLauncher(moduleFileName, nodeFileName);
  }
  // Every caller resolves the fixed launcher name. Publishing it last is the
  // one atomic swap that adopts the files this generation just published.
  await publishContentAtomically(launcher, join(input.targetDir, "dohc-mcp"), 0o755);
}

// Atomic publication keeps each real path complete. The launcher's content
// names its exact module, and its Node.js when it has one, so checking those
// files proves they belong to one generation.
export async function hasIntactStableCliBin(targetDir: string): Promise<boolean> {
  try {
    const launcherPath = join(targetDir, "dohc-mcp");
    const [launcherStat, launcherContent] = await Promise.all([
      stat(launcherPath),
      readFile(launcherPath, "utf8"),
    ]);
    if (!launcherStat.isFile() || launcherStat.size === 0) return false;
    const referencedModule = /"\$\{0%\/\*\}\/(dohc-mcp-[^"/]+\.mjs)" "\$@"/.exec(launcherContent)?.[1];
    if (!referencedModule) return false;
    const moduleStat = await stat(join(targetDir, referencedModule));
    if (!moduleStat.isFile() || moduleStat.size === 0) return false;
    const referencedNode = /^NODE="\$\{0%\/\*\}\/(node-[0-9a-f]{64})"$/m.exec(launcherContent)?.[1];
    return referencedNode === undefined || await isExecutableFile(join(targetDir, referencedNode));
  } catch {
    return false;
  }
}

/**
 * Returns the stable target after a successful sync or when a failed sync
 * leaves a complete generation from an earlier boot. Returns undefined when
 * none survives, so callers report the launcher unavailable instead of
 * exposing the AppImage mount path.
 */
export async function refreshLinuxStableCliBin(input: {
  resourcesCliBinDir: string;
  targetDir: string;
  arch?: string;
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
