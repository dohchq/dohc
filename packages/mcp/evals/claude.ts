// Runs one sample: Claude Code, signed in as it already is on this machine, working in a
// temporary copy of the case's workspace with only the dohc MCP server connected.
//
// --restricted and --strict-mcp-config keep the person's own settings, instructions, plugins,
// and MCP servers out of the run, and confine the file tools to the temporary folder. The
// agent gets no shell.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EvalCase, RecordedCall, RunRecord } from "./case";

const BUILT_IN_TOOLS = "Read,Glob,Grep,Edit,Write";
const MCP_PREFIX = "mcp__dohc__";

export interface SampleUsage {
  /** What the tokens would cost at API prices. A subscription run is not billed this. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  durationMs: number;
}

export interface SampleOutcome {
  /** Absent when the sample ended as an error. */
  run?: RunRecord;
  /** Why the sample cannot be graded: a harness failure, never an agent's mistake. */
  error?: string;
  usage: SampleUsage;
  harness?: string;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  claude_code_version?: string;
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
  message?: { content?: unknown };
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

/** Reads Claude Code's stream-json output into the calls the agent made and its last text. */
export function readTranscript(lines: readonly string[]): {
  calls: RecordedCall[];
  text: string;
  finished: boolean;
  failed: string | undefined;
  usage: SampleUsage;
  /** Claude Code's version, from its first event. */
  harness: string | undefined;
} {
  const calls: (RecordedCall & { id: string })[] = [];
  let text = "";
  let finished = false;
  let failed: string | undefined;
  let harness: string | undefined;
  const usage: SampleUsage = { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 };
  for (const line of lines) {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    const blocks = Array.isArray(event.message?.content) ? (event.message.content as ContentBlock[]) : [];
    if (event.type === "system" && event.subtype === "init") {
      harness = event.claude_code_version ? `Claude Code ${event.claude_code_version}` : undefined;
    } else if (event.type === "assistant") {
      for (const block of blocks) {
        if (block.type !== "tool_use" || !block.id || !block.name) continue;
        const tool = block.name.startsWith(MCP_PREFIX) ? block.name.slice(MCP_PREFIX.length) : block.name;
        calls.push({ id: block.id, tool, args: block.input ?? {}, ok: true });
      }
    } else if (event.type === "user") {
      for (const block of blocks) {
        const call = block.type === "tool_result" ? calls.find((candidate) => candidate.id === block.tool_use_id) : undefined;
        if (call) call.ok = block.is_error !== true;
      }
    } else if (event.type === "result") {
      finished = true;
      text = event.result ?? "";
      if (event.is_error) failed = `Claude Code reported an error: ${text.slice(0, 300)}`;
      else if (event.subtype !== "success") failed = `Claude Code ended with ${event.subtype ?? "no result"}: ${text.slice(0, 300)}`;
      usage.costUsd = event.total_cost_usd ?? 0;
      usage.inputTokens = (event.usage?.input_tokens ?? 0) + (event.usage?.cache_creation_input_tokens ?? 0) + (event.usage?.cache_read_input_tokens ?? 0);
      usage.outputTokens = event.usage?.output_tokens ?? 0;
      usage.turns = event.num_turns ?? 0;
      usage.durationMs = event.duration_ms ?? 0;
    }
  }
  return { calls: calls.map(({ id: _id, ...call }) => call), text, finished, failed, usage, harness };
}

/** Rewrites a built-in tool's absolute path as the workspace path a case names, such as `notes/plan.md`. */
function workspacePaths(calls: readonly RecordedCall[], root: string): RecordedCall[] {
  const inRoot = (value: unknown): value is string =>
    typeof value === "string" && value.toLowerCase().startsWith(root.toLowerCase());
  return calls.map((call) => ({
    ...call,
    args: Object.fromEntries(Object.entries(call.args).map(([key, value]) =>
      [key, inRoot(value) ? relative(root, value).split(sep).join("/") : value])),
  }));
}

/** Makes the workspace folder and writes the case's files into it. */
export async function seedWorkspace(root: string, evalCase: EvalCase): Promise<void> {
  await mkdir(root);
  for (const [path, content] of Object.entries(evalCase.files ?? {})) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** The workspace's files as a case names them. */
export async function workspaceFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    files[relative(root, absolute).split(sep).join("/")] = await readFile(absolute, "utf8");
  }
  return files;
}

/**
 * The environment of one sample. A run started from inside another agent session would inherit
 * that session's model route, sign-in token, and effort, and the sample would not be Claude
 * Code as a person runs it. Dropping these makes Claude Code use its own sign-in and defaults.
 */
export function sampleEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(ANTHROPIC_|CLAUDE|T3CODE_)/i.test(name)));
}

/** The command line of one sample, for --dry-run and for the run itself. */
export function claudeArguments(input: { prompt: string; model: string; mcpConfigPath: string }): string[] {
  return [
    "-p", input.prompt,
    "--model", input.model,
    "--output-format", "stream-json",
    "--verbose",
    "--restricted",
    "--strict-mcp-config",
    "--mcp-config", input.mcpConfigPath,
    "--tools", BUILT_IN_TOOLS,
    "--allowedTools", `mcp__dohc,${BUILT_IN_TOOLS}`,
    "--no-session-persistence",
  ];
}

export async function runClaudeSample(input: { evalCase: EvalCase; model: string; timeoutMs: number; keepSessionRoute: boolean }): Promise<SampleOutcome> {
  const here = dirname(fileURLToPath(import.meta.url));
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const sampleDir = await mkdtemp(join(tmpdir(), "dohc-eval-"));
  const root = join(sampleDir, "workspace");
  const unansweredLog = join(sampleDir, "unanswered.log");
  const mcpConfigPath = join(sampleDir, "mcp.json");
  try {
    await seedWorkspace(root, input.evalCase);
    await writeFile(mcpConfigPath, JSON.stringify({
      mcpServers: {
        dohc: { command: process.execPath, args: ["--import", tsxLoader, join(here, "server.ts"), input.evalCase.id, root, unansweredLog] },
      },
    }));

    const child = spawn("claude", claudeArguments({ prompt: input.evalCase.prompt, model: input.model, mcpConfigPath }), {
      cwd: root,
      env: input.keepSessionRoute ? process.env : sampleEnvironment(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Windows does not end a process's children with it, and the MCP server is one.
      if (process.platform === "win32" && child.pid !== undefined) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else child.kill("SIGKILL");
    }, input.timeoutMs);
    const spawnError = await new Promise<Error | undefined>((resolve) => {
      child.once("error", resolve);
      child.once("close", () => resolve(undefined));
    });
    clearTimeout(timer);

    const transcript = readTranscript(stdout.split("\n"));
    const unanswered = await readFile(unansweredLog, "utf8").catch(() => "");
    const error = spawnError ? `could not start claude: ${spawnError.message}`
      : timedOut ? `no answer within ${input.timeoutMs / 1000} s`
      : !transcript.finished ? `Claude Code printed no result: ${stderr.trim().slice(0, 300)}`
      : transcript.failed
      ?? (unanswered ? `the case lists no answer for: ${[...new Set(unanswered.trim().split("\n"))].join(", ")}` : undefined);
    const harness = transcript.harness ? { harness: transcript.harness } : {};
    if (error) return { error, usage: transcript.usage, ...harness };
    return { ...harness, run: { calls: workspacePaths(transcript.calls, root), text: transcript.text, files: await workspaceFiles(root) }, usage: transcript.usage };
  } finally {
    await rm(sampleDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
