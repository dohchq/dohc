//! The workspace actor: a dedicated OS thread owning exactly one storage
//! writer connection, driven by a **tokio** command loop.
//!
//! This is the Rust replacement for the TS engine's process-global write chain
//! and `workspaceActivity` map (`STATE_OWNERSHIP.tsv` rows `chain-store-writes`,
//! `registry-workspace-activity`, `actor-registry`). State ownership is
//! unambiguous: the connection lives on the worker thread and never crosses it;
//! callers hold clonable [`ActorHandle`]s that only send messages
//! (`PORTING.md` §5, §14).
//!
//! ## The blocking writer under an async loop (CAL-2)
//!
//! The writer connection is synchronous, blocking rusqlite. It stays on ONE
//! dedicated OS thread (`std::thread`) — **never** on the async runtime (plan
//! §Workspace actor model: "one writable `rusqlite` connection on a dedicated
//! thread (never blocking the async runtime)"). Commands flow over a bounded
//! [`tokio::sync::mpsc`] channel; the worker consumes them with
//! [`blocking_recv`](tokio::sync::mpsc::Receiver::blocking_recv), so the
//! blocking SQLite work never occupies a runtime worker. Replies come back on
//! [`tokio::sync::oneshot`] channels. The tokio channels are runtime-agnostic
//! for their blocking API, so the CAL-1 synchronous call sites keep working
//! outside any runtime, while the async methods drive the loop from within one.
//!
//! Lifecycle is explicit — `open → ready → draining → closed` — and `Drop`
//! releases the connection deterministically by joining the worker (no detached
//! task outlives the actor). Cancellation ([`CancellationToken`]) is checked
//! BETWEEN bounded units, never inside a transaction (`PORTING.md` §12).

use crate::error::RuntimeError;
use crate::identity::EngineDbIdentity;
use crate::search::{
    GranularChatMessageSearchBatch, SearchPageBatch, SearchResult, SearchResultKey,
    delete_file_search_index, ensure_search_index_for_version,
    query_chat_messages_granular_bounded, search_workspace, search_workspace_page,
    upsert_file_search_index,
};
use crate::search::{read_engine_search_policy, resolve_effective_policy};
use dohc_engine_collab::{
    AppendOutcome, CloseOutcome, ContentKind, DocKey, LeaseRegistry, Projection, Regime, Ydoc,
};
use dohc_engine_crypto::{SecretDataKey, SecretPlaintext, load_key_file};
use dohc_engine_domain::{
    AgentRunRecord, AgentUnreadThreadRow, BinaryHead, BinaryHeadMeta, BinaryWriteResult,
    CaptureIngest, CaptureIngestBinary, CaptureIngestBinaryResult, CaptureManifestSeedEntry,
    CaptureRetire, CaptureRetireResult, CaptureSecret, CaptureSecretRetire, ChannelThreadSummary,
    ChatAgentReadState, ChatAttachment, ChatBookmark, ChatBookmarkTransition, ChatChannel,
    ChatChannelKind, ChatChannelSummary, ChatDecision, ChatFeedPage, ChatFeedReadState,
    ChatFileMention, ChatFollow, ChatMention, ChatMessage, ChatMessagePage,
    ChatProjectionFileAccess, ChatReaction, ChatThread, ChatThreadProjection, ChatThreadReadState,
    CompareTextFileVersions, CreateFileThread, CreateNamedVersion, DeleteResult, DeleteTextFile,
    DispatchClaim, DispatchRecovery, DomainError, InbandBinary, InbandSecret, InbandText,
    LinkedChatStore, ListMomentsQuery, MentionCursor, MergeTextFileFromVersion,
    MergeTextFileResult, MomentPage, MomentRecord, PendingBookmarkRow, RenameResult,
    RenameTextFile, ResolveDecision, ResolveTextConflict, ResolveTextConflictResult,
    RollbackTextFileMutation, RunRecordLink, SaveBookmark, SecretComparePage, SecretDelete,
    SecretFileStat, SecretFileStore, SecretMomentPage, SecretMomentRecord, SecretRestoreResult,
    SecretWrite, SecretWriteResult, SendMessage, SetFollow, SetReaction, SnapshotContent,
    SnapshotMetadata, SnapshotView, StartChannelThread, TextConflict, TextSnapshot,
    ThreadDispatchPause, UnreadFileThread, VersionFileChangePage, VersionRecord,
    VersionedTextComparison, VersionedTextStore, WriteBinary, WriteResult, WriteText,
    apply_secret_file_from_version, binary_delete_job_id, binary_rename_delete_job_id,
    binary_rename_write_job_id, binary_rollback_job_identity, capture_ingest_binary_in_tx,
    capture_ingest_in_tx, capture_manifest_seed, capture_retire_in_tx, capture_secret_retire,
    compare_secret_files_page_keyless, decode_binary_rollback_job_identity,
    delete_secret_file_keyless, derive_capture_object_id, enqueue_binary_delete,
    enqueue_binary_rename, enqueue_write, fork_version_keyless, get_secret_moment_keyless,
    has_secret_state, insert_text_conflict_if_absent, list_secret_files_keyless,
    list_secret_files_keyless_page, list_secret_moments_page_keyless,
    restore_secret_file_verbatim_with_metadata, secret_file_len_keyless,
    select_snapshot_by_path_in_tx, validate_addressable_plaintext_path, write_binary_in_tx,
    write_projected_text_in_tx, write_text_in_tx,
};
use dohc_engine_files::{
    DurabilityPolicy, JobOutcome, MaterializeError, ProjectionTargetKind, ProjectionTargetState,
    StdBackoff, StdReplacer, materialize_one, materialize_secret_delete_one,
    materialize_secret_one, probe_projection_target,
};
use dohc_engine_storage::{
    CompoundWrite, Document, EngineStore, FaultAction, FaultInjector, FaultPoint, JobStatus,
    MaterializationJob, MaterializationJobSpec, MaterializationOperation, NoFaults, Preimage,
    StorageError, TxnOutcome, WriteOutcome, hex_sha256, put_binary_blob, upsert_projection_job,
};
use dohc_engine_sync::{
    ApplyOutcome, BlobDownloadRequest, BlobDownloadResponse, BlobHaveRequest, BlobHaveResponse,
    BlobUploadRequest, ClaimRequest, ClaimResponse, ConflictApplyResult, EpochRequest,
    EpochResponse, KeyEnvelopeDownloadRequest, KeyEnvelopeDownloadResponse, KeyEnvelopeRequest,
    KeyEnvelopeResponse, ProbeRequest, ProbeResponse, PullRequest, PullResponse, PushRequest,
    PushResponse, RecoverResponse, RelayCursor, RelayError, RelaySyncClient, RelayTransport,
    ReplicationEnvelope, ShareBlobRequest, ShareCursor, ShareViewPullOutcome, ShareViewRequest,
    ShareViewResponse, SharedChannelPullOutcome, SharedChannelPushOutcome, SharedChannelRequest,
    SharedChannelResponse, SyncPassOutcome, apply_conflict_envelope, read_replayed_refusal,
    read_sync_identity, retain_refusal_for_direct_retry,
};
use dohc_engine_sync_http::HttpRelayTransport;
use rusqlite::{OptionalExtension, params};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::sync_channel as std_sync_channel;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::mpsc::{self, OwnedPermit};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Bound on the actor's command queue. Backpressure blocks the sender rather
/// than growing an unbounded queue (`plan §Rust policy`: bounded everything).
const COMMAND_QUEUE_CAPACITY: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostCommitMaterializeOutcome {
    Applied,
    Skipped,
    Conflict,
    Superseded,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryWriteExecutionResult {
    pub write: BinaryWriteResult,
    pub materialized: bool,
    pub materialize_outcome: PostCommitMaterializeOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeExecutionResult {
    pub merge: MergeTextFileResult,
    pub materialize_enqueued: bool,
    pub materialized: bool,
    pub materialize_outcome: PostCommitMaterializeOutcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RollbackExecutionResult {
    pub deduped: bool,
    pub materialize_enqueued: bool,
    pub materialized: bool,
    pub materialize_outcome: PostCommitMaterializeOutcome,
}

pub struct ActiveVersionSwitch {
    pub workspace_id: String,
    pub version_id: String,
    pub root_dir: PathBuf,
    pub self_writes: Arc<dyn SelfWriteRecorder>,
    pub now_ms: i64,
}

/// Physical channel capacity: the data bound plus ONE slot reserved at spawn
/// for the `Close` command (see [`WorkspaceActor::close`]). Reserving keeps the
/// usable data capacity at exactly [`COMMAND_QUEUE_CAPACITY`] while guaranteeing
/// `Close` always has a home, so shutdown never spins or starves.
const CHANNEL_CAPACITY: usize = COMMAND_QUEUE_CAPACITY + 1;

/// The actor lifecycle, observable via [`ActorHandle::lifecycle`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleState {
    /// The worker thread is opening the store (transient; before the first
    /// command is served).
    Opening,
    /// The store is open and serving commands.
    Ready,
    /// A close was requested; the worker is finishing and will not accept new
    /// work.
    Draining,
    /// The worker has exited and the connection has been released.
    Closed,
}

impl LifecycleState {
    const fn as_u8(self) -> u8 {
        match self {
            LifecycleState::Opening => 0,
            LifecycleState::Ready => 1,
            LifecycleState::Draining => 2,
            LifecycleState::Closed => 3,
        }
    }

    fn from_u8(value: u8) -> LifecycleState {
        match value {
            0 => LifecycleState::Opening,
            1 => LifecycleState::Ready,
            2 => LifecycleState::Draining,
            _ => LifecycleState::Closed,
        }
    }
}

/// A cheap, comparable snapshot of the store's row counts — enough for
/// durability/convergence assertions without exposing the connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreSnapshot {
    pub documents: i64,
    pub journal_entries: i64,
    pub request_ledger: i64,
    pub migration_ledger: i64,
}

/// The outcome of a cancellable multi-unit run ([`ActorHandle::run_units`]).
/// `committed` is the number of units that reached a durable commit; `cancelled`
/// reports whether the run stopped early at a between-unit cancellation point.
/// The store always holds exactly the committed prefix — cancellation never
/// tears a unit (`PORTING.md` §12).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnitsOutcome {
    pub committed: usize,
    pub cancelled: bool,
}

/// Actor-owned snapshot used to establish one daemon Y.Doc session without
/// exposing the store connection to the protocol layer.
#[derive(Debug)]
pub struct YdocOpenState {
    pub key: DocKey,
    pub content_kind: ContentKind,
    pub regime: Regime,
    pub initial_update: Vec<u8>,
    /// The text head's blob sha at open time (None for an absent head) —
    /// the session's settle preimage expectation until its first settle.
    pub head_blob_sha256: Option<String>,
    pub lineage_existing: bool,
    pub seed_markdown: Option<String>,
}

/// Result of the single moment+snapshot+materialization settlement path.
#[derive(Debug)]
pub struct YdocSettlement {
    pub moment_id: String,
    pub path: String,
    pub markdown: String,
    pub sha256: String,
    pub projection: Projection,
}

#[derive(Clone, PartialEq, Eq)]
pub struct RelayConfiguration {
    pub base_url: String,
    pub bearer_token: String,
    #[cfg(debug_assertions)]
    pub allow_insecure_loopback_for_tests: bool,
}

impl std::fmt::Debug for RelayConfiguration {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RelayConfiguration")
            .field("base_url", &self.base_url)
            .field("bearer_token", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, Clone)]
pub enum RelayOperation {
    Push {
        workspace_id: String,
    },
    Pull {
        workspace_id: String,
    },
    CommitCursor {
        workspace_id: String,
        cursor: RelayCursor,
    },
    Probe {
        workspace_id: String,
    },
    Claim {
        workspace_id: String,
    },
    RecoverOrigin {
        workspace_id: String,
        new_origin_id: String,
    },
    UploadKeyEnvelope {
        workspace_id: String,
        envelope_json: String,
        if_match: Option<String>,
    },
    DownloadKeyEnvelope {
        workspace_id: String,
    },
    PullSharedChannel {
        workspace_id: String,
        share_id: String,
        channel_wire_id: String,
    },
    PushSharedChannel {
        workspace_id: String,
        share_id: String,
        channel_wire_id: String,
    },
    PullShareView {
        workspace_id: String,
        share_id: String,
    },
    CommitShareViewCursor {
        workspace_id: String,
        cursor: ShareCursor,
    },
}

const RELAY_IO_PENDING: &str = "relay-io-pending";

#[derive(Debug, Clone, PartialEq, Eq)]
enum RelayIoRequest {
    Push(PushRequest),
    Pull(PullRequest),
    Probe(ProbeRequest),
    Claim(ClaimRequest),
    RotateEpoch(EpochRequest),
    BlobsHave(BlobHaveRequest),
    UploadBlob(BlobUploadRequest),
    DownloadBlob(BlobDownloadRequest),
    UploadKeyEnvelope(KeyEnvelopeRequest),
    DownloadKeyEnvelope(KeyEnvelopeDownloadRequest),
    SharedChannelPull(SharedChannelRequest),
    SharedChannelPush(SharedChannelRequest),
    ShareViewPull(ShareViewRequest),
    ShareBlob(ShareBlobRequest),
}

#[derive(Debug, Clone)]
enum RelayIoResponse {
    Push(PushResponse),
    Pull(PullResponse),
    Probe(ProbeResponse),
    Claim(ClaimResponse),
    RotateEpoch(EpochResponse),
    BlobsHave(BlobHaveResponse),
    UploadBlob,
    DownloadBlob(BlobDownloadResponse),
    UploadKeyEnvelope(KeyEnvelopeResponse),
    DownloadKeyEnvelope(KeyEnvelopeDownloadResponse),
    SharedChannelPull(SharedChannelResponse),
    SharedChannelPush(SharedChannelResponse),
    ShareViewPull(ShareViewResponse),
    ShareBlob(BlobDownloadResponse),
}

#[derive(Default)]
struct DeferredRelayState {
    completed: Vec<(RelayIoRequest, Result<RelayIoResponse, RelayError>)>,
    pending: Option<RelayIoRequest>,
    workspace_pushed: usize,
    shared_channel_pushed: usize,
}

#[derive(Clone, Default)]
struct DeferredRelayTransport {
    state: Arc<Mutex<DeferredRelayState>>,
}

impl DeferredRelayTransport {
    fn resolve<T>(
        &self,
        request: RelayIoRequest,
        project: impl Fn(&RelayIoResponse) -> Option<T>,
    ) -> Result<T, RelayError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(index) = state
            .completed
            .iter()
            .position(|(completed, _)| completed == &request)
        {
            let release = matches!(
                state.completed[index].0,
                RelayIoRequest::Push(_)
                    | RelayIoRequest::SharedChannelPush(_)
                    | RelayIoRequest::UploadBlob(_)
                    | RelayIoRequest::DownloadBlob(_)
                    | RelayIoRequest::UploadKeyEnvelope(_)
                    | RelayIoRequest::DownloadKeyEnvelope(_)
                    | RelayIoRequest::ShareBlob(_)
            ) || matches!(
                &state.completed[index].1,
                Ok(RelayIoResponse::BlobsHave(response)) if response.missing.is_empty()
            );
            let uploaded = matches!(state.completed[index].0, RelayIoRequest::UploadBlob(_));
            let projected = match &state.completed[index].1 {
                Ok(response) => project(response).ok_or(RelayError::InvalidResponse),
                Err(error) => Err(error.clone()),
            };
            if release && projected.is_ok() {
                let _ = state.completed.swap_remove(index);
                if uploaded {
                    state
                        .completed
                        .retain(|(request, _)| !matches!(request, RelayIoRequest::BlobsHave(_)));
                }
            }
            return projected;
        }
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending != &request)
        {
            return Err(RelayError::InvalidResponse);
        }
        state.pending = Some(request);
        Err(RelayError::Local(RELAY_IO_PENDING.to_owned()))
    }

    fn take_pending(&self) -> Option<RelayIoRequest> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pending
            .take()
    }

    fn complete(&self, request: RelayIoRequest, result: Result<RelayIoResponse, RelayError>) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Ok(RelayIoResponse::Push(response)) = &result
            && let RelayIoRequest::Push(request) = &request
            && !request.ops.is_empty()
        {
            state.workspace_pushed = state.workspace_pushed.saturating_add(response.inserted);
        }
        if let Ok(RelayIoResponse::SharedChannelPush(response)) = &result
            && let Some(push) = &response.push
        {
            state.shared_channel_pushed = state.shared_channel_pushed.saturating_add(push.inserted);
        }
        state.completed.push((request, result));
    }

    fn apply_progress(&self, outcome: &mut RelayOperationOutcome) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match outcome {
            RelayOperationOutcome::Sync(SyncPassOutcome::Complete { pushed, .. }) => {
                *pushed = state.workspace_pushed;
            }
            RelayOperationOutcome::SharedChannelPushed(outcome) => {
                outcome.pushed = state.shared_channel_pushed;
            }
            _ => {}
        }
    }
}

macro_rules! relay_transport_method {
    ($name:ident, $request:ty, $request_variant:ident, $response:ty, $response_variant:ident) => {
        fn $name(&self, request: $request) -> Result<$response, RelayError> {
            self.resolve(
                RelayIoRequest::$request_variant(request),
                |response| match response {
                    RelayIoResponse::$response_variant(value) => Some(value.clone()),
                    _ => None,
                },
            )
        }
    };
}

impl RelayTransport for DeferredRelayTransport {
    relay_transport_method!(push, PushRequest, Push, PushResponse, Push);
    relay_transport_method!(pull, PullRequest, Pull, PullResponse, Pull);
    relay_transport_method!(probe, ProbeRequest, Probe, ProbeResponse, Probe);
    relay_transport_method!(claim_workspace, ClaimRequest, Claim, ClaimResponse, Claim);
    relay_transport_method!(
        rotate_epoch,
        EpochRequest,
        RotateEpoch,
        EpochResponse,
        RotateEpoch
    );
    relay_transport_method!(
        blobs_have,
        BlobHaveRequest,
        BlobsHave,
        BlobHaveResponse,
        BlobsHave
    );

    fn upload_blob(&self, request: BlobUploadRequest) -> Result<(), RelayError> {
        self.resolve(RelayIoRequest::UploadBlob(request), |response| {
            matches!(response, RelayIoResponse::UploadBlob).then_some(())
        })
    }

    relay_transport_method!(
        download_blob,
        BlobDownloadRequest,
        DownloadBlob,
        BlobDownloadResponse,
        DownloadBlob
    );
    relay_transport_method!(
        upload_key_envelope,
        KeyEnvelopeRequest,
        UploadKeyEnvelope,
        KeyEnvelopeResponse,
        UploadKeyEnvelope
    );
    relay_transport_method!(
        download_key_envelope,
        KeyEnvelopeDownloadRequest,
        DownloadKeyEnvelope,
        KeyEnvelopeDownloadResponse,
        DownloadKeyEnvelope
    );
    relay_transport_method!(
        shared_channel_pull,
        SharedChannelRequest,
        SharedChannelPull,
        SharedChannelResponse,
        SharedChannelPull
    );
    relay_transport_method!(
        shared_channel_push,
        SharedChannelRequest,
        SharedChannelPush,
        SharedChannelResponse,
        SharedChannelPush
    );
    relay_transport_method!(
        share_view_pull,
        ShareViewRequest,
        ShareViewPull,
        ShareViewResponse,
        ShareViewPull
    );
    relay_transport_method!(
        share_blob,
        ShareBlobRequest,
        ShareBlob,
        BlobDownloadResponse,
        ShareBlob
    );
}

#[cfg(test)]
mod deferred_relay_tests {
    use super::*;

    #[test]
    fn completed_push_batches_release_consumed_request_payloads() {
        let transport = DeferredRelayTransport::default();
        let request = PushRequest {
            workspace_id: "workspace".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            origin_id: "origin".to_owned(),
            after_seq: -1,
            ops: (0..dohc_engine_sync::MAX_PUSH_OPS_PER_BATCH)
                .map(|origin_seq| dohc_engine_sync::ReplicationEnvelope {
                    workspace_id: "workspace".to_owned(),
                    origin_id: "origin".to_owned(),
                    origin_seq: i64::try_from(origin_seq).expect("sequence"),
                    op_kind: "probe".to_owned(),
                    payload: serde_json::json!({"body": "retained until consumed"}),
                    recorded_at_ms: 1_000,
                })
                .collect(),
        };
        transport.complete(
            RelayIoRequest::Push(request.clone()),
            Ok(RelayIoResponse::Push(PushResponse {
                accepted: request.ops.len(),
                inserted: request.ops.len(),
                skipped: 0,
                current_max_origin_seq: i64::try_from(request.ops.len() - 1).expect("maximum"),
            })),
        );

        assert_eq!(
            transport.push(request).expect("consume completed push"),
            PushResponse {
                accepted: dohc_engine_sync::MAX_PUSH_OPS_PER_BATCH,
                inserted: dohc_engine_sync::MAX_PUSH_OPS_PER_BATCH,
                skipped: 0,
                current_max_origin_seq:
                    i64::try_from(dohc_engine_sync::MAX_PUSH_OPS_PER_BATCH - 1,).expect("maximum"),
            }
        );
        assert!(
            transport
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .completed
                .is_empty(),
            "MUTATION: omitting Push from the release set retains every consumed batch"
        );
    }

    #[test]
    fn large_multi_blob_pull_does_not_retain_consumed_buffers() {
        let transport = DeferredRelayTransport::default();
        for index in 0..64 {
            let request = ShareBlobRequest {
                share_id: "share".to_owned(),
                sha256: format!("{index:064x}"),
            };
            let bytes = vec![u8::try_from(index).expect("byte"); 256 * 1024];
            transport.complete(
                RelayIoRequest::ShareBlob(request.clone()),
                Ok(RelayIoResponse::ShareBlob(BlobDownloadResponse {
                    bytes: bytes.clone(),
                })),
            );
            assert_eq!(
                transport.share_blob(request).expect("consume blob").bytes,
                bytes
            );
        }

        let state = transport
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let retained = state
            .completed
            .iter()
            .filter_map(|(_, result)| match result {
                Ok(RelayIoResponse::DownloadBlob(response))
                | Ok(RelayIoResponse::ShareBlob(response)) => Some(response.bytes.len()),
                _ => None,
            })
            .sum::<usize>();
        assert_eq!(
            retained, 0,
            "persisted blob responses must be released before the RPC completes"
        );
    }

    #[test]
    fn completed_empty_blob_inventory_is_released_without_an_upload() {
        let transport = DeferredRelayTransport::default();
        let request = BlobHaveRequest {
            workspace_id: "workspace".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            sha256s: Vec::new(),
        };
        transport.complete(
            RelayIoRequest::BlobsHave(request.clone()),
            Ok(RelayIoResponse::BlobsHave(BlobHaveResponse {
                missing: Vec::new(),
            })),
        );
        assert!(
            transport
                .blobs_have(request)
                .expect("consume inventory")
                .missing
                .is_empty()
        );
        assert!(
            transport
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .completed
                .is_empty(),
            "MUTATION: retaining a successful all-present inventory holds its request vector"
        );
    }

    #[test]
    fn deferred_key_upload_surfaces_the_first_cas_conflict_without_a_cached_retry_loop() {
        let transport = DeferredRelayTransport::default();
        let request = KeyEnvelopeRequest {
            workspace_id: "workspace".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            envelope_json: "{}".to_owned(),
            if_match: Some("stale".to_owned()),
        };
        transport.complete(
            RelayIoRequest::UploadKeyEnvelope(request.clone()),
            Err(RelayError::Conflict),
        );
        let client = RelaySyncClient::new(transport.clone());
        assert_eq!(
            client.upload_key_envelope(request),
            Err(RelayError::Conflict)
        );
        assert!(
            transport.take_pending().is_none(),
            "MUTATION: rebasing the CAS conflict schedules a GET and re-enters cached I/O"
        );
    }

    #[test]
    fn deferred_multi_page_pull_schedules_each_http_request_once() {
        let transport = DeferredRelayTransport::default();
        let request = |cursor| PullRequest {
            workspace_id: "workspace".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            cursor,
            limit: 1,
        };
        let mut scheduled = 0;
        for next in 0..4 {
            for cursor in 0..=next {
                let result = transport.pull(request(cursor));
                if cursor < next {
                    assert!(result.is_ok(), "completed prefixes are memoized");
                } else {
                    assert_eq!(result, Err(RelayError::Local(RELAY_IO_PENDING.to_owned())));
                    let pending = transport.take_pending().expect("one pending request");
                    transport.complete(
                        pending,
                        Ok(RelayIoResponse::Pull(PullResponse {
                            ops: Vec::new(),
                            next_cursor: cursor + 1,
                            has_more: cursor < 3,
                        })),
                    );
                    scheduled += 1;
                }
            }
        }
        for cursor in 0..4 {
            transport.pull(request(cursor)).expect("completed page");
        }
        assert_eq!(
            scheduled, 4,
            "each distinct HTTP page adds one actor turn; replay does not schedule a quadratic number"
        );
    }
}

#[derive(Debug)]
pub enum RelayOperationOutcome {
    Sync(SyncPassOutcome),
    CursorCommitted,
    Probe(bool),
    Claimed,
    Recovered(RecoverResponse),
    KeyEnvelopeUploaded { etag: String },
    KeyEnvelopeDownloaded { envelope_json: String, etag: String },
    SharedChannelPulled(SharedChannelPullOutcome),
    SharedChannelPushed(SharedChannelPushOutcome),
    ShareViewPulled(ShareViewPullOutcome),
}

/// Daemon-owned sink for identities written by settlement. Recording before
/// the actor replies closes the watcher race between atomic replace and the
/// protocol layer regaining control.
pub trait SelfWriteRecorder: Send + Sync {
    fn record(&self, workspace_id: &str, path: &str, sha256: &str);
    /// Remove a previously recorded identity — the compensation for a settle
    /// whose materialization conflicted (the file was never replaced, so the
    /// entry must not survive to suppress a genuine capture).
    fn retract(&self, workspace_id: &str, path: &str, sha256: &str);
}

