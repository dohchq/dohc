//! dohc engine collab: the durable Y.Doc layer.
//!
//! Owns the durable Y.Doc update cache, its snapshots, and their compaction.
//! Holds per-document leases and the base-once replicated lineage. Applies
//! `ydoc.update` replication idempotently with echo suppression. Settles a
//! Y.Doc into artifact content with provenance through the job pipeline.
//!
//! It enforces the yrs interop harness's four caveats (`crates/yrs-interop/README.md`)
//! plus the shared root schema; see [`ydoc`] for the per-constraint enforcement.
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

#![forbid(unsafe_code)]

pub mod author_coverage;
pub mod canonical_json;
mod doc_cache;
pub mod durable;
pub mod error;
pub mod lease;
pub mod limits;
pub mod live_object_binding;
pub mod live_update_application;
pub mod owner_base_source;
pub mod owner_outbox;
pub mod replay_parity;
pub mod replication;
pub mod scene;
mod scene_lifecycle;
pub mod ydoc;

pub use doc_cache::{CacheStats, RemoteAppendProbe, WriterDocCache};
pub use durable::{
    archive_active_lineage_in_tx, claim_base, claim_base_at_relay, claim_base_at_relay_in_tx,
    claim_base_in_tx, close_session, encode_origination_base_in_tx, ensure_marker, load_doc_in,
    load_persisted, local_close_is_covered, mark_base_coordinate_absent_in_tx, maybe_compact,
    read_last_settled_sha, read_marker, read_marker_in, read_pristine_seed_lineage_source,
    read_seed_only_lineage_source, record_base_coordinate_in_tx, record_local_update,
    record_update_in_tx, replace_lineage_with_successor, replace_lineage_with_successor_in_tx,
    rewrite_bare_marker_content_kind, settle, validate_remote_update, AppendOutcome,
    BaseCoordinateRecord, BaseRelayCoordinate, ClaimOutcome, CloseOutcome, CloseProjection,
    CompactOutcome, LineageClaimStatus, LineageGuard, LocalAppend, Marker, MarkerCreation,
    OriginationBase, PersistedDoc, Regime, SettleOutcome, SuccessorInstallOutcome,
    SuccessorReplacement,
};
pub use error::CollabError;
pub use lease::{Lease, LeaseRegistry};
pub use live_object_binding::LiveObjectBinding;
pub use owner_outbox::{
    acknowledge as acknowledge_owner_outbox, append as append_owner_outbox,
    quarantine as quarantine_owner_outbox, read_pending as read_pending_owner_outbox,
    read_pending_page as read_pending_owner_outbox_page, OwnerDeliveryReceipt,
    OwnerOutboxAcknowledgeResult, OwnerOutboxAppendInput, OwnerOutboxAppendResult,
    OwnerOutboxEntry, OwnerOutboxError, OwnerOutboxLimits, OwnerOutboxPageResult,
    OwnerOutboxPending, OwnerOutboxQuarantineInput, OwnerOutboxReadCursor, OwnerOutboxReadPage,
    OwnerOutboxReadPart, OwnerOutboxState,
};
pub use replay_parity::{validate_replay_parity, validate_replay_parity_with_scratch};
pub use replication::{
    apply_remote_update, apply_remote_update_in_transaction_with_projection, RemoteApplyProjection,
    RemoteUpdate, ReplicationApplyOutcome, UpdateOrigin,
};
pub use scene::{
    encode_scene_asset_record, encode_scene_asset_records, fold_scene, import_portable_scene,
    scene_asset_directory, scene_asset_extension, scene_asset_ref, scene_asset_ref_is_owned,
    scene_data_url_len, FoldedScene, ImportedScene, ImportedSceneFile, SceneAsset,
    SceneImportError,
};
pub use scene_lifecycle::{
    freeze_scene_asset_delete_authority_in_tx, read_scene_asset_delete_authority,
    scene_asset_delete_moment_id, SceneAssetDeleteAuthority,
};
pub use ydoc::{
    fresh_successor_base, merge_updates, seed_client_id, ContentKind, OffsetMode, Projection,
    SuccessorBase, SuccessorIdentity, SuccessorIdentityInput, Ydoc, LINEAGE_EPOCH_META_KEY,
    ROOT_BODY, ROOT_FRONTMATTER, ROOT_META, ROOT_PLAINTEXT, ROOT_SCENE_APP_STATE,
    ROOT_SCENE_ASSETS, ROOT_SCENE_REVISIONS,
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
        return Err(CollabError::InvalidIdentifier {
            reason: reason.to_owned(),
        });
    }
    // Reject NUL and other control characters: the settle job id and payload
    // fingerprints are NUL-delimited (`"{ws}\0{ver}\0{obj}\0…"`), so a NUL (or
    // other control char) in a coordinate could forge a collision across
    // distinct keys. Identifiers are opaque handles, never control bytes.
    if value.bytes().any(|b| b.is_ascii_control()) {
        return Err(CollabError::InvalidIdentifier {
            reason: reason.to_owned(),
        });
    }
    Ok(())
}

pub(crate) fn validate_actor_origin_id(value: &str) -> Result<(), CollabError> {
    check_identifier(
        value,
        "actor_origin_id must be non-empty, bounded, and contain no control bytes",
    )
}
