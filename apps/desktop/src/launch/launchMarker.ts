import { readFileSync, rmSync, writeFileSync } from "node:fs";

// The launch marker counts launches of one build in a row that never finished
// starting. The entry module raises the count before main loads. Main
// removes the marker once the app has run 30 s after its first window
// loaded, or at a clean quit if that comes first. So a count that survives
// means the launch before it crashed, hung, or exited within 30 s. Another
// version starts from zero: an update is a new build.
//
// The marker is best effort: a read or write that fails never stops a
// launch. It is written without fsync, so a power cut can leave a stale
// count, which costs at most one extra update check.

export const LAUNCH_MARKER_FILE = "dohc-launch.json";

// Checking before main loads delays that launch, so one unfinished launch,
// such as a killed process or a power cut, does not trigger it. Two in a row
// do.
export const UNFINISHED_LAUNCHES_BEFORE_CHECK = 2;

export interface MarkerFileSystem {
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string): void;
  rmSync(path: string, options: { force: true }): void;
}

const nodeFileSystem: MarkerFileSystem = { readFileSync, writeFileSync, rmSync };

// The launch this process began, if any. Main reads it through the functions
// below; the entry module and main share this module instance.
let current: { path: string; version: string; previous: number; fs: MarkerFileSystem } | null = null;

function readUnfinished(fs: MarkerFileSystem, path: string, version: string): number {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return 0;
    if (!("version" in parsed) || parsed.version !== version || !("unfinished" in parsed)) return 0;
    const count = parsed.unfinished;
    return typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

function write(fs: MarkerFileSystem, path: string, version: string, unfinished: number): void {
  try {
    if (unfinished > 0) fs.writeFileSync(path, JSON.stringify({ version, unfinished }));
    else fs.rmSync(path, { force: true });
  } catch (error) {
    console.error("[desktop] launch marker:", error);
  }
}

/** Counts this launch as unfinished and returns the count before it. */
export function beginLaunch(path: string, version: string, fs: MarkerFileSystem = nodeFileSystem): number {
  const previous = readUnfinished(fs, path, version);
  write(fs, path, version, previous + 1);
  current = { path, version, previous, fs };
  return previous;
}

/** This launch finished starting: the next one starts from zero. */
export function finishLaunch(): void {
  if (!current) return;
  write(current.fs, current.path, current.version, 0);
  current = null;
}

/**
 * This process handed its launch to the running instance, so it never
 * counted as a launch of its own. The count goes back to what it was.
 */
export function abandonLaunch(): void {
  if (!current) return;
  write(current.fs, current.path, current.version, current.previous);
  current = null;
}
