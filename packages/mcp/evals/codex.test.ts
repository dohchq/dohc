import { describe, expect, it } from "vitest";
import { codexArguments, codexSampleEnvironment, readCodexTranscript } from "./codex";

const line = (event: unknown) => JSON.stringify(event);

describe("codex eval harness", () => {
  it("isolates every sample from user config, rules, and session persistence", () => {
    const args = codexArguments({
      prompt: "Do the task.",
      model: "gpt-6.2-sol",
      root: "/sample/workspace",
      serverCommand: "node",
      serverArgs: ["server.ts"],
    });
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--approve-for-me");
    expect(args.join(" ")).not.toMatch(/dangerously-bypass/);
  });

  it("strips enclosing agent session env vars while preserving Codex auth env", () => {
    expect(
      codexSampleEnvironment({
        PATH: "/bin",
        CODEX_HOME: "/home/.codex",
        T3CODE_THREAD_ID: "thread-1",
        ANTHROPIC_API_KEY: "secret",
        CLAUDECODE: "1",
      }),
    ).toEqual({ PATH: "/bin", CODEX_HOME: "/home/.codex" });
  });

  it("parses MCP calls, structured refusals, file changes, answer text, and usage", () => {
    const transcript = readCodexTranscript([
      line({ type: "thread.started", thread_id: "t1" }),
      line({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "dohc",
          tool: "dohc_dataset",
          arguments: { request: { action: "prepare" } },
          status: "completed",
          error: null,
          result: {
            isError: true,
            structured_content: { ok: false, reason: "Invalid dataset metadata." },
          },
        },
      }),
      line({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "dohc",
          tool: "dohc_list_versions",
          arguments: {},
          status: "completed",
          error: null,
          result: { structured_content: { ok: true, versions: [] } },
        },
      }),
      line({
        type: "item.completed",
        item: {
          type: "file_change",
          status: "completed",
          changes: [{ path: "notes.md", kind: "update" }],
        },
      }),
      line({
        type: "item.completed",
        item: { type: "agent_message", text: "All set." },
      }),
      line({
        type: "turn.completed",
        usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90 },
      }),
    ]);
    expect(transcript).toEqual({
      calls: [
        { tool: "dohc_dataset", args: { request: { action: "prepare" } }, ok: false },
        { tool: "dohc_list_versions", args: {}, ok: true },
        { tool: "Edit", args: { file_path: "notes.md" }, ok: true },
      ],
      refusals: ["dohc_dataset: Invalid dataset metadata."],
      text: "All set.",
      finished: true,
      failed: undefined,
      usage: { costUsd: 0, inputTokens: 1200, outputTokens: 90, turns: 1, durationMs: 0 },
    });
  });
});
