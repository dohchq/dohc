import { createHash } from "node:crypto";

/** The lowercase hex SHA-256 digest of `bytes`; strings hash as UTF-8. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
