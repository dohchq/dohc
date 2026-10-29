import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { mkdtemp, rmdir } from "node:fs/promises";
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
  /** The installed compiler owner. On macOS and Linux the worker's directory is the only tree the build may read and run. */
  ownerExecutable: string;
  onOwnerSpawn?: (pid: number) => void;
}
export interface CompilerProcessRequest { input: Uint8Array; bounds: CompilerProcessBounds; signal?: AbortSignal }
export interface CompilerProcessResult { stdout: Uint8Array; stderr: Uint8Array }
export class CompilerProcessError extends Error {
  diagnostics?: string;
  /** Safe to copy into a bug report. Never contains compiler input or environment values. */
  details?: string;
  readonly reason: "cancelled" | "timeout" | "memory" | "processes" | "output" | "stderr" | "exit" | "spawn" | "input";
  constructor(reason: CompilerProcessError["reason"], message: string) {
    super(message);this.reason = reason;this.name = "CompilerProcessError";
  }
}

const STARTUP_STAGES = ["owner running", "job assigned", "admitted", "worker spawned", "worker ready"] as const;
const STAGE_PREFIX = "[dohc-compiler] ";
const STDERR_TAIL_BYTES = 128;

/** Only fixed stage names and runtime error codes are safe to copy from stderr. */
function safeStderrLine(line: string): string {
  if (STARTUP_STAGES.some(stage => line === `${STAGE_PREFIX}${stage}`)) return line;
  const codes = line.match(/\b(?:ENOMEM|EPIPE|ERR_WORKER_OUT_OF_MEMORY|STATUS_NO_MEMORY|System\.ComponentModel\.Win32Exception|System\.OutOfMemoryException)\b/g);
  return codes ? [...new Set(codes)].join(" ") : "[redacted stderr]";
}

/** The process that holds the build, and how this caller ends it. */
interface CompilerOwner {
  child: ChildProcess & { stdin: Writable; stdout: Readable; stderr: Readable };
  stop(): void;
  /** Runs once the owner closed, before the result settles. Never rejects. */
  finish(): Promise<void>;
  reasons: ReadonlyMap<number, { reason: CompilerProcessError["reason"]; message: string }>;
}

/** Windows Job Object limits aggregate committed memory, including native esbuild. */
function windowsOwner(runtime: CompilerProcessRuntime, bounds: CompilerProcessBounds, inputBytes: number): CompilerOwner {
  const relayPath = fileURLToPath(new URL("./compilerProcessRelay.mjs", import.meta.url));
  const payload = Buffer.from(JSON.stringify({ worker: runtime.workerPath, args: runtime.workerArgs ?? [] })).toString("base64");
  const environment: NodeJS.ProcessEnv = {};
  // No NODE_OPTIONS, NODE_PATH, compiler overrides, or inherited credentials.
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  const child = spawn(runtime.ownerExecutable, [runtime.nodeExecutable, relayPath, payload, String(bounds.maxMemoryBytes), String(bounds.maxProcesses), String(bounds.timeoutMs), String(inputBytes)], {
    cwd: fileURLToPath(new URL(".", import.meta.url)), env: environment, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
  });
  return { child, stop: () => child.kill("SIGKILL"), finish: async () => {}, reasons: new Map([[124, { reason: "timeout", message: "Compiler owner timed out." }]]) };
}

