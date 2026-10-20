#!/usr/bin/env node

// Publishes the day's nightly with nobody at the Mac. launchd runs it at 04:00
// from a clean checkout of main. It waits for the verification queue, checks
// that main changed, passed verification and has its runners online, then
// dispatches Desktop Release for that commit and waits for it to publish. It
// adds the macOS files with release-desktop-macos.mjs and reports each result
// on the release tracker. docs/engineering/desktop-release.md, "Publish
// nightlies on a schedule", describes it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RELEASE_REPOSITORY, WORK_ROOT, macFileNames } from "./release-desktop-macos.mjs";
import { repoRootFromScript } from "./resolve-desktop-release.mjs";
import { LEGACY_NIGHTLIES } from "./select-upgrade-nightly.mjs";
import { guiDomain, launchAgentsDir, launchPath, listRequests, plist, plistText, queueRoot, terminalStates } from "./verification/queue.mjs";

export const NIGHTLY_AGENT_LABEL = "app.dohc.release-nightly";
// The issue that tracks the alpha. The job reports there, as the release owners do.
export const TRACKER_ISSUE = 2281;
// The clean checkout of main that launchd runs the job from.
export const DRIVER_CHECKOUT = join(WORK_ROOT, "driver");
export const NIGHTLY_LOG = join(WORK_ROOT, "nightly.log");
export const NIGHTLY_LOCK = join(WORK_ROOT, "nightly.lock");
const WORKFLOW = "desktop-release.yml";
// The labels of the jobs a windows-linux nightly runs (docs/engineering/desktop-release.md).
const RUNNERS = { Windows: ["self-hosted", "windows", "x64"], Linux: ["self-hosted", "linux", "x64"] };
const MAC_MANIFEST = macFileNames("", "nightly").manifest;
// The Mac's nightly verification starts at 03:07 and takes about 40 minutes.
const QUEUE_WAIT_MS = 3 * 60 * 60_000;
// Runs that still wait for a runner after this are cancelled, unless Publish has started.
const RUN_WAIT_MS = 6 * 60 * 60_000;
// Publish times out in 20 minutes and a cancel takes effect in seconds, so a run is never followed longer than this past the limit.
const RUN_GRACE_MS = 60 * 60_000;
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
// A dispatch names its commit in the run's title, so the job finds its own run.
export const runTitle = commit => `Desktop Release for ${commit}`;

/** The last nightly verification that ran every gate on main and passed. Narrower runs do not count. */
export const verifiedNightly = requests => requests.findLast(({ request, status }) =>
  request.nightly && request.full && request.scope === "all" && request.gates?.rust && request.gates?.js && status.state === "passed") ?? null;

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
    "--jq", '.[] | select((.draft | not) and .prerelease and (.tag_name | test("-nightly\\\\."))) | {tag: .tag_name, publishedAt: .published_at, assets: [.assets[].name]}',
  ])).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const newest = nightlies[0];
  const lastNightly = newest
    ? { ...newest, commit: read(run, "gh", ["api", `repos/${repo}/commits/refs/tags/${newest.tag}`, "--jq", ".sha"]).trim() }
    : null;
  const runners = jsonLines(read(run, "gh", ["api", "--paginate", `repos/${repo}/actions/runners`, "--jq", ".runners[] | {name, status, labels: [.labels[].name]}"]));
  return { head, lastNightly, runners };
}

/** The job runs with Ice's token, so it runs only from a clean checkout of a commit on main, as the macOS command does. */
export function checkCheckout(run, repo = RELEASE_REPOSITORY) {
  const changed = read(run, "git", ["status", "--porcelain"]).trimEnd();
  if (changed) throw new Error(`The checkout the job runs from has changes:\n${changed}`);
  const head = read(run, "git", ["rev-parse", "HEAD"]).trim();
  const compared = run("gh", ["api", `repos/${repo}/compare/${head}...main`, "--jq", ".status"]);
  if (compared.status !== 0 || !["ahead", "identical"].includes(compared.stdout.trim())) throw new Error(`The checkout the job runs from is at ${head}, which is not on main.`);
}

