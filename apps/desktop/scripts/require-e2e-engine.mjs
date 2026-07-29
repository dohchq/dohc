#!/usr/bin/env node
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Unpackaged, the app resolves its daemon at <desktop>/target/debug (see
// defaultEngineBinaryPath: appPath is dist/main under Electron, then ../..).
// Nothing in the build produces it there, so a fresh checkout runs the whole
// e2e suite against an app that cannot start — every spec fails inside
// electron.launch with the real cause buried in Playwright's log. That cost
// this project one full, entirely invalid 30-failure run. Fail before the
// suite instead, and copy the binary over when a normal cargo build has
// already produced it at the workspace root.
const scriptPath = fileURLToPath(import.meta.url);
const desktopDir = resolve(dirname(scriptPath), "..");
const repoDir = resolve(desktopDir, "../..");

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

export function requireE2eEngine({
  desktopTargetDir = join(desktopDir, "target", "debug"),
  cargoTargetDir = join(repoDir, "target", "debug"),
  platform = process.platform,
} = {}) {
  const name = engineBinaryName(platform);
  const wanted = join(desktopTargetDir, name);
  if (isFile(wanted)) return { binary: wanted, copied: false };

  const built = join(cargoTargetDir, name);
  if (isFile(built)) {
    mkdirSync(desktopTargetDir, { recursive: true });
    copyFileSync(built, wanted);
    return { binary: wanted, copied: true };
  }

  throw new Error(
    [
      `The desktop e2e suite needs a debug engine daemon at:`,
      `  ${wanted}`,
      ``,
      `Neither it nor a built one at ${built} exists, so every spec would fail`,
      `inside electron.launch rather than telling you why. Build it first:`,
      ``,
      `  cargo build --bin dohc-workspace-engine`,
      ``,
      `then re-run — this check copies it into place for you.`,
    ].join("\n"),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const { binary, copied } = requireE2eEngine();
    if (copied) console.info(`[e2e] staged the engine daemon at ${binary}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
