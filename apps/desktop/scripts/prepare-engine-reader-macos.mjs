import { chmod, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { requireEngineReader } from "./stage-engine-reader.mjs";

/** afterPack owns only the app copy, including unsigned development packages. */
export default async function prepareEngineReaderMacOS(context, { chmod: setMode = chmod } = {}) {
  if (context.electronPlatformName !== "darwin") return;
  const resources = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents/Resources");
  const arch = context.arch === undefined ? process.arch : context.arch === 1 ? "x64" : context.arch === 3 ? "arm64" : "unsupported";
  const config = await requireEngineReader(resources, "darwin", arch);
  if (!config) throw new Error("No reader runtime for the macOS packaging architecture.");
  const root = dirname(config.node), base = dirname(root);
  const { generation } = JSON.parse(await readFile(join(base, "selection.json"), "utf8"));
  await setMode(base, 0o755);
  for (const entry of await readdir(base)) {
    if (![generation, "selection.json", "node-LICENSE.txt"].includes(entry)) await rm(join(base, entry), { recursive: true, force: true });
  }
  await setMode(join(base, "selection.json"), 0o444);
  await setMode(config.manifest, 0o444);
  await setMode(config.bundle, 0o444);
  await setMode(config.node, 0o555);
  await setMode(root, 0o755);
  await setMode(base, 0o755);
}
