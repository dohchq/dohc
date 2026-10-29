import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Spawns the built desktop app for a few seconds and fails on fatal stderr
// patterns (t3code's smoke pattern). Catches broken builds that unit tests
// cannot see: missing modules, preload failures, renderer crashes.

const repoRoot = process.cwd();
const mainEntry = join(repoRoot, "apps/desktop/dist/main/main.js");
const packagedProfile = process.env.DOHC_SMOKE_USER_DATA_DIR;

if (packagedProfile && (!isAbsolute(packagedProfile) || !process.env.DOHC_SMOKE_ELECTRON)) {
  throw new Error("Packaged smoke requires an absolute isolated profile and a packaged executable.");
}
if (!packagedProfile && !existsSync(mainEntry)) {
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
  // Renderer assets CORS-blocked over file:// (grantFileProtocolExtraPrivileges
  // fuse regression): the app stays alive but every window is blank.
  /blocked by CORS policy/,
];

// --enable-logging routes renderer console/load errors to stderr so the
// renderer-side fatal patterns can actually fire.
const args = packagedProfile
  ? ["--dohc-isolated-test", `--user-data-dir=${packagedProfile}`, "--enable-logging"]
  : [mainEntry, "--enable-logging"];
if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") args.push("--no-sandbox");

const child = spawn(
  // Packaged smoke loads the release ASAR through its own executable.
  process.env.DOHC_SMOKE_ELECTRON ?? join(repoRoot, "node_modules/.bin/electron"),
  args,
  {
    env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stderr = "";
// dohc writes this line when its own shutdown ends, just before app.exit.
const QUIT_LINE = /\[desktop\] quit: shutdown (?:finished in \d+ ms|ran past its \d+ ms budget)/;
const SMOKE_DURATION_MS = 8000;
// dohc's shutdown takes at most QUIT_ASK_TIMEOUT_MS plus WILL_QUIT_BUDGET_MS
// (src/shutdownBudgets.ts) before it writes that line.
const QUIT_LINE_LIMIT_MS = 15_000;
// After the line, Chromium waits for its helper processes to exit. On a loaded
// Mac that took from seconds to over 90 s (#2159), so the smoke stops the
// process itself instead of failing.
const TEARDOWN_GRACE_MS = 10_000;
let sentTerm = false;
let quitLineTimer = null;
let teardownTimer = null;
let stoppedAfterQuit = false;
// Each stream is matched on its own, so the other stream's output cannot split the line.
const streams = { stdout: "", stderr: "" };
const findQuitLine = () => QUIT_LINE.exec(streams.stdout)?.[0] ?? QUIT_LINE.exec(streams.stderr)?.[0];

const onOutput = (stream) => (chunk) => {
  stderr += String(chunk);
  streams[stream] += String(chunk);
  if (!sentTerm || teardownTimer || !findQuitLine()) return;
  clearTimeout(quitLineTimer);
  teardownTimer = setTimeout(() => {
    stoppedAfterQuit = true;
    child.kill("SIGKILL");
  }, TEARDOWN_GRACE_MS);
};
child.stderr.on("data", onOutput("stderr"));
// Electron routes some output to stdout depending on platform; scan both.
child.stdout.on("data", onOutput("stdout"));

const termTimer = setTimeout(() => {
  sentTerm = true;
  child.kill("SIGTERM");
  quitLineTimer = setTimeout(() => child.kill("SIGKILL"), QUIT_LINE_LIMIT_MS);
}, SMOKE_DURATION_MS);

const clearTimers = () => {
  clearTimeout(termTimer);
  clearTimeout(quitLineTimer);
  clearTimeout(teardownTimer);
};

child.once("error", (error) => {
  clearTimers();
  console.error("Desktop smoke FAILED.");
  console.error(`  failed to spawn Electron: ${error.message}`);
  process.exit(1);
});

// "exit" can come before the last output arrives, so the verdict waits for
// "close". A helper that outlives the app can hold the pipes open, so that
// wait is bounded.
const OUTPUT_DRAIN_MS = 2_000;
let exited = null;
let drainTimer = null;
child.on("exit", (code, signal) => {
  clearTimers();
  exited = { code, signal };
  drainTimer = setTimeout(judge, OUTPUT_DRAIN_MS);
});
child.on("close", () => {
  if (exited) judge();
});

function judge() {
  clearTimeout(drainTimer);
  const { code, signal } = exited;
  const fatal = FATAL_PATTERNS.filter((pattern) => pattern.test(stderr));
  // Surviving until OUR SIGTERM is part of the contract: an app that quits or
  // crashes early (single-instance lock, segfault, clean process.exit) must
  // fail the smoke even with quiet stderr.
  const earlyExit = !sentTerm;
  const quitLine = findQuitLine();
  const finished = quitLine?.includes("finished") ?? false;
  const badExit = !stoppedAfterQuit && ((code !== null && code !== 0) || (signal !== null && signal !== "SIGTERM"));
  if (fatal.length > 0 || earlyExit || !finished || badExit) {
    console.error("Desktop smoke FAILED.");
    if (earlyExit) {
      console.error(`  app exited early (code=${code}, signal=${signal}) before the ${SMOKE_DURATION_MS}ms window elapsed`);
    } else if (!quitLine) {
      console.error(`  dohc did not finish its shutdown within ${QUIT_LINE_LIMIT_MS}ms of SIGTERM (code=${code}, signal=${signal})`);
    } else if (!finished) {
      console.error(`  ${quitLine}`);
    } else if (badExit) {
      console.error(`  abnormal exit (code=${code}, signal=${signal})`);
    }
    for (const pattern of fatal) console.error(`  fatal pattern: ${pattern}`);
    console.error("--- output ---");
    console.error(stderr.slice(0, 4000));
    process.exit(1);
  }
  if (stoppedAfterQuit) console.log(`${quitLine}. Electron was still exiting ${TEARDOWN_GRACE_MS}ms later, so the smoke stopped it.`);
  console.log("Desktop smoke passed: app ran with no fatal stderr output.");
  process.exit(0);
}
