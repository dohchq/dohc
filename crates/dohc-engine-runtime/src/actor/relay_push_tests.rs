use super::*;
use crate::WorkspaceSupervisor;
use dohc_engine_domain::{VersionedTextStore, WriteBinary};
use dohc_engine_storage::{StorageError, hex_sha256};
use dohc_engine_sync::{ReplicationEnvelope, journal_moment_append_in_tx, read_pushed_seq};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::collections::{BTreeMap, BTreeSet};

#[path = "relay_cache_tests.rs"]
pub(super) mod cache_tests;

#[path = "relay_push_retention_tests.rs"]
mod retention_tests;

const WORKSPACE: &str = "ws";
const ORIGIN: &str = "local";
const PREFIX_OPS: usize = dohc_engine_sync::MAX_PUSH_OPS_PER_BATCH;
const FILES: usize = 2 * PREFIX_OPS + 17;

fn fixture() -> (ScratchDir, std::path::PathBuf, EngineStore) {
    fixture_with_files(FILES)
}

fn fixture_with_files(files: usize) -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch workspace");
    let path = engine_db_path(&scratch).expect("engine path");
    let mut store = EngineStore::open(&path, 1_000).expect("open store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE, "main", 1_000, &NoFaults)
        .expect("main version");
    adopt_join_identity(
        &mut store, WORKSPACE, ORIGIN, "epoch", "stream", 1_000, &NoFaults,
    )
    .expect("adopt confirmed identity");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                 VALUES (?1,?2,-1)",
                [WORKSPACE, ORIGIN],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("enrolled workspace");
    for index in 0..files {
        append_file(&mut store, index);
    }
    assert_eq!(read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(), -1);
    (scratch, path, store)
}

fn append_file(store: &mut EngineStore, index: usize) {
    append_file_as(store, index, &format!("moment-{index}"));
}

fn append_file_as(store: &mut EngineStore, index: usize, moment_id: &str) {
    append_file_bytes(
        store,
        index,
        moment_id,
        format!("binary content {index}").into_bytes(),
    );
}

