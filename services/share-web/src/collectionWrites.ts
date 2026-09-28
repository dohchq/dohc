// A Collection's own files, written through an Edit share link (ADR 0013).
// The viewer and the remote MCP both send this request to share-web, which
// adds only the link's server-held capability and profile secret and forwards
// it to the relay. Both read the answer with `readCollectionWriteOutcome`.

export const COLLECTION_WRITES_PATH = "/api/view/collection-writes";
/** The relay's link envelope: 4 MiB of content as base64, plus the changes' metadata. */
export const MAX_COLLECTION_WRITE_ENVELOPE_BYTES = 7 * 1024 * 1024;
/** The content one write may carry, summed over its files. */
export const MAX_COLLECTION_WRITE_CONTENT_BYTES = 4 * 1024 * 1024;
/** A schema, an automations file, and 500 records. */
export const MAX_COLLECTION_WRITE_FILES = 502;
export const MAX_SUBMIT_ID_CHARS = 128;

/**
 * One file as its writer names it: its path, the content it replaces (null
 * to create it), and its new UTF-8 content as text or as base64.
 */
export type CollectionFileWrite = { path: string; basedOnBlobSha256: string | null } & ({ text: string } | { base64: string });

/**
 * What became of a write. `accepted` means the relay recorded it in the
 * owner's workspace history; the owner's computer applies it when it next
 * syncs. `unknown` means the answer was lost: send the same submit id again.
 */
export type CollectionWriteOutcome =
  | { ok: true; outcome: "accepted"; submitId: string }
  | { ok: false; outcome: "stale"; path: string; currentBlobSha256: string | null }
  | { ok: false; outcome: "refused"; reason: string }
  | { ok: false; outcome: "unavailable" }
  | { ok: false; outcome: "rate-limited" }
  | { ok: false; outcome: "unknown" };

/** The bytes of each file's content, which the write limits count. */
export function collectionWriteContentBytes(files: readonly CollectionFileWrite[]): number {
  const encoder = new TextEncoder();
  return files.reduce((total, file) => total + ("text" in file
    ? encoder.encode(file.text).byteLength
    : file.base64.length / 4 * 3 - (file.base64.endsWith("==") ? 2 : file.base64.endsWith("=") ? 1 : 0)), 0);
}

/** The request body: the relay's link envelope, with each file's text as base64. */
export function collectionWriteBody(submitId: string, files: readonly CollectionFileWrite[], recordedAtMs: number): string {
  const encoder = new TextEncoder();
  return JSON.stringify({
    submitId,
    changes: files.map((file) => ({
      basedOnPath: file.basedOnBlobSha256 === null ? null : file.path,
      basedOnBlobSha256: file.basedOnBlobSha256,
      operation: "write",
      afterPath: file.path,
      afterContentKind: "text",
      afterContentBase64: "text" in file ? base64(encoder.encode(file.text)) : file.base64,
      recordedAtMs,
    })),
  });
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

const SHA256 = /^[0-9a-f]{64}$/u;

function exactKeys(value: Record<string, unknown>, keys: string): boolean {
  return Object.keys(value).sort().join() === keys;
}

/** The outcome share-web answered, or `unknown` for anything it did not. */
export function parseCollectionWriteOutcome(status: number, value: unknown): CollectionWriteOutcome {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (status === 200 && body && exactKeys(body, "ok,outcome,submitId") && body.ok === true &&
      body.outcome === "accepted" && typeof body.submitId === "string") {
    return { ok: true, outcome: "accepted", submitId: body.submitId };
  }
  if (status === 409 && body && exactKeys(body, "currentBlobSha256,ok,outcome,path") && body.outcome === "stale" &&
      typeof body.path === "string" && (body.currentBlobSha256 === null ||
        (typeof body.currentBlobSha256 === "string" && SHA256.test(body.currentBlobSha256)))) {
    return { ok: false, outcome: "stale", path: body.path, currentBlobSha256: body.currentBlobSha256 };
  }
  if (status === 403 && body && exactKeys(body, "ok,outcome,reason") && body.outcome === "refused" && typeof body.reason === "string") {
    return { ok: false, outcome: "refused", reason: body.reason };
  }
  if (status === 404) return { ok: false, outcome: "unavailable" };
  if (status === 429) return { ok: false, outcome: "rate-limited" };
  return { ok: false, outcome: "unknown" };
}
