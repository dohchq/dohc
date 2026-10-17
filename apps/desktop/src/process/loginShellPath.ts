import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { posix } from "node:path";

// Long enough for a profile that loads nvm or a plugin manager. A profile that
// hangs costs agent runs this much once, then they use the PATH dohc has.
export const LOGIN_SHELL_PATH_TIMEOUT_MS = 3_000;
const OUTPUT_LIMIT = 256 * 1024;
// The login shell sees only these, so variables launchd or a parent process
// set, such as BASH_ENV, ZDOTDIR, ENV or NODE_OPTIONS, cannot steer it.
const SHELL_ENVIRONMENT = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"] as const;

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
 * The process groups of `root` and of every process descended from it, read
 * from `ps -A -o pid=,ppid=,pgid=` output. An interactive shell gives each
 * job, and an exit trap's command, a group of its own.
 */
export function descendantGroups(table: string, root: number): number[] {
  const rows = table.split("\n").map((line) => line.trim().split(/\s+/u).map(Number))
    .filter((row) => row.length === 3 && row.every((value) => Number.isInteger(value) && value > 0));
  const groups = new Set([root]);
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid, pgid] of rows) {
      if (tree.has(ppid!) && !tree.has(pid!)) {
        tree.add(pid!);
        groups.add(pgid!);
        grew = true;
      }
    }
  }
  return [...groups];
}

// Kills the shell's group and the groups its descendants started. The table
// is read before the kill, while every descendant still names its parent.
function stopShell(pid: number | undefined): Promise<void> {
  if (pid === undefined) return Promise.resolve();
  return new Promise((done) => {
    execFile("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid="], { timeout: 1_000 }, (_error, table) => {
      for (const group of descendantGroups(typeof table === "string" ? table : "", pid)) {
        try {
          process.kill(-group, "SIGKILL");
        } catch { /* The group already exited. */ }
      }
      done();
    });
  });
}

/**
 * Asks the person's login shell for its PATH, as Terminal would set it. The
 * markers keep a profile's own output out of the answer. Resolves null when
 * the shell fails, prints no PATH, or prints none within `timeoutMs`. Once the
 * PATH arrives, or the time runs out, the shell and everything it started are
 * killed, so nothing the profile started outlives the read.
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
    let entries: string[] | null = null;
    let settled = false;
    const child = spawn(options.shell, ["-ilc", command], {
      env: options.env,
      stdio: ["ignore", "pipe", "ignore"],
      // Its own session, apart from dohc's process group.
      detached: true,
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void stopShell(child.pid).then(() => resolve(entries));
    };
    // Runs until the shell closes, even after the PATH arrived, so a profile
    // that keeps the output open is still stopped.
    const timer = setTimeout(finish, options.timeoutMs ?? LOGIN_SHELL_PATH_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (entries) return;
      output += chunk;
      entries = parseShellPath(output, marker);
      if (entries) void stopShell(child.pid);
      else if (output.length > OUTPUT_LIMIT) finish();
    });
    child.on("error", finish);
    child.on("close", finish);
  });
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

/** What the login shell starts with: a few account facts and nothing that steers it. */
export function loginShellEnvironment(env: NodeJS.ProcessEnv, shell: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { SHELL: shell, TERM: "dumb" };
  for (const name of SHELL_ENVIRONMENT) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  return result;
}

/**
 * Finder and the Dock start dohc with launchd's PATH, which has no Homebrew,
 * Node or user installs. Merges the PATH the account's login shell sets into
 * `env`, so agents and the tools they call find what they find in Terminal.
 * Never rejects.
 */
export async function adoptLoginShellPath(
  env: NodeJS.ProcessEnv,
  deps: {
    accountShell(): string | null | undefined;
    readShells(): string;
    read: typeof readLoginShellPath;
  } = {
    accountShell: () => userInfo().shell,
    readShells: () => readFileSync("/etc/shells", "utf8"),
    read: readLoginShellPath,
  },
): Promise<void> {
  let shell: string | null;
  try {
    shell = registeredLoginShell(deps.accountShell(), deps.readShells());
  } catch {
    return;
  }
  if (!shell) return;
  const entries = await deps.read({ shell, env: loginShellEnvironment(env, shell) }).catch(() => null);
  if (entries) env.PATH = mergeShellPath(env.PATH, entries);
}
