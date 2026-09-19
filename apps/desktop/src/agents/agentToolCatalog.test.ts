import { describe, expect, it } from "vitest";
import { AgentLaunchProfile, agentProfileArguments, configuredRunnerCommand, supportsAgentProfile } from "./agentToolCatalog";
import { tokenizeRunnerCommand } from "./chatRunnerProcess";
import { RunnerSettings } from "../settings/userSettings";

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
  it("uses stdin, workspace writes, no Git requirement, and no persistent Codex session", () => {
    const profile = { tool: "codex", executable: "C:\\Program Files\\Codex\\codex.exe" } as const;
    expect(agentProfileArguments(profile)).toEqual(["exec", "--config", "approval_policy=never", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "-"]);
    expect(tokenizeRunnerCommand(configuredRunnerCommand({ command: "ignored", profile }))).toEqual([profile.executable, ...agentProfileArguments(profile)]);
    expect(RunnerSettings.parse({ command: "", profile, enabled: true, timeoutMinutes: 30 }).profile).toEqual(profile);
  });
  it("keeps Claude's configured permissions and denies unattended prompts", () => {
    expect(agentProfileArguments({ tool: "claude", executable: "/usr/local/bin/claude" })).toEqual(["-p", "--permission-prompts", "none", "--no-session-persistence"]);
  });
  it("rejects unsupported tools and relative executable paths", () => {
    for (const profile of [{ tool: "cursor", executable: "/bin/agent" }, { tool: "codex", executable: "./codex" }, { tool: "claude", executable: "C:\\claude\n.exe" }]) {
      expect(AgentLaunchProfile.safeParse(profile).success).toBe(false);
    }
  });
  it("preserves the raw command and round-trips spaces, quotes and UNC paths", () => {
    expect(configuredRunnerCommand({ command: ' node "agent script.mjs" ' })).toBe('node "agent script.mjs"');
    for (const executable of ['\\\\server\\tools\\claude.exe', '/tools/a"b/claude', 'C:\\Program Files\\claude.exe']) {
      expect(tokenizeRunnerCommand(configuredRunnerCommand({ command: "", profile: { tool: "claude", executable } }))[0]).toBe(executable);
    }
  });
});
