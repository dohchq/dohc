#!/usr/bin/env node

// Adds the macOS files to a desktop release that the Desktop Release workflow
// published. It builds the release commit for Apple silicon in a throwaway
// worktree, signs and notarizes with the release keychain, checks the result,
// and uploads it. It never changes the files of the checkout it runs from.
// docs/engineering/desktop-release.md describes the procedure.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay, setImmediate as yieldToSignals } from "node:timers/promises";
import { readDesktopPackageVersion, repoRootFromScript, resolveDesktopRelease, stripVersionPrefix } from "./resolve-desktop-release.mjs";
import { updateDesktopPackageVersion } from "./update-desktop-package-version.mjs";
import { sourceMapUpload } from "./upload-desktop-source-maps.mjs";
import { parseUpdateManifest, verifyDesktopReleaseArtifacts } from "./verify-desktop-release-artifacts.mjs";
import { underReleaseLock } from "./release-lock.mjs";
import { withBuildBudget } from "./verification/build.mjs";

// The repository whose releases the packaged updater reads (publish in electron-builder.yml).
export const RELEASE_REPOSITORY = "dohchq/dohc";
export const DEFAULT_KEYCHAIN = join(homedir(), "Library/Keychains/dohc-release.keychain-db");
export const DEFAULT_KEYCHAIN_PROFILE = "dohc-notary";
export const POSTHOG_KEYCHAIN_SERVICE = "dohc-posthog-cli-api-key";
// Saved in the login keychain, the release keychain's password lets the command unlock it without anyone at the Mac.
export const SAVED_PASSWORD_SERVICE = "dohc-release-keychain-password";
// Each release's throwaway checkout and built files live here, outside every checkout.
export const WORK_ROOT = join(homedir(), "dohc-release");
// One release command at a time on this Mac, including the scheduled nightly job (release-lock.mjs).
export const RELEASE_LOCK = join(WORK_ROOT, "release.lock");
// The workflow's publish job. It runs only after Preflight, which runs only on refs/heads/main.
export const PUBLISH_JOB = "Publish";
// The workflow's first job. It stamps a nightly's version with its run attempt.
export const PREFLIGHT_JOB = "Preflight";
export const UNLOCK_WAIT_MS = 30 * 60_000;
const TARGET = "aarch64-apple-darwin";
const DIST = "mac-arm64";
const IDENTITY_PREFIX = "Developer ID Application: ";
const UNLOCKED = 1; // kSecUnlockStateStatus
const USAGE = "Usage: pnpm release:macos --version <version or tag> --channel latest|nightly [--keychain <path>] [--keychain-profile <name>] [--dry-run [--rehearse]]";

// This command sets each of these itself. A value left in the shell must not
// change what signs, notarizes, or reports.
const RELEASE_VARIABLES = [
  "CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME", "CSC_KEYCHAIN", "CSC_IDENTITY_AUTO_DISCOVERY",
  "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER",
  "APPLE_KEYCHAIN", "APPLE_KEYCHAIN_PROFILE", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD",
  "DOHC_POSTHOG_KEY", "DOHC_POSTHOG_HOST", "POSTHOG_CLI_API_KEY", "POSTHOG_CLI_PROJECT_ID", "POSTHOG_CLI_HOST",
  "DOHC_REQUIRE_SIGNING", "DOHC_DESKTOP_DIST", "DESKTOP_VERSION", "DOHC_SMOKE_PACKAGE_DIRECTORY",
];

export function parseMacReleaseArgs(argv) {
  const options = { keychain: DEFAULT_KEYCHAIN, keychainProfile: DEFAULT_KEYCHAIN_PROFILE, dryRun: false, rehearse: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for ${arg}.\n${USAGE}`);
      index += 1;
      return next;
    };
    if (arg === "--") continue;
    if (arg === "--version") options.version = stripVersionPrefix(value());
    else if (arg === "--channel") options.channel = value();
    else if (arg === "--keychain") options.keychain = value();
    else if (arg === "--keychain-profile") options.keychainProfile = value();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--rehearse") options.rehearse = true;
    else throw new Error(`Unknown argument '${arg}'.\n${USAGE}`);
  }
  if (!options.version || !["latest", "nightly"].includes(options.channel)) throw new Error(USAGE);
  if (options.rehearse && !options.dryRun) throw new Error("--rehearse builds for a release that a real run refuses, so it needs --dry-run.");
  return options;
}

export function releaseEnvironment(source, additions = {}) {
  const env = { ...source };
  for (const name of RELEASE_VARIABLES) delete env[name];
  return { ...env, ...additions };
}

function capture(command, args, { cwd = repoRootFromScript(), env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.error?.message ?? result.stderr ?? "" };
}

function read(run, command, args) {
  const result = run(command, args);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr.trim()}`);
  return result.stdout;
}

