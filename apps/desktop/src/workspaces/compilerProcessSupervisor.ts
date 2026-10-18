import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CompilerProcessBounds {
  timeoutMs: number;
  maxMemoryBytes: number;
  maxProcesses: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxErrorBytes: number;
}
/** Installed runtime paths and arguments, never app-supplied commands. */
export interface CompilerProcessRuntime {
  nodeExecutable: string;
  workerPath: string;
  workerArgs?: readonly string[];
  /** macOS: the installed compiler-owner. The worker's directory is the only tree the build may read and run. */
  ownerExecutable?: string;
  onOwnerSpawn?: (pid: number) => void;
}
export interface CompilerProcessRequest { input: Uint8Array; bounds: CompilerProcessBounds; signal?: AbortSignal }
export interface CompilerProcessResult { stdout: Uint8Array; stderr: Uint8Array }
export class CompilerProcessError extends Error {
  diagnostics?: string;
  readonly reason: "cancelled" | "timeout" | "memory" | "processes" | "output" | "stderr" | "exit" | "spawn" | "input";
  constructor(reason: CompilerProcessError["reason"], message: string) {
    super(message);this.reason = reason;this.name = "CompilerProcessError";
  }
}

/** The process that holds the build, and how this caller ends it. */
interface CompilerOwner {
  child: ChildProcessWithoutNullStreams;
  stop(): void;
  /** Runs once the owner closed, before the result settles. Never rejects. */
  finish(): Promise<void>;
  reasons: ReadonlyMap<number, { reason: CompilerProcessError["reason"]; message: string }>;
}

/** Windows Job Object limits aggregate committed memory, including native esbuild. */
function windowsOwner(runtime: CompilerProcessRuntime, bounds: CompilerProcessBounds, inputBytes: number): CompilerOwner {
  const ownerPath = fileURLToPath(new URL("./windowsCompilerJob.ps1", import.meta.url));
  const relayPath = fileURLToPath(new URL("./compilerProcessRelay.mjs", import.meta.url));
  const payload = Buffer.from(JSON.stringify({ worker: runtime.workerPath, args: runtime.workerArgs ?? [] })).toString("base64");
  const environment: NodeJS.ProcessEnv = {};
  // No NODE_OPTIONS, NODE_PATH, compiler overrides, or inherited credentials.
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = `& ([scriptblock]::Create([IO.File]::ReadAllText(${quote(ownerPath)}))) ${[runtime.nodeExecutable, relayPath, payload, String(bounds.maxMemoryBytes), String(bounds.maxProcesses), String(bounds.timeoutMs), String(inputBytes)].map(quote).join(" ")}`;
  const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: fileURLToPath(new URL(".", import.meta.url)), env: environment, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
  });
  return { child, stop: () => child.kill("SIGKILL"), finish: async () => {}, reasons: new Map([[124, { reason: "timeout", message: "Compiler owner timed out." }]]) };
}

// The macOS owner's exit codes, from crates/dohc-compiler-owner/src/supervise.rs.
const macosReasons = new Map<number, { reason: CompilerProcessError["reason"]; message: string }>([
  [122, { reason: "processes", message: "Compiler process bound exceeded." }],
  [123, { reason: "memory", message: "Compiler memory bound exceeded." }],
  [124, { reason: "timeout", message: "Compiler owner timed out." }],
]);
/** The owner's own teardown takes at most 2 s. Past this, the caller kills the group itself. */
const OWNER_STOP_GRACE_MS = 3_000;
const GROUP_KILL_MS = 2_000;
/** After the owner exits nothing in its tree writes, so pipes held open longer belong to a process that escaped it. */
const PIPE_DRAIN_MS = 500;

/**
 * Kills the owner's process group until none of it is left. A fork in flight
 * can create a member one signal misses. EPERM means only the exited owner,
 * not yet reaped, is left.
 */
