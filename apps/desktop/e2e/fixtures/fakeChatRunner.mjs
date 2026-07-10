#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
const prompt = process.argv.at(-1);
const threadId = process.env.DOHC_CHAT_THREAD;
const runId = process.env.DOHC_RUN_ID;

if (!threadId || !runId || !prompt || prompt === mode || prompt.trim().length === 0) {
  console.error("fake chat runner requires thread, run, and non-empty prompt context");
  process.exit(2);
}

if (mode === "silent-fail") {
  process.exit(3);
}

if (mode !== "report") {
  console.error(`unknown fake chat runner mode: ${mode ?? "missing"}`);
  process.exit(2);
}

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
    "done: checked the exports",
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
