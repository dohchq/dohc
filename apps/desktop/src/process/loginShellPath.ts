import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { posix } from "node:path";
import type { Readable } from "node:stream";

// Long enough for a profile that loads nvm or a plugin manager. A profile that
// hangs costs agent runs this much once, then they use the PATH dohc has.
export const LOGIN_SHELL_PATH_TIMEOUT_MS = 3_000;
const OUTPUT_LIMIT = 256 * 1024;
// The login shell sees only these, so variables launchd, a desktop session or
// a parent process set, such as BASH_ENV, ZDOTDIR, ENV or NODE_OPTIONS, cannot steer it.
const SHELL_ENVIRONMENT = ["USER", "LOGNAME", "TMPDIR", "LANG"] as const;

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

// The part of a spawned shell this read uses.
export interface ShellProcess {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: Readable | null;
  on(event: "error" | "close", listener: () => void): unknown;
}

function spawnShell(shell: string, command: string, env: NodeJS.ProcessEnv): ShellProcess {
  return spawn(shell, ["-ilc", command], {
    env,
    stdio: ["ignore", "pipe", "ignore"],
    // A process group of its own, whose id is the shell's pid.
    detached: true,
  });
}

/**
 * Asks the person's login shell for its PATH, as Terminal would set it. The
 * markers keep a profile's own output out of the answer. Resolves when the
 * PATH arrives, the shell ends, or `timeoutMs` passes, and null without a
 * PATH. When the PATH arrives or the time runs out, a shell that is still
 * running is killed with its process group, which holds the profile and its
 * exit trap. Jobs the profile moved into other groups, such as `set -m`
 * background jobs and agents like ssh-agent, keep running, as they do after
 * Terminal closes. dohc does not own them.
 */
export function readLoginShellPath(options: {
  shell: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawn?: (shell: string, command: string, env: NodeJS.ProcessEnv) => ShellProcess;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}): Promise<string[] | null> {
  if (!posix.isAbsolute(options.shell)) return Promise.resolve(null);
  const marker = `__dohc_path_${randomUUID()}__`;
  const command = `printf '%s' '${marker}'; /usr/bin/printenv PATH; printf '%s' '${marker}'`;
  const kill = options.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = (options.spawn ?? spawnShell)(options.shell, command, options.env);
    const settle = (entries: string[] | null, stop: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      // Once Node has seen the shell exit, its pid may name another process,
      // so the group is signalled only before that.
      if (stop && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try {
          kill(-child.pid, "SIGKILL");
        } catch { /* The group already ended. */ }
      }
      resolve(entries);
    };
    const timer = setTimeout(() => settle(parseShellPath(output, marker), true), options.timeoutMs ?? LOGIN_SHELL_PATH_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      const entries = parseShellPath(output, marker);
      if (entries) settle(entries, true);
      else if (output.length > OUTPUT_LIMIT) settle(null, true);
    });
    child.on("error", () => settle(null, false));
    child.on("close", () => settle(parseShellPath(output, marker), false));
  });
}

/**
 * Whether startup reads the login shell's PATH. Finder, the Dock and a Linux
 * desktop's launcher start dohc without what the shell adds. A Linux terminal
 * launch already has the shell's PATH, with whatever the person chose there,
 * such as `nvm use`, so it keeps that PATH as it is.
 */
export function needsLoginShellPath(platform: NodeJS.Platform, fromTerminal: boolean): boolean {
  return platform === "darwin" || (platform === "linux" && !fromTerminal);
}

/**
 * Whether this process has a controlling terminal, as one a terminal started
 * has even with its streams redirected and in the background. A desktop's
 * launcher starts apps without one.
 */
export function hasControllingTerminal(
  open: (path: string) => void = (path) => closeSync(openSync(path, "r")),
): boolean {
  try {
    open("/dev/tty");
    return true;
  } catch {
    return false;
  }
}

/** The account's registered shell, when /etc/shells lists it, or null. */
export function registeredLoginShell(
  shell: string | null | undefined,
  shells: string,
): string | null {
  if (!shell || !posix.isAbsolute(shell)) return null;
  const listed = shells.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  return listed.includes(shell) ? shell : null;
}

/** What the login shell starts with: the account's facts and nothing that steers it. */
export function loginShellEnvironment(
  env: NodeJS.ProcessEnv,
  account: { shell: string; homedir: string },
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { HOME: account.homedir, SHELL: account.shell, TERM: "dumb" };
  for (const name of SHELL_ENVIRONMENT) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  return result;
}

/**
 * Finder and the Dock start dohc with launchd's PATH, which has no Homebrew,
 * Node or user installs, and a Linux launcher starts it without what only the
 * shell adds, such as nvm. Merges the PATH the account's login shell sets into
 * `env`, so agents and the tools they call find what they find in Terminal.
 * Never rejects.
 */
export async function adoptLoginShellPath(
  env: NodeJS.ProcessEnv,
  deps: {
    account(): { shell: string | null; homedir: string };
    readShells(): string;
    read: typeof readLoginShellPath;
  } = {
    account: () => userInfo(),
    readShells: () => readFileSync("/etc/shells", "utf8"),
    read: readLoginShellPath,
  },
): Promise<void> {
  let account: { shell: string; homedir: string } | null = null;
  try {
    const { shell, homedir } = deps.account();
    const registered = registeredLoginShell(shell, deps.readShells());
    if (registered && posix.isAbsolute(homedir)) account = { shell: registered, homedir };
  } catch { /* No account record or no /etc/shells: keep the PATH dohc has. */ }
  if (!account) return;
  const entries = await deps.read({ shell: account.shell, env: loginShellEnvironment(env, account) }).catch(() => null);
  if (entries) env.PATH = mergeShellPath(env.PATH, entries);
}