// gh --paginate with --jq prints one JSON value per line across every page.
const jsonLines = text => text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));

// SecKeychainGetStatus reads the lock state without asking to unlock, which
// no security subcommand does. A negative value is an error, such as a
// missing keychain.
function readKeychainStatus(path) {
  const script = `ObjC.import("Security"); var ref = Ref(); $.SecKeychainOpen(${JSON.stringify(path)}, ref); var status = Ref(); var code = $.SecKeychainGetStatus(ref[0], status); code === 0 ? status[0] : code`;
  return Number(read(capture, "osascript", ["-l", "JavaScript", "-e", script]).trim());
}

// security reads a password from the terminal when it has one. A child in its
// own session has no terminal, so it reads the password from its input, which
// no other program can see.
function unlockWithPassword(keychain, password) {
  const result = spawnSync("security", ["unlock-keychain", keychain], { input: Buffer.concat([password, Buffer.from("\n")]), detached: true, encoding: "utf8", timeout: 60_000 });
  return { status: result.error ? null : result.status, stderr: result.error?.message ?? result.stderr ?? "" };
}

// -w prints a password with non-ASCII text or a control character as bare hex,
// which a password of hex digits also looks like. -g marks that form with 0x,
// quotes every other password, and prints nothing after the label for an
// empty one. It prints the password on stderr, so never log this output.
function savedPassword(output) {
  const line = output.split("\n").find(entry => entry.startsWith("password: "));
  const hex = line && /^password: 0x([0-9A-F]+)(?: |$)/.exec(line);
  if (hex) return Buffer.from(hex[1], "hex");
  const quoted = line && /^password: "(.*)"$/.exec(line);
  if (quoted) return Buffer.from(quoted[1]);
  return line === "password: " ? Buffer.alloc(0) : null;
}

/** Locks the release keychain, and returns why it could not, or null. */
function lockKeychain(run, keychain) {
  const result = run("security", ["lock-keychain", keychain]);
  return result.status === 0 ? null : `Could not lock the release keychain: ${result.stderr.trim()}\nLock it now with: security lock-keychain "${keychain}"`;
}

const readManifest = path => parseUpdateManifest(readFileSync(path, "utf8"), path);

export function macFileNames(version, channel) {
  const zip = `dohc-${version}-mac-arm64.zip`;
  return { zip, dmg: `dohc-${version}-mac-arm64.dmg`, blockmap: `${zip}.blockmap`, manifest: `${channel}-mac.yml` };
}

// The update manifest uploads last, so it never names a missing file.
const uploadOrder = names => [names.zip, names.dmg, names.blockmap, names.manifest];

export function macAssetNames(assets) {
  return assets.map(asset => asset.name).filter(name => name.endsWith("-mac.yml") || name.includes("-mac-") || /\.(dmg|zip)(\.blockmap)?$/.test(name));
}

const deleteCommands = ({ tag, repo }, names) => names.map(name => `  gh release delete-asset ${tag} ${name} -R ${repo} --yes`).join("\n");

/**
 * What a release's macOS files allow: a fresh upload, finishing an upload
 * that stopped before the manifest, or nothing.
 */
export function macReleaseState(plan, assets) {
  const present = macAssetNames(assets);
  if (present.length === 0) return { kind: "fresh" };
  // Macs may already update from a release with a Mac manifest, so its files stay as they are.
  const manifests = present.filter(name => name.endsWith("-mac.yml"));
  if (manifests.length) return { kind: "refuse", reason: `Release ${plan.tag} already has its macOS files, including ${manifests.join(", ")}. There is nothing to add.` };
  const binaries = uploadOrder(plan.names).slice(0, -1);
  if (present.every(name => binaries.includes(name))) return { kind: "resume", present };
  return {
    kind: "refuse",
    reason: `Release ${plan.tag} has macOS files this command cannot finish: ${present.join(", ")}. To start again, delete them, then run again:\n${deleteCommands(plan, present)}`,
  };
}

function publishedRelease(run, repo, tag, channel) {
  const result = run("gh", ["release", "view", tag, "-R", repo, "--json", "tagName,isDraft,isPrerelease,assets"]);
  if (result.status !== 0) {
    throw new Error(`${repo} has no release ${tag}: ${result.stderr.trim()}\nPublish it with the Desktop Release workflow, then run again.`);
  }
  const release = JSON.parse(result.stdout);
  if (release.isDraft) throw new Error(`Release ${tag} is still a draft. Wait for its Desktop Release run to publish it.`);
  if (release.isPrerelease !== (channel === "nightly")) {
    throw new Error(`Release ${tag} is ${release.isPrerelease ? "a prerelease" : "not a prerelease"}, so it is not on the ${channel} channel.`);
  }
  return release;
}

