import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp as createTemporaryDirectory,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { load } from "js-yaml";
import { verifyDesktopReleaseArtifacts } from "./verify-desktop-release-artifacts.mjs";
import { NIGHTLY_AGENT_LABEL, nightlyAgentDefinition, nightlyDecision, runNightly, runTitle, verifiedNightly, waitForQueue, waitForRun } from "./release-nightly.mjs";
import { LOCK_BUSY, heldLockOptions, releaseLockHeld } from "./release-lock.mjs";

const temporaryDirectories = [];
async function mkdtemp(prefix) {
  const directory = await createTemporaryDirectory(prefix);
  temporaryDirectories.push(directory);
  return directory;
}
after(async () => {
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true });
});

import {
  desktopReleaseTargets,
  nextNightlyBaseVersion,
  resolveDesktopRelease,
  writeGithubOutput,
} from "./resolve-desktop-release.mjs";
import { updateDesktopPackageVersion } from "./update-desktop-package-version.mjs";
import { checkDesktopReleasePublication } from "./check-desktop-release-publication.mjs";
import { LEGACY_NIGHTLIES, selectUpgradeNightly } from "./select-upgrade-nightly.mjs";
import {
  createMockUpdateServer,
  resolveServablePath,
} from "./mock-update-server.mjs";
import { scriptsWithoutChunkIds, sourceMapUpload, uploadSourceMaps } from "./upload-desktop-source-maps.mjs";
import {
  DEFAULT_KEYCHAIN, PREFLIGHT_JOB, PUBLISH_JOB, SAVED_PASSWORD_SERVICE, UNLOCK_WAIT_MS, assertWorkflowVersion, confirmUploaded, electronBuilderArgs, filesToUpload, macAssetNames,
  macFileNames, macUploadPlan, parseMacReleaseArgs, preflightMacRelease, publishMacFiles, releaseEnvironment, signatureChecks,
  signingEnvironment, unlockReleaseKeychain, unlockedSigning, uploadCommands, verifyKeptFiles, withReleaseKeychain, RELEASE_REPOSITORY, releaseMac,
} from "./release-desktop-macos.mjs";

async function fixtureRoot(version = "0.1.0") {
  const root = await mkdtemp(join(tmpdir(), "dohc-release-"));
  await mkdir(join(root, "apps/desktop"), { recursive: true });
  await writeFile(
    join(root, "apps/desktop/package.json"),
    `${JSON.stringify({ name: "@dohc/desktop", version }, null, 2)}\n`,
  );
  return root;
}

test("resolves stable and nightly desktop release metadata", async () => {
  const root = await fixtureRoot("0.1.0");
  assert.equal(nextNightlyBaseVersion("0.1.0"), "0.1.1");

  const stable = await resolveDesktopRelease({
    root,
    channel: "latest",
    version: "v0.1.0",
    sha: "0123456789abcdef",
  });
  assert.equal(stable.version, "0.1.0");
  assert.equal(stable.tag, "v0.1.0");
  assert.equal(stable.is_prerelease, "false");

  const nightly = await resolveDesktopRelease({
    root,
    channel: "nightly",
    date: "20260621",
    runNumber: 12,
    runAttempt: 2,
    sha: "0123456789abcdef",
  });
  assert.equal(nightly.version, "0.1.1-nightly.20260621.12.2");
  assert.equal(nightly.release_channel, "nightly");
  assert.equal(nightly.make_latest, "false");
  assert.deepEqual(JSON.parse(nightly.matrix).map((target) => target.os), ["Windows", "Linux"]);
});

test("release platform selection defaults to every workflow platform and leaves macOS to the Mac release command", () => {
  const both = desktopReleaseTargets();
  assert.deepEqual(desktopReleaseTargets("windows-linux"), both);
  const [windows, linux] = both;
  assert.deepEqual(desktopReleaseTargets("windows"), [windows]);
  assert.equal(windows.runner, "windows-2025");
  assert.equal(windows.target, "x86_64-pc-windows-msvc");
  assert.deepEqual(desktopReleaseTargets("linux"), [linux]);
  assert.equal(linux.runner, "ubuntu-24.04");
  assert.equal(linux.target, "x86_64-unknown-linux-gnu");
  assert.equal(linux.require_signing, "0");
  for (const platforms of ["mac", "macos", "all"]) assert.throws(() => desktopReleaseTargets(platforms), /Invalid release platforms/);
});

test("Linux nightly metadata keeps the version generator and selects only Linux", async () => {
  for (const platforms of ["linux", "windows-linux"]) {
    const release = await resolveDesktopRelease({
      packageVersion: "0.1.0", channel: "nightly", platforms,
      date: "20261007", runNumber: 2, runAttempt: 1, sha: "0123456789abcdef",
    });
    assert.equal(release.version, "0.1.1-nightly.20261007.2.1");
    assert.deepEqual(JSON.parse(release.matrix), desktopReleaseTargets(platforms));
  }
});

const publishedRelease = (tag_name, names = [], published_at = "2026-10-18T10:00:00Z") => ({ draft: false, tag_name, published_at, assets: names.map((name) => ({ name })) });
const draftRelease = (tag_name, names = []) => ({ draft: true, tag_name, published_at: null, assets: names.map((name) => ({ name })) });

test("stable publication preserves every platform previously published on its channel", () => {
  const check = (platforms, releases) => checkDesktopReleasePublication({ channel: "latest", platforms, releases });
  const linuxOnly = [publishedRelease("v0.0.9", ["latest-linux.yml"])];
  const windowsAndLinux = [publishedRelease("v0.0.9", ["latest.yml", "latest-linux.yml"])];
  assert.doesNotThrow(() => check("linux", linuxOnly));
  assert.throws(() => check("linux", windowsAndLinux), /win update manifests/);
  assert.throws(() => check("windows", windowsAndLinux), /linux update manifests.*Select platforms=windows-linux/);
  assert.doesNotThrow(() => check("windows-linux", windowsAndLinux));
  // The Mac release command adds the macOS manifest after the workflow publishes.
  for (const platforms of ["windows", "linux", "windows-linux"]) assert.doesNotThrow(() => check(platforms, [publishedRelease("v0.0.9", ["latest-mac.yml"])]));
  // A draft and the other channel's manifests deliver no update to this channel.
  for (const releases of [[], [draftRelease("v0.0.9", ["latest-linux.yml"])], [publishedRelease("v0.1.1-nightly.20261018.37.1", ["nightly.yml", "nightly-linux.yml"])]]) {
    assert.doesNotThrow(() => check("windows", releases));
  }
});

test("a nightly publishes every platform the workflow builds", () => {
  for (const platforms of ["windows", "linux"]) {
    assert.throws(() => checkDesktopReleasePublication({ channel: "nightly", platforms, releases: [] }), /A nightly publishes every platform this workflow builds\. Select platforms=windows-linux/);
  }
  assert.doesNotThrow(() => checkDesktopReleasePublication({ channel: "nightly", platforms: "windows-linux", releases: [] }));
});

test("at most one nightly publishes per nightly day, which starts at 18:00 UTC, counted by when it published", () => {
  const now = new Date("2026-10-19T09:00:00Z");
  const check = (releases, at = now) => checkDesktopReleasePublication({ channel: "nightly", platforms: "windows-linux", releases, now: at });
  // Last night's scheduled nightly refuses a morning dispatch, and says when the next one can publish.
  const lastNight = publishedRelease("v0.1.1-nightly.20261018.37.1", ["nightly.yml"], "2026-10-18T20:30:00Z");
  assert.throws(() => check([lastNight]), (error) => error.message ===
    "v0.1.1-nightly.20261018.37.1 published at 2026-10-18 20:30 UTC, and one nightly publishes per nightly day, which starts at 18:00 UTC. The next nightly can publish from 2026-10-19 18:00 UTC. Before then, use dry_run=true.");
  assert.throws(() => check([publishedRelease("v0.2.1-nightly.20261019.38.2", ["nightly.yml"], "2026-10-19T08:59:00+00:00")]), /can publish from 2026-10-19 18:00 UTC/);
  // A nightly published by hand before 18:00 UTC doesn't hold back that evening's scheduled one.
  const manual = publishedRelease("v0.1.1-nightly.20261019.38.1", ["nightly.yml"], "2026-10-19T00:30:00Z");
  assert.throws(() => check([manual]), /can publish from 2026-10-19 18:00 UTC/);
  assert.doesNotThrow(() => check([manual], new Date("2026-10-19T20:00:00Z")));
  // On 26 October a nightly dispatched by hand published at about 07:00 UTC, and that evening's run still publishes.
  const morning = publishedRelease("v0.1.1-nightly.20261026.152.1", ["nightly.yml", "nightly-linux.yml"], "2026-10-26T07:00:00Z");
  assert.doesNotThrow(() => check([morning], new Date("2026-10-26T20:00:00Z")));
  // The day turns at 18:00 UTC exactly.
  const beforeTurn = publishedRelease("v0.1.1-nightly.20261019.39.1", ["nightly.yml"], "2026-10-19T17:59:00Z");
  assert.throws(() => check([beforeTurn], new Date("2026-10-19T17:59:59Z")), /can publish from 2026-10-19 18:00 UTC/);
  assert.doesNotThrow(() => check([beforeTurn], new Date("2026-10-19T18:00:00Z")));
  const atTurn = publishedRelease("v0.1.1-nightly.20261019.40.1", ["nightly.yml"], "2026-10-19T18:00:00Z");
  assert.throws(() => check([atTurn], new Date("2026-10-20T17:59:59Z")), /can publish from 2026-10-20 18:00 UTC/);
  // A draft never reached an updater, and earlier nightly days and stable releases do not count.
  assert.doesNotThrow(() => check([
    draftRelease("v0.1.1-nightly.20261019.39.1", ["nightly.yml"]),
    publishedRelease("v0.1.1-nightly.20261018.36.1", ["nightly.yml", "nightly-linux.yml"], "2026-10-18T17:59:59Z"),
    publishedRelease("v0.1.0", ["latest.yml"], "2026-10-19T08:00:00Z"),
  ]));
});

test("publication history fails closed on incomplete input", () => {
  for (const releases of [null, {}, [{}], [{ draft: false, assets: [] }], [{ draft: false, tag_name: "v0.1.0", assets: [] }],
    [{ draft: false, tag_name: "v0.1.0", published_at: "2026-10-18T10:00:00Z", assets: [{}] }], [[[]]]]) {
    for (const channel of ["nightly", "latest"]) {
      assert.throws(() => checkDesktopReleasePublication({ channel, platforms: "windows-linux", releases }), /Release history/);
    }
  }
});

test("the publication check exits unsuccessfully when a release breaks a rule", async () => {
  const root = await fixtureRoot();
  const history = join(root, "releases.jsonl");
  const writeHistory = (publishedAt) => writeFile(history,
    JSON.stringify(publishedRelease("v0.1.1-nightly.20261018.37.1", ["nightly.yml", "nightly-linux.yml", "nightly-mac.yml"], publishedAt)) + "\n");
  await writeHistory(new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString());
  const script = fileURLToPath(new URL("./check-desktop-release-publication.mjs", import.meta.url));
  const args = [script, "--channel", "nightly", "--platforms", "windows", "--releases", history];
  await assert.rejects(promisify(execFile)(process.execPath, args), (error) => error.code === 1 && /Select platforms=windows-linux/.test(error.stderr));
  args[4] = "windows-linux";
  const { stdout } = await promisify(execFile)(process.execPath, args);
  assert.match(stdout, /meets the publication rules/);
  await writeHistory(new Date().toISOString());
  await assert.rejects(promisify(execFile)(process.execPath, args), (error) => error.code === 1 && /The next nightly can publish from/.test(error.stderr));
});

test("release metadata requires a real commit sha", async () => {
  const root = await fixtureRoot("0.1.0");
  const previousSha = process.env.GITHUB_SHA;
  delete process.env.GITHUB_SHA;
  try {
    await assert.rejects(
      () =>
        resolveDesktopRelease({
          root,
          channel: "nightly",
          date: "20260621",
          runNumber: 12,
          runAttempt: 2,
        }),
      /Commit SHA is required/,
    );
  } finally {
    if (previousSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previousSha;
  }
});

test("stable release metadata rejects prerelease package versions", async () => {
  const root = await fixtureRoot("0.1.0-nightly.20260621.12.2");
  await assert.rejects(
    () =>
      resolveDesktopRelease({
        root,
        channel: "latest",
        version: "v0.1.0",
        sha: "0123456789abcdef",
      }),
    /must match apps\/desktop\/package\.json/,
  );
});

test("nightly release dates must be real calendar dates", async () => {
  const root = await fixtureRoot("0.1.0");
  await assert.rejects(
    () =>
      resolveDesktopRelease({
        root,
        channel: "nightly",
        date: "20260230",
        runNumber: 12,
        runAttempt: 2,
        sha: "0123456789abcdef",
      }),
    /Date does not exist/,
  );
  await assert.doesNotReject(() =>
    resolveDesktopRelease({
      root,
      channel: "nightly",
      date: "20260228",
      runNumber: 12,
      runAttempt: 2,
      sha: "0123456789abcdef",
    }),
  );
});

test("updates apps/desktop/package.json version idempotently", async () => {
  const root = await fixtureRoot("0.1.0");
  const first = await updateDesktopPackageVersion("0.1.1-nightly.20260621.12.2", {
    root,
  });
  const second = await updateDesktopPackageVersion("0.1.1-nightly.20260621.12.2", {
    root,
  });
  const packageJson = JSON.parse(
    await readFile(join(root, "apps/desktop/package.json"), "utf8"),
  );

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(packageJson.version, "0.1.1-nightly.20260621.12.2");
});

test("writes GitHub output in action-compatible key value form", async () => {
  const root = await mkdtemp(join(tmpdir(), "dohc-release-output-"));
  const outputPath = join(root, "github-output.txt");

  await writeGithubOutput(
    {
      release_channel: "nightly",
      version: "0.1.1-nightly.20260621.12.2",
      make_latest: "false",
    },
    outputPath,
  );

  assert.equal(
    await readFile(outputPath, "utf8"),
    [
      "release_channel=nightly",
      "version=0.1.1-nightly.20260621.12.2",
      "make_latest=false",
      "",
    ].join("\n"),
  );
});

test("mock update server serves files and blocks traversal/directory-link escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dohc-update-server-"));
  const outside = await mkdtemp(join(tmpdir(), "dohc-outside-"));
  await writeFile(join(root, "latest.yml"), "version: 0.1.0\n");
  await writeFile(join(outside, "secret.txt"), "nope");
  await symlink(outside, join(root, "outside-link"), process.platform === "win32" ? "junction" : "dir");

  assert.ok(await resolveServablePath(root, "/latest.yml"));
  assert.equal(await resolveServablePath(root, "/../secret.txt"), null);
  assert.equal(await resolveServablePath(root, "/latest%00.yml"), null);
  assert.equal(await resolveServablePath(root, "/outside-link/secret.txt"), null);

  const server = await createMockUpdateServer({ root });
  try {
    const ok = await fetch(`${server.url}/latest.yml`);
    const escaped = await fetch(`${server.url}/../secret.txt`);
    const linked = await fetch(`${server.url}/outside-link/secret.txt`);
    const nul = await fetch(`${server.url}/latest%00.yml`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") ?? "", /^text\/yaml/);
    assert.equal(await ok.text(), "version: 0.1.0\n");
    assert.equal(escaped.status, 404);
    assert.equal(linked.status, 404);
    assert.equal(nul.status, 404);
  } finally {
    await server.close();
  }
});

// The release workflow runs these commands from the repository root on every
// runner, Windows included. Run them the same way so a script that exits
// without doing its work fails here.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const runScript = promisify(execFile);
function runReleaseScript(script, args, env = {}) {
  return runScript(process.execPath, [`scripts/${script}`, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });
}

