import { posix, win32 } from "node:path";

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
  if (platform === "linux" && ["arm64", "x64"].includes(arch)) return null;
  if (!(platform === "win32" && arch === "x64" || platform === "darwin" && arch === "arm64")) {
    throw new Error(`Unsupported agent runtime target: ${platform}-${arch}`);
  }
  return paths.join(input.resourcesPath, "app-compiler", platform === "win32" ? "node.exe" : "node");
}
