use super::*;
use dohc_engine_collab::live_update_application::ReleasedTails;
use dohc_engine_collab::live_update_application::owner_activations::ACTIVATE_ADOPTION;
use std::cell::Cell;
use std::sync::atomic::{AtomicBool, AtomicI64};

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

/// A hosted replica refuses every write to work it already holds, so a
/// local-only workspace with work in it must not become one. Neither has a
/// sync identity, so only the work refuses it.
#[test]
fn only_a_workspace_without_work_becomes_a_hosted_replica() {
    let with_file: fn(&mut EngineStore) = |store| {
        let mut files = VersionedTextStore::new(store);
        files
            .ensure_main_version("ws", "main", 1, &NoFaults)
            .unwrap();
        files
            .write_text(
                &dohc_engine_domain::WriteText {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "local-object".to_owned(),
                    path: "notes.md".to_owned(),
                    text: "local work".to_owned(),
                    moment_id: "local-moment".to_owned(),
                    metadata_origin: "user".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 10,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
    };
    let with_chat: fn(&mut EngineStore) = |store| {
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO chat_channels \
                     (workspace_id,channel_id,name,slug,kind,created_at_ms,updated_at_ms) \
                     VALUES ('ws','channel','Channel','channel','channel',1,1)",
                    [],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .unwrap();
    };
    for seed in [with_file, with_chat] {
        let (_scratch, _path, mut store) = open_store();
        seed(&mut store);
        assert!(read_sync_identity(&store, "ws").unwrap().is_none());
        assert!(matches!(
            create_hosted_replica(&mut store, "ws", HOST, "epoch-1", "stream-1", 1, &NoFaults),
            Err(SyncError::InvalidInput {
                reason: crate::HOSTED_REPLICA_NOT_PRISTINE
            })
        ));
        assert!(!is_hosted_replica(&store, "ws").unwrap());
        assert!(read_sync_identity(&store, "ws").unwrap().is_none());
    }
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

fn recorded_feeds(store: &EngineStore) -> Vec<(String, i64, String, Option<String>)> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT 'relay',origin_seq,ingress_kind,relay_namespace FROM relay_deferred_ops \
                 UNION ALL SELECT 'ydoc:'||COALESCE(replication_epoch,'-')||'/'||COALESCE(stream_identity,'-'), \
                   origin_seq,ingress_kind,relay_namespace FROM ydoc_deferred_updates ORDER BY 1,2",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
            .collect::<Result<Vec<_>, _>>()
        })
        .unwrap()
}

fn defer_update(
    store: &mut EngineStore,
    seq: i64,
    relay_seq: i64,
    namespace: Option<&str>,
) -> Result<(), SyncError> {
    let key = dohc_engine_collab::DocKey {
        workspace_id: "ws".to_owned(),
        version_id: "main".to_owned(),
        object_id: "doc".to_owned(),
    };
    let op = envelope("owner", seq, "ydoc.update", json!({ "objectId": "doc" }));
    match store.write_with(&NoFaults, |tx| {
        tx.execute_batch(
            "INSERT OR IGNORE INTO versioned_workspaces (workspace_id,main_version_id) \
             VALUES ('ws','main'); \
             INSERT OR IGNORE INTO file_objects (workspace_id,object_id,created_at_ms) \
             VALUES ('ws','doc',0);",
        )
        .map_err(SyncError::persist)?;
        crate::ydoc_apply::defer_ydoc_update_in_tx(
            tx,
            &key,
            &op,
            &"a".repeat(64),
            relay_seq,
            namespace,
        )
    })? {
        TxnOutcome::Committed(()) => Ok(()),
        TxnOutcome::Crashed { .. } => panic!("no fault was injected"),
    }
}

#[test]
fn hosted_deferrals_keep_the_feed_they_arrived_on() {
    let (_scratch, path, mut store) = hosted_store();
    host_document(&mut store, "doc-a");
    let identity = read_sync_identity(&store, "ws").unwrap().unwrap();
    let first = document_op(3, 1, "doc-a");
    assert!(
        matches!(
            crate::deferred::retain(&mut store, &identity, None, &[&first], &NoFaults),
            Err(RelayError::Local(reason)) if reason.contains(crate::ydoc_apply::HOSTED_DEFERRAL_UNNAMED)
        ),
        "work no trusted namespace names is not retained"
    );
    assert!(matches!(
        defer_update(&mut store, 1, 5, None),
        Err(SyncError::RetryableState {
            reason: crate::ydoc_apply::HOSTED_DEFERRAL_UNNAMED
        })
    ));
    assert!(matches!(
        defer_update(&mut store, 1, 0, Some("relay")),
        Err(SyncError::RetryableState {
            reason: crate::ydoc_apply::HOSTED_DEFERRAL_UNNAMED
        })
    ));
    assert!(recorded_feeds(&store).is_empty(), "nothing was retained");

    crate::deferred::retain(&mut store, &identity, Some("relay"), &[&first], &NoFaults).unwrap();
    defer_update(&mut store, 1, 5, Some("relay")).unwrap();
    let recorded = vec![
        (
            "relay".to_owned(),
            3,
            "hosted".to_owned(),
            Some("relay".to_owned()),
        ),
        (
            "ydoc:epoch-1/stream-1".to_owned(),
            1,
            "hosted".to_owned(),
            Some("relay".to_owned()),
        ),
    ];
    assert_eq!(recorded_feeds(&store), recorded);
    assert_eq!(
        crate::deferred::retained_namespace(&store, &first).unwrap(),
        Some(Some("relay".to_owned()))
    );

    crate::deferred::retain(
        &mut store,
        &identity,
        Some("elsewhere"),
        &[&first],
        &NoFaults,
    )
    .unwrap();
    defer_update(&mut store, 1, 5, Some("elsewhere")).unwrap();
    assert_eq!(
        recorded_feeds(&store),
        recorded,
        "queued work keeps its feed"
    );

    drop(store);
    let store = EngineStore::open(&path, 2_000).unwrap();
    assert_eq!(recorded_feeds(&store), recorded);
    assert_eq!(
        crate::deferred::retained_namespace(&store, &first).unwrap(),
        Some(Some("relay".to_owned())),
        "a replay after restart decides under the feed the op arrived on"
    );
}

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