const dispatchedRuns = (run, repo) => JSON.parse(read(run, "gh", [
  "run", "list", "-R", repo, "--workflow", WORKFLOW, "--event", "workflow_dispatch", "--branch", "main", "--limit", "20", "--json", "databaseId,headSha,url,displayTitle",
]));

/** Dispatches Desktop Release on main for `commit` and returns the run it started. */
export async function dispatchNightly(run, { commit, dryRun, repo = RELEASE_REPOSITORY, wait = delay, now = Date.now, findMs = 5 * 60_000, pollMs = 10_000 }) {
  const earlier = new Set(dispatchedRuns(run, repo).map(entry => entry.databaseId));
  read(run, "gh", ["workflow", "run", WORKFLOW, "-R", repo, "--ref", "main", "-f", "channel=nightly", "-f", "platforms=windows-linux", "-f", `dry_run=${dryRun}`, "-f", `commit=${commit}`]);
  for (const deadline = now() + findMs; now() < deadline; await wait(pollMs)) {
    const started = dispatchedRuns(run, repo).find(entry => !earlier.has(entry.databaseId) && entry.displayTitle === runTitle(commit));
    if (started) return started;
  }
  throw new Error(`GitHub accepted the dispatch, but no run titled "${runTitle(commit)}" appeared within ${findMs / 60_000} minutes.`);
}

const publishStarted = jobs => jobs.some(job => job.name === "Publish" && ["in_progress", "completed"].includes(job.status));

/**
 * Waits until a run completes and returns its conclusion. A run still waiting
 * at the limit is cancelled unless Publish has started, because cancelling a
 * publish could leave a release with only some of its files.
 */
