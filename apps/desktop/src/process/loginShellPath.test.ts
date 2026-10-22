import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adoptLoginShellPath,
  loginShellEnvironment,
  hasControllingTerminal,
  mergeShellPath,
  needsLoginShellPath,
  parseShellPath,
  readLoginShellPath,
  registeredLoginShell,
  type ShellProcess,
} from "./loginShellPath";

const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const SHELLS = "# List of acceptable shells\n/bin/bash\n/bin/zsh\n";

describe("parseShellPath", () => {
  it("reads only what sits between the markers, and only absolute entries", () => {
    expect(parseShellPath("Welcome: /fake/bin\nMARK/opt/homebrew/bin:relative/bin::/usr/bin\nMARKbye", "MARK"))
      .toEqual(["/opt/homebrew/bin", "/usr/bin"]);
  });

  it("refuses output without both markers or without an absolute entry", () => {
    expect(parseShellPath("/opt/homebrew/bin:/usr/bin", "MARK")).toBeNull();
    expect(parseShellPath("MARK/opt/homebrew/bin:/usr/bin", "MARK")).toBeNull();
    expect(parseShellPath("MARKbin:.\nMARK", "MARK")).toBeNull();
  });
});

describe("mergeShellPath", () => {
  it("puts the login shell's entries first and keeps the rest of launchd's PATH once", () => {
    expect(mergeShellPath(LAUNCHD_PATH, ["/opt/homebrew/bin", "/usr/bin", "/Users/sam/.local/bin"]))
      .toBe("/opt/homebrew/bin:/usr/bin:/Users/sam/.local/bin:/bin:/usr/sbin:/sbin");
    expect(mergeShellPath(undefined, ["/opt/homebrew/bin"])).toBe("/opt/homebrew/bin");
    expect(mergeShellPath("::relative:/bin", ["/usr/bin"])).toBe("/usr/bin:/bin");
  });
});

describe("needsLoginShellPath", () => {
  it("reads it for Finder and a Linux launcher, and keeps a Linux terminal's PATH", () => {
    expect(needsLoginShellPath("darwin", false)).toBe(true);
    expect(needsLoginShellPath("darwin", true)).toBe(true);
    expect(needsLoginShellPath("linux", false)).toBe(true);
    expect(needsLoginShellPath("linux", true)).toBe(false);
    expect(needsLoginShellPath("win32", false)).toBe(false);
  });
});

describe("hasControllingTerminal", () => {
  it("is true only when /dev/tty opens", () => {
    const opened: string[] = [];
    expect(hasControllingTerminal((path) => { opened.push(path); })).toBe(true);
    expect(opened).toEqual(["/dev/tty"]);
    expect(hasControllingTerminal(() => {
      throw Object.assign(new Error("No such device or address"), { code: "ENXIO" });
    })).toBe(false);
  });
});

describe("registeredLoginShell", () => {
  it("accepts only an absolute shell /etc/shells lists", () => {
    expect(registeredLoginShell("/bin/zsh", SHELLS)).toBe("/bin/zsh");
    expect(registeredLoginShell("/tmp/evil-shell", SHELLS)).toBeNull();
    expect(registeredLoginShell("zsh", "zsh\n")).toBeNull();
    expect(registeredLoginShell(null, SHELLS)).toBeNull();
    expect(registeredLoginShell("# List of acceptable shells", SHELLS)).toBeNull();
  });
});

describe("loginShellEnvironment", () => {
  it("passes the account's home and shell, a few facts, and nothing that steers the shell", () => {
    expect(loginShellEnvironment({
      HOME: "/tmp/elsewhere", USER: "sam", LOGNAME: "sam", TMPDIR: "/var/folders/x/T/", LANG: "en_US.UTF-8",
      PATH: LAUNCHD_PATH, SHELL: "/tmp/other", BASH_ENV: "/tmp/payload", ZDOTDIR: "/tmp/z", ENV: "/tmp/e",
      NODE_OPTIONS: "--require /tmp/x.js", TERM: "xterm",
    }, { shell: "/bin/zsh", homedir: "/Users/sam" })).toEqual({
      HOME: "/Users/sam", USER: "sam", LOGNAME: "sam", TMPDIR: "/var/folders/x/T/", LANG: "en_US.UTF-8",
      SHELL: "/bin/zsh", TERM: "dumb",
    });
  });
});

describe("adoptLoginShellPath", () => {
  it("reads the account's registered shell with the minimal environment and merges its PATH", async () => {
    const env: NodeJS.ProcessEnv = { HOME: "/tmp/elsewhere", SHELL: "/tmp/other", BASH_ENV: "/tmp/payload", PATH: LAUNCHD_PATH };
    const read = vi.fn(async () => ["/opt/homebrew/bin"]);
    await adoptLoginShellPath(env, { account: () => ({ shell: "/bin/zsh", homedir: "/Users/sam" }), readShells: () => SHELLS, read });
    expect(read).toHaveBeenCalledWith({ shell: "/bin/zsh", env: { HOME: "/Users/sam", SHELL: "/bin/zsh", TERM: "dumb" } });
    expect(env.PATH).toBe(`/opt/homebrew/bin:${LAUNCHD_PATH}`);
  });

  it("keeps the PATH when the shell is unlisted, unreadable, or gives none", async () => {
    const read = vi.fn(async () => ["/opt/homebrew/bin"]);
    const env: NodeJS.ProcessEnv = { PATH: LAUNCHD_PATH };
    const account = () => ({ shell: "/bin/zsh", homedir: "/Users/sam" });
    await adoptLoginShellPath(env, { account: () => ({ shell: "/tmp/evil-shell", homedir: "/Users/sam" }), readShells: () => SHELLS, read });
    await adoptLoginShellPath(env, { account, readShells: () => { throw new Error("EACCES"); }, read });
    await adoptLoginShellPath(env, { account: () => { throw new Error("no passwd entry"); }, readShells: () => SHELLS, read });
    expect(read).not.toHaveBeenCalled();
    await adoptLoginShellPath(env, { account, readShells: () => SHELLS, read: async () => null });
    await adoptLoginShellPath(env, { account, readShells: () => SHELLS, read: async () => { throw new Error("spawn EACCES"); } });
    expect(env.PATH).toBe(LAUNCHD_PATH);
  });
});

