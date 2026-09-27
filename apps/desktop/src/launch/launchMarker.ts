import { readFileSync, rmSync, writeFileSync } from "node:fs";

// The launch marker counts launches of one build in a row that never finished
// starting. The entry module raises the count before main loads. Main
// removes the marker once the app has run 30 s after its first window
// loaded, or at a clean quit if that comes first. So a count that survives
// means the launch before it crashed, hung, or exited within 30 s. Another
// version starts from zero: an update is a new build.
//
// Only the process that holds the single-instance lock opens the marker; a
// second launch hands off before it reads or writes anything.
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

interface MarkerState {
  unfinished: number;
  // A single-use pass for the relaunch after a check that found nothing.
  checked?: string;
}

export interface LaunchRecord {
  // Unfinished launches of this version before this one.
  readonly unfinished: number;
  // This launch is the relaunch its checking process allowed.
  readonly checked: boolean;
  finish(): void;
  // Allows one relaunch to skip the check. Returns the pass it must carry.
  grantCheckedRelaunch(): string;
}

const nodeFileSystem: MarkerFileSystem = { readFileSync, writeFileSync, rmSync };

function read(fs: MarkerFileSystem, path: string, version: string): MarkerState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return { unfinished: 0 };
    if (!("version" in parsed) || parsed.version !== version || !("unfinished" in parsed)) return { unfinished: 0 };
    const count = parsed.unfinished;
    const unfinished = typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : 0;
    const checked = "checked" in parsed && typeof parsed.checked === "string" ? parsed.checked : undefined;
    return checked ? { unfinished, checked } : { unfinished };
  } catch {
    return { unfinished: 0 };
  }
}

function write(fs: MarkerFileSystem, path: string, version: string, state: MarkerState): void {
  try {
    if (state.unfinished > 0 || state.checked) fs.writeFileSync(path, JSON.stringify({ version, ...state }));
    else fs.rmSync(path, { force: true });
  } catch (error) {
    console.error("[desktop] launch marker:", error);
  }
}

/**
 * Counts this launch as unfinished. A pass from the marker matching
 * `checkedPass` marks this launch as the allowed relaunch and is used up.
 */
export function openLaunchMarker(
  path: string,
  version: string,
  checkedPass: string | null,
  fs: MarkerFileSystem = nodeFileSystem,
): LaunchRecord {
  const before = read(fs, path, version);
  const checked = checkedPass !== null && before.checked === checkedPass;
  write(fs, path, version, { unfinished: before.unfinished + 1 });
  let open = true;
  return {
    unfinished: before.unfinished,
    checked,
    finish() {
      if (!open) return;
      open = false;
      write(fs, path, version, { unfinished: 0 });
    },
    // The checking process never loaded main, so it does not count.
    grantCheckedRelaunch() {
      open = false;
      const pass = globalThis.crypto.randomUUID();
      write(fs, path, version, { unfinished: before.unfinished, checked: pass });
      return pass;
    },
  };
}

// The launch this process began, if any. The entry module and main share
// this module instance.
let current: LaunchRecord | null = null;

export function beginLaunch(
  path: string,
  version: string,
  checkedPass: string | null,
  fs: MarkerFileSystem = nodeFileSystem,
): LaunchRecord {
  current = openLaunchMarker(path, version, checkedPass, fs);
  return current;
}

/** This launch finished starting: the next one starts from zero. */
export function finishLaunch(): void {
  current?.finish();
  current = null;
}

/** Allows one relaunch of this launch to skip the check; null without a launch. */
export function grantCheckedRelaunch(): string | null {
  const pass = current?.grantCheckedRelaunch() ?? null;
  current = null;
  return pass;
}
