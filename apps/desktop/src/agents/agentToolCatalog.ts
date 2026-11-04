import { z } from "zod";

export const AgentLaunchProfile = z.object({
  tool: z.enum(["claude", "codex"]),
  executable: z.string().min(1).max(2048).refine(
    (value) => /^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(value) && !/[\r\n\0]/u.test(value),
    "Choose an absolute executable path.",
  ),
  // The person's own flags, at most as long as a typed command.
  arguments: z.array(z.string().refine((value) => !/[\r\n\0]/u.test(value)))
    .max(2048).refine((values) => values.join(" ").length <= 4096).optional(),
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
  return profile ?? launchFromCommand(command);
}

/**
 * What a typed command saves. A command that starts Claude Code or Codex by
 * its full path keeps that tool's profile, with the rest as the person's own
 * flags. Any other command runs as typed.
 */
export function launchFromCommand(command: string): AgentLaunch | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  let tokens: string[];
  try {
    tokens = tokenizeRunnerCommand(trimmed);
  } catch {
    return { command: trimmed };
  }
  const [executable = "", ...flags] = tokens;
  const tool = /^(claude|codex)(?:\.(?:exe|cmd|bat))?$/iu.exec(executable.split(/[\\/]/u).pop() ?? "")?.[1]?.toLowerCase();
  const profile = AgentLaunchProfile.safeParse({ tool, executable, ...(flags.length > 0 ? { arguments: flags } : {}) });
  return profile.success ? profile.data : { command: trimmed };
}

/** The line under a command field: what dohc adds when it starts the command. */
export function launchCommandHint(launch: AgentLaunch | null): string {
  const tool = launch ? launchProfile(launch)?.tool : undefined;
  return tool === "claude" ? "dohc adds its reply tool. The conversation arrives through stdin."
    : tool === "codex" ? "dohc adds its reply tool and sandbox. The conversation arrives through stdin."
    : "dohc runs this command as typed. The conversation arrives through stdin.";
}
export type AgentToolId = "claude" | "codex" | "opencode" | "cursor";

// What a person reads when Restricted Mode holds an agent back: main's
// notice and the band in Chats.
export const AGENTS_RESTRICTED_MESSAGE = "In Restricted Mode, dohc does not start agents in this workspace.";

// The oldest Claude Code dohc starts. dohc checks it in Settings and again
// before each run.
export const CLAUDE_MIN_VERSION = "2.1.316";

export function supportsAgentProfile(tool: AgentToolId, version: string | null): boolean {
  if (tool === "codex") return version !== null;
  if (tool !== "claude" || !version) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  const [minMajor, minMinor, minPatch] = CLAUDE_MIN_VERSION.split(".").map(Number) as [number, number, number];
  return major !== minMajor ? major > minMajor : minor !== minMinor ? minor > minMinor : patch >= minPatch;
}

export const AGENT_TOOLS = [
  { id: "claude", name: "Claude Code", command: "claude", authArgs: ["auth", "status"],
    permissions: "Edits workspace files and uses dohc's tools without asking. Other actions use your Claude permissions; approval requests are denied." },
  { id: "codex", name: "Codex", command: "codex", authArgs: ["login", "status"],
    permissions: "Workspace-write sandbox. Runs without approval prompts." },
  { id: "opencode", name: "OpenCode", command: "opencode", authArgs: ["auth", "list", "--pure"],
    permissions: "No launch profile yet" },
  { id: "cursor", name: "Cursor", command: "cursor-agent", authArgs: ["status", "--format", "json"],
    permissions: "No launch profile yet" },
] as const;

// runArguments holds what one run adds: the dohc MCP server it replies
// through and, for Codex, its sandbox and trust (codexRunConfig.ts). The
// person's own flags come right after the subcommand, so where they set an
// option dohc sets too, dohc's later one wins.
// A read-only Claude Code run has only the built-in tools that read and only
// the run's dohc server; a read-only Codex run gets that from codexRunConfig,
// and loads none of the person's saved command rules. `codex mcp list`
// takes no --ignore-rules, so it stays out of runArguments.
export function agentProfileArguments(profile: AgentLaunchProfile, runArguments: readonly string[] = [], readOnly = false): string[] {
  const own = profile.arguments ?? [];
  // A Claude Code run loads only the person's own Claude Code settings, none from the workspace.
  // In CLI rules, / anchors at the primary working directory. Bare Edit matches every path.
  // mcp__dohc allows every tool the run's dohc server offers.
  // --restricted drops the person's settings files too, and with them their
  // hooks and plugins; --disable-slash-commands drops their skills.
  const claudeTools = readOnly
    ? ["--strict-mcp-config", "--restricted", "--disable-slash-commands", "--tools", "Read,Grep,Glob", "--allowedTools", "mcp__dohc"]
    : ["--allowedTools", "Edit(/**)", "mcp__dohc", "--disallowedTools", "Edit(/.dohc/**)", "Edit(/.codex/**)"];
  return profile.tool === "claude"
    ? ["-p", ...own, "--permission-prompts", "none", "--no-session-persistence", "--setting-sources", "user", ...runArguments, ...claudeTools]
    : ["exec", ...own, "--config", "approval_policy=never", ...runArguments, ...(readOnly ? ["--ignore-rules"] : []), "--skip-git-repo-check", "--ephemeral", "-"];
}

// Double quotes group, and a backslash escapes only a double quote or
// another backslash, so a Windows path reads as typed.
export function tokenizeRunnerCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let inDoubleQuotes = false;
  let tokenStarted = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === '"') {
      inDoubleQuotes = !inDoubleQuotes;
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      const next = command[index + 1];
      if (next === '"' || next === "\\") {
        token += next;
        tokenStarted = true;
        index += 1;
        continue;
      }
    }
    if (/\s/u.test(character) && !inDoubleQuotes) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    token += character;
    tokenStarted = true;
  }
  if (inDoubleQuotes) {
    throw new Error("Runner command has an unterminated double quote.");
  }
  if (tokenStarted) tokens.push(token);
  if (tokens.length === 0 || !tokens[0]) {
    throw new Error("Configure a runner command before dispatching.");
  }
  return tokens;
}

// The text tokenizeRunnerCommand reads back as value. A backslash doubles
// only beside another backslash, before a double quote, or at the end.
function quoteRunnerToken(value: string): string {
  const escaped = value.replace(/\\+(?="|$)|\\{2,}|"/gu, (match) => match === '"' ? '\\"' : match.repeat(2));
  return value === "" || /[\s"]/u.test(value) ? `"${escaped}"` : escaped;
}

/** The command a person reads and edits. For a profile, dohc's own flags stay out of it. */
export function launchCommand(launch: AgentLaunch): string {
  return "tool" in launch
    ? [launch.executable, ...(launch.arguments ?? [])].map(quoteRunnerToken).join(" ")
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