/// Chat on a hosted replica would allocate from the journal's maximum while
/// the sync journal allocates from the counter, so the next sync append
/// would collide with a chat coordinate.
#[test]
fn a_hosted_replica_writes_no_chat_and_its_journal_keeps_one_counter() {
    let (_scratch, path, mut store) = hosted_store();
    host_document(&mut store, "doc-a");
    {
        let mut chats = LinkedChatStore::new(&mut store);
        for refused in [
            chats.ensure_general_channel("ws", "general-local", 2_000, &NoFaults),
            chats.ensure_agent_channel(
                "ws",
                "agent-local",
                "default",
                "My agent",
                2_000,
                &NoFaults,
            ),
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

struct ShareBeforePullResponse {
    pull_count: usize,
    object_id: String,
    path: String,
}

/// The relay's scoped feed, in memory. It serves `workspace.init` and the
/// rows of shared documents with their original coordinates, withholds every
/// other row, and examines `raw_rows_per_page` rows per page as the relay
/// bounds its scan, so its cursor passes withheld rows. Under a stale scope
/// token it serves nothing and keeps the cursor. It reads above
/// `epoch_log_floor`, as the relay does after an epoch rotation.
struct HostedFeed {
    log: Mutex<Vec<ReplicationEnvelope>>,
    epoch_log_floor: AtomicI64,
    shared: Mutex<BTreeMap<String, String>>,
    revision: AtomicUsize,
    blobs: Mutex<BTreeMap<String, Vec<u8>>>,
    raw_rows_per_page: AtomicUsize,
    share_before_pull_response: Mutex<Option<ShareBeforePullResponse>>,
    pulls: Mutex<Vec<HostedPullRequest>>,
    pushes: Mutex<Vec<PushRequest>>,
    /// Documents whose new host ops the relay refuses, each kept as a refusal at its coordinate.
    refusing: Mutex<BTreeSet<String>>,
    /// Corrupts each push response after the relay recorded the batch.
    garble: Mutex<Option<fn(&mut PushResponse)>>,
    /// Loses the reply to the next push after the relay recorded its batch.
    lose_push_reply: AtomicBool,
    downloads: Mutex<Vec<String>>,
}

impl HostedFeed {
    fn new() -> Self {
        Self {
            log: Mutex::new(Vec::new()),
            epoch_log_floor: AtomicI64::new(0),
            shared: Mutex::new(BTreeMap::new()),
            revision: AtomicUsize::new(0),
            blobs: Mutex::new(BTreeMap::new()),
            raw_rows_per_page: AtomicUsize::new(usize::MAX),
            share_before_pull_response: Mutex::new(None),
            pulls: Mutex::new(Vec::new()),
            pushes: Mutex::new(Vec::new()),
            refusing: Mutex::new(BTreeSet::new()),
            garble: Mutex::new(None),
            lose_push_reply: AtomicBool::new(false),
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

    #[allow(clippy::too_many_arguments)]
    fn rename(
        &self,
        origin: &str,
        seq: i64,
        object_id: &str,
        from: &str,
        to: &str,
        text: &str,
        before_moment_id: &str,
    ) {
        let sha = dohc_engine_storage::hex_sha256(text.as_bytes());
        self.append(envelope(
            origin,
            seq,
            "moment.append",
            json!({
                "momentId": format!("moment-{origin}-{seq}"),
                "versionId": "main",
                "objectId": object_id,
                "objectCreatedAtMs": 1,
                "path": to,
                "recordedAtMs": 2_000,
                "operation": "rename",
                "payloadBeforeBlobSha256": sha,
                "payloadBeforePath": from,
                "payloadAfterBlobSha256": sha,
                "payloadAfterPath": to,
                "metadata": {"origin": "sync"},
                "beforePresent": "present",
                "beforeObjectId": object_id,
                "beforeVersionId": "main",
                "beforePath": from,
                "beforeBlobSha256": sha,
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
            let mut share_at = self.share_before_pull_response.lock().unwrap();
            if share_at
                .as_ref()
                .is_some_and(|share| share.pull_count == count)
            {
                share_at.take()
            } else {
                None
            }
        };
        if let Some(share) = due {
            self.share(&share.object_id, &share.path);
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
        let since = req.cursor.max(self.epoch_log_floor.load(Ordering::SeqCst));
        let log = self.log.lock().unwrap();
        let rows = log
            .iter()
            .filter(|row| row.relay_seq.unwrap() > since)
            .collect::<Vec<_>>();
        let raw = self.raw_rows_per_page.load(Ordering::SeqCst);
        let (mut ops, mut scanned, mut next_cursor) = (Vec::new(), 0, since);
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
            next_cursor: if next_cursor == since {
                req.cursor
            } else {
                next_cursor
            },
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
        let mut hosted_refusals = Vec::new();
        for op in req.ops {
            let present = self
                .log
                .lock()
                .unwrap()
                .iter()
                .find(|row| row.origin_id == op.origin_id && row.origin_seq == op.origin_seq)
                .map(|row| row.op_kind.clone());
            // A retried coordinate keeps its first decision.
            let refused = match present {
                Some(kind) => kind == "relay.refused",
                None => {
                    let refused = crate::hosted::hosted_document(&op)
                        .is_some_and(|object_id| self.refusing.lock().unwrap().contains(object_id));
                    let mut row = op.clone();
                    if refused {
                        row.op_kind = "relay.refused".to_owned();
                        row.payload =
                            json!({"opKind": op.op_kind, "reason": "outside-hosted-documents"});
                    }
                    self.append(row);
                    inserted += 1;
                    refused
                }
            };
            if refused {
                hosted_refusals.push(HostedPushRefusal {
                    origin_id: op.origin_id,
                    origin_seq: op.origin_seq,
                    op_kind: op.op_kind,
                    reason: "outside-hosted-documents".to_owned(),
                });
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
        let mut response = PushResponse {
            registered_references: Vec::new(),
            settlement_refusals: Vec::new(),
            hosted_refusals,
            redundant_recoveries: Vec::new(),
            accepted,
            inserted,
            skipped: accepted - inserted,
            current_max_origin_seq,
        };
        if let Some(garble) = *self.garble.lock().unwrap() {
            garble(&mut response);
        }
        if self.lose_push_reply.swap(false, Ordering::SeqCst) {
            return Err(RelayError::WorkspaceUnavailable);
        }
        Ok(response)
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

fn hosted_feed() -> HostedFeed {
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-a", "a.md", "hosted a");
    feed.create("owner", 2, "private", "private.md", "private");
    feed.create("owner", 3, "doc-b", "b.md", "hosted b");
    feed.share("doc-a", "a.md");
    feed
}

fn pass(
    client: &RelaySyncClient<HostedFeed>,
    store: &mut EngineStore,
    faults: &dyn dohc_engine_storage::FaultInjector,
) -> Result<HostedPassOutcome, RelayError> {
    // As the actor's relay coordinator runs it: each released-tail
    // validation the pass waits for completes, and the pass goes on.
    let mut cache = WriterDocCache::new();
    loop {
        match client.pull_hosted_workspace(store, &mut cache, "ws", "relay", faults, &NoLiveLeases)
        {
            Err(RelayError::ValidationPending(pending)) => {
                pending.validate().wait().unwrap();
            }
            pass => return pass,
        }
    }
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
        .commit_hosted_cursor(store, "ws", pending, &ReleasedTails::uncached(), &NoFaults)
        .unwrap()
    {
        TxnOutcome::Committed(commit) => commit.committed,
        TxnOutcome::Crashed { .. } => panic!("no fault was injected"),
    }
}

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

/// Park every departed document that can park, and forget each retired file
/// as the runtime does once the file is gone. Answers whether one parked or
/// a path came free.
fn park(store: &mut EngineStore) -> bool {
    let mut parked = false;
    for document in departed_hosted_documents(store, "ws").unwrap() {
        parked |= park_hosted_document(store, "ws", &document.object_id, "main", &NoFaults)
            .unwrap()
            == TxnOutcome::Committed(true);
    }
    for file in retired_hosted_files(store, "ws").unwrap() {
        forget_retired_hosted_file(store, "ws", &file.path, &NoFaults).unwrap();
        parked = true;
    }
    parked
}

/// [`sync`], parking where the runtime does: after a pass that adopted a
/// scope, and after each commit. Parking leaves more to pull.
fn sync_parking(client: &RelaySyncClient<HostedFeed>, store: &mut EngineStore) {
    for _ in 0..64 {
        let outcome = pass(client, store, &NoFaults).unwrap();
        commit(client, store, &outcome);
        if !park(store) && !outcome.has_more {
            return;
        }
    }
    panic!("the hosted replica did not catch up");
}

fn is_parked(store: &EngineStore, object_id: &str) -> bool {
    count(
        store,
        &format!(
            "SELECT EXISTS(SELECT 1 FROM hosted_documents WHERE object_id='{object_id}' \
               AND state='parked') \
             AND EXISTS(SELECT 1 FROM hosted_parked_snapshots WHERE object_id='{object_id}') \
             AND NOT EXISTS(SELECT 1 FROM snapshots WHERE object_id='{object_id}') \
             AND NOT EXISTS(SELECT 1 FROM path_aliases WHERE object_id='{object_id}')"
        ),
    ) == 1
}

/// The tables with an `object_id` column that still hold a row of
/// `object_id`, so a table added later is checked too.
fn holding(store: &EngineStore, object_id: &str) -> Vec<String> {
    store
        .read_with(|conn| {
            let tables = conn
                .prepare(
                    "SELECT name FROM sqlite_schema s WHERE type='table' \
                     AND EXISTS(SELECT 1 FROM pragma_table_info(s.name) WHERE name='object_id')",
                )?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let mut holding = Vec::new();
            for table in tables {
                let rows: i64 = conn.query_row(
                    &format!("SELECT COUNT(*) FROM \"{table}\" WHERE object_id=?1"),
                    [object_id],
                    |row| row.get(0),
                )?;
                if rows > 0 {
                    holding.push(table);
                }
            }
            Ok::<_, rusqlite::Error>(holding)
        })
        .unwrap()
}

fn has_blob(store: &EngineStore, sha256: &str) -> bool {
    count(
        store,
        &format!(
            "SELECT EXISTS(SELECT 1 FROM blobs WHERE sha256='{sha256}') \
             OR EXISTS(SELECT 1 FROM binary_blobs WHERE sha256='{sha256}')"
        ),
    ) == 1
}

fn replica(store: &EngineStore) -> HostedReplicaState {
    read_hosted_replica(store, "ws").unwrap().unwrap()
}

fn document(store: &EngineStore, object_id: &str) -> Option<HostedDocumentState> {
    replica(store).documents.get(object_id).cloned()
}

fn ready(store: &EngineStore, object_id: &str) -> bool {
    document(store, object_id).unwrap().status == HostedDocumentStatus::Ready
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
    let (_scratch, path, mut store) = hosted_store();
    let client = RelaySyncClient::new(hosted_feed());

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
            status: HostedDocumentStatus::Backfilling,
            backfill_cursor: 0
        })
    );
    assert!(coordinates(&store).is_empty());

    let backfill = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(
        client.transport().pull_requests()[1].object_id.as_deref(),
        Some("doc-a")
    );
    assert_eq!(backfill.applied, 1);
    assert!(!ready(&store, "doc-a"));
    assert!(commit(&client, &mut store, &backfill));
    assert_eq!(
        document(&store, "doc-a"),
        Some(HostedDocumentState {
            path: "a.md".to_owned(),
            status: HostedDocumentStatus::Ready,
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
    assert!(ready(&store, "doc-a"));
    assert!(!ready(&store, "doc-b"));

    // One pass reads sixteen rows of doc-b's backfill, below the main cursor
    // and past it, and stops before the end.
    let partial = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(partial.applied, 1);
    assert!(commit(&client, &mut store, &partial));
    assert_eq!(
        document(&store, "doc-b"),
        Some(HostedDocumentState {
            path: "b.md".to_owned(),
            status: HostedDocumentStatus::Backfilling,
            backfill_cursor: 16
        })
    );
    assert_eq!(replica(&store).main_cursor, 4);

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
    assert!(ready(&store, "doc-b"));
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
fn a_pass_fetched_under_an_older_scope_cannot_commit() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(hosted_feed());
    pass(&client, &mut store, &NoFaults).unwrap();
    let backfill = pass(&client, &mut store, &NoFaults).unwrap();
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
            status: HostedDocumentStatus::Backfilling,
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
    stale.main_cursor = stale.main_cursor.map(|cursor| cursor + 10);
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
    let (_scratch, path, mut store) = hosted_store();
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
                .commit_hosted_cursor(
                    &mut store,
                    "ws",
                    &pending,
                    &ReleasedTails::uncached(),
                    crash.as_ref(),
                )
                .unwrap(),
            TxnOutcome::Crashed { committed: false }
        );
    }
    if restart {
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

/// Models an inconsistent feed that no dohc engine writes: a hand-written
/// writer rotated the epoch, then continued `doc-a`'s Y.Doc lineage above the
/// floor with a delta and a new head. Its base is below the floor, so the feed
/// never serves it, and `doc-a` stays held rather than becoming ready.
#[test]
fn a_document_whose_ydoc_base_is_below_the_floor_stays_held() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    let ydoc = dohc_engine_collab::Ydoc::wire();
    ydoc.plaintext_insert(0, "hosted a");
    let base = ydoc.encode_full_state();
    let base_sha = dohc_engine_storage::hex_sha256(&base);
    let update = |origin: &str, seq: i64, bytes: Vec<u8>, is_base: bool| {
        let sha = dohc_engine_storage::hex_sha256(&bytes);
        feed.blobs.lock().unwrap().insert(sha.clone(), bytes);
        feed.append(envelope(
            origin,
            seq,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": "doc-a",
                "path": "a.md",
                "contentKind": "plaintext",
                "updateBlobSha256": sha,
                "lineageClaimId": base_sha,
                "isBaseState": is_base
            }),
        ));
    };
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    update("owner", 1, base, true);
    feed.create("owner", 2, "doc-a", "a.md", "hosted a");
    feed.epoch_log_floor.store(3, Ordering::SeqCst);
    update("writer", 0, ydoc.plaintext_insert(8, ", edited"), false);
    feed.create("writer", 1, "doc-a", "a.md", "hosted a, edited");
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);

    assert_eq!(hold(&store, "doc-a"), Some(HostedHold::WorkWaiting));
    assert_eq!(
        document(&store, "doc-a").unwrap().backfill_cursor,
        4,
        "its read stops at the new head, behind the delta"
    );
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM ydoc_deferred_updates WHERE object_id='doc-a'"
        ),
        1,
        "the delta waits for its base"
    );
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM ydoc_docs WHERE object_id='doc-a'"
        ),
        0
    );
    assert!(content(&store).0.is_empty(), "no file is materialized");
}

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

fn retain_behind_closed_editor(
    client: &RelaySyncClient<HostedFeed>,
    store: &mut EngineStore,
    from: usize,
) {
    let held = client.transport().log.lock().unwrap()[from - 1..].to_vec();
    let identity = read_sync_identity(store, "ws").unwrap().unwrap();
    let held_refs = held.iter().collect::<Vec<_>>();
    crate::deferred::retain(store, &identity, Some("relay"), &held_refs, &NoFaults).unwrap();
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
    let (_scratch, _path, mut store) = hosted_store();
    let (parent, child, result_sha) = withheld_conflict(&mut store);
    assert_conflict_child_hold_parity(&mut store, parent, child, result_sha);
}

fn assert_conflict_child_hold_parity(
    store: &mut EngineStore,
    parent: ReplicationEnvelope,
    child: ReplicationEnvelope,
    result_sha: String,
) {
    assert!(matches!(
        apply_replication_envelope(
            store,
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
    sync(&client, store);

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
    let held = pass(&client, store, &NoFaults).unwrap();
    assert_eq!(held.applied, 1);
    assert!(commit(&client, store, &held));
    assert_eq!(hold(store, "hosted-object"), Some(parent_withheld()));
    assert_eq!(
        retained(store),
        0,
        "both edits of the held document wait in its feed"
    );
    assert_eq!(
        coordinates(store),
        [("owner".to_owned(), 2), ("peer".to_owned(), 1)]
    );

    apply_replication_envelope(
        store,
        &mut WriterDocCache::new(),
        &parent,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    sync(&client, store);
    assert_eq!(retained(store), 0);
    assert_eq!(
        coordinates(store),
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
            store,
            "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' AND moment_id='owner-moment'"
        ),
        1,
        "the resolution applies once, through its parent"
    );
    assert_eq!(
        dohc_engine_domain::VersionedTextStore::new(store)
            .read_text("ws", "main", "hosted.md")
            .unwrap()
            .unwrap()
            .text,
        later_text
    );
}

fn parent_withheld() -> HostedHold {
    HostedHold::ConflictParentWithheld {
        conflict_id: "owner-conflict".to_owned(),
    }
}

/// Retain `count` later rows of `object_id`, from relay position `from`, as
/// work past the replay page that fills the workspace's cap.
fn fill_retained(store: &mut EngineStore, object_id: &str, from: i64, count: i64) {
    let identity = read_sync_identity(store, "ws").unwrap().unwrap();
    store
        .write_with(&NoFaults, |tx| {
            for seq in 0..count {
                let mut op = document_op(seq, from + seq, object_id);
                op.origin_id = "filler".to_owned();
                let json = serde_json::to_string(&op).unwrap();
                tx.execute(
                    "INSERT INTO relay_deferred_ops (workspace_id,origin_id,origin_seq, \
                     replication_epoch,stream_identity,envelope_json,retained_bytes) \
                     VALUES ('ws','filler',?1,?2,?3,?4,?5)",
                    params![
                        seq,
                        identity.replication_epoch,
                        identity.stream_identity,
                        json,
                        json.len() as i64
                    ],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "INSERT INTO hosted_deferred_ops (workspace_id,origin_id,origin_seq,object_id,relay_seq) \
                     VALUES ('ws','filler',?1,?2,?3)",
                    params![seq, object_id, from + seq],
                )
                .map_err(SyncError::persist)?;
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

/// The cap is full of a ready document's retained work, ending at a conflict
/// child whose parent the feed withholds. Its editor closes while another
/// document's moment waits behind that document's open editor. Replay
/// applies the first document's moment and stops at the child. Retaining the
/// other's moment would pass the cap and fail this pass, and every later
/// one, before the commit that releases the first document's work. So the
/// other document is held at its moment, retaining nothing, and the pass
/// commits. Once its editor closes, the moment applies and it is ready.
#[test]
fn a_full_retention_limit_holds_a_document_instead_of_failing_the_pass() {
    let (_scratch, _path, mut store) = hosted_store();
    let (_parent, child, _) = withheld_conflict(&mut store);
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 2, "workspace.init", json!({})));
    feed.create(
        "peer",
        0,
        "hosted-object",
        "hosted.md",
        "before the conflict",
    );
    feed.create("other", 0, "other-object", "other.md", "other before");
    feed.share("hosted-object", "hosted.md");
    feed.share("other-object", "other.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    assert!(ready(&store, "hosted-object"));
    assert!(ready(&store, "other-object"));

    let feed = client.transport();
    feed.replace(
        "peer",
        1,
        "hosted-object",
        "hosted.md",
        "edited live",
        ("hosted-object", "before the conflict", "moment-peer-0"),
    );
    let moment = feed.log.lock().unwrap().len();
    feed.append(child);
    let child_seq = moment as i64 + 1;
    hydrated(&mut store, &["edited live".to_owned()]);
    retain_behind_closed_editor(&client, &mut store, moment);
    fill_retained(&mut store, "hosted-object", child_seq + 100, 9_998);
    assert_eq!(retained(&store), 10_000);

    feed.replace(
        "other",
        1,
        "other-object",
        "other.md",
        "other edited",
        ("other-object", "other before", "moment-other-0"),
    );
    let other_seq = feed.log.lock().unwrap().len() as i64;
    let editing_other = client
        .pull_hosted_workspace(
            &mut store,
            &mut WriterDocCache::new(),
            "ws",
            "relay",
            &NoFaults,
            &LiveSession("other-object"),
        )
        .expect("a full retention limit never fails a hosted pass");
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM hosted_deferred_ops WHERE object_id='other-object'"
        ),
        0,
        "the other document retains nothing"
    );
    assert_eq!(
        editing_other.pending_cursor.as_ref().unwrap().reads["other-object"],
        HostedRead {
            cursor: other_seq - 1,
            stopped: Some(HostedHold::WorkWaiting),
            complete: false,
            heads_written: false,
        },
        "before its moment"
    );
    assert!(commit(&client, &mut store, &editing_other));
    let (heads, _) = content(&store);
    assert_eq!(heads["hosted-object"], "edited live");
    assert_eq!(heads["other-object"], "other before");
    assert_eq!(hold(&store, "hosted-object"), Some(parent_withheld()));
    assert_eq!(hold(&store, "other-object"), Some(HostedHold::WorkWaiting));
    assert_eq!(retained(&store), 0, "the commit released the full cap");
    assert_eq!(
        document(&store, "other-object").unwrap().backfill_cursor,
        other_seq - 1
    );

    sync(&client, &mut store);
    assert!(ready(&store, "other-object"));
    assert_eq!(content(&store).0["other-object"], "other edited");
    assert_eq!(hold(&store, "hosted-object"), Some(parent_withheld()));
    assert_eq!(retained(&store), 0);
}

fn journal_live_update(store: &mut EngineStore, object_id: &str, update: &[u8]) -> i64 {
    let key = dohc_engine_collab::DocKey::new("ws", "main", object_id).unwrap();
    let path = format!("{object_id}.md");
    let outcome = store
        .write_with(&NoFaults, |tx| {
            let sha =
                dohc_engine_storage::put_binary_blob(tx, update).map_err(SyncError::Storage)?;
            let payload = ydoc_update_payload(
                &key,
                &path,
                dohc_engine_collab::ContentKind::Richdoc,
                &sha,
                &"0".repeat(64),
                None,
                None,
                false,
            );
            journal_local_op_in_tx(tx, "ws", "ydoc.update", &payload, 3_000)
        })
        .unwrap();
    let TxnOutcome::Committed(seq) = outcome else {
        panic!("journal must commit")
    };
    seq
}

fn recorded_refusals(store: &EngineStore) -> Vec<(String, i64, String, String)> {
    store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT origin_id,origin_seq,op_kind,reason_message FROM replication_pending_refusals \
                 WHERE workspace_id='ws' ORDER BY origin_seq",
            )?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>(rows)
        })
        .unwrap()
}

struct RollBackAfterPush<'a> {
    feed: &'a HostedFeed,
    pushes: usize,
    armed: AtomicBool,
}

impl dohc_engine_storage::FaultInjector for RollBackAfterPush<'_> {
    fn poll(&self, point: FaultPoint) -> dohc_engine_storage::FaultAction {
        if point == FaultPoint::StorageBeforePersist
            && self.feed.pushes.lock().unwrap().len() > self.pushes
            && self.armed.swap(false, Ordering::SeqCst)
        {
            dohc_engine_storage::FaultAction::Crash
        } else {
            dohc_engine_storage::FaultAction::Continue
        }
    }
}

#[test]
fn a_refused_hosted_write_keeps_its_coordinate_and_a_crashed_push_retries_to_the_same_decisions() {
    let (_scratch, _path, mut store) = hosted_store();
    host_document(&mut store, "doc-a");
    host_document(&mut store, "doc-b");
    for (object_id, update) in [
        ("doc-a", b"a one".as_slice()),
        ("doc-b", b"b one"),
        ("doc-a", b"a two"),
    ] {
        journal_live_update(&mut store, object_id, update);
    }
    let client = RelaySyncClient::new(HostedFeed::new());
    client
        .transport()
        .refusing
        .lock()
        .unwrap()
        .insert("doc-b".to_owned());
    let push = |store: &mut EngineStore, faults: &dyn dohc_engine_storage::FaultInjector| {
        client
            .push_workspace(store, "ws", faults, &NoLiveLeases, 3_000, 1_000_000)
            .unwrap()
    };

    let crash = ScriptedFaults::crash_at(FaultPoint::SyncAfterPushBeforeCursorPersist);
    assert!(matches!(
        push(&mut store, crash.as_ref()),
        SyncPassOutcome::CrashedAfterRemoteCommit
    ));
    assert_eq!(read_pushed_seq(&store, "ws", HOST).unwrap(), -1);
    assert!(
        recorded_refusals(&store).is_empty(),
        "a refusal commits with its push cursor or not at all"
    );

    let rollback = RollBackAfterPush {
        feed: client.transport(),
        pushes: client.transport().pushes.lock().unwrap().len(),
        armed: AtomicBool::new(true),
    };
    assert!(matches!(
        push(&mut store, &rollback),
        SyncPassOutcome::CrashedAfterRemoteCommit
    ));
    assert!(!rollback.armed.load(Ordering::SeqCst), "the fault fired");
    assert_eq!(read_pushed_seq(&store, "ws", HOST).unwrap(), -1);
    assert!(recorded_refusals(&store).is_empty());

    let refusal = HostedPushRefusal {
        origin_id: HOST.to_owned(),
        origin_seq: 1,
        op_kind: "ydoc.update".to_owned(),
        reason: "outside-hosted-documents".to_owned(),
    };
    let expected = vec![(
        HOST.to_owned(),
        1,
        "ydoc.update".to_owned(),
        "the relay refused this hosted write: outside-hosted-documents".to_owned(),
    )];
    for reported in [
        vec![crate::hosted::push_refusal("ws", &refusal)],
        Vec::new(),
    ] {
        let outcome = push(&mut store, &NoFaults);
        let SyncPassOutcome::Complete {
            pushed,
            refused,
            refusals,
            ..
        } = outcome
        else {
            panic!("the retried push completes: {outcome:?}")
        };
        assert_eq!((pushed, refused), (0, reported.len()));
        assert_eq!(refusals, reported);
        assert_eq!(read_pushed_seq(&store, "ws", HOST).unwrap(), 2);
        assert_eq!(recorded_refusals(&store), expected);
    }
    let relay_rows = |client: &RelaySyncClient<HostedFeed>| {
        client
            .transport()
            .log
            .lock()
            .unwrap()
            .iter()
            .filter(|row| row.origin_id == HOST)
            .map(|row| (row.origin_seq, row.op_kind.clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        relay_rows(&client),
        [
            (0, "ydoc.update".to_owned()),
            (1, "relay.refused".to_owned()),
            (2, "ydoc.update".to_owned())
        ]
    );

    journal_live_update(&mut store, "doc-a", b"a three");
    assert!(matches!(
        push(&mut store, &NoFaults),
        SyncPassOutcome::Complete {
            pushed: 1,
            refused: 0,
            ..
        }
    ));
    assert_eq!(read_pushed_seq(&store, "ws", HOST).unwrap(), 3);
    assert_eq!(relay_rows(&client).len(), 4);
    assert_eq!(recorded_refusals(&store), expected);
}

#[test]
fn a_push_response_refuses_only_its_own_batch_and_only_for_a_hosted_push() {
    let batch = [
        envelope(HOST, 4, "ydoc.update", json!({})),
        envelope(HOST, 5, "moment.append", json!({})),
    ];
    let refusal = |origin_seq: i64, op_kind: &str, reason: &str| HostedPushRefusal {
        origin_id: HOST.to_owned(),
        origin_seq,
        op_kind: op_kind.to_owned(),
        reason: reason.to_owned(),
    };
    let response = |hosted_refusals: Vec<HostedPushRefusal>, settled: Option<i64>| PushResponse {
        registered_references: Vec::new(),
        settlement_refusals: settled
            .map(|origin_seq| SettlementPublicationRefusal {
                origin_id: HOST.to_owned(),
                origin_seq,
                moment_id: "unavailable".to_owned(),
                settlement_id: "unavailable".to_owned(),
                reason: "authorship-mismatch".to_owned(),
            })
            .into_iter()
            .collect(),
        hosted_refusals,
        redundant_recoveries: Vec::new(),
        accepted: 2,
        inserted: 2,
        skipped: 0,
        current_max_origin_seq: 5,
    };
    let valid = response(
        vec![refusal(5, "moment.append", "outside-hosted-documents")],
        None,
    );
    assert_eq!(
        crate::hosted::validate_push_refusals(&valid, &batch, true),
        Ok(())
    );
    let long = "x".repeat(257);
    for (case, hosted) in [
        (valid.clone(), false),
        (
            response(
                vec![refusal(6, "ydoc.update", "outside-hosted-documents")],
                None,
            ),
            true,
        ),
        (
            response(
                vec![refusal(4, "moment.append", "outside-hosted-documents")],
                None,
            ),
            true,
        ),
        (response(vec![refusal(4, "ydoc.update", "")], None), true),
        (response(vec![refusal(4, "ydoc.update", &long)], None), true),
        (
            response(
                vec![
                    refusal(4, "ydoc.update", "outside-hosted-documents"),
                    refusal(4, "ydoc.update", "outside-hosted-documents"),
                ],
                None,
            ),
            true,
        ),
        (
            response(
                vec![refusal(5, "moment.append", "outside-hosted-documents")],
                Some(5),
            ),
            true,
        ),
    ] {
        assert_eq!(
            crate::hosted::validate_push_refusals(&case, &batch, hosted),
            Err(RelayError::InvalidResponse),
            "{case:?}"
        );
    }

    let unrefused = PushResponse {
        registered_references: Vec::new(),
        hosted_refusals: Vec::new(),
        ..valid.clone()
    };
    assert_eq!(
        crate::relay::validate_share_push_response(&unrefused, 2),
        Ok(())
    );
    assert_eq!(
        crate::relay::validate_share_push_response(&valid, 2),
        Err(RelayError::InvalidResponse)
    );
    let probe = PushResponse {
        registered_references: Vec::new(),
        accepted: 0,
        inserted: 0,
        ..unrefused
    };
    assert_eq!(crate::relay::validate_probe_response(&probe), Ok(()));
    assert_eq!(
        crate::relay::validate_probe_response(&PushResponse {
            registered_references: Vec::new(),
            hosted_refusals: valid.hosted_refusals.clone(),
            ..probe
        }),
        Err(RelayError::InvalidResponse)
    );

    let (_scratch, _path, mut ordinary) = open_store();
    let refused = refusal(0, "ydoc.update", "outside-hosted-documents");
    assert!(matches!(
        crate::cursor::write_pushed_seq_with_refusals(
            &mut ordinary,
            "ws",
            HOST,
            0,
            &[],
            std::slice::from_ref(&refused),
            &[],
            &NoFaults,
            &NoLiveLeases,
            3_000
        ),
        Err(SyncError::InvalidInput { .. })
    ));
    let (_scratch, _path, mut store) = hosted_store();
    host_document(&mut store, "doc-a");
    journal_live_update(&mut store, "doc-a", b"a one");
    for wrong in [
        refusal(1, "ydoc.update", "outside-hosted-documents"),
        refusal(0, "moment.append", "outside-hosted-documents"),
    ] {
        assert!(matches!(
            crate::cursor::write_pushed_seq_with_refusals(
                &mut store,
                "ws",
                HOST,
                0,
                &[],
                std::slice::from_ref(&wrong),
                &[],
                &NoFaults,
                &NoLiveLeases,
                3_000
            ),
            Err(SyncError::CoordinateDiverged)
        ));
    }
    assert_eq!(read_pushed_seq(&store, "ws", HOST).unwrap(), -1);
}

fn text_sha(text: &str) -> String {
    dohc_engine_storage::hex_sha256(text.as_bytes())
}

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

#[test]
fn a_moment_that_replaced_a_withheld_object_applies_as_a_create() {
    let (_scratch, _path, mut store) = hosted_store();
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

fn departing_b() -> (
    ScratchDir,
    std::path::PathBuf,
    EngineStore,
    RelaySyncClient<HostedFeed>,
) {
    departing_b_at("a.md")
}

fn departing_b_at(
    at: &str,
) -> (
    ScratchDir,
    std::path::PathBuf,
    EngineStore,
    RelaySyncClient<HostedFeed>,
) {
    let (scratch, path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-b", at, "hosted b");
    feed.share("doc-b", at);
    sync(&client, &mut store);
    assert_eq!(
        content(&store).0,
        BTreeMap::from([("doc-b".to_owned(), "hosted b".to_owned())])
    );
    (scratch, path, store, client)
}

fn replace_b_with_a(feed: &HostedFeed) {
    feed.unshare("doc-b");
    feed.replace(
        "owner",
        2,
        "doc-a",
        "a.md",
        "hosted a",
        ("doc-b", "hosted b", "moment-owner-1"),
    );
    feed.share("doc-a", "a.md");
}

fn heads(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
    entries
        .iter()
        .map(|(object_id, text)| ((*object_id).to_owned(), (*text).to_owned()))
        .collect()
}

/// Clearing `a.md` for `doc-a` would drop the head `doc-b`'s unsettled work
/// still needs. `doc-a`'s moments wait, in order, until `doc-b` parks, and
/// then apply as a create and its edit. `doc-b` keeps its history and bytes,
/// and holds no path.
#[test]
fn a_replacement_waits_for_the_departed_document_holding_its_path() {
    let (_scratch, _path, mut store, client) = departing_b();
    let feed = client.transport();
    replace_b_with_a(feed);
    feed.replace(
        "owner",
        3,
        "doc-a",
        "a.md",
        "edited a",
        ("doc-a", "hosted a", "moment-owner-2"),
    );
    sync(&client, &mut store);
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b")]));
    assert_eq!(hold(&store, "doc-a"), Some(HostedHold::WorkWaiting));
    assert_eq!(retained(&store), 0, "the edit waits behind the create");

    sync_parking(&client, &mut store);
    let (now, moments) = content(&store);
    assert_eq!(now, heads(&[("doc-a", "edited a")]));
    assert_eq!(
        moments,
        BTreeMap::from([
            ("moment-owner-1".to_owned(), 1),
            ("moment-owner-2".to_owned(), 1),
            ("moment-owner-3".to_owned(), 1)
        ])
    );
    assert_eq!(retained(&store), 0);
    assert_eq!(count(&store, "SELECT COUNT(*) FROM conflicts"), 0);
    assert_eq!(
        stored_before(&store, "moment-owner-2"),
        (1, None, None, None),
        "the host's history records a create"
    );
    assert_eq!(
        withheld_befores(&store),
        [(
            "moment-owner-2".to_owned(),
            "doc-b".to_owned(),
            "a.md".to_owned(),
            text_sha("hosted b"),
            "text".to_owned()
        )]
    );
    assert!(is_parked(&store, "doc-b"));
    assert_eq!(
        coordinates(&store),
        [
            ("owner".to_owned(), 0),
            ("owner".to_owned(), 1),
            ("owner".to_owned(), 2),
            ("owner".to_owned(), 3)
        ]
    );
    assert!(has_blob(&store, &text_sha("hosted b")));
    assert!(departed_hosted_documents(&store, "ws").unwrap().is_empty());
}

/// Accepted live work of `object_id` at journal cursor 7, past any
/// settlement, as the session host applied it.
fn accept_live_work(store: &mut EngineStore, object_id: &str) -> String {
    accept_live_update(store, object_id, "lineage", b"live update")
}

fn accept_live_update(
    store: &mut EngineStore,
    object_id: &str,
    lineage: &str,
    bytes: &[u8],
) -> String {
    let update = dohc_engine_storage::hex_sha256(bytes);
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_storage::put_binary_blob(tx, bytes).map_err(SyncError::Storage)?;
            tx.execute_batch(&format!(
                "INSERT INTO live_device_application_bindings VALUES \
                   ('relay','ws','main','{object_id}','{lineage}','a.md','[]',0,'host',1,'instance', \
                    'connection',1,NULL); \
                 INSERT INTO live_device_update_applications (relay_database_namespace,workspace_id, \
                   delivery_id,main_version_id,object_id,lineage_claim_id,current_path, \
                   selector_paths_json,restore_fence_generation,update_digest,update_byte_length, \
                   journal_cursor,accepting_host_epoch,principal_kind,principal_id,received_at_ms, \
                   first_seen_count,local_ydoc_sequence,applied_host_id,applied_host_epoch, \
                   applied_instance_id,applied_connection_id) VALUES \
                   ('relay','ws','delivery','main','{object_id}','{lineage}','a.md','[]',0,'{update}', \
                    {length},7,1,'owner','owner',0,0,1,'host',1,'instance','connection'); \
                 INSERT INTO live_device_application_first_seen VALUES \
                   ('relay','ws','delivery',0,1,0,1);",
                length = bytes.len()
            ))
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    update
}

fn settle_live_work(store: &mut EngineStore, object_id: &str) {
    settle_live_lineage(store, object_id, "lineage");
}

fn settle_live_lineage(store: &mut EngineStore, object_id: &str, lineage: &str) {
    let digest = "d".repeat(64);
    store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(&format!(
                "INSERT INTO live_device_settlements (settlement_id,relay_database_namespace, \
                   workspace_id,main_version_id,object_id,lineage_claim_id,previous_cursor, \
                   terminal_cursor,previous_ydoc_sequence,local_ydoc_sequence,application_count, \
                   interval_digest,moment_id,markdown_digest,source_state_vector_digest, \
                   binding_json,host_coordinate_json,recorded_at_ms) VALUES \
                   ('settlement','relay','ws','main','{object_id}','{lineage}',0,7,0,1,1, \
                    '{digest}','settled','{digest}','{digest}','{{}}','{{}}',0)"
            ))
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

#[test]
fn a_departed_document_is_reported_until_its_file_is_forgotten() {
    let (_scratch, path, mut store, client) = departing_b();
    let departed = |store: &EngineStore| departed_hosted_object_ids(store, "ws").unwrap();
    assert!(departed(&store).is_empty());
    client.transport().unshare("doc-b");
    sync(&client, &mut store);
    assert_eq!(departed(&store), ["doc-b"]);

    assert_eq!(
        park_hosted_document(&mut store, "ws", "doc-b", "main", &NoFaults).unwrap(),
        TxnOutcome::Committed(true)
    );
    assert!(is_parked(&store, "doc-b"));
    assert_eq!(departed(&store), ["doc-b"], "its file is still to go");
    drop(store);
    let mut store = EngineStore::open(&path, 3_000).unwrap();
    assert_eq!(departed(&store), ["doc-b"]);

    forget_retired_hosted_file(&mut store, "ws", "a.md", &NoFaults).unwrap();
    assert!(departed(&store).is_empty());
}

fn baseless_ydoc_delta(feed: &HostedFeed, object_id: &str, path: &str) -> String {
    let ydoc = dohc_engine_collab::Ydoc::wire();
    ydoc.plaintext_insert(0, "waits for a base");
    let update = ydoc.encode_full_state();
    let sha = dohc_engine_storage::hex_sha256(&update);
    feed.blobs.lock().unwrap().insert(sha.clone(), update);
    feed.append(envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": object_id,
            "path": path,
            "contentKind": "plaintext",
            "updateBlobSha256": sha,
            "lineageClaimId": "1".repeat(64),
            "isBaseState": false
        }),
    ));
    sha
}

fn pending_outbox(store: &mut EngineStore, object_id: &str) {
    store
        .write_with(&NoFaults, |tx| {
            let base = dohc_engine_storage::put_binary_blob(tx, b"outbox base")
                .map_err(SyncError::Storage)?;
            tx.execute(
                "INSERT INTO owner_ydoc_outboxes (outbox_id,workspace_id,main_version_id,object_id, \
                   lineage_claim_id,current_path,selector_paths_json,restore_fence_generation, \
                   base_update_digest,base_blob_digest,base_byte_length,state,pending_bytes, \
                   oldest_entry_at_ms,next_sequence,created_at_ms) \
                 VALUES ('outbox','ws','main',?1,'lineage','a.md','[]',0,?2,?2,11,'active',5,1,2,0)",
                params![object_id, base],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

/// A departed document with a deferred update would wait for rows the feed
/// no longer serves. It parks with the update, which its return skips as
/// redelivered, so the update and its bytes stay queued: dropping them would
/// lose the edit. Work the relay served that was never journaled is
/// released, and the return fetches it again. Parking still waits for the
/// host's own undelivered outbox bytes.
#[test]
fn parking_keeps_journaled_deferred_updates_and_waits_for_accepted_work() {
    let (_scratch, _path, mut store, client) = departing_b();
    let feed = client.transport();
    let update = baseless_ydoc_delta(feed, "doc-b", "a.md");
    sync(&client, &mut store);
    let deferred = "SELECT COUNT(*) FROM ydoc_deferred_updates WHERE object_id='doc-b'";
    assert_eq!(count(&store, deferred), 1);
    pending_outbox(&mut store, "doc-b");
    let identity = read_sync_identity(&store, "ws").unwrap().unwrap();
    let unjournaled = document_op(9, 99, "doc-b");
    crate::deferred::retain(
        &mut store,
        &identity,
        Some("relay"),
        &[&unjournaled],
        &NoFaults,
    )
    .unwrap();
    assert_eq!(retained(&store), 1);

    feed.unshare("doc-b");
    sync_parking(&client, &mut store);
    assert_eq!(
        content(&store).0,
        heads(&[("doc-b", "hosted b")]),
        "its outbox bytes hold it"
    );
    assert!(!hosted_document_parkable(&store, "ws", "doc-b").unwrap());
    assert_eq!(departed_hosted_object_ids(&store, "ws").unwrap(), ["doc-b"]);
    assert_eq!(count(&store, deferred), 1);

    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE owner_ydoc_outboxes SET pending_bytes=0,oldest_entry_at_ms=NULL",
                [],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));
    assert_eq!(count(&store, deferred), 1);
    assert!(has_blob(&store, &update));
    assert_eq!(retained(&store), 0, "work never journaled is released");
    assert!(departed_hosted_object_ids(&store, "ws").unwrap().is_empty());

    let journal = coordinates(&store);
    feed.share("doc-b", "a.md");
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b")]));
    assert_eq!(
        count(&store, deferred),
        1,
        "the update still waits for its base"
    );
    assert_eq!(coordinates(&store), journal, "nothing applied twice");
}

#[test]
fn parking_is_all_or_nothing_and_idempotent() {
    let (_scratch, path, mut store, client) = departing_b();
    client.transport().unshare("doc-b");
    sync(&client, &mut store);
    let before = (
        content(&store),
        coordinates(&store),
        holding(&store, "doc-b"),
    );
    assert!(!before.2.is_empty());

    let crash = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
    assert_eq!(
        park_hosted_document(&mut store, "ws", "doc-b", "main", crash.as_ref()).unwrap(),
        TxnOutcome::Crashed { committed: false }
    );
    drop(store);
    let mut store = EngineStore::open(&path, 3_000).unwrap();
    assert_eq!(
        (
            content(&store),
            coordinates(&store),
            holding(&store, "doc-b")
        ),
        before
    );
    assert!(retired_hosted_files(&store, "ws").unwrap().is_empty());

    assert_eq!(
        park_hosted_document(&mut store, "ws", "doc-b", "main", &NoFaults).unwrap(),
        TxnOutcome::Committed(true)
    );
    assert!(is_parked(&store, "doc-b"));
    assert_eq!(coordinates(&store), before.1, "its journal stays");
    assert_eq!(
        retired_hosted_files(&store, "ws").unwrap(),
        [RetiredFile {
            path: "a.md".to_owned(),
            sha256: text_sha("hosted b")
        }],
        "its file is recorded as its head parks"
    );
    assert_eq!(
        park_hosted_document(&mut store, "ws", "doc-b", "main", &NoFaults).unwrap(),
        TxnOutcome::Committed(false),
        "nothing is left to park"
    );
    assert!(park(&mut store), "its file's path comes free");
    assert!(!park(&mut store));
}

#[test]
fn a_retired_file_holds_its_path_until_it_is_forgotten() {
    let (_scratch, path, mut store, client) = departing_b();
    replace_b_with_a(client.transport());
    sync(&client, &mut store);
    assert_eq!(
        park_hosted_document(&mut store, "ws", "doc-b", "main", &NoFaults).unwrap(),
        TxnOutcome::Committed(true)
    );
    drop(store);
    let mut store = EngineStore::open(&path, 3_000).unwrap();

    sync(&client, &mut store);
    assert!(content(&store).0.is_empty());
    assert_eq!(hold(&store, "doc-a"), Some(HostedHold::WorkWaiting));
    assert_eq!(retained(&store), 0, "doc-a waits for the file in its feed");
    assert_eq!(retired_hosted_files(&store, "ws").unwrap().len(), 1);

    assert_eq!(
        forget_retired_hosted_file(&mut store, "ws", "a.md", &NoFaults).unwrap(),
        TxnOutcome::Committed(())
    );
    sync(&client, &mut store);
    assert_eq!(content(&store).0, heads(&[("doc-a", "hosted a")]));
    assert_eq!(retained(&store), 0);
}

/// Retiring a document must not delete a conflict another hosted document
/// still needs. `doc-b`'s rename leaves a conflict against `doc-a` at
/// `b.md`. A parked document keeps its conflicts, with the bytes of both
/// sides, after both documents park.
#[test]
fn parking_keeps_a_conflict_and_the_bytes_of_its_sides() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-a", "b.md", "hosted a");
    feed.create("peer", 0, "doc-b", "x.md", "hosted b");
    feed.share("doc-a", "b.md");
    feed.share("doc-b", "x.md");
    sync(&client, &mut store);
    feed.rename(
        "peer",
        1,
        "doc-b",
        "x.md",
        "b.md",
        "hosted b",
        "moment-peer-0",
    );
    sync(&client, &mut store);
    let conflict = "SELECT COUNT(*) FROM conflicts WHERE current_object_id='doc-a' \
                    AND incoming_object_id='doc-b'";
    assert_eq!(count(&store, conflict), 1);

    feed.unshare("doc-a");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-a"));
    assert!(document(&store, "doc-b").is_some());
    assert_eq!(count(&store, conflict), 1, "doc-b still has it to resolve");
    assert!(has_blob(&store, &text_sha("hosted a")));
    assert!(has_blob(&store, &text_sha("hosted b")));

    feed.unshare("doc-b");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));
    assert_eq!(count(&store, conflict), 1);
    assert!(has_blob(&store, &text_sha("hosted a")));
    assert!(has_blob(&store, &text_sha("hosted b")));
}

type Pairs = Vec<(String, String)>;

fn paths(store: &EngineStore) -> (Pairs, Pairs) {
    store
        .read_with(|conn| {
            let pairs = |sql: &str| -> rusqlite::Result<Pairs> {
                conn.prepare(sql)?
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect()
            };
            Ok::<_, rusqlite::Error>((
                pairs("SELECT object_id,path FROM snapshots ORDER BY object_id")?,
                pairs("SELECT path,object_id FROM path_aliases ORDER BY path")?,
            ))
        })
        .unwrap()
}

fn path_held(path: &str, held_by: &str) -> HostedHold {
    HostedHold::PathHeld {
        path: path.to_owned(),
        held_by: held_by.to_owned(),
    }
}

fn hold(store: &EngineStore, object_id: &str) -> Option<HostedHold> {
    match document(store, object_id).unwrap().status {
        HostedDocumentStatus::Held(hold) => Some(hold),
        HostedDocumentStatus::Backfilling | HostedDocumentStatus::Ready => None,
    }
}

/// Two shared documents whose paths differ only in case, or where one path is
/// a folder of the other, cannot both be files on a disk that ignores case.
/// The later one is held, naming the document that holds its path,
/// while the first and the main cursor go on. Once the first moves, the later
/// one applies.
#[test]
fn a_document_at_another_spelling_of_a_held_path_is_held_until_the_path_frees() {
    for (held, path) in [
        ("a.md", "A.md"),
        ("A.md", "a.md/c.md"),
        ("a.md/c.md", "A.md"),
        ("\u{212a}.md", "k.md"),
        ("e\u{301}.md", "\u{e9}.md"),
    ] {
        let (_scratch, _path, mut store) = hosted_store();
        let client = RelaySyncClient::new(HostedFeed::new());
        let feed = client.transport();
        feed.append(envelope("owner", 0, "workspace.init", json!({})));
        feed.create("owner", 1, "doc-a", held, "hosted a");
        feed.create("owner", 2, "doc-b", path, "hosted b");
        feed.share("doc-a", held);
        sync(&client, &mut store);

        feed.share("doc-b", path);
        sync(&client, &mut store);
        assert_eq!(
            hold(&store, "doc-b"),
            Some(path_held(path, "doc-a")),
            "{path} against {held}"
        );
        assert_eq!(
            content(&store).0,
            heads(&[("doc-a", "hosted a")]),
            "{path} against {held}"
        );
        feed.replace(
            "owner",
            3,
            "doc-a",
            held,
            "edited a",
            ("doc-a", "hosted a", "moment-owner-1"),
        );
        sync(&client, &mut store);
        assert_eq!(
            content(&store).0,
            heads(&[("doc-a", "edited a")]),
            "{path} against {held}"
        );

        feed.rename(
            "owner",
            4,
            "doc-a",
            held,
            "z.md",
            "edited a",
            "moment-owner-3",
        );
        sync(&client, &mut store);
        assert!(ready(&store, "doc-b"), "{path} against {held}");
        assert_eq!(
            content(&store).0,
            heads(&[("doc-a", "edited a"), ("doc-b", "hosted b")]),
            "{path} against {held}"
        );
        assert_eq!(retained(&store), 0, "{path} against {held}");
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM conflicts"),
            0,
            "{path} against {held}"
        );
    }
}

#[test]
fn a_trade_of_spellings_stopped_at_any_apply_resumes_after_a_restart() {
    let mut crashes = 0;
    for nth in 0.. {
        let (_scratch, path, mut store) = hosted_store();
        let client = RelaySyncClient::new(HostedFeed::new());
        let feed = client.transport();
        feed.append(envelope("owner", 0, "workspace.init", json!({})));
        feed.create("owner", 1, "doc-a", "a.md", "hosted a");
        feed.create("owner", 2, "doc-b", "b.md", "hosted b");
        feed.share("doc-a", "a.md");
        feed.share("doc-b", "b.md");
        sync(&client, &mut store);
        feed.rename(
            "owner",
            3,
            "doc-a",
            "a.md",
            "B.md",
            "hosted a",
            "moment-owner-1",
        );
        feed.rename(
            "owner",
            4,
            "doc-b",
            "b.md",
            "A.md",
            "hosted b",
            "moment-owner-2",
        );
        feed.share("doc-a", "B.md");
        feed.share("doc-b", "A.md");

        let crash = super::ordinary_pull_progress::CrashAt {
            point: FaultPoint::SyncBeforeApplyCommit,
            nth,
            seen: AtomicUsize::new(0),
        };
        let crashed = trade(&client, &mut store, &crash);
        if crashed {
            crashes += 1;
            drop(store);
            store = EngineStore::open(&path, 3_000).unwrap();
            assert_eq!(ready_on_one_file(&store), Pairs::new(), "{nth}");
            assert!(!trade(&client, &mut store, &NoFaults), "{nth}");
        }
        assert!(ready(&store, "doc-a"), "{nth}");
        assert!(ready(&store, "doc-b"), "{nth}");
        let pair = |left: &str, right: &str| (left.to_owned(), right.to_owned());
        assert_eq!(
            paths(&store).0,
            vec![pair("doc-a", "B.md"), pair("doc-b", "A.md")],
            "{nth}"
        );
        let (texts, applied) = content(&store);
        assert_eq!(
            texts,
            heads(&[("doc-a", "hosted a"), ("doc-b", "hosted b")]),
            "{nth}"
        );
        assert!(applied.values().all(|count| *count == 1), "{nth}");
        assert_eq!(count(&store, "SELECT COUNT(*) FROM conflicts"), 0);
        assert_eq!(retained(&store), 0);
        if !crashed {
            break;
        }
    }
    assert!(
        crashes >= 2,
        "the trade stopped at each of its renames: {crashes}"
    );
}

/// Pass and commit as two [`sync`]s do, which a trade of spellings takes,
/// checking after each commit that no document is ready at a spelling of
/// another's head. Answers whether a pass crashed at `faults`.
fn trade(
    client: &RelaySyncClient<HostedFeed>,
    store: &mut EngineStore,
    faults: &dyn dohc_engine_storage::FaultInjector,
) -> bool {
    for _ in 0..2 {
        for _ in 0..64 {
            let Ok(outcome) = pass(client, store, faults) else {
                return true;
            };
            commit(client, store, &outcome);
            assert_eq!(ready_on_one_file(store), Pairs::new());
            if !outcome.has_more {
                break;
            }
        }
    }
    false
}

/// Each pair of documents whose heads are spellings of one path while either
/// is ready. On a disk that ignores case, the ready one writes the other's
/// file.
fn ready_on_one_file(store: &EngineStore) -> Pairs {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT a.object_id,b.object_id FROM snapshots a JOIN snapshots b \
                   ON b.workspace_id=a.workspace_id AND b.version_id=a.version_id \
                  AND a.object_id<b.object_id AND lower(a.path)=lower(b.path) \
                 WHERE EXISTS(SELECT 1 FROM hosted_documents d \
                   WHERE d.workspace_id=a.workspace_id AND d.state='ready' \
                     AND d.object_id IN (a.object_id,b.object_id)) \
                 ORDER BY a.object_id,b.object_id",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Pairs>>()
        })
        .unwrap()
}

struct LiveSession(&'static str);

impl LeaseProbe for LiveSession {
    fn is_live(&self, key: &dohc_engine_collab::DocKey) -> bool {
        key.object_id == self.0
    }
}

#[test]
fn a_backfill_is_ready_only_once_its_waiting_work_applies() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-b", "a.md", "hosted b");
    feed.share("doc-b", "b.md");
    pass(&client, &mut store, &NoFaults).unwrap();
    // The creation applies, but the pass never commits, so the backfill
    // fetches it again with the rename.
    pass(&client, &mut store, &NoFaults).unwrap();
    feed.rename(
        "owner",
        2,
        "doc-b",
        "a.md",
        "b.md",
        "hosted b",
        "moment-owner-1",
    );
    let behind_session = client
        .pull_hosted_workspace(
            &mut store,
            &mut WriterDocCache::new(),
            "ws",
            "relay",
            &NoFaults,
            &LiveSession("doc-b"),
        )
        .unwrap();
    assert_eq!(
        behind_session.pending_cursor.as_ref().unwrap().reads["doc-b"],
        HostedRead {
            cursor: 2,
            stopped: Some(HostedHold::WorkWaiting),
            complete: false,
            heads_written: false,
        },
        "before the rename"
    );
    assert!(commit(&client, &mut store, &behind_session));
    assert_eq!(hold(&store, "doc-b"), Some(HostedHold::WorkWaiting));
    assert_eq!(retained(&store), 0);

    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(retained(&store), 0);
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM snapshots WHERE object_id='doc-b' AND path='b.md'"
        ),
        1
    );
}

