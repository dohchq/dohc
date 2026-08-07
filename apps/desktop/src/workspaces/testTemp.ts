import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  rmdir,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const SCRATCH_PARENT = "dohc-test-scratch";
// How long a run root must be untouched before this sweep may remove it.
//
// This sweep walks the parent every runtime shares, so it can reach a live Rust
// soak's workspace, not just an abandoned vitest run. It is a limit that
// destroys work, so it is set past the longest run this repo asks for:
// `tools/rust-engine-program/soak-config.json` declares
// `postCutoverContinuous.durationsHours: [6, 24]`. Double the longest.
const MAX_RUN_AGE_MS = 48 * 60 * 60 * 1_000;
// Windows refuses to unlink a file whose handle is still open, and a just-closed
// SQLite handle can hold one for a beat. This is the budget the e2e helper this
// replaces already used: `100ms * attempt` over 8 attempts.
const WINDOWS_CLEANUP_ATTEMPTS = 8;
const WINDOWS_CLEANUP_DELAY_MS = 100;
// The shape a run root's name has: a component, the id of the process that
// made it, and a 16-digit hex nonce — `process-4821-3f9a1c0d5e2b7648`, or
// `rust-gate-1180-...` from the gate that hands one down. The sweep's next act
// is a recursive delete, so it removes only names carrying this shape. An aged
// directory somebody else left in the shared parent is not this sweep's to
// remove. The Rust twin's `is_run_root_name` reads the same way.
//
// A root named by `DOHC_TEST_SCRATCH_RUN` is never swept: whoever named it owns
// it. `scratchRunId` refuses a configured id of this shape for that reason —
// otherwise `ci-123-0123456789abcdef` would be deleted as one we generated, and
// ownership would rest on a name rather than on who made the directory.
const RUN_ROOT_NAME = /^.+-\d+-[0-9a-f]{16}$/u;

const testScratch = new Set<string>();
const suiteScratch = new Set<string>();
// Paths whose removal lost to an open handle. They stay here so the final
// drain retries them and, failing that, fails the suite. Dropping them and
// logging instead would leave the tree behind under a green run, and the only
// run-level scratch reporter in this repo runs from the Rust gate — it never
// sees a JS run at all.
const unresolvedScratch = new Set<string>();
let startup: Promise<void> | undefined;
let processRunId: string | undefined;

function nativeTmpdir(): string {
  // In WSL, os.tmpdir() can inherit Windows TEMP/TMP and land under /mnt/c,
  // where watcher and SQLite behavior can differ from native Linux temp.
  // Windows keeps using the platform temp dir.
  return process.platform !== "win32" && existsSync("/tmp") ? "/tmp" : tmpdir();
}

export function testScratchRunRoot(): string {
  // A caller that also inspects this tree hands the absolute root down rather
  // than deriving it again. `nativeTmpdir()` here and `std::env::temp_dir()` in
  // Rust do not agree under WSL, and a runner counting its own guess would
  // report an absent tree as clean.
  const handedDown = process.env.DOHC_TEST_SCRATCH_ROOT;
  if (handedDown) {
    if (!isAbsolute(handedDown)) {
      throw new Error("DOHC_TEST_SCRATCH_ROOT must be an absolute path");
    }
    return handedDown;
  }
  return join(nativeTmpdir(), SCRATCH_PARENT, scratchRunId());
}

export async function createTestScratch(prefix: string): Promise<string> {
  await ensureScratchRun();
  const path = await mkdtemp(join(testScratchRunRoot(), safePrefix(prefix)));
  testScratch.add(path);
  return path;
}

export function createTestScratchSync(prefix: string): string {
  ensureScratchRunSync();
  const path = mkdtempSync(join(testScratchRunRoot(), safePrefix(prefix)));
  testScratch.add(path);
  return path;
}

export function createSuiteTestScratchSync(prefix: string): string {
  ensureScratchRunSync();
  const path = mkdtempSync(join(testScratchRunRoot(), safePrefix(prefix)));
  suiteScratch.add(path);
  return path;
}

export async function cleanupTestScratch(): Promise<void> {
  await cleanupRegistered(testScratch);
}

export async function cleanupSuiteTestScratch(): Promise<void> {
  await cleanupRegistered(suiteScratch);
  // Last chance for anything an earlier drain could not remove. Every server
  // and database this suite opened is closed by now, so the handles that beat
  // those attempts are gone.
  await cleanupRegistered(unresolvedScratch);
  await removeEmptyRunRoot();
  if (unresolvedScratch.size > 0) {
    const remaining = [...unresolvedScratch].sort();
    unresolvedScratch.clear();
    throw new Error(
      `scratch cleanup failed after ${cleanupAttempts()} attempts for ${remaining.length} director${remaining.length === 1 ? "y" : "ies"}, which would leak: ${remaining.join(", ")}`,
    );
  }
}

export async function removeTestScratch(path: string): Promise<void> {
  testScratch.delete(path);
  suiteScratch.delete(path);
  const error = await removeTreeWithRetry(path);
  if (error) {
    unresolvedScratch.add(path);
    console.error(
      `scratch cleanup failed after ${cleanupAttempts()} attempts for ${path}: ${error.message}; retrying when the suite ends, and failing the suite if it still cannot go`,
    );
    return;
  }
  unresolvedScratch.delete(path);
}

export async function sweepOldTestScratch(): Promise<void> {
  const currentRun = testScratchRunRoot();
  await sweepScratchParent(join(nativeTmpdir(), SCRATCH_PARENT), currentRun, Date.now());
}

