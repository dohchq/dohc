use super::{ActorHandle, ClaimAnnouncer};
use crate::error::RuntimeError;
use dohc_engine_collab::{LeaseRegistry, WriterDocCache};
use dohc_engine_storage::{EngineStore, NoFaults, TxnOutcome};
use dohc_engine_sync::{
    BlobDownloadBatchRequest, BlobDownloadBatchResponse, BlobDownloadResponse, BlobHaveRequest,
    BlobHaveResponse, BlobUploadRequest, ClaimRequest, ClaimResponse, DirectWritePushOutcome,
    EpochRequest, EpochResponse, KeyEnvelopeDownloadRequest, KeyEnvelopeDownloadResponse,
    KeyEnvelopeRequest, KeyEnvelopeResponse, LogCoordinateRequest, LogCoordinateResponse,
    MAX_BLOB_DOWNLOAD_BATCH, ProbeRequest, ProbeResponse, PullRequest, PullResponse, PushRequest,
    PushResponse, RecoverResponse, RelayCursor, RelayError, RelaySyncClient, RelayTransport,
    ShareBlobRequest, ShareBlobUploadRequest, ShareCollectionWriteRequest,
    ShareCollectionWriteResponse, ShareCursor, ShareLogPushRequest, ShareProposalSubmitOutcome,
    ShareProposalSubmitRequest, ShareProposalSubmitResponse, ShareViewPullOutcome,
    ShareViewRequest, ShareViewResponse, SharedChannelPullOutcome, SharedChannelPushOutcome,
    SharedChannelRequest, SharedChannelResponse, SyncPassOutcome, adopt_join_identity,
    create_claim_identity, read_sync_identity,
};
use dohc_engine_sync_http::HttpRelayTransport;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

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
    LookupCoordinate(LogCoordinateRequest),
    Probe(ProbeRequest),
    Claim(ClaimRequest),
    RotateEpoch(EpochRequest),
    BlobsHave(BlobHaveRequest),
    UploadBlob(BlobUploadRequest),
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

#[derive(Debug, Clone)]
enum RelayIoResponse {
    Push(PushResponse),
    Pull(PullResponse),
    LookupCoordinate(LogCoordinateResponse),
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

#[derive(Clone, Default)]
struct DeferredRelayTransport {
    state: Arc<Mutex<DeferredRelayState>>,
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
            let release = matches!(
                state.completed[index].0,
                RelayIoRequest::Push(_)
                    | RelayIoRequest::ShareLogPush(_)
                    | RelayIoRequest::UploadBlob(_)
                    | RelayIoRequest::DownloadBlobs(_)
                    | RelayIoRequest::UploadKeyEnvelope(_)
                    | RelayIoRequest::DownloadKeyEnvelope(_)
                    | RelayIoRequest::ShareBlob(_)
                    | RelayIoRequest::ShareProposalSubmit(_)
            ) || matches!(
                &state.completed[index].1,
                Ok(RelayIoResponse::BlobsHave(response)) if response.missing.is_empty()
            );
            let uploaded = matches!(state.completed[index].0, RelayIoRequest::UploadBlob(_));
            let projected = match &mut state.completed[index].1 {
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
    relay_transport_method!(push, PushRequest, Push, PushResponse, Push);
    relay_transport_method!(pull, PullRequest, Pull, PullResponse, Pull);
    relay_transport_method!(
        lookup_log_coordinate,
        LogCoordinateRequest,
        LookupCoordinate,
        LogCoordinateResponse,
        LookupCoordinate
    );
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
mod deferred_relay_tests {
    use super::*;

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
            "retaining a successful all-present inventory holds its request vector"
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
                ).map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok::<_, dohc_engine_storage::StorageError>(())
            })? {
                TxnOutcome::Committed(()) => Ok(()),
                TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
            }
        }).await
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
        let transport = DeferredRelayTransport::default();
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        let http_transport = Arc::new(build_http_transport(configuration)?);
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
                .run(move |store, cache| {
                    let _reservation = queued_reservation;
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
                        )
                    };
                    // A pull can claim, replace, or advance lineages behind the
                    // local path (probe-covered; reset hooks stay unconditional).
                    cache.clear();
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
                    let http_transport = Arc::clone(&http_transport);
                    let io_request = request.clone();
                    let result = tokio::select! {
                        biased;
                        () = token.cancelled() => return Err(RuntimeError::Cancelled),
                        result = execute_http_request(
                            http_transport,
                            io_request,
                            token.clone(),
                        ) => result,
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

const MAX_CONCURRENT_BLOB_DOWNLOADS: usize = 4;
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
    if let RelayIoRequest::DownloadBlobs(request) = request {
        let download_transport = Arc::clone(&transport);
        return execute_blob_download_batch(request, token, move |request, worker_token| {
            download_transport.download_blobs_cancellable(request, || worker_token.is_cancelled())
        })
        .await
        .map(RelayIoResponse::DownloadBlobs);
    }

    tokio::task::spawn_blocking(move || execute_blocking_http_request(&transport, request))
        .await
        .map_err(|_| relay_io_aborted())?
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

fn execute_blocking_http_request(
    transport: &HttpRelayTransport,
    request: RelayIoRequest,
) -> Result<RelayIoResponse, RelayError> {
    match request {
        RelayIoRequest::Push(request) => transport.push(request).map(RelayIoResponse::Push),
        RelayIoRequest::Pull(request) => transport.pull(request).map(RelayIoResponse::Pull),
        RelayIoRequest::LookupCoordinate(request) => transport
            .lookup_log_coordinate(request)
            .map(RelayIoResponse::LookupCoordinate),
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
        RelayIoRequest::DownloadBlobs(_) => Err(RelayError::InvalidResponse),
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
) -> Result<RelayOperationOutcome, RuntimeError> {
    let client = RelaySyncClient::new(transport);
    let outcome = run_relay_operation(store, doc_cache, &client, operation, leases);
    claims.announce(&client.take_automation_claims());
    outcome
}

fn run_relay_operation(
    store: &mut EngineStore,
    doc_cache: &mut WriterDocCache,
    client: &RelaySyncClient<DeferredRelayTransport>,
    operation: RelayOperation,
    leases: &LeaseRegistry,
) -> Result<RelayOperationOutcome, RuntimeError> {
    match operation {
        RelayOperation::Push {
            workspace_id,
            now_ms,
            max_read_bytes,
        } => client
            .push_workspace(
                store,
                &workspace_id,
                &NoFaults,
                leases,
                now_ms,
                max_read_bytes,
            )
            .map(RelayOperationOutcome::Sync)
            .map_err(RuntimeError::from),
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
            &NoFaults,
            leases,
            now_ms,
        )? {
            TxnOutcome::Committed(sharing_declined) => {
                Ok(RelayOperationOutcome::CursorCommitted { sharing_declined })
            }
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
            }),
            TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
        },
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
                    &ClaimAnnouncer::default()
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
                    &ClaimAnnouncer::default()
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
