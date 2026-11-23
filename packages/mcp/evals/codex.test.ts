import { createHash } from "node:crypto";
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
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

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

  it("parses MCP calls, structured refusals (including kind=refused), file changes, shell commands, answer text, and usage without fake cost", () => {
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
          tool: "dohc_dataset",
          arguments: { request: { action: "invoke" } },
          status: "completed",
          error: null,
          result: {
            structured_content: {
              kind: "refused",
              code: "workshop_full",
              message: "All 8 seats are booked.",
            },
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
        { tool: "dohc_dataset", args: { request: { action: "invoke" } }, ok: false },
        { tool: "dohc_list_versions", args: {}, ok: true },
        { tool: "Edit", args: { file_path: "notes.md" }, ok: true },
        { tool: "Bash", args: { command: "echo hi > out.txt" }, ok: true },
        { tool: "Bash", args: { command: "false" }, ok: false },
      ],
      refusals: [
        "dohc_dataset: Invalid dataset metadata.",
        "dohc_dataset: All 8 seats are booked.",
      ],
      text: "All set.",
      finished: true,
      failed: undefined,
      usage: { inputTokens: 1200, outputTokens: 90, turns: 1, durationMs: 0 },
    });
  });

  it("records unmanaged writes, post-MCP overwrites/reverts/deletes, and ignores untouched MCP binary writes", () => {
    const binHash = createHash("sha256")
      .update(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]))
      .digest("hex");
    const calls = appendUnmanagedFileWrites(
      [{ tool: "Bash", args: { command: "write files" }, ok: true }],
      new Map([
        ["pricing.md", sha256("old")],
        ["notes.md", sha256("keep")],
        ["reverted.md", sha256("seed")],
      ]),
      new Map([
        ["pricing.md", sha256("new")],
        ["notes.md", sha256("keep")],
        ["mcp-clean.md", sha256("owned")],
        ["mcp-bin.png", binHash],
        ["mcp-tampered.md", sha256("overwritten-by-shell")],
        ["reverted.md", sha256("seed")],
        ["shell.md", sha256("bypass")],
      ]),
      new Map([
        ["mcp-clean.md", sha256("owned")],
        ["mcp-bin.png", binHash],
        ["mcp-tampered.md", sha256("original-mcp-content")],
        ["reverted.md", sha256("mcp-edited")],
        ["mcp-deleted.md", sha256("created-then-rm")],
      ]),
    );
    expect(calls).toEqual([
      { tool: "Bash", args: { command: "write files" }, ok: true },
      { tool: "Edit", args: { file_path: "mcp-deleted.md" }, ok: true },
      { tool: "Edit", args: { file_path: "mcp-tampered.md" }, ok: true },
      { tool: "Edit", args: { file_path: "pricing.md" }, ok: true },
      { tool: "Edit", args: { file_path: "reverted.md" }, ok: true },
      { tool: "Write", args: { file_path: "shell.md" }, ok: true },
    ]);
  });

  it("resolves Windows npm/pnpm codex.cmd shims, JS CODEX_BIN entrypoints, and rejects unknown .cmd wrappers", async () => {
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

      const explicitJs = resolveCodexCommand(
        ["exec"],
        { CODEX_BIN: targetJs, PATH: "" },
        "win32",
        "C:\\node.exe",
      );
      expect(explicitJs).toEqual({ command: "C:\\node.exe", args: [targetJs, "exec"] });

      const exeDir = join(dir, "native");
      await mkdir(exeDir, { recursive: true });
      const nativeExe = join(exeDir, "codex.exe");
      await writeFile(nativeExe, "");
      expect(
        resolveCodexCommand(["exec"], { PATH: `${exeDir};${npmDir}` }, "win32", "C:\\node.exe"),
      ).toEqual({ command: nativeExe, args: ["exec"] });

      const badCmdDir = join(dir, "bad-cmd");
      await mkdir(badCmdDir, { recursive: true });
      const badCmd = join(badCmdDir, "codex.cmd");
      await writeFile(badCmd, "@echo off\r\necho unknown\r\n");
      expect(() =>
        resolveCodexCommand(["exec"], { PATH: badCmdDir }, "win32", "C:\\node.exe"),
      ).toThrow(/CODEX_BIN/);

      expect(resolveCodexCommand(["exec"], { PATH: `${exeDir}:${npmDir}` }, "linux")).toEqual({
        command: "codex",
        args: ["exec"],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
