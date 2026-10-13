use super::*;
use std::cell::Cell;

const HOST: &str = "service-host:host";

fn hosted_store() -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let (scratch, path, mut store) = open_store();
    assert_eq!(
        create_hosted_replica(
            &mut store, "ws", HOST, "epoch-1", "stream-1", 1_000, &NoFaults
        )
        .unwrap(),
        TxnOutcome::Committed(AdoptJoinIdentityOutcome::Adopted)
    );
    (scratch, path, store)
}

fn op(seq: i64, body: &str) -> ReplicationEnvelope {
    envelope("owner", seq, "probe.remote", json!({ "body": body }))
}

/// Admit `op`, counting how often its mutation runs.
fn admit(
    store: &mut EngineStore,
    op: &ReplicationEnvelope,
    mutations: &Cell<usize>,
) -> Result<ApplyDisposition<()>, SyncError> {
    apply_envelope_with(store, op, &NoFaults, |_tx, _op| {
        mutations.set(mutations.get() + 1);
        Ok(())
    })
    .map(|outcome| outcome.primary)
}

fn journaled(store: &EngineStore) -> Vec<i64> {
    store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT origin_seq FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id='owner' ORDER BY origin_seq",
            )?;
            let rows = statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<i64>, _>>()?;
            Ok::<_, rusqlite::Error>(rows)
        })
        .unwrap()
}

fn retained(store: &EngineStore) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM relay_deferred_ops", [], |row| {
                row.get(0)
            })
        })
        .unwrap()
}

#[test]
fn a_replica_is_hosted_only_by_its_row() {
    let (_scratch, _path, mut store) = open_store();
    for refused in [
        create_hosted_replica(
            &mut store,
            "ws",
            "origin:host",
            "epoch-1",
            "stream-1",
            1,
            &NoFaults,
        ),
        adopt_join_identity(&mut store, "ws", HOST, "epoch-1", "stream-1", 1, &NoFaults),
    ] {
        assert!(matches!(refused, Err(SyncError::InvalidInput { .. })));
    }
    seed_identity(&mut store);
    assert!(
        matches!(
            create_hosted_replica(&mut store, "ws", HOST, "epoch-1", "stream-1", 1, &NoFaults),
            Err(SyncError::InvalidInput { .. })
        ),
        "an ordinary replica never becomes hosted"
    );

    let (_scratch, _path, mut hosted) = hosted_store();
    assert_eq!(
        create_hosted_replica(&mut hosted, "ws", HOST, "epoch-1", "stream-1", 1, &NoFaults)
            .unwrap(),
        TxnOutcome::Committed(AdoptJoinIdentityOutcome::AlreadyMatched)
    );
    assert!(
        matches!(
            adopt_join_identity(
                &mut hosted,
                "ws",
                "origin:x",
                "epoch-1",
                "stream-1",
                1,
                &NoFaults
            ),
            Err(SyncError::InvalidInput { .. })
        ),
        "a hosted replica never becomes ordinary"
    );
}

#[test]
fn hosted_admission_takes_sparse_origins_that_ordinary_admission_refuses() {
    let mutations = Cell::new(0);
    let (_ordinary_scratch, _ordinary_path, mut ordinary) = open_store();
    seed_identity(&mut ordinary);
    assert_eq!(
        admit(&mut ordinary, &op(0, "first"), &mutations).unwrap(),
        ApplyDisposition::Applied(())
    );
    assert!(matches!(
        admit(&mut ordinary, &op(2, "after a gap"), &mutations),
        Err(SyncError::SequenceGap)
    ));
    assert_eq!(
        read_replication_acked_seq(&ordinary, "ws", "owner").unwrap(),
        0
    );

    let (_scratch, _path, mut hosted) = hosted_store();
    for seq in [0, 2, 5] {
        assert_eq!(
            admit(&mut hosted, &op(seq, "sparse"), &mutations).unwrap(),
            ApplyDisposition::Applied(())
        );
    }
    assert_eq!(mutations.get(), 4);
    assert_eq!(journaled(&hosted), [0, 2, 5]);
    assert_eq!(
        read_replication_acked_seq(&hosted, "ws", "owner").unwrap(),
        -1,
        "sparse admission never moves the ordinary ack"
    );
}

#[test]
fn hosted_backfill_below_applied_coordinates_applies_exactly_once() {
    let mutations = Cell::new(0);
    let (_scratch, _path, mut store) = hosted_store();
    for (seq, body) in [(5, "later"), (2, "backfill")] {
        assert_eq!(
            admit(&mut store, &op(seq, body), &mutations).unwrap(),
            ApplyDisposition::Applied(())
        );
    }
    for (seq, body) in [(2, "backfill"), (5, "later")] {
        assert_eq!(
            admit(&mut store, &op(seq, body), &mutations).unwrap(),
            ApplyDisposition::Skipped,
            "redelivery of {seq}"
        );
    }
    assert!(matches!(
        admit(&mut store, &op(2, "divergent"), &mutations),
        Err(SyncError::CoordinateDiverged)
    ));
    assert_eq!(mutations.get(), 2);
    assert_eq!(journaled(&store), [2, 5]);
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "owner").unwrap(),
        -1
    );
}

/// An op of `object_id` at relay position `relay_seq`.
fn document_op(seq: i64, relay_seq: i64, object_id: &str) -> ReplicationEnvelope {
    let mut op = envelope(
        "owner",
        seq,
        "live.audit.application",
        json!({ "objectId": object_id }),
    );
    op.relay_seq = Some(relay_seq);
    op
}

#[test]
fn hosted_deferred_work_replays_by_coordinate_membership() {
    let mutations = Cell::new(0);
    let (_scratch, _path, mut store) = hosted_store();
    host_document(&mut store, "doc-a");
    let identity = read_sync_identity(&store, "ws").unwrap().unwrap();
    let (early, late) = (document_op(3, 1, "doc-a"), document_op(7, 2, "doc-a"));
    crate::deferred::retain(&mut store, &identity, &[&early, &late], &NoFaults).unwrap();
    let waiting = |store: &EngineStore| {
        crate::deferred::read_hosted(store, "ws", &identity)
            .unwrap()
            .documents
    };
    assert_eq!(
        waiting(&store),
        BTreeMap::from([("doc-a".to_owned(), None)])
    );

    admit(&mut store, &early, &mutations).unwrap();
    assert!(
        crate::deferred::has_unapplied(&store, "ws").unwrap(),
        "the later coordinate still waits"
    );
    admit(&mut store, &late, &mutations).unwrap();
    assert!(!crate::deferred::has_unapplied(&store, "ws").unwrap());
    assert!(waiting(&store).is_empty());
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "owner").unwrap(),
        -1
    );

    let mut unplaced = document_op(8, 3, "doc-a");
    unplaced.relay_seq = None;
    for refused in [op(9, "names no document"), unplaced] {
        assert!(
            crate::deferred::retain(&mut store, &identity, &[&refused], &NoFaults).is_err(),
            "a hosted replica retains its documents' work at its relay position"
        );
    }
}

