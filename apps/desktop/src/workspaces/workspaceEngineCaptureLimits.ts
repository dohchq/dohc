import { MAX_VERSIONED_BINARY_FILE_BYTES } from "@dohc/workspace-contracts/engine";

export const MAX_ENGINE_CAPTURE_TEXT_BYTES = 10 * 1024 * 1024;
export const MAX_ENGINE_CAPTURE_BINARY_BYTES = MAX_VERSIONED_BINARY_FILE_BYTES;

const BYTES_PER_KB = 1_024;
const BYTES_PER_MB = 1_048_576;

/** A limit in the unit that states it truly: 40 bytes reads as "40 bytes",
 * never as a rounded-up "0.1 MB" the user cannot check. */
export function formatSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < BYTES_PER_MB) return `${Math.floor(bytes / BYTES_PER_KB)} KB`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}
