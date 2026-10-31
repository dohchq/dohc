import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deferred, type Deferred } from "../testing/deferred";
import { agentExecutableCandidates, parseAgentAuth, probeAgentTools, type AgentProbeDependencies, type ProbeOutput } from "./agentToolProbe";
import { fakeFolderStat, folderIdentities, shortNamePairs } from "../testing/containmentCases";

function fixture(overrides: Partial<AgentProbeDependencies> = {}): AgentProbeDependencies {
  return { platform: "win32", home: "C:\\Users\\ice", workspaceRoot: "C:\\Workspace", realPath: (path) => path,
    env: { PATH: 'relative;.;"C:\\Tools"', APPDATA: "C:\\Users\\ice\\AppData\\Roaming" }, isExecutable: () => false,
    stat: () => { throw new Error("identity unavailable"); },
    signal: new AbortController().signal, run: vi.fn(async () => ({ exitCode: 0, stdout: "1.2.3", stderr: "" })),
    codexMayRunWithoutLogin: () => false, ...overrides };
}

describe("read-only agent detection", () => {
  it.for([false, true])("a differently capitalized folder keeps its detection result (resolved: %s)", async (alias, context) => {
    const disk = mkdtempSync(join(tmpdir(), "dohc-probe-case-"));
    try {
      mkdirSync(join(disk, "Work", "bin"), { recursive: true });
      writeFileSync(join(disk, "Work", "bin", "codex"), "tool");
      if (!existsSync(join(disk, "work", "bin", "codex"))) context.skip();
      mkdirSync(join(disk, "outside"));
      writeFileSync(join(disk, "outside", "codex"), "tool");
      const lookup = (value: string) => join(disk, value.slice("/disk/".length));
      const candidate = alias ? "/disk/link/codex" : "/disk/work/bin/codex";
      const deps = fixture({ platform: "linux", workspaceRoot: "/disk/Work", home: "/home/test",
        env: { PATH: alias ? "/disk/link" : "/disk/work/bin" },
        realPath: (value) => value === candidate ? "/disk/work/bin/codex" : value,
        isExecutable: (value) => value === candidate,
        stat: (value) => statSync(lookup(value), { bigint: true }),
      });
      expect((await probeAgentTools(deps)).find((tool) => tool.tool === "codex")).toMatchObject({ executable: null, probe: "not-found" });
      expect(deps.run).not.toHaveBeenCalled();
      deps.env.PATH += ":/disk/outside";
      deps.isExecutable = (value) => value === candidate || value === "/disk/outside/codex";
      expect((await probeAgentTools(deps)).find((tool) => tool.tool === "codex")).toMatchObject({ executable: "/disk/outside/codex", probe: "detected" });
      expect(deps.run).toHaveBeenCalledTimes(2);
    } finally { rmSync(disk, { recursive: true, force: true }); }
  });

  describe.each(shortNamePairs("/folders", "LongFolderName", posix))("$name", ({ parent, child }) => {
    describe.each([false, true])("resolved: %s", (resolved) => {
      it.each(folderIdentities)("keeps the detection result for $name", async ({ identity }) => {
        const inside = identity !== "different";
        const target = posix.join(child, "bin", "codex");
        const candidate = resolved ? "/links/codex" : target;
        const deps = fixture({ platform: "linux", workspaceRoot: parent, home: "/home/test",
          env: { PATH: posix.dirname(candidate) }, realPath: (value) => value === candidate ? target : value,
          isExecutable: (value) => value === candidate,
          stat: vi.fn(fakeFolderStat(identity, parent, { dev: 2n, ino: 3n }, { dev: 2n, ino: 4n })),
        });
        expect((await probeAgentTools(deps)).find((tool) => tool.tool === "codex")?.probe).toBe(inside ? "not-found" : "detected");
        expect(deps.stat).toHaveBeenCalled();
        expect(deps.run).toHaveBeenCalledTimes(inside ? 0 : 2);
      });
    });
  });

  it.each((["win32", "darwin"] as const).flatMap((platform) => [false, true].map((resolved) => ({ platform, resolved }))))("stored spelling decides detection without stat on $platform (resolved: $resolved)", async ({ platform, resolved }) => {
    const path = platform === "win32" ? win32 : posix;
    const workspaceRoot = platform === "win32" ? "C:\\Work" : "/Users/me/Work";
    const candidate = path.join(resolved ? path.join(path.dirname(workspaceRoot), "Links") : workspaceRoot.toLowerCase(), "bin", platform === "win32" ? "codex.EXE" : "codex");
    const storedCandidate = path.join(workspaceRoot, "bin", path.basename(candidate));
    const stat = vi.fn(() => ({ dev: 2n, ino: 3n }));
    const rootLookup = resolved ? workspaceRoot.toLowerCase() : workspaceRoot;
    const deps = fixture({ platform, workspaceRoot: rootLookup, home: path.dirname(workspaceRoot),
      env: { PATH: path.dirname(candidate) }, stat, isExecutable: (value) => value === candidate,
      realPath: (value) => value === rootLookup ? workspaceRoot : value === candidate ? storedCandidate : value,
    });
    expect((await probeAgentTools(deps)).find((tool) => tool.tool === "codex")?.probe).toBe("not-found");
    expect(stat).not.toHaveBeenCalled();
    deps.env.PATH = path.join(path.dirname(workspaceRoot), "Tools");
    const installed = path.join(deps.env.PATH, path.basename(candidate));
    deps.isExecutable = (value) => value === installed;
    expect((await probeAgentTools(deps)).find((tool) => tool.tool === "codex")?.probe).toBe("detected");
    expect(stat).not.toHaveBeenCalled();
  });

  it("lookup spelling and folder identity give consistent Linux detection", async () => {
    const workspaceRoot = "/mnt/c/Work";
    const directories = ["/mnt/c/work/bin", "/mnt/c/WORK~1/bin", "/mnt/c/Users/me/AppData/Roaming/npm", "/home/me/.local/bin"];
    const codex = posix.join(directories[2]!, "codex"), claude = posix.join(directories[3]!, "claude");
    const deps = fixture({ platform: "linux", workspaceRoot, home: "/home/me", env: { PATH: directories.join(":") },
      realPath: (value) => value, stat: () => ({ dev: 2n, ino: 3n }),
      isExecutable: (value) => value === codex || value === claude || directories.slice(0, 2).some((dir) => value === posix.join(dir, "codex")),
    });
    const tools = await probeAgentTools(deps);
    expect(tools.find((tool) => tool.tool === "codex")).toMatchObject({ executable: codex, probe: "detected" });
    expect(tools.find((tool) => tool.tool === "claude")).toMatchObject({ executable: claude, probe: "detected" });
    expect(deps.run).toHaveBeenCalledTimes(4);
  });

  const installs = [
    { platform: "win32", name: "WinGet", tool: "claude", candidate: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe", target: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Claude\\claude.exe" },
    { platform: "win32", name: "npm global", tool: "codex", candidate: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd", target: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\codex\\codex.cmd" },
    { platform: "win32", name: "standalone", tool: "codex", candidate: "C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe", target: "C:\\Users\\me\\.codex\\packages\\current\\codex.exe" },
    { platform: "win32", name: "user local", tool: "claude", candidate: "C:\\Users\\me\\.local\\bin\\claude.exe", target: "C:\\Users\\me\\.local\\share\\claude\\versions\\current\\claude.exe" },
    { platform: "win32", name: "subst drive", tool: "codex", candidate: "R:\\Tools\\codex.exe", target: "C:\\Users\\me\\Tools\\codex.exe" },
    { platform: "win32", name: "mapped drive", tool: "claude", candidate: "X:\\Tools\\claude.exe", target: "\\\\server\\tools\\claude.exe" },
    { platform: "darwin", name: "Homebrew Caskroom", tool: "claude", candidate: "/opt/homebrew/bin/claude", target: "/opt/homebrew/Caskroom/claude/current/claude" },
    { platform: "darwin", name: "Homebrew Cellar", tool: "claude", candidate: "/opt/homebrew/bin/claude", target: "/opt/homebrew/Cellar/claude/current/bin/claude" },
    { platform: "darwin", name: "user local", tool: "claude", candidate: "/Users/me/.local/bin/claude", target: "/Users/me/.local/share/claude/versions/current/claude" },
    { platform: "darwin", name: "npm global", tool: "codex", candidate: "/Users/me/.npm-global/bin/codex", target: "/Users/me/.npm-global/lib/node_modules/codex/bin/codex" },
    { platform: "linux", name: "Homebrew", tool: "claude", candidate: "/home/linuxbrew/.linuxbrew/bin/claude", target: "/home/linuxbrew/.linuxbrew/Cellar/claude/current/bin/claude" },
    { platform: "linux", name: "user local", tool: "claude", candidate: "/home/me/.local/bin/claude", target: "/home/me/.local/share/claude/versions/current/claude" },
    { platform: "linux", name: "npm global", tool: "codex", candidate: "/home/me/.npm-global/bin/codex", target: "/home/me/.npm-global/lib/node_modules/codex/bin/codex" },
  ] as const;
  it.each(installs.flatMap((install) => [false, true].map((resolved) => ({ ...install, resolved }))))(
    "detects $name on $platform (resolved: $resolved)", async ({ platform, tool, candidate, target, resolved }) => {
      const path = platform === "win32" ? win32 : posix;
      const home = platform === "win32" ? "C:\\Users\\me" : platform === "darwin" ? "/Users/me" : "/home/me";
      const missing = path.join(home, "missing"), unavailable = path.join(home, "unavailable");
      const unresolved = path.join(unavailable, path.basename(candidate));
      const windowsApps = path.join(home, "AppData", "Local", "Microsoft", "WindowsApps");
      const directories = [missing, unavailable, ...(platform === "win32" ? [windowsApps] : []), path.dirname(candidate)];
      const deps = fixture({ platform, home, workspaceRoot: path.join(home, "Projects", "Work"),
        env: { PATH: directories.join(platform === "win32" ? ";" : ":"), PATHEXT: ".exe;.cmd" },
        realPath: (value) => value === unresolved ? null : value === candidate && resolved ? target : value,
        isExecutable: (value) => value === candidate || value === unresolved,
        stat: vi.fn(() => { throw new Error("unexpected identity lookup"); }),
      });
      expect((await probeAgentTools(deps)).find((result) => result.tool === tool)).toMatchObject({ executable: candidate, probe: "detected" });
      expect(deps.run).toHaveBeenCalledTimes(2);
      expect(deps.run).toHaveBeenCalledWith(candidate, ["--version"], deps.signal);
      expect(deps.stat).not.toHaveBeenCalled();
    },
  );
  it("resolves Windows PATHEXT in order and never searches relative PATH or workspace", async () => {
    const deps = fixture({ isExecutable: (path) => path === "C:\\Tools\\claude.CMD" });
    expect(agentExecutableCandidates("claude", deps).slice(0, 4)).toEqual(["C:\\Tools\\claude.COM", "C:\\Tools\\claude.EXE", "C:\\Tools\\claude.BAT", "C:\\Tools\\claude.CMD"]);
    const tools = await probeAgentTools(deps);
    expect(tools[0]).toMatchObject({ executable: "C:\\Tools\\claude.CMD", version: "1.2.3", probe: "detected", auth: "unknown" });
    expect(deps.run).toHaveBeenNthCalledWith(1, "C:\\Tools\\claude.CMD", ["--version"], deps.signal);
    expect(deps.run).toHaveBeenNthCalledWith(2, "C:\\Tools\\claude.CMD", ["auth", "status"], deps.signal);
    expect(deps.run).toHaveBeenCalledTimes(2);
  });
  it("finds native installs outside PATH and supports POSIX paths", () => {
    expect(agentExecutableCandidates("claude", fixture())).toContain("C:\\Users\\ice\\.local\\bin\\claude.EXE");
    expect(agentExecutableCandidates("opencode", fixture())).toContain("C:\\Users\\ice\\AppData\\Roaming\\npm\\opencode.CMD");
    const posix = fixture({ platform: "darwin", home: "/Users/sam", env: { PATH: ".:/opt/bin" } });
    expect(agentExecutableCandidates("codex", posix)).toContain("/opt/homebrew/bin/codex");
    expect(agentExecutableCandidates("cursor", posix)).toContain("/Users/sam/.local/bin/agent");
    expect(agentExecutableCandidates("codex", posix)).not.toContain("codex");
  });
  it("finds POSIX user installs and explicit version-manager locations without a shell", async () => {
    const deps = fixture({ platform: "linux", home: "/home/sam", workspaceRoot: "/work/project",
      env: { PATH: "", NVM_BIN: "/home/sam/.nvm/versions/node/v24/bin", VOLTA_HOME: "/opt/volta" },
      isExecutable: (path) => path === "/home/sam/.npm-global/bin/claude" });
    const candidates = agentExecutableCandidates("claude", deps);
    expect(candidates).toContain("/home/sam/.volta/bin/claude");
    expect(candidates).toContain("/home/sam/.npm-global/bin/claude");
    expect(candidates).toContain("/home/sam/.nvm/versions/node/v24/bin/claude");
    expect(candidates).toContain("/opt/volta/bin/claude");
    expect((await probeAgentTools(deps))[0].executable).toBe("/home/sam/.npm-global/bin/claude");
    expect(deps.run).toHaveBeenCalledTimes(2);
  });
  it.each([
    { platform: "win32" as const, workspaceRoot: "C:\\Workspace", unsafe: "c:\\WORKSPACE\\bin", safe: "C:\\Workspace-other\\bin", separator: ";", file: "claude.EXE" },
    { platform: "linux" as const, workspaceRoot: "/work/project", unsafe: "/work/project/bin", safe: "/work/project-other/bin", separator: ":", file: "claude" },
  ])("skips absolute PATH entries inside the workspace on $platform", async ({ platform, workspaceRoot, unsafe, safe, separator, file }) => {
    const slash = platform === "win32" ? "\\" : "/";
    const deps = fixture({ platform, workspaceRoot, env: { PATH: `${unsafe}${separator}${safe}` },
      isExecutable: (path) => path === `${unsafe}${slash}${file}` || path === `${safe}${slash}${file}` });
    expect((await probeAgentTools(deps))[0].executable).toBe(`${safe}${slash}${file}`);
    expect(deps.run).toHaveBeenCalledTimes(2);
    expect(deps.run).toHaveBeenCalledWith(`${safe}${slash}${file}`, ["--version"], deps.signal);
  });
  it.each([
    { platform: "win32" as const, workspaceRoot: "C:\\Workspace", canonicalRoot: "D:\\Project", candidate: "C:\\Tools\\claude.EXE", target: "d:\\PROJECT\\bin\\claude.EXE", path: "C:\\Tools" },
    { platform: "linux" as const, workspaceRoot: "/work/project", canonicalRoot: "/data/project", candidate: "/usr/local/bin/claude", target: "/data/project/bin/claude", path: "/usr/local/bin" },
  ])("does not probe symlinks or junctions targeting the workspace on $platform", async ({ platform, workspaceRoot, canonicalRoot, candidate, target, path }) => {
    const deps = fixture({ platform, workspaceRoot, env: { PATH: path }, isExecutable: (value) => value === candidate,
      realPath: (value) => value === workspaceRoot ? canonicalRoot : value === candidate ? target : value });
    expect((await probeAgentTools(deps))[0]).toMatchObject({ executable: null, probe: "not-found" });
    expect(deps.run).not.toHaveBeenCalled();
  });
  it("does not probe a workspace-local symlink even when its target is outside the workspace", async () => {
    const deps = fixture({ env: { PATH: "C:\\Workspace\\bin" }, isExecutable: (value) => value === "C:\\Workspace\\bin\\claude.EXE",
      realPath: (value) => value === "C:\\Workspace" ? value : "C:\\Tools\\claude.EXE" });
    expect((await probeAgentTools(deps))[0].executable).toBeNull();
    expect(deps.run).not.toHaveBeenCalled();
  });
  it.each(["workspace", "executable"])("does not probe when the %s canonical path cannot be resolved", async (missing) => {
    const deps = fixture({ isExecutable: (path) => path === "C:\\Tools\\claude.EXE",
      realPath: (path) => (missing === "workspace" ? path === "C:\\Workspace" : path === "C:\\Tools\\claude.EXE") ? null : path });
    expect((await probeAgentTools(deps))[0].executable).toBeNull();
    expect(deps.run).not.toHaveBeenCalled();
  });
  it("does not execute missing tools and isolates failures per tool", async () => {
    const missing = fixture();
    expect((await probeAgentTools(missing)).every((tool) => tool.probe === "not-found")).toBe(true);
    expect(missing.run).not.toHaveBeenCalled();
    const deps = fixture({ isExecutable: (path) => path.endsWith(".EXE"), run: vi.fn(async (path) => {
      if (path.includes("claude")) throw new Error("timeout");
      return { exitCode: 0, stdout: "codex-cli 0.155.1", stderr: "" };
    }) });
    const tools = await probeAgentTools(deps);
    expect(tools[0]).toMatchObject({ probe: "failed", auth: "unknown" });
    expect(tools[1]).toMatchObject({ probe: "detected", version: "0.155.1" });
  });
  it("keeps failed auth unknown and never returns identity or diagnostic output", () => {
    expect(parseAgentAuth("claude", { exitCode: 0, stdout: '{"loggedIn":true,"email":"private@example.com"}', stderr: "" })).toBe("signed-in");
    expect(parseAgentAuth("claude", { exitCode: 1, stdout: '{"loggedIn":false}', stderr: "" })).toBe("signed-out");
    expect(parseAgentAuth("claude", { exitCode: 1, stdout: "bad json", stderr: "network failure" })).toBe("unknown");
    expect(parseAgentAuth("codex", { exitCode: 0, stdout: "", stderr: "Logged in using ChatGPT" })).toBe("signed-in");
    expect(parseAgentAuth("codex", { exitCode: 0, stdout: "", stderr: "API key configured - sk-proj-***ABCD" })).toBe("signed-in");
    expect(parseAgentAuth("codex", { exitCode: 1, stdout: "", stderr: "Not logged in" })).toBe("signed-out");
    expect(parseAgentAuth("opencode", { exitCode: 0, stdout: "2 credentials", stderr: "" })).toBe("credentials-found");
    expect(parseAgentAuth("opencode", { exitCode: 0, stdout: "0 credentials", stderr: "" })).toBe("unknown");
    expect(parseAgentAuth("cursor", { exitCode: 0, stdout: '{"isAuthenticated":true,"userInfo":{"email":"private@example.com"}}', stderr: "" })).toBe("signed-in");
    expect(parseAgentAuth("cursor", { exitCode: 0, stdout: '{"isAuthenticated":false}', stderr: "" })).toBe("signed-out");
    expect(parseAgentAuth("cursor", { exitCode: 1, stdout: "", stderr: "Unsupported format" })).toBe("unknown");
  });
  it("keeps Codex's sign-in unknown when it isn't logged in but may reach a model another way", async () => {
    const codex = (codexMayRunWithoutLogin: boolean) => fixture({
      isExecutable: (path) => path === "C:\\Tools\\codex.EXE", codexMayRunWithoutLogin: () => codexMayRunWithoutLogin,
      run: vi.fn(async (_path: string, args: readonly string[]) => args[0] === "--version"
        ? { exitCode: 0, stdout: "codex-cli 0.163.0", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "Not logged in" }),
    });
    expect((await probeAgentTools(codex(false)))[1]).toMatchObject({ probe: "detected", auth: "signed-out" });
    expect((await probeAgentTools(codex(true)))[1]).toMatchObject({ probe: "detected", auth: "unknown" });
  });
  it("does not authenticate after a failed version probe", async () => {
    const deps = fixture({ isExecutable: (path) => path.endsWith("claude.EXE"), run: vi.fn(async () => ({ exitCode: 1, stdout: "secret error", stderr: "" })) });
    expect((await probeAgentTools(deps))[0]).toMatchObject({ version: null, auth: "unknown", probe: "failed" });
    expect(deps.run).toHaveBeenCalledTimes(1);
  });
});