#[test]
fn a_ready_document_the_scope_moves_is_held_until_it_arrives() {
    let (_scratch, _path, mut store, client) = departing_b();
    let feed = client.transport();
    feed.share("doc-b", "b.md");
    assert_eq!(
        pass(&client, &mut store, &NoFaults).unwrap().pending_cursor,
        None
    );
    let away = HostedHold::ScopePathMismatch {
        scope_path: "b.md".to_owned(),
        head_path: Some("a.md".to_owned()),
    };
    assert_eq!(hold(&store, "doc-b"), Some(away.clone()));
    let outcome = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(outcome.held, BTreeMap::from([("doc-b".to_owned(), away)]));
    assert!(commit(&client, &mut store, &outcome));

    feed.rename(
        "owner",
        2,
        "doc-b",
        "a.md",
        "b.md",
        "hosted b",
        "moment-owner-1",
    );
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(paths(&store).0, [("doc-b".to_owned(), "b.md".to_owned())]);
    assert_eq!(replica(&store).main_cursor, 3);
}

#[test]
fn a_ydoc_base_waits_for_a_retired_file_at_its_path() {
    let (_scratch, _path, mut store, client) = departing_b();
    let feed = client.transport();
    feed.unshare("doc-b");
    sync(&client, &mut store);
    assert_eq!(
        park_hosted_document(&mut store, "ws", "doc-b", "main", &NoFaults).unwrap(),
        TxnOutcome::Committed(true)
    );
    ydoc_base(feed, "doc-a", "a.md", "hosted a");
    feed.share("doc-a", "a.md");
    sync(&client, &mut store);
    assert_eq!(hold(&store, "doc-a"), Some(HostedHold::WorkWaiting));
    assert_eq!(
        count(
            &store,
            "SELECT (SELECT COUNT(*) FROM snapshots) + (SELECT COUNT(*) FROM ydoc_docs)"
        ),
        0
    );

    assert_eq!(
        forget_retired_hosted_file(&mut store, "ws", "a.md", &NoFaults).unwrap(),
        TxnOutcome::Committed(())
    );
    sync(&client, &mut store);
    assert!(ready(&store, "doc-a"));
    assert_eq!(paths(&store).0, [("doc-a".to_owned(), "a.md".to_owned())]);
}

