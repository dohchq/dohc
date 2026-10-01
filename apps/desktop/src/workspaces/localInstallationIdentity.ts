import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const errorCode = (error: unknown) => (error instanceof Error && "code" in error ? error.code : undefined);

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);

/**
 * This installation's signed-out subject: a stable opaque id, never the
 * email, so History and reactions name the same person across restarts.
 * Never throws, because unrelated callers read it. A file dohc cannot use is
 * kept beside it under a `.corrupt-` name and a fresh id is saved. When the
 * id cannot be read or saved, the caller keeps the returned id for its
 * process; `onError` says why.
 */
export function readOrCreateLocalInstallationId(file: string, onError: (message: string, error: unknown) => void): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return saveNewId(file, onError);
    onError("dohc could not read this installation's id. It uses an unsaved one until it restarts.", error);
    return `local:${randomUUID()}`;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "id" in parsed && validId(parsed.id)) return parsed.id;
  } catch {
    // Truncated or not JSON. Kept below, like an invalid id.
  }
  try {
    renameSync(file, `${file}.corrupt-${Date.now()}-${randomUUID()}`);
  } catch (error) {
    onError("dohc could not set aside this installation's unreadable id file. It uses an unsaved id until it restarts.", error);
    return `local:${randomUUID()}`;
  }
  return saveNewId(file, onError);
}

// Written whole to a private temporary file, flushed, then renamed over the
// target, so a crash leaves the old file or the complete new one.
function saveNewId(file: string, onError: (message: string, error: unknown) => void): string {
  const id = `local:${randomUUID()}`;
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify({ id }, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, file);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Never created, or already renamed. */ }
    onError("dohc could not save this installation's id. It uses an unsaved one until it restarts.", error);
  }
  return id;
}
