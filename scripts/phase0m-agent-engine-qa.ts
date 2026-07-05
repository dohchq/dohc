#!/usr/bin/env -S pnpm exec tsx
// PR 0M arc-gate agent QA (lane 0M-7): proves the arc's agent promise against
// the REAL engine path. A real local agent CLI edits a normal file in a
// disposable FLAGGED workspace (experimental.workspaceEngineAlpha on) while
// the production watcher->engine capture pipeline is live — the exact
// desktop main-process wiring: createWorkspaceActivity with the same
// captureFor gate main.ts uses (readWorkspaceSettingsFile ->
// createWorkspaceEngineCapture). The agent is told nothing about history or
// version control; it just edits a normal file.
//
// Asserted afterwards (read-only, from OUTSIDE the store):
//   1. the edit landed as an ENGINE moment in .dohc/engine/engine.db with the
//      exact on-disk text (node:sqlite, readOnly);
//   2. NO legacy .dohc/history change set was written (sole recorder,
//      PR 0M-5);
//   3. .env never entered the engine store (shared secret classifier).
//
// Usage (mirrors scripts/phase0-agent-cli-smoke.mjs):
//   DOHC_TEST_AGENT_CLI=codex pnpm exec tsx scripts/phase0m-agent-engine-qa.ts
// Env: DOHC_TEST_AGENT_CLI (codex|claude, default codex), DOHC_CODEX_CLI,
//   DOHC_CODEX_SANDBOX (default workspace-write), DOHC_CLAUDE_CLI,
//   DOHC_CLAUDE_MODEL, DOHC_TEST_AGENT_TIMEOUT_MS (default 180000),
//   DOHC_KEEP_AGENT_SMOKE_WORKSPACE=1 to keep the temp workspace,
//   DOHC_TEST_AGENT_TMPDIR (keep it on /tmp under WSL — DrvFs mounts do not
//   surface inotify to the watcher).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CreatedWorkspace } from "../apps/desktop/src/workspaces/createWorkspaceFolder";
import { createWorkspaceActivity } from "../apps/desktop/src/workspaces/workspaceActivity";
import { createWorkspaceEngineCapture } from "../apps/desktop/src/workspaces/workspaceEngineCapture";
import { readWorkspaceSettingsFile } from "../apps/desktop/src/workspaces/workspaceSettingsFile";
import { createChangeSetStore } from "../apps/desktop/src/workspaces/workspaceWatcher";
import { defaultWorkspaceMode } from "../packages/workspace-core/src/workspaceMode";

const cli = process.env.DOHC_TEST_AGENT_CLI || "codex";
const keep = process.env.DOHC_KEEP_AGENT_SMOKE_WORKSPACE === "1";
const timeoutMs = Number(process.env.DOHC_TEST_AGENT_TIMEOUT_MS || 180_000);
const EXPECTED_TRIMMED_TEXT = "after agent via normal files";
// The watcher settles at 500ms; the capture chain then records in the
// background. 30s is generous for a tmpfs workspace.
const CAPTURE_WAIT_MS = 30_000;

// --- agent CLI harness (the scripts/phase0-agent-cli-smoke.mjs pattern; kept
// --- in sync by hand so the Phase 0 smoke script stays byte-stable) --------

function redactTempPath(value: string): string {
  return value.includes("dohc-agent-engine-qa") ? "<temp>" : value;
}

