import { posix, win32 } from "node:path";
import { AGENT_TOOLS, type AgentToolDetection, type AgentToolId } from "./agentToolCatalog";

export interface ProbeOutput { exitCode: number | null; stdout: string; stderr: string }
export interface AgentProbeDependencies {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  workspaceRoot: string;
  realPath(path: string): string | null;
  isExecutable(path: string): boolean;
  run(executable: string, args: readonly string[]): Promise<ProbeOutput>;
}

// Only absolute PATH entries and known user install locations participate.
// A workspace-local executable must never shadow an installed tool in a probe.
export function agentExecutableCandidates(tool: AgentToolId, deps: Pick<AgentProbeDependencies, "platform" | "env" | "home">): string[] {
  const windows = deps.platform === "win32";
  const path = windows ? win32 : posix;
  const entry = AGENT_TOOLS.find((item) => item.id === tool)!;
  const directories = (deps.env.Path ?? deps.env.PATH ?? "").split(windows ? ";" : ":")
    .map((value) => value.replace(/^"(.*)"$/u, "$1")).filter((value) => path.isAbsolute(value));
  directories.push(path.join(deps.home, ".local", "bin"));
  if (windows) {
    if (deps.env.APPDATA) directories.push(path.join(deps.env.APPDATA, "npm"));
    if (deps.env.LOCALAPPDATA) directories.push(path.join(deps.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin"));
    if (deps.env.LOCALAPPDATA) directories.push(path.join(deps.env.LOCALAPPDATA, "cursor-agent"));
    if (deps.env.NVM_SYMLINK) directories.push(deps.env.NVM_SYMLINK);
  } else {
    directories.push("/usr/local/bin", "/opt/homebrew/bin", path.join(deps.home, ".opencode", "bin"),
      path.join(deps.home, ".volta", "bin"), path.join(deps.home, ".npm-global", "bin"));
  }
  if (deps.env.NVM_BIN) directories.push(deps.env.NVM_BIN);
  if (deps.env.VOLTA_HOME) directories.push(path.join(deps.env.VOLTA_HOME, "bin"));
  const extensions = windows
    ? (deps.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => /^\.(exe|com|cmd|bat)$/iu.test(ext))
    : [""];
  const candidates = directories.filter((dir) => path.isAbsolute(dir))
    .flatMap((dir) => extensions.map((ext) => path.join(dir, `${entry.command}${ext}`)));
  if (tool === "cursor") {
    candidates.push(...extensions.map((ext) => path.join(deps.home, ".local", "bin", `agent${ext}`)));
  }
  return [...new Set(candidates)];
}

export function parseAgentAuth(tool: AgentToolId, output: ProbeOutput): AgentToolDetection["auth"] {
  if (tool === "claude") {
    try {
      const value: unknown = JSON.parse(output.stdout);
      if (typeof value === "object" && value !== null && "loggedIn" in value) {
        if (value.loggedIn === true && output.exitCode === 0) return "signed-in";
        if (value.loggedIn === false) return "signed-out";
      }
    } catch { /* An unreadable probe is not evidence of sign-out. */ }
  }
  const text = `${output.stdout}\n${output.stderr}`.replace(/\x1b\[[0-9;]*m/gu, "");
  if (tool === "codex") {
    if (output.exitCode === 0 && /Logged in using /u.test(text)) return "signed-in";
    if (/Not logged in/iu.test(text)) return "signed-out";
  }
  if (tool === "cursor") {
    try {
      const value: unknown = JSON.parse(output.stdout);
      if (typeof value === "object" && value !== null && "isAuthenticated" in value) {
        if (value.isAuthenticated === true && output.exitCode === 0) return "signed-in";
        if (value.isAuthenticated === false) return "signed-out";
      }
    } catch { /* Older versions may not support JSON status. */ }
  }
  // Stored provider credentials do not prove that a provider will accept them.
  if (tool === "opencode" && output.exitCode === 0 && /\b[1-9]\d* credentials?\b/u.test(text)) return "credentials-found";
  return "unknown";
}

export async function probeAgentTools(deps: AgentProbeDependencies): Promise<AgentToolDetection[]> {
  const path = deps.platform === "win32" ? win32 : posix;
  const canonicalWorkspace = deps.realPath(deps.workspaceRoot);
  const insideWorkspace = (candidate: string, root: string): boolean => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  };
  const installedExecutable = (candidate: string): boolean => {
    if (!canonicalWorkspace || !path.isAbsolute(canonicalWorkspace)
      || insideWorkspace(candidate, deps.workspaceRoot) || insideWorkspace(candidate, canonicalWorkspace)) return false;
    if (!deps.isExecutable(candidate)) return false;
    const canonical = deps.realPath(candidate);
    return canonical !== null && path.isAbsolute(canonical)
      && !insideWorkspace(canonical, deps.workspaceRoot) && !insideWorkspace(canonical, canonicalWorkspace);
  };
  return Promise.all(AGENT_TOOLS.map(async (tool): Promise<AgentToolDetection> => {
    const executable = agentExecutableCandidates(tool.id, deps).find(installedExecutable) ?? null;
    const result: AgentToolDetection = { tool: tool.id, executable, version: null, auth: "unknown", probe: executable ? "failed" : "not-found" };
    if (!executable) return result;
    try {
      const version = await deps.run(executable, ["--version"]);
      if (version.exitCode !== 0) return result;
      // Return the version only, never a tool's free-form diagnostic output.
      result.version = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/u.exec(version.stdout)?.[0] ?? null;
      if (!result.version) return result;
      result.probe = "detected";
      if (tool.authArgs) result.auth = parseAgentAuth(tool.id, await deps.run(executable, tool.authArgs));
    } catch { /* Keep detection separate from probe success and authentication. */ }
    return result;
  }));
}
