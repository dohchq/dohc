import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { killChildTreeWin32, resolveSpawnCommand } from "../process/windowsSpawn";
import { probeAgentTools, type ProbeOutput } from "./agentToolProbe";

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_OUTPUT_LIMIT = 64 * 1024;

// Settles only after the child and its output pipes close and any tree kill it
// started finishes, so a probe never outlives its caller. Cancellation rejects
// with the signal's reason; a timeout, output overflow or child error resolves
// as a failed probe. A setup failure after spawn rejects once the child drains.
export function runProbe(executable: string, args: readonly string[], signal: AbortSignal): Promise<ProbeOutput> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const command = resolveSpawnCommand(executable, [...args], { cwd: homedir() });
    // Node can return a child without pipes and report its spawn failure later.
    const child: ChildProcess = spawn(command.command, command.args, {
      cwd: homedir(), env: process.env, windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let closed = false;
    let stopped = false;
    let settled = false;
    let killing: Promise<void> | undefined;
    let setupFailure: { error: unknown } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (settled || !closed || killing) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      child.off("error", stop).off("close", onClose);
      child.stdout?.off("data", onStdout).off("error", stop);
      child.stderr?.off("data", onStderr).off("error", stop);
      if (signal.aborted) reject(signal.reason);
      else if (setupFailure) reject(setupFailure.error);
      else resolve({ exitCode: stopped ? null : exitCode, stdout, stderr });
    };
    const onKilled = () => { killing = undefined; settle(); };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (!child.pid) return;
      // A failed kill is not drainage; the probe still waits for the child to close.
      if (process.platform === "win32") killing = killChildTreeWin32(child).then(onKilled, onKilled);
      else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    };
    // After a stop, keep reading so the pipes can close, but discard the output.
    const onStdout = (text: string) => { if (stopped) return; stdout += text; if (stdout.length + stderr.length > PROBE_OUTPUT_LIMIT) stop(); };
    const onStderr = (text: string) => { if (stopped) return; stderr += text; if (stdout.length + stderr.length > PROBE_OUTPUT_LIMIT) stop(); };
    const onClose = (code: number | null) => { closed = true; exitCode = code; settle(); };
    child.on("error", stop).on("close", onClose);
    signal.addEventListener("abort", stop, { once: true });
    try {
      child.stdout?.setEncoding("utf8").on("data", onStdout).on("error", stop);
      child.stderr?.setEncoding("utf8").on("data", onStderr).on("error", stop);
      timer = setTimeout(stop, PROBE_TIMEOUT_MS);
    } catch (error) {
      setupFailure = { error };
      stop();
    }
    // Cancellation during command resolution or spawn fired before the listener existed.
    if (signal.aborted) stop();
  });
}

export function detectAgentTools(workspaceRoot: string, signal: AbortSignal) {
  return probeAgentTools({
    platform: process.platform, env: process.env, home: homedir(), workspaceRoot, signal, run: runProbe,
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
