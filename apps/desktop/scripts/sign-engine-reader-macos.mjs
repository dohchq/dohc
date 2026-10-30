import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { requireEngineReader } from "./stage-engine-reader.mjs";

const run = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const entitlements = fileURLToPath(new URL("../build/entitlements.reader-node.plist", import.meta.url));

async function signApp(options) {
  const require = createRequire(import.meta.url);
  const builder = createRequire(require.resolve("electron-builder/package.json"));
  await builder("app-builder-lib/out/codeSign/macCodeSign.js").sign(options);
}

/** electron-builder calls this after resolving the app identity, before notarization. */
export default async function signEngineReaderMacOS(options, _packager, operations = { run, signApp }) {
  if (options.platform !== "darwin") throw new Error("Reader signing requires macOS.");
  const setMode = operations.chmod ?? chmod;
  const resources = join(options.app, "Contents/Resources");
  const { generation } = JSON.parse(await readFile(join(resources, "engine-reader/selection.json"), "utf8"));
  if (typeof generation !== "string" || !/^[a-f0-9]{64}$/.test(generation)) throw new Error("Invalid reader generation.");
  const { runtime: { arch } } = JSON.parse(await readFile(join(resources, "engine-reader", generation, "manifest.json"), "utf8"));
  const config = await requireEngineReader(resources, "darwin", arch);
  if (!config) throw new Error("No reader runtime for the macOS signing architecture.");
  const base = dirname(dirname(config.node));
  const oldRoot = dirname(config.node);
  const manifest = JSON.parse(await readFile(config.manifest, "utf8"));
  await setMode(base, 0o755);
  await setMode(oldRoot, 0o755);
  async function signNode(node) {
    // Detach any staging hard link before changing permissions or signing bytes.
    const temporaryNode = join(dirname(node), `.node-signing-${process.pid}`);
    await copyFile(node, temporaryNode);
    await rename(temporaryNode, node);
    await setMode(node, 0o755);
    const args = ["--force", "--sign", options.identity, "--options", "runtime",
      "--entitlements", entitlements, options.identity === "-" ? "--timestamp=none" : "--timestamp",
      ...(options.keychain ? ["--keychain", options.keychain] : []), node];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await operations.run("/usr/bin/codesign", args);
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        await (operations.wait ?? delay)(attempt * 5000);
      }
    }
    await operations.run("/usr/bin/codesign", ["--verify", "--strict", node]);
  }
  await signNode(config.node);
  manifest.runtime.sha256 = hash(await readFile(config.node));
  const { sources, buildSha256, ...built } = manifest;
  manifest.buildSha256 = hash(JSON.stringify(built));
  const temporaryManifest = join(oldRoot, `.manifest-signing-${process.pid}.json`);
  await writeFile(temporaryManifest, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644, flag: "wx" });
  await rename(temporaryManifest, config.manifest);
  await setMode(config.manifest, 0o644);
  await setMode(config.node, 0o755);
  const root = join(base, manifest.buildSha256);
  if (root !== oldRoot) await rename(oldRoot, root);
  const selection = join(base, "selection.json");
  const temporarySelection = join(base, `.selection-signing-${process.pid}.json`);
  await writeFile(temporarySelection, JSON.stringify({ generation: manifest.buildSha256 }) + "\n", { mode: 0o644, flag: "wx" });
  await rename(temporarySelection, selection);
  await setMode(selection, 0o644);
  await setMode(root, 0o755);
  await setMode(base, 0o755);

  const compilerNode = resolve(resources, "app-compiler/node");
  const compilerManifestPath = join(resources, "app-compiler/manifest.json");
  const compilerManifest = JSON.parse(await readFile(compilerManifestPath, "utf8"));
  await signNode(compilerNode);
  // files.node identifies the signed app copy; nodeVersion and nodeSha256 retain the verified upstream identity.
  compilerManifest.files.node = hash(await readFile(compilerNode));
  const temporaryCompilerManifest = join(resources, "app-compiler", `.manifest-signing-${process.pid}.json`);
  await writeFile(temporaryCompilerManifest, JSON.stringify(compilerManifest, null, 2) + "\n", { flag: "wx" });
  await rename(temporaryCompilerManifest, compilerManifestPath);

  // Keep both signed Nodes unchanged through the outer signing pass.
  const readerNode = resolve(root, "node");
  await operations.signApp({ ...options, ignore: file =>
    resolve(file) === readerNode || resolve(file) === compilerNode || Boolean(options.ignore?.(file)) });
  if (hash(await readFile(readerNode)) !== manifest.runtime.sha256) throw new Error("Signing changed the pinned reader runtime.");
  if (hash(await readFile(compilerNode)) !== compilerManifest.files.node) throw new Error("Signing changed the pinned app compiler runtime.");
}
