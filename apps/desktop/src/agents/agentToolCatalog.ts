import { z } from "zod";

export const AgentLaunchProfile = z.object({
  tool: z.enum(["claude", "codex"]),
  executable: z.string().min(1).max(2048).refine(
    (value) => /^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(value) && !/[\r\n\0]/u.test(value),
    "Choose an absolute executable path.",
  ),
}).strict();
export type AgentLaunchProfile = z.infer<typeof AgentLaunchProfile>;
export type AgentToolId = "claude" | "codex" | "opencode" | "cursor";

export function supportsAgentProfile(tool: AgentToolId, version: string | null): boolean {
  if (tool === "codex") return version !== null;
  if (tool !== "claude" || !version) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major! > 2 || (major === 2 && (minor! > 1 || (minor === 1 && patch! >= 259)));
}

export const AGENT_TOOLS = [
  { id: "claude", name: "Claude Code", command: "claude", authArgs: ["auth", "status"],
    permissions: "Uses your Claude permissions. Requests that need approval are denied." },
  { id: "codex", name: "Codex", command: "codex", authArgs: ["login", "status"],
    permissions: "Workspace-write sandbox. Runs without approval prompts." },
  { id: "opencode", name: "OpenCode", command: "opencode", authArgs: ["auth", "list", "--pure"],
    permissions: "No launch profile yet" },
  { id: "cursor", name: "Cursor", command: "cursor-agent", authArgs: ["status", "--format", "json"],
    permissions: "No launch profile yet" },
] as const;

export function agentProfileArguments(profile: AgentLaunchProfile): string[] {
  return profile.tool === "claude"
    ? ["-p", "--permission-prompts", "none", "--no-session-persistence"]
    : ["exec", "--config", "approval_policy=never", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "-"];
}

function quoteRunnerToken(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function configuredRunnerCommand(runner: { command: string; profile?: AgentLaunchProfile }): string {
  return runner.profile
    ? [quoteRunnerToken(runner.profile.executable), ...agentProfileArguments(runner.profile)].join(" ")
    : runner.command.trim();
}

export const AgentToolDetection = z.object({
  tool: z.enum(["claude", "codex", "opencode", "cursor"]),
  executable: z.string().max(2048).nullable(),
  version: z.string().max(200).nullable(),
  auth: z.enum(["signed-in", "signed-out", "credentials-found", "unknown"]),
  probe: z.enum(["detected", "not-found", "failed"]),
}).strict();
export type AgentToolDetection = z.infer<typeof AgentToolDetection>;

export const AgentToolsResult = z.object({
  workingDirectory: z.string().min(1).max(32768),
  tools: z.array(AgentToolDetection).max(4),
}).strict();
export type AgentToolsResult = z.infer<typeof AgentToolsResult>;
