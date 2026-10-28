//! R10 replication, cursor, share, and relay-client substrate.
//!
//! This core crate owns durable operation coordinates and their crash
//! boundaries. It deliberately has no HTTP, async runtime, thread, process, or
//! filesystem implementation: [`RelayTransport`] is implemented by the
//! sibling `dohc-engine-sync-http` adapter. All SQLite access borrows
//! [`EngineStore`] through `read_with` or `write_with`; no second connection
//! is opened.

#![forbid(unsafe_code)]

mod apply;
mod conflict_apply;
mod conflict_outbox;
mod conflict_resolve_v1;
mod cursor;
mod deferred;
mod enrolment;
mod error;
mod file_search;
mod hosted;
mod hydration;
mod journal;
mod live_audit;
mod model;
mod moment_apply;
mod outbound;
mod owner_publication;
mod settlement_publication;
pub use owner_publication::{
    OwnerAdmissionPending, OwnerPublicationPrefix, owner_publication_prefix,
};
mod path_policy;
mod references;
mod refusal_notices;
mod relay;
pub mod replica_cut;
pub use refusal_notices::{
    RefusalCoordinate, RefusalDocument, RefusalNotice, dismiss_refusal_notice, list_refusal_notices,
};
mod router;
mod secret_apply;
mod share;
mod share_grant;
mod version_apply;
mod ydoc_apply;
mod ydoc_projection;
pub use ydoc_apply::project_ydoc_with_reader;
pub use ydoc_projection::{UpdateProjectionError, project_ydoc_updates};
mod ydoc_origination;
mod ydoc_recovery;

