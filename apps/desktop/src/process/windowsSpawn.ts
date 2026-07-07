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
// validation ever saw. Tokens with embedded double quotes are not
// representable safely (cmd has no escape for them), so they are refused.
// Residual caveat: %VAR% expansion still occurs inside quotes and has no
// reliable escape in a cmd /c context.
function quoteForCmd(token: string): string {
  if (token.includes('"')) {
    throw new Error(
      "Command argument contains a double quote, which cannot be represented safely on a cmd.exe command line.",
    );
  }
  return `"${token}"`;
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
  if (process.platform !== "win32" || !child.pid) return Promise.resolve(false);
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      { windowsHide: true },
      (error) => resolve(!error),
    );
  });
}
