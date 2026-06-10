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

// --enable-logging routes renderer console/load errors to stderr so the
// renderer-side fatal patterns can actually fire.
const args = [mainEntry, "--enable-logging"];
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
child.stdout.on("data", (chunk) => {
  // Electron routes some output to stdout depending on platform; scan both.
  stderr += String(chunk);
});

const SMOKE_DURATION_MS = 8000;
let sentTerm = false;

setTimeout(() => {
  sentTerm = true;
  child.kill("SIGTERM");
}, SMOKE_DURATION_MS);

child.on("exit", (code, signal) => {
  const fatal = FATAL_PATTERNS.filter((pattern) => pattern.test(stderr));
  // Surviving until OUR SIGTERM is part of the contract: an app that quits or
  // crashes early (single-instance lock, segfault, clean process.exit) must
  // fail the smoke even with quiet stderr.
  const earlyExit = !sentTerm;
  const badExit = (code !== null && code !== 0) || (signal !== null && signal !== "SIGTERM");
  if (fatal.length > 0 || earlyExit || badExit) {
    console.error("Desktop smoke FAILED.");
    if (earlyExit) {
      console.error(`  app exited early (code=${code}, signal=${signal}) before the ${SMOKE_DURATION_MS}ms window elapsed`);
    } else if (badExit) {
      console.error(`  abnormal exit (code=${code}, signal=${signal})`);
    }
    for (const pattern of fatal) console.error(`  fatal pattern: ${pattern}`);
    console.error("--- output ---");
    console.error(stderr.slice(0, 4000));
    process.exit(1);
  }
  console.log("Desktop smoke passed: app ran with no fatal stderr output.");
  process.exit(0);
});
