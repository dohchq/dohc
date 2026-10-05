import { execFileSync } from "node:child_process";

const retryWait = new Int32Array(new SharedArrayBuffer(4));

export function readGit(args, cwd) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return execFileSync("git", args, {
        cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
    } catch (cause) {
      if (attempt === 3) {
        const stderr = String(cause.stderr ?? "");
        throw Object.assign(new Error(
          `git ${args.join(" ")} failed after ${attempt} attempts (${cause.status ?? cause.code ?? cause.signal ?? "unknown"}).\n${stderr.trim() || cause.message}`,
          { cause },
        ), { stderr, status: cause.status, code: cause.code, signal: cause.signal });
      }
      Atomics.wait(retryWait, 0, 0, 100);
    }
  }
}
