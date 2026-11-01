use super::{ActorHandle, ClaimAnnouncer};
use crate::error::RuntimeError;
use dohc_engine_collab::{LeaseRegistry, WriterDocCache};
use dohc_engine_storage::{EngineStore, NoFaults, TxnOutcome};
use dohc_engine_sync::{
    BlobDownloadBatchRequest, BlobDownloadBatchResponse, BlobDownloadResponse, BlobHaveRequest,
    BlobHaveResponse, BlobUploadRequest, ClaimRequest, ClaimResponse, DirectWritePushOutcome,
    EpochRequest, EpochResponse, HostedCursor, HostedPassOutcome, HostedPullRequest,
    HostedPullResponse, KeyEnvelopeDownloadRequest, KeyEnvelopeDownloadResponse,
    KeyEnvelopeRequest, KeyEnvelopeResponse, LogCoordinateRequest, LogCoordinateResponse,
    MAX_BASE_REPAIR_LOOKUPS, MAX_BLOB_DOWNLOAD_BATCH, ProbeRequest, ProbeResponse, PullRequest,
    PullResponse, PushRequest, PushResponse, PushWorkspaceProgress, RecoverResponse, RelayCursor,
    RelayError, RelaySyncClient, RelayTransport, ShareBlobRequest, ShareBlobUploadRequest,
    ShareCollectionWriteRequest, ShareCollectionWriteResponse, ShareCursor, ShareLogPushRequest,
    ShareProposalSubmitOutcome, ShareProposalSubmitRequest, ShareProposalSubmitResponse,
    ShareViewPullOutcome, ShareViewRequest, ShareViewResponse, SharedChannelPullOutcome,
    SharedChannelPushOutcome, SharedChannelRequest, SharedChannelResponse, SyncError,
    SyncPassOutcome, adopt_join_identity, create_claim_identity, create_hosted_replica,
    is_hosted_replica, read_sync_identity,
};
use dohc_engine_sync_http::HttpRelayTransport;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

#[cfg(not(test))]
use dohc_engine_storage::NoFaults as CursorFaults;
#[cfg(test)]
use relay_push_tests::cache_tests::CursorFaults;

#[derive(Clone, PartialEq, Eq)]
pub struct RelayConfiguration {
    pub base_url: String,
    pub socket_path: Option<std::path::PathBuf>,
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
        now_ms: i64,
        max_read_bytes: usize,
    },
    Pull {
        workspace_id: String,
        now_ms: i64,
    },
    CommitCursor {
        workspace_id: String,
        cursor: RelayCursor,
        now_ms: i64,
    },
    Probe {
        workspace_id: String,
    },
    Claim {
        workspace_id: String,
        account_id: Option<String>,
        new_origin_id: String,
        new_replication_epoch: String,
        new_stream_identity: String,
        created_at_ms: i64,
    },
    AdoptJoinIdentity {
        workspace_id: String,
        new_origin_id: String,
        replication_epoch: String,
        stream_identity: String,
        created_at_ms: i64,
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
        /// The selector the relay stated for this share, pinned by the
        /// recipient on first read. Required: there is no unscoped pull.
        granted: dohc_engine_sync::ShareGrant,
    },
    /// Record an editable share view's own replica identity once, before it
    /// can submit file changes.
    ///
    /// Carries the ACCESS and nothing else of the grant. The RPC boundary
    /// still parses the whole selector, but this operation expresses exactly
    /// one decision — the level gate — and carrying paths it never reads
    /// would invite a later reader to think they matter here.
    RecordShareViewIdentity {
        workspace_id: String,
        access: dohc_engine_sync::ShareAccess,
        origin_id: String,
        replication_epoch: String,
        stream_identity: String,
        created_at_ms: i64,
    },
    /// Offer this replica's own edits of a received file share back to the
    /// granter, for the granter to accept or decline. The grant
    /// scopes the files and carries the level the client refuses below `edit`
    /// on.
    SubmitShareProposal {
        workspace_id: String,
        share_id: String,
        granted: dohc_engine_sync::ShareGrant,
        /// The idempotency key for one submit. A repeat with the same id
        /// answers with the proposal the relay already holds and never opens a
        /// second one.
        submit_id: String,
        max_read_bytes: usize,
    },
    /// Write this replica's changes to a Collection's own files directly into
    /// the granter's workspace. Every other change stays on proposals.
    PushDirectWrites {
        workspace_id: String,
        share_id: String,
        granted: dohc_engine_sync::ShareGrant,
        max_read_bytes: usize,
    },
    CommitShareViewCursor {
        workspace_id: String,
        cursor: ShareCursor,
    },
    /// Make a pristine workspace the session host's hosted replica under the
    /// relay's coordinate, before any other write gives it an ordinary one.
    /// Then confirm the relay holds nothing of its origin past what it
    /// numbered. Every attach runs this before its first other hosted call,
    /// so a store that lost pushed commits stops before anyone edits it.
    CreateHostedReplica {
        workspace_id: String,
        new_origin_id: String,
        replication_epoch: String,
        stream_identity: String,
        created_at_ms: i64,
    },
    /// One pass of the hosted feed. Its cursor commits with
    /// `CommitHostedCursor` once its changed paths are materialized. A pass
    /// that adopts a new scope, and every commit, then park the documents
    /// that left the scope, as `root` holds them. `relay_namespace` is the
    /// feed's, as the configured host names it.
    PullHosted {
        workspace_id: String,
        root: std::path::PathBuf,
        relay_namespace: String,
        now_ms: i64,
    },
    CommitHostedCursor {
        workspace_id: String,
        cursor: HostedCursor,
        root: std::path::PathBuf,
        now_ms: i64,
    },
}

impl RelayOperation {
    fn workspace_id(&self) -> &str {
        match self {
            Self::Push { workspace_id, .. }
            | Self::Pull { workspace_id, .. }
            | Self::CommitCursor { workspace_id, .. }
            | Self::Probe { workspace_id }
            | Self::Claim { workspace_id, .. }
            | Self::AdoptJoinIdentity { workspace_id, .. }
            | Self::RecoverOrigin { workspace_id, .. }
            | Self::UploadKeyEnvelope { workspace_id, .. }
            | Self::DownloadKeyEnvelope { workspace_id }
            | Self::PullSharedChannel { workspace_id, .. }
            | Self::PushSharedChannel { workspace_id, .. }
            | Self::PullShareView { workspace_id, .. }
            | Self::RecordShareViewIdentity { workspace_id, .. }
            | Self::SubmitShareProposal { workspace_id, .. }
            | Self::PushDirectWrites { workspace_id, .. }
            | Self::CommitShareViewCursor { workspace_id, .. }
            | Self::CreateHostedReplica { workspace_id, .. }
            | Self::PullHosted { workspace_id, .. }
            | Self::CommitHostedCursor { workspace_id, .. } => workspace_id,
        }
    }

