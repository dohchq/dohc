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

#[test]
fn hosted_deferred_work_replays_by_coordinate_membership() {
    let mutations = Cell::new(0);
    let (_scratch, _path, mut store) = hosted_store();
    let identity = read_sync_identity(&store, "ws").unwrap().unwrap();
    let (early, late) = (op(3, "early"), op(7, "late"));
    crate::deferred::retain(&mut store, &identity, &[&early, &late], &NoFaults).unwrap();
    let held = |store: &EngineStore| crate::deferred::read(store, "ws", &identity).unwrap().1;
    assert_eq!(held(&store), BTreeSet::from(["owner".to_owned()]));

    admit(&mut store, &early, &mutations).unwrap();
    assert!(
        crate::deferred::has_unapplied(&store, "ws").unwrap(),
        "the later coordinate still waits"
    );
    admit(&mut store, &late, &mutations).unwrap();
    assert!(!crate::deferred::has_unapplied(&store, "ws").unwrap());
    assert!(held(&store).is_empty());
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "owner").unwrap(),
        -1
    );
}

#[test]
fn hosted_outbound_sequences_survive_purged_journal_rows_and_reopen() {
    let (_scratch, path, mut store) = hosted_store();
    let journal = |store: &mut EngineStore| match journal_local_replication_op(
        store,
        "ws",
        HOST,
        "epoch-1",
        "stream-1",
        "probe.local",
        &json!({}),
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
            journal_local_op_in_tx(tx, "ws", "probe.local", &json!({}), 2_000)
        })
        .unwrap()
    else {
        panic!("no fault was injected");
    };
    written.push(in_tx);
    assert_eq!(written, [0, 1, 2, 3]);
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

    fn pull_requests(&self) -> Vec<HostedPullRequest> {
        self.pulls.lock().unwrap().clone()
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
    replica(store).documents.get(object_id).copied()
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
