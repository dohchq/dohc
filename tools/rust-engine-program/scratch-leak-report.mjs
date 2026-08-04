import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

// What a healthy `cargo test --workspace` leaves in its run root on Windows.
//
// A test binary removes each scratch tree in a `Drop` guard, but the guard can
// lose a race it cannot win from inside: SQLite releases engine.db, its -wal
// and its -shm a moment after the store drops, and Windows refuses to unlink a
// file whose handle is still open. The guard retries for 2.8s and then gives
// up, and the handle is released when that test binary exits — after the guard
// is gone.
//
// Measured on this machine, per full run: 0 entries from every package run on
// its own (`-p dohc-engine-domain`, `-p dohc-workspace-engine --lib`, and
// `-p dohc-engine-runtime -p dohc-engine-testkit -p dohc-engine-sync
// -p dohc-engine-sync-http` — thousands of scratch directories between them),
// and 4, then 3 entries from `--workspace`, where ~30 test binaries run at
// once. Stragglers appear only at full parallelism, and single digits are the
// healthy range.
//
// The limit sits an order of magnitude beyond that range, because the
// regression this row exists to catch is not a straggler. It is a harness that
// stops cleaning up at all, which showed up as 191,851 directories in #605.
// Failing a healthy run over 3 stragglers would only teach the next reader to
// ignore the row.
const LEAK_ENTRY_LIMIT = 32;

export async function inspectScratchRun(runRoot) {
  let names;
  try {
    names = await readdir(runRoot);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { status: "PASS", reason: "0 entries, 0 bytes", entryCount: 0, bytes: 0, leaked: [] };
    }
    throw error;
  }

  let bytes = 0;
  for (const name of names) {
    bytes += await treeBytes(join(runRoot, name));
  }
  const entryCount = names.length;
  const leaked = names.slice(0, 5);

  // Reclaim the run root either way. Every test binary has exited by now, so
  // the handles that beat the in-process guards are gone and this succeeds —
  // which is what keeps "a completed gate run leaves nothing" true.
  let cleanupFailure;
  try {
    await rm(runRoot, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 7 : 0,
      retryDelay: 100,
    });
  } catch (error) {
    cleanupFailure = error instanceof Error ? error.message : String(error);
  }

  // A tree the gate itself cannot reclaim is a real leak whatever its size:
  // something still holds it after the run.
  if (cleanupFailure) {
    return {
      status: "FAIL",
      reason: `run root could not be reclaimed after the run: ${cleanupFailure}; observed ${entryCount} entries and ${bytes} bytes; leaked directories: ${leaked.join(", ")}`,
      entryCount,
      bytes,
      leaked,
    };
  }

  if (entryCount > LEAK_ENTRY_LIMIT) {
    return {
      status: "FAIL",
      reason: `scratch entry limit ${LEAK_ENTRY_LIMIT} entries; observed ${entryCount} entries and ${bytes} bytes; leaked directories: ${leaked.join(", ")}; run root reclaimed after measurement`,
      entryCount,
      bytes,
      leaked,
    };
  }

  return {
    status: "PASS",
    reason:
      entryCount === 0
        ? "0 entries, 0 bytes"
        : `${entryCount} entries and ${bytes} bytes left by shutdown races, within the ${LEAK_ENTRY_LIMIT}-entry limit; run root reclaimed`,
    entryCount,
    bytes,
    leaked,
  };
}

async function treeBytes(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return metadata.size;
  const names = await readdir(path);
  let bytes = 0;
  for (const name of names) bytes += await treeBytes(join(path, name));
  return bytes;
}

function errorCode(error) {
  return error instanceof Error && "code" in error ? String(error.code ?? "") : "";
}
