//! Collab-layer bounds. Everything the durable Y.Doc layer accepts or grows is
//! bounded (plan §"Rust policy": bounded everything). Violations are typed
//! errors, never silent truncation, and the update log growth is bounded by
//! compaction/retention rather than allowed to grow without limit.

/// Maximum size of one Y.Doc payload — a delta OR a full-state base — accepted
/// by the durable append, the base claim, and the replication apply, in bytes.
/// Reject over-cap bytes locally BEFORE the blob put and the journal, so
/// nothing that can only fail on a peer is ever recorded.
///
/// **MEASURED, not inherited (#549).** The previous value was 5 MiB, copied
/// from the deleted TS engine's binary-FILE cap and justified as a bound on one
/// update. A base is a full state, so the same number bounded whole documents,
/// and it rejected work the rest of the engine accepts: the store takes a
/// document body up to `MAX_TEXT_BYTES` (10 MiB), and 5 MiB of Y.Doc state is
/// reached by a rich document holding roughly 3.5 MiB of markdown.
///
/// `ydoc_full_state_size.rs` encodes the full state of representative documents
/// against their projected content. At `MAX_TEXT_BYTES` — the largest body
/// the engine accepts — the measured full state was:
///
/// | document | content | full state | ratio |
/// | --- | ---: | ---: | ---: |
/// | plaintext | 10,486,884 | 10,486,912 | 1.000 |
/// | rich, 700 B paragraphs | 10,486,321 | 11,263,557 | 1.074 |
/// | rich, 400 B paragraphs | 10,486,020 | 11,836,040 | 1.129 |
/// | rich, 120 B paragraphs (82,591 blocks) | 10,485,835 | 14,747,923 | 1.406 |
///
/// Revision churn adds ~60 bytes of state per interior edit, on top of content.
///
/// So the bound is **twice `MAX_TEXT_BYTES`**: past the worst measured document
/// (1.406x) with room for roughly 100,000 revisions of churn above it. It is a
/// measured limit with headroom, not a theorem — enough churn still exceeds it,
/// and that refusal names this constraint, its limit, and the observed size.
///
/// Widening this moves the whole path: `blob_ceiling(BlobKind::Ydoc)` reads it,
/// `MAX_INGEST_BLOB_BYTES` derives from that, and the relay's own
/// `MAX_BLOB_BYTES` (`services/sync-relay/src/server.ts`) must stay at or above
/// the result — `the_relay_transport_cap_covers_the_widest_engine_ingest_ceiling`
/// holds that.
///
/// One number covers deltas and bases on purpose. Nothing measures how big a
/// single EDIT may be; a delta never exceeds the full state it is a slice of;
/// and the paths that walk a lineage piece by piece meet snapshots and deltas
/// mixed together. A second number would be a second thing to keep true.
pub const MAX_YDOC_UPDATE_BYTES: usize = 20 * 1024 * 1024;

/// Fold the append-only update log into a full-state snapshot (and prune the
/// folded updates) once this many updates accumulate past the latest snapshot.
/// Matches the TS driver's `DEFAULT_COMPACTION_THRESHOLD`. This retention bound
/// keeps the log finite.
pub const DEFAULT_COMPACTION_THRESHOLD: u32 = 64;

/// FORWARD CONTRACT (not active protection today). `apply_remote_update` applies
/// exactly one update per call, so nothing enforces this yet. It is the bound a
/// future BATCH-apply entrypoint (R11b's replication drain) MUST cap its input
/// at, so a hostile/buggy peer cannot force an unbounded apply loop in one call.
/// Do not assume it is enforced until a batch entrypoint wires it.
pub const MAX_REPLICATION_APPLY_BATCH: usize = 4096;

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
