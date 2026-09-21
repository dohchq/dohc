#!/usr/bin/env node
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireAppCompiler } from "./stage-app-compiler.mjs";
import { requireAppBackendRuntime } from "./stage-app-backend-runtime.mjs";

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

export default async function requireWorkspaceEngineBeforePack(context) {
  requireWorkspaceEngine();
  await requireAppBackendRuntime();
  // electron-builder's architecture enum: x64=1, arm64=3. Reject mismatched
  // cross-packaging instead of shipping a compiler that cannot start.
  const arch = context?.arch === undefined ? process.arch : context.arch === 1 ? "x64" : context.arch === 3 ? "arm64" : "unsupported";
  await requireAppCompiler(undefined, context?.electronPlatformName ?? process.platform, arch);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    requireWorkspaceEngine(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
