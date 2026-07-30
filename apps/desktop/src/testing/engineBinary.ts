import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// One place that answers "where is the engine daemon this test should drive?".
// Four suites each answered it differently and one of them answered wrong: it
// looked only under the repo root, so its coverage appeared or vanished
// depending on whether somebody had run `cargo build` first, and a clean
// checkout reported green having run nothing (#390).
//
// Candidates, tried in order:
// 1. DOHC_TEST_ENGINE_BINARY — explicit override, resolved absolute, and nothing
//    else is consulted.
// 2. <repo>/target/debug — where `cargo build` puts it. AUTHORITATIVE for tests,
//    because it is the only one a build refreshes.
// 3. apps/desktop/target/debug — a *copy* staged for Electron by
//    scripts/require-e2e-engine.mjs, which the app resolves at launch.
//
// Root before staged, first match, no mtime comparison. An earlier revision of
// this module compared mtimes to answer "which of these is fresher", and that
// heuristic generated four separate defects in review — seed/app skew, a
// clobbered override, an unresolved relative path, and a symlink whose target got
// overwritten. The simpler answer is that freshness is not this module's
// question: `cargo build` owns (2), the staging hook owns (3) and keeps it equal
// to (2) or to the override, and a test just needs the cargo output.
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
    join(desktopRoot, "..", "..", "target", "debug", name),
    join(desktopRoot, "target", "debug", name),
  ];
}

/**
 * The first candidate that exists, or null when none does.
 *
 * First match, not newest. See the ordering note above: the workspace-root cargo
 * output is authoritative for tests, and keeping the staged copy in step with it
 * is the staging hook's job, not this module's.
 */
export function findEngineBinary(
  candidates: readonly string[] = engineBinaryCandidates(),
): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
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
