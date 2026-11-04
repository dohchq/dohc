import { describe, expect, it } from "vitest";
import {
  AgentLaunch,
  AgentLaunchProfile,
  agentProfileArguments,
  launchCommand,
  launchCommandHint,
  launchFrom,
  launchFromCommand,
  supportsAgentProfile,
  tokenizeRunnerCommand,
} from "./agentToolCatalog";

describe("agent launch profiles", () => {
  it("requires Claude Code 2.1.316 or later", () => {
    for (const version of [null, "2.1.315", "2.1.295", "2.1.259", "2.0.999", "1.9.999", "2.1.316-beta", "unknown"]) {
      expect(supportsAgentProfile("claude", version)).toBe(false);
    }
    for (const version of ["2.1.316", "2.1.317", "2.2.0", "3.0.0"]) {
      expect(supportsAgentProfile("claude", version)).toBe(true);
    }
    expect(supportsAgentProfile("codex", "0.155.1")).toBe(true);
    expect(supportsAgentProfile("opencode", "1.18.31")).toBe(false);
  });
  it("uses stdin, the run's own sandbox, no Git requirement, and no persistent Codex session", () => {
    const profile = { tool: "codex", executable: "C:\\Program Files\\Codex\\codex.exe" } as const;
    expect(agentProfileArguments(profile)).toEqual(["exec", "--config", "approval_policy=never", "--skip-git-repo-check", "--ephemeral", "-"]);
    expect(agentProfileArguments(profile, ["--config", "x=1"])).toEqual(["exec", "--config", "approval_policy=never", "--config", "x=1", "--skip-git-repo-check", "--ephemeral", "-"]);
    // A reply-only run loads none of the person's saved command rules.
    expect(agentProfileArguments(profile, ["--config", "x=1"], true)).toEqual(["exec", "--config", "approval_policy=never", "--config", "x=1", "--ignore-rules", "--skip-git-repo-check", "--ephemeral", "-"]);
    expect(launchCommand(profile)).toBe('"C:\\Program Files\\Codex\\codex.exe"');
    expect(AgentLaunch.parse(profile)).toEqual(profile);
  });
  it("allows workspace edits and chat replies while denying unattended prompts", () => {
    const profile = { tool: "claude", executable: "/usr/local/bin/claude" } as const;
    expect(agentProfileArguments(profile)).toEqual(["-p", "--permission-prompts", "none", "--no-session-persistence", "--setting-sources", "user", "--allowedTools", "Edit(/**)", "mcp__dohc", "--disallowedTools", "Edit(/.dohc/**)", "Edit(/.codex/**)"]);
    expect(agentProfileArguments(profile, [], true)).toEqual(["-p", "--permission-prompts", "none", "--no-session-persistence", "--setting-sources", "user", "--strict-mcp-config", "--restricted", "--disable-slash-commands", "--tools", "Read,Grep,Glob", "--allowedTools", "mcp__dohc"]);
    expect(launchCommand(profile)).toBe("/usr/local/bin/claude");
  });
  it("puts the person's own flags once, after the subcommand and before dohc's", () => {
    const run = ["--config", "mcp_servers.dohc.required=true"];
    expect(agentProfileArguments({ tool: "codex", executable: "/bin/codex", arguments: ["--model", "o3"] }, run)).toEqual(
      ["exec", "--model", "o3", "--config", "approval_policy=never", ...run, "--skip-git-repo-check", "--ephemeral", "-"],
    );
    const claude = agentProfileArguments({ tool: "claude", executable: "/bin/claude", arguments: ["--model", "opus"] }, ["--mcp-config", "/x.json"]);
    expect(claude.slice(0, 4)).toEqual(["-p", "--model", "opus", "--permission-prompts"]);
    expect(claude.filter((arg) => arg === "opus")).toHaveLength(1);
    expect(claude.indexOf("--model")).toBeLessThan(claude.indexOf("--mcp-config"));
  });
  it("starts a chosen tool over a typed command, and needs one of them", () => {
    const profile = { tool: "claude", executable: "/usr/local/bin/claude" } as const;
    expect(launchFrom(profile, "node agent.mjs")).toEqual(profile);
    expect(launchFrom(undefined, " node agent.mjs ")).toEqual({ command: "node agent.mjs" });
    expect(launchFrom(undefined, "  ")).toBeNull();
    expect(AgentLaunch.safeParse({ command: "  " }).success).toBe(false);
    expect(AgentLaunch.safeParse({ command: "node agent.mjs", tool: "claude" }).success).toBe(false);
  });
  it("rejects unsupported tools, relative executable paths and flags with line breaks", () => {
    for (const profile of [
      { tool: "cursor", executable: "/bin/agent" }, { tool: "codex", executable: "./codex" }, { tool: "claude", executable: "C:\\claude\n.exe" },
      { tool: "claude", executable: "/bin/claude", arguments: ["--model\nopus"] }, { tool: "claude", executable: "/bin/claude", arguments: ["x".repeat(4097)] },
    ]) {
      expect(AgentLaunchProfile.safeParse(profile).success).toBe(false);
    }
  });
  it("preserves the raw command and round-trips spaces, quotes and backslashes", () => {
    expect(launchCommand({ command: ' node "agent script.mjs" ' })).toBe('node "agent script.mjs"');
    const flags = ["--add-dir", "C:\\My Work\\", "a\\\"b", "", "D:\\"];
    for (const executable of ["\\\\server\\tools\\claude.exe", '/tools/a"b/claude', "C:\\Program Files\\claude.exe", "C:\\Tools\\claude.exe"]) {
      expect(tokenizeRunnerCommand(launchCommand({ tool: "claude", executable, arguments: flags }))).toEqual([executable, ...flags]);
    }
  });
  it("shows a Windows path with single backslashes", () => {
    expect(launchCommand({ tool: "claude", executable: "C:\\Users\\me\\.local\\bin\\claude.exe", arguments: ["--add-dir", "D:\\Notes\\"] }))
      .toBe("C:\\Users\\me\\.local\\bin\\claude.exe --add-dir D:\\Notes\\\\");
    expect(launchCommand({ tool: "codex", executable: "C:\\Program Files\\Codex\\codex.exe" })).toBe('"C:\\Program Files\\Codex\\codex.exe"');
  });

  it("tokenizes quoted runner arguments and rejects an unterminated command", () => {
    expect(
      tokenizeRunnerCommand('claude -p --allowedTools "Bash(dohc chat:*)" --label "two words"'),
    ).toEqual(["claude", "-p", "--allowedTools", "Bash(dohc chat:*)", "--label", "two words"]);
    expect(() => tokenizeRunnerCommand('claude -p "unterminated')).toThrow(
      "Runner command has an unterminated double quote.",
    );
  });
});