pub use apply::{
    ApplyDisposition, ApplyOutcome, RefusalReason, ReplicationRefusal, apply_chat_envelope,
    apply_envelope_with, read_replayed_refusal, retain_refusal_for_direct_retry,
};
pub use conflict_apply::{ConflictApplyResult, apply_conflict_envelope};
pub use conflict_resolve_v1::{
    PreparedLocalConflictResolveV1, commit_local_conflict_resolve_v1_in_tx,
    prepare_local_conflict_resolve_v1_in_tx,
};
pub use cursor::{
    CursorCommit, CursorKind, OrdinaryPullCompletion, RelayCursor, ShareCursor, SharedPeerPosition,
    abandon_ordinary_pull, commit_relay_cursor, commit_share_cursor, ordinary_pull_unfinished_in,
    read_pushed_seq, read_relay_cursor, read_share_cursor, read_shared_peer_position,
};
pub use enrolment::{originate_closing_ydoc_base_in_tx, originate_live_ydoc_base_in_tx};
use error::ShareDisposition;
pub use error::{ObservedBytes, RelayError, SyncError};
pub use hosted::{
    DepartedDocument, DepartedHead, HOSTED_REPLICA_NOT_PRISTINE, HostedCommit, HostedCursor,
    HostedDocumentState, HostedDocumentStatus, HostedHold, HostedRead, HostedReplicaState,
    PASSIVE_STORE_CANNOT_HOST, RetiredFile, SERVICE_HOST_ORIGIN_PREFIX, commit_hosted_cursor,
    departed_hosted_documents, departed_hosted_materialization, departed_hosted_object_ids,
    forget_retired_hosted_file, hosted_document_parkable, is_hosted_replica, park_hosted_document,
    read_hosted_replica, retired_hosted_files,
};
pub use hydration::{
    BlobContent, BlobHydration, BlobKind, MAX_INGEST_BLOB_BYTES, blob_ceiling, hydrate_blob_content,
};
pub use journal::{
    AdoptJoinIdentityOutcome, ShareViewIdentity, ShareViewIdentityOutcome, SyncIdentity,
    adopt_join_identity, create_claim_identity, create_hosted_replica, journal_local_op_in_tx,
    journal_local_replication_op, list_replication_ops, read_replication_acked_seq,
    read_sync_identity, record_share_view_identity, workspace_journals_file_moments_in_tx,
    workspace_replicates_with_relay, workspace_replicates_with_relay_in_tx,
};
pub use live_audit::{
    journal_live_base_in_tx, journal_live_event_in_tx, journal_live_event_or_defer_in_tx,
    journal_live_settlement_in_tx,
};
pub use model::{
    MAX_BLOB_HAVE_BATCH, MAX_PAYLOAD_JSON_BYTES, MAX_PULL_OPS, MAX_PUSH_OPS_PER_BATCH,
    MAX_SHARE_PROPOSAL_OPS, MAX_WIRE_INTEGER, ReplicationEnvelope, SettlementAdmission,
};
pub use moment_apply::open_artifacts::{OpenArtifactDrain, drain_open_document_artifacts};
pub use moment_apply::{
    MomentApplyResult, MomentMaterializationChange, apply_moment_envelope,
    apply_moment_envelope_detailed,
};
pub use outbound::{
    journal_moment_append_in_tx, journal_secret_delete_in_tx, journal_secret_put_from_moment_in_tx,
    journal_secret_put_in_tx, journal_secret_version_fork_in_tx, journal_version_create_in_tx,
};
pub use path_policy::{PathClass, classify_share_path};
pub use relay::{
    BlobDownloadBatchRequest, BlobDownloadBatchResponse, BlobDownloadResponse, BlobDownloadSpec,
    BlobHaveRequest, BlobHaveResponse, BlobUploadRequest, ClaimRequest, ClaimResponse,
    DirectWritePushOutcome, DirectWriteReport, DirectWriteResult, DirectWriteState,
    DirectWriteStatus, EpochRequest, EpochResponse, HostedPassOutcome, HostedPullRequest,
    HostedPullResponse, HostedPushRefusal, HostedScope, HostedScopeDocument,
    KeyEnvelopeDownloadRequest, KeyEnvelopeDownloadResponse, KeyEnvelopeRequest,
    KeyEnvelopeResponse, LogCoordinateRequest, LogCoordinateResponse, MAX_BASE_REPAIR_LOOKUPS,
    MAX_BLOB_DOWNLOAD_BATCH, MAX_BLOB_UPLOAD_BATCH, ProbeRequest, ProbeResponse, PullRequest,
    PullResponse, PushRequest, PushResponse, PushWorkspaceProgress, RecoverResponse,
    RelaySyncClient, RelayTransport, SettlementPublicationRefusal, ShareBlobRequest,
    ShareBlobUploadRequest, ShareCollectionWriteRequest, ShareCollectionWriteResponse,
    ShareLogPushRequest, ShareProposalChange, ShareProposalSubmitOutcome,
    ShareProposalSubmitRequest, ShareProposalSubmitResponse, ShareReplicationEnvelope,
    ShareViewChangedPath, ShareViewPullOutcome, ShareViewRefusal, ShareViewRequest,
    ShareViewResponse, SharedChannelPullOutcome, SharedChannelPushOutcome, SharedChannelRejection,
    SharedChannelRequest, SharedChannelResponse, SyncPassOutcome, collision_key, hosted_feed_only,
    no_hosted_feed, read_direct_write_status, read_record_creation_statuses,
};
pub use router::{RoutedApply, apply_replication_envelope};
pub use secret_apply::apply_secret_envelope;
pub use share::{
    MAX_SHARE_VERSION_ID_CHARS, ShareAccess, ShareBoundary, ShareGrant, ShareSurface,
    apply_shared_envelope, is_valid_share_version_id,
};
pub use share_grant::GrantBinding;
pub use version_apply::{apply_version_envelope, apply_workspace_envelope};
pub use ydoc_apply::{
    AlwaysLive, LeaseProbe, LocalHeadReconcile, NoLiveLeases, PreparedLocalYdocLineage,
    ResultingHead, YdocApplyResult, YdocDrainCleanup, YdocDrainResult, YdocLineageReplacement,
    apply_ydoc_envelope, complete_deferred_ydoc_drain_cleanup, current_ydoc_content_matches_in_tx,
    drain_deferred_ydoc_for_key, drain_deferred_ydoc_for_key_holding_cleanup,
    drain_deferred_ydoc_for_live_session, ensure_no_adopted_owner_under_path,
    fold_resolution_into_ydoc_in_tx, live_session_has_drainable_deferred_ydoc,
    open_sync_conflict_for_object, prepare_local_ydoc_lineage_in_tx, project_and_write_in_tx,
    project_ydoc_with_store, reconcile_imported_resulting_head_in_tx, reconcile_local_head_in_tx,
    reconcile_local_resulting_head_in_tx, reconcile_prepared_local_head_in_tx,
    retire_ydoc_lineage_in_tx, retry_markdown_projection_in_tx, validate_scene_asset_with_store,
    workspace_has_ydoc_state_in_tx,
};
pub use ydoc_origination::{
    BaseOrigination, SharingDeclined, lineage_originated_here, originate_appended_ydoc_base_in_tx,
    originate_ydoc_base_in_tx, ydoc_update_payload,
};
pub use ydoc_recovery::{YdocRecoveryMaterialization, repair_conflicted_ydoc_recoveries};

pub use dohc_engine_collab::WriterDocCache;
pub use dohc_engine_storage::{FaultInjector, FaultPoint, NoFaults};

#[cfg(test)]
mod moment_apply_tests;
#[cfg(test)]
mod tests;
