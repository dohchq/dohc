import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  rmdir,
  stat,
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

const testScratch = new Set<string>();
const suiteScratch = new Set<string>();
// Paths whose removal lost to an open handle. They stay here so the final
// drain retries them and, failing that, fails the suite. Dropping them and
// logging instead would leave the tree behind under a green run, and the only
// run-level scratch reporter in this repo runs from the Rust gate — it never
// sees a JS run at all.
const unresolvedScratch = new Set<string>();
let startup: Promise<void> | undefined;
let syncStartupDone = false;
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
    if (path === currentRun) continue;
    let metadata;
    try {
      metadata = await stat(path);
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
    return configured;
  }
  processRunId ??= `process-${process.pid}-${randomBytes(8).toString("hex")}`;
  return processRunId;
}

/// Whether nothing anywhere under `path` has been touched inside the max age.
///
/// A directory's mtime moves when its own entries change, not when a file
/// deeper inside is written. A soak that spends a day writing into a workspace
/// it created in its first minute leaves the root looking untouched, so reading
/// only the root would delete live work. Stop at the first recent thing found.
export async function isIdleSince(path: string, nowMs: number): Promise<boolean> {
  let metadata;
  try {
    metadata = await stat(path);
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

function isIdleSinceSync(path: string, nowMs: number): boolean {
  let metadata;
  try {
    metadata = statSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    return false;
  }
  if (nowMs - metadata.mtimeMs <= MAX_RUN_AGE_MS) return false;
  if (!metadata.isDirectory()) return true;
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return false;
  }
  return names.every((name) => isIdleSinceSync(join(path, name), nowMs));
}

function safePrefix(prefix: string): string {
  const safe = prefix.replace(/[^A-Za-z0-9._-]/gu, "-");
  return safe.length > 0 ? safe : "scratch-";
}

async function ensureScratchRun(): Promise<void> {
  startup ??= (async () => {
    await sweepOldTestScratch();
    await mkdir(testScratchRunRoot(), { recursive: true });
  })();
  await startup;
}

function ensureScratchRunSync(): void {
  if (syncStartupDone) return;
  sweepOldTestScratchSync();
  mkdirSync(testScratchRunRoot(), { recursive: true });
  syncStartupDone = true;
}

function sweepOldTestScratchSync(): void {
  const parent = join(nativeTmpdir(), SCRATCH_PARENT);
  const currentRun = testScratchRunRoot();
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const nowMs = Date.now();
  for (const name of names) {
    const path = join(parent, name);
    if (path === currentRun) continue;
    let metadata;
    try {
      metadata = statSync(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isDirectory() || !isIdleSinceSync(path, nowMs)) {
      continue;
    }
    try {
      rmSync(path, {
        recursive: true,
        force: true,
        maxRetries: process.platform === "win32" ? WINDOWS_CLEANUP_ATTEMPTS - 1 : 0,
        retryDelay: WINDOWS_CLEANUP_DELAY_MS,
      });
    } catch (error) {
      console.error(
        `scratch sweep could not remove aged run ${path} after ${cleanupAttempts()} attempts: ${errorMessage(error)}`,
      );
    }
  }
}

async function cleanupRegistered(paths: Set<string>): Promise<void> {
  const pending = [...paths];
  paths.clear();
  await Promise.all(pending.map((path) => removeTestScratch(path)));
}

async function removeTreeWithRetry(path: string): Promise<Error | undefined> {
  const attempts = cleanupAttempts();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return undefined;
    } catch (error) {
      if (attempt === attempts) return toError(error);
      await new Promise((resolve) =>
        setTimeout(resolve, WINDOWS_CLEANUP_DELAY_MS * attempt),
      );
    }
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
