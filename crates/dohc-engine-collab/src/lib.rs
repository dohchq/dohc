//! dohc engine collab — R11a durable Y.Doc layer.
//!
//! The Rust-owned durable Y.Doc update cache, snapshots, convergence-neutral
//! compaction, per-document leases, the base-once replicated lineage, idempotent
//! and echo-suppressed `ydoc.update` replication apply, and the settle pipeline
//! (Y.Doc → artifact content with provenance, materialized through R04's job
//! pipeline). It is the follow-through on the yrs abort criterion the week-one
//! spike cleared (`SPIKE_REPORT.md`, `DECISIONS.md`), and it enforces all five
//! binding yrs constraints — see [`ydoc`] for the per-constraint enforcement.
//!
//! # Two regimes (do not conflate)
//!
//! - **Local-only** ([`Regime::LocalOnly`]): the update/snapshot rows are a
//!   PRUNABLE fast-resume cache. The workspace file is the durable artifact; a
//!   closed session prunes the CRDT rows to nothing (keeping only the marker).
//! - **Replicated** ([`Regime::Replicated`]): the CRDT lineage is durable
//!   canonical. `ydoc.update` ops are journaled, the base is emitted exactly
//!   once (base-once), and the rows are NEVER pruned on close — peers bootstrap
//!   from that lineage.
//!
//! The crate is dormant: nothing here is reachable from product code.

#![forbid(unsafe_code)]

pub mod canonical_json;
pub mod durable;
pub mod error;
pub mod lease;
pub mod limits;
pub mod replay_parity;
pub mod replication;
pub mod scene;
mod scene_lifecycle;
pub mod ydoc;

pub use durable::{
    claim_base, claim_base_in_tx, close_session, encode_origination_base_in_tx, ensure_marker,
    load_doc_from_connection, load_doc_in_tx, load_persisted, maybe_compact, read_last_settled_sha,
    read_marker, read_marker_from_connection, read_marker_in_tx, record_local_update,
    record_local_update_creating_marker, record_local_update_creating_marker_guarded,
    record_local_update_creating_marker_with_hook, record_local_update_with_origin,
    record_local_update_with_origin_and_hook, record_update_in_tx,
    rewrite_bare_marker_content_kind, settle, validate_remote_update_for,
    validate_remote_update_with_pending, AppendOutcome, ClaimOutcome, CloseOutcome, CompactOutcome,
    Marker, OriginationBase, PersistedDoc, Regime, SettleOutcome,
};
pub use error::CollabError;
pub use lease::{Lease, LeaseRegistry};
pub use replay_parity::validate_replay_parity;
pub use replication::{
    apply_remote_update, apply_remote_update_in_transaction, RemoteUpdate, ReplicationApplyOutcome,
    UpdateOrigin,
};
pub use scene::{
    encode_scene_asset_records, fold_scene, import_portable_scene, scene_asset_directory,
    scene_asset_extension, scene_asset_ref, scene_asset_ref_is_owned, scene_data_url_len,
    FoldedScene, ImportedScene, ImportedSceneFile, SceneAsset, SceneImportError,
};
pub use scene_lifecycle::{
    freeze_scene_asset_delete_authority_in_tx, read_scene_asset_delete_authority,
    scene_asset_delete_moment_id, SceneAssetDeleteAuthority,
};
pub use ydoc::{
    merge_updates, ContentKind, OffsetMode, Projection, Ydoc, ROOT_BODY, ROOT_FRONTMATTER,
    ROOT_META, ROOT_PLAINTEXT, ROOT_SCENE_APP_STATE, ROOT_SCENE_ASSETS, ROOT_SCENE_REVISIONS,
};

// The content-addressing primitive is shared with the storage layer so a
// projection/state-vector fingerprint here is byte-identical to a blob key
// there.
pub use dohc_engine_storage::hex_sha256;

/// The durable identity of one Y.Doc lineage: a version-scoped object. Versions
/// are independent content lines, so a lineage is keyed by all three
/// coordinates (mirrors the TS `ydoc_docs` primary key).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DocKey {
    pub workspace_id: String,
    pub version_id: String,
    pub object_id: String,
}

impl DocKey {
    /// Construct and validate a key: every coordinate must be non-empty and
    /// within the shared identifier length bound.
    pub fn new(
        workspace_id: impl Into<String>,
        version_id: impl Into<String>,
        object_id: impl Into<String>,
    ) -> Result<Self, CollabError> {
        let key = DocKey {
            workspace_id: workspace_id.into(),
            version_id: version_id.into(),
            object_id: object_id.into(),
        };
        check_identifier(
            &key.workspace_id,
            "workspace_id must be non-empty and bounded",
        )?;
        check_identifier(&key.version_id, "version_id must be non-empty and bounded")?;
        check_identifier(&key.object_id, "object_id must be non-empty and bounded")?;
        Ok(key)
    }
}

fn check_identifier(value: &str, reason: &'static str) -> Result<(), CollabError> {
    if value.is_empty() || value.len() > dohc_engine_storage::MAX_IDENTIFIER_BYTES {
        return Err(CollabError::InvalidIdentifier { reason });
    }
    // Reject NUL and other control characters: the settle job id and payload
    // fingerprints are NUL-delimited (`"{ws}\0{ver}\0{obj}\0…"`), so a NUL (or
    // other control char) in a coordinate could forge a collision across
    // distinct keys. Identifiers are opaque handles, never control bytes.
    if value.bytes().any(|b| b.is_ascii_control()) {
        return Err(CollabError::InvalidIdentifier { reason });
    }
    Ok(())
}
