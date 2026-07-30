#!/usr/bin/env node
import { copyFileSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
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

// Two symlink hazards, in opposite directions, both destructive.
//
// 1. The DESTINATION is a link: copyFileSync follows it and overwrites its
//    TARGET, so a developer who links the staged path at the repo-root build
//    would have test setup silently rewrite that build. Hence the unlink first.
// 2. The SOURCE is a link pointing AT the destination (the inverse alias):
//    unlinking the destination first destroys the very file the copy is about to
//    read, failing with ENOENT and leaving no staged daemon at all.
//
// `realpathSync` — not `resolve` — is what separates these, because `resolve`
// normalises a path string without following links. Same real file means there is
// nothing to copy and nothing to remove.
function sameRealFile(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    // Either side may not exist yet, in which case they are not the same file.
    return false;
  }
}

function stageBinary(from, to) {
  if (sameRealFile(from, to)) return false;
  rmSync(to, { force: true });
  copyFileSync(from, to);
  return true;
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
    mkdirSync(desktopTargetDir, { recursive: true });
    // stageBinary reports false when source and destination are the same real
    // file — including via a symlink either way, which resolve() cannot see.
    const staged = stageBinary(override, wanted);
    return { binary: wanted, copied: staged, refreshed: staged };
  }

  const built = join(cargoTargetDir, name);

  // The workspace-root build wins whenever it exists, with no mtime comparison.
  // It is authoritative because `cargo build` is the only thing that refreshes
  // it, and src/testing/engineBinary.ts now resolves it FIRST for the seed
  // helper — so any branch that left a different file staged would have Electron
  // launch one daemon while the seed used another. Keeping a "newer" staged copy
  // is exactly that hole: a previous run's override can be newer than a fresh
  // build. The deliberate-custom-artifact case is the override above, which is
  // the supported way to say "use this one".
  if (isFile(built)) {
    mkdirSync(desktopTargetDir, { recursive: true });
    const hadStaged = isFile(wanted);
    // Report what actually happened. stageBinary returns false when the two
    // paths are the same real file — a symlink either way — and hardcoding
    // `copied: true` here would tell a caller a copy occurred that did not.
    const staged = stageBinary(built, wanted);
    return { binary: wanted, copied: staged, refreshed: staged && hadStaged };
  }

  // No build to stage. An existing staged copy is all there is, so the app can
  // still launch — but the seed helper will resolve this same file, since the
  // root candidate does not exist.
  if (isFile(wanted)) {
    return { binary: wanted, copied: false, refreshed: false };
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