/// Make `object_id` a document of the replica's current scope.
fn host_document(store: &mut EngineStore, object_id: &str) {
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO hosted_documents (workspace_id,object_id,path,state,scope_generation) \
                 SELECT workspace_id,?1,?1||'.md','ready',scope_generation FROM hosted_replicas \
                 WHERE workspace_id='ws'",
                [object_id],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

fn last_outbound_seq(store: &EngineStore) -> i64 {
    count(
        store,
        "SELECT last_outbound_seq FROM hosted_replicas WHERE workspace_id='ws'",
    )
}

#[test]
fn hosted_outbound_sequences_survive_purged_journal_rows_and_reopen() {
    let (_scratch, path, mut store) = hosted_store();
    host_document(&mut store, "doc-a");
    let journal = |store: &mut EngineStore| match journal_local_replication_op(
        store,
        "ws",
        HOST,
        "epoch-1",
        "stream-1",
        "live.audit.application",
        &json!({"objectId": "doc-a"}),
        1_000,
        &NoFaults,
    )
    .unwrap()
    {
        TxnOutcome::Committed(seq) => seq,
        TxnOutcome::Crashed { .. } => panic!("no fault was injected"),
    };
    let mut written = vec![journal(&mut store), journal(&mut store)];
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM replication_log WHERE workspace_id='ws'", [])
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    drop(store);

    let mut store = EngineStore::open(&path, 2_000).unwrap();
    written.push(journal(&mut store));
    let TxnOutcome::Committed(in_tx) = store
        .write_with(&NoFaults, |tx| {
            journal_local_op_in_tx(
                tx,
                "ws",
                "live.audit.application",
                &json!({"objectId": "doc-a"}),
                2_000,
            )
        })
        .unwrap()
    else {
        panic!("no fault was injected");
    };
    written.push(in_tx);
    assert_eq!(written, [0, 1, 2, 3]);
    assert_eq!(last_outbound_seq(&store), 3);
}

/// The slice-1 review's reproduction: chat on a hosted replica allocated from
/// the journal's maximum while the sync journal allocated from the counter, so
/// the next sync append collided with a chat coordinate.
#[test]
fn a_hosted_replica_writes_no_chat_and_its_journal_keeps_one_counter() {
    let (_scratch, path, mut store) = hosted_store_with_main();
    host_document(&mut store, "doc-a");
    {
        let mut chats = LinkedChatStore::new(&mut store);
        for refused in [
            chats.ensure_general_channel("ws", "general-local", 2_000, &NoFaults),
            chats.ensure_agent_channel("ws", "agent-local", 2_000, &NoFaults),
        ] {
            assert!(matches!(
                refused,
                Err(dohc_engine_domain::DomainError::InvalidInput { .. })
            ));
        }
    }
    for table in ["replication_log", "chat_channels", "chat_channel_wire_ids"] {
        assert_eq!(
            count(&store, &format!("SELECT COUNT(*) FROM {table}")),
            0,
            "{table} stays empty"
        );
    }
    assert_eq!(last_outbound_seq(&store), -1);

    let append = |store: &mut EngineStore| {
        store
            .write_with(&NoFaults, |tx| {
                journal_local_op_in_tx(
                    tx,
                    "ws",
                    "ydoc.update",
                    &json!({"objectId": "doc-a"}),
                    3_000,
                )
            })
            .unwrap()
    };
    assert_eq!(append(&mut store), TxnOutcome::Committed(0));
    drop(store);
    let mut store = EngineStore::open(&path, 4_000).unwrap();
    assert_eq!(append(&mut store), TxnOutcome::Committed(1));
    assert_eq!(
        coordinates(&store),
        [(HOST.to_owned(), 0), (HOST.to_owned(), 1)]
    );
}

/// Every kind the session host does not write is refused before it takes a
/// sequence, through both journal paths; every kind it writes, for a document
/// it hosts, takes the next one from the counter.
#[test]
fn a_hosted_replica_journals_only_its_documents_live_work() {
    let (_scratch, _path, mut store) = hosted_store();
    host_document(&mut store, "doc-a");
    let in_tx = |store: &mut EngineStore, kind: &str, payload: serde_json::Value| {
        store.write_with(&NoFaults, |tx| {
            journal_local_op_in_tx(tx, "ws", kind, &payload, 2_000)
        })
    };
    for (kind, payload) in [
        ("chat.message.create", json!({"threadId": "thread"})),
        ("secret.file.put", json!({"objectId": "doc-a"})),
        ("version.create", json!({"versionId": "fork"})),
        ("conflict.resolve", json!({"conflictId": "conflict"})),
        ("workspace.init", json!({})),
        ("moment.append", json!({"objectId": "private"})),
        ("ydoc.update", json!({"objectId": "private"})),
        ("moment.append", json!({})),
    ] {
        assert!(
            matches!(
                in_tx(&mut store, kind, payload.clone()),
                Err(SyncError::InvalidInput {
                    reason: "a hosted replica writes only its hosted documents"
                })
            ),
            "{kind} {payload}"
        );
        assert!(matches!(
            journal_local_replication_op(
                &mut store, "ws", HOST, "epoch-1", "stream-1", kind, &payload, 2_000, &NoFaults
            ),
            Err(SyncError::InvalidInput { .. })
        ));
    }
    assert_eq!(count(&store, "SELECT COUNT(*) FROM replication_log"), 0);
    assert_eq!(last_outbound_seq(&store), -1, "a refusal takes no sequence");

    let mut written = Vec::new();
    for (kind, payload) in [
        ("ydoc.update", json!({"objectId": "doc-a"})),
        ("moment.append", json!({"objectId": "doc-a"})),
        ("live.audit.application", json!({"objectId": "doc-a"})),
        (
            "live.audit.settlement",
            json!({"record": {"binding": {"objectId": "doc-a"}}}),
        ),
        (
            "live.audit.base",
            json!({"record": {"checkpoint": {"binding": {"objectId": "doc-a"}}}}),
        ),
    ] {
        let TxnOutcome::Committed(seq) = in_tx(&mut store, kind, payload).unwrap() else {
            panic!("no fault was injected");
        };
        written.push(seq);
    }
    assert_eq!(written, [0, 1, 2, 3, 4]);
    assert_eq!(last_outbound_seq(&store), 4);
}

/// The relay's scoped feed, in memory. It serves `workspace.init` and the
/// rows of shared documents with their original coordinates, withholds every
/// other row, and examines `raw_rows_per_page` rows per page as the relay
/// bounds its scan, so its cursor passes withheld rows. Under a stale scope
/// token it serves nothing and keeps the cursor.
struct HostedFeed {
    log: Mutex<Vec<ReplicationEnvelope>>,
    shared: Mutex<BTreeMap<String, String>>,
    revision: AtomicUsize,
    blobs: Mutex<BTreeMap<String, Vec<u8>>>,
    raw_rows_per_page: AtomicUsize,
    /// Shares a document just before answering the pull with this count.
    share_at_pull: Mutex<Option<(usize, String, String)>>,
    pulls: Mutex<Vec<HostedPullRequest>>,
    pushes: Mutex<Vec<PushRequest>>,
    /// Every blob a download asked for.
    downloads: Mutex<Vec<String>>,
}

impl HostedFeed {
    fn new() -> Self {
        Self {
            log: Mutex::new(Vec::new()),
            shared: Mutex::new(BTreeMap::new()),
            revision: AtomicUsize::new(0),
            blobs: Mutex::new(BTreeMap::new()),
            raw_rows_per_page: AtomicUsize::new(usize::MAX),
            share_at_pull: Mutex::new(None),
            pulls: Mutex::new(Vec::new()),
            pushes: Mutex::new(Vec::new()),
            downloads: Mutex::new(Vec::new()),
        }
    }

    fn append(&self, mut op: ReplicationEnvelope) {
        let mut log = self.log.lock().unwrap();
        op.relay_seq = Some(log.len() as i64 + 1);
        log.push(op);
    }

    fn share(&self, object_id: &str, path: &str) {
        self.shared
            .lock()
            .unwrap()
            .insert(object_id.to_owned(), path.to_owned());
        self.revision.fetch_add(1, Ordering::SeqCst);
    }

    fn unshare(&self, object_id: &str) {
        self.shared.lock().unwrap().remove(object_id);
        self.revision.fetch_add(1, Ordering::SeqCst);
    }

    fn token(&self) -> String {
        format!("scope-{}", self.revision.load(Ordering::SeqCst))
    }

    /// A text write that creates `object_id`, with its bytes on the relay.
    fn create(&self, origin: &str, seq: i64, object_id: &str, path: &str, text: &str) {
        let sha = dohc_engine_storage::hex_sha256(text.as_bytes());
        self.blobs
            .lock()
            .unwrap()
            .insert(sha.clone(), text.as_bytes().to_vec());
        self.append(envelope(
            origin,
            seq,
            "moment.append",
            json!({
                "momentId": format!("moment-{origin}-{seq}"),
                "versionId": "main",
                "objectId": object_id,
                "objectCreatedAtMs": 1,
                "path": path,
                "recordedAtMs": 2_000,
                "operation": "write",
                "payloadBeforeBlobSha256": null,
                "payloadBeforePath": null,
                "payloadAfterBlobSha256": sha,
                "payloadAfterPath": path,
                "metadata": {"origin": "sync"},
                "beforePresent": "absent"
            }),
        ));
    }

    /// A text write of `object_id` whose before side is an object's head at
    /// the same path: its id, text and latest moment. The relay holds only the
    /// after bytes.
    fn replace(
        &self,
        origin: &str,
        seq: i64,
        object_id: &str,
        path: &str,
        text: &str,
        before: (&str, &str, &str),
    ) {
        let (before_object_id, before_text, before_moment_id) = before;
        let sha = dohc_engine_storage::hex_sha256(text.as_bytes());
        let before_sha = dohc_engine_storage::hex_sha256(before_text.as_bytes());
        self.blobs
            .lock()
            .unwrap()
            .insert(sha.clone(), text.as_bytes().to_vec());
        self.append(envelope(
            origin,
            seq,
            "moment.append",
            json!({
                "momentId": format!("moment-{origin}-{seq}"),
                "versionId": "main",
                "objectId": object_id,
                "objectCreatedAtMs": 1,
                "path": path,
                "recordedAtMs": 2_000,
                "operation": "write",
                "payloadBeforeBlobSha256": before_sha,
                "payloadBeforePath": path,
                "payloadAfterBlobSha256": sha,
                "payloadAfterPath": path,
                "metadata": {"origin": "sync"},
                "beforePresent": "present",
                "beforeObjectId": before_object_id,
                "beforeVersionId": "main",
                "beforePath": path,
                "beforeBlobSha256": before_sha,
                "beforeContentKind": "text",
                "beforeUpdatedAtMs": 1_500,
                "beforeLatestMomentId": before_moment_id,
                "beforeMetadata": {"origin": "sync"}
            }),
        ));
    }

    fn pull_requests(&self) -> Vec<HostedPullRequest> {
        self.pulls.lock().unwrap().clone()
    }

    fn downloaded(&self) -> Vec<String> {
        self.downloads.lock().unwrap().clone()
    }
}

impl RelayTransport for HostedFeed {
    fn push(&self, _req: PushRequest) -> Result<PushResponse, RelayError> {
        // The relay refuses a service-host origin outside the hosted routes.
        Err(RelayError::BadRequest)
    }

    fn pull(&self, _req: PullRequest) -> Result<PullResponse, RelayError> {
        Err(RelayError::BadRequest)
    }

    fn pull_hosted(&self, req: HostedPullRequest) -> Result<HostedPullResponse, RelayError> {
        let count = {
            let mut pulls = self.pulls.lock().unwrap();
            pulls.push(req.clone());
            pulls.len()
        };
        let due = {
            let mut share_at = self.share_at_pull.lock().unwrap();
            if share_at.as_ref().is_some_and(|(at, ..)| *at == count) {
                share_at.take()
            } else {
                None
            }
        };
        if let Some((_, object_id, path)) = due {
            self.share(&object_id, &path);
        }
        let shared = self.shared.lock().unwrap().clone();
        let scope = HostedScope {
            token: self.token(),
            documents: shared
                .iter()
                .map(|(object_id, path)| HostedScopeDocument {
                    object_id: object_id.clone(),
                    path: path.clone(),
                })
                .collect(),
        };
        if req.scope_token.as_deref() != Some(scope.token.as_str()) {
            return Ok(HostedPullResponse {
                scope,
                ops: Vec::new(),
                next_cursor: req.cursor,
                has_more: false,
            });
        }
        if req
            .object_id
            .as_ref()
            .is_some_and(|object_id| !shared.contains_key(object_id))
        {
            return Err(RelayError::BadRequest);
        }
        let log = self.log.lock().unwrap();
        let rows = log
            .iter()
            .filter(|row| row.relay_seq.unwrap() > req.cursor)
            .collect::<Vec<_>>();
        let raw = self.raw_rows_per_page.load(Ordering::SeqCst);
        let (mut ops, mut scanned, mut next_cursor) = (Vec::new(), 0, req.cursor);
        for row in &rows {
            if scanned == raw || ops.len() == req.limit {
                break;
            }
            scanned += 1;
            next_cursor = row.relay_seq.unwrap();
            let admitted = match (crate::hosted::hosted_document(row), &req.object_id) {
                (Some(object_id), Some(filter)) => object_id == filter.as_str(),
                (Some(object_id), None) => shared.contains_key(object_id),
                (None, None) => row.op_kind == "workspace.init",
                (None, Some(_)) => false,
            };
            if admitted {
                ops.push((*row).clone());
            }
        }
        Ok(HostedPullResponse {
            scope,
            ops,
            next_cursor,
            has_more: scanned < rows.len(),
        })
    }

    fn push_hosted(&self, req: PushRequest) -> Result<PushResponse, RelayError> {
        if !req.origin_id.starts_with(SERVICE_HOST_ORIGIN_PREFIX) {
            return Err(RelayError::BadRequest);
        }
        self.pushes.lock().unwrap().push(req.clone());
        let accepted = req.ops.len();
        let mut inserted = 0;
        for op in req.ops {
            let present = self
                .log
                .lock()
                .unwrap()
                .iter()
                .any(|row| row.origin_id == op.origin_id && row.origin_seq == op.origin_seq);
            if !present {
                self.append(op);
                inserted += 1;
            }
        }
        let current_max_origin_seq = self
            .log
            .lock()
            .unwrap()
            .iter()
            .filter(|row| row.origin_id == req.origin_id)
            .map(|row| row.origin_seq)
            .max()
            .unwrap_or(-1);
        Ok(PushResponse {
            settlement_refusals: Vec::new(),
            accepted,
            inserted,
            skipped: accepted - inserted,
            current_max_origin_seq,
        })
    }

    fn lookup_log_coordinate(
        &self,
        req: LogCoordinateRequest,
    ) -> Result<LogCoordinateResponse, RelayError> {
        Ok(self
            .log
            .lock()
            .unwrap()
            .iter()
            .find(|row| row.origin_id == req.origin_id && row.origin_seq == req.origin_seq)
            .cloned()
            .map_or(
                LogCoordinateResponse::Absent,
                LogCoordinateResponse::Present,
            ))
    }

    fn probe(&self, _req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        Ok(ProbeResponse { has_content: false })
    }

    fn claim_workspace(&self, _req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        Err(RelayError::BadRequest)
    }

    fn rotate_epoch(&self, _req: EpochRequest) -> Result<EpochResponse, RelayError> {
        Err(RelayError::BadRequest)
    }

    fn blobs_have(&self, req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError> {
        let blobs = self.blobs.lock().unwrap();
        Ok(BlobHaveResponse {
            missing: req
                .sha256s
                .into_iter()
                .filter(|sha256| !blobs.contains_key(sha256))
                .collect(),
        })
    }

    fn upload_blob(&self, req: BlobUploadRequest) -> Result<(), RelayError> {
        self.blobs.lock().unwrap().insert(req.sha256, req.bytes);
        Ok(())
    }

    fn download_blobs(
        &self,
        req: BlobDownloadBatchRequest,
    ) -> Result<BlobDownloadBatchResponse, RelayError> {
        let blobs = self.blobs.lock().unwrap();
        self.downloads
            .lock()
            .unwrap()
            .extend(req.blobs.iter().map(|blob| blob.sha256.clone()));
        Ok(BlobDownloadBatchResponse {
            results: req
                .blobs
                .iter()
                .map(|blob| {
                    blobs
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
        Err(RelayError::BadRequest)
    }

    fn download_key_envelope(
        &self,
        _req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError> {
        Err(RelayError::BadRequest)
    }

    fn shared_channel_pull(
        &self,
        _req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        Err(RelayError::BadRequest)
    }

    fn share_log_push(&self, _req: ShareLogPushRequest) -> Result<PushResponse, RelayError> {
        Err(RelayError::BadRequest)
    }

    fn share_view_pull(&self, _req: ShareViewRequest) -> Result<ShareViewResponse, RelayError> {
        Err(RelayError::BadRequest)
    }

    fn share_blob(&self, _req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError> {
        Err(RelayError::BadRequest)
    }

    fn share_blob_upload(&self, _req: ShareBlobUploadRequest) -> Result<(), RelayError> {
        Err(RelayError::BadRequest)
    }

    fn share_proposal_submit(
        &self,
        _req: ShareProposalSubmitRequest,
    ) -> Result<ShareProposalSubmitResponse, RelayError> {
        Err(RelayError::BadRequest)
    }

    fn share_collection_write(
        &self,
        _req: ShareCollectionWriteRequest,
    ) -> Result<ShareCollectionWriteResponse, RelayError> {
        Err(RelayError::BadRequest)
    }
}

/// A feed holding a hosted document, a private file it withholds, and a
/// document outside the scope until a test shares it.
fn hosted_feed() -> HostedFeed {
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-a", "a.md", "hosted a");
    feed.create("owner", 2, "private", "private.md", "private");
    feed.create("owner", 3, "doc-b", "b.md", "hosted b");
    feed.share("doc-a", "a.md");
    feed
}

fn hosted_store_with_main() -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let (scratch, path, mut store) = hosted_store();
    seed_replication_version(&mut store, "main", "main");
    (scratch, path, store)
}

fn pass(
    client: &RelaySyncClient<HostedFeed>,
    store: &mut EngineStore,
    faults: &dyn dohc_engine_storage::FaultInjector,
) -> Result<HostedPassOutcome, RelayError> {
    client.pull_hosted_workspace(
        store,
        &mut WriterDocCache::new(),
        "ws",
        faults,
        &NoLiveLeases,
    )
}

fn commit(
    client: &RelaySyncClient<HostedFeed>,
    store: &mut EngineStore,
    outcome: &HostedPassOutcome,
) -> bool {
    let Some(pending) = &outcome.pending_cursor else {
        return false;
    };
    match client
        .commit_hosted_cursor(store, "ws", pending, &NoFaults)
        .unwrap()
    {
        TxnOutcome::Committed(committed) => committed,
        TxnOutcome::Crashed { .. } => panic!("no fault was injected"),
    }
}

/// Pass and commit until the feed has nothing more.
fn sync(client: &RelaySyncClient<HostedFeed>, store: &mut EngineStore) {
    for _ in 0..64 {
        let outcome = pass(client, store, &NoFaults).unwrap();
        commit(client, store, &outcome);
        if !outcome.has_more {
            return;
        }
    }
    panic!("the hosted replica did not catch up");
}

fn replica(store: &EngineStore) -> HostedReplicaState {
    read_hosted_replica(store, "ws").unwrap().unwrap()
}

fn document(store: &EngineStore, object_id: &str) -> Option<HostedDocumentState> {
    replica(store).documents.get(object_id).cloned()
}

fn coordinates(store: &EngineStore) -> Vec<(String, i64)> {
    store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT origin_id,origin_seq FROM replication_log \
                 WHERE workspace_id='ws' ORDER BY origin_id,origin_seq",
            )?;
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap()
}

/// Each object's current text, and how many moments each moment id has.
fn content(store: &EngineStore) -> (BTreeMap<String, String>, BTreeMap<String, i64>) {
    store
        .read_with(|conn| {
            let mut heads = conn.prepare(
                "SELECT s.object_id,b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
                 WHERE s.workspace_id='ws' AND s.version_id='main'",
            )?;
            let heads = heads
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<_, _>>()?;
            let mut moments = conn.prepare(
                "SELECT moment_id,COUNT(*) FROM moments WHERE workspace_id='ws' GROUP BY moment_id",
            )?;
            let moments = moments
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<_, _>>()?;
            Ok::<_, rusqlite::Error>((heads, moments))
        })
        .unwrap()
}

fn count(store: &EngineStore, sql: &str) -> i64 {
    store
        .read_with(|conn| conn.query_row(sql, [], |row| row.get(0)))
        .unwrap()
}

#[test]
fn a_document_that_joins_the_scope_backfills_below_the_frozen_main_cursor() {
    let (_scratch, path, mut store) = hosted_store_with_main();
    let client = RelaySyncClient::new(hosted_feed());

    // The first response names the scope and applies nothing.
    let learned = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(learned.pending_cursor, None);
    assert!(learned.has_more);
    assert_eq!(client.transport().pull_requests()[0].scope_token, None);
    let state = replica(&store);
    assert_eq!(state.scope_token.as_deref(), Some("scope-1"));
    assert_eq!(state.scope_generation, 1);
    assert_eq!(
        document(&store, "doc-a"),
        Some(HostedDocumentState {
            path: "a.md".to_owned(),
            ready: false,
            backfill_cursor: 0
        })
    );
    assert!(coordinates(&store).is_empty());

    // Its backfill is ready only once committed.
    let backfill = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(
        client.transport().pull_requests()[1].object_id.as_deref(),
        Some("doc-a")
    );
    assert_eq!(backfill.applied, 1);
    assert!(!document(&store, "doc-a").unwrap().ready);
    assert!(commit(&client, &mut store, &backfill));
    assert_eq!(
        document(&store, "doc-a"),
        Some(HostedDocumentState {
            path: "a.md".to_owned(),
            ready: true,
            backfill_cursor: 4
        })
    );
    assert_eq!(replica(&store).main_cursor, 0, "frozen while it backfilled");
    sync(&client, &mut store);
    assert_eq!(replica(&store).main_cursor, 4, "past the rows it withholds");
    assert_eq!(
        coordinates(&store),
        [("owner".to_owned(), 0), ("owner".to_owned(), 1)]
    );

    // doc-b joins after the main cursor passed its row.
    let feed = client.transport();
    for seq in 4..24 {
        feed.create("owner", seq, "private", "private.md", "private");
    }
    feed.share("doc-b", "b.md");
    feed.raw_rows_per_page.store(1, Ordering::SeqCst);
    let stale = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(stale.pending_cursor, None, "a stale scope applies nothing");
    assert_eq!(stale.applied + stale.skipped, 0);
    let state = replica(&store);
    assert_eq!(state.scope_generation, 2);
    assert_eq!(state.main_cursor, 4, "and keeps the cursor");
    assert!(document(&store, "doc-a").unwrap().ready);
    assert!(!document(&store, "doc-b").unwrap().ready);

    // One pass reads sixteen rows of doc-b's backfill, below the main cursor
    // and past it, and stops before the end.
    let partial = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(partial.applied, 1);
    assert!(commit(&client, &mut store, &partial));
    assert_eq!(
        document(&store, "doc-b"),
        Some(HostedDocumentState {
            path: "b.md".to_owned(),
            ready: false,
            backfill_cursor: 16
        })
    );
    assert_eq!(replica(&store).main_cursor, 4);

    // A restart resumes the backfill where it stopped.
    drop(store);
    let mut store = EngineStore::open(&path, 3_000).unwrap();
    let pulled = client.transport().pull_requests().len();
    feed.raw_rows_per_page.store(usize::MAX, Ordering::SeqCst);
    let resumed = pass(&client, &mut store, &NoFaults).unwrap();
    let request = &client.transport().pull_requests()[pulled];
    assert_eq!(
        (request.object_id.as_deref(), request.cursor),
        (Some("doc-b"), 16)
    );
    assert_eq!(
        resumed.applied + resumed.skipped,
        0,
        "nothing applies twice"
    );
    assert!(commit(&client, &mut store, &resumed));
    assert!(document(&store, "doc-b").unwrap().ready);
    assert_eq!(
        replica(&store).main_cursor,
        4,
        "until the backfill committed"
    );

    sync(&client, &mut store);
    let main = client.transport().pull_requests().last().unwrap().clone();
    assert_eq!(main.object_id, None);
    assert_eq!(replica(&store).main_cursor, 24);
    assert_eq!(
        coordinates(&store),
        [
            ("owner".to_owned(), 0),
            ("owner".to_owned(), 1),
            ("owner".to_owned(), 3)
        ]
    );
    let (heads, moments) = content(&store);
    assert_eq!(
        heads,
        BTreeMap::from([
            ("doc-a".to_owned(), "hosted a".to_owned()),
            ("doc-b".to_owned(), "hosted b".to_owned())
        ])
    );
    assert!(moments.values().all(|count| *count == 1));
}

#[test]
fn a_scope_change_mid_pass_drops_what_the_pass_fetched() {
    let (_scratch, _path, mut store) = hosted_store_with_main();
    let client = RelaySyncClient::new(hosted_feed());
    sync(&client, &mut store);
    let feed = client.transport();
    feed.create("owner", 4, "doc-a-sibling", "a2.md", "sibling");
    feed.share("doc-a-sibling", "a2.md");
    sync(&client, &mut store);
    let before = (coordinates(&store), replica(&store).main_cursor);

    feed.create("owner", 5, "doc-a-sibling", "a2.md", "unadmitted");
    feed.create("owner", 6, "private", "private.md", "private");
    feed.raw_rows_per_page.store(1, Ordering::SeqCst);
    // The first page carries a row; the second answers under a new scope.
    let pulled = feed.pull_requests().len();
    *feed.share_at_pull.lock().unwrap() = Some((pulled + 2, "doc-b".to_owned(), "b.md".to_owned()));
    let changed = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(feed.pull_requests().len(), pulled + 2);
    assert_eq!(changed.pending_cursor, None);
    assert_eq!(
        (coordinates(&store), replica(&store).main_cursor),
        before,
        "nothing the old scope served applies"
    );
    assert!(document(&store, "doc-b").is_some_and(|doc| !doc.ready));
}

#[test]
fn a_pass_fetched_under_an_older_scope_cannot_commit() {
    let (_scratch, _path, mut store) = hosted_store_with_main();
    let client = RelaySyncClient::new(hosted_feed());
    pass(&client, &mut store, &NoFaults).unwrap();
    let backfill = pass(&client, &mut store, &NoFaults).unwrap();
    // The pass is not committed before the scope moves.
    client.transport().share("doc-b", "b.md");
    assert_eq!(
        pass(&client, &mut store, &NoFaults).unwrap().pending_cursor,
        None
    );
    assert!(!commit(&client, &mut store, &backfill));
    assert_eq!(
        document(&store, "doc-a"),
        Some(HostedDocumentState {
            path: "a.md".to_owned(),
            ready: false,
            backfill_cursor: 0
        })
    );

    sync(&client, &mut store);
    let main = pass(&client, &mut store, &NoFaults).unwrap();
    let cursor = replica(&store).main_cursor;
    client
        .transport()
        .create("owner", 4, "doc-a", "a.md", "late");
    client.transport().share("doc-c", "c.md");
    pass(&client, &mut store, &NoFaults).unwrap();
    let mut stale = main.pending_cursor.clone().unwrap();
    stale.cursor += 10;
    assert!(!commit(
        &client,
        &mut store,
        &HostedPassOutcome {
            pending_cursor: Some(stale),
            ..main
        }
    ));
    assert_eq!(replica(&store).main_cursor, cursor);
}

type Finished = (
    (BTreeMap<String, String>, BTreeMap<String, i64>),
    Vec<(String, i64)>,
);

/// Sync two hosted documents to the end after one interruption of the first
/// backfill: a pass that fails at `faults`, a commit that crashes, or a
/// caller that stops before materializing and restarts.
fn finish_after(
    faults: Option<&dyn dohc_engine_storage::FaultInjector>,
    interrupt_commit: bool,
    restart: bool,
) -> Finished {
    let (_scratch, path, mut store) = hosted_store_with_main();
    let client = RelaySyncClient::new(hosted_feed());
    client.transport().share("doc-b", "b.md");
    pass(&client, &mut store, &NoFaults).unwrap();
    if let Some(faults) = faults {
        assert!(pass(&client, &mut store, faults).is_err());
    }
    let applied = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(applied.changed_paths.len(), 1);
    if interrupt_commit {
        let pending = applied.pending_cursor.clone().unwrap();
        let crash = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
        assert_eq!(
            client
                .commit_hosted_cursor(&mut store, "ws", &pending, crash.as_ref())
                .unwrap(),
            TxnOutcome::Crashed { committed: false }
        );
    }
    if restart {
        // The pass is fetched again and names the same paths to materialize.
        drop(store);
        store = EngineStore::open(&path, 3_000).unwrap();
        let again = pass(&client, &mut store, &NoFaults).unwrap();
        assert_eq!(again.changed_paths, applied.changed_paths);
        assert_eq!(again.applied, 0);
    }
    sync(&client, &mut store);
    (content(&store), coordinates(&store))
}

#[test]
fn interrupted_hosted_passes_resume_to_the_same_content_once() {
    let clean = finish_after(None, false, false);
    assert_eq!(clean.0.0.len(), 2);
    let hydration = ScriptedFaults::crash_at(FaultPoint::SyncBeforeBlobHydrateCommit);
    let application = ScriptedFaults::crash_at(FaultPoint::SyncBeforeApplyCommit);
    for (name, resumed) in [
        (
            "hydration",
            finish_after(Some(hydration.as_ref()), false, false),
        ),
        (
            "application",
            finish_after(Some(application.as_ref()), false, false),
        ),
        ("materialization", finish_after(None, false, true)),
        ("cursor commit", finish_after(None, true, true)),
    ] {
        assert_eq!(resumed, clean, "{name}");
        assert!(resumed.0.1.values().all(|count| *count == 1), "{name}");
    }
}

/// The slice-2 review's first reproduction: a replica created pristine has
/// no main version, and a backfill never serves the `workspace.init` that
/// creates it.
#[test]
fn a_pristine_hosted_replica_takes_workspace_init_before_its_first_backfill() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(hosted_feed());
    client.transport().share("doc-b", "b.md");
    sync(&client, &mut store);

    let requests = client.transport().pull_requests();
    let initial = |request: &HostedPullRequest| {
        request.object_id.is_none() && request.cursor == 0 && request.limit == 1
    };
    assert!(
        initial(&requests[1]),
        "the first backfill pass opens the main feed"
    );
    assert_eq!(requests[2].object_id.as_deref(), Some("doc-a"));
    assert_eq!(
        requests.iter().filter(|request| initial(request)).count(),
        1,
        "only while the main version is missing"
    );
    let (heads, moments) = content(&store);
    assert_eq!(
        heads,
        BTreeMap::from([
            ("doc-a".to_owned(), "hosted a".to_owned()),
            ("doc-b".to_owned(), "hosted b".to_owned())
        ])
    );
    assert!(moments.values().all(|count| *count == 1));
    assert_eq!(
        coordinates(&store),
        [
            ("owner".to_owned(), 0),
            ("owner".to_owned(), 1),
            ("owner".to_owned(), 3)
        ]
    );
    assert_eq!(replica(&store).main_cursor, 4);
}

/// Hold `texts` locally, as the hydration before retention left them.
fn hydrated(store: &mut EngineStore, texts: &[String]) {
    store
        .write_with(&NoFaults, |tx| {
            for text in texts {
                tx.execute(
                    "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                    params![text_sha(text), text.len() as i64, text],
                )
                .map_err(SyncError::persist)?;
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

/// Retain the feed's rows from relay position `from` on, as a pass that held
/// them behind a live editor did, and commit the main cursor past them. The
/// editor has since closed.
fn retain_behind_closed_editor(
    client: &RelaySyncClient<HostedFeed>,
    store: &mut EngineStore,
    from: usize,
) {
    let held = client.transport().log.lock().unwrap()[from - 1..].to_vec();
    let identity = read_sync_identity(store, "ws").unwrap().unwrap();
    let held_refs = held.iter().collect::<Vec<_>>();
    crate::deferred::retain(store, &identity, &held_refs, &NoFaults).unwrap();
    let end = held.last().and_then(|op| op.relay_seq).unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE hosted_replicas SET main_cursor=?1 WHERE workspace_id='ws'",
                [end],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

/// The slice-2 review's second reproduction: more retained work of one
/// document than one replay reads. Each pass applies the prefix it read.
#[test]
fn retained_work_longer_than_a_replay_page_drains_in_order() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(hosted_feed());
    sync(&client, &mut store);
    let feed = client.transport();
    let mut texts = Vec::new();
    let mut before = ("hosted a".to_owned(), "moment-owner-1".to_owned());
    for seq in 0..501 {
        let text = format!("edit {seq}");
        feed.replace(
            "peer",
            seq,
            "doc-a",
            "a.md",
            &text,
            ("doc-a", &before.0, &before.1),
        );
        before = (text.clone(), format!("moment-peer-{seq}"));
        texts.push(text);
    }
    hydrated(&mut store, &texts);
    retain_behind_closed_editor(&client, &mut store, 5);
    assert_eq!(retained(&store), 501);

    sync(&client, &mut store);
    assert_eq!(retained(&store), 0);
    let (heads, moments) = content(&store);
    assert_eq!(
        heads,
        BTreeMap::from([("doc-a".to_owned(), "edit 500".to_owned())])
    );
    assert_eq!(moments.len(), 502);
    assert!(moments.values().all(|count| *count == 1));
}

/// The slice-2 review's third reproduction: a full replay page of a document
/// that left the scope came first, and the hosted document's work behind it
/// never replayed.
#[test]
fn retained_work_of_a_removed_document_leaves_a_hosted_one_free() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(hosted_feed());
    let feed = client.transport();
    feed.share("gone", "gone.md");
    sync(&client, &mut store);
    for seq in 100..600 {
        feed.append(document_op(seq, 1, "gone"));
    }
    feed.replace(
        "peer",
        0,
        "doc-a",
        "a.md",
        "kept",
        ("doc-a", "hosted a", "moment-owner-1"),
    );
    hydrated(&mut store, &["kept".to_owned()]);
    retain_behind_closed_editor(&client, &mut store, 5);
    feed.unshare("gone");

    sync(&client, &mut store);
    assert_eq!(
        content(&store).0,
        BTreeMap::from([("doc-a".to_owned(), "kept".to_owned())])
    );
    assert_eq!(
        retained(&store),
        500,
        "the removed document's work waits for its removal"
    );
}

/// Documents take turns at the replay page, so one whose work stays held
/// cannot starve another's.
#[test]
fn hosted_replay_takes_turns_by_document() {
    let (_scratch, _path, mut store) = hosted_store();
    host_document(&mut store, "doc-a");
    host_document(&mut store, "doc-b");
    let identity = read_sync_identity(&store, "ws").unwrap().unwrap();
    let mut held = (0..500)
        .map(|seq| document_op(seq, seq + 1, "doc-a"))
        .collect::<Vec<_>>();
    held.push(document_op(500, 501, "doc-b"));
    held.push(document_op(501, 502, "doc-a"));
    crate::deferred::retain(
        &mut store,
        &identity,
        &held.iter().collect::<Vec<_>>(),
        &NoFaults,
    )
    .unwrap();

    let first = crate::deferred::read_hosted(&store, "ws", &identity).unwrap();
    assert_eq!(first.ops, held[..500]);
    assert_eq!(
        first.documents,
        BTreeMap::from([
            ("doc-a".to_owned(), Some(502)),
            ("doc-b".to_owned(), Some(501))
        ]),
        "each holds from the first op the page left out"
    );
    let mut report = None;
    crate::deferred::claim_report(&mut store, "ws", &first.ops, &[], &mut report, &NoFaults)
        .unwrap();
    let second = crate::deferred::read_hosted(&store, "ws", &identity).unwrap();
    assert!(second.ops.contains(&held[500]), "doc-b's turn comes next");
    assert_eq!(second.ops.len(), 500);
    assert_eq!(
        second.documents,
        BTreeMap::from([("doc-a".to_owned(), Some(500)), ("doc-b".to_owned(), None)])
    );
}

/// One scope token names one set of documents at their paths: a response
/// that keeps the token but moves a document is not the scope this replica
/// adopted.
#[test]
fn a_scope_token_names_its_documents_paths() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(hosted_feed());
    sync(&client, &mut store);
    let feed = client.transport();
    feed.shared
        .lock()
        .unwrap()
        .insert("doc-a".to_owned(), "moved.md".to_owned());
    assert!(matches!(
        pass(&client, &mut store, &NoFaults),
        Err(RelayError::InvalidResponse)
    ));

    feed.share("doc-a", "moved.md");
    sync(&client, &mut store);
    assert_eq!(document(&store, "doc-a").unwrap().path, "moved.md");
}

/// A conflict child of `hosted-object` whose `conflict.resolve` parent the
/// feed withholds, with the resolved text already local.
fn withheld_conflict(
    store: &mut EngineStore,
) -> (ReplicationEnvelope, ReplicationEnvelope, String) {
    use crate::conflict_resolve_v1::{
        ConflictResolveV1, EffectContextV1, EffectKindV1, EffectV1, HeadContentKindV1, HeadV1,
        MetadataV1, PresentHeadV1, ResolutionV1, ResolveChoiceV1, build_conflict_resolve_v1,
    };

    let result_text = "resolved by the owner";
    let result_sha = dohc_engine_storage::hex_sha256(result_text.as_bytes());
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![result_sha, result_text.len() as i64, result_text],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let result = HeadV1::Present(PresentHeadV1 {
        path_ref: 0,
        object_id: "hosted-object".to_owned(),
        latest_moment_id: "owner-moment".to_owned(),
        content_kind: HeadContentKindV1::Text,
        blob_sha256: result_sha.clone(),
        byte_length: result_text.len() as i64,
        updated_at_ms: 21,
    });
    let built = build_conflict_resolve_v1(ConflictResolveV1 {
        workspace_id: "ws".to_owned(),
        conflict_id: "owner-conflict".to_owned(),
        chosen_from: ResolveChoiceV1::Incoming,
        resolution: ResolutionV1::AppliedIncoming,
        target_version_id: "main".to_owned(),
        source_version_id: "peer".to_owned(),
        paths: vec!["hosted.md".to_owned()],
        current: HeadV1::Absent { path_ref: 0 },
        incoming: result.clone(),
        result,
        effect_context: EffectContextV1 {
            recorded_at_ms: 21,
            metadata: MetadataV1 {
                origin: "sync".to_owned(),
                summary: None,
                correlation_id: None,
            },
            author: None,
            current_object_created_at_ms: None,
            result_object_created_at_ms: Some(20),
        },
        effects: vec![EffectV1 {
            kind: EffectKindV1::Write,
            moment_id: "owner-moment".to_owned(),
            payload_sha256: String::new(),
        }],
        lineage_transition: None,
        exported_before: None,
    })
    .unwrap();
    let mut parent = envelope("owner", 0, "conflict.resolve", built.value.clone());
    parent.recorded_at_ms = 21;
    let mut child = envelope(
        "owner",
        1,
        "moment.append",
        built.validated.shadows[0].clone(),
    );
    child.recorded_at_ms = 21;
    (parent, child, result_sha)
}

#[test]
fn a_held_op_holds_later_ops_of_its_document_but_not_of_its_origin() {
    let (_scratch, _path, mut store) = hosted_store_with_main();
    let (parent, child, result_sha) = withheld_conflict(&mut store);
    assert!(matches!(
        apply_replication_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &child,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::RetryableState {
            reason: crate::hosted::CONFLICT_PARENT_WITHHELD
        })
    ));

    let feed = HostedFeed::new();
    feed.append(envelope("owner", 2, "workspace.init", json!({})));
    feed.share("hosted-object", "hosted.md");
    feed.share("other-object", "other.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);

    // The child waits for its parent; a later edit of its document waits
    // behind it, though an edit of another document from the same origin does not.
    let later_text = "edited after the resolution";
    let later_sha = dohc_engine_storage::hex_sha256(later_text.as_bytes());
    let feed = client.transport();
    feed.blobs
        .lock()
        .unwrap()
        .insert(later_sha.clone(), later_text.as_bytes().to_vec());
    feed.append(child);
    feed.append(envelope(
        "peer",
        0,
        "moment.append",
        json!({
            "momentId": "peer-edit",
            "versionId": "main",
            "objectId": "hosted-object",
            "objectCreatedAtMs": 20,
            "path": "hosted.md",
            "recordedAtMs": 2_000,
            "operation": "write",
            "payloadBeforeBlobSha256": result_sha,
            "payloadBeforePath": "hosted.md",
            "payloadAfterBlobSha256": later_sha,
            "payloadAfterPath": "hosted.md",
            "metadata": {"origin": "sync"},
            "beforePresent": "present",
            "beforeObjectId": "hosted-object",
            "beforeVersionId": "main",
            "beforePath": "hosted.md",
            "beforeBlobSha256": result_sha,
            "beforeUpdatedAtMs": 21,
            "beforeLatestMomentId": "owner-moment",
            "beforeMetadata": {"origin": "sync"}
        }),
    ));
    feed.create("peer", 1, "other-object", "other.md", "independent");
    let held = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(held.applied, 1);
    assert!(commit(&client, &mut store, &held));
    assert_eq!(retained(&store), 2, "both edits of the held document wait");
    assert_eq!(
        coordinates(&store),
        [("owner".to_owned(), 2), ("peer".to_owned(), 1)]
    );

    // The parent arrives (5b projects it); the held document resumes in order.
    apply_replication_envelope(
        &mut store,
        &mut WriterDocCache::new(),
        &parent,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    sync(&client, &mut store);
    assert_eq!(retained(&store), 0);
    assert_eq!(
        coordinates(&store),
        [
            ("owner".to_owned(), 0),
            ("owner".to_owned(), 1),
            ("owner".to_owned(), 2),
            ("peer".to_owned(), 0),
            ("peer".to_owned(), 1)
        ]
    );
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' AND moment_id='owner-moment'"
        ),
        1,
        "the resolution applies once, through its parent"
    );
}

#[test]
fn live_writes_journal_and_push_under_the_service_host_origin() {
    let (_scratch, _path, mut store) = hosted_store_with_main();
    host_document(&mut store, "doc-a");
    assert!(
        store
            .read_with(|conn| workspace_replicates_with_relay(conn, "ws"))
            .unwrap(),
        "a hosted replica replicates before any cursor or push"
    );
    let key = dohc_engine_collab::DocKey::new("ws", "main", "doc-a").unwrap();
    let journaled = store
        .write_with(&NoFaults, |tx| {
            let mut written = Vec::new();
            for update in [b"update one".as_slice(), b"update two"] {
                let sha =
                    dohc_engine_storage::put_binary_blob(tx, update).map_err(SyncError::Storage)?;
                written.push(journal_local_op_in_tx(
                    tx,
                    "ws",
                    "ydoc.update",
                    &ydoc_update_payload(
                        &key,
                        "a.md",
                        dohc_engine_collab::ContentKind::Richdoc,
                        &sha,
                        &"0".repeat(64),
                        None,
                        None,
                        false,
                    ),
                    3_000,
                )?);
            }
            Ok::<_, SyncError>(written)
        })
        .unwrap();
    assert_eq!(journaled, TxnOutcome::Committed(vec![0, 1]));
    assert_eq!(
        coordinates(&store),
        [(HOST.to_owned(), 0), (HOST.to_owned(), 1)]
    );

    let client = RelaySyncClient::new(HostedFeed::new());
    let outcome = client
        .push_workspace(&mut store, "ws", &NoFaults, &NoLiveLeases, 3_000, 1_000_000)
        .unwrap();
    assert!(matches!(
        outcome,
        SyncPassOutcome::Complete { pushed: 2, .. }
    ));
    let pushes = client.transport().pushes.lock().unwrap().clone();
    assert_eq!(pushes.len(), 1, "one batch to the hosted log, and no probe");
    assert_eq!(pushes[0].origin_id, HOST);
    assert_eq!(read_pushed_seq(&store, "ws", HOST).unwrap(), 1);
}

#[test]
fn ordinary_only_machinery_stays_off_a_hosted_replica() {
    let (_scratch, _path, mut store) = hosted_store_with_main();
    // A local file no live session wrote: an ordinary enrolment would journal it.
    VersionedTextStore::new(&mut store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: "local-object".to_owned(),
                path: "local.md".to_owned(),
                text: "written on the host".to_owned(),
                moment_id: "local-moment".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2_000,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    let client = RelaySyncClient::new(hosted_feed());
    sync(&client, &mut store);
    assert!(matches!(
        client
            .push_workspace(&mut store, "ws", &NoFaults, &NoLiveLeases, 3_000, 1_000_000)
            .unwrap(),
        SyncPassOutcome::Complete { pushed: 0, .. }
    ));
    assert!(client.transport().pushes.lock().unwrap().is_empty());
    assert_eq!(
        coordinates(&store),
        [("owner".to_owned(), 0), ("owner".to_owned(), 1)],
        "no enrolment journals the host's own files"
    );
    for (table, rows) in [
        (
            "sync_relay_push_state",
            "no push state for the owner's origin",
        ),
        ("sync_relay_cursors", "no ordinary cursor"),
    ] {
        assert_eq!(
            count(&store, &format!("SELECT COUNT(*) FROM {table}")),
            0,
            "{rows}"
        );
    }

    assert!(
        client
            .recover_origin(&mut store, "ws", "service-host:rebased", &NoFaults)
            .is_err(),
        "a hosted origin is never rebased"
    );
    assert_eq!(
        read_sync_identity(&store, "ws").unwrap().unwrap().origin_id,
        HOST
    );
    assert!(
        client
            .pull_chat_workspace(
                &mut store,
                &mut WriterDocCache::new(),
                "ws",
                &NoFaults,
                &NoLiveLeases,
                3_000
            )
            .is_err()
    );
    let ordinary = RelayCursor {
        cursor: 4,
        replication_epoch: "epoch-1".to_owned(),
        stream_identity: "stream-1".to_owned(),
        bootstrap_complete: true,
        settlement_report_id: None,
    };
    assert!(
        client
            .commit_pull_cursor(&mut store, "ws", &ordinary, &NoFaults, &NoLiveLeases, 3_000)
            .is_err()
    );
    assert_eq!(count(&store, "SELECT COUNT(*) FROM sync_relay_cursors"), 0);
}

fn text_sha(text: &str) -> String {
    dohc_engine_storage::hex_sha256(text.as_bytes())
}

/// A moment's stored before side: presence, text digest, object, and the
/// payload-before digest.
type StoredBefore = (i64, Option<String>, Option<String>, Option<String>);

fn stored_before(store: &EngineStore, moment_id: &str) -> StoredBefore {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT before_present,before_blob_sha256,before_object_id, \
                 payload_before_blob_sha256 FROM moments \
                 WHERE workspace_id='ws' AND moment_id=?1",
                [moment_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
        })
        .unwrap()
}

fn withheld_befores(store: &EngineStore) -> Vec<(String, String, String, String, String)> {
    store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT moment_id,before_object_id,before_path,before_sha256,before_content_kind \
                 FROM hosted_withheld_befores WHERE workspace_id='ws' ORDER BY moment_id",
            )?;
            statement
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap()
}

/// The owner's private file held `a.md` until the hosted document replaced
/// it. The feed serves that moment but withholds the private file's row and
/// bytes, so on the host the private file never existed.
#[test]
fn a_moment_that_replaced_a_withheld_object_applies_as_a_create() {
    let (_scratch, _path, mut store) = hosted_store_with_main();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "private", "a.md", "private text");
    feed.replace(
        "owner",
        2,
        "doc-a",
        "a.md",
        "hosted text",
        ("private", "private text", "moment-owner-1"),
    );
    feed.blobs.lock().unwrap().remove(&text_sha("private text"));
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);

    let (heads, moments) = content(&store);
    assert_eq!(
        heads,
        BTreeMap::from([("doc-a".to_owned(), "hosted text".to_owned())])
    );
    assert_eq!(moments, BTreeMap::from([("moment-owner-2".to_owned(), 1)]));
    let downloaded = client.transport().downloaded();
    assert!(downloaded.contains(&text_sha("hosted text")));
    assert!(
        !downloaded.contains(&text_sha("private text")),
        "the withheld before-image is never requested"
    );
    assert_eq!(
        stored_before(&store, "moment-owner-2"),
        (1, None, None, None),
        "the host's history records a create"
    );
    let history = VersionedTextStore::new(&mut store)
        .list_moments(&dohc_engine_domain::ListMomentsQuery {
            workspace_id: "ws".to_owned(),
            version_id: Some("main".to_owned()),
            object_id: Some("doc-a".to_owned()),
            limit: 10,
            before_moment_order: None,
        })
        .unwrap();
    assert_eq!(history.moments.len(), 1);
    assert!(!history.moments[0].before_present);
    assert_eq!(history.moments[0].before_blob_sha256, None);
    assert_eq!(
        withheld_befores(&store),
        [(
            "moment-owner-2".to_owned(),
            "private".to_owned(),
            "a.md".to_owned(),
            text_sha("private text"),
            "text".to_owned()
        )]
    );
    assert_eq!(
        coordinates(&store),
        [("owner".to_owned(), 0), ("owner".to_owned(), 2)],
        "the journal keeps the row as sent"
    );

    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM moments WHERE workspace_id='ws' AND moment_id='moment-owner-2'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    assert!(
        withheld_befores(&store).is_empty(),
        "it leaves with its moment"
    );
}

/// A before side the feed serves is fetched and kept: the document's own
/// earlier content, or another document the replica hosts. An ordinary
/// replica fetches every before side.
#[test]
fn a_before_side_the_feed_serves_is_fetched_and_kept() {
    let (_scratch, _path, mut store) = hosted_store_with_main();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-a", "a.md", "first");
    feed.replace(
        "owner",
        2,
        "doc-a",
        "a.md",
        "second",
        ("doc-a", "first", "moment-owner-1"),
    );
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    assert_eq!(
        stored_before(&store, "moment-owner-2"),
        (
            2,
            Some(text_sha("first")),
            Some("doc-a".to_owned()),
            Some(text_sha("first"))
        )
    );
    assert_eq!(
        content(&store).0,
        BTreeMap::from([("doc-a".to_owned(), "second".to_owned())])
    );
    assert!(withheld_befores(&store).is_empty());

    // Which before sides a pass would request, before any is local.
    let foreign = |before_object_id: &str| {
        let feed = HostedFeed::new();
        feed.replace(
            "owner",
            3,
            "doc-a",
            "a.md",
            "third",
            (before_object_id, "replaced", "moment-owner-2"),
        );
        feed.log.lock().unwrap().remove(0)
    };
    let requested = |store: &EngineStore, op: &ReplicationEnvelope| {
        crate::relay::blob_refs_to_apply(store, std::slice::from_ref(op))
            .unwrap()
            .contains_key(&text_sha("replaced"))
    };
    host_document(&mut store, "doc-b");
    assert!(requested(&store, &foreign("doc-b")), "a hosted document");
    assert!(!requested(&store, &foreign("private")), "a withheld object");

    let (_ordinary_scratch, _ordinary_path, mut ordinary) = open_store();
    seed_identity(&mut ordinary);
    assert!(
        requested(&ordinary, &foreign("private")),
        "an ordinary replica"
    );
    assert!(
        ordinary
            .read_with(|conn| crate::hosted::withheld_before(conn, &foreign("private")))
            .unwrap()
            .is_none()
    );
}
