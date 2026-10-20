#!/usr/bin/env node

// Publishes the day's nightly with nobody at the Mac. launchd runs it at 04:00
// from a clean checkout of main. It waits for the verification queue, checks
// that main changed, passed verification and has its runners online, then
// dispatches Desktop Release and waits for it to publish. It adds the macOS
// files with release-desktop-macos.mjs and reports each result on the release
// tracker. docs/engineering/desktop-release.md, "Publish nightlies on a
// schedule", describes it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RELEASE_REPOSITORY, WORK_ROOT } from "./release-desktop-macos.mjs";
import { repoRootFromScript } from "./resolve-desktop-release.mjs";
import { guiDomain, launchAgentsDir, launchPath, lastNightlyPass, listRequests, plist, plistText, queueRoot, terminalStates } from "./verification/queue.mjs";

export const NIGHTLY_AGENT_LABEL = "app.dohc.release-nightly";
// The issue that tracks the alpha. The job reports there, as the release owners do.
export const TRACKER_ISSUE = 2281;
// The clean checkout of main that launchd runs the job from.
export const DRIVER_CHECKOUT = join(WORK_ROOT, "driver");
export const NIGHTLY_LOG = join(WORK_ROOT, "nightly.log");
const LOCK = join(WORK_ROOT, "nightly.lock");
const WORKFLOW = "desktop-release.yml";
// The labels of the jobs a windows-linux nightly runs (docs/engineering/desktop-release.md).
const RUNNERS = { Windows: ["self-hosted", "windows", "x64"], Linux: ["self-hosted", "linux", "x64"] };
// The Mac's nightly verification starts at 03:07 and takes about 40 minutes.
const QUEUE_WAIT_MS = 3 * 60 * 60_000;
// Preflight runs the desktop tests, then both platforms package in turn.
const RUN_WAIT_MS = 6 * 60 * 60_000;
const NOTE = "> [!NOTE]\n> Posted by the nightly release job on the Mac mini (`scripts/release-nightly.mjs`).\n\n";

const USAGE = "Usage: node scripts/release-nightly.mjs run [--dry-run] | install | uninstall";

function capture(command, args, { cwd = repoRootFromScript() } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.error?.message ?? result.stderr ?? "" };
}