/** The version the workflow stamped: resolve-desktop-release.mjs for this package version and the run in the tag. */
export async function assertWorkflowVersion({ version, channel, commit }, packageVersion) {
  const nightly = /^\d+\.\d+\.\d+-nightly\.(\d{8})\.(\d+)\.(\d+)$/.exec(version);
  const resolved = await resolveDesktopRelease({
    packageVersion, channel, version, sha: commit,
    ...(nightly ? { date: nightly[1], runNumber: nightly[2], runAttempt: nightly[3] } : {}),
  });
  if (resolved.version !== version) throw new Error(`For package version ${packageVersion}, the workflow stamps ${resolved.version}, not ${version}.`);
}

/** Whether a commit is on the branch head `mainCommit`. A commit GitHub does not have is not. */
function onMain(run, repo, commit, mainCommit) {
  const result = run("gh", ["api", `repos/${repo}/compare/${commit}...${mainCommit}`, "--jq", ".status"]);
  return result.status === 0 && ["ahead", "identical"].includes(result.stdout.trim());
}

/**
 * Refuses before building unless this Mac can add the release's macOS files.
 * A rehearsal builds this checkout's commit instead, and reports, instead of
 * refusing, what makes the release one that a real run refuses.
 */
export async function preflightMacRelease(options, {
  platform = process.platform, arch = process.arch, run = capture, keychainStatus = readKeychainStatus, workRoot = WORK_ROOT,
} = {}) {
  const { version, channel, dryRun, rehearse, keychain, keychainProfile } = options;
  const tag = `v${version}`;
  const warnings = [];
  const notices = [];
  const refuse = reason => {
    if (!rehearse) throw new Error(reason);
    warnings.push(reason);
  };
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error(`macOS releases build on Apple silicon with arm64 Node. This host is ${platform}-${arch}.`);
  }
  const nightly = /^\d+\.\d+\.\d+-nightly\.\d{8}\.(\d+)\.(\d+)$/.exec(version);
  if ((channel === "nightly") !== Boolean(nightly)) throw new Error(`${tag} is not a ${channel} version.`);
  const repo = RELEASE_REPOSITORY;
  const plan = {
    tag, version, channel, repo, dryRun, rehearse, keychain, keychainProfile, warnings, notices, reporting: {}, signs: false,
    names: macFileNames(version, channel),
    workDir: join(workRoot, dryRun ? `${tag}-dry-run` : tag),
    savedFiles: join(workRoot, tag, "files"),
    workRoot,
  };

  const release = publishedRelease(run, repo, tag, channel);
  plan.state = macReleaseState(plan, release.assets);
  if (plan.state.kind === "resume" && !uploadOrder(plan.names).every(name => existsSync(join(plan.savedFiles, name)))) {
    plan.state = {
      kind: "refuse",
      reason: `Release ${tag} has part of an upload (${plan.state.present.join(", ")}), but ${plan.savedFiles} does not hold the files that run built. To start again, delete them, then run again:\n${deleteCommands(plan, plan.state.present)}`,
    };
  }
  if (plan.state.kind === "refuse") refuse(plan.state.reason);
  if (rehearse && plan.state.kind !== "fresh") {
    if (plan.state.kind === "resume") warnings.push(`Release ${tag} has part of an upload. A real run finishes it from ${plan.savedFiles}.`);
    plan.state = { kind: "fresh" };
  }

  // A tag can move, and a tag can be named main. The main branch's own
  // commit, and a successful Publish job of a dispatched run, cannot be
  // faked that way: the workflow runs Publish only after Preflight passes on
  // refs/heads/main.
  plan.commit = read(run, "gh", ["api", `repos/${repo}/commits/refs/tags/${tag}`, "--jq", ".sha"]).trim();
  const mainCommit = read(run, "gh", ["api", `repos/${repo}/git/ref/heads/main`, "--jq", ".object.sha"]).trim();
  const runs = jsonLines(read(run, "gh", [
    "api", "--paginate", `repos/${repo}/actions/workflows/desktop-release.yml/runs?head_sha=${plan.commit}&event=workflow_dispatch&per_page=100`,
    "--jq", ".workflow_runs[] | {id, run_number, event}",
  ])).filter(candidate => candidate.event === "workflow_dispatch" && (!nightly || candidate.run_number === Number(nightly[1])));
  const published = runs.some(candidate => {
    const jobs = jsonLines(read(run, "gh", [
      "api", "--paginate", `repos/${repo}/actions/runs/${candidate.id}/jobs?filter=all&per_page=100`,
      "--jq", ".jobs[] | {name, conclusion, run_attempt, head_sha, started_at}",
    ]));
    // Re-running failed jobs starts an attempt that reuses the earlier
    // attempt's Preflight, start time included, and so publishes the version
    // that attempt stamped.
    const preflightStart = attempt => jobs.find(job => job.name === PREFLIGHT_JOB && job.run_attempt === attempt)?.started_at;
    const attempt = nightly ? Number(nightly[2]) : 0;
    const stamped = preflightStart(attempt);
    // The tag's attempt must have run that Preflight, not kept it from an earlier one.
    const ranPreflight = Boolean(stamped) && !jobs.some(job => job.name === PREFLIGHT_JOB && job.run_attempt < attempt && job.started_at === stamped);
    return jobs.some(job => job.name === PUBLISH_JOB && job.conclusion === "success" && job.head_sha === plan.commit
      && (!nightly || (ranPreflight && preflightStart(job.run_attempt) === stamped)));
  });
  if (!published) {
    refuse(`Tag ${tag} points to ${plan.commit}, but no dispatched Desktop Release run${nightly ? ` ${nightly[1]}, attempt ${nightly[2]},` : ""} published that commit from main.`);
  }
  if (!onMain(run, repo, plan.commit, mainCommit)) refuse(`${plan.commit}, the commit of ${tag}, is not on main at ${mainCommit}.`);

  // A real release runs only reviewed code: this command and the files it
  // loads are tracked files of a clean checkout on main, plus Node's own modules.
  const head = read(run, "git", ["rev-parse", "HEAD"]).trim();
  const changed = read(run, "git", ["status", "--porcelain"]).trimEnd();
  const headOnMain = onMain(run, repo, head, mainCommit);
  if (dryRun) {
    notices.push(`A dry run runs from any checkout. This one is at ${head}${headOnMain ? ", on main" : ", not on main"}${changed ? ", with uncommitted changes" : ""}.`);
  } else {
    if (changed) throw new Error(`The checkout that runs this command has uncommitted changes:\n${changed}\nA real release runs from a clean checkout on main.`);
    if (!headOnMain) throw new Error(`The checkout that runs this command is at ${head}, which is not on main. A real release runs from a clean checkout on main.`);
    if (read(run, "gh", ["api", `repos/${repo}`, "--jq", ".permissions.push"]).trim() !== "true") throw new Error(`Your GitHub account cannot upload to ${repo}'s releases.`);
  }
  plan.buildCommit = rehearse ? head : plan.commit;
  if (dryRun || plan.state.kind === "resume") return plan;

  // A new build signs and notarizes with the release keychain, which is
  // locked here. Only what a locked keychain shows is checked now.
  if (keychainStatus(keychain) < 0) throw new Error(`The release keychain ${keychain} does not exist. Create it as docs/engineering/desktop-release.md describes, or use --dry-run.`);
  const certificates = (read(run, "security", ["find-certificate", "-a", "-c", "Developer ID Application", "-Z", keychain]).match(/^SHA-1 hash:/gm) ?? []).length;
  if (certificates !== 1) throw new Error(`The release keychain holds ${certificates} Developer ID Application certificates. Keep exactly one, as docs/engineering/desktop-release.md describes.`);
  if (run("security", ["find-generic-password", "-a", `com.apple.gke.notary.tool.saved-creds.${keychainProfile}`, keychain]).status !== 0) {
    throw new Error(`The release keychain has no notarytool profile ${keychainProfile}. Store it as docs/engineering/desktop-release.md describes, or pass --keychain-profile.`);
  }
  // A release reports to the PostHog project the repository variables name,
  // and uploads its source maps as the workflow does.
  const variables = new Map(JSON.parse(read(run, "gh", ["variable", "list", "-R", repo, "--json", "name,value"])).map(({ name, value }) => [name, value]));
  const reporting = Object.fromEntries(["DOHC_POSTHOG_KEY", "DOHC_POSTHOG_HOST", "POSTHOG_CLI_PROJECT_ID", "POSTHOG_CLI_HOST"].map(name => [name, variables.get(name) ?? ""]));
  const reports = Boolean(reporting.DOHC_POSTHOG_KEY.trim());
  if (reports && run("security", ["find-generic-password", "-s", POSTHOG_KEYCHAIN_SERVICE, keychain]).status !== 0) {
    throw new Error(`Releases report to PostHog, so the source map upload needs the item ${POSTHOG_KEYCHAIN_SERVICE} in the release keychain. Store it as docs/engineering/desktop-release.md describes.`);
  }
  // The key itself is read once the keychain unlocks. This checks every other setting the upload needs.
  sourceMapUpload({ ...reporting, POSTHOG_CLI_API_KEY: reports ? "in the release keychain" : "", DESKTOP_VERSION: version, DOHC_DESKTOP_DIST: DIST });
  return { ...plan, signs: true, reporting };
}

