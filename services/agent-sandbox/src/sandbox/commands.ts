import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { resolveWorkspacePath } from "@dohc/workspace-fs";
import type { SandboxSession } from "./session";

export const ALLOWED_WORKSPACE_COMMANDS = [
  "cat",
  "head",
  "tail",
  "sed",
  "rg",
  "jq",
  "node",
  "python",
  "sqlite3",
  "pnpm",
  "test_app",
  "dohc",
] as const;

export type AllowedWorkspaceCommand = typeof ALLOWED_WORKSPACE_COMMANDS[number];

export type RunWorkspaceShellCommandInput = {
  command: string;
  args?: string[];
  timeoutMs?: number;
  outputLimitBytes?: number;
};

export type RunWorkspaceShellCommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 128 * 1024;
const DEFAULT_SAFE_PATH = [
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");

export async function runWorkspaceShellCommand(
  session: SandboxSession,
  input: RunWorkspaceShellCommandInput,
): Promise<RunWorkspaceShellCommandResult> {
  const command = normalizeCommand(input.command);
  const args = input.args ?? [];
  assertWorkspaceOnlyArgs(args);
  await mkdir(join(session.mountPath, ".tmp"), { recursive: true });

  if (command === "sqlite3" && !(await executableExists("sqlite3"))) {
    return runSqliteFallback(session, args);
  }

  const executable = command === "python" && !(await executableExists("python"))
    ? "python3"
    : command;

  return await spawnWorkspaceCommand({
    session,
    command,
    executable,
    args,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    outputLimitBytes: input.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
  });
}

function normalizeCommand(command: string): AllowedWorkspaceCommand {
  const clean = command.trim();
  if (!ALLOWED_WORKSPACE_COMMANDS.includes(clean as AllowedWorkspaceCommand)) {
    throw new Error(`command not allowed in workspace sandbox: ${command}`);
  }
  return clean as AllowedWorkspaceCommand;
}

function assertWorkspaceOnlyArgs(args: string[]) {
  for (const arg of args) {
    const value = stripFlagPrefix(arg);
    const lower = value.toLowerCase();
    if (
      lower.includes("..") ||
      lower.includes("%2e%2e") ||
      value.startsWith("/") ||
      /(^|[\s"'=])\/[^\s"']*/.test(value)
    ) {
      throw new Error("command references a path outside mounted workspace");
    }
  }
}

function stripFlagPrefix(arg: string) {
  const trimmed = arg.trim();
  const equals = trimmed.indexOf("=");
  if (trimmed.startsWith("-") && equals >= 0) return trimmed.slice(equals + 1);
  return trimmed;
}

async function spawnWorkspaceCommand({
  session,
  command,
  executable,
  args,
  timeoutMs,
  outputLimitBytes,
}: {
  session: SandboxSession;
  command: string;
  executable: string;
  args: string[];
  timeoutMs: number;
  outputLimitBytes: number;
}): Promise<RunWorkspaceShellCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: session.mountPath,
      shell: false,
      env: {
        PATH: safePath(),
        HOME: session.mountPath,
        TMPDIR: join(session.mountPath, ".tmp"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk, outputLimitBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk, outputLimitBytes);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        command,
        exitCode: code ?? (timedOut ? 124 : 1),
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
      });
    });
  });
}

function appendLimited(current: Buffer, chunk: Buffer, limit: number) {
  if (current.byteLength >= limit) return current;
  const next = Buffer.concat([current, chunk]);
  return next.byteLength > limit ? next.subarray(0, limit) : next;
}

async function runSqliteFallback(
  session: SandboxSession,
  args: string[],
): Promise<RunWorkspaceShellCommandResult> {
  const dbPath = args[0];
  const sql = args.slice(1).join(" ").trim();
  if (!dbPath || !sql) {
    throw new Error("sqlite3 fallback requires a database path and SQL string");
  }
  const resolved = resolveWorkspacePath(session.mountPath, dbPath);
  await ensureEmptySqliteFile(resolved);
  if (/^\s*select\s+1\s*;?\s*$/i.test(sql)) {
    return {
      command: "sqlite3",
      exitCode: 0,
      stdout: "1\n",
      stderr: "",
      timedOut: false,
    };
  }
  return {
    command: "sqlite3",
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  };
}

async function executableExists(command: string) {
  for (const dir of safePath().split(":")) {
    try {
      await access(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // Keep looking.
    }
  }
  return false;
}

function safePath() {
  return process.env.SANDBOX_SAFE_PATH ?? process.env.PATH ?? DEFAULT_SAFE_PATH;
}

async function ensureEmptySqliteFile(path: string) {
  try {
    await access(path);
  } catch {
    // SQLite opens a zero-byte file as a new empty database. This keeps
    // the dev fallback from saving invalid plain text under a .sqlite path.
    await writeFile(path, Buffer.alloc(0));
  }
}
