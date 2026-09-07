import { createHmac, randomBytes, type BinaryLike } from "node:crypto";
import {
  LIVE_TICKET_ENTROPY_BYTES,
  parseLiveTicketToken,
} from "@dohc/live-session-contract/live-ticket";

export function mintLiveTicketToken(
  entropy: (byteLength: number) => Uint8Array = randomBytes,
): string {
  const bytes = entropy(LIVE_TICKET_ENTROPY_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== LIVE_TICKET_ENTROPY_BYTES) {
    throw new TypeError("Live-ticket entropy must contain exactly 32 bytes.");
  }
  return Buffer.from(bytes).toString("hex");
}

export function hashLiveTicketToken(token: string, key: BinaryLike): string {
  return createHmac("sha256", key)
    .update("live-ticket\n")
    .update(parseLiveTicketToken(token))
    .digest("base64url");
}