function read(run, command, args) {
  const result = run(command, args);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr.trim()}`);
  return result.stdout;
}

// gh --paginate with --jq prints one JSON value per line across every page.
const jsonLines = text => text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
const utcDay = time => new Date(time).toISOString().slice(0, 10);
const short = sha => sha.slice(0, 9);

/**
 * Whether tonight's nightly should be dispatched. A skip that needs someone,
 * such as an offline runner, is reported; a quiet night is not.
 */
export function nightlyDecision({ head, verifiedHead, lastNightly, now, runners, dryRun = false }) {
  const offline = Object.entries(RUNNERS)
    .filter(([, labels]) => !runners.some(runner => runner.status === "online" && labels.every(label => runner.labels.some(name => name.toLowerCase() === label))))
    .map(([platform]) => platform);
  if (dryRun) return offline.length ? { kind: "skip", report: true, reason: `No ${offline.join(" or ")} release runner is online, so the dry run would wait in the queue.` } : { kind: "dispatch" };
  if (lastNightly?.commit === head) return { kind: "skip", report: false, reason: `main is still at ${short(head)}, which ${lastNightly.tag} published.` };
  if (lastNightly && utcDay(lastNightly.publishedAt) === utcDay(now)) return { kind: "skip", report: false, reason: `${lastNightly.tag} already published on ${utcDay(now)} (UTC), and one nightly publishes per UTC day.` };
  if (verifiedHead !== head) {
    return { kind: "skip", report: true, reason: `The Mac's nightly verification has not passed on main's head ${short(head)}${verifiedHead ? `; its last pass is ${short(verifiedHead)}` : ""}.` };
  }
  if (offline.length) return { kind: "skip", report: true, reason: `No ${offline.join(" or ")} release runner is online. Start the runners on ICE-PC.` };
  return { kind: "dispatch" };
}

/** What the decision reads from GitHub: main's head, the newest published nightly, and the release runners. */
export function readGitHub(run, repo = RELEASE_REPOSITORY) {
  const head = read(run, "gh", ["api", `repos/${repo}/git/ref/heads/main`, "--jq", ".object.sha"]).trim();
  const nightlies = jsonLines(read(run, "gh", [
    "api", "--paginate", `repos/${repo}/releases?per_page=100`,
    "--jq", '.[] | select((.draft | not) and .prerelease and (.tag_name | test("-nightly\\\\."))) | {tag: .tag_name, publishedAt: .published_at}',
  ])).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const newest = nightlies[0];
  const lastNightly = newest
    ? { ...newest, commit: read(run, "gh", ["api", `repos/${repo}/commits/refs/tags/${newest.tag}`, "--jq", ".sha"]).trim() }
    : null;
  const runners = jsonLines(read(run, "gh", ["api", "--paginate", `repos/${repo}/actions/runners`, "--jq", ".runners[] | {name, status, labels: [.labels[].name]}"]));
  return { head, lastNightly, runners };
}

const dispatchedRuns = (run, repo) => JSON.parse(read(run, "gh", [
  "run", "list", "-R", repo, "--workflow", WORKFLOW, "--event", "workflow_dispatch", "--limit", "20", "--json", "databaseId,headSha,url",
]));

/** Dispatches Desktop Release on main and returns the run it started. */
export async function dispatchNightly(run, { dryRun, repo = RELEASE_REPOSITORY, wait = delay, now = Date.now, findMs = 5 * 60_000, pollMs = 10_000 }) {
  const earlier = new Set(dispatchedRuns(run, repo).map(entry => entry.databaseId));
  read(run, "gh", ["workflow", "run", WORKFLOW, "-R", repo, "--ref", "main", "-f", "channel=nightly", "-f", "platforms=windows-linux", "-f", `dry_run=${dryRun}`]);
  for (const deadline = now() + findMs; now() < deadline; await wait(pollMs)) {
    const started = dispatchedRuns(run, repo).find(entry => !earlier.has(entry.databaseId));
    if (started) return started;
  }
  throw new Error(`GitHub accepted the dispatch, but no new ${WORKFLOW} run appeared within ${findMs / 60_000} minutes.`);
}

/** Waits until a run completes, and returns its conclusion, or null when it is still running at the limit. */
export async function waitForRun(run, id, { repo = RELEASE_REPOSITORY, wait = delay, now = Date.now, limitMs = RUN_WAIT_MS, pollMs = 5 * 60_000 }) {
  for (const deadline = now() + limitMs; ; await wait(pollMs)) {
    const state = JSON.parse(read(run, "gh", ["run", "view", String(id), "-R", repo, "--json", "status,conclusion"]));
    if (state.status === "completed") return state.conclusion;
    if (now() >= deadline) return null;
  }
}

/** The nightly a run published: the newest nightly release whose tag is on the run's commit. */
export function publishedNightly(run, commit, repo = RELEASE_REPOSITORY) {
  const releases = jsonLines(read(run, "gh", [
    "api", `repos/${repo}/releases?per_page=20`,
    "--jq", '.[] | select((.draft | not) and .prerelease and (.tag_name | test("-nightly\\\\."))) | {tag: .tag_name, publishedAt: .published_at, url: .html_url}',
  ])).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return releases.find(release => read(run, "gh", ["api", `repos/${repo}/commits/refs/tags/${release.tag}`, "--jq", ".sha"]).trim() === commit) ?? null;
}

/** Waits while the verification queue has a request queued or running. Returns whether it went idle. */
export async function waitForQueue(root, { requests = () => listRequests(root), wait = delay, now = Date.now, limitMs = QUEUE_WAIT_MS, pollMs = 2 * 60_000 } = {}) {
  for (const deadline = now() + limitMs; ; await wait(pollMs)) {
    if (requests().every(entry => terminalStates.has(entry.status.state))) return true;
    if (now() >= deadline) return false;
  }
}

/**
 * Tonight's nightly, start to finish. Returns the report, or null for a quiet
 * night. A dry run dispatches with dry_run=true, adds no macOS files, and skips
 * the rules that a dry run does not apply.
 */
export async function runNightly({ dryRun = false }, {
  run = capture, repo = RELEASE_REPOSITORY, root = queueRoot(), wait = delay, now = Date.now, log = console.log,
  queueIdle = () => waitForQueue(root, { wait, now }),
  verifiedHead = () => lastNightlyPass(listRequests(root))?.request.head ?? null,
  addMacFiles = tag => spawnSync(process.execPath, [join(repoRootFromScript(), "scripts/release-desktop-macos.mjs"), "--version", tag, "--channel", "nightly"], { cwd: repoRootFromScript(), stdio: "inherit" }).status,
} = {}) {
  if (!dryRun) {
    if (!root) return "The Mac's verification queue is not installed here, so no nightly can be verified. Nothing was dispatched.";
    if (!(await queueIdle())) return `The verification queue was still busy after ${QUEUE_WAIT_MS / 3_600_000} hours. Nothing was dispatched.`;
  }
  const github = readGitHub(run, repo);
  const decision = nightlyDecision({ ...github, verifiedHead: dryRun ? github.head : verifiedHead(), now: now(), dryRun });
  if (decision.kind === "skip") {
    log(`Skipped: ${decision.reason}`);
    return decision.report ? `Skipped tonight's ${dryRun ? "dry run" : "nightly"}. ${decision.reason}` : null;
  }
  const started = await dispatchNightly(run, { dryRun, repo, wait, now });
  log(`Dispatched ${started.url} for ${short(started.headSha)}.`);
  // main can move between the check and the dispatch. Only the verified commit ships.
  if (!dryRun && started.headSha !== github.head) {
    run("gh", ["run", "cancel", String(started.databaseId), "-R", repo]);
    return `main moved to ${short(started.headSha)} after the checks passed on ${short(github.head)}, so the job cancelled [the run](${started.url}). Nothing was published.`;
  }
  const conclusion = await waitForRun(run, started.databaseId, { repo, wait, now });
  if (conclusion === null) {
    return `[Desktop Release](${started.url}) for ${short(started.headSha)} was still running after ${RUN_WAIT_MS / 3_600_000} hours. If it publishes, add the macOS files by hand on the Mac mini.`;
  }
  if (conclusion !== "success") {
    return `[Desktop Release](${started.url}) for ${short(started.headSha)} ended with "${conclusion}". ${dryRun ? "The dry run did not pass." : "Nothing was published."}`;
  }
  if (dryRun) return `The dry run of Desktop Release passed for ${short(started.headSha)}: [run](${started.url}). It published nothing.`;
  const release = publishedNightly(run, started.headSha, repo);
  if (!release) return `[Desktop Release](${started.url}) succeeded for ${short(started.headSha)}, but no published nightly is tagged on that commit. Check the release before adding the macOS files.`;
  log(`Published ${release.tag}. Adding the macOS files.`);
  const status = addMacFiles(release.tag);
  if (status !== 0) {
    return [
      `Published [${release.tag}](${release.url}) for Windows and Linux ([run](${started.url})), but adding the macOS files failed${status === null ? "" : ` with exit code ${status}`}.`,
      "Macs on the nightly channel see no update until they are added. On the Mac mini, run:",
      "",
      `    node scripts/release-desktop-macos.mjs --version ${release.tag} --channel nightly`,
      "",
      "It finishes an upload that stopped.",
    ].join("\n");
  }
  return `Published [${release.tag}](${release.url}) from ${short(started.headSha)} for Windows, Linux and macOS ([run](${started.url})).`;
}

