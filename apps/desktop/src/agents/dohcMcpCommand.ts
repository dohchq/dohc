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
export function isAppImageBoot(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env.APPIMAGE);
}

/**
 * The dohc-mcp command a chat session config points the user's AI tool at.
 *
 * A packaged install ships the launcher in its cli-bin extraResource
 * (build-cli-bin.mjs stages it; scripts/package-smoke.mjs asserts it), so
 * the resolved command is that file's absolute path -- a bare `dohc-mcp`
 * exists on no user's PATH. Dev keeps the bare name: the workspace's
 * node_modules/.bin provides it. DOHC_MCP_COMMAND stays the explicit
 * override either way.
 *
 * A packaged Linux AppImage returns null when its persistent cli-bin copy
 * is unavailable. The caller must not write a command in that case: the
 * fallback resources path is inside the AppImage's temporary FUSE mount and
 * must never reach a config file or a spawned process's environment.
 */
export function resolveDohcMcpCommand(input: {
  isPackaged: boolean;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  linuxStableCliBinDir?: string;
}): string | null {
  const env = input.env ?? process.env;
  const override = env.DOHC_MCP_COMMAND?.trim();
  if (override) return override;
  if (!input.isPackaged) return "dohc-mcp";
  const platform = input.platform ?? process.platform;
  let cliBinDir: string;
  if (platform === "linux" && isAppImageBoot(env)) {
    if (!input.linuxStableCliBinDir) return null;
    cliBinDir = input.linuxStableCliBinDir;
  } else {
    cliBinDir = resolve(input.resourcesPath ?? dirname(process.execPath), "cli-bin");
  }
  return join(
    cliBinDir,
    platform === "win32" ? "dohc-mcp.cmd" : "dohc-mcp",
  );
}

/**
 * The plugin host's own env, layered onto the ambient process env: the
 * resolved dohc-mcp command when one exists, or an explicit "unavailable"
 * marker when it doesn't -- never both, and never a stale leftover of
 * whichever one applied on a previous call (a workspace's plugin host can
 * respawn after this install's launcher availability changes, e.g. once a
 * boot's stable-copy refresh finally succeeds).
 */
export function pluginHostEnvFor(
  dohcMcpCommand: string | null,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  if (dohcMcpCommand === null) {
    delete env.DOHC_MCP_COMMAND;
    env.DOHC_MCP_COMMAND_UNAVAILABLE = "1";
  } else {
    env.DOHC_MCP_COMMAND = dohcMcpCommand;
    delete env.DOHC_MCP_COMMAND_UNAVAILABLE;
  }
  return env;
}
