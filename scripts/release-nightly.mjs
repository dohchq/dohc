#!/usr/bin/env node

// Publishes the day's nightly with nobody at the Mac. launchd runs it at 04:00
// from a clean checkout of main. It waits for the verification queue, checks
// that main changed and passed verification, then dispatches Desktop Release
// for that commit and waits for it to publish. It adds the macOS files with
// release-desktop-macos.mjs and reports each result on the release tracker.
// docs/engineering/desktop-release.md describes it under "Publish nightlies
// on a schedule".

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { nextNightlyDay, utcMinute } from "./check-desktop-release-publication.mjs";
import { RELEASE_LOCK, RELEASE_REPOSITORY, WORK_ROOT, macFileNames } from "./release-desktop-macos.mjs";
import { LOCK_BUSY, heldLockOptions, underReleaseLock } from "./release-lock.mjs";
import { repoRootFromScript } from "./resolve-desktop-release.mjs";
import { LEGACY_NIGHTLIES } from "./select-upgrade-nightly.mjs";
import { guiDomain, launchAgentsDir, launchPath, listRequests, plist, plistText, queueRoot, terminalStates, unloadLaunchAgent } from "./verification/queue.mjs";

export const NIGHTLY_AGENT_LABEL = "app.dohc.release-nightly";
// The issue that tracks the alpha. The job reports there, as the release owners do.
export const TRACKER_ISSUE = 2281;
// The clean checkout of main that launchd runs the job from.
export const DRIVER_CHECKOUT = join(WORK_ROOT, "driver");
export const NIGHTLY_LOG = join(WORK_ROOT, "nightly.log");
const WORKFLOW = "desktop-release.yml";
const MAC_MANIFEST = macFileNames("", "nightly").manifest;
// The Mac's nightly verification starts at 03:07 and takes about 40 minutes.
const QUEUE_WAIT_MS = 3 * 60 * 60_000;
// The longest the job follows a run. A run still going then is left to finish:
// cancelling one could interrupt a publish and leave a release with only some of its files.
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
const short = sha => sha.slice(0, 9);
// A dispatch names its channel, dry run and commit in the run's title, so the job finds its own run.
export const runTitle = (commit, dryRun) => `Desktop Release nightly${dryRun ? " dry run" : ""} for ${commit}`;

/** The last nightly verification that ran every gate on main and passed. Narrower runs do not count. */
export const verifiedNightly = requests => requests.findLast(({ request, status }) =>
  request.nightly && request.full && request.scope === "all" && request.gates?.rust && request.gates?.js && status.state === "passed") ?? null;

/**
 * Whether tonight's nightly should be dispatched. Every skip that leaves main
 * unpublished is reported; a quiet night, with main already published, is not.
 */
export function nightlyDecision({ head, verifiedHead, lastNightly, now, dryRun = false }) {
  if (dryRun) return { kind: "dispatch" };
  if (lastNightly?.commit === head) return { kind: "skip", report: false, reason: `main is still at ${short(head)}, which ${lastNightly.tag} published.` };
  if (lastNightly && nextNightlyDay(lastNightly.publishedAt) > now) {
    return { kind: "skip", report: true, reason: `${lastNightly.tag} published at ${utcMinute(lastNightly.publishedAt)}, and one nightly publishes per nightly day, which starts at 18:00 UTC. main's head ${short(head)} stays unpublished until the next nightly, which can publish from ${utcMinute(nextNightlyDay(lastNightly.publishedAt))}.` };
  }
  if (verifiedHead !== head) {
    return { kind: "skip", report: true, reason: `The Mac's nightly verification has not passed on main's head ${short(head)}${verifiedHead ? `; its last pass is ${short(verifiedHead)}` : ""}.` };
  }
  return { kind: "dispatch" };
}

/** What the decision reads from GitHub: main's head and the newest published nightly. */
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
  return { head, lastNightly };
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
  // gh can fail after GitHub accepted the dispatch, so the job looks for the run either way.
  const dispatched = run("gh", ["workflow", "run", WORKFLOW, "-R", repo, "--ref", "main", "-f", "channel=nightly", "-f", "platforms=windows-linux", "-f", `dry_run=${dryRun}`, "-f", `commit=${commit}`]);
  for (const deadline = now() + findMs; now() < deadline; await wait(pollMs)) {
    const started = dispatchedRuns(run, repo).find(entry => !earlier.has(entry.databaseId) && entry.displayTitle === runTitle(commit, dryRun));
    if (started) return started;
  }
  if (dispatched.status !== 0) throw new Error(`gh workflow run failed, and no run titled "${runTitle(commit, dryRun)}" appeared within ${findMs / 60_000} minutes:\n${dispatched.stderr.trim()}`);
  throw new Error(`GitHub accepted the dispatch, but no run titled "${runTitle(commit, dryRun)}" appeared within ${findMs / 60_000} minutes.`);
}