const CLAUDE = "C:\\Tools\\claude.EXE";
const CODEX = "C:\\Tools\\codex.EXE";
const failedOutput: ProbeOutput = { exitCode: 1, stdout: "", stderr: "" };
const turn = () => new Promise<void>((resolve) => { setImmediate(resolve); });

function observe<T>(promise: Promise<T>) {
  const seen: { outcome?: { value: T } | { error: unknown } } = {};
  const done = promise.then((value) => { seen.outcome = { value }; }, (error: unknown) => { seen.outcome = { error }; });
  return { seen, done };
}

// Each run stays pending until its test settles it, which stands in for subprocess drainage.
function controlledProbes(executables: readonly string[]) {
  const controller = new AbortController();
  const calls: Array<{ executable: string; output: Deferred<ProbeOutput> }> = [];
  const run = vi.fn((executable: string, _args: readonly string[], _signal: AbortSignal) => {
    const output = deferred<ProbeOutput>();
    calls.push({ executable, output });
    return output.promise;
  });
  const deps = fixture({ signal: controller.signal, run, isExecutable: (path) => executables.includes(path) });
  const drainAll = async (detection: Promise<void>) => {
    controller.abort();
    for (const call of calls) call.output.resolve(failedOutput);
    await detection;
  };
  return { controller, calls, run, deps, drainAll };
}

