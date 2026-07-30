import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// One place that answers "where is the engine daemon this test should drive?".
// Four suites each answered it differently and one of them answered wrong: it
// looked only under the repo root, so its coverage appeared or vanished
// depending on whether somebody had run `cargo build` first, and a clean
// checkout reported green having run nothing (#390).
//
// Resolution order mirrors how the binary actually lands on disk:
// 1. DOHC_TEST_ENGINE_BINARY — explicit override, used verbatim.
// 2. apps/desktop/target/debug — what the app under test resolves in e2e
//    (defaultEngineBinaryPath from appPath dist/main -> ../..), and where
//    staged-binary harnesses copy it.
// 3. <repo>/target/debug — where a repo-root `cargo build` places it.
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
  if (override) return [override];
  const name = `dohc-workspace-engine${process.platform === "win32" ? ".exe" : ""}`;
  return [
    join(desktopRoot, "target", "debug", name),
    join(desktopRoot, "..", "..", "target", "debug", name),
  ];
}

/** The first candidate that exists, or null when none does. */
export function findEngineBinary(): string | null {
  for (const candidate of engineBinaryCandidates()) {
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