#[test]
fn a_departed_path_holds_its_case_aliases_descendants_and_ancestors() {
    for (at, path) in [
        ("a.md", "A.md"),
        ("a.md", "a.md/c.md"),
        ("a.md/c.md", "a.md"),
        ("a.md/c.md", "A.md"),
    ] {
        let (_scratch, _path, mut store, client) = departing_b_at(at);
        let feed = client.transport();
        feed.unshare("doc-b");
        sync(&client, &mut store);
        ydoc_base(feed, "doc-a", path, "hosted a");
        feed.share("doc-a", path);
        sync(&client, &mut store);
        assert_eq!(
            hold(&store, "doc-a"),
            Some(HostedHold::WorkWaiting),
            "{path}"
        );

        assert_eq!(
            park_hosted_document(&mut store, "ws", "doc-b", "main", &NoFaults).unwrap(),
            TxnOutcome::Committed(true)
        );
        sync(&client, &mut store);
        assert_eq!(
            hold(&store, "doc-a"),
            Some(HostedHold::WorkWaiting),
            "{path}"
        );

        assert_eq!(
            forget_retired_hosted_file(&mut store, "ws", at, &NoFaults).unwrap(),
            TxnOutcome::Committed(())
        );
        sync(&client, &mut store);
        assert!(ready(&store, "doc-a"), "{path}");
    }
}

