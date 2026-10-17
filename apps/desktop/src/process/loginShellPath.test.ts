import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adoptLoginShellPath,
  descendantGroups,
  loginShellEnvironment,
  mergeShellPath,
  parseShellPath,
  readLoginShellPath,
  registeredLoginShell,
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

describe("descendantGroups", () => {
  it("names the shell's group and the groups of everything below it, and nothing else", () => {
    const table = [
      "  100     1   100", // the shell
      "  101   100   101", // a job in its own group
      "  102   101   101", // that job's child
      "  103   100   100", // a plain child
      "  200     1   200", // not the shell's
      "  201   200   100", // a stranger in a group number that matches
      "garbage",
    ].join("\n");
    expect(descendantGroups(table, 100).sort()).toEqual([100, 101]);
    expect(descendantGroups("", 100)).toEqual([100]);
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
  it("passes a few account facts and nothing that steers the shell", () => {
    expect(loginShellEnvironment({
      HOME: "/Users/sam", USER: "sam", LOGNAME: "sam", TMPDIR: "/var/folders/x/T/", LANG: "en_US.UTF-8",
      PATH: LAUNCHD_PATH, SHELL: "/tmp/other", BASH_ENV: "/tmp/payload", ZDOTDIR: "/tmp/z", ENV: "/tmp/e",
      NODE_OPTIONS: "--require /tmp/x.js", TERM: "xterm",
    }, "/bin/zsh")).toEqual({
      HOME: "/Users/sam", USER: "sam", LOGNAME: "sam", TMPDIR: "/var/folders/x/T/", LANG: "en_US.UTF-8",
      SHELL: "/bin/zsh", TERM: "dumb",
    });
  });
});

describe("adoptLoginShellPath", () => {
  it("reads the account's registered shell with the minimal environment and merges its PATH", async () => {
    const env: NodeJS.ProcessEnv = { HOME: "/Users/sam", SHELL: "/tmp/other", BASH_ENV: "/tmp/payload", PATH: LAUNCHD_PATH };
    const read = vi.fn(async () => ["/opt/homebrew/bin"]);
    await adoptLoginShellPath(env, { accountShell: () => "/bin/zsh", readShells: () => SHELLS, read });
    expect(read).toHaveBeenCalledWith({ shell: "/bin/zsh", env: { HOME: "/Users/sam", SHELL: "/bin/zsh", TERM: "dumb" } });
    expect(env.PATH).toBe(`/opt/homebrew/bin:${LAUNCHD_PATH}`);
  });

  it("keeps the PATH when the shell is unlisted, unreadable, or gives none", async () => {
    const read = vi.fn(async () => ["/opt/homebrew/bin"]);
    const env: NodeJS.ProcessEnv = { PATH: LAUNCHD_PATH };
    await adoptLoginShellPath(env, { accountShell: () => "/tmp/evil-shell", readShells: () => SHELLS, read });
    await adoptLoginShellPath(env, { accountShell: () => "/bin/zsh", readShells: () => { throw new Error("EACCES"); }, read });
    expect(read).not.toHaveBeenCalled();
    await adoptLoginShellPath(env, { accountShell: () => "/bin/zsh", readShells: () => SHELLS, read: async () => null });
    await adoptLoginShellPath(env, {
      accountShell: () => "/bin/zsh", readShells: () => SHELLS, read: async () => { throw new Error("spawn EACCES"); },
    });
    expect(env.PATH).toBe(LAUNCHD_PATH);
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

  it("stops a job in its own process group that the shell waits for at exit", async () => {
    // With job control on, bash gives the job a group of its own, as it does
    // an exit trap's command. Killing the shell's group alone would leave the
    // job holding the output open.
    const dir = profile([
      'echo $$ > "$HOME/shell.pid"',
      "set -m",
      'sleep 30 & echo $! > "$HOME/job.pid"',
      "trap wait EXIT",
      'export PATH="/opt/dohc-test/bin:$PATH"',
      "",
    ].join("\n"));
    const started = Date.now();
    const entries = await readLoginShellPath({ shell: "/bin/bash", env: { HOME: dir }, timeoutMs: 10_000 });
    expect(entries?.[0]).toBe("/opt/dohc-test/bin");
    expect(Date.now() - started).toBeLessThan(10_000);
    const job = Number(readFileSync(join(dir, "job.pid"), "utf8"));
    await vi.waitFor(() => expect(() => process.kill(job, 0)).toThrow());
    await vi.waitFor(() => groupGone(join(dir, "shell.pid")));
  });

  it("keeps the PATH and stops the shell when its exit hangs after printing", async () => {
    const dir = profile([
      'echo $$ > "$HOME/shell.pid"',
      'export PATH="/opt/dohc-test/bin:$PATH"',
      "trap 'sleep 30' EXIT",
      "",
    ].join("\n"));
    const started = Date.now();
    const entries = await readLoginShellPath({ shell: "/bin/bash", env: { HOME: dir }, timeoutMs: 10_000 });
    expect(entries?.[0]).toBe("/opt/dohc-test/bin");
    // The PATH arriving stops the group; the deadline is not what ended it.
    expect(Date.now() - started).toBeLessThan(10_000);
    await vi.waitFor(() => groupGone(join(dir, "shell.pid")));
  });

  it("gives up on a profile that hangs before printing, and stops what it started", async () => {
    const dir = profile('echo $$ > "$HOME/shell.pid"\nsleep 30 & wait\n');
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
