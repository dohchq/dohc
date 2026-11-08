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
type FileStamp = { path: string; size: number; mtimeMs: number };
const reportedVersions = new Map<string, FileStamp & { version: string }>();

function fileStamp(executable: string): Promise<FileStamp | null> {
  return realpath(executable).then(async (path) => {
    const { size, mtimeMs } = await stat(path);
    return { path, size, mtimeMs };
  }).catch(() => null);
}

function sameFile(a: FileStamp, b: FileStamp): boolean {
  return a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

// The version Claude Code reports, or null when it reports none.
export async function claudeCodeVersion(executable: string, resourcesRoot: string): Promise<string | null> {
  const before = await fileStamp(executable);
  const kept = before && reportedVersions.get(before.path);
  if (before && kept && sameFile(kept, before)) return kept.version;
  const output = await runProbe(executable, ["--version"], new AbortController().signal, resourcesRoot);
  const version = output.exitCode === 0 ? parseToolVersion(output.stdout) : null;
  if (before && version && supportsAgentProfile("claude", version)) {
    // Keep it only when the file is still the one stamped before the check ran.
    const after = await fileStamp(executable);
    if (after && sameFile(after, before)) reportedVersions.set(before.path, { ...before, version });
  }
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