#[test]
fn a_document_that_returns_at_another_path_is_held_without_looping() {
    let (_scratch, _path, mut store, client) = departing_b();
    let feed = client.transport();
    feed.unshare("doc-b");
    sync_parking(&client, &mut store);
    feed.share("doc-b", "b.md");
    sync_parking(&client, &mut store);
    let away = HostedHold::ScopePathMismatch {
        scope_path: "b.md".to_owned(),
        head_path: Some("a.md".to_owned()),
    };
    assert_eq!(hold(&store, "doc-b"), Some(away.clone()));
    assert_eq!(paths(&store).0, [("doc-b".to_owned(), "a.md".to_owned())]);
    for _ in 0..2 {
        let again = pass(&client, &mut store, &NoFaults).unwrap();
        assert!(!again.has_more);
        assert_eq!(again.applied, 0);
        assert_eq!(
            again.held,
            BTreeMap::from([("doc-b".to_owned(), away.clone())])
        );
        assert!(commit(&client, &mut store, &again));
    }

    feed.rename(
        "owner",
        2,
        "doc-b",
        "a.md",
        "b.md",
        "hosted b",
        "moment-owner-1",
    );
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(paths(&store).0, [("doc-b".to_owned(), "b.md".to_owned())]);
}

#[test]
fn a_return_interrupted_at_its_unparking_finishes_once_after_a_restart() {
    for unparked in [false, true] {
        let (_scratch, path, mut store, client) = departing_b();
        let feed = client.transport();
        feed.unshare("doc-b");
        sync_parking(&client, &mut store);
        let parked_heads = "SELECT COUNT(*) FROM hosted_parked_snapshots";
        let journal = coordinates(&store);
        feed.share("doc-b", "a.md");
        assert_eq!(
            pass(&client, &mut store, &NoFaults).unwrap().pending_cursor,
            None
        );
        if unparked {
            let back = pass(&client, &mut store, &NoFaults).unwrap();
            assert!(
                back.changed_paths
                    .iter()
                    .any(|change| change.path == "a.md")
            );
            assert_eq!(count(&store, parked_heads), 0);
        } else {
            let crash = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
            assert!(pass(&client, &mut store, crash.as_ref()).is_err());
            assert_eq!(count(&store, parked_heads), 1, "{unparked}");
        }
        drop(store);
        let mut store = EngineStore::open(&path, 3_000).unwrap();
        let again = pass(&client, &mut store, &NoFaults).unwrap();
        assert!(
            again
                .changed_paths
                .iter()
                .any(|change| change.path == "a.md"),
            "{unparked}: its file is named again"
        );
        assert!(commit(&client, &mut store, &again));
        sync(&client, &mut store);
        assert!(ready(&store, "doc-b"), "{unparked}");
        assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b")]));
        assert_eq!(coordinates(&store), journal, "{unparked}");
        assert_eq!(count(&store, parked_heads), 0);
    }
}