/** The LaunchAgent that runs the job at 04:00 in the login session, where the login keychain is open. */
export function nightlyAgentDefinition({ checkout = DRIVER_CHECKOUT, queue, logPath = NIGHTLY_LOG, path = launchPath() }) {
  // Each night starts from main's reviewed code, in a checkout nothing else changes.
  const script = 'cd "$0" && git fetch --quiet origin main && git checkout --quiet --detach origin/main && exec node scripts/release-nightly.mjs run';
  return plist(NIGHTLY_AGENT_LABEL, { PATH: path, DOHC_VERIFICATION_QUEUE_ROOT: queue }, `  <key>ProgramArguments</key><array>${["/bin/sh", "-c", script, checkout].map(plistText).join("")}</array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key>${plistText(logPath)}
  <key>StandardErrorPath</key>${plistText(logPath)}`);
}

function install({ run = capture } = {}) {
  if (process.platform !== "darwin") throw new Error("The nightly job runs on the Mac that holds the release keychain.");
  const queue = queueRoot();
  if (!queue) throw new Error("Install the verification queue first (pnpm verify:queue install). The job releases only what its nightly verification passed.");
  if (!existsSync(join(DRIVER_CHECKOUT, ".git"))) {
    const origin = read(run, "git", ["remote", "get-url", "origin"]).trim();
    mkdirSync(WORK_ROOT, { recursive: true });
    read(run, "git", ["clone", "--quiet", origin, DRIVER_CHECKOUT]);
  }
  const file = join(launchAgentsDir(), `${NIGHTLY_AGENT_LABEL}.plist`);
  mkdirSync(launchAgentsDir(), { recursive: true });
  writeFileSync(file, nightlyAgentDefinition({ queue }));
  run("launchctl", ["bootout", `${guiDomain()}/${NIGHTLY_AGENT_LABEL}`]);
  read(run, "launchctl", ["bootstrap", guiDomain(), file]);
  console.log(`Installed ${NIGHTLY_AGENT_LABEL}. It runs at 04:00 from ${DRIVER_CHECKOUT} and logs to ${NIGHTLY_LOG}.`);
}