describe("cancelled agent detection", () => {
  const reason = new Error("Agent detection was cancelled.");

  it("does not probe when detection is already cancelled", async () => {
    const probes = controlledProbes([CLAUDE]);
    probes.controller.abort(reason);
    await expect(probeAgentTools(probes.deps)).rejects.toBe(reason);
    expect(probes.run).not.toHaveBeenCalled();
  });

  it("waits for a cancelled version probe to drain and never starts authentication", async () => {
    const probes = controlledProbes([CLAUDE]);
    const detection = observe(probeAgentTools(probes.deps));
    try {
      expect(probes.run).toHaveBeenCalledWith(CLAUDE, ["--version"], probes.controller.signal);
      probes.controller.abort(reason);
      await turn();
      expect(detection.seen.outcome).toBeUndefined();
      probes.calls[0]!.output.reject(reason);
      await detection.done;
    } finally {
      await probes.drainAll(detection.done);
    }
    expect(detection.seen.outcome).toEqual({ error: reason });
    expect(probes.run).toHaveBeenCalledOnce();
  });

  it("checks cancellation between the version and authentication probes", async () => {
    const probes = controlledProbes([CLAUDE]);
    const detection = observe(probeAgentTools(probes.deps));
    try {
      probes.calls[0]!.output.resolve({ exitCode: 0, stdout: "2.1.300", stderr: "" });
      probes.controller.abort(reason);
      await detection.done;
    } finally {
      await probes.drainAll(detection.done);
    }
    expect(detection.seen.outcome).toEqual({ error: reason });
    expect(probes.run).toHaveBeenCalledOnce();
  });

  it("rejects without partial results after a cancelled authentication probe drains", async () => {
    const probes = controlledProbes([CLAUDE]);
    const detection = observe(probeAgentTools(probes.deps));
    try {
      probes.calls[0]!.output.resolve({ exitCode: 0, stdout: "2.1.300", stderr: "" });
      await turn();
      expect(probes.run).toHaveBeenLastCalledWith(CLAUDE, ["auth", "status"], probes.controller.signal);
      probes.controller.abort(reason);
      await turn();
      expect(detection.seen.outcome).toBeUndefined();
      probes.calls[1]!.output.resolve({ exitCode: 0, stdout: '{"loggedIn":true}', stderr: "" });
      await detection.done;
    } finally {
      await probes.drainAll(detection.done);
    }
    expect(detection.seen.outcome).toEqual({ error: reason });
    expect(probes.run).toHaveBeenCalledTimes(2);
  });

  it.each([
    { first: "fails", outcome: () => new Error("probe failed") },
    { first: "is cancelled", outcome: () => reason },
  ])("stays pending after one probe $first until every started probe drains", async ({ outcome }) => {
    const probes = controlledProbes([CLAUDE, CODEX]);
    const detection = observe(probeAgentTools(probes.deps));
    try {
      expect(probes.calls.map((call) => call.executable)).toEqual([CLAUDE, CODEX]);
      probes.controller.abort(reason);
      probes.calls[0]!.output.reject(outcome());
      await turn();
      expect(detection.seen.outcome).toBeUndefined();
      probes.calls[1]!.output.reject(reason);
      await detection.done;
    } finally {
      await probes.drainAll(detection.done);
    }
    expect(detection.seen.outcome).toEqual({ error: reason });
    expect(probes.run).toHaveBeenCalledTimes(2);
  });
});
