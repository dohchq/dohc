import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolveSpawnCommand } from "../process/windowsSpawn";
import { runProbeProcess, windowsProbeOwner } from "./agentProbeProcess";
import { probeAgentTools, type ProbeOutput } from "./agentToolProbe";
import { codexConfigFiles, codexMayRunWithoutLogin } from "./codexRunConfig";

// resourcesRoot is chosen by Electron main, never by a workspace or renderer.
export async function runProbe(executable: string, args: readonly string[], signal: AbortSignal, resourcesRoot: string): Promise<ProbeOutput> {
  signal.throwIfAborted();
  const command = resolveSpawnCommand(executable, [...args], { cwd: homedir() });
  return runProbeProcess(command, signal, process.platform === "win32" ? windowsProbeOwner(resourcesRoot) : undefined);
}

export function detectAgentTools(workspaceRoot: string, signal: AbortSignal, resourcesRoot: string) {
  return probeAgentTools({
    platform: process.platform, env: process.env, home: homedir(), workspaceRoot, signal,
    run: (executable, args, probeSignal) => runProbe(executable, args, probeSignal, resourcesRoot),
    codexMayRunWithoutLogin: () => codexMayRunWithoutLogin(process.env, codexConfigFiles(process.env, process.platform)),
    realPath: (path) => {
      try { return realpathSync(path); } catch { return null; }
    },
    isExecutable: (path) => {
      try {
        accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return statSync(path).isFile();
      } catch { return false; }
    },
  });
}