// A shell whose output, exit and close the test drives.
function fakeShell() {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const shell = {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout,
    on: (event: "error" | "close", listener: () => void) => events.on(event, listener),
    print: (text: string) => stdout.write(text),
    exit: () => {
      shell.exitCode = 0;
    },
    close: () => events.emit("close"),
  };
  return shell;
}

function readFake(shell: ReturnType<typeof fakeShell>, timeoutMs = 60_000) {
  const kill = vi.fn((_pid: number, _signal: NodeJS.Signals) => undefined);
  let command = "";
  const read = readLoginShellPath({
    shell: "/bin/zsh", env: {}, timeoutMs, kill,
    spawn: (_shell, text): ShellProcess => {
      command = text;
      return shell;
    },
  });
  const marker = /'(__dohc_path_[^']+)'/u.exec(command)![1]!;
  return { read, kill, printPath: (path: string) => shell.print(`${marker}${path}\n${marker}`) };
}

describe("readLoginShellPath cleanup", () => {
  it("kills the running shell's group once, when the PATH arrives", async () => {
    const shell = fakeShell();
    const f = readFake(shell);
    f.printPath("/opt/homebrew/bin:/usr/bin");
    await expect(f.read).resolves.toEqual(["/opt/homebrew/bin", "/usr/bin"]);
    expect(f.kill.mock.calls).toEqual([[-4242, "SIGKILL"]]);
    shell.close();
    expect(f.kill).toHaveBeenCalledTimes(1);
  });

  it("never signals a shell Node has seen exit, whose pid may name another process", async () => {
    vi.useFakeTimers();
    try {
      const shell = fakeShell();
      const f = readFake(shell, 1_000);
      shell.exit();
      f.printPath("/opt/homebrew/bin");
      await expect(f.read).resolves.toEqual(["/opt/homebrew/bin"]);

      const late = fakeShell();
      const g = readFake(late, 1_000);
      late.exit();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(g.read).resolves.toBeNull();
      expect(f.kill).not.toHaveBeenCalled();
      expect(g.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills a shell still running at the deadline, and reads nothing after", async () => {
    vi.useFakeTimers();
    try {
      const shell = fakeShell();
      const f = readFake(shell, 1_000);
      shell.print("Last login: today\n");
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(f.read).resolves.toBeNull();
      expect(f.kill.mock.calls).toEqual([[-4242, "SIGKILL"]]);
      expect(shell.stdout.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// A real login shell in a Finder-like environment, with a profile that prints
// its own output.
describe.skipIf(process.platform === "win32")("readLoginShellPath", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  function profile(text: string): string {
    home = mkdtempSync(join(tmpdir(), "dohc-login-shell-"));
    writeFileSync(join(home, ".bash_profile"), text);
    return home;
  }

  function groupGone(pidFile: string): void {
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(-pid, 0)).toThrow();
  }

  it("reads the PATH a login profile sets, past the profile's own output", async () => {
    const dir = profile([
      'echo "Last login: today on ttys000: /not/a/path"',
      'export PATH="/opt/dohc-test/bin:relative/bin:$PATH"',
      "",
    ].join("\n"));
    const entries = await readLoginShellPath({ shell: "/bin/bash", env: { HOME: dir, SHELL: "/bin/bash" } });
    expect(entries?.[0]).toBe("/opt/dohc-test/bin");
    expect(entries).not.toContain("relative/bin");
    expect(entries).not.toContain("/not/a/path");
    expect(mergeShellPath(LAUNCHD_PATH, entries ?? []).startsWith("/opt/dohc-test/bin:")).toBe(true);
  });

  it("keeps the PATH and ends a shell whose exit trap never returns", async () => {
    // The trap runs in the shell itself, so the shell never exits on its own.
    const dir = profile([
      'echo $$ > "$HOME/shell.pid"',
      'export PATH="/opt/dohc-test/bin:$PATH"',
      "trap 'while :; do :; done' EXIT",
      "",
    ].join("\n"));
    const started = Date.now();
    const entries = await readLoginShellPath({ shell: "/bin/bash", env: { HOME: dir }, timeoutMs: 10_000 });
    expect(entries?.[0]).toBe("/opt/dohc-test/bin");
    // The PATH arriving ended it; the deadline did not.
    expect(Date.now() - started).toBeLessThan(10_000);
    await vi.waitFor(() => groupGone(join(dir, "shell.pid")));
  });

  it("gives up on a profile that hangs before printing, and ends its group", async () => {
    const dir = profile('echo $$ > "$HOME/shell.pid"\nsleep 30\n');
    const started = Date.now();
    await expect(readLoginShellPath({ shell: "/bin/bash", env: { HOME: dir }, timeoutMs: 1_000 })).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    await vi.waitFor(() => groupGone(join(dir, "shell.pid")));
  });

  it("refuses a shell that is not an absolute path or does not run", async () => {
    await expect(readLoginShellPath({ shell: "zsh", env: {} })).resolves.toBeNull();
    await expect(readLoginShellPath({ shell: "/nonexistent/shell", env: {} })).resolves.toBeNull();
  });
});
