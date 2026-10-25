import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, readFile, writeFile, constants } from "node:fs/promises";
import { join } from "node:path";
import { atomicReplaceFile } from "../atomicReplaceFile";
import { bundledPosixLauncher, posixMcpLauncher } from "../../scripts/mcp-launchers.mjs";
import { NODE_VERSION, PINNED_NODE } from "../../scripts/pinned-node.mjs";

async function contentHash(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function regularFile(filePath: string, executable = false): Promise<boolean> {
  try {
    const file = await lstat(filePath);
    if (!file.isFile() || file.size === 0) return false;
    if (executable) await access(filePath, constants.X_OK);
    return true;
  } catch { return false; }
}

async function intactFile(filePath: string, hash: string, executable = false): Promise<boolean> {
  return await regularFile(filePath, executable) && (await contentHash(filePath)).startsWith(hash);
}

async function publishImmutable(source: string, destination: string, hash: string, executable = false): Promise<void> {
  if (await intactFile(destination, hash, executable)) return;
  await atomicReplaceFile(destination, async temporary => {
    await copyFile(source, temporary);
    if (executable) await chmod(temporary, 0o755);
    if (!await intactFile(temporary, hash, executable)) throw new Error("Agent runtime changed during publication.");
  });
}

async function publishLauncher(content: string, destination: string): Promise<void> {
  await atomicReplaceFile(destination, async temporary => {
    await writeFile(temporary, content);
    await chmod(temporary, 0o755);
  });
}

function requireArchitecture(arch: string): void {
  if (arch !== "x64" && arch !== "arm64") throw new Error(`Unsupported Linux agent runtime architecture: ${arch}`);
}

export async function syncLinuxStableCliBin(input: {
  resourcesCliBinDir: string;
  targetDir: string;
  arch?: string;
}): Promise<void> {
  const arch = input.arch ?? process.arch;
  requireArchitecture(arch);
  await mkdir(input.targetDir, { recursive: true });
  let nodeFileName: string | undefined;
  if (arch === "x64") {
    const compiler = join(input.resourcesCliBinDir, "..", "app-compiler");
    const nodePath = join(compiler, "node");
    const manifest = JSON.parse(await readFile(join(compiler, "manifest.json"), "utf8"));
    const pinned = PINNED_NODE["linux-x64"];
    if (manifest.platform !== "linux" || manifest.arch !== "x64" || manifest.nodeVersion !== NODE_VERSION ||
        manifest.nodeSha256 !== pinned.sha256 || manifest.files?.node !== pinned.sha256 ||
        !await intactFile(nodePath, pinned.sha256, true)) {
      throw new Error("The installed agent runtime does not match the pinned Node release.");
    }
    nodeFileName = `node-${pinned.sha256}`;
    await publishImmutable(nodePath, join(input.targetDir, nodeFileName), pinned.sha256, true);
  }
  const modulePath = join(input.resourcesCliBinDir, "dohc-mcp.mjs");
  if (!await regularFile(modulePath)) throw new Error("The installed MCP module is missing.");
  const moduleHash = await contentHash(modulePath);
  const moduleFileName = `dohc-mcp-${moduleHash.slice(0, 16)}.mjs`;
  await publishImmutable(modulePath, join(input.targetDir, moduleFileName), moduleHash);
  // This is the only swap that adopts a new executable set. Keep old files
  // because a saved configuration or a starting process can still use them.
  await publishLauncher(
    nodeFileName ? bundledPosixLauncher(moduleFileName, nodeFileName) : posixMcpLauncher(moduleFileName),
    join(input.targetDir, "dohc-mcp"),
  );
}

export async function hasIntactStableCliBin(targetDir: string, arch: string = process.arch): Promise<boolean> {
  try {
    requireArchitecture(arch);
    const launcherPath = join(targetDir, "dohc-mcp");
    if (!await regularFile(launcherPath, true)) return false;
    const content = await readFile(launcherPath, "utf8");
    const moduleName = /\/(dohc-mcp-([a-f0-9]{16})\.mjs)"/.exec(content);
    if (!moduleName) return false;
    if (arch === "x64") {
      const nodeName = /NODE="\$\{0%\/\*\}\/(node-([a-f0-9]{64}))"/.exec(content);
      if (!nodeName || content !== bundledPosixLauncher(moduleName[1], nodeName[1])) return false;
      if (!await intactFile(join(targetDir, nodeName[1]), nodeName[2], true)) return false;
    } else if (content !== posixMcpLauncher(moduleName[1])) return false;
    return await intactFile(join(targetDir, moduleName[1]), moduleName[2]);
  } catch { return false; }
}

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
    return await hasIntactStableCliBin(input.targetDir, input.arch) ? input.targetDir : undefined;
  }
}
