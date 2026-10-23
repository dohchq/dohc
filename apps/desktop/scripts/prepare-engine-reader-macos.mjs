import { chmod, lstat, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { requireEngineReader } from "./stage-engine-reader.mjs";

async function discard(path) {
  const directory = (await lstat(path)).isDirectory();
  if (directory) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await discard(join(path, entry));
  }
  await rm(path, { recursive: directory, force: true });
}

/** afterPack owns only the app copy, including unsigned development packages. */
export default async function prepareEngineReaderMacOS(context, { chmod: setMode = chmod } = {}) {
  if (context.electronPlatformName !== "darwin") return;
  const resources = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents/Resources");
  const config = await requireEngineReader(resources, "darwin", "arm64");
  const root = dirname(config.node), base = dirname(root);
  const { generation } = JSON.parse(await readFile(join(base, "selection.json"), "utf8"));
  await setMode(base, 0o755);
  for (const entry of await readdir(base)) {
    if (![generation, "selection.json", "node-LICENSE.txt"].includes(entry)) await discard(join(base, entry));
  }
  await setMode(join(base, "selection.json"), 0o444);
  await setMode(config.manifest, 0o444);
  await setMode(config.bundle, 0o444);
  await setMode(config.node, 0o555);
  await setMode(root, 0o555);
  await setMode(base, 0o555);
}
