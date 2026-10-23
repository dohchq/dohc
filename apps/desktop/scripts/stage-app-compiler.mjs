import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

import { NODE_VERSION, PINNED_NODE } from "./pinned-node.mjs";
const maxNodeBytes = 128 * 1024 * 1024;
const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
/** The platforms that build apps under crates/dohc-compiler-owner, and its Rust target on each. */
const ownerTargets = { darwin: "aarch64-apple-darwin", linux: "x86_64-unknown-linux-gnu" };
const ownerCrate = "crates/dohc-compiler-owner";

function compilerFiles(platform, arch) {
  const native = `node_modules/@esbuild/${platform}-${arch}`;
  return [
    PINNED_NODE[`${platform}-${arch}`].file, "adapter.mjs", "worker.mjs",
    "node_modules/esbuild/package.json", "node_modules/esbuild/lib/main.js", "node_modules/esbuild/LICENSE.md",
    `${native}/package.json`, `${native}/${platform === "win32" ? "esbuild.exe" : "bin/esbuild"}`,
    "licenses/node.txt", "licenses/acorn.txt", "licenses/parse5.txt", "licenses/entities.txt",
  ];
}

// dohc ships no Intel Mac build, so staging or packaging one fails.
function refuseIntelMac(platform, arch) {
  if (platform === "darwin" && arch !== "arm64") throw new Error("The packaged app compiler requires macOS arm64. dohc has no Intel Mac build.");
}

// Windows x64, Apple silicon Macs and Linux x64 build apps. Linux arm64 ships
// only the esbuild binary that Collection actions compile with.
function stagedFiles(platform, arch) {
  if (platform === "win32") return arch === "x64" ? [...compilerFiles(platform, arch), "compilerProcessRelay.mjs", "windowsCompilerJob.ps1"] : undefined;
  if (platform === "darwin" || platform === "linux" && arch === "x64") return [...compilerFiles(platform, arch), "compiler-owner"];
  if (platform !== "linux" || !["arm64", "x64"].includes(arch)) return undefined;
  const native = `node_modules/@esbuild/${platform}-${arch}`;
  return ["node_modules/esbuild/LICENSE.md", `${native}/package.json`, `${native}/bin/esbuild`];
}

async function packageRoot(resolve, name) {
  for (let directory = dirname(resolve(name)); directory !== dirname(directory); directory = dirname(directory)) {
    const manifest = await readFile(join(directory, "package.json"), "utf8").then(JSON.parse, () => null);
    if (manifest?.name === name) return directory;
  }
  throw new Error(`App compiler cannot find ${name}.`);
}

export async function requireAppCompiler(root = join(desktopRoot, "resources/app-compiler"), platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch !== "x64") throw new Error("The packaged app compiler currently requires Windows x64.");
  refuseIntelMac(platform, arch);
  const files = stagedFiles(platform, arch);
  if (!files) return;
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const node = PINNED_NODE[`${platform}-${arch}`];
  if (node && (manifest.nodeVersion !== NODE_VERSION || manifest.nodeSha256 !== node.sha256) ||
      manifest.platform !== platform || manifest.arch !== arch ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...files].sort())) {
    throw new Error(`App compiler staging manifest does not match ${platform}-${arch}.`);
  }
  for (const path of files) {
    const bytes = await readFile(join(root, path));
    if (sha256(bytes) !== manifest.files[path]) throw new Error(`App compiler asset changed: ${path}`);
  }
  if (node && manifest.files[node.file] !== node.sha256) throw new Error("App compiler Node identity changed.");
}

