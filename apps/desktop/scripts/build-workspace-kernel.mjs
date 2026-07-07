#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(scriptDir, "../../..");
const manifestPath = join(repoRoot, "crates/workspace-kernel/Cargo.toml");
const binaryName = `dohc-workspace-kernel${process.platform === "win32" ? ".exe" : ""}`;
const builtBinary = join(
  repoRoot,
  "crates/workspace-kernel/target/release",
  binaryName,
);
const resourceDir = join(desktopDir, "resources/workspace-kernel");
const stagedBinary = join(resourceDir, binaryName);

function warn(message, error) {
  console.warn(`[workspace-kernel] ${message}`);
  if (error instanceof Error && error.message) console.warn(`[workspace-kernel] ${error.message}`);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// "Degrade, never fail the JS build": even the staging fs ops are best-effort.
// A read-only resources dir or a locked stale binary must warn and skip, not
// abort packaging of the rest of the app.
try {
  mkdirSync(resourceDir, { recursive: true });
  rmSync(stagedBinary, { force: true });
} catch (error) {
  warn("could not prepare the staging directory; packaging will omit the workspace kernel binary.", error);
  process.exit(0);
}

if (process.env.DOHC_SKIP_WORKSPACE_KERNEL_BUILD === "1") {
  warn("DOHC_SKIP_WORKSPACE_KERNEL_BUILD=1; packaging will omit the workspace kernel binary.");
  process.exit(0);
}

const cargo = spawnSync(
  "cargo",
  ["build", "--release", "--manifest-path", manifestPath],
  {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);

if (cargo.error) {
  warn("cargo is unavailable; packaging will omit the workspace kernel binary.", cargo.error);
  process.exit(0);
}

if (cargo.status !== 0) {
  warn("cargo build failed; packaging will omit the workspace kernel binary.");
  if (cargo.stdout.trim()) console.warn(cargo.stdout.trim());
  if (cargo.stderr.trim()) console.warn(cargo.stderr.trim());
  process.exit(0);
}

if (!isFile(builtBinary)) {
  warn(`cargo build completed but did not produce ${builtBinary}; packaging will omit the workspace kernel binary.`);
  process.exit(0);
}

try {
  copyFileSync(builtBinary, stagedBinary);
} catch (error) {
  warn("could not stage the built binary; packaging will omit the workspace kernel binary.", error);
  process.exit(0);
}
console.log(`[workspace-kernel] staged ${stagedBinary}`);
