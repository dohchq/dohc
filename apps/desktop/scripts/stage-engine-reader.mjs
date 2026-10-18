import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { userInfo } from "node:os";
import { buildEngineReader } from "../../../packages/ydoc-projection/scripts/build-engine-reader.mjs";
import { NODE_VERSION, PINNED_NODE } from "./pinned-node.mjs";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const run = promisify(execFile);
const identity = platform => ({ version: NODE_VERSION, platform, arch: "x64", unicode: "17.0", icu: "78.3" });

async function regular(path) {
  if (!(await lstat(path)).isFile()) throw new Error(`Reader asset is not a regular file: ${path}`);
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    const bytes = await file.readFile();
    const after = await lstat(path);
    if (!after.isFile() || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`Reader asset replaced: ${path}`);
    }
    return bytes;
  } finally { await file.close(); }
}

/** Packaging fails closed; macOS deliberately has no closure until PR 4b. */
export async function requireEngineReader(resources = join(desktop, "resources"), platform = process.platform, arch = process.arch, hostNode) {
  if (platform === "darwin") return;
  if (!["win32", "linux"].includes(platform) || arch !== "x64") throw new Error("Reader requires Windows or Linux x64.");
  const selection = JSON.parse(await regular(join(resources, "engine-reader/selection.json")));
  if (!/^[a-f0-9]{64}$/.test(selection.generation)) throw new Error("Invalid reader generation.");
  const root = join(resources, "engine-reader", selection.generation);
  const manifest = JSON.parse(await regular(join(root, "manifest.json")));
  const { sources, buildSha256, ...built } = manifest;
  const runtime = hostNode ?? (platform === "win32" ? join(resources, "app-compiler/node.exe") : join(root, "node"));
  if (manifest.version !== 1 || buildSha256 !== selection.generation || hash(JSON.stringify(built)) !== buildSha256 ||
      JSON.stringify(manifest.runtime) !== JSON.stringify({ ...identity(platform), sha256: manifest.runtime.sha256 }) ||
      manifest.runtime.sha256 !== (platform === "win32" ? PINNED_NODE["win32-x64"].sha256 : PINNED_NODE["linux-x64"].sha256)) throw new Error("Reader identity mismatch.");
  if (hash(await regular(runtime)) !== manifest.runtime.sha256 ||
      hash(await regular(join(root, "reader.cjs"))) !== manifest.bundleSha256) throw new Error("Reader asset hash mismatch.");
  return { node: resolve(runtime), bundle: resolve(root, "reader.cjs"), manifest: resolve(root, "manifest.json") };
}

async function linuxNode(staging, fetchNode, resources) {
  const previous = await requireEngineReader(resources, "linux", "x64").catch(() => null);
  for (const candidate of fetchNode === fetch ? [previous?.node, process.execPath] : []) {
    if (!candidate) continue;
    const bytes = await regular(candidate).catch(() => null);
    if (bytes && hash(bytes) === PINNED_NODE["linux-x64"].sha256) {
      await writeFile(join(staging, "node"), bytes);
      return bytes;
    }
  }
  const response = await fetchNode(PINNED_NODE["linux-x64"].url,
    { redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Reader runtime download failed: ${response.status}`);
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > 128 * 1024 * 1024) throw new Error("Reader runtime download too large.");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (hash(bytes) !== PINNED_NODE["linux-x64"].archiveSha256) throw new Error("Reader runtime download checksum mismatch.");
  const archive = join(staging, "node.tar.gz");
  await writeFile(archive, bytes);
  const tar = process.platform === "win32" ? join(process.env.SystemRoot, "System32/tar.exe") : "tar";
  await run(tar, ["-xzf", archive, "-C", staging, "--strip-components=2", PINNED_NODE["linux-x64"].member]);
  await rm(archive);
  const node = await regular(join(staging, "node"));
  if (hash(node) !== PINNED_NODE["linux-x64"].sha256) throw new Error("Extracted reader runtime checksum mismatch.");
  return node;
}

/** New builds select a fresh immutable generation. Active generations are never rewritten. */
export async function stageEngineReader(options = {}) {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const resources = resolve(options.resources ?? join(desktop, "resources"));
  if (platform === "darwin") return { supported: false };
  if (!["win32", "linux"].includes(platform) || arch !== "x64") throw new Error("Reader requires Windows or Linux x64.");
  const base = join(resources, "engine-reader");
  await mkdir(base, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const grants = [`${userInfo().username}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"];
    await run("icacls.exe", [resources, "/inheritance:r", "/grant:r", ...grants]);
  }
  const staging = await mkdtemp(join(base, ".staging-"));
  try {
    const manifest = await buildEngineReader(staging);
    const runtime = platform === "win32" ? await regular(join(resources, "app-compiler/node.exe")) :
      options.selfHost ? await regular(process.execPath) : await linuxNode(staging, options.fetchNode ?? fetch, resources);
    if (platform === "win32" && hash(runtime) !== PINNED_NODE["win32-x64"].sha256) throw new Error("Reader requires the pinned compiler Node.");
    if (options.selfHost) {
      for (const [key, value] of Object.entries(identity(platform))) {
        const actual = key === "version" ? process.versions.node : key === "unicode" || key === "icu" ? process.versions[key] : process[key];
        if (actual !== value) throw new Error("Self-host reader runtime version mismatch.");
      }
    }
    manifest.runtime = { ...identity(platform), sha256: hash(runtime) };
    const { sources, buildSha256, ...built } = manifest;
    manifest.buildSha256 = hash(JSON.stringify(built));
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    for (const file of platform === "win32" || options.selfHost ? ["reader.cjs", "manifest.json"] : ["node", "reader.cjs", "manifest.json"]) {
      await chmod(join(staging, file), file === "node" ? 0o555 : 0o444);
    }
    await chmod(staging, 0o555);
    const generation = manifest.buildSha256, destination = join(base, generation);
    try { await rename(staging, destination); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code) || !(await lstat(destination)).isDirectory()) throw error; }
    const selected = join(base, "selection.json");
    const temporary = join(base, `.selection-${process.pid}.json`);
    await writeFile(temporary, JSON.stringify({ generation }) + "\n", { mode: 0o600 });
    await rename(temporary, selected);
    const config = await requireEngineReader(resources, platform, arch, options.selfHost ? process.execPath : undefined);
    if (options.selfHost) await writeFile(join(base, "startup.json"), JSON.stringify(config) + "\n", { mode: 0o444 });
    return { supported: true, generation, ...config };
  } finally {
    await chmod(staging, 0o700).catch(() => {});
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await stageEngineReader({ platform: process.argv.includes("--linux") ? "linux" : process.platform,
    resources: process.env.DOHC_READER_STAGE_RESOURCES, selfHost: process.argv.includes("--self-host") });
  console.log(JSON.stringify(result));
}
