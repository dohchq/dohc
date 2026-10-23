import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
export default async function signEngineReaderMacOS(options, packager, operations = { run, signApp }) {
  if (options.platform !== "darwin") throw new Error("Reader signing requires macOS.");
  if (!options.identity) {
    if (packager.forceCodeSigning) throw new Error("Reader signing requires the macOS app identity.");
    return;
  }
  const resources = join(options.app, "Contents/Resources");
  const { generation } = JSON.parse(await readFile(join(resources, "engine-reader/selection.json"), "utf8"));
  if (typeof generation !== "string" || !/^[a-f0-9]{64}$/.test(generation)) throw new Error("Invalid reader generation.");
  const { runtime: { arch } } = JSON.parse(await readFile(join(resources, "engine-reader", generation, "manifest.json"), "utf8"));
  const config = await requireEngineReader(resources, "darwin", arch);
  if (!config) throw new Error("No reader runtime for the macOS signing architecture.");
  const base = dirname(dirname(config.node));
  const oldRoot = dirname(config.node);
  const manifest = JSON.parse(await readFile(config.manifest, "utf8"));
  await chmod(oldRoot, 0o700);
  await chmod(config.node, 0o755);
  await operations.run("/usr/bin/codesign", ["--force", "--sign", options.identity, "--options", "runtime",
    "--entitlements", entitlements, options.identity === "-" ? "--timestamp=none" : "--timestamp",
    ...(options.keychain ? ["--keychain", options.keychain] : []), config.node]);
  await operations.run("/usr/bin/codesign", ["--verify", "--strict", config.node]);
  manifest.runtime.sha256 = hash(await readFile(config.node));
  const { sources, buildSha256, ...built } = manifest;
  manifest.buildSha256 = hash(JSON.stringify(built));
  await chmod(config.manifest, 0o644);
  await writeFile(config.manifest, JSON.stringify(manifest, null, 2) + "\n");
  await chmod(config.manifest, 0o444);
  await chmod(config.node, 0o555);
  const root = join(base, manifest.buildSha256);
  if (root !== oldRoot) await rename(oldRoot, root);
  await writeFile(join(base, "selection.json"), JSON.stringify({ generation: manifest.buildSha256 }) + "\n");
  await chmod(root, 0o555);

  // Keep the pinned reader bytes and the compiler's official OpenJS signature.
  const readerNode = resolve(root, "node"), compilerNode = resolve(resources, "app-compiler/node");
  await operations.signApp({ ...options, ignore: file =>
    resolve(file) === readerNode || resolve(file) === compilerNode || Boolean(options.ignore?.(file)) });
  if (hash(await readFile(readerNode)) !== manifest.runtime.sha256) throw new Error("Signing changed the pinned reader runtime.");
}