enum Command {
    Write {
        write: CompoundWrite,
        faults: Arc<dyn FaultInjector>,
        reply: oneshot::Sender<Result<WriteOutcome, StorageError>>,
    },
    Read {
        doc_id: String,
        reply: oneshot::Sender<Result<Option<Document>, StorageError>>,
    },
    Snapshot {
        reply: oneshot::Sender<Result<StoreSnapshot, StorageError>>,
    },
    BindShadowClone {
        token: String,
        reply: oneshot::Sender<Result<bool, StorageError>>,
    },
    /// A long operation: a sequence of bounded units (one compound write each,
    /// one transaction each). The worker checks `token` BEFORE each unit and
    /// stops cooperatively at that between-unit boundary.
    RunUnits {
        units: Vec<CompoundWrite>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<UnitsOutcome, StorageError>>,
    },
    VersionedTextWrite {
        input: WriteText,
        root_dir: Option<PathBuf>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<WriteResult, RuntimeError>>,
    },
    VersionedBinaryWrite {
        input: WriteBinary,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<BinaryWriteExecutionResult, RuntimeError>>,
    },
    VersionedTextRename {
        input: RenameTextFile,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<RenameResult, RuntimeError>>,
    },
    VersionedTextDelete {
        input: DeleteTextFile,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<DeleteResult, RuntimeError>>,
    },
    VersionedTextRollback {
        input: RollbackTextFileMutation,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<RollbackExecutionResult, RuntimeError>>,
    },
    VersionedTextCompare {
        input: CompareTextFileVersions,
        reply: oneshot::Sender<Result<VersionedTextComparison, RuntimeError>>,
    },
    VersionedTextMerge {
        input: MergeTextFileFromVersion,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<MergeExecutionResult, RuntimeError>>,
    },
    CompareVersionFilesPage {
        workspace_id: String,
        source_version_id: String,
        target_version_id: String,
        after_path: Option<String>,
        limit: usize,
        reply: oneshot::Sender<Result<VersionFileChangePage, RuntimeError>>,
    },
    CaptureIngest {
        input: CaptureIngest,
        root_dir: Option<PathBuf>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<WriteResult, RuntimeError>>,
    },
    CaptureIngestBinary {
        input: CaptureIngestBinary,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<CaptureIngestBinaryResult, RuntimeError>>,
    },
    CaptureSecret {
        // Boxed: the plaintext + key payload should not size every command
        // slot, and the key must never be duplicated by channel copies.
        payload: Box<(CaptureSecret, SecretDataKey)>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<SecretWriteResult, RuntimeError>>,
    },
    CaptureSecretRetire {
        input: CaptureSecretRetire,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<Option<SecretMomentRecord>, RuntimeError>>,
    },
    SecretStateExists {
        workspace_id: String,
        reply: oneshot::Sender<Result<bool, RuntimeError>>,
    },
    CaptureRetire {
        input: CaptureRetire,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<CaptureRetireResult, RuntimeError>>,
    },
    VersionedTextRead {
        workspace_id: String,
        version_id: String,
        path: String,
        token: CancellationToken,
        reply: oneshot::Sender<Result<Option<TextSnapshot>, RuntimeError>>,
    },
    ResolvePathObject {
        workspace_id: String,
        version_id: String,
        path: String,
        reply: oneshot::Sender<Result<Option<String>, RuntimeError>>,
    },
    ListVersions {
        workspace_id: String,
        reply: oneshot::Sender<Result<Vec<VersionRecord>, RuntimeError>>,
    },
    ListSnapshots {
        workspace_id: String,
        version_id: String,
        reply: oneshot::Sender<Result<Vec<SnapshotView>, RuntimeError>>,
    },
    ListSnapshotMetadata {
        workspace_id: String,
        version_id: String,
        after_path: Option<String>,
        limit: usize,
        reply: oneshot::Sender<Result<Vec<SnapshotMetadata>, RuntimeError>>,
    },
    ListMoments {
        query: Box<ListMomentsQuery>,
        reply: oneshot::Sender<Result<MomentPage, RuntimeError>>,
    },
    GetMoment {
        workspace_id: String,
        moment_id: String,
        reply: oneshot::Sender<Result<Option<MomentRecord>, RuntimeError>>,
    },
    ReadBinary {
        workspace_id: String,
        version_id: String,
        path: String,
        reply: oneshot::Sender<Result<Option<BinaryHead>, RuntimeError>>,
    },
    ReadBinaryMeta {
        workspace_id: String,
        version_id: String,
        path: String,
        reply: oneshot::Sender<Result<Option<BinaryHeadMeta>, RuntimeError>>,
    },
    ReadBinaryBlob {
        workspace_id: String,
        sha256: String,
        reply: oneshot::Sender<Result<Option<dohc_engine_domain::BinaryBlobRead>, RuntimeError>>,
    },
    ReadBinaryBlobForEgress {
        workspace_id: String,
        sha256: String,
        reply: oneshot::Sender<Result<Option<dohc_engine_domain::BinaryBlobRead>, RuntimeError>>,
    },
    ReadTextInband {
        workspace_id: String,
        version_id: String,
        path: String,
        cap: usize,
        reply: oneshot::Sender<Result<Option<InbandText>, RuntimeError>>,
    },
    ReadBinaryInband {
        workspace_id: String,
        version_id: String,
        path: String,
        cap: usize,
        reply: oneshot::Sender<Result<Option<InbandBinary>, RuntimeError>>,
    },
    MaterializeSecretInband {
        workspace_id: String,
        version_id: String,
        path: String,
        key: Box<SecretDataKey>,
        cap: usize,
        reply: oneshot::Sender<Result<Option<InbandSecret>, RuntimeError>>,
    },
    WriteSecretFile {
        input: Box<SecretWrite>,
        key: Box<SecretDataKey>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<SecretWriteResult, RuntimeError>>,
    },
    DeleteSecretFile {
        input: SecretDelete,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<Option<SecretMomentRecord>, RuntimeError>>,
    },
    ForkSecretVersion {
        workspace_id: String,
        from_version_id: String,
        to_version_id: String,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<(), RuntimeError>>,
    },
    ListSecretMoments {
        workspace_id: String,
        version_id: Option<String>,
        path: Option<String>,
        before_moment_order: Option<i64>,
        limit: usize,
        reply: oneshot::Sender<Result<SecretMomentPage, RuntimeError>>,
    },
    GetSecretMoment {
        workspace_id: String,
        moment_id: String,
        reply: oneshot::Sender<Result<Option<SecretMomentRecord>, RuntimeError>>,
    },
    CompareSecretFiles {
        workspace_id: String,
        source_version_id: String,
        target_version_id: String,
        after_path: Option<String>,
        limit: usize,
        key: Option<Box<SecretDataKey>>,
        reply: oneshot::Sender<Result<SecretComparePage, RuntimeError>>,
    },
    ApplySecretFile {
        workspace_id: String,
        path: String,
        from_version_id: String,
        to_version_id: String,
        moment_id: String,
        metadata_origin: String,
        metadata_summary: Option<String>,
        metadata_correlation_id: Option<String>,
        now_ms: i64,
        key: Box<SecretDataKey>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<SecretWriteResult, RuntimeError>>,
    },
    RestoreSecretFile {
        workspace_id: String,
        path: String,
        before_moment_id: String,
        moment_id: String,
        metadata_origin: String,
        metadata_summary: Option<String>,
        metadata_correlation_id: Option<String>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<SecretRestoreResult, RuntimeError>>,
    },
    ListSecretFiles {
        workspace_id: String,
        version_id: String,
        reply: oneshot::Sender<Result<Vec<SecretFileStat>, RuntimeError>>,
    },
    SecretFileLen {
        workspace_id: String,
        version_id: String,
        path: String,
        reply: oneshot::Sender<Result<Option<i64>, RuntimeError>>,
    },
    ListSecretFilesPage {
        workspace_id: String,
        version_id: String,
        after_path: Option<String>,
        limit: usize,
        reply: oneshot::Sender<Result<Vec<SecretFileStat>, RuntimeError>>,
    },
    MaterializeSecret {
        workspace_id: String,
        version_id: String,
        path: String,
        key: Box<SecretDataKey>,
        reply: oneshot::Sender<Result<Option<String>, RuntimeError>>,
    },
    ActiveVersionId {
        workspace_id: String,
        reply: oneshot::Sender<Result<String, RuntimeError>>,
    },
    ActiveVersion {
        workspace_id: String,
        reply: oneshot::Sender<Result<VersionRecord, RuntimeError>>,
    },
    EnsureMainVersion {
        workspace_id: String,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<VersionRecord, RuntimeError>>,
    },
    SetActiveVersion {
        input: ActiveVersionSwitch,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<VersionRecord, RuntimeError>>,
    },
    CreateNamedVersion {
        input: CreateNamedVersion,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<VersionRecord, RuntimeError>>,
    },
    PreflightCreateNamedVersion {
        input: CreateNamedVersion,
        token: CancellationToken,
        reply: oneshot::Sender<Result<Option<VersionRecord>, RuntimeError>>,
    },
    CaptureManifestSeed {
        workspace_id: String,
        version_id: String,
        reply: oneshot::Sender<Result<Vec<CaptureManifestSeedEntry>, RuntimeError>>,
    },
    YdocApply {
        key: DocKey,
        content_kind: ContentKind,
        update: Vec<u8>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<AppendOutcome, RuntimeError>>,
    },
    YdocOpenState {
        workspace_id: String,
        now_ms: i64,
        drain_deferred: bool,
        expected_key: Option<DocKey>,
        version_id: String,
        path: String,
        content_kind: Option<ContentKind>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<YdocOpenState, RuntimeError>>,
    },
    YdocVersionUnsettledContentKind {
        workspace_id: String,
        version_id: String,
        ignored_object_ids: Vec<String>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<Option<ContentKind>, RuntimeError>>,
    },
    YdocRecordUpdate {
        key: DocKey,
        path: String,
        content_kind: ContentKind,
        regime: Regime,
        update: Vec<u8>,
        request_id: Option<String>,
        actor_origin_id: Option<String>,
        require_empty_lineage: bool,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<AppendOutcome, RuntimeError>>,
    },
    YdocSettle {
        root_dir: PathBuf,
        key: DocKey,
        path: String,
        content_kind: ContentKind,
        expected_head_sha: Option<String>,
        session_id: String,
        self_writes: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<YdocSettlement, RuntimeError>>,
    },
    YdocResync {
        key: DocKey,
        token: CancellationToken,
        reply: oneshot::Sender<Result<Vec<u8>, RuntimeError>>,
    },
    YdocCloseSession {
        key: DocKey,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<Option<CloseOutcome>, RuntimeError>>,
    },
    MaterializeReplayPending {
        root_dir: PathBuf,
        workspace_id: String,
        now_ms: i64,
        reply: oneshot::Sender<Result<usize, RuntimeError>>,
    },
    MaterializeReplayPendingForFence {
        root_dir: PathBuf,
        workspace_id: String,
        self_writes: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
        reply: oneshot::Sender<Result<(), RuntimeError>>,
    },
    ConflictList {
        workspace_id: String,
        status: Option<String>,
        after_conflict_id: Option<String>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<Vec<TextConflict>, RuntimeError>>,
    },
    ConflictOpen {
        conflict: Box<TextConflict>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<bool, RuntimeError>>,
    },
    ConflictResolve {
        input: ResolveTextConflict,
        root_dir: Option<PathBuf>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ResolveTextConflictResult, RuntimeError>>,
    },
    ConflictApplyReplicated {
        envelope: ReplicationEnvelope,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ApplyOutcome<ConflictApplyResult>, RuntimeError>>,
    },
    Search {
        root_dir: PathBuf,
        workspace_id: String,
        version_id: String,
        query: String,
        limit: Option<i64>,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<Vec<SearchResult>, RuntimeError>>,
    },
    SearchPage {
        root_dir: PathBuf,
        workspace_id: String,
        version_id: String,
        query: String,
        limit: Option<i64>,
        now_ms: i64,
        expected_generation: Option<u64>,
        after: Option<SearchResultKey>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<SearchPageBatch, RuntimeError>>,
    },
    SearchQueryChatMessagesGranular {
        workspace_id: String,
        query: String,
        limit: i64,
        materialized_byte_budget: usize,
        reply: oneshot::Sender<Result<GranularChatMessageSearchBatch, RuntimeError>>,
    },
    EnsureSearchIndex {
        root_dir: PathBuf,
        workspace_id: String,
        version_id: String,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<(), RuntimeError>>,
    },
    ChatChannelCreate {
        workspace_id: String,
        channel_id: String,
        name: String,
        kind: ChatChannelKind,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatChannel, RuntimeError>>,
    },
    ChatChannelEnsureGeneral {
        workspace_id: String,
        channel_id: String,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatChannel, RuntimeError>>,
    },
    ChatChannelEnsureAgent {
        workspace_id: String,
        channel_id: String,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatChannel, RuntimeError>>,
    },
    ChatChannelsList {
        workspace_id: String,
        reply: oneshot::Sender<Result<Vec<ChatChannelSummary>, RuntimeError>>,
    },
    ChatChannelFindBySlug {
        workspace_id: String,
        slug: String,
        reply: oneshot::Sender<Result<Option<ChatChannel>, RuntimeError>>,
    },
    ChatChannelGetWireId {
        workspace_id: String,
        channel_id: String,
        reply: oneshot::Sender<Result<Option<String>, RuntimeError>>,
    },
    ChatThreadStart {
        input: Box<StartChannelThread>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<(ChatThread, ChatMessage), RuntimeError>>,
    },
    ChatThreadCreate {
        input: Box<CreateFileThread>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatThread, RuntimeError>>,
    },
    ChatThreadsList {
        workspace_id: String,
        reply: oneshot::Sender<Result<Vec<ChatThread>, RuntimeError>>,
    },
    ChatThreadsListForFile {
        workspace_id: String,
        object_id: String,
        after: Option<(i64, String)>,
        limit: i64,
        reply: oneshot::Sender<Result<Vec<ChatThread>, RuntimeError>>,
    },
    ChatThreadsListForChannel {
        workspace_id: String,
        channel_id: String,
        after: Option<(i64, String)>,
        limit: i64,
        reply: oneshot::Sender<Result<Vec<ChannelThreadSummary>, RuntimeError>>,
    },
    ChatThreadFindChannelId {
        workspace_id: String,
        thread_id: String,
        reply: oneshot::Sender<Result<Option<String>, RuntimeError>>,
    },
    ChatThreadGetProjection {
        workspace_id: String,
        thread_id: String,
        linked_file_access: ChatProjectionFileAccess,
        reply: oneshot::Sender<Result<ChatThreadProjection, RuntimeError>>,
    },
    ChatAttachmentsListForThread {
        workspace_id: String,
        thread_id: String,
        after: Option<(i64, String)>,
        limit: i64,
        reply: oneshot::Sender<Result<Vec<ChatAttachment>, RuntimeError>>,
    },
    ChatAttachmentsListFileMentions {
        workspace_id: String,
        object_id: Option<String>,
        path_hint: Option<String>,
        after: Option<(i64, String)>,
        limit: i64,
        reply: oneshot::Sender<Result<Vec<ChatFileMention>, RuntimeError>>,
    },
    ChatMentionsBackfill {
        workspace_id: String,
        token: CancellationToken,
        reply: oneshot::Sender<Result<i64, RuntimeError>>,
    },
    ChatMentionsListForHandle {
        workspace_id: String,
        handle: String,
        unread_only: bool,
        after: Option<MentionCursor>,
        limit: i64,
        reply: oneshot::Sender<Result<Vec<ChatMention>, RuntimeError>>,
    },
    ChatDispatchRecordEligibleTriggers {
        workspace_id: String,
        verified_user_id: Option<String>,
        at_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<i64, RuntimeError>>,
    },
    ChatMessageSend {
        input: Box<SendMessage>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatMessage, RuntimeError>>,
    },
    ChatDecisionResolve {
        input: Box<ResolveDecision>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatDecision, RuntimeError>>,
    },
    ChatDecisionsList {
        workspace_id: String,
        thread_id: String,
        after: Option<(i64, String)>,
        limit: i64,
        reply: oneshot::Sender<Result<Vec<ChatDecision>, RuntimeError>>,
    },
    ChatReactionSet {
        input: Box<SetReaction>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatReaction, RuntimeError>>,
    },
    ChatReactionsList {
        workspace_id: String,
        thread_id: String,
        after: Option<(i64, String)>,
        limit: i64,
        reply: oneshot::Sender<Result<Vec<ChatReaction>, RuntimeError>>,
    },
    ChatMessagesList {
        workspace_id: String,
        thread_id: String,
        limit: i64,
        after_message_order: Option<i64>,
        reply: oneshot::Sender<Result<ChatMessagePage, RuntimeError>>,
    },
    ChatReadStateMarkThreadRead {
        workspace_id: String,
        thread_id: String,
        up_to_sequence: i64,
        expected_revision: Option<i64>,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatThreadReadState, RuntimeError>>,
    },
    ChatReadStateGet {
        workspace_id: String,
        thread_id: String,
        reply: oneshot::Sender<Result<ChatThreadReadState, RuntimeError>>,
    },
    ChatReadStateListUnreadFileThreads {
        workspace_id: String,
        after_thread_id: Option<String>,
        limit: i64,
        reply: oneshot::Sender<Result<Vec<UnreadFileThread>, RuntimeError>>,
    },
    ChatAgentUnreadThreads {
        workspace_id: String,
        after: Option<(i64, String)>,
        limit: i64,
        reply: oneshot::Sender<Result<Vec<AgentUnreadThreadRow>, RuntimeError>>,
    },
    ChatAgentMarkThreadRead {
        workspace_id: String,
        thread_id: String,
        up_to_created_at_ms: i64,
        up_to_message_id: String,
        expected_revision: Option<i64>,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatAgentReadState, RuntimeError>>,
    },
    ChatFollowSet {
        input: Box<SetFollow>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatFollow, RuntimeError>>,
    },
    ChatFollowsList {
        workspace_id: String,
        owner_user_id: String,
        state: Option<String>,
        reply: oneshot::Sender<Result<Vec<ChatFollow>, RuntimeError>>,
    },
    ChatFollowsEnsureDefaults {
        workspace_id: String,
        owner_user_id: String,
        token: CancellationToken,
        reply: oneshot::Sender<Result<(), RuntimeError>>,
    },
    ChatBookmarkFind {
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
        reply: oneshot::Sender<Result<Option<ChatBookmark>, RuntimeError>>,
    },
    ChatBookmarksListPending {
        workspace_id: String,
        owner_user_id: String,
        limit: i64,
        after: Option<(i64, String)>,
        reply: oneshot::Sender<Result<Vec<PendingBookmarkRow>, RuntimeError>>,
    },
    ChatFeedMarkSeen {
        workspace_id: String,
        owner_user_id: String,
        replication_owner_user_id: Option<String>,
        head_cursor: String,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatFeedReadState, RuntimeError>>,
    },
    ChatFeedListPersonal {
        workspace_id: String,
        owner_user_id: String,
        limit: Option<i64>,
        cursor: Option<String>,
        reply: oneshot::Sender<Result<ChatFeedPage, RuntimeError>>,
    },
    ChatBookmarkSave {
        input: Box<SaveBookmark>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatBookmark, RuntimeError>>,
    },
    ChatBookmarksList {
        workspace_id: String,
        owner_user_id: String,
        state: Option<String>,
        reply: oneshot::Sender<Result<Vec<ChatBookmark>, RuntimeError>>,
    },
    ChatBookmarkMarkReady {
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
        generation: i64,
        projected_at_ms: i64,
        projection_object_id: Option<String>,
        projection_path: Option<String>,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatBookmarkTransition, RuntimeError>>,
    },
    ChatBookmarkArchive {
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatBookmark, RuntimeError>>,
    },
    ChatBookmarkMarkPending {
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
        request_id: String,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatBookmark, RuntimeError>>,
    },
    ChatBookmarkMarkFailed {
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
        generation: i64,
        failure_reason: String,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatBookmarkTransition, RuntimeError>>,
    },
    ChatBookmarkMarkStale {
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
        generation: i64,
        failure_reason: Option<String>,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ChatBookmarkTransition, RuntimeError>>,
    },
    ChatDispatchEnqueue {
        workspace_id: String,
        trigger_message_id: String,
        thread_id: String,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<bool, RuntimeError>>,
    },
    ChatDispatchClaimNextPending {
        workspace_id: String,
        run_id: String,
        command: String,
        log_path: Option<String>,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<Option<DispatchClaim>, RuntimeError>>,
    },
    ChatDispatchListPending {
        workspace_id: String,
        after: Option<(i64, String)>,
        limit: i64,
        reply: oneshot::Sender<Result<Vec<dohc_engine_domain::DispatchRecord>, RuntimeError>>,
    },
    ChatDispatchOpenRuns {
        workspace_id: String,
        after: Option<(i64, String)>,
        limit: i64,
        reply: oneshot::Sender<Result<Vec<DispatchClaim>, RuntimeError>>,
    },
    ChatDispatchListRunMessages {
        workspace_id: String,
        run_id: String,
        after_message_id: Option<String>,
        limit: i64,
        reply: oneshot::Sender<Result<Vec<String>, RuntimeError>>,
    },
    ChatDispatchRunIdForMessage {
        workspace_id: String,
        message_id: String,
        reply: oneshot::Sender<Result<Option<String>, RuntimeError>>,
    },
    ChatDispatchRunRecordsForThread {
        workspace_id: String,
        thread_id: String,
        run_limit: Option<i64>,
        after: Option<(i64, String, String)>,
        page_limit: i64,
        reply: oneshot::Sender<Result<Vec<RunRecordLink>, RuntimeError>>,
    },
    ChatDispatchGetRunRecord {
        workspace_id: String,
        run_id: String,
        reply: oneshot::Sender<Result<Option<AgentRunRecord>, RuntimeError>>,
    },
    ChatDispatchThreadPaused {
        workspace_id: String,
        thread_id: String,
        reply: oneshot::Sender<Result<bool, RuntimeError>>,
    },
    ChatDispatchGetThreadPauseState {
        workspace_id: String,
        thread_id: String,
        reply: oneshot::Sender<Result<Option<ThreadDispatchPause>, RuntimeError>>,
    },
    ChatDispatchRecentCount {
        workspace_id: String,
        thread_id: String,
        since_ms: f64,
        reply: oneshot::Sender<Result<i64, RuntimeError>>,
    },
    ChatDispatchFailPendingForThread {
        workspace_id: String,
        thread_id: String,
        reason: String,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<i64, RuntimeError>>,
    },
    ChatDispatchRecordRunMessage {
        workspace_id: String,
        message_id: String,
        run_id: String,
        token: CancellationToken,
        reply: oneshot::Sender<Result<bool, RuntimeError>>,
    },
    ChatDispatchSetThreadPaused {
        workspace_id: String,
        thread_id: String,
        paused: bool,
        reason: Option<String>,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<ThreadDispatchPause, RuntimeError>>,
    },
    ChatDispatchMarkFailureNotePosted {
        workspace_id: String,
        run_id: String,
        token: CancellationToken,
        reply: oneshot::Sender<Result<AgentRunRecord, RuntimeError>>,
    },
    ChatDispatchRequeueFailedTrigger {
        workspace_id: String,
        trigger_message_id: String,
        run_id: String,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<bool, RuntimeError>>,
    },
    ChatDispatchListAppQuitRecoveries {
        workspace_id: String,
        after: Option<(i64, String)>,
        limit: i64,
        reply: oneshot::Sender<Result<Vec<DispatchRecovery>, RuntimeError>>,
    },
    ChatDispatchComplete {
        workspace_id: String,
        run_id: String,
        exit_code: i64,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<(), RuntimeError>>,
    },
    ChatDispatchFail {
        workspace_id: String,
        run_id: String,
        reason: String,
        exit_code: Option<i64>,
        now_ms: i64,
        token: CancellationToken,
        reply: oneshot::Sender<Result<(), RuntimeError>>,
    },
    ChatDispatchReclaimRunning {
        workspace_id: String,
        max_attempts: i64,
        now_ms: i64,
        reply: oneshot::Sender<Result<Vec<String>, RuntimeError>>,
    },
    Relay {
        transport: DeferredRelayTransport,
        operation: RelayOperation,
        leases: LeaseRegistry,
        token: CancellationToken,
        reply: oneshot::Sender<Result<RelayOperationOutcome, RuntimeError>>,
    },
    /// Break the loop and release the connection. Carries no reply: the caller
    /// joins the worker, and the join is the completion signal (so `close`
    /// needs no `blocking_recv`, staying safe to call from a `Drop` that runs
    /// inside an async runtime).
    Close,
}

/// Owns the worker thread and the command sender. Held by the supervisor;
/// callers use [`ActorHandle`]s. Dropping it joins the worker.
pub struct WorkspaceActor {
    identity: EngineDbIdentity,
    generation: u64,
    tx: mpsc::Sender<Command>,
    /// A permit for the `Close` command, reserved at spawn from the dedicated
    /// extra channel slot. `close` consumes it to deliver `Close` in bounded
    /// time — fairly, behind existing FIFO work, without a `try_send` spin and
    /// without blocking in `Drop`.
    close_permit: Option<OwnedPermit<Command>>,
    state: Arc<AtomicU8>,
    worker: Option<JoinHandle<()>>,
}

impl WorkspaceActor {
    /// Spawn the actor's worker thread and open the store. Blocks until the
    /// open completes so open errors (including the fingerprint fence)
    /// propagate synchronously. `spawn` is intentionally synchronous — a
    /// workspace open is an infrequent, off-hot-path operation the supervisor
    /// drives without holding its registry lock.
    pub(crate) fn spawn(
        db_path: PathBuf,
        identity: EngineDbIdentity,
        generation: u64,
        now_ms: i64,
    ) -> Result<Self, RuntimeError> {
        Self::spawn_with_mode(db_path, identity, generation, now_ms, false)
    }

    /// Spawn an actor whose store connection is query-only and never runs the
    /// writer open ritual.
    pub(crate) fn spawn_read_only(
        db_path: PathBuf,
        identity: EngineDbIdentity,
        generation: u64,
    ) -> Result<Self, RuntimeError> {
        Self::spawn_with_mode(db_path, identity, generation, 0, true)
    }

    fn spawn_with_mode(
        db_path: PathBuf,
        identity: EngineDbIdentity,
        generation: u64,
        now_ms: i64,
        read_only: bool,
    ) -> Result<Self, RuntimeError> {
        let (tx, rx) = mpsc::channel::<Command>(CHANNEL_CAPACITY);
        // Reserve the dedicated Close slot up front (the channel is empty, so
        // this cannot fail); `close` sends through it without contending with
        // data producers on tokio's fair waiter queue.
        let close_permit = tx.clone().try_reserve_owned().ok();
        let state = Arc::new(AtomicU8::new(LifecycleState::Opening.as_u8()));
        // Startup handshake uses a std channel: `spawn` runs in a synchronous
        // context, so the open result must not depend on a tokio runtime.
        let (startup_tx, startup_rx) = std_sync_channel::<Result<(), StorageError>>(1);

        let worker_state = Arc::clone(&state);
        let worker = std::thread::Builder::new()
            .name("dohc-engine-actor".to_owned())
            .spawn(move || worker_main(db_path, now_ms, read_only, rx, worker_state, startup_tx))
            .map_err(RuntimeError::ThreadSpawn)?;

        match startup_rx.recv() {
            Ok(Ok(())) => Ok(WorkspaceActor {
                identity,
                generation,
                tx,
                close_permit,
                state,
                worker: Some(worker),
            }),
            Ok(Err(storage_err)) => {
                let _ = worker.join();
                Err(RuntimeError::Storage(storage_err))
            }
            Err(_) => {
                let _ = worker.join();
                Err(RuntimeError::WorkerPanicked)
            }
        }
    }

    /// A clonable handle for issuing commands.
    pub fn handle(&self) -> ActorHandle {
        ActorHandle {
            identity: self.identity.clone(),
            tx: self.tx.clone(),
            state: Arc::clone(&self.state),
        }
    }

    /// The canonical identity this actor is keyed by.
    pub fn identity(&self) -> &EngineDbIdentity {
        &self.identity
    }

    /// The session generation (incremented on restart).
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The current lifecycle state.
    pub fn lifecycle(&self) -> LifecycleState {
        LifecycleState::from_u8(self.state.load(Ordering::Acquire))
    }

    /// Orderly close: drain queued work, stop accepting new commands, release
    /// the connection, and join the worker. Idempotent.
    ///
    /// `Close` is delivered through the slot reserved at spawn, so it lands in
    /// bounded time behind existing FIFO work — no `try_send` spin and no
    /// starvation under sustained concurrent submission (tokio's fair waiter
    /// queue can never crowd it out). Sending through the reserved permit does
    /// not block or await, so `close` is safe to call from a `Drop` that runs
    /// inside an async runtime.
    ///
    /// The subsequent `worker.join()` **does block the calling thread** until
    /// the worker drains and exits. From an async runtime that briefly parks the
    /// executor thread; a future `close_async` could yield instead (noted for a
    /// later shard). A worker wedged inside a fault gate must be released by the
    /// caller before close (same contract as CAL-1).
    pub fn close(&mut self) -> Result<(), RuntimeError> {
        let Some(worker) = self.worker.take() else {
            return Ok(());
        };
        match self.close_permit.take() {
            // Reserved slot: instant, fair, FIFO-respecting delivery.
            Some(permit) => {
                permit.send(Command::Close);
            }
            // No reserved permit (only if a prior close already consumed it, or
            // the impossible spawn-time reservation failure): best-effort. A
            // Closed error means the worker is already gone — nothing to do.
            None => {
                let _ = self.tx.try_send(Command::Close);
            }
        }
        match worker.join() {
            Ok(()) => Ok(()),
            Err(_) => Err(RuntimeError::WorkerPanicked),
        }
    }
}

impl Drop for WorkspaceActor {
    fn drop(&mut self) {
        // Deterministic release: never leave the worker thread (and its
        // connection) detached.
        let _ = self.close();
    }
}

/// A clonable, message-only handle to a [`WorkspaceActor`]. Holds no state of
/// its own beyond the sender and the shared lifecycle flag.
#[derive(Clone)]
pub struct ActorHandle {
    identity: EngineDbIdentity,
    tx: mpsc::Sender<Command>,
    state: Arc<AtomicU8>,
}

impl ActorHandle {
    /// The canonical identity of the actor this handle addresses.
    pub fn identity(&self) -> &EngineDbIdentity {
        &self.identity
    }

