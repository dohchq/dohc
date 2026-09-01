#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentUiAuditBundles,
  readUiAuditBuildProvenance,
  validateUiAuditBundles,
} from "./ui-audit-build-provenance.mjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MIN_SCREENSHOT_BYTES = 10_000;
const MIN_WIDTH = 1_000;
const MIN_HEIGHT = 700;

export const uiAuditCaptureManifestName = "ui-audit-capture.json";

export const expectedUiAuditShots = [
  "01-first-run-dark.png",
  "01-first-run-light.png",
  "02-shell-explorer-light.png",
  "03-editor-doc-light.png",
  "04-editor-doc-dark.png",
  "05-editor-bubble-menu-light.png",
  "06-editor-slash-menu-light.png",
  "07-search-light.png",
  "08-chats-dark.png",
  "08-chats-light.png",
  "09-graph-light.png",
  "10-history-light.png",
  "13-command-palette-light.png",
  "14-quick-open-light.png",
  "15-settings-dark.png",
  "15-settings-light.png",
  "16-csv-light.png",
  "17-shell-dark.png",
  "18-new-file-dialog-light.png",
  "19-settings-appearance-light.png",
  "20-properties-panel-light.png",
];

export function readPngDimensions(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG file");
  }
  if (bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("PNG has no IHDR header");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readCaptureManifest(directory, expectedCommit, expectedBuild) {
  const manifestPath = join(directory, uiAuditCaptureManifestName);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`could not read ${uiAuditCaptureManifestName}${detail}`);
  }
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.state !== "complete" ||
    typeof manifest.commit !== "string" ||
    typeof manifest.startedAt !== "string" ||
    typeof manifest.completedAt !== "string" ||
    typeof manifest.build !== "object" ||
    manifest.build === null ||
    !Array.isArray(manifest.shots)
  ) {
    throw new Error(`${uiAuditCaptureManifestName} has an invalid shape`);
  }
  if (manifest.commit !== expectedCommit) {
    throw new Error(
      `screenshots were captured from ${manifest.commit}; expected ${expectedCommit}`,
    );
  }
  if (
    manifest.build.schemaVersion !== 1 ||
    typeof manifest.build.commit !== "string" ||
    typeof manifest.build.builtAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.build.builtAt))
  ) {
    throw new Error(`${uiAuditCaptureManifestName} has invalid build provenance`);
  }
  if (
    manifest.build.commit !== expectedBuild.commit ||
    (expectedBuild.builtAt !== null &&
      manifest.build.builtAt !== expectedBuild.builtAt)
  ) {
    throw new Error(`${uiAuditCaptureManifestName} does not match the verified desktop build`);
  }
  validateUiAuditBundles(
    manifest.build.bundles,
    expectedBuild.bundles,
    `${uiAuditCaptureManifestName} build provenance`,
  );
  const startedAtMs = Date.parse(manifest.startedAt);
  const completedAtMs = Date.parse(manifest.completedAt);
  if (
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(completedAtMs) ||
    completedAtMs < startedAtMs
  ) {
    throw new Error(`${uiAuditCaptureManifestName} has an invalid capture window`);
  }
  const expectedNames = [...expectedUiAuditShots].sort();
  const names = manifest.shots.map((shot) => shot?.name).sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(`${uiAuditCaptureManifestName} does not name the expected screenshots`);
  }
  const hashes = new Map();
  for (const shot of manifest.shots) {
    if (
      typeof shot?.name !== "string" ||
      typeof shot.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(shot.sha256) ||
      hashes.has(shot.name)
    ) {
      throw new Error(`${uiAuditCaptureManifestName} has an invalid screenshot record`);
    }
    hashes.set(shot.name, shot.sha256);
  }
  return { manifest, hashes };
}

function validateBundleHashes(actual, expected) {
  validateUiAuditBundles(actual, expected, `captured ${uiAuditCaptureManifestName}`);
}

export function validateUiAuditDirectory(
  directory,
  expectedCommit,
  expectedBundles,
  expectedBuild = { commit: expectedCommit, builtAt: null, bundles: expectedBundles },
) {
  if (typeof expectedCommit !== "string" || !/^[0-9a-f]{40}$/.test(expectedCommit)) {
    throw new Error("expectedCommit must be a full Git commit id");
  }
  const capture = readCaptureManifest(directory, expectedCommit, expectedBuild);
  validateBundleHashes(capture.manifest.bundles, expectedBundles);
  const shots = expectedUiAuditShots.map((name) => {
    const path = join(directory, name);
    const metadata = statSync(path);
    const size = metadata.size;
    if (size < MIN_SCREENSHOT_BYTES) {
      throw new Error(`${name} is only ${size} bytes; the capture may be blank`);
    }
    const bytes = readFileSync(path);
    const dimensions = readPngDimensions(bytes);
    if (dimensions.width < MIN_WIDTH || dimensions.height < MIN_HEIGHT) {
      throw new Error(
        `${name} is ${dimensions.width}x${dimensions.height}; expected at least ${MIN_WIDTH}x${MIN_HEIGHT}`,
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (capture.hashes.get(name) !== sha256) {
      throw new Error(`${name} does not match its capture manifest`);
    }
    return {
      name,
      size,
      sha256,
      modifiedAt: metadata.mtime.toISOString(),
      ...dimensions,
    };
  });

  return {
    directory: resolve(directory),
    capture: {
      commit: capture.manifest.commit,
      startedAt: capture.manifest.startedAt,
      completedAt: capture.manifest.completedAt,
      build: capture.manifest.build,
      bundles: capture.manifest.bundles,
    },
    shots,
  };
}

function repoRoot() {
  return resolve(fileURLToPath(import.meta.url), "../../../../");
}

function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot(),
    encoding: "utf8",
  }).trim();
}

function worktreeDirty() {
  return (
    execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot(),
      encoding: "utf8",
    }).trim() !== ""
  );
}

function currentBundleHashes() {
  const desktopRoot = resolve(repoRoot(), "apps/desktop");
  return currentUiAuditBundles(desktopRoot);
}

function runCli(args) {
  if (args.length < 1 || args.length > 2) {
    throw new Error("usage: validate-ui-audit.mjs <screenshot-dir> [report.json]");
  }
  const commit = currentCommit();
  if (worktreeDirty()) {
    throw new Error("commit the worktree before validating UI audit evidence");
  }
  const desktopRoot = resolve(repoRoot(), "apps/desktop");
  const bundles = currentBundleHashes();
  const build = readUiAuditBuildProvenance(desktopRoot, commit, bundles);
  const result = {
    validatedCommit: commit,
    worktreeDirty: false,
    validatedAt: new Date().toISOString(),
    ...validateUiAuditDirectory(args[0], commit, bundles, build),
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args[1]) writeFileSync(args[1], json, "utf8");
  process.stdout.write(json);
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
