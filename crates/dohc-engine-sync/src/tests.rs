use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use dohc_engine_domain::chats::{
    CHAT_THREAD_HEADER_MESSAGE_ID, chat_thread_display_title, upsert_chat_search_index_row,
};
use dohc_engine_domain::{
    AGENT_CHANNEL_NAME, AGENT_CHANNEL_WIRE_ID, BookmarkMode, BookmarkTargetKind, ChatActorKind,
    ChatChannelKind, ChatReactionState, CreateFileThread, DeleteTextFile, FollowState,
    FollowTargetKind, GENERAL_CHANNEL_WIRE_ID, LinkedChatStore, MAX_SECRET_FILE_BYTES,
    MAX_TEXT_BYTES, RenameTextFile, ResolveDecision, SECRET_IV_BYTES, SECRET_TAG_BYTES,
    SaveBookmark, SendMessage, SetFollow, SetReaction, StartChannelThread, VersionedTextStore,
    WriteBinary, attachment_id_for, channel_slug_for_name,
};
use dohc_engine_files::MaterializeOptions;
use dohc_engine_storage::{EngineStore, FaultPoint, NoFaults, TxnOutcome};
use dohc_engine_testkit::{
    ScratchDir, ScriptedFaults, decode_hex, engine_db_path, flip_byte, open_store,
};
use rusqlite::{OptionalExtension, params};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::apply::apply_chat_tx;
use crate::*;

/// A relay-acked envelope for workspace `ws`, recorded at 2_000 ms, whose
/// relay sequence equals its origin sequence.
fn envelope(origin: &str, seq: i64, kind: &str, payload: serde_json::Value) -> ReplicationEnvelope {
    ReplicationEnvelope {
        workspace_id: "ws".to_owned(),
        origin_id: origin.to_owned(),
        origin_seq: seq,
        op_kind: kind.to_owned(),
        payload,
        recorded_at_ms: 2_000,
        relay_seq: Some(seq),
    }
}

macro_rules! assert_invalid_refusal {
    ($result:expr) => {
        assert!(matches!(
            $result,
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Refused(ReplicationRefusal {
                    reason: RefusalReason::InvalidInput { .. },
                    ..
                }),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ))
    };
}

fn clock_collision_pair() -> (Vec<u8>, Vec<u8>) {
    (
        decode_hex("01010c00040109706c61696e546578740461efbfbd00"),
        decode_hex("01010c00040109706c61696e546578740561f09f988000"),
    )
}

fn seed_text_head(engine: &mut EngineStore, object_id: &str, path: &str, text: &str) -> String {
    let sha = dohc_engine_storage::hex_sha256(text.as_bytes());
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![sha, text.len() as i64, text],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws',?1,1)",
                [object_id],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO snapshots \
                 (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin,content_kind,binary_sha256) \
                 VALUES ('ws','main',?1,?2,?3,1,?4,'api','text',NULL)",
                params![object_id, path, sha, format!("seed-{object_id}")],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
                 VALUES ('ws','main',?1,?2)",
                params![path, object_id],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed text head");
    sha
}