fn append_file_bytes(store: &mut EngineStore, index: usize, moment_id: &str, bytes: Vec<u8>) {
    VersionedTextStore::new(store)
        .write_binary(
            &WriteBinary {
                workspace_id: WORKSPACE.to_owned(),
                version_id: "main".to_owned(),
                object_id: format!("object-{index}"),
                path: format!("files/{index}.bin"),
                bytes,
                moment_id: moment_id.to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1_100 + index as i64,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("write content-bearing moment");
    store
        .write_with(&NoFaults, |tx| {
            journal_moment_append_in_tx(tx, WORKSPACE, moment_id)
        })
        .expect("journal moment");
}

fn push_operation() -> RelayOperation {
    RelayOperation::Push {
        workspace_id: WORKSPACE.to_owned(),
        now_ms: 2_000,
        max_read_bytes: 8 * 1024 * 1024,
    }
}

#[derive(Default)]
struct Relay {
    blobs: BTreeSet<String>,
    uploads: BTreeMap<String, usize>,
    ops: BTreeMap<i64, ReplicationEnvelope>,
    pushes: Vec<PushRequest>,
    inventories: usize,
    inserted: usize,
    skipped: usize,
}

impl Relay {
    fn answer(&mut self, request: &RelayIoRequest) -> RelayIoResponse {
        match request {
            RelayIoRequest::UploadBlobs(requests) => {
                assert!((2..=dohc_engine_sync::MAX_BLOB_UPLOAD_BATCH).contains(&requests.len()));
                for request in requests {
                    self.answer(&RelayIoRequest::UploadBlob(request.clone()));
                }
                RelayIoResponse::UploadBlob
            }
            RelayIoRequest::BlobsHave(request) => {
                assert!(request.sha256s.len() <= PREFIX_OPS);
                self.inventories += 1;
                RelayIoResponse::BlobsHave(BlobHaveResponse {
                    missing: request
                        .sha256s
                        .iter()
                        .filter(|sha| !self.blobs.contains(*sha))
                        .cloned()
                        .collect(),
                })
            }
            RelayIoRequest::UploadBlob(request) => {
                assert_eq!(hex_sha256(&request.bytes), request.sha256);
                *self.uploads.entry(request.sha256.clone()).or_default() += 1;
                assert!(self.blobs.insert(request.sha256.clone()), "upload repeated");
                RelayIoResponse::UploadBlob
            }
            RelayIoRequest::Push(request) => {
                assert_eq!(request.origin_id, ORIGIN);
                assert!(!request.ops.is_empty());
                assert!(request.ops.len() <= PREFIX_OPS);
                let mut inserted = 0;
                for op in &request.ops {
                    assert_eq!(op.origin_id, ORIGIN);
                    assert!(op.origin_seq > request.after_seq);
                    assert!(
                        self.blobs
                            .contains(op.payload["payloadAfterBlobSha256"].as_str().unwrap())
                    );
                    if let Some(previous) = self.ops.get(&op.origin_seq) {
                        assert_eq!(previous, op, "retry changed an immutable coordinate");
                    } else {
                        assert_eq!(op.origin_seq, self.ops.len() as i64);
                        self.ops.insert(op.origin_seq, op.clone());
                        inserted += 1;
                    }
                }
                self.pushes.push(request.clone());
                let skipped = request.ops.len() - inserted;
                self.inserted += inserted;
                self.skipped += skipped;
                RelayIoResponse::Push(PushResponse {
                    settlement_refusals: Vec::new(),
                    hosted_refusals: Vec::new(),
                    redundant_recoveries: Vec::new(),
                    accepted: request.ops.len(),
                    inserted,
                    skipped,
                    current_max_origin_seq: *self.ops.last_key_value().unwrap().0,
                })
            }
            other => panic!("unexpected push request: {other:?}"),
        }
    }

    fn assert_complete(&self) {
        assert_eq!(self.ops.len(), FILES);
        assert_eq!(self.inserted, FILES);
        assert_eq!(self.blobs.len(), FILES);
        assert_eq!(self.uploads.len(), FILES);
        assert!(self.uploads.values().all(|count| *count == 1));
        assert_eq!(
            self.ops.keys().copied().collect::<Vec<_>>(),
            (0..FILES as i64).collect::<Vec<_>>()
        );
    }
}

fn step(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    transport: &DeferredRelayTransport,
) -> Option<(usize, bool)> {
    match execute_relay_operation(
        store,
        cache,
        transport.clone(),
        push_operation(),
        &LeaseRegistry::default(),
        &ClaimAnnouncer::default(),
        &mut crate::actor::live_application::Registry::default(),
    ) {
        Err(RuntimeError::Relay(RelayError::Local(reason))) if reason == RELAY_IO_PENDING => None,
        Ok(mut outcome) => {
            transport.apply_progress(&mut outcome);
            let RelayOperationOutcome::Sync(SyncPassOutcome::Complete {
                pushed,
                has_more,
                owner_admission_pending,
                ..
            }) = outcome
            else {
                panic!("unexpected push outcome: {outcome:?}");
            };
            assert!(owner_admission_pending.is_empty());
            Some((pushed, has_more))
        }
        other => panic!("unexpected bridge result: {other:?}"),
    }
}

fn pump_pass(store: &mut EngineStore, relay: &mut Relay) -> (usize, bool) {
    let transport = DeferredRelayTransport::default();
    let mut cache = WriterDocCache::new();
    for _ in 0..1_000 {
        if let Some(outcome) = step(store, &mut cache, &transport) {
            assert!(transport.take_pending().is_none());
            return outcome;
        }
        let request = transport.take_pending().expect("deferred request");
        let response = relay.answer(&request);
        transport.complete(request, Ok(response));
    }
    panic!("bridge failed to finish a bounded prefix");
}

fn finish(store: &mut EngineStore, relay: &mut Relay) {
    for _ in 0..FILES {
        let (_, has_more) = pump_pass(store, relay);
        if !has_more {
            assert_eq!(
                read_pushed_seq(store, WORKSPACE, ORIGIN).unwrap(),
                FILES as i64 - 1
            );
            relay.assert_complete();
            return;
        }
    }
    panic!("push passes made no progress");
}

#[test]
fn deferred_conflict_rewind_refetches_the_relay_maximum() {
    let (_scratch, _path, mut store) = fixture_with_files(3);
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE sync_relay_push_state SET pushed_seq=1", [])
                .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .unwrap();
    let transport = DeferredRelayTransport::default();
    let mut cache = WriterDocCache::new();
    let mut relay = Relay::default();
    let mut probes = 0;
    let mut restored_prefixes = 0;
    for _ in 0..20 {
        match execute_relay_operation(
            &mut store,
            &mut cache,
            transport.clone(),
            push_operation(),
            &LeaseRegistry::default(),
            &ClaimAnnouncer::default(),
            &mut crate::actor::live_application::Registry::default(),
        ) {
            Err(RuntimeError::Relay(RelayError::OriginDiverged)) => {
                assert_eq!(probes, 2, "the second conflict must recheck the relay");
                assert_eq!(restored_prefixes, 1);
                assert_eq!(read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(), 1);
                return;
            }
            Err(RuntimeError::Relay(RelayError::Local(reason))) if reason == RELAY_IO_PENDING => {}
            other => panic!("unexpected rewind result: {other:?}"),
        }
        let request = transport.take_pending().expect("deferred rewind request");
        let response = match &request {
            RelayIoRequest::Push(push) if push.ops.is_empty() => {
                assert_eq!(push.after_seq, 1);
                probes += 1;
                Ok(RelayIoResponse::Push(PushResponse {
                    settlement_refusals: Vec::new(),
                    hosted_refusals: Vec::new(),
                    redundant_recoveries: Vec::new(),
                    accepted: 0,
                    inserted: 0,
                    skipped: 0,
                    current_max_origin_seq: if probes == 1 { 0 } else { 1 },
                }))
            }
            RelayIoRequest::Push(push) if push.after_seq == 1 => Err(RelayError::Conflict),
            RelayIoRequest::Push(push) if push.ops.len() > 1 => {
                // Force one acknowledged prefix before retrying the original conflicting suffix.
                Err(RelayError::SettlementProofBudget)
            }
            RelayIoRequest::Push(push) => {
                assert_eq!(push.after_seq, 0);
                assert_eq!(push.ops[0].origin_seq, 1);
                restored_prefixes += 1;
                Ok(RelayIoResponse::Push(PushResponse {
                    settlement_refusals: Vec::new(),
                    hosted_refusals: Vec::new(),
                    redundant_recoveries: Vec::new(),
                    accepted: 1,
                    inserted: 1,
                    skipped: 0,
                    current_max_origin_seq: 1,
                }))
            }
            _ => Ok(relay.answer(&request)),
        };
        transport.complete(request, response);
    }
    panic!(
        "cached conflict probe repeated the rewind: probes={probes}, restored_prefixes={restored_prefixes}"
    );
}

#[test]
fn deferred_push_returns_one_acknowledged_prefix_and_resumes_without_reuploading() {
    let (_scratch, _path, mut store) = fixture();
    let mut relay = Relay::default();
    let (pushed, has_more) = pump_pass(&mut store, &mut relay);
    assert_eq!(pushed, PREFIX_OPS);
    assert!(has_more);
    assert_eq!(relay.pushes.len(), 1);
    assert_eq!(relay.inventories, 1);
    assert_eq!(relay.ops.len(), PREFIX_OPS);
    assert_eq!(relay.blobs.len(), PREFIX_OPS);
    assert_eq!(
        read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(),
        PREFIX_OPS as i64 - 1
    );
    finish(&mut store, &mut relay);
    assert_eq!(relay.skipped, 0);
    assert_eq!(pump_pass(&mut store, &mut relay), (0, false));
    assert_eq!(relay.pushes.len(), FILES.div_ceil(PREFIX_OPS));
    assert_eq!(relay.inventories, FILES.div_ceil(PREFIX_OPS));
}

#[test]
fn deferred_proof_budget_reduces_batches_and_acknowledges_each_prefix() {
    let (_scratch, _path, mut store) = fixture_with_files(7);
    let transport = DeferredRelayTransport::default();
    let mut cache = WriterDocCache::new();
    let mut relay = Relay::default();
    let mut sizes = Vec::new();
    for _ in 0..100 {
        if let Some((pushed, has_more)) = step(&mut store, &mut cache, &transport) {
            assert_eq!(pushed, 7);
            assert!(!has_more);
            assert_eq!(read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(), 6);
            assert_eq!(sizes, vec![7, 3, 1, 1, 1, 1, 1, 1, 1]);
            assert_eq!(relay.ops.len(), 7);
            assert!(relay.uploads.values().all(|count| *count == 1));
            return;
        }
        let request = transport.take_pending().expect("deferred request");
        let response = match &request {
            RelayIoRequest::Push(push) => {
                sizes.push(push.ops.len());
                if push.ops.len() > 2 {
                    Err(RelayError::SettlementProofBudget)
                } else {
                    Ok(relay.answer(&request))
                }
            }
            _ => Ok(relay.answer(&request)),
        };
        transport.complete(request, response);
    }
    panic!("proof budget retry did not finish a bounded prefix");
}

#[test]
fn completed_have_confirmations_do_not_cross_blob_identities() {
    for key in ["workspace", "epoch", "stream"] {
        let (_scratch, _path, mut store) = fixture_with_files(1);
        let transport = DeferredRelayTransport::default();
        let mut cache = WriterDocCache::new();
        let mut relay = Relay::default();
        assert_eq!(step(&mut store, &mut cache, &transport), None);
        let RelayIoRequest::BlobsHave(have) = transport.take_pending().unwrap() else {
            panic!("expected initial inventory");
        };
        let mut other = have.clone();
        match key {
            "workspace" => other.workspace_id = "another-workspace".into(),
            "epoch" => other.replication_epoch = "another-epoch".into(),
            "stream" => other.stream_identity = "another-stream".into(),
            _ => unreachable!(),
        }
        transport.complete(
            RelayIoRequest::BlobsHave(other),
            Ok(RelayIoResponse::BlobsHave(BlobHaveResponse {
                missing: Vec::new(),
            })),
        );
        let request = RelayIoRequest::BlobsHave(have);
        let response = relay.answer(&request);
        transport.complete(request, Ok(response));
        assert_eq!(step(&mut store, &mut cache, &transport), None);
        let request = transport.take_pending().unwrap();
        assert!(
            matches!(request, RelayIoRequest::UploadBlob(_)),
            "{key} confirmation leaked into this push"
        );
        let response = relay.answer(&request);
        transport.complete(request, Ok(response));
        assert!(
            transport
                .state
                .lock()
                .unwrap()
                .completed
                .iter()
                .all(|(request, _)| !matches!(
                    request,
                    RelayIoRequest::UploadBlob(_) | RelayIoRequest::UploadBlobs(_)
                )),
            "successful uploads retain no request payload"
        );
        assert_eq!(step(&mut store, &mut cache, &transport), None);
        let request = transport.take_pending().unwrap();
        assert!(matches!(request, RelayIoRequest::Push(_)));
        let response = relay.answer(&request);
        transport.complete(request, Ok(response));
        assert_eq!(step(&mut store, &mut cache, &transport), Some((1, false)));
        assert_eq!(relay.inventories, 1);
    }
}

/// Push after an acknowledged prefix, cancelling the request when `cancel_at`
/// is first issued. Returns the outcome, the relay, and the digests the
/// request at which it cancelled uploads.
async fn push_cancelled_at(
    cancel_at: fn(&RelayIoRequest) -> bool,
) -> (
    Result<RelayOperationOutcome, RuntimeError>,
    ScratchDir,
    std::path::PathBuf,
    Relay,
    Vec<String>,
) {
    let (scratch, path, mut store) = fixture();
    let mut relay = Relay::default();
    assert_eq!(pump_pass(&mut store, &mut relay), (PREFIX_OPS, true));
    drop(store);

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 2_100).expect("open actor").actor;
    let token = CancellationToken::new();
    let request_token = token.clone();
    let relay = Arc::new(Mutex::new(relay));
    let cancelled_uploads = Arc::new(Mutex::new(Vec::new()));
    let io_relay = Arc::clone(&relay);
    let io_cancelled_uploads = Arc::clone(&cancelled_uploads);
    let outcome = actor
        .relay_with_io(
            false,
            push_operation(),
            LeaseRegistry::default(),
            token.clone(),
            None,
            move |request, _token| {
                let relay = Arc::clone(&io_relay);
                let cancelled_uploads = Arc::clone(&io_cancelled_uploads);
                let request_token = request_token.clone();
                async move {
                    if !request_token.is_cancelled() && cancel_at(&request) {
                        let uploads = match &request {
                            RelayIoRequest::UploadBlob(upload) => std::slice::from_ref(upload),
                            RelayIoRequest::UploadBlobs(uploads) => uploads.as_slice(),
                            _ => &[],
                        };
                        *cancelled_uploads.lock().unwrap() =
                            uploads.iter().map(|upload| upload.sha256.clone()).collect();
                        request_token.cancel();
                    }
                    Ok(relay.lock().unwrap().answer(&request))
                }
            },
        )
        .await;
    assert!(token.is_cancelled(), "the request was cancelled");
    supervisor.close(&path).expect("close actor");
    let relay = std::mem::take(&mut *relay.lock().unwrap());
    let cancelled_uploads = std::mem::take(&mut *cancelled_uploads.lock().unwrap());
    (outcome, scratch, path, relay, cancelled_uploads)
}

#[tokio::test]
async fn a_push_cancelled_after_its_upload_is_issued_answers_with_what_it_pushed() {
    let (outcome, _scratch, path, mut relay, cancelled_uploads) = push_cancelled_at(|request| {
        matches!(
            request,
            RelayIoRequest::UploadBlob(_) | RelayIoRequest::UploadBlobs(_)
        )
    })
    .await;
    assert!(!cancelled_uploads.is_empty(), "an upload was issued");
    assert!(
        cancelled_uploads
            .iter()
            .all(|sha| relay.blobs.contains(sha)),
        "the upload issued before cancellation landed"
    );
    assert!(
        matches!(
            outcome,
            Ok(RelayOperationOutcome::Sync(SyncPassOutcome::Complete {
                pushed: PREFIX_OPS,
                has_more: true,
                ..
            }))
        ),
        "{outcome:?}"
    );
    let mut store = EngineStore::open(&path, 2_200).expect("reopen store");
    assert_eq!(
        read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(),
        2 * PREFIX_OPS as i64 - 1
    );
    assert_eq!(relay.ops.len(), 2 * PREFIX_OPS);
    finish(&mut store, &mut relay);
    assert_eq!(relay.skipped, 0);
}

#[tokio::test]
async fn a_push_cancelled_during_its_inventory_read_preserves_the_acknowledged_prefix() {
    let (outcome, _scratch, path, mut relay, _) =
        push_cancelled_at(|request| matches!(request, RelayIoRequest::BlobsHave(_))).await;
    assert!(
        matches!(outcome, Err(RuntimeError::Cancelled)),
        "{outcome:?}"
    );
    let mut store = EngineStore::open(&path, 2_200).expect("reopen store");
    assert_eq!(
        read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(),
        PREFIX_OPS as i64 - 1
    );
    assert_eq!(relay.ops.len(), PREFIX_OPS);
    finish(&mut store, &mut relay);
    assert_eq!(relay.skipped, 0);
}

#[tokio::test]
async fn deferred_push_requires_hosted_author_proof_and_preserves_neutral_markers() {
    // Even a live settlement moment on the native lane needs a proof.
    let settlement = format!("moment-ydoc-{}", "a".repeat(64));
    for authors in [
        serde_json::json!([{"kind":"human","humanId":"recipient","humanName":"Recipient"}]),
        serde_json::json!([{"kind":"link","publicPrincipalId":"recipient","label":"Edit link"}]),
        serde_json::json!([{"kind":"unattributed"}]),
    ] {
        for (moment_id, native_settlements) in [
            (settlement.as_str(), false),
            (settlement.as_str(), true),
            ("moment-0", false),
            ("moment-0", true),
        ] {
            let (_scratch, path, mut store) = fixture_with_files(0);
            append_file_as(&mut store, 0, moment_id);
            append_file(&mut store, 1);
            store.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE replication_log SET payload_json=json_set(payload_json,'$.authors',json(?1)) WHERE op_kind='moment.append' AND origin_seq=0", [authors.to_string()]).map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        }).unwrap();
            drop(store);
            let supervisor = WorkspaceSupervisor::new();
            let actor = supervisor.open(&path, 2_100).unwrap().actor;
            let relay = Arc::new(Mutex::new(Relay::default()));
            let io_relay = Arc::clone(&relay);
            let outcome = actor
                .relay_with_io(
                    native_settlements,
                    push_operation(),
                    LeaseRegistry::default(),
                    CancellationToken::new(),
                    None,
                    move |request, _token| {
                        let relay = Arc::clone(&io_relay);
                        async move { Ok(relay.lock().unwrap().answer(&request)) }
                    },
                )
                .await
                .unwrap();
            assert!(matches!(
                outcome,
                RelayOperationOutcome::Sync(SyncPassOutcome::Complete {
                    pushed: 2,
                    has_more: false,
                    ..
                })
            ));
            {
                let relay = relay.lock().unwrap();
                assert_eq!(relay.ops.len(), 2, "later file must still push");
                let payload = &relay.ops[&0].payload;
                if authors[0]["kind"] == "unattributed" {
                    assert_eq!(payload["authors"], authors);
                    assert!(payload.get("attributionUnavailable").is_none());
                } else {
                    assert!(payload.get("authors").is_none());
                    assert_eq!(
                        payload["attributionUnavailable"]["reason"],
                        "unproven-hosted-authors"
                    );
                }
            }
            supervisor.close(&path).unwrap();
            let store = EngineStore::open(&path, 2_200).unwrap();
            assert_eq!(read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(), 1);
        }
    }
}

#[test]
fn prepared_push_keeps_its_bounded_page_after_a_writer_append() {
    let (_scratch, _path, mut store) = fixture_with_files(1);
    let transport = DeferredRelayTransport::default();
    let mut cache = WriterDocCache::new();
    let mut relay = Relay::default();
    assert_eq!(step(&mut store, &mut cache, &transport), None);
    let request = transport.take_pending().expect("initial inventory");
    let RelayIoRequest::BlobsHave(inventory) = &request else {
        panic!("unexpected initial request: {request:?}");
    };
    assert_eq!(inventory.sha256s.len(), 1);
    let response = relay.answer(&request);
    transport.complete(request, Ok(response));

    append_file(&mut store, 1);
    assert_eq!(read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(), -1);
    assert_eq!(step(&mut store, &mut cache, &transport), None);
    let request = transport.take_pending().expect("prepared upload");
    let RelayIoRequest::UploadBlob(_) = &request else {
        panic!("later append restarted the prepared page: {request:?}");
    };
    let response = relay.answer(&request);
    transport.complete(request, Ok(response));

    for _ in 0..10 {
        if let Some(outcome) = step(&mut store, &mut cache, &transport) {
            assert_eq!(outcome, (2, false));
            assert_eq!(read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(), 1);
            assert_eq!(relay.ops.keys().copied().collect::<Vec<_>>(), vec![0, 1]);
            assert_eq!(relay.inserted, 2);
            assert_eq!(relay.skipped, 0);
            assert_eq!(relay.pushes.len(), 2);
            assert_eq!(relay.pushes[0].ops.len(), 1);
            assert_eq!(relay.pushes[1].ops.len(), 1);
            assert_eq!(relay.inventories, 2);
            assert_eq!(relay.uploads.len(), 2);
            assert!(relay.uploads.values().all(|count| *count == 1));
            return;
        }
        let request = transport.take_pending().expect("deferred request");
        let response = relay.answer(&request);
        transport.complete(request, Ok(response));
    }
    panic!("retained page did not finish");
}

#[test]
fn identity_change_does_not_acknowledge_an_old_deferred_append() {
    let (_scratch, _path, mut store) = fixture_with_files(1);
    let transport = DeferredRelayTransport::default();
    let mut cache = WriterDocCache::new();
    let mut relay = Relay::default();
    loop {
        assert_eq!(step(&mut store, &mut cache, &transport), None);
        let request = transport.take_pending().expect("deferred request");
        let response = relay.answer(&request);
        let is_push = matches!(request, RelayIoRequest::Push(_));
        transport.complete(request, Ok(response));
        if is_push {
            break;
        }
    }
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE sync_identity SET stream_identity='new-stream' WHERE workspace_id=?1",
                [WORKSPACE],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("replace stream identity before consuming append");
    assert_eq!(step(&mut store, &mut cache, &transport), None);
    assert_eq!(read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(), -1);
    let RelayIoRequest::BlobsHave(inventory) = transport.take_pending().expect("new inventory")
    else {
        panic!("old stream preparation was reused");
    };
    assert_eq!(inventory.stream_identity, "new-stream");
}

#[test]
fn dropped_completed_push_replays_remote_commit_once_before_advancing_local_cursor() {
    let (_scratch, path, mut store) = fixture();
    let mut relay = Relay::default();
    assert_eq!(pump_pass(&mut store, &mut relay), (PREFIX_OPS, true));
    let transport = DeferredRelayTransport::default();
    let mut cache = WriterDocCache::new();
    let mut committed = None;
    for _ in 0..1_000 {
        assert_eq!(step(&mut store, &mut cache, &transport), None);
        let request = transport.take_pending().expect("deferred request");
        let response = relay.answer(&request);
        let is_push = matches!(request, RelayIoRequest::Push(_));
        transport.complete(request.clone(), Ok(response));
        if is_push {
            committed = Some(request);
            break;
        }
    }
    let RelayIoRequest::Push(committed) = committed.expect("remote commit") else {
        unreachable!();
    };
    assert_eq!(committed.after_seq, PREFIX_OPS as i64 - 1);
    assert_eq!(relay.ops.len(), 2 * PREFIX_OPS);
    // The relay committed; the writer has not consumed its completed answer.
    assert_eq!(
        read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(),
        PREFIX_OPS as i64 - 1
    );
    drop(transport);
    drop(store);
    let mut store = EngineStore::open(&path, 2_100).expect("reopen store");
    assert_eq!(
        read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(),
        PREFIX_OPS as i64 - 1
    );
    let (pushed, has_more) = pump_pass(&mut store, &mut relay);
    assert_eq!(
        pushed, 0,
        "the resumed append is already stored by the relay"
    );
    assert!(has_more);
    assert_eq!(relay.pushes.last().unwrap(), &committed);
    assert_eq!(
        read_pushed_seq(&store, WORKSPACE, ORIGIN).unwrap(),
        (2 * PREFIX_OPS) as i64 - 1
    );
    assert_eq!(relay.skipped, PREFIX_OPS);
    finish(&mut store, &mut relay);
    assert_eq!(relay.skipped, PREFIX_OPS);
}
