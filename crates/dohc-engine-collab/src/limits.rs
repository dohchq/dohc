//! Collab-layer bounds. Everything the durable Y.Doc layer accepts or grows is
//! bounded (plan §"Rust policy": bounded everything). Violations are typed
//! errors, never silent truncation, and the update log growth is bounded by
//! compaction/retention rather than allowed to grow without limit.

/// Maximum size of a single Y.Doc update accepted by the durable append and the
/// replication apply, in bytes. Matches the TS engine's
/// `MAX_VERSIONED_BINARY_FILE_BYTES` (`versionedTextStore.ts`): a larger update
/// would be stored and pushed but then REJECTED by every replicating peer on
/// hydrate, so the doc could never replicate — reject it locally BEFORE the blob
/// put + journal so nothing that can only fail on a peer is ever recorded.
pub const MAX_YDOC_UPDATE_BYTES: usize = 5 * 1024 * 1024;

/// Fold the append-only update log into a full-state snapshot (and prune the
/// folded updates) once this many updates accumulate past the latest snapshot.
/// Matches the TS driver's `DEFAULT_COMPACTION_THRESHOLD` (the legacy Hocuspocus
/// stack never compacted; the durable layer MUST, or the log grows unbounded —
/// design Risk 3). This is the retention bound that keeps the log finite.
pub const DEFAULT_COMPACTION_THRESHOLD: u32 = 64;

/// FORWARD CONTRACT (not active protection today). `apply_remote_update` applies
/// exactly one update per call, so nothing enforces this yet. It is the bound a
/// future BATCH-apply entrypoint (R11b's replication drain) MUST cap its input
/// at, so a hostile/buggy peer cannot force an unbounded apply loop in one call.
/// Do not assume it is enforced until a batch entrypoint wires it.
pub const MAX_REPLICATION_APPLY_BATCH: usize = 4096;

/// Maximum size of a settled markdown projection materialized in one settle, in
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