/**
 * Unlocks the release keychain with the password saved in the login keychain.
 * Without a saved password, security asks for it in a terminal; otherwise, the
 * command waits for someone to unlock the keychain. Before packaging, a
 * keychain that is already unlocked was open while the build ran other code,
 * so it is locked and unlocked again the same way.
 */
export async function unlockReleaseKeychain(plan, purpose, {
  keychainStatus, step, run, interactive, cancelled, unlockWith = unlockWithPassword, wait = delay, now = Date.now, pollMs = 5000,
}, { relock = false } = {}) {
  const unlocked = () => (keychainStatus(plan.keychain) & UNLOCKED) !== 0;
  if (unlocked()) {
    if (!relock) return;
    console.warn("\nThe release keychain was unlocked before packaging, so the install and builds ran with it open. Locking it, then unlocking it again.");
    const failure = lockKeychain(run, plan.keychain);
    if (failure) throw new Error(failure);
  }
  // add-generic-password saves to the default keychain, so the search covers the keychain list, which excludes the release keychain.
  const saved = run("security", ["find-generic-password", "-s", SAVED_PASSWORD_SERVICE, "-g"]);
  if (saved.status === 0) {
    console.log(`\n${purpose} unlocks the release keychain with the password saved in the login keychain.`);
    const password = savedPassword(`${saved.stdout}\n${saved.stderr}`);
    const result = password ? unlockWith(plan.keychain, password) : { status: null, stderr: "security printed no password." };
    if (result.status !== 0 || !unlocked()) {
      throw new Error(`The password saved as ${SAVED_PASSWORD_SERVICE} in the login keychain did not unlock the release keychain: ${result.stderr.trim()}\nSave the right one, or delete it, as docs/engineering/desktop-release.md describes. Nothing was signed or uploaded.`);
    }
    return;
  }
  if (interactive) {
    console.log(`\n${purpose} needs the release keychain.`);
    await step("security", ["unlock-keychain", plan.keychain], process.env);
  } else {
    console.log(`\n${purpose} needs the release keychain. Unlock it in a terminal:\n  security unlock-keychain "${plan.keychain}"`);
    const deadline = now() + UNLOCK_WAIT_MS;
    while (!unlocked()) {
      if (cancelled()) throw new Error("Stopped while waiting for the release keychain.");
      if (now() >= deadline) throw new Error("The release keychain stayed locked for 30 minutes. Nothing was signed or uploaded. Run the command again.");
      await wait(pollMs);
    }
  }
  if (!unlocked()) throw new Error("The release keychain is still locked. Nothing was signed or uploaded.");
}