fn insert_probe(tx: &rusqlite::Transaction<'_>, op: &ReplicationEnvelope) -> Result<(), SyncError> {
    tx.execute(
        "INSERT OR REPLACE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
        params![op.origin_id, op.op_kind.len() as i64, op.op_kind],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

#[test]
fn live_binding_refusal_rolls_back_mutation_persists_acks_and_allows_next_envelope() {
    let (_scratch, _path, mut engine) = open_store();
    let text = "refused peer edit";
    let digest = dohc_engine_storage::hex_sha256(text.as_bytes());
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs(sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![digest, text.len() as i64, text],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let refused = envelope(
        "adopted-owner-peer",
        0,
        "moment.append",
        json!({
            "momentId":"refused-peer-moment", "versionId":"main", "objectId":"peer-object",
            "objectCreatedAtMs":1, "path":"peer.md", "recordedAtMs":2000, "operation":"write",
            "payloadBeforeBlobSha256":null, "payloadBeforePath":null,
            "payloadAfterBlobSha256":digest, "payloadAfterPath":"peer.md",
            "metadata":{"origin":"sync"}, "beforePresent":"absent"
        }),
    );
    let outcome = apply_envelope_with(&mut engine, &refused, &NoFaults, |tx, op| {
        insert_probe(tx, op)?;
        Err::<(), _>(SyncError::LiveDocumentBindingActive)
    })
    .expect("binding refusal must not abort the pull");
    let ApplyDisposition::Refused(refusal) = outcome.primary else {
        panic!("expected a persisted refusal");
    };
    assert_eq!(
        refusal.reason.message(),
        "live document binding is still active"
    );
    let (mutations, refusals, journaled): (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM blobs WHERE sha256='adopted-owner-peer'", [], |row| row.get(0))?,
                conn.query_row("SELECT COUNT(*) FROM replication_pending_refusals WHERE origin_id='adopted-owner-peer' AND origin_seq=0 AND reason_message='live document binding is still active'", [], |row| row.get(0))?,
                conn.query_row("SELECT COUNT(*) FROM replication_log WHERE origin_id='adopted-owner-peer' AND origin_seq=0", [], |row| row.get(0))?,
            ))
        })
        .expect("committed refusal and rolled back mutation");
    assert_eq!((mutations, refusals, journaled), (0, 1, 1));
    let retained: String = engine.read_with(|conn| conn.query_row(
        "SELECT text_sha256 FROM replication_refused_moment_blobs WHERE workspace_id='ws' AND origin_id='adopted-owner-peer' AND origin_seq=0 AND role='payload-after'",
        [], |row|row.get(0),
    )).expect("refused moment retains its source blob");
    assert_eq!(retained, digest);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "adopted-owner-peer").expect("ack"),
        0
    );
    assert_eq!(
        apply_envelope_with(
            &mut engine,
            &refused,
            &NoFaults,
            |_, _| -> Result<(), SyncError> {
                panic!("redelivery must not rerun the refused mutation")
            }
        )
        .expect("redelivery")
        .primary,
        ApplyDisposition::Skipped,
    );
    let mut next = envelope(
        "adopted-owner-peer",
        1,
        "moment.append",
        refused.payload.clone(),
    );
    next.payload["momentId"] = json!("next-peer-moment");
    assert_eq!(
        apply_envelope_with(&mut engine, &next, &NoFaults, insert_probe)
            .expect("next envelope")
            .primary,
        ApplyDisposition::Applied(())
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "adopted-owner-peer").expect("next ack"),
        1
    );
}

fn reaction_payload(state: &str, emoji: &str, at_ms: i64, author_id: &str) -> serde_json::Value {
    json!({
        "reactionId": format!("reaction-{author_id}"),
        "messageId": "message",
        "threadId": "thread",
        "emoji": emoji,
        "authorId": author_id,
        "authorKind": "human",
        "authorDisplayName": author_id,
        "atMs": at_ms,
        "state": state,
    })
}

fn decision_payload(state: &str, at_ms: i64, resolver: Option<&str>) -> serde_json::Value {
    let mut payload = json!({
        "threadId": "thread",
        "messageId": "message",
        "state": state,
        "atMs": at_ms,
    });
    if let Some(resolver) = resolver {
        payload["resolvedByMessageId"] = json!(resolver);
    }
    payload
}

#[derive(Default)]
pub(crate) struct FakeRelay {
    pushes: Mutex<Vec<PushRequest>>,
    pull: Mutex<Option<PullResponse>>,
}