// The owner's exit codes, from crates/dohc-compiler-owner/src/supervise.rs.
const ownerReasons = new Map<number, { reason: CompilerProcessError["reason"]; message: string }>([
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
 * The owner leads a new process group, confines the worker with Seatbelt on
 * macOS or Landlock and seccomp on Linux, and samples memory and process count. It stops every process it tracks when
 * a bound trips, the deadline passes, or its lifeline on descriptor 3 ends.
 * It removes the build directory itself, without following symlinks a
 * process that escaped its tree may have put there.
 */
async function confinedOwner(runtime: CompilerProcessRuntime, bounds: CompilerProcessBounds, inputBytes: number): Promise<CompilerOwner> {
  const directory = await mkdtemp(join(tmpdir(), "dohc-app-compiler-"));
  const child = spawn(runtime.ownerExecutable, [String(bounds.maxMemoryBytes), String(bounds.maxProcesses), String(bounds.timeoutMs), String(inputBytes),
    dirname(runtime.workerPath), directory, runtime.nodeExecutable, runtime.workerPath, ...(runtime.workerArgs ?? [])],
  // No environment: the owner gives the worker TMPDIR and nothing else.
  { cwd: directory, env: {}, detached: true, shell: false, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  // This caller never writes to the lifeline. Closing it, or this process
  // dying, tells the owner the caller is gone, even while the owner waits on
  // a worker that has not read its input.
  const lifeline = child.stdio[3] as Writable;
  lifeline.on("error", () => {});
  let fallback: NodeJS.Timeout | undefined;
  child.once("exit", () => {
    setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, PIPE_DRAIN_MS).unref();
  });
  return {
    child,
    stop: () => {
      // A closed lifeline makes the owner stop its whole tree, including
      // descendants that left its group. Killing the group would skip those.
      lifeline.destroy();
      fallback ??= setTimeout(() => { if (child.pid !== undefined) void killProcessGroup(child.pid); }, OWNER_STOP_GRACE_MS);
      fallback.unref();
    },
    finish: async () => {
      clearTimeout(fallback);
      lifeline.destroy();
      if (child.pid !== undefined) await killProcessGroup(child.pid);
      // A recursive remove here would follow a symlink an escaped process
      // swapped in. The owner already emptied the directory, so a directory
      // that is not empty stays for the system to clear from the temporary folder.
      await rmdir(directory).catch(() => {});
    },
    reasons: ownerReasons,
  };
}

/** Runs one compile under an owner that bounds and stops everything the worker starts. */
export async function runOwnedCompilerProcess(runtime: CompilerProcessRuntime, request: CompilerProcessRequest): Promise<CompilerProcessResult> {
  if (!["win32", "darwin", "linux"].includes(process.platform)) throw new Error("Compiler process limits are unavailable on this platform.");
  const bounds = { ...request.bounds };
  const signal = request.signal;
  const onOwnerSpawn = runtime.onOwnerSpawn;
  for (const key of ["timeoutMs", "maxMemoryBytes", "maxProcesses", "maxInputBytes", "maxOutputBytes", "maxErrorBytes"] as const) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] < 1) throw new Error("Invalid compiler process bound.");
  }
  if (bounds.timeoutMs > 2_147_483_647) throw new Error("Compiler timeout exceeds the timer range.");
  if (bounds.maxProcesses > 4_294_967_295) throw new Error("Compiler process count exceeds the OS range.");
  if (!(request.input instanceof Uint8Array) || request.input.byteLength > bounds.maxInputBytes) throw new CompilerProcessError("input", "Compiler input bound exceeded.");
  if (![runtime.ownerExecutable, runtime.nodeExecutable, runtime.workerPath].every(path => typeof path === "string" && isAbsolute(path))) throw new Error("Compiler runtime paths must be absolute.");
  if (signal?.aborted) throw new CompilerProcessError("cancelled", "Compiler cancelled.");
  const input = Buffer.from(request.input);
  const started = performance.now();
  const owner = process.platform === "win32" ? windowsOwner(runtime, bounds, input.byteLength) : await confinedOwner(runtime, bounds, input.byteLength);
  const { child } = owner;
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const stages: string[] = [];
    let lastStage = "starting owner", safeTail = "", pendingStderr = Buffer.alloc(0);
    let lastStageIndex = -1;
    let timeoutDetails: string | undefined;
    const elapsed = () => Math.round(performance.now() - started);
    const stage = (name: string) => { lastStage = name;stages.push(`${name}=${elapsed()}ms`); };
    const details = () => `Last stage: ${lastStage}; elapsed=${elapsed()}ms${stages.length ? `; ${stages.join(", ")}` : ""}`;
    const appendTail = (text: string) => { safeTail = Buffer.from(`${safeTail}${safeTail ? "; " : ""}${text}`).subarray(-STDERR_TAIL_BYTES).toString("utf8"); };
    const stderrLine = (line: Buffer) => {
      const text = line.toString("utf8").replace(/\r?\n$/, "");
      const next = STARTUP_STAGES.find(name => text === `${STAGE_PREFIX}${name}`);
      if (next && STARTUP_STAGES.indexOf(next) > lastStageIndex) {
        lastStageIndex = STARTUP_STAGES.indexOf(next);
        stage(next);
        return;
      }
      appendTail(safeStderrLine(text));
      errBytes += line.byteLength;
      if (errBytes > bounds.maxErrorBytes) stop(new CompilerProcessError("stderr", "Compiler diagnostic bound exceeded."));
      else stderr.push(line);
    };
    let outBytes = 0, errBytes = 0, failure: Error | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      if (error instanceof CompilerProcessError && error.reason === "timeout") timeoutDetails = details();
      failure = error;owner.stop();
    };
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
      pendingStderr = Buffer.concat([pendingStderr, chunk]);
      // Hold only a possible stage record. Other bytes spend the bound immediately.
      for (;;) {
        const newline = pendingStderr.indexOf(10);
        const text = pendingStderr.length < 128 ? pendingStderr.toString("utf8") : "";
        const isStagePrefix = text && STARTUP_STAGES.some(name => `${STAGE_PREFIX}${name}\n`.startsWith(text) || `${STAGE_PREFIX}${name}\r\n`.startsWith(text));
        const length = newline >= 0 ? newline + 1 : isStagePrefix ? 0 : pendingStderr.length;
        if (!length) break;
        stderrLine(pendingStderr.subarray(0, length));pendingStderr = pendingStderr.subarray(length);
      }
    });
    child.stdin.on("error", error => {if ((error as NodeJS.ErrnoException).code !== "EPIPE") stop(error);});
    child.once("error", error => { failure ??= new CompilerProcessError("spawn", error.message); });
    child.once("spawn", () => {
      stage("owner spawned");
      try { if (child.pid !== undefined) onOwnerSpawn?.(child.pid); }
      catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
    });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);signal?.removeEventListener("abort", abort);
      if (pendingStderr.length) stderrLine(pendingStderr);
      void owner.finish().then(() => {
        const named = code === null ? undefined : owner.reasons.get(code);
        if (!failure && named) failure = new CompilerProcessError(named.reason, named.message);
        if (failure instanceof CompilerProcessError && failure.reason === "timeout") failure.details = `${timeoutDetails ?? details()}; stderr tail: ${safeTail || "(empty)"}`;
        if (failure) reject(failure);
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
