import { describe, expect, it } from "vitest";
import { AgentLaunch, AgentLaunchProfile, agentProfileArguments, launchCommand, launchFrom, supportsAgentProfile } from "./agentToolCatalog";
import { tokenizeRunnerCommand } from "./chatRunnerProcess";

describe("agent launch profiles", () => {
  it("requires Claude's noninteractive permission flag version", () => {
    for (const version of [null, "2.1.258", "2.0.999", "1.9.999", "2.1.259-beta", "unknown"]) {
      expect(supportsAgentProfile("claude", version)).toBe(false);
    }
    for (const version of ["2.1.259", "2.1.278", "2.2.0", "3.0.0"]) {
      expect(supportsAgentProfile("claude", version)).toBe(true);
    }
    expect(supportsAgentProfile("codex", "0.155.1")).toBe(true);
    expect(supportsAgentProfile("opencode", "1.18.31")).toBe(false);
  });
  it("uses stdin, the run's own sandbox, no Git requirement, and no persistent Codex session", () => {
    const profile = { tool: "codex", executable: "C:\\Program Files\\Codex\\codex.exe" } as const;
    expect(agentProfileArguments(profile)).toEqual(["exec", "--config", "approval_policy=never", "--skip-git-repo-check", "--ephemeral", "-"]);
    expect(agentProfileArguments(profile, ["--config", "x=1"])).toEqual(["exec", "--config", "approval_policy=never", "--config", "x=1", "--skip-git-repo-check", "--ephemeral", "-"]);
    expect(tokenizeRunnerCommand(launchCommand(profile))).toEqual([profile.executable, ...agentProfileArguments(profile)]);
    expect(AgentLaunch.parse(profile)).toEqual(profile);
  });
  it("allows workspace edits and chat replies while denying unattended prompts", () => {
    const profile = { tool: "claude", executable: "/usr/local/bin/claude" } as const;
    expect(agentProfileArguments(profile)).toEqual(["-p", "--permission-prompts", "none", "--no-session-persistence", "--setting-sources", "user", "--allowedTools", "Edit(/**)", "mcp__dohc__dohc_reply_to_chat", "--disallowedTools", "Edit(/.dohc/**)", "Edit(/.codex/**)"]);
    expect(tokenizeRunnerCommand(launchCommand(profile))).toEqual([profile.executable, ...agentProfileArguments(profile)]);
  });
  it("starts a chosen tool over a typed command, and needs one of them", () => {
    const profile = { tool: "claude", executable: "/usr/local/bin/claude" } as const;
    expect(launchFrom(profile, "node agent.mjs")).toEqual(profile);
    expect(launchFrom(undefined, " node agent.mjs ")).toEqual({ command: "node agent.mjs" });
    expect(launchFrom(undefined, "  ")).toBeNull();
    expect(AgentLaunch.safeParse({ command: "  " }).success).toBe(false);
    expect(AgentLaunch.safeParse({ command: "node agent.mjs", tool: "claude" }).success).toBe(false);
  });
  it("rejects unsupported tools and relative executable paths", () => {
    for (const profile of [{ tool: "cursor", executable: "/bin/agent" }, { tool: "codex", executable: "./codex" }, { tool: "claude", executable: "C:\\claude\n.exe" }]) {
      expect(AgentLaunchProfile.safeParse(profile).success).toBe(false);
    }
  });
  it("preserves the raw command and round-trips spaces, quotes and UNC paths", () => {
    expect(launchCommand({ command: ' node "agent script.mjs" ' })).toBe('node "agent script.mjs"');
    for (const executable of ['\\\\server\\tools\\claude.exe', '/tools/a"b/claude', 'C:\\Program Files\\claude.exe']) {
      const profile = { tool: "claude", executable } as const;
      expect(tokenizeRunnerCommand(launchCommand(profile))).toEqual([executable, ...agentProfileArguments(profile)]);
    }
  });
});
