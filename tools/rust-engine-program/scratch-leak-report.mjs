import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";

const LEAK_ENTRY_LIMIT = 0;

export async function inspectScratchRun(runRoot) {
  let names;
  try {
    names = await readdir(runRoot);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return passResult();
    throw error;
  }

  let bytes = 0;
  for (const name of names) {
    bytes += await treeBytes(join(runRoot, name));
  }
  const entryCount = names.length;
  if (entryCount === LEAK_ENTRY_LIMIT) {
    try {
      await rmdir(runRoot);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return passResult();
  }
  const leaked = names.slice(0, 5).join(", ");
  let cleanupFailure;
  try {
    await rm(runRoot, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 7 : 0,
      retryDelay: 50,
    });
  } catch (error) {
    cleanupFailure = error instanceof Error ? error.message : String(error);
  }
  return {
    status: "FAIL",
    reason: `scratch entry limit ${LEAK_ENTRY_LIMIT} entries; observed ${entryCount} entries and ${bytes} bytes; leaked directories: ${leaked}${cleanupFailure ? `; cleanup failed: ${cleanupFailure}` : "; leaked run removed after measurement"}`,
    entryCount,
    bytes,
    leaked: names.slice(0, 5),
  };
}

function passResult() {
  return {
    status: "PASS",
    reason: "0 entries, 0 bytes",
    entryCount: 0,
    bytes: 0,
    leaked: [],
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
