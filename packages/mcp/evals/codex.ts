// Runs one eval sample with Codex CLI (`codex exec`) in a temporary workspace with only the
// dohc MCP server configured and a fresh CODEX_HOME holding only auth.json (plus AGENTS.md
// when --skill is passed).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EvalCase, RecordedCall, RunRecord } from "./case";
import {
  sampleEnvironment,
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
    exit_code?: number | null;
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

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function mcpCallSucceeded(item: NonNullable<CodexEvent["item"]>): boolean {
  if (item.status !== "completed" || item.error != null) return false;
  if (item.result?.isError === true || item.result?.is_error === true) return false;
  const structured = item.result?.structured_content ?? item.result?.structuredContent;
  if (
    structured?.ok === false ||
    structured?.kind === "partial" ||
    structured?.kind === "refused"
  ) {
    return false;
  }
  return true;
}

function mcpCallFailureText(item: NonNullable<CodexEvent["item"]>): string | undefined {
  if (item.error?.message) return item.error.message;
  const structured = item.result?.structured_content ?? item.result?.structuredContent;
  if (typeof structured?.reason === "string") return structured.reason;
  if (structured?.kind === "refused" && typeof structured?.message === "string") {
    return structured.message;
  }
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
      } else if (item.type === "command_execution") {
        const ok =
          item.status !== "failed" &&
          (item.exit_code === undefined || item.exit_code === null || item.exit_code === 0);
        calls.push({
          tool: "Bash",
          args: { command: item.command ?? "" },
          ok,
        });
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

/**
 * Records any workspace file added, modified, or deleted outside dohc MCP tools (including shell
 * overwrites after an earlier MCP write) so unmanaged writes cannot bypass `notCalls` checks.
 */
export function appendUnmanagedFileWrites(
  calls: readonly RecordedCall[],
  initialFiles: Readonly<Record<string, string>>,
  finalFiles: Readonly<Record<string, string>>,
  mcpWrittenHashes: ReadonlyMap<string, string>,
): RecordedCall[] {
  const out = [...calls];
  const recordedPaths = new Set(
    calls
      .filter((c) => c.tool === "Write" || c.tool === "Edit")
      .map((c) => (typeof c.args.file_path === "string" ? c.args.file_path : ""))
      .filter(Boolean),
  );
  const allPaths = new Set([...Object.keys(initialFiles), ...Object.keys(finalFiles)]);
  for (const relPath of [...allPaths].sort()) {
    const initial = initialFiles[relPath];
    const final = finalFiles[relPath];
    if (initial === final) continue;
    if (final !== undefined && mcpWrittenHashes.get(relPath) === sha256(final)) continue;
    if (recordedPaths.has(relPath) && !mcpWrittenHashes.has(relPath)) continue;
    const tool =
      Object.hasOwn(initialFiles, relPath) || mcpWrittenHashes.has(relPath) ? "Edit" : "Write";
    out.push({ tool, args: { file_path: relPath }, ok: true });
  }
  return out;
}

export function codexSampleEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  codexHome?: string,
): Record<string, string | undefined> {
  const cleaned = Object.fromEntries(
    Object.entries(sampleEnvironment(env)).filter(([name]) => !/^DOHC_/i.test(name)),
  );
  if (codexHome) cleaned.CODEX_HOME = codexHome;
  return cleaned;
}

function unwrapWindowsCmdShim(
  cmdPath: string,
  args: readonly string[],
  nodeExecutable: string,
): { command: string; args: string[] } {
  const script = readFileSync(cmdPath, "utf8");
  const match = /["']?%~?dp0%?[\\/]+([^"'\r\n]+?\.(?:c|m)?js)["']?/i.exec(script);
  if (match?.[1]) {
    const target = resolve(dirname(cmdPath), match[1]);
    if (existsSync(target)) {
      return { command: nodeExecutable, args: [target, ...args] };
    }
  }
  throw new Error(
    `Cannot locate a Node entrypoint inside ${cmdPath}; set CODEX_BIN to codex.exe or its .js entrypoint.`,
  );
}

/**
 * Resolves the Codex CLI command cleanly on Windows and POSIX, supporting native `codex.exe`,
 * npm/pnpm `codex.cmd` shims (without `EINVAL`), and `CODEX_BIN`.
 */
export function resolveCodexCommand(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  nodeExecutable: string = process.execPath,
): { command: string; args: string[] } {
  const explicit = env.CODEX_BIN?.trim();
  if (explicit) {
    if (platform === "win32" && /\.(?:cmd|bat)$/i.test(extname(explicit))) {
      return unwrapWindowsCmdShim(explicit, args, nodeExecutable);
    }
    return { command: explicit, args: [...args] };
  }
  if (platform !== "win32") {
    return { command: "codex", args: [...args] };
  }
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const dir of pathValue.split(";").filter(Boolean)) {
    for (const candidate of ["codex.exe", "codex.cmd", "codex.CMD", "codex.bat"]) {
      const full = join(dir, candidate);
      if (!existsSync(full)) continue;
      if (/\.(?:cmd|bat)$/i.test(candidate)) {
        return unwrapWindowsCmdShim(full, args, nodeExecutable);
      }
      return { command: full, args: [...args] };
    }
  }
  return { command: "codex", args: [...args] };
}