/** Waits until a run completes and returns its conclusion, or null when it is still going at the limit. */
export async function waitForRun(run, id, { repo = RELEASE_REPOSITORY, wait = delay, now = Date.now, limitMs = RUN_WAIT_MS, pollMs = 5 * 60_000, failureLimit = 6 }) {
  let failures = 0;
  for (const deadline = now() + limitMs; ; await wait(pollMs)) {
    const view = run("gh", ["run", "view", String(id), "-R", repo, "--json", "status,conclusion"]);
    if (view.status === 0) {
      failures = 0;
      const state = JSON.parse(view.stdout);
      if (state.status === "completed") return state.conclusion;
    } else if (++failures >= failureLimit) {
      throw new Error(`gh could not read the run ${failureLimit} times in a row: ${view.stderr.trim()}`);
    }
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
  // The macOS command runs under the job's hold on the release lock.
  addMacFiles = tag => spawnSync(process.execPath, [join(repoRootFromScript(), "scripts/release-desktop-macos.mjs"), "--version", tag, "--channel", "nightly"], { cwd: repoRootFromScript(), ...heldLockOptions(RELEASE_LOCK) }).status,
} = {}) {
  checkCheckout(run, repo);
  if (!dryRun) {
    if (!root) return "The Mac's verification queue is not installed here, so no nightly can be verified. Nothing was dispatched.";
    if (!(await queueIdle())) return `The verification queue was still busy after ${QUEUE_WAIT_MS / 3_600_000} hours. Nothing was dispatched.`;
  }
  const github = readGitHub(run, repo);
  const reports = [];
  // A nightly that published without its macOS files, after a failure or a lost run, gets them first.
  const last = github.lastNightly;
  if (!dryRun && last && !LEGACY_NIGHTLIES.includes(last.tag) && !last.assets.includes(MAC_MANIFEST)) {
    log(`${last.tag} has no macOS files. Adding them.`);
    const status = addMacFiles(last.tag);
    reports.push(status === 0 ? `Added the macOS files to ${last.tag}, which published without them.` : `For ${last.tag}, ${macFailure(last.tag, status)}`);
  }
  // A later step that throws still reports the repair above.
  let tonight;
  try {
    tonight = await publishTonight({ dryRun, github, run, repo, wait, now, log, verifiedHead, addMacFiles });
  } catch (error) {
    tonight = `The nightly job stopped: ${error instanceof Error ? error.message : String(error)}`;
  }
  return [...reports, tonight].filter(Boolean).join("\n\n") || null;
}

/** Decides tonight's nightly and, when it goes ahead, dispatches it and adds its macOS files. Returns the report, or null. */
async function publishTonight({ dryRun, github, run, repo, wait, now, log, verifiedHead, addMacFiles }) {
  const decision = nightlyDecision({ ...github, verifiedHead: dryRun ? github.head : verifiedHead(), now: now(), dryRun });
  if (decision.kind === "skip") {
    log(`Skipped: ${decision.reason}`);
    return decision.report ? `Skipped tonight's ${dryRun ? "dry run" : "nightly"}. ${decision.reason}` : null;
  }
  const started = await dispatchNightly(run, { commit: github.head, dryRun, repo, wait, now });
  log(`Dispatched ${started.url} for ${short(started.headSha)}.`);
  let conclusion;
  try {
    conclusion = await waitForRun(run, started.databaseId, { repo, wait, now });
  } catch (error) {
    return `The job lost track of [Desktop Release](${started.url}) for ${short(github.head)}: ${error instanceof Error ? error.message : String(error)} If it publishes, the next night adds its macOS files.`;
  }
  if (conclusion === null) {
    return `[Desktop Release](${started.url}) for ${short(github.head)} was still going after ${RUN_WAIT_MS / 3_600_000} hours. Check the run on GitHub. If it publishes, the next night adds its macOS files.`;
  }
  if (conclusion !== "success") {
    // The workflow refuses to build when main is no longer at the requested commit.
    if (started.headSha !== github.head) {
      return `main moved to ${short(started.headSha)} after the checks passed on ${short(github.head)}, so [Desktop Release](${started.url}) refused to build it. Nothing was published.`;
    }
    return `[Desktop Release](${started.url}) for ${short(github.head)} ended with "${conclusion}". ${dryRun ? "The dry run did not pass." : "Nothing was published."}`;
  }
  if (dryRun) return `The dry run of Desktop Release passed for ${short(github.head)}: [run](${started.url}). It published nothing.`;
  const release = publishedNightly(run, github.head, repo);
  if (!release) return `[Desktop Release](${started.url}) succeeded for ${short(github.head)}, but no published nightly is tagged on that commit. Check the release before adding the macOS files.`;
  log(`Published ${release.tag}. Adding the macOS files.`);
  const status = addMacFiles(release.tag);
  if (status !== 0) return `Published [${release.tag}](${release.url}) for Windows and Linux ([run](${started.url})), but ${macFailure(release.tag, status)}`;
  return `Published [${release.tag}](${release.url}) from ${short(github.head)} for Windows, Linux and macOS ([run](${started.url})).`;
}

