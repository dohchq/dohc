import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Spawns the built desktop app for a few seconds and fails on fatal stderr
// patterns (t3code's smoke pattern). Catches broken builds that unit tests
// cannot see: missing modules, preload failures, renderer crashes.

const repoRoot = process.cwd();
const mainEntry = join(repoRoot, "apps/desktop/dist/main/main.js");

if (!existsSync(mainEntry)) {
  console.error(`Desktop build missing: ${mainEntry} — run pnpm build:desktop first.`);
  process.exit(1);
}

const FATAL_PATTERNS = [
  /MODULE_NOT_FOUND/,
  /Uncaught (Error|Exception)/i,
  /Cannot find module/,
  /Unable to load preload script/,
  /Renderer process crashed/i,
  /ERR_FILE_NOT_FOUND/,
];

const args = [mainEntry];
if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") args.push("--no-sandbox");

const child = spawn(
  join(repoRoot, "node_modules/.bin/electron"),
  args,
  {
    env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});
child.stdout.on("data", () => {});

const SMOKE_DURATION_MS = 8000;

setTimeout(() => {
  child.kill("SIGTERM");
}, SMOKE_DURATION_MS);

child.on("exit", () => {
  const fatal = FATAL_PATTERNS.filter((pattern) => pattern.test(stderr));
  if (fatal.length > 0) {
    console.error("Desktop smoke FAILED. Fatal stderr patterns:");
    for (const pattern of fatal) console.error(`  ${pattern}`);
    console.error("--- stderr ---");
    console.error(stderr.slice(0, 4000));
    process.exit(1);
  }
  console.log("Desktop smoke passed: app ran with no fatal stderr output.");
  process.exit(0);
});