    /// The actor's current lifecycle state.
    pub fn lifecycle(&self) -> LifecycleState {
        LifecycleState::from_u8(self.state.load(Ordering::Acquire))
    }

    // --- Synchronous API (CAL-1 call sites; must be used OUTSIDE a runtime) ---

    /// Issue a compound write through the actor's single writer, blocking the
    /// calling thread for the result. For synchronous callers that are not on a
    /// tokio runtime; the async loop is unaffected.
    pub fn write(
        &self,
        write: CompoundWrite,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<WriteOutcome, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::Write {
                write,
                faults,
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }

    /// Enqueue a compound write WITHOUT waiting for its result, failing fast
    /// with [`RuntimeError::Overloaded`] if the bounded queue is full. This is
    /// the observable-backpressure path (the protocol's `OVERLOADED`). The
    /// result is not delivered to the caller.
    pub fn try_submit_write(
        &self,
        write: CompoundWrite,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<(), RuntimeError> {
        // A single-slot reply channel is created and immediately dropped; the
        // worker's later `reply.send` fails harmlessly.
        let (reply, _reply_rx) = oneshot::channel();
        match self.tx.try_send(Command::Write {
            write,
            faults,
            reply,
        }) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(RuntimeError::Overloaded),
            Err(TrySendError::Closed(_)) => Err(RuntimeError::ActorUnavailable),
        }
    }

    /// Read a document by id, blocking the calling thread.
    pub fn read(&self, doc_id: &str) -> Result<Option<Document>, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::Read {
                doc_id: doc_id.to_owned(),
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }

    /// Snapshot the store's row counts, blocking the calling thread.
    pub fn snapshot(&self) -> Result<StoreSnapshot, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::Snapshot { reply })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }

    /// Capture a text file on the actor's writer, blocking the calling thread.
    pub fn capture_ingest_blocking(
        &self,
        input: CaptureIngest,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<WriteResult, RuntimeError> {
        self.capture_ingest_blocking_with_root(input, None, faults)
    }

    /// Capture and index a text file when the owning workspace session can
    /// supply its authoritative root.
    pub fn capture_ingest_indexed_blocking(
        &self,
        input: CaptureIngest,
        root_dir: PathBuf,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<WriteResult, RuntimeError> {
        self.capture_ingest_blocking_with_root(input, Some(root_dir), faults)
    }

    fn capture_ingest_blocking_with_root(
        &self,
        input: CaptureIngest,
        root_dir: Option<PathBuf>,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<WriteResult, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::CaptureIngest {
                input,
                root_dir,
                faults,
                token: CancellationToken::new(),
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Capture a binary file on the actor's writer, blocking the caller.
    pub fn capture_ingest_binary_blocking(
        &self,
        input: CaptureIngestBinary,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<CaptureIngestBinaryResult, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::CaptureIngestBinary {
                input,
                faults,
                token: CancellationToken::new(),
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Capture a secret file on the actor's writer, blocking the caller. The
    /// workspace data key travels with the request (the actor holds no key
    /// state; custody stays at the composition layer).
    pub fn capture_secret_blocking(
        &self,
        input: CaptureSecret,
        key: SecretDataKey,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<SecretWriteResult, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::CaptureSecret {
                payload: Box::new((input, key)),
                faults,
                token: CancellationToken::new(),
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Retire a captured secret path on the actor's writer, blocking the
    /// caller. Keyless: a delete never decrypts.
    pub fn capture_secret_retire_blocking(
        &self,
        input: CaptureSecretRetire,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<Option<SecretMomentRecord>, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::CaptureSecretRetire {
                input,
                faults,
                token: CancellationToken::new(),
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Whether the workspace holds ANY encrypted secret state — the async
    /// variant for RPC handlers (a missing key file over live secret rows
    /// must fail closed, never read as "no secrets").
    pub async fn secret_state_exists(&self, workspace_id: String) -> Result<bool, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::SecretStateExists {
                workspace_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Whether the workspace holds ANY encrypted secret state. The capture
    /// layer consults this before ever MINTING a data key: a missing key file
    /// over live secret rows must fail closed, never silently strand the
    /// history under a fresh key.
    pub fn secret_state_exists_blocking(&self, workspace_id: String) -> Result<bool, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::SecretStateExists {
                workspace_id,
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Retire a captured path on the actor's writer, blocking the caller.
    pub fn capture_retire_blocking(
        &self,
        input: CaptureRetire,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<CaptureRetireResult, RuntimeError> {
        debug_assert_sync_context();
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .blocking_send(Command::CaptureRetire {
                input,
                faults,
                token: CancellationToken::new(),
                reply,
            })
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .blocking_recv()
            .map_err(|_| RuntimeError::ActorUnavailable)?
    }

    // --- Async API (drives the tokio loop from within a runtime) ---

    /// Async compound write. Awaits queue space (bounded backpressure) and the
    /// worker's reply.
    pub async fn write_async(
        &self,
        write: CompoundWrite,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<WriteOutcome, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::Write {
                write,
                faults,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }

    /// Async read.
    pub async fn read_async(&self, doc_id: &str) -> Result<Option<Document>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::Read {
                doc_id: doc_id.to_owned(),
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }

    /// Stamp a fresh shadow database or verify an existing shadow binding on
    /// the actor-owned connection before the workspace can accept writes.
    pub async fn bind_shadow_clone(&self, token: String) -> Result<bool, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::BindShadowClone { token, reply })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }

    /// Execute a versioned-text write on the actor's single writer thread.
    pub async fn versioned_text_write(
        &self,
        input: WriteText,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::VersionedTextWrite {
                input,
                root_dir: None,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Execute an RPC text write with its FTS row in the same transaction.
    pub async fn versioned_text_write_indexed(
        &self,
        input: WriteText,
        root_dir: PathBuf,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::VersionedTextWrite {
                input,
                root_dir: Some(root_dir),
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Execute, index, and materialize a caller-originated binary write on the
    /// actor's sole writer thread.
    pub async fn versioned_binary_write(
        &self,
        input: WriteBinary,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<BinaryWriteExecutionResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::VersionedBinaryWrite {
                input,
                root_dir,
                self_writes,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn versioned_text_rename(
        &self,
        input: RenameTextFile,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<RenameResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::VersionedTextRename {
                input,
                root_dir,
                self_writes,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn versioned_text_delete(
        &self,
        input: DeleteTextFile,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<DeleteResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::VersionedTextDelete {
                input,
                root_dir,
                self_writes,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn versioned_text_rollback(
        &self,
        input: RollbackTextFileMutation,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<RollbackExecutionResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::VersionedTextRollback {
                input,
                root_dir,
                self_writes,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn versioned_text_compare(
        &self,
        input: CompareTextFileVersions,
    ) -> Result<VersionedTextComparison, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::VersionedTextCompare { input, reply })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn versioned_text_merge(
        &self,
        input: MergeTextFileFromVersion,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<MergeExecutionResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::VersionedTextMerge {
                input,
                root_dir,
                self_writes,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn compare_version_files_page(
        &self,
        workspace_id: String,
        source_version_id: String,
        target_version_id: String,
        after_path: Option<String>,
        limit: usize,
    ) -> Result<VersionFileChangePage, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::CompareVersionFilesPage {
                workspace_id,
                source_version_id,
                target_version_id,
                after_path,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Capture a text file on the actor's single writer thread.
    pub async fn capture_ingest(
        &self,
        input: CaptureIngest,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        self.capture_ingest_with_root(input, None, faults, token)
            .await
    }

    /// Capture and index a text file when the owning workspace session can
    /// supply its authoritative root.
    pub async fn capture_ingest_indexed(
        &self,
        input: CaptureIngest,
        root_dir: PathBuf,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        self.capture_ingest_with_root(input, Some(root_dir), faults, token)
            .await
    }

    async fn capture_ingest_with_root(
        &self,
        input: CaptureIngest,
        root_dir: Option<PathBuf>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::CaptureIngest {
                input,
                root_dir,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Capture a binary file on the actor's single writer thread.
    pub async fn capture_ingest_binary(
        &self,
        input: CaptureIngestBinary,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<CaptureIngestBinaryResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::CaptureIngestBinary {
                input,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Every version record in the workspace, oldest-first
    /// (`created_at_ms, name, version_id`) — the read behind `versions.list`.
    pub async fn list_versions(
        &self,
        workspace_id: String,
    ) -> Result<Vec<VersionRecord>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ListVersions {
                workspace_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn list_snapshots(
        &self,
        workspace_id: String,
        version_id: String,
    ) -> Result<Vec<SnapshotView>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ListSnapshots {
                workspace_id,
                version_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// One page of snapshot METADATA (no body hydration) — the listing read
    /// behind `versionedText.list`.
    pub async fn list_snapshot_metadata(
        &self,
        workspace_id: String,
        version_id: String,
        after_path: Option<String>,
        limit: usize,
    ) -> Result<Vec<SnapshotMetadata>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ListSnapshotMetadata {
                workspace_id,
                version_id,
                after_path,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn list_moments(&self, query: ListMomentsQuery) -> Result<MomentPage, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ListMoments {
                query: Box::new(query),
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn get_moment(
        &self,
        workspace_id: String,
        moment_id: String,
    ) -> Result<Option<MomentRecord>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::GetMoment {
                workspace_id,
                moment_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn read_binary(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
    ) -> Result<Option<BinaryHead>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ReadBinary {
                workspace_id,
                version_id,
                path,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// The binary head's metadata (no bytes) — sized in SQL.
    pub async fn read_binary_meta(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
    ) -> Result<Option<BinaryHeadMeta>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ReadBinaryMeta {
                workspace_id,
                version_id,
                path,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn read_binary_blob(
        &self,
        workspace_id: String,
        sha256: String,
    ) -> Result<Option<dohc_engine_domain::BinaryBlobRead>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ReadBinaryBlob {
                workspace_id,
                sha256,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn read_binary_blob_for_egress(
        &self,
        workspace_id: String,
        sha256: String,
    ) -> Result<Option<dohc_engine_domain::BinaryBlobRead>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ReadBinaryBlobForEgress {
                workspace_id,
                sha256,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Text head with the body hydrated only under `cap` — one actor turn.
    pub async fn read_text_inband(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
        cap: usize,
    ) -> Result<Option<InbandText>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ReadTextInband {
                workspace_id,
                version_id,
                path,
                cap,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Binary head with the bytes hydrated only under `cap` — one actor turn.
    pub async fn read_binary_inband(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
        cap: usize,
    ) -> Result<Option<InbandBinary>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ReadBinaryInband {
                workspace_id,
                version_id,
                path,
                cap,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Secret materialize with the cap decided in the SAME turn — an
    /// over-cap tip is never decrypted.
    pub async fn materialize_secret_inband(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
        key: SecretDataKey,
        cap: usize,
    ) -> Result<Option<InbandSecret>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::MaterializeSecretInband {
                workspace_id,
                version_id,
                path,
                key: Box::new(key),
                cap,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn write_secret_file(
        &self,
        input: SecretWrite,
        key: SecretDataKey,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<SecretWriteResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::WriteSecretFile {
                input: Box::new(input),
                key: Box::new(key),
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn delete_secret_file(
        &self,
        input: SecretDelete,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<Option<SecretMomentRecord>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::DeleteSecretFile {
                input,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn fork_secret_version(
        &self,
        workspace_id: String,
        from_version_id: String,
        to_version_id: String,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<(), RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ForkSecretVersion {
                workspace_id,
                from_version_id,
                to_version_id,
                now_ms,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn list_secret_moments(
        &self,
        workspace_id: String,
        version_id: Option<String>,
        path: Option<String>,
        before_moment_order: Option<i64>,
        limit: usize,
    ) -> Result<SecretMomentPage, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ListSecretMoments {
                workspace_id,
                version_id,
                path,
                before_moment_order,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn get_secret_moment(
        &self,
        workspace_id: String,
        moment_id: String,
    ) -> Result<Option<SecretMomentRecord>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::GetSecretMoment {
                workspace_id,
                moment_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn compare_secret_files(
        &self,
        workspace_id: String,
        source_version_id: String,
        target_version_id: String,
        after_path: Option<String>,
        limit: usize,
        key: Option<SecretDataKey>,
    ) -> Result<SecretComparePage, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::CompareSecretFiles {
                workspace_id,
                source_version_id,
                target_version_id,
                after_path,
                limit,
                key: key.map(Box::new),
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn apply_secret_file(
        &self,
        workspace_id: String,
        path: String,
        from_version_id: String,
        to_version_id: String,
        moment_id: String,
        metadata_origin: String,
        metadata_summary: Option<String>,
        metadata_correlation_id: Option<String>,
        now_ms: i64,
        key: SecretDataKey,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<SecretWriteResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ApplySecretFile {
                workspace_id,
                path,
                from_version_id,
                to_version_id,
                moment_id,
                metadata_origin,
                metadata_summary,
                metadata_correlation_id,
                now_ms,
                key: Box::new(key),
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn restore_secret_file(
        &self,
        workspace_id: String,
        path: String,
        before_moment_id: String,
        moment_id: String,
        metadata_origin: String,
        metadata_summary: Option<String>,
        metadata_correlation_id: Option<String>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<SecretRestoreResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::RestoreSecretFile {
                workspace_id,
                path,
                before_moment_id,
                moment_id,
                metadata_origin,
                metadata_summary,
                metadata_correlation_id,
                now_ms,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn list_secret_files(
        &self,
        workspace_id: String,
        version_id: String,
    ) -> Result<Vec<SecretFileStat>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ListSecretFiles {
                workspace_id,
                version_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// One secret tip's recorded byte length — keyless, no decrypt.
    pub async fn secret_file_len(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
    ) -> Result<Option<i64>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::SecretFileLen {
                workspace_id,
                version_id,
                path,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// One page of secret-file tips (metadata only, keyset by path).
    pub async fn list_secret_files_page(
        &self,
        workspace_id: String,
        version_id: String,
        after_path: Option<String>,
        limit: usize,
    ) -> Result<Vec<SecretFileStat>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ListSecretFilesPage {
                workspace_id,
                version_id,
                after_path,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Decrypt one secret tip to UTF-8 plaintext. The KEY comes from the
    /// caller (the daemon loads it from the workspace root), matching the
    /// capture-secret pattern — the actor never holds key custody itself.
    pub async fn materialize_secret(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
        key: SecretDataKey,
    ) -> Result<Option<String>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::MaterializeSecret {
                workspace_id,
                version_id,
                path,
                key: Box::new(key),
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// The workspace's ACTIVE version id (falling back to main), read on the
    /// actor thread. The capture driver targets this so captures land in the
    /// version the user is actually on (TS oracle parity).
    pub async fn active_version_id(&self, workspace_id: String) -> Result<String, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ActiveVersionId {
                workspace_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn active_version(
        &self,
        workspace_id: String,
    ) -> Result<VersionRecord, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ActiveVersion {
                workspace_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn ensure_main_version(
        &self,
        workspace_id: String,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<VersionRecord, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::EnsureMainVersion {
                workspace_id,
                now_ms,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn set_active_version(
        &self,
        input: ActiveVersionSwitch,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<VersionRecord, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::SetActiveVersion {
                input,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn create_named_version(
        &self,
        input: CreateNamedVersion,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<VersionRecord, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::CreateNamedVersion {
                input,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn preflight_create_named_version(
        &self,
        input: CreateNamedVersion,
        token: CancellationToken,
    ) -> Result<Option<VersionRecord>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::PreflightCreateNamedVersion {
                input,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Every captured path with its content identity, for seeding a fresh
    /// files-layer manifest on workspace (re)open (deleted-while-closed
    /// files must retire against the seed, never survive an empty baseline).
    pub async fn capture_manifest_seed(
        &self,
        workspace_id: String,
        version_id: String,
    ) -> Result<Vec<CaptureManifestSeedEntry>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::CaptureManifestSeed {
                workspace_id,
                version_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Capture a secret file on the actor's single writer thread.
    pub async fn capture_secret(
        &self,
        input: CaptureSecret,
        key: SecretDataKey,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<SecretWriteResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::CaptureSecret {
                payload: Box::new((input, key)),
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Retire a captured secret path on the actor's single writer thread.
    pub async fn capture_secret_retire(
        &self,
        input: CaptureSecretRetire,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<Option<SecretMomentRecord>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::CaptureSecretRetire {
                input,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Retire a captured path on the actor's single writer thread.
    pub async fn capture_retire(
        &self,
        input: CaptureRetire,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<CaptureRetireResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::CaptureRetire {
                input,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Read one versioned text snapshot on the actor-owned connection.
    pub async fn versioned_text_read(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
        token: CancellationToken,
    ) -> Result<Option<TextSnapshot>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::VersionedTextRead {
                workspace_id,
                version_id,
                path,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn resolve_path_object(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
    ) -> Result<Option<String>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ResolvePathObject {
                workspace_id,
                version_id,
                path,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Validate and append one local Y.Doc update. Marker creation and append
    /// are separate bounded transactions with a cancellation point between.
    pub async fn ydoc_apply(
        &self,
        key: DocKey,
        content_kind: ContentKind,
        update: Vec<u8>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<AppendOutcome, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::YdocApply {
                key,
                content_kind,
                update,
                now_ms,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn ydoc_open_state(
        &self,
        workspace_id: String,
        now_ms: i64,
        drain_deferred: bool,
        expected_key: Option<DocKey>,
        version_id: String,
        path: String,
        content_kind: Option<ContentKind>,
        token: CancellationToken,
    ) -> Result<YdocOpenState, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::YdocOpenState {
                workspace_id,
                now_ms,
                drain_deferred,
                expected_key,
                version_id,
                path,
                content_kind,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Report the content kind of durable Y.Doc state whose current CRDT
    /// projection is not the materialized version snapshot.
    pub async fn ydoc_version_unsettled_content_kind(
        &self,
        workspace_id: String,
        version_id: String,
        ignored_object_ids: Vec<String>,
        token: CancellationToken,
    ) -> Result<Option<ContentKind>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::YdocVersionUnsettledContentKind {
                workspace_id,
                version_id,
                ignored_object_ids,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn ydoc_record_update(
        &self,
        key: DocKey,
        path: String,
        content_kind: ContentKind,
        regime: Regime,
        update: Vec<u8>,
        actor_origin_id: Option<String>,
        require_empty_lineage: bool,
        request_id: Option<String>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<AppendOutcome, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::YdocRecordUpdate {
                key,
                path,
                content_kind,
                regime,
                update,
                request_id,
                actor_origin_id,
                require_empty_lineage,
                now_ms,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn ydoc_settle(
        &self,
        root_dir: PathBuf,
        key: DocKey,
        path: String,
        content_kind: ContentKind,
        expected_head_sha: Option<String>,
        session_id: String,
        self_writes: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<YdocSettlement, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::YdocSettle {
                root_dir,
                key,
                path,
                content_kind,
                expected_head_sha,
                session_id,
                self_writes,
                now_ms,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn ydoc_resync(
        &self,
        key: DocKey,
        token: CancellationToken,
    ) -> Result<Vec<u8>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::YdocResync { key, token, reply })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn ydoc_close_session(
        &self,
        key: DocKey,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<Option<CloseOutcome>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::YdocCloseSession {
                key,
                now_ms,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Replay every pending materialization job (best-effort, per-job
    /// failures tolerated). Returns the number of jobs that reached disk.
    pub async fn materialize_replay_pending(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        now_ms: i64,
    ) -> Result<usize, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::MaterializeReplayPending {
                root_dir,
                workspace_id,
                now_ms,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Replay pending writes before a version fence scans the filesystem.
    /// Unlike startup replay, any attempted job failure is fatal: scanning
    /// stale disk bytes after a committed write failed to materialize could
    /// capture those bytes back over the committed head.
    pub async fn materialize_replay_pending_for_fence(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        self_writes: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
    ) -> Result<(), RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::MaterializeReplayPendingForFence {
                root_dir,
                workspace_id,
                self_writes,
                now_ms,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn conflict_list(
        &self,
        workspace_id: String,
        status: Option<String>,
        after_conflict_id: Option<String>,
        token: CancellationToken,
    ) -> Result<Vec<TextConflict>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ConflictList {
                workspace_id,
                status,
                after_conflict_id,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn conflict_open(
        &self,
        conflict: Box<TextConflict>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<bool, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ConflictOpen {
                conflict,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn conflict_resolve(
        &self,
        input: ResolveTextConflict,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<ResolveTextConflictResult, RuntimeError> {
        self.conflict_resolve_with_root(input, None, faults, token)
            .await
    }

    /// Resolve and index a text conflict with the workspace root owned by the
    /// calling session.
    pub async fn conflict_resolve_indexed(
        &self,
        input: ResolveTextConflict,
        root_dir: PathBuf,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<ResolveTextConflictResult, RuntimeError> {
        self.conflict_resolve_with_root(input, Some(root_dir), faults, token)
            .await
    }

    async fn conflict_resolve_with_root(
        &self,
        input: ResolveTextConflict,
        root_dir: Option<PathBuf>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<ResolveTextConflictResult, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ConflictResolve {
                input,
                root_dir,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn conflict_apply_replicated(
        &self,
        envelope: ReplicationEnvelope,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<ApplyOutcome<ConflictApplyResult>, RuntimeError> {
        // Keep the complete typed result on the actor boundary: callers need
        // the structured `pending_resolve`, not only its derived boolean view.
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ConflictApplyReplicated {
                envelope,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn search(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        version_id: String,
        query: String,
        limit: Option<i64>,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<Vec<SearchResult>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::Search {
                root_dir,
                workspace_id,
                version_id,
                query,
                limit,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn search_page(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        version_id: String,
        query: String,
        limit: Option<i64>,
        now_ms: i64,
        expected_generation: Option<u64>,
        after: Option<SearchResultKey>,
        token: CancellationToken,
    ) -> Result<SearchPageBatch, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::SearchPage {
                root_dir,
                workspace_id,
                version_id,
                query,
                limit,
                now_ms,
                expected_generation,
                after,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn search_query_chat_messages_granular(
        &self,
        workspace_id: String,
        query: String,
        limit: i64,
        materialized_byte_budget: usize,
    ) -> Result<GranularChatMessageSearchBatch, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::SearchQueryChatMessagesGranular {
                workspace_id,
                query,
                limit,
                materialized_byte_budget,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn ensure_search_index(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        version_id: String,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<(), RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::EnsureSearchIndex {
                root_dir,
                workspace_id,
                version_id,
                now_ms,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_channel_create(
        &self,
        workspace_id: String,
        channel_id: String,
        name: String,
        kind: ChatChannelKind,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatChannel, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatChannelCreate {
                workspace_id,
                channel_id,
                name,
                kind,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_channel_ensure_general(
        &self,
        workspace_id: String,
        channel_id: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatChannel, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatChannelEnsureGeneral {
                workspace_id,
                channel_id,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_channel_ensure_agent(
        &self,
        workspace_id: String,
        channel_id: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatChannel, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatChannelEnsureAgent {
                workspace_id,
                channel_id,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_channels_list(
        &self,
        workspace_id: String,
    ) -> Result<Vec<ChatChannelSummary>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatChannelsList {
                workspace_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_channel_find_by_slug(
        &self,
        workspace_id: String,
        slug: String,
    ) -> Result<Option<ChatChannel>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatChannelFindBySlug {
                workspace_id,
                slug,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_channel_get_wire_id(
        &self,
        workspace_id: String,
        channel_id: String,
    ) -> Result<Option<String>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatChannelGetWireId {
                workspace_id,
                channel_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_thread_start(
        &self,
        input: StartChannelThread,
        token: CancellationToken,
    ) -> Result<(ChatThread, ChatMessage), RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatThreadStart {
                input: Box::new(input),
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_thread_create(
        &self,
        input: CreateFileThread,
        token: CancellationToken,
    ) -> Result<ChatThread, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatThreadCreate {
                input: Box::new(input),
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_threads_list(
        &self,
        workspace_id: String,
    ) -> Result<Vec<ChatThread>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatThreadsList {
                workspace_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_threads_list_for_file(
        &self,
        workspace_id: String,
        object_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChatThread>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatThreadsListForFile {
                workspace_id,
                object_id,
                after,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_threads_list_for_channel(
        &self,
        workspace_id: String,
        channel_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChannelThreadSummary>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatThreadsListForChannel {
                workspace_id,
                channel_id,
                after,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_thread_find_channel_id(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<Option<String>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatThreadFindChannelId {
                workspace_id,
                thread_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_thread_get_projection(
        &self,
        workspace_id: String,
        thread_id: String,
        linked_file_access: ChatProjectionFileAccess,
    ) -> Result<ChatThreadProjection, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatThreadGetProjection {
                workspace_id,
                thread_id,
                linked_file_access,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_attachments_list_for_thread(
        &self,
        workspace_id: String,
        thread_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChatAttachment>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatAttachmentsListForThread {
                workspace_id,
                thread_id,
                after,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_attachments_list_file_mentions(
        &self,
        workspace_id: String,
        object_id: Option<String>,
        path_hint: Option<String>,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChatFileMention>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatAttachmentsListFileMentions {
                workspace_id,
                object_id,
                path_hint,
                after,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_mentions_backfill(
        &self,
        workspace_id: String,
        token: CancellationToken,
    ) -> Result<i64, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatMentionsBackfill {
                workspace_id,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_mentions_list_for_handle(
        &self,
        workspace_id: String,
        handle: String,
        unread_only: bool,
        after: Option<MentionCursor>,
        limit: i64,
    ) -> Result<Vec<ChatMention>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatMentionsListForHandle {
                workspace_id,
                handle,
                unread_only,
                after,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_record_eligible_triggers(
        &self,
        workspace_id: String,
        verified_user_id: Option<String>,
        at_ms: i64,
        token: CancellationToken,
    ) -> Result<i64, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchRecordEligibleTriggers {
                workspace_id,
                verified_user_id,
                at_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_message_send(
        &self,
        input: SendMessage,
        token: CancellationToken,
    ) -> Result<ChatMessage, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatMessageSend {
                input: Box::new(input),
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_decision_resolve(
        &self,
        input: ResolveDecision,
        token: CancellationToken,
    ) -> Result<ChatDecision, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDecisionResolve {
                input: Box::new(input),
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_decisions_list(
        &self,
        workspace_id: String,
        thread_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChatDecision>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDecisionsList {
                workspace_id,
                thread_id,
                after,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_reaction_set(
        &self,
        input: SetReaction,
        token: CancellationToken,
    ) -> Result<ChatReaction, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatReactionSet {
                input: Box::new(input),
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_reactions_list(
        &self,
        workspace_id: String,
        thread_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ChatReaction>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatReactionsList {
                workspace_id,
                thread_id,
                after,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_messages_list(
        &self,
        workspace_id: String,
        thread_id: String,
        limit: i64,
        after_message_order: Option<i64>,
    ) -> Result<ChatMessagePage, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatMessagesList {
                workspace_id,
                thread_id,
                limit,
                after_message_order,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_read_state_mark_thread_read(
        &self,
        workspace_id: String,
        thread_id: String,
        up_to_sequence: i64,
        expected_revision: Option<i64>,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatThreadReadState, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatReadStateMarkThreadRead {
                workspace_id,
                thread_id,
                up_to_sequence,
                expected_revision,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_read_state_get(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<ChatThreadReadState, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatReadStateGet {
                workspace_id,
                thread_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_read_state_list_unread_file_threads(
        &self,
        workspace_id: String,
        after_thread_id: Option<String>,
        limit: i64,
    ) -> Result<Vec<UnreadFileThread>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatReadStateListUnreadFileThreads {
                workspace_id,
                after_thread_id,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_agent_unread_threads(
        &self,
        workspace_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<AgentUnreadThreadRow>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatAgentUnreadThreads {
                workspace_id,
                after,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_agent_mark_thread_read(
        &self,
        workspace_id: String,
        thread_id: String,
        up_to_created_at_ms: i64,
        up_to_message_id: String,
        expected_revision: Option<i64>,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatAgentReadState, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatAgentMarkThreadRead {
                workspace_id,
                thread_id,
                up_to_created_at_ms,
                up_to_message_id,
                expected_revision,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_follow_set(
        &self,
        input: SetFollow,
        token: CancellationToken,
    ) -> Result<ChatFollow, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatFollowSet {
                input: Box::new(input),
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_follows_list(
        &self,
        workspace_id: String,
        owner_user_id: String,
        state: Option<String>,
    ) -> Result<Vec<ChatFollow>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatFollowsList {
                workspace_id,
                owner_user_id,
                state,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_follows_ensure_defaults(
        &self,
        workspace_id: String,
        owner_user_id: String,
        token: CancellationToken,
    ) -> Result<(), RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatFollowsEnsureDefaults {
                workspace_id,
                owner_user_id,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_bookmark_find(
        &self,
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
    ) -> Result<Option<ChatBookmark>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatBookmarkFind {
                workspace_id,
                owner_user_id,
                bookmark_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_bookmarks_list_pending(
        &self,
        workspace_id: String,
        owner_user_id: String,
        limit: i64,
        after: Option<(i64, String)>,
    ) -> Result<Vec<PendingBookmarkRow>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatBookmarksListPending {
                workspace_id,
                owner_user_id,
                limit,
                after,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_feed_mark_seen(
        &self,
        workspace_id: String,
        owner_user_id: String,
        replication_owner_user_id: Option<String>,
        head_cursor: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatFeedReadState, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatFeedMarkSeen {
                workspace_id,
                owner_user_id,
                replication_owner_user_id,
                head_cursor,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_feed_list_personal(
        &self,
        workspace_id: String,
        owner_user_id: String,
        limit: Option<i64>,
        cursor: Option<String>,
    ) -> Result<ChatFeedPage, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatFeedListPersonal {
                workspace_id,
                owner_user_id,
                limit,
                cursor,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_bookmark_save(
        &self,
        input: SaveBookmark,
        token: CancellationToken,
    ) -> Result<ChatBookmark, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatBookmarkSave {
                input: Box::new(input),
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_bookmarks_list(
        &self,
        workspace_id: String,
        owner_user_id: String,
        state: Option<String>,
    ) -> Result<Vec<ChatBookmark>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatBookmarksList {
                workspace_id,
                owner_user_id,
                state,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_bookmark_mark_ready(
        &self,
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
        generation: i64,
        projected_at_ms: i64,
        projection_object_id: Option<String>,
        projection_path: Option<String>,
        token: CancellationToken,
    ) -> Result<ChatBookmarkTransition, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatBookmarkMarkReady {
                workspace_id,
                owner_user_id,
                bookmark_id,
                generation,
                projected_at_ms,
                projection_object_id,
                projection_path,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_bookmark_archive(
        &self,
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatBookmark, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatBookmarkArchive {
                workspace_id,
                owner_user_id,
                bookmark_id,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_bookmark_mark_pending(
        &self,
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
        request_id: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatBookmark, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatBookmarkMarkPending {
                workspace_id,
                owner_user_id,
                bookmark_id,
                request_id,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_bookmark_mark_failed(
        &self,
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
        generation: i64,
        failure_reason: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatBookmarkTransition, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatBookmarkMarkFailed {
                workspace_id,
                owner_user_id,
                bookmark_id,
                generation,
                failure_reason,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_bookmark_mark_stale(
        &self,
        workspace_id: String,
        owner_user_id: String,
        bookmark_id: String,
        generation: i64,
        failure_reason: Option<String>,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ChatBookmarkTransition, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatBookmarkMarkStale {
                workspace_id,
                owner_user_id,
                bookmark_id,
                generation,
                failure_reason,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_enqueue(
        &self,
        workspace_id: String,
        trigger_message_id: String,
        thread_id: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<bool, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchEnqueue {
                workspace_id,
                trigger_message_id,
                thread_id,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_dispatch_claim_next_pending(
        &self,
        workspace_id: String,
        run_id: String,
        command: String,
        log_path: Option<String>,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<Option<DispatchClaim>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchClaimNextPending {
                workspace_id,
                run_id,
                command,
                log_path,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_list_pending(
        &self,
        workspace_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<dohc_engine_domain::DispatchRecord>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchListPending {
                workspace_id,
                after,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_open_runs(
        &self,
        workspace_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<DispatchClaim>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchOpenRuns {
                workspace_id,
                after,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_list_run_messages(
        &self,
        workspace_id: String,
        run_id: String,
        after_message_id: Option<String>,
        limit: i64,
    ) -> Result<Vec<String>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchListRunMessages {
                workspace_id,
                run_id,
                after_message_id,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_run_id_for_message(
        &self,
        workspace_id: String,
        message_id: String,
    ) -> Result<Option<String>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchRunIdForMessage {
                workspace_id,
                message_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_dispatch_run_records_for_thread(
        &self,
        workspace_id: String,
        thread_id: String,
        run_limit: Option<i64>,
        after: Option<(i64, String, String)>,
        page_limit: i64,
    ) -> Result<Vec<RunRecordLink>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchRunRecordsForThread {
                workspace_id,
                thread_id,
                run_limit,
                after,
                page_limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_get_run_record(
        &self,
        workspace_id: String,
        run_id: String,
    ) -> Result<Option<AgentRunRecord>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchGetRunRecord {
                workspace_id,
                run_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_thread_paused(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<bool, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchThreadPaused {
                workspace_id,
                thread_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_get_thread_pause_state(
        &self,
        workspace_id: String,
        thread_id: String,
    ) -> Result<Option<ThreadDispatchPause>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchGetThreadPauseState {
                workspace_id,
                thread_id,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_recent_count(
        &self,
        workspace_id: String,
        thread_id: String,
        since_ms: f64,
    ) -> Result<i64, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchRecentCount {
                workspace_id,
                thread_id,
                since_ms,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_dispatch_fail_pending_for_thread(
        &self,
        workspace_id: String,
        thread_id: String,
        reason: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<i64, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchFailPendingForThread {
                workspace_id,
                thread_id,
                reason,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_record_run_message(
        &self,
        workspace_id: String,
        message_id: String,
        run_id: String,
        token: CancellationToken,
    ) -> Result<bool, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchRecordRunMessage {
                workspace_id,
                message_id,
                run_id,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn chat_dispatch_set_thread_paused(
        &self,
        workspace_id: String,
        thread_id: String,
        paused: bool,
        reason: Option<String>,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<ThreadDispatchPause, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchSetThreadPaused {
                workspace_id,
                thread_id,
                paused,
                reason,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_mark_failure_note_posted(
        &self,
        workspace_id: String,
        run_id: String,
        token: CancellationToken,
    ) -> Result<AgentRunRecord, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchMarkFailureNotePosted {
                workspace_id,
                run_id,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_requeue_failed_trigger(
        &self,
        workspace_id: String,
        trigger_message_id: String,
        run_id: String,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<bool, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchRequeueFailedTrigger {
                workspace_id,
                trigger_message_id,
                run_id,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_list_app_quit_recoveries(
        &self,
        workspace_id: String,
        after: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<DispatchRecovery>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchListAppQuitRecoveries {
                workspace_id,
                after,
                limit,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_complete(
        &self,
        workspace_id: String,
        run_id: String,
        exit_code: i64,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<(), RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchComplete {
                workspace_id,
                run_id,
                exit_code,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_fail(
        &self,
        workspace_id: String,
        run_id: String,
        reason: String,
        exit_code: Option<i64>,
        now_ms: i64,
        token: CancellationToken,
    ) -> Result<(), RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchFail {
                workspace_id,
                run_id,
                reason,
                exit_code,
                now_ms,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn chat_dispatch_reclaim_running(
        &self,
        workspace_id: String,
        max_attempts: i64,
        now_ms: i64,
    ) -> Result<Vec<String>, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::ChatDispatchReclaimRunning {
                workspace_id,
                max_attempts,
                now_ms,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    pub async fn relay(
        &self,
        configuration: RelayConfiguration,
        operation: RelayOperation,
        leases: LeaseRegistry,
        token: CancellationToken,
    ) -> Result<RelayOperationOutcome, RuntimeError> {
        let transport = DeferredRelayTransport::default();
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        let http_transport = Arc::new(build_http_transport(configuration)?);
        loop {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            let (reply, reply_rx) = oneshot::channel();
            self.tx
                .send(Command::Relay {
                    transport: transport.clone(),
                    operation: operation.clone(),
                    leases: leases.clone(),
                    token: token.clone(),
                    reply,
                })
                .await
                .map_err(|_| RuntimeError::ActorUnavailable)?;
            let outcome = reply_rx.await.map_err(|_| RuntimeError::ActorUnavailable)?;
            match outcome {
                Err(RuntimeError::Relay(RelayError::Local(reason)))
                    if reason == RELAY_IO_PENDING =>
                {
                    let request = transport
                        .take_pending()
                        .ok_or(RuntimeError::Relay(RelayError::InvalidResponse))?;
                    let http_transport = Arc::clone(&http_transport);
                    let io_request = request.clone();
                    let task = tokio::task::spawn_blocking(move || {
                        execute_http_request(&http_transport, io_request)
                    });
                    let result = tokio::select! {
                        result = task => result
                            .map_err(|_| RuntimeError::Relay(RelayError::Partitioned))?,
                        () = token.cancelled() => return Err(RuntimeError::Cancelled),
                    };
                    transport.complete(request, result);
                }
                Ok(mut outcome) => {
                    transport.apply_progress(&mut outcome);
                    return Ok(outcome);
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// Run a long operation as a sequence of bounded units, cancellable at each
    /// between-unit boundary via `token`. Returns how many units committed.
    ///
    /// The worker checks the token BEFORE each unit's transaction; once a
    /// unit's `BEGIN IMMEDIATE` starts it always runs to COMMIT/ROLLBACK
    /// (`PORTING.md` §12) — cancellation never tears a unit, so the store holds
    /// exactly the committed prefix.
    pub async fn run_units(
        &self,
        units: Vec<CompoundWrite>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<UnitsOutcome, RuntimeError> {
        let (reply, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::RunUnits {
                units,
                faults,
                token,
                reply,
            })
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        reply_rx
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?
            .map_err(RuntimeError::Storage)
    }

    /// Run a long operation under a deadline. The units execute on the writer
    /// thread; if `deadline` elapses first, the shared `token` is cancelled
    /// (stopping the run at the next between-unit boundary) and
    /// [`RuntimeError::DeadlineExceeded`] is returned. Work already committed
    /// before the deadline stays durable — exactly-once ack semantics
    /// (`PORTING.md` §12).
    pub async fn run_units_with_deadline(
        &self,
        units: Vec<CompoundWrite>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        deadline: std::time::Duration,
    ) -> Result<UnitsOutcome, RuntimeError> {
        // The deadline bounds the WHOLE operation, including enqueue: under a
        // full command queue `send().await` can block past the deadline, so the
        // wait for queue space is inside the timed select too.
        let deadline_at = tokio::time::Instant::now() + deadline;
        let (reply, reply_rx) = oneshot::channel();

        tokio::select! {
            biased;
            sent = self.tx.send(Command::RunUnits {
                units,
                faults,
                token: token.clone(),
                reply,
            }) => sent.map_err(|_| RuntimeError::ActorUnavailable)?,
            () = tokio::time::sleep_until(deadline_at) => {
                // Never admitted; nothing was cancelled to observe.
                token.cancel();
                return Err(RuntimeError::DeadlineExceeded);
            }
        }

        tokio::select! {
            biased;
            result = reply_rx => result
                .map_err(|_| RuntimeError::ActorUnavailable)?
                .map_err(RuntimeError::Storage),
            () = tokio::time::sleep_until(deadline_at) => {
                // Deadline first: ask the run to stop at its next between-unit
                // boundary. The in-flight unit (if any) still finishes durably.
                token.cancel();
                Err(RuntimeError::DeadlineExceeded)
            }
        }
    }
}

/// Debug-only guard: the synchronous `write`/`read`/`snapshot` API uses
/// `blocking_send`/`blocking_recv`, which PANIC inside a tokio runtime (the
/// product runs on tokio). Catch the misuse cheaply in debug builds with a
/// clear message instead of an opaque tokio panic in production; use the async
/// API from within a runtime.
#[inline]
fn debug_assert_sync_context() {
    debug_assert!(
        tokio::runtime::Handle::try_current().is_err(),
        "synchronous ActorHandle API called from within a tokio runtime; use the async API (write_async/read_async/run_units)"
    );
}

struct SecretJobCoordinates {
    workspace_id: String,
    version_id: String,
    path: String,
}

fn secret_job_coordinates(
    store: &mut EngineStore,
    job: &MaterializationJob,
) -> Result<Option<SecretJobCoordinates>, RuntimeError> {
    let moment_id = job
        .job_id
        .strip_prefix("secret-mat_")
        .ok_or(DomainError::StateCorrupt {
            reason: "secret materialization job id is malformed",
        })?;
    let coordinates: Option<(String, String, String, i64, String)> = store.read_with(|conn| {
        conn.query_row(
            "SELECT workspace_id, version_id, path, moment_order, operation \
                 FROM secret_moments WHERE moment_id = ?1",
            [moment_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::corrupt_public)
    })?;
    let Some((workspace_id, version_id, path, moment_order, operation)) = coordinates else {
        // Version deletion cascades its secret moments but the generic
        // materialization ledger has no FK back to those domain rows. Treat
        // that pending job as an orphan the replay loop can retire, not as
        // corruption that bricks every future workspace open.
        return Ok(None);
    };
    let expected_operation = match job.operation {
        dohc_engine_storage::MaterializationOperation::Write => "write",
        dohc_engine_storage::MaterializationOperation::Delete => "delete",
    };
    if path != job.target_path
        || moment_order != job.target_generation
        || operation != expected_operation
    {
        return Err(DomainError::StateCorrupt {
            reason: "secret materialization job does not match its moment",
        }
        .into());
    }
    Ok(Some(SecretJobCoordinates {
        workspace_id,
        version_id,
        path,
    }))
}

fn secret_tip_exists(
    store: &EngineStore,
    coordinates: &SecretJobCoordinates,
) -> Result<bool, RuntimeError> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT 1 FROM secret_files \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
                params![
                    coordinates.workspace_id,
                    coordinates.version_id,
                    coordinates.path
                ],
                |_| Ok(()),
            )
            .optional()
            .map(|row| row.is_some())
            .map_err(StorageError::corrupt_public)
        })
        .map_err(RuntimeError::from)
}

fn secret_plaintext_for_job(
    store: &mut EngineStore,
    key: &SecretDataKey,
    coordinates: &SecretJobCoordinates,
) -> Result<Option<SecretPlaintext>, RuntimeError> {
    SecretFileStore::new(store, key)
        .materialize_secret_file(
            &coordinates.workspace_id,
            &coordinates.version_id,
            &coordinates.path,
        )
        .map_err(RuntimeError::from)
}

struct SwitchProjection {
    spec: MaterializationJobSpec,
    operation: MaterializationOperation,
    inline_content: Option<Vec<u8>>,
}

fn projection_preimage(state: &ProjectionTargetState) -> Option<Preimage> {
    match state {
        ProjectionTargetState::Absent => Some(Preimage::Absent),
        ProjectionTargetState::Text { sha256 } | ProjectionTargetState::Binary { sha256 } => {
            Some(Preimage::Present(sha256.clone()))
        }
        ProjectionTargetState::UntrackedContent | ProjectionTargetState::Unreadable => None,
    }
}

fn projection_matches(
    state: &ProjectionTargetState,
    content: &SnapshotContent,
    desired_sha256: &str,
) -> bool {
    matches!(
        (state, content),
        (
            ProjectionTargetState::Text { sha256 },
            SnapshotContent::Text { .. }
        ) if sha256 == desired_sha256
    ) || matches!(
        (state, content),
        (
            ProjectionTargetState::Binary { sha256 },
            SnapshotContent::Binary { .. }
        ) if sha256 == desired_sha256
    )
}

fn switch_projection_job_id(
    workspace_id: &str,
    version_id: &str,
    path: &str,
    operation: MaterializationOperation,
    content_sha256: &str,
    secret: bool,
) -> String {
    let operation = match operation {
        MaterializationOperation::Write => "write",
        MaterializationOperation::Delete => "delete",
    };
    let identity = format!(
        "{workspace_id}\0{version_id}\0{path}\0{operation}\0{content_sha256}\0{}",
        if secret { "secret" } else { "plain" }
    );
    let prefix = if secret {
        "version-switch-secret-mat_"
    } else {
        "version-switch-mat_"
    };
    format!("{prefix}{}", hex_sha256(identity.as_bytes()))
}

#[allow(
    clippy::too_many_arguments,
    reason = "durable projection fields remain explicit at each planner branch"
)]
fn planned_projection(
    workspace_id: &str,
    version_id: &str,
    path: String,
    operation: MaterializationOperation,
    content_sha256: String,
    preimage: Preimage,
    target_generation: i64,
    now_ms: i64,
    secret: bool,
    inline_content: Option<Vec<u8>>,
) -> SwitchProjection {
    SwitchProjection {
        spec: MaterializationJobSpec {
            job_id: switch_projection_job_id(
                workspace_id,
                version_id,
                &path,
                operation,
                &content_sha256,
                secret,
            ),
            workspace_id: workspace_id.to_owned(),
            target_path: path,
            content_sha256,
            preimage,
            target_generation,
            now_ms,
        },
        operation,
        inline_content,
    }
}

fn plan_plaintext_switch(
    store: &mut EngineStore,
    workspace_id: &str,
    target_version_id: &str,
    previous_version_id: &str,
    root_dir: &std::path::Path,
    now_ms: i64,
    token: &CancellationToken,
) -> Result<Vec<SwitchProjection>, RuntimeError> {
    let target = VersionedTextStore::new(store)
        .list_snapshots(workspace_id, target_version_id)
        .map_err(RuntimeError::from)?;
    let target_paths: HashSet<&str> = target
        .iter()
        .map(|snapshot| snapshot.path.as_str())
        .collect();
    let policy = read_engine_search_policy(root_dir);
    if policy.is_degraded() {
        return Err(DomainError::StateCorrupt {
            reason: "workspace file policy is unavailable during version switch",
        }
        .into());
    }
    let mut projections = Vec::new();
    if !policy.is_degraded() {
        for snapshot in &target {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            if !resolve_effective_policy(
                &snapshot.path,
                policy.files_policy.as_deref(),
                policy.visibility_policy.as_deref(),
            )
            .tracked
            {
                continue;
            }
            let state =
                probe_projection_target(root_dir, &snapshot.path, ProjectionTargetKind::Plaintext);
            let Some(preimage) = projection_preimage(&state) else {
                continue;
            };
            let (desired_sha256, inline_content) = match &snapshot.content {
                SnapshotContent::Text { text } => {
                    (hex_sha256(text.as_bytes()), Some(text.as_bytes().to_vec()))
                }
                SnapshotContent::Binary { sha256 } => (sha256.clone(), None),
            };
            if projection_matches(&state, &snapshot.content, &desired_sha256) {
                continue;
            }
            projections.push(planned_projection(
                workspace_id,
                target_version_id,
                snapshot.path.clone(),
                MaterializationOperation::Write,
                desired_sha256,
                preimage,
                snapshot.updated_at_ms,
                now_ms,
                false,
                inline_content,
            ));
        }
    }
    let previous = VersionedTextStore::new(store)
        .list_snapshots(workspace_id, previous_version_id)
        .map_err(RuntimeError::from)?;
    if !policy.is_degraded() {
        let empty_sha = hex_sha256(&[]);
        for snapshot in previous {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            if target_paths.contains(snapshot.path.as_str())
                || !resolve_effective_policy(
                    &snapshot.path,
                    policy.files_policy.as_deref(),
                    policy.visibility_policy.as_deref(),
                )
                .tracked
            {
                continue;
            }
            let state =
                probe_projection_target(root_dir, &snapshot.path, ProjectionTargetKind::Plaintext);
            let Some(preimage @ Preimage::Present(_)) = projection_preimage(&state) else {
                continue;
            };
            projections.push(planned_projection(
                workspace_id,
                target_version_id,
                snapshot.path,
                MaterializationOperation::Delete,
                empty_sha.clone(),
                preimage,
                snapshot.updated_at_ms,
                now_ms,
                false,
                Some(Vec::new()),
            ));
        }
    }
    Ok(projections)
}

fn secret_ciphertext_sha(
    store: &EngineStore,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<String, RuntimeError> {
    let ciphertext_base64: Option<String> = store.read_with(|connection| {
        connection
            .query_row(
                "SELECT ciphertext_base64 FROM secret_files \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
                params![workspace_id, version_id, path],
                |row| row.get(0),
            )
            .optional()
            .map_err(StorageError::corrupt_public)
    })?;
    let ciphertext_base64 = ciphertext_base64.ok_or(DomainError::StateCorrupt {
        reason: "secret tip has no ciphertext identity",
    })?;
    let ciphertext = dohc_engine_crypto::base64::forgiving_decode(&ciphertext_base64);
    Ok(hex_sha256(&ciphertext))
}

fn load_projection_secret_key(root_dir: &std::path::Path) -> Result<SecretDataKey, RuntimeError> {
    load_key_file(root_dir)
        .map_err(DomainError::from)?
        .ok_or_else(|| {
            RuntimeError::from(DomainError::StateCorrupt {
                reason: "workspace secret key is unavailable",
            })
        })
}

#[allow(
    clippy::too_many_arguments,
    reason = "the planner keeps key custody and switch coordinates explicit"
)]
fn plan_secret_switch(
    store: &mut EngineStore,
    workspace_id: &str,
    target_version_id: &str,
    previous_version_id: &str,
    root_dir: &std::path::Path,
    now_ms: i64,
    token: &CancellationToken,
    secret_key: &mut Option<SecretDataKey>,
) -> Result<Vec<SwitchProjection>, RuntimeError> {
    let target = list_secret_files_keyless(store, workspace_id, target_version_id)?;
    let target_paths: HashSet<&str> = target.iter().map(|stat| stat.path.as_str()).collect();
    let mut projections = Vec::new();
    for stat in &target {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        let state = probe_projection_target(root_dir, &stat.path, ProjectionTargetKind::Secret);
        let Some(preimage) = projection_preimage(&state) else {
            continue;
        };
        if secret_key.is_none() {
            *secret_key = Some(load_projection_secret_key(root_dir)?);
        }
        let plaintext =
            SecretFileStore::new(store, secret_key.as_ref().expect("secret key loaded"))
                .materialize_secret_file(workspace_id, target_version_id, &stat.path)?
                .ok_or(DomainError::StateCorrupt {
                    reason: "secret tip could not be materialized",
                })?;
        let desired_plaintext_sha = hex_sha256(plaintext.as_bytes());
        let already_equal = matches!(
            &state,
            ProjectionTargetState::Text { sha256 } if sha256 == &desired_plaintext_sha
        );
        drop(plaintext);
        if already_equal {
            continue;
        }
        let ciphertext_sha =
            secret_ciphertext_sha(store, workspace_id, target_version_id, &stat.path)?;
        projections.push(planned_projection(
            workspace_id,
            target_version_id,
            stat.path.clone(),
            MaterializationOperation::Write,
            ciphertext_sha,
            preimage,
            stat.updated_at_ms,
            now_ms,
            true,
            None,
        ));
    }
    let previous = list_secret_files_keyless(store, workspace_id, previous_version_id)?;
    let empty_sha = hex_sha256(&[]);
    for stat in previous {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if target_paths.contains(stat.path.as_str()) {
            continue;
        }
        let state = probe_projection_target(root_dir, &stat.path, ProjectionTargetKind::Secret);
        let Some(preimage @ Preimage::Present(_)) = projection_preimage(&state) else {
            continue;
        };
        projections.push(planned_projection(
            workspace_id,
            target_version_id,
            stat.path,
            MaterializationOperation::Delete,
            empty_sha.clone(),
            preimage,
            stat.updated_at_ms,
            now_ms,
            true,
            Some(Vec::new()),
        ));
    }
    Ok(projections)
}

fn active_projection_coordinates(
    store: &EngineStore,
) -> Result<Vec<(String, String)>, RuntimeError> {
    store
        .read_with(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT workspace_id, version_id FROM active_versions ORDER BY workspace_id",
                )
                .map_err(StorageError::corrupt_public)?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(StorageError::corrupt_public)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::corrupt_public)
        })
        .map_err(RuntimeError::from)
}

fn switch_projection_matches_active(
    store: &EngineStore,
    job: &MaterializationJob,
    secret: bool,
) -> Result<Option<SecretJobCoordinates>, RuntimeError> {
    for (workspace_id, version_id) in active_projection_coordinates(store)? {
        let expected_job_id = switch_projection_job_id(
            &workspace_id,
            &version_id,
            &job.target_path,
            job.operation,
            &job.content_sha256,
            secret,
        );
        if job.job_id != expected_job_id {
            continue;
        }
        let matches = if secret {
            let ciphertext_base64: Option<String> = store.read_with(|connection| {
                connection
                    .query_row(
                        "SELECT ciphertext_base64 FROM secret_files \
                         WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
                        params![workspace_id, version_id, job.target_path],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(StorageError::corrupt_public)
            })?;
            let tip_sha = ciphertext_base64
                .map(|encoded| hex_sha256(&dohc_engine_crypto::base64::forgiving_decode(&encoded)));
            match job.operation {
                MaterializationOperation::Write => tip_sha.as_deref() == Some(&job.content_sha256),
                MaterializationOperation::Delete => tip_sha.is_none(),
            }
        } else {
            let tip_sha: Option<String> = store.read_with(|connection| {
                connection
                    .query_row(
                        "SELECT CASE COALESCE(content_kind, 'text') \
                                  WHEN 'binary' THEN binary_sha256 ELSE blob_sha256 END \
                         FROM snapshots \
                         WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3",
                        params![workspace_id, version_id, job.target_path],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(StorageError::corrupt_public)
            })?;
            match job.operation {
                MaterializationOperation::Write => tip_sha.as_deref() == Some(&job.content_sha256),
                MaterializationOperation::Delete => tip_sha.is_none(),
            }
        };
        if matches {
            return Ok(Some(SecretJobCoordinates {
                workspace_id,
                version_id,
                path: job.target_path.clone(),
            }));
        }
        return Ok(None);
    }
    Ok(None)
}

struct MaterializationReplaySummary {
    completed: usize,
    failed: usize,
    selected_seen: usize,
}

#[derive(Clone, Copy)]
struct MaterializationReplayScope<'a> {
    workspace_id: &'a str,
    self_writes: Option<&'a dyn SelfWriteRecorder>,
}

const ROLLBACK_RESTORE_PREFIX: &str = "rollback-restore_";

fn rollback_restore_identity(job_id: &str) -> Option<&str> {
    if job_id.starts_with(ROLLBACK_RESTORE_PREFIX) {
        return Some(job_id);
    }
    job_id
        .strip_prefix("binary-rename-0-write-mat_")
        .or_else(|| job_id.strip_prefix("binary-rename-1-delete-mat_"))
        .filter(|id| id.starts_with(ROLLBACK_RESTORE_PREFIX))
}

fn legacy_rollback_restore_is_corroborated(
    store: &EngineStore,
    rollback_id: &str,
) -> Result<bool, RuntimeError> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT 1 FROM moments WHERE moment_id = ?1 LIMIT 1",
                [rollback_id],
                |_| Ok(()),
            )
            .optional()
            .map(|ordinary_moment| ordinary_moment.is_none())
            .map_err(StorageError::corrupt_public)
        })
        .map_err(RuntimeError::from)
}

fn rollback_write_matches_active_snapshot(
    store: &EngineStore,
    write_job: &MaterializationJob,
    workspace_id: &str,
    version_id: Option<&str>,
    additionally_absent_path: Option<&str>,
) -> Result<bool, RuntimeError> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT 1 \
                 FROM versioned_workspaces w \
                 JOIN path_aliases a ON a.workspace_id = w.workspace_id \
                   AND a.version_id = COALESCE( \
                       (SELECT av.version_id FROM active_versions av \
                        WHERE av.workspace_id = w.workspace_id), \
                       w.main_version_id) \
                   AND a.path = ?1 \
                 JOIN snapshots s ON s.workspace_id = a.workspace_id \
                   AND s.version_id = a.version_id AND s.object_id = a.object_id \
                 WHERE w.workspace_id = ?4 \
                   AND (?5 IS NULL OR a.version_id = ?5) \
                   AND CASE COALESCE(s.content_kind, 'text') \
                         WHEN 'binary' THEN s.binary_sha256 ELSE s.blob_sha256 END = ?2 \
                   AND (?3 IS NULL OR NOT EXISTS ( \
                       SELECT 1 FROM path_aliases occupied \
                       WHERE occupied.workspace_id = a.workspace_id \
                         AND occupied.version_id = a.version_id \
                         AND occupied.path = ?3)) \
                 LIMIT 1",
                params![
                    write_job.target_path,
                    write_job.content_sha256,
                    additionally_absent_path,
                    workspace_id,
                    version_id
                ],
                |_| Ok(()),
            )
            .optional()
            .map(|match_| match_.is_some())
            .map_err(StorageError::corrupt_public)
        })
        .map_err(RuntimeError::from)
}

fn rollback_delete_matches_active_absence(
    store: &EngineStore,
    delete_job: &MaterializationJob,
    workspace_id: &str,
    version_id: Option<&str>,
) -> Result<bool, RuntimeError> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT 1 FROM versioned_workspaces w \
                 WHERE w.workspace_id = ?2 \
                   AND (?3 IS NULL OR COALESCE( \
                       (SELECT av.version_id FROM active_versions av \
                        WHERE av.workspace_id = w.workspace_id), \
                       w.main_version_id) = ?3) \
                   AND NOT EXISTS ( \
                     SELECT 1 FROM path_aliases a \
                     WHERE a.workspace_id = w.workspace_id \
                       AND a.version_id = COALESCE( \
                           (SELECT av.version_id FROM active_versions av \
                            WHERE av.workspace_id = w.workspace_id), \
                           w.main_version_id) \
                       AND a.path = ?1) \
                 LIMIT 1",
                params![delete_job.target_path, workspace_id, version_id],
                |_| Ok(()),
            )
            .optional()
            .map(|match_| match_.is_some())
            .map_err(StorageError::corrupt_public)
        })
        .map_err(RuntimeError::from)
}

fn rollback_job_matches_active(
    store: &EngineStore,
    replay_workspace_id: &str,
    job: &MaterializationJob,
) -> Result<Option<bool>, RuntimeError> {
    let Some(rollback_id) = rollback_restore_identity(&job.job_id) else {
        return Ok(None);
    };
    let version_id = match decode_binary_rollback_job_identity(rollback_id) {
        Some((workspace_id, version_id, _)) => {
            if workspace_id != replay_workspace_id {
                return Ok(Some(false));
            }
            Some(version_id)
        }
        None if rollback_id.contains('\u{1f}') => return Ok(Some(false)),
        None => {
            if !legacy_rollback_restore_is_corroborated(store, rollback_id)? {
                return Ok(None);
            }
            None
        }
    };
    if job.job_id.starts_with("binary-rename-1-delete-mat_") {
        let write_id = binary_rename_write_job_id(rollback_id);
        let Some(write_job) = store.load_materialization_job(&write_id)? else {
            return Ok(Some(false));
        };
        return rollback_write_matches_active_snapshot(
            store,
            &write_job,
            replay_workspace_id,
            version_id,
            Some(&job.target_path),
        )
        .map(Some);
    }
    match job.operation {
        MaterializationOperation::Write => rollback_write_matches_active_snapshot(
            store,
            job,
            replay_workspace_id,
            version_id,
            None,
        ),
        MaterializationOperation::Delete => {
            rollback_delete_matches_active_absence(store, job, replay_workspace_id, version_id)
        }
    }
    .map(Some)
}

fn replay_pending_materializations(
    store: &mut EngineStore,
    root_dir: &std::path::Path,
    scope: MaterializationReplayScope<'_>,
    now_ms: i64,
    faults: &dyn FaultInjector,
    selected: Option<&HashSet<String>>,
    superseded_after_projection_is_drained: bool,
) -> Result<MaterializationReplaySummary, RuntimeError> {
    let jobs = store.list_pending_materialization_jobs()?;
    let mut summary = MaterializationReplaySummary {
        completed: 0,
        failed: 0,
        selected_seen: 0,
    };
    let mut secret_key: Option<SecretDataKey> = None;
    for job in jobs {
        if selected.is_some_and(|selected| !selected.contains(&job.job_id)) {
            continue;
        }
        // Empty is the migration sentinel for a pre-coordinate row. Those
        // intents were globally replayable before workspace scoping existed,
        // so preserve that behavior until one workspace drains them.
        if !job.workspace_id.is_empty() && job.workspace_id != scope.workspace_id {
            continue;
        }
        summary.selected_seen += usize::from(selected.is_some());
        let switch_secret = job.job_id.starts_with("version-switch-secret-mat_");
        let ordinary_secret = job.job_id.starts_with("secret-mat_");
        if switch_secret || ordinary_secret {
            let coordinates = if switch_secret {
                match switch_projection_matches_active(store, &job, true)? {
                    Some(coordinates) => coordinates,
                    None => {
                        store.mark_materialization_complete(&job.job_id, now_ms)?;
                        if selected.is_some() {
                            summary.failed += 1;
                        }
                        continue;
                    }
                }
            } else {
                let Some(coordinates) = secret_job_coordinates(store, &job)? else {
                    store.mark_materialization_complete(&job.job_id, now_ms)?;
                    continue;
                };
                let active_version_id = VersionedTextStore::new(store)
                    .get_active_version(&coordinates.workspace_id)?
                    .version_id;
                if coordinates.version_id != active_version_id {
                    continue;
                }
                let tip_present = secret_tip_exists(store, &coordinates)?;
                match (job.operation, tip_present) {
                    (MaterializationOperation::Write, false)
                    | (MaterializationOperation::Delete, true) => {
                        store.mark_materialization_complete(&job.job_id, now_ms)?;
                        continue;
                    }
                    (MaterializationOperation::Delete, false)
                    | (MaterializationOperation::Write, true) => {}
                }
                coordinates
            };
            if job.operation == MaterializationOperation::Delete {
                match materialize_secret_delete_one(
                    store,
                    root_dir,
                    &job,
                    DurabilityPolicy::per_os(),
                    now_ms,
                    faults,
                ) {
                    Ok(JobOutcome::Completed | JobOutcome::AlreadyMaterialized) => {
                        summary.completed += 1;
                    }
                    Ok(
                        JobOutcome::Conflict
                        | JobOutcome::Superseded
                        | JobOutcome::Blocked
                        | JobOutcome::Crashed(_),
                    )
                    | Err(_) => summary.failed += 1,
                }
                continue;
            }
            if secret_key.is_none() {
                let Ok(Some(key)) = load_key_file(root_dir) else {
                    summary.failed += 1;
                    continue;
                };
                secret_key = Some(key);
            }
            let plaintext = match secret_plaintext_for_job(
                store,
                secret_key.as_ref().expect("secret key loaded"),
                &coordinates,
            ) {
                Ok(Some(plaintext)) => plaintext,
                Ok(None) => {
                    store.mark_materialization_complete(&job.job_id, now_ms)?;
                    continue;
                }
                Err(_) => {
                    summary.failed += 1;
                    continue;
                }
            };
            let plaintext_sha = hex_sha256(plaintext.as_bytes());
            if let Some(self_writes) = scope.self_writes {
                self_writes.record(scope.workspace_id, &job.target_path, &plaintext_sha);
            }
            let outcome = materialize_secret_one(
                store,
                root_dir,
                &job,
                plaintext.as_bytes(),
                DurabilityPolicy::per_os(),
                &StdReplacer,
                &StdBackoff,
                now_ms,
                faults,
            );
            match outcome {
                Ok(JobOutcome::Completed | JobOutcome::AlreadyMaterialized) => {
                    summary.completed += 1;
                }
                Ok(
                    JobOutcome::Conflict
                    | JobOutcome::Superseded
                    | JobOutcome::Blocked
                    | JobOutcome::Crashed(_),
                )
                | Err(_) => {
                    if let Some(self_writes) = scope.self_writes {
                        self_writes.retract(scope.workspace_id, &job.target_path, &plaintext_sha);
                    }
                    summary.failed += 1;
                }
            }
            continue;
        }
        if job.job_id.starts_with("version-switch-mat_")
            && switch_projection_matches_active(store, &job, false)?.is_none()
        {
            store.mark_materialization_complete(&job.job_id, now_ms)?;
            if selected.is_some() {
                summary.failed += 1;
            }
            continue;
        }
        if matches!(
            rollback_job_matches_active(store, scope.workspace_id, &job)?,
            Some(false)
        ) {
            continue;
        }
        if let Some(moment_id) = job.job_id.strip_prefix("binary-rename-1-delete-mat_") {
            let write_job_id = binary_rename_write_job_id(moment_id);
            match store
                .load_materialization_job(&write_job_id)?
                .map(|write_job| write_job.status)
            {
                Some(JobStatus::Complete) => {}
                Some(JobStatus::Conflict) => {
                    store.mark_materialization_conflict(&job.job_id, now_ms)?;
                    summary.failed += 1;
                    continue;
                }
                Some(JobStatus::Pending) | None => {
                    if selected.is_some() {
                        summary.failed += 1;
                    }
                    continue;
                }
            }
        }
        let outcome = if let Some(self_writes) = scope.self_writes {
            let (materialized, reported) = materialize_pending_job(
                store,
                root_dir,
                scope.workspace_id,
                &job,
                self_writes,
                now_ms,
                faults,
            );
            if materialized {
                Ok(JobOutcome::Completed)
            } else {
                Ok(match reported {
                    PostCommitMaterializeOutcome::Conflict => JobOutcome::Conflict,
                    PostCommitMaterializeOutcome::Superseded => JobOutcome::Superseded,
                    PostCommitMaterializeOutcome::Applied
                    | PostCommitMaterializeOutcome::Skipped
                    | PostCommitMaterializeOutcome::Error => {
                        JobOutcome::Crashed(FaultPoint::MaterializeAfterJobCommit)
                    }
                })
            }
        } else {
            materialize_one(
                store,
                root_dir,
                &job,
                DurabilityPolicy::per_os(),
                &StdReplacer,
                &StdBackoff,
                now_ms,
                faults,
            )
            .map_err(RuntimeError::from)
        };
        match outcome {
            Ok(JobOutcome::Completed | JobOutcome::AlreadyMaterialized) => {
                summary.completed += 1;
            }
            Ok(JobOutcome::Blocked) => summary.failed += 1,
            Ok(JobOutcome::Superseded) if superseded_after_projection_is_drained => {
                summary.completed += 1;
            }
            Ok(JobOutcome::Conflict | JobOutcome::Superseded) => {
                summary.failed += 1;
                if let Some(moment_id) = job.job_id.strip_prefix("ydoc-mat_") {
                    let coords: Option<(String, String, String)> =
                        store.read_with(|connection| {
                            connection
                                .query_row(
                                    "SELECT workspace_id, version_id, object_id \
                                 FROM moments WHERE moment_id = ?1",
                                    [moment_id],
                                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                                )
                                .optional()
                                .map_err(StorageError::corrupt_public)
                        })?;
                    if let Some((workspace_id, version_id, object_id)) = coords {
                        store.write_with(&NoFaults, |transaction| {
                            transaction
                                .execute(
                                    "UPDATE ydoc_docs SET last_settled_sha = NULL, updated_at_ms = ?4 \
                                     WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                                    params![workspace_id, version_id, object_id, now_ms],
                                )
                                .map_err(StorageError::persist_public)?;
                            Ok::<_, StorageError>(())
                        })?;
                    }
                }
            }
            Ok(JobOutcome::Crashed(_)) | Err(_) => summary.failed += 1,
        }
    }
    Ok(summary)
}

#[allow(
    clippy::too_many_arguments,
    reason = "projection coordinates, disk suppression, faults, and cancellation are independent"
)]
fn reconcile_active_plaintext_projection_on_store(
    store: &mut EngineStore,
    workspace_id: &str,
    active_version_id: &str,
    inactive_version_id: &str,
    root_dir: &std::path::Path,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<(), RuntimeError> {
    let projections = plan_plaintext_switch(
        store,
        workspace_id,
        active_version_id,
        inactive_version_id,
        root_dir,
        now_ms,
        token,
    )?;
    if projections.is_empty() {
        return Ok(());
    }
    let outcome = store.write_with(faults, |tx| {
        for projection in &projections {
            if let Some(content) = projection.inline_content.as_deref() {
                let stored_sha = put_binary_blob(tx, content)?;
                if stored_sha != projection.spec.content_sha256 {
                    return Err(StorageError::corrupt_public(rusqlite::Error::InvalidQuery));
                }
            }
            upsert_projection_job(tx, &projection.spec, projection.operation)?;
        }
        Ok::<_, StorageError>(())
    })?;
    if matches!(outcome, TxnOutcome::Crashed { .. }) {
        return Err(RuntimeError::OperationCrashed);
    }
    let selected: HashSet<String> = projections
        .iter()
        .map(|projection| projection.spec.job_id.clone())
        .collect();
    let replay = replay_pending_materializations(
        store,
        root_dir,
        MaterializationReplayScope {
            workspace_id,
            self_writes: Some(self_writes),
        },
        now_ms,
        faults,
        Some(&selected),
        false,
    )?;
    let failed_jobs = replay.failed + selected.len().saturating_sub(replay.selected_seen);
    if failed_jobs > 0 {
        return Err(RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs });
    }
    Ok(())
}

#[allow(
    clippy::too_many_arguments,
    reason = "switch ordering, disk root, suppression, faults, and cancellation are independent"
)]
fn switch_active_version_on_store(
    store: &mut EngineStore,
    workspace_id: &str,
    version_id: &str,
    root_dir: &std::path::Path,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<VersionRecord, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let previous = VersionedTextStore::new(store).get_active_version(workspace_id)?;
    let target = VersionedTextStore::new(store)
        .list_versions(workspace_id)?
        .into_iter()
        .find(|version| version.version_id == version_id)
        .ok_or(DomainError::VersionNotFound)?;
    if previous.version_id == version_id {
        return Ok(target);
    }
    let mut secret_key = None;
    let mut projections = plan_plaintext_switch(
        store,
        workspace_id,
        version_id,
        &previous.version_id,
        root_dir,
        now_ms,
        token,
    )?;
    projections.extend(plan_secret_switch(
        store,
        workspace_id,
        version_id,
        &previous.version_id,
        root_dir,
        now_ms,
        token,
        &mut secret_key,
    )?);
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let outcome = store.write_with(faults, |tx| {
        tx.execute(
            "INSERT INTO active_versions (workspace_id, version_id) VALUES (?1, ?2) \
             ON CONFLICT(workspace_id) DO UPDATE SET version_id = excluded.version_id",
            params![workspace_id, version_id],
        )
        .map_err(StorageError::persist_public)?;
        for projection in &projections {
            if let Some(content) = projection.inline_content.as_deref() {
                let stored_sha = put_binary_blob(tx, content)?;
                if stored_sha != projection.spec.content_sha256 {
                    return Err(StorageError::corrupt_public(rusqlite::Error::InvalidQuery));
                }
            }
            upsert_projection_job(tx, &projection.spec, projection.operation)?;
        }
        Ok::<_, StorageError>(())
    })?;
    if matches!(outcome, TxnOutcome::Crashed { .. }) {
        return Err(RuntimeError::OperationCrashed);
    }
    drop(secret_key);
    let selected: HashSet<String> = projections
        .iter()
        .map(|projection| projection.spec.job_id.clone())
        .collect();
    let replay = replay_pending_materializations(
        store,
        root_dir,
        MaterializationReplayScope {
            workspace_id,
            self_writes: Some(self_writes),
        },
        now_ms,
        faults,
        Some(&selected),
        false,
    )?;
    let failed_jobs = replay.failed + selected.len().saturating_sub(replay.selected_seen);
    if failed_jobs > 0 {
        return Err(RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs });
    }

    // Rollbacks against inactive versions intentionally leave their inverse
    // disk intents pending. Once that version becomes active, drain every
    // restore whose desired state now matches the active snapshots. Run this
    // after switch projections: a projection may already establish the same
    // bytes, in which case the restore completes idempotently instead of
    // conflicting with the projection's disk preimage.
    let mut rollback_restores = HashSet::new();
    for job in store.list_pending_materialization_jobs()? {
        if matches!(
            rollback_job_matches_active(store, workspace_id, &job)?,
            Some(true)
        ) {
            rollback_restores.insert(job.job_id);
        }
    }
    if !rollback_restores.is_empty() {
        let replay = replay_pending_materializations(
            store,
            root_dir,
            MaterializationReplayScope {
                workspace_id,
                self_writes: Some(self_writes),
            },
            now_ms,
            faults,
            Some(&rollback_restores),
            true,
        )?;
        let failed_jobs =
            replay.failed + rollback_restores.len().saturating_sub(replay.selected_seen);
        if failed_jobs > 0 {
            return Err(RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs });
        }
    }
    Ok(target)
}

fn build_http_transport(
    configuration: RelayConfiguration,
) -> Result<HttpRelayTransport, RelayError> {
    #[cfg(debug_assertions)]
    if configuration.allow_insecure_loopback_for_tests {
        HttpRelayTransport::new_insecure_loopback_for_tests(
            configuration.base_url,
            configuration.bearer_token,
        )
    } else {
        HttpRelayTransport::new(configuration.base_url, configuration.bearer_token)
    }
    #[cfg(not(debug_assertions))]
    {
        HttpRelayTransport::new(configuration.base_url, configuration.bearer_token)
    }
}

fn execute_http_request(
    transport: &HttpRelayTransport,
    request: RelayIoRequest,
) -> Result<RelayIoResponse, RelayError> {
    match request {
        RelayIoRequest::Push(request) => transport.push(request).map(RelayIoResponse::Push),
        RelayIoRequest::Pull(request) => transport.pull(request).map(RelayIoResponse::Pull),
        RelayIoRequest::Probe(request) => transport.probe(request).map(RelayIoResponse::Probe),
        RelayIoRequest::Claim(request) => transport
            .claim_workspace(request)
            .map(RelayIoResponse::Claim),
        RelayIoRequest::RotateEpoch(request) => transport
            .rotate_epoch(request)
            .map(RelayIoResponse::RotateEpoch),
        RelayIoRequest::BlobsHave(request) => transport
            .blobs_have(request)
            .map(RelayIoResponse::BlobsHave),
        RelayIoRequest::UploadBlob(request) => transport
            .upload_blob(request)
            .map(|()| RelayIoResponse::UploadBlob),
        RelayIoRequest::DownloadBlob(request) => transport
            .download_blob(request)
            .map(RelayIoResponse::DownloadBlob),
        RelayIoRequest::UploadKeyEnvelope(request) => transport
            .upload_key_envelope(request)
            .map(RelayIoResponse::UploadKeyEnvelope),
        RelayIoRequest::DownloadKeyEnvelope(request) => transport
            .download_key_envelope(request)
            .map(RelayIoResponse::DownloadKeyEnvelope),
        RelayIoRequest::SharedChannelPull(request) => transport
            .shared_channel_pull(request)
            .map(RelayIoResponse::SharedChannelPull),
        RelayIoRequest::SharedChannelPush(request) => transport
            .shared_channel_push(request)
            .map(RelayIoResponse::SharedChannelPush),
        RelayIoRequest::ShareViewPull(request) => transport
            .share_view_pull(request)
            .map(RelayIoResponse::ShareViewPull),
        RelayIoRequest::ShareBlob(request) => transport
            .share_blob(request)
            .map(RelayIoResponse::ShareBlob),
    }
}

fn execute_relay_operation(
    store: &mut EngineStore,
    transport: DeferredRelayTransport,
    operation: RelayOperation,
    leases: &LeaseRegistry,
) -> Result<RelayOperationOutcome, RuntimeError> {
    let client = RelaySyncClient::new(transport);
    match operation {
        RelayOperation::Push { workspace_id } => client
            .push_workspace(store, &workspace_id, &NoFaults)
            .map(RelayOperationOutcome::Sync)
            .map_err(RuntimeError::from),
        RelayOperation::Pull { workspace_id } => client
            .pull_chat_workspace(store, &workspace_id, &NoFaults, leases)
            .map(RelayOperationOutcome::Sync)
            .map_err(RuntimeError::from),
        RelayOperation::CommitCursor {
            workspace_id,
            cursor,
        } => match client.commit_pull_cursor(store, &workspace_id, &cursor, &NoFaults)? {
            TxnOutcome::Committed(()) => Ok(RelayOperationOutcome::CursorCommitted),
            TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
        },
        RelayOperation::Probe { workspace_id } => {
            let identity = read_sync_identity(store, &workspace_id)?
                .ok_or(dohc_engine_sync::RelayError::InvalidResponse)?;
            client
                .probe(ProbeRequest {
                    workspace_id,
                    replication_epoch: identity.replication_epoch,
                    stream_identity: identity.stream_identity,
                })
                .map(|response| RelayOperationOutcome::Probe(response.has_content))
                .map_err(RuntimeError::from)
        }
        RelayOperation::Claim { workspace_id } => {
            let identity = read_sync_identity(store, &workspace_id)?
                .ok_or(dohc_engine_sync::RelayError::InvalidResponse)?;
            client.claim_workspace(ClaimRequest {
                workspace_id,
                replication_epoch: identity.replication_epoch,
                stream_identity: identity.stream_identity,
            })?;
            Ok(RelayOperationOutcome::Claimed)
        }
        RelayOperation::RecoverOrigin {
            workspace_id,
            new_origin_id,
        } => client
            .recover_origin(store, &workspace_id, &new_origin_id, &NoFaults)
            .map(RelayOperationOutcome::Recovered)
            .map_err(RuntimeError::from),
        RelayOperation::UploadKeyEnvelope {
            workspace_id,
            envelope_json,
            if_match,
        } => {
            let identity = read_sync_identity(store, &workspace_id)?
                .ok_or(dohc_engine_sync::RelayError::InvalidResponse)?;
            client
                .upload_key_envelope(KeyEnvelopeRequest {
                    workspace_id,
                    replication_epoch: identity.replication_epoch,
                    stream_identity: identity.stream_identity,
                    envelope_json,
                    if_match,
                })
                .map(|response| RelayOperationOutcome::KeyEnvelopeUploaded {
                    etag: response.etag,
                })
                .map_err(RuntimeError::from)
        }
        RelayOperation::DownloadKeyEnvelope { workspace_id } => {
            let identity = read_sync_identity(store, &workspace_id)?
                .ok_or(dohc_engine_sync::RelayError::InvalidResponse)?;
            client
                .download_key_envelope(KeyEnvelopeDownloadRequest {
                    workspace_id,
                    replication_epoch: identity.replication_epoch,
                    stream_identity: identity.stream_identity,
                })
                .map(|response| RelayOperationOutcome::KeyEnvelopeDownloaded {
                    envelope_json: response.envelope_json,
                    etag: response.etag,
                })
                .map_err(RuntimeError::from)
        }
        RelayOperation::PullSharedChannel {
            workspace_id,
            share_id,
            channel_wire_id,
        } => client
            .pull_shared_channel(store, &workspace_id, &share_id, &channel_wire_id, &NoFaults)
            .map(RelayOperationOutcome::SharedChannelPulled)
            .map_err(RuntimeError::from),
        RelayOperation::PushSharedChannel {
            workspace_id,
            share_id,
            channel_wire_id,
        } => client
            .push_shared_channel(store, &workspace_id, &share_id, &channel_wire_id, &NoFaults)
            .map(RelayOperationOutcome::SharedChannelPushed)
            .map_err(RuntimeError::from),
        RelayOperation::PullShareView {
            workspace_id,
            share_id,
        } => client
            .pull_share_view(store, &workspace_id, &share_id, &NoFaults)
            .map(RelayOperationOutcome::ShareViewPulled)
            .map_err(RuntimeError::from),
        RelayOperation::CommitShareViewCursor {
            workspace_id,
            cursor,
        } => match client.commit_share_view_cursor(store, &workspace_id, &cursor, &NoFaults)? {
            TxnOutcome::Committed(()) => Ok(RelayOperationOutcome::CursorCommitted),
            TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
        },
    }
}

fn worker_main(
    db_path: PathBuf,
    now_ms: i64,
    read_only: bool,
    mut rx: mpsc::Receiver<Command>,
    state: Arc<AtomicU8>,
    startup_tx: std::sync::mpsc::SyncSender<Result<(), StorageError>>,
) {
    // Publish Closed on ANY exit — normal return OR a panic unwind (e.g. a
    // panicking fault injector). Declared before `store` so `store` (and its
    // connection) drops first, then this guard publishes Closed: a reader that
    // observes Closed is guaranteed the writer handle is already gone.
    struct ClosedGuard(Arc<AtomicU8>);
    impl Drop for ClosedGuard {
        fn drop(&mut self) {
            self.0
                .store(LifecycleState::Closed.as_u8(), Ordering::Release);
        }
    }
    let _closed_guard = ClosedGuard(Arc::clone(&state));

    let mut store = match if read_only {
        EngineStore::open_read_only(&db_path)
    } else {
        EngineStore::open(&db_path, now_ms)
    } {
        Ok(store) => store,
        Err(err) => {
            let _ = startup_tx.send(Err(err));
            return;
        }
    };
    // Publish Ready *before* acking the open, so a caller that observes the
    // successful open also observes Ready.
    state.store(LifecycleState::Ready.as_u8(), Ordering::Release);
    if startup_tx.send(Ok(())).is_err() {
        // The spawner unwound before the actor was built; nothing to serve.
        return;
    }
    drop(startup_tx);

    // Blocking recv on the tokio channel keeps the SQLite work on THIS
    // dedicated thread, off the async runtime. `blocking_recv` returns `None`
    // once every sender is dropped.
    while let Some(cmd) = rx.blocking_recv() {
        match cmd {
            Command::Write {
                write,
                faults,
                reply,
            } => {
                let outcome = store.commit_compound(&write, faults.as_ref());
                let _ = reply.send(outcome);
            }
            Command::Read { doc_id, reply } => {
                let _ = reply.send(store.read_document(&doc_id));
            }
            Command::Snapshot { reply } => {
                let _ = reply.send(snapshot(&store));
            }
            Command::BindShadowClone { token, reply } => {
                let _ = reply.send(store.bind_shadow_clone_token(&token));
            }
            Command::RunUnits {
                units,
                faults,
                token,
                reply,
            } => {
                let outcome = run_units(&mut store, units, faults.as_ref(), &token);
                let _ = reply.send(outcome);
            }
            Command::VersionedTextWrite {
                input,
                root_dir,
                faults,
                token,
                reply,
            } => {
                let outcome = versioned_text_write_on_store(
                    &mut store,
                    &input,
                    root_dir.as_deref(),
                    faults.as_ref(),
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::VersionedBinaryWrite {
                input,
                root_dir,
                self_writes,
                faults,
                token,
                reply,
            } => {
                let outcome = versioned_binary_write_on_store(
                    &mut store,
                    &input,
                    &root_dir,
                    self_writes.as_ref(),
                    faults.as_ref(),
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::VersionedTextRename {
                input,
                root_dir,
                self_writes,
                faults,
                token,
                reply,
            } => {
                let outcome = versioned_text_rename_on_store(
                    &mut store,
                    &input,
                    &root_dir,
                    self_writes.as_ref(),
                    faults.as_ref(),
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::VersionedTextDelete {
                input,
                root_dir,
                self_writes,
                faults,
                token,
                reply,
            } => {
                let outcome = versioned_text_delete_on_store(
                    &mut store,
                    &input,
                    &root_dir,
                    self_writes.as_ref(),
                    faults.as_ref(),
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::VersionedTextRollback {
                input,
                root_dir,
                self_writes,
                faults,
                token,
                reply,
            } => {
                let outcome = versioned_text_rollback_on_store(
                    &mut store,
                    &input,
                    &root_dir,
                    self_writes.as_ref(),
                    faults.as_ref(),
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::VersionedTextCompare { input, reply } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .compare_text_file_versions(&input)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::VersionedTextMerge {
                input,
                root_dir,
                self_writes,
                faults,
                token,
                reply,
            } => {
                let outcome = versioned_text_merge_on_store(
                    &mut store,
                    &input,
                    &root_dir,
                    self_writes.as_ref(),
                    faults.as_ref(),
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::CompareVersionFilesPage {
                workspace_id,
                source_version_id,
                target_version_id,
                after_path,
                limit,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .compare_version_files_page(
                        &workspace_id,
                        &source_version_id,
                        &target_version_id,
                        after_path.as_deref(),
                        limit,
                    )
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::CaptureIngest {
                input,
                root_dir,
                faults,
                token,
                reply,
            } => {
                let outcome = capture_ingest_on_store(
                    &mut store,
                    &input,
                    root_dir.as_deref(),
                    faults.as_ref(),
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::CaptureIngestBinary {
                input,
                faults,
                token,
                reply,
            } => {
                let outcome =
                    capture_ingest_binary_on_store(&mut store, &input, faults.as_ref(), &token);
                let _ = reply.send(outcome);
            }
            Command::CaptureSecret {
                payload,
                faults,
                token,
                reply,
            } => {
                let (input, key) = *payload;
                let outcome =
                    capture_secret_on_store(&mut store, &input, &key, faults.as_ref(), &token);
                let _ = reply.send(outcome);
            }
            Command::CaptureSecretRetire {
                input,
                faults,
                token,
                reply,
            } => {
                let outcome =
                    capture_secret_retire_on_store(&mut store, &input, faults.as_ref(), &token);
                let _ = reply.send(outcome);
            }
            Command::SecretStateExists {
                workspace_id,
                reply,
            } => {
                let outcome =
                    has_secret_state(&mut store, &workspace_id).map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ListVersions {
                workspace_id,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .list_versions(&workspace_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ListSnapshots {
                workspace_id,
                version_id,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .list_snapshots(&workspace_id, &version_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ListSnapshotMetadata {
                workspace_id,
                version_id,
                after_path,
                limit,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .list_snapshot_metadata(
                        &workspace_id,
                        &version_id,
                        after_path.as_deref(),
                        limit,
                    )
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ListMoments { query, reply } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .list_moments(&query)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::GetMoment {
                workspace_id,
                moment_id,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .get_moment(&workspace_id, &moment_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ReadBinary {
                workspace_id,
                version_id,
                path,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .read_binary(&workspace_id, &version_id, &path)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ReadBinaryMeta {
                workspace_id,
                version_id,
                path,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .read_binary_meta(&workspace_id, &version_id, &path)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ReadBinaryBlob {
                workspace_id,
                sha256,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .read_binary_blob(&workspace_id, &sha256)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ReadBinaryBlobForEgress {
                workspace_id,
                sha256,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .read_binary_blob_for_egress(&workspace_id, &sha256)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ReadTextInband {
                workspace_id,
                version_id,
                path,
                cap,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .read_text_inband(&workspace_id, &version_id, &path, cap)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ReadBinaryInband {
                workspace_id,
                version_id,
                path,
                cap,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .read_binary_inband(&workspace_id, &version_id, &path, cap)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::MaterializeSecretInband {
                workspace_id,
                version_id,
                path,
                key,
                cap,
                reply,
            } => {
                let outcome = SecretFileStore::new(&mut store, &key)
                    .materialize_secret_file_inband(&workspace_id, &version_id, &path, cap)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::WriteSecretFile {
                input,
                key,
                faults,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    SecretFileStore::new(&mut store, &key)
                        .write_secret_file(&input, faults.as_ref())
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::DeleteSecretFile {
                input,
                faults,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    delete_secret_file_keyless(&mut store, &input, faults.as_ref())
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ForkSecretVersion {
                workspace_id,
                from_version_id,
                to_version_id,
                now_ms,
                faults,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    fork_version_keyless(
                        &mut store,
                        &workspace_id,
                        &from_version_id,
                        &to_version_id,
                        now_ms,
                        faults.as_ref(),
                    )
                    .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ListSecretMoments {
                workspace_id,
                version_id,
                path,
                before_moment_order,
                limit,
                reply,
            } => {
                let outcome = list_secret_moments_page_keyless(
                    &store,
                    &workspace_id,
                    version_id.as_deref(),
                    path.as_deref(),
                    before_moment_order,
                    limit,
                )
                .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::GetSecretMoment {
                workspace_id,
                moment_id,
                reply,
            } => {
                let outcome = get_secret_moment_keyless(&store, &workspace_id, &moment_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::CompareSecretFiles {
                workspace_id,
                source_version_id,
                target_version_id,
                after_path,
                limit,
                key,
                reply,
            } => {
                let outcome = compare_secret_files_page_keyless(
                    &store,
                    key.as_deref(),
                    &workspace_id,
                    &source_version_id,
                    &target_version_id,
                    after_path.as_deref(),
                    limit,
                )
                .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ApplySecretFile {
                workspace_id,
                path,
                from_version_id,
                to_version_id,
                moment_id,
                metadata_origin,
                metadata_summary,
                metadata_correlation_id,
                now_ms,
                key,
                faults,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    apply_secret_file_from_version(
                        &mut store,
                        &key,
                        &dohc_engine_domain::ApplySecretFileFromVersion {
                            workspace_id,
                            path,
                            from_version_id,
                            to_version_id,
                            moment_id,
                            metadata_origin,
                            metadata_summary,
                            metadata_correlation_id,
                            now_ms,
                        },
                        faults.as_ref(),
                    )
                    .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::RestoreSecretFile {
                workspace_id,
                path,
                before_moment_id,
                moment_id,
                metadata_origin,
                metadata_summary,
                metadata_correlation_id,
                now_ms,
                faults,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    restore_secret_file_verbatim_with_metadata(
                        &mut store,
                        &workspace_id,
                        &path,
                        &before_moment_id,
                        &moment_id,
                        &metadata_origin,
                        metadata_summary,
                        metadata_correlation_id,
                        now_ms,
                        faults.as_ref(),
                    )
                    .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ListSecretFiles {
                workspace_id,
                version_id,
                reply,
            } => {
                let outcome = list_secret_files_keyless(&store, &workspace_id, &version_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::SecretFileLen {
                workspace_id,
                version_id,
                path,
                reply,
            } => {
                let outcome = secret_file_len_keyless(&store, &workspace_id, &version_id, &path)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ListSecretFilesPage {
                workspace_id,
                version_id,
                after_path,
                limit,
                reply,
            } => {
                let outcome = list_secret_files_keyless_page(
                    &store,
                    &workspace_id,
                    &version_id,
                    after_path.as_deref(),
                    limit,
                )
                .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::MaterializeSecret {
                workspace_id,
                version_id,
                path,
                key,
                reply,
            } => {
                let outcome = SecretFileStore::new(&mut store, &key)
                    .materialize_secret_file(&workspace_id, &version_id, &path)
                    .map_err(RuntimeError::from)
                    .and_then(|plaintext| match plaintext {
                        None => Ok(None),
                        Some(plaintext) => plaintext.into_utf8().map(Some).map_err(|_| {
                            RuntimeError::from(dohc_engine_domain::DomainError::StateCorrupt {
                                reason: "secret plaintext is not utf-8",
                            })
                        }),
                    });
                let _ = reply.send(outcome);
            }
            Command::ActiveVersionId {
                workspace_id,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .get_active_version(&workspace_id)
                    .map(|version| version.version_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ActiveVersion {
                workspace_id,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .get_active_version(&workspace_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::EnsureMainVersion {
                workspace_id,
                now_ms,
                faults,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    VersionedTextStore::new(&mut store)
                        .ensure_main_version(&workspace_id, "main", now_ms, faults.as_ref())
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::SetActiveVersion {
                input,
                faults,
                token,
                reply,
            } => {
                let outcome = switch_active_version_on_store(
                    &mut store,
                    &input.workspace_id,
                    &input.version_id,
                    &input.root_dir,
                    input.self_writes.as_ref(),
                    input.now_ms,
                    faults.as_ref(),
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::CreateNamedVersion {
                input,
                faults,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    VersionedTextStore::new(&mut store)
                        .create_named_version(&input, faults.as_ref())
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::PreflightCreateNamedVersion {
                input,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    VersionedTextStore::new(&mut store)
                        .preflight_create_named_version(&input)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::CaptureManifestSeed {
                workspace_id,
                version_id,
                reply,
            } => {
                let outcome = capture_manifest_seed(&store, &workspace_id, &version_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::CaptureRetire {
                input,
                faults,
                token,
                reply,
            } => {
                let outcome = capture_retire_on_store(&mut store, &input, faults.as_ref(), &token);
                let _ = reply.send(outcome);
            }
            Command::VersionedTextRead {
                workspace_id,
                version_id,
                path,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    VersionedTextStore::new(&mut store)
                        .read_text(&workspace_id, &version_id, &path)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ResolvePathObject {
                workspace_id,
                version_id,
                path,
                reply,
            } => {
                let outcome = VersionedTextStore::new(&mut store)
                    .object_id_for_path(&workspace_id, &version_id, &path)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::YdocApply {
                key,
                content_kind,
                update,
                now_ms,
                faults,
                token,
                reply,
            } => {
                let outcome = ydoc_apply_on_store(
                    &mut store,
                    &key,
                    content_kind,
                    &update,
                    now_ms,
                    faults.as_ref(),
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::YdocOpenState {
                workspace_id,
                now_ms,
                drain_deferred,
                expected_key,
                version_id,
                path,
                content_kind,
                token,
                reply,
            } => {
                let outcome = ydoc_open_state_on_store(
                    &mut store,
                    &workspace_id,
                    now_ms,
                    drain_deferred,
                    expected_key.as_ref(),
                    &version_id,
                    &path,
                    content_kind,
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::YdocVersionUnsettledContentKind {
                workspace_id,
                version_id,
                ignored_object_ids,
                token,
                reply,
            } => {
                let outcome = ydoc_version_unsettled_content_kind_on_store(
                    &store,
                    &workspace_id,
                    &version_id,
                    &ignored_object_ids,
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::YdocRecordUpdate {
                key,
                path,
                content_kind,
                regime,
                update,
                request_id,
                actor_origin_id,
                require_empty_lineage,
                now_ms,
                faults,
                token,
                reply,
            } => {
                let outcome = ydoc_record_update_on_store(
                    &mut store,
                    &key,
                    &path,
                    content_kind,
                    regime,
                    &update,
                    actor_origin_id,
                    require_empty_lineage,
                    request_id,
                    now_ms,
                    faults.as_ref(),
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::YdocSettle {
                root_dir,
                key,
                path,
                content_kind,
                expected_head_sha,
                session_id,
                self_writes,
                now_ms,
                faults,
                token,
                reply,
            } => {
                let outcome = ydoc_settle_on_store(
                    &mut store,
                    &root_dir,
                    &key,
                    &path,
                    content_kind,
                    expected_head_sha,
                    &session_id,
                    self_writes.as_ref(),
                    now_ms,
                    faults.as_ref(),
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::YdocResync { key, token, reply } => {
                let outcome = ydoc_resync_on_store(&mut store, &key, &token);
                let _ = reply.send(outcome);
            }
            Command::YdocCloseSession {
                key,
                now_ms,
                faults,
                token,
                reply,
            } => {
                let outcome =
                    ydoc_close_session_on_store(&mut store, &key, now_ms, faults.as_ref(), &token);
                let _ = reply.send(outcome);
            }
            Command::MaterializeReplayPending {
                root_dir,
                workspace_id,
                now_ms,
                reply,
            } => {
                // Open-time replay runs before the files layer starts. The
                // switch path calls the same tolerant per-job executor with a
                // selected durable job set and watcher suppression enabled.
                let outcome = replay_pending_materializations(
                    &mut store,
                    &root_dir,
                    MaterializationReplayScope {
                        workspace_id: &workspace_id,
                        self_writes: None,
                    },
                    now_ms,
                    &NoFaults,
                    None,
                    false,
                )
                .map(|summary| summary.completed);
                let _ = reply.send(outcome);
            }
            Command::MaterializeReplayPendingForFence {
                root_dir,
                workspace_id,
                self_writes,
                now_ms,
                reply,
            } => {
                let outcome = replay_pending_materializations(
                    &mut store,
                    &root_dir,
                    MaterializationReplayScope {
                        workspace_id: &workspace_id,
                        self_writes: Some(self_writes.as_ref()),
                    },
                    now_ms,
                    &NoFaults,
                    None,
                    false,
                )
                .and_then(|summary| {
                    if summary.failed == 0 {
                        Ok(())
                    } else {
                        Err(RuntimeError::ActiveVersionMaterializationIncomplete {
                            failed_jobs: summary.failed,
                        })
                    }
                });
                let _ = reply.send(outcome);
            }
            Command::ConflictList {
                workspace_id,
                status,
                after_conflict_id,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    VersionedTextStore::new(&mut store)
                        .list_text_conflicts_page(
                            &workspace_id,
                            status.as_deref(),
                            after_conflict_id.as_deref(),
                        )
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ConflictOpen {
                conflict,
                faults,
                token,
                reply,
            } => {
                let outcome =
                    conflict_open_on_store(&mut store, &conflict, faults.as_ref(), &token);
                let _ = reply.send(outcome);
            }
            Command::ConflictResolve {
                input,
                root_dir,
                faults,
                token,
                reply,
            } => {
                let outcome = conflict_resolve_on_store(
                    &mut store,
                    &input,
                    root_dir.as_deref(),
                    faults.as_ref(),
                    &token,
                );
                let _ = reply.send(outcome);
            }
            Command::ConflictApplyReplicated {
                envelope,
                faults,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    match apply_conflict_envelope(&mut store, &envelope, faults.as_ref()) {
                        Ok(outcome @ ApplyOutcome::Refused(_)) => {
                            retain_refusal_for_direct_retry(&mut store, &envelope, faults.as_ref())
                                .map(|()| outcome)
                                .map_err(RuntimeError::from)
                        }
                        Ok(ApplyOutcome::Skipped) => read_replayed_refusal(&store, &envelope)
                            .map(|refusal| {
                                refusal.map_or(ApplyOutcome::Skipped, ApplyOutcome::Refused)
                            })
                            .map_err(RuntimeError::from),
                        outcome => outcome.map_err(RuntimeError::from),
                    }
                };
                let _ = reply.send(outcome);
            }
            Command::ChatChannelCreate {
                workspace_id,
                channel_id,
                name,
                kind,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .create_channel(&workspace_id, &channel_id, &name, kind, now_ms, &NoFaults)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatChannelEnsureGeneral {
                workspace_id,
                channel_id,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .ensure_general_channel(&workspace_id, &channel_id, now_ms, &NoFaults)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatChannelEnsureAgent {
                workspace_id,
                channel_id,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .ensure_agent_channel(&workspace_id, &channel_id, now_ms, &NoFaults)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatChannelsList {
                workspace_id,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_channels(&workspace_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatChannelFindBySlug {
                workspace_id,
                slug,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .find_channel_by_slug(&workspace_id, &slug)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatChannelGetWireId {
                workspace_id,
                channel_id,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .get_channel_wire_id(&workspace_id, &channel_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatThreadStart {
                input,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .start_channel_thread(&input, &NoFaults)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatThreadCreate {
                input,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .create_thread(&input, &NoFaults)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatThreadsList {
                workspace_id,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_threads(&workspace_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatThreadsListForFile {
                workspace_id,
                object_id,
                after,
                limit,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_threads_for_file(&workspace_id, &object_id, after, limit)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatThreadsListForChannel {
                workspace_id,
                channel_id,
                after,
                limit,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_channel_threads(&workspace_id, &channel_id, after, limit)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatThreadFindChannelId {
                workspace_id,
                thread_id,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .find_thread_channel_id(&workspace_id, &thread_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatThreadGetProjection {
                workspace_id,
                thread_id,
                linked_file_access,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .get_thread_projection(&workspace_id, &thread_id, linked_file_access)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatAttachmentsListForThread {
                workspace_id,
                thread_id,
                after,
                limit,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_thread_attachments(&workspace_id, &thread_id, after, limit)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatAttachmentsListFileMentions {
                workspace_id,
                object_id,
                path_hint,
                after,
                limit,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_file_mentions(
                        &workspace_id,
                        object_id.as_deref(),
                        path_hint.as_deref(),
                        after,
                        limit,
                    )
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatMentionsBackfill {
                workspace_id,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .backfill_mentions(&workspace_id, &NoFaults)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatMentionsListForHandle {
                workspace_id,
                handle,
                unread_only,
                after,
                limit,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_mentions_for_handle(&workspace_id, &handle, unread_only, after, limit)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchRecordEligibleTriggers {
                workspace_id,
                verified_user_id,
                at_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .record_eligible_triggers(
                            &workspace_id,
                            verified_user_id.as_deref(),
                            at_ms,
                            &NoFaults,
                        )
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatMessageSend {
                input,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .send_message(&input, &NoFaults)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatDecisionResolve {
                input,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .resolve_decision(&input, &NoFaults)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatDecisionsList {
                workspace_id,
                thread_id,
                after,
                limit,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_thread_decisions(&workspace_id, &thread_id, after, limit)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatReactionSet {
                input,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .set_reaction(&input, &NoFaults)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatReactionsList {
                workspace_id,
                thread_id,
                after,
                limit,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_reactions(&workspace_id, &thread_id, after, limit)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatMessagesList {
                workspace_id,
                thread_id,
                limit,
                after_message_order,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_messages(&workspace_id, &thread_id, limit, after_message_order)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatReadStateMarkThreadRead {
                workspace_id,
                thread_id,
                up_to_sequence,
                expected_revision,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .mark_thread_read(
                            &workspace_id,
                            &thread_id,
                            up_to_sequence,
                            expected_revision,
                            now_ms,
                            &NoFaults,
                        )
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatReadStateGet {
                workspace_id,
                thread_id,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .read_state(&workspace_id, &thread_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatReadStateListUnreadFileThreads {
                workspace_id,
                after_thread_id,
                limit,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_unread_file_threads(&workspace_id, after_thread_id.as_deref(), limit)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatAgentUnreadThreads {
                workspace_id,
                after,
                limit,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_agent_unread_threads(&workspace_id, after, limit)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatAgentMarkThreadRead {
                workspace_id,
                thread_id,
                up_to_created_at_ms,
                up_to_message_id,
                expected_revision,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .mark_thread_read_by_agent(
                            &workspace_id,
                            &thread_id,
                            up_to_created_at_ms,
                            &up_to_message_id,
                            expected_revision,
                            now_ms,
                            &NoFaults,
                        )
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatFollowSet {
                input,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .set_follow(&input, &NoFaults)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatFollowsList {
                workspace_id,
                owner_user_id,
                state,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_follows(&workspace_id, &owner_user_id, state.as_deref())
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatFollowsEnsureDefaults {
                workspace_id,
                owner_user_id,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .ensure_default_channel_follows(&workspace_id, &owner_user_id, &NoFaults)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatBookmarkFind {
                workspace_id,
                owner_user_id,
                bookmark_id,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .find_bookmark(&workspace_id, &owner_user_id, &bookmark_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatBookmarksListPending {
                workspace_id,
                owner_user_id,
                limit,
                after,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_pending_bookmarks_page(&workspace_id, &owner_user_id, limit, after)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatFeedMarkSeen {
                workspace_id,
                owner_user_id,
                replication_owner_user_id,
                head_cursor,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .mark_feed_seen(
                            &workspace_id,
                            &owner_user_id,
                            replication_owner_user_id.as_deref(),
                            &head_cursor,
                            now_ms,
                            &NoFaults,
                        )
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatFeedListPersonal {
                workspace_id,
                owner_user_id,
                limit,
                cursor,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_personal_feed(&workspace_id, &owner_user_id, limit, cursor.as_deref())
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatBookmarkSave {
                input,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .save_bookmark(&input, &NoFaults)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatBookmarksList {
                workspace_id,
                owner_user_id,
                state,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_bookmarks(&workspace_id, &owner_user_id, state.as_deref())
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatBookmarkMarkReady {
                workspace_id,
                owner_user_id,
                bookmark_id,
                generation,
                projected_at_ms,
                projection_object_id,
                projection_path,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .mark_bookmark_ready(
                            &workspace_id,
                            &owner_user_id,
                            &bookmark_id,
                            generation,
                            projected_at_ms,
                            projection_object_id.as_deref(),
                            projection_path.as_deref(),
                            &NoFaults,
                        )
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatBookmarkArchive {
                workspace_id,
                owner_user_id,
                bookmark_id,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .archive_bookmark(
                            &workspace_id,
                            &owner_user_id,
                            &bookmark_id,
                            now_ms,
                            &NoFaults,
                        )
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatBookmarkMarkPending {
                workspace_id,
                owner_user_id,
                bookmark_id,
                request_id,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .mark_bookmark_pending(
                            &workspace_id,
                            &owner_user_id,
                            &bookmark_id,
                            &request_id,
                            now_ms,
                            &NoFaults,
                        )
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatBookmarkMarkFailed {
                workspace_id,
                owner_user_id,
                bookmark_id,
                generation,
                failure_reason,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .mark_bookmark_failed(
                            &workspace_id,
                            &owner_user_id,
                            &bookmark_id,
                            generation,
                            &failure_reason,
                            now_ms,
                            &NoFaults,
                        )
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatBookmarkMarkStale {
                workspace_id,
                owner_user_id,
                bookmark_id,
                generation,
                failure_reason,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .mark_bookmark_stale(
                            &workspace_id,
                            &owner_user_id,
                            &bookmark_id,
                            generation,
                            failure_reason.as_deref(),
                            now_ms,
                            &NoFaults,
                        )
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchEnqueue {
                workspace_id,
                trigger_message_id,
                thread_id,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .enqueue_dispatch(
                            &workspace_id,
                            &trigger_message_id,
                            &thread_id,
                            now_ms,
                            &NoFaults,
                        )
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchClaimNextPending {
                workspace_id,
                run_id,
                command,
                log_path,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .claim_next_pending(
                            &workspace_id,
                            &run_id,
                            &command,
                            log_path.as_deref(),
                            now_ms,
                            &NoFaults,
                        )
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchListPending {
                workspace_id,
                after,
                limit,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_pending_dispatches(&workspace_id, after, limit)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchOpenRuns {
                workspace_id,
                after,
                limit,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_open_dispatch_runs(&workspace_id, after, limit)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchListRunMessages {
                workspace_id,
                run_id,
                after_message_id,
                limit,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_run_messages(&workspace_id, &run_id, after_message_id, limit)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchRunIdForMessage {
                workspace_id,
                message_id,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .dispatch_run_id_for_message(&workspace_id, &message_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchRunRecordsForThread {
                workspace_id,
                thread_id,
                run_limit,
                after,
                page_limit,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .run_records_for_thread(&workspace_id, &thread_id, run_limit, after, page_limit)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchGetRunRecord {
                workspace_id,
                run_id,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .get_run_record(&workspace_id, &run_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchThreadPaused {
                workspace_id,
                thread_id,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .thread_dispatch_paused(&workspace_id, &thread_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchGetThreadPauseState {
                workspace_id,
                thread_id,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .get_thread_dispatch_pause_state(&workspace_id, &thread_id)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchRecentCount {
                workspace_id,
                thread_id,
                since_ms,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .recent_dispatch_count(&workspace_id, &thread_id, since_ms)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchFailPendingForThread {
                workspace_id,
                thread_id,
                reason,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .fail_pending_for_thread(
                            &workspace_id,
                            &thread_id,
                            &reason,
                            now_ms,
                            &NoFaults,
                        )
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchRecordRunMessage {
                workspace_id,
                message_id,
                run_id,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .record_run_message(&workspace_id, &message_id, &run_id, &NoFaults)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchSetThreadPaused {
                workspace_id,
                thread_id,
                paused,
                reason,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .set_thread_dispatch_paused(
                            &workspace_id,
                            &thread_id,
                            paused,
                            reason.as_deref(),
                            now_ms,
                            &NoFaults,
                        )
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchMarkFailureNotePosted {
                workspace_id,
                run_id,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .mark_failure_note_posted(&workspace_id, &run_id, &NoFaults)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchRequeueFailedTrigger {
                workspace_id,
                trigger_message_id,
                run_id,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .requeue_failed_trigger(
                            &workspace_id,
                            &trigger_message_id,
                            &run_id,
                            now_ms,
                            &NoFaults,
                        )
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchListAppQuitRecoveries {
                workspace_id,
                after,
                limit,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .list_app_quit_recoveries(&workspace_id, after, limit)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchComplete {
                workspace_id,
                run_id,
                exit_code,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .complete_dispatch(&workspace_id, &run_id, exit_code, now_ms, &NoFaults)
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchFail {
                workspace_id,
                run_id,
                reason,
                exit_code,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    LinkedChatStore::new(&mut store)
                        .fail_dispatch(
                            &workspace_id,
                            &run_id,
                            &reason,
                            exit_code,
                            now_ms,
                            &NoFaults,
                        )
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::ChatDispatchReclaimRunning {
                workspace_id,
                max_attempts,
                now_ms,
                reply,
            } => {
                let outcome = LinkedChatStore::new(&mut store)
                    .reclaim_running_dispatches(&workspace_id, max_attempts, now_ms, &NoFaults)
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::Search {
                root_dir,
                workspace_id,
                version_id,
                query,
                limit,
                now_ms,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    store
                        .read_with(|conn| {
                            search_workspace(
                                conn,
                                &root_dir,
                                &workspace_id,
                                &version_id,
                                &query,
                                limit,
                                now_ms,
                            )
                        })
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::SearchPage {
                root_dir,
                workspace_id,
                version_id,
                query,
                limit,
                now_ms,
                expected_generation,
                after,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    store
                        .read_with(|conn| {
                            search_workspace_page(
                                conn,
                                &root_dir,
                                &workspace_id,
                                &version_id,
                                &query,
                                limit,
                                now_ms,
                                expected_generation,
                                after,
                            )
                        })
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::SearchQueryChatMessagesGranular {
                workspace_id,
                query,
                limit,
                materialized_byte_budget,
                reply,
            } => {
                let outcome = store
                    .read_with(|conn| {
                        query_chat_messages_granular_bounded(
                            conn,
                            &workspace_id,
                            &query,
                            limit,
                            materialized_byte_budget,
                        )
                    })
                    .map_err(RuntimeError::from);
                let _ = reply.send(outcome);
            }
            Command::EnsureSearchIndex {
                root_dir,
                workspace_id,
                version_id,
                now_ms,
                faults,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    store
                        .read_with(|conn| {
                            ensure_search_index_for_version(
                                conn,
                                &root_dir,
                                &workspace_id,
                                &version_id,
                                now_ms,
                                faults.as_ref(),
                            )
                        })
                        .map_err(RuntimeError::from)
                };
                let _ = reply.send(outcome);
            }
            Command::Relay {
                transport,
                operation,
                leases,
                token,
                reply,
            } => {
                let outcome = if token.is_cancelled() {
                    Err(RuntimeError::Cancelled)
                } else {
                    execute_relay_operation(&mut store, transport, operation, &leases)
                };
                let _ = reply.send(outcome);
            }
            Command::Close => {
                // FIFO ordering means every command enqueued before Close has
                // already been served; there is nothing left to drain.
                state.store(LifecycleState::Draining.as_u8(), Ordering::Release);
                break;
            }
        }
    }

    // Normal exit: drop the connection explicitly, then the `_closed_guard`
    // publishes Closed as it falls out of scope (same ordering the guard
    // guarantees on a panic unwind).
    drop(store);
}

fn ydoc_apply_on_store(
    store: &mut EngineStore,
    key: &DocKey,
    content_kind: ContentKind,
    update: &[u8],
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<AppendOutcome, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    match dohc_engine_collab::record_local_update_creating_marker(
        store,
        key,
        content_kind,
        Regime::Replicated,
        update,
        None,
        faults,
        now_ms,
    )? {
        TxnOutcome::Committed(outcome) => Ok(outcome),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

/// Durable Y.Doc state exists when the lineage holds updates OR snapshots.
/// A pruned local-only marker (both zero) has NO durable state: opens report
/// it absent and settles refuse it (an empty projection must never clobber
/// the artifact).
fn ydoc_marker_has_durable_state(marker: &dohc_engine_collab::Marker) -> bool {
    // base_claimed covers the replicated base-only lineage: claim_base inserts
    // the base snapshot at up_to_seq 0 WITHOUT advancing head_snapshot_seq, so
    // the seq pair alone would misread a claimed base as absent (double-seed +
    // NoMarker settle refusals on a valid lineage).
    marker.head_update_seq > 0 || marker.head_snapshot_seq > 0 || marker.base_claimed
}

fn ydoc_version_unsettled_content_kind_on_store(
    store: &EngineStore,
    workspace_id: &str,
    version_id: &str,
    ignored_object_ids: &[String],
    token: &CancellationToken,
) -> Result<Option<ContentKind>, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let lineages: Vec<(String, ContentKind, bool)> = store.read_with(|conn| {
        let mut statement = conn
            .prepare(
                "SELECT docs.object_id, docs.content_kind, EXISTS ( \
                     SELECT 1 FROM ydoc_deferred_updates AS deferred \
                     WHERE deferred.workspace_id = docs.workspace_id \
                       AND deferred.version_id = docs.version_id \
                       AND deferred.object_id = docs.object_id \
                  ) \
                  FROM ydoc_docs AS docs \
                  WHERE docs.workspace_id = ?1 AND docs.version_id = ?2 \
                    AND (docs.head_update_seq > 0 OR docs.head_snapshot_seq > 0 \
                         OR docs.base_claimed = 1 OR EXISTS ( \
                            SELECT 1 FROM ydoc_deferred_updates AS deferred \
                            WHERE deferred.workspace_id = docs.workspace_id \
                              AND deferred.version_id = docs.version_id \
                              AND deferred.object_id = docs.object_id \
                        ))",
            )
            .map_err(StorageError::corrupt_public)?;
        let rows = statement
            .query_map(params![workspace_id, version_id], |row| {
                let content_kind = row.get::<_, String>(1)?;
                Ok((row.get(0)?, ContentKind::parse(&content_kind), row.get(2)?))
            })
            .map_err(StorageError::corrupt_public)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::corrupt_public)
    })?;

    for (object_id, content_kind, has_deferred_updates) in lineages {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if ignored_object_ids
            .iter()
            .any(|ignored| ignored == &object_id)
        {
            continue;
        }
        // Deferred updates are source-version state too, and a fork clones
        // neither them nor the Y.Doc lineage. Refuse even when the currently
        // integrated projection still happens to match its snapshot.
        if has_deferred_updates {
            return Ok(Some(content_kind));
        }
        let key = DocKey::new(workspace_id, version_id, object_id)?;
        let Some(persisted) = dohc_engine_collab::load_persisted(store, &key)? else {
            // The row predicate above says durable state exists. A missing
            // load is inconsistent and must fail closed for the fork.
            return Ok(Some(content_kind));
        };
        if persisted.doc.has_pending_dependencies() {
            return Ok(Some(content_kind));
        }
        let content_kind = persisted.marker.content_kind;
        let projected = persisted.doc.project(content_kind)?;
        let projected_sha = hex_sha256(projected.markdown.as_bytes());
        let materialized_sha: Option<String> = store.read_with(|conn| {
            conn.query_row(
                "SELECT blob_sha256 FROM snapshots \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                params![workspace_id, version_id, key.object_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(StorageError::corrupt_public)
        })?;
        if materialized_sha.as_deref() != Some(projected_sha.as_str()) {
            return Ok(Some(content_kind));
        }
    }
    Ok(None)
}

fn ensure_mutation_version_on_store(
    store: &mut EngineStore,
    workspace_id: &str,
    version_id: &str,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<(), RuntimeError> {
    let mut versions = VersionedTextStore::new(store);
    if versions.get_main_version(workspace_id)?.is_some() {
        return Ok(());
    }
    if version_id != "main" {
        return Err(DomainError::VersionNotFound.into());
    }
    versions.ensure_main_version(workspace_id, "main", now_ms, faults)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn ydoc_open_state_on_store(
    store: &mut EngineStore,
    workspace_id: &str,
    now_ms: i64,
    drain_deferred: bool,
    expected_key: Option<&DocKey>,
    version_id: &str,
    path: &str,
    requested_content_kind: Option<ContentKind>,
    token: &CancellationToken,
) -> Result<YdocOpenState, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let canonical_path = validate_addressable_plaintext_path(path)?;
    // Bootstrap: the first live doc in an EMPTY workspace must be creatable —
    // without this, read_text errors VersionNotFound before the absent-path
    // flow can run (capture normally creates main, but nothing has captured).
    ensure_mutation_version_on_store(store, workspace_id, version_id, now_ms, &NoFaults)?;
    let head =
        VersionedTextStore::new(store).read_text(workspace_id, version_id, &canonical_path)?;
    let head_sha = head.as_ref().map(|snapshot| snapshot.blob_sha256.clone());
    let object_id = match head.as_ref() {
        Some(snapshot) => snapshot.object_id.clone(),
        None => {
            let derived = derive_capture_object_id(workspace_id, version_id, &canonical_path);
            // A derived id still LIVE at another alias means this path's
            // former file was renamed away: capture's locked resolution mints
            // an order-disambiguated id for that case, which open-time cannot
            // reserve pre-commit. Reusing the derived id would graft the new
            // document onto the renamed file's lineage, so refuse; a capture
            // or local write creates the path and reopening resumes normally.
            let collides = store.read_with(|conn| {
                dohc_engine_domain::object_has_live_alias(conn, workspace_id, &derived)
            })?;
            if collides {
                return Err(RuntimeError::Collab(
                    dohc_engine_collab::CollabError::ObjectAliasCollision,
                ));
            }
            derived
        }
    };
    let key = DocKey::new(workspace_id, version_id, object_id)?;
    let expected_key_matches = expected_key.is_none_or(|expected| *expected == key);
    // RETIRED artifact: the path has NO head (deleted on disk, capture
    // retired the snapshot/alias) but a LOCAL-ONLY lineage that claims a
    // settled artifact survived (workspace teardown skips the prune).
    // Markdown-is-the-artifact: the user deleted the document, so reopening
    // must not resurrect the stale cache — and its retained last_settled_sha
    // would wedge the next settle in ConflictStaleTarget (head None vs a
    // settled expectation). Clear the lineage; the open proceeds as absent.
    // A crashed never-settled draft (last_settled NULL) still resurrects —
    // its CRDT rows are the only copy of the user's edits. Replicated
    // lineages are durable canonical and never clear here.
    // POST-LEASE only (same gating as the drain): the pre-lease probe must
    // stay side-effect-free — a second opener's probe running this clear
    // while the first session still holds the lease would delete the live
    // session's unmaterialized CRDT state out from under it.
    if drain_deferred
        && expected_key_matches
        && head.is_none()
        && dohc_engine_collab::read_marker(store, &key)?
            .is_some_and(|marker| marker.regime == dohc_engine_collab::Regime::LocalOnly)
        && dohc_engine_collab::read_last_settled_sha(store, &key)?.is_some()
    {
        let cleared = store.write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM ydoc_updates                  WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "DELETE FROM ydoc_snapshots                  WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "UPDATE ydoc_docs SET head_update_seq = 0, head_snapshot_seq = 0,                  last_settled_sha = NULL, updated_at_ms = ?4                  WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                params![key.workspace_id, key.version_id, key.object_id, now_ms],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })?;
        if matches!(cleared, TxnOutcome::Crashed { .. }) {
            return Err(RuntimeError::OperationCrashed);
        }
    }
    // Re-converge BEFORE loading state: an envelope acked-but-deferred while
    // a previous session held the lease is only guaranteed to drain on that
    // session's ydoc.close — workspace.close, stale-handle eviction, and a
    // crash all skip it. The imported replication log is the durable pending
    // queue, and replaying an already-applied row is content-deduped, so
    // draining on every open makes the parked update land on the next use
    // of the doc no matter how the previous session ended.
    // The drain only runs for the key the CALLER'S LEASE covers: if the
    // path's owner changed between the RPC's probe and this post-lease read,
    // the derived key belongs to a different object — possibly one a live
    // session already holds — and draining it here would mutate that doc
    // behind its active editor with no event or resync signal. The RPC layer
    // rejects the mismatched open right after; skipping the drain keeps this
    // read side-effect-free for the foreign key.
    if drain_deferred
        && expected_key_matches
        && dohc_engine_collab::read_marker(store, &key)?
            .is_some_and(|marker| marker.regime == Regime::Replicated)
    {
        // Only the POST-LEASE read drains: a pre-lease probe mutating the
        // lineage while another session holds the lease would advance state
        // behind the active editor with no event or resync signal.
        dohc_engine_sync::drain_deferred_ydoc_for_key(store, &key, &NoFaults)?;
    }
    let persisted = dohc_engine_collab::load_persisted(store, &key)?;
    // "Existing" means durable DOC STATE, not a bare marker: a local-only
    // close prunes every CRDT row and leaves head_update_seq == 0
    // (markdown-is-the-artifact). Reporting such a lineage as existing would
    // hand the client an EMPTY doc with no seedMarkdown — its next settle
    // would clobber the settled file. A pruned marker is seed-eligible
    // (the recordUpdate guard checks head_update_seq > 0), so the artifact
    // re-seeds the cache exactly like a first open. "Durable doc state"
    // means updates OR snapshots: a replicated lineage holding only its
    // base snapshot (head_update_seq == 0, head_snapshot_seq > 0) is
    // EXISTING — reporting it absent would hand the client the base state
    // AND a markdown seed, duplicating content on the first seed apply.
    let lineage_existing = persisted
        .as_ref()
        .is_some_and(|persisted| ydoc_marker_has_durable_state(&persisted.marker));
    let (content_kind, regime, initial_update) = match persisted {
        Some(persisted) => (
            persisted.marker.content_kind,
            persisted.marker.regime,
            persisted.doc.encode_full_state(),
        ),
        None => {
            let doc = Ydoc::wire();
            (
                // PLAINTEXT default: the desktop's markdown live path opens
                // without a contentKind, and a richdoc default would wedge
                // it — richdoc settle is a C1 refusal and the client skips
                // its close-time settle, so first-time markdown edits would
                // persist only as closed CRDT cache while the .md file and
                // history stay stale. Richdoc callers pass the kind
                // explicitly.
                requested_content_kind.unwrap_or(ContentKind::Plaintext),
                Regime::LocalOnly,
                doc.encode_full_state(),
            )
        }
    };
    Ok(YdocOpenState {
        head_blob_sha256: head_sha,
        key,
        content_kind,
        regime,
        initial_update,
        lineage_existing,
        seed_markdown: (!lineage_existing)
            .then(|| head.map(|snapshot| snapshot.text))
            .flatten(),
    })
}

#[allow(clippy::too_many_arguments)]
fn ydoc_record_update_on_store(
    store: &mut EngineStore,
    key: &DocKey,
    path: &str,
    content_kind: ContentKind,
    regime: Regime,
    update: &[u8],
    actor_origin_id: Option<String>,
    require_empty_lineage: bool,
    request_id: Option<String>,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<AppendOutcome, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    // Validate BEFORE anything touches the store: a malformed first seed
    // must not strand a bare file_objects row for the deterministic object
    // id (which regular writes then treat as already existing).
    Ydoc::validate_update(update)?;
    // A replicated, base-claimed lineage journals the ydoc.update DELTA in
    // the SAME transaction as the append (blob-before-log holds; TS parity:
    // ydocEngineDriver journals inside the recordUpdate write). Local-only
    // lineages journal nothing — their markdown is the artifact.
    let update_sha = dohc_engine_storage::hex_sha256(update);
    let journal_key = key.clone();
    let journal_path = path.to_owned();
    let journal_kind = content_kind;
    match dohc_engine_collab::record_local_update_creating_marker_guarded(
        store,
        key,
        content_kind,
        regime,
        update,
        actor_origin_id.as_deref(),
        // Parent row, seed guard, marker, append, and outbound journal all
        // commit in ONE transaction — no bare-parent crash window, and a
        // timed-out-commit seed retry DEDUPES inside the guard instead of
        // refusing seed-onto-existing-lineage.
        true,
        require_empty_lineage,
        request_id.as_deref(),
        faults,
        now_ms,
        move |tx, outcome| {
            if outcome.emit_outbound {
                dohc_engine_sync::journal_local_op_in_tx(
                    tx,
                    &journal_key.workspace_id,
                    "ydoc.update",
                    &serde_json::json!({
                        "versionId": journal_key.version_id,
                        "objectId": journal_key.object_id,
                        "path": journal_path,
                        "contentKind": journal_kind.as_str(),
                        "updateBlobSha256": update_sha,
                        "isBaseState": false,
                    }),
                    now_ms,
                )
                .map_err(|error| dohc_engine_collab::CollabError::Corrupt {
                    // Named explicitly: a base-claimed replicated lineage
                    // with NO sync identity is a half-initialized state
                    // (every real replicated flow runs sync init first —
                    // pulls require the identity and the TS driver creates
                    // it when journaling the base). Fail closed with a
                    // diagnosable reason rather than a generic failure; an
                    // identity cannot be seeded down here (origin identity
                    // is minted by sync init, not the collab layer).
                    reason: format!("outbound ydoc.update journal append failed: {error}"),
                })?;
            }
            Ok(())
        },
    )? {
        TxnOutcome::Committed(outcome) => Ok(outcome),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

#[allow(clippy::too_many_arguments)]
fn ydoc_settle_on_store(
    store: &mut EngineStore,
    root_dir: &std::path::Path,
    key: &DocKey,
    path: &str,
    content_kind: ContentKind,
    expected_head_sha: Option<String>,
    session_id: &str,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<YdocSettlement, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    // Refuse to settle a lineage that has no durable state: projecting a
    // fresh doc would be the empty string, and the projected write below
    // would clobber the existing file with it. Mirrors collab settle()'s
    // NoMarker refusal — and a PRUNED bare marker (local-only close) is the
    // same hazard: load_persisted returns Some with an EMPTY doc, so the
    // durable-state predicate (updates OR snapshots) gates it, matching
    // ydoc.open's lineage-absent treatment.
    match dohc_engine_collab::read_marker(store, key)? {
        None => return Err(dohc_engine_collab::CollabError::NoMarker.into()),
        Some(marker) => {
            if !ydoc_marker_has_durable_state(&marker) {
                return Err(dohc_engine_collab::CollabError::NoMarker.into());
            }
            // Acked-but-deferred remote envelopes must land BEFORE the
            // projection — but if any actually apply, the CLIENT's doc has
            // not seen them: settling would materialize content the user
            // never saw while they keep editing stale state. Refuse; the
            // client resyncs (which also drains) and settles again.
            if marker.regime == Regime::Replicated
                && dohc_engine_sync::drain_deferred_ydoc_for_key(store, key, faults)?.drained > 0
            {
                return Err(dohc_engine_domain::DomainError::InvalidInput {
                    reason: "ydoc-remote-updates-pending",
                }
                .into());
            }
        }
    }
    let doc = match dohc_engine_collab::load_persisted(store, key)? {
        Some(persisted) => persisted.doc,
        None => return Err(dohc_engine_collab::CollabError::NoMarker.into()),
    };
    // A doc holding unintegrated remote updates (missing cross-origin
    // dependency) must not settle: the projection would omit pending remote
    // content and last_settled_sha would record that incomplete artifact as
    // settled — the CRDT then advances past a stale file.
    if doc.has_pending_dependencies() {
        return Err(dohc_engine_collab::CollabError::MissingDependencies.into());
    }
    let projection = doc.project(content_kind)?;
    // A successful settle must be REPORTABLE: the response carries the
    // markdown as one wire string, so a projection past the in-band cap
    // refuses BEFORE anything commits (a committed-but-undecodable settle
    // would strand the client). Blob streaming lifts this at RPC-D.
    if projection.markdown.len() > dohc_engine_domain::INBAND_CONTENT_CAP_BYTES {
        return Err(dohc_engine_domain::DomainError::InvalidText {
            reason: "ydoc-settle-exceeds-inband-cap",
        }
        .into());
    }
    // The stale-head guard runs BEFORE the idempotent no-op: an external
    // capture ingest (or any same-object writer) must surface as
    // ConflictStaleTarget even when the projection itself is unchanged —
    // otherwise settle reports success and a close can prune without the
    // client ever resyncing over the divergence.
    //
    // The expectation derives from DURABLE state (the lineage's last settle
    // sha) falling back to the caller-supplied OPEN-TIME head sha — never
    // from RPC-side session fields mutated after awaits, which a dropped
    // future (deadline firing after the actor committed a settle) leaves
    // stale and would turn every retry into a false conflict.
    let expected_head_sha =
        dohc_engine_collab::read_last_settled_sha(store, key)?.or(expected_head_sha);
    let head_probe =
        VersionedTextStore::new(store).read_text(&key.workspace_id, &key.version_id, path)?;
    let probe_sha = head_probe
        .as_ref()
        .map(|snapshot| snapshot.blob_sha256.clone());
    if probe_sha != expected_head_sha {
        return Err(dohc_engine_domain::DomainError::ConflictStaleTarget.into());
    }
    if let Some(current) = head_probe.as_ref() {
        // Ownership must hold even when the CONTENT matches the expectation:
        // a path rebound to another object whose blob happens to equal this
        // session's expected sha would otherwise pass the stale guard and be
        // answered (or replayed) as if this session still owned it — and a
        // later close could prune this object's CRDT while the artifact
        // belongs to the other owner. Mirror the fresh path's in-tx check.
        if current.object_id != key.object_id {
            return Err(dohc_engine_domain::DomainError::ConflictStaleTarget.into());
        }
        // The marker may have committed while the PRIOR settle's
        // materialization failed transiently before the file replace: the
        // head and last_settled_sha are advanced, the job is still pending,
        // and the DISK holds the old preimage. That job must replay BEFORE
        // any settle answer — the idempotent no-op (or close could prune
        // over stale disk bytes) AND a changed-projection settle (whose new
        // job's preimage is the unmaterialized head; skipping the replay
        // would strand it in a permanent materialization conflict).
        let pending_job_id = format!("ydoc-mat_{}", current.latest_moment_id);
        // PENDING only: a completed/conflicted job must not replay here — a
        // completed one would re-read the target on every settle (and fail
        // the whole settle pre-commit on a transient read error), and a
        // conflicted one already ran its compensation.
        if let Some(job) = store
            .load_materialization_job(&pending_job_id)?
            .filter(|job| job.status == dohc_engine_storage::JobStatus::Pending)
        {
            // Suppression BEFORE the replace, exactly like the fresh path —
            // the watcher can observe the replayed bytes the instant they
            // land; retract on a conflicted job.
            self_writes.record(&key.workspace_id, &current.path, &current.blob_sha256);
            let replay_outcome = materialize_one(
                store,
                root_dir,
                &job,
                DurabilityPolicy::per_os(),
                &StdReplacer,
                &StdBackoff,
                now_ms,
                faults,
            );
            let replay_outcome = match replay_outcome {
                Ok(outcome) => outcome,
                Err(error) => {
                    // Same crash posture as the fresh settle's transient-Err
                    // arm: the job stays pending for startup replay and the
                    // committed marker keeps a retry on this idempotent
                    // branch; only the in-memory suppression is retracted
                    // (re-recorded before the next replay attempt).
                    self_writes.retract(&key.workspace_id, &current.path, &current.blob_sha256);
                    return Err(error.into());
                }
            };
            match replay_outcome {
                JobOutcome::Completed | JobOutcome::AlreadyMaterialized => {}
                JobOutcome::Blocked => {
                    // Disk did not move and the committed marker still
                    // describes the durable pending job. Preserve it so the
                    // next settle can retry this replay after containment is
                    // restored.
                    self_writes.retract(&key.workspace_id, &current.path, &current.blob_sha256);
                    return Err(MaterializeError::SymlinkTarget.into());
                }
                JobOutcome::Conflict | JobOutcome::Superseded => {
                    self_writes.retract(&key.workspace_id, &current.path, &current.blob_sha256);
                    // The disk moved past the prior settle before its job
                    // replayed: last_settled_sha no longer describes a
                    // materialized artifact. NULL it so close(settle:false)
                    // refuses UnsettledClose instead of pruning.
                    let cleared = store.write_with(faults, |tx| {
                        tx.execute(
                            "UPDATE ydoc_docs SET last_settled_sha = NULL, updated_at_ms = ?4                              WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                            params![key.workspace_id, key.version_id, key.object_id, now_ms],
                        )
                        .map_err(StorageError::persist_public)?;
                        Ok::<_, StorageError>(())
                    })?;
                    if matches!(cleared, TxnOutcome::Crashed { .. }) {
                        return Err(RuntimeError::OperationCrashed);
                    }
                    return Err(dohc_engine_domain::DomainError::ConflictStaleTarget.into());
                }
                JobOutcome::Crashed(_) => return Err(RuntimeError::OperationCrashed),
            }
        }
    }
    // Idempotent no-op: when the lineage's last settled content is exactly
    // this projection, re-settling would mint a duplicate moment (the
    // fingerprint's previous-moment input changed) and a redundant
    // materialization job — the TS driver only settles when the projection
    // differs. Answer with the current head instead (its pending job, if
    // any, was replayed above).
    let projected_sha = dohc_engine_storage::hex_sha256(projection.markdown.as_bytes());
    if dohc_engine_collab::read_last_settled_sha(store, key)?.as_deref()
        == Some(projected_sha.as_str())
    {
        let current = head_probe.ok_or(dohc_engine_domain::DomainError::FileNotFound)?;
        return Ok(YdocSettlement {
            moment_id: current.latest_moment_id,
            path: current.path,
            markdown: current.text,
            sha256: current.blob_sha256,
            projection,
        });
    }
    let projection_for_write = projection.clone();
    let outcome = store.write_with(faults, |tx| {
        let current = select_snapshot_by_path_in_tx(tx, &key.workspace_id, &key.version_id, path)?;
        if current.binary_sha256.is_some() {
            return Err(dohc_engine_domain::DomainError::BinaryHeadNotText);
        }
        // The path may have changed owners since ydoc.open (another write
        // claimed it with a different object). Settling anyway would overwrite
        // the OTHER object's head with this session's stale projection while
        // marking this lineage settled — refuse as a stale target instead.
        if let Some(snapshot) = current.snapshot.as_ref()
            && snapshot.object_id != key.object_id
        {
            return Err(dohc_engine_domain::DomainError::ConflictStaleTarget);
        }
        // SAME-object divergence: capture (an external disk edit) or another
        // writer may have advanced this object's head since the session's
        // expectation (the open-time head, or its own last settle). Settling
        // anyway would overwrite those newer bytes with a projection the
        // user never saw — refuse; the client resyncs/merges.
        let current_sha = current
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.blob_sha256.clone());
        if current_sha != expected_head_sha {
            return Err(dohc_engine_domain::DomainError::ConflictStaleTarget);
        }
        let preimage = current
            .snapshot
            .as_ref()
            .map_or(Preimage::Absent, |snapshot| {
                Preimage::Present(snapshot.blob_sha256.clone())
            });
        let previous_moment = current
            .snapshot
            .as_ref()
            .map_or("absent", |snapshot| snapshot.latest_moment_id.as_str());
        let fingerprint = format!(
            "{}\0{}\0{}\0{}\0{}\0{}\0{}",
            key.workspace_id,
            key.version_id,
            key.object_id,
            path,
            session_id,
            previous_moment,
            projection_for_write.source_state_vector_sha256,
        );
        let moment_id = format!(
            "moment-ydoc-{}",
            dohc_engine_storage::hex_sha256(fingerprint.as_bytes())
        );
        let result = write_projected_text_in_tx(
            tx,
            &WriteText {
                workspace_id: key.workspace_id.clone(),
                version_id: key.version_id.clone(),
                object_id: key.object_id.clone(),
                path: path.to_owned(),
                text: projection_for_write.markdown.clone(),
                moment_id,
                metadata_origin: "ydoc".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms,
                request_id: None,
            },
        )?;
        if !result.deduped {
            upsert_file_search_index(
                tx,
                root_dir,
                &key.workspace_id,
                &key.version_id,
                &result.snapshot.object_id,
                &result.snapshot.path,
                &result.snapshot.text,
            )
            .map_err(search_domain)?;
        }
        enqueue_write(tx, &result, preimage, "ydoc")?;
        // The settle marker commits ATOMICALLY with the moment: a crash can
        // never leave a minted settlement moment whose lineage still reads
        // as unsettled (which would force a non-idempotent re-settle — the
        // moment fingerprint includes the per-open session_id). The PRIOR
        // marker values ride along so a materialization conflict below can
        // compensate — an errored settle must not leave a marker that lets
        // close(settle:false) prune the CRDT with no artifact on disk.
        //
        // settle_seq namespace: the daemon settle path owns this column and
        // writes moment_order into it; collab settle()'s +1 generation
        // counter is never invoked on daemon-settled lineages (C1 has no
        // collab-settle caller). The close guard reads last_settled_sha only.
        let prior_marker: (i64, Option<String>) = tx
            .query_row(
                "SELECT settle_seq, last_settled_sha FROM ydoc_docs \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                params![key.workspace_id, key.version_id, key.object_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| {
                dohc_engine_domain::DomainError::Storage(StorageError::persist_public(error))
            })?;
        tx.execute(
            "UPDATE ydoc_docs SET settle_seq = ?4, last_settled_sha = ?5, updated_at_ms = ?6 \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                result.moment.moment_order,
                result.snapshot.blob_sha256,
                now_ms,
            ],
        )
        .map_err(|error| {
            dohc_engine_domain::DomainError::Storage(StorageError::persist_public(error))
        })?;
        Ok((result, prior_marker))
    })?;
    let (write, prior_marker) = match outcome {
        TxnOutcome::Committed(write) => write,
        TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
    };
    // NO cancellation checks past this point: the settle marker committed
    // with the moment above, so a Cancelled return here would report failure
    // for a settle the lineage already records — and close(settle:false)
    // could then prune the CRDT with the artifact never materialized or
    // suppressed. Once committed, the settle runs to completion.
    //
    // The suppression identity registers BEFORE the file replace: the watcher
    // can observe the materialized bytes the instant they land, and a
    // record-after-replace left a window where capture queued an ingest that
    // would claim the settle as an external edit.
    self_writes.record(
        &key.workspace_id,
        &write.snapshot.path,
        &write.snapshot.blob_sha256,
    );
    let job_id = format!("ydoc-mat_{}", write.moment.moment_id);
    let job = store.load_materialization_job(&job_id)?.ok_or_else(|| {
        RuntimeError::Domain(dohc_engine_domain::DomainError::StateCorrupt {
            reason: "Y.Doc settle materialization job is missing",
        })
    })?;
    let job_outcome = materialize_one(
        store,
        root_dir,
        &job,
        DurabilityPolicy::per_os(),
        &StdReplacer,
        &StdBackoff,
        now_ms,
        faults,
    );
    let job_outcome = match job_outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            // A transient materialization ERROR (sharing violation, IO)
            // leaves the crash-consistent state on purpose: the settle
            // committed durably (marker, moment, snapshot) and the job stays
            // pending for startup replay, exactly as if the process had died
            // between the commit and the replace. Rolling the marker back to
            // the PRIOR head would make every retry compare the advanced
            // head against a stale expectation — permanent
            // ConflictStaleTarget — while the committed marker routes a
            // retry through the idempotent no-op branch, which replays the
            // pending job. Only the in-memory suppression identity is
            // retracted; the no-op replay re-records it before the replace.
            let _ = prior_marker;
            self_writes.retract(
                &key.workspace_id,
                &write.snapshot.path,
                &write.snapshot.blob_sha256,
            );
            return Err(error.into());
        }
    };
    match job_outcome {
        JobOutcome::Completed | JobOutcome::AlreadyMaterialized => {}
        JobOutcome::Blocked => {
            // This is the same crash-consistent state as dying after the
            // marker/job commit: the write is durably pending and will land
            // once containment is restored. Keep both the advanced marker and
            // the self-write registration, and report the committed settle.
        }
        JobOutcome::Conflict | JobOutcome::Superseded => {
            // The target changed on disk and the job left it untouched: this
            // settle FAILED, so the marker committed above must not stand —
            // it would let close(settle:false) pass the settled check and
            // prune the CRDT while the artifact was never materialized.
            // (A crash before this compensation is the pending-job case: the
            // job itself is durable and drains on reopen.)
            let compensated = store.write_with(faults, |tx| {
                tx.execute(
                    "UPDATE ydoc_docs SET settle_seq = ?4, last_settled_sha = ?5, \
                     updated_at_ms = ?6 \
                     WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                    params![
                        key.workspace_id,
                        key.version_id,
                        key.object_id,
                        prior_marker.0,
                        prior_marker.1,
                        now_ms,
                    ],
                )
                .map_err(StorageError::persist_public)?;
                Ok::<_, StorageError>(())
            })?;
            if matches!(compensated, TxnOutcome::Crashed { .. }) {
                return Err(RuntimeError::OperationCrashed);
            }
            self_writes.retract(
                &key.workspace_id,
                &write.snapshot.path,
                &write.snapshot.blob_sha256,
            );
            return Err(dohc_engine_domain::DomainError::ConflictStaleTarget.into());
        }
        JobOutcome::Crashed(_) => return Err(RuntimeError::OperationCrashed),
    }
    Ok(YdocSettlement {
        moment_id: write.moment.moment_id,
        path: write.snapshot.path,
        markdown: write.snapshot.text,
        sha256: write.snapshot.blob_sha256,
        projection,
    })
}

fn ydoc_resync_on_store(
    store: &mut EngineStore,
    key: &DocKey,
    token: &CancellationToken,
) -> Result<Vec<u8>, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    // Resync is the staleness RECOVERY path: an envelope acked-but-deferred
    // because THIS session held the lease may be the very edit that made the
    // client stale — drain it first or the recovery response still misses it.
    if dohc_engine_collab::read_marker(store, key)?
        .is_some_and(|marker| marker.regime == Regime::Replicated)
    {
        dohc_engine_sync::drain_deferred_ydoc_for_key(store, key, &NoFaults)?;
    }
    Ok(match dohc_engine_collab::load_persisted(store, key)? {
        Some(persisted) => persisted.doc.encode_full_state(),
        None => Ydoc::wire().encode_full_state(),
    })
}

fn ydoc_close_session_on_store(
    store: &mut EngineStore,
    key: &DocKey,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<Option<CloseOutcome>, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let Some(marker) = dohc_engine_collab::read_marker(store, key)? else {
        return Ok(None);
    };
    // Richdoc lineages persist their closed CRDT state: C1 has no richdoc
    // markdown settle, so the local-only prune's markdown-is-the-artifact
    // premise doesn't hold — pruning would discard the only copy.
    let persist_closed_state = marker.content_kind == ContentKind::Richdoc;
    let outcome = match dohc_engine_collab::close_session(
        store,
        key,
        persist_closed_state,
        faults,
        now_ms,
    )? {
        TxnOutcome::Committed(outcome) => outcome,
        TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
    };
    if marker.regime == Regime::Replicated {
        // The drain PROJECTS internally now (idempotent-by-sha, dependency-
        // gated): drained remote content reaches the visible head with no
        // session left to settle it.
        dohc_engine_sync::drain_deferred_ydoc_for_key(store, key, faults)?;
    }
    Ok(Some(outcome))
}

fn versioned_text_write_on_store(
    store: &mut EngineStore,
    input: &WriteText,
    root_dir: Option<&std::path::Path>,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<WriteResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    ensure_mutation_version_on_store(
        store,
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let Some(root_dir) = root_dir else {
        return VersionedTextStore::new(store)
            .write_text(input, faults)
            .map_err(RuntimeError::from);
    };
    let outcome = store.write_with(faults, |tx| {
        let result = write_text_in_tx(tx, input).map_err(RuntimeError::from)?;
        if !result.deduped {
            upsert_file_search_index(
                tx,
                root_dir,
                &input.workspace_id,
                &input.version_id,
                &result.snapshot.object_id,
                &result.snapshot.path,
                &result.snapshot.text,
            )
            .map_err(RuntimeError::from)?;
        }
        Ok::<_, RuntimeError>(result)
    })?;
    match outcome {
        TxnOutcome::Committed(result) => Ok(result),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn versioned_binary_write_on_store(
    store: &mut EngineStore,
    input: &WriteBinary,
    root_dir: &std::path::Path,
    self_writes: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<BinaryWriteExecutionResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    ensure_mutation_version_on_store(
        store,
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    let outcome = store.write_with(faults, |tx| {
        let result = write_binary_in_tx(tx, input).map_err(RuntimeError::from)?;
        if !result.deduped {
            delete_file_search_index(
                tx,
                &input.workspace_id,
                &input.version_id,
                &result.object_id,
            )
            .map_err(RuntimeError::from)?;
        }
        Ok::<_, RuntimeError>(result)
    })?;
    let result = match outcome {
        TxnOutcome::Committed(result) => result,
        TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
    };
    if !result.deduped && !result.materialize_enqueued {
        // A NON-ACTIVE version write is DB-only. Disk mirrors the active
        // version, so there is no job to run and no self-write to suppress.
        return Ok(BinaryWriteExecutionResult {
            write: result,
            materialized: false,
            materialize_outcome: PostCommitMaterializeOutcome::Skipped,
        });
    }

    // Request-ledger reconstruction returns the ORIGINAL moment. A replay must
    // probe that moment's durable job, not the caller's newly supplied id: a
    // transient first materialization can leave the original job pending.
    let job = match store.load_materialization_job(&result.moment.moment_id) {
        Ok(Some(job)) => job,
        Ok(None) if result.deduped => {
            return Ok(BinaryWriteExecutionResult {
                write: result,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Skipped,
            });
        }
        Ok(None) => {
            return Ok(BinaryWriteExecutionResult {
                write: result,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Error,
            });
        }
        Err(error) => {
            // The wire result self-describes the outcome; stderr keeps the
            // server-side trail (the DOP1 wire owns stdin/stdout).
            eprintln!(
                "engine: binary write committed but loading its materialization job failed: {error}"
            );
            return Ok(BinaryWriteExecutionResult {
                write: result,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Error,
            });
        }
    };
    if result.deduped && job.status != JobStatus::Pending {
        return Ok(BinaryWriteExecutionResult {
            write: result,
            materialized: false,
            materialize_outcome: PostCommitMaterializeOutcome::Skipped,
        });
    }
    let (materialized, materialize_outcome) = materialize_pending_job(
        store,
        root_dir,
        &input.workspace_id,
        &job,
        self_writes,
        input.now_ms,
        faults,
    );
    Ok(BinaryWriteExecutionResult {
        write: result,
        materialized,
        materialize_outcome,
    })
}

fn materialize_pending_job(
    store: &EngineStore,
    root_dir: &std::path::Path,
    workspace_id: &str,
    job: &MaterializationJob,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> (bool, PostCommitMaterializeOutcome) {
    // Register before replacement: the watcher may observe the write as soon
    // as the atomic rename lands. Every non-applied outcome retracts the
    // identity because no self-write is then available to consume it.
    self_writes.record(workspace_id, &job.target_path, &job.content_sha256);
    let outcome = materialize_one(
        store,
        root_dir,
        job,
        DurabilityPolicy::per_os(),
        &StdReplacer,
        &StdBackoff,
        now_ms,
        faults,
    );
    let (materialized, reported) = match outcome {
        Ok(JobOutcome::Completed | JobOutcome::AlreadyMaterialized) => {
            (true, PostCommitMaterializeOutcome::Applied)
        }
        Ok(JobOutcome::Blocked) => (false, PostCommitMaterializeOutcome::Skipped),
        Ok(JobOutcome::Conflict) => (false, PostCommitMaterializeOutcome::Conflict),
        Ok(JobOutcome::Superseded) => (false, PostCommitMaterializeOutcome::Superseded),
        Ok(JobOutcome::Crashed(_)) => (false, PostCommitMaterializeOutcome::Error),
        Err(error) => {
            eprintln!(
                "engine: post-commit materialization failed for {}: {error}",
                job.target_path
            );
            (false, PostCommitMaterializeOutcome::Error)
        }
    };
    if !materialized {
        self_writes.retract(workspace_id, &job.target_path, &job.content_sha256);
    }
    (materialized, reported)
}

fn search_domain(error: crate::search::SearchError) -> dohc_engine_domain::DomainError {
    match error {
        crate::search::SearchError::Storage(error) => {
            dohc_engine_domain::DomainError::Storage(StorageError::persist_public(error))
        }
        crate::search::SearchError::Store(error) => dohc_engine_domain::DomainError::Storage(error),
        crate::search::SearchError::Corrupt(reason)
        | crate::search::SearchError::Bounds(reason) => {
            dohc_engine_domain::DomainError::StateCorrupt { reason }
        }
    }
}

fn versioned_text_rename_on_store(
    store: &mut EngineStore,
    input: &RenameTextFile,
    root_dir: &std::path::Path,
    self_writes: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<RenameResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let result = VersionedTextStore::new(store)
        .rename_text_file_with(input, faults, |tx, result| {
            delete_file_search_index(
                tx,
                &input.workspace_id,
                &input.version_id,
                &result.object.object_id,
            )
            .map_err(search_domain)?;
            if result.moment.after_content_kind == "text" {
                upsert_file_search_index(
                    tx,
                    root_dir,
                    &input.workspace_id,
                    &input.version_id,
                    &result.object.object_id,
                    &result.after.path,
                    &result.after.text,
                )
                .map_err(search_domain)?;
            }
            enqueue_binary_rename(tx, result)?;
            Ok(())
        })
        .map_err(RuntimeError::from)?;
    if result.moment.after_content_kind == "binary" {
        let write_ready = materialize_expected_job(
            store,
            root_dir,
            &input.workspace_id,
            &binary_rename_write_job_id(&result.moment.moment_id),
            self_writes,
            result.moment.recorded_at_ms,
            faults,
        );
        if write_ready {
            materialize_expected_job(
                store,
                root_dir,
                &input.workspace_id,
                &binary_rename_delete_job_id(&result.moment.moment_id),
                self_writes,
                result.moment.recorded_at_ms,
                faults,
            );
        }
    }
    Ok(result)
}

fn versioned_text_delete_on_store(
    store: &mut EngineStore,
    input: &DeleteTextFile,
    root_dir: &std::path::Path,
    self_writes: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<DeleteResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let outcome = store.write_with(faults, |tx| {
        let result =
            dohc_engine_domain::delete_text_in_tx(tx, input).map_err(RuntimeError::from)?;
        if !result.deduped {
            delete_file_search_index(
                tx,
                &input.workspace_id,
                &input.version_id,
                &result.object.object_id,
            )
            .map_err(RuntimeError::from)?;
            enqueue_binary_delete(tx, &result).map_err(RuntimeError::from)?;
        }
        Ok::<_, RuntimeError>(result)
    })?;
    match outcome {
        TxnOutcome::Committed(result) => {
            if result.moment.before_content_kind == "binary" {
                materialize_expected_job(
                    store,
                    root_dir,
                    &input.workspace_id,
                    &binary_delete_job_id(&result.moment.moment_id),
                    self_writes,
                    result.moment.recorded_at_ms,
                    faults,
                );
            }
            Ok(result)
        }
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn materialize_expected_job(
    store: &EngineStore,
    root_dir: &std::path::Path,
    workspace_id: &str,
    job_id: &str,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> bool {
    let job = match store.load_materialization_job(job_id) {
        Ok(Some(job)) => job,
        Ok(None) => return false,
        Err(error) => {
            eprintln!("engine: loading post-commit materialization job failed: {error}");
            return false;
        }
    };
    match job.status {
        JobStatus::Complete => true,
        JobStatus::Pending => {
            materialize_pending_job(
                store,
                root_dir,
                workspace_id,
                &job,
                self_writes,
                now_ms,
                faults,
            )
            .0
        }
        JobStatus::Conflict => false,
    }
}

fn versioned_text_rollback_on_store(
    store: &mut EngineStore,
    input: &RollbackTextFileMutation,
    root_dir: &std::path::Path,
    self_writes: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<RollbackExecutionResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let deduped = VersionedTextStore::new(store).rollback_text_file_mutation_with(
        input,
        faults,
        |tx, object_id, restored_text| {
            delete_file_search_index(tx, &input.workspace_id, &input.version_id, object_id)
                .map_err(search_domain)?;
            if let Some((path, text)) = restored_text {
                upsert_file_search_index(
                    tx,
                    root_dir,
                    &input.workspace_id,
                    &input.version_id,
                    object_id,
                    path,
                    text,
                )
                .map_err(search_domain)?;
            }
            Ok(())
        },
    )?;
    let job_id = binary_rollback_job_identity(
        &input.workspace_id,
        &input.version_id,
        &input.mutation_moment_id,
    );
    let rename_write_job_id = binary_rename_write_job_id(&job_id);
    let rename_delete_job_id = binary_rename_delete_job_id(&job_id);
    // The rollback tx is already committed: a failed job load must not turn
    // into an RPC refusal — the caller would believe a durable rollback
    // failed. Mirror the binary-write seam and self-describe the outcome.
    let (job, rename_write_job, rename_delete_job) = match (
        store.load_materialization_job(&job_id),
        store.load_materialization_job(&rename_write_job_id),
        store.load_materialization_job(&rename_delete_job_id),
    ) {
        (Ok(job), Ok(rename_write_job), Ok(rename_delete_job)) => {
            (job, rename_write_job, rename_delete_job)
        }
        _ => {
            eprintln!("engine: rollback committed but loading its restore job(s) failed");
            return Ok(RollbackExecutionResult {
                deduped,
                materialize_enqueued: true,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Error,
            });
        }
    };
    // Fall back only when the new namespace is absent, preserving legacy replay
    // without mistaking an unrelated legacy collision for this rollback.
    let (job, rename_write_job, rename_delete_job) =
        if job.is_none() && rename_write_job.is_none() && rename_delete_job.is_none() {
            let legacy_job_id = format!("{ROLLBACK_RESTORE_PREFIX}{}", input.mutation_moment_id);
            let legacy_write_job_id = binary_rename_write_job_id(&legacy_job_id);
            let legacy_delete_job_id = binary_rename_delete_job_id(&legacy_job_id);
            match (
                store.load_materialization_job(&legacy_job_id),
                store.load_materialization_job(&legacy_write_job_id),
                store.load_materialization_job(&legacy_delete_job_id),
            ) {
                (Ok(job), Ok(write_job), Ok(delete_job)) => (job, write_job, delete_job),
                _ => {
                    eprintln!(
                        "engine: rollback committed but loading its legacy restore job(s) failed"
                    );
                    return Ok(RollbackExecutionResult {
                        deduped,
                        materialize_enqueued: true,
                        materialized: false,
                        materialize_outcome: PostCommitMaterializeOutcome::Error,
                    });
                }
            }
        } else {
            (job, rename_write_job, rename_delete_job)
        };
    let has_jobs = job.is_some() || rename_write_job.is_some() || rename_delete_job.is_some();
    if !has_jobs {
        return Ok(RollbackExecutionResult {
            deduped,
            materialize_enqueued: false,
            materialized: false,
            materialize_outcome: PostCommitMaterializeOutcome::Skipped,
        });
    }

    let active_version =
        if faults.poll(FaultPoint::RollbackBeforeActiveVersionLookup) == FaultAction::Crash {
            Err(RuntimeError::from(StorageError::corrupt_public(
                rusqlite::Error::InvalidQuery,
            )))
        } else {
            VersionedTextStore::new(store)
                .get_active_version(&input.workspace_id)
                .map_err(RuntimeError::from)
        };
    let active_version = match active_version {
        Ok(active_version) => active_version,
        Err(error) => {
            eprintln!(
                "engine: rollback committed but active-version lookup failed; \
                 restore remains pending for normal replay: {error}"
            );
            return Ok(RollbackExecutionResult {
                deduped,
                materialize_enqueued: true,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Error,
            });
        }
    };
    let target_is_active = active_version.version_id == input.version_id;
    if !target_is_active {
        if let Err(error) = reconcile_active_plaintext_projection_on_store(
            store,
            &input.workspace_id,
            &active_version.version_id,
            &input.version_id,
            root_dir,
            self_writes,
            job.as_ref()
                .or(rename_write_job.as_ref())
                .or(rename_delete_job.as_ref())
                .map_or(0, |job| job.created_at_ms),
            faults,
            token,
        ) {
            eprintln!(
                "engine: rollback committed but reconciling the active disk projection failed: \
                 {error}"
            );
            return Ok(RollbackExecutionResult {
                deduped,
                materialize_enqueued: true,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Error,
            });
        }
        return Ok(RollbackExecutionResult {
            deduped,
            materialize_enqueued: true,
            materialized: false,
            materialize_outcome: PostCommitMaterializeOutcome::Skipped,
        });
    }

    if let Some(job) = job {
        if deduped && job.status != JobStatus::Pending {
            return Ok(RollbackExecutionResult {
                deduped: true,
                materialize_enqueued: false,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Skipped,
            });
        }
        let (materialized, materialize_outcome) = match job.status {
            JobStatus::Complete => (true, PostCommitMaterializeOutcome::Applied),
            JobStatus::Pending => materialize_pending_job(
                store,
                root_dir,
                &input.workspace_id,
                &job,
                self_writes,
                job.created_at_ms,
                faults,
            ),
            JobStatus::Conflict => (false, PostCommitMaterializeOutcome::Conflict),
        };
        return Ok(RollbackExecutionResult {
            deduped,
            materialize_enqueued: true,
            materialized,
            materialize_outcome,
        });
    }

    let (Some(write_job), Some(delete_job)) = (rename_write_job, rename_delete_job) else {
        eprintln!("engine: rollback committed with an incomplete rename restore job pair");
        return Ok(RollbackExecutionResult {
            deduped,
            materialize_enqueued: true,
            materialized: false,
            materialize_outcome: PostCommitMaterializeOutcome::Error,
        });
    };
    if deduped && write_job.status != JobStatus::Pending && delete_job.status != JobStatus::Pending
    {
        return Ok(RollbackExecutionResult {
            deduped: true,
            materialize_enqueued: false,
            materialized: false,
            materialize_outcome: PostCommitMaterializeOutcome::Skipped,
        });
    }
    let (write_materialized, write_outcome) = match write_job.status {
        JobStatus::Complete => (true, PostCommitMaterializeOutcome::Applied),
        JobStatus::Pending => materialize_pending_job(
            store,
            root_dir,
            &input.workspace_id,
            &write_job,
            self_writes,
            write_job.created_at_ms,
            faults,
        ),
        JobStatus::Conflict => (false, PostCommitMaterializeOutcome::Conflict),
    };
    if !write_materialized {
        if write_outcome == PostCommitMaterializeOutcome::Conflict
            && let Err(error) =
                store.mark_materialization_conflict(&delete_job.job_id, write_job.created_at_ms)
        {
            eprintln!(
                "engine: rollback rename write conflicted but terminalizing its paired delete \
                 failed: {error}"
            );
        }
        return Ok(RollbackExecutionResult {
            deduped,
            materialize_enqueued: true,
            materialized: false,
            materialize_outcome: write_outcome,
        });
    }
    let delete_job = match store.load_materialization_job(&delete_job.job_id) {
        Ok(Some(job)) => job,
        Ok(None) | Err(_) => {
            return Ok(RollbackExecutionResult {
                deduped,
                materialize_enqueued: true,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Error,
            });
        }
    };
    let (materialized, materialize_outcome) = match delete_job.status {
        JobStatus::Complete => (true, PostCommitMaterializeOutcome::Applied),
        JobStatus::Pending => materialize_pending_job(
            store,
            root_dir,
            &input.workspace_id,
            &delete_job,
            self_writes,
            delete_job.created_at_ms,
            faults,
        ),
        JobStatus::Conflict => (false, PostCommitMaterializeOutcome::Conflict),
    };
    Ok(RollbackExecutionResult {
        deduped,
        materialize_enqueued: true,
        materialized,
        materialize_outcome,
    })
}

fn versioned_text_merge_on_store(
    store: &mut EngineStore,
    input: &MergeTextFileFromVersion,
    root_dir: &std::path::Path,
    self_writes: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<MergeExecutionResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let target_is_active = VersionedTextStore::new(store)
        .get_active_version(&input.workspace_id)
        .map_err(RuntimeError::from)?
        .version_id
        == input.target_version_id;
    let result = VersionedTextStore::new(store)
        .merge_text_file_from_version_with(input, faults, |tx, result| {
            match result {
                MergeTextFileResult::Write { write, .. } => upsert_file_search_index(
                    tx,
                    root_dir,
                    &input.workspace_id,
                    &input.target_version_id,
                    &write.object.object_id,
                    &write.snapshot.path,
                    &write.snapshot.text,
                )
                .map_err(search_domain)?,
                MergeTextFileResult::Delete { delete, .. } => delete_file_search_index(
                    tx,
                    &input.workspace_id,
                    &input.target_version_id,
                    &delete.object.object_id,
                )
                .map_err(search_domain)?,
                MergeTextFileResult::Unchanged { .. } | MergeTextFileResult::Conflict { .. } => {}
            }
            Ok(())
        })
        .map_err(RuntimeError::from)?;
    let (moment_id, deduped) = match &result {
        MergeTextFileResult::Write { write, .. } => {
            (write.moment.moment_id.as_str(), write.deduped)
        }
        MergeTextFileResult::Delete { delete, .. } => {
            (delete.moment.moment_id.as_str(), delete.deduped)
        }
        MergeTextFileResult::Unchanged { .. } | MergeTextFileResult::Conflict { .. } => {
            return Ok(MergeExecutionResult {
                merge: result,
                materialize_enqueued: false,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Skipped,
            });
        }
    };
    if !target_is_active {
        return Ok(MergeExecutionResult {
            merge: result,
            materialize_enqueued: false,
            materialized: false,
            materialize_outcome: PostCommitMaterializeOutcome::Skipped,
        });
    }

    let job_id = format!("merge-mat_{moment_id}");
    let job = match store.load_materialization_job(&job_id) {
        Ok(Some(job)) => job,
        Ok(None) if deduped => {
            return Ok(MergeExecutionResult {
                merge: result,
                materialize_enqueued: false,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Skipped,
            });
        }
        Ok(None) => {
            return Ok(MergeExecutionResult {
                merge: result,
                materialize_enqueued: true,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Error,
            });
        }
        Err(error) => {
            eprintln!(
                "engine: merge committed but loading its materialization job failed: {error}"
            );
            return Ok(MergeExecutionResult {
                merge: result,
                materialize_enqueued: !deduped,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Error,
            });
        }
    };
    if deduped && job.status != JobStatus::Pending {
        return Ok(MergeExecutionResult {
            merge: result,
            materialize_enqueued: false,
            materialized: false,
            materialize_outcome: PostCommitMaterializeOutcome::Skipped,
        });
    }
    let (materialized, materialize_outcome) = materialize_pending_job(
        store,
        root_dir,
        &input.workspace_id,
        &job,
        self_writes,
        input.now_ms,
        faults,
    );
    Ok(MergeExecutionResult {
        merge: result,
        materialize_enqueued: !deduped,
        materialized,
        materialize_outcome,
    })
}

fn capture_ingest_on_store(
    store: &mut EngineStore,
    input: &CaptureIngest,
    root_dir: Option<&std::path::Path>,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<WriteResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    ensure_mutation_version_on_store(
        store,
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let outcome = store.write_with(faults, |tx| {
        let result = capture_ingest_in_tx(tx, input).map_err(RuntimeError::from)?;
        if !result.deduped
            && let Some(root_dir) = root_dir
        {
            upsert_file_search_index(
                tx,
                root_dir,
                &input.workspace_id,
                &input.version_id,
                &result.snapshot.object_id,
                &result.snapshot.path,
                &result.snapshot.text,
            )
            .map_err(RuntimeError::from)?;
        }
        Ok::<_, RuntimeError>(result)
    })?;
    match outcome {
        TxnOutcome::Committed(result) => Ok(result),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn capture_ingest_binary_on_store(
    store: &mut EngineStore,
    input: &CaptureIngestBinary,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<CaptureIngestBinaryResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    ensure_mutation_version_on_store(
        store,
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let outcome = store.write_with(faults, |tx| {
        let result = capture_ingest_binary_in_tx(tx, input).map_err(RuntimeError::from)?;
        if !result.deduped {
            delete_file_search_index(
                tx,
                &input.workspace_id,
                &input.version_id,
                &result.object_id,
            )
            .map_err(RuntimeError::from)?;
        }
        Ok::<_, RuntimeError>(result)
    })?;
    match outcome {
        TxnOutcome::Committed(result) => Ok(result),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn capture_secret_on_store(
    store: &mut EngineStore,
    input: &CaptureSecret,
    key: &SecretDataKey,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<SecretWriteResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    ensure_mutation_version_on_store(
        store,
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    SecretFileStore::new(store, key)
        .capture_secret(input, faults)
        .map_err(RuntimeError::from)
}

fn capture_secret_retire_on_store(
    store: &mut EngineStore,
    input: &CaptureSecretRetire,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<Option<SecretMomentRecord>, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    ensure_mutation_version_on_store(
        store,
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    capture_secret_retire(store, input, faults).map_err(RuntimeError::from)
}

fn capture_retire_on_store(
    store: &mut EngineStore,
    input: &CaptureRetire,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<CaptureRetireResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    ensure_mutation_version_on_store(
        store,
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let outcome = store.write_with(faults, |tx| {
        let result = capture_retire_in_tx(tx, input).map_err(RuntimeError::from)?;
        if !result.deduped
            && let Some(retired) = result.retired.as_ref()
        {
            delete_file_search_index(
                tx,
                &input.workspace_id,
                &input.version_id,
                &retired.object.object_id,
            )
            .map_err(RuntimeError::from)?;
        }
        Ok::<_, RuntimeError>(result)
    })?;
    match outcome {
        TxnOutcome::Committed(result) => Ok(result),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn conflict_open_on_store(
    store: &mut EngineStore,
    conflict: &TextConflict,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<bool, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let outcome = store.write_with(faults, |tx| {
        let inserted = insert_text_conflict_if_absent(tx, conflict)?;
        if inserted {
            tx.execute(
                "INSERT INTO replication_journal (doc_id, op_kind, created_at_ms) \
                 VALUES (?1, 'conflict.open', ?2)",
                params![conflict.conflict_id, conflict.created_at_ms],
            )
            .map_err(|error| {
                dohc_engine_domain::DomainError::Storage(StorageError::persist_public(error))
            })?;
        }
        Ok::<_, dohc_engine_domain::DomainError>(inserted)
    })?;
    match outcome {
        TxnOutcome::Committed(inserted) => Ok(inserted),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn conflict_resolve_on_store(
    store: &mut EngineStore,
    input: &ResolveTextConflict,
    root_dir: Option<&std::path::Path>,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<ResolveTextConflictResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    VersionedTextStore::new(store)
        .resolve_text_conflict_with(input, faults, |tx, result| {
            if let Some(delete) = result.delete.as_ref() {
                delete_file_search_index(
                    tx,
                    &input.workspace_id,
                    &delete.before.version_id,
                    &delete.object.object_id,
                )
                .map_err(search_domain)?;
            }
            if let Some(write) = result.write.as_ref()
                && let Some(root_dir) = root_dir
            {
                upsert_file_search_index(
                    tx,
                    root_dir,
                    &input.workspace_id,
                    &write.snapshot.version_id,
                    &write.snapshot.object_id,
                    &write.snapshot.path,
                    &write.snapshot.text,
                )
                .map_err(search_domain)?;
            }
            Ok(())
        })
        .map_err(RuntimeError::from)
}

/// Execute a run of bounded units, checking `token` BETWEEN units. Each unit is
/// one compound write (one transaction). Stops early and reports `cancelled` if
/// the token trips at a boundary; a storage error aborts the run and surfaces.
fn run_units(
    store: &mut EngineStore,
    units: Vec<CompoundWrite>,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<UnitsOutcome, StorageError> {
    let mut committed = 0usize;
    for unit in units {
        // Cancellation point is BETWEEN units, before the next transaction.
        if token.is_cancelled() {
            return Ok(UnitsOutcome {
                committed,
                cancelled: true,
            });
        }
        match store.commit_compound(&unit, faults)? {
            WriteOutcome::Acked { .. } => committed += 1,
            // A crash fault ends the run at a durable boundary. An
            // after-commit-before-ack crash already durably committed THIS
            // unit, so count it — otherwise `committed` undercounts what the
            // database actually holds and breaks retry/progress accounting.
            WriteOutcome::Crashed { committed: durable } => {
                if durable {
                    committed += 1;
                }
                return Ok(UnitsOutcome {
                    committed,
                    cancelled: token.is_cancelled(),
                });
            }
        }
    }
    Ok(UnitsOutcome {
        committed,
        cancelled: false,
    })
}

fn snapshot(store: &EngineStore) -> Result<StoreSnapshot, StorageError> {
    Ok(StoreSnapshot {
        documents: store.document_count()?,
        journal_entries: store.journal_len()?,
        request_ledger: store.request_ledger_len()?,
        migration_ledger: store.migration_ledger_len()?,
    })
}
