import { readFileSync, renameSync, writeFileSync } from "node:fs";

// Declined DM requests are account-wide because received relay grants are
// account-wide. The file lives in stateDir, not in a workspace registry.
// Accepted DMs need no account file: their JoinedSharedChannel registry row
// records the workspace that owns them.

type ReadResult = { ok: true; declined: Set<string> } | { ok: false };

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function readSet(file: string): ReadResult {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { ok: true, declined: new Set() };
    }
    return { ok: false };
  }
  try {
    const parsed = JSON.parse(raw) as { declined?: unknown };
    if (!Array.isArray(parsed.declined)) return { ok: false };
    const declined = new Set<string>();
    for (const shareId of parsed.declined) {
      if (typeof shareId === "string" && shareId) declined.add(shareId);
    }
    return { ok: true, declined };
  } catch {
    return { ok: false };
  }
}

function writeSet(file: string, declined: ReadonlySet<string>): boolean {
  try {
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ declined: [...declined].sort() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function readDeclinedDms(file: string): ReadonlySet<string> | null {
  const result = readSet(file);
  return result.ok ? result.declined : null;
}

export function declineDm(file: string, shareId: string): boolean {
  const result = readSet(file);
  if (!result.ok) return false;
  if (result.declined.has(shareId)) return true;
  result.declined.add(shareId);
  return writeSet(file, result.declined);
}

export function clearDeclinedDm(file: string, shareId: string): boolean {
  const result = readSet(file);
  if (!result.ok) return false;
  if (!result.declined.has(shareId)) return true;
  result.declined.delete(shareId);
  return writeSet(file, result.declined);
}
