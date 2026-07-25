#!/usr/bin/env node
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const desktopDir = resolve(dirname(scriptPath), "..");

function engineBinaryName(platform) {
  return `dohc-workspace-engine${platform === "win32" ? ".exe" : ""}`;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function requireWorkspaceEngine(
  resourceDir = join(desktopDir, "resources", "workspace-engine"),
  platform = process.platform,
) {
  const binary = join(resourceDir, engineBinaryName(platform));
  if (!isFile(binary)) {
    throw new Error(
      `Refusing to package without the Rust workspace engine binary: ${binary}`,
    );
  }
}

export default function requireWorkspaceEngineBeforePack() {
  requireWorkspaceEngine();
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    requireWorkspaceEngine(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