impl RelayTransport for FakeRelay {
    fn push(&self, req: PushRequest) -> Result<PushResponse, RelayError> {
        self.pushes.lock().expect("push lock").push(req.clone());
        let accepted = req.ops.len();
        let current_max_origin_seq = req.ops.last().map_or(req.after_seq, |op| op.origin_seq);
        Ok(PushResponse {
            accepted,
            inserted: accepted,
            skipped: 0,
            current_max_origin_seq,
        })
    }
    fn pull(&self, _req: PullRequest) -> Result<PullResponse, RelayError> {
        let mut page = self
            .pull
            .lock()
            .expect("pull lock")
            .clone()
            .ok_or(RelayError::InvalidResponse)?;
        assign_fixture_relay_sequences(&mut page);
        Ok(page)
    }
    fn lookup_log_coordinate(
        &self,
        _req: LogCoordinateRequest,
    ) -> Result<LogCoordinateResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn probe(&self, _req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        Ok(ProbeResponse { has_content: false })
    }
    fn claim_workspace(&self, _req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        Ok(ClaimResponse)
    }
    fn rotate_epoch(&self, _req: EpochRequest) -> Result<EpochResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn blobs_have(&self, _req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError> {
        Ok(BlobHaveResponse {
            missing: Vec::new(),
        })
    }
    fn upload_blob(&self, _req: BlobUploadRequest) -> Result<(), RelayError> {
        Ok(())
    }
    fn download_blobs(
        &self,
        req: BlobDownloadBatchRequest,
    ) -> Result<BlobDownloadBatchResponse, RelayError> {
        Ok(BlobDownloadBatchResponse {
            results: req
                .blobs
                .iter()
                .map(|_| Err(RelayError::BlobMissing))
                .collect(),
        })
    }
    fn upload_key_envelope(
        &self,
        _req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        Ok(KeyEnvelopeResponse {
            etag: "etag".to_owned(),
        })
    }
    fn download_key_envelope(
        &self,
        _req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError> {
        Err(RelayError::KeyEnvelopeMissing)
    }
    fn shared_channel_pull(
        &self,
        _req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn share_log_push(&self, _req: ShareLogPushRequest) -> Result<PushResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn share_view_pull(&self, _req: ShareViewRequest) -> Result<ShareViewResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn share_blob(&self, _req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError> {
        Err(RelayError::ShareUnavailable)
    }

    fn share_blob_upload(&self, _req: ShareBlobUploadRequest) -> Result<(), RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn share_proposal_submit(
        &self,
        _req: ShareProposalSubmitRequest,
    ) -> Result<ShareProposalSubmitResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
}

#[derive(Default)]
struct KeyConflictRelay {
    uploads: Mutex<Vec<KeyEnvelopeRequest>>,
    downloads: Mutex<usize>,
}

impl RelayTransport for KeyConflictRelay {
    fn push(&self, _req: PushRequest) -> Result<PushResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn pull(&self, _req: PullRequest) -> Result<PullResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn lookup_log_coordinate(
        &self,
        _req: LogCoordinateRequest,
    ) -> Result<LogCoordinateResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn probe(&self, _req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn claim_workspace(&self, _req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn rotate_epoch(&self, _req: EpochRequest) -> Result<EpochResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn blobs_have(&self, _req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn upload_blob(&self, _req: BlobUploadRequest) -> Result<(), RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn download_blobs(
        &self,
        _req: BlobDownloadBatchRequest,
    ) -> Result<BlobDownloadBatchResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn upload_key_envelope(
        &self,
        req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        self.uploads.lock().expect("key uploads").push(req);
        Err(RelayError::Conflict)
    }
    fn download_key_envelope(
        &self,
        _req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError> {
        *self.downloads.lock().expect("key downloads") += 1;
        Ok(KeyEnvelopeDownloadResponse {
            envelope_json: r#"{"winner":true}"#.to_owned(),
            etag: "winner-etag".to_owned(),
        })
    }
    fn shared_channel_pull(
        &self,
        _req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn share_log_push(&self, _req: ShareLogPushRequest) -> Result<PushResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn share_view_pull(&self, _req: ShareViewRequest) -> Result<ShareViewResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn share_blob(&self, _req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn share_blob_upload(&self, _req: ShareBlobUploadRequest) -> Result<(), RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn share_proposal_submit(
        &self,
        _req: ShareProposalSubmitRequest,
    ) -> Result<ShareProposalSubmitResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
}

struct PagedRelay {
    pages: BTreeMap<i64, PullResponse>,
    blobs: BTreeMap<String, Vec<u8>>,
    coordinates: Mutex<BTreeMap<(String, i64), LogCoordinateResponse>>,
    pulls: Mutex<Vec<(i64, usize)>>,
    download_batches: Mutex<Vec<BlobDownloadBatchRequest>>,
}

impl PagedRelay {
    fn new(pages: impl IntoIterator<Item = (i64, PullResponse)>) -> Self {
        let pages = pages
            .into_iter()
            .map(|(cursor, mut page)| {
                assign_fixture_relay_sequences(&mut page);
                (cursor, page)
            })
            .collect();
        Self {
            pages,
            blobs: BTreeMap::new(),
            coordinates: Mutex::new(BTreeMap::new()),
            pulls: Mutex::new(Vec::new()),
            download_batches: Mutex::new(Vec::new()),
        }
    }

    fn with_coordinate(
        mut self,
        origin_id: &str,
        origin_seq: i64,
        response: LogCoordinateResponse,
    ) -> Self {
        self.coordinates
            .get_mut()
            .expect("coordinate responses")
            .insert((origin_id.to_owned(), origin_seq), response);
        self
    }
}

fn assign_fixture_relay_sequences(page: &mut PullResponse) {
    let Ok(count) = i64::try_from(page.ops.len()) else {
        return;
    };
    let first = page.next_cursor.saturating_sub(count).saturating_add(1);
    for (index, op) in page.ops.iter_mut().enumerate() {
        op.relay_seq = i64::try_from(index)
            .ok()
            .and_then(|offset| first.checked_add(offset));
    }
}

impl RelayTransport for PagedRelay {
    fn push(&self, req: PushRequest) -> Result<PushResponse, RelayError> {
        let accepted = req.ops.len();
        let current_max_origin_seq = req.ops.last().map_or(req.after_seq, |op| op.origin_seq);
        let mut coordinates = self.coordinates.lock().expect("coordinate responses");
        for op in req.ops {
            let mut pulled = op;
            pulled.relay_seq = Some(100 + pulled.origin_seq);
            coordinates.insert(
                (pulled.origin_id.clone(), pulled.origin_seq),
                LogCoordinateResponse::Present(pulled),
            );
        }
        Ok(PushResponse {
            accepted,
            inserted: accepted,
            skipped: 0,
            current_max_origin_seq,
        })
    }

    fn pull(&self, req: PullRequest) -> Result<PullResponse, RelayError> {
        self.pulls
            .lock()
            .expect("pull calls")
            .push((req.cursor, req.limit));
        self.pages
            .get(&req.cursor)
            .cloned()
            .ok_or(RelayError::InvalidResponse)
    }

    fn lookup_log_coordinate(
        &self,
        req: LogCoordinateRequest,
    ) -> Result<LogCoordinateResponse, RelayError> {
        self.coordinates
            .lock()
            .expect("coordinate responses")
            .get(&(req.origin_id, req.origin_seq))
            .cloned()
            .ok_or(RelayError::InvalidResponse)
    }

    fn probe(&self, _req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        Ok(ProbeResponse { has_content: false })
    }

    fn claim_workspace(&self, _req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        Ok(ClaimResponse)
    }

    fn rotate_epoch(&self, _req: EpochRequest) -> Result<EpochResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn blobs_have(&self, _req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError> {
        Ok(BlobHaveResponse {
            missing: Vec::new(),
        })
    }

    fn upload_blob(&self, _req: BlobUploadRequest) -> Result<(), RelayError> {
        Ok(())
    }

    fn download_blobs(
        &self,
        req: BlobDownloadBatchRequest,
    ) -> Result<BlobDownloadBatchResponse, RelayError> {
        self.download_batches
            .lock()
            .expect("blob download batches")
            .push(req.clone());
        Ok(BlobDownloadBatchResponse {
            results: req
                .blobs
                .into_iter()
                .map(|blob| {
                    self.blobs
                        .get(&blob.sha256)
                        .cloned()
                        .map(|bytes| BlobDownloadResponse { bytes })
                        .ok_or(RelayError::BlobMissing)
                })
                .collect(),
        })
    }

    fn upload_key_envelope(
        &self,
        _req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn download_key_envelope(
        &self,
        _req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError> {
        Err(RelayError::KeyEnvelopeMissing)
    }

    fn shared_channel_pull(
        &self,
        _req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn share_log_push(&self, _req: ShareLogPushRequest) -> Result<PushResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn share_view_pull(&self, _req: ShareViewRequest) -> Result<ShareViewResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn share_blob(&self, _req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError> {
        Err(RelayError::ShareUnavailable)
    }

    fn share_blob_upload(&self, _req: ShareBlobUploadRequest) -> Result<(), RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn share_proposal_submit(
        &self,
        _req: ShareProposalSubmitRequest,
    ) -> Result<ShareProposalSubmitResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
}

struct PagedShareRelay {
    shared_pages: BTreeMap<i64, SharedChannelResponse>,
    view_pages: BTreeMap<i64, ShareViewResponse>,
    shared_pulls: Mutex<Vec<i64>>,
    shared_pushes: Mutex<Vec<ShareLogPushRequest>>,
    view_pulls: Mutex<Vec<(i64, usize)>>,
    view_blobs: BTreeMap<String, Vec<u8>>,
    /// What the transport answers for a blob instead of serving it. The real
    /// HTTP transport stops reading at its own bound and reports
    /// `BlobTooLarge` on a body it never finished (`blob_body_overflow`), and
    /// nothing else in this file can produce that shape.
    view_blob_errors: BTreeMap<String, RelayError>,
    share_blob_calls: Mutex<Vec<String>>,
    /// `proposal_calls` records the ORDER the submit lane touches
    /// the transport in, which is the property the blob ordering test needs
    /// and neither typed vector can state on its own.
    proposal_calls: Mutex<Vec<String>>,
    blob_uploads: Mutex<Vec<ShareBlobUploadRequest>>,
    proposal_submits: Mutex<Vec<ShareProposalSubmitRequest>>,
}

impl PagedShareRelay {
    fn new(
        shared_pages: impl IntoIterator<Item = (i64, SharedChannelResponse)>,
        view_pages: impl IntoIterator<Item = (i64, ShareViewResponse)>,
    ) -> Self {
        Self {
            shared_pages: shared_pages.into_iter().collect(),
            view_pages: view_pages.into_iter().collect(),
            shared_pulls: Mutex::new(Vec::new()),
            shared_pushes: Mutex::new(Vec::new()),
            view_pulls: Mutex::new(Vec::new()),
            view_blobs: BTreeMap::new(),
            view_blob_errors: BTreeMap::new(),
            share_blob_calls: Mutex::new(Vec::new()),
            proposal_calls: Mutex::new(Vec::new()),
            blob_uploads: Mutex::new(Vec::new()),
            proposal_submits: Mutex::new(Vec::new()),
        }
    }

    fn with_view_blobs(mut self, blobs: impl IntoIterator<Item = (String, Vec<u8>)>) -> Self {
        self.view_blobs = blobs.into_iter().collect();
        self
    }

    fn with_view_blob_errors(
        mut self,
        errors: impl IntoIterator<Item = (String, RelayError)>,
    ) -> Self {
        self.view_blob_errors = errors.into_iter().collect();
        self
    }
}

impl RelayTransport for PagedShareRelay {
    fn push(&self, _req: PushRequest) -> Result<PushResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn pull(&self, _req: PullRequest) -> Result<PullResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn lookup_log_coordinate(
        &self,
        _req: LogCoordinateRequest,
    ) -> Result<LogCoordinateResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn probe(&self, _req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn claim_workspace(&self, _req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn rotate_epoch(&self, _req: EpochRequest) -> Result<EpochResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn blobs_have(&self, _req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn upload_blob(&self, _req: BlobUploadRequest) -> Result<(), RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn download_blobs(
        &self,
        _req: BlobDownloadBatchRequest,
    ) -> Result<BlobDownloadBatchResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn upload_key_envelope(
        &self,
        _req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn download_key_envelope(
        &self,
        _req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn shared_channel_pull(
        &self,
        req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        self.shared_pulls
            .lock()
            .expect("shared pull calls")
            .push(req.cursor);
        self.shared_pages
            .get(&req.cursor)
            .cloned()
            .ok_or(RelayError::InvalidResponse)
    }

    fn share_log_push(&self, req: ShareLogPushRequest) -> Result<PushResponse, RelayError> {
        let accepted = req.ops.len();
        let current_max_origin_seq = req.ops.last().map_or(-1, |op| op.origin_seq);
        self.shared_pushes
            .lock()
            .expect("shared push calls")
            .push(req);
        Ok(PushResponse {
            accepted,
            inserted: accepted,
            skipped: 0,
            current_max_origin_seq,
        })
    }

    fn share_view_pull(&self, req: ShareViewRequest) -> Result<ShareViewResponse, RelayError> {
        self.view_pulls
            .lock()
            .expect("view pull calls")
            .push((req.cursor, req.limit));
        self.view_pages
            .get(&req.cursor)
            .cloned()
            .ok_or(RelayError::InvalidResponse)
    }

    fn share_blob(&self, req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError> {
        self.share_blob_calls
            .lock()
            .expect("share blob calls")
            .push(req.sha256.clone());
        if let Some(error) = self.view_blob_errors.get(&req.sha256) {
            return Err(error.clone());
        }
        self.view_blobs
            .get(&req.sha256)
            .cloned()
            .map(|bytes| BlobDownloadResponse { bytes })
            .ok_or(RelayError::InvalidResponse)
    }

    fn share_blob_upload(&self, req: ShareBlobUploadRequest) -> Result<(), RelayError> {
        self.proposal_calls
            .lock()
            .expect("proposal calls")
            .push(format!("blob:{}", req.sha256));
        self.blob_uploads.lock().expect("blob uploads").push(req);
        Ok(())
    }

    fn share_proposal_submit(
        &self,
        req: ShareProposalSubmitRequest,
    ) -> Result<ShareProposalSubmitResponse, RelayError> {
        self.proposal_calls
            .lock()
            .expect("proposal calls")
            .push("submit".to_owned());
        let ops = req.ops.len();
        self.proposal_submits
            .lock()
            .expect("proposal submits")
            .push(req);
        Ok(ShareProposalSubmitResponse {
            proposal_id: "proposal-1".to_owned(),
            ops,
        })
    }
}

fn seed_identity(engine: &mut EngineStore) {
    let outcome = journal_local_replication_op(
        engine,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "probe.local",
        &json!({}),
        1_000,
        &NoFaults,
    )
    .expect("identity");
    assert_eq!(outcome, TxnOutcome::Committed(0));
}

fn seed_replication_version(engine: &mut EngineStore, version_id: &str, kind: &str) {
    seed_replication_version_in_workspace(engine, "ws", version_id, kind);
}

fn seed_replication_version_in_workspace(
    engine: &mut EngineStore,
    workspace_id: &str,
    version_id: &str,
    kind: &str,
) {
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO versioned_workspaces (workspace_id, main_version_id) \
                 VALUES (?1, 'main')",
                [workspace_id],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT OR IGNORE INTO versions \
                 (workspace_id, version_id, kind, name, created_at_ms) \
                 VALUES (?1, ?2, ?3, ?2, 1)",
                params![workspace_id, version_id, kind],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed replication version");
}

fn shipped_text_snapshot(object_id: &str, path: &str, blob_sha256: &str) -> serde_json::Value {
    json!({
        "objectId": object_id,
        "objectCreatedAtMs": 1_100,
        "path": path,
        "blobSha256": blob_sha256,
        "byteLength": 7,
        "updatedAtMs": 1_200,
        "latestMomentId": format!("{object_id}-moment"),
        "metadata": {"origin": "sync"}
    })
}

fn version_create_with_shipped_snapshots(
    origin: &str,
    version_id: &str,
    snapshots: Vec<serde_json::Value>,
) -> ReplicationEnvelope {
    envelope(
        origin,
        0,
        "version.create",
        json!({
            "versionId": version_id,
            "name": version_id,
            "kind": "named",
            "forkVersionId": "main",
            "forkMomentId": "fork-moment",
            "createdAtMs": 1_500,
            "forkSnapshots": snapshots
        }),
    )
}

// Keep child modules after assert_invalid_refusal so they inherit its macro scope.
mod chat;
mod owner_publication;
mod recover;
mod relay_pull;
mod relay_pull_bench;
mod secret;
mod share_proposal;
mod share_view;
mod shared_channel;
mod version;
mod ydoc_base;
mod ydoc_cache;
mod ydoc_drain;
mod ydoc_restore;