async function download(fetchNode, url) {
  const response = await fetchNode(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Cannot download the pinned app compiler runtime (${response.status}).`);
  if (Number(response.headers.get("content-length")) > maxNodeBytes) {
    await response.body.cancel();
    throw new Error("App compiler runtime download exceeds its size bound.");
  }
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maxNodeBytes) throw new Error("App compiler runtime download exceeds its size bound.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** One regular file from a gzipped ustar archive, as Node's release tarballs are. */
export function archiveMember(archive, name) {
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("latin1").replace(/\0.*$/s, "");
    const prefix = field(345, 155), size = Number.parseInt(field(124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) break;
    offset += 512;
    if ((prefix ? `${prefix}/${field(0, 100)}` : field(0, 100)) === name && ["0", "\0"].includes(String.fromCharCode(header[156]))) {
      return tar.subarray(offset, offset + size);
    }
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error(`The Node archive does not contain ${name}.`);
}

/** Build preparation may fetch this fixed release. Packaged execution never resolves Node from PATH. */
export async function readPinnedCompilerNode(options = {}) {
  const target = `${options.platform ?? process.platform}-${options.arch ?? process.arch}`;
  const node = PINNED_NODE[target];
  if (!node) throw new Error(`App compiler has no pinned Node for ${target}.`);
  if (options.nodeExecutable) {
    const bytes = await readFile(options.nodeExecutable);
    if (sha256(bytes) !== node.sha256) throw new Error(`App compiler requires the official Node ${NODE_VERSION} executable for ${target}.`);
    return bytes;
  }
  for (const path of [...(options.stagedNodePaths ?? []), options.currentNodeExecutable ?? process.execPath]) {
    const bytes = await readFile(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (bytes && sha256(bytes) === node.sha256) return bytes;
  }
  const downloaded = await download(options.fetchNode ?? fetch, node.url);
  if (node.archiveSha256 && sha256(downloaded) !== node.archiveSha256) throw new Error("App compiler runtime archive does not match the official Node checksum.");
  const bytes = node.member ? archiveMember(downloaded, node.member) : downloaded;
  if (sha256(bytes) !== node.sha256) throw new Error("App compiler runtime download does not match the official Node checksum.");
  return bytes;
}

/** Builds crates/dohc-compiler-owner for this platform's target. */
async function buildCompilerOwner(sourceRoot, platform) {
  const ownerTarget = ownerTargets[platform];
  const repoRoot = resolve(sourceRoot, "../..");
  const targetDir = join(repoRoot, "target");
  try {
    await promisify(execFile)("cargo", ["build", "--locked", "--release", "--manifest-path", join(repoRoot, ownerCrate, "Cargo.toml"), "--target", ownerTarget, "--target-dir", targetDir],
      { cwd: repoRoot, env: process.env, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`Cannot build the app compiler owner for ${ownerTarget}: ${(error.stderr || error.message).trim().split("\n").slice(-5).join("\n")}`);
  }
  return join(targetDir, ownerTarget, "release", "dohc-compiler-owner");
}

/** Stage only trusted build inputs, without running dependency install scripts. */
export async function stageAppCompiler(options = {}) {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  refuseIntelMac(platform, arch);
  const files = stagedFiles(platform, arch);
  if (!files) return { supported: false };
  const destination = resolve(options.destination ?? join(desktopRoot, "resources/app-compiler"));
  const sourceRoot = resolve(options.desktopRoot ?? desktopRoot);
  const pinned = PINNED_NODE[`${platform}-${arch}`];
  // A temporary destination reuses the copy that development staging keeps.
  const stagedNodePaths = pinned ? [join(destination, pinned.file), join(sourceRoot, "resources/app-compiler", pinned.file)] : [];
  const node = pinned ? await readPinnedCompilerNode({ platform, arch, nodeExecutable: options.nodeExecutable, stagedNodePaths }) : null;
  const require = createRequire(join(sourceRoot, "package.json"));
  const esbuildRoot = dirname(require.resolve("esbuild/package.json"));
  if (JSON.parse(await readFile(join(esbuildRoot, "package.json"), "utf8")).version !== "0.28.1") throw new Error("App compiler requires esbuild 0.28.1.");
  // Loaded here so the Rust gate can read the pinned Node without installed packages.
  const { build } = await import("esbuild");
  const esbuildRequire = createRequire(join(esbuildRoot, "package.json"));
  const nativePackage = `@esbuild/${platform}-${arch}`;
  let platformRoot;
  try { platformRoot = dirname(esbuildRequire.resolve(`${nativePackage}/package.json`)); }
  catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    // pnpm installs only the host's binary unless asked for another architecture.
    throw new Error(`App compiler requires ${nativePackage}. Install it with pnpm install --cpu=current --cpu=${arch}.`);
  }
  if (JSON.parse(await readFile(join(platformRoot, "package.json"), "utf8")).version !== "0.28.1") throw new Error(`App compiler requires ${nativePackage} 0.28.1.`);
  const owner = files.includes("compiler-owner") ? await buildCompilerOwner(sourceRoot, platform) : null;
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(`${destination}.staging-`);
  try {
    for (const path of files) await mkdir(dirname(join(staging, path)), { recursive: true });
    if (!node) {
      await cp(join(esbuildRoot, "LICENSE.md"), join(staging, "node_modules/esbuild/LICENSE.md"));
      for (const file of ["package.json", "bin/esbuild"]) await cp(join(platformRoot, file), join(staging, "node_modules", nativePackage, file));
    } else {
      const acornRoot = dirname(require.resolve("acorn/package.json"));
      const parse5Root = await packageRoot(require.resolve, "parse5");
      const entitiesRoot = await packageRoot(createRequire(join(parse5Root, "package.json")).resolve, "entities");
      await writeFile(join(staging, pinned.file), node, { mode: 0o755 });
      for (const file of ["package.json", "lib/main.js", "LICENSE.md"]) await cp(join(esbuildRoot, file), join(staging, "node_modules/esbuild", file));
      const binary = platform === "win32" ? "esbuild.exe" : "bin/esbuild";
      for (const file of ["package.json", binary]) await cp(join(platformRoot, file), join(staging, "node_modules", nativePackage, file));
      if (platform === "win32") {
        for (const file of ["compilerProcessRelay.mjs", "windowsCompilerJob.ps1"]) await cp(join(sourceRoot, "src/workspaces", file), join(staging, file));
      } else {
        await cp(owner, join(staging, "compiler-owner"));
        await chmod(join(staging, "compiler-owner"), 0o755);
      }
      await cp(join(sourceRoot, "scripts/compiler-node-LICENSE.txt"), join(staging, "licenses/node.txt"));
      await cp(join(acornRoot, "LICENSE"), join(staging, "licenses/acorn.txt"));
      await cp(join(parse5Root, "LICENSE"), join(staging, "licenses/parse5.txt"));
      await cp(join(entitiesRoot, "LICENSE"), join(staging, "licenses/entities.txt"));
      for (const [source, output] of [["closedAppCompilerProcess.ts", "adapter.mjs"], ["closedAppCompilerWorker.ts", "worker.mjs"]]) {
        await build({ entryPoints: [join(sourceRoot, "src/workspaces", source)], outfile: join(staging, output),
          bundle: true, platform: "node", target: "node24", format: "esm", external: ["esbuild"], logLevel: "silent" });
      }
    }
    const identities = {};
    for (const path of files) identities[path] = sha256(await readFile(join(staging, path)));
    const runtime = pinned ? { nodeVersion: NODE_VERSION, nodeSha256: pinned.sha256 } : {};
    await writeFile(join(staging, "manifest.json"), JSON.stringify({ ...runtime, platform, arch, files: identities }, null, 2));
    await requireAppCompiler(staging, platform, arch);
    const current = await readFile(join(destination, "manifest.json"), "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (current === await readFile(join(staging, "manifest.json"), "utf8")) {
      await requireAppCompiler(destination, platform, arch);
      return { supported: true, destination, changed: false };
    }
    const exists = await stat(destination).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
    const previous = `${staging}.previous`;
    if (exists) await rename(destination, previous);
    try { await rename(staging, destination); }
    catch (error) { if (exists) await rename(previous, destination); throw error; }
    // Executing files can keep a replaced tree open on Windows. Preserve its
    // location for the build owner instead of failing the successful staging.
    const retained = exists ? await rm(previous, { recursive: true, force: true }).then(() => null, () => previous) : null;
    return { supported: true, destination, changed: true, retained };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = {};
  for (const argument of process.argv.slice(2)) {
    const match = /^--node=(.+)$/.exec(argument);
    if (!match) throw new Error(`Unknown compiler staging argument: ${argument}`);
    options.nodeExecutable = match[1];
  }
  console.log(JSON.stringify(await stageAppCompiler(options)));
}
