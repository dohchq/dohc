import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp as createTemporaryDirectory,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { load } from "js-yaml";
import { verifyDesktopReleaseArtifacts } from "./verify-desktop-release-artifacts.mjs";

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
import { checkDesktopReleasePlatforms } from "./check-desktop-release-platforms.mjs";
import {
  createMockUpdateServer,
  resolveServablePath,
} from "./mock-update-server.mjs";
import { scriptsWithoutChunkIds, sourceMapUpload, uploadSourceMaps } from "./upload-desktop-source-maps.mjs";

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
  assert.deepEqual(JSON.parse(nightly.matrix).map((target) => target.os), ["Windows"]);
});

test("release platform selection defaults to Windows and keeps every native target available", () => {
  const windows = desktopReleaseTargets();
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].runner, ["self-hosted", "windows", "x64"]);
  assert.equal(windows[0].target, "x86_64-pc-windows-msvc");
  const linux = desktopReleaseTargets("linux");
  assert.equal(linux.length, 1);
  assert.deepEqual(linux[0].runner, ["self-hosted", "linux", "x64"]);
  assert.equal(linux[0].target, "x86_64-unknown-linux-gnu");
  assert.equal(linux[0].require_signing, "0");
  assert.deepEqual(desktopReleaseTargets("windows-linux"), [windows[0], linux[0]]);
  const all = desktopReleaseTargets("all");
  assert.deepEqual(all.map((target) => [target.arch, target.target]), [
    ["x64", "x86_64-pc-windows-msvc"],
    ["arm64", "aarch64-apple-darwin"],
    ["x64", "x86_64-unknown-linux-gnu"],
  ]);
  for (const target of all) assert.equal(target.runner[0], "self-hosted");
  assert.throws(() => desktopReleaseTargets("mac"), /Invalid release platforms/);
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

test("Linux and combined publication preserve previously shipped platform feeds", () => {
  for (const channel of ["nightly", "latest"]) {
    const release = (names) => [{ draft: false, assets: names.map((name) => ({ name })) }];
    const linuxOnly = release([`${channel}-linux.yml`]);
    const windowsAndLinux = release([`${channel}.yml`, `${channel}-linux.yml`]);
    assert.doesNotThrow(() => checkDesktopReleasePlatforms({ channel, platforms: "linux", releases: linuxOnly }));
    assert.throws(() => checkDesktopReleasePlatforms({ channel, platforms: "linux", releases: windowsAndLinux }), /win update manifests/);
    assert.doesNotThrow(() => checkDesktopReleasePlatforms({ channel, platforms: "windows-linux", releases: windowsAndLinux }));
    for (const platforms of ["linux", "windows-linux"]) {
      assert.throws(() => checkDesktopReleasePlatforms({ channel, platforms, releases: release([`${channel}-mac.yml`]) }), /mac update manifests/);
    }
  }
});

test("publication preserves every platform previously published on its channel", () => {
  const release = (names, draft = false) => ({ draft, assets: names.map((name) => ({ name })) });
  for (const channel of ["nightly", "latest"]) {
    for (const platform of ["mac", "linux"]) {
      const releases = [release([`${channel}.yml`]), release([`${channel}-${platform}.yml`])];
      assert.throws(() => checkDesktopReleasePlatforms({ channel, platforms: "windows", releases }), /Select platforms=all/);
      assert.doesNotThrow(() => checkDesktopReleasePlatforms({ channel, platforms: "all", releases }));
    }
    const other = channel === "nightly" ? "latest" : "nightly";
    for (const releases of [[], [release([`${channel}.yml`])], [release([`${channel}-mac.yml`, `${channel}-linux.yml`], true)], [release([`${other}-mac.yml`, `${other}-linux.yml`])]]) {
      assert.doesNotThrow(() => checkDesktopReleasePlatforms({ channel, platforms: "windows", releases }));
    }
  }
});

test("publication platform history fails closed on incomplete input", () => {
  for (const releases of [null, {}, [{}], [{ draft: false, assets: [{}] }], [[[]]]]) {
    assert.throws(() => checkDesktopReleasePlatforms({ channel: "nightly", platforms: "windows", releases }), /Release history/);
  }
});

