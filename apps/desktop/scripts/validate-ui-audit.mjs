#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MIN_SCREENSHOT_BYTES = 10_000;
const MIN_WIDTH = 1_000;
const MIN_HEIGHT = 700;

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

export function validateUiAuditDirectory(directory) {
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
    return {
      name,
      size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      modifiedAt: metadata.mtime.toISOString(),
      ...dimensions,
    };
  });

  return { directory: resolve(directory), shots };
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

function runCli(args) {
  if (args.length < 1 || args.length > 2) {
    throw new Error("usage: validate-ui-audit.mjs <screenshot-dir> [report.json]");
  }
  const result = {
    validatedCommit: currentCommit(),
    worktreeDirty: worktreeDirty(),
    validatedAt: new Date().toISOString(),
    ...validateUiAuditDirectory(args[0]),
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