async function killProcessGroup(group: number): Promise<void> {
  const deadline = Date.now() + GROUP_KILL_MS;
  while (Date.now() < deadline) {
    try { process.kill(-group, "SIGKILL"); }
    catch (error) {
      // ESRCH: the group is gone. Anything else but EPERM cannot improve.
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return;
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

/**
 * The owner leads a new process group, confines the worker with Seatbelt, and
 * samples memory and process count. It stops every process it tracks when
 * a bound trips, the deadline passes, or its stdin ends.
 */
async function macosOwner(runtime: CompilerProcessRuntime, bounds: CompilerProcessBounds, inputBytes: number): Promise<CompilerOwner> {
  if (!runtime.ownerExecutable || !isAbsolute(runtime.ownerExecutable)) throw new Error("Compiler runtime paths must be absolute.");
  const directory = await mkdtemp(join(tmpdir(), "dohc-app-compiler-"));
  const child = spawn(runtime.ownerExecutable, [String(bounds.maxMemoryBytes), String(bounds.maxProcesses), String(bounds.timeoutMs), String(inputBytes),
    dirname(runtime.workerPath), directory, runtime.nodeExecutable, runtime.workerPath, ...(runtime.workerArgs ?? [])],
  // No environment: the owner gives the worker TMPDIR and nothing else.
  { cwd: directory, env: {}, detached: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let fallback: NodeJS.Timeout | undefined;
  child.once("exit", () => {
    setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, PIPE_DRAIN_MS).unref();
  });
  return {
    child,
    stop: () => {
      // EOF on the lifeline makes the owner stop its whole tree, including
      // descendants that left its group. Killing the group would skip those.
      child.stdin.destroy();
      fallback ??= setTimeout(() => { if (child.pid !== undefined) void killProcessGroup(child.pid); }, OWNER_STOP_GRACE_MS);
      fallback.unref();
    },
    finish: async () => {
      clearTimeout(fallback);
      if (child.pid !== undefined) await killProcessGroup(child.pid);
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    },
    reasons: macosReasons,
  };
}

/** Runs one compile under an owner that bounds and stops everything the worker starts. */
export async function runOwnedCompilerProcess(runtime: CompilerProcessRuntime, request: CompilerProcessRequest): Promise<CompilerProcessResult> {
  if (process.platform !== "win32" && process.platform !== "darwin") throw new Error("Compiler process limits are unavailable on this platform.");
  const bounds = { ...request.bounds };
  const signal = request.signal;
  const onOwnerSpawn = runtime.onOwnerSpawn;
  for (const key of ["timeoutMs", "maxMemoryBytes", "maxProcesses", "maxInputBytes", "maxOutputBytes", "maxErrorBytes"] as const) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] < 1) throw new Error("Invalid compiler process bound.");
  }
  if (bounds.timeoutMs > 2_147_483_647) throw new Error("Compiler timeout exceeds the timer range.");
  if (bounds.maxProcesses > 4_294_967_295) throw new Error("Compiler process count exceeds the OS range.");
  if (!(request.input instanceof Uint8Array) || request.input.byteLength > bounds.maxInputBytes) throw new CompilerProcessError("input", "Compiler input bound exceeded.");
  if (!isAbsolute(runtime.nodeExecutable) || !isAbsolute(runtime.workerPath)) throw new Error("Compiler runtime paths must be absolute.");
  if (signal?.aborted) throw new CompilerProcessError("cancelled", "Compiler cancelled.");
  const input = Buffer.from(request.input);
  const owner = process.platform === "win32" ? windowsOwner(runtime, bounds, input.byteLength) : await macosOwner(runtime, bounds, input.byteLength);
  const { child } = owner;
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outBytes = 0, errBytes = 0, failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error;owner.stop(); };
    const abort = () => stop(new CompilerProcessError("cancelled", "Compiler cancelled."));
    const timer = setTimeout(() => stop(new CompilerProcessError("timeout", "Compiler timed out.")), bounds.timeoutMs);
    timer.unref();signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.byteLength;
      if (outBytes > bounds.maxOutputBytes) stop(new CompilerProcessError("output", "Compiler output bound exceeded."));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errBytes += chunk.byteLength;
      if (errBytes > bounds.maxErrorBytes) stop(new CompilerProcessError("stderr", "Compiler diagnostic bound exceeded."));
      else stderr.push(chunk);
    });
    child.stdin.on("error", error => {if ((error as NodeJS.ErrnoException).code !== "EPIPE") stop(error);});
    child.once("error", error => { failure ??= new CompilerProcessError("spawn", error.message); });
    child.once("spawn", () => {
      try { if (child.pid !== undefined) onOwnerSpawn?.(child.pid); }
      catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
    });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);signal?.removeEventListener("abort", abort);
      void owner.finish().then(() => {
        const named = code === null ? undefined : owner.reasons.get(code);
        if (failure) reject(failure);
        else if (named) reject(new CompilerProcessError(named.reason, named.message));
        else if (code !== 0) {
          const error = new CompilerProcessError("exit", `Compiler exited (${exitSignal ?? code}).`);
          error.diagnostics = Buffer.concat(stderr).toString("utf8");reject(error);
        }
        else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
    });
    // Exact input length frames the request. Keep stdin open as a caller-lifetime
    // pipe; the owner closes worker input after forwarding that frame.
    child.stdin.write(input);
  });
}