test("publication platform check exits unsuccessfully when a channel would lose updates", async () => {
  const root = await fixtureRoot();
  const history = join(root, "releases.jsonl");
  await writeFile(history, [
    { draft: false, assets: [{ name: "nightly.yml" }] },
    { draft: false, assets: [{ name: "nightly-mac.yml" }] },
  ].map((release) => JSON.stringify(release)).join("\n") + "\n");
  const script = fileURLToPath(new URL("./check-desktop-release-platforms.mjs", import.meta.url));
  const args = [script, "--channel", "nightly", "--platforms", "windows", "--releases", history];
  await assert.rejects(promisify(execFile)(process.execPath, args), (error) => error.code === 1 && /Select platforms=all/.test(error.stderr));
  args[4] = "all";
  const { stdout } = await promisify(execFile)(process.execPath, args);
  assert.match(stdout, /keeps every previously published platform/);
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

function releaseExpression(expression, needs, secrets = {}, inputs = {}) {
  // These release guards use string comparisons and operators shared by Actions and JavaScript.
  assert.match(expression, /^\$\{\{[\s\S]*\}\}$/u);
  return Function("needs", "secrets", "inputs", "fromJSON", `return (${expression.slice(3, -2)});`)(needs, secrets, inputs, JSON.parse);
}

test("desktop releases start only by dispatch, run on self-hosted runners, and preserve unsigned package smoke", () => {
  const { jobs } = releaseWorkflow;
  assert.deepEqual(Object.keys(releaseWorkflow.on), ["workflow_dispatch"], "only a dispatch can start a release");
  assert.equal(releaseWorkflow.concurrency["cancel-in-progress"], false, "a publish in progress must finish");
  assert.equal(releaseWorkflow.permissions.contents, "read");
  assert.equal(jobs.preflight.if, "github.ref == 'refs/heads/main'");
  for (const job of [jobs.build, jobs.publish]) assert.equal(job.environment, "desktop-release");

  // Cloud runners stay off (AGENTS.md). Packaging runs on the matrix preflight
  // selects from the release targets. Every other job runs on the Linux runner
  // for a Linux dispatch and on the Windows runner otherwise.
  assert.equal(jobs.build["runs-on"], "${{ matrix.runner }}");
  assert.equal(jobs.build.strategy.matrix.include, "${{ fromJSON(needs.preflight.outputs.matrix) }}");
  // Windows and WSL share one PC, so a combined dispatch packages one platform at a time.
  assert.equal(jobs.build.strategy["max-parallel"], "${{ inputs.platforms == 'windows-linux' && 1 || 4 }}");
  assert.match(releaseStep(jobs.preflight, '--platforms "$DISPATCH_PLATFORMS"').run, /--platforms "\$DISPATCH_PLATFORMS"/);
  const dispatchPlatforms = releaseWorkflow.on.workflow_dispatch.inputs.platforms.options;
  for (const [name, job] of Object.entries(jobs)) {
    const runners = name === "build"
      ? desktopReleaseTargets("all").map(target => target.runner)
      : dispatchPlatforms.map(platforms => releaseExpression(job["runs-on"], {}, {}, { platforms }));
    if (name !== "build") {
      assert.deepEqual(runners, dispatchPlatforms.map(platforms => ["self-hosted", platforms === "linux" ? "linux" : "windows", "x64"]),
        `${name} runs on the Linux runner only for a Linux dispatch`);
    }
    assert.ok(runners.length > 0, `${name} has a runner`);
    for (const runner of runners) {
      assert.ok(Array.isArray(runner), `${name} has explicit runner labels`);
      assert.ok(runner.includes("self-hosted"));
      assert.ok(runner.some(label => ["linux", "windows", "macos"].includes(label)));
      assert.ok(runner.some(label => ["x64", "arm64"].includes(label)));
    }
  }

  // Desktop tests need the built runtime exports and the native engine.
  const preflightOrder = step => jobs.preflight.steps.indexOf(step);
  const desktopTests = releaseStep(jobs.preflight, "test:unit --maxWorkers=4");
  for (const prepare of ["pnpm --filter @dohc/app-backend-runtime build", "pnpm qa:prepare -- --engine-only"]) {
    assert.ok(preflightOrder(releaseStep(jobs.preflight, prepare)) < preflightOrder(desktopTests), `desktop tests run after ${prepare}`);
  }
  assert.equal(desktopTests.env.DOHC_REQUIRE_ENGINE_E2E, "1");
  releaseStep(jobs.preflight, "pnpm --filter @dohc/desktop test:scripts");

  // Draft and published versions must both be refused before packaging.
  assert.ok([jobs["unused-version"].needs].flat().includes("preflight"));
  assert.equal(jobs["unused-version"].permissions.contents, "write");
  // A channel keeps every platform it has published, unless the dispatch selects them all.
  const keepPlatforms = releaseStep(jobs["unused-version"], "check-desktop-release-platforms.mjs");
  assert.equal(keepPlatforms.if, "needs.preflight.outputs.dry_run != 'true'");
  assert.match(keepPlatforms.run, /set -euo pipefail/);
  assert.match(keepPlatforms.run, /gh api --paginate/);
  assert.match(keepPlatforms.run, /--releases release-history\.jsonl/);
  assert.equal(keepPlatforms.env.RELEASE_CHANNEL, "${{ needs.preflight.outputs.release_channel }}");
  assert.equal(keepPlatforms.env.RELEASE_PLATFORMS, "${{ inputs.platforms }}");
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
  assert.match(packageDesktop.run, /CSC_IDENTITY_AUTO_DISCOVERY=false/, "unsigned macOS runs disable signing discovery");
  assert.match(packageDesktop.run, /builder_args\+=\(-c\.mac\.identity=null\)/, "unsigned macOS runs disable electron-builder signing");
  releaseStep(jobs.build, "verify-desktop-release-artifacts.mjs");
  const fuseSmoke = releaseStep(jobs.build, "smoke:fuses:desktop");
  assert.equal(fuseSmoke.if, "runner.os == 'Linux'");
  assert.equal(fuseSmoke.env.DOHC_E2E_NO_CHROMIUM_SANDBOX, "1");
  assert.equal(fuseSmoke.run, "xvfb-run -a pnpm smoke:fuses:desktop");
  // Each packaged app runs once before anything uploads it.
  const windowsSmoke = releaseStep(jobs.build, "--binary apps/desktop/release/win-unpacked/dohc.exe");
  assert.equal(windowsSmoke.if, "runner.os == 'Windows'");
  assert.match(windowsSmoke.run, /--package-commit '\$\{\{ github\.sha \}\}'/);
  const macSmoke = jobs.build.steps.find(step => step.if === "runner.os == 'macOS'" && step.run === "pnpm smoke:fuses:desktop");
  assert.ok(macSmoke, "the macOS package's signature, fuses and boot are checked");
  assert.equal(macSmoke.env.DOHC_SMOKE_PACKAGE_DIRECTORY, "${{ github.workspace }}/apps/desktop/release/mac-arm64/dohc.app",
    "the macOS smoke boots the Apple silicon bundle electron-builder wrote");
  const upload = releaseStep(jobs.build, "actions/upload-artifact@");
  const order = step => jobs.build.steps.indexOf(step);
  assert.ok(order(packageDesktop) < order(fuseSmoke), "the Linux fuse smoke boots the package electron-builder wrote");
  assert.ok(order(packageDesktop) < order(macSmoke), "the macOS smoke boots the package electron-builder wrote");
  for (const smoke of [fuseSmoke, windowsSmoke, macSmoke]) assert.ok(order(smoke) < order(upload), "the packaged smoke runs before the upload");
  // Package smoke fails a required-signing Mac run that would skip notarization.
  const packageSmoke = releaseStep(jobs.build, "smoke:package:desktop");
  for (const name of ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
    assert.ok(packageDesktop.env[name], `packaging notarizes with ${name}`);
    assert.equal(packageSmoke.env[name], packageDesktop.env[name], `Package smoke sees the ${name} that packaging uses`);
  }

  const secretExpressions = workflowValues(releaseWorkflow).filter(value => typeof value === "string" && value.includes("secrets."));
  assert.ok(secretExpressions.length > 0, "the workflow still declares release secrets");
  for (const expression of secretExpressions) {
    const secrets = Object.fromEntries([...expression.matchAll(/secrets\.(\w+)/gu)].map(([, name]) => [name, `configured-${name}`]));
    assert.equal(releaseExpression(expression, { preflight: { outputs: { dry_run: "true" } } }, secrets), "", "dry runs receive no release secrets");
    assert.ok(releaseExpression(expression, { preflight: { outputs: { dry_run: "false" } } }, secrets), "publishing can use configured secrets");
  }
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
  assert.deepEqual(desktopReleaseTargets("all").map(({ artifact_platform, arch, target }) => [artifact_platform, arch, target]).sort(), [
    ["mac", "arm64", "aarch64-apple-darwin"],
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
    /\*\/\*\.app\/\*\|.*\*\/win-unpacked\/\*\|.*\*\/linux-unpacked\/\*/,
    "release upload step must skip unpacked app internals that contain duplicate basenames",
  );
  assert.match(
    prepareReleaseUpload,
    /latest\*\.yml\|nightly\*\.yml\|\*\.dmg\|\*\.zip\|\*\.exe\|\*\.AppImage\|\*\.deb\|\*\.blockmap/,
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

test("the release injects source maps for every build that names PostHog before packaging, and never in a dry run", () => {
  const job = releaseWorkflow.jobs.build;
  const build = releaseStep(job, "pnpm build:desktop");
  const upload = releaseStep(job, "upload-desktop-source-maps.mjs");
  const packaging = releaseStep(job, "electron-builder");
  assert.equal(upload.if, "needs.preflight.outputs.dry_run != 'true'");
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
