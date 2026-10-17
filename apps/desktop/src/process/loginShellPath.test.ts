import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adoptLoginShellPath, mergeShellPath, parseShellPath, readLoginShellPath } from "./loginShellPath";

const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

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

describe("adoptLoginShellPath", () => {
  it("merges the shell's PATH into the environment, and keeps it when the shell gives none", async () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: LAUNCHD_PATH };
    const read = vi.fn(async () => ["/opt/homebrew/bin"]);
    await adoptLoginShellPath(env, read);
    expect(read).toHaveBeenCalledWith({ shell: "/bin/zsh", env });
    expect(env.PATH).toBe(`/opt/homebrew/bin:${LAUNCHD_PATH}`);

    const unchanged: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: LAUNCHD_PATH };
    await adoptLoginShellPath(unchanged, async () => null);
    await adoptLoginShellPath(unchanged, async () => { throw new Error("spawn EACCES"); });
    expect(unchanged.PATH).toBe(LAUNCHD_PATH);
  });
});

// A real login shell in a Finder-like environment: only HOME and SHELL, as
// `env -i HOME=… SHELL=…` gives, with a profile that prints its own output.
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

  it("gives up on a profile that hangs, and stops what it started", async () => {
    const dir = profile('echo $$ > "$HOME/shell.pid"\nsleep 30 & echo $! > "$HOME/sleep.pid"\nwait\n');
    const started = Date.now();
    await expect(readLoginShellPath({ shell: "/bin/bash", env: { HOME: dir }, timeoutMs: 1_000 })).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    const sleeper = Number(readFileSync(join(dir, "sleep.pid"), "utf8"));
    await vi.waitFor(() => expect(() => process.kill(sleeper, 0)).toThrow());
  });

  it("refuses a shell that is not an absolute path or does not run", async () => {
    await expect(readLoginShellPath({ shell: "zsh", env: {} })).resolves.toBeNull();
    await expect(readLoginShellPath({ shell: "/nonexistent/shell", env: {} })).resolves.toBeNull();
  });
});
