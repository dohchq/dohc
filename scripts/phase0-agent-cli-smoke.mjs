#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const cli = process.env.DOHC_TEST_AGENT_CLI || "codex";
const keep = process.env.DOHC_KEEP_AGENT_SMOKE_WORKSPACE === "1";
const timeoutMs = Number(process.env.DOHC_TEST_AGENT_TIMEOUT_MS || 180_000);

function commandFor(cliName, workspaceRoot, prompt) {
  if (cliName === "codex") {
    const bin = process.env.DOHC_CODEX_CLI || "codex";
    const sandbox = process.env.DOHC_CODEX_SANDBOX || "workspace-write";
    return {
      bin,
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

function runAgent(command, transcriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.bin, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Agent CLI timed out after ${timeoutMs}ms`));
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
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      await writeFile(
        transcriptPath,
        JSON.stringify(
          {
            command: command.bin,
            args: command.args.map((arg) => (arg.includes("dohc-agent-smoke") ? "<temp>" : arg)),
            exitCode: code,
            stdout: stdout.replace(/ALPHA_SECRET=[^\n]*/g, "ALPHA_SECRET=<redacted>"),
            stderr: stderr.replace(/ALPHA_SECRET=[^\n]*/g, "ALPHA_SECRET=<redacted>"),
          },
          null,
          2,
        ),
        "utf8",
      );
      if (code === 0) resolve(undefined);
      else reject(new Error(`Agent CLI exited with ${code}; transcript: ${transcriptPath}`));
    });
  });
}

const tempRoot = process.env.DOHC_TEST_AGENT_TMPDIR || "/tmp";
const workspaceRoot = await mkdtemp(join(tempRoot || tmpdir(), "dohc-agent-smoke-"));
const notesDir = join(workspaceRoot, "notes");
const targetPath = join(notesDir, "agent-task.txt");
const transcriptPath = join(workspaceRoot, "agent-transcript.json");

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
  await runAgent(commandFor(cli, workspaceRoot, prompt), transcriptPath);
  const result = await readFile(targetPath, "utf8");
  if (result.trim() !== "after agent via normal files") {
    throw new Error(`Agent did not write expected file contents. Got: ${JSON.stringify(result)}`);
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
} finally {
  if (!keep) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
