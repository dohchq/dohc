import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killChildTreeWin32, resolveSpawnCommand } from "./windowsSpawn";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dohc-windows-spawn-"));
  tempRoots.push(dir);
  return dir;
}

describe("resolveSpawnCommand", () => {
  it("returns the input untouched off Windows", () => {
    expect(
      resolveSpawnCommand("npm", ["run", "dev"], { platform: "linux" }),
    ).toEqual({ command: "npm", args: ["run", "dev"] });
  });

  it("quotes every token on the cmd.exe line so metacharacters stay inert", () => {
    const resolved = resolveSpawnCommand("npm", ["run", "dev", "--url=http://x/?a=1&b=2"], {
      platform: "win32",
      env: {
        Path: "C:\\Program Files\\nodejs",
        PATHEXT: ".COM;.EXE;.CMD",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
      exists: (candidate) => candidate === "C:\\Program Files\\nodejs\\npm.CMD",
    });
    expect(resolved).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\nodejs\\npm.CMD" "run" "dev" "--url=http://x/?a=1&b=2""',
      ],
      windowsVerbatimArguments: true,
    });
  });

  it("refuses arguments containing a double quote instead of corrupting the line", () => {
    expect(() =>
      resolveSpawnCommand("npm", ['--label="x"'], {
        platform: "win32",
        env: { Path: "C:\\npm", PATHEXT: ".CMD", ComSpec: "cmd.exe" },
        exists: (candidate) => candidate === "C:\\npm\\npm.CMD",
      }),
    ).toThrow(/double quote/);
  });

  it("doubles a trailing backslash run so it cannot escape the closing quote", () => {
    const resolved = resolveSpawnCommand("npm", ["C:\\site\\", "C:\\deep\\\\"], {
      platform: "win32",
      env: { Path: "C:\\npm", PATHEXT: ".CMD", ComSpec: "cmd.exe" },
      exists: (candidate) => candidate === "C:\\npm\\npm.CMD",
    });
    // CommandLineToArgvW parses 2n backslashes before a quote as n literal
    // backslashes; without doubling, \" would read as a literal quote and
    // swallow the argument boundary.
    expect(resolved.args[3]).toBe(
      '""C:\\npm\\npm.CMD" "C:\\site\\\\" "C:\\deep\\\\\\\\""',
    );
  });

  it("resolves relative path-segment commands against the spawn cwd, not the process cwd", () => {
    const seen: string[] = [];
    const resolved = resolveSpawnCommand("node_modules/.bin/vite", ["dev"], {
      platform: "win32",
      cwd: "C:\\site",
      env: { Path: "", PATHEXT: ".CMD", ComSpec: "cmd.exe" },
      exists: (candidate) => {
        seen.push(candidate);
        return candidate === "C:\\site\\node_modules\\.bin\\vite.CMD";
      },
    });
    expect(seen).toEqual(["C:\\site\\node_modules\\.bin\\vite.CMD"]);
    expect(resolved.command).toBe("cmd.exe");
    expect(resolved.args[3]).toBe('""C:\\site\\node_modules\\.bin\\vite.CMD" "dev""');
  });
});

// Real shim topology: the unit fakes elsewhere spawn process.execPath
// directly, so the cmd.exe wrapper path (quoting round-trip, exit-code
// propagation, tree kill) is only exercised here, with a genuine .cmd.
const describeWin32 = process.platform === "win32" ? describe : describe.skip;

describeWin32("real .cmd shim topology (win32)", () => {
  it("round-trips argv (including metacharacter tokens) and the exit code through a .cmd shim", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "echo-args.mjs"),
      "console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exit(7);\n",
    );
    await writeFile(
      join(dir, "fake.cmd"),
      `@echo off\r\nnode "%~dp0echo-args.mjs" %*\r\nexit /b %errorlevel%\r\n`,
    );

    const args = ["run", "dev", "--url=http://x/?a=1&b=2", "with space", "C:\\ends\\in\\backslash\\"];
    const resolved = resolveSpawnCommand("fake", args, {
      env: { ...process.env, Path: dir },
    });
    expect(resolved.windowsVerbatimArguments).toBe(true);

    const { stdout, code } = await new Promise<{ stdout: string; code: number | null }>(
      (resolve, reject) => {
        const child = spawn(resolved.command, resolved.args, {
          cwd: dir,
          stdio: ["ignore", "pipe", "pipe"],
          windowsVerbatimArguments: resolved.windowsVerbatimArguments,
        });
        let out = "";
        child.stdout.on("data", (chunk) => {
          out += String(chunk);
        });
        child.once("error", reject);
        child.once("exit", (exitCode) => resolve({ stdout: out, code: exitCode }));
      },
    );

    // The metacharacter token arrives intact (no second command ran) and the
    // shim's real exit code survives the cmd.exe wrapper.
    expect(JSON.parse(stdout.trim())).toEqual(args);
    expect(code).toBe(7);
  });

  it("killChildTreeWin32 kills the grandchild behind a .cmd wrapper", async () => {
    const dir = await tempDir();
    const pidFile = join(dir, "grandchild.pid");
    await writeFile(
      join(dir, "daemon.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    await writeFile(join(dir, "daemon.cmd"), `@echo off\r\nnode "%~dp0daemon.mjs"\r\n`);

    const resolved = resolveSpawnCommand("daemon", [], {
      env: { ...process.env, Path: dir },
    });
    const child = spawn(resolved.command, resolved.args, {
      cwd: dir,
      stdio: ["ignore", "ignore", "ignore"],
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    });

    const { readFile } = await import("node:fs/promises");
    let grandchildPid = 0;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        grandchildPid = Number((await readFile(pidFile, "utf8")).trim());
        if (grandchildPid > 0) break;
      } catch {
        // Not written yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(grandchildPid).toBeGreaterThan(0);

    const killed = await killChildTreeWin32(child);
    expect(killed).toBe(true);

    // The grandchild — not just the cmd.exe wrapper — must be dead.
    const gone = await new Promise<boolean>((resolve) => {
      const check = () => {
        try {
          process.kill(grandchildPid, 0);
          return false;
        } catch {
          return true;
        }
      };
      const poll = setInterval(() => {
        if (check()) {
          clearInterval(poll);
          resolve(true);
        }
      }, 50);
      setTimeout(() => {
        clearInterval(poll);
        resolve(check());
      }, 5000);
    });
    expect(gone).toBe(true);
  });
});
