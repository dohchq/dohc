import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { claudeArguments, readTranscript, sampleEnvironment, workspacePaths } from "./claude";

const line = (event: unknown) => JSON.stringify(event);

describe("eval samples", () => {
  // Claude Code keeps a sample inside its workspace, and away from the person's own MCP
  // servers, only while it gets these flags. A sample that loses one runs a real agent on
  // the developer's machine without that limit.
  it("starts every sample restricted to its workspace, with only dohc's MCP server and no shell", () => {
    const args = claudeArguments({ prompt: "Do the task.", model: "claude-haiku-5-5", mcpConfigPath: "/sample/mcp.json" });
    expect(args).toContain("--restricted");
    expect(args).toContain("--strict-mcp-config");
    expect(args.slice(args.indexOf("--mcp-config"), args.indexOf("--mcp-config") + 2)).toEqual(["--mcp-config", "/sample/mcp.json"]);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Edit,Write");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__dohc,Read,Glob,Grep,Edit,Write");
    expect(args.join(" ")).not.toMatch(/bypassPermissions|dangerously/);
  });

  it("drops an enclosing agent session's route, token, and effort from a sample's environment", () => {
    expect(sampleEnvironment({
      PATH: "/bin",
      HOME: "/home/user",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      ANTHROPIC_AUTH_TOKEN: "token",
      CLAUDECODE: "1",
      CLAUDE_EFFORT: "high",
      CLAUDE_CODE_SESSION_ID: "session",
      T3CODE_THREAD_ID: "thread",
    })).toEqual({ PATH: "/bin", HOME: "/home/user" });
  });

  it("names a built-in tool's path as the workspace does, and leaves a sibling folder's path alone", () => {
    const root = resolve("eval", "workspace");
    const sibling = resolve("eval", "workspace-other", "plan.md");
    const args = { file_path: join(root, "notes", "plan.md"), mixed: `${root}/notes/plan.md`, other: sibling, new_string: "notes/plan.md is done", limit: 5 };
    expect(workspacePaths([{ tool: "Edit", args, ok: true }], root))
      .toEqual([{ tool: "Edit", args: { ...args, file_path: "notes/plan.md", mixed: "notes/plan.md" }, ok: true }]);
  });

  it("reads the calls, their outcomes, and the answer from Claude Code's output", () => {
    const transcript = readTranscript([
      "not json",
      line({ type: "system", subtype: "init", claude_code_version: "2.1.322" }),
      line({ type: "assistant", message: { content: [
        { type: "text", text: "Looking." },
        { type: "tool_use", id: "a", name: "mcp__dohc__dohc_write_file", input: { path: "notes.md", content: "x" } },
        { type: "tool_use", id: "b", name: "Read", input: { file_path: "notes.md" } },
      ] } }),
      line({ type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "a", is_error: true },
        { type: "tool_result", tool_use_id: "b" },
      ] } }),
      line({ type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 2, duration_ms: 900, total_cost_usd: 0.01,
        usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 7 } }),
    ]);
    expect(transcript).toEqual({
      calls: [
        { tool: "dohc_write_file", args: { path: "notes.md", content: "x" }, ok: false },
        { tool: "Read", args: { file_path: "notes.md" }, ok: true },
      ],
      text: "Done.",
      finished: true,
      failed: undefined,
      harness: "Claude Code 2.1.322",
      usage: { costUsd: 0.01, inputTokens: 303, outputTokens: 7, turns: 2, durationMs: 900 },
    });
  });

  it("reports a run that printed no result, or ended in an error, as not gradable", () => {
    expect(readTranscript([line({ type: "assistant", message: { content: [] } })]).finished).toBe(false);
    expect(readTranscript([line({ type: "result", subtype: "error_max_turns", is_error: false, result: "" })]).failed)
      .toBe("Claude Code ended with error_max_turns: ");
    expect(readTranscript([line({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate" })]).failed)
      .toBe("Claude Code reported an error: Failed to authenticate");
  });
});