function redactSecrets(value: string): string {
  return value.replace(/ALPHA_SECRET=[^\n]*/g, "ALPHA_SECRET=<redacted>");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface AgentCommand {
  bin: string;
  cwd: string;
  args: string[];
  stdin?: string;
}

function commandFor(cliName: string, workspaceRoot: string, prompt: string): AgentCommand {
  if (cliName === "codex") {
    const bin = process.env.DOHC_CODEX_CLI || "codex";
    const sandbox = process.env.DOHC_CODEX_SANDBOX || "workspace-write";
    return {
      bin,
      cwd: workspaceRoot,
      args: [
        "exec",
        "--cd",
        workspaceRoot,
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        sandbox,
        prompt,
      ],
    };
  }
  if (cliName === "claude") {
    const bin = process.env.DOHC_CLAUDE_CLI || "claude";
    const modelArgs = process.env.DOHC_CLAUDE_MODEL
      ? ["--model", process.env.DOHC_CLAUDE_MODEL]
      : [];
    return {
      bin,
      cwd: workspaceRoot,
      args: [
        "--print",
        "--permission-mode",
        "bypassPermissions",
        ...modelArgs,
        "--add-dir",
        workspaceRoot,
      ],
      stdin: prompt,
    };
  }
  throw new Error(`Unsupported DOHC_TEST_AGENT_CLI=${cliName}. Expected codex or claude.`);
}

interface AgentResult {
  command: string;
  cwd?: string;
  args: string[];
  durationMs: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  spawnError?: string;
  timedOut: boolean;
}

function runAgent(command: AgentCommand): Promise<AgentResult> {
  return new Promise((resolve) => {
    const startedAtMs = Date.now();
    const child = spawn(command.bin, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: command.cwd,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const settle = (result: { exitCode: number | null; spawnError?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: command.bin,
        cwd: redactTempPath(command.cwd),
        args: command.args.map(redactTempPath),
        durationMs: Date.now() - startedAtMs,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
        timedOut,
        ...result,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    if (command.stdin) {
      child.stdin.write(command.stdin);
    }
    child.stdin.end();
    child.on("error", (error) => {
      settle({ exitCode: null, spawnError: error.message });
    });
    child.on("close", (code) => {
      settle({ exitCode: code });
    });
  });
}

// --- engine.db read-only assertions ----------------------------------------

interface EngineMomentRow {
  path: string;
  operation: string;
  origin: string;
  text: string | null;
}

function readEngineMoments(rootPath: string): EngineMomentRow[] {
  const db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), {
    readOnly: true,
  });
  try {
    return db
      .prepare(
        `SELECT m.path AS path, m.operation AS operation,
                m.metadata_origin AS origin, b.text AS text
         FROM moments m
         LEFT JOIN blobs b ON b.sha256 = m.payload_after_blob_sha256
         ORDER BY m.moment_order`,
      )
      .all() as unknown as EngineMomentRow[];
  } finally {
    db.close();
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  totalMs: number,
  stepMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

// --- the QA run -------------------------------------------------------------

const tempRoot = process.env.DOHC_TEST_AGENT_TMPDIR || "/tmp";
const workspaceRoot = await mkdtemp(join(tempRoot || tmpdir(), "dohc-agent-engine-qa-"));
const targetRelativePath = "notes/agent-task.txt";
const targetPath = join(workspaceRoot, targetRelativePath);
const transcriptPath = join(workspaceRoot, "agent-transcript.json");

const workspace: CreatedWorkspace = {
  workspaceId: "phase0m-agent-engine-qa",
  rootPath: workspaceRoot,
  kind: "personal",
  mode: defaultWorkspaceMode("personal"),
};

// The exact main.ts captureFor gate: flag read from the workspace settings
// file at open; no flag, no engine capture.
const activity = createWorkspaceActivity(() => {}, {
  captureFor: async (w, hooks) => {
    const { settings } = await readWorkspaceSettingsFile(w.rootPath);
    if (!settings.experimental.workspaceEngineAlpha) return null;
    return createWorkspaceEngineCapture({
      workspaceId: w.workspaceId,
      rootPath: w.rootPath,
      onCaptureOutcome: hooks.onCaptureOutcome,
    });
  },
});

let transcript: Record<string, unknown> | null = null;
let failure: unknown = null;

try {
  await mkdir(join(workspaceRoot, "notes"), { recursive: true });
  await writeFile(targetPath, "before agent\n", "utf8");
  await writeFile(join(workspaceRoot, ".env"), "ALPHA_SECRET=throwaway\n", "utf8");
  // FLAG the workspace: engine alpha on (the e2e seedWorkspaceSettings shape).
  await mkdir(join(workspaceRoot, ".dohc"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".dohc", "settings.local.json"),
    `${JSON.stringify(
      {
        version: 1,
        agents: { mcpAutoStart: false, defaultDriverId: null, defaultModel: null },
        sites: { defaultPreviewMode: "auto" },
        privacy: { confirmExternalLinks: true },
        experimental: { workspaceEngineAlpha: true },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await activity.open(workspace);
  const capture = activity.engineCaptureFor(workspace.workspaceId);
  if (!capture) {
    throw new Error(
      "Flagged workspace did not get an engine capture — the captureFor gate is broken.",
    );
  }

  const prompt = [
    "You are testing dohc's local-agent file promise in a disposable folder.",
    "Do not mention or read .env.",
    "Edit only notes/agent-task.txt.",
    "Replace its entire contents with exactly:",
    EXPECTED_TRIMMED_TEXT,
    "",
  ].join("\n");
  const agent = await runAgent(commandFor(cli, workspaceRoot, prompt));

  const result = await readFile(targetPath, "utf8");
  const postcondition = {
    expectedTrimmedText: EXPECTED_TRIMMED_TEXT,
    matched: result.trim() === EXPECTED_TRIMMED_TEXT,
    targetSizeBytes: Buffer.byteLength(result, "utf8"),
    targetSha256: sha256(result),
    targetPreview: result.slice(0, 200),
  };

  // Wait for the live watcher batch to settle and the capture chain to
  // record the agent's exact on-disk text as an engine moment.
  const captured = await waitFor(async () => {
    await capture.flush();
    return readEngineMoments(workspaceRoot).some(
      (moment) =>
        moment.path === targetRelativePath &&
        moment.operation === "write" &&
        moment.text === result,
    );
  }, CAPTURE_WAIT_MS);

  const moments = readEngineMoments(workspaceRoot);
  const envMoments = moments.filter((moment) => moment.path === ".env");
  const legacyRecords = await createChangeSetStore(workspaceRoot).list();

  const failureReasons: string[] = [];
  if (agent.spawnError) failureReasons.push(`Agent CLI failed to spawn: ${agent.spawnError}`);
  if (agent.timedOut) failureReasons.push(`Agent CLI timed out after ${timeoutMs}ms`);
  if (agent.exitCode !== 0) failureReasons.push(`Agent CLI exited with ${agent.exitCode}`);
  if (!postcondition.matched) {
    failureReasons.push(
      `Agent did not write expected file contents. Got: ${JSON.stringify(result)}`,
    );
  }
  if (!captured) {
    failureReasons.push(
      `No engine moment with the agent's exact text appeared in .dohc/engine/engine.db within ${CAPTURE_WAIT_MS}ms`,
    );
  }
  if (envMoments.length > 0) {
    failureReasons.push(".env leaked into the engine store");
  }
  if (legacyRecords.length > 0) {
    failureReasons.push(
      `Flagged workspace wrote ${legacyRecords.length} legacy .dohc/history change set(s) — the engine must be the sole recorder`,
    );
  }

  const engineEvidence = {
    engineMomentCount: moments.length,
    agentEditCaptured: captured,
    capturedMoments: moments.map((moment) => ({
      path: moment.path,
      operation: moment.operation,
      origin: moment.origin,
      textSha256: moment.text === null ? null : sha256(moment.text),
    })),
    envMomentCount: envMoments.length,
    legacyChangeSetCount: legacyRecords.length,
  };

  transcript = {
    ...agent,
    harness: {
      ok: failureReasons.length === 0,
      cli,
      flaggedWorkspace: true,
      postcondition,
      engineEvidence,
      failureReason: failureReasons.join("; ") || undefined,
    },
  };
  if (failureReasons.length > 0) {
    throw new Error(`${failureReasons.join("; ")}; transcript: ${transcriptPath}`);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        cli,
        workspaceRoot,
        targetPath,
        transcriptPath,
        keptWorkspace: keep,
        engineEvidence,
      },
      null,
      2,
    ),
  );
} catch (error) {
  failure = error;
  transcript ??= {
    command: cli,
    harness: {
      ok: false,
      cli,
      flaggedWorkspace: true,
      failureReason: error instanceof Error ? error.message : String(error),
    },
  };
} finally {
  await activity.stopAll().catch(() => undefined);
  if (transcript) {
    await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
  }
  if (!keep) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

if (failure) {
  throw failure;
}
