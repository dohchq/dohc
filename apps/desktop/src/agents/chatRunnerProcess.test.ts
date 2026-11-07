import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import {
  createChatRunnerProcess,
  readRunnerNodeAvailable,
  codexCheckWithTimeout,
  type ChatRunnerProcessOptions,
  type RunDohcTools,
  type RunnerSpawnOptions,
} from "./chatRunnerProcess";
import type { AgentLaunchProfile } from "./agentToolCatalog";
import { READ_ONLY_DISABLED_FEATURES, REPLY_ONLY_DISABLED_FEATURES } from "./codexRunConfig";
import { resolveSpawnCommand } from "../process/windowsSpawn";

const [bundledPlatform, bundledArch, nodeName] = process.platform === "win32"
  ? ["win32", "x64", "node.exe"] as const
  : ["darwin", "arm64", "node"] as const;

async function runnerFixture(platform: NodeJS.Platform, packaged = false, arch = "x64", overrides: Partial<ChatRunnerProcessOptions> = {}) {
  const root = await createTestScratch("dohc-chat-runner-");
  const calls: { command: string; args: string[]; options: RunnerSpawnOptions }[] = [];
  const checks: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const runner = createChatRunnerProcess(
    {
      stateDir: () => join(root, "state"),
      appRoot: () => root,
      isPackaged: () => packaged,
      resourcesPath: () => platform === "win32" ? join(root, "resources") : join(root, "resources").replace(/^[a-z]:/iu, "").replaceAll("\\", "/"),
      arch,
      platform,
      codexConfigFiles: () => ({ requirements: [], config: [], managedPreferences: [] }),
      runCodexCheck: async (command, args, options) => {
        checks.push({ command, args, cwd: options.cwd, env: options.env });
        return JSON.stringify([{ name: "dohc", enabled: true }]);
      },
      ...overrides,
      spawnRunner: (command, args, options) => {
        calls.push({ command, args, options });
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
  const spawn = (command: string, assertMayStart: () => void = () => undefined, profile?: AgentLaunchProfile, dohcTools: RunDohcTools = "reply") =>
    runner.spawnConfiguredRunner({
      rootPath: root,
      runId: "run-1",
      agentName: "Nova",
      logPath: join(root, "logs", "run.log"),
      command,
      profile,
      dohcTools,
      prompt: "",
      assertMayStart,
    });
  return { calls, checks, root, spawn };
}

describe("chat runner process", () => {
  it("refuses a directory in place of the packaged runtime", async () => {
    const { root, calls, spawn } = await runnerFixture(bundledPlatform, true, bundledArch);
    mkdirSync(join(root, "resources", "app-compiler", nodeName), { recursive: true });
    await expect(spawn(`"${process.execPath}"`)).rejects.toThrow("Reinstall dohc");
    expect(calls).toHaveLength(0);
  });

  it.runIf(process.platform !== "win32")("refuses a non-executable packaged POSIX runtime", async () => {
    const { root, calls, spawn } = await runnerFixture("darwin", true, "arm64");
    mkdirSync(join(root, "resources", "app-compiler"), { recursive: true });
    writeFileSync(join(root, "resources", "app-compiler", "node"), "runtime", { mode: 0o600 });
    await expect(spawn("agent")).rejects.toThrow("Reinstall dohc");
    expect(calls).toHaveLength(0);
  });

  it.each(["", "true", "{}", '{"source":"other","available":false}', '{"source":"path","available":"false"}'])("ignores malformed runtime records: %s", async (content) => {
    const root = await createTestScratch("dohc-chat-runner-");
    const log = join(root, "run.log");
    writeFileSync(`${log}.node`, content);
    expect(await readRunnerNodeAvailable(log)).toBeUndefined();
  });
  it.each(["claude", "codex", "custom"] as const)("refuses missing packaged Node before %s configuration, recording, or spawn", async (tool) => {
    const { root, calls, spawn } = await runnerFixture(bundledPlatform, true, bundledArch);
    vi.stubEnv("PATH", process.execPath);
    const profile = tool === "custom" ? undefined : { tool, executable: process.execPath, args: [] } as unknown as AgentLaunchProfile;
    await expect(spawn(`"${process.execPath}"`, () => undefined, profile)).rejects.toThrow(
      "dohc is missing a file it needs to run agents. Reinstall dohc, then try again.",
    );
    expect(calls).toHaveLength(0);
    expect(existsSync(join(root, "logs", "run.log.mcp.json"))).toBe(false);
    expect(existsSync(join(root, "logs", "run.log.node"))).toBe(false);
  });

  it("records the packaged reply runtime even without Node on PATH", async () => {
    const { root, spawn } = await runnerFixture(bundledPlatform, true, bundledArch);
    mkdirSync(join(root, "resources", "app-compiler"), { recursive: true });
    writeFileSync(join(root, "resources", "app-compiler", nodeName), "runtime", { mode: 0o755 });
    vi.stubEnv("PATH", "");
    await spawn(`"${process.execPath}"`);
    expect(await readRunnerNodeAvailable(join(root, "logs", "run.log"))).toEqual({ source: "bundled", available: true });
  });

  it("keeps packaged Linux arm64 on the PATH probe", async () => {
    const { root, spawn } = await runnerFixture("linux", true, "arm64");
    vi.stubEnv("PATH", "");
    await spawn("agent");
    expect(await readRunnerNodeAvailable(join(root, "logs", "run.log"))).toEqual({ source: "path", available: false });
  });

  it("uses the packaged runtime on Linux x64 and refuses to start without it", async () => {
    const { root, calls, spawn } = await runnerFixture("linux", true, "x64");
    vi.stubEnv("PATH", process.execPath);
    expect(() => spawn("agent")).toThrow("dohc is missing a file it needs to run agents. Reinstall dohc, then try again.");
    expect(calls).toHaveLength(0);
    mkdirSync(join(root, "resources", "app-compiler"), { recursive: true });
    writeFileSync(join(root, "resources", "app-compiler", "node"), "runtime", { mode: 0o755 });
    vi.stubEnv("PATH", "");
    spawn("agent");
    expect(calls).toHaveLength(1);
    expect(await readRunnerNodeAvailable(join(root, "logs", "run.log"))).toEqual({ source: "bundled", available: true });
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

  it.each([
    ["claude", "all"],
    ["claude", "reply"],
    ["codex", "all"],
    ["codex", "reply"],
  ] as const)("starts a %s run's dohc server with %s tools, each approved, and lets only an all-tools run write", async (tool, dohcTools) => {
    const { calls, checks, root, spawn } = await runnerFixture("linux");
    await spawn("", () => undefined, { tool, executable: process.execPath }, dohcTools);
    const serverArgs = ["--workspace", root, "--home", join(root, "state"), ...(dohcTools === "reply" ? ["--tool", "dohc_reply_to_chat"] : [])];
    const readOnly = dohcTools === "reply";
    const args = calls[0]!.args;
    expect(args.some((arg) => arg.includes("enabled_tools"))).toBe(false);
    if (tool === "claude") {
      expect(args.slice(args.indexOf("--mcp-config") + 2)).toEqual(readOnly
        ? ["--strict-mcp-config", "--restricted", "--disable-slash-commands", "--tools", "Read,Grep,Glob", "--allowedTools", "mcp__dohc"]
        : ["--allowedTools", "Edit(/**)", "mcp__dohc", "--disallowedTools", "Edit(/.dohc/**)", "Edit(/.codex/**)"]);
      expect(JSON.parse(readFileSync(join(root, "logs", "run.log.mcp.json"), "utf8")).mcpServers.dohc.args).toEqual(serverArgs);
      expect(checks).toEqual([]);
    } else {
      expect(args).toContain(`mcp_servers.dohc.args=[${serverArgs.map((arg) => `'${arg}'`).join(",")}]`);
      expect(args).toContain("mcp_servers.dohc.default_tools_approval_mode='approve'");
      expect(args.some((arg) => arg.startsWith("mcp_servers.dohc.tools."))).toBe(false);
      const permissions = args.filter((arg) => arg.startsWith("permissions.") || arg.startsWith("default_permissions="));
      if (readOnly) expect(permissions).toEqual([expect.stringMatching(/^permissions\.dohc_run_\w+=\{filesystem=\{':workspace_roots'=\{'\.'='read','\.dohc'='deny'\}\}\}$/u), expect.stringMatching(/^default_permissions='dohc_run_\w+'$/u)]);
      else expect(permissions).toEqual([expect.stringMatching(/^permissions\.dohc_run_\w+=\{extends=':workspace',/u), expect.stringMatching(/^default_permissions='dohc_run_\w+'$/u)]);
      expect(args.flatMap((arg, index) => args[index - 1] === "--disable" ? [arg] : [])).toEqual(readOnly ? [...READ_ONLY_DISABLED_FEATURES, ...REPLY_ONLY_DISABLED_FEATURES] : []);
      expect(args.includes("web_search='disabled'")).toBe(readOnly);
      expect(args.slice(-4)).toEqual([readOnly ? "--ignore-rules" : expect.anything(), "--skip-git-repo-check", "--ephemeral", "-"]);
      // A reply-only run asks Codex first which servers these same arguments
      // start. `codex mcp list` takes no --ignore-rules.
      expect(checks.map((check) => [check.command, check.args, check.cwd])).toEqual(readOnly
        ? [[process.execPath, ["mcp", "list", "--json", ...args.slice(3, -4)], root]]
        : []);
      if (readOnly) expect(checks[0]!.env).toBe(calls[0]!.options.env);
    }
  });

  it.each(["all", "reply"] as const)("ignores the person's saved Codex command rules only in a run with %s dohc tools when it is reply-only", async (dohcTools) => {
    const { calls, checks, spawn } = await runnerFixture("linux");
    await spawn("", () => undefined, { tool: "codex", executable: process.execPath }, dohcTools);
    expect(calls[0]!.args.includes("--ignore-rules")).toBe(dohcTools === "reply");
    expect(checks.flatMap((check) => check.args).includes("--ignore-rules")).toBe(false);
  });

  it.each(["all", "reply"] as const)("turns off the person's after-turn Codex command in a run with %s dohc tools when it is reply-only", async (dohcTools) => {
    const { calls, checks, spawn } = await runnerFixture("linux");
    await spawn("", () => undefined, { tool: "codex", executable: process.execPath }, dohcTools);
    const args = calls[0]!.args;
    const notify = args.flatMap((arg, index) => args[index - 1] === "--config" && arg.startsWith("notify=") ? [arg] : []);
    expect(notify).toEqual(dohcTools === "reply" ? ["notify=[]"] : []);
    if (dohcTools === "reply") expect(checks[0]!.args).toContain("notify=[]");
  });

  it.each(["all", "reply"] as const)("turns off the Codex shell and view_image in a run with %s dohc tools only when it is reply-only", async (dohcTools) => {
    const { calls, checks, spawn } = await runnerFixture("linux");
    await spawn("", () => undefined, { tool: "codex", executable: process.execPath }, dohcTools);
    for (const args of [calls[0]!.args, ...checks.map((check) => check.args)]) {
      const disabled = args.filter((_, index) => args[index - 1] === "--disable");
      expect(["shell_tool", "unified_exec", "view_image"].filter((feature) => disabled.includes(feature)))
        .toEqual(dohcTools === "reply" ? ["shell_tool", "unified_exec", "view_image"] : []);
    }
    expect(checks).toHaveLength(dohcTools === "reply" ? 1 : 0);
  });

  it.each([
    ["another server is on", JSON.stringify([{ name: "dohc", enabled: true }, { name: "owner", enabled: true }, { name: "off", enabled: false }]),
      "Codex would also start `owner`, so dohc didn't start it. dohc turns off only the MCP servers named in your Codex config.toml."],
    ["dohc's server is missing", JSON.stringify([{ name: "owner", enabled: false }]), "Codex didn't list dohc's MCP server, so dohc didn't start it."],
    ["the list isn't JSON", "Usage: codex", "Codex didn't list dohc's MCP server, so dohc didn't start it."],
  ])("starts no reply-only Codex run when %s, and says why in the run's log", async (_case, stdout, reason) => {
    const { calls, root, spawn } = await runnerFixture("linux", false, "x64", { runCodexCheck: async () => stdout });
    await expect(spawn("", () => undefined, { tool: "codex", executable: process.execPath }, "reply")).rejects.toThrow(reason);
    expect(calls).toEqual([]);
    expect(readFileSync(join(root, "logs", "run.log"), "utf8")).toBe(`${reason}\n`);
  });

  it("starts no reply-only Codex run when Codex can't list its servers", async () => {
    const { calls, spawn } = await runnerFixture("linux", false, "x64", { runCodexCheck: async () => { throw new Error("Unknown feature flag: plugins"); } });
    await expect(spawn("", () => undefined, { tool: "codex", executable: process.execPath }, "reply"))
      .rejects.toThrow("Codex couldn't list its MCP servers, so dohc didn't start it. Run `codex mcp list` to see why.");
    expect(calls).toEqual([]);
  });

  it("asks once more whether the run may start after the server check", async () => {
    let checked = false;
    const { calls, spawn } = await runnerFixture("linux", false, "x64", { runCodexCheck: async () => { checked = true; return JSON.stringify([{ name: "dohc", enabled: true }]); } });
    const mayStart = vi.fn(() => { if (checked) throw new Error("Restricted"); });
    await expect(spawn("", mayStart, { tool: "codex", executable: process.execPath }, "reply")).rejects.toThrow("Restricted");
    expect(mayStart).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
  });

  it("turns off each MCP server the person's Codex config names in a reply-only run, and none in an all-tools run", async () => {
    const home = await createTestScratch("dohc-codex-home-");
    writeFileSync(join(home, "config.toml"), "[mcp_servers.owner_a]\ncommand = 'a'\n[mcp_servers.owner-b]\ncommand = 'b'\n[mcp_servers.dohc]\ncommand = 'x'\n[mcp_servers.\"has.dot\"]\ncommand = 'c'\n");
    const { calls, spawn } = await runnerFixture("linux", false, "x64", { codexConfigFiles: () => ({ requirements: [], config: [join(home, "config.toml")], managedPreferences: [] }) });
    await spawn("", () => undefined, { tool: "codex", executable: process.execPath }, "reply");
    await spawn("", () => undefined, { tool: "codex", executable: process.execPath }, "all");
    const [replyOnly, allTools] = calls.map((call) => call.args.filter((arg) => /^mcp_servers\.[^.]+\.enabled=/u.test(arg)));
    // A name with a dot can't be turned off by key; the server check refuses it.
    expect(replyOnly).toEqual(["mcp_servers.owner_a.enabled=false", "mcp_servers.owner-b.enabled=false"]);
    expect(allTools).toEqual([]);
  });

  it.runIf(process.platform === "win32")("ends the whole npm-installed Codex process tree when its server check takes too long", async () => {
    const root = await createTestScratch("dohc-codex-check-");
    const pidFile = join(root, "codex.pid");
    // Stands in for npm's codex.cmd: cmd.exe starts a Node.js that never answers.
    const codex = join(root, "codex.cmd");
    writeFileSync(codex, `@"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)" "%~dp0codex.pid"\r\n`);
    const check = resolveSpawnCommand(codex, ["mcp", "list", "--json"], { env: process.env, platform: "win32", cwd: root });
    let pid: number | undefined;
    try {
      await expect(codexCheckWithTimeout(5_000)(check.command, check.args, { cwd: root, env: process.env, windowsVerbatimArguments: check.windowsVerbatimArguments }))
        .rejects.toThrow("Codex took too long to list its MCP servers.");
      pid = Number(readFileSync(pidFile, "utf8"));
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 10_000, interval: 100 });
    } finally {
      try { if (pid) process.kill(pid); } catch {}
    }
  });

  it("starts the runner when the Node.js sidecar write fails", async () => {
    const { calls, root, spawn } = await runnerFixture("linux");
    mkdirSync(join(root, "logs", "run.log.node"), { recursive: true });
    await expect(spawn("agent")).resolves.toBeDefined();
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
    await spawn("agent");
    expect(await readRunnerNodeAvailable(join(root, "logs", "run.log")))
      .toEqual({ source: "path", available: process.platform === "win32" || executable });
  });

  it("records Node.js as missing when it is only in the workspace or a relative PATH entry", async () => {
    const { root, spawn } = await runnerFixture("linux");
    writeFileSync(join(root, "node"), "not executed", { mode: 0o700 });
    vi.stubEnv("PATH", ["", ".", "relative"].join(delimiter));
    await spawn("agent");
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
      await spawn(`"${process.execPath}"`);
      expect(await readRunnerNodeAvailable(join(root, "logs", "run.log")))
        .toEqual({ source: "path", available: extension !== ".OTHER" });
    });

  it.runIf(process.platform === "win32")("does not count Node.js in the Windows current directory", async () => {
    const { root, spawn } = await runnerFixture("win32");
    writeFileSync(join(root, "node.exe"), "not executed");
    vi.stubEnv("PATH", ["", ".", "relative"].join(delimiter));
    await spawn(`"${process.execPath}"`);
    expect(await readRunnerNodeAvailable(join(root, "logs", "run.log"))).toEqual({ source: "path", available: false });
  });

  it.each(["claude", "codex"] as const)("passes the person's own %s flags once, before dohc's reply server, only in the owner's run", async (tool) => {
    const { calls, spawn } = await runnerFixture("linux");
    const profile = { tool, executable: `/opt/bin/${tool}`, arguments: ["--model", "own-model"] };
    await spawn("", () => undefined, profile, "all");
    await spawn("", () => undefined, profile, "reply");
    expect(calls).toHaveLength(2);
    const [owner, replyOnly] = calls;
    expect(owner!.command).toBe(`/opt/bin/${tool}`);
    expect(owner!.args.slice(0, 3)).toEqual([tool === "claude" ? "-p" : "exec", "--model", "own-model"]);
    expect(owner!.args.filter((arg) => arg === "own-model")).toHaveLength(1);
    const replyServer = owner!.args.indexOf(tool === "claude" ? "--mcp-config" : "mcp_servers.dohc.required=true");
    expect(replyServer).toBeGreaterThan(owner!.args.indexOf("own-model"));
    expect(replyOnly!.args).not.toContain("own-model");
  });

  it("refuses own flags that saving refuses, in the owner's run and a reply-only run", async () => {
    const { calls, spawn } = await runnerFixture("linux");
    for (const [tool, flags, rule] of [
      ["codex", ["resume", "--last"], "The first word after the program must be a flag, such as --model."],
      ["codex", ["--model", "o3", "--"], "Its flags cannot include a bare --."],
      ["claude", ["--model", "opus", "--settings"], "Its last flag needs a file or folder after it."],
    ] as const) {
      for (const dohcTools of ["all", "reply"] as const) {
        await expect(spawn("", () => undefined, { tool, executable: `/opt/bin/${tool}`, arguments: [...flags] }, dohcTools))
          .rejects.toThrow(`dohc did not start Nova. ${rule} Change the command in Settings › Agents.`);
      }
    }
    expect(calls).toEqual([]);
  });

  it("keeps the workspace folder out of the runner's program search", async () => {
    const spaced = join(process.cwd(), "Program Files");
    vi.stubEnv("PATH", ["", ".", "relative", '"."', process.cwd(), `"${spaced}"`].join(delimiter));
    const { calls, spawn } = await runnerFixture("win32");
    await spawn(`"${process.execPath}"`);
    const env = calls[0]!.options.env;
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe("1");
    expect(env.PATH!.split(delimiter).slice(1)).toEqual([process.cwd(), spaced]);
  });

  it.each(["claude", "codex"] as const)("keeps app execution aliases on a Windows PATH only for a %s run that can start them", async (tool) => {
    const aliases = join(process.cwd(), "Microsoft", "WindowsApps");
    const storePowerShell = join(aliases, "Microsoft.PowerShell_8wekyb3d8bbwe");
    vi.stubEnv("PATH", [aliases, process.cwd(), storePowerShell].join(delimiter));
    const { calls, spawn } = await runnerFixture("win32");
    await spawn("", undefined, { tool, executable: process.execPath });
    expect(calls[0]!.options.env.PATH!.split(delimiter).slice(1)).toEqual(
      tool === "codex" ? [process.cwd()] : [aliases, process.cwd(), storePowerShell],
    );
  });

  it("drops a quoted PATH entry elsewhere, where the quote is part of its name", async () => {
    vi.stubEnv("PATH", [`"${join(process.cwd(), "agents")}"`, process.cwd()].join(delimiter));
    const { calls, spawn } = await runnerFixture("linux");
    await spawn("dohc-missing-runner");
    expect(calls[0]!.options.env.PATH!.split(delimiter).slice(1)).toEqual([process.cwd()]);
  });

  it("refuses a runner Windows can't find on PATH instead of searching the workspace", async () => {
    const { calls, root, spawn } = await runnerFixture("win32");
    const reason = "Couldn't find dohc-missing-runner on PATH. Use its full path in the runner command.";
    await expect(spawn("dohc-missing-runner --print")).rejects.toThrow(reason);
    expect(calls).toEqual([]);
    expect(readFileSync(join(root, "logs", "run.log"), "utf8")).toBe(`${reason}\n`);
  });

  it.each(["all", "reply"] as const)("refuses a Windows Codex run with %s dohc tools only when it is reply-only and the requirements rule out its sandbox", async (dohcTools) => {
    const requirements = join(await createTestScratch("dohc-codex-requirements-"), "requirements.toml");
    writeFileSync(requirements, "[windows]\nrequire_mxc = true\n");
    const { calls, checks, spawn } = await runnerFixture("win32", false, "x64", { codexConfigFiles: () => ({ requirements: [requirements], config: [], managedPreferences: [] }) });
    const started = spawn("", undefined, { tool: "codex", executable: process.execPath }, dohcTools);
    if (dohcTools === "all") {
      await started;
      expect(calls).toHaveLength(1);
    } else {
      await expect(started).rejects.toThrow("Your organization's Codex settings don't allow automations to start this agent.");
      expect(calls).toEqual([]);
      expect(checks).toEqual([]);
    }
  });

  it("says a relative runner path that doesn't exist doesn't exist", async () => {
    const { spawn } = await runnerFixture("win32");
    await expect(spawn(String.raw`.\tools\agent.cmd`)).rejects.toThrow(
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
      await expect(spawn(`"${shim}"`)).rejects.toThrow(
        "Windows' command interpreter (ComSpec) isn't set to a full path. Set ComSpec to the full path of cmd.exe, then restart dohc.",
      );
    },
  );

  it("starts no runner when the last check before spawn refuses, and says why in the run's log", async () => {
    const { calls, root, spawn } = await runnerFixture("linux");
    await expect(spawn("dohc-runner", () => { throw new Error("Restricted"); })).rejects.toThrow("Restricted");
    expect(calls).toEqual([]);
    expect(readFileSync(join(root, "logs", "run.log"), "utf8")).toBe("Restricted\n");
  });

  it("passes a bare runner name to the system elsewhere", async () => {
    const { calls, spawn } = await runnerFixture("linux");
    await spawn("dohc-missing-runner");
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
      const child = await runner.spawnConfiguredRunner({
        rootPath: workspace,
        runId: "run-1",
        agentName: "Nova",
        logPath: join(shims, "run.log"),
        command: `"${shim}"`,
        dohcTools: "reply",
        prompt: "",
        assertMayStart: () => undefined,
      });
      const exitCode = await new Promise<number | null>((resolveExit) => child.onExit(resolveExit));
      expect(exitCode).toBe(0);
      expect(existsSync(join(workspace, "planted.txt"))).toBe(false);
      expect(readFileSync(join(shims, "node-version.txt"), "utf8")).toMatch(/^v\d+\./u);
    },
  );

  it.runIf(process.platform === "win32")("says why an npm-installed Codex can't start in a folder with an apostrophe", async () => {
    const root = join(await createTestScratch("dohc-chat-runner-"), "O'Brien");
    mkdirSync(root);
    // Stands in for npm's codex.cmd and records the arguments cmd.exe passes on.
    const codex = join(root, "codex.cmd");
    writeFileSync(codex, `@"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv))" "%~dp0args.json" %*\r\n`);
    const runner = createChatRunnerProcess(
      { stateDir: () => join(root, "state"), appRoot: () => root, isPackaged: () => false, codexConfigFiles: () => ({ requirements: [], config: [], managedPreferences: [] }),
        runCodexCheck: async () => JSON.stringify([{ name: "dohc", enabled: true }]) },
      () => undefined,
    );
    const start = (rootPath: string) => runner.spawnConfiguredRunner({
      rootPath,
      runId: "run-1",
      agentName: "Nova",
      logPath: join(root, "run.log"),
      command: "",
      profile: { tool: "codex", executable: codex },
      dohcTools: "reply",
      prompt: "",
      assertMayStart: () => undefined,
    });
    await expect(start(root)).rejects.toThrow(
      "Codex can't start here because this folder's path has an apostrophe and Codex was installed with npm. Rename the folder, or install Codex with OpenAI's installer.",
    );
    expect(existsSync(join(root, "args.json"))).toBe(false);
    // Without one in the workspace's path, the same Codex starts, and dohc's
    // own paths may still hold one.
    const workspace = await createTestScratch("dohc-chat-runner-");
    const child = await start(workspace);
    expect(await new Promise<number | null>((resolveExit) => child.onExit(resolveExit))).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "args.json"), "utf8"))).toContain(
      `mcp_servers.dohc.cwd='''${join(root, "node_modules", ".bin")}'''`,
    );
  });

  it.runIf(process.platform === "win32")("starts an npm-installed Codex without a writable folder whose path has an apostrophe", async () => {
    const scratch = realpathSync.native(await createTestScratch("dohc-chat-runner-"));
    const [workspace, apostrophe, plain] = ["ws", "o'brien", "plain"].map((name) => join(scratch, name));
    for (const folder of [workspace!, apostrophe!, plain!]) mkdirSync(folder);
    const config = join(scratch, "config.toml");
    writeFileSync(config, `[sandbox_workspace_write]\nwritable_roots = ${JSON.stringify([apostrophe, plain])}\n`);
    for (const [name, content] of [["codex.cmd", "@echo off\r\n"], ["codex.exe", ""]] as const) writeFileSync(join(scratch, name), content);
    // A run gets no writable folder inside a temp folder, and the scratch folder is in one.
    for (const name of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(name, undefined);
    const started: string[] = [];
    const runner = createChatRunnerProcess({
      stateDir: () => join(scratch, "state"),
      appRoot: () => scratch,
      isPackaged: () => false,
      platform: "win32",
      codexConfigFiles: () => ({ requirements: [], config: [config], managedPreferences: [] }),
      spawnRunner: (_command, args) => {
        started.push(args.join(" "));
        return { pid: 4_100, writeStdin: () => undefined, hasExited: () => false, onExit: () => undefined, onError: () => undefined };
      },
    }, () => undefined);
    for (const executable of ["codex.cmd", "codex.exe"]) {
      await runner.spawnConfiguredRunner({
        rootPath: workspace!,
        runId: "run-1",
        agentName: "Nova",
        logPath: join(scratch, "run.log"),
        command: "",
        profile: { tool: "codex", executable: join(scratch, executable) },
        dohcTools: "all",
        prompt: "",
        assertMayStart: () => undefined,
      });
    }
    const [shim, direct] = started;
    expect(shim).toContain(`'${plain}'='write'`);
    expect(shim).not.toContain("o'brien");
    expect(direct).toContain(`'${plain}'='write'`);
    expect(direct).toContain(`${JSON.stringify(apostrophe)}='write'`);
  });
});