function uninstall({ run = capture } = {}) {
  run("launchctl", ["bootout", `${guiDomain()}/${NIGHTLY_AGENT_LABEL}`]);
  rmSync(join(launchAgentsDir(), `${NIGHTLY_AGENT_LABEL}.plist`), { force: true });
  console.log(`Removed ${NIGHTLY_AGENT_LABEL}. ${DRIVER_CHECKOUT} stays; delete it if you no longer need it.`);
}

/** One run at a time: a run by hand and the scheduled one must not dispatch twice. */
function withLock(action) {
  mkdirSync(WORK_ROOT, { recursive: true });
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, "utf8"));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* The run that held it is gone. */ }
    if (alive) throw new Error(`Another nightly run (pid ${pid}) is in progress.`);
  }
  writeFileSync(LOCK, String(process.pid));
  return action().finally(() => rmSync(LOCK, { force: true }));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "install") return install();
  if (command === "uninstall") return uninstall();
  if (command !== "run" || rest.some(arg => arg !== "--dry-run")) throw new Error(USAGE);
  const dryRun = rest.includes("--dry-run");
  console.log(`\n[${new Date().toISOString()}] Nightly ${dryRun ? "dry run" : "release"} starting.`);
  const report = await withLock(() => runNightly({ dryRun }).catch(error => `The nightly job stopped: ${error instanceof Error ? error.message : String(error)}`));
  if (report === null) return;
  console.log(report);
  const posted = capture("gh", ["issue", "comment", String(TRACKER_ISSUE), "-R", RELEASE_REPOSITORY, "--body", `${NOTE}${report}`]);
  if (posted.status !== 0) console.error(`Could not post the report on #${TRACKER_ISSUE}: ${posted.stderr.trim()}`);
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