test("resolve-desktop-release prints release metadata when run as a command", async () => {
  const root = await fixtureRoot();
  const { stdout } = await runReleaseScript("resolve-desktop-release.mjs", [
    "--root", root, "--channel", "nightly", "--date", "20260621",
    "--run-number", "2", "--run-attempt", "1", "--sha", "0123456789abcdef",
  ]);
  assert.match(stdout, /^version=0\.1\.1-nightly\.20260621\.2\.1$/m);
  const matrix = output => JSON.parse(/^matrix=(.*)$/m.exec(output)[1]);
  assert.deepEqual(matrix(stdout), desktopReleaseTargets());
  const linux = await runReleaseScript("resolve-desktop-release.mjs", [
    "--root", root, "--channel", "nightly", "--platforms", "linux", "--date", "20260621",
    "--run-number", "2", "--run-attempt", "1", "--sha", "0123456789abcdef",
  ]);
  assert.deepEqual(matrix(linux.stdout), desktopReleaseTargets("linux"));
});

// Node resolves links in the entry path before it sets import.meta.url, so a
// guard that compares that URL with argv[1] fails in a checkout reached
// through a junction or symlink, such as a runner's work directory or /var on
// macOS.
test("release commands run from a checkout reached through a link", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dohc-linked-checkout-"));
  const linkedRoot = join(parent, "checkout");
  await symlink(repoRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  const root = await fixtureRoot();
  const { stdout } = await runScript(
    process.execPath,
    [
      "scripts/resolve-desktop-release.mjs",
      "--root", root, "--channel", "nightly", "--date", "20260621",
      "--run-number", "2", "--run-attempt", "1", "--sha", "0123456789abcdef",
    ],
    { cwd: linkedRoot },
  );
  assert.match(stdout, /^version=0\.1\.1-nightly\.20260621\.2\.1$/m);
});

test("update-desktop-package-version stamps the version when run as a command", async () => {
  const root = await fixtureRoot();
  const { stdout } = await runReleaseScript(
    "update-desktop-package-version.mjs",
    ["--root", root],
    { DESKTOP_VERSION: "0.1.1-nightly.20260621.2.1" },
  );
  assert.match(stdout, /^updated /);
  const packageJson = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"));
  assert.equal(packageJson.version, "0.1.1-nightly.20260621.2.1");
});

test("mock-update-server serves its root when run as a command", async () => {
  const root = await mkdtemp(join(tmpdir(), "dohc-update-command-"));
  await writeFile(join(root, "latest.yml"), "version: 0.1.0\n");
  const child = spawn(
    process.execPath,
    ["scripts/mock-update-server.mjs", "--root", root, "--port", "0"],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  try {
    const url = await new Promise((resolveUrl, reject) => {
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const serving = / at (http:\/\/127\.0\.0\.1:\d+)\s*$/m.exec(output);
        if (serving) resolveUrl(serving[1]);
      });
      child.once("error", reject);
      exited.then((code) =>
        reject(new Error(`mock-update-server exited with ${code} before serving: ${output}`)),
      );
    });
    const response = await fetch(`${url}/latest.yml`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "version: 0.1.0\n");
  } finally {
    child.kill();
    await exited;
  }
});

const releaseWorkflowSource = await readFile(new URL("../.github/workflows/desktop-release.yml", import.meta.url), "utf8");
const releaseWorkflow = load(releaseWorkflowSource);

// A Windows checkout can have CRLF line endings, and an edit can drop the final newline.
test("the release workflow contract reads the same with CRLF line endings and no final newline", () => {
  const lf = releaseWorkflowSource.replaceAll("\r\n", "\n");
  const crlf = lf.replaceAll("\n", "\r\n");
  for (const source of [lf, crlf, lf.trimEnd(), crlf.trimEnd()]) assert.deepEqual(load(source), releaseWorkflow);
});

function releaseStep(job, command) {
  const step = job.steps.find(candidate => candidate.run?.includes(command) || candidate.uses?.startsWith(command));
  assert.ok(step, `release job runs ${command}`);
  return step;
}

