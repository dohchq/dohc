export const MAX_PAYLOAD_JSON_BYTES = 256 * 1024;
export const MAX_SHARE_ID_CHARS = 128;
export const MAX_DISCUSSION_ACTIVITY_HOLD_MS = 30_000;
export const MAX_LOG_PAGE_SIZE = 500;

// Transport cap. The relay never parses content, so it cannot tell a captured
// file from a document body from a Y.Doc payload; it carries the widest engine
// ceiling and lets the Rust sync-apply path enforce the real one by referenced
// kind on hydrate. A blob a peer smuggles under this cap but over its kind's
// ceiling is rejected client-side as a protocol violation.
//
// The widest is now the Y.Doc payload bound, not the 10 MiB document body:
// #549 measured a rich document at MAX_TEXT_BYTES encoding to 14.06 MiB of
// Y.Doc full state, so MAX_YDOC_UPDATE_BYTES is 20 MiB. Under that number a
// document the engine accepts would be refused 413 here, and the base it needs
// could never reach a peer. Keep this at or above the engine's
// MAX_INGEST_BLOB_BYTES (crates/dohc-engine-sync/src/hydration.rs); no test
// compares the two, so check both when widening either.
export const MAX_BLOB_BYTES = 20 * 1024 * 1024;
