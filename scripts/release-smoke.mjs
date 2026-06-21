#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDesktopRelease } from "./resolve-desktop-release.mjs";
import { updateDesktopPackageVersion } from "./update-desktop-package-version.mjs";
import {
  mergeUpdateManifests,
  parseUpdateManifest,
} from "./merge-update-manifests.mjs";
import { createMockUpdateServer } from "./mock-update-server.mjs";

async function main() {
  const root = await mkdtemp(join(tmpdir(), "dohc-release-smoke-"));
  await mkdir(join(root, "apps/desktop"), { recursive: true });
  await writeFile(
    join(root, "apps/desktop/package.json"),
    `${JSON.stringify({ name: "@dohc/desktop", version: "0.1.0" }, null, 2)}\n`,
  );

  const nightly = await resolveDesktopRelease({
    root,
    channel: "nightly",
    date: "20260621",
    runNumber: 1,
    runAttempt: 1,
    sha: "0123456789abcdef",
  });
  assert.equal(nightly.version, "0.1.1-nightly.20260621.1.1");

  const stamp = await updateDesktopPackageVersion(nightly.version, { root });
  assert.equal(stamp.changed, true);

  const merged = mergeUpdateManifests(
    parseUpdateManifest(`
version: ${nightly.version}
files:
  - url: dohc-arm64.zip
    sha512: a
    size: 1
path: dohc-arm64.zip
sha512: a
`),
    parseUpdateManifest(`
version: ${nightly.version}
files:
  - url: dohc-x64.zip
    sha512: b
    size: 2
path: dohc-x64.zip
sha512: b
`),
    "mac",
  );
  assert.equal(merged.files.length, 2);

  await writeFile(join(root, "latest.yml"), "version: 0.1.0\n");
  const server = await createMockUpdateServer({ root });
  try {
    const response = await fetch(`${server.url}/latest.yml`);
    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }

  console.log("Desktop release smoke passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error : String(error));
  process.exitCode = 1;
});
