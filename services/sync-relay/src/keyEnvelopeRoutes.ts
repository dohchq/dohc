import { jsonResponse } from "@dohc/service-http";
import { SHA256_HEX_PATTERN } from "@dohc/security-contract/wire-patterns";
import { badRequest, relayError } from "./errors";
import { readBytes } from "./relayBytes";
import type { SyncRelayStorage } from "./storage";

export const MAX_KEY_ENVELOPE_BYTES = 16 * 1024;

export function createKeyEnvelopeRoutes(
  storage: Pick<SyncRelayStorage, "putKeyEnvelope" | "getKeyEnvelope">,
  nowMs: () => number,
) {
  async function respondToKeyEnvelopes(
    request: Request,
    workspaceId: string,
  ): Promise<Response> {
    if (request.method === "PUT") {
      const bytes = await readBytes(request, MAX_KEY_ENVELOPE_BYTES);
      const envelopeJson = Buffer.from(bytes).toString("utf8");
      try {
        const parsed = JSON.parse(envelopeJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not object");
        }
      } catch {
        throw badRequest("key envelope must be a JSON object");
      }
      // Create-only on first write; CAS via If-Match (sha256 of the envelope
      // being replaced) thereafter. A stale or absent precondition is a 409,
      // never a silent overwrite — the envelope is the only recovery path
      // for the wrapped workspace key. Replaced envelopes are retained in
      // the history table by storage.putKeyEnvelope.
      const result = storage.putKeyEnvelope({
        workspaceId,
        envelopeJson,
        updatedAtMs: nowMs(),
        expectedSha256: parseIfMatchSha256(request.headers.get("if-match")),
      });
      return jsonResponse(
        { ok: true, workspaceId, sha256: result.sha256 },
        200,
        { etag: `"${result.sha256}"` },
      );
    }

    if (request.method === "GET") {
      const envelope = storage.getKeyEnvelope(workspaceId);
      if (!envelope) throw relayError("key_envelope_not_found");
      return new Response(envelope.envelopeJson, {
        status: 200,
        headers: {
          "content-type": "application/json",
          // Current fingerprint + write time so clients can detect that the
          // envelope they enrolled with has been replaced.
          etag: `"${envelope.sha256}"`,
          "x-key-envelope-updated-at-ms": String(envelope.updatedAtMs),
        },
      });
    }

    throw relayError("method_not_allowed");
  }

  return respondToKeyEnvelopes;
}

// If-Match for PUT /keys: absent means create-only; otherwise a (optionally
// quoted) sha256 of the envelope the caller intends to replace. Wildcard and
// weak validators are refused — an unconditional overwrite is exactly the
// write this endpoint exists to prevent.
function parseIfMatchSha256(header: string | null): string | null {
  if (header === null) return null;
  const value = header.trim().replace(/^"(.*)"$/u, "$1");
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw badRequest("if-match must be the sha256 of the current key envelope");
  }
  return value;
}
