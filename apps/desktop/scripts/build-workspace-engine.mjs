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
const defaultDesktopDir = resolve(scriptDir, "..");
const defaultRepoRoot = resolve(scriptDir, "../../..");

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function parseTargetArgument(args) {
  if (args.length === 0) return undefined;
  if (
    args.length !== 2 ||
    args[0] !== "--target" ||
    !/^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)+$/.test(args[1])
  ) {
    throw new Error(
      "Usage: build-workspace-engine.mjs [--target <Rust target triple>]",
    );
  }
  return args[1];
}

export function buildWorkspaceEngine({
  repoRoot = defaultRepoRoot,
  desktopDir = defaultDesktopDir,
  platform = process.platform,
  target,
  runCargo = spawnSync,
} = {}) {
  const binaryName = `dohc-workspace-engine${
    target?.includes("-windows-") || (!target && platform === "win32")
      ? ".exe"
      : ""
  }`;
  const builtBinary = target
    ? join(repoRoot, "target", target, "release", binaryName)
    : join(repoRoot, "target", "release", binaryName);
  const resourceDir = join(desktopDir, "resources", "workspace-engine");
  const stagedBinary = join(resourceDir, binaryName);
  const cargoArgs = ["build", "--release", "--bin", "dohc-workspace-engine"];
  if (target) cargoArgs.push("--target", target);

  mkdirSync(resourceDir, { recursive: true });
  rmSync(stagedBinary, { force: true });

  const cargo = runCargo("cargo", cargoArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (cargo.error) {
    throw new Error("cargo could not build the Rust workspace engine.", {
      cause: cargo.error,
    });
  }
  if (cargo.status !== 0) {
    if (cargo.stdout?.trim()) console.error(cargo.stdout.trim());
    if (cargo.stderr?.trim()) console.error(cargo.stderr.trim());
    throw new Error(
      `Rust workspace engine build failed with exit code ${cargo.status}.`,
    );
  }
  if (!isFile(builtBinary)) {
    const targetDescription = target ? ` for target ${target}` : "";
    throw new Error(
      `cargo succeeded but the Rust workspace engine${targetDescription} is missing: ${builtBinary}`,
    );
  }

  copyFileSync(builtBinary, stagedBinary);
  if (!binaryName.endsWith(".exe")) chmodSync(stagedBinary, 0o755);
  console.log(
    `[workspace-engine] staged ${stagedBinary}${
      target ? ` from target ${target}` : ""
    }`,
  );
  return { builtBinary, stagedBinary, target };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  buildWorkspaceEngine({ target: parseTargetArgument(process.argv.slice(2)) });
}