#[test]
fn a_write_for_a_parked_document_is_refused() {
    let (_scratch, _path, mut store, client) = departing_b();
    client.transport().unshare("doc-b");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));
    let before = last_outbound_seq(&store);
    for (kind, payload) in [
        ("ydoc.update", json!({"objectId": "doc-b"})),
        ("moment.append", json!({"objectId": "doc-b"})),
        ("live.audit.application", json!({"objectId": "doc-b"})),
    ] {
        let refused = store.write_with(&NoFaults, |tx| {
            journal_local_op_in_tx(tx, "ws", kind, &payload, 3_000)
        });
        assert!(
            matches!(
                refused,
                Err(SyncError::InvalidInput {
                    reason: dohc_engine_domain::HOSTED_REPLICA_WRITE_REFUSED
                })
            ),
            "{kind}: {refused:?}"
        );
    }
    assert_eq!(last_outbound_seq(&store), before);
}

#[test]
fn deferred_input_survives_parking_and_release_and_drains_after_the_return() {
    use dohc_engine_collab::live_object_binding::LiveObjectBinding;
    use dohc_engine_collab::live_update_application::{
        ApplicationHostCoordinate, Release, RetirementKey, RetirementScope, release_activation,
    };
    let (_scratch, _path, mut store, client) = departing_b();
    let feed = client.transport();
    let ydoc = dohc_engine_collab::Ydoc::wire();
    ydoc.plaintext_insert(0, "hosted b");
    let base = ydoc.encode_full_state();
    let base_sha = dohc_engine_storage::hex_sha256(&base);
    let update = ydoc.plaintext_insert(8, " and more");
    let update_sha = dohc_engine_storage::hex_sha256(&update);
    feed.blobs.lock().unwrap().insert(base_sha.clone(), base);
    feed.blobs
        .lock()
        .unwrap()
        .insert(update_sha.clone(), update);
    let ydoc_update = |sha: &str, base: bool| {
        json!({"versionId": "main", "objectId": "doc-b", "path": "a.md",
            "contentKind": "plaintext", "updateBlobSha256": sha,
            "lineageClaimId": base_sha, "isBaseState": base})
    };
    feed.append(envelope(
        "peer",
        0,
        "ydoc.update",
        ydoc_update(&update_sha, false),
    ));
    sync(&client, &mut store);
    let deferred = "SELECT COUNT(*) FROM ydoc_deferred_updates WHERE object_id='doc-b'";
    assert_eq!(count(&store, deferred), 1, "the update waits for its base");

    let lineage = dohc_engine_storage::hex_sha256(b"activation lineage");
    let binding = LiveObjectBinding {
        workspace_id: "ws".into(),
        main_version_id: "main".into(),
        object_id: "doc-b".into(),
        lineage_claim_id: lineage.clone(),
        current_path: "a.md".into(),
        selector_paths: vec!["a.md".into()],
        restore_fence_generation: 0,
    };
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_storage::put_binary_blob(tx, b"activation lineage")
                .map_err(SyncError::Storage)?;
            tx.execute(
                "INSERT INTO live_owner_adoptions (relay_database_namespace,adoption_id, \
                   workspace_id,main_version_id,object_id,lineage_claim_id,binding_json, \
                   source_moment_id,source_digest,source_byte_length, \
                   baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest, \
                   coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor, \
                   terminal_receipt_json,host_coordinate_json,max_pending_bytes,max_pending_age_ms) \
                 VALUES ('relay','activation','ws','main','doc-b',?1,?2,'moment-owner-1',?3,8,0,0, \
                   'e','c',0,0,0,'null','{}',1,1)",
                params![lineage, serde_json::to_string(&binding).unwrap(), text_sha("hosted b")],
            )
            .map_err(SyncError::persist)?;
            tx.execute(ACTIVATE_ADOPTION, params!["relay", "activation", None::<String>])
                .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO live_device_application_bindings VALUES \
                 ('relay','ws','main','doc-b',?1,'a.md','[\"a.md\"]',0,'host',1,'instance', \
                  'connection',1,'activation')",
                [&lineage],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO live_accepted_checkpoints VALUES \
                 ('relay','ws','main','doc-b',?1,0,0,'null','{}',?1,?1,?2,NULL,NULL)",
                params![lineage, "e".repeat(64)],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();

    feed.unshare("doc-b");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));
    assert_eq!(count(&store, deferred), 1, "parking keeps it");
    let released = release_activation(
        &mut store,
        &mut WriterDocCache::new(),
        &RetirementScope {
            namespace: "relay",
            workspace_id: "ws",
            max_deliveries: 8,
            max_applications: 8,
        },
        &RetirementKey {
            object_id: "doc-b".into(),
            lineage_claim_id: lineage,
            activation_id: "activation".into(),
            restore_fence_generation: 0,
            accepted_through: 0,
        },
        &ApplicationHostCoordinate {
            host_id: "host".into(),
            host_epoch: 1,
            instance_id: "instance".into(),
            connection_id: "connection".into(),
        },
        30,
        &NoFaults,
    )
    .unwrap();
    assert!(matches!(
        released,
        Release::Released {
            replayed: false,
            ..
        }
    ));
    assert_eq!(count(&store, deferred), 1, "release keeps it");

    // The base is written while `doc-b` is out of the scope, so only its
    // return fetches it.
    feed.append(envelope(
        "base-peer",
        0,
        "ydoc.update",
        ydoc_update(&base_sha, true),
    ));
    let journal = coordinates(&store);
    feed.share("doc-b", "a.md");
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(count(&store, deferred), 0, "the returned base drained it");
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b and more")]));
    let mut expected = journal;
    expected.push(("base-peer".to_owned(), 0));
    expected.sort();
    assert_eq!(coordinates(&store), expected, "only the base is new");
}

