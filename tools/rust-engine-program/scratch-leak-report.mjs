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

// #605 was 196 GB, not 191,851 directories — the directories were the symptom
// and the bytes were the outage. A row that bounds only the count would pass
// one workspace whose engine.db grew without limit, which is the same failure
// wearing a different shape. Measured healthy: a full `--workspace` run left
// 7,612,907 bytes, then 4,201,818, and every single-package run left 0. The
// ceiling is 256 MiB — about 35x the largest healthy run seen here, and still
// three orders of magnitude below the incident.
const LEAK_BYTE_LIMIT = 256 * 1024 * 1024;

// Written into the run root before the tests start and required after they
// finish. Its absence means this module never reached the tree the tests used.
export const SCRATCH_SENTINEL = ".dohc-gate-sentinel";

export async function inspectScratchRun(runRoot) {
  let names;
  try {
    names = await readdir(runRoot);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return {
        status: "FAIL",
        reason: `scratch run root ${runRoot} does not exist, so nothing was inspected; the tests wrote somewhere else and this row would otherwise report a clean run it never looked at`,
        entryCount: 0,
        bytes: 0,
        leaked: [],
      };
    }
    throw error;
  }

  if (!names.includes(SCRATCH_SENTINEL)) {
    return {
      status: "FAIL",
      reason: `scratch run root ${runRoot} has no ${SCRATCH_SENTINEL}, so this is not the tree the run used; "0 entries" here would mean nothing was looked at, not that nothing leaked`,
      entryCount: 0,
      bytes: 0,
      leaked: names.slice(0, 5),
    };
  }

  names = names.filter((name) => name !== SCRATCH_SENTINEL);
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

  // Two independent bounds on two independent failure modes: many directories
  // means a harness stopped cleaning up, many bytes means one workspace grew
  // without limit. Either alone fills a disk.
  if (entryCount > LEAK_ENTRY_LIMIT || bytes > LEAK_BYTE_LIMIT) {
    const breached =
      entryCount > LEAK_ENTRY_LIMIT
        ? `entry limit ${LEAK_ENTRY_LIMIT} entries`
        : `byte limit ${LEAK_BYTE_LIMIT} bytes`;
    return {
      status: "FAIL",
      reason: `scratch ${breached}; observed ${entryCount} entries and ${bytes} bytes; leaked directories: ${leaked.join(", ")}; run root reclaimed after measurement`,
      entryCount,
      bytes,
      leaked,
    };
  }

  return {
    status: "PASS",
    reason:
      entryCount === 0
        ? `0 entries, 0 bytes (${SCRATCH_SENTINEL} confirmed the tree was walked)`
        : `${entryCount} entries and ${bytes} bytes left by shutdown races, within the ${LEAK_ENTRY_LIMIT}-entry and ${LEAK_BYTE_LIMIT}-byte limits; run root reclaimed`,
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
