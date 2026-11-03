import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolveSpawnCommand } from "../process/windowsSpawn";
import { runProbeProcess, windowsProbeOwner } from "./agentProbeProcess";
import { supportsAgentProfile } from "./agentToolCatalog";
import { parseToolVersion, probeAgentTools, type ProbeOutput } from "./agentToolProbe";
import { codexConfigFiles, codexMayRunWithoutLogin } from "./codexRunConfig";

// resourcesRoot is chosen by Electron main, never by a workspace or renderer.
export async function runProbe(executable: string, args: readonly string[], signal: AbortSignal, resourcesRoot: string): Promise<ProbeOutput> {
  signal.throwIfAborted();
  const command = resolveSpawnCommand(executable, [...args], { cwd: homedir() });
  return runProbeProcess(command, signal, process.platform === "win32" ? windowsProbeOwner(resourcesRoot) : undefined);
}

// Supported versions by resolved path, kept while the file's size and modified
// time stay the same. Any other result is checked again next time, so an update
// through a launcher that doesn't change still takes effect.
const reportedVersions = new Map<string, { size: number; mtimeMs: number; version: string }>();

// The version an installed tool reports, or null when it reports none.
export async function agentToolVersion(executable: string, resourcesRoot: string): Promise<string | null> {
  const file = await realpath(executable).then(async (path) => {
    const { size, mtimeMs } = await stat(path);
    return { path, size, mtimeMs };
  }).catch(() => null);
  const kept = file && reportedVersions.get(file.path);
  if (file && kept && kept.size === file.size && kept.mtimeMs === file.mtimeMs) return kept.version;
  const output = await runProbe(executable, ["--version"], new AbortController().signal, resourcesRoot);
  const version = output.exitCode === 0 ? parseToolVersion(output.stdout) : null;
  if (file && version && supportsAgentProfile("claude", version)) reportedVersions.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, version });
  return version;
}

export function detectAgentTools(workspaceRoot: string, signal: AbortSignal, resourcesRoot: string) {
  return probeAgentTools({
    platform: process.platform, env: process.env, home: homedir(), workspaceRoot, signal,
    stat: statSync,
    run: (executable, args, probeSignal) => runProbe(executable, args, probeSignal, resourcesRoot),
    codexMayRunWithoutLogin: () => codexMayRunWithoutLogin(process.env, codexConfigFiles(process.env, process.platform)),
    realPath: (path) => {
      // Native realpath returns stored names on Windows and macOS. The JavaScript
      // form still resolves on drives where the native call fails.
      try { return realpathSync.native(path); } catch {
        try { return realpathSync(path); } catch { return null; }
      }
    },
    isExecutable: (path) => {
      try {
        accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return statSync(path).isFile();
      } catch { return false; }
    },
  });
}
