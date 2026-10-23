import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildEngineReader } from "../../../packages/ydoc-projection/scripts/build-engine-reader.mjs";
import { NODE_VERSION, PINNED_NODE } from "./pinned-node.mjs";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const run = promisify(execFile);
const identity = (platform, arch) => ({ version: NODE_VERSION, platform, arch, unicode: "17.0", icu: "78.3" });
const supported = (platform, arch) => (["win32", "linux"].includes(platform) && arch === "x64") || (platform === "darwin" && ["arm64", "x64"].includes(arch));

async function regular(path) {
  if (!(await lstat(path)).isFile()) throw new Error(`Reader asset is not a regular file: ${path}`);
  return readFile(path);
}

/** Packaging verifies the official runtime before any macOS signing changes its bytes. */
export async function requireEngineReader(resources = join(desktop, "resources"), platform = process.platform, arch = process.arch, hostNode) {
  if (!supported(platform, arch)) return;
  const selection = JSON.parse(await regular(join(resources, "engine-reader/selection.json")));
  return verifyGeneration(resources, platform, arch, selection.generation, hostNode);
}

async function verifyGeneration(resources, platform, arch, generation, hostNode) {
  if (!/^[a-f0-9]{64}$/.test(generation)) throw new Error("Invalid reader generation.");
  const root = join(resources, "engine-reader", generation);
  const manifest = JSON.parse(await regular(join(root, "manifest.json")));
  const { sources, buildSha256, ...built } = manifest;
  const runtime = hostNode ?? (platform === "win32" ? join(resources, "app-compiler/node.exe") : join(root, "node"));
  if (manifest.version !== 1 || buildSha256 !== generation || hash(JSON.stringify(built)) !== buildSha256 ||
      JSON.stringify(manifest.runtime) !== JSON.stringify({ ...identity(platform, arch), sha256: manifest.runtime.sha256 }) ||
      manifest.runtime.sha256 !== PINNED_NODE[`${platform}-${arch}`].sha256) throw new Error("Reader identity mismatch.");
  if (hash(await regular(runtime)) !== manifest.runtime.sha256 ||
      hash(await regular(join(root, "reader.cjs"))) !== manifest.bundleSha256) throw new Error("Reader asset hash mismatch.");
  return { node: resolve(runtime), bundle: resolve(root, "reader.cjs"), manifest: resolve(root, "manifest.json") };
}

async function discard(path) {
  if ((await lstat(path)).isDirectory()) await chmod(path, 0o700);
  await rm(path, { recursive: true, force: true });
}
async function prune(base, generation, selfHost) {
  for (const entry of await readdir(base)) {
    if ([generation, "selection.json", ...(selfHost ? ["startup.json"] : [])].includes(entry)) continue;
    const path = join(base, entry);
    // A concurrent preparation owns recent files, including a generation it has not selected yet.
    const metadata = await lstat(path).catch(() => null);
    if (!metadata || Date.now() - metadata.mtimeMs < 24 * 60 * 60 * 1000) continue;
    // Windows keeps executable generations locked while a reader is running.
    await discard(path).catch(() => {});
  }
}

