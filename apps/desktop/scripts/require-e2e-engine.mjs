#!/usr/bin/env node
import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
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

// copyFileSync FOLLOWS a symlink at the destination and overwrites its TARGET.
// A developer who links the staged path at the repo-root build would have
// test setup silently rewrite that build. Replace the entry instead.
function stageBinary(from, to) {
  rmSync(to, { force: true });
  copyFileSync(from, to);
}

function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// Kept as a literal rather than imported from src/testing/engineBinary.ts: this
// script runs as plain node from a pnpm lifecycle hook, with no TS loader.
const overrideEnvVar = "DOHC_TEST_ENGINE_BINARY";

export function requireE2eEngine({
  desktopTargetDir = join(desktopDir, "target", "debug"),
  cargoTargetDir = join(repoDir, "target", "debug"),
  platform = process.platform,
  override = process.env[overrideEnvVar]?.trim() || null,
} = {}) {
  const name = engineBinaryName(platform);
  const wanted = join(desktopTargetDir, name);

  // An explicit override wins, and it has to win HERE too. Electron always
  // launches the staged path, so honouring the override only in the seed helper
  // would leave Playwright seeding with the override and exercising whatever sat
  // in the staged path — the same skew this refresh exists to remove, arriving
  // from the other direction. Stage the override itself so both agree.
  if (override) {
    if (!isFile(override)) {
      throw new Error(
        `${overrideEnvVar}=${override} does not exist, so the e2e app cannot launch a daemon.`,
      );
    }
    if (resolve(override) === resolve(wanted)) {
      return { binary: wanted, copied: false, refreshed: false };
    }
    mkdirSync(desktopTargetDir, { recursive: true });
    stageBinary(override, wanted);
    return { binary: wanted, copied: true, refreshed: true };
  }

  const built = join(cargoTargetDir, name);

  // A staged copy that exists is not necessarily the one you just built.
  // `cargo build` refreshes only the workspace-root binary, so leaving an older
  // staged file in place makes Electron launch stale daemon code — while the
  // seed helper, which picks the newest candidate, uses the fresh one. The
  // specs would then seed with one daemon version and exercise another: skew
  // that either fails for no reason or passes while testing the wrong artifact.
  if (isFile(wanted)) {
    const stagedAt = mtimeMs(wanted);
    const builtAt = isFile(built) ? mtimeMs(built) : null;
    if (stagedAt !== null && builtAt !== null && builtAt > stagedAt) {
      stageBinary(built, wanted);
      return { binary: wanted, copied: true, refreshed: true };
    }
    return { binary: wanted, copied: false, refreshed: false };
  }

  if (isFile(built)) {
    mkdirSync(desktopTargetDir, { recursive: true });
    stageBinary(built, wanted);
    return { binary: wanted, copied: true, refreshed: false };
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
