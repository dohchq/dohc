import { describe, expect, it, vi } from "vitest";
import { agentExecutableCandidates, parseAgentAuth, probeAgentTools, type AgentProbeDependencies } from "./agentToolProbe";

function fixture(overrides: Partial<AgentProbeDependencies> = {}): AgentProbeDependencies {
  return { platform: "win32", home: "C:\\Users\\ice", workspaceRoot: "C:\\Workspace", realPath: (path) => path,
    env: { PATH: 'relative;.;"C:\\Tools"', APPDATA: "C:\\Users\\ice\\AppData\\Roaming" }, isExecutable: () => false,
    run: vi.fn(async () => ({ exitCode: 0, stdout: "1.2.3", stderr: "" })), ...overrides };
}

describe("read-only agent detection", () => {
  it("resolves Windows PATHEXT in order and never searches relative PATH or workspace", async () => {
    const deps = fixture({ isExecutable: (path) => path === "C:\\Tools\\claude.CMD" });
    expect(agentExecutableCandidates("claude", deps).slice(0, 4)).toEqual(["C:\\Tools\\claude.COM", "C:\\Tools\\claude.EXE", "C:\\Tools\\claude.BAT", "C:\\Tools\\claude.CMD"]);
    const tools = await probeAgentTools(deps);
    expect(tools[0]).toMatchObject({ executable: "C:\\Tools\\claude.CMD", version: "1.2.3", probe: "detected", auth: "unknown" });
    expect(deps.run).toHaveBeenNthCalledWith(1, "C:\\Tools\\claude.CMD", ["--version"]);
    expect(deps.run).toHaveBeenNthCalledWith(2, "C:\\Tools\\claude.CMD", ["auth", "status"]);
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
    expect(deps.run).toHaveBeenCalledWith(`${safe}${slash}${file}`, ["--version"]);
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
    expect(parseAgentAuth("codex", { exitCode: 1, stdout: "", stderr: "Not logged in" })).toBe("signed-out");
    expect(parseAgentAuth("opencode", { exitCode: 0, stdout: "2 credentials", stderr: "" })).toBe("credentials-found");
    expect(parseAgentAuth("opencode", { exitCode: 0, stdout: "0 credentials", stderr: "" })).toBe("unknown");
    expect(parseAgentAuth("cursor", { exitCode: 0, stdout: '{"isAuthenticated":true,"userInfo":{"email":"private@example.com"}}', stderr: "" })).toBe("signed-in");
    expect(parseAgentAuth("cursor", { exitCode: 0, stdout: '{"isAuthenticated":false}', stderr: "" })).toBe("signed-out");
    expect(parseAgentAuth("cursor", { exitCode: 1, stdout: "", stderr: "Unsupported format" })).toBe("unknown");
  });
  it("does not authenticate after a failed version probe", async () => {
    const deps = fixture({ isExecutable: (path) => path.endsWith("claude.EXE"), run: vi.fn(async () => ({ exitCode: 1, stdout: "secret error", stderr: "" })) });
    expect((await probeAgentTools(deps))[0]).toMatchObject({ version: null, auth: "unknown", probe: "failed" });
    expect(deps.run).toHaveBeenCalledTimes(1);
  });
});
