import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

// The opaque per-install reactor id used when signed out (no cloud user id): a
// stable uuid persisted to `file` — NEVER the email — so a signed-out reaction
// cell is stable across restarts without leaking PII into the CRDT.
//
// Reads the existing id, or mints and persists a new one. The write is ATOMIC
// (write a temp file, then rename over the target), matching
// cloudCredentialStore's save(): a crash between the two steps can never leave a
// half-written id file — a reader sees either the old file or the complete new
// one. Kept sync so callers stay simple; the fs touch happens at most once.
export function readOrCreateLocalReactorId(file: string): string {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { id?: unknown };
    if (typeof parsed.id === "string" && parsed.id) return parsed.id;
  } catch {
    // Not created yet (or unreadable) — mint and persist one below.
  }
  const id = `local:${randomUUID()}`;
  try {
    // mode 0o600 on the temp file is preserved by the rename.
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ id }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // Best-effort persistence; the id is still stable for this process run.
  }
  return id;
}
