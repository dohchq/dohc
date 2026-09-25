import { readBoundedJson } from "@dohc/service-http";

// share-web is itself a relay client. When the relay refuses share-web's
// relay API version, the browser page and an agent get this answer instead of
// "not found", so the person can tell a mismatched server from a missing share.
// Both sides belong to the server, so the next step is always its operator.
const MESSAGES = {
  api_version_too_old:
    "This server's share page needs an update to match its sync service. Ask the person who runs the server to update it.",
  api_version_too_new:
    "This server's sync service needs an update to match its share page. Ask the person who runs the server to update it.",
} as const;

export const RELAY_VERSION_REFUSAL_STATUS = 409;

export interface RelayVersionRefusal {
  ok: false;
  code: keyof typeof MESSAGES;
  error: string;
}

export function relayVersionRefusal(body: unknown): RelayVersionRefusal | null {
  const code = typeof body === "object" && body !== null && "code" in body ? body.code : undefined;
  return code === "api_version_too_old" || code === "api_version_too_new"
    ? { ok: false, code, error: MESSAGES[code] }
    : null;
}

// Reads a relay 400 without consuming it, so other refusal handling still can.
export async function readRelayVersionRefusal(
  relayResponse: Response,
  signal: AbortSignal,
): Promise<RelayVersionRefusal | null> {
  if (relayResponse.status !== 400 || !relayResponse.body) return null;
  return relayVersionRefusal(
    await readBoundedJson(relayResponse.clone(), 4096, signal).catch(() => null),
  );
}

// Thrown by the MCP bridge when share-web answered its own request with a
// version refusal, so the /mcp route can pass it on.
export class RelayVersionRefusalError extends Error {
  constructor(readonly refusal: RelayVersionRefusal) {
    super(refusal.error);
    this.name = "RelayVersionRefusalError";
  }
}
