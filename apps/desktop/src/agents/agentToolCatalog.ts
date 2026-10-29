import { z } from "zod";

export const AgentLaunchProfile = z.object({
  tool: z.enum(["claude", "codex"]),
  executable: z.string().min(1).max(2048).refine(
    (value) => /^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(value) && !/[\r\n\0]/u.test(value),
    "Choose an absolute executable path.",
  ),
}).strict();
export type AgentLaunchProfile = z.infer<typeof AgentLaunchProfile>;

// How dohc starts an agent: a tool it knows, or the person's own command.
export const AgentLaunch = z.union([
  AgentLaunchProfile,
  z.object({
    command: z.string().max(4096).refine((value) => value.trim().length > 0, "Enter the command that starts your agent."),
  }).strict(),
]);
export type AgentLaunch = z.infer<typeof AgentLaunch>;

export function launchProfile(launch: AgentLaunch): AgentLaunchProfile | undefined {
  return "tool" in launch ? launch : undefined;
}

/** The chosen tool, else the typed command, else null for neither. */
export function launchFrom(profile: AgentLaunchProfile | undefined, command: string): AgentLaunch | null {
  return profile ?? (command.trim() ? { command: command.trim() } : null);
}
export type AgentToolId = "claude" | "codex" | "opencode" | "cursor";

// What a person reads when Restricted Mode holds an agent back: main's
// notice and the band in Chats.
export const AGENTS_RESTRICTED_MESSAGE = "In Restricted Mode, dohc does not start agents in this workspace.";

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
    permissions: "Edits workspace files and replies without asking. Other actions use your Claude permissions; approval requests are denied." },
  { id: "codex", name: "Codex", command: "codex", authArgs: ["login", "status"],
    permissions: "Workspace-write sandbox. Runs without approval prompts." },
  { id: "opencode", name: "OpenCode", command: "opencode", authArgs: ["auth", "list", "--pure"],
    permissions: "No launch profile yet" },
  { id: "cursor", name: "Cursor", command: "cursor-agent", authArgs: ["status", "--format", "json"],
    permissions: "No launch profile yet" },
] as const;

// runArguments holds what one run adds: the dohc MCP server it replies
// through and, for Codex, its sandbox and trust (codexRunConfig.ts).
export function agentProfileArguments(profile: AgentLaunchProfile, runArguments: readonly string[] = []): string[] {
  // A Claude Code run loads only the person's own Claude Code settings, none from the workspace.
  // In CLI rules, / anchors at the primary working directory. Bare Edit matches every path.
  return profile.tool === "claude"
    ? ["-p", "--permission-prompts", "none", "--no-session-persistence", "--setting-sources", "user", ...runArguments, "--allowedTools", "Edit(/**)", "mcp__dohc__dohc_reply_to_chat", "--disallowedTools", "Edit(/.dohc/**)", "Edit(/.codex/**)"]
    : ["exec", "--config", "approval_policy=never", ...runArguments, "--skip-git-repo-check", "--ephemeral", "-"];
}

function quoteRunnerToken(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function launchCommand(launch: AgentLaunch): string {
  return "tool" in launch
    ? [quoteRunnerToken(launch.executable), ...agentProfileArguments(launch).map((arg) => /\s/u.test(arg) ? quoteRunnerToken(arg) : arg)].join(" ")
    : launch.command.trim();
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