async function archivedNode(staging, fetchNode, resources, platform, arch) {
  const pinned = PINNED_NODE[`${platform}-${arch}`];
  const previous = await requireEngineReader(resources, platform, arch).catch(() => null);
  for (const candidate of fetchNode === fetch ? [previous?.node, process.execPath] : []) {
    if (!candidate) continue;
    const bytes = await regular(candidate).catch(() => null);
    if (bytes && hash(bytes) === pinned.sha256) {
      await writeFile(join(staging, "node"), bytes);
      return bytes;
    }
  }
  const response = await fetchNode(pinned.url,
    { redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Reader runtime download failed: ${response.status}`);
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > 128 * 1024 * 1024) throw new Error("Reader runtime download too large.");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (hash(bytes) !== pinned.archiveSha256) throw new Error("Reader runtime download checksum mismatch.");
  const archive = join(staging, "node.tar.gz");
  await writeFile(archive, bytes);
  const tar = process.platform === "win32" ? join(process.env.SystemRoot, "System32/tar.exe") : "tar";
  await run(tar, ["-xzf", archive, "-C", staging, "--strip-components=2", pinned.member]);
  await rm(archive);
  const node = await regular(join(staging, "node"));
  if (hash(node) !== pinned.sha256) throw new Error("Extracted reader runtime checksum mismatch.");
  return node;
}

/** Preparation verifies before selecting; packages retain only the selected generation. */
export async function stageEngineReader(options = {}) {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const resources = resolve(options.resources ?? join(desktop, "resources"));
  if (!supported(platform, arch)) return { supported: false };
  const base = join(resources, "engine-reader");
  await mkdir(base, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    const config = await requireEngineReader(resources, platform, arch, options.selfHost ? process.execPath : undefined).then(async config => {
      const manifest = JSON.parse(await regular(config.manifest));
      const repo = resolve(desktop, "../..");
      if (hash(await readFile(join(repo, "pnpm-lock.yaml"))) !== manifest.lockSha256) return null;
      for (const source of manifest.sources) if (hash(await readFile(resolve(repo, source.path))) !== source.sha256) return null;
      return config;
    }).catch(() => null);
    if (config) {
      const generation = basename(dirname(config.bundle));
      if (options.selfHost) await writeFile(join(base, "startup.json"), JSON.stringify(config) + "\n", { mode: 0o444 });
      await prune(base, generation, options.selfHost);
      return { supported: true, generation, ...config };
    }
  }
  const staging = await mkdtemp(join(base, ".staging-"));
  try {
    const manifest = await buildEngineReader(staging);
    const runtime = platform === "win32" ? await regular(join(resources, "app-compiler/node.exe")) :
      options.selfHost ? await regular(process.execPath) : await archivedNode(staging, options.fetchNode ?? fetch, resources, platform, arch);
    if (platform === "win32" && hash(runtime) !== PINNED_NODE["win32-x64"].sha256) throw new Error("Reader requires the pinned compiler Node.");
    if (options.selfHost) {
      for (const [key, value] of Object.entries(identity(platform, arch))) {
        const actual = key === "version" ? process.versions.node : key === "unicode" || key === "icu" ? process.versions[key] : process[key];
        if (actual !== value) throw new Error("Self-host reader runtime version mismatch.");
      }
    }
    manifest.runtime = { ...identity(platform, arch), sha256: hash(runtime) };
    const { sources, buildSha256, ...built } = manifest;
    manifest.buildSha256 = hash(JSON.stringify(built));
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    for (const file of platform === "win32" || options.selfHost ? ["reader.cjs", "manifest.json"] : ["node", "reader.cjs", "manifest.json"]) {
      await chmod(join(staging, file), file === "node" ? 0o555 : 0o444);
    }
    // A read-only folder protects nothing on Windows and stops git clean removing it.
    if (process.platform !== "win32") await chmod(staging, 0o555);
    const generation = manifest.buildSha256, destination = join(base, generation);
    const hostNode = options.selfHost ? process.execPath : undefined;
    const existing = await verifyGeneration(resources, platform, arch, generation, hostNode).catch(() => null);
    if (!existing) {
      if (await lstat(destination).catch(() => null)) await discard(destination);
      await rename(staging, destination);
    }
    const config = await verifyGeneration(resources, platform, arch, generation, hostNode);
    const selected = join(base, "selection.json");
    const temporary = join(base, `.selection-${process.pid}.json`);
    await writeFile(temporary, JSON.stringify({ generation }) + "\n", { mode: 0o600 });
    await rename(temporary, selected);
    if (options.selfHost) await writeFile(join(base, "startup.json"), JSON.stringify(config) + "\n", { mode: 0o444 });
    await prune(base, generation, options.selfHost);
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
