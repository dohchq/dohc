// Windows child-process spawning support, shared by agent transports and the
// site runner. On Windows, package-manager and npm-installed CLI commands are
// .cmd/.bat shims that cannot be spawned directly; they must run behind a
// cmd.exe wrapper whose command line follows cmd's (not POSIX's) quoting
// rules, and killing that wrapper does not kill the real process it started.
// Everything here is a no-op on other platforms.
import { execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

// Quote a token for a cmd.exe /s /c command line. EVERY token is quoted:
// cmd.exe does not interpret its metacharacters (& | < > ^ and parentheses)
// inside double quotes, so quoting only whitespace-bearing tokens would let a
// metacharacter-bearing argument be parsed as a second command that no
// validation ever saw. Two token shapes have no safe representation and are
// refused outright rather than quoted:
//   - embedded double quotes: cmd has no escape for them.
//   - a percent sign: cmd.exe still expands %VAR% inside double quotes with no
//     reliable escape, so a crafted env value (e.g. DOHC_PWN='" & calc & "')
//     would break out of the quotes and inject a second command that the
//     pre-expansion argv allowlist in siteRunner never saw. Quoting cannot
//     contain it, so any token carrying % is rejected.
function quoteForCmd(token: string): string {
  if (token.includes('"')) {
    throw new Error(
      "Command argument contains a double quote, which cannot be represented safely on a cmd.exe command line.",
    );
  }
  if (token.includes("%")) {
    throw new Error(
      "Command argument contains a percent sign, which cmd.exe expands as an environment-variable reference (%VAR%) even inside double quotes, with no reliable escape. Refusing to build a cmd.exe command line that could inject an attacker-controlled environment value.",
    );
  }
  // A trailing backslash run would combine with the closing quote into
  // CommandLineToArgvW's backslash-quote escape (\" = literal quote), so
  // double it — 2n backslashes before a quote parse back to n literal ones.
  const escaped = token.replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

export interface ResolvedSpawnCommand {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export function resolveSpawnCommand(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    exists?: (path: string) => boolean;
    // Base directory the child will be spawned with. Relative commands that
    // contain a path segment resolve against it, not the app process cwd.
    cwd?: string;
  } = {},
): ResolvedSpawnCommand {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command, args };

  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const pathValue = env.Path ?? env.PATH ?? "";
  const pathext = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  const hasPathSegment = /[\\/]/.test(command);
  const hasExtension = win32.extname(command).length > 0;
  const bases = hasPathSegment
    ? // Resolve against the spawn cwd so a site-relative command such as
      // "node_modules/.bin/vite" probes (and later executes as) the file the
      // child will actually see, not one under the app process cwd.
      [win32.resolve(options.cwd ?? process.cwd(), command)]
    : pathValue
        .split(win32.delimiter)
        .filter(Boolean)
        .map((dir) => win32.join(dir, command));
  const candidates = bases.flatMap((base) =>
    hasExtension ? [base] : pathext.map((ext) => `${base}${ext}`),
  );
  const resolved = candidates.find((candidate) => exists(candidate));
  if (!resolved) return { command, args };

  const extension = win32.extname(resolved).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    // cmd.exe /s strips the first and last quote of the string after /c, so
    // the whole command line rides in ONE outer-quoted argument with every
    // token quoted individually. windowsVerbatimArguments stops Node from
    // re-quoting that argument, which would corrupt cmd.exe's parsing (and,
    // for a spaced shim path like "C:\Program Files\nodejs\npm.cmd", swallow
    // the child's real exit code behind a cmd.exe launch failure).
    const line = [resolved, ...args].map(quoteForCmd).join(" ");
    return {
      command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: resolved, args };
}

// On Windows a shim-launched command runs behind a cmd.exe wrapper, and
// killing that wrapper leaves the real process alive — still bound to its
// ports, holding its cwd (blocking directory deletion) and its inherited
// stdio pipes. Kill the whole tree there; POSIX callers keep plain signals.
// Resolves true only when taskkill ran and succeeded.
export function killChildTreeWin32(child: ChildProcess): Promise<boolean> {
  return killProcessTreeWin32(
    child.pid,
    () => child.exitCode !== null || child.signalCode !== null,
  );
}

export function killProcessTreeWin32(
  pid: number | undefined,
  exited: () => boolean,
): Promise<boolean> {
  if (process.platform !== "win32" || !pid || exited()) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      "taskkill",
      ["/pid", String(pid), "/T", "/F"],
      { windowsHide: true },
      (error) => resolve(!error),
    );
  });
}

// taskkill /PID <wrapper> /T walks the LIVE process tree from a still-running
// wrapper pid — it has nothing to walk once that wrapper has already exited,
// the same gap posixSpawn.ts's module comment describes for "-pid" process
// groups. siteRunner's stopChild needs a snapshot taken WHILE the wrapper was
// still alive, captured periodically the same way posixSpawn.ts's shared
// processDescendants lets a backgrounded descendant stay reachable after its
// own wrapper exits and gets reparented away in the process table.
//
// Win32_Process (via CIM) is used rather than `wmic` — Windows 11 24H2
// removed wmic.exe by default — or `tasklist`, whose plain-text table has no
// machine-stable delimiter; Get-CimInstance is available from the Windows
// PowerShell 5.1 that ships on every supported Windows host, no pwsh (7)
// install required. Its output is reduced to the same "pid ppid" shape
// posixSpawn's parseProcessTable already parses, so the tree-walk itself
// (posixSpawn.ts's processDescendants) stays a single, platform-agnostic
// implementation shared by both platforms — this module supplies only the
// platform-specific text source.
export function readProcessTableWithPowershell(): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }",
      ],
      { windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolveOutput(stdout);
      },
    );
  });
}
