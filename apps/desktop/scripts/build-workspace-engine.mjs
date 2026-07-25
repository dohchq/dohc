#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(scriptDir, "../../..");
const binaryName = `dohc-workspace-engine${process.platform === "win32" ? ".exe" : ""}`;
const builtBinary = join(repoRoot, "target", "release", binaryName);
const resourceDir = join(desktopDir, "resources", "workspace-engine");
const stagedBinary = join(resourceDir, binaryName);

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

mkdirSync(resourceDir, { recursive: true });
rmSync(stagedBinary, { force: true });

const cargo = spawnSync(
  "cargo",
  ["build", "--release", "--bin", "dohc-workspace-engine"],
  {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);

if (cargo.error) {
  throw new Error("cargo could not build the Rust workspace engine.", {
    cause: cargo.error,
  });
}
if (cargo.status !== 0) {
  if (cargo.stdout.trim()) console.error(cargo.stdout.trim());
  if (cargo.stderr.trim()) console.error(cargo.stderr.trim());
  throw new Error(
    `Rust workspace engine build failed with exit code ${cargo.status}.`,
  );
}
if (!isFile(builtBinary)) {
  throw new Error(
    `cargo succeeded but the Rust workspace engine is missing: ${builtBinary}`,
  );
}

copyFileSync(builtBinary, stagedBinary);
if (process.platform !== "win32") chmodSync(stagedBinary, 0o755);
console.log(`[workspace-engine] staged ${stagedBinary}`);
