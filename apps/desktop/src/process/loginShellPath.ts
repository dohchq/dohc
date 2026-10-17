import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { posix } from "node:path";

// Long enough for a profile that loads nvm or a plugin manager. A profile that
// hangs costs agent runs this much once, then they use the PATH dohc has.
export const LOGIN_SHELL_PATH_TIMEOUT_MS = 3_000;
const OUTPUT_LIMIT = 256 * 1024;

/** The absolute PATH entries a shell printed between two markers, or null. */
export function parseShellPath(output: string, marker: string): string[] | null {
  const start = output.indexOf(marker);
  if (start < 0) return null;
  const end = output.indexOf(marker, start + marker.length);
  if (end < 0) return null;
  const entries = output.slice(start + marker.length, end).trim().split(":").filter((entry) => posix.isAbsolute(entry));
  return entries.length > 0 ? entries : null;
}

/** The login shell's entries in its order, then the ones only the current PATH has. */
export function mergeShellPath(current: string | undefined, fromShell: readonly string[]): string {
  return [...new Set([...fromShell, ...(current ?? "").split(":").filter((entry) => posix.isAbsolute(entry))])].join(":");
}

/**
 * Asks the person's login shell for its PATH, as Terminal would set it. The
 * markers keep a profile's own output out of the answer. Resolves null when
 * the shell fails, prints no PATH, or takes longer than `timeoutMs`; a shell
 * still running then is killed with everything it started.
 */
export function readLoginShellPath(options: {
  shell: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<string[] | null> {
  if (!posix.isAbsolute(options.shell)) return Promise.resolve(null);
  const marker = `__dohc_path_${randomUUID()}__`;
  const command = `printf '%s' '${marker}'; /usr/bin/printenv PATH; printf '%s' '${marker}'`;
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = spawn(options.shell, ["-ilc", command], {
      env: options.env,
      stdio: ["ignore", "pipe", "ignore"],
      // Its own process group, so a timeout stops what the profile started too.
      detached: true,
    });
    const stopGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch { /* It already exited. */ }
    };
    const finish = (entries: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      resolve(entries);
    };
    const timer = setTimeout(() => {
      stopGroup();
      finish(null);
    }, options.timeoutMs ?? LOGIN_SHELL_PATH_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      const entries = parseShellPath(output, marker);
      if (entries) {
        finish(entries);
      } else if (output.length > OUTPUT_LIMIT) {
        stopGroup();
        finish(null);
      }
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(parseShellPath(output, marker)));
  });
}

/**
 * Finder and the Dock start dohc with launchd's PATH, which has no Homebrew,
 * Node or user installs. Merges the login shell's PATH into `env` so agents
 * and the tools they call find what they find in Terminal. Never rejects.
 */
export async function adoptLoginShellPath(
  env: NodeJS.ProcessEnv,
  read: typeof readLoginShellPath = readLoginShellPath,
): Promise<void> {
  let shell = env.SHELL;
  if (!shell) {
    try {
      shell = userInfo().shell ?? undefined;
    } catch { /* No passwd entry: keep the PATH dohc has. */ }
  }
  if (!shell) return;
  const entries = await read({ shell, env }).catch(() => null);
  if (entries) env.PATH = mergeShellPath(env.PATH, entries);
}
