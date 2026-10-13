import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ProbeOutput } from "./agentToolProbe";

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_OUTPUT_LIMIT = 64 * 1024;
// agentProbeOwner.cs accepts the same bound.
const MAX_ADMISSION_BYTES = 16 * 1024 * 1024;

export interface ProbeCommand { command: string; args: readonly string[]; windowsVerbatimArguments?: boolean }
/** Installed paths chosen by Electron main, never by a workspace or renderer. */
export interface WindowsProbeOwner { root: string; executable: string; relay: string; node: string }

// The relay runs on the Node staged with the app compiler. Without these
// trusted assets, detection fails instead of starting an unowned command.
export function windowsProbeOwner(resourcesRoot: string): WindowsProbeOwner {
  if (process.arch !== "x64") throw new Error("Agent detection on Windows requires x64.");
  if (!isAbsolute(resourcesRoot)) throw new Error("Agent probe resources path must be absolute.");
  const root = join(resourcesRoot, "agent-probe");
  const owner = {
    root, executable: join(root, "agentProbeOwner.exe"), relay: join(root, "agentProbeRelay.mjs"),
    node: join(resourcesRoot, "app-compiler", "node.exe"),
  };
  for (const path of [owner.executable, owner.relay, owner.node]) {
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) throw new Error(`Agent detection is missing ${path}.`);
  }
  return owner;
}

// Settles only after the child and its output pipes close, so a probe never
// outlives its caller. On Windows the child is the probe owner: closing its
// stdin stops the probe, and it exits only after every process in the probe's
// job has exited. Cancellation rejects with the signal's reason; a timeout,
// output overflow or child error resolves as a failed probe. A setup failure
// after spawn rejects once the child drains.
export function runProbeProcess(command: ProbeCommand, signal: AbortSignal, owner?: WindowsProbeOwner): Promise<ProbeOutput> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const windows = process.platform === "win32";
    let admission: Buffer | undefined;
    let child: ChildProcess;
    if (windows) {
      if (!owner) throw new Error("Agent detection on Windows requires its probe owner.");
      // The environment carries credentials, so it travels over stdin, never a command line.
      admission = Buffer.from(JSON.stringify({
        command: command.command, args: command.args,
        windowsVerbatimArguments: command.windowsVerbatimArguments ?? false, cwd: homedir(), env: process.env,
      }));
      if (admission.byteLength > MAX_ADMISSION_BYTES) throw new Error("The agent probe environment is too large.");
      // No NODE_OPTIONS, NODE_PATH or credentials reach the owner or relay.
      const environment: NodeJS.ProcessEnv = {};
      for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
        if (process.env[name] !== undefined) environment[name] = process.env[name];
      }
      child = spawn(owner.executable, [owner.node, owner.relay, String(admission.byteLength)], {
        cwd: owner.root, env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      // Node can return a child without pipes and report its spawn failure later.
      child = spawn(command.command, command.args, {
        cwd: homedir(), env: process.env, windowsHide: true,
        windowsVerbatimArguments: command.windowsVerbatimArguments, detached: true, stdio: ["ignore", "pipe", "pipe"],
      });
    }
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let closed = false;
    let stopped = false;
    let settled = false;
    let setupFailure: { error: unknown } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (settled || !closed) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      child.off("error", stop).off("close", onClose);
      child.stdin?.off("error", stop);
      child.stdout?.off("data", onStdout).off("error", stop);
      child.stderr?.off("data", onStderr).off("error", stop);
      if (signal.aborted) reject(signal.reason);
      else if (setupFailure) reject(setupFailure.error);
      else resolve({ exitCode: stopped ? null : exitCode, stdout, stderr });
    };
    // A stop that does not end the child is not drainage; the probe still waits for it to close.
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (windows) child.stdin?.destroy();
      else if (child.pid) {
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
      child.stdin?.on("error", stop);
      child.stdout?.setEncoding("utf8").on("data", onStdout).on("error", stop);
      child.stderr?.setEncoding("utf8").on("data", onStderr).on("error", stop);
      timer = setTimeout(stop, PROBE_TIMEOUT_MS);
    } catch (error) {
      setupFailure = { error };
      stop();
    }
    // Cancellation during command resolution or spawn fired before the listener existed.
    if (signal.aborted) stop();
    // The owner starts a command only after this write, so a probe stopped
    // during spawn or setup starts nothing.
    else if (admission && !stopped) child.stdin?.write(admission);
  });
}