/**
 * Runs `action`, then locks the release keychain. A lock that fails is
 * reported. It fails the action that otherwise succeeded, and leaves an
 * earlier error the one thrown.
 */
async function thenLock(run, keychain, action) {
  let failed = false;
  try {
    return await action();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const failure = lockKeychain(run, keychain);
    if (failure && failed) console.error(failure);
    else if (failure) throw new Error(failure);
  }
}

/** What signing needs from the unlocked release keychain: one valid identity, a profile that signs in, and the PostHog key. */
export function unlockedSigning(plan, run) {
  const identities = [...new Set([...read(run, "security", ["find-identity", "-v", "-p", "codesigning", plan.keychain])
    .matchAll(/^\s*\d+\)\s+[0-9A-F]{40}\s+"(Developer ID Application: [^"]+)"$/gm)].map(match => match[1]))];
  if (identities.length !== 1) throw new Error(`The release keychain has ${identities.length} valid Developer ID Application identities. Keep exactly one valid identity, then run again.`);
  if (run("xcrun", ["notarytool", "history", "--keychain-profile", plan.keychainProfile, "--keychain", plan.keychain, "--output-format", "json"]).status !== 0) {
    throw new Error(`The notarytool profile ${plan.keychainProfile} cannot sign in. Store it again as docs/engineering/desktop-release.md describes.`);
  }
  const reporting = { ...plan.reporting };
  if (reporting.DOHC_POSTHOG_KEY.trim()) reporting.POSTHOG_CLI_API_KEY = read(run, "security", ["find-generic-password", "-s", POSTHOG_KEYCHAIN_SERVICE, "-w", plan.keychain]).trim();
  return { ...plan, identity: identities[0], reporting };
}

export function electronBuilderArgs({ channel, signs }) {
  // Stapling the DMG after packaging changes its bytes. The Mac updater reads
  // only the ZIP, so the update manifest lists only the ZIP.
  const args = ["--filter", "@dohc/desktop", "exec", "electron-builder", "--mac", "--arm64", "--publish", "never", `-c.publish.channel=${channel}`, "-c.dmg.writeUpdateInfo=false"];
  return [...args, ...(signs ? ["-c.forceCodeSigning=true", "-c.dmg.sign=true"] : ["-c.mac.identity=null"])];
}

/** electron-builder signs from the release keychain and notarizes with its profile, or signs nothing. */
export function signingEnvironment({ signs, identity, keychain, keychainProfile }) {
  if (!signs) return { CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  return { CSC_KEYCHAIN: keychain, CSC_NAME: identity.slice(IDENTITY_PREFIX.length), APPLE_KEYCHAIN: keychain, APPLE_KEYCHAIN_PROFILE: keychainProfile };
}

/** The signature checks for a bundle. An unsigned build has no Developer ID signature or ticket to check. */
export function signatureChecks({ app, dmg, signs }) {
  const checks = [["codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]]];
  if (!signs) return checks;
  return [...checks, ["spctl", ["--assess", "--type", "execute", "--verbose=4", app]], ["xcrun", ["stapler", "validate", app]], ["xcrun", ["stapler", "validate", dmg]]];
}

async function digest(path, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
}

export async function macUploadPlan(directory, names) {
  return Promise.all(uploadOrder(names).map(async name => {
    const path = join(directory, name);
    return { name, path, size: (await stat(path)).size, sha256: await digest(path, "sha256", "hex") };
  }));
}

const matchesAsset = (file, asset) => asset?.state === "uploaded" && asset.size === file.size && asset.digest === `sha256:${file.sha256}`;

/** Checks the files a stopped run kept, as that run checked them before uploading. */
export async function verifyKeptFiles(plan, step) {
  await verifyDesktopReleaseArtifacts({ directory: plan.savedFiles, platform: "mac", arch: "arm64", version: plan.version, channel: plan.channel });
  const unpacked = join(plan.workDir, "kept-app");
  await rm(unpacked, { recursive: true, force: true });
  try {
    await step("ditto", ["-x", "-k", join(plan.savedFiles, plan.names.zip), unpacked], process.env);
    const checks = signatureChecks({ app: join(unpacked, "dohc.app"), dmg: join(plan.savedFiles, plan.names.dmg), signs: true });
    for (const [command, args] of checks) await step(command, args, process.env);
  } finally {
    await rm(unpacked, { recursive: true, force: true });
  }
}

/**
 * The files the release still needs. Files already on the release must be
 * the ones in `files`, and the uploaded ZIP must have the SHA-512 that the
 * update manifest names. Anything else needs a person.
 */
export async function filesToUpload(plan, assets, files, download) {
  const state = macReleaseState(plan, assets);
  if (state.kind === "refuse") throw new Error(state.reason);
  if (state.kind === "fresh") return files;
  const recovery = `To start again, delete them, then run again:\n${deleteCommands(plan, state.present)}`;
  const mismatched = state.present.filter(name => !matchesAsset(files.find(file => file.name === name), assets.find(asset => asset.name === name)));
  if (mismatched.length) throw new Error(`Release ${plan.tag} holds ${mismatched.join(", ")}, which differ from the files in ${plan.savedFiles}. ${recovery}`);
  if (state.present.includes(plan.names.zip)) {
    const manifest = readManifest(files.find(file => file.name === plan.names.manifest).path);
    const expected = manifest.files.find(file => file.url === plan.names.zip)?.sha512;
    if (!expected || await digest(await download(plan.names.zip), "sha512", "base64") !== expected) {
      throw new Error(`The ZIP on release ${plan.tag} does not have the SHA-512 that ${plan.names.manifest} names. ${recovery}`);
    }
  }
  return files.filter(file => !state.present.includes(file.name));
}

export function uploadCommands({ tag, repo }, files) {
  const upload = paths => ["gh", ["release", "upload", tag, "-R", repo, ...paths]];
  const binaries = files.slice(0, -1).map(file => file.path);
  return [...(binaries.length ? [upload(binaries)] : []), upload([files.at(-1).path])];
}

export function confirmUploaded(assets, files) {
  const missing = files.filter(file => !matchesAsset(file, assets.find(asset => asset.name === file.name)));
  if (missing.length) throw new Error(`The release does not hold these files as built: ${missing.map(file => file.name).join(", ")}.`);
}

/**
 * Uploads what the release still needs, with the manifest last. The manifest
 * uploads only when the release holds every file it names, as built. After a
 * cancellation, no upload starts.
 */
export async function publishMacFiles(plan, directory, { run, step, cancelled, download }) {
  const files = await macUploadPlan(directory, plan.names);
  const binaries = files.slice(0, -1);
  const manifest = readManifest(files.at(-1).path);
  const stray = [...new Set([...manifest.files.map(file => file.url), manifest.path])].filter(name => !binaries.some(file => file.name === name));
  if (stray.length) throw new Error(`${plan.names.manifest} in ${directory} names ${stray.join(", ")}, which this command does not upload. Nothing was uploaded.`);
  // A rehearsal uploads nothing, so it shows the plan for a release with no macOS files.
  const remaining = plan.rehearse ? files : await filesToUpload(plan, publishedRelease(run, plan.repo, plan.tag, plan.channel).assets, files, download);
  const commands = uploadCommands(plan, remaining);
  console.log(`\nUpload plan for ${plan.tag} on ${plan.repo}${plan.dryRun ? " (dry run: uploads nothing)" : ""}:`);
  for (const file of remaining) console.log(`  ${file.name}  ${file.size} bytes  sha256:${file.sha256}`);
  for (const [command, args] of commands) console.log(`  ${command} ${args.join(" ")}`);
  if (plan.dryRun) return commands;
  const release = () => publishedRelease(run, plan.repo, plan.tag, plan.channel).assets;
  try {
    for (const [command, args] of commands) {
      if (cancelled()) throw new Error("Stopped before the next upload.");
      if (args.at(-1) === files.at(-1).path) confirmUploaded(release(), binaries);
      await step(command, args, releaseEnvironment(process.env));
    }
    confirmUploaded(release(), files);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nThe built files stay in ${directory}. Run the same command again to finish the upload.`);
  }
  console.log(`\nRelease ${plan.tag} now holds the macOS files, and GitHub reports the same sizes and SHA-256 digests.`);
  return commands;
}

async function removeWorktree(checkout, run) {
  run("git", ["worktree", "remove", "--force", checkout]);
  await rm(checkout, { recursive: true, force: true });
  run("git", ["worktree", "prune"]);
}

/** Builds and checks the release's macOS files in a throwaway worktree, and returns the folder that keeps them. */
async function buildMacFiles(plan, { root, step, run, keychainStatus, interactive, cancelled }) {
  const checkout = join(plan.workDir, "checkout");
  const files = join(plan.workDir, "files");
  await removeWorktree(checkout, run);
  await rm(files, { recursive: true, force: true });
  await mkdir(plan.workDir, { recursive: true });
  const keychain = { keychainStatus, step, run, interactive, cancelled };
  // A short first unlock checks the identity and the profile and reads the
  // PostHog key into memory. The install, the builds, and the source map
  // upload, which fetches @posthog/cli outside the lockfile, then run with
  // the keychain locked.
  let signing = plan;
  if (plan.signs) {
    await unlockReleaseKeychain(plan, "Checking the signing identity", keychain);
    signing = await thenLock(run, plan.keychain, () => unlockedSigning(plan, run));
  }
  try {
    if (!plan.rehearse) await step("git", ["fetch", "--quiet", "origin", plan.buildCommit], process.env, root);
    await step("git", ["worktree", "add", "--detach", checkout, plan.buildCommit], process.env, root);
    await assertWorkflowVersion(plan, await readDesktopPackageVersion(checkout));
    const releaseDir = join(checkout, "apps/desktop/release");
    const app = join(releaseDir, "mac-arm64/dohc.app");
    const dmg = join(releaseDir, plan.names.dmg);
    const env = (additions = {}) => releaseEnvironment(process.env, additions);
    const target = join(checkout, "target");
    await step("pnpm", ["install", "--frozen-lockfile"], env(), checkout);
    await updateDesktopPackageVersion(plan.version, { root: checkout });
    await step("pnpm", ["build:desktop"], env({
      DOHC_POSTHOG_KEY: plan.reporting.DOHC_POSTHOG_KEY ?? "", DOHC_POSTHOG_HOST: plan.reporting.DOHC_POSTHOG_HOST ?? "", DOHC_DESKTOP_DIST: DIST,
    }), checkout);
    await withBuildBudget(budget => step("pnpm", ["--filter", "@dohc/desktop", "run", "build:engine", "--target", TARGET],
      releaseEnvironment(budget, { CARGO_TARGET_DIR: target, CARGO_BUILD_TARGET_DIR: target, CARGO_BUILD_BUILD_DIR: target }), checkout));
    // The chunk IDs the source maps carry must be in the files that ship, so
    // the upload runs before packaging. Only that child sees the PostHog key.
    if (plan.signs) await step(process.execPath, ["scripts/upload-desktop-source-maps.mjs"], env({ ...signing.reporting, DOHC_DESKTOP_DIST: DIST, DESKTOP_VERSION: plan.version }), checkout);
    await step("pnpm", ["smoke:package:desktop"], env({ DOHC_REQUIRE_SIGNING: plan.signs ? "1" : "0", ...signingEnvironment(signing) }), checkout);
    const packageApp = () => step("pnpm", electronBuilderArgs(plan), env(signingEnvironment(signing)), checkout);
    if (!plan.signs) await packageApp();
    else {
      // The keychain is open only while electron-builder signs and notarizes the app and the DMG is notarized.
      await unlockReleaseKeychain(plan, "Packaging", keychain, { relock: true });
      await thenLock(run, plan.keychain, async () => {
        await packageApp();
        const submission = run("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", plan.keychainProfile, "--keychain", plan.keychain, "--wait", "--output-format", "json"]);
        let result = {};
        try { result = JSON.parse(submission.stdout); } catch { /* reported below */ }
        if (result.status !== "Accepted") {
          const log = result.id ? ` Read why with xcrun notarytool log ${result.id} --keychain-profile ${plan.keychainProfile} --keychain "${plan.keychain}".` : "";
          throw new Error(`Apple did not accept the DMG (${result.status ?? submission.stderr.trim()}).${log}`);
        }
      });
      await step("xcrun", ["stapler", "staple", dmg], env(), checkout);
    }
    for (const [command, args] of signatureChecks({ app, dmg, signs: plan.signs })) await step(command, args, env(), checkout);
    if (!plan.signs) console.log("\nAn unsigned build has no Developer ID signature or notarization ticket, so spctl and stapler do not run.");
    await step("pnpm", ["smoke:fuses:desktop"], env({ DOHC_SMOKE_PACKAGE_DIRECTORY: app }), checkout);
    await verifyDesktopReleaseArtifacts({ directory: releaseDir, platform: "mac", arch: "arm64", version: plan.version, channel: plan.channel });
    await mkdir(files, { recursive: true });
    for (const name of uploadOrder(plan.names)) await copyFile(join(releaseDir, name), join(files, name));
  } finally {
    await removeWorktree(checkout, run);
  }
  const verification = await verifyDesktopReleaseArtifacts({ directory: files, platform: "mac", arch: "arm64", version: plan.version, channel: plan.channel });
  console.log(`\nRelease artifacts ${verification.status}: ${verification.artifacts.map(artifact => artifact.name).join(", ")} with ${verification.manifest.name}.`);
  return files;
}

function makeStep(cancelled) {
  const started = Date.now();
  const elapsed = () => new Date(Date.now() - started).toISOString().slice(11, 19);
  return async (command, args, env, cwd = repoRootFromScript()) => {
    // Yielding lets a pending signal handler run before the check.
    await yieldToSignals();
    if (cancelled()) throw new Error("Stopped before the next step.");
    console.log(`\n[${elapsed()}] > ${command} ${args.join(" ")}`);
    const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
    await yieldToSignals();
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed${result.signal ? ` (${result.signal})` : ` with exit code ${result.status}`}.`);
    if (cancelled()) throw new Error("Stopped after the current step.");
  };
}

function downloadAsset(plan, run) {
  return async name => {
    const directory = join(plan.workDir, "download");
    await rm(directory, { recursive: true, force: true });
    read(run, "gh", ["release", "download", plan.tag, "-R", plan.repo, "-p", name, "-D", directory]);
    return join(directory, name);
  };
}

export async function releaseMac(plan, {
  root = repoRootFromScript(), run = capture, cancelled = () => false, step = makeStep(cancelled),
  keychainStatus = readKeychainStatus, interactive = Boolean(process.stdin.isTTY),
} = {}) {
  let files = plan.savedFiles;
  try {
    if (plan.state.kind === "fresh") files = await buildMacFiles(plan, { root, step, run, keychainStatus, interactive, cancelled });
    else {
      console.log(`\nFinishing the upload that stopped, from ${plan.savedFiles}.`);
      await verifyKeptFiles(plan, step);
    }
    await publishMacFiles(plan, files, { run, step, cancelled, download: downloadAsset(plan, run) });
  } finally {
    await rm(join(plan.workDir, "download"), { recursive: true, force: true });
  }
  if (plan.dryRun) console.log(`\nThe dry run's files stay in ${files}.`);
  else await rm(join(plan.workRoot, plan.tag), { recursive: true, force: true });
}

/**
 * Runs a real release and locks the release keychain afterwards, however it
 * ends. A lock that fails is reported, and an earlier error stays the one
 * thrown. A dry run leaves the keychain alone.
 */
export async function withReleaseKeychain({ dryRun, keychain }, action, run = capture) {
  return dryRun || !existsSync(keychain) ? action() : thenLock(run, keychain, action);
}

async function main() {
  // A usage error does not wait for the lock.
  const options = parseMacReleaseArgs(process.argv.slice(2));
  // One release command at a time on this Mac. Under the scheduled nightly job, this command already holds the lock.
  const locked = process.platform === "darwin" ? await underReleaseLock(RELEASE_LOCK) : null;
  if (locked !== null) {
    process.exitCode = locked;
    return;
  }
  // A signal stops the command between steps. It still locks the release
  // keychain and removes the throwaway checkout, and starts no further upload.
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      stopping = true;
      console.error(`\n${signal}: stopping. Nothing further uploads.`);
    });
  }
  await withReleaseKeychain(options, async () => {
    const plan = await preflightMacRelease(options);
    for (const notice of plan.notices) console.log(notice);
    for (const warning of plan.warnings) console.warn(`[rehearse] A real run refuses: ${warning}`);
    console.log(plan.state.kind === "resume"
      ? `Finishing the macOS upload for ${plan.tag}.`
      : `Building macOS ${plan.version} (${plan.channel}) from ${plan.buildCommit}${plan.signs ? ", signed from the release keychain" : ", unsigned"}.`);
    await releaseMac(plan, { cancelled: () => stopping });
  });
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
