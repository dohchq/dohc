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
import { join } from "node:path";

const SCRATCH_PARENT = "dohc-test-scratch";
const MAX_RUN_AGE_MS = 6 * 60 * 60 * 1_000;
const WINDOWS_CLEANUP_ATTEMPTS = 8;
const WINDOWS_CLEANUP_DELAY_MS = 50;

const testScratch = new Set<string>();
const suiteScratch = new Set<string>();
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
  await removeEmptyRunRoot();
}

export async function removeTestScratch(path: string): Promise<void> {
  testScratch.delete(path);
  suiteScratch.delete(path);
  const error = await removeTreeWithRetry(path);
  if (error) {
    console.error(
      `scratch cleanup failed after ${cleanupAttempts()} attempts for ${path}: ${error.message}; the run-level scratch leak check will report this directory`,
    );
  }
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
    if (!metadata.isDirectory() || nowMs - metadata.mtimeMs <= MAX_RUN_AGE_MS) {
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
    if (!metadata.isDirectory() || nowMs - metadata.mtimeMs <= MAX_RUN_AGE_MS) {
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
