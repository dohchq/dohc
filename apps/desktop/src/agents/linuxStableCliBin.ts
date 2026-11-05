import { createHash } from "node:crypto";
import { access, chmod, constants, copyFile, lstat, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { atomicReplaceFile } from "../atomicReplaceFile";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { agentRuntimeTarget, bundledPosixLauncher, posixMcpLauncher } from "../../scripts/mcp-launchers.mjs";
import { PINNED_NODE } from "../../scripts/pinned-node.mjs";

// After a crash, the launcher must not name a file whose bytes never reached
// the disk. Each file is flushed before its rename, and its folder after it,
// so the launcher's rename comes last.
async function flushFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const DURABLE_RENAME = { syncDirectory: true };

async function publishAtomically(
  sourcePath: string,
  targetPath: string,
  mode?: number,
): Promise<void> {
  await atomicReplaceFile(targetPath, async (tempPath) => {
    await copyFile(sourcePath, tempPath);
    if (mode !== undefined) await chmod(tempPath, mode);
    await flushFile(tempPath);
  }, DURABLE_RENAME);
}

async function publishContentAtomically(
  content: string,
  targetPath: string,
  mode?: number,
): Promise<void> {
  await atomicReplaceFile(targetPath, async (tempPath) => {
    await writeFile(tempPath, content);
    if (mode !== undefined) await chmod(tempPath, mode);
    await flushFile(tempPath);
  }, DURABLE_RENAME);
}

async function contentHash(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex").slice(0, 16);
}

// Hashing dohc's 120 MB Node.js on Electron's main thread held up the first
// workspace shell after a copy, so a worker reads and hashes it.
const SHA256_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const hash = require("node:crypto").createHash("sha256");
require("node:fs").createReadStream(workerData)
  .on("data", (chunk) => hash.update(chunk))
  .on("end", () => parentPort.postMessage(hash.digest("hex")))
  .on("error", (error) => { throw error; });
`;

function sha256InWorker(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(SHA256_WORKER_SOURCE, { eval: true, workerData: filePath });
    worker.once("message", (digest: string) => resolve(digest));
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`The Node.js hash worker stopped with code ${code}.`)));
  });
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
    if (await sha256InWorker(tempPath) !== sha256) {
      throw new Error("dohc's Node.js does not match its pinned release.");
    }
    await flushFile(tempPath);
  }, DURABLE_RENAME);
}

const LAUNCHER_NODE = /^NODE="\$\{0%\/\*\}\/(node-[0-9a-f]{64})"$/m;

// One dohc runs per settings folder, so a temp file here is from a copy that a
// quit or crash cut short. A Node.js that neither the launcher nor this release
// names is from an earlier release. Each can be 120 MB. The Node.js an earlier
// launcher names goes on the refresh after the one that replaces that launcher.
// Only a missing launcher names no Node.js. If the launcher exists but can't be
// read, the Node.js it names is unknown, so this refresh removes nothing.
async function removeLeftovers(targetDir: string, currentNode: string | undefined): Promise<void> {
  const launcher = await readFile(join(targetDir, "dohc-mcp"), "utf8").catch((cause: NodeJS.ErrnoException) =>
    cause.code === "ENOENT" ? "" : undefined,
  );
  if (launcher === undefined) return;
  const namedNode = LAUNCHER_NODE.exec(launcher)?.[1];
  for (const name of await readdir(targetDir)) {
    const earlierNode = /^node-[0-9a-f]{64}$/.test(name) && name !== namedNode && name !== currentNode;
    if (name.includes(".tmp-") || earlierNode) {
      await rm(join(targetDir, name), { force: true }).catch(() => undefined);
    }
  }
}

export async function syncLinuxStableCliBin(input: {
  resourcesCliBinDir: string;
  targetDir: string;
  arch?: string;
}): Promise<void> {
  await mkdir(input.targetDir, { recursive: true });
  const arch = input.arch ?? process.arch;
  const pinned = agentRuntimeTarget("linux", arch) === "bundled"
    ? PINNED_NODE[`linux-${arch}` as keyof typeof PINNED_NODE]
    : undefined;
  const nodeFileName = pinned ? `node-${pinned.sha256}` : undefined;
  await removeLeftovers(input.targetDir, nodeFileName);
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
  if (pinned && nodeFileName) {
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
// files proves they belong to one generation. This runs only after a refresh
// fails, so it hashes the Node.js against the hash in its name.
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
    const referencedNode = LAUNCHER_NODE.exec(launcherContent)?.[1];
    if (referencedNode === undefined) return true;
    const nodePath = join(targetDir, referencedNode);
    return await isExecutableFile(nodePath) && await sha256InWorker(nodePath) === referencedNode.slice("node-".length);
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
