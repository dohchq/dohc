import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import {
  createChatRunnerProcess,
  tokenizeRunnerCommand,
  type RunnerSpawnOptions,
} from "./chatRunnerProcess";

async function runnerFixture(platform: NodeJS.Platform) {
  const root = await createTestScratch("dohc-chat-runner-");
  const calls: { command: string; options: RunnerSpawnOptions }[] = [];
  const runner = createChatRunnerProcess(
    {
      stateDir: () => join(root, "state"),
      appRoot: () => root,
      isPackaged: () => false,
      platform,
      spawnRunner: (command, _args, options) => {
        calls.push({ command, options });
        return {
          pid: 4_100,
          writeStdin: () => undefined,
          hasExited: () => false,
          onExit: () => undefined,
          onError: () => undefined,
        };
      },
    },
    () => undefined,
  );
  const spawn = (command: string, assertMayStart = () => undefined) =>
    runner.spawnConfiguredRunner({
      rootPath: root,
      runId: "run-1",
      logPath: join(root, "logs", "run.log"),
      command,
      prompt: "",
      assertMayStart,
    });
  return { calls, root, spawn };
}

describe("chat runner process", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([false, true])("records Node.js on the filtered POSIX runner PATH: %s", async (executable) => {
    const { root, spawn } = await runnerFixture("linux");
    const bin = join(root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const node = join(bin, "node");
    writeFileSync(node, "not executed");
    chmodSync(node, executable ? 0o700 : 0o600);
    vi.stubEnv("PATH", "");
    spawn("agent");
    expect(readFileSync(join(root, "logs", "run.log.node"), "utf8"))
      .toBe(`${process.platform === "win32" || executable}\n`);
  });

  it("records Node.js as missing when it is only in the workspace or a relative PATH entry", async () => {
    const { root, spawn } = await runnerFixture("linux");
    writeFileSync(join(root, "node"), "not executed", { mode: 0o700 });
    vi.stubEnv("PATH", ["", ".", "relative"].join(delimiter));
    spawn("agent");
    expect(readFileSync(join(root, "logs", "run.log.node"), "utf8")).toBe("false\n");
  });

  it.runIf(process.platform === "win32")
    .each([".EXE", ".CMD", ".OTHER"])("uses the runner's PATHEXT for Node.js lookup: %s", async (extension) => {
      const { root, spawn } = await runnerFixture("win32");
      const bin = join(root, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, `node${extension}`), "not executed");
      vi.stubEnv("PATH", "");
      vi.stubEnv("PATHEXT", ".CMD;.EXE");
      spawn(`"${process.execPath}"`);
      expect(readFileSync(join(root, "logs", "run.log.node"), "utf8"))
        .toBe(`${extension !== ".OTHER"}\n`);
    });

  it.runIf(process.platform === "win32")("does not count Node.js in the Windows current directory", async () => {
    const { root, spawn } = await runnerFixture("win32");
    writeFileSync(join(root, "node.exe"), "not executed");
    vi.stubEnv("PATH", ["", ".", "relative"].join(delimiter));
    spawn(`"${process.execPath}"`);
    expect(readFileSync(join(root, "logs", "run.log.node"), "utf8")).toBe("false\n");
  });

  it("tokenizes quoted runner arguments and rejects an unterminated command", () => {
    expect(
      tokenizeRunnerCommand('claude -p --allowedTools "Bash(dohc chat:*)" --label "two words"'),
    ).toEqual(["claude", "-p", "--allowedTools", "Bash(dohc chat:*)", "--label", "two words"]);
    expect(() => tokenizeRunnerCommand('claude -p "unterminated')).toThrow(
      "Runner command has an unterminated double quote.",
    );
  });

  it("keeps the workspace folder out of the runner's program search", async () => {
    const spaced = join(process.cwd(), "Program Files");
    vi.stubEnv("PATH", ["", ".", "relative", '"."', process.cwd(), `"${spaced}"`].join(delimiter));
    const { calls, spawn } = await runnerFixture("win32");
    spawn(`"${process.execPath}"`);
    const env = calls[0]!.options.env;
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe("1");
    expect(env.PATH!.split(delimiter).slice(1)).toEqual([process.cwd(), spaced]);
  });

  it("drops a quoted PATH entry elsewhere, where the quote is part of its name", async () => {
    vi.stubEnv("PATH", [`"${join(process.cwd(), "agents")}"`, process.cwd()].join(delimiter));
    const { calls, spawn } = await runnerFixture("linux");
    spawn("dohc-missing-runner");
    expect(calls[0]!.options.env.PATH!.split(delimiter).slice(1)).toEqual([process.cwd()]);
  });

  it("refuses a runner Windows can't find on PATH instead of searching the workspace", async () => {
    const { calls, root, spawn } = await runnerFixture("win32");
    const reason = "Couldn't find dohc-missing-runner on PATH. Use its full path in the runner command.";
    expect(() => spawn("dohc-missing-runner --print")).toThrow(reason);
    expect(calls).toEqual([]);
    expect(readFileSync(join(root, "logs", "run.log"), "utf8")).toBe(`${reason}\n`);
  });

  it("says a relative runner path that doesn't exist doesn't exist", async () => {
    const { spawn } = await runnerFixture("win32");
    expect(() => spawn(String.raw`.\tools\agent.cmd`)).toThrow(
      String.raw`.\tools\agent.cmd doesn't exist. Use its full path in the runner command.`,
    );
  });

  it.runIf(process.platform === "win32")(
    "says ComSpec isn't a full path when a shim needs cmd.exe",
    async () => {
      vi.stubEnv("ComSpec", "cmd.exe");
      const { root, spawn } = await runnerFixture("win32");
      const shim = join(root, "agent.cmd");
      writeFileSync(shim, "@echo off\r\n");
      expect(() => spawn(`"${shim}"`)).toThrow(
        "Windows' command interpreter (ComSpec) isn't set to a full path. Set ComSpec to the full path of cmd.exe, then restart dohc.",
      );
    },
  );

  it("starts no runner when the last check before spawn refuses, and says why in the run's log", async () => {
    const { calls, root, spawn } = await runnerFixture("linux");
    expect(() => spawn("dohc-runner", () => { throw new Error("Restricted"); })).toThrow("Restricted");
    expect(calls).toEqual([]);
    expect(readFileSync(join(root, "logs", "run.log"), "utf8")).toBe("Restricted\n");
  });

  it("passes a bare runner name to the system elsewhere", async () => {
    const { calls, spawn } = await runnerFixture("linux");
    spawn("dohc-missing-runner");
    expect(calls[0]!.command).toBe("dohc-missing-runner");
  });

  it.runIf(process.platform === "win32")(
    "does not run a node.cmd planted at the workspace root through an npm shim",
    async () => {
      vi.stubEnv("NoDefaultCurrentDirectoryInExePath", undefined);
      const workspace = await createTestScratch("dohc-chat-runner-workspace-");
      const shims = await createTestScratch("dohc-chat-runner-shims-");
      writeFileSync(join(workspace, "node.cmd"), '@echo planted> "%~dp0planted.txt"\r\n');
      // npm's cmd-shim, with no node.exe beside it, so it runs a bare `node`.
      const shim = join(shims, "agent.cmd");
      writeFileSync(shim, [
        "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start",
        "SETLOCAL", "CALL :find_dp0",
        'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (",
        '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")",
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" --version > "%dp0%\\node-version.txt"',
        "",
      ].join("\r\n"));
      const runner = createChatRunnerProcess(
        {
          stateDir: () => join(shims, "state"),
          appRoot: () => shims,
          isPackaged: () => false,
        },
        () => undefined,
      );
      const child = runner.spawnConfiguredRunner({
        rootPath: workspace,
        runId: "run-1",
        logPath: join(shims, "run.log"),
        command: `"${shim}"`,
        prompt: "",
        assertMayStart: () => undefined,
      });
      const exitCode = await new Promise<number | null>((resolveExit) => child.onExit(resolveExit));
      expect(exitCode).toBe(0);
      expect(existsSync(join(workspace, "planted.txt"))).toBe(false);
      expect(readFileSync(join(shims, "node-version.txt"), "utf8")).toMatch(/^v\d+\./u);
    },
  );
});
