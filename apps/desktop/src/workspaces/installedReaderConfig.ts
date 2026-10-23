import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Main-process installation paths only. Missing preparation disables the reader. */
export function installedReaderConfig(resources: string | undefined, platform = process.platform, arch = process.arch): string | undefined {
  const supported = platform === "darwin" ? ["arm64", "x64"].includes(arch) : ["win32", "linux"].includes(platform) && arch === "x64";
  if (!resources || !supported) return;
  try {
    const { generation } = JSON.parse(readFileSync(join(resources, "engine-reader/selection.json"), "utf8"));
    if (typeof generation !== "string" || !/^[a-f0-9]{64}$/.test(generation)) return;
    const root = resolve(resources, "engine-reader", generation);
    return JSON.stringify({ node: platform === "win32" ? resolve(resources, "app-compiler/node.exe") : join(root, "node"),
      bundle: join(root, "reader.cjs"), manifest: join(root, "manifest.json") });
  } catch { return; }
}
