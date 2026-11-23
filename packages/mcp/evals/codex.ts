// Runs one eval sample with Codex CLI (`codex exec`) in a temporary workspace with only the
// dohc MCP server configured. `--ignore-user-config` and `--ignore-rules` keep the person's
// own MCP servers and settings out of the run; `--approve-for-me` runs inside the
// `workspace-write` sandbox without prompting.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EvalCase, RecordedCall, RunRecord } from "./case";
import {
  seedWorkspace,
  workspaceFiles,
  workspacePaths,
  type SampleOutcome,
  type SampleUsage,
} from "./claude";

interface CodexEvent {
  type?: string;
  message?: string;
  error?: { message?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  item?: {
    type?: string;
    server?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
    status?: string;
    text?: string;
    command?: string;
    error?: { message?: string } | null;
    result?: {
      isError?: boolean;
      is_error?: boolean;
      content?: Array<{ type?: string; text?: string }>;
      structured_content?: Record<string, unknown>;
      structuredContent?: Record<string, unknown>;
    } | null;
    changes?: Array<{ path?: string; kind?: string }>;
  };
}

function mcpCallSucceeded(item: NonNullable<CodexEvent["item"]>): boolean {
  if (item.status !== "completed" || item.error != null) return false;
  if (item.result?.isError === true || item.result?.is_error === true) return false;
  const structured = item.result?.structured_content ?? item.result?.structuredContent;
  if (structured?.ok === false || structured?.kind === "partial") return false;
  return true;
}

function mcpCallFailureText(item: NonNullable<CodexEvent["item"]>): string | undefined {
  if (item.error?.message) return item.error.message;
  const structured = item.result?.structured_content ?? item.result?.structuredContent;
  if (typeof structured?.reason === "string") return structured.reason;
  const firstText = item.result?.content?.find((c) => typeof c.text === "string")?.text;
  return firstText ? firstText.slice(0, 400) : undefined;
}

/** Reads `codex exec --json` JSONL output into recorded calls, refusals, answer text, and usage. */
export function readCodexTranscript(lines: readonly string[]): {
  calls: RecordedCall[];
  refusals: string[];
  text: string;
  finished: boolean;
  failed: string | undefined;
  usage: SampleUsage;
} {
  const calls: RecordedCall[] = [];
  const refusals: string[] = [];
  let text = "";
  let finished = false;
  let failed: string | undefined;
  const usage: SampleUsage = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    turns: 0,
    durationMs: 0,
  };
  for (const line of lines) {
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      continue;
    }
    if (event.type === "item.completed" && event.item) {
      const item = event.item;
      if (item.type === "mcp_tool_call" && item.tool) {
        const ok = mcpCallSucceeded(item);
        calls.push({ tool: item.tool, args: item.arguments ?? {}, ok });
        if (!ok) {
          const reason = mcpCallFailureText(item);
          refusals.push(`${item.tool}: ${reason ?? "failed"}`);
        }
      } else if (item.type === "file_change") {
        for (const change of item.changes ?? []) {
          const kind = change.kind === "add" ? "Write" : "Edit";
          calls.push({
            tool: kind,
            args: change.path ? { file_path: change.path } : {},
            ok: item.status !== "failed",
          });
        }
      } else if (item.type === "agent_message" && typeof item.text === "string") {
        text = item.text;
      }
    } else if (event.type === "turn.completed") {
      finished = true;
      usage.turns += 1;
      usage.inputTokens += event.usage?.input_tokens ?? 0;
      usage.outputTokens += event.usage?.output_tokens ?? 0;
    } else if (event.type === "turn.failed") {
      finished = true;
      failed = `Codex turn failed: ${(event.error?.message ?? event.message ?? "unknown").slice(0, 300)}`;
    } else if (event.type === "error" && !finished) {
      const msg = event.message ?? event.error?.message ?? "unknown error";
      if (!/reconnecting/i.test(msg)) failed = `Codex reported an error: ${msg.slice(0, 300)}`;
    }
  }
  return { calls, refusals, text, finished, failed, usage };
}