    /// The replicas this operation runs on. A push goes to whichever log
    /// its replica writes.
    fn replicas(&self) -> Replicas {
        match self {
            Self::Push { .. } => Replicas::Both,
            Self::CreateHostedReplica { .. }
            | Self::PullHosted { .. }
            | Self::CommitHostedCursor { .. } => Replicas::Hosted,
            Self::Pull { .. }
            | Self::CommitCursor { .. }
            | Self::Probe { .. }
            | Self::Claim { .. }
            | Self::AdoptJoinIdentity { .. }
            | Self::RecoverOrigin { .. }
            | Self::UploadKeyEnvelope { .. }
            | Self::DownloadKeyEnvelope { .. }
            | Self::PullSharedChannel { .. }
            | Self::PushSharedChannel { .. }
            | Self::PullShareView { .. }
            | Self::RecordShareViewIdentity { .. }
            | Self::SubmitShareProposal { .. }
            | Self::PushDirectWrites { .. }
            | Self::CommitShareViewCursor { .. } => Replicas::Ordinary,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Replicas {
    Ordinary,
    Hosted,
    Both,
}

const RELAY_IO_PENDING: &str = "relay-io-pending";
// A relay worker task ended without an answer: it panicked, or its runtime
// dropped it. That is a failure on this machine, not a network one, so it must
// not read as an unreachable server.
const RELAY_IO_ABORTED: &str = "relay-io-aborted";

#[derive(Debug, Clone, PartialEq, Eq)]
enum RelayIoRequest {
    Push(PushRequest),
    Pull(PullRequest),
    PushHosted(PushRequest),
    PullHosted(HostedPullRequest),
    LookupCoordinates(Vec<LogCoordinateRequest>),
    Probe(ProbeRequest),
    Claim(ClaimRequest),
    RotateEpoch(EpochRequest),
    BlobsHave(BlobHaveRequest),
    UploadBlob(BlobUploadRequest),
    UploadBlobs(Vec<BlobUploadRequest>),
    DownloadBlobs(BlobDownloadBatchRequest),
    UploadKeyEnvelope(KeyEnvelopeRequest),
    DownloadKeyEnvelope(KeyEnvelopeDownloadRequest),
    SharedChannelPull(SharedChannelRequest),
    ShareLogPush(ShareLogPushRequest),
    ShareViewPull(ShareViewRequest),
    ShareBlob(ShareBlobRequest),
    ShareBlobUpload(ShareBlobUploadRequest),
    ShareProposalSubmit(ShareProposalSubmitRequest),
    ShareCollectionWrite(ShareCollectionWriteRequest),
}

impl RelayIoRequest {
    /// Whether the relay may store something once this request is issued.
    fn changes_relay(&self) -> bool {
        !matches!(
            self,
            RelayIoRequest::Pull(_)
                | RelayIoRequest::PullHosted(_)
                | RelayIoRequest::LookupCoordinates(_)
                | RelayIoRequest::Probe(_)
                | RelayIoRequest::BlobsHave(_)
                | RelayIoRequest::DownloadBlobs(_)
                | RelayIoRequest::DownloadKeyEnvelope(_)
                | RelayIoRequest::SharedChannelPull(_)
                | RelayIoRequest::ShareViewPull(_)
                | RelayIoRequest::ShareBlob(_)
        )
    }
}

#[derive(Debug, Clone)]
enum RelayIoResponse {
    /// Answers both log pushes.
    Push(PushResponse),
    Pull(PullResponse),
    PullHosted(HostedPullResponse),
    LookupCoordinates(Vec<LogCoordinateResponse>),
    Probe(ProbeResponse),
    Claim(ClaimResponse),
    RotateEpoch(EpochResponse),
    BlobsHave(BlobHaveResponse),
    UploadBlob,
    DownloadBlobs(BlobDownloadBatchResponse),
    UploadKeyEnvelope(KeyEnvelopeResponse),
    DownloadKeyEnvelope(KeyEnvelopeDownloadResponse),
    SharedChannelPull(SharedChannelResponse),
    ShareLogPush(PushResponse),
    ShareViewPull(ShareViewResponse),
    ShareBlob(BlobDownloadResponse),
    ShareBlobUpload,
    ShareProposalSubmit(ShareProposalSubmitResponse),
    ShareCollectionWrite(ShareCollectionWriteResponse),
}

#[derive(Default)]
struct DeferredRelayState {
    completed: Vec<(RelayIoRequest, Result<RelayIoResponse, RelayError>)>,
    pending: Option<RelayIoRequest>,
    workspace_pushed: usize,
    share_log_pushed: usize,
}

/// One pull request at a time on a store, held from its fetch through every
/// wait for released-tail validation to its outcome: another pull's drain
/// would reclaim the owner settlements this one's report already owns.
#[derive(Clone, Default)]
pub(super) struct PullPermit {
    held: Arc<tokio::sync::Mutex<()>>,
    /// Woken each time a pull finds the permit held.
    #[cfg(feature = "test-support")]
    pub(super) waited: Arc<tokio::sync::Notify>,
}

impl PullPermit {
    /// The permit once no other pull holds it, or none if `token` is
    /// cancelled first. Dropping it releases it.
    async fn acquire(
        &self,
        token: &CancellationToken,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, RuntimeError> {
        if let Ok(held) = Arc::clone(&self.held).try_lock_owned() {
            return Ok(held);
        }
        #[cfg(feature = "test-support")]
        self.waited.notify_one();
        tokio::select! {
            biased;
            () = token.cancelled() => Err(RuntimeError::Cancelled),
            held = Arc::clone(&self.held).lock_owned() => Ok(held),
        }
    }
}

#[derive(Clone, Default)]
struct DeferredRelayTransport {
    native_settlements: bool,
    state: Arc<Mutex<DeferredRelayState>>,
    push_progress: Arc<Mutex<PushWorkspaceProgress>>,
    /// The pull pass this request stopped for released-tail validation.
    continuation: dohc_engine_sync::PullContinuation,
}

impl DeferredRelayTransport {
    fn resolve<T>(
        &self,
        request: RelayIoRequest,
        project: impl Fn(&mut RelayIoResponse) -> Option<T>,
    ) -> Result<T, RelayError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(index) = state
            .completed
            .iter()
            .position(|(completed, _)| same_io_request(completed, &request))
        {
            // Only the stable repair probe must survive operation replay.
            let release = !matches!(&state.completed[index].0, RelayIoRequest::Push(push) if push.ops.is_empty() && push.after_seq == -1)
                && matches!(
                    state.completed[index].0,
                    RelayIoRequest::Push(_)
                        | RelayIoRequest::PushHosted(_)
                        | RelayIoRequest::ShareLogPush(_)
                        | RelayIoRequest::DownloadBlobs(_)
                        | RelayIoRequest::UploadKeyEnvelope(_)
                        | RelayIoRequest::DownloadKeyEnvelope(_)
                        | RelayIoRequest::ShareBlob(_)
                        | RelayIoRequest::ShareProposalSubmit(_)
                );
            let projected = match &mut state.completed[index].1 {
                Ok(response) => project(response).ok_or(RelayError::InvalidResponse),
                Err(error) => Err(error.clone()),
            };
            if release && projected.is_ok() {
                let _ = state.completed.swap_remove(index);
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
        if let (RelayIoRequest::BlobsHave(have), Ok(RelayIoResponse::BlobsHave(response))) =
            (&request, &result)
        {
            if let Ok(missing) = response.validated_missing(&have.sha256s) {
                self.push_progress
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .confirm_blob_presence(
                        &have.workspace_id,
                        &have.replication_epoch,
                        &have.stream_identity,
                        have.sha256s
                            .iter()
                            .filter(|sha| !missing.contains(sha))
                            .cloned(),
                    );
            }
        }
        let uploads = match (&request, &result) {
            (RelayIoRequest::UploadBlob(upload), Ok(RelayIoResponse::UploadBlob)) => {
                std::slice::from_ref(upload)
            }
            (RelayIoRequest::UploadBlobs(uploads), Ok(RelayIoResponse::UploadBlob)) => {
                uploads.as_slice()
            }
            _ => &[],
        };
        if !uploads.is_empty() {
            let mut progress = self
                .push_progress
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let confirmed = uploads.iter().all(|upload| {
                progress.confirm_blob_presence(
                    &upload.workspace_id,
                    &upload.replication_epoch,
                    &upload.stream_identity,
                    [upload.sha256.clone()],
                )
            });
            debug_assert!(
                confirmed,
                "a successful upload belongs to the active push identity"
            );
            // The native continuation consumes presence, without retaining blob bytes.
            return;
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Ok(RelayIoResponse::Push(response)) = &result
            && let RelayIoRequest::Push(request) | RelayIoRequest::PushHosted(request) = &request
            && !request.ops.is_empty()
        {
            state.workspace_pushed = state.workspace_pushed.saturating_add(response.inserted);
        }
        if let Ok(RelayIoResponse::ShareLogPush(response)) = &result {
            state.share_log_pushed = state.share_log_pushed.saturating_add(response.inserted);
        }
        // A completed upload stays for every rerun of its operation, so it
        // keeps only what names it: the content is gone once it is sent.
        let request = match request {
            RelayIoRequest::ShareBlobUpload(upload) => {
                RelayIoRequest::ShareBlobUpload(ShareBlobUploadRequest {
                    bytes: Vec::new(),
                    ..upload
                })
            }
            other => other,
        };
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
                outcome.pushed = state.share_log_pushed;
            }
            _ => {}
        }
    }
}

fn coordinate_cache_key(request: &LogCoordinateRequest) -> (&str, &str, &str, &str, i64) {
    (
        &request.workspace_id,
        &request.replication_epoch,
        &request.stream_identity,
        &request.origin_id,
        request.origin_seq,
    )
}

/// Whether a completed request answers `request`. A share upload is named by
/// its share and content hash, because its completed copy no longer holds the
/// content.
fn same_io_request(completed: &RelayIoRequest, request: &RelayIoRequest) -> bool {
    match (completed, request) {
        (RelayIoRequest::ShareBlobUpload(done), RelayIoRequest::ShareBlobUpload(asked)) => {
            done.share_id == asked.share_id && done.sha256 == asked.sha256
        }
        _ => completed == request,
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
    fn publishes_native_settlements(&self) -> bool {
        self.native_settlements
    }

    relay_transport_method!(push, PushRequest, Push, PushResponse, Push);
    relay_transport_method!(pull, PullRequest, Pull, PullResponse, Pull);
    relay_transport_method!(push_hosted, PushRequest, PushHosted, PushResponse, Push);
    relay_transport_method!(
        pull_hosted,
        HostedPullRequest,
        PullHosted,
        HostedPullResponse,
        PullHosted
    );
    fn lookup_log_coordinate(
        &self,
        request: LogCoordinateRequest,
    ) -> Result<LogCoordinateResponse, RelayError> {
        self.lookup_log_coordinates(vec![request])?
            .pop()
            .ok_or(RelayError::InvalidResponse)
    }
    fn lookup_log_coordinates(
        &self,
        requests: Vec<LogCoordinateRequest>,
    ) -> Result<Vec<LogCoordinateResponse>, RelayError> {
        if requests.is_empty() || requests.len() > MAX_BASE_REPAIR_LOOKUPS {
            return Err(RelayError::InvalidResponse);
        }
        // Completed groups leave the next replay's repair query. Match answers by
        // coordinate so pending groups cannot shift and repeat a completed batch.
        let mut answers = {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut known = std::collections::BTreeMap::new();
            for (request, result) in &state.completed {
                match (request, result) {
                    (
                        RelayIoRequest::LookupCoordinates(batch),
                        Ok(RelayIoResponse::LookupCoordinates(responses)),
                    ) => {
                        if batch.len() != responses.len() {
                            return Err(RelayError::InvalidResponse);
                        }
                        for (coordinate, response) in batch.iter().zip(responses) {
                            known.insert(coordinate_cache_key(coordinate), response);
                        }
                    }
                    (RelayIoRequest::LookupCoordinates(batch), Err(error))
                        if requests.iter().any(|request| batch.contains(request)) =>
                    {
                        return Err(error.clone());
                    }
                    _ => {}
                }
            }
            requests
                .iter()
                .map(|request| {
                    known
                        .get(&coordinate_cache_key(request))
                        .map(|answer| (*answer).clone())
                })
                .collect::<Vec<_>>()
        };
        let missing = requests
            .iter()
            .zip(&answers)
            .filter(|(_, answer)| answer.is_none())
            .map(|(request, _)| request.clone())
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            let resolved = self.resolve(
                RelayIoRequest::LookupCoordinates(missing),
                |response| match response {
                    RelayIoResponse::LookupCoordinates(values) => Some(values.clone()),
                    _ => None,
                },
            )?;
            let mut resolved = resolved.into_iter();
            for answer in &mut answers {
                if answer.is_none() {
                    *answer = Some(resolved.next().ok_or(RelayError::InvalidResponse)?);
                }
            }
            if resolved.next().is_some() {
                return Err(RelayError::InvalidResponse);
            }
        }
        answers
            .into_iter()
            .map(|answer| answer.ok_or(RelayError::InvalidResponse))
            .collect()
    }
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

    fn upload_blobs(&self, mut requests: Vec<BlobUploadRequest>) -> Result<(), RelayError> {
        if requests.len() == 1 {
            return self.upload_blob(requests.remove(0));
        }
        self.resolve(RelayIoRequest::UploadBlobs(requests), |response| {
            matches!(response, RelayIoResponse::UploadBlob).then_some(())
        })
    }

    fn upload_blob(&self, request: BlobUploadRequest) -> Result<(), RelayError> {
        self.resolve(RelayIoRequest::UploadBlob(request), |response| {
            matches!(response, RelayIoResponse::UploadBlob).then_some(())
        })
    }

    fn download_blobs(
        &self,
        request: BlobDownloadBatchRequest,
    ) -> Result<BlobDownloadBatchResponse, RelayError> {
        self.resolve(
            RelayIoRequest::DownloadBlobs(request),
            |response| match response {
                RelayIoResponse::DownloadBlobs(response) => Some(BlobDownloadBatchResponse {
                    results: std::mem::take(&mut response.results),
                }),
                _ => None,
            },
        )
    }
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
        share_log_push,
        ShareLogPushRequest,
        ShareLogPush,
        PushResponse,
        ShareLogPush
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

    fn share_blob_upload(&self, request: ShareBlobUploadRequest) -> Result<(), RelayError> {
        self.resolve(RelayIoRequest::ShareBlobUpload(request), |response| {
            matches!(response, RelayIoResponse::ShareBlobUpload).then_some(())
        })
    }

    relay_transport_method!(
        share_proposal_submit,
        ShareProposalSubmitRequest,
        ShareProposalSubmit,
        ShareProposalSubmitResponse,
        ShareProposalSubmit
    );
    relay_transport_method!(
        share_collection_write,
        ShareCollectionWriteRequest,
        ShareCollectionWrite,
        ShareCollectionWriteResponse,
        ShareCollectionWrite
    );
}

#[cfg(test)]
#[path = "relay_bench.rs"]
mod relay_bench;

#[cfg(test)]
#[path = "relay_push_tests.rs"]
mod relay_push_tests;

#[cfg(test)]
#[path = "relay_base_repair_tests.rs"]
mod relay_base_repair_tests;

#[cfg(test)]
#[path = "relay_hosted_origin_tests.rs"]
mod relay_hosted_origin_tests;

#[cfg(test)]
mod deferred_relay_tests {
    use super::*;

    #[test]
    fn a_lane_drain_is_not_repeated_when_a_push_resumes_after_blob_io() {
        use dohc_engine_domain::{VersionedTextStore, WriteText};
        use dohc_engine_testkit::{ScratchDir, engine_db_path};
        let scratch = ScratchDir::new().unwrap();
        let path = engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&path, 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .unwrap();
        dohc_engine_sync::adopt_join_identity(
            &mut store, "ws", "local", "epoch", "stream", 1, &NoFaults,
        )
        .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO sync_relay_push_state VALUES ('ws','local',-1)",
                    [],
                )
                .unwrap();
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .unwrap();
        let write = |store: &mut EngineStore, id: &str, text: &str, now| {
            VersionedTextStore::new(store)
                .write_text(
                    &WriteText {
                        workspace_id: "ws".into(),
                        version_id: "main".into(),
                        object_id: "doc".into(),
                        moment_id: id.into(),
                        path: "doc.md".into(),
                        text: text.into(),
                        metadata_origin: "ydoc".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: now,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
        };
        write(&mut store, "a", "A", 10);
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO ydoc_docs(workspace_id,version_id,object_id,content_kind,regime,lineage_claim_status,updated_at_ms,file_export_lane,path) VALUES ('ws','main','doc','plaintext','local-only','unclaimed',1,1,'doc.md')", []).unwrap();
            Ok::<_, dohc_engine_storage::StorageError>(())
        }).unwrap();
        let transport = DeferredRelayTransport::default();
        let operation = RelayOperation::Push {
            workspace_id: "ws".into(),
            now_ms: 20,
            max_read_bytes: 0,
        };
        let mut cache = WriterDocCache::new();
        let run = |store: &mut EngineStore, cache: &mut WriterDocCache| {
            execute_relay_operation(
                store,
                cache,
                transport.clone(),
                operation.clone(),
                &LeaseRegistry::default(),
                &ClaimAnnouncer::default(),
                &mut crate::actor::live_application::Registry::default(),
            )
        };
        assert!(matches!(run(&mut store, &mut cache),
            Err(RuntimeError::Relay(RelayError::Local(reason))) if reason == RELAY_IO_PENDING));
        let pending = transport.take_pending().unwrap();
        assert!(matches!(pending, RelayIoRequest::BlobsHave(_)));
        write(&mut store, "b", "B", 30);
        transport.complete(
            pending,
            Ok(RelayIoResponse::BlobsHave(BlobHaveResponse {
                missing: Vec::new(),
            })),
        );
        assert!(matches!(run(&mut store, &mut cache),
            Err(RuntimeError::Relay(RelayError::Local(reason))) if reason == RELAY_IO_PENDING));
        let exported: Vec<String> = store.read_with(|conn| {
            conn.prepare("SELECT json_extract(payload_json,'$.momentId') FROM replication_log WHERE imported=0 AND op_kind='moment.append' ORDER BY rowid")?
                .query_map([], |row| row.get(0))?.collect::<Result<_, rusqlite::Error>>()
        }).unwrap();
        assert_eq!(
            exported,
            ["a"],
            "a sync continuation must not select a newer settle"
        );
        for continuation in 0..8 {
            let pending = transport.take_pending().unwrap();
            let response = match &pending {
                RelayIoRequest::BlobsHave(_) => RelayIoResponse::BlobsHave(BlobHaveResponse {
                    missing: Vec::new(),
                }),
                RelayIoRequest::Push(request) => RelayIoResponse::Push(PushResponse {
                    settlement_refusals: Vec::new(),
                    hosted_refusals: Vec::new(),
                    redundant_recoveries: Vec::new(),
                    accepted: request.ops.len(),
                    inserted: request.ops.len(),
                    skipped: 0,
                    current_max_origin_seq: request.ops.last().unwrap().origin_seq,
                }),
                other => panic!("unexpected I/O: {other:?}"),
            };
            transport.complete(pending, Ok(response));
            match run(&mut store, &mut cache) {
                Ok(_) => break,
                Err(RuntimeError::Relay(RelayError::Local(reason)))
                    if reason == RELAY_IO_PENDING =>
                {
                    assert!(continuation < 7, "the push did not finish");
                }
                other => panic!("unexpected outcome: {other:?}"),
            }
        }
        let count = || {
            store.read_with(|conn| conn.query_row(
            "SELECT count(*) FROM replication_log WHERE imported=0 AND op_kind='moment.append'", [], |row| row.get::<_, i64>(0))).unwrap()
        };
        assert_eq!(count(), 1);
        let second_phase = execute_relay_operation(
            &mut store,
            &mut cache,
            transport.clone(),
            operation.clone(),
            &LeaseRegistry::default(),
            &ClaimAnnouncer::default(),
            &mut crate::actor::live_application::Registry::default(),
        );
        assert!(
            second_phase.is_ok(),
            "a second phase must keep the same selection"
        );
        let next_operation = RelayOperation::Push {
            workspace_id: "ws".into(),
            now_ms: 40,
            max_read_bytes: 0,
        };
        let next = execute_relay_operation(
            &mut store,
            &mut cache,
            DeferredRelayTransport::default(),
            next_operation,
            &LeaseRegistry::default(),
            &ClaimAnnouncer::default(),
            &mut crate::actor::live_application::Registry::default(),
        );
        assert!(matches!(next,
            Err(RuntimeError::Relay(RelayError::Local(reason))) if reason == RELAY_IO_PENDING));
        let exported: Vec<String> = store.read_with(|conn| {
            conn.prepare("SELECT json_extract(payload_json,'$.momentId') FROM replication_log WHERE imported=0 AND op_kind='moment.append' ORDER BY rowid")?
                .query_map([], |row| row.get(0))?.collect::<Result<_, rusqlite::Error>>()
        }).unwrap();
        assert_eq!(
            exported,
            ["a", "b"],
            "the next pass selects the later settle"
        );
    }

    #[test]
    fn base_repair_probe_is_sent_once_across_pull_replays_without_cursor_advance() {
        base_repair_probe_across_replays(false);
    }

    #[test]
    fn base_repair_push_between_pull_replays_keeps_stale_probe_safe() {
        base_repair_probe_across_replays(true);
    }

    fn base_repair_probe_across_replays(push_between_replays: bool) {
        use dohc_engine_sync::{ReplicationEnvelope, SyncError};
        use rusqlite::params;
        let (_scratch, _path, mut store) = dohc_engine_testkit::open_store();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1000, &NoFaults)
            .unwrap();
        dohc_engine_sync::adopt_join_identity(
            &mut store, "ws", "local", "epoch", "stream", 1000, &NoFaults,
        )
        .unwrap();
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO file_objects (workspace_id,object_id,created_at_ms) VALUES ('ws','doc',1000)", []).map_err(|error| SyncError::Storage(dohc_engine_storage::StorageError::persist_public(error)))?;
            tx.execute("INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) VALUES ('ws','local',-1)", []).map_err(|error| SyncError::Storage(dohc_engine_storage::StorageError::persist_public(error)))?;
            Ok::<_,SyncError>(())
        }).unwrap();
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.plaintext_insert(0, "base");
        let bytes = doc.encode_full_state();
        let claim = dohc_engine_storage::hex_sha256(&bytes);
        let key = dohc_engine_collab::DocKey::new("ws", "main", "doc").unwrap();
        dohc_engine_collab::claim_base(
            &mut store,
            &key,
            dohc_engine_collab::ContentKind::Plaintext,
            &bytes,
            &NoFaults,
            1000,
        )
        .unwrap();
        let payload = serde_json::json!({"versionId":"main","objectId":"doc","path":"doc.md","contentKind":"plaintext","lineageClaimId":claim,"updateBlobSha256":claim,"isBaseState":true});
        store.write_with(&NoFaults, |tx| {
            for (origin,seq) in [("local",0),("local",1),("peer",0)] {
                tx.execute("INSERT INTO replication_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported,apply_disposition) VALUES ('ws',?1,?2,'ydoc.update',?3,1000,?4,'applied')",params![origin,seq,payload.to_string(),i64::from(origin!="local")]).map_err(|error| SyncError::Storage(dohc_engine_storage::StorageError::persist_public(error)))?;
                tx.execute("INSERT INTO ydoc_base_relay_candidates (workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq) VALUES ('ws','main','doc',?1,?2,?3)",params![claim,origin,seq]).map_err(|error| SyncError::Storage(dohc_engine_storage::StorageError::persist_public(error)))?;
            }
            Ok::<_,SyncError>(())
        }).unwrap();
        let committed = ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: "ws".into(),
            origin_id: "local".into(),
            origin_seq: 0,
            op_kind: "ydoc.update".into(),
            payload: payload.clone(),
            recorded_at_ms: 1000,
            relay_seq: Some(100),
        };
        let transport = DeferredRelayTransport::default();
        let mut cache = WriterDocCache::new();
        let operation = RelayOperation::Pull {
            workspace_id: "ws".into(),
            now_ms: 1200,
        };
        let mut probes = 0;
        let mut lookups = 0;
        let mut runs = 0;
        loop {
            runs += 1;
            assert!(
                runs <= 6,
                "repair repeated a relay request: probes={probes}, lookups={lookups}"
            );
            match execute_relay_operation(
                &mut store,
                &mut cache,
                transport.clone(),
                operation.clone(),
                &LeaseRegistry::default(),
                &ClaimAnnouncer::default(),
                &mut crate::actor::live_application::Registry::default(),
            ) {
                Ok(RelayOperationOutcome::Sync(SyncPassOutcome::Complete { .. })) => break,
                Err(RuntimeError::Relay(RelayError::Local(reason)))
                    if reason == RELAY_IO_PENDING =>
                {
                    let request = transport.take_pending().unwrap();
                    let response = match &request {
                        RelayIoRequest::Pull(_) => RelayIoResponse::Pull(PullResponse {
                            ops: Vec::new(),
                            next_cursor: 0,
                            has_more: false,
                        }),
                        RelayIoRequest::Push(push) => {
                            assert!(push.ops.is_empty());
                            probes += 1;
                            RelayIoResponse::Push(PushResponse {
                                settlement_refusals: Vec::new(),
                                hosted_refusals: Vec::new(),
                                redundant_recoveries: Vec::new(),
                                accepted: 0,
                                inserted: 0,
                                skipped: 0,
                                current_max_origin_seq: 0,
                            })
                        }
                        RelayIoRequest::LookupCoordinates(coordinates) => {
                            lookups += coordinates.len();
                            RelayIoResponse::LookupCoordinates(
                                coordinates
                                    .iter()
                                    .map(|coordinate| {
                                        if coordinate.origin_id == "local" {
                                            let mut op = committed.clone();
                                            op.origin_seq = coordinate.origin_seq;
                                            op.relay_seq = Some(100 + coordinate.origin_seq);
                                            LogCoordinateResponse::Present(op)
                                        } else {
                                            LogCoordinateResponse::Absent
                                        }
                                    })
                                    .collect(),
                            )
                        }
                        other => panic!("unexpected repair request: {other:?}"),
                    };
                    transport.complete(request, Ok(response));
                    if push_between_replays && runs == 2 {
                        // Complete a separate push while this pull retains the earlier maximum of zero.
                        let push_transport = DeferredRelayTransport::default();
                        for push_run in 0..4 {
                            match execute_relay_operation(
                                &mut store,
                                &mut WriterDocCache::new(),
                                push_transport.clone(),
                                RelayOperation::Push {
                                    workspace_id: "ws".into(),
                                    now_ms: 1201,
                                    max_read_bytes: 0,
                                },
                                &LeaseRegistry::default(),
                                &ClaimAnnouncer::default(),
                                &mut crate::actor::live_application::Registry::default(),
                            ) {
                                Ok(RelayOperationOutcome::Sync(SyncPassOutcome::Complete {
                                    ..
                                })) => break,
                                Err(RuntimeError::Relay(RelayError::Local(reason)))
                                    if reason == RELAY_IO_PENDING =>
                                {
                                    assert!(push_run < 3, "push failed to finish");
                                    let request = push_transport.take_pending().unwrap();
                                    let response = match &request {
                                        RelayIoRequest::BlobsHave(_) => {
                                            RelayIoResponse::BlobsHave(BlobHaveResponse {
                                                missing: Vec::new(),
                                            })
                                        }
                                        RelayIoRequest::Push(push) => {
                                            assert_eq!(push.ops.len(), 2);
                                            RelayIoResponse::Push(PushResponse {
                                                settlement_refusals: Vec::new(),
                                                hosted_refusals: Vec::new(),
                                                redundant_recoveries: Vec::new(),
                                                accepted: 2,
                                                inserted: 1,
                                                skipped: 1,
                                                current_max_origin_seq: 1,
                                            })
                                        }
                                        other => {
                                            panic!("unexpected concurrent push request: {other:?}")
                                        }
                                    };
                                    push_transport.complete(request, Ok(response));
                                }
                                other => panic!("unexpected concurrent push result: {other:?}"),
                            }
                        }
                        assert_eq!(
                            dohc_engine_sync::read_pushed_seq(&store, "ws", "local").unwrap(),
                            1
                        );
                        // A newly captured base still needs the cached bound when the pull resumes.
                        store.write_with(&NoFaults, |tx| {
                            tx.execute("INSERT INTO replication_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported,apply_disposition) VALUES ('ws','local',2,'ydoc.update',?1,1000,0,'applied')", [payload.to_string()]).unwrap();
                            tx.execute("INSERT INTO ydoc_base_relay_candidates (workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq) VALUES ('ws','main','doc',?1,'local',2)", [&claim]).unwrap();
                            Ok::<_,SyncError>(())
                        }).unwrap();
                    }
                }
                other => panic!("unexpected pull result: {other:?}"),
            }
        }
        assert_eq!(
            (probes, lookups, runs),
            if push_between_replays {
                (1, 3, 4)
            } else {
                (1, 2, 4)
            }
        );
        assert_eq!(
            dohc_engine_sync::read_pushed_seq(&store, "ws", "local").unwrap(),
            if push_between_replays { 1 } else { -1 }
        );
        let relay_seq: Option<i64> = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT base_relay_seq FROM ydoc_docs WHERE object_id='doc'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(relay_seq, Some(100));
    }

    /// An operation reruns from its start after each relay call. Send changes
    /// uploads each changed file's content before it submits, so a completed
    /// upload must answer every later rerun. When it was consumed on its first
    /// rerun, each extra upload doubled the reruns: four uploads took 16.
    #[test]
    fn an_operation_with_several_uploads_reruns_once_per_relay_call() {
        let transport = DeferredRelayTransport::default();
        let uploads: Vec<ShareBlobUploadRequest> = ['a', 'b', 'c', 'd']
            .into_iter()
            .map(|sha| ShareBlobUploadRequest {
                share_id: "share".to_owned(),
                sha256: sha.to_string().repeat(64),
                bytes: vec![1, 2, 3],
            })
            .collect();
        let operation = || -> Result<(), RelayError> {
            for upload in &uploads {
                transport.share_blob_upload(upload.clone())?;
            }
            Ok(())
        };
        let mut runs = 0;
        loop {
            runs += 1;
            assert!(runs <= uploads.len() + 1, "an upload was sent again");
            match operation() {
                Ok(()) => break,
                Err(RelayError::Local(reason)) if reason == RELAY_IO_PENDING => {
                    let request = transport.take_pending().expect("pending upload");
                    transport.complete(request, Ok(RelayIoResponse::ShareBlobUpload));
                }
                Err(error) => panic!("unexpected relay error: {error:?}"),
            }
        }
        assert_eq!(runs, uploads.len() + 1);
        assert!(
            transport
                .state
                .lock()
                .expect("state")
                .completed
                .iter()
                .all(|(request, _)| matches!(
                    request,
                    RelayIoRequest::ShareBlobUpload(upload) if upload.bytes.is_empty()
                )),
            "a kept upload holds no content",
        );
    }

    #[test]
    fn a_completed_direct_write_answers_every_rerun_of_its_operation() {
        let transport = DeferredRelayTransport::default();
        let request = ShareCollectionWriteRequest {
            share_id: "share".to_owned(),
            submit_id: "direct-1".to_owned(),
            changes: Vec::new(),
        };
        let written = ShareCollectionWriteResponse::Written {
            paths: vec!["trip/packing/collection.yaml".to_owned()],
        };
        transport.complete(
            RelayIoRequest::ShareCollectionWrite(request.clone()),
            Ok(RelayIoResponse::ShareCollectionWrite(written.clone())),
        );
        for _ in 0..2 {
            assert_eq!(
                transport.share_collection_write(request.clone()),
                Ok(written.clone())
            );
        }
    }

    #[test]
    fn completed_blob_batch_transfers_body_allocations_without_copying() {
        let transport = DeferredRelayTransport::default();
        let request = BlobDownloadBatchRequest {
            workspace_id: "workspace".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            blobs: vec![dohc_engine_sync::BlobDownloadSpec {
                sha256: "a".repeat(64),
                limit_bytes: 1024,
            }],
        };
        let bytes = vec![7; 1024];
        let pointer = bytes.as_ptr();
        transport.complete(
            RelayIoRequest::DownloadBlobs(request.clone()),
            Ok(RelayIoResponse::DownloadBlobs(BlobDownloadBatchResponse {
                results: vec![Ok(BlobDownloadResponse { bytes })],
            })),
        );
        let response = transport
            .download_blobs(request.clone())
            .expect("consume batch");
        assert_eq!(
            response.results[0].as_ref().expect("body").bytes.as_ptr(),
            pointer
        );
        assert!(transport.state.lock().expect("state").completed.is_empty());
        assert_eq!(
            transport.download_blobs(request),
            Err(RelayError::Local(RELAY_IO_PENDING.to_owned()))
        );
    }

    #[test]
    fn failed_blob_batch_projection_retains_its_completed_response() {
        let request = BlobDownloadBatchRequest {
            workspace_id: "workspace".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            blobs: Vec::new(),
        };
        for (result, expected) in [
            (Err(RelayError::BlobMissing), RelayError::BlobMissing),
            (Ok(RelayIoResponse::UploadBlob), RelayError::InvalidResponse),
        ] {
            let transport = DeferredRelayTransport::default();
            transport.complete(RelayIoRequest::DownloadBlobs(request.clone()), result);
            for _ in 0..2 {
                assert_eq!(
                    transport.download_blobs(request.clone()),
                    Err(expected.clone())
                );
                assert_eq!(transport.state.lock().expect("state").completed.len(), 1);
            }
        }
    }

    #[test]
    fn completed_pull_page_remains_available_for_replay() {
        let transport = DeferredRelayTransport::default();
        let request = PullRequest {
            workspace_id: "workspace".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            cursor: 0,
            limit: 10,
        };
        let response = PullResponse {
            ops: Vec::new(),
            next_cursor: 1,
            has_more: false,
        };
        transport.complete(
            RelayIoRequest::Pull(request.clone()),
            Ok(RelayIoResponse::Pull(response.clone())),
        );
        for _ in 0..2 {
            assert_eq!(
                transport.pull(request.clone()).expect("replay page"),
                response
            );
            assert_eq!(transport.state.lock().expect("state").completed.len(), 1);
        }
    }

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
                    settlement_admission: None,
                    admitted_author_snapshot: None,
                    workspace_id: "workspace".to_owned(),
                    origin_id: "origin".to_owned(),
                    origin_seq: i64::try_from(origin_seq).expect("sequence"),
                    relay_seq: None,
                    op_kind: "probe".to_owned(),
                    payload: serde_json::json!({"body": "retained until consumed"}),
                    recorded_at_ms: 1_000,
                })
                .collect(),
        };
        transport.complete(
            RelayIoRequest::Push(request.clone()),
            Ok(RelayIoResponse::Push(PushResponse {
                settlement_refusals: Vec::new(),
                hosted_refusals: Vec::new(),
                redundant_recoveries: Vec::new(),
                accepted: request.ops.len(),
                inserted: request.ops.len(),
                skipped: 0,
                current_max_origin_seq: i64::try_from(request.ops.len() - 1).expect("maximum"),
            })),
        );

        assert_eq!(
            transport.push(request).expect("consume completed push"),
            PushResponse {
                settlement_refusals: Vec::new(),
                hosted_refusals: Vec::new(),
                redundant_recoveries: Vec::new(),
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
            "omitting Push from the release set retains every consumed batch"
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
                Ok(RelayIoResponse::DownloadBlobs(response)) => Some(
                    response
                        .results
                        .iter()
                        .filter_map(|result| result.as_ref().ok())
                        .map(|response| response.bytes.len())
                        .sum(),
                ),
                Ok(RelayIoResponse::ShareBlob(response)) => Some(response.bytes.len()),
                _ => None,
            })
            .sum::<usize>();
        assert_eq!(
            retained, 0,
            "persisted blob responses must be released before the RPC completes"
        );
    }

    #[test]
    fn completed_blob_batch_replays_in_request_order_and_releases_the_slot() {
        let transport = DeferredRelayTransport::default();
        let request = BlobDownloadBatchRequest {
            workspace_id: "workspace".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            blobs: vec![
                dohc_engine_sync::BlobDownloadSpec {
                    sha256: "a".repeat(64),
                    limit_bytes: 5,
                },
                dohc_engine_sync::BlobDownloadSpec {
                    sha256: "b".repeat(64),
                    limit_bytes: 7,
                },
            ],
        };

        assert_eq!(
            transport.download_blobs(request.clone()),
            Err(RelayError::Local(RELAY_IO_PENDING.to_owned()))
        );
        assert_eq!(
            transport.take_pending(),
            Some(RelayIoRequest::DownloadBlobs(request.clone()))
        );
        let response = BlobDownloadBatchResponse {
            results: vec![
                Ok(BlobDownloadResponse {
                    bytes: b"first".to_vec(),
                }),
                Err(RelayError::BlobMissing),
            ],
        };
        transport.complete(
            RelayIoRequest::DownloadBlobs(request.clone()),
            Ok(RelayIoResponse::DownloadBlobs(response.clone())),
        );

        assert_eq!(
            transport
                .download_blobs(request)
                .expect("replay completed blob batch"),
            response
        );
        assert!(
            transport
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .completed
                .is_empty(),
            "a consumed blob batch must release its ordered request and response"
        );
    }

    #[test]
    fn completed_empty_blob_inventory_answers_later_page_replays() {
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
        for _ in 0..2 {
            assert!(
                transport
                    .blobs_have(request.clone())
                    .expect("consume inventory")
                    .missing
                    .is_empty()
            );
        }
        assert!(transport.take_pending().is_none());
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
            "rebasing the CAS conflict schedules a GET and re-enters cached I/O"
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

    #[derive(Debug, PartialEq, Eq)]
    enum BlobWorkerEvent {
        Started(usize),
        Completed(usize),
        Cancelled(usize),
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blob_batch_fanout_is_bound_to_four_and_reassembles_request_order() {
        use std::sync::{Condvar, mpsc};
        use std::time::Duration;

        fn release(gates: &[(Mutex<bool>, Condvar)], index: usize) {
            let (released, condition) = &gates[index];
            *released
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
            condition.notify_one();
        }

        let gates = Arc::new(
            (0..5)
                .map(|_| (Mutex::new(false), Condvar::new()))
                .collect::<Vec<_>>(),
        );
        let (events, event_rx) = mpsc::channel();
        let worker_gates = Arc::clone(&gates);
        let request = BlobDownloadBatchRequest {
            workspace_id: "workspace".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            blobs: (0..5)
                .map(|index| dohc_engine_sync::BlobDownloadSpec {
                    sha256: index.to_string(),
                    limit_bytes: 1,
                })
                .collect(),
        };
        let task = tokio::spawn(execute_blob_download_batch(
            request,
            CancellationToken::new(),
            move |request, _worker_token| {
                let index = request.blobs[0]
                    .sha256
                    .parse::<usize>()
                    .expect("test blob index");
                events
                    .send(BlobWorkerEvent::Started(index))
                    .expect("started event");
                let (released, condition) = &worker_gates[index];
                let mut released = released
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                while !*released {
                    released = condition
                        .wait(released)
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                }
                events
                    .send(BlobWorkerEvent::Completed(index))
                    .expect("completed event");
                Ok(BlobDownloadBatchResponse {
                    results: vec![Ok(BlobDownloadResponse {
                        bytes: vec![u8::try_from(index).expect("test byte")],
                    })],
                })
            },
        ));

        let mut started = std::collections::BTreeSet::new();
        for _ in 0..MAX_CONCURRENT_BLOB_DOWNLOADS {
            match event_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("four workers start")
            {
                BlobWorkerEvent::Started(index) => {
                    started.insert(index);
                }
                event => panic!("unexpected worker event: {event:?}"),
            }
        }
        assert_eq!(started, [0, 1, 2, 3].into_iter().collect());
        assert!(
            event_rx.try_recv().is_err(),
            "the fifth GET must wait for one of the first four"
        );

        release(&gates, 3);
        assert_eq!(
            event_rx.recv_timeout(Duration::from_secs(2)),
            Ok(BlobWorkerEvent::Completed(3))
        );
        assert_eq!(
            event_rx.recv_timeout(Duration::from_secs(2)),
            Ok(BlobWorkerEvent::Started(4))
        );
        for index in [4, 2, 1, 0] {
            release(&gates, index);
            assert_eq!(
                event_rx.recv_timeout(Duration::from_secs(2)),
                Ok(BlobWorkerEvent::Completed(index))
            );
        }

        let response = task
            .await
            .expect("batch task")
            .expect("ordered batch response");
        let bytes = response
            .results
            .into_iter()
            .map(|result| result.expect("blob result").bytes)
            .collect::<Vec<_>>();
        assert_eq!(bytes, vec![vec![0], vec![1], vec![2], vec![3], vec![4]]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_blob_batch_stops_scheduling_and_releases_in_flight_downloads() {
        use std::sync::{Condvar, mpsc};
        use std::time::Duration;

        let gates = Arc::new(
            (0..5)
                .map(|_| (Mutex::new(false), Condvar::new()))
                .collect::<Vec<_>>(),
        );
        let (events, event_rx) = mpsc::channel();
        let worker_gates = Arc::clone(&gates);
        let cancellation = CancellationToken::new();
        let task_cancellation = cancellation.clone();
        let request = BlobDownloadBatchRequest {
            workspace_id: "workspace".to_owned(),
            replication_epoch: "epoch".to_owned(),
            stream_identity: "stream".to_owned(),
            blobs: (0..5)
                .map(|index| dohc_engine_sync::BlobDownloadSpec {
                    sha256: index.to_string(),
                    limit_bytes: 1,
                })
                .collect(),
        };
        let task = tokio::spawn(execute_blob_download_batch(
            request,
            task_cancellation,
            move |request, worker_cancellation| {
                let index = request.blobs[0]
                    .sha256
                    .parse::<usize>()
                    .expect("test blob index");
                events
                    .send(BlobWorkerEvent::Started(index))
                    .expect("started event");
                let (released, condition) = &worker_gates[index];
                let mut released = released
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                while !*released && !worker_cancellation.is_cancelled() {
                    released = condition
                        .wait(released)
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                }
                assert!(worker_cancellation.is_cancelled());
                events
                    .send(BlobWorkerEvent::Cancelled(index))
                    .expect("cancelled event");
                Err(RelayError::Local("cancelled test download".to_owned()))
            },
        ));

        let mut started = std::collections::BTreeSet::new();
        for _ in 0..MAX_CONCURRENT_BLOB_DOWNLOADS {
            match event_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("four workers start")
            {
                BlobWorkerEvent::Started(index) => {
                    started.insert(index);
                }
                event => panic!("unexpected worker event: {event:?}"),
            }
        }
        assert_eq!(started, [0, 1, 2, 3].into_iter().collect());

        cancellation.cancel();
        for (released, condition) in gates.iter() {
            *released
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
            condition.notify_all();
        }

        let mut cancelled = std::collections::BTreeSet::new();
        for _ in 0..MAX_CONCURRENT_BLOB_DOWNLOADS {
            match event_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("in-flight workers observe cancellation")
            {
                BlobWorkerEvent::Cancelled(index) => {
                    cancelled.insert(index);
                }
                event => panic!("unexpected worker event after cancellation: {event:?}"),
            }
        }
        assert_eq!(cancelled, [0, 1, 2, 3].into_iter().collect());
        let outcome = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("cancelled batch resolves promptly")
            .expect("batch task");
        assert!(
            outcome.is_err(),
            "a cancelled batch must not produce a response"
        );
        assert!(
            event_rx.try_recv().is_err(),
            "cancellation must prevent the fifth download from starting"
        );
    }
}

#[derive(Debug)]
pub enum RelayOperationOutcome {
    Sync(SyncPassOutcome),
    CursorCommitted {
        sharing_declined: Vec<dohc_engine_sync::SharingDeclined>,
        writer_cache_changed: bool,
    },
    Probe(bool),
    Claimed,
    JoinIdentityAdopted,
    Recovered(RecoverResponse),
    KeyEnvelopeUploaded {
        etag: String,
    },
    KeyEnvelopeDownloaded {
        envelope_json: String,
        etag: String,
    },
    SharedChannelPulled(SharedChannelPullOutcome),
    SharedChannelPushed(SharedChannelPushOutcome),
    ShareViewPulled(ShareViewPullOutcome),
    ShareViewIdentity(ShareViewIdentityRecord),
    ShareProposalSubmitted(ShareProposalSubmitOutcome),
    DirectWritesPushed(DirectWritePushOutcome),
    HostedReplicaCreated,
    HostedPass {
        pass: HostedPassOutcome,
        /// Each document of the scope that is not ready after the pass. Its
        /// live registrations were released before the pass replied.
        unready: Vec<String>,
        /// Each document that left the scope and is not gone from the
        /// replica yet: its rows or its file remain.
        departed: Vec<String>,
    },
    HostedCursorCommitted {
        /// Not committed when the scope moved since the pass fetched; and
        /// whether a document it kept held waits for the next pass.
        commit: dohc_engine_sync::HostedCommit,
        /// Parking after the commit: `Ok(true)` when a document that left the
        /// scope parked or its file's path came free, so work that waited for
        /// its path can apply and the caller pulls again. Its failure leaves
        /// the commit standing.
        retirement: Result<bool, RuntimeError>,
        /// As for [`Self::HostedPass`], after the commit. A failure to read
        /// them released nothing and leaves the commit standing; the next
        /// pass releases them.
        unready: Result<Vec<String>, RuntimeError>,
        /// As for [`Self::HostedPass`], after the parking. A failure to
        /// read them leaves the commit standing; the next pass reports them.
        departed: Result<Vec<String>, RuntimeError>,
    },
}

/// What a share view's identity call settled on, including the answer the
/// journal layer cannot give.
///
/// `NotRequired` lives here rather than in `dohc-engine-sync` because it is
/// the LEVEL's answer, and the level is read here: View and Comment never
/// reach the store at all. Keeping it out of the journal layer means that
/// function has no variant it can never return.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareViewIdentityRecord {
    Recorded,
    AlreadyRecorded,
    NotRequired,
}

impl ActorHandle {
    pub async fn share_record_creation_statuses(
        &self,
        workspace_id: String,
        share_id: String,
        paths: Vec<String>,
        granted: dohc_engine_sync::ShareGrant,
    ) -> Result<std::collections::BTreeMap<String, dohc_engine_sync::DirectWriteStatus>, RuntimeError>
    {
        self.run(move |store, _cache| {
            dohc_engine_sync::read_record_creation_statuses(
                store,
                &workspace_id,
                &share_id,
                &paths,
                &granted,
            )
            .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn share_direct_status(
        &self,
        workspace_id: String,
        share_id: String,
        path: String,
        granted: dohc_engine_sync::ShareGrant,
    ) -> Result<dohc_engine_sync::DirectWriteStatus, RuntimeError> {
        self.run(move |store, _cache| {
            dohc_engine_sync::read_direct_write_status(
                store,
                &workspace_id,
                &share_id,
                &path,
                &granted,
            )
            .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn sync_refusal_notices(
        &self,
        workspace_id: String,
    ) -> Result<Vec<dohc_engine_sync::RefusalNotice>, RuntimeError> {
        self.run(move |store, _cache| {
            dohc_engine_sync::list_refusal_notices(store, &workspace_id).map_err(RuntimeError::from)
        })
        .await
    }

    /// A page of the documents the hosted replica holds for released
    /// retained work; none for a workspace that is not hosted.
    pub async fn held_documents(
        &self,
        workspace_id: String,
        after_object_id: Option<String>,
        limit: usize,
    ) -> Result<Option<dohc_engine_sync::HeldDocumentsPage>, RuntimeError> {
        self.run(move |store, _cache| {
            dohc_engine_sync::list_held_documents(
                store,
                &workspace_id,
                after_object_id.as_deref(),
                limit,
            )
            .map_err(RuntimeError::from)
        })
        .await
    }

    /// One held document and what its binding preserves. The actor only
    /// admits the proof and, once it is done, compares what it read with
    /// bounded reads; the proof runs on a blocking thread of its own, and
    /// nothing on the actor waits for it. An answer whose evidence moved
    /// meanwhile is stale, with nothing preserved, and nothing proves again.
    ///
    /// A caller that asks what the workspace's running proof asks, of the
    /// same state, shares it; any other is busy while that proof's reader is
    /// open, and so is a new proof past the daemon's limit or while the
    /// store's WAL presses on held readers. A request busy whatever it asks
    /// is refused before the actor reads anything. `token`, the caller's own
    /// cancellation or deadline, ends only its wait. The last caller to leave
    /// stops the proof, and answers once the proof ended, its reader closed,
    /// or after twice SQLite's busy timeout. A proof that gave way to
    /// writes, reached its deadline or found no room in the daemon's proof
    /// memory answers busy, and one whose answer would never fit answers too
    /// large. The answer keeps the proof's result charged until the last
    /// caller drops it.
    pub async fn held_document(
        &self,
        workspace_id: String,
        object_id: String,
        token: CancellationToken,
    ) -> Result<Option<dohc_engine_sync::HeldAnswer>, RuntimeError> {
        use dohc_engine_collab::live_update_application::HeldProofError;
        use dohc_engine_sync::HeldProofAdmission;
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if self.held_proofs.refuses(&workspace_id) {
            return Err(RuntimeError::HeldReadBusy);
        }
        let proofs = self.held_proofs.clone();
        let (admitted_workspace, admitted_object) = (workspace_id.clone(), object_id.clone());
        let admission = self
            .run(move |store, _cache| {
                dohc_engine_sync::admit_held_proof(
                    store,
                    &proofs,
                    &admitted_workspace,
                    &admitted_object,
                )
                .map_err(RuntimeError::from)
            })
            .await?;
        let mut wait = match admission {
            HeldProofAdmission::Started(run, wait) => {
                // Nothing awaits the thread: the proof answers its callers,
                // and an unrun one ends as closed. Its reader opens by the
                // store's path, so the thread keeps the store's location
                // until the proof returns, after the actor and every handle.
                let location = self.location();
                drop(tokio::task::spawn_blocking(move || {
                    run.prove(|job| {
                        let proved =
                            dohc_engine_sync::prove_held_document(job, &workspace_id, &object_id)
                                .map_err(Arc::new);
                        let retained = proved
                            .as_ref()
                            .map_or(0, dohc_engine_sync::HeldProof::retained_bytes);
                        (proved, retained)
                    });
                    drop(location);
                }));
                wait
            }
            HeldProofAdmission::Joined(wait) => wait,
            HeldProofAdmission::Busy => return Err(RuntimeError::HeldReadBusy),
            HeldProofAdmission::Closed => return Err(RuntimeError::ActorUnavailable),
        };
        let proved = tokio::select! {
            biased;
            () = token.cancelled() => None,
            proved = &mut wait => Some(proved),
        };
        let Some(proved) = proved else {
            let _ = tokio::time::timeout(
                dohc_engine_collab::live_update_application::HELD_PROOF_CLOSE_BOUND,
                wait.leave(),
            )
            .await;
            return Err(RuntimeError::Cancelled);
        };
        let proved = proved.map_err(|error| match error {
            HeldProofError::Closed => RuntimeError::ActorUnavailable,
            HeldProofError::Busy => RuntimeError::HeldReadBusy,
            HeldProofError::TooLarge => RuntimeError::HeldReadTooLarge,
            HeldProofError::Panicked => RuntimeError::WorkerPanicked,
        })?;
        let proof = match &**proved {
            Ok(proof) => proof,
            Err(failure) => return Err(dohc_engine_sync::shared_proof_failure(failure).into()),
        };
        // Only the bounded freshness goes to the actor: the proof, however
        // large, is dropped here, never there.
        let freshness = proof.freshness().clone();
        let release = self
            .run(move |store, _cache| {
                dohc_engine_sync::check_held_freshness(store, &freshness)
                    .map_err(RuntimeError::from)
            })
            .await?;
        let released = proof.released(release);
        Ok(released
            .map(|inspection| dohc_engine_sync::HeldAnswer::new(inspection, Arc::clone(&proved))))
    }

    pub async fn dismiss_sync_refusal(
        &self,
        workspace_id: String,
        notice_id: String,
        refusal_coordinates: Vec<dohc_engine_sync::RefusalCoordinate>,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _cache| {
            dohc_engine_sync::dismiss_refusal_notice(
                store,
                &workspace_id,
                &notice_id,
                &refusal_coordinates,
                &NoFaults,
            )
            .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn reset_claim_refusal(
        &self,
        workspace_id: String,
        account_id: Option<String>,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _cache| {
            match store.write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE sync_identity SET claim_state='pending', claim_account_id=NULL \
                     WHERE workspace_id=?1 AND claim_state <> 'pending' \
                     AND (?2 IS NULL OR claim_account_id IS NOT ?2)",
                    rusqlite::params![workspace_id, account_id],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok::<_, dohc_engine_storage::StorageError>(())
            })? {
                TxnOutcome::Committed(()) => Ok(()),
                TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
            }
        })
        .await
    }

    /// Make an unfinished ordinary pull's applied pages local truth, for a
    /// workspace that opens with no ordinary sync configured. Answers whether
    /// a pull was unfinished.
    pub async fn abandon_ordinary_pull(&self, workspace_id: String) -> Result<bool, RuntimeError> {
        self.run(move |store, _cache| {
            match dohc_engine_sync::abandon_ordinary_pull(store, &workspace_id, &NoFaults)? {
                TxnOutcome::Committed(abandoned) => Ok(abandoned),
                TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
            }
        })
        .await
    }

    /// Collections updates wait for an unfinished ordinary pull.
    pub async fn ordinary_pull_unfinished(
        &self,
        workspace_id: String,
    ) -> Result<bool, RuntimeError> {
        self.run(move |store, _cache| {
            store
                .read_with(|conn| {
                    dohc_engine_sync::ordinary_pull_unfinished_in(conn, &workspace_id)
                })
                .map_err(RuntimeError::from)
        })
        .await
    }

    /// How many changes that did not originate on this computer the engine
    /// has applied to the workspace; 0 before the first.
    pub async fn remote_changes_applied(&self, workspace_id: String) -> Result<i64, RuntimeError> {
        self.run(move |store, _cache| {
            store
                .read_with(|conn| {
                    dohc_engine_storage::remote_changes_applied_in(conn, &workspace_id)
                })
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn relay(
        &self,
        configuration: RelayConfiguration,
        operation: RelayOperation,
        leases: LeaseRegistry,
        token: CancellationToken,
        reservation: Option<Arc<dyn Send + Sync>>,
    ) -> Result<RelayOperationOutcome, RuntimeError> {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        let http_transport = build_http_transport(configuration)?;
        // A hosted replica reads and writes only the session host's scoped
        // feed, and so does the operation that creates one.
        let workspace_id = operation.workspace_id().to_owned();
        let hosted = operation.replicas() == Replicas::Hosted
            || self
                .run(move |store, _cache| Ok(is_hosted_replica(store, &workspace_id)?))
                .await?;
        let http_transport = Arc::new(if hosted {
            http_transport.hosted()
        } else {
            http_transport
        });
        // Keep the deferred I/O state out of callers' inline RPC futures.
        Box::pin(self.relay_with_io(
            http_transport.publishes_native_settlements(),
            operation,
            leases,
            token,
            reservation,
            move |request, token| execute_http_request(Arc::clone(&http_transport), request, token),
        ))
        .await
    }

    /// [`Self::relay`], answered by `transport` instead of a relay over HTTP.
    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub async fn relay_through<T>(
        &self,
        transport: Arc<T>,
        operation: RelayOperation,
        token: CancellationToken,
    ) -> Result<RelayOperationOutcome, RuntimeError>
    where
        T: RelayTransport + Send + Sync + 'static,
    {
        Box::pin(self.relay_with_io(
            transport.publishes_native_settlements(),
            operation,
            LeaseRegistry::new(),
            token,
            None,
            move |request, _token| {
                let transport = Arc::clone(&transport);
                async move {
                    tokio::task::spawn_blocking(move || {
                        execute_blocking_request(&*transport, request)
                    })
                    .await
                    .map_err(|_| relay_io_aborted())?
                }
            },
        ))
        .await
    }

    async fn relay_with_io<F, Fut>(
        &self,
        native_settlements: bool,
        operation: RelayOperation,
        leases: LeaseRegistry,
        mut token: CancellationToken,
        reservation: Option<Arc<dyn Send + Sync>>,
        execute_io: F,
    ) -> Result<RelayOperationOutcome, RuntimeError>
    where
        F: Fn(RelayIoRequest, CancellationToken) -> Fut,
        Fut: std::future::Future<Output = Result<RelayIoResponse, RelayError>>,
    {
        let transport = DeferredRelayTransport {
            native_settlements,
            ..DeferredRelayTransport::default()
        };
        let _pull = match &operation {
            RelayOperation::Pull { .. } | RelayOperation::PullHosted { .. } => {
                Some(self.pulls.acquire(&token).await?)
            }
            _ => None,
        };
        // Once the relay may have stored something, the operation runs to its
        // end so the request answers with what landed. Until then each step
        // and each effect-free read stops on cancellation.
        let mut preparation_attempt = 0;
        loop {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            let queued_transport = transport.clone();
            let queued_operation = operation.clone();
            let queued_leases = leases.clone();
            let queued_token = token.clone();
            let queued_reservation = reservation.clone();
            let queued_claims = self.claims.clone();
            let outcome = self
                .run_with_registrations(move |store, cache, registrations| {
                    let _reservation = queued_reservation;
                    let is_push = matches!(&queued_operation, RelayOperation::Push { .. });
                    let is_pull = matches!(&queued_operation, RelayOperation::Pull { .. });
                    let outcome = if queued_token.is_cancelled() {
                        Err(RuntimeError::Cancelled)
                    } else {
                        execute_relay_operation(
                            store,
                            cache,
                            queued_transport,
                            queued_operation,
                            &queued_leases,
                            &queued_claims,
                            registrations,
                        )
                    };
                    // Push handles enrollment resets below. A pull that only
                    // redelivers durable echoes leaves the writer cache valid;
                    // applied or materialized work still invalidates it.
                    let pull_changed = match &outcome {
                        Ok(RelayOperationOutcome::Sync(
                            SyncPassOutcome::Complete {
                                applied,
                                changed_paths,
                                ..
                            }
                            | SyncPassOutcome::CrashedAfterApply {
                                applied,
                                changed_paths,
                                ..
                            },
                        )) => *applied > 0 || !changed_paths.is_empty(),
                        Err(RuntimeError::Relay(RelayError::Local(reason)))
                            if reason == RELAY_IO_PENDING =>
                        {
                            false
                        }
                        _ => true,
                    };
                    let unchanged_commit = matches!(
                        &outcome,
                        Ok(RelayOperationOutcome::CursorCommitted {
                            writer_cache_changed: false,
                            ..
                        })
                    );
                    if !is_push && !unchanged_commit && (!is_pull || pull_changed) {
                        cache.clear();
                    }
                    outcome
                })
                .await;
            match outcome {
                Err(RuntimeError::Relay(RelayError::Local(reason)))
                    if reason == RELAY_IO_PENDING =>
                {
                    let request = transport
                        .take_pending()
                        .ok_or(RuntimeError::Relay(RelayError::InvalidResponse))?;
                    if request.changes_relay() {
                        token = CancellationToken::new();
                    }
                    let io_request = request.clone();
                    let result = tokio::select! {
                        biased;
                        () = token.cancelled() => return Err(RuntimeError::Cancelled),
                        result = execute_io(io_request, token.clone()) => result,
                    };
                    transport.complete(request, result);
                }
                // The attempt's transaction ended and the actor is free. The
                // store's worker validates; once it completes, a fresh
                // attempt rereads every fact and goes on from the progress
                // the transport kept.
                Err(RuntimeError::Relay(RelayError::ValidationPending(pending))) => {
                    tokio::select! {
                        biased;
                        () = token.cancelled() => return Err(RuntimeError::Cancelled),
                        validated = pending.validate() => validated.map_err(validation_failed)?,
                    }
                }
                Ok(mut outcome) => {
                    transport.apply_progress(&mut outcome);
                    return Ok(outcome);
                }
                Err(error) => {
                    let result: Result<(), RuntimeError> = Err(error);
                    if super::wait_for_reader(
                        &result,
                        preparation_attempt,
                        self.markdown_recovery.clone(),
                    )
                    .await
                    {
                        preparation_attempt += 1;
                        continue;
                    }
                    return result.map(|()| unreachable!());
                }
            }
        }
    }
}

fn build_http_transport(
    configuration: RelayConfiguration,
) -> Result<HttpRelayTransport, RelayError> {
    if let Some(path) = &configuration.socket_path {
        if !configuration.base_url.is_empty() {
            return Err(RelayError::InvalidResponse);
        }
        return HttpRelayTransport::new_unix_socket(path, configuration.bearer_token);
    }
    #[cfg(debug_assertions)]
    {
        let test_ca = test_relay_ca(
            std::env::var_os(TEST_RELAY_CA_MODE_ENV).as_deref(),
            std::env::var_os(TEST_RELAY_CA_FILE_ENV).as_deref(),
        )?;
        build_debug_http_transport(configuration, test_ca)
    }
    #[cfg(not(debug_assertions))]
    {
        HttpRelayTransport::new(configuration.base_url, configuration.bearer_token)
    }
}

/// A local test relay behind a fixture CA needs both settings: the mode set to
/// "1" and the absolute path of one CA certificate. Either one alone, or a
/// malformed value, refuses every relay request instead of falling back.
#[cfg(debug_assertions)]
const TEST_RELAY_CA_MODE_ENV: &str = "DOHC_ENGINE_TEST_RELAY_CA_MODE";
#[cfg(debug_assertions)]
const TEST_RELAY_CA_FILE_ENV: &str = "DOHC_ENGINE_TEST_RELAY_CA_FILE";

#[cfg(debug_assertions)]
fn test_relay_ca_refused() -> RelayError {
    RelayError::Local("relay-test-ca-invalid".to_owned())
}

#[cfg(debug_assertions)]
fn test_relay_ca(
    mode: Option<&std::ffi::OsStr>,
    file: Option<&std::ffi::OsStr>,
) -> Result<Option<Vec<u8>>, RelayError> {
    match (mode, file) {
        (None, None) => Ok(None),
        (Some(mode), Some(file)) if mode == "1" && std::path::Path::new(file).is_absolute() => {
            std::fs::read(file)
                .map(Some)
                .map_err(|_| test_relay_ca_refused())
        }
        _ => Err(test_relay_ca_refused()),
    }
}

#[cfg(debug_assertions)]
fn build_debug_http_transport(
    configuration: RelayConfiguration,
    test_ca: Option<Vec<u8>>,
) -> Result<HttpRelayTransport, RelayError> {
    let RelayConfiguration {
        base_url,
        socket_path: _,
        bearer_token: token,
        allow_insecure_loopback_for_tests: insecure,
    } = configuration;
    match (insecure, test_ca) {
        (false, None) => HttpRelayTransport::new(base_url, token),
        (true, None) => HttpRelayTransport::new_insecure_loopback_for_tests(base_url, token),
        (false, Some(ca)) => HttpRelayTransport::new_with_test_ca_for_tests(base_url, token, &ca),
        (true, Some(_)) => Err(test_relay_ca_refused()),
    }
}

/// A validation that ended without a result fails its request, which never
/// validates any other way. A store that closed is unavailable.
pub(super) fn validation_failed(
    error: dohc_engine_collab::live_update_application::ValidationError,
) -> RuntimeError {
    use dohc_engine_collab::live_update_application::ValidationError;
    match error {
        ValidationError::Closed => RuntimeError::ActorUnavailable,
        ValidationError::Failed => {
            RuntimeError::Relay(RelayError::Local("released-tails-unvalidated".to_owned()))
        }
        ValidationError::Uncommitted => {
            RuntimeError::Relay(RelayError::Local("released-tails-uncommitted".to_owned()))
        }
    }
}

const MAX_CONCURRENT_BLOB_DOWNLOADS: usize = 4;
const MAX_CONCURRENT_COORDINATE_LOOKUPS: usize = 8;
const RELAY_IO_CANCELLED: &str = "relay-io-cancelled";

fn relay_io_aborted() -> RelayError {
    RelayError::Local(RELAY_IO_ABORTED.to_owned())
}

fn relay_io_cancelled() -> RelayError {
    RelayError::Local(RELAY_IO_CANCELLED.to_owned())
}

async fn execute_http_request(
    transport: Arc<HttpRelayTransport>,
    request: RelayIoRequest,
    token: CancellationToken,
) -> Result<RelayIoResponse, RelayError> {
    if let RelayIoRequest::LookupCoordinates(requests) = request {
        return execute_coordinate_lookup_batch(requests, token, move |request, worker_token| {
            transport.lookup_log_coordinate_cancellable(request, || worker_token.is_cancelled())
        })
        .await
        .map(RelayIoResponse::LookupCoordinates);
    }
    if let RelayIoRequest::DownloadBlobs(request) = request {
        let download_transport = Arc::clone(&transport);
        return execute_blob_download_batch(request, token, move |request, worker_token| {
            download_transport.download_blobs_cancellable(request, || worker_token.is_cancelled())
        })
        .await
        .map(RelayIoResponse::DownloadBlobs);
    }

    tokio::task::spawn_blocking(move || execute_blocking_request(&*transport, request))
        .await
        .map_err(|_| relay_io_aborted())?
}

async fn execute_coordinate_lookup_batch<F>(
    requests: Vec<LogCoordinateRequest>,
    token: CancellationToken,
    lookup: F,
) -> Result<Vec<LogCoordinateResponse>, RelayError>
where
    F: Fn(LogCoordinateRequest, CancellationToken) -> Result<LogCoordinateResponse, RelayError>
        + Clone
        + Send
        + 'static,
{
    if requests.is_empty() || requests.len() > MAX_BASE_REPAIR_LOOKUPS {
        return Err(RelayError::InvalidResponse);
    }
    let workers = token.child_token();
    let _cancel_workers = workers.clone().drop_guard();
    let mut results = vec![None; requests.len()];
    let mut tasks = tokio::task::JoinSet::new();
    let mut requests = requests.into_iter().enumerate();
    loop {
        if token.is_cancelled() {
            return Err(relay_io_cancelled());
        }
        while tasks.len() < MAX_CONCURRENT_COORDINATE_LOOKUPS {
            let Some((index, request)) = requests.next() else {
                break;
            };
            let lookup = lookup.clone();
            let worker_token = workers.clone();
            tasks.spawn_blocking(move || {
                let result = if worker_token.is_cancelled() {
                    Err(relay_io_cancelled())
                } else {
                    lookup(request, worker_token)
                };
                (index, result)
            });
        }
        if tasks.is_empty() {
            break;
        }
        let joined = tokio::select! {
            biased;
            () = token.cancelled() => return Err(relay_io_cancelled()),
            joined = tasks.join_next() => joined,
        };
        let (index, result) = joined
            .ok_or(RelayError::InvalidResponse)?
            .map_err(|_| relay_io_aborted())?;
        results[index] = Some(result?);
    }
    results
        .into_iter()
        .map(|result| result.ok_or(RelayError::InvalidResponse))
        .collect()
}

/// Fan one deterministic bridge request into bounded blocking GETs. At the
/// 20 MiB widest ceiling, four active bodies plus eight capped ordered replies
/// bound blob bytes held here to 240 MiB, plus allocator and request overhead.
async fn execute_blob_download_batch<F>(
    request: BlobDownloadBatchRequest,
    token: CancellationToken,
    download: F,
) -> Result<BlobDownloadBatchResponse, RelayError>
where
    F: Fn(
            BlobDownloadBatchRequest,
            CancellationToken,
        ) -> Result<BlobDownloadBatchResponse, RelayError>
        + Clone
        + Send
        + 'static,
{
    if token.is_cancelled() {
        return Err(relay_io_cancelled());
    }
    if request.blobs.is_empty() || request.blobs.len() > MAX_BLOB_DOWNLOAD_BATCH {
        return Err(RelayError::InvalidResponse);
    }

    let result_count = request.blobs.len();
    let mut results = vec![None; result_count];
    let mut tasks = tokio::task::JoinSet::new();
    let mut next = 0;

    while next < result_count || !tasks.is_empty() {
        while next < result_count && tasks.len() < MAX_CONCURRENT_BLOB_DOWNLOADS {
            if token.is_cancelled() {
                tasks.abort_all();
                return Err(relay_io_cancelled());
            }
            let index = next;
            let single = BlobDownloadBatchRequest {
                workspace_id: request.workspace_id.clone(),
                replication_epoch: request.replication_epoch.clone(),
                stream_identity: request.stream_identity.clone(),
                blobs: vec![request.blobs[index].clone()],
            };
            let download = download.clone();
            let worker_token = token.clone();
            tasks.spawn_blocking(move || {
                let result = match download(single, worker_token) {
                    Ok(response) => {
                        let mut results = response.results.into_iter();
                        match (results.next(), results.next()) {
                            (Some(result), None) => result,
                            _ => Err(RelayError::InvalidResponse),
                        }
                    }
                    Err(error) => Err(error),
                };
                (index, result)
            });
            next += 1;
        }

        let joined = tokio::select! {
            biased;
            () = token.cancelled() => {
                tasks.abort_all();
                return Err(relay_io_cancelled());
            }
            joined = tasks.join_next() => joined,
        };
        let (index, result) = joined
            .ok_or(RelayError::InvalidResponse)?
            .map_err(|_| relay_io_aborted())?;
        results[index] = Some(result);
    }
    if token.is_cancelled() {
        return Err(relay_io_cancelled());
    }

    let results = results
        .into_iter()
        .map(|result| result.ok_or(RelayError::InvalidResponse))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(BlobDownloadBatchResponse { results })
}

fn execute_blocking_request<T: RelayTransport + ?Sized>(
    transport: &T,
    request: RelayIoRequest,
) -> Result<RelayIoResponse, RelayError> {
    match request {
        RelayIoRequest::Push(request) => transport.push(request).map(RelayIoResponse::Push),
        RelayIoRequest::Pull(request) => transport.pull(request).map(RelayIoResponse::Pull),
        RelayIoRequest::PushHosted(request) => {
            transport.push_hosted(request).map(RelayIoResponse::Push)
        }
        RelayIoRequest::PullHosted(request) => transport
            .pull_hosted(request)
            .map(RelayIoResponse::PullHosted),
        RelayIoRequest::LookupCoordinates(requests) => transport
            .lookup_log_coordinates(requests)
            .map(RelayIoResponse::LookupCoordinates),
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
        RelayIoRequest::UploadBlobs(requests) => transport
            .upload_blobs(requests)
            .map(|()| RelayIoResponse::UploadBlob),
        RelayIoRequest::UploadBlob(request) => transport
            .upload_blob(request)
            .map(|()| RelayIoResponse::UploadBlob),
        RelayIoRequest::DownloadBlobs(request) => transport
            .download_blobs(request)
            .map(RelayIoResponse::DownloadBlobs),
        RelayIoRequest::UploadKeyEnvelope(request) => transport
            .upload_key_envelope(request)
            .map(RelayIoResponse::UploadKeyEnvelope),
        RelayIoRequest::DownloadKeyEnvelope(request) => transport
            .download_key_envelope(request)
            .map(RelayIoResponse::DownloadKeyEnvelope),
        RelayIoRequest::SharedChannelPull(request) => transport
            .shared_channel_pull(request)
            .map(RelayIoResponse::SharedChannelPull),
        RelayIoRequest::ShareLogPush(request) => transport
            .share_log_push(request)
            .map(RelayIoResponse::ShareLogPush),
        RelayIoRequest::ShareViewPull(request) => transport
            .share_view_pull(request)
            .map(RelayIoResponse::ShareViewPull),
        RelayIoRequest::ShareBlob(request) => transport
            .share_blob(request)
            .map(RelayIoResponse::ShareBlob),
        RelayIoRequest::ShareBlobUpload(request) => transport
            .share_blob_upload(request)
            .map(|()| RelayIoResponse::ShareBlobUpload),
        RelayIoRequest::ShareProposalSubmit(request) => transport
            .share_proposal_submit(request)
            .map(RelayIoResponse::ShareProposalSubmit),
        RelayIoRequest::ShareCollectionWrite(request) => transport
            .share_collection_write(request)
            .map(RelayIoResponse::ShareCollectionWrite),
    }
}

/// Run one relay operation, then announce every Group automation claim its
/// applies committed. A pass that fails on a later envelope still announces
/// them: its retry finds those messages stored and claims nothing again.
fn execute_relay_operation(
    store: &mut EngineStore,
    doc_cache: &mut WriterDocCache,
    transport: DeferredRelayTransport,
    operation: RelayOperation,
    leases: &LeaseRegistry,
    claims: &ClaimAnnouncer,
    registrations: &mut super::live_application::Registry,
) -> Result<RelayOperationOutcome, RuntimeError> {
    let continuation = transport.continuation.clone();
    let client = RelaySyncClient::resuming(transport, continuation);
    let outcome = run_relay_operation(store, doc_cache, &client, operation, leases, registrations);
    claims.announce(&client.take_automation_claims());
    if outcome.is_err()
        && let Some(pending) = client.take_pending_preparation()
    {
        use dohc_engine_collab::markdown_write_safety::PendingPreparation;
        return Err(match pending {
            PendingPreparation::Reader(pending) => SyncError::MarkdownReaderPending(pending).into(),
            PendingPreparation::Witness { key, path, pending } => {
                SyncError::MarkdownWitnessCheckPending { key, path, pending }.into()
            }
        });
    }
    outcome
}

fn run_relay_operation(
    store: &mut EngineStore,
    doc_cache: &mut WriterDocCache,
    client: &RelaySyncClient<DeferredRelayTransport>,
    operation: RelayOperation,
    leases: &LeaseRegistry,
    registrations: &mut super::live_application::Registry,
) -> Result<RelayOperationOutcome, RuntimeError> {
    let replicas = operation.replicas();
    if store.is_passive()
        && !matches!(
            &operation,
            RelayOperation::Pull { .. }
                | RelayOperation::CommitCursor { .. }
                | RelayOperation::AdoptJoinIdentity { .. }
        )
    {
        if replicas == Replicas::Hosted {
            return Err(RuntimeError::Relay(RelayError::HostedRefusal(
                dohc_engine_sync::PASSIVE_STORE_CANNOT_HOST,
            )));
        }
        return Err(RuntimeError::Sync(SyncError::InvalidInput {
            reason: "passive store cannot execute this relay operation",
        }));
    }
    // Before any state change or relay request: a hosted replica reaches only
    // its hosted feed.
    if replicas == Replicas::Ordinary && is_hosted_replica(store, operation.workspace_id())? {
        return Err(RuntimeError::Relay(dohc_engine_sync::hosted_feed_only()));
    }
    match operation {
        RelayOperation::Push {
            workspace_id,
            now_ms,
            max_read_bytes,
        } => {
            let mut progress = client
                .transport()
                .push_progress
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let outcome = client.resume_push_workspace(
                store,
                &workspace_id,
                &NoFaults,
                leases,
                now_ms,
                max_read_bytes,
                &mut progress,
            );
            // Enrollment can claim bases before I/O yields or an error.
            if progress.writer_cache_reset_required() {
                doc_cache.clear();
            }
            outcome
                .map(RelayOperationOutcome::Sync)
                .map_err(RuntimeError::from)
        }
        RelayOperation::Pull {
            workspace_id,
            now_ms,
        } => client
            .pull_chat_workspace(store, doc_cache, &workspace_id, &NoFaults, leases, now_ms)
            .map(RelayOperationOutcome::Sync)
            .map_err(RuntimeError::from),
        RelayOperation::CommitCursor {
            workspace_id,
            cursor,
            now_ms,
        } => match client.commit_pull_cursor(
            store,
            &workspace_id,
            &cursor,
            &CursorFaults,
            leases,
            now_ms,
        )? {
            TxnOutcome::Committed(commit) => Ok(RelayOperationOutcome::CursorCommitted {
                sharing_declined: commit.sharing_declined,
                writer_cache_changed: commit.writer_cache_changed,
            }),
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
        RelayOperation::Claim {
            workspace_id,
            account_id,
            new_origin_id,
            new_replication_epoch,
            new_stream_identity,
            created_at_ms,
        } => {
            let identity = match read_sync_identity(store, &workspace_id)? {
                Some(identity) => identity,
                None => {
                    match create_claim_identity(
                        store,
                        &workspace_id,
                        &new_origin_id,
                        &new_replication_epoch,
                        &new_stream_identity,
                        created_at_ms,
                        &NoFaults,
                    )? {
                        TxnOutcome::Committed(_) => {}
                        TxnOutcome::Crashed { .. } => {
                            return Err(RuntimeError::OperationCrashed);
                        }
                    }
                    read_sync_identity(store, &workspace_id)?
                        .ok_or(dohc_engine_sync::RelayError::InvalidResponse)?
                }
            };
            client.claim_workspace(
                store,
                ClaimRequest {
                    workspace_id,
                    replication_epoch: identity.replication_epoch,
                    stream_identity: identity.stream_identity,
                },
                account_id.as_deref(),
                &NoFaults,
            )?;
            Ok(RelayOperationOutcome::Claimed)
        }
        RelayOperation::AdoptJoinIdentity {
            workspace_id,
            new_origin_id,
            replication_epoch,
            stream_identity,
            created_at_ms,
        } => match adopt_join_identity(
            store,
            &workspace_id,
            &new_origin_id,
            &replication_epoch,
            &stream_identity,
            created_at_ms,
            &NoFaults,
        )? {
            TxnOutcome::Committed(_) => Ok(RelayOperationOutcome::JoinIdentityAdopted),
            TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
        },
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
            granted,
        } => client
            .pull_share_view(store, &workspace_id, &share_id, &granted, &NoFaults)
            .map(RelayOperationOutcome::ShareViewPulled)
            .map_err(RuntimeError::from),
        RelayOperation::RecordShareViewIdentity {
            workspace_id,
            access,
            origin_id,
            replication_epoch,
            stream_identity,
            created_at_ms,
        } => {
            // The level gate, and the only place it is read. Only Edit sends
            // workspace replication ops, so View and Comment need no
            // identity and the store is not touched at all.
            if access != dohc_engine_sync::ShareAccess::Edit {
                return Ok(RelayOperationOutcome::ShareViewIdentity(
                    ShareViewIdentityRecord::NotRequired,
                ));
            }
            match dohc_engine_sync::record_share_view_identity(
                store,
                &workspace_id,
                dohc_engine_sync::ShareViewIdentity {
                    origin_id: &origin_id,
                    replication_epoch: &replication_epoch,
                    stream_identity: &stream_identity,
                },
                created_at_ms,
                &NoFaults,
            )? {
                TxnOutcome::Committed(outcome) => {
                    Ok(RelayOperationOutcome::ShareViewIdentity(match outcome {
                        dohc_engine_sync::ShareViewIdentityOutcome::Recorded => {
                            ShareViewIdentityRecord::Recorded
                        }
                        dohc_engine_sync::ShareViewIdentityOutcome::AlreadyRecorded => {
                            ShareViewIdentityRecord::AlreadyRecorded
                        }
                    }))
                }
                TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
            }
        }
        RelayOperation::SubmitShareProposal {
            workspace_id,
            share_id,
            granted,
            submit_id,
            max_read_bytes,
        } => client
            .submit_share_proposal(
                store,
                &workspace_id,
                &share_id,
                &granted,
                &submit_id,
                &NoFaults,
                max_read_bytes,
            )
            .map(RelayOperationOutcome::ShareProposalSubmitted)
            .map_err(RuntimeError::from),
        RelayOperation::PushDirectWrites {
            workspace_id,
            share_id,
            granted,
            max_read_bytes,
        } => client
            .push_direct_writes(
                store,
                &workspace_id,
                &share_id,
                &granted,
                &NoFaults,
                max_read_bytes,
            )
            .map(RelayOperationOutcome::DirectWritesPushed)
            .map_err(RuntimeError::from),
        RelayOperation::CommitShareViewCursor {
            workspace_id,
            cursor,
        } => match client.commit_share_view_cursor(store, &workspace_id, &cursor, &NoFaults)? {
            TxnOutcome::Committed(()) => Ok(RelayOperationOutcome::CursorCommitted {
                sharing_declined: Vec::new(),
                writer_cache_changed: true,
            }),
            TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
        },
        RelayOperation::CreateHostedReplica {
            workspace_id,
            new_origin_id,
            replication_epoch,
            stream_identity,
            created_at_ms,
        } => {
            match create_hosted_replica(
                store,
                &workspace_id,
                &new_origin_id,
                &replication_epoch,
                &stream_identity,
                created_at_ms,
                &NoFaults,
            )
            .map_err(|error| match error {
                SyncError::InvalidInput { reason } => {
                    RuntimeError::Relay(RelayError::HostedRefusal(reason))
                }
                error => RuntimeError::Sync(error),
            })? {
                TxnOutcome::Committed(_) => {}
                TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
            }
            // After the commit, so a lost answer leaves the replica created
            // and the retry asks again.
            client.confirm_hosted_origin(store, &workspace_id)?;
            Ok(RelayOperationOutcome::HostedReplicaCreated)
        }
        RelayOperation::PullHosted {
            workspace_id,
            root,
            relay_namespace,
            now_ms,
        } => {
            let pass = client.pull_hosted_workspace(
                store,
                doc_cache,
                &workspace_id,
                &relay_namespace,
                &NoFaults,
                leases,
            )?;
            // A pass without a cursor adopted a new scope.
            if pass.pending_cursor.is_none() {
                park_departed_hosted(store, doc_cache, leases, &workspace_id, &root, now_ms)?;
            }
            Ok(RelayOperationOutcome::HostedPass {
                pass,
                unready: release_unready_hosted(store, registrations, &workspace_id)?,
                departed: dohc_engine_sync::departed_hosted_object_ids(store, &workspace_id)?,
            })
        }
        RelayOperation::CommitHostedCursor {
            workspace_id,
            cursor,
            root,
            now_ms,
        } => match client.commit_hosted_cursor(
            store,
            &workspace_id,
            &cursor,
            &doc_cache.released_tails(store),
            &NoFaults,
        )? {
            TxnOutcome::Committed(commit) => {
                let retirement =
                    park_departed_hosted(store, doc_cache, leases, &workspace_id, &root, now_ms);
                Ok(RelayOperationOutcome::HostedCursorCommitted {
                    commit,
                    retirement,
                    unready: release_unready_hosted(store, registrations, &workspace_id),
                    departed: dohc_engine_sync::departed_hosted_object_ids(store, &workspace_id)
                        .map_err(RuntimeError::from),
                })
            }
            TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
        },
    }
}

/// Release the live registrations of each document of the hosted scope that
/// is not ready, held or backfilling again: none can be edited live until a
/// later commit settles it ready. The release is in memory only, so its
/// accepted work still pushes. A document that left the scope keeps its
/// registrations until it drains.
fn release_unready_hosted(
    store: &EngineStore,
    registrations: &mut super::live_application::Registry,
    workspace_id: &str,
) -> Result<Vec<String>, RuntimeError> {
    let unready = dohc_engine_sync::read_hosted_replica(store, workspace_id)?
        .map(|replica| {
            replica
                .documents
                .into_iter()
                .filter(|(_, document)| {
                    document.status != dohc_engine_sync::HostedDocumentStatus::Ready
                })
                .map(|(object_id, _)| object_id)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    registrations.release(workspace_id, &unready);
    Ok(unready)
}

/// Park each hosted document that left the scope once nothing of it is left
/// to settle, deliver or push: no live session holds it, the unload checks
/// pass, and its file holds its head or nothing. Each parks in its own
/// transaction, which records its file as retired; the file goes after, and
/// a file an earlier pass could not remove goes first. A pass can stop after
/// it applied a document's rows and before it wrote their files, and once it
/// leaves the scope no pass serves those rows again, so such a document's
/// files are first written as the pass that makes it ready writes them. A
/// file holding anything else after that is a bug in a service root nothing
/// else writes to, so its document stays departed, the others still park,
/// and the pass names the first such file, or else the first such write that
/// failed. Answers whether any document parked or any path came free.
fn park_departed_hosted(
    store: &mut EngineStore,
    doc_cache: &mut WriterDocCache,
    leases: &LeaseRegistry,
    workspace_id: &str,
    root: &std::path::Path,
    now_ms: i64,
) -> Result<bool, RuntimeError> {
    let active = dohc_engine_domain::VersionedTextStore::new(store)
        .get_active_version(workspace_id)?
        .version_id;
    let mut unexpected = None;
    let mut unwritten = None;
    let mut parked = remove_retired_files(store, workspace_id, root, &mut unexpected)?;
    'departed: for document in dohc_engine_sync::departed_hosted_documents(store, workspace_id)? {
        let versions = document
            .heads
            .iter()
            .map(|head| &head.version_id)
            .chain(&document.ydoc_versions)
            .collect::<std::collections::BTreeSet<_>>();
        let keys = versions
            .into_iter()
            .map(|version_id| {
                dohc_engine_collab::DocKey::new(workspace_id, version_id, &document.object_id)
            })
            .collect::<Result<Vec<_>, _>>()?;
        if keys.iter().any(|key| leases.is_held(key))
            || !dohc_engine_sync::hosted_document_parkable(
                store,
                workspace_id,
                &document.object_id,
            )?
        {
            continue;
        }
        for key in &keys {
            if super::ydoc::ydoc_unload_pending(store, key, root, now_ms)?.is_some() {
                continue 'departed;
            }
        }
        let finished = dohc_engine_sync::departed_hosted_materialization(
            store,
            workspace_id,
            &document.object_id,
            &active,
        )
        .map_err(RuntimeError::from)
        .and_then(|page| match page {
            Some(page) => super::versions::materialize_relay_page_on_store(
                store,
                workspace_id,
                root,
                page,
                &(),
                now_ms,
                &CancellationToken::new(),
            ),
            None => Ok(()),
        });
        if let Err(error) = finished {
            unwritten.get_or_insert(error);
            continue;
        }
        let files = document
            .heads
            .iter()
            .filter(|head| head.version_id == active)
            .collect::<Vec<_>>();
        for head in &files {
            use dohc_engine_files::ProjectionTargetState as File;
            match dohc_engine_files::probe_projection_target(
                root,
                &head.path,
                dohc_engine_files::ProjectionTargetKind::Plaintext,
            ) {
                File::Absent => {}
                File::Text { sha256 } | File::Binary { sha256 } if sha256 == head.sha256 => {}
                _ => {
                    unexpected.get_or_insert_with(|| head.path.clone());
                    continue 'departed;
                }
            }
        }
        match dohc_engine_sync::park_hosted_document(
            store,
            workspace_id,
            &document.object_id,
            &active,
            &NoFaults,
        )? {
            TxnOutcome::Committed(true) => {}
            TxnOutcome::Committed(false) => continue,
            TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
        }
        parked = true;
        for key in &keys {
            doc_cache.remove(key);
            doc_cache.unpin(key);
        }
        remove_retired_files(store, workspace_id, root, &mut unexpected)?;
    }
    match (unexpected, unwritten) {
        (Some(path), _) => Err(RuntimeError::HostedFileUnexpected { path }),
        (None, Some(error)) => Err(error),
        (None, None) => Ok(parked),
    }
}

/// Remove each retired file that still holds its document's head, and free
/// its path. One that holds anything else stays on disk with its path held,
/// so its document stays departed; the first such path goes in `unexpected`
/// for the pass to name. A removal that fails also keeps the path held for
/// the next pass. The folders a removed file leaves empty go too, so a file
/// can take their name; an empty one that cannot go keeps the path held, and
/// with it each folder above, until a later pass removes it; that pass walks
/// past the folders already gone. A folder that cannot be inspected also
/// keeps the path held. Answers whether any path came free.
fn remove_retired_files(
    store: &mut EngineStore,
    workspace_id: &str,
    root: &std::path::Path,
    unexpected: &mut Option<String>,
) -> Result<bool, RuntimeError> {
    let mut freed = false;
    for file in dohc_engine_sync::retired_hosted_files(store, workspace_id)? {
        if !dohc_engine_files::remove_file_holding(store, root, &file.path, &file.sha256)? {
            unexpected.get_or_insert(file.path);
            continue;
        }
        let mut stuck = false;
        let mut parent = file.path.as_str();
        while let Some((folder, _)) = parent.rsplit_once('/') {
            let path = root.join(folder);
            match left_folder(
                dohc_engine_files::remove_empty_directory_target(store, root, folder),
                || std::fs::symlink_metadata(&path).map(|m| m.is_dir()),
                || Ok(std::fs::read_dir(&path)?.next().transpose()?.is_none()),
            ) {
                // An earlier pass removed it; an empty folder above may remain.
                LeftFolder::Removed | LeftFolder::Gone => {}
                LeftFolder::HasContent => break,
                LeftFolder::Stuck => {
                    stuck = true;
                    break;
                }
            }
            parent = folder;
        }
        if stuck {
            continue;
        }
        freed = true;
        match dohc_engine_sync::forget_retired_hosted_file(
            store,
            workspace_id,
            &file.path,
            &NoFaults,
        )? {
            TxnOutcome::Committed(()) => {}
            TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
        }
    }
    Ok(freed)
}

/// What became of a folder a removed retired file left.
#[derive(Debug, PartialEq, Eq)]
enum LeftFolder {
    Removed,
    Gone,
    HasContent,
    Stuck,
}

/// Fail closed: the path goes free only past a folder that is surely gone
/// or surely holds something; any other answer keeps it held.
fn left_folder<E>(
    removed: Result<bool, E>,
    is_dir: impl FnOnce() -> std::io::Result<bool>,
    is_empty: impl FnOnce() -> std::io::Result<bool>,
) -> LeftFolder {
    match removed {
        Ok(true) => return LeftFolder::Removed,
        Ok(false) => {}
        Err(_) => return LeftFolder::Stuck,
    }
    match is_dir() {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => LeftFolder::Gone,
        Err(_) => LeftFolder::Stuck,
        Ok(false) => LeftFolder::HasContent,
        Ok(true) => match is_empty() {
            Ok(false) => LeftFolder::HasContent,
            Ok(true) | Err(_) => LeftFolder::Stuck,
        },
    }
}

#[cfg(test)]
#[path = "scene_unload_tests.rs"]
mod scene_unload_tests;

#[cfg(test)]
mod left_folder_tests {
    use super::{LeftFolder, left_folder};
    use std::io::{Error, ErrorKind, Result};

    fn unreachable() -> Result<bool> {
        panic!("inspected a folder whose answer was already known")
    }

    fn denied() -> Result<bool> {
        Err(Error::from(ErrorKind::PermissionDenied))
    }

    #[test]
    fn a_removed_folder_is_not_inspected() {
        let removed = left_folder(Ok::<_, ()>(true), unreachable, unreachable);
        assert_eq!(removed, LeftFolder::Removed);
    }

    #[test]
    fn a_failed_removal_keeps_the_path_held() {
        let stuck = left_folder(Err(()), unreachable, unreachable);
        assert_eq!(stuck, LeftFolder::Stuck);
    }

    #[test]
    fn only_a_missing_folder_counts_as_gone() {
        let missing = || Err(Error::from(ErrorKind::NotFound));
        assert_eq!(
            left_folder(Ok::<_, ()>(false), missing, unreachable),
            LeftFolder::Gone
        );
        assert_eq!(
            left_folder(Ok::<_, ()>(false), denied, unreachable),
            LeftFolder::Stuck
        );
    }

    #[test]
    fn a_folder_that_holds_something_lets_the_path_go() {
        assert_eq!(
            left_folder(Ok::<_, ()>(false), || Ok(true), || Ok(false)),
            LeftFolder::HasContent
        );
        assert_eq!(
            left_folder(Ok::<_, ()>(false), || Ok(false), unreachable),
            LeftFolder::HasContent
        );
    }

    #[test]
    fn an_empty_or_unlisted_folder_keeps_the_path_held() {
        assert_eq!(
            left_folder(Ok::<_, ()>(false), || Ok(true), || Ok(true)),
            LeftFolder::Stuck
        );
        assert_eq!(
            left_folder(Ok::<_, ()>(false), || Ok(true), denied),
            LeftFolder::Stuck
        );
    }
}

/// The level gate on share-view enrolment, read at the one place
/// that writes the row. `EnrollShareView` never touches the transport, so
/// this drives `execute_relay_operation` directly.
#[cfg(test)]
mod share_view_identity_tests {
    use super::*;
    use dohc_engine_sync::ShareAccess;
    use dohc_engine_testkit::ScratchDir;
    use rusqlite::OptionalExtension;

    #[test]
    fn claim_creation_stays_pending_across_restart_until_transport_confirmation() {
        for before_transport in [true, false] {
            let scratch = ScratchDir::new().unwrap();
            let path = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
            let mut store = EngineStore::open(&path, 1_000).unwrap();
            let operation = RelayOperation::Claim {
                workspace_id: "ws".to_owned(),
                account_id: Some("account-a".to_owned()),
                new_origin_id: "origin".to_owned(),
                new_replication_epoch: "epoch".to_owned(),
                new_stream_identity: "stream".to_owned(),
                created_at_ms: 1_000,
            };
            let transport = DeferredRelayTransport::default();
            let mut cache = WriterDocCache::new();
            if before_transport {
                create_claim_identity(
                    &mut store, "ws", "origin", "epoch", "stream", 1_000, &NoFaults,
                )
                .unwrap();
            } else {
                let result = execute_relay_operation(
                    &mut store,
                    &mut cache,
                    transport.clone(),
                    operation.clone(),
                    &LeaseRegistry::default(),
                    &ClaimAnnouncer::default(),
                    &mut crate::actor::live_application::Registry::default(),
                );
                assert!(
                    matches!(result, Err(RuntimeError::Relay(RelayError::Local(reason))) if reason == RELAY_IO_PENDING)
                );
            }
            drop(store);
            let mut store = EngineStore::open(&path, 2_000).unwrap();
            let push = RelayOperation::Push {
                workspace_id: "ws".to_owned(),
                now_ms: 2_000,
                max_read_bytes: 0,
            };
            assert!(matches!(
                execute_relay_operation(
                    &mut store,
                    &mut cache,
                    transport.clone(),
                    push.clone(),
                    &LeaseRegistry::default(),
                    &ClaimAnnouncer::default(),
                    &mut crate::actor::live_application::Registry::default()
                ),
                Err(RuntimeError::Relay(RelayError::IdentityRequired))
            ));
            let result = execute_relay_operation(
                &mut store,
                &mut cache,
                transport.clone(),
                operation.clone(),
                &LeaseRegistry::default(),
                &ClaimAnnouncer::default(),
                &mut crate::actor::live_application::Registry::default(),
            );
            assert!(result.is_err());
            let request = transport.take_pending().unwrap();
            assert!(matches!(request, RelayIoRequest::Claim(_)));
            transport.complete(request, Ok(RelayIoResponse::Claim(ClaimResponse)));
            assert!(matches!(
                execute_relay_operation(
                    &mut store,
                    &mut cache,
                    transport,
                    operation,
                    &LeaseRegistry::default(),
                    &ClaimAnnouncer::default(),
                    &mut crate::actor::live_application::Registry::default()
                ),
                Ok(RelayOperationOutcome::Claimed)
            ));
            let state: Option<String> = store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT claim_state FROM sync_identity WHERE workspace_id='ws'",
                        [],
                        |row| row.get(0),
                    )
                })
                .unwrap();
            assert_eq!(state, None);
        }
    }

    fn record(store: &mut EngineStore, access: ShareAccess) -> ShareViewIdentityRecord {
        let mut doc_cache = WriterDocCache::new();
        let outcome = execute_relay_operation(
            store,
            &mut doc_cache,
            DeferredRelayTransport::default(),
            RelayOperation::RecordShareViewIdentity {
                workspace_id: "ws".to_owned(),
                access,
                origin_id: "origin_share-view".to_owned(),
                replication_epoch: "epoch_share-view".to_owned(),
                stream_identity: "stream_share-view".to_owned(),
                created_at_ms: 1_000,
            },
            &LeaseRegistry::default(),
            &ClaimAnnouncer::default(),
            &mut crate::actor::live_application::Registry::default(),
        )
        .expect("recording runs");
        match outcome {
            RelayOperationOutcome::ShareViewIdentity(record) => record,
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    fn identity(store: &EngineStore) -> Option<String> {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT origin_id FROM sync_identity WHERE workspace_id='ws'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()
            })
            .expect("read identity")
    }

    /// A View share sends no workspace replication ops, so it is given no
    /// identity. The absence keeps its file writes local.
    #[test]
    fn a_view_share_is_never_enrolled() {
        let scratch = ScratchDir::new().expect("scratch");
        let path = dohc_engine_testkit::engine_db_path(&scratch).expect("db path");
        let mut store = EngineStore::open(&path, 1_000).expect("open");
        assert_eq!(
            record(&mut store, ShareAccess::View),
            ShareViewIdentityRecord::NotRequired,
        );
        assert_eq!(
            identity(&store),
            None,
            "a view share must never gain a sync identity",
        );
    }

    #[test]
    fn a_comment_share_is_never_enrolled() {
        let scratch = ScratchDir::new().expect("scratch");
        let path = dohc_engine_testkit::engine_db_path(&scratch).expect("db path");
        let mut store = EngineStore::open(&path, 1_000).expect("open");
        assert_eq!(
            record(&mut store, ShareAccess::Comment),
            ShareViewIdentityRecord::NotRequired,
        );
        assert_eq!(
            identity(&store),
            None,
            "comment discussion no longer uses the workspace sync identity",
        );
    }

    fn file_lane(store: &EngineStore) -> bool {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM share_view_file_lane WHERE workspace_id='ws')",
                    [],
                    |row| row.get::<_, bool>(0),
                )
            })
            .expect("read file lane")
    }

    /// The level mapping, at the one place that makes it: only Edit can send
    /// workspace replication ops, so only Edit records an identity and takes
    /// the file lane.
    #[test]
    fn only_an_edit_share_takes_the_file_lane() {
        for access in [ShareAccess::View, ShareAccess::Comment] {
            let scratch = ScratchDir::new().expect("scratch");
            let path = dohc_engine_testkit::engine_db_path(&scratch).expect("db path");
            let mut store = EngineStore::open(&path, 1_000).expect("open");
            assert_eq!(
                record(&mut store, access),
                ShareViewIdentityRecord::NotRequired
            );
            assert_eq!(
                identity(&store),
                None,
                "{access:?} must not record an identity",
            );
            assert!(!file_lane(&store), "{access:?} takes no file lane");
        }

        let scratch = ScratchDir::new().expect("scratch");
        let path = dohc_engine_testkit::engine_db_path(&scratch).expect("db path");
        let mut store = EngineStore::open(&path, 1_000).expect("open");
        assert_eq!(
            record(&mut store, ShareAccess::Edit),
            ShareViewIdentityRecord::Recorded
        );
        assert_eq!(identity(&store).as_deref(), Some("origin_share-view"));
        assert!(file_lane(&store), "Edit must take the file lane");
    }

    /// Edit records once; repeated refreshes cannot split the replica log.
    #[test]
    fn an_edit_share_enrols_once_per_workspace() {
        let scratch = ScratchDir::new().expect("scratch");
        let path = dohc_engine_testkit::engine_db_path(&scratch).expect("db path");
        let mut store = EngineStore::open(&path, 1_000).expect("open");
        assert_eq!(
            record(&mut store, ShareAccess::Edit),
            ShareViewIdentityRecord::Recorded,
        );
        assert_eq!(identity(&store).as_deref(), Some("origin_share-view"));
        assert_eq!(
            record(&mut store, ShareAccess::Edit),
            ShareViewIdentityRecord::AlreadyRecorded,
            "every refresh calls this; a second row would split the log",
        );
    }
}

#[cfg(test)]
mod hosted_refusal_tests {
    use super::*;
    use dohc_engine_sync::{CursorKind, ShareAccess, ShareGrant};
    use dohc_engine_testkit::ScratchDir;

    /// Every row of every table, to show a refusal changed nothing.
    fn everything(store: &EngineStore) -> Vec<String> {
        store
            .read_with(|conn| {
                let tables = conn
                    .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                let mut rows = Vec::new();
                for table in tables {
                    let mut statement = conn.prepare(&format!("SELECT * FROM \"{table}\""))?;
                    let columns = statement.column_count();
                    let mut query = statement.query([])?;
                    while let Some(row) = query.next()? {
                        let values = (0..columns)
                            .map(|column| row.get::<_, rusqlite::types::Value>(column))
                            .collect::<Result<Vec<_>, _>>()?;
                        rows.push(format!("{table}: {values:?}"));
                    }
                }
                Ok::<_, rusqlite::Error>(rows)
            })
            .unwrap()
    }

    /// Sol's slice-4 review: ordinary operations reached ordinary relay
    /// routes from a hosted replica, and a claim left `pending` behind.
    /// Each is refused with its reason before it writes or sends anything.
    #[test]
    fn a_hosted_replica_refuses_every_ordinary_operation_untouched() {
        let scratch = ScratchDir::new().unwrap();
        let path = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&path, 1_000).unwrap();
        create_hosted_replica(
            &mut store,
            "ws",
            "service-host:host",
            "epoch",
            "stream",
            1_000,
            &NoFaults,
        )
        .unwrap();
        let ws = || "ws".to_owned();
        let granted = || ShareGrant {
            paths: Vec::new(),
            version_id: None,
            access: ShareAccess::Edit,
        };
        let operations = [
            RelayOperation::Pull {
                workspace_id: ws(),
                now_ms: 2_000,
            },
            RelayOperation::CommitCursor {
                workspace_id: ws(),
                cursor: RelayCursor {
                    cursor: 1,
                    replication_epoch: "epoch".into(),
                    stream_identity: "stream".into(),
                    bootstrap_complete: true,
                    settlement_report_id: None,
                    ordinary_pull: None,
                },
                now_ms: 2_000,
            },
            RelayOperation::Probe { workspace_id: ws() },
            RelayOperation::Claim {
                workspace_id: ws(),
                account_id: Some("account".into()),
                new_origin_id: "origin".into(),
                new_replication_epoch: "epoch-2".into(),
                new_stream_identity: "stream-2".into(),
                created_at_ms: 2_000,
            },
            RelayOperation::AdoptJoinIdentity {
                workspace_id: ws(),
                new_origin_id: "origin".into(),
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                created_at_ms: 2_000,
            },
            RelayOperation::RecoverOrigin {
                workspace_id: ws(),
                new_origin_id: "service-host:rebased".into(),
            },
            RelayOperation::UploadKeyEnvelope {
                workspace_id: ws(),
                envelope_json: "{}".into(),
                if_match: None,
            },
            RelayOperation::DownloadKeyEnvelope { workspace_id: ws() },
            RelayOperation::PullSharedChannel {
                workspace_id: ws(),
                share_id: "share".into(),
                channel_wire_id: "wire".into(),
            },
            RelayOperation::PushSharedChannel {
                workspace_id: ws(),
                share_id: "share".into(),
                channel_wire_id: "wire".into(),
            },
            RelayOperation::PullShareView {
                workspace_id: ws(),
                share_id: "share".into(),
                granted: granted(),
            },
            RelayOperation::RecordShareViewIdentity {
                workspace_id: ws(),
                access: ShareAccess::Edit,
                origin_id: "origin".into(),
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                created_at_ms: 2_000,
            },
            RelayOperation::SubmitShareProposal {
                workspace_id: ws(),
                share_id: "share".into(),
                granted: granted(),
                submit_id: "submit".into(),
                max_read_bytes: 0,
            },
            RelayOperation::PushDirectWrites {
                workspace_id: ws(),
                share_id: "share".into(),
                granted: granted(),
                max_read_bytes: 0,
            },
            RelayOperation::CommitShareViewCursor {
                workspace_id: ws(),
                cursor: ShareCursor {
                    kind: CursorKind::ShareView,
                    share_id: "share".into(),
                    cursor: 1,
                },
            },
        ];
        let before = everything(&store);
        let mut cache = WriterDocCache::new();
        for operation in operations {
            assert_eq!(operation.replicas(), Replicas::Ordinary, "{operation:?}");
            let transport = DeferredRelayTransport::default();
            let refused = execute_relay_operation(
                &mut store,
                &mut cache,
                transport.clone(),
                operation.clone(),
                &LeaseRegistry::default(),
                &ClaimAnnouncer::default(),
                &mut crate::actor::live_application::Registry::default(),
            );
            assert!(
                matches!(&refused, Err(RuntimeError::Relay(refusal))
                    if *refusal == dohc_engine_sync::hosted_feed_only()),
                "{operation:?}: {refused:?}"
            );
            assert_eq!(transport.take_pending(), None, "{operation:?} sent nothing");
            assert_eq!(everything(&store), before, "{operation:?} wrote nothing");
        }
    }

    /// The switch-over plan: a retired file holding anything but its head was
    /// forgotten before it was named, so its document left `departed` while
    /// the file stayed. Its path stays held now: every pass names the file,
    /// across a restart, until it holds its head again and goes.
    #[test]
    fn a_retired_file_holding_anything_else_keeps_its_document_departed() {
        let scratch = ScratchDir::new().unwrap();
        let root = ScratchDir::new().unwrap();
        let path = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&path, 1_000).unwrap();
        create_hosted_replica(
            &mut store,
            "ws",
            "service-host:host",
            "epoch",
            "stream",
            1_000,
            &NoFaults,
        )
        .unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 0, &NoFaults)
            .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO hosted_retired_files (workspace_id,path,object_id,sha256) \
                     VALUES ('ws','a.md','doc-b',?1)",
                    [dohc_engine_storage::hex_sha256(b"hosted b")],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)
            })
            .unwrap();
        let file = root.path().join("a.md");
        std::fs::write(&file, "not the head").unwrap();
        let pass = |store: &mut EngineStore| {
            park_departed_hosted(
                store,
                &mut WriterDocCache::new(),
                &LeaseRegistry::default(),
                "ws",
                root.path(),
                2_000,
            )
        };
        let departed = |store: &EngineStore| {
            dohc_engine_sync::departed_hosted_object_ids(store, "ws").unwrap()
        };

        for _ in 0..2 {
            let refused = pass(&mut store);
            assert!(
                matches!(&refused, Err(RuntimeError::HostedFileUnexpected { path }) if path == "a.md"),
                "{refused:?}"
            );
            assert_eq!(departed(&store), ["doc-b"]);
        }
        drop(store);
        let mut store = EngineStore::open(&path, 3_000).unwrap();
        let refused = pass(&mut store);
        assert!(
            matches!(&refused, Err(RuntimeError::HostedFileUnexpected { path }) if path == "a.md"),
            "{refused:?}"
        );
        assert_eq!(departed(&store), ["doc-b"]);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "not the head");

        std::fs::write(&file, "hosted b").unwrap();
        assert!(pass(&mut store).unwrap(), "its path came free");
        assert!(departed(&store).is_empty());
        assert!(!file.exists());
    }

    /// The durability review: a stuck retired file returned before the
    /// retired files after it and every departed document, so nothing else
    /// in the workspace ever retired. The others still go or park; the stuck
    /// one stays departed, and the pass still names it.
    #[test]
    fn a_stuck_retired_file_does_not_hold_back_other_departed_documents() {
        let scratch = ScratchDir::new().unwrap();
        let root = ScratchDir::new().unwrap();
        let path = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&path, 1_000).unwrap();
        create_hosted_replica(
            &mut store,
            "ws",
            "service-host:host",
            "epoch",
            "stream",
            1_000,
            &NoFaults,
        )
        .unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 0, &NoFaults)
            .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO hosted_retired_files (workspace_id,path,object_id,sha256) \
                     VALUES ('ws','a.md','doc-b',?1),('ws','z.md','doc-z',?2)",
                    [
                        dohc_engine_storage::hex_sha256(b"hosted b"),
                        dohc_engine_storage::hex_sha256(b"hosted z"),
                    ],
                )
                .and_then(|_| {
                    tx.execute(
                        "INSERT INTO hosted_documents \
                         (workspace_id,object_id,path,state,scope_generation) \
                         VALUES ('ws','doc-c','c.md','ready',1)",
                        [],
                    )
                })
                .map_err(dohc_engine_storage::StorageError::persist_public)
            })
            .unwrap();
        std::fs::write(root.path().join("a.md"), "not the head").unwrap();
        std::fs::write(root.path().join("z.md"), "hosted z").unwrap();
        assert_eq!(
            dohc_engine_sync::departed_hosted_object_ids(&store, "ws").unwrap(),
            ["doc-b", "doc-c", "doc-z"]
        );

        let refused = park_departed_hosted(
            &mut store,
            &mut WriterDocCache::new(),
            &LeaseRegistry::default(),
            "ws",
            root.path(),
            2_000,
        );
        assert!(
            matches!(&refused, Err(RuntimeError::HostedFileUnexpected { path }) if path == "a.md"),
            "{refused:?}"
        );
        assert_eq!(
            dohc_engine_sync::departed_hosted_object_ids(&store, "ws").unwrap(),
            ["doc-b"]
        );
        assert!(root.path().join("a.md").exists());
        assert!(!root.path().join("z.md").exists());
    }

    /// The durability review: a retired `a.md/x/c.md` left the folder
    /// `a.md`, which a file at `a.md` could never replace. The folders its
    /// file leaves empty go with it, up to one that still holds something.
    #[test]
    fn a_retired_file_takes_the_folders_it_leaves_empty() {
        let scratch = ScratchDir::new().unwrap();
        let root = ScratchDir::new().unwrap();
        let path = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&path, 1_000).unwrap();
        create_hosted_replica(
            &mut store,
            "ws",
            "service-host:host",
            "epoch",
            "stream",
            1_000,
            &NoFaults,
        )
        .unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 0, &NoFaults)
            .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO hosted_retired_files (workspace_id,path,object_id,sha256) \
                     VALUES ('ws','a.md/x/c.md','doc-c',?1),('ws','d/e/f.md','doc-f',?1)",
                    [dohc_engine_storage::hex_sha256(b"hosted")],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)
            })
            .unwrap();
        std::fs::create_dir_all(root.path().join("a.md/x")).unwrap();
        std::fs::create_dir_all(root.path().join("d/e")).unwrap();
        std::fs::write(root.path().join("a.md/x/c.md"), "hosted").unwrap();
        std::fs::write(root.path().join("d/e/f.md"), "hosted").unwrap();
        std::fs::write(root.path().join("d/keep.md"), "keep").unwrap();

        assert!(
            park_departed_hosted(
                &mut store,
                &mut WriterDocCache::new(),
                &LeaseRegistry::default(),
                "ws",
                root.path(),
                2_000,
            )
            .unwrap()
        );
        assert!(!root.path().join("a.md").exists());
        assert!(!root.path().join("d/e").exists());
        assert_eq!(
            std::fs::read_to_string(root.path().join("d/keep.md")).unwrap(),
            "keep"
        );
        assert!(
            dohc_engine_sync::retired_hosted_files(&store, "ws")
                .unwrap()
                .is_empty()
        );
    }

    /// Sol's sixth park review: a finish that stops after writing a
    /// document's file keeps only that document departed while the others
    /// park, and after a restart the next pass parks it too.
    #[test]
    fn an_interrupted_finish_holds_back_only_its_document_until_a_restart() {
        let scratch = ScratchDir::new().unwrap();
        let root = ScratchDir::new().unwrap();
        let path = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&path, 1_000).unwrap();
        create_hosted_replica(
            &mut store,
            "ws",
            "service-host:host",
            "epoch",
            "stream",
            1_000,
            &NoFaults,
        )
        .unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 0, &NoFaults)
            .unwrap();
        for (seq, object_id) in [(1, "doc-a"), (2, "doc-b")] {
            dohc_engine_domain::VersionedTextStore::new(&mut store)
                .write_text(
                    &dohc_engine_domain::WriteText {
                        workspace_id: "ws".to_owned(),
                        version_id: "main".to_owned(),
                        object_id: object_id.to_owned(),
                        path: format!("{object_id}.md"),
                        text: format!("hosted {object_id}"),
                        moment_id: format!("moment-{seq}"),
                        metadata_origin: "sync".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 1_000 + seq,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
        }
        // Both applied rows no committed pass wrote, then left the scope.
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO hosted_documents \
                     (workspace_id,object_id,path,state,scope_generation,unmaterialized_seq) \
                     VALUES ('ws','doc-a','doc-a.md','ready',1,1),\
                     ('ws','doc-b','doc-b.md','ready',1,2)",
                    [],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)
            })
            .unwrap();
        let pass = |store: &mut EngineStore| {
            park_departed_hosted(
                store,
                &mut WriterDocCache::new(),
                &LeaseRegistry::default(),
                "ws",
                root.path(),
                2_000,
            )
        };
        let departed = |store: &EngineStore| {
            dohc_engine_sync::departed_hosted_object_ids(store, "ws").unwrap()
        };
        let a = root.path().join("doc-a.md");

        let faults = dohc_engine_testkit::ScriptedFaults::crash_at(
            dohc_engine_storage::FaultPoint::MaterializeAfterRenameBeforeComplete,
        );
        let armed: Arc<dyn dohc_engine_storage::FaultInjector> = faults.clone();
        super::super::versions::tests::RELAY_FAULTS.with(|relay| relay.replace(Some(armed)));
        let interrupted = pass(&mut store);
        super::super::versions::tests::RELAY_FAULTS.with(|relay| relay.take());
        assert!(faults.fired());
        assert!(
            matches!(
                interrupted,
                Err(RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs: 1 })
            ),
            "{interrupted:?}"
        );
        assert_eq!(departed(&store), ["doc-a"]);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "hosted doc-a");
        assert!(!root.path().join("doc-b.md").exists());

        drop(store);
        let mut store = EngineStore::open(&path, 3_000).unwrap();
        super::super::materialization::replay_pending_materializations(
            &mut store,
            root.path(),
            super::super::materialization::MaterializationReplayScope {
                holds: None,
                workspace_id: "ws",
                self_writes: None,
                progress: None,
                file_outcomes_settled: false,
                released_hold_paths: None,
                planned_against_active_heads: false,
            },
            3_000,
            &NoFaults,
            None,
            false,
        )
        .unwrap();
        assert!(pass(&mut store).unwrap());
        assert!(departed(&store).is_empty());
        assert!(!a.exists());
    }
}