fn restores(store: &EngineStore) -> String {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT json_array( \
                   (SELECT json_group_array(json_array(operation_id,previous_operation_id, \
                      resume_settlement_id,resume_receipt_json,proposal_point_sha256)) \
                    FROM (SELECT * FROM live_restore_fences ORDER BY operation_id)), \
                   (SELECT json_group_array(json_array(settlement_id,settlement_kind, \
                      restore_operation_id)) \
                    FROM (SELECT * FROM live_device_settlements ORDER BY settlement_id)))",
                [],
                |row| row.get(0),
            )
        })
        .unwrap()
}

#[test]
fn a_restore_made_before_parking_survives_the_return() {
    let (_scratch, path, mut store, client) = departing_b();
    accept_live_work(&mut store, "doc-b");
    settle_live_work(&mut store, "doc-b");
    let point = dohc_engine_storage::hex_sha256(b"restore point");
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_storage::put_binary_blob(tx, b"restore point")
                .map_err(SyncError::Storage)?;
            // A restore applied through the accepted delivery, and resumed by
            // the settlement after it.
            tx.execute(
                "INSERT INTO live_restore_fences (workspace_id,main_version_id,object_id, \
                   relay_database_namespace,operation_id,input_json,receipt_json, \
                   proposal_json,proposal_candidate_sha256,proposal_frozen_sha256, \
                   proposal_point_sha256,application_json,application_delivery_id) \
                 VALUES ('ws','main','doc-b','relay','restore','{\"newFence\":2}','{}', \
                   '{}',?1,?1,?1,'{}','delivery')",
                [&point],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "UPDATE live_device_settlements SET settlement_kind='restore', \
                 restore_operation_id='restore'",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "UPDATE live_restore_fences SET resume_receipt_json='{}', \
                 resume_settlement_id='settlement',resume_evidence_digest=?1",
                ["e".repeat(64)],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let key = dohc_engine_collab::DocKey::new("ws", "main", "doc-b").unwrap();
    let generation = |store: &EngineStore| {
        store
            .read_with(|conn| {
                Ok::<_, SyncError>(format!(
                    "{:?}",
                    dohc_engine_collab::live_update_application::restore_generation(conn, &key)
                ))
            })
            .unwrap()
    };
    let before = (restores(&store), generation(&store));

    client.transport().unshare("doc-b");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));
    drop(store);
    let mut store = EngineStore::open(&path, 3_000).unwrap();
    assert_eq!((restores(&store), generation(&store)), before);
    assert!(has_blob(&store, &point));

    client.transport().share("doc-b", "a.md");
    sync_parking(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!((restores(&store), generation(&store)), before);
}

fn peer_update(
    feed: &HostedFeed,
    kind: &str,
    seq: i64,
    object_id: &str,
    path: &str,
    update: Vec<u8>,
    lineage: &str,
) {
    let sha = dohc_engine_storage::hex_sha256(&update);
    let base = sha == lineage;
    feed.blobs.lock().unwrap().insert(sha.clone(), update);
    feed.append(envelope(
        "peer",
        seq,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": object_id,
            "path": path,
            "contentKind": kind,
            "updateBlobSha256": sha,
            "lineageClaimId": lineage,
            "isBaseState": base
        }),
    ));
}

fn queued_b(store: &EngineStore) -> String {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT json_group_array(json_array(origin_id,origin_seq,ingress_kind, \
                   relay_namespace)) FROM (SELECT * FROM ydoc_deferred_updates \
                   WHERE object_id='doc-b' ORDER BY origin_id,origin_seq)",
                [],
                |row| row.get(0),
            )
        })
        .unwrap()
}

fn release_b(store: &mut EngineStore) {
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM live_device_application_bindings WHERE object_id='doc-b'",
                [],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
}

fn ready_bound_b() -> (
    ScratchDir,
    std::path::PathBuf,
    EngineStore,
    RelaySyncClient<HostedFeed>,
    dohc_engine_collab::Ydoc,
    String,
) {
    let (scratch, path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    let ydoc = dohc_engine_collab::Ydoc::wire();
    ydoc.plaintext_insert(0, "hosted b");
    let base = ydoc.encode_full_state();
    let lineage = dohc_engine_storage::hex_sha256(&base);
    peer_update(feed, "plaintext", 0, "doc-b", "a.md", base, &lineage);
    feed.share("doc-b", "a.md");
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    accept_live_update(&mut store, "doc-b", &lineage, b"live update");
    (scratch, path, store, client, ydoc, lineage)
}

/// The ready hold: an ordinary edit of `doc-b`'s current lineage that its
/// session never admitted, as the owner's edit while paused, reaches the
/// replica while `doc-b` is ready. Its content here would miss the edit, so
/// the edit stays queued with its feed and holds `doc-b` in its own
/// transaction: the pass reports it held, a reopened store still holds it
/// before any commit, and every pass after reports it again. Nothing is
/// refused. Once the binding goes, the next pass applies the edit and
/// `doc-b` is ready with it.
#[test]
fn an_unadmitted_edit_of_the_current_lineage_holds_a_ready_document() {
    let (_scratch, path, mut store, client, ydoc, lineage) = ready_bound_b();
    let edit = ydoc.plaintext_insert(8, " and more");
    peer_update(
        client.transport(),
        "plaintext",
        1,
        "doc-b",
        "a.md",
        edit,
        &lineage,
    );
    let queued = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(
        queued.held,
        BTreeMap::from([("doc-b".to_owned(), HostedHold::LiveEditUnadmitted)])
    );
    assert!(queued.refusals.is_empty());
    drop(store);

    let mut store = EngineStore::open(&path, 3_000).unwrap();
    assert_eq!(hold(&store, "doc-b"), Some(HostedHold::LiveEditUnadmitted));
    sync(&client, &mut store);
    let again = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(
        again.held,
        BTreeMap::from([("doc-b".to_owned(), HostedHold::LiveEditUnadmitted)])
    );
    assert!(commit(&client, &mut store, &again));
    assert_eq!(hold(&store, "doc-b"), Some(HostedHold::LiveEditUnadmitted));
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM replication_refused_ydoc_blobs"
        ),
        0
    );
    assert_eq!(queued_b(&store), r#"[["peer",1,"hosted","relay"]]"#);
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b")]));

    release_b(&mut store);
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b and more")]));
    assert_eq!(queued_b(&store), "[]");
}

#[test]
fn an_echo_queued_behind_an_unadmitted_edit_applies_once_after_release() {
    let (_scratch, _path, mut store, client, base, echo, lineage) = ready_bound_richdoc_b();
    let peer = dohc_engine_collab::Ydoc::wire();
    peer.apply(&base).unwrap();
    let edit = peer.richdoc_append_paragraph("unseen");
    // The edit and the echo are concurrent, so their client IDs order them.
    peer.apply(&echo).unwrap();
    let merged = peer
        .project(dohc_engine_collab::ContentKind::Richdoc)
        .unwrap()
        .content;
    peer_update(
        client.transport(),
        "richdoc",
        1,
        "doc-b",
        "a.md",
        edit,
        &lineage,
    );
    sync(&client, &mut store);
    assert_eq!(hold(&store, "doc-b"), Some(HostedHold::LiveEditUnadmitted));
    queue_b(&mut store, 2, 100, "richdoc", &echo, &lineage);
    let before = content(&store);
    for _ in 0..2 {
        assert_eq!(drained_again(&mut store), Vec::<String>::new());
        let outcome = pass(&client, &mut store, &NoFaults).unwrap();
        assert_eq!(
            outcome.held,
            BTreeMap::from([("doc-b".to_owned(), HostedHold::LiveEditUnadmitted)])
        );
        assert!(commit(&client, &mut store, &outcome));
    }
    assert_eq!(
        queued_b(&store),
        r#"[["peer",1,"hosted","relay"],["peer",2,"hosted","relay"]]"#
    );
    assert_eq!(content(&store), before);

    release_b(&mut store);
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(queued_b(&store), "[]");
    let applied = content(&store);
    assert_eq!(applied.0["doc-b"], merged);
    assert_eq!(
        (
            merged.matches("unseen").count(),
            merged.matches("accepted").count()
        ),
        (1, 1),
        "{merged}"
    );
    sync(&client, &mut store);
    assert_eq!(content(&store), applied);
}

/// Parking: the reply to the host's push of `doc-b`'s row is lost after the
/// relay recorded it. `doc-b` cannot park while its row looks unpushed; the
/// next push is acknowledged, `doc-b` parks, and its return skips the row as
/// its own.
#[test]
fn a_lost_push_reply_holds_parking_until_the_retry_is_acknowledged() {
    let (_scratch, _path, mut store, client) = departing_b();
    let feed = client.transport();
    assert_eq!(journal_live_update(&mut store, "doc-b", b"live b"), 0);
    let push = |store: &mut EngineStore| {
        client.push_workspace(store, "ws", &NoFaults, &NoLiveLeases, 3_000, 1_000_000)
    };
    feed.lose_push_reply.store(true, Ordering::SeqCst);
    assert!(push(&mut store).is_err());
    assert_eq!(read_pushed_seq(&store, "ws", HOST).unwrap(), -1);

    feed.unshare("doc-b");
    sync_parking(&client, &mut store);
    assert!(!hosted_document_parkable(&store, "ws", "doc-b").unwrap());
    assert_eq!(departed_hosted_object_ids(&store, "ws").unwrap(), ["doc-b"]);

    push(&mut store).unwrap();
    assert_eq!(read_pushed_seq(&store, "ws", HOST).unwrap(), 0);
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));
    let journal = coordinates(&store);

    feed.share("doc-b", "a.md");
    sync_parking(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(coordinates(&store), journal, "its own row skips");
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b")]));
}