export async function sweepScratchParent(
  parent: string,
  currentRun: string,
  nowMs: number,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(parent);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const path = join(parent, name);
    if (path === currentRun || !RUN_ROOT_NAME.test(name)) continue;
    let metadata;
    try {
      // `lstat` for the same reason `isIdleSince` uses it, and for one more: a
      // cyclic link left by a killed run answers `stat` with ELOOP, which is
      // not ENOENT, so the sweep would throw and every later test process would
      // fail its startup sweep on it. A link is not a run root — skip it, as
      // the Rust twin's `entry.file_type()` already does.
      metadata = await lstat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isDirectory() || !(await isIdleSince(path, nowMs))) {
      continue;
    }
    const error = await removeTreeWithRetry(path);
    if (error) {
      console.error(
        `scratch sweep could not remove aged run ${path} after ${cleanupAttempts()} attempts: ${error.message}`,
      );
    }
  }
}

function scratchRunId(): string {
  const configured = process.env.DOHC_TEST_SCRATCH_RUN;
  if (configured) {
    if (
      !/^[A-Za-z0-9._-]+$/u.test(configured) ||
      configured === "." ||
      configured === ".."
    ) {
      throw new Error(
        "DOHC_TEST_SCRATCH_RUN must contain only ASCII letters, digits, periods, hyphens, or underscores",
      );
    }
    if (RUN_ROOT_NAME.test(configured)) {
      throw new Error(
        `DOHC_TEST_SCRATCH_RUN must not end in \`-<digits>-<16 hex>\`, the shape of a generated run id: ${configured}. The sweep removes names of that shape as runs it created, and a root you named is yours to remove.`,
      );
    }
    return configured;
  }
  // The shape `RUN_ROOT_NAME` describes, and the only run root name this
  // module invents. Change one and the sweep stops reclaiming the other.
  processRunId ??= `process-${process.pid}-${randomBytes(8).toString("hex")}`;
  return processRunId;
}

/// Whether nothing anywhere under `path` has been touched inside the max age.
///
/// A directory's mtime moves when its own entries change, not when a file
/// deeper inside is written. A soak that spends a day writing into a workspace
/// it created in its first minute leaves the root looking untouched, so reading
/// only the root would delete live work. Stop at the first recent thing found.
///
/// `lstat`, never `stat`: a link is a leaf here, exactly as `symlink_metadata`
/// makes it one in the Rust twin. Following one asks about a tree this run does
/// not own — an external target with recent files would pin an abandoned run
/// forever, and a cycle answers `ELOOP`, which reads as "still busy" and pins it
/// the same way.
export async function isIdleSince(path: string, nowMs: number): Promise<boolean> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    return false;
  }
  if (nowMs - metadata.mtimeMs <= MAX_RUN_AGE_MS) return false;
  if (!metadata.isDirectory()) return true;
  let names: string[];
  try {
    names = await readdir(path);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!(await isIdleSince(join(path, name), nowMs))) return false;
  }
  return true;
}

// `.` and `..` are not names, they are directions. `join` folds them away
// before `mkdtemp` appends its suffix, so a `.` prefix would put the scratch
// beside the run root and a `..` prefix beside the managed parent — loose in
// %TEMP%, which is the shape of #605 itself. Neither the reporter, which reads
// the run root's children, nor the sweep, which reads run roots, would ever see
// it. They fall back like every other prefix that cannot be a name.
//
// The Rust twin has no such hole: it appends `-{sequence}-{nonce}` to the name
// before joining, so `..` becomes the ordinary filename `..-0-<nonce>`.
// `a_dot_name_stays_inside_the_run_root` holds that.
function safePrefix(prefix: string): string {
  const safe = prefix.replace(/[^A-Za-z0-9._-]/gu, "-");
  const isDirection = safe === "." || safe === "..";
  return safe.length > 0 && !isDirection ? safe : "scratch-";
}

async function ensureScratchRun(): Promise<void> {
  startup ??= (async () => {
    await sweepOldTestScratch();
    await mkdir(testScratchRunRoot(), { recursive: true });
  })();
  await startup;
}

// Only the run root, never a sweep. `testSetup.ts` awaits `sweepOldTestScratch`
// at module scope, and vitest evaluates a setup file before the test module
// that needs this — so by the time any synchronous creator runs, the sweep has
// already happened. Playwright never reaches here: its helpers are async.
function ensureScratchRunSync(): void {
  mkdirSync(testScratchRunRoot(), { recursive: true });
}

async function cleanupRegistered(paths: Set<string>): Promise<void> {
  const pending = [...paths];
  paths.clear();
  await Promise.all(pending.map((path) => removeTestScratch(path)));
}

async function removeTreeWithRetry(path: string): Promise<Error | undefined> {
  try {
    await rm(path, {
      recursive: true,
      force: true,
      maxRetries: cleanupAttempts() - 1,
      retryDelay: WINDOWS_CLEANUP_DELAY_MS,
    });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return undefined;
}

async function removeEmptyRunRoot(): Promise<void> {
  // A handed-down root belongs to whoever handed it down. The Rust gate writes
  // a sentinel into it and reclaims it once every test binary has exited, and
  // the Rust helper never removes a run root either. One suite removing a root
  // its sibling workers still allocate under would ENOENT their next mkdtemp.
  if (process.env.DOHC_TEST_SCRATCH_ROOT) return;
  try {
    await rmdir(testScratchRunRoot());
  } catch (error) {
    if (!new Set(["ENOENT", "ENOTEMPTY", "EEXIST"]).has(errorCode(error))) {
      console.error(
        `scratch run cleanup failed for ${testScratchRunRoot()}: ${errorMessage(error)}`,
      );
    }
  }
}

function cleanupAttempts(): number {
  return process.platform === "win32" ? WINDOWS_CLEANUP_ATTEMPTS : 1;
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code ?? "")
    : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