/** The command line of one Codex sample, for --dry-run and for the run itself. */
export function codexArguments(input: {
  prompt: string;
  model: string;
  root: string;
  serverCommand: string;
  serverArgs: readonly string[];
  hasSkill?: boolean;
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
    ...(input.hasSkill ? ["-c", "project_doc_max_bytes=131072"] : []),
    input.prompt,
  ];
}

async function prepareIsolatedCodexHome(
  codexHome: string,
  env: Readonly<Record<string, string | undefined>>,
  skillPrompt?: string,
): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  const sourceHome = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const authPath = join(sourceHome, "auth.json");
  await copyFile(authPath, join(codexHome, "auth.json")).catch((error) => {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  });
  if (skillPrompt) {
    await writeFile(join(codexHome, "AGENTS.md"), skillPrompt, "utf8");
  }
}

function parseMcpWritesLog(raw: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as { path?: unknown; sha256?: unknown };
      if (typeof entry.path === "string" && typeof entry.sha256 === "string") {
        hashes.set(entry.path, entry.sha256);
      }
    } catch {
      /* ignore partial line */
    }
  }
  return hashes;
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
  const codexHome = join(sampleDir, "codex-home");
  const unansweredLog = join(sampleDir, "unanswered.log");
  const writesLog = join(sampleDir, "mcp-writes.log");
  const startedAt = Date.now();
  try {
    await seedWorkspace(root, input.evalCase, home);
    const initialFiles = await workspaceFiles(root);
    await prepareIsolatedCodexHome(codexHome, process.env, input.skillPrompt);
    const serverArgs = [
      "--import",
      tsxLoader,
      join(here, "server.ts"),
      input.evalCase.id,
      root,
      unansweredLog,
      home,
      writesLog,
    ];
    const codexArgs = codexArguments({
      prompt: input.evalCase.prompt,
      model: input.model,
      root,
      serverCommand: process.execPath,
      serverArgs,
      hasSkill: Boolean(input.skillPrompt),
    });
    const env = input.keepSessionRoute
      ? { ...process.env, CODEX_HOME: codexHome }
      : codexSampleEnvironment(process.env, codexHome);
    const launch = resolveCodexCommand(codexArgs, env);
    const child = spawn(launch.command, launch.args, {
      cwd: root,
      env,
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
    const spawnError = await new Promise<Error | undefined>((resolveExit) => {
      child.once("error", resolveExit);
      child.once("close", () => resolveExit(undefined));
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
    const mcpWritesRaw = await readFile(writesLog, "utf8").catch(() => "");
    const mcpWrittenHashes = parseMcpWritesLog(mcpWritesRaw);
    const finalFiles = await workspaceFiles(root);
    const calls = appendUnmanagedFileWrites(
      workspacePaths(transcript.calls, root),
      initialFiles,
      finalFiles,
      mcpWrittenHashes,
    );
    const run: RunRecord = {
      calls,
      text: transcript.text,
      files: finalFiles,
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