fn released_binding(
    object_id: &str,
    path: &str,
    relay_seq: i64,
) -> dohc_engine_collab::live_update_application::ReleasedLineageBinding {
    use dohc_engine_collab::live_update_application::{
        IncomingCoordinate, ProtectedTails, ReleasedLineageBinding,
    };
    ReleasedLineageBinding {
        workspace_id: "ws".into(),
        main_version_id: "main".into(),
        object_id: object_id.into(),
        lineage_claim_id: "a".repeat(64),
        current_path: Some(path.into()),
        restore_generation: Some(0),
        incoming: IncomingCoordinate {
            relay_namespace: Some("relay".into()),
            replication_epoch: "epoch-1".into(),
            stream_identity: "stream-1".into(),
            origin_id: "peer".into(),
            origin_seq: 3,
            relay_seq,
        },
        head_digest: "b".repeat(64),
        tails: std::sync::Arc::new(ProtectedTails::Invalid),
    }
}

fn queue_update(store: &mut EngineStore, object_id: &str, origin_id: &str, origin_seq: i64) {
    let key = dohc_engine_collab::DocKey {
        workspace_id: "ws".to_owned(),
        version_id: "main".to_owned(),
        object_id: object_id.to_owned(),
    };
    let op = envelope(
        origin_id,
        origin_seq,
        "ydoc.update",
        json!({ "objectId": object_id }),
    );
    store
        .write_with(&NoFaults, |tx| {
            crate::ydoc_apply::defer_ydoc_update_in_tx(
                tx,
                &key,
                &op,
                &"a".repeat(64),
                8,
                Some("relay"),
            )
        })
        .unwrap();
}

/// Hold `doc-a` for released retained work with a binding that names the
/// update at peer 3.
fn hold_doc_a(store: &mut EngineStore) -> HostedHold {
    let binding = released_binding("doc-a", "a.md", 8);
    store
        .write_with(&NoFaults, |tx| {
            crate::hosted::hold_released_in_tx(
                tx,
                &binding,
                crate::ReleasedHoldContinuation::Frozen,
                false,
            )
        })
        .unwrap();
    HostedHold::ReleasedLineageUnsettled {
        binding: Box::new(binding),
        continuation: crate::ReleasedHoldContinuation::Frozen,
        binding_stale: false,
    }
}

/// While a drain's frozen hold stands on its queued update, the next op of
/// its document that nothing retains stays in the feed: the pass journals
/// none of it, queues nothing behind the hold, and reports the hold it
/// found. With a lineage established, the end-of-pass drain examines the
/// document too, and one that decides nothing of the held update leaves the
/// hold standing rather than clearing it.
#[test]
fn a_frozen_hold_stops_its_document_before_the_next_op_and_leaves_it_in_the_feed() {
    for established in [false, true] {
        a_frozen_hold_stops_its_document(established);
    }
}

fn a_frozen_hold_stops_its_document(established: bool) {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-a", "a.md", "first");
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    if established {
        establish_lineage(&mut store, "doc-a");
    }
    queue_update(&mut store, "doc-a", "peer", 3);
    let hold = hold_doc_a(&mut store);
    client.transport().replace(
        "owner",
        2,
        "doc-a",
        "a.md",
        "edited",
        ("doc-a", "first", "moment-owner-1"),
    );
    // A drain that decides nothing of the held update derives no binding,
    // so the hold it leaves standing claims no currency.
    let hold = if established { hold.stale() } else { hold };
    let outcome = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(outcome.held.get("doc-a"), Some(&hold), "{outcome:?}");
    let arrived = "SELECT COUNT(*) FROM replication_log WHERE origin_id='owner' AND origin_seq=2";
    assert_eq!(count(&store, arrived), 0, "the op stays in the feed");
    assert_eq!(
        count(&store, "SELECT COUNT(*) FROM ydoc_deferred_updates"),
        1,
        "nothing queues behind the hold"
    );
    assert_eq!(count(&store, "SELECT COUNT(*) FROM relay_deferred_ops"), 0);
}

/// Give `object_id` a Y.Doc lineage a base established, so its queued
/// updates are work the replica owes rather than updates waiting for a base.
fn establish_lineage(store: &mut EngineStore, object_id: &str) {
    let key = dohc_engine_collab::DocKey::new("ws", "main", object_id).unwrap();
    let base = dohc_engine_collab::Ydoc::wire();
    base.plaintext_insert(0, "first");
    dohc_engine_collab::claim_base(
        store,
        &key,
        dohc_engine_collab::ContentKind::Plaintext,
        &base.encode_full_state(),
        &NoFaults,
        1_000,
    )
    .unwrap();
}

#[test]
fn a_released_hold_for_a_document_the_replica_does_not_host_stores_nothing() {
    let (_scratch, _path, mut store) = hosted_store();
    let before = read_hosted_replica(&store, "ws").unwrap().unwrap();
    let stored = store
        .write_with(&NoFaults, |tx| {
            crate::hosted::hold_released_in_tx(
                tx,
                &released_binding("absent", "absent.md", 8),
                crate::ReleasedHoldContinuation::Frozen,
                false,
            )
        })
        .unwrap();
    assert!(matches!(stored, TxnOutcome::Committed(false)));
    assert_eq!(read_hosted_replica(&store, "ws").unwrap().unwrap(), before);
}

fn total_changes(store: &EngineStore) -> u64 {
    store
        .read_with(|conn| Ok::<_, SyncError>(conn.total_changes()))
        .unwrap()
}

fn confirm(client: &RelaySyncClient<HostedFeed>, store: &EngineStore) -> Result<(), RelayError> {
    let before = (
        client.transport().pushes.lock().unwrap().len(),
        total_changes(store),
    );
    let confirmed = client.confirm_hosted_origin(store, "ws");
    let pushes = client.transport().pushes.lock().unwrap();
    assert_eq!(pushes.len(), before.0 + 1, "one push to the hosted log");
    let probe = pushes.last().unwrap();
    assert_eq!(
        (probe.origin_id.as_str(), probe.after_seq, probe.ops.len()),
        (HOST, -1, 0)
    );
    assert_eq!(total_changes(store), before.1, "the probe writes nothing");
    confirmed
}

#[test]
fn the_origin_probe_refuses_a_relay_past_what_the_replica_numbered() {
    let (_scratch, _path, store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    client.transport().append(envelope(
        HOST,
        0,
        "ydoc.update",
        json!({"objectId": "doc-a"}),
    ));
    assert!(matches!(
        confirm(&client, &store),
        Err(RelayError::OriginDiverged)
    ));
}

/// Copy the store's files, as an operator restoring an older volume would
/// have kept them.
fn copy_store(from: &std::path::Path, to: &std::path::Path) {
    for suffix in ["", "-wal", "-shm"] {
        let source = std::path::PathBuf::from(format!("{}{suffix}", from.display()));
        let target = std::path::PathBuf::from(format!("{}{suffix}", to.display()));
        if source.exists() {
            std::fs::copy(&source, &target).unwrap();
        } else if target.exists() {
            std::fs::remove_file(&target).unwrap();
        }
    }
}

/// A store is restored from a copy older than its last push. The feed serves
/// the host's own rows back, so one pull imports them and the journal's
/// maximum climbs to the relay's, which hides the loss from a push. The
/// counter still says what this store numbered.
#[test]
fn the_origin_probe_finds_commits_a_restored_store_lost_after_a_pull() {
    let (_scratch, path, store, client) = departing_b_at("doc-b.md");
    drop(store);
    let copy = ScratchDir::new().unwrap();
    let saved = copy.path().join("engine.db");
    copy_store(&path, &saved);

    let mut store = EngineStore::open(&path, 2_000).unwrap();
    journal_live_update(&mut store, "doc-b", b"lost one");
    journal_live_update(&mut store, "doc-b", b"lost two");
    client
        .push_workspace(&mut store, "ws", &NoFaults, &NoLiveLeases, 3_000, 1_000_000)
        .unwrap();
    sync(&client, &mut store);
    confirm(&client, &store).unwrap();
    drop(store);

    copy_store(&saved, &path);
    let mut store = EngineStore::open(&path, 4_000).unwrap();
    assert_eq!(last_outbound_seq(&store), -1);
    sync(&client, &mut store);
    assert_eq!(
        crate::relay::local_max_origin_seq(&store, "ws", HOST).unwrap(),
        1,
        "the pull imported the lost rows"
    );
    assert!(matches!(
        confirm(&client, &store),
        Err(RelayError::OriginDiverged)
    ));
}

fn ydoc_base(feed: &HostedFeed, object_id: &str, path: &str, text: &str) {
    let ydoc = dohc_engine_collab::Ydoc::wire();
    ydoc.plaintext_insert(0, text);
    let base = ydoc.encode_full_state();
    let base_sha = dohc_engine_storage::hex_sha256(&base);
    feed.blobs.lock().unwrap().insert(base_sha.clone(), base);
    feed.append(envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": object_id,
            "path": path,
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha,
            "lineageClaimId": base_sha,
            "isBaseState": true
        }),
    ));
}

/// [`ready_bound_b`] for a richdoc `doc-b` at `base`, whose session admitted
/// `echo`, a later edit of its lineage the replica has not pulled.
#[allow(clippy::type_complexity)]
fn ready_bound_richdoc_b() -> (
    ScratchDir,
    std::path::PathBuf,
    EngineStore,
    RelaySyncClient<HostedFeed>,
    Vec<u8>,
    Vec<u8>,
    String,
) {
    let (scratch, path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    let ydoc = dohc_engine_collab::Ydoc::wire();
    ydoc.richdoc_append_paragraph("hosted b");
    let base = ydoc.encode_full_state();
    let lineage = dohc_engine_storage::hex_sha256(&base);
    peer_update(feed, "richdoc", 0, "doc-b", "a.md", base.clone(), &lineage);
    feed.share("doc-b", "a.md");
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    let echo = ydoc.richdoc_append_paragraph("accepted");
    accept_live_update(&mut store, "doc-b", &lineage, &echo);
    (scratch, path, store, client, base, echo, lineage)
}

fn queue_b(
    store: &mut EngineStore,
    seq: i64,
    relay_seq: i64,
    kind: &str,
    update: &[u8],
    lineage: &str,
) {
    let sha = store.put_binary_blob(update).unwrap();
    let key = dohc_engine_collab::DocKey::new("ws", "main", "doc-b").unwrap();
    let op = envelope(
        "peer",
        seq,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "doc-b",
            "path": "a.md",
            "contentKind": kind,
            "updateBlobSha256": sha,
            "lineageClaimId": lineage,
            "isBaseState": false
        }),
    );
    crate::apply_envelope_with(store, &op, &NoFaults, |tx, op| {
        crate::ydoc_apply::defer_ydoc_update_in_tx(tx, &key, op, lineage, relay_seq, Some("relay"))
    })
    .unwrap();
}

/// The documents the end-of-pass drain takes up again now.
fn drained_again(store: &mut EngineStore) -> Vec<String> {
    crate::ydoc_apply::drain_released_holds(
        store,
        &mut WriterDocCache::new(),
        "ws",
        &BTreeMap::new(),
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap()
    .holds
    .into_keys()
    .collect()
}
