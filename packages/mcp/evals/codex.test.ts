import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendUnmanagedFileWrites,
  codexArguments,
  codexSampleEnvironment,
  readCodexTranscript,
  resolveCodexCommand,
} from "./codex";

const line = (event: unknown) => JSON.stringify(event);

describe("codex eval harness", () => {
  it("isolates every sample from user config, rules, and session persistence", () => {
    const args = codexArguments({
      prompt: "Do the task.",
      model: "gpt-6.2-sol",
      root: "/sample/workspace",
      serverCommand: "node",
      serverArgs: ["server.ts"],
      hasSkill: true,
    });
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--approve-for-me");
    expect(args).toContain("project_doc_max_bytes=131072");
    expect(args.join(" ")).not.toMatch(/dangerously-bypass/);
  });

  it("strips enclosing agent and dohc env vars and pins an isolated CODEX_HOME", () => {
    expect(
      codexSampleEnvironment(
        {
          PATH: "/bin",
          CODEX_HOME: "/home/.codex",
          T3CODE_THREAD_ID: "thread-1",
          ANTHROPIC_API_KEY: "secret",
          CLAUDECODE: "1",
          DOHC_WORKSPACE: "/real/workspace",
        },
        "/tmp/sample/codex-home",
      ),
    ).toEqual({ PATH: "/bin", CODEX_HOME: "/tmp/sample/codex-home" });
  });

  it("parses MCP calls, refusals, file changes, shell commands, answer text, and usage without fake cost", () => {
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
        item: {
          type: "command_execution",
          status: "completed",
          command: "echo hi > out.txt",
          exit_code: 0,
        },
      }),
      line({
        type: "item.completed",
        item: {
          type: "command_execution",
          status: "completed",
          command: "false",
          exit_code: 1,
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
        { tool: "Bash", args: { command: "echo hi > out.txt" }, ok: true },
        { tool: "Bash", args: { command: "false" }, ok: false },
      ],
      refusals: ["dohc_dataset: Invalid dataset metadata."],
      text: "All set.",
      finished: true,
      failed: undefined,
      usage: { inputTokens: 1200, outputTokens: 90, turns: 1, durationMs: 0 },
    });
  });

  it("records unmanaged workspace writes from shell commands while ignoring MCP-owned writes", () => {
    const calls = appendUnmanagedFileWrites(
      [{ tool: "Bash", args: { command: "write files" }, ok: true }],
      { "pricing.md": "old", "notes.md": "keep" },
      { "pricing.md": "new", "notes.md": "keep", "mcp.md": "owned", "shell.md": "bypass" },
      new Set(["mcp.md"]),
    );
    expect(calls).toEqual([
      { tool: "Bash", args: { command: "write files" }, ok: true },
      { tool: "Edit", args: { file_path: "pricing.md" }, ok: true },
      { tool: "Write", args: { file_path: "shell.md" }, ok: true },
    ]);
  });

  it("resolves Windows npm and pnpm codex.cmd shims directly to Node and honors CODEX_BIN", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dohc-codex-bin-"));
    try {
      const npmDir = join(dir, "npm");
      const targetJs = join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.js");
      await mkdir(join(npmDir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
      await writeFile(targetJs, "console.log('ok');\n");
      const npmCmd = join(npmDir, "codex.cmd");
      await writeFile(
        npmCmd,
        '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
      );

      const resolved = resolveCodexCommand(["exec"], { PATH: npmDir }, "win32", "C:\\node.exe");
      expect(resolved).toEqual({ command: "C:\\node.exe", args: [targetJs, "exec"] });

      const explicit = resolveCodexCommand(
        ["exec"],
        { CODEX_BIN: npmCmd, PATH: "" },
        "win32",
        "C:\\node.exe",
      );
      expect(explicit).toEqual({ command: "C:\\node.exe", args: [targetJs, "exec"] });

      const exeDir = join(dir, "native");
      await mkdir(exeDir, { recursive: true });
      const nativeExe = join(exeDir, "codex.exe");
      await writeFile(nativeExe, "");
      expect(
        resolveCodexCommand(["exec"], { PATH: `${exeDir};${npmDir}` }, "win32", "C:\\node.exe"),
      ).toEqual({ command: nativeExe, args: ["exec"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