describe("a typed command", () => {
  it("keeps the profile when the shown command is saved as it is", () => {
    const profiles: AgentLaunchProfile[] = [
      { tool: "claude", executable: "C:\\Program Files\\Claude\\claude.exe" },
      { tool: "codex", executable: "\\\\server\\tools\\codex.cmd", arguments: ["--model", "o3"] },
      { tool: "claude", executable: "/usr/local/bin/claude", arguments: ["--add-dir", "/my notes/"] },
    ];
    for (const profile of profiles) {
      expect(launchFromCommand(launchCommand(profile))).toEqual(profile);
    }
  });
  it("adds the person's flags to the profile", () => {
    expect(launchFromCommand("C:\\Tools\\claude.exe --model opus")).toEqual({ tool: "claude", executable: "C:\\Tools\\claude.exe", arguments: ["--model", "opus"] });
    expect(launchFromCommand("/opt/bin/Codex --model o3")).toEqual({ tool: "codex", executable: "/opt/bin/Codex", arguments: ["--model", "o3"] });
    expect(launchFromCommand('"C:\\npm\\codex.CMD"')).toEqual({ tool: "codex", executable: "C:\\npm\\codex.CMD" });
    expect(launchFromCommand("C:\\Tools\\claude.bat -c")).toEqual({ tool: "claude", executable: "C:\\Tools\\claude.bat", arguments: ["-c"] });
  });
  it("runs any other command as typed", () => {
    for (const command of ["claude --model opus", "node agent.mjs", "/usr/bin/claude-wrapper -p", "C:\\Tools\\codex.ps1", '"C:\\Tools\\claude.exe', "C:\\claude\\agent.exe"]) {
      expect(launchFromCommand(` ${command} `)).toEqual({ command });
    }
    expect(launchFromCommand("  ")).toBeNull();
  });
  it("says what dohc adds for each kind of launch", () => {
    expect(launchCommandHint({ tool: "claude", executable: "/bin/claude" })).toBe("dohc adds its reply tool. The conversation arrives through stdin.");
    expect(launchCommandHint({ tool: "codex", executable: "/bin/codex" })).toBe("dohc adds its reply tool and sandbox. The conversation arrives through stdin.");
    expect(launchCommandHint({ command: "node agent.mjs" })).toBe("dohc runs this command as typed. The conversation arrives through stdin.");
    expect(launchCommandHint(null)).toBe("dohc runs this command as typed. The conversation arrives through stdin.");
  });
});