#[cfg(all(test, debug_assertions))]
mod test_relay_ca_tests {
    use super::*;
    use dohc_engine_testkit::ScratchDir;
    use std::ffi::OsStr;

    const UNPARSED_CA: &[u8] = b"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";

    fn configuration(base_url: &str, insecure: bool) -> RelayConfiguration {
        RelayConfiguration {
            base_url: base_url.to_owned(),
            socket_path: None,
            bearer_token: "token".to_owned(),
            allow_insecure_loopback_for_tests: insecure,
        }
    }

    #[test]
    fn a_partial_or_malformed_opt_in_refuses_instead_of_falling_back() {
        let scratch = ScratchDir::new().expect("scratch");
        let ca = scratch.join("ca.pem");
        std::fs::write(&ca, UNPARSED_CA).expect("CA file");
        let ca = ca.as_os_str();
        let missing = scratch.join("missing.pem");
        let one = Some(OsStr::new("1"));

        assert_eq!(test_relay_ca(None, None), Ok(None));
        let read = test_relay_ca(one, Some(ca));
        assert_eq!(read, Ok(Some(UNPARSED_CA.to_vec())));
        for (mode, file) in [
            (one, None),
            (None, Some(ca)),
            (Some(OsStr::new("0")), Some(ca)),
            (Some(OsStr::new("true")), Some(ca)),
            (one, Some(OsStr::new("ca.pem"))),
            (one, Some(missing.as_os_str())),
        ] {
            assert_eq!(
                test_relay_ca(mode, file),
                Err(test_relay_ca_refused()),
                "mode {mode:?} with file {file:?} must refuse"
            );
        }
    }

    #[test]
    fn the_test_ca_selects_its_own_constructor_and_never_the_plaintext_one() {
        let ca = Some(UNPARSED_CA.to_vec());
        let build = |base_url, insecure, ca: Option<Vec<u8>>| {
            build_debug_http_transport(configuration(base_url, insecure), ca)
        };
        assert!(build("https://relay.example", false, None).is_ok());
        assert!(build("http://127.0.0.1:1", true, None).is_ok());
        assert!(build("https://127.0.0.1:1", false, ca.clone()).is_ok());
        assert!(
            build("https://relay.example", false, ca.clone()).is_err(),
            "with a test CA, only an IP-literal loopback relay is reachable"
        );
        assert!(
            build("http://127.0.0.1:1", true, ca).is_err(),
            "a test CA and the plaintext loopback opt-in together must refuse"
        );
    }
}
