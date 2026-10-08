import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";

export function observationKey(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function readObservationFile(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** A failed write leaves the previous observation intact. */
export function writeObservationFile(file: string, value: unknown): void {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    let failed = false;
    try {
      writeFileSync(fd, `${JSON.stringify(value)}\n`);
      fsyncSync(fd);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try { closeSync(fd); } catch (error) { if (!failed) throw error; }
    }
    renameSync(temporary, file);
    if (process.platform !== "win32") {
      const directoryFd = openSync(directory, "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    }
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve the persistence error. */ }
    throw error;
  }
}

export function removeObservationFile(file: string): void {
  try { unlinkSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