function workflowValues(value) {
  if (Array.isArray(value)) return value.flatMap(workflowValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(workflowValues);
  return [value];
}

function releaseExpression(expression, needs, secrets = {}, inputs = {}, matrix = {}) {
  // These release guards use string comparisons and operators shared by Actions and JavaScript.
  assert.match(expression, /^\$\{\{[\s\S]*\}\}$/u);
  return Function("needs", "secrets", "inputs", "matrix", `return (${expression.slice(3, -2)});`)(needs, secrets, inputs, matrix);
}

test("desktop releases start only by dispatch, use pinned GitHub images, and preserve unsigned package smoke", () => {
  const { jobs } = releaseWorkflow;
  assert.deepEqual(Object.keys(releaseWorkflow.on), ["workflow_dispatch"], "only a dispatch can start a release");
  assert.equal(releaseWorkflow.concurrency["cancel-in-progress"], false, "a publish in progress must finish");
  assert.equal(releaseWorkflow.permissions.contents, "read");
  assert.equal(jobs.preflight.if, "github.ref == 'refs/heads/main'");
  for (const job of [jobs.build, jobs.publish]) assert.equal(job.environment, "desktop-release");

  assert.equal(jobs.build["runs-on"], "${{ matrix.runner }}");
  assert.equal(jobs.build.strategy.matrix.include, "${{ fromJSON(needs.preflight.outputs.matrix) }}");
  assert.equal(jobs.build.strategy["max-parallel"], undefined, "platform builds can run in parallel");
  const dispatchPlatforms = releaseWorkflow.on.workflow_dispatch.inputs.platforms.options;
  // GitHub's images lack the pinned Rust, and qa:prepare reads rustc without installing it.
  for (const [job, firstRustStep] of [[jobs.preflight, "Prepare desktop and native test engine"], [jobs.build, "Build workspace engine"]]) {
    const toolchain = job.steps.findIndex(step => step.name === "Rust toolchain");
    assert.ok(toolchain >= 0 && toolchain < job.steps.findIndex(step => step.name === firstRustStep), `${firstRustStep} has the pinned Rust`);
    assert.equal(job.steps[toolchain].if, undefined);
    assert.match(job.steps[toolchain].run, /rustup show active-toolchain \|\| rustup toolchain install/);
    // GitHub's Windows TEMP is a short 8.3 path; every later step uses the runner's own temp folder.
    const temp = job.steps.findIndex(step => step.name === "Use the runner's temp folder");
    assert.ok(temp >= 0 && temp < job.steps.findIndex(step => step.name === "Install"), "TEMP is set before anything runs");
    assert.equal(job.steps[temp].if, "runner.os == 'Windows'");
    assert.match(job.steps[temp].run, /TEMP=\$RUNNER_TEMP[\s\S]*TMP=\$RUNNER_TEMP/);
  }
  const hostedImage = platforms => (platforms === "linux" ? "ubuntu-24.04" : "windows-2025");
  for (const platforms of dispatchPlatforms) {
    assert.deepEqual(desktopReleaseTargets(platforms).map(target => target.runner),
      (platforms === "windows-linux" ? ["windows", "linux"] : [platforms]).map(hostedImage));
  }
  assert.deepEqual(dispatchPlatforms.map(platforms => releaseExpression(jobs.preflight["runs-on"], {}, {}, { platforms })), dispatchPlatforms.map(hostedImage),
    "preflight runs on Linux only for a Linux dispatch");
  for (const job of [jobs["unused-version"], jobs.publish]) assert.equal(job["runs-on"], "ubuntu-24.04");

  // Desktop tests need the built runtime exports and the PR gate's full
  // preparation, which stages the Markdown reader beside the native engine.
  // The PR gate's runner runs the package's unit and script tests with its retries.
  const preflightOrder = step => jobs.preflight.steps.indexOf(step);
  const desktopTests = releaseStep(jobs.preflight, "node scripts/verification/js-tests.mjs --prepared --package @dohc/desktop");
  for (const prepare of ["pnpm --filter @dohc/app-backend-runtime build", "pnpm qa:prepare"]) {
    assert.ok(preflightOrder(releaseStep(jobs.preflight, prepare)) < preflightOrder(desktopTests), `desktop tests run after ${prepare}`);
  }
  assert.equal(releaseStep(jobs.preflight, "pnpm qa:prepare").run, "pnpm qa:prepare", "preflight prepares the desktop, not only the engine");
  assert.equal(desktopTests.env.DOHC_REQUIRE_ENGINE_E2E, "1");

  // Draft and published versions must both be refused before packaging.
  assert.ok([jobs["unused-version"].needs].flat().includes("preflight"));
  assert.equal(jobs["unused-version"].permissions.contents, "write");
  // Publishing checks the release history: a nightly ships every workflow platform at
  // most once a nightly day, and a channel keeps every platform it has published. The check
  // runs before packaging, and again in Publish, because a run can publish after the nightly day turns.
  const rulesBeforePackaging = releaseStep(jobs["unused-version"], "check-desktop-release-publication.mjs");
  const rulesBeforePublishing = releaseStep(jobs.publish, "check-desktop-release-publication.mjs");
  assert.equal(rulesBeforePackaging.if, "needs.preflight.outputs.dry_run != 'true'");
  for (const publicationRules of [rulesBeforePackaging, rulesBeforePublishing]) {
    assert.match(publicationRules.run, /set -euo pipefail/);
    assert.match(publicationRules.run, /gh api --paginate/);
    assert.match(publicationRules.run, /\{draft, tag_name, published_at, assets: /);
    assert.match(publicationRules.run, /--releases release-history\.jsonl/);
    assert.equal(publicationRules.env.RELEASE_CHANNEL, "${{ needs.preflight.outputs.release_channel }}");
    assert.equal(publicationRules.env.RELEASE_PLATFORMS, "${{ inputs.platforms }}");
  }
  assert.ok(jobs.publish.steps.indexOf(rulesBeforePublishing) < jobs.publish.steps.indexOf(releaseStep(jobs.publish, "softprops/action-gh-release@")),
    "Publish checks the rules before it creates the release");
  assert.equal(releaseWorkflow.on.workflow_dispatch.inputs.platforms.default, "windows-linux");
  // Both steps list releases, so the refusal is found by its tag lookup.
  const refuseUsedVersion = releaseStep(jobs["unused-version"], "git/matching-refs/tags/").run;
  assert.match(refuseUsedVersion, /repos\/\$\{GITHUB_REPOSITORY\}\/releases\?per_page=100/);
  assert.match(refuseUsedVersion, /select\(\.tag_name == env\.TAG\)/);
  assert.match(refuseUsedVersion, /git\/matching-refs\/tags\/\$\{TAG\}/);
  for (const found of [/== \*published\*/, /== \*draft\*/, /-n "\$tag"/]) assert.match(refuseUsedVersion, found);
  assert.ok([jobs.build.needs].flat().includes("unused-version"), "packaging waits for the version check");

  // Updaters cannot see the release until the publish job's final step.
  const createRelease = releaseStep(jobs.publish, "softprops/action-gh-release@");
  assert.ok([jobs.publish.needs].flat().includes("build"), "publishing waits for packaging");
  assert.equal(createRelease.id, "draft");
  assert.equal(createRelease.with.draft, true);
  assert.equal(createRelease.with.target_commitish, "${{ github.sha }}");
  const lastPublishStep = jobs.publish.steps.at(-1);
  assert.equal(lastPublishStep.env.RELEASE_ID, "${{ steps.draft.outputs.id }}");
  assert.match(lastPublishStep.run, /-F draft=false/);
  for (const dryRun of ["true", "false"]) {
    assert.equal(releaseExpression(jobs.publish.if, { preflight: { outputs: { dry_run: dryRun } } }), dryRun === "false");
  }

  const packageSteps = Object.values(jobs).flatMap(job => job.steps).filter(step => step.run?.includes("electron-builder"));
  assert.equal(packageSteps.length, 1, "every electron-builder path is covered");
  const packageDesktop = releaseStep(jobs.build, "electron-builder");
  assert.equal(packageSteps[0], packageDesktop);
  assert.match(packageDesktop.run, /builder_args=\(--publish never/, "packaging cannot publish directly");
  assert.match(packageDesktop.run, /builder_args\+=\(-c\.forceCodeSigning=true\)/, "required signing must fail without an identity");
  assert.match(packageDesktop.run, /CSC_IDENTITY_AUTO_DISCOVERY=false/, "unsigned runs disable signing discovery");
  releaseStep(jobs.build, "verify-desktop-release-artifacts.mjs");
  const fuseSmoke = releaseStep(jobs.build, "smoke:fuses:desktop");
  assert.equal(fuseSmoke.if, "runner.os == 'Linux'");
  assert.equal(fuseSmoke.env.DOHC_E2E_NO_CHROMIUM_SANDBOX, "1");
  assert.equal(fuseSmoke.run, "xvfb-run -a pnpm smoke:fuses:desktop");
  // Each packaged app runs once before anything uploads it.
  const windowsSmoke = releaseStep(jobs.build, "--binary apps/desktop/release/win-unpacked/dohc.exe");
  assert.equal(windowsSmoke.if, "runner.os == 'Windows'");
  assert.match(windowsSmoke.run, /--package-commit '\$\{\{ github\.sha \}\}'/);
  const upload = releaseStep(jobs.build, "actions/upload-artifact@");
  const order = step => jobs.build.steps.indexOf(step);
  assert.ok(order(packageDesktop) < order(fuseSmoke), "the Linux fuse smoke boots the package electron-builder wrote");
  for (const smoke of [fuseSmoke, windowsSmoke]) assert.ok(order(smoke) < order(upload), "the packaged smoke runs before the upload");
  // Package smoke fails a required-signing Windows run without the certificate packaging uses.
  const packageSmoke = releaseStep(jobs.build, "smoke:package:desktop");
  assert.equal(packageSmoke.env.WIN_CSC_LINK, packageDesktop.env.WIN_CSC_LINK, "Package smoke sees the certificate that packaging uses");

  // The Mac release command builds macOS with this Mac's keychain, so the
  // workflow holds no macOS target, job, or credential.
  assert.doesNotMatch(releaseWorkflowSource, /secrets\.(MACOS|APPLE)_|== 'macOS'|mac\.identity|mac-arm64/u, "the workflow builds no macOS package");
  const secretExpressions = workflowValues(releaseWorkflow).filter(value => typeof value === "string" && value.includes("secrets."));
  assert.ok(secretExpressions.length > 0, "the workflow still declares release secrets");
  for (const expression of secretExpressions) {
    const secrets = Object.fromEntries([...expression.matchAll(/secrets\.(\w+)/gu)].map(([, name]) => [name, `configured-${name}`]));
    // Signing secrets belong to one platform. Every other secret serves all targets.
    const owner = /secrets\.WIN_/u.test(expression) ? "Windows" : null;
    for (const target of desktopReleaseTargets("windows-linux")) {
      const matrix = { os: target.os };
      assert.equal(releaseExpression(expression, { preflight: { outputs: { dry_run: "true" } } }, secrets, {}, matrix), "", "dry runs receive no release secrets");
      const published = releaseExpression(expression, { preflight: { outputs: { dry_run: "false" } } }, secrets, {}, matrix);
      if (owner && target.os !== owner) assert.equal(published, "", `${target.label} receives no ${owner} signing secret`);
      else assert.ok(published, `${target.label} publishing can use configured secrets`);
    }
  }
});

test("the upgrade check opens the newest published nightly, and only legacy nightlies skip it", () => {
  const nightly = (tag_name, published_at, names = [`dohc-${tag_name}-linux-x86_64.AppImage`], draft = false) =>
    ({ tag_name, published_at, draft, assets: names.map((name) => ({ name })) });
  const older = nightly("v0.1.2-nightly.20261017.40.1", "2026-10-17T04:00:00Z");
  const newer = nightly("v0.1.2-nightly.20261018.41.1", "2026-10-18T04:00:00Z");
  const stable = nightly("v0.1.2", "2026-10-19T04:00:00Z");
  const draft = nightly("v0.1.2-nightly.20261019.42.1", "2026-10-19T05:00:00Z", undefined, true);
  assert.deepEqual(selectUpgradeNightly([older, newer, stable, draft]), { tag: newer.tag_name }, "drafts and stable releases are not nightlies");
  assert.match(selectUpgradeNightly([stable]).notice, /No nightly is published yet/u);
  assert.equal(selectUpgradeNightly([]).tag, null);
  assert.deepEqual(LEGACY_NIGHTLIES, ["v0.1.1-nightly.20260622.15.1"]);
  const legacy = nightly(LEGACY_NIGHTLIES[0], "2026-06-22T09:42:56Z");
  assert.equal(selectUpgradeNightly([legacy]).tag, null, "a nightly from before the packaged engine skips the check");
  assert.equal(selectUpgradeNightly([legacy, older]).tag, older.tag_name, "a later nightly replaces the legacy one");
  // A newer nightly without an AppImage must not hand the check to an older one.
  const windowsOnly = nightly("v0.1.2-nightly.20261019.43.1", "2026-10-19T06:00:00Z", ["dohc-setup.exe"]);
  assert.throws(() => selectUpgradeNightly([older, windowsOnly]), /v0\.1\.2-nightly\.20261019\.43\.1, the newest published nightly, has no Linux AppImage/u);
  assert.throws(() => selectUpgradeNightly([{ ...older, published_at: null }]), /no publication time/u);
});

test("the Linux package opens a workspace from the previous nightly before anything uploads it", () => {
  const { build } = releaseWorkflow.jobs;
  const choose = releaseStep(build, "scripts/select-upgrade-nightly.mjs");
  assert.equal(choose.id, "previous-nightly");
  assert.equal(choose.if, "runner.os == 'Linux'");
  assert.equal(choose.env.GH_TOKEN, "${{ github.token }}", "the step reads releases with the job token");
  assert.match(choose.run, /--jq '\.\[\] \| \{tag_name, draft, published_at, assets: \[\.assets\[\] \| \{name\}\]\}'/u, "the helper sees every release and decides");
  assert.match(choose.run, /--github-output$/mu);
  const upgrade = releaseStep(build, "src/workspaces/engineUpgrade.e2e.test.ts");
  assert.equal(upgrade.if, "runner.os == 'Linux' && steps.previous-nightly.outputs.tag != ''", "only the helper's skip skips the check");
  assert.equal(upgrade.env.PREVIOUS_NIGHTLY, "${{ steps.previous-nightly.outputs.tag }}");
  assert.equal(upgrade.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(upgrade.env.DOHC_REQUIRE_UPGRADE_E2E, "1", "a missing engine fails the check instead of skipping it");
  assert.equal(upgrade.env.DOHC_TEST_ENGINE_BINARY,
    "${{ github.workspace }}/apps/desktop/release/linux-unpacked/resources/workspace-engine/dohc-workspace-engine",
    "the check opens the workspace with the engine this run packaged");
  assert.match(upgrade.run, /--appimage-extract/u, "the AppImage is extracted without FUSE");
  assert.match(upgrade.run, /download="\$\{RUNNER_TEMP\}\/previous-nightly"/u, "the previous nightly stays out of apps/desktop/release");
  assert.match(upgrade.run, /gh release download "\$PREVIOUS_NIGHTLY" .*--dir "\$download"/u);
  assert.match(upgrade.run, /export DOHC_UPGRADE_PREVIOUS_ENGINE="\$download\/squashfs-root\/resources\/workspace-engine\/dohc-workspace-engine"/u);
  assert.match(upgrade.run, /if \[\[ ! -x "\$DOHC_UPGRADE_PREVIOUS_ENGINE" \]\]; then\n\s+echo "::error::[^\n]+"\n\s+exit 1/u, "a nightly without an executable engine fails the check");
  assert.doesNotMatch(upgrade.run, /exit 0/u, "the check step itself never skips");
  const order = step => build.steps.indexOf(step);
  assert.ok(order(releaseStep(build, "smoke:fuses:desktop")) < order(choose), "the check runs after the fuse smoke");
  assert.equal(order(upgrade), order(choose) + 1);
  assert.ok(order(upgrade) < order(releaseStep(build, "actions/upload-artifact@")), "the check runs before the upload");
});

test("desktop release stages the Rust engine and Collection compiler for the packaged architecture", async () => {
  const root = await mkdtemp(join(tmpdir(), "dohc-engine-cross-build-"));
  const scriptDir = join(root, "apps/desktop/scripts");
  await mkdir(scriptDir, { recursive: true });
  const sourceScript = join(
    process.cwd(),
    "apps/desktop/scripts/build-workspace-engine.mjs",
  );
  const copiedScript = join(scriptDir, "build-workspace-engine.mjs");
  await writeFile(copiedScript, await readFile(sourceScript, "utf8"));
  await mkdir(join(root, "scripts/verification"), { recursive: true });
  await writeFile(join(root, "scripts/verification/process.mjs"), await readFile(join(process.cwd(), "scripts/verification/process.mjs"), "utf8"));
  await mkdir(join(root, "tools/rust-engine-program"), { recursive: true });
  await writeFile(join(root, "tools/rust-engine-program/git-read.mjs"), await readFile(join(process.cwd(), "tools/rust-engine-program/git-read.mjs"), "utf8"));

  const buildModule = await import(
    `${pathToFileURL(copiedScript).href}?test=${Date.now()}`
  );
  assert.equal(typeof buildModule.buildWorkspaceEngine, "function");

  const target =
    process.platform === "darwin" && process.arch === "arm64"
      ? "x86_64-apple-darwin"
      : "aarch64-apple-darwin";
  const cargoCalls = [];
  await buildModule.buildWorkspaceEngine({
    repoRoot: root,
    desktopDir: join(root, "apps/desktop"),
    platform: "darwin",
    target,
    runCargo(command, args, options) {
      cargoCalls.push({ command, args, cwd: options.cwd });
      const output = join(
        root,
        "target",
        target,
        "release",
        "dohc-workspace-engine",
      );
      mkdirSync(join(root, "target", target, "release"), { recursive: true });
      writeFileSync(output, "target fixture");
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(cargoCalls, [
    {
      command: "cargo",
      args: [
        "build",
        "--release",
        "--bin",
        "dohc-workspace-engine",
        "--target",
        target,
      ],
      cwd: root,
    },
  ]);
  assert.equal(
    await readFile(
      join(
        root,
        "apps/desktop/resources/workspace-engine/dohc-workspace-engine",
      ),
      "utf8",
    ),
    "target fixture",
  );

  const mismatchRepoRoot = join(root, "mismatch");
  const mismatchDesktopDir = join(mismatchRepoRoot, "apps/desktop");
  await assert.rejects(
    () =>
      buildModule.buildWorkspaceEngine({
        repoRoot: mismatchRepoRoot,
        desktopDir: mismatchDesktopDir,
        platform: "darwin",
        target,
        runCargo() {
          const hostOutput = join(
            mismatchRepoRoot,
            "target",
            "release",
            "dohc-workspace-engine",
          );
          mkdirSync(join(mismatchRepoRoot, "target", "release"), {
            recursive: true,
          });
          writeFileSync(hostOutput, "host fixture");
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    new RegExp(`for target ${target} is missing`),
  );
  assert.equal(
    existsSync(
      join(
        mismatchDesktopDir,
        "resources/workspace-engine/dohc-workspace-engine",
      ),
    ),
    false,
  );

  const build = releaseWorkflow.jobs.build;
  assert.equal(build.strategy.matrix.include, "${{ fromJSON(needs.preflight.outputs.matrix) }}", "preflight selects the package matrix");
  assert.deepEqual(desktopReleaseTargets("windows-linux").map(({ artifact_platform, arch, target }) => [artifact_platform, arch, target]).sort(), [
    ["win", "x64", "x86_64-pc-windows-msvc"],
    ["linux", "x64", "x86_64-unknown-linux-gnu"],
  ].sort());
  const engineCommand = releaseStep(build, "build:engine").run.match(
    /^\s*pnpm --filter @dohc\/desktop run build:engine (.+)$/m,
  );
  assert.ok(engineCommand, "the workflow builds the selected Rust target");
  const engineArgs = engineCommand[1]
    .replace('"${{ matrix.target }}"', target)
    .trim().split(/\s+/);
  assert.equal(buildModule.parseTargetArgument(engineArgs), target);
  // Each target packages on a runner of its own architecture, so the install
  // needs no --cpu and packaging checks the compiler the desktop build staged.
  const installs = build.steps.filter(step => /\bpnpm (install|i)\b/.test(step.run ?? ""));
  assert.deepEqual(installs.map(step => step.run), ["pnpm install --frozen-lockfile"]);
  assert.ok(!build.steps.some(step => step.run?.includes("stage-app-compiler.mjs")), "the desktop build stages the compiler");
  const order = step => build.steps.indexOf(step);
  assert.ok(order(releaseStep(build, "pnpm build:desktop")) < order(releaseStep(build, "electron-builder")), "packaging checks the staged compiler");
});

test("desktop release workflow uploads only distributable release assets", () => {
  const prepareReleaseUpload = releaseStep(releaseWorkflow.jobs.publish, "is_release_upload_file").run;

  assert.match(
    prepareReleaseUpload,
    /is_release_upload_file\(\)/,
    "release upload step must filter downloaded package contents before flattening",
  );
  assert.match(
    prepareReleaseUpload,
    /\*\/win-unpacked\/\*\|\*\/linux-unpacked\/\*/,
    "release upload step must skip unpacked app internals that contain duplicate basenames",
  );
  assert.match(
    prepareReleaseUpload,
    /latest\*\.yml\|nightly\*\.yml\|\*\.exe\|\*\.AppImage\|\*\.deb\|\*\.blockmap/,
    "release upload step must allow update manifests and configured installer artifacts",
  );
  assert.match(
    prepareReleaseUpload,
    /if ! is_release_upload_file "\$file"; then\s+continue\s+fi/,
    "release upload step must skip non-release files before the basename conflict guard",
  );
});

const SOURCE_MAP_ENV = {
  DOHC_POSTHOG_KEY: "phc_abcdefghij0123456789",
  POSTHOG_CLI_API_KEY: "phx_fixture",
  POSTHOG_CLI_PROJECT_ID: "42",
  DESKTOP_VERSION: "0.1.1-nightly.20260621.2.1",
  DOHC_DESKTOP_DIST: "win-x64",
};
const CHUNK_ID = "0192f5b8-7c3a-5e1d-9a2b-3c4d5e6f7a8b";

// The files a production build writes, before and after the CLI injects them.
async function builtDist({ injected }) {
  const root = await mkdtemp(join(tmpdir(), "dohc-source-maps-"));
  const trailer = injected ? `\n//# chunkId=${CHUNK_ID}` : "";
  for (const file of ["main/app.js", "main/chunks/posthogErrors-Ab12.js", "renderer/assets/index-Cd34.js"]) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), `console.log(1);\n${trailer}`);
    await writeFile(join(root, `${file}.map`), "{}");
  }
  // A file without a source map is not code the reports name.
  await writeFile(join(root, "renderer/assets/worker-copy.js"), "console.log(2);\n");
  return [join(root, "main"), join(root, "renderer")];
}

test("a build with a PostHog key injects and uploads its source maps under the release and dist its reports carry", () => {
  assert.deepEqual(sourceMapUpload(SOURCE_MAP_ENV).args, [
    "dlx", "--allow-build=@posthog/cli", "@posthog/cli@0.18.10", "sourcemap", "process",
    "--directory", "apps/desktop/dist/main",
    "--directory", "apps/desktop/dist/renderer",
    "--release-name", "dohc-desktop",
    "--release-version", "0.1.1-nightly.20260621.2.1",
    "--build", "win-x64",
  ]);
  assert.match(sourceMapUpload({ ...SOURCE_MAP_ENV, DOHC_POSTHOG_KEY: " " }).skip, /DOHC_POSTHOG_KEY is not set/);
  assert.match(sourceMapUpload({ DOHC_POSTHOG_KEY: "" }).skip, /needs no source maps/);
  for (const missing of [{ POSTHOG_CLI_API_KEY: "" }, { POSTHOG_CLI_API_KEY: undefined }]) {
    assert.throws(() => sourceMapUpload({ ...SOURCE_MAP_ENV, ...missing }), /POSTHOG_CLI_API_KEY is empty\. Add it/);
  }
  assert.throws(
    () => sourceMapUpload({ ...SOURCE_MAP_ENV, POSTHOG_CLI_API_KEY: " ", POSTHOG_CLI_PROJECT_ID: "" }),
    /POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID are empty\. Add them/,
  );
  assert.throws(() => sourceMapUpload({ ...SOURCE_MAP_ENV, DESKTOP_VERSION: "" }), /DESKTOP_VERSION/);
  assert.throws(() => sourceMapUpload({ ...SOURCE_MAP_ENV, DOHC_DESKTOP_DIST: "win x64" }), /DOHC_DESKTOP_DIST/);
});

test("the source map upload leaves a PostHog host the release did not set unset, and keeps one it did", async () => {
  const directories = await builtDist({ injected: true });
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    return { status: 0 };
  };
  // A repository variable that is not set reaches the step as an empty string.
  uploadSourceMaps({ ...SOURCE_MAP_ENV, PATH: "/bin", POSTHOG_CLI_HOST: " " }, spawn, directories);
  uploadSourceMaps({ ...SOURCE_MAP_ENV, POSTHOG_CLI_HOST: "https://eu.posthog.com" }, spawn, directories);

  const [unset, configured] = calls;
  assert.equal(unset.command, "pnpm");
  assert.deepEqual(unset.args, sourceMapUpload(SOURCE_MAP_ENV).args);
  assert.equal("POSTHOG_CLI_HOST" in unset.env, false);
  assert.equal(unset.env.POSTHOG_CLI_API_KEY, SOURCE_MAP_ENV.POSTHOG_CLI_API_KEY);
  assert.equal(unset.env.POSTHOG_CLI_PROJECT_ID, SOURCE_MAP_ENV.POSTHOG_CLI_PROJECT_ID);
  assert.equal(unset.env.PATH, "/bin");
  assert.equal(configured.env.POSTHOG_CLI_HOST, "https://eu.posthog.com");

  assert.throws(
    () => uploadSourceMaps(SOURCE_MAP_ENV, () => ({ status: 1 }), directories),
    /The source map upload failed with exit code 1/,
  );
});

test("the source map upload leaves PowerShell 7's module path out of the CLI's environment on Windows", () => {
  for (const name of ["PSModulePath", "PSMODULEPATH"]) {
    const env = { ...SOURCE_MAP_ENV, [name]: "C:\\Program Files\\PowerShell\\7\\Modules", PATH: "/bin" };
    const windows = sourceMapUpload(env, "win32").env;
    assert.equal(Object.keys(windows).some((key) => key.toUpperCase() === "PSMODULEPATH"), false);
    assert.equal(windows.PATH, "/bin");
    for (const platform of ["darwin", "linux"]) assert.equal(sourceMapUpload(env, platform).env[name], env[name]);
  }
});

test("a dry run installs and runs the CLI with the release's environment, and uploads nothing", async () => {
  const dryRun = { DOHC_SOURCE_MAPS_DRY_RUN: "true", DOHC_POSTHOG_KEY: "", POSTHOG_CLI_API_KEY: "", POSTHOG_CLI_HOST: "", PSModulePath: "C:\\Modules", PATH: "/bin" };
  const upload = sourceMapUpload(dryRun, "win32");
  assert.deepEqual(upload.args, ["dlx", "--allow-build=@posthog/cli", "@posthog/cli@0.18.10", "--version"]);
  assert.deepEqual(upload.env, { DOHC_SOURCE_MAPS_DRY_RUN: "true", DOHC_POSTHOG_KEY: "", POSTHOG_CLI_API_KEY: "", PATH: "/bin" });
  // The Mac's release passes its shell's environment on, so a DRY_RUN left there must not skip a real upload.
  assert.equal(sourceMapUpload({ ...SOURCE_MAP_ENV, DRY_RUN: "true" }).dryRun, undefined);

  // A dry run's build has no PostHog key, so its files carry no chunk ID.
  const directories = await builtDist({ injected: false });
  const calls = [];
  uploadSourceMaps(dryRun, (command, args) => { calls.push(args); return { status: 0 }; }, directories);
  assert.deepEqual(calls, [upload.args]);
  assert.throws(() => uploadSourceMaps(dryRun, () => ({ status: 1 }), directories), /failed with exit code 1/);
});

test("the source map upload fails when a script the reports name ships without its chunk ID", async () => {
  const directories = await builtDist({ injected: false });
  assert.deepEqual(scriptsWithoutChunkIds(directories).map((path) => path.replaceAll("\\", "/").split("/").at(-1)).sort(), [
    "app.js", "index-Cd34.js", "posthogErrors-Ab12.js",
  ]);
  assert.throws(
    () => uploadSourceMaps(SOURCE_MAP_ENV, () => ({ status: 0 }), directories),
    /These scripts carry no chunk ID[\s\S]*app\.js/,
  );
  assert.deepEqual(scriptsWithoutChunkIds(await builtDist({ injected: true })), []);
});

test("upload-desktop-source-maps skips without a PostHog key and fails without upload credentials when run as a command", async () => {
  const skipped = await runReleaseScript("upload-desktop-source-maps.mjs", [], {
    ...SOURCE_MAP_ENV,
    DOHC_POSTHOG_KEY: "",
    POSTHOG_CLI_API_KEY: "",
  });
  assert.match(skipped.stdout, /needs no source maps/);

  await assert.rejects(
    runReleaseScript("upload-desktop-source-maps.mjs", [], { ...SOURCE_MAP_ENV, POSTHOG_CLI_PROJECT_ID: "" }),
    (error) => error.code === 1 && /POSTHOG_CLI_PROJECT_ID is empty/.test(error.stderr),
  );
});

test("the release injects source maps for every build that names PostHog before packaging, and a dry run only runs the CLI", () => {
  const job = releaseWorkflow.jobs.build;
  const build = releaseStep(job, "pnpm build:desktop");
  const upload = releaseStep(job, "upload-desktop-source-maps.mjs");
  const packaging = releaseStep(job, "electron-builder");
  assert.equal(upload.if, undefined);
  assert.equal(upload.env.DOHC_SOURCE_MAPS_DRY_RUN, "${{ needs.preflight.outputs.dry_run }}");
  assert.equal(upload.run, "node scripts/upload-desktop-source-maps.mjs");
  // The upload sees the key and dist the build compiled in.
  for (const name of ["DOHC_POSTHOG_KEY", "DOHC_DESKTOP_DIST"]) {
    assert.ok(build.env[name], `the build sets ${name}`);
    assert.equal(upload.env[name], build.env[name], `the upload reads the build's ${name}`);
  }
  assert.match(build.env.DOHC_POSTHOG_KEY, /needs\.preflight\.outputs\.dry_run != 'true' && vars\.DOHC_POSTHOG_KEY/);
  assert.equal(upload.env.DESKTOP_VERSION, "${{ needs.preflight.outputs.version }}");
  assert.match(upload.env.POSTHOG_CLI_API_KEY, /needs\.preflight\.outputs\.dry_run != 'true' && secrets\.POSTHOG_CLI_API_KEY/);
  assert.ok(job.steps.indexOf(upload) > job.steps.indexOf(build), "the upload runs after the build writes the source maps");
  assert.ok(job.steps.indexOf(packaging) > job.steps.indexOf(upload), "the package ships the files the upload injected");
  for (const step of job.steps.slice(job.steps.indexOf(upload) + 1)) {
    assert.doesNotMatch(step.run ?? "", /build:desktop|electron-vite build/, `${step.name} must not rebuild the injected files`);
  }
});

test("the installer leaves out every source map", async () => {
  const builder = load(await readFile(new URL("../apps/desktop/electron-builder.yml", import.meta.url), "utf8"));
  assert.ok(builder.files.includes("dist/**"));
  assert.ok(builder.files.includes("!dist/**/*.map"));
});
// Writes the update manifest fields the verifier reads, as electron-builder lays them out.
function updateManifest({ version, files, path, sha512 }) {
  const quote = JSON.stringify;
  return [
    `version: ${quote(version)}`,
    "files:",
    ...files.flatMap(file => [`  - url: ${quote(file.url)}`, `    sha512: ${quote(file.sha512)}`, `    size: ${file.size}`]),
    `path: ${quote(path)}`,
    `sha512: ${quote(sha512)}`,
    "",
  ].join("\n");
}

async function artifactFixture(platform = "win", arch = "x64") {
  const directory = await mkdtemp(join(tmpdir(), "dohc-artifact-test-"));
  const version = "0.1.0";
  const extension = platform === "win" ? "exe" : platform === "mac" ? "zip" : "AppImage";
  const artifactArch = platform === "linux" && arch === "x64" ? "x86_64" : arch;
  const name = `dohc-${version}-${platform}-${artifactArch}.${extension}`;
  const bytes = Buffer.from("packaged artifact fixture");
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  await writeFile(join(directory, name), bytes);
  if (platform === "mac") await writeFile(join(directory, `dohc-${version}-mac-${arch}.dmg`), "dmg fixture");
  const files = [{ url: name, sha512, size: bytes.length }];
  // electron-builder lists both Linux packages in one manifest, the .deb under amd64.
  if (platform === "linux") {
    const deb = Buffer.from("deb package fixture");
    const debName = `dohc-${version}-linux-amd64.deb`;
    await writeFile(join(directory, debName), deb);
    files.push({ url: debName, sha512: createHash("sha512").update(deb).digest("base64"), size: deb.length });
  }
  const manifest = { version, files, path: name, sha512 };
  const manifestPath = join(directory, `latest${platform === "win" ? "" : `-${platform}`}.yml`);
  await writeFile(manifestPath, updateManifest(manifest));
  return { options: { directory, platform, arch, version, channel: "latest" }, name, manifest, manifestPath };
}

test("release verification hashes distributable files for each configured platform", async () => {
  for (const [platform, arch] of [["win", "x64"], ["linux", "x64"], ["mac", "arm64"]]) {
    const { options } = await artifactFixture(platform, arch);
    const result = await verifyDesktopReleaseArtifacts(options);
    assert.equal(result.status, "passed");
    assert.equal(result.artifacts.length, platform === "win" ? 1 : 2);
    assert.ok(result.excludes.includes("installation"));
  }
  // A Linux manifest that leaves out the .deb strands every .deb install on its version.
  const linux = await artifactFixture("linux", "x64");
  await writeFile(linux.manifestPath, updateManifest({ ...linux.manifest, files: linux.manifest.files.slice(0, 1) }));
  await assert.rejects(verifyDesktopReleaseArtifacts(linux.options), /does not list the x64 update artifact: dohc-0\.1\.0-linux-amd64\.deb/);
  const intel = await artifactFixture("mac", "x64");
  await assert.rejects(verifyDesktopReleaseArtifacts(intel.options), /Unsupported release target: mac-x64/);
});

test("release verification rejects changed bytes, version, and legacy updater metadata", async () => {
  const { options, name, manifest, manifestPath } = await artifactFixture();
  await assert.rejects(verifyDesktopReleaseArtifacts({ ...options, version: "0.2.0" }), /Manifest version/);
  await writeFile(manifestPath, updateManifest({ ...manifest, sha512: "incorrect" }));
  await assert.rejects(verifyDesktopReleaseArtifacts(options), /Manifest path and SHA-512/);
  await writeFile(manifestPath, updateManifest(manifest));
  await writeFile(join(options.directory, name), "different package bytes!");
  await assert.rejects(verifyDesktopReleaseArtifacts(options), /size or SHA-512/);
});

test("verify-desktop-release-artifacts reports its verdict when run as a command", async () => {
  const { options, name } = await artifactFixture();
  const args = Object.entries(options).flatMap(([key, value]) => [`--${key}`, value]);
  const { stdout } = await runReleaseScript("verify-desktop-release-artifacts.mjs", args);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "passed");
  assert.equal(result.version, options.version);
  assert.deepEqual(result.artifacts.map((artifact) => artifact.name), [name]);

  await writeFile(join(options.directory, name), "different package bytes!");
  await assert.rejects(
    runReleaseScript("verify-desktop-release-artifacts.mjs", args),
    (error) => error.code === 1 && /size or SHA-512/.test(error.stderr),
  );
});

test("release verification rejects missing installers and wrong update architecture", async () => {
  const fixture = await artifactFixture("mac", "arm64");
  await rm(join(fixture.options.directory, "dohc-0.1.0-mac-arm64.dmg"));
  await assert.rejects(verifyDesktopReleaseArtifacts(fixture.options), /ENOENT/);
  const win = await artifactFixture();
  const alternate = "other.exe";
  await writeFile(join(win.options.directory, alternate), await readFile(join(win.options.directory, win.name)));
  const manifest = { ...win.manifest, files: [{ ...win.manifest.files[0], url: alternate }], path: alternate };
  await writeFile(win.manifestPath, updateManifest(manifest));
  await assert.rejects(verifyDesktopReleaseArtifacts(win.options), /does not list the x64 update artifact/);
});

test("release verification rejects artifact paths outside the release directory", async () => {
  const { options, name, manifest, manifestPath } = await artifactFixture();
  for (const url of ["../outside.exe", "https://example.com/installer.exe", "..%2Foutside.exe"]) {
    await writeFile(manifestPath, updateManifest({ ...manifest, files: [{ ...manifest.files[0], url }] }));
    await assert.rejects(verifyDesktopReleaseArtifacts(options), /local filename/);
  }
  const outside = await mkdtemp(join(tmpdir(), "dohc-artifact-outside-"));
  await writeFile(join(outside, name), "outside");
  await rm(join(options.directory, name));
  // Containment must fail before the file-type check; Windows junctions need no symlink privilege.
  await symlink(outside, join(options.directory, name), process.platform === "win32" ? "junction" : "dir");
  await writeFile(manifestPath, updateManifest(manifest));
  await assert.rejects(verifyDesktopReleaseArtifacts(options), /escapes its directory/);
});

const RELEASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const MAIN_COMMIT = "9".repeat(40);
const HEAD_COMMIT = "e".repeat(40);
const IDENTITY = "Developer ID Application: Example Maker (TEAM123456)";
const KEYCHAIN = "/Users/maker/Library/Keychains/dohc-release.keychain-db";
const NIGHTLY_TAG = "v0.1.1-nightly.20261019.42.1";
const PREFLIGHT_START = "2026-10-19T04:00:00Z";
const lines = values => values.map(value => JSON.stringify(value)).join("\n") + "\n";
const publishJobs = (overrides = {}) => ({
  "gh api --paginate repos/dohchq/dohc/actions/runs/7/jobs": { stdout: lines([
    { name: "Preflight", conclusion: "success", run_attempt: 1, head_sha: RELEASE_COMMIT, started_at: PREFLIGHT_START },
    { name: "Publish", conclusion: "success", run_attempt: 1, head_sha: RELEASE_COMMIT, ...overrides },
  ]) },
});

// Answers the commands the Mac release preflight runs, by longest matching prefix.
function fakeMac(answers = {}) {
  const calls = [];
  const table = {
    "gh release view": { stdout: JSON.stringify({ isDraft: false, isPrerelease: true, assets: [{ name: "nightly.yml" }, { name: "nightly-linux.yml" }] }) },
    "gh api repos/dohchq/dohc/commits/refs/tags/": { stdout: `${RELEASE_COMMIT}\n` },
    "gh api repos/dohchq/dohc/git/ref/heads/main": { stdout: `${MAIN_COMMIT}\n` },
    "gh api --paginate repos/dohchq/dohc/actions/workflows/desktop-release.yml/runs": { stdout: lines([{ id: 7, run_number: 42, event: "workflow_dispatch" }]) },
    ...publishJobs(),
    "gh api repos/dohchq/dohc/compare/": { stdout: "ahead\n" },
    "gh api repos/dohchq/dohc --jq .permissions.push": { stdout: "true\n" },
    "git rev-parse HEAD": { stdout: `${HEAD_COMMIT}\n` },
    "git status --porcelain": { stdout: "" },
    "security find-certificate -a -c Developer ID Application -Z": { stdout: `SHA-256 hash: ${"C".repeat(64)}\nSHA-1 hash: ${"A".repeat(40)}\nkeychain: "${KEYCHAIN}"\n` },
    "security find-generic-password -a com.apple.gke.notary.tool.saved-creds.": { stdout: "" },
    "gh variable list": { stdout: JSON.stringify([{ name: "DOHC_POSTHOG_KEY", value: "phc_abcdefghij0123456789" }, { name: "POSTHOG_CLI_PROJECT_ID", value: "42" }]) },
    "security find-generic-password -s dohc-posthog-cli-api-key": { stdout: "" },
    "security find-generic-password -s dohc-posthog-cli-api-key -w": { stdout: "phx_fixture\n" },
    "security find-generic-password -s dohc-release-keychain-password": { status: 44, stderr: "The specified item could not be found in the keychain." },
    "security find-identity -v -p codesigning": { stdout: `  1) ${"A".repeat(40)} "${IDENTITY}"\n     1 valid identities found\n` },
    "xcrun notarytool history --keychain-profile": { stdout: "{\"history\":[]}" },
    ...answers,
  };
  const run = (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    const prefix = Object.keys(table).filter(candidate => line.startsWith(candidate)).sort((a, b) => b.length - a.length)[0];
    if (!prefix) throw new Error(`The release ran an unexpected command: ${line}`);
    return { status: 0, stdout: "", stderr: "", ...table[prefix] };
  };
  return { run, calls };
}

const nightlyArgs = ["--version", NIGHTLY_TAG, "--channel", "nightly", "--keychain", KEYCHAIN];
const releaseWith = (assets, extra = {}) => ({ "gh release view": { stdout: JSON.stringify({ isDraft: false, isPrerelease: true, assets: assets.map(name => ({ name })), ...extra }) } });
const macHost = (extra = {}) => ({ platform: "darwin", arch: "arm64", keychainStatus: () => 2, ...extra });
const stableRelease = { ...releaseWith(["latest.yml"], { isPrerelease: false }), "gh api --paginate repos/dohchq/dohc/actions/workflows/desktop-release.yml/runs": { stdout: lines([{ id: 7, run_number: 3, event: "workflow_dispatch" }]) } };

test("the Mac release command reads its release from a version or tag and a channel", () => {
  assert.deepEqual(parseMacReleaseArgs(["--", "--version", NIGHTLY_TAG, "--channel", "nightly"]), {
    version: "0.1.1-nightly.20261019.42.1", channel: "nightly", keychain: DEFAULT_KEYCHAIN, keychainProfile: "dohc-notary", dryRun: false, rehearse: false,
  });
  assert.equal(DEFAULT_KEYCHAIN, join(homedir(), "Library/Keychains/dohc-release.keychain-db"));
  assert.equal(parseMacReleaseArgs(["--version", "0.1.0", "--channel", "latest", "--keychain-profile", "notary"]).keychainProfile, "notary");
  for (const args of [[], ["--version", "0.1.0"], ["--version", "0.1.0", "--channel", "stable"], [...nightlyArgs, "--sign"]]) {
    assert.throws(() => parseMacReleaseArgs(args), /pnpm release:macos/);
  }
  assert.throws(() => parseMacReleaseArgs([...nightlyArgs, "--rehearse"]), /needs --dry-run/);
});

test("the Mac release relies on the workflow's Publish job running only after Preflight passes on refs/heads/main", () => {
  const { jobs } = releaseWorkflow;
  assert.equal(jobs.publish.name, PUBLISH_JOB);
  assert.equal(jobs.preflight.name, PREFLIGHT_JOB);
  assert.equal(jobs.preflight.if, "github.ref == 'refs/heads/main'");
  for (const job of [jobs.publish, jobs.build]) assert.ok([job.needs].flat().includes("preflight"), "Publish runs only after Preflight");
  assert.ok([jobs.publish.needs].flat().includes("build"));
});

test("the Mac release preflight ties the tag to a dispatched run's Publish job on the main branch, and leaves the keychain locked", async () => {
  const fake = fakeMac();
  const plan = await preflightMacRelease(parseMacReleaseArgs(nightlyArgs), { run: fake.run, ...macHost() });
  assert.equal(plan.commit, RELEASE_COMMIT);
  assert.equal(plan.buildCommit, RELEASE_COMMIT, "a release builds the commit its run published");
  assert.equal(plan.state.kind, "fresh");
  assert.equal(plan.signs, true, "a locked release keychain is ready for a release");
  assert.equal(plan.reporting.POSTHOG_CLI_API_KEY, undefined, "the PostHog key is read only after unlocking");
  for (const call of [
    `gh api --paginate repos/dohchq/dohc/actions/workflows/desktop-release.yml/runs?head_sha=${RELEASE_COMMIT}&event=workflow_dispatch&per_page=100 --jq .workflow_runs[] | {id, run_number, event}`,
    "gh api --paginate repos/dohchq/dohc/actions/runs/7/jobs?filter=all&per_page=100 --jq .jobs[] | {name, conclusion, run_attempt, head_sha, started_at}",
    `gh api repos/dohchq/dohc/compare/${RELEASE_COMMIT}...${MAIN_COMMIT} --jq .status`,
    `gh api repos/dohchq/dohc/compare/${HEAD_COMMIT}...${MAIN_COMMIT} --jq .status`,
    `security find-certificate -a -c Developer ID Application -Z ${KEYCHAIN}`,
    `security find-generic-password -a com.apple.gke.notary.tool.saved-creds.dohc-notary ${KEYCHAIN}`,
    `security find-generic-password -s dohc-posthog-cli-api-key ${KEYCHAIN}`,
  ]) assert.ok(fake.calls.includes(call), call);
  assert.ok(!fake.calls.some(call => /find-identity|notarytool|-w /.test(call)), "nothing that needs the unlocked keychain runs before the build");
  assert.ok(!fake.calls.some(call => /compare\/[0-9a-f]+\.\.\.main/.test(call)), "a tag named main cannot stand in for the branch");

  const stable = await preflightMacRelease(parseMacReleaseArgs(["--version", "v0.1.0", "--channel", "latest", "--keychain", KEYCHAIN]), {
    run: fakeMac({ ...stableRelease, ...publishJobs({ run_attempt: 2 }) }).run, ...macHost(),
  });
  assert.equal(stable.version, "0.1.0");
});

test("the Mac release preflight refuses another host, a release it cannot read, and a tag no dispatched run on main published", async () => {
  const preflight = (answers = {}, host = {}, args = nightlyArgs) =>
    preflightMacRelease(parseMacReleaseArgs(args), { run: fakeMac(answers).run, ...macHost(host) });
  for (const host of [{ arch: "x64" }, { platform: "linux" }]) {
    await assert.rejects(preflight({}, { ...host, run: () => assert.fail("no command runs on another host") }), /Apple silicon with arm64 Node/);
  }
  await assert.rejects(preflight({ "gh release view": { status: 1, stderr: "release not found" } }), /has no release v0\.1\.1-nightly\.20261019\.42\.1: release not found/);
  await assert.rejects(preflight(releaseWith([], { isDraft: true })), /still a draft/);
  await assert.rejects(preflight(releaseWith([], { isPrerelease: false })), /not on the nightly channel/);
  await assert.rejects(preflight({}, {}, ["--version", NIGHTLY_TAG, "--channel", "latest"]), /not a latest version/);
  const unpublished = /no dispatched Desktop Release run 42, attempt 1, published that commit from main/;
  // A run dispatched on a tag named main reports head_branch main, but skips Preflight and so Publish.
  await assert.rejects(preflight(publishJobs({ conclusion: "skipped" })), unpublished);
  await assert.rejects(preflight({ "gh api --paginate repos/dohchq/dohc/actions/workflows/desktop-release.yml/runs": { stdout: lines([{ id: 7, run_number: 42, event: "push" }]) } }), unpublished);
  await assert.rejects(preflight({ "gh api --paginate repos/dohchq/dohc/actions/workflows/desktop-release.yml/runs": { stdout: lines([{ id: 7, run_number: 41, event: "workflow_dispatch" }]) } }), unpublished);
  await assert.rejects(preflight(publishJobs({ run_attempt: 2 })), unpublished);
  await assert.rejects(preflight(publishJobs({ head_sha: "f".repeat(40) })), unpublished);
  await assert.rejects(preflight({ ...stableRelease, ...publishJobs({ conclusion: "skipped" }) }, {}, ["--version", "0.1.0", "--channel", "latest"]),
    /no dispatched Desktop Release run published that commit from main/);
  await assert.rejects(preflight({ [`gh api repos/dohchq/dohc/compare/${RELEASE_COMMIT}`]: { stdout: "diverged\n" } }), new RegExp(`${RELEASE_COMMIT}, the commit of ${NIGHTLY_TAG.replaceAll(".", "\\.")}, is not on main at ${MAIN_COMMIT}`));
});

test("the Mac release preflight accepts a nightly that a re-run of its failed jobs published", async () => {
  // Each attempt gives its Preflight's start time and its Publish job's conclusion.
  const attempts = (...list) => ({
    "gh api --paginate repos/dohchq/dohc/actions/runs/7/jobs": { stdout: lines(list.flatMap(([startedAt, publish], index) => [
      { name: "Preflight", conclusion: "success", run_attempt: index + 1, head_sha: RELEASE_COMMIT, started_at: startedAt },
      { name: "Publish", conclusion: publish, run_attempt: index + 1, head_sha: RELEASE_COMMIT },
    ])) },
  });
  const preflight = (answers, tag = NIGHTLY_TAG) =>
    preflightMacRelease(parseMacReleaseArgs(["--version", tag, "--channel", "nightly", "--keychain", KEYCHAIN]), { run: fakeMac(answers).run, ...macHost() });
  const unpublished = attempt => new RegExp(`no dispatched Desktop Release run 42, attempt ${attempt}, published that commit from main`);
  // Later attempts kept attempt 1's Preflight, so they published the version attempt 1 stamped.
  assert.equal((await preflight(attempts([PREFLIGHT_START, "skipped"], [PREFLIGHT_START, "success"]))).commit, RELEASE_COMMIT);
  assert.equal((await preflight(attempts([PREFLIGHT_START, "skipped"], [PREFLIGHT_START, "failure"], [PREFLIGHT_START, "success"]))).commit, RELEASE_COMMIT);
  // Attempt 2 ran its own Preflight, so it published its own version.
  await assert.rejects(preflight(attempts([PREFLIGHT_START, "skipped"], ["2026-10-19T05:00:00Z", "success"])), unpublished(1));
  // Without start times, nothing shows that attempt 2 kept attempt 1's Preflight.
  await assert.rejects(preflight(attempts([null, "skipped"], [null, "success"])), unpublished(1));
  // Attempt 2 kept attempt 1's Preflight and stamped no version of its own, so nothing published a tag that names it.
  await assert.rejects(preflight(attempts([PREFLIGHT_START, "success"], [PREFLIGHT_START, "failure"]), "v0.1.1-nightly.20261019.42.2"), unpublished(2));
});

test("a real Mac release runs only from a clean checkout on main, and a dry run says where it runs from", async () => {
  const preflight = (answers, args = nightlyArgs) => preflightMacRelease(parseMacReleaseArgs(args), { run: fakeMac(answers).run, ...macHost() });
  await assert.rejects(preflight({ "git status --porcelain": { stdout: " M scripts/release-desktop-macos.mjs\n" } }), /uncommitted changes:\n M scripts\/release-desktop-macos\.mjs\nA real release runs from a clean checkout on main/);
  const unpushed = { [`gh api repos/dohchq/dohc/compare/${HEAD_COMMIT}`]: { status: 1, stderr: "Not Found" } };
  await assert.rejects(preflight(unpushed), new RegExp(`is at ${HEAD_COMMIT}, which is not on main`));
  await assert.rejects(preflight({ "gh api repos/dohchq/dohc --jq .permissions.push": { stdout: "false\n" } }), /cannot upload/);
  const dry = await preflight({ ...unpushed, "git status --porcelain": { stdout: "?? notes.md\n" } }, [...nightlyArgs, "--dry-run"]);
  assert.deepEqual(dry.notices, [`A dry run runs from any checkout. This one is at ${HEAD_COMMIT}, not on main, with uncommitted changes.`]);
});

test("the Mac release preflight finishes only an upload it can prove, and refuses other Mac files with the commands that clear them", async () => {
  const workRoot = await mkdtemp(join(tmpdir(), "dohc-mac-release-work-"));
  const names = macFileNames("0.1.1-nightly.20261019.42.1", "nightly");
  const preflight = (assets, host = {}) => preflightMacRelease(parseMacReleaseArgs(nightlyArgs), { workRoot, run: fakeMac(releaseWith(assets)).run, ...macHost(host) });
  // A release whose Mac manifest is out may already update Macs, so the command never suggests deleting its files.
  for (const assets of [[names.zip, names.dmg, names.blockmap, names.manifest], [names.manifest, "dohc-0.1.1-nightly.20261019.42.1-mac-x64.zip"]]) {
    await assert.rejects(preflight(["nightly.yml", ...assets]), (error) => /already has its macOS files, including nightly-mac\.yml\. There is nothing to add/.test(error.message) && !/delete-asset/.test(error.message));
  }
  const x64 = "dohc-0.1.1-nightly.20261019.42.1-mac-x64.dmg";
  await assert.rejects(preflight([names.zip, x64]), new RegExp(`cannot finish[\\s\\S]*gh release delete-asset ${NIGHTLY_TAG} ${names.zip.replaceAll(".", "\\.")} -R dohchq/dohc --yes\\n  gh release delete-asset ${NIGHTLY_TAG} ${x64.replaceAll(".", "\\.")}`));
  await assert.rejects(preflight([names.zip, names.dmg]), /part of an upload[\s\S]*does not hold the files that run built[\s\S]*delete-asset/);

  const saved = join(workRoot, NIGHTLY_TAG, "files");
  await mkdir(saved, { recursive: true });
  for (const name of Object.values(names)) await writeFile(join(saved, name), name);
  // Finishing an upload signs nothing, so it does not need the release keychain.
  const plan = await preflight([names.zip, names.dmg], { keychainStatus: () => assert.fail("finishing an upload reads no keychain") });
  assert.deepEqual(plan.state, { kind: "resume", present: [names.zip, names.dmg] });
  assert.equal(plan.signs, false);
});

test("a new Mac release refuses a missing release keychain, or one without one certificate, the notarytool profile, or the PostHog key", async () => {
  const preflight = (answers = {}, host = {}, args = nightlyArgs) =>
    preflightMacRelease(parseMacReleaseArgs(args), { run: fakeMac(answers).run, ...macHost(host) });
  await assert.rejects(preflight({}, { keychainStatus: () => -25294 }), new RegExp(`release keychain ${KEYCHAIN} does not exist`));
  const certificates = count => ({ "security find-certificate -a -c Developer ID Application -Z": { stdout: `SHA-1 hash: ${"A".repeat(40)}\n`.repeat(count) } });
  for (const count of [0, 2]) await assert.rejects(preflight(certificates(count)), new RegExp(`holds ${count} Developer ID Application certificates`));
  await assert.rejects(preflight({ "security find-generic-password -a com.apple.gke.notary.tool.saved-creds.": { status: 44 } }, {}, [...nightlyArgs, "--keychain-profile", "other"]),
    /no notarytool profile other/);
  await assert.rejects(preflight({ "security find-generic-password -s dohc-posthog-cli-api-key": { status: 44 } }), /dohc-posthog-cli-api-key in the release keychain/);
  const unreported = fakeMac({ "gh variable list": { stdout: "[]" } });
  await preflightMacRelease(parseMacReleaseArgs(nightlyArgs), { run: unreported.run, ...macHost() });
  assert.ok(!unreported.calls.some(call => call.startsWith("security find-generic-password -s")), "a release that reports nothing needs no PostHog key");

  // A dry run builds unsigned and reports nothing, so a locked or missing keychain cannot stop it.
  const dry = fakeMac();
  const dryPlan = await preflightMacRelease(parseMacReleaseArgs([...nightlyArgs, "--dry-run"]), {
    run: dry.run, ...macHost({ keychainStatus: () => assert.fail("a dry run reads no keychain") }),
  });
  assert.deepEqual(signingEnvironment(dryPlan), { CSC_IDENTITY_AUTO_DISCOVERY: "false" });
  assert.ok(!dry.calls.some(call => /^(security|xcrun|gh variable)/.test(call)), "a dry run reads no signing, notarization, or reporting credential");
});

test("the release keychain unlocks through security in a terminal, and otherwise the command waits up to 30 minutes", async () => {
  const plan = { keychain: KEYCHAIN };
  const statuses = values => () => values.length > 1 ? values.shift() : values[0];
  const steps = [];
  const step = async (command, args) => { steps.push([command, ...args].join(" ")); };
  const locks = [];
  const run = (command, args) => {
    if (args[0] === "find-generic-password") return { status: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
    locks.push([command, ...args].join(" "));
    return { status: 0, stdout: "", stderr: "" };
  };
  const unlock = (keychainStatus, options = {}, relock = false) =>
    unlockReleaseKeychain(plan, "Packaging", { keychainStatus, step, run, interactive: true, cancelled: () => false, ...options }, { relock });
  await unlock(statuses([7]));
  assert.deepEqual(steps, [], "an open keychain needs nothing before the build");
  await unlock(statuses([2, 7]));
  assert.deepEqual(steps, [`security unlock-keychain ${KEYCHAIN}`]);
  await assert.rejects(unlock(statuses([2])), /still locked/);

  // Before packaging, a keychain someone opened early was open while other code ran.
  steps.length = 0;
  await unlock(statuses([7, 7]), {}, true);
  assert.deepEqual(locks, [`security lock-keychain ${KEYCHAIN}`]);
  assert.deepEqual(steps, [`security unlock-keychain ${KEYCHAIN}`], "it locks the keychain, then unlocks it the usual way");
  await assert.rejects(unlockReleaseKeychain(plan, "Packaging", { keychainStatus: statuses([7]), step, run: () => ({ status: 1, stdout: "", stderr: "denied" }), interactive: true, cancelled: () => false }, { relock: true }),
    /Could not lock the release keychain: denied/);

  let clock = 0;
  const waits = [];
  const wait = async ms => { waits.push(ms); clock += ms; };
  await unlock(statuses([2, 2, 2, 7]), { interactive: false, wait, now: () => clock });
  assert.deepEqual(waits, [5000, 5000]);
  clock = 0;
  await assert.rejects(unlock(statuses([2]), { interactive: false, wait, now: () => clock }), /stayed locked for 30 minutes/);
  assert.equal(clock, UNLOCK_WAIT_MS);
  await assert.rejects(unlock(statuses([2]), { interactive: false, cancelled: () => true, wait, now: () => 0 }), /Stopped while waiting/);
});

test("a password saved in the login keychain unlocks the release keychain without anyone at the Mac", async () => {
  const plan = { keychain: KEYCHAIN };
  let open = false;
  let saved = 'keychain: "/Users/maker/Library/Keychains/login.keychain-db"\npassword: "pass "word" %s"\n';
  const calls = [];
  const unlocks = [];
  const keychain = {
    keychainStatus: () => (open ? 7 : 2),
    step: async () => assert.fail("nobody is asked for the password"),
    run: (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "lock-keychain") open = false;
      return { status: 0, stdout: "", stderr: saved };
    },
    interactive: true,
    cancelled: () => false,
    wait: async () => assert.fail("nothing waits for someone to unlock the keychain"),
    unlockWith: (path, password) => { unlocks.push([path, password.toString()]); open = true; return { status: 0, stderr: "" }; },
  };
  const lookup = `security find-generic-password -s ${SAVED_PASSWORD_SERVICE} -g`;
  await unlockReleaseKeychain(plan, "Checking the signing identity", keychain);
  assert.deepEqual(calls, [lookup]);
  assert.deepEqual(unlocks, [[KEYCHAIN, 'pass "word" %s']], "a quoted password passes as saved");

  // Before packaging, an open keychain is locked, then unlocked with the saved password again.
  calls.length = 0;
  await unlockReleaseKeychain(plan, "Packaging", keychain, { relock: true });
  assert.deepEqual(calls, [`security lock-keychain ${KEYCHAIN}`, lookup]);
  assert.equal(unlocks.length, 2);
  assert.equal(open, true);

  // security prints a password with a backslash, a control character, or non-ASCII text as hex.
  open = false;
  saved = 'password: 0x70C3A4737377C3B67264  "p\\303\\244ssw\\303\\266rd"\n';
  await unlockReleaseKeychain(plan, "Packaging", keychain);
  assert.deepEqual(unlocks.at(-1), [KEYCHAIN, "pässwörd"]);
  open = false;
  saved = "password: 0xC3A4 \n";
  await unlockReleaseKeychain(plan, "Packaging", keychain);
  assert.deepEqual(unlocks.at(-1), [KEYCHAIN, "ä"], "hex with no printable character has no quoted form");
  open = false;
  saved = "password: \n";
  await unlockReleaseKeychain(plan, "Packaging", keychain);
  assert.deepEqual(unlocks.at(-1), [KEYCHAIN, ""], "an empty password");
  open = false;
  saved = 'password: "0x41  "A""\n';
  await unlockReleaseKeychain(plan, "Packaging", keychain);
  assert.deepEqual(unlocks.at(-1), [KEYCHAIN, '0x41  "A"'], "a quoted password that looks like hex stays as typed");

  open = false;
  saved = 'keychain: "/Users/maker/Library/Keychains/login.keychain-db"\n';
  await assert.rejects(unlockReleaseKeychain(plan, "Packaging", keychain), /did not unlock the release keychain: security printed no password/);
  saved = 'password: "pass"\n';
  await assert.rejects(
    unlockReleaseKeychain(plan, "Packaging", { ...keychain, unlockWith: () => ({ status: 51, stderr: "The user name or passphrase you entered is not correct." }) }),
    /dohc-release-keychain-password in the login keychain did not unlock the release keychain: The user name or passphrase/,
  );
  await assert.rejects(unlockReleaseKeychain(plan, "Packaging", { ...keychain, unlockWith: () => ({ status: 0, stderr: "" }) }), /did not unlock the release keychain/,
    "a keychain that stays locked fails even when security reports success");
});

// The fake security is a POSIX shell script. The unlock it stands in for runs only on macOS.
test("the saved password reaches security on its input, in a session of its own, and never in its arguments", { skip: process.platform === "win32" }, async t => {
  const bin = await mkdtemp(join(tmpdir(), "dohc-security-"));
  const record = join(bin, "record");
  // A session leader's process group is its own process ID, and a new session has no terminal.
  await writeFile(join(bin, "security"), `#!/bin/sh
printf '%s\\n' "$*" > "${record}"
[ "$(ps -o pgid= -p $$ | tr -d ' ')" = "$$" ] && ! (true < /dev/tty) 2>/dev/null && echo own-session >> "${record}"
cat >> "${record}"
`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => { process.env.PATH = path; });
  const password = 'pass "word" \\ %s';
  await unlockReleaseKeychain({ keychain: KEYCHAIN }, "Packaging", {
    keychainStatus: () => (existsSync(record) ? 7 : 2),
    run: () => ({ status: 0, stdout: "", stderr: `password: 0x${Buffer.from(password).toString("hex").toUpperCase()}  "escaped"\n` }),
    step: async () => assert.fail("nobody is asked for the password"),
    interactive: true,
    cancelled: () => false,
  });
  assert.equal(readFileSync(record, "utf8"), `unlock-keychain ${KEYCHAIN}\nown-session\n${password}\n`);
});

test("the Mac release command and the nightly job load only tracked files and Node's own modules, and upload to the repository the updater reads", async () => {
  const seen = new Set();
  const visit = async path => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const [, specifier] of (await readFile(path, "utf8")).matchAll(/^\s*import\s(?:[^;]*?\sfrom\s)?"([^"]+)"/gm)) {
      if (specifier.startsWith(".")) await visit(fileURLToPath(new URL(specifier, pathToFileURL(path))));
      else assert.match(specifier, /^node:/, `${path} imports ${specifier} from node_modules`);
    }
  };
  // The nightly job runs from a clean clone of main, which has no node_modules.
  await visit(fileURLToPath(new URL("./release-desktop-macos.mjs", import.meta.url)));
  await visit(fileURLToPath(new URL("./release-nightly.mjs", import.meta.url)));
  assert.ok(seen.size > 1);
  const { publish } = load(await readFile(new URL("../apps/desktop/electron-builder.yml", import.meta.url), "utf8"));
  assert.equal(RELEASE_REPOSITORY, `${publish.owner}/${publish.repo}`);
});

test("after unlocking, signing needs one valid identity, a profile that signs in, and the PostHog key", async () => {
  const plan = { keychain: KEYCHAIN, keychainProfile: "dohc-notary", signs: true, reporting: { DOHC_POSTHOG_KEY: "phc_abcdefghij0123456789" } };
  const signing = unlockedSigning(plan, fakeMac().run);
  assert.deepEqual(signingEnvironment(signing), {
    CSC_KEYCHAIN: KEYCHAIN, CSC_NAME: "Example Maker (TEAM123456)", APPLE_KEYCHAIN: KEYCHAIN, APPLE_KEYCHAIN_PROFILE: "dohc-notary",
  });
  assert.equal(signing.reporting.POSTHOG_CLI_API_KEY, "phx_fixture");
  const two = `  1) ${"A".repeat(40)} "${IDENTITY}"\n  2) ${"B".repeat(40)} "Developer ID Application: Other (TEAM654321)"\n`;
  for (const stdout of ["     0 valid identities found\n", two]) {
    assert.throws(() => unlockedSigning(plan, fakeMac({ "security find-identity -v -p codesigning": { stdout } }).run), /valid Developer ID Application identities/);
  }
  assert.throws(() => unlockedSigning(plan, fakeMac({ "xcrun notarytool history --keychain-profile": { status: 69 } }).run), /dohc-notary cannot sign in/);
});

test("the Mac release stamps the version the workflow stamped for the commit's package version", async () => {
  await assertWorkflowVersion({ version: "0.1.1-nightly.20261019.42.1", channel: "nightly", commit: RELEASE_COMMIT }, "0.1.0");
  await assert.rejects(assertWorkflowVersion({ version: "0.1.1-nightly.20261019.42.1", channel: "nightly", commit: RELEASE_COMMIT }, "0.2.0"), /stamps 0\.2\.1-nightly\.20261019\.42\.1, not 0\.1\.1/);
  await assertWorkflowVersion({ version: "0.1.0", channel: "latest", commit: RELEASE_COMMIT }, "0.1.0");
  await assert.rejects(assertWorkflowVersion({ version: "0.1.0", channel: "latest", commit: RELEASE_COMMIT }, "0.1.1"), /must match apps\/desktop\/package\.json/);
});

test("Mac packaging signs and notarizes only a real release, from the release keychain alone, and keeps the DMG out of the update manifest", () => {
  const real = electronBuilderArgs({ channel: "nightly", signs: true });
  const dry = electronBuilderArgs({ channel: "nightly", signs: false });
  for (const args of [real, dry]) {
    for (const arg of ["--mac", "--arm64", "-c.publish.channel=nightly", "-c.dmg.writeUpdateInfo=false"]) assert.ok(args.includes(arg), arg);
    assert.equal(args[args.indexOf("--publish") + 1], "never", "packaging cannot publish directly");
  }
  for (const arg of ["-c.forceCodeSigning=true", "-c.dmg.sign=true"]) {
    assert.ok(real.includes(arg), `a release passes ${arg}`);
    assert.ok(!dry.includes(arg), `a dry run leaves out ${arg}`);
  }
  assert.ok(dry.includes("-c.mac.identity=null"));
  assert.ok(!real.includes("-c.mac.identity=null"));

  const inherited = { PATH: "/usr/bin", CSC_LINK: "cert.p12", CSC_KEY_PASSWORD: "x", APPLE_ID: "a@b", APPLE_APP_SPECIFIC_PASSWORD: "x", APPLE_TEAM_ID: "T", WIN_CSC_LINK: "w", POSTHOG_CLI_API_KEY: "k", DOHC_POSTHOG_KEY: "phc" };
  assert.deepEqual(releaseEnvironment(inherited, { CSC_NAME: "Example Maker (TEAM123456)" }), { PATH: "/usr/bin", CSC_NAME: "Example Maker (TEAM123456)" });

  const paths = { app: "/r/mac-arm64/dohc.app", dmg: "/r/dohc.dmg" };
  const line = ([command, args]) => [command, ...args].join(" ");
  assert.deepEqual(signatureChecks({ ...paths, signs: true }).map(line), [
    "codesign --verify --deep --strict --verbose=2 /r/mac-arm64/dohc.app",
    "spctl --assess --type execute --verbose=4 /r/mac-arm64/dohc.app",
    "xcrun stapler validate /r/mac-arm64/dohc.app",
    "xcrun stapler validate /r/dohc.dmg",
  ]);
  assert.deepEqual(signatureChecks({ ...paths, signs: false }).map(line), ["codesign --verify --deep --strict --verbose=2 /r/mac-arm64/dohc.app"]);
});

// The four files a Mac release uploads, as electron-builder lays them out, and the plan that uploads them.
async function macReleaseFiles() {
  const fixture = await artifactFixture("mac", "arm64");
  const { directory } = fixture.options;
  await writeFile(join(directory, `${fixture.name}.blockmap`), "blockmap fixture");
  const names = macFileNames("0.1.0", "latest");
  const workDir = await mkdtemp(join(tmpdir(), "dohc-mac-release-run-"));
  const plan = { tag: "v0.1.0", version: "0.1.0", repo: "dohchq/dohc", channel: "latest", names, savedFiles: directory, workDir, dryRun: false };
  return { plan, directory, names, files: await macUploadPlan(directory, names), manifestPath: fixture.manifestPath, manifest: fixture.manifest };
}
const uploaded = files => files.map(file => ({ name: file.name, state: "uploaded", size: file.size, digest: `sha256:${file.sha256}` }));

test("a Mac release uploads its update manifest after every file it names, and confirms GitHub's sizes and digests", async () => {
  const { plan, files, names } = await macReleaseFiles();
  assert.deepEqual(files.map(file => file.name), [names.zip, names.dmg, names.blockmap, names.manifest]);
  const [binaries, manifest] = uploadCommands(plan, files);
  assert.deepEqual(binaries, ["gh", ["release", "upload", "v0.1.0", "-R", "dohchq/dohc", ...files.slice(0, -1).map(file => file.path)]]);
  assert.deepEqual(manifest, ["gh", ["release", "upload", "v0.1.0", "-R", "dohchq/dohc", files[3].path]]);
  assert.deepEqual(uploadCommands(plan, files.slice(2)).map(([, args]) => args.slice(5)), [[files[2].path], [files[3].path]]);
  assert.deepEqual(macAssetNames(files.map(({ name }) => ({ name }))), files.map(file => file.name));
  assert.deepEqual(macAssetNames([{ name: "latest.yml" }, { name: "latest-linux.yml" }, { name: "dohc-0.1.0-win-x64.exe" }]), []);

  assert.doesNotThrow(() => confirmUploaded([{ name: "latest.yml" }, ...uploaded(files)], files));
  assert.throws(() => confirmUploaded(uploaded(files).slice(1), files), /dohc-0\.1\.0-mac-arm64\.zip\./);
  assert.throws(() => confirmUploaded(uploaded(files).map((asset, index) => index === 3 ? { ...asset, digest: "sha256:00" } : asset), files), /latest-mac\.yml/);
});

test("a rerun finishes a stopped Mac upload only when the uploaded files are the ones it kept", async () => {
  const { plan, files, names, directory } = await macReleaseFiles();
  const download = async () => join(directory, names.zip);
  assert.deepEqual(await filesToUpload(plan, [{ name: "latest.yml" }], files, download), files);
  const partial = uploaded(files).slice(0, 2);
  assert.deepEqual((await filesToUpload(plan, partial, files, download)).map(file => file.name), [names.blockmap, names.manifest]);

  const recovery = /To start again, delete them[\s\S]*gh release delete-asset v0\.1\.0 dohc-0\.1\.0-mac-arm64\.zip -R dohchq\/dohc --yes/;
  for (const asset of [{ digest: "sha256:00" }, { size: 1 }, { state: "starter" }]) {
    await assert.rejects(filesToUpload(plan, [{ ...partial[0], ...asset }, partial[1]], files, download), recovery);
  }
  const other = join(directory, "other.zip");
  await writeFile(other, "other bytes");
  await assert.rejects(filesToUpload(plan, partial, files, async () => other), /ZIP on release v0\.1\.0 does not have the SHA-512 that latest-mac\.yml names/);
  await assert.rejects(filesToUpload(plan, uploaded(files), files, download), /already has its macOS files/);
});

test("a rerun checks the kept files as the stopped run did: the artifact verifier, then the signatures and tickets", async () => {
  const { plan, directory, names, manifestPath, manifest } = await macReleaseFiles();
  const steps = [];
  await verifyKeptFiles(plan, async (command, args) => { steps.push([command, ...args].join(" ")); });
  const app = join(plan.workDir, "kept-app/dohc.app");
  assert.deepEqual(steps, [
    `ditto -x -k ${join(directory, names.zip)} ${join(plan.workDir, "kept-app")}`,
    `codesign --verify --deep --strict --verbose=2 ${app}`,
    `spctl --assess --type execute --verbose=4 ${app}`,
    `xcrun stapler validate ${app}`,
    `xcrun stapler validate ${join(directory, names.dmg)}`,
  ]);
  await writeFile(manifestPath, updateManifest({ ...manifest, version: "0.1.1" }));
  await assert.rejects(verifyKeptFiles(plan, async () => assert.fail("no signature check runs on files the verifier rejects")), /Manifest version 0\.1\.1 does not match 0\.1\.0/);
});

// Publishes with a release whose assets the queue gives, view by view, and records each upload.
async function publishWith({ plan, directory }, { cancelled = () => false, views }) {
  const steps = [];
  const run = () => ({ status: 0, stderr: "", stdout: JSON.stringify({ isDraft: false, isPrerelease: false, assets: views.shift() }) });
  const step = async (command, args) => { steps.push(args.slice(5)); };
  const result = publishMacFiles(plan, directory, { run, step, cancelled: () => cancelled(steps), download: async () => join(directory, plan.names.zip) });
  return { steps, result };
}

test("a Mac release uploads the manifest only after the release holds every file, and starts no upload after a cancellation", async () => {
  const release = await macReleaseFiles();
  const { files, directory } = release;
  const paths = files.map(file => file.path);
  const done = uploaded(files);

  const finished = await publishWith(release, { views: [[], done.slice(0, 3), done] });
  await finished.result;
  assert.deepEqual(finished.steps, [paths.slice(0, 3), [paths[3]]]);
  const resumed = await publishWith(release, { views: [done.slice(0, 2), done.slice(0, 3), done] });
  await resumed.result;
  assert.deepEqual(resumed.steps, [[paths[2]], [paths[3]]], "a rerun uploads only what the release lacks");

  const keep = new RegExp(`\\nThe built files stay in ${RegExp.escape(directory)}\\. Run the same command again`);
  const lacking = await publishWith(release, { views: [[], done.slice(0, 2)] });
  await assert.rejects(lacking.result, /does not hold these files as built: dohc-0\.1\.0-mac-arm64\.zip\.blockmap\./);
  assert.deepEqual(lacking.steps, [paths.slice(0, 3)], "the manifest does not upload while a file it needs is missing");
  const stopped = await publishWith(release, { cancelled: () => true, views: [[]] });
  await assert.rejects(stopped.result, new RegExp(`Stopped before the next upload\\.${keep.source}`));
  assert.deepEqual(stopped.steps, []);
  const midway = await publishWith(release, { cancelled: steps => steps.length > 0, views: [[]] });
  await assert.rejects(midway.result, /Stopped before the next upload/);
  assert.deepEqual(midway.steps, [paths.slice(0, 3)], "the binaries upload, the manifest does not");

  const rehearsal = publishMacFiles({ ...release.plan, dryRun: true, rehearse: true }, directory, { run: () => assert.fail("a rehearsal reads no release"), step: () => assert.fail("a rehearsal uploads nothing"), cancelled: () => false });
  assert.equal((await rehearsal).length, 2, "a rehearsal shows the plan for a release with no macOS files");
});

test("a Mac release never uploads a manifest that names a file it does not upload", async () => {
  const release = await macReleaseFiles();
  const { manifestPath, manifest } = release;
  await writeFile(manifestPath, updateManifest({ ...manifest, files: [...manifest.files, { url: "dohc-0.1.0-mac-x64.zip", sha512: "x", size: 1 }] }));
  const stray = await publishWith(release, { views: [[]] });
  await assert.rejects(stray.result, /latest-mac\.yml in [\s\S]* names dohc-0\.1\.0-mac-x64\.zip, which this command does not upload\. Nothing was uploaded\./);
  assert.deepEqual(stray.steps, []);
});

test("a real Mac release locks the release keychain however it ends, reports a lock that fails, and a dry run leaves it alone", async () => {
  const keychain = join(await mkdtemp(join(tmpdir(), "dohc-keychain-")), "dohc-release.keychain-db");
  await writeFile(keychain, "");
  const locker = status => {
    const calls = [];
    return { calls, run: (command, args) => { calls.push([command, ...args].join(" ")); return { status, stdout: "", stderr: status ? "locking failed" : "" }; } };
  };
  for (const dryRun of [false, true]) {
    const lock = locker(0);
    await assert.rejects(withReleaseKeychain({ dryRun, keychain }, async () => { throw new Error("build failed"); }, lock.run), /build failed/);
    assert.deepEqual(lock.calls, dryRun ? [] : [`security lock-keychain ${keychain}`]);
  }
  // A failed lock keeps the build's own error, and fails a run that otherwise succeeded.
  await assert.rejects(withReleaseKeychain({ dryRun: false, keychain }, async () => { throw new Error("build failed"); }, locker(1).run), /^Error: build failed$/);
  await assert.rejects(withReleaseKeychain({ dryRun: false, keychain }, async () => "uploaded", locker(1).run), /Could not lock the release keychain: locking failed\nLock it now with: security lock-keychain/);
});

test("a real Mac release opens the release keychain only to check signing and to package, never while third-party code runs", async () => {
  const workRoot = await mkdtemp(join(tmpdir(), "dohc-mac-release-order-"));
  const names = macFileNames("0.1.0", "latest");
  const checkout = join(workRoot, "v0.1.0", "checkout");
  const plan = {
    tag: "v0.1.0", version: "0.1.0", channel: "latest", repo: "dohchq/dohc", commit: RELEASE_COMMIT, buildCommit: RELEASE_COMMIT, names,
    workRoot, workDir: join(workRoot, "v0.1.0"), savedFiles: join(workRoot, "v0.1.0", "files"), state: { kind: "fresh" },
    signs: true, dryRun: false, rehearse: false, keychain: KEYCHAIN, keychainProfile: "dohc-notary",
    reporting: { DOHC_POSTHOG_KEY: "phc_abcdefghij0123456789", DOHC_POSTHOG_HOST: "", POSTHOG_CLI_PROJECT_ID: "42", POSTHOG_CLI_HOST: "" },
  };
  let open = false;
  const steps = [];
  const uploads = new Map();
  const asset = path => {
    const bytes = readFileSync(path);
    return { name: basename(path), state: "uploaded", size: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  };
  const step = async (command, args, env) => {
    const line = [command, ...args].join(" ");
    steps.push({ line, open, key: env?.POSTHOG_CLI_API_KEY });
    if (line === `security unlock-keychain ${KEYCHAIN}`) open = true;
    if (line.startsWith("git worktree add")) {
      mkdirSync(join(checkout, "apps/desktop"), { recursive: true });
      writeFileSync(join(checkout, "apps/desktop/package.json"), JSON.stringify({ name: "@dohc/desktop", version: "0.1.0" }));
    }
    if (line.includes("exec electron-builder")) {
      const release = join(checkout, "apps/desktop/release");
      mkdirSync(join(release, "mac-arm64/dohc.app"), { recursive: true });
      for (const name of [names.zip, names.dmg, names.blockmap]) writeFileSync(join(release, name), `${name} bytes`);
      const zip = readFileSync(join(release, names.zip));
      const sha512 = createHash("sha512").update(zip).digest("base64");
      writeFileSync(join(release, names.manifest), updateManifest({ version: "0.1.0", files: [{ url: names.zip, sha512, size: zip.length }], path: names.zip, sha512 }));
    }
    if (command === "gh" && args[1] === "upload") for (const path of args.slice(5)) uploads.set(basename(path), asset(path));
  };
  const run = (command, args) => {
    const line = [command, ...args].join(" ");
    steps.push({ line, open });
    if (line === `security lock-keychain ${KEYCHAIN}`) open = false;
    if (line.startsWith("gh release view")) return { status: 0, stderr: "", stdout: JSON.stringify({ isDraft: false, isPrerelease: false, assets: [...uploads.values()] }) };
    if (line.startsWith("xcrun notarytool submit")) return { status: 0, stderr: "", stdout: JSON.stringify({ id: "1", status: "Accepted" }) };
    if (line.startsWith("git worktree") || line.startsWith("security lock-keychain")) return { status: 0, stderr: "", stdout: "" };
    return fakeMac().run(command, args);
  };
  await releaseMac(plan, { root: workRoot, run, step, keychainStatus: () => (open ? 7 : 2), interactive: true });

  const at = text => steps.find(entry => entry.line.includes(text));
  for (const text of ["pnpm install", "pnpm build:desktop", "run build:engine", "upload-desktop-source-maps.mjs", "smoke:package:desktop", "stapler staple", "smoke:fuses:desktop", "gh release upload"]) {
    assert.equal(at(text).open, false, `${text} runs with the release keychain locked`);
  }
  for (const text of ["security find-identity", "xcrun notarytool history", "find-generic-password -s dohc-posthog-cli-api-key -w", "exec electron-builder", "xcrun notarytool submit"]) {
    assert.equal(at(text).open, true, `${text} runs with the release keychain unlocked`);
  }
  assert.equal(steps.filter(entry => entry.line === `security unlock-keychain ${KEYCHAIN}`).length, 2, "one unlock checks signing, and one packages");
  assert.equal(open, false, "the release keychain ends locked");
  assert.equal(at("upload-desktop-source-maps.mjs").key, "phx_fixture", "the source map upload sees the PostHog key");
  assert.deepEqual(steps.filter(entry => entry.key && !entry.line.includes("upload-desktop-source-maps.mjs")), [], "no other step sees the PostHog key");
  assert.deepEqual([...uploads.keys()], [names.zip, names.dmg, names.blockmap, names.manifest]);
  assert.equal(existsSync(checkout), false, "the throwaway worktree is gone");
  assert.equal(existsSync(join(workRoot, "v0.1.0")), false, "a finished upload keeps no files");
});

// HOME moves the command's lock into a temporary directory, so the test never takes this Mac's real one.
test("release-desktop-macos refuses incomplete arguments when run as a command, even while a release holds the lock", async t => {
  const home = await mkdtemp(join(tmpdir(), "dohc-release-home-"));
  if (process.platform === "darwin") {
    await mkdir(join(home, "dohc-release"));
    const holder = spawn("/usr/bin/perl", ["-e", '$| = 1; open(my $lock, ">>", shift) or die; flock($lock, 2) or die; print "held\\n"; sleep 60', join(home, "dohc-release/release.lock")], { stdio: ["ignore", "pipe", "inherit"] });
    t.after(() => holder.kill("SIGKILL"));
    await new Promise(resolve => holder.stdout.once("data", resolve));
  }
  await assert.rejects(
    runReleaseScript("release-desktop-macos.mjs", ["--channel", "nightly"], { HOME: home }),
    (error) => error.code === 1 && /Usage: pnpm release:macos/.test(error.stderr),
  );
});

test("release checkouts do not persist credentials", () => {
  for (const [name, job] of Object.entries(releaseWorkflow.jobs)) {
    const checkout = job.steps.find(step => step.uses?.startsWith("actions/checkout@"));
    assert.ok(checkout, `${name} checks out the release commit`);
    assert.equal(checkout.with["persist-credentials"], false);
  }
});

const NIGHTLY_HEAD = "a".repeat(40);
const YESTERDAY = { tag: "v0.1.1-nightly.20261019.41.1", commit: "b".repeat(40), publishedAt: "2026-10-19T20:30:00Z", assets: ["nightly.yml", "nightly-linux.yml", "nightly-mac.yml"] };
const TONIGHT = Date.parse("2026-10-20T20:00:00Z");

test("the nightly job dispatches only a new main that passed verification", () => {
  const night = { head: NIGHTLY_HEAD, verifiedHead: NIGHTLY_HEAD, lastNightly: YESTERDAY, now: TONIGHT };
  assert.deepEqual(nightlyDecision(night), { kind: "dispatch" });
  assert.deepEqual(nightlyDecision({ ...night, lastNightly: null }), { kind: "dispatch" }, "the first nightly needs no earlier one");

  const quiet = nightlyDecision({ ...night, lastNightly: { ...YESTERDAY, commit: NIGHTLY_HEAD } });
  assert.deepEqual([quiet.kind, quiet.report], ["skip", false], "a night with nothing new is not reported");
  // A nightly published by hand before 18:00 UTC leaves tonight's to go ahead.
  assert.deepEqual(nightlyDecision({ ...night, lastNightly: { ...YESTERDAY, publishedAt: "2026-10-20T01:00:00Z" } }), { kind: "dispatch" });
  assert.deepEqual(nightlyDecision({ ...night, now: Date.parse("2026-10-26T20:00:00Z"), lastNightly: { ...YESTERDAY, publishedAt: "2026-10-26T07:00:00Z" } }), { kind: "dispatch" },
    "on 26 October a nightly dispatched by hand published at about 07:00 UTC, and that evening's run still dispatches");
  // One published after 18:00 UTC is tonight's, so main stays unpublished, and that is reported.
  const sameDay = nightlyDecision({ ...night, lastNightly: { ...YESTERDAY, publishedAt: "2026-10-20T19:00:00Z" } });
  assert.deepEqual([sameDay.kind, sameDay.report], ["skip", true]);
  assert.equal(sameDay.reason, "v0.1.1-nightly.20261019.41.1 published at 2026-10-20 19:00 UTC, and one nightly publishes per nightly day, which starts at 18:00 UTC. main's head aaaaaaaaa stays unpublished until the next nightly, which can publish from 2026-10-21 18:00 UTC.");

  const unverified = nightlyDecision({ ...night, verifiedHead: "c".repeat(40) });
  assert.deepEqual([unverified.kind, unverified.report], ["skip", true]);
  assert.match(unverified.reason, /has not passed on main's head aaaaaaaaa; its last pass is ccccccccc/);
  assert.match(nightlyDecision({ ...night, verifiedHead: null }).reason, /has not passed/);

  // A dry run publishes nothing, so it skips publication and verification rules.
  assert.deepEqual(nightlyDecision({ ...night, verifiedHead: null, lastNightly: { ...YESTERDAY, commit: NIGHTLY_HEAD }, dryRun: true }), { kind: "dispatch" });
});

test("only a full nightly verification of main counts as verified", () => {
  const pass = (request, state = "passed") => ({ request: { nightly: true, full: true, scope: "all", gates: { rust: true, js: true }, ...request }, status: { state } });
  assert.equal(verifiedNightly([pass({ head: "1" }), pass({ head: "2" })]).request.head, "2");
  assert.equal(verifiedNightly([pass({ head: "1" }), pass({ head: "2" }, "failed")]).request.head, "1");
  for (const narrower of [{ full: false }, { scope: "js" }, { gates: { rust: false, js: true } }, { nightly: false }]) {
    assert.equal(verifiedNightly([pass({ head: "2", ...narrower })]), null, JSON.stringify(narrower));
  }
});

// Answers the commands the nightly job runs. The job's run is 9. Run 8 ran
// earlier, and run 10 is someone else's dispatch that starts at the same time.
function fakeNightly({ runHead = NIGHTLY_HEAD, conclusion = "success", lastNightly = YESTERDAY, views = null, status = "", compare = "identical", dryRun = false, dispatchFails = false, dispatchLost = false } = {}) {
  const calls = [];
  const tag = "v0.1.1-nightly.20261020.42.1";
  let dispatched = false;
  let viewCount = 0;
  const tags = { ...(lastNightly ? { [lastNightly.tag]: lastNightly.commit } : {}), [tag]: runHead };
  const viewAnswers = views ?? [{ status: "in_progress", jobs: [] }, { status: "in_progress", jobs: [] }, { status: "completed", conclusion, jobs: [] }];
  const run = (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    const ok = stdout => ({ status: 0, stdout, stderr: "" });
    if (line === "git status --porcelain") return ok(status);
    if (line === "git rev-parse HEAD") return ok(`${"e".repeat(40)}\n`);
    if (line.startsWith("gh api repos/dohchq/dohc/compare/")) return ok(`${compare}\n`);
    if (line.startsWith("gh api repos/dohchq/dohc/git/ref/heads/main")) return ok(`${NIGHTLY_HEAD}\n`);
    if (line.startsWith("gh api --paginate repos/dohchq/dohc/releases")) return ok(lastNightly ? `${JSON.stringify({ tag: lastNightly.tag, publishedAt: lastNightly.publishedAt, assets: lastNightly.assets })}\n` : "");
    if (line.startsWith("gh api repos/dohchq/dohc/commits/refs/tags/")) return ok(`${tags[args[1].split("/").pop()]}\n`);
    if (line.startsWith("gh run list")) {
      const earlier = { databaseId: 8, headSha: YESTERDAY.commit, url: "https://github.com/dohchq/dohc/actions/runs/8", displayTitle: "Desktop Release" };
      // Someone's stable release for the same commit, dispatched at the same time.
      const others = { databaseId: 10, headSha: NIGHTLY_HEAD, url: "https://github.com/dohchq/dohc/actions/runs/10", displayTitle: `Desktop Release latest for ${NIGHTLY_HEAD}` };
      const ours = { databaseId: 9, headSha: runHead, url: "https://github.com/dohchq/dohc/actions/runs/9", displayTitle: runTitle(NIGHTLY_HEAD, dryRun) };
      return ok(JSON.stringify(dispatched ? [others, ours, earlier] : [earlier]));
    }
    if (line.startsWith("gh workflow run")) {
      if (dispatchFails) return { status: 1, stdout: "", stderr: "HTTP 500" };
      dispatched = true;
      // GitHub accepted the dispatch, but gh lost the response.
      return dispatchLost ? { status: 1, stdout: "", stderr: "connection reset" } : ok("");
    }
    if (line.startsWith("gh run view 9")) {
      const answer = viewAnswers[Math.min(viewCount++, viewAnswers.length - 1)];
      return answer === "error" ? { status: 1, stdout: "", stderr: "HTTP 502" } : ok(JSON.stringify(answer));
    }
    if (line.startsWith("gh run cancel 9")) return ok("");
    if (line.startsWith("gh api repos/dohchq/dohc/releases?per_page=20")) {
      return ok(`${JSON.stringify({ tag, publishedAt: "2026-10-20T21:10:00Z", url: `https://github.com/dohchq/dohc/releases/tag/${tag}` })}\n${JSON.stringify({ tag: YESTERDAY.tag, publishedAt: YESTERDAY.publishedAt, url: "" })}\n`);
    }
    throw new Error(`The nightly job ran an unexpected command: ${line}`);
  };
  return { run, calls, tag };
}

function nightlyHost(fake, extra = {}) {
  let clock = TONIGHT;
  const macs = [];
  return {
    macs,
    deps: {
      run: fake.run, root: "/queue", log: () => {}, now: () => clock, wait: async ms => { clock += ms; },
      queueIdle: async () => true, verifiedHead: () => NIGHTLY_HEAD, addMacFiles: tag => { macs.push(tag); return 0; }, ...extra,
    },
  };
}

test("a nightly dispatches Desktop Release for main's verified commit, follows its own run, and adds the macOS files to the release it published", async () => {
  const fake = fakeNightly();
  const host = nightlyHost(fake);
  const report = await runNightly({}, host.deps);
  assert.ok(fake.calls.includes(`gh workflow run desktop-release.yml -R dohchq/dohc --ref main -f channel=nightly -f platforms=windows-linux -f dry_run=false -f commit=${NIGHTLY_HEAD}`));
  assert.ok(fake.calls.some(call => call.startsWith("gh run view 9")), "it follows the run titled with its commit, not another dispatch that started then");
  assert.ok(!fake.calls.some(call => call.startsWith("gh run view 10")));
  assert.deepEqual(host.macs, [fake.tag], "the macOS files go to the release the run published");
  assert.match(report, new RegExp(`^Published \\[${RegExp.escape(fake.tag)}\\]\\(.+\\) from aaaaaaaaa for Windows, Linux and macOS \\(\\[run\\]\\(https://github.com/dohchq/dohc/actions/runs/9\\)\\)\\.$`));
});

test("a nightly publishes nothing on a quiet night, a busy queue, a moved main, a failed run, or a checkout that is not clean main", async () => {
  const quiet = fakeNightly({ lastNightly: { ...YESTERDAY, commit: NIGHTLY_HEAD } });
  assert.equal(await runNightly({}, nightlyHost(quiet).deps), null);
  assert.ok(!quiet.calls.some(call => call.startsWith("gh workflow run")));

  const busy = fakeNightly();
  assert.match(await runNightly({}, nightlyHost(busy, { queueIdle: async () => false }).deps), /verification queue was still busy/);
  assert.ok(!busy.calls.some(call => call.startsWith("gh api repos/dohchq/dohc/git/ref")), "nothing reads GitHub or dispatches while verification runs");

  // The workflow refuses to build a commit other than the requested one, so no cancel is needed.
  const moved = fakeNightly({ runHead: "d".repeat(40), conclusion: "failure" });
  const movedHost = nightlyHost(moved);
  assert.match(await runNightly({}, movedHost.deps), /main moved to ddddddddd after the checks passed on aaaaaaaaa, so \[Desktop Release\]\(.+\) refused to build it\. Nothing was published\./);
  assert.ok(!moved.calls.some(call => call.startsWith("gh run cancel")));
  assert.deepEqual(movedHost.macs, []);

  const failed = fakeNightly({ conclusion: "failure" });
  const failedHost = nightlyHost(failed);
  assert.match(await runNightly({}, failedHost.deps), /ended with "failure"\. Nothing was published\./);
  assert.deepEqual(failedHost.macs, []);

  await assert.rejects(runNightly({}, nightlyHost(fakeNightly({ status: " M scripts/release-nightly.mjs" })).deps), /checkout the job runs from has changes/);
  await assert.rejects(runNightly({}, nightlyHost(fakeNightly({ compare: "diverged" })).deps), /which is not on main/);
});

test("a nightly keeps following its run through gh errors, and leaves a run still going at its limit to finish", async () => {
  let clock = 0;
  const options = { wait: async ms => { clock += ms; }, now: () => clock, limitMs: 3000, pollMs: 1000 };
  const flaky = fakeNightly({ views: ["error", "error", { status: "completed", conclusion: "success" }] });
  assert.equal(await waitForRun(flaky.run, 9, options), "success");

  clock = 0;
  const going = fakeNightly({ views: [{ status: "queued" }] });
  assert.equal(await waitForRun(going.run, 9, options), null);
  assert.equal(clock, 3000);
  assert.ok(!going.calls.some(call => call.startsWith("gh run cancel")), "cancelling could interrupt a publish, so the job never cancels");

  clock = 0;
  await assert.rejects(waitForRun(fakeNightly({ views: ["error"] }).run, 9, { ...options, failureLimit: 3 }), /could not read the run 3 times in a row: HTTP 502/);

  const lost = fakeNightly({ views: ["error"] });
  assert.match(await runNightly({}, nightlyHost(lost).deps), /lost track of \[Desktop Release\]\(.+\) for aaaaaaaaa: .+If it publishes, the next night adds its macOS files\./);

  const stuck = fakeNightly({ views: [{ status: "queued" }] });
  const stuckHost = nightlyHost(stuck);
  assert.match(await runNightly({}, stuckHost.deps), /was still going after 6 hours\. Check the run on GitHub\. If it publishes, the next night adds its macOS files\./);
  assert.deepEqual(stuckHost.macs, []);
});

test("a nightly adds missing macOS files to the newest nightly first, except to the legacy June nightly", async () => {
  const missing = fakeNightly({ lastNightly: { ...YESTERDAY, commit: NIGHTLY_HEAD, assets: ["nightly.yml", "nightly-linux.yml"] } });
  const host = nightlyHost(missing);
  assert.match(await runNightly({}, host.deps), /^Added the macOS files to v0\.1\.1-nightly\.20261019\.41\.1, which published without them\.$/);
  assert.deepEqual(host.macs, [YESTERDAY.tag]);

  const failing = fakeNightly({ lastNightly: { ...YESTERDAY, commit: NIGHTLY_HEAD, assets: ["nightly.yml"] } });
  const report = await runNightly({}, nightlyHost(failing, { addMacFiles: () => 1 }).deps);
  assert.match(report, /adding the macOS files to v0\.1\.1-nightly\.20261019\.41\.1 failed with exit code 1/);
  assert.match(report, /node scripts\/release-desktop-macos\.mjs --version v0\.1\.1-nightly\.20261019\.41\.1 --channel nightly/);

  // A later step that fails still reports the repair.
  const thenFails = fakeNightly({ lastNightly: { ...YESTERDAY, assets: ["nightly.yml"] }, dispatchFails: true });
  assert.match(await runNightly({}, nightlyHost(thenFails).deps), /^Added the macOS files to v0\.1\.1-nightly\.20261019\.41\.1, which published without them\.\n\nThe nightly job stopped: gh workflow run failed, and no run titled "Desktop Release nightly for a+" appeared within 5 minutes:\nHTTP 500$/);

  const legacy = fakeNightly({ lastNightly: { tag: "v0.1.1-nightly.20260622.15.1", commit: NIGHTLY_HEAD, publishedAt: "2026-06-22T09:42:56Z", assets: ["latest.yml"] } });
  const legacyHost = nightlyHost(legacy);
  assert.equal(await runNightly({}, legacyHost.deps), null);
  assert.deepEqual(legacyHost.macs, []);
});

test("a nightly follows its run when gh loses the dispatch's response", async () => {
  const lost = fakeNightly({ dispatchLost: true });
  const host = nightlyHost(lost);
  assert.match(await runNightly({}, host.deps), /^Published \[v0\.1\.1-nightly\.20261020\.42\.1\]/);
  assert.deepEqual(host.macs, [lost.tag]);
});

test("a nightly whose macOS files fail reports the command that finishes them", async () => {
  const fake = fakeNightly();
  const report = await runNightly({}, nightlyHost(fake, { addMacFiles: () => 1 }).deps);
  assert.match(report, /^Published \[.+\]\(.+\) for Windows and Linux \(\[run\]\(.+\)\), but adding the macOS files to .+ failed with exit code 1/);
  assert.match(report, new RegExp(`node scripts/release-desktop-macos\\.mjs --version ${RegExp.escape(fake.tag)} --channel nightly`));
});

test("a nightly dry run dispatches with dry_run=true, does not wait for verification, and adds no macOS files", async () => {
  const fake = fakeNightly({ lastNightly: { ...YESTERDAY, commit: NIGHTLY_HEAD }, dryRun: true });
  const host = nightlyHost(fake, { queueIdle: async () => assert.fail("a dry run does not wait for the queue"), verifiedHead: () => assert.fail("a dry run needs no verification") });
  assert.match(await runNightly({ dryRun: true }, host.deps), /dry run of Desktop Release passed for aaaaaaaaa/);
  assert.ok(fake.calls.includes(`gh workflow run desktop-release.yml -R dohchq/dohc --ref main -f channel=nightly -f platforms=windows-linux -f dry_run=true -f commit=${NIGHTLY_HEAD}`));
  assert.deepEqual(host.macs, []);
});

test("the nightly job waits for the verification queue to finish, up to its limit", async () => {
  let clock = 0;
  const wait = async ms => { clock += ms; };
  const states = [["running"], ["queued", "passed"], ["passed", "failed"]];
  assert.equal(await waitForQueue("/queue", { requests: () => (states.shift() ?? []).map(state => ({ status: { state } })), wait, now: () => clock, pollMs: 1000 }), true);
  assert.equal(clock, 2000);
  clock = 0;
  assert.equal(await waitForQueue("/queue", { requests: () => [{ status: { state: "running" } }], wait, now: () => clock, limitMs: 5000, pollMs: 1000 }), false);
  assert.equal(clock, 5000);
});

test("release commands on the Mac take one lock, hand it to the macOS command they start, and lose it only with the last process holding it", { skip: process.platform === "win32" }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "dohc-release-lock-"));
  // A pid file holds a positive pid or does not exist. Signalling 0 would hit this test's own process group.
  const pidOf = role => {
    const pid = Number(readFileSync(join(dir, `${role}.pid`), "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`${role}.pid holds no pid`);
    return pid;
  };
  // Whatever the outcome, stop every command this test started.
  t.after(() => {
    for (const role of ["parent", "child", "other", "graceful"]) {
      try { process.kill(pidOf(role), "SIGKILL"); } catch { /* not started or already gone */ }
    }
  });
  const lock = join(dir, "release.lock");
  const script = join(dir, "hold.mjs");
  const lockModule = pathToFileURL(fileURLToPath(new URL("./release-lock.mjs", import.meta.url))).href;
  // A release command: "parent" starts a child release command under its hold, as the nightly job starts the macOS command.
  await writeFile(script, `import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { heldLockOptions, underReleaseLock } from ${JSON.stringify(lockModule)};
const [lock, role, dir] = process.argv.slice(2);
const locked = await underReleaseLock(lock);
if (locked !== null) process.exit(locked);
if (role === "parent") spawn(process.execPath, [process.argv[1], lock, "child", dir], heldLockOptions(lock));
if (role === "graceful") process.on("SIGTERM", () => setTimeout(() => { writeFileSync(dir + "/cleaned", ""); process.exit(0); }, 200));
// Written whole, then renamed, so a reader never sees an empty pid file.
writeFileSync(dir + "/" + role + ".pid.tmp", String(process.pid));
renameSync(dir + "/" + role + ".pid.tmp", dir + "/" + role + ".pid");
setInterval(() => {}, 1000);
`);
  const clean = { ...process.env, DOHC_RELEASE_LOCK_HELD: "", DOHC_RELEASE_LOCK_FD: "" };
  const until = async (check, what) => {
    for (const deadline = Date.now() + 10_000; !check(); await new Promise(resolve => setTimeout(resolve, 50))) if (Date.now() > deadline) assert.fail(what);
  };
  const competing = () => promisify(execFile)(process.execPath, [script, lock, "other", dir], { timeout: 10_000, env: clean }).then(() => 0, error => error.code);

  const job = spawn(process.execPath, [script, lock, "parent", dir], { stdio: "ignore", env: clean });
  await until(() => existsSync(join(dir, "child.pid")), "the child release command never started");
  assert.equal(await competing(), LOCK_BUSY, "a release run by hand does not start while the job runs");
  process.kill(pidOf("parent"), "SIGKILL");
  await new Promise(resolve => job.once("exit", resolve));
  assert.equal(await competing(), LOCK_BUSY, "the child still holds the lock after the job is killed");
  process.kill(pidOf("child"), "SIGKILL");
  await until(() => !releaseLockHeld(lock), "the lock outlived the last process holding it");

  // A signal sent to the command someone started reaches the run under the lock, which cleans up before the command exits.
  const started = spawn(process.execPath, [script, lock, "graceful", dir], { stdio: "ignore", env: clean });
  await until(() => existsSync(join(dir, "graceful.pid")), "the run under the lock never started");
  const exited = new Promise(resolve => started.once("exit", code => resolve(code)));
  started.kill("SIGTERM");
  assert.equal(await exited, 0);
  assert.equal(existsSync(join(dir, "cleaned")), true);
  assert.equal(releaseLockHeld(lock), false);
  assert.throws(() => heldLockOptions(lock, clean), /does not hold/);
});

test("the nightly LaunchAgent runs at 04:00 in the login session from a clean checkout of main, and reports when it cannot update it", () => {
  const definition = nightlyAgentDefinition({ checkout: "/Users/maker/dohc-release/driver", source: "git@github.com:dohchq/dohc.git", queue: "/Users/maker/dev/worktrees/_verification", logPath: "/Users/maker/dohc-release/nightly.log", path: "/usr/bin:/bin" });
  assert.match(definition, new RegExp(`<key>Label</key><string>${RegExp.escape(NIGHTLY_AGENT_LABEL)}</string>`));
  assert.match(definition, /<key>LimitLoadToSessionType<\/key><string>Aqua<\/string>/);
  assert.match(definition, /<key>Hour<\/key><integer>4<\/integer><key>Minute<\/key><integer>0<\/integer>/);
  // A failure is reported through gh, so no code from the checkout runs before main is in it.
  assert.match(definition, /git checkout --quiet --force --detach FETCH_HEAD &amp;&amp; git clean -ffdxq \|\| exec gh issue comment 2281 -R dohchq\/dohc --body "\$3"/);
  assert.match(definition, /if \[ "\$attempt" = 3 \]; then exec gh issue comment 2281 -R dohchq\/dohc --body "\$2"; fi/);
  assert.doesNotMatch(definition, /release-nightly\.mjs report/);
  assert.match(definition, /exec node scripts\/release-nightly\.mjs run<\/string><string>\/Users\/maker\/dohc-release\/driver<\/string><string>git@github\.com:dohchq\/dohc\.git<\/string><string>&gt; \[!NOTE\]\n&gt; Posted by the nightly release job.+could not fetch main in \/Users\/maker\/dohc-release\/driver, so nothing ran tonight\. See \/Users\/maker\/dohc-release\/nightly\.log\.<\/string><string>.+could not check out main in .+<\/string><\/array>/s);
  assert.match(definition, /git fetch --quiet "\$1" refs\/heads\/main/, "it fetches the main branch from the repository install checked, not the clone's origin");
  assert.match(definition, /<key>DOHC_VERIFICATION_QUEUE_ROOT<\/key><string>\/Users\/maker\/dev\/worktrees\/_verification<\/string>/);
  assert.match(definition, /<key>StandardOutPath<\/key><string>\/Users\/maker\/dohc-release\/nightly\.log<\/string>/);
});

test("Desktop Release names the requested commit in its run title and builds nothing when main is elsewhere", async () => {
  assert.equal(runTitle(NIGHTLY_HEAD, false), `Desktop Release nightly for ${NIGHTLY_HEAD}`);
  assert.equal(runTitle(NIGHTLY_HEAD, true), `Desktop Release nightly dry run for ${NIGHTLY_HEAD}`);
  assert.equal(releaseWorkflow["run-name"], "Desktop Release ${{ inputs.channel }}${{ inputs.dry_run && ' dry run' || '' }}${{ inputs.commit && format(' for {0}', inputs.commit) || '' }}");
  assert.equal(releaseWorkflow.on.workflow_dispatch.inputs.commit.required, false);
  const [guard] = releaseWorkflow.jobs.preflight.steps;
  assert.equal(guard.name, "Check the requested commit", "the guard runs before anything else in preflight");
  assert.equal(guard.if, "inputs.commit != ''");
  assert.equal(guard.env.REQUESTED_COMMIT, "${{ inputs.commit }}");
  if (process.platform === "win32") return;
  const check = (requested, actual) => promisify(execFile)("bash", ["-euo", "pipefail", "-c", guard.run], { env: { ...process.env, REQUESTED_COMMIT: requested, GITHUB_SHA: actual } });
  await check(NIGHTLY_HEAD, NIGHTLY_HEAD);
  await assert.rejects(check(NIGHTLY_HEAD, "d".repeat(40)), error => error.code === 1 && /not the requested commit/.test(error.stdout));
});
