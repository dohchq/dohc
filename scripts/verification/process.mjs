import { spawn, execFile, execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

export const repoRoot = resolve(import.meta.dirname, "../..");
const require = createRequire(resolve(repoRoot, "apps/desktop/package.json"));
const execFileAsync = promisify(execFile);

async function waitForGroupExit(group) {
  const deadline = Date.now() + 5000;
  while (true) {
    let stdout;
    try {
      ({ stdout } = await execFileAsync("ps", ["-A", "-o", "pgid=", "-o", "stat="], {
        encoding: "utf8", timeout: 1000, maxBuffer: 32 * 1024 * 1024,
      }));
    } catch (cause) {
      throw new Error(`Cannot confirm process group ${group} stopped.`, { cause });
    }
    const members = stdout.trim().split("\n").filter(Boolean).map(line => line.trim().split(/\s+/u));
    if (members.some(([pgid, state]) => !/^\d+$/u.test(pgid) || !state)) {
      throw new Error(`Cannot read process group ${group} state.`);
    }
    // Zombies retain a group ID but have already released their files and sockets.
    if (!members.some(([pgid, state]) => Number(pgid) === group && !state.startsWith("Z"))) return;
    if (Date.now() >= deadline) throw new Error(`Process group ${group} still has live members after SIGKILL.`);
    await new Promise(done => setTimeout(done, 20));
  }
}

export function pnpm(args) {
  const manifest = require.resolve("pnpm");
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  return [process.execPath, [resolve(dirname(manifest), pkg.bin.pnpm), ...args]];
}

export function git(args, cwd = repoRoot) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}

export function run(command, args, { cwd = repoRoot, env = process.env, log, onSpawn, quietStdout = false, timeoutMs, signal: abortSignal } = {}) {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error("Command timeout must be a positive number of milliseconds.");
  if (abortSignal?.aborted) return Promise.reject(Object.assign(new Error(`${command} failed (interrupted).`), {
    exitCode: null, signal: null, stdout: "", stderr: "", interrupted: true, timedOut: false,
  }));
  return new Promise((resolveRun, reject) => {
    if (log) mkdirSync(dirname(log), { recursive: true });
    const output = log ? createWriteStream(log) : null;
    const windows = process.platform === "win32";
    const launchCommand = windows ? "pwsh.exe" : command;
    const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;
    const launchArgs = windows ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `& ([scriptblock]::Create([IO.File]::ReadAllText(${quotePowerShell(resolve(import.meta.dirname, "windows-job.ps1"))}))) ${[
        process.execPath, resolve(import.meta.dirname, "windows-command.mjs"), Buffer.from(JSON.stringify({ command, args })).toString("base64"),
      ].map(quotePowerShell).join(" ")}`] : args;
    const child = spawn(launchCommand, launchArgs, { cwd, env, windowsHide: true, detached: !windows, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    onSpawn?.(child);
    console.log(`[run] pid=${child.pid ?? "unavailable"} ${command} ${args.join(" ")}`);
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + stdoutDecoder.write(chunk)).slice(-16 * 1024 * 1024);
      if (!quietStdout) process.stdout.write(chunk);
      output?.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + stderrDecoder.write(chunk)).slice(-1024 * 1024);
      process.stderr.write(chunk);
      output?.write(chunk);
    });
    let interrupted = false;
    let timedOut = false;
    let outputError;
    let escalation;
    let cancellation;
    let cancellationError;
    let completed = false;
    const stopGroup = () => {
      if (cancellation) return cancellation;
      clearTimeout(escalation);
      cancellation = (async () => {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if (error.code === "ESRCH") return; throw error; }
        await waitForGroupExit(child.pid);
      })();
      cancellation.catch(() => {});
      return cancellation;
    };
    const interrupt = () => {
      if (interrupted || !child.pid || completed) return;
      interrupted = true;
      if (windows) {
        // The retained handle belongs to the job owner, even after the command exits.
        child.kill("SIGKILL");
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        escalation = setTimeout(stopGroup, 5000);
        escalation.unref();
      }
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    abortSignal?.addEventListener("abort", interrupt, { once: true });
    if (abortSignal?.aborted) interrupt();
    const deadline = timeoutMs === undefined ? null : setTimeout(() => { timedOut = true; interrupt(); }, timeoutMs);
    output?.once("error", (error) => { outputError = error; interrupt(); });
    const cleanup = () => {
      completed = true;
      clearTimeout(escalation);
      clearTimeout(deadline);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      abortSignal?.removeEventListener("abort", interrupt);
    };
    child.once("error", (error) => {
      cleanup(); output?.end();
      reject(Object.assign(error, { exitCode: null, signal: null, stdout, stderr, interrupted, timedOut }));
    });
    child.once("close", async (code, signal) => {
      clearTimeout(deadline);
      if (interrupted && !windows) {
        try { await stopGroup(); } catch (error) { cancellationError = error; }
      }
      cleanup();
      stdout = (stdout + stdoutDecoder.end()).slice(-16 * 1024 * 1024);
      stderr = (stderr + stderrDecoder.end()).slice(-1024 * 1024);
      if (output && !output.destroyed) await new Promise((done) => output.end(error => { outputError ??= error; done(); }));
      const failure = outputError ?? cancellationError ?? (code !== 0 || interrupted || timedOut
        ? new Error(`${command} failed (${timedOut ? `timed out after ${timeoutMs}ms` : interrupted ? "interrupted" : signal ?? code}).${log ? ` Log: ${log}` : `\n${stderr.slice(-4000)}`}`) : null);
      if (failure) reject(Object.assign(failure, { exitCode: code, signal, stdout, stderr, interrupted, timedOut,
        commandExitFailure: !outputError && !cancellationError && typeof code === "number" && code !== 0 && !interrupted && !timedOut }));
      else resolveRun({ pid: child.pid, code, stdout, stderr });
    });
  });
}

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