/**
 * The LaunchAgent that runs the job at 04:00 in the login session, where the
 * login keychain is open. Each night starts from main's reviewed code: the
 * launcher fetches main from the repository install checked, whatever the
 * clone's origin says, into a checkout nothing else uses, and discards
 * anything else in it. When that fails, gh reports it, so no code from the
 * checkout runs.
 */
export function nightlyAgentDefinition({ checkout = DRIVER_CHECKOUT, source, queue, logPath = NIGHTLY_LOG, path = launchPath() }) {
  const report = message => `${NOTE}The nightly job could not ${message} in ${checkout}, so nothing ran tonight. See ${logPath}.`;
  const post = `exec gh issue comment ${TRACKER_ISSUE} -R ${RELEASE_REPOSITORY} --body`;
  const script = [
    'cd "$0" || exit 1',
    `for attempt in 1 2 3; do git fetch --quiet "$1" refs/heads/main && break; if [ "$attempt" = 3 ]; then ${post} "$2"; fi; sleep 300; done`,
    `git checkout --quiet --force --detach FETCH_HEAD && git clean -ffdxq || ${post} "$3"`,
    "exec node scripts/release-nightly.mjs run",
  ].join("\n");
  const args = ["/bin/sh", "-c", script, checkout, source, report("fetch main"), report("check out main")];
  return plist(NIGHTLY_AGENT_LABEL, { PATH: path, DOHC_VERIFICATION_QUEUE_ROOT: queue }, `  <key>ProgramArguments</key><array>${args.map(plistText).join("")}</array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key>${plistText(logPath)}
  <key>StandardErrorPath</key>${plistText(logPath)}`);
}

// install and uninstall run under the release lock, so stopping the LaunchAgent never interrupts a release.
async function install({ run = capture } = {}) {
  if (process.platform !== "darwin") throw new Error("The nightly job runs on the Mac that holds the release keychain.");
  const queue = queueRoot();
  if (!queue) throw new Error("Install the verification queue first (pnpm verify:queue install). The job releases only what its nightly verification passed.");
  // The launcher fetches main from this URL each night, so only dohchq/dohc's code runs with these credentials.
  const source = read(run, "git", ["remote", "get-url", "origin"]).trim();
  if (!new RegExp(`^(git@github\\.com:|https://github\\.com/|ssh://git@github\\.com/)${RELEASE_REPOSITORY}(\\.git)?$`).test(source)) {
    throw new Error(`Install from a checkout whose origin is ${RELEASE_REPOSITORY} on GitHub, not ${source}.`);
  }
  // A fresh clone, so nothing left in an earlier one, such as its config or hooks, comes along.
  rmSync(DRIVER_CHECKOUT, { recursive: true, force: true });
  mkdirSync(WORK_ROOT, { recursive: true });
  read(run, "git", ["clone", "--quiet", source, DRIVER_CHECKOUT]);
  const file = join(launchAgentsDir(), `${NIGHTLY_AGENT_LABEL}.plist`);
  mkdirSync(launchAgentsDir(), { recursive: true });
  writeFileSync(file, nightlyAgentDefinition({ source, queue }));
  // bootout returns before launchd lets the job go, and a bootstrap then fails.
  await unloadLaunchAgent(NIGHTLY_AGENT_LABEL);
  read(run, "launchctl", ["bootstrap", guiDomain(), file]);
  console.log(`Installed ${NIGHTLY_AGENT_LABEL}. It runs at 04:00 from ${DRIVER_CHECKOUT} and logs to ${NIGHTLY_LOG}.`);
}

async function uninstall() {
  await unloadLaunchAgent(NIGHTLY_AGENT_LABEL);
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
  const valid = ["install", "uninstall"].includes(command) ? rest.length === 0 : command === "run" && rest.every(arg => arg === "--dry-run");
  if (!valid) throw new Error(USAGE);
  // A run holds the release lock throughout, including the macOS command it starts.
  const locked = await underReleaseLock(RELEASE_LOCK);
  if (locked === LOCK_BUSY && command === "run") post("Another release command on the Mac mini was running, so the nightly job did not run tonight.");
  if (locked !== null) {
    process.exitCode = locked;
    return;
  }
  if (command === "install") return install();
  if (command === "uninstall") return uninstall();
  const dryRun = rest.includes("--dry-run");
  console.log(`\n[${new Date().toISOString()}] Nightly ${dryRun ? "dry run" : "release"} starting.`);
  const report = await runNightly({ dryRun }).catch(error => `The nightly job stopped: ${error instanceof Error ? error.message : String(error)}`);
  if (report !== null) post(report);
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
