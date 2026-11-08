import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PINNED_NODE } from "./pinned-node.mjs";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const ownerSource = "src/agents/agentProbeOwner.cs", relaySource = "src/agents/agentProbeRelay.mjs";
const stagerSource = "scripts/stage-agent-probe.mjs";
const files = ["agentProbeOwner.exe", "agentProbeRelay.mjs"];
const nodeSha256 = PINNED_NODE["win32-x64"].sha256;

/** Compiles C# 5 with the .NET Framework compiler that ships with Windows. */
export async function compileOwner(sources, outfile, main = "AgentProbeOwner") {
  const csc = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  try {
    await promisify(execFile)(csc, ["/nologo", "/noconfig", "/target:exe", "/platform:x64", "/optimize+",
      "/reference:System.dll", `/main:${main}`, `/out:${outfile}`, ...sources], { windowsHide: true });
  } catch (error) {
    throw new Error(`Cannot compile ${basename(outfile)}: ${(error.stdout || error.message).trim()}`);
  }
}

// The relay runs on the Node staged with the app compiler, so that Node belongs to this closure.
export async function requireAgentProbe(root = join(desktopRoot, "resources/agent-probe"),
  compilerRoot = join(desktopRoot, "resources/app-compiler"), platform = process.platform, arch = process.arch) {
  if (platform !== "win32") return;
  if (arch !== "x64") throw new Error("The packaged agent probe currently requires Windows x64.");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (manifest.nodeSha256 !== nodeSha256 || manifest.platform !== "win32" || manifest.arch !== "x64" ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...files].sort()) ||
      manifest.files["agentProbeRelay.mjs"] !== manifest.sources?.[relaySource]) {
    throw new Error("Agent probe staging manifest does not match this build.");
  }
  for (const path of files) {
    if (sha256(await readFile(join(root, path))) !== manifest.files[path]) throw new Error(`Agent probe asset changed: ${path}`);
  }
  if (sha256(await readFile(join(compilerRoot, "node.exe"))) !== nodeSha256) throw new Error("Agent probe Node identity changed.");
}

/** csc output is not byte-reproducible, so unchanged sources reuse the checked staged tree. */
export async function stageAgentProbe(options = {}) {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  if (platform !== "win32" || arch !== "x64") return { supported: false };
  const destination = resolve(options.destination ?? join(desktopRoot, "resources/agent-probe"));
  const compilerRoot = resolve(options.compilerRoot ?? join(desktopRoot, "resources/app-compiler"));
  const sourceRoot = resolve(options.desktopRoot ?? desktopRoot);
  const sources = {};
  for (const path of [ownerSource, relaySource]) sources[path] = sha256(await readFile(join(sourceRoot, path)));
  // This module is the compile recipe; hash the running copy, not a file under sourceRoot.
  sources[stagerSource] = sha256(await readFile(fileURLToPath(import.meta.url)));
  const current = await readFile(join(destination, "manifest.json"), "utf8").then(JSON.parse, error => { if (error.code === "ENOENT") return null; throw error; });
  if (JSON.stringify(current?.sources) === JSON.stringify(sources) &&
      await requireAgentProbe(destination, compilerRoot, platform, arch).then(() => true, () => false)) {
    return { supported: true, destination, changed: false };
  }
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(`${destination}.staging-`);
  try {
    await compileOwner([join(sourceRoot, ownerSource)], join(staging, "agentProbeOwner.exe"));
    await copyFile(join(sourceRoot, relaySource), join(staging, "agentProbeRelay.mjs"));
    const identities = {};
    for (const path of files) identities[path] = sha256(await readFile(join(staging, path)));
    await writeFile(join(staging, "manifest.json"), JSON.stringify({ nodeSha256, platform, arch, sources, files: identities }, null, 2));
    await requireAgentProbe(staging, compilerRoot, platform, arch);
    const exists = await stat(destination).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
    const previous = `${staging}.previous`;
    if (exists) await rename(destination, previous);
    try { await rename(staging, destination); }
    catch (error) { if (exists) await rename(previous, destination); throw error; }
    // A running owner can keep the replaced tree open; leave it for the build owner.
    const retained = exists ? await rm(previous, { recursive: true, force: true }).then(() => null, () => previous) : null;
    return { supported: true, destination, changed: true, retained };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(JSON.stringify(await stageAgentProbe()));
}
