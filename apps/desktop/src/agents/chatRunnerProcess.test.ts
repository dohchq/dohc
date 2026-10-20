import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  const spawn = (command: string) =>
    runner.spawnConfiguredRunner({
      rootPath: root,
      runId: "run-1",
      logPath: join(root, "logs", "run.log"),
      command,
      prompt: "",
    });
  return { calls, spawn };
}

describe("chat runner process", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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
    vi.stubEnv("PATH", ["", ".", "relative", process.cwd()].join(delimiter));
    const { calls, spawn } = await runnerFixture("win32");
    spawn(`"${process.execPath}"`);
    const env = calls[0]!.options.env;
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe("1");
    expect(env.PATH!.split(delimiter).slice(1)).toEqual([process.cwd()]);
  });

  it("refuses a runner Windows can't find on PATH instead of searching the workspace", async () => {
    const { calls, spawn } = await runnerFixture("win32");
    expect(() => spawn("dohc-missing-runner --print")).toThrow(
      "Couldn't find dohc-missing-runner on PATH. Use its full path in the runner command.",
    );
    expect(calls).toEqual([]);
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
      });
      const exitCode = await new Promise<number | null>((resolveExit) => child.onExit(resolveExit));
      expect(exitCode).toBe(0);
      expect(existsSync(join(workspace, "planted.txt"))).toBe(false);
      expect(readFileSync(join(shims, "node-version.txt"), "utf8")).toMatch(/^v\d+\./u);
    },
  );
});
