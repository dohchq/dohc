import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
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
  onOwnerSpawn?: (pid: number) => void;
}
export interface CompilerProcessRequest { input: Uint8Array; bounds: CompilerProcessBounds; signal?: AbortSignal }
export interface CompilerProcessResult { stdout: Uint8Array; stderr: Uint8Array }
export class CompilerProcessError extends Error {
  diagnostics?: string;
  readonly reason: "cancelled" | "timeout" | "output" | "stderr" | "exit" | "spawn" | "input";
  constructor(reason: CompilerProcessError["reason"], message: string) {
    super(message);this.reason = reason;this.name = "CompilerProcessError";
  }
}

/** Windows Job Object limits aggregate committed memory, including native esbuild. */
export async function runOwnedCompilerProcess(runtime: CompilerProcessRuntime, request: CompilerProcessRequest): Promise<CompilerProcessResult> {
  if (process.platform !== "win32") throw new Error("Compiler process limits are unavailable on this platform.");
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
  const command = `& ([scriptblock]::Create([IO.File]::ReadAllText(${quote(ownerPath)}))) ${[runtime.nodeExecutable, relayPath, payload, String(bounds.maxMemoryBytes), String(bounds.maxProcesses), String(bounds.timeoutMs), String(input.byteLength)].map(quote).join(" ")}`;
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd: fileURLToPath(new URL(".", import.meta.url)), env: environment, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outBytes = 0, errBytes = 0, failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error;child.kill("SIGKILL"); };
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
      if (failure) reject(failure);
      else if (code === 124) reject(new CompilerProcessError("timeout", "Compiler owner timed out."));
      else if (code !== 0) {
        const error = new CompilerProcessError("exit", `Compiler exited (${exitSignal ?? code}).`);
        error.diagnostics = Buffer.concat(stderr).toString("utf8");reject(error);
      }
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    // Exact input length frames the request. Keep stdin open as a caller-lifetime
    // pipe; the owner closes worker input after forwarding that frame.
    child.stdin.write(input);
  });
}
