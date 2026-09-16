#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Dispatch spawns the runner with the mode on argv and the prompt on stdin,
// never argv (chatRunnerProcess.ts spawnConfiguredRunner). Read stdin the way
// a real harness does, before branching on the mode, so both modes pin the
// delivery.
const mode = process.argv[2];
const threadId = process.env.DOHC_CHAT_THREAD;
const runId = process.env.DOHC_RUN_ID;

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");

if (!threadId || !runId || prompt.trim().length === 0) {
  console.error(
    "fake chat runner: expected a non-empty prompt on stdin, plus " +
      "DOHC_CHAT_THREAD and DOHC_RUN_ID in the environment. Got " +
      `${prompt.length} prompt bytes on stdin, ` +
      `DOHC_CHAT_THREAD=${threadId ?? "unset"}, ` +
      `DOHC_RUN_ID=${runId ?? "unset"}.`,
  );
  process.exit(2);
}

if (mode === "silent-fail") {
  process.exit(3);
}

if (mode !== "report" && mode !== "ask") {
  console.error(`unknown fake chat runner mode: ${mode ?? "missing"}`);
  process.exit(2);
}

// In ask mode the prompt decides: a taken choice renders as "- [x] <choice>"
// in the thread markdown, so the second run reports it; the first run asks.
const taken = mode === "ask" ? /^- \[x\] (.+)$/mu.exec(prompt)?.[1] : undefined;
const replyArgs =
  mode === "report"
    ? ["done: checked the exports"]
    : taken
      ? [`going with ${taken}`]
      : ["--needs-decision", "--option", "Friday", "--option", "Monday", "Which day do we ship?"];

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(fixtureDir, "../../../..");
const cliBin = resolve(repoRoot, "packages/cli/bin/dohc.js");
const child = spawn(
  process.execPath,
  [
    cliBin,
    "chat",
    "reply",
    threadId,
    "--as-agent",
    ...replyArgs,
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  },
);

child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