export function codexSampleEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !/^(ANTHROPIC_|CLAUDE|T3CODE_)/i.test(name)),
  );
}

/** The command line of one Codex sample, for --dry-run and for the run itself. */
export function codexArguments(input: {
  prompt: string;
  model: string;
  root: string;
  serverCommand: string;
  serverArgs: readonly string[];
  skillPrompt?: string;
}): string[] {
  return [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "--approve-for-me",
    "-C",
    input.root,
    "-m",
    input.model,
    "-c",
    `mcp_servers.dohc.command=${JSON.stringify(input.serverCommand)}`,
    "-c",
    `mcp_servers.dohc.args=${JSON.stringify(input.serverArgs)}`,
    "-c",
    "mcp_servers.dohc.startup_timeout_sec=30",
    ...(input.skillPrompt
      ? ["-c", `developer_instructions=${JSON.stringify(input.skillPrompt)}`]
      : []),
    input.prompt,
  ];
}

export async function runCodexSample(input: {
  evalCase: EvalCase;
  model: string;
  timeoutMs: number;
  keepSessionRoute: boolean;
  skillPrompt?: string;
}): Promise<SampleOutcome & { refusals?: string[] }> {
  const here = dirname(fileURLToPath(import.meta.url));
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const sampleDir = await mkdtemp(join(tmpdir(), "dohc-eval-codex-"));
  const root = join(sampleDir, "workspace");
  const home = join(sampleDir, "home");
  const unansweredLog = join(sampleDir, "unanswered.log");
  const startedAt = Date.now();
  try {
    await seedWorkspace(root, input.evalCase, home);
    const serverArgs = [
      "--import",
      tsxLoader,
      join(here, "server.ts"),
      input.evalCase.id,
      root,
      unansweredLog,
      home,
    ];
    // Write skill to a temp file outside workspace if very large? Wait: developer_instructions via
    // -c works directly up to Windows cmdline limits (~32 KB); our skill is ~4-8 KB, well within.
    const args = codexArguments({
      prompt: input.evalCase.prompt,
      model: input.model,
      root,
      serverCommand: process.execPath,
      serverArgs,
      ...(input.skillPrompt ? { skillPrompt: input.skillPrompt } : {}),
    });
    const child = spawn("codex", args, {
      cwd: root,
      env: input.keepSessionRoute ? process.env : codexSampleEnvironment(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid !== undefined)
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else child.kill("SIGKILL");
    }, input.timeoutMs);
    const spawnError = await new Promise<Error | undefined>((resolve) => {
      child.once("error", resolve);
      child.once("close", () => resolve(undefined));
    });
    clearTimeout(timer);

    const transcript = readCodexTranscript(stdout.split("\n"));
    transcript.usage.durationMs = Date.now() - startedAt;
    const unanswered = await readFile(unansweredLog, "utf8").catch(() => "");
    const error = spawnError
      ? `could not start codex: ${spawnError.message}`
      : timedOut
        ? `no answer within ${input.timeoutMs / 1000} s`
        : !transcript.finished
          ? `Codex printed no turn completion: ${stderr.trim().slice(0, 300)}`
          : (transcript.failed ??
            (unanswered
              ? `the case lists no answer for: ${[...new Set(unanswered.trim().split("\n"))].join(", ")}`
              : undefined));
    if (error)
      return {
        error,
        usage: transcript.usage,
        harness: "Codex CLI",
        refusals: transcript.refusals,
      };
    const run: RunRecord = {
      calls: workspacePaths(transcript.calls, root),
      text: transcript.text,
      files: await workspaceFiles(root),
    };
    return {
      harness: "Codex CLI",
      run,
      usage: transcript.usage,
      refusals: transcript.refusals,
    };
  } finally {
    await rm(sampleDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
