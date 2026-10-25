import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import {
  createChatRunnerProcess,
  readRunnerNodeAvailable,
  tokenizeRunnerCommand,
  type RunnerSpawnOptions,
} from "./chatRunnerProcess";
import type { AgentLaunchProfile } from "./agentToolCatalog";

async function runnerFixture(platform: NodeJS.Platform, packaged = false, arch = "x64") {
  const root = await createTestScratch("dohc-chat-runner-");
  const calls: { command: string; options: RunnerSpawnOptions }[] = [];
  const runner = createChatRunnerProcess(
    {
      stateDir: () => join(root, "state"),
      appRoot: () => root,
      isPackaged: () => packaged,
      resourcesPath: () => platform === "win32" ? join(root, "resources") : join(root, "resources").replace(/^[a-z]:/iu, "").replaceAll("\\", "/"),
      arch,
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
  const spawn = (command: string, assertMayStart = () => undefined, profile?: AgentLaunchProfile) =>
    runner.spawnConfiguredRunner({
      rootPath: root,
      runId: "run-1",
      logPath: join(root, "logs", "run.log"),
      command,
      profile,
      prompt: "",
      assertMayStart,
    });
  return { calls, root, spawn };
}

describe("chat runner process", () => {
  it("refuses a directory in place of the packaged runtime", async () => {
    const { root, calls, spawn } = await runnerFixture("win32", true);
    mkdirSync(join(root, "resources", "app-compiler", "node.exe"), { recursive: true });
    expect(() => spawn(`"${process.execPath}"`)).toThrow("Reinstall dohc");
    expect(calls).toHaveLength(0);
  });

  it.runIf(process.platform !== "win32")("refuses a non-executable packaged POSIX runtime", async () => {
    const { root, calls, spawn } = await runnerFixture("darwin", true, "arm64");
    mkdirSync(join(root, "resources", "app-compiler"), { recursive: true });
    writeFileSync(join(root, "resources", "app-compiler", "node"), "runtime", { mode: 0o600 });
    expect(() => spawn("agent")).toThrow("Reinstall dohc");
    expect(calls).toHaveLength(0);
  });

  it.each(["", "true", "{}", '{"source":"other","available":false}', '{"source":"path","available":"false"}'])("ignores malformed runtime records: %s", async (content) => {
    const root = await createTestScratch("dohc-chat-runner-");
    const log = join(root, "run.log");
    writeFileSync(`${log}.node`, content);
    expect(await readRunnerNodeAvailable(log)).toBeUndefined();
  });
  it.each(["claude", "codex", "custom"] as const)("refuses missing packaged Node before %s configuration, recording, or spawn", async (tool) => {
    const { root, calls, spawn } = await runnerFixture("win32", true);
    vi.stubEnv("PATH", process.execPath);
    const profile = tool === "custom" ? undefined : { tool, executable: process.execPath, args: [] } as unknown as AgentLaunchProfile;
    expect(() => spawn(`"${process.execPath}"`, () => undefined, profile)).toThrow(
      "dohc is missing a file it needs to run agents. Reinstall dohc, then try again.",
    );
    expect(calls).toHaveLength(0);
    expect(existsSync(join(root, "logs", "run.log.mcp.json"))).toBe(false);
    expect(existsSync(join(root, "logs", "run.log.node"))).toBe(false);
  });

  it("records the packaged reply runtime even without Node on PATH", async () => {
    const { root, spawn } = await runnerFixture("win32", true);
    mkdirSync(join(root, "resources", "app-compiler"), { recursive: true });
    writeFileSync(join(root, "resources", "app-compiler", "node.exe"), "runtime");
    vi.stubEnv("PATH", "");
    spawn(`"${process.execPath}"`);
    expect(await readRunnerNodeAvailable(join(root, "logs", "run.log"))).toEqual({ source: "bundled", available: true });
  });

  it.each(["x64", "arm64"])("keeps packaged Linux %s on the PATH probe", async (arch) => {
    const { root, spawn } = await runnerFixture("linux", true, arch);
    vi.stubEnv("PATH", "");
    spawn("agent");
    expect(await readRunnerNodeAvailable(join(root, "logs", "run.log"))).toEqual({ source: "path", available: false });
  });

  it.each([true, false])("reads legacy runtime records: %s", async (available) => {
    const root = await createTestScratch("dohc-chat-runner-");
    const log = join(root, "run.log");
    writeFileSync(`${log}.node`, `${available}\n`);
    expect(await readRunnerNodeAvailable(log)).toEqual({ source: "path", available });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts the runner when the Node.js sidecar write fails", async () => {
    const { calls, root, spawn } = await runnerFixture("linux");
    mkdirSync(join(root, "logs", "run.log.node"), { recursive: true });
    expect(() => spawn("agent")).not.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("agent");
  });

  it("treats a non-ENOENT Node.js sidecar read error as an unknown lookup", async () => {
    const root = await createTestScratch("dohc-chat-runner-");
    const logPath = join(root, "run.log");
    mkdirSync(`${logPath}.node`);
    await expect(readFile(`${logPath}.node`, "utf8")).rejects.toMatchObject({ code: "EISDIR" });
    await expect(readRunnerNodeAvailable(logPath)).resolves.toBeUndefined();
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
    expect(await readRunnerNodeAvailable(join(root, "logs", "run.log")))
      .toEqual({ source: "path", available: process.platform === "win32" || executable });
  });

  it("records Node.js as missing when it is only in the workspace or a relative PATH entry", async () => {
    const { root, spawn } = await runnerFixture("linux");
    writeFileSync(join(root, "node"), "not executed", { mode: 0o700 });
    vi.stubEnv("PATH", ["", ".", "relative"].join(delimiter));
    spawn("agent");
    expect(await readRunnerNodeAvailable(join(root, "logs", "run.log"))).toEqual({ source: "path", available: false });
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
      expect(await readRunnerNodeAvailable(join(root, "logs", "run.log")))
        .toEqual({ source: "path", available: extension !== ".OTHER" });
    });

  it.runIf(process.platform === "win32")("does not count Node.js in the Windows current directory", async () => {
    const { root, spawn } = await runnerFixture("win32");
    writeFileSync(join(root, "node.exe"), "not executed");
    vi.stubEnv("PATH", ["", ".", "relative"].join(delimiter));
    spawn(`"${process.execPath}"`);
    expect(await readRunnerNodeAvailable(join(root, "logs", "run.log"))).toEqual({ source: "path", available: false });
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

  it.each(["claude", "codex"] as const)("keeps app execution aliases on a Windows PATH only for a %s run that can start them", async (tool) => {
    const aliases = join(process.cwd(), "Microsoft", "WindowsApps");
    const storePowerShell = join(aliases, "Microsoft.PowerShell_8wekyb3d8bbwe");
    vi.stubEnv("PATH", [aliases, process.cwd(), storePowerShell].join(delimiter));
    const { calls, spawn } = await runnerFixture("win32");
    spawn("", undefined, { tool, executable: process.execPath });
    expect(calls[0]!.options.env.PATH!.split(delimiter).slice(1)).toEqual(
      tool === "codex" ? [process.cwd()] : [aliases, process.cwd(), storePowerShell],
    );
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

  it.runIf(process.platform === "win32")("starts an npm-installed Codex in a folder with an apostrophe", async () => {
    const root = join(await createTestScratch("dohc-chat-runner-"), "O'Brien");
    mkdirSync(root);
    // Stands in for npm's codex.cmd and records the arguments cmd.exe passes on.
    const codex = join(root, "codex.cmd");
    writeFileSync(codex, `@"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv))" "%~dp0args.json" %*\r\n`);
    const runner = createChatRunnerProcess(
      { stateDir: () => join(root, "state"), appRoot: () => root, isPackaged: () => false },
      () => undefined,
    );
    const child = runner.spawnConfiguredRunner({
      rootPath: root,
      runId: "run-1",
      logPath: join(root, "run.log"),
      command: "",
      profile: { tool: "codex", executable: codex },
      prompt: "",
      assertMayStart: () => undefined,
    });
    expect(await new Promise<number | null>((resolveExit) => child.onExit(resolveExit))).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "args.json"), "utf8"))).toContain(
      `mcp_servers.dohc.cwd='''${join(root, "node_modules", ".bin")}'''`,
    );
  });
});
