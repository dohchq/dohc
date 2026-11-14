//! Collab-layer bounds. Everything the durable Y.Doc layer accepts or grows is
//! bounded. Violations are typed
//! errors, never silent truncation, and the update log growth is bounded by
//! compaction/retention rather than allowed to grow without limit.

/// Maximum size of one Y.Doc payload, a delta or a full-state base, accepted
/// by the durable append, the base claim, and the replication apply, in bytes.
/// Reject over-cap bytes locally before the blob put and the journal, so
/// nothing that can only fail on a peer is ever recorded.
///
/// The bound is twice `MAX_TEXT_BYTES` (10 MiB), the largest document body the
/// store accepts. `ydoc_full_state_size.rs` measures the full state of
/// representative documents at that size. The worst, a rich document of 120 B
/// paragraphs, encodes to 1.406 times its content. Revision churn adds about
/// 60 bytes of state per interior edit, so the bound leaves room for roughly
/// 100,000 revisions above the worst document. Enough churn still exceeds it,
/// and that refusal names this constraint, its limit, and the observed size.
///
/// Widening this moves the whole path: `blob_ceiling(BlobKind::Ydoc)` reads it,
/// `MAX_INGEST_BLOB_BYTES` derives from that, and the relay's own
/// `MAX_BLOB_BYTES` (`services/sync-relay/src/server.ts`) must stay at or above
/// the result. The two are written by hand in different languages and no test
/// compares them; check both when widening either.
///
/// One number covers deltas and bases on purpose. Nothing measures how big a
/// single edit may be; a delta never exceeds the full state it is a slice of;
/// and the paths that walk a lineage piece by piece meet snapshots and deltas
/// mixed together.
pub const MAX_YDOC_UPDATE_BYTES: usize = 20 * 1024 * 1024;

/// Existing public Markdown output bound, shared with live-session-contract.
/// packages/live-session-contract/src/limits.test.ts checks they agree.
pub const MAX_PUBLIC_MARKDOWN_BYTES: usize = 2 * 1024 * 1024;

/// Fold the append-only update log into a full-state snapshot (and prune the
/// folded updates) once this many updates accumulate past the latest snapshot.
/// Matches the TS driver's `DEFAULT_COMPACTION_THRESHOLD`. This retention bound
/// keeps the log finite.
pub const DEFAULT_COMPACTION_THRESHOLD: u32 = 64;

/// Maximum projected artifact size materialized in one settle, in
/// bytes. Mirrors the storage blob cap posture: bounded, generous, never
/// unbounded.
pub const MAX_PROJECTION_BYTES: usize = 16 * 1024 * 1024;

/// Maximum XML nesting accepted by rich-document projection. Remote Y.Doc
/// updates are not ProseMirror-schema validated, so a peer can construct
/// nesting the editor never emits; cap it before recursive tree construction.
pub const MAX_PROJECTION_DEPTH: usize = 128;

/// Maximum XML nodes visited by one rich-document projection. This bounds
/// content-derived collection growth even when many individually valid remote
/// updates accumulate into one pathological document.
pub const MAX_PROJECTION_NODES: usize = 262_144;
