#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const cli = process.env.DOHC_TEST_AGENT_CLI || "codex";
const keep = process.env.DOHC_KEEP_AGENT_SMOKE_WORKSPACE === "1";
const timeoutMs = Number(process.env.DOHC_TEST_AGENT_TIMEOUT_MS || 180_000);

function redactTempPath(value) {
  return value.includes("dohc-agent-smoke") ? "<temp>" : value;
}

function redactSecrets(value) {
  return value.replace(/ALPHA_SECRET=[^\n]*/g, "ALPHA_SECRET=<redacted>");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function commandFor(cliName, workspaceRoot, prompt) {
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

function runAgent(command) {
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
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: command.bin,
        cwd: command.cwd ? redactTempPath(command.cwd) : undefined,
        args: command.args.map(redactTempPath),
        durationMs: Date.now() - startedAtMs,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
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
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    child.on("error", (error) => {
      settle({ exitCode: null, spawnError: error.message, timedOut });
    });
    child.on("close", (code) => {
      settle({ exitCode: code, timedOut });
    });
  });
}

const tempRoot = process.env.DOHC_TEST_AGENT_TMPDIR || "/tmp";
const workspaceRoot = await mkdtemp(join(tempRoot || tmpdir(), "dohc-agent-smoke-"));
const notesDir = join(workspaceRoot, "notes");
const targetPath = join(notesDir, "agent-task.txt");
const transcriptPath = join(workspaceRoot, "agent-transcript.json");
let transcript = null;
let failure = null;

try {
  await mkdir(notesDir, { recursive: true });
  await writeFile(targetPath, "before agent\n", "utf8");
  await writeFile(join(workspaceRoot, ".env"), "ALPHA_SECRET=throwaway\n", "utf8");
  const prompt = [
    "You are testing dohc's local-agent file promise in a disposable folder.",
    "Do not mention or read .env.",
    "Edit only notes/agent-task.txt.",
    "Replace its entire contents with exactly:",
    "after agent via normal files",
    "",
  ].join("\n");
  const agent = await runAgent(commandFor(cli, workspaceRoot, prompt));
  const result = await readFile(targetPath, "utf8");
  const postcondition = {
    expectedTrimmedText: "after agent via normal files",
    matched: result.trim() === "after agent via normal files",
    targetSizeBytes: Buffer.byteLength(result, "utf8"),
    targetSha256: sha256(result),
    targetPreview: result.slice(0, 200),
  };
  const failureReasons = [];
  if (agent.spawnError) failureReasons.push(`Agent CLI failed to spawn: ${agent.spawnError}`);
  if (agent.timedOut) failureReasons.push(`Agent CLI timed out after ${timeoutMs}ms`);
  if (agent.exitCode !== 0) failureReasons.push(`Agent CLI exited with ${agent.exitCode}`);
  if (!postcondition.matched) {
    failureReasons.push(`Agent did not write expected file contents. Got: ${JSON.stringify(result)}`);
  }
  transcript = {
    ...agent,
    harness: {
      ok: failureReasons.length === 0,
      cli,
      postcondition,
      failureReason: failureReasons.join("; ") || undefined,
    },
  };
  if (!transcript.harness.ok) {
    throw new Error(`${transcript.harness.failureReason}; transcript: ${transcriptPath}`);
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
      },
      null,
      2,
    ),
  );
} catch (error) {
  failure = error;
  if (!transcript) {
    transcript = {
      command: cli,
      harness: {
        ok: false,
        cli,
        failureReason: error instanceof Error ? error.message : String(error),
      },
    };
  }
} finally {
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
