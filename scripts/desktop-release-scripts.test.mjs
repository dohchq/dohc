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
  nextNightlyBaseVersion,
  resolveDesktopRelease,
  writeGithubOutput,
} from "./resolve-desktop-release.mjs";
import { updateDesktopPackageVersion } from "./update-desktop-package-version.mjs";
import {
  mergeUpdateManifests,
  parseUpdateManifest,
  serializeUpdateManifest,
} from "./merge-update-manifests.mjs";
import {
  createMockUpdateServer,
  resolveServablePath,
} from "./mock-update-server.mjs";

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

test("merges Electron updater manifests by version and unique file URL", () => {
  const primary = parseUpdateManifest(`
version: 0.1.0
files:
  - url: dohc-0.1.0-mac-arm64.zip
    sha512: arm
    size: 12
path: dohc-0.1.0-mac-arm64.zip
sha512: arm
releaseDate: 2026-06-21T00:00:00.000Z
`);
  const secondary = parseUpdateManifest(`
version: 0.1.0
files:
  - url: dohc-0.1.0-mac-x64.zip
    sha512: x64
    size: 13
path: dohc-0.1.0-mac-x64.zip
sha512: x64
`);
  const merged = mergeUpdateManifests(primary, secondary, "mac");
  const serialized = serializeUpdateManifest(merged);

  assert.deepEqual(
    merged.files.map((file) => file.url),
    ["dohc-0.1.0-mac-arm64.zip", "dohc-0.1.0-mac-x64.zip"],
  );
  assert.equal(merged.files[0].sha512, "arm");
  assert.equal(merged.files[0].size, 12);
  assert.equal(merged.files[1].sha512, "x64");
  assert.equal(merged.files[1].size, 13);
  assert.match(serialized, /releaseDate: 2026-06-21T00:00:00.000Z/);
  assert.throws(
    () =>
      mergeUpdateManifests(
        primary,
        { ...secondary, version: "0.2.0" },
        "mac",
      ),
    /different versions/,
  );
  assert.throws(
    () =>
      mergeUpdateManifests(
        primary,
        {
          ...secondary,
          files: [{ url: "dohc-0.1.0-mac-arm64.zip", sha512: "different", size: 12 }],
        },
        "mac",
      ),
    /Conflicting entries/,
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

test("merge-update-manifests writes the merged manifest when run as a command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-merge-command-"));
  const manifest = (arch) =>
    [
      "version: 0.1.0",
      "files:",
      `  - url: dohc-0.1.0-mac-${arch}.zip`,
      `    sha512: ${arch}`,
      "    size: 1",
      `path: dohc-0.1.0-mac-${arch}.zip`,
      `sha512: ${arch}`,
      "",
    ].join("\n");
  await writeFile(join(directory, "arm64.yml"), manifest("arm64"));
  await writeFile(join(directory, "x64.yml"), manifest("x64"));
  await runReleaseScript("merge-update-manifests.mjs", [
    "--platform", "mac",
    join(directory, "arm64.yml"), join(directory, "x64.yml"), join(directory, "merged.yml"),
  ]);
  const merged = parseUpdateManifest(await readFile(join(directory, "merged.yml"), "utf8"));
  assert.deepEqual(
    merged.files.map((file) => file.url).sort(),
    ["dohc-0.1.0-mac-arm64.zip", "dohc-0.1.0-mac-x64.zip"],
  );
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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function topLevelSection(source, name) {
  const pattern = new RegExp(
    `^${escapeRegex(name)}:\\r?\\n([\\s\\S]*?)(?=^[^\\s].*:|(?![\\s\\S]))`,
    "m",
  );
  const match = source.match(pattern);
  assert.ok(match, `workflow section exists: ${name}`);
  return match[1];
}

function indentedSection(source, indent, name) {
  const pattern = new RegExp(
    `^ {${indent}}${escapeRegex(name)}:\\r?\\n([\\s\\S]*?)(?=^ {${indent}}\\S|^[^\\s]|(?![\\s\\S]))`,
    "m",
  );
  const match = source.match(pattern);
  assert.ok(match, `workflow subsection exists: ${name}`);
  return match[1];
}

function stepBlocks(source) {
  return source.replaceAll("\r\n", "\n").match(/^ {6}- name: .*(?:\n(?! {6}- name: ).*)*/gm) ?? [];
}

function stepBlock(source, name) {
  const prefix = `      - name: ${name}`;
  const block = stepBlocks(source).find((candidate) => candidate.startsWith(prefix));
  assert.ok(block, `workflow step exists: ${name}`);
  return block;
}

test("workflow section helpers support sections at end of file", () => {
  const source = [
    "on:",
    "  pull_request:",
    "    branches:",
    "      - main",
  ].join("\n");

  const onSection = topLevelSection(source, "on");
  assert.equal(onSection, "  pull_request:\n    branches:\n      - main");
  assert.equal(indentedSection(onSection, 2, "pull_request"), "    branches:\n      - main");
});

test("workflow section helpers support CRLF line endings", () => {
  const source = [
    "on:",
    "  pull_request:",
    "    branches:",
    "      - main",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
  ].join("\r\n");

  const onSection = topLevelSection(source, "on");
  assert.equal(onSection, "  pull_request:\r\n    branches:\r\n      - main\r\n");
  assert.equal(
    indentedSection(onSection, 2, "pull_request"),
    "    branches:\r\n      - main\r\n",
  );
});

test("desktop releases use explicit release events and preserve unsigned package smoke", async () => {
  const workflow = await readFile(
    join(process.cwd(), ".github/workflows/desktop-release.yml"),
    "utf8",
  );
  const onSection = topLevelSection(workflow, "on");
  const packageDesktop = stepBlock(workflow, "Package desktop");
  const fuseSmoke = stepBlock(workflow, "Fuse smoke");
  const packageSteps = stepBlocks(workflow).filter((step) =>
    step.includes("electron-builder")
  );

  assert.doesNotMatch(onSection, /pull_request/);
  assert.doesNotMatch(onSection, /tags:/);
  assert.match(onSection, /  push:/);
  assert.match(onSection, /  workflow_dispatch:/);
  assert.match(stepBlock(workflow, "Verify release artifacts"), /verify-desktop-release-artifacts\.mjs/);
  const jobs = topLevelSection(workflow, "jobs");
  assert.match(indentedSection(jobs, 2, "preflight"), /if: github\.ref == 'refs\/heads\/main'/);
  for (const job of ["build", "publish"]) {
    assert.match(indentedSection(jobs, 2, job), /^ {4}environment: desktop-release$/m);
  }
  assert.match(workflow, /if:\s*\$\{\{\s*needs\.preflight\.outputs\.dry_run != 'true'\s*\}\}/);
  assert.equal(packageSteps.length, 1, "all electron-builder package paths are explicitly covered");
  assert.equal(packageSteps[0], packageDesktop);
  for (const step of packageSteps) {
    assert.match(
      step,
      /builder_args=\(--publish never/,
      "package step must never publish directly",
    );
  }
  assert.match(
    packageDesktop,
    /builder_args\+=\(-c\.forceCodeSigning=true\)/,
    "stable/signing-required jobs must still hard-fail without a signing identity",
  );
  assert.match(
    packageDesktop,
    /CSC_IDENTITY_AUTO_DISCOVERY=false/,
    "unsigned macOS dry runs must not try the GitHub runner's signing autodiscovery path",
  );
  assert.match(
    packageDesktop,
    /builder_args\+=\(-c\.mac\.identity=null\)/,
    "unsigned macOS package jobs must explicitly disable signing in electron-builder",
  );
  assert.match(fuseSmoke, /^ {8}if: runner\.os == 'Linux'$/m);
  assert.match(fuseSmoke, /^ {10}DOHC_E2E_NO_CHROMIUM_SANDBOX: "1"$/m);
  assert.match(fuseSmoke, /^ {8}run: xvfb-run -a pnpm smoke:fuses:desktop$/m);

  const secretLines = workflow
    .split(/\r?\n/)
    .filter((line) => line.includes("secrets."));
  assert.ok(secretLines.length > 0, "the workflow still declares release secrets");
  for (const line of secretLines) {
    assert.match(
      line,
      /needs\.preflight\.outputs\.dry_run != 'true'/,
      `release secret must be empty for dry runs: ${line.trim()}`,
    );
  }
});

test("desktop release stages the Rust engine built for the packaged architecture", async () => {
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

  const workflow = await readFile(
    join(process.cwd(), ".github/workflows/desktop-release.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /arch: x64\s+target: x86_64-apple-darwin/,
  );
  assert.match(
    workflow,
    /arch: arm64\s+target: aarch64-apple-darwin/,
  );
  assert.match(
    workflow,
    /arch: x64\s+target: x86_64-pc-windows-msvc/,
  );
  assert.match(
    workflow,
    /arch: x64\s+target: x86_64-unknown-linux-gnu/,
  );
  assert.match(
    stepBlock(workflow, "Build workspace engine"),
    /build:engine -- --target "\$\{\{ matrix\.target \}\}"/,
  );
});

test("desktop release workflow uploads only distributable release assets", async () => {
  const workflow = await readFile(
    join(process.cwd(), ".github/workflows/desktop-release.yml"),
    "utf8",
  );
  const prepareReleaseUpload = stepBlock(workflow, "Prepare release upload");

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
    /latest\*\.yml\|nightly\*\.yml\|\*\.dmg\|\*\.zip\|\*\.exe\|\*\.AppImage\|\*\.blockmap/,
    "release upload step must allow update manifests and configured installer artifacts",
  );
  assert.match(
    prepareReleaseUpload,
    /if ! is_release_upload_file "\$file"; then\s+continue\s+fi/,
    "release upload step must skip non-release files before the basename conflict guard",
  );
});

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
  const manifest = { version, files: [{ url: name, sha512, size: bytes.length }], path: name, sha512 };
  const manifestPath = join(directory, `latest${platform === "win" ? "" : `-${platform}`}.yml`);
  await writeFile(manifestPath, serializeUpdateManifest(manifest));
  return { options: { directory, platform, arch, version, channel: "latest" }, name, manifest, manifestPath };
}

test("release verification hashes distributable files for each configured platform", async () => {
  for (const [platform, arch] of [["win", "x64"], ["linux", "x64"], ["mac", "x64"], ["mac", "arm64"]]) {
    const { options } = await artifactFixture(platform, arch);
    const result = await verifyDesktopReleaseArtifacts(options);
    assert.equal(result.status, "passed");
    assert.equal(result.artifacts.length, platform === "mac" ? 2 : 1);
    assert.ok(result.excludes.includes("installation"));
  }
});

test("release verification rejects changed bytes, version, and legacy updater metadata", async () => {
  const { options, name, manifest, manifestPath } = await artifactFixture();
  await assert.rejects(verifyDesktopReleaseArtifacts({ ...options, version: "0.2.0" }), /Manifest version/);
  await writeFile(manifestPath, serializeUpdateManifest({ ...manifest, sha512: "incorrect" }));
  await assert.rejects(verifyDesktopReleaseArtifacts(options), /Manifest path and SHA-512/);
  await writeFile(manifestPath, serializeUpdateManifest(manifest));
  await writeFile(join(options.directory, name), "different package bytes!");
  await assert.rejects(verifyDesktopReleaseArtifacts(options), /size or SHA-512/);
});

test("release verification rejects missing installers and wrong update architecture", async () => {
  const fixture = await artifactFixture("mac", "arm64");
  await rm(join(fixture.options.directory, "dohc-0.1.0-mac-arm64.dmg"));
  await assert.rejects(verifyDesktopReleaseArtifacts(fixture.options), /ENOENT/);
  const win = await artifactFixture();
  const alternate = "other.exe";
  await writeFile(join(win.options.directory, alternate), await readFile(join(win.options.directory, win.name)));
  const manifest = { ...win.manifest, files: [{ ...win.manifest.files[0], url: alternate }], path: alternate };
  await writeFile(win.manifestPath, serializeUpdateManifest(manifest));
  await assert.rejects(verifyDesktopReleaseArtifacts(win.options), /does not list the x64 update artifact/);
});

test("release verification rejects artifact paths outside the release directory", async () => {
  const { options, name, manifest, manifestPath } = await artifactFixture();
  for (const url of ["../outside.exe", "https://example.com/installer.exe", "..%2Foutside.exe"]) {
    await writeFile(manifestPath, serializeUpdateManifest({ ...manifest, files: [{ ...manifest.files[0], url }] }));
    await assert.rejects(verifyDesktopReleaseArtifacts(options), /local filename/);
  }
  const outside = await mkdtemp(join(tmpdir(), "dohc-artifact-outside-"));
  await writeFile(join(outside, name), "outside");
  await rm(join(options.directory, name));
  // Containment must fail before the file-type check; Windows junctions need no symlink privilege.
  await symlink(outside, join(options.directory, name), process.platform === "win32" ? "junction" : "dir");
  await writeFile(manifestPath, serializeUpdateManifest(manifest));
  await assert.rejects(verifyDesktopReleaseArtifacts(options), /escapes its directory/);
});