export async function waitForRun(run, id, { repo = RELEASE_REPOSITORY, wait = delay, now = Date.now, limitMs = RUN_WAIT_MS, graceMs = RUN_GRACE_MS, pollMs = 5 * 60_000, failureLimit = 6 }) {
  let failures = 0;
  let cancelled = false;
  for (const deadline = now() + limitMs; ; await wait(pollMs)) {
    if (now() >= deadline + graceMs) throw new Error(`The run was still not finished ${graceMs / 60_000} minutes after the job's ${limitMs / 3_600_000}-hour limit${cancelled ? ", though the job cancelled it" : ""}.`);
    const view = run("gh", ["run", "view", String(id), "-R", repo, "--json", "status,conclusion,jobs"]);
    if (view.status !== 0) {
      failures += 1;
      if (failures >= failureLimit) throw new Error(`gh could not read the run ${failureLimit} times in a row: ${view.stderr.trim()}`);
      continue;
    }
    failures = 0;
    const state = JSON.parse(view.stdout);
    if (state.status === "completed") return { conclusion: state.conclusion, cancelled };
    if (!cancelled && now() >= deadline && !publishStarted(state.jobs ?? [])) {
      read(run, "gh", ["run", "cancel", String(id), "-R", repo]);
      cancelled = true;
    }
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

const macCommand = tag => `node scripts/release-desktop-macos.mjs --version ${tag} --channel nightly`;
const macFailure = (tag, status) => [
  `adding the macOS files to ${tag} failed${status === null ? "" : ` with exit code ${status}`}. Macs on the nightly channel see no update until they are added.`,
  "The next night tries again. To add them now, run this on the Mac mini; it finishes an upload that stopped:",
  "",
  `    ${macCommand(tag)}`,
].join("\n");

/**
 * Tonight's nightly, start to finish. Returns the report, or null for a quiet
 * night. A dry run dispatches with dry_run=true, adds no macOS files, and skips
 * the rules that a dry run does not apply.
 */
export async function runNightly({ dryRun = false }, {
  run = capture, repo = RELEASE_REPOSITORY, root = queueRoot(), wait = delay, now = Date.now, log = console.log,
  queueIdle = () => waitForQueue(root, { wait, now }),
  verifiedHead = () => verifiedNightly(listRequests(root))?.request.head ?? null,
  addMacFiles = tag => spawnSync(process.execPath, [join(repoRootFromScript(), "scripts/release-desktop-macos.mjs"), "--version", tag, "--channel", "nightly"], { cwd: repoRootFromScript(), stdio: "inherit" }).status,
} = {}) {
  checkCheckout(run, repo);
  const reports = [];
  const finish = report => [...reports, report].filter(Boolean).join("\n\n") || null;
  if (!dryRun) {
    if (!root) return "The Mac's verification queue is not installed here, so no nightly can be verified. Nothing was dispatched.";
    if (!(await queueIdle())) return `The verification queue was still busy after ${QUEUE_WAIT_MS / 3_600_000} hours. Nothing was dispatched.`;
  }
  const github = readGitHub(run, repo);
  // A nightly that published without its macOS files, after a failure or a lost run, gets them first.
  const last = github.lastNightly;
  if (!dryRun && last && !LEGACY_NIGHTLIES.includes(last.tag) && !last.assets.includes(MAC_MANIFEST)) {
    log(`${last.tag} has no macOS files. Adding them.`);
    const status = addMacFiles(last.tag);
    reports.push(status === 0 ? `Added the macOS files to ${last.tag}, which published without them.` : `For ${last.tag}, ${macFailure(last.tag, status)}`);
  }
  const decision = nightlyDecision({ ...github, verifiedHead: dryRun ? github.head : verifiedHead(), now: now(), dryRun });
  if (decision.kind === "skip") {
    log(`Skipped: ${decision.reason}`);
    return finish(decision.report ? `Skipped tonight's ${dryRun ? "dry run" : "nightly"}. ${decision.reason}` : null);
  }
  const started = await dispatchNightly(run, { commit: github.head, dryRun, repo, wait, now });
  log(`Dispatched ${started.url} for ${short(started.headSha)}.`);
  let outcome;
  try {
    outcome = await waitForRun(run, started.databaseId, { repo, wait, now });
  } catch (error) {
    return finish(`The job lost track of [Desktop Release](${started.url}) for ${short(github.head)}: ${error instanceof Error ? error.message : String(error)} If it publishes, the next night adds its macOS files.`);
  }
  if (outcome.conclusion !== "success") {
    // The workflow refuses to build when main is no longer at the requested commit.
    if (started.headSha !== github.head) {
      return finish(`main moved to ${short(started.headSha)} after the checks passed on ${short(github.head)}, so [Desktop Release](${started.url}) refused to build it. Nothing was published.`);
    }
    if (outcome.cancelled) return finish(`[Desktop Release](${started.url}) for ${short(github.head)} still had not started publishing after ${RUN_WAIT_MS / 3_600_000} hours, so the job cancelled it. Nothing was published. Check that the runners on ICE-PC are online.`);
    return finish(`[Desktop Release](${started.url}) for ${short(github.head)} ended with "${outcome.conclusion}". ${dryRun ? "The dry run did not pass." : "Nothing was published."}`);
  }
  if (dryRun) return finish(`The dry run of Desktop Release passed for ${short(github.head)}: [run](${started.url}). It published nothing.`);
  const release = publishedNightly(run, github.head, repo);
  if (!release) return finish(`[Desktop Release](${started.url}) succeeded for ${short(github.head)}, but no published nightly is tagged on that commit. Check the release before adding the macOS files.`);
  log(`Published ${release.tag}. Adding the macOS files.`);
  const status = addMacFiles(release.tag);
  if (status !== 0) return finish(`Published [${release.tag}](${release.url}) for Windows and Linux ([run](${started.url})), but ${macFailure(release.tag, status)}`);
  return finish(`Published [${release.tag}](${release.url}) from ${short(github.head)} for Windows, Linux and macOS ([run](${started.url})).`);
}

/**
 * The LaunchAgent that runs the job at 04:00 in the login session, where the
 * login keychain is open. Each night starts from main's reviewed code: the
 * launcher fetches main into a checkout nothing else uses and discards
 * anything else in it. When that fails, the previous night's code reports it.
 */
export function nightlyAgentDefinition({ checkout = DRIVER_CHECKOUT, queue, logPath = NIGHTLY_LOG, path = launchPath() }) {
  const script = [
    'cd "$0" || exit 1',
    'for attempt in 1 2 3; do git fetch --quiet origin main && break; if [ "$attempt" = 3 ]; then exec node scripts/release-nightly.mjs report "The nightly job could not fetch main into $0, so nothing ran tonight."; fi; sleep 300; done',
    'git checkout --quiet --force --detach FETCH_HEAD && git clean -ffdxq || exec node scripts/release-nightly.mjs report "The nightly job could not check out main in $0, so nothing ran tonight."',
    "exec node scripts/release-nightly.mjs run",
  ].join("\n");
  return plist(NIGHTLY_AGENT_LABEL, { PATH: path, DOHC_VERIFICATION_QUEUE_ROOT: queue }, `  <key>ProgramArguments</key><array>${["/bin/sh", "-c", script, checkout].map(plistText).join("")}</array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key>${plistText(logPath)}
  <key>StandardErrorPath</key>${plistText(logPath)}`);
}

const isAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};
const lockHolder = (path = NIGHTLY_LOCK) => {
  try { const pid = Number(readFileSync(path, "utf8")); return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : null; } catch { return null; }
};

/**
 * Takes the lock that keeps a run by hand and the scheduled run from both
 * dispatching. Exclusive creation makes taking it atomic; a lock whose process
 * is gone is replaced. Returns the release function.
 */
export function acquireNightlyLock(path = NIGHTLY_LOCK) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return () => { if (lockHolder(path) === process.pid) rmSync(path, { force: true }); };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = lockHolder(path);
      if (pid) throw new Error(`Another nightly run (pid ${pid}) is in progress.`);
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Could not take ${path}.`);
}

// Stopping the LaunchAgent mid-release would kill the macOS command before it locks the release keychain.
function refuseDuringRun() {
  const pid = lockHolder();
  if (pid) throw new Error(`A nightly run (pid ${pid}) is in progress. Wait for it to finish; see ${NIGHTLY_LOG}.`);
}

function install({ run = capture } = {}) {
  if (process.platform !== "darwin") throw new Error("The nightly job runs on the Mac that holds the release keychain.");
  refuseDuringRun();
  const queue = queueRoot();
  if (!queue) throw new Error("Install the verification queue first (pnpm verify:queue install). The job releases only what its nightly verification passed.");
  if (!existsSync(join(DRIVER_CHECKOUT, ".git"))) {
    const origin = read(run, "git", ["remote", "get-url", "origin"]).trim();
    if (!new RegExp(`[:/]${RELEASE_REPOSITORY}(\\.git)?$`).test(origin)) throw new Error(`Install from a checkout whose origin is ${RELEASE_REPOSITORY}, not ${origin}.`);
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
  refuseDuringRun();
  run("launchctl", ["bootout", `${guiDomain()}/${NIGHTLY_AGENT_LABEL}`]);
  rmSync(join(launchAgentsDir(), `${NIGHTLY_AGENT_LABEL}.plist`), { force: true });
  console.log(`Removed ${NIGHTLY_AGENT_LABEL}. ${DRIVER_CHECKOUT} stays; delete it if you no longer need it.`);
}

function post(report) {
  console.log(report);
  const posted = capture("gh", ["issue", "comment", String(TRACKER_ISSUE), "-R", RELEASE_REPOSITORY, "--body", `${NOTE}${report}`]);
  if (posted.status !== 0) console.error(`Could not post the report on #${TRACKER_ISSUE}: ${posted.stderr.trim()}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "install") return install();
  if (command === "uninstall") return uninstall();
  if (command === "report" && rest.length === 1) return post(rest[0]);
  if (command !== "run" || rest.some(arg => arg !== "--dry-run")) throw new Error(USAGE);
  const dryRun = rest.includes("--dry-run");
  console.log(`\n[${new Date().toISOString()}] Nightly ${dryRun ? "dry run" : "release"} starting.`);
  mkdirSync(WORK_ROOT, { recursive: true });
  const release = acquireNightlyLock();
  try {
    const report = await runNightly({ dryRun }).catch(error => `The nightly job stopped: ${error instanceof Error ? error.message : String(error)}`);
    if (report !== null) post(report);
  } finally {
    release();
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
