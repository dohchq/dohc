import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

export const NODE_VERSION = "24.16.0";
// https://nodejs.org/dist/v24.16.0/SHASUMS256.txt, win-x64/node.exe
export const NODE_SHA256 = "b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3";
const nodeUrl = `https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`;
const maxNodeBytes = 128 * 1024 * 1024;
const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const files = [
  "node.exe", "adapter.mjs", "worker.mjs", "compilerProcessRelay.mjs", "windowsCompilerJob.ps1",
  "node_modules/esbuild/package.json", "node_modules/esbuild/lib/main.js", "node_modules/esbuild/LICENSE.md",
  "node_modules/@esbuild/win32-x64/package.json", "node_modules/@esbuild/win32-x64/esbuild.exe",
  "licenses/node.txt", "licenses/acorn.txt",
];

export async function requireAppCompiler(root = join(desktopRoot, "resources/app-compiler"), platform = process.platform, arch = process.arch) {
  if (platform !== "win32") return;
  if (arch !== "x64") throw new Error("The packaged app compiler currently requires Windows x64.");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (manifest.nodeVersion !== NODE_VERSION || manifest.nodeSha256 !== NODE_SHA256 ||
      manifest.platform !== "win32" || manifest.arch !== "x64" ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...files].sort())) {
    throw new Error("App compiler staging manifest does not match this build.");
  }
  for (const path of files) {
    const bytes = await readFile(join(root, path));
    if (sha256(bytes) !== manifest.files[path]) throw new Error(`App compiler asset changed: ${path}`);
  }
  if (manifest.files["node.exe"] !== NODE_SHA256) throw new Error("App compiler Node identity changed.");
}

/** Build preparation may fetch this fixed release. Packaged execution never resolves Node from PATH. */
export async function readPinnedCompilerNode(options = {}) {
  if (options.nodeExecutable) {
    const bytes = await readFile(options.nodeExecutable);
    if (sha256(bytes) !== NODE_SHA256) throw new Error(`App compiler requires the official Node ${NODE_VERSION} Windows x64 executable.`);
    return bytes;
  }
  for (const path of [options.stagedNodePath, options.currentNodeExecutable ?? process.execPath]) {
    if (!path) continue;
    const bytes = await readFile(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (bytes && sha256(bytes) === NODE_SHA256) return bytes;
  }
  const response = await (options.fetchNode ?? fetch)(nodeUrl, { redirect: "error", signal: AbortSignal.timeout(120_000) });
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
  const bytes = Buffer.concat(chunks);
  if (sha256(bytes) !== NODE_SHA256) throw new Error("App compiler runtime download does not match the official Node checksum.");
  return bytes;
}

/** Stage only trusted build inputs, without running dependency install scripts. */
export async function stageAppCompiler(options = {}) {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  if (platform !== "win32" || arch !== "x64") return { supported: false };
  const destination = resolve(options.destination ?? join(desktopRoot, "resources/app-compiler"));
  const sourceRoot = resolve(options.desktopRoot ?? desktopRoot);
  const node = await readPinnedCompilerNode({ nodeExecutable: options.nodeExecutable, stagedNodePath: join(destination, "node.exe") });
  const require = createRequire(join(sourceRoot, "package.json"));
  const esbuildRoot = dirname(require.resolve("esbuild/package.json"));
  if (JSON.parse(await readFile(join(esbuildRoot, "package.json"), "utf8")).version !== "0.28.1") throw new Error("App compiler requires esbuild 0.28.1.");
  const esbuildRequire = createRequire(join(esbuildRoot, "package.json"));
  const platformRoot = dirname(esbuildRequire.resolve("@esbuild/win32-x64/package.json"));
  if (JSON.parse(await readFile(join(platformRoot, "package.json"), "utf8")).version !== "0.28.1") throw new Error("App compiler requires esbuild 0.28.1 Windows x64.");
  const acornRoot = dirname(require.resolve("acorn/package.json"));
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(`${destination}.staging-`);
  try {
    for (const path of files) await mkdir(dirname(join(staging, path)), { recursive: true });
    await writeFile(join(staging, "node.exe"), node);
    for (const file of ["package.json", "lib/main.js", "LICENSE.md"]) await cp(join(esbuildRoot, file), join(staging, "node_modules/esbuild", file));
    for (const file of ["package.json", "esbuild.exe"]) await cp(join(platformRoot, file), join(staging, "node_modules/@esbuild/win32-x64", file));
    for (const file of ["compilerProcessRelay.mjs", "windowsCompilerJob.ps1"]) await cp(join(sourceRoot, "src/workspaces", file), join(staging, file));
    await cp(join(sourceRoot, "scripts/compiler-node-LICENSE.txt"), join(staging, "licenses/node.txt"));
    await cp(join(acornRoot, "LICENSE"), join(staging, "licenses/acorn.txt"));
    for (const [source, output] of [["closedAppCompilerProcess.ts", "adapter.mjs"], ["closedAppCompilerWorker.ts", "worker.mjs"]]) {
      await build({ entryPoints: [join(sourceRoot, "src/workspaces", source)], outfile: join(staging, output),
        bundle: true, platform: "node", target: "node24", format: "esm", external: ["esbuild"], logLevel: "silent" });
    }
    const identities = {};
    for (const path of files) identities[path] = sha256(await readFile(join(staging, path)));
    await writeFile(join(staging, "manifest.json"), JSON.stringify({ nodeVersion: NODE_VERSION, nodeSha256: NODE_SHA256, platform, arch, files: identities }, null, 2));
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
    const match = /^--(node|platform|arch)=(.+)$/.exec(argument);
    if (!match) throw new Error(`Unknown compiler staging argument: ${argument}`);
    options[match[1] === "node" ? "nodeExecutable" : match[1]] = match[2];
  }
  console.log(JSON.stringify(await stageAppCompiler(options)));
}
