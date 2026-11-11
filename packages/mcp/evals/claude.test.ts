import { describe, expect, it } from "vitest";
import { readTranscript, sampleEnvironment } from "./claude";

const line = (event: unknown) => JSON.stringify(event);

describe("eval samples", () => {
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
