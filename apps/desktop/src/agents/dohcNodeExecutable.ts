import { posix, win32 } from "node:path";
import { agentRuntimeTarget } from "../../scripts/mcp-launchers.mjs";

export function resolveDohcNodeExecutable(input: {
  resourcesPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): string | null {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const paths = platform === "win32" ? win32 : posix;
  if (!paths.isAbsolute(input.resourcesPath) || platform === "win32" && !win32.parse(input.resourcesPath).root.startsWith("\\\\") && !/^[a-z]:[\\/]/iu.test(input.resourcesPath)) {
    throw new Error("Agent resources path must be absolute.");
  }
  if (agentRuntimeTarget(platform, arch) === "path") return null;
  return paths.join(input.resourcesPath, "app-compiler", platform === "win32" ? "node.exe" : "node");
}
