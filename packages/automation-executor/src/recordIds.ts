import { createHash } from "node:crypto";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

// The engine's record id shape (mint_record_id in dohc-engine-domain): "rec_"
// plus 16 bytes in unpadded lowercase base32, most significant bit first.
export function recordIdFromBytes(bytes: Uint8Array): string {
  let id = "rec_";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      id += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) id += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return id;
}

/**
 * A record id derived from `seed`, in the engine's record id shape: "rec_"
 * plus the first 16 bytes of the seed's SHA-256 in unpadded lowercase
 * base32. The same seed always names the same record, so an automation step
 * that seeds it with its claim id and step position finds the record an
 * earlier attempt created.
 */
export function derivedRecordId(seed: string): string {
  return recordIdFromBytes(
    createHash("sha256").update(seed).digest().subarray(0, 16),
  );
}
