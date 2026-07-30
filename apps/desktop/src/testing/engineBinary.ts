import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// One place that answers "where is the engine daemon this test should drive?".
// Four suites each answered it differently and one of them answered wrong: it
// looked only under the repo root, so its coverage appeared or vanished
// depending on whether somebody had run `cargo build` first, and a clean
// checkout reported green having run nothing (#390).
//
// Candidates, in the order they are listed for diagnostics:
// 1. DOHC_TEST_ENGINE_BINARY — explicit override, and nothing else is consulted.
// 2. apps/desktop/target/debug — what the app under test resolves in e2e
//    (defaultEngineBinaryPath from appPath dist/main -> ../..), and where
//    staged-binary harnesses copy it.
// 3. <repo>/target/debug — where a repo-root `cargo build` places it.
//
// When several exist, the NEWEST wins rather than the first. `cargo build`
// updates only (3), while `scripts/require-e2e-engine.mjs` leaves a *copy* at
// (2) — so first-match ordering would silently run these suites against daemon
// code from an earlier build. Three of the four suites previously read (3)
// directly, so preferring a stale staged copy would have been a regression in
// freshness, and with CI disabled these local runs are the only safety net.
//
// This module holds no Playwright or vitest import, so both `src/**` tests and
// `e2e/**` helpers can use it. It computes the desktop root itself rather than
// importing `desktopRoot` from `e2e/helpers/desktopApp`, which loads Playwright
// at module scope.
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The only supported override. */
export const ENGINE_BINARY_ENV_VAR = "DOHC_TEST_ENGINE_BINARY";

/** Set to "1" to turn a missing binary into a failure instead of a skip. */
export const REQUIRE_ENGINE_ENV_VAR = "DOHC_REQUIRE_ENGINE_E2E";

/**
 * Every path that could hold the binary, in the order they are tried. An
 * override collapses the list to itself: the point of an override is that
 * nothing else is consulted.
 */
export function engineBinaryCandidates(): string[] {
  const override = process.env[ENGINE_BINARY_ENV_VAR]?.trim();
  // Absolute, always. EngineDaemonLifecycle sets the child's cwd to
  // dirname(command) and then spawns `command` from there, so a relative
  // override like ./artifacts/engine.exe would be resolved a second time
  // against its own directory — artifacts/artifacts/engine.exe — and fail the
  // startup handshake. The relay suite used to call resolve() itself; that
  // normalisation belongs here now that discovery is shared.
  if (override) return [resolve(override)];
  const name = `dohc-workspace-engine${process.platform === "win32" ? ".exe" : ""}`;
  return [
    join(desktopRoot, "target", "debug", name),
    join(desktopRoot, "..", "..", "target", "debug", name),
  ];
}

/**
 * The NEWEST candidate that exists, or null when none does.
 *
 * Newest rather than first: a staged copy and a fresh `cargo build` output can
 * both exist, and only mtime distinguishes the one that matches the checked-out
 * Rust code. An override short-circuits this — `engineBinaryCandidates()`
 * already collapses to it, so there is nothing to compare.
 */
export function findEngineBinary(
  candidates: readonly string[] = engineBinaryCandidates(),
): string | null {
  let best: { path: string; mtimeMs: number } | null = null;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(candidate).mtimeMs;
    } catch {
      // Raced away between the existsSync and the stat; treat as absent.
      continue;
    }
    if (best === null || mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs };
  }
  return best?.path ?? null;
}

function missingBinaryError(requiredMode: boolean): Error {
  const candidates = engineBinaryCandidates();
  return new Error(
    "dohc-workspace-engine debug binary not found. Tried:\n" +
      candidates.map((candidate) => `  ${candidate}`).join("\n") +
      `\nBuild it (cargo build -p dohc-workspace-engine) or set ${ENGINE_BINARY_ENV_VAR}.` +
      (requiredMode
        ? `\n${REQUIRE_ENGINE_ENV_VAR}=1 makes this a failure rather than a skip.`
        : ""),
  );
}

/**
 * The binary path, or a thrown error naming every candidate tried. Use this
 * where a suite or helper cannot proceed without a daemon at all.
 */
export function resolveEngineBinary(): string {
  const found = findEngineBinary();
  if (found === null) throw missingBinaryError(false);
  return found;
}

export interface EngineBinaryGate {
  /** The resolved binary, or null when the suite must skip. */
  readonly path: string | null;
  /** Pass straight to `it.skipIf(...)`. */
  readonly missing: boolean;
  /**
   * The binary path inside a test body. Throws when there is none — reaching
   * it means the `it.skipIf(gate.missing)` guard is absent.
   */
  require(): string;
}

/**
 * Decides once, at module scope, whether a daemon-driving suite can run.
 *
 * A skip is right for a developer who has not built the daemon and wrong for
 * CI, where it is the difference between a suite guarding the real daemon and
 * reporting green without running. Set DOHC_REQUIRE_ENGINE_E2E=1 to throw
 * instead. Same pattern as DOHC_REQUIRE_POSTGRES.
 */
export function requireEngineBinaryOrSkip(): EngineBinaryGate {
  const found = findEngineBinary();
  if (found === null && process.env[REQUIRE_ENGINE_ENV_VAR] === "1") {
    throw missingBinaryError(true);
  }
  return {
    path: found,
    missing: found === null,
    require(): string {
      if (found === null) throw missingBinaryError(false);
      return found;
    },
  };
}
