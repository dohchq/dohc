import { spawnSync } from "node:child_process";

const retryWait = new Int32Array(new SharedArrayBuffer(4));
const retryDelays = [100, 300, 900];

export function readGit(args, cwd) {
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync("git", args, {
      cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      if (result.stderr?.length) process.stderr.write(result.stderr);
      return result.stdout;
    }
    if (attempt === retryDelays.length + 1) {
      const cause = result.error ?? new Error("git did not exit successfully");
      const stderr = String(result.stderr ?? "");
      throw Object.assign(new Error(
        `git ${args.join(" ")} failed after ${attempt} attempts (${result.status ?? cause.code ?? result.signal ?? "unknown"}).\n${stderr.trim() || cause.message}`,
        { cause },
      ), { stderr, status: result.status, code: cause.code, signal: result.signal });
    }
    Atomics.wait(retryWait, 0, 0, retryDelays[attempt - 1]);
  }
}
