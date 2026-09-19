import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { killChildTreeWin32, resolveSpawnCommand } from "../process/windowsSpawn";
import { probeAgentTools, type ProbeOutput } from "./agentToolProbe";

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_OUTPUT_LIMIT = 64 * 1024;

function runProbe(executable: string, args: readonly string[]): Promise<ProbeOutput> {
  return new Promise((resolve) => {
    const command = resolveSpawnCommand(executable, [...args], { cwd: homedir() });
    const child = spawn(command.command, command.args, {
      cwd: homedir(), env: process.env, windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    };
    const stop = () => {
      if (process.platform === "win32") void killChildTreeWin32(child);
      else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
      finish(null);
    };
    const timer = setTimeout(stop, PROBE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => { if (settled) return; stdout += text; if (stdout.length + stderr.length > PROBE_OUTPUT_LIMIT) stop(); });
    child.stderr.on("data", (text: string) => { if (settled) return; stderr += text; if (stdout.length + stderr.length > PROBE_OUTPUT_LIMIT) stop(); });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

export function detectAgentTools(workspaceRoot: string) {
  return probeAgentTools({
    platform: process.platform, env: process.env, home: homedir(), workspaceRoot, run: runProbe,
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
