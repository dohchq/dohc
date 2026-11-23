import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** True when this process is genuinely running from inside an AppImage's
 * own mount -- electron-builder's AppImage target exports this at a real,
 * non-empty path. Some launchers otherwise inherit an EMPTY APPIMAGE from
 * a parent process, which must not be mistaken for one -- boot's
 * stable-copy refresh and this file's command resolver must agree on the
 * same test, or a packaged, non-AppImage install with an empty APPIMAGE in
 * its environment gets treated as an AppImage with no stable copy, and MCP
 * becomes wrongly unavailable even though its ordinary resources/cli-bin
 * is perfectly stable. */
export function isAppImageBoot(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.APPIMAGE);
}

/** True for a macOS app that runs from the temporary copy App Translocation
 * makes of a quarantined download, or from a mounted volume outside the
 * Applications folder at its top, as from a disk image. Either path can go
 * away, so nothing that outlives this launch may name it. */
export function isTemporaryMacAppPath(path: string): boolean {
  if (path.includes("/AppTranslocation/")) return true;
  const [, volumes, volume, top] = path.split("/");
  return volumes === "Volumes" && volume !== undefined && volume !== "" && top !== "Applications";
}

export interface DohcMcpLaunch {
  command: string;
  args: string[];
}

/**
 * The command and leading arguments an external MCP client uses to spawn
 * dohc's stdio MCP server.
 *
 * On Windows, Node.js refuses to spawn `.cmd` batch wrappers when `shell` is
 * false (the default in MCP SDK StdioClientTransport, Claude Desktop, Cursor,
 * and Claude Code), so Windows resolves directly to dohc's bundled `node.exe`
 * plus `cli-bin/dohc-mcp.mjs`.
 *
 * A packaged Linux AppImage returns null when its persistent cli-bin copy is
 * unavailable so a temporary FUSE mount path never reaches a config file. A
 * packaged macOS app on a temporary path returns null for the same reason.
 */
export function resolveDohcMcpLaunch(input: {
  isPackaged: boolean;
  resourcesPath?: string;
  devResourcesPath?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  linuxStableCliBinDir?: string;
  fileExists?: (path: string) => boolean;
}): DohcMcpLaunch | null {
  const env = input.env ?? process.env;
  const override = env.DOHC_MCP_COMMAND?.trim();
  if (override) return { command: override, args: [] };
  const platform = input.platform ?? process.platform;
  const fileExists = input.fileExists ?? existsSync;
  if (!input.isPackaged) {
    if (platform === "win32" && input.devResourcesPath) {
      const devResources = resolve(input.devResourcesPath);
      const nodeExe = join(devResources, "app-compiler", "node.exe");
      const mcpEntry = join(devResources, "cli-bin", "dohc-mcp.mjs");
      if (fileExists(nodeExe) && fileExists(mcpEntry)) {
        return { command: nodeExe, args: [mcpEntry] };
      }
    }
    return { command: "dohc-mcp", args: [] };
  }
  let cliBinDir: string;
  const resourcesPath = resolve(input.resourcesPath ?? dirname(process.execPath));
  if (platform === "linux" && isAppImageBoot(env)) {
    if (!input.linuxStableCliBinDir) return null;
    cliBinDir = input.linuxStableCliBinDir;
  } else if (platform === "darwin" && isTemporaryMacAppPath(input.resourcesPath ?? resourcesPath)) {
    return null;
  } else {
    cliBinDir = join(resourcesPath, "cli-bin");
  }
  if (platform === "win32") {
    return {
      command: join(resourcesPath, "app-compiler", "node.exe"),
      args: [join(cliBinDir, "dohc-mcp.mjs")],
    };
  }
  return { command: join(cliBinDir, "dohc-mcp"), args: [] };
}
