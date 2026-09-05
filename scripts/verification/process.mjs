import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

export const repoRoot = resolve(import.meta.dirname, "../..");
const require = createRequire(resolve(repoRoot, "apps/desktop/package.json"));

export function pnpm(args) {
  const manifest = require.resolve("pnpm");
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  return [process.execPath, [resolve(dirname(manifest), pkg.bin.pnpm), ...args]];
}

export function git(args, cwd = repoRoot) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}

export function run(command, args, { cwd = repoRoot, env = process.env, log, onSpawn, quietStdout = false, timeoutMs } = {}) {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error("Command timeout must be a positive number of milliseconds.");
  return new Promise((resolveRun, reject) => {
    if (log) mkdirSync(dirname(log), { recursive: true });
    const output = log ? createWriteStream(log) : null;
    const child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    onSpawn?.(child);
    console.log(`[run] pid=${child.pid ?? "unavailable"} ${command} ${args.join(" ")}`);
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-16 * 1024 * 1024);
      if (!quietStdout) process.stdout.write(chunk);
      output?.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-1024 * 1024);
      process.stderr.write(chunk);
      output?.write(chunk);
    });
    let interrupted = false;
    let timedOut = false;
    let outputError;
    let escalation;
    const interrupt = () => {
      if (interrupted || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
      interrupted = true;
      if (process.platform === "win32") {
        const stopper = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        stopper.on("error", () => child.kill("SIGTERM"));
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        escalation = setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") console.error(error.message); }
        }, 5000);
        escalation.unref();
      }
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    const deadline = timeoutMs === undefined ? null : setTimeout(() => { timedOut = true; interrupt(); }, timeoutMs);
    output?.once("error", (error) => { outputError = error; interrupt(); });
    const cleanup = () => {
      clearTimeout(escalation);
      clearTimeout(deadline);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    };
    child.once("error", (error) => { cleanup(); output?.end(); reject(error); });
    child.once("close", async (code, signal) => {
      cleanup();
      if (output && !output.destroyed) await new Promise((done) => output.end(done));
      if (outputError) reject(outputError);
      else if (code !== 0 || interrupted || timedOut) reject(new Error(`${command} failed (${timedOut ? `timed out after ${timeoutMs}ms` : interrupted ? "interrupted" : signal ?? code}).${log ? ` Log: ${log}` : `\n${stderr.slice(-4000)}`}`));
      else resolveRun({ pid: child.pid, code, stdout, stderr });
    });
  });
}

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
