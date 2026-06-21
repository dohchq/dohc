import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

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

test("mock update server serves files and blocks traversal/symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dohc-update-server-"));
  const outside = await mkdtemp(join(tmpdir(), "dohc-outside-"));
  await writeFile(join(root, "latest.yml"), "version: 0.1.0\n");
  await writeFile(join(outside, "secret.txt"), "nope");
  await symlink(join(outside, "secret.txt"), join(root, "secret-link.txt"));

  assert.ok(await resolveServablePath(root, "/latest.yml"));
  assert.equal(await resolveServablePath(root, "/../secret.txt"), null);
  assert.equal(await resolveServablePath(root, "/latest%00.yml"), null);
  assert.equal(await resolveServablePath(root, "/secret-link.txt"), null);

  const server = await createMockUpdateServer({ root });
  try {
    const ok = await fetch(`${server.url}/latest.yml`);
    const escaped = await fetch(`${server.url}/../secret.txt`);
    const nul = await fetch(`${server.url}/latest%00.yml`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") ?? "", /^text\/yaml/);
    assert.equal(await ok.text(), "version: 0.1.0\n");
    assert.equal(escaped.status, 404);
    assert.equal(nul.status, 404);
  } finally {
    await server.close();
  }
});
