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

/// The durability review: a local-only workspace with work in it became a
/// hosted replica, which then refuses every write to that work. Neither has
/// a sync identity, so only the work refuses it.
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
    crate::deferred::retain(
        &mut store,
        &identity,
        Some("relay"),
        &[&early, &late],
        &NoFaults,
    )
    .unwrap();
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
    let at_zero = document_op(4, 0, "doc-a");
    for refused in [op(9, "names no document"), unplaced, at_zero] {
        assert!(
            crate::deferred::retain(&mut store, &identity, Some("relay"), &[&refused], &NoFaults)
                .is_err(),
            "a hosted replica retains its documents' work at its relay position"
        );
    }
}

/// The feed each retained op and deferred Y.Doc update of `store` recorded,
/// by origin sequence: its ingress kind, namespace, epoch and stream.
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

/// Defer a Y.Doc update of `doc` at `seq` as a pull under `namespace` does.
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

/// A hosted replica records, with each op it retains and each Y.Doc update
/// it defers, the feed it arrived on: the trusted namespace, its epoch and
/// stream, and a relay position from 1. Work no namespace names, or with no
/// relay position, is retained nowhere, and retaining it fails rather than
/// stopping there quietly. A later configuration never relabels what is
/// queued, and a restart reads the same feed back.
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

    // The trusted configuration now names another namespace.
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

/// An ordinary replica's deferrals are local, and need no feed.
#[test]
fn ordinary_deferrals_are_local() {
    let (_scratch, _path, mut store) = open_store();
    defer_update(&mut store, 1, 5, None).unwrap();
    assert_eq!(
        recorded_feeds(&store),
        [("ydoc:-/-".to_owned(), 1, "local".to_owned(), None)]
    );
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
/// token it serves nothing and keeps the cursor. It reads above
/// `epoch_log_floor`, as the relay does after an epoch rotation.
struct HostedFeed {
    log: Mutex<Vec<ReplicationEnvelope>>,
    epoch_log_floor: AtomicI64,
    shared: Mutex<BTreeMap<String, String>>,
    revision: AtomicUsize,
    blobs: Mutex<BTreeMap<String, Vec<u8>>>,
    raw_rows_per_page: AtomicUsize,
    /// Shares a document just before answering the pull with this count.
    share_at_pull: Mutex<Option<(usize, String, String)>>,
    pulls: Mutex<Vec<HostedPullRequest>>,
    pushes: Mutex<Vec<PushRequest>>,
    /// Documents whose new host ops the relay refuses, each kept as a refusal at its coordinate.
    refusing: Mutex<BTreeSet<String>>,
    /// Corrupts each push response after the relay recorded the batch.
    garble: Mutex<Option<fn(&mut PushResponse)>>,
    /// Loses the reply to the next push after the relay recorded its batch.
    lose_push_reply: AtomicBool,
    /// Every blob a download asked for.
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
            share_at_pull: Mutex::new(None),
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

    /// A rename of `object_id`, holding `text`, from `from` to `to`. Its
    /// before side is the object's own head, last written by `before_moment_id`.
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

/// Whether `object_id` is parked: its row says so, and its heads and path
/// aliases are in the parked tables and nowhere else.
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
    let (_scratch, path, mut store) = hosted_store();
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
            status: HostedDocumentStatus::Backfilling,
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
fn a_scope_change_mid_pass_drops_what_the_pass_fetched() {
    let (_scratch, _path, mut store) = hosted_store();
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
    assert!(!ready(&store, "doc-b"));
}

#[test]
fn a_pass_fetched_under_an_older_scope_cannot_commit() {
    let (_scratch, _path, mut store) = hosted_store();
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

/// What a pass applied stays unwritten for its document until a committed
/// read covers it, so a document that leaves the scope first finishes it
/// before it parks: every decision its journal stored, and its head. One
/// whose files a committed pass wrote has nothing to finish, and a parked
/// one has nothing left.
#[test]
fn a_document_finishes_on_parking_only_what_no_commit_wrote() {
    let (_scratch, path, mut store) = hosted_store();
    let client = RelaySyncClient::new(hosted_feed());
    let finish = |store: &EngineStore| {
        departed_hosted_materialization(store, "ws", "doc-a", "main")
            .unwrap()
            .map(|page| {
                page.into_iter()
                    .map(|change| change.path)
                    .collect::<Vec<_>>()
            })
    };
    sync(&client, &mut store);
    assert_eq!(
        finish(&store),
        None,
        "the commit that made it ready wrote it"
    );

    let feed = client.transport();
    feed.rename(
        "owner",
        4,
        "doc-a",
        "a.md",
        "c.md",
        "hosted a",
        "moment-owner-1",
    );
    assert_eq!(pass(&client, &mut store, &NoFaults).unwrap().applied, 1);
    drop(store);
    let mut store = EngineStore::open(&path, 3_000).unwrap();
    assert_eq!(
        finish(&store),
        Some(vec!["a.md".to_owned(), "c.md".to_owned()])
    );
    sync(&client, &mut store);
    assert_eq!(finish(&store), None, "a commit that read it again wrote it");

    feed.rename(
        "owner",
        5,
        "doc-a",
        "c.md",
        "d.md",
        "hosted a",
        "moment-owner-4",
    );
    assert_eq!(pass(&client, &mut store, &NoFaults).unwrap().applied, 1);
    feed.unshare("doc-a");
    assert_eq!(
        pass(&client, &mut store, &NoFaults).unwrap().pending_cursor,
        None
    );
    assert_eq!(
        finish(&store),
        Some(vec![
            "a.md".to_owned(),
            "c.md".to_owned(),
            "d.md".to_owned()
        ])
    );
    assert_eq!(
        park_hosted_document(&mut store, "ws", "doc-a", "main", &NoFaults).unwrap(),
        TxnOutcome::Committed(true)
    );
    assert_eq!(finish(&store), None);
}

/// The slice-2 re-review's reproduction: after an epoch rotation the feed
/// reads above the old log, so it never serves `workspace.init` again. A
/// replica created then holds `main` from its creation. Rotation leaves the
/// old epoch's enrollments, so `doc-a` is out of the scope.
#[test]
fn a_hosted_replica_created_after_an_epoch_rotation_needs_no_workspace_init() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = hosted_feed();
    feed.unshare("doc-a");
    feed.epoch_log_floor.store(4, Ordering::SeqCst);
    feed.create("owner-2", 0, "doc-c", "c.md", "after rotation");
    feed.share("doc-c", "c.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);

    assert!(ready(&store, "doc-c"));
    let (heads, moments) = content(&store);
    assert_eq!(
        heads,
        BTreeMap::from([("doc-c".to_owned(), "after rotation".to_owned())])
    );
    assert!(moments.values().all(|count| *count == 1));
    assert_eq!(coordinates(&store), [("owner-2".to_owned(), 0)]);
    assert_eq!(replica(&store).main_cursor, 5);
}

/// Models a feed no relay produces after a rotation: `doc-a` stays in scope
/// although every row of it is below the floor. It is held at no path, and
/// only the document written above the floor is materialized.
#[test]
fn a_document_in_scope_with_every_row_below_the_floor_is_held_at_no_path() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = hosted_feed();
    feed.epoch_log_floor.store(4, Ordering::SeqCst);
    feed.create("owner-2", 0, "doc-c", "c.md", "after rotation");
    feed.share("doc-c", "c.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);

    assert_eq!(
        hold(&store, "doc-a"),
        Some(HostedHold::ScopePathMismatch {
            scope_path: "a.md".to_owned(),
            head_path: None
        })
    );
    assert_eq!(
        content(&store).0,
        BTreeMap::from([("doc-c".to_owned(), "after rotation".to_owned())])
    );
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

/// The feed answers a page whose scan passed only withheld rows with no ops
/// and a moved cursor, on the main feed and in a backfill.
#[test]
fn a_page_of_only_withheld_rows_moves_the_cursor() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.create("owner", 0, "private", "private.md", "private");
    feed.create("owner", 1, "doc-a", "a.md", "hosted a");
    feed.create("owner", 2, "private", "private.md", "private again");
    feed.share("doc-a", "a.md");
    feed.raw_rows_per_page.store(1, Ordering::SeqCst);
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);

    let cursors = |object_id: Option<&str>| {
        client
            .transport()
            .pull_requests()
            .iter()
            .filter(|request| request.scope_token.is_some())
            .filter(|request| request.object_id.as_deref() == object_id)
            .map(|request| request.cursor)
            .collect::<Vec<_>>()
    };
    assert_eq!(cursors(Some("doc-a")), [0, 1, 2]);
    assert_eq!(cursors(None), [0, 1, 2]);
    assert!(ready(&store, "doc-a"));
    assert_eq!(
        content(&store).0,
        BTreeMap::from([("doc-a".to_owned(), "hosted a".to_owned())])
    );
    assert_eq!(coordinates(&store), [("owner".to_owned(), 1)]);
    assert_eq!(replica(&store).main_cursor, 3);
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
        "the removed document's work waits for it to park"
    );
    assert!(park(&mut store));
    assert_eq!(retained(&store), 0, "parking releases it");
    assert_eq!(holding(&store, "gone"), ["hosted_documents"]);
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
        Some("relay"),
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
    let (_scratch, _path, mut store) = hosted_store();
    let (parent, child, result_sha) = withheld_conflict(&mut store);
    assert_conflict_child_hold_parity(&mut store, parent, child, result_sha);
}

#[test]
fn a_text_keep_without_lineage_holds_like_an_incoming_resolution() {
    let (_scratch, _path, mut store) = hosted_store();
    let (parent, _, result_sha) = withheld_conflict(&mut store);
    let context = crate::conflict_resolve_v1::ConflictResolveEnvelopeContext {
        workspace_id: "ws",
        recorded_at_ms: 21,
    };
    let mut payload =
        crate::conflict_resolve_v1::validate_conflict_resolve_v1(&parent.payload, context)
            .unwrap()
            .payload;
    payload.chosen_from = crate::conflict_resolve_v1::ResolveChoiceV1::Current;
    payload.resolution = crate::conflict_resolve_v1::ResolutionV1::KeptCurrent;
    payload.current = payload.result.clone();
    if let crate::conflict_resolve_v1::HeadV1::Present(head) = &mut payload.current {
        head.latest_moment_id = "owner-before".to_owned();
        head.updated_at_ms = 20;
    }
    payload.incoming = crate::conflict_resolve_v1::HeadV1::Absent { path_ref: 0 };
    payload.effect_context.current_object_created_at_ms = Some(20);
    assert!(payload.lineage_transition.is_none());
    let built = crate::conflict_resolve_v1::build_conflict_resolve_v1(payload).unwrap();
    let mut parent = envelope("owner", 0, "conflict.resolve", built.value);
    parent.recorded_at_ms = 21;
    let mut child = envelope(
        "owner",
        1,
        "moment.append",
        built.validated.shadows[0].clone(),
    );
    child.recorded_at_ms = 21;
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1, &NoFaults)
        .unwrap();
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: "hosted-object".to_owned(),
                path: "hosted.md".to_owned(),
                text: "resolved by the owner".to_owned(),
                moment_id: "owner-before".to_owned(),
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 20,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
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

    // The parent arrives (5b projects it); the held document resumes in order.
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

/// What holds a document at the child of [`withheld_conflict`].
fn parent_withheld() -> HostedHold {
    HostedHold::ConflictParentWithheld {
        conflict_id: "owner-conflict".to_owned(),
    }
}

/// The durability review: a ready document's conflict child whose parent the
/// feed withholds was retained, with every later row of its document behind
/// it, until retained work reached its workspace-wide cap and every pass
/// failed. The document is held at the child instead, naming the conflict,
/// and retains nothing; another document syncs past the cap.
#[test]
fn a_ready_document_holds_at_a_withheld_conflict_parent_and_retains_nothing() {
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
    feed.share("hosted-object", "hosted.md");
    feed.share("other-object", "other.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    assert!(ready(&store, "hosted-object"));

    let feed = client.transport();
    feed.append(child);
    let child_seq = feed.log.lock().unwrap().len() as i64;
    // More live rows of the document than the cap on retained work.
    for seq in 0..10_001 {
        feed.append(envelope(
            "live",
            seq,
            "live.audit.application",
            json!({"objectId": "hosted-object"}),
        ));
    }
    feed.create("peer", 1, "other-object", "other.md", "independent");
    sync(&client, &mut store);
    assert_eq!(hold(&store, "hosted-object"), Some(parent_withheld()));
    assert_eq!(retained(&store), 0);
    assert_eq!(
        document(&store, "hosted-object").unwrap().backfill_cursor,
        child_seq - 1,
        "its own read starts at the child"
    );
    assert!(ready(&store, "other-object"));
    assert_eq!(
        content(&store).0.get("other-object").map(String::as_str),
        Some("independent")
    );

    let again = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(again.held.get("hosted-object"), Some(&parent_withheld()));
    assert!(
        client
            .transport()
            .pull_requests()
            .iter()
            .rev()
            .any(
                |request| request.object_id.as_deref() == Some("hosted-object")
                    && request.cursor == child_seq - 1
            )
    );
}

/// Sol's review of the hold above: a ready document's moment waited behind a
/// live editor, retaining the conflict child and the rows behind it. Once
/// the editor closed, replay applied the moment and held the document at the
/// child, but its retained rows stayed, counting against the workspace's cap
/// though they could never apply. The hold releases them, and its own read
/// starts before the child.
#[test]
fn a_held_document_releases_the_work_it_retained_while_ready() {
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
    feed.share("hosted-object", "hosted.md");
    feed.share("other-object", "other.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    assert!(ready(&store, "hosted-object"));

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
    for seq in 0..3 {
        feed.append(envelope(
            "live",
            seq,
            "live.audit.application",
            json!({"objectId": "hosted-object"}),
        ));
    }
    hydrated(&mut store, &["edited live".to_owned()]);
    retain_behind_closed_editor(&client, &mut store, moment);
    fill_retained(&mut store, "hosted-object", child_seq + 4, 9_995);
    assert_eq!(retained(&store), 10_000);

    sync(&client, &mut store);
    assert_eq!(
        content(&store).0.get("hosted-object").map(String::as_str),
        Some("edited live"),
        "the moment the editor held applied"
    );
    assert_eq!(hold(&store, "hosted-object"), Some(parent_withheld()));
    assert_eq!(retained(&store), 0, "the held document retains nothing");
    assert_eq!(
        document(&store, "hosted-object").unwrap().backfill_cursor,
        child_seq - 1,
        "its own read starts at the child"
    );
    let again = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(again.held.get("hosted-object"), Some(&parent_withheld()));
    assert!(
        client
            .transport()
            .pull_requests()
            .iter()
            .rev()
            .any(
                |request| request.object_id.as_deref() == Some("hosted-object")
                    && request.cursor == child_seq - 1
            )
    );

    let other = [
        document_op(0, child_seq + 10_000, "other-object"),
        document_op(1, child_seq + 10_001, "other-object"),
    ];
    let identity = read_sync_identity(&store, "ws").unwrap().unwrap();
    assert!(
        crate::deferred::retain(
            &mut store,
            &identity,
            Some("relay"),
            &[&other[0], &other[1]],
            &NoFaults
        )
        .unwrap()
        .is_empty(),
        "another document retains work under the freed cap"
    );
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

/// Sol's review of the release above: the cap was full of a ready
/// document's retained work, ending at a conflict child whose parent the
/// feed withholds. Its editor closed while another document's moment waited
/// behind that document's open editor. Replay applied the first document's
/// moment and stopped at the child, but retaining the other's moment passed
/// the cap, so the pass failed before the commit that releases the first
/// document's work, and so did every later pass. The other document is held
/// at its moment instead, retaining nothing, and the pass commits. Once its
/// editor closes, the moment applies and it is ready.
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

    // The other editor closed.
    sync(&client, &mut store);
    assert!(ready(&store, "other-object"));
    assert_eq!(content(&store).0["other-object"], "other edited");
    assert_eq!(hold(&store, "hosted-object"), Some(parent_withheld()));
    assert_eq!(retained(&store), 0);
}

/// Opus's review: a read that stops below its document's read position, with
/// no released work to explain it, would skip the row it stopped at. Commit
/// refuses it and changes nothing.
#[test]
fn a_read_stopping_before_its_document_position_is_refused() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 2, "workspace.init", json!({})));
    feed.create(
        "peer",
        0,
        "hosted-object",
        "hosted.md",
        "before the conflict",
    );
    feed.share("hosted-object", "hosted.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    let before = document(&store, "hosted-object").unwrap();
    assert!(before.backfill_cursor > 0);

    let mut outcome = pass(&client, &mut store, &NoFaults).unwrap();
    let pending = outcome.pending_cursor.as_mut().unwrap();
    pending.reads.insert(
        "hosted-object".to_owned(),
        crate::HostedRead {
            cursor: before.backfill_cursor - 1,
            stopped: Some(parent_withheld()),
            complete: false,
            heads_written: false,
        },
    );
    assert!(matches!(
        crate::commit_hosted_cursor(
            &mut store,
            "ws",
            pending,
            &ReleasedTails::uncached(),
            &NoFaults
        ),
        Err(SyncError::InvalidInput {
            reason: crate::hosted::STOPPED_BEFORE_READ
        })
    ));
    assert_eq!(document(&store, "hosted-object"), Some(before));
}

#[test]
fn live_writes_journal_and_push_under_the_service_host_origin() {
    let (_scratch, _path, mut store) = hosted_store();
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
    let mut progress = PushWorkspaceProgress::default();
    let outcome = client
        .resume_push_workspace(
            &mut store,
            "ws",
            &NoFaults,
            &NoLiveLeases,
            3_000,
            1_000_000,
            &mut progress,
        )
        .unwrap();
    assert!(matches!(
        outcome,
        SyncPassOutcome::Complete { pushed: 2, .. }
    ));
    assert!(
        !progress.writer_cache_reset_required(),
        "a hosted push claims no local bases, so live sessions keep their documents"
    );
    let pushes = client.transport().pushes.lock().unwrap().clone();
    assert_eq!(pushes.len(), 1, "one batch to the hosted log, and no probe");
    assert_eq!(pushes[0].origin_id, HOST);
    assert_eq!(read_pushed_seq(&store, "ws", HOST).unwrap(), 1);
}

/// Journal one live Y.Doc update to a hosted document under the host's origin.
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

/// A document that leaves the share takes its blobs out of the host's reach,
/// so the relay reports them missing even after the host uploaded them. Each
/// push asks again and uploads them, so the drain lands.
#[test]
fn each_hosted_push_uploads_what_the_relay_reports_missing() {
    let (_scratch, _path, mut store) = hosted_store();
    host_document(&mut store, "doc-a");
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    let push = |store: &mut EngineStore| {
        client
            .push_workspace(store, "ws", &NoFaults, &NoLiveLeases, 3_000, 1_000_000)
            .unwrap()
    };
    let update = b"drained update";
    let sha = dohc_engine_storage::hex_sha256(update);
    journal_live_update(&mut store, "doc-a", update);
    assert!(matches!(
        push(&mut store),
        SyncPassOutcome::Complete { pushed: 1, .. }
    ));
    assert!(feed.blobs.lock().unwrap().contains_key(&sha));

    feed.blobs.lock().unwrap().clear();
    journal_live_update(&mut store, "doc-a", update);
    assert!(matches!(
        push(&mut store),
        SyncPassOutcome::Complete { pushed: 1, .. }
    ));
    assert_eq!(
        feed.blobs.lock().unwrap().get(&sha).map(Vec::as_slice),
        Some(update.as_slice())
    );
    assert_eq!(read_pushed_seq(&store, "ws", HOST).unwrap(), 1);
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

/// Rolls back the first transaction that ends after the relay answered another push.
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

    // The relay decides every coordinate, then the host stops before recording them.
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

    // The retry gets the same decisions, and the transaction recording them
    // fails after writing them: it keeps neither them nor the cursor.
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

    // The retry gets the first decisions back and records each once.
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
    // Then a pass with nothing left to push reports nothing again.
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

    // Later work lands past the refused coordinate.
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

    // Neither a probe nor a share log push refuses an op.
    let unrefused = PushResponse {
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
        accepted: 0,
        inserted: 0,
        ..unrefused
    };
    assert_eq!(crate::relay::validate_probe_response(&probe), Ok(()));
    assert_eq!(
        crate::relay::validate_probe_response(&PushResponse {
            hosted_refusals: valid.hosted_refusals.clone(),
            ..probe
        }),
        Err(RelayError::InvalidResponse)
    );

    // Recording takes only this hosted replica's own journaled ops.
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

#[test]
fn a_hosted_push_whose_refusals_name_ops_outside_its_batch_keeps_nothing() {
    let (_scratch, _path, mut store) = hosted_store();
    host_document(&mut store, "doc-a");
    host_document(&mut store, "doc-b");
    journal_live_update(&mut store, "doc-a", b"a one");
    journal_live_update(&mut store, "doc-b", b"b one");
    let garbles: [fn(&mut PushResponse); 2] = [
        // An op the batch does not hold.
        |response| {
            let mut other = response.hosted_refusals[0].clone();
            other.origin_seq = 7;
            response.hosted_refusals.push(other);
        },
        // The same op twice.
        |response| {
            let again = response.hosted_refusals[0].clone();
            response.hosted_refusals.push(again);
        },
    ];
    for garble in garbles {
        let client = RelaySyncClient::new(HostedFeed::new());
        let feed = client.transport();
        feed.refusing.lock().unwrap().insert("doc-b".to_owned());
        *feed.garble.lock().unwrap() = Some(garble);
        assert_eq!(
            client
                .push_workspace(&mut store, "ws", &NoFaults, &NoLiveLeases, 3_000, 1_000_000)
                .unwrap_err(),
            RelayError::InvalidResponse
        );
        assert_eq!(feed.pushes.lock().unwrap().len(), 1);
        assert_eq!(read_pushed_seq(&store, "ws", HOST).unwrap(), -1);
        assert!(recorded_refusals(&store).is_empty());
    }
}

#[test]
fn ordinary_only_machinery_stays_off_a_hosted_replica() {
    let (_scratch, _path, mut store) = hosted_store();
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
        ordinary_pull: None,
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

/// `doc-b` is hosted at `a.md` and synced.
fn departing_b() -> (
    ScratchDir,
    std::path::PathBuf,
    EngineStore,
    RelaySyncClient<HostedFeed>,
) {
    departing_b_at("a.md")
}

/// `doc-b` is hosted at `at` and synced.
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

/// `doc-b` leaves the scope, and `doc-a` replaces it at `a.md`.
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

/// The slice-3 re-review's first finding: clearing `a.md` for `doc-a` dropped
/// the head `doc-b`'s unsettled work still needed. `doc-a`'s moments now
/// wait, in order, until `doc-b` parks, and then apply as a create and its
/// edit. `doc-b` keeps its history and bytes, and holds no path.
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

/// Accepted live `update` of `object_id` on `lineage`, as
/// [`accept_live_work`] records it.
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

/// The settlement of `object_id`'s accepted work through journal cursor 7.
fn settle_live_work(store: &mut EngineStore, object_id: &str) {
    settle_live_lineage(store, object_id, "lineage");
}

/// The settlement of `object_id`'s accepted work on `lineage` through
/// journal cursor 7.
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

/// The slice-3 re-review's first reproduction: `doc-b` has accepted,
/// unsettled live work when the scope moves to `doc-a`. `doc-b` keeps its
/// head until that work settles and the relay holds every row the host wrote
/// for it; only then does it park and `doc-a` take the path. Parking keeps
/// its accepted work and every row naming it.
#[test]
fn a_departed_document_keeps_its_head_until_its_work_settles() {
    let (_scratch, _path, mut store, client) = departing_b();
    let update = accept_live_work(&mut store, "doc-b");
    for (kind, payload) in [
        ("ydoc.update", json!({"objectId": "doc-b"})),
        ("moment.append", json!({"objectId": "doc-b"})),
        ("live.audit.application", json!({"objectId": "doc-b"})),
        (
            "live.audit.settlement",
            json!({"record": {"binding": {"objectId": "doc-b"}}}),
        ),
        (
            "live.audit.base",
            json!({"record": {"checkpoint": {"binding": {"objectId": "doc-b"}}}}),
        ),
    ] {
        store
            .write_with(&NoFaults, |tx| {
                journal_local_op_in_tx(tx, "ws", kind, &payload, 3_000)
            })
            .unwrap();
    }
    replace_b_with_a(client.transport());

    sync_parking(&client, &mut store);
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b")]));
    assert_eq!(hold(&store, "doc-a"), Some(HostedHold::WorkWaiting));
    assert_eq!(retained(&store), 0, "doc-a waits in its feed");
    assert!(!hosted_document_parkable(&store, "ws", "doc-b").unwrap());

    // The work settles; the rows the host wrote are not acknowledged yet.
    settle_live_work(&mut store, "doc-b");
    sync_parking(&client, &mut store);
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b")]));
    assert!(!hosted_document_parkable(&store, "ws", "doc-b").unwrap());

    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                 VALUES ('ws',?1,4)",
                [HOST],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    sync_parking(&client, &mut store);
    assert_eq!(content(&store).0, heads(&[("doc-a", "hosted a")]));
    assert_eq!(retained(&store), 0);
    assert!(is_parked(&store, "doc-b"));
    let mut kept = vec![
        ("owner".to_owned(), 0),
        ("owner".to_owned(), 1),
        ("owner".to_owned(), 2),
    ];
    kept.extend((0..5).map(|seq| (HOST.to_owned(), seq)));
    assert_eq!(coordinates(&store), kept, "the host's own rows stay too");
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM live_device_application_first_seen"
        ),
        1
    );
    assert!(has_blob(&store, &update));
}

/// Part 5's lifecycle fact: the host releases a document only once it is
/// gone. Parking releases its heads before its file, so the retired file
/// keeps it departed, across a restart, until the file is forgotten.
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

/// A file retired before retired files named their document still goes,
/// but names no departed document.
#[test]
fn a_file_retired_without_its_document_is_removed_but_names_none() {
    let (_scratch, _path, mut store, client) = departing_b();
    client.transport().unshare("doc-b");
    sync(&client, &mut store);
    assert_eq!(
        park_hosted_document(&mut store, "ws", "doc-b", "main", &NoFaults).unwrap(),
        TxnOutcome::Committed(true)
    );
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE hosted_retired_files SET object_id=NULL", [])
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    assert!(departed_hosted_object_ids(&store, "ws").unwrap().is_empty());
    let files = retired_hosted_files(&store, "ws").unwrap();
    assert_eq!(
        files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        ["a.md"]
    );
}

/// Serve a Y.Doc delta of `object_id` at `path` on a lineage the feed never
/// sends a base for, so the replica defers it. Answers its blob.
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

/// Outbox bytes of `object_id` the host accepted and has not delivered.
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

/// Part 5's retirement deadlock: a departed document with a deferred update
/// waited for rows the feed no longer serves. It parks with the update, which
/// its return skips as redelivered, so the update and its bytes stay queued:
/// dropping them would lose the edit. Work the relay served that was never
/// journaled is released, and the return fetches it again. Parking still
/// waits for the host's own undelivered outbox bytes.
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

/// Main's capture holds: a held file's row referenced the document's object,
/// so retiring it failed. The hold, which holds its path, goes when it parks.
#[test]
fn a_capture_hold_does_not_keep_a_departed_document() {
    let (_scratch, _path, mut store, client) = departing_b();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO capture_file_holds VALUES ('ws','main','doc-b','a.md',?1,4, \
                 'ydoc-resolution-not-representable',3,1,0)",
                [text_sha("held")],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    client.transport().unshare("doc-b");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));
    assert_eq!(count(&store, "SELECT COUNT(*) FROM capture_file_holds"), 0);
    assert!(departed_hosted_object_ids(&store, "ws").unwrap().is_empty());
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

/// Sol's retirement review: a file that did not go after its document
/// retired, because the process stopped or the file was locked, stayed
/// forever. Its path now stays held, across a restart, until the file is
/// gone and forgotten; only then does `doc-a`'s waiting write take it.
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

/// Sol's retirement review: retiring a document deleted every conflict that
/// named it, including one another hosted document still needs. `doc-b`'s
/// rename left a conflict against `doc-a` at `b.md`. A parked document keeps
/// its conflicts, with the bytes of both sides, after both documents park.
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

#[test]
fn parking_keeps_every_version_of_its_bytes() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-a", "a.md", "shared text");
    feed.create("owner", 2, "doc-b", "b.md", "shared text");
    feed.replace(
        "owner",
        3,
        "doc-b",
        "b.md",
        "only b",
        ("doc-b", "shared text", "moment-owner-2"),
    );
    feed.share("doc-a", "a.md");
    feed.share("doc-b", "b.md");
    sync(&client, &mut store);

    feed.unshare("doc-b");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));
    assert_eq!(content(&store).0, heads(&[("doc-a", "shared text")]));
    assert!(has_blob(&store, &text_sha("shared text")));
    assert!(has_blob(&store, &text_sha("only b")), "its head's bytes");
}

/// The slice-3 re-review's second finding: a returning document skipped its
/// journaled creation as a redelivery, so the rename fetched after it found
/// no head and opened a conflict. `doc-b` parks after it leaves, and the
/// owner moves it to `b.md`. Its return brings its head back at `a.md`
/// before its rows route, so its creation skips and the rename applies to
/// it once. The pass names both paths to materialize.
#[test]
fn a_document_that_returns_after_parking_applies_only_what_it_missed() {
    let (_scratch, _path, mut store, client) = departing_b();
    let feed = client.transport();
    feed.unshare("doc-b");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));

    feed.rename(
        "owner",
        2,
        "doc-b",
        "a.md",
        "b.md",
        "hosted b",
        "moment-owner-1",
    );
    feed.share("doc-b", "b.md");
    assert_eq!(
        sync_changes(&client, &mut store),
        [("a.md".to_owned(), "delete"), ("b.md".to_owned(), "write")]
    );
    let (now, moments) = content(&store);
    assert_eq!(now, heads(&[("doc-b", "hosted b")]));
    assert_eq!(
        moments,
        BTreeMap::from([
            ("moment-owner-1".to_owned(), 1),
            ("moment-owner-2".to_owned(), 1)
        ])
    );
    assert_eq!(count(&store, "SELECT COUNT(*) FROM conflicts"), 0);
    assert_eq!(
        paths(&store),
        (
            vec![("doc-b".to_owned(), "b.md".to_owned())],
            vec![("b.md".to_owned(), "doc-b".to_owned())]
        )
    );
    assert_eq!(
        count(
            &store,
            "SELECT (SELECT COUNT(*) FROM hosted_parked_snapshots) \
             + (SELECT COUNT(*) FROM hosted_parked_path_aliases)"
        ),
        0
    );
    assert_eq!(
        coordinates(&store),
        [
            ("owner".to_owned(), 0),
            ("owner".to_owned(), 1),
            ("owner".to_owned(), 2)
        ]
    );
    assert!(ready(&store, "doc-b"));
    assert_eq!(document(&store, "doc-b").unwrap().path, "b.md");
}

/// [`sync_retiring`], answering each path the passes changed and how it
/// last changed.
fn sync_changes(
    client: &RelaySyncClient<HostedFeed>,
    store: &mut EngineStore,
) -> Vec<(String, &'static str)> {
    let mut changes = BTreeMap::new();
    for _ in 0..64 {
        let outcome = pass(client, store, &NoFaults).unwrap();
        for change in &outcome.changed_paths {
            changes.insert(change.path.clone(), change.operation);
        }
        commit(client, store, &outcome);
        if !park(store) && !outcome.has_more {
            return changes.into_iter().collect();
        }
    }
    panic!("the hosted replica did not catch up");
}

type Pairs = Vec<(String, String)>;

/// Each object's head path, and the object each path names.
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

/// The retirement round's open case, and path reuse while parked: `doc-b`
/// left the scope at `a.md` and parked, the owner moved it to `b.md`, and
/// `doc-a` took `a.md`. `doc-b` returns with its head parked at `a.md`,
/// which `doc-a` holds, so its head stays parked, the rename it missed waits,
/// and nothing opens a conflict: `doc-b` is held, and `doc-a` and the main
/// cursor go on. Once the owner moves `doc-a`, `doc-b`'s head comes back,
/// the rename applies behind it, and `doc-b` is ready at `b.md`.
#[test]
fn a_returning_document_is_held_while_another_holds_its_old_path() {
    let (_scratch, _path, mut store, client) = departing_b();
    let feed = client.transport();
    feed.unshare("doc-b");
    feed.rename(
        "owner",
        2,
        "doc-b",
        "a.md",
        "b.md",
        "hosted b",
        "moment-owner-1",
    );
    feed.create("owner", 3, "doc-a", "a.md", "hosted a");
    feed.share("doc-a", "a.md");
    sync_parking(&client, &mut store);
    assert_eq!(content(&store).0, heads(&[("doc-a", "hosted a")]));
    assert!(is_parked(&store, "doc-b"));

    feed.share("doc-b", "b.md");
    sync_parking(&client, &mut store);
    assert_eq!(content(&store).0, heads(&[("doc-a", "hosted a")]));
    assert_eq!(hold(&store, "doc-b"), Some(path_held("a.md", "doc-a")));
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM hosted_parked_snapshots WHERE object_id='doc-b'"
        ),
        1,
        "its head stays parked"
    );
    assert_eq!(retained(&store), 0, "its rename waits in its feed");
    assert_eq!(
        document(&store, "doc-b").unwrap().backfill_cursor,
        2,
        "before its rename"
    );
    assert_eq!(count(&store, "SELECT COUNT(*) FROM conflicts"), 0);

    // doc-a keeps syncing, and the pass reports doc-b held.
    feed.replace(
        "owner",
        4,
        "doc-a",
        "a.md",
        "edited a",
        ("doc-a", "hosted a", "moment-owner-3"),
    );
    let outcome = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(
        outcome.held,
        BTreeMap::from([("doc-b".to_owned(), path_held("a.md", "doc-a"))])
    );
    assert!(commit(&client, &mut store, &outcome));
    assert_eq!(content(&store).0, heads(&[("doc-a", "edited a")]));
    assert_eq!(replica(&store).main_cursor, 5);

    feed.rename(
        "owner",
        5,
        "doc-a",
        "a.md",
        "c.md",
        "edited a",
        "moment-owner-4",
    );
    sync_parking(&client, &mut store);
    let pair = |left: &str, right: &str| (left.to_owned(), right.to_owned());
    assert_eq!(
        paths(&store),
        (
            vec![pair("doc-a", "c.md"), pair("doc-b", "b.md")],
            vec![pair("b.md", "doc-b"), pair("c.md", "doc-a")]
        )
    );
    assert_eq!(
        content(&store).0,
        heads(&[("doc-a", "edited a"), ("doc-b", "hosted b")])
    );
    assert_eq!(count(&store, "SELECT COUNT(*) FROM conflicts"), 0);
    assert_eq!(retained(&store), 0);
    assert!(ready(&store, "doc-b"));
}

/// Serve a Y.Doc base of `object_id` at `path` holding `text`, written by
/// a peer.
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

/// Sol's second finding: a backfilled Y.Doc base at a path another hosted
/// document holds was retried on every pass and held the pass. `doc-b`'s base
/// is held like a moment: `doc-a` and the main cursor go on, and once `doc-a`
/// moves, the base applies and `doc-b` is ready.
#[test]
fn a_ydoc_base_at_a_held_path_holds_its_document_until_the_path_frees() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-a", "a.md", "hosted a");
    ydoc_base(feed, "doc-b", "a.md", "hosted b");
    feed.share("doc-a", "a.md");
    sync(&client, &mut store);

    feed.share("doc-b", "a.md");
    sync(&client, &mut store);
    assert_eq!(hold(&store, "doc-b"), Some(path_held("a.md", "doc-a")));
    feed.replace(
        "owner",
        2,
        "doc-a",
        "a.md",
        "edited a",
        ("doc-a", "hosted a", "moment-owner-1"),
    );
    sync(&client, &mut store);
    assert_eq!(content(&store).0, heads(&[("doc-a", "edited a")]));
    assert_eq!(replica(&store).main_cursor, 4);
    assert_eq!(retained(&store), 0);
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM ydoc_docs WHERE object_id='doc-b'"
        ),
        0
    );

    feed.rename(
        "owner",
        3,
        "doc-a",
        "a.md",
        "c.md",
        "edited a",
        "moment-owner-2",
    );
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(retained(&store), 0);
    assert_eq!(count(&store, "SELECT COUNT(*) FROM conflicts"), 0);
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM snapshots WHERE object_id='doc-b' AND path='a.md'"
        ),
        1
    );
}

/// Two shared documents whose paths differ only in case, or where one path is
/// a folder of the other, cannot both be files on a disk that ignores case
/// (#2036). The later one is held, naming the document that holds its path,
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

/// Documents shared together, at two spellings of one path, backfill one at
/// a time in object id order, so the later id is held whatever the feed's
/// order, and a document beside them keeps syncing (#2036).
#[test]
fn documents_shared_together_at_spellings_of_one_path_hold_the_later_id() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-b", "Notes.md", "hosted b");
    feed.create("owner", 2, "doc-a", "notes.md", "hosted a");
    feed.create("owner", 3, "doc-c", "c.md", "hosted c");
    feed.share("doc-a", "notes.md");
    feed.share("doc-b", "Notes.md");
    feed.share("doc-c", "c.md");
    sync(&client, &mut store);

    assert!(ready(&store, "doc-a"));
    assert_eq!(hold(&store, "doc-b"), Some(path_held("Notes.md", "doc-a")));
    assert!(ready(&store, "doc-c"));
    assert_eq!(
        content(&store).0,
        heads(&[("doc-a", "hosted a"), ("doc-c", "hosted c")])
    );
    assert_eq!(retained(&store), 0);
}

/// A ready document renamed to another spelling of a path another document
/// holds would share that document's file on a disk that ignores case
/// (#2036). The owner's scope moves with it. The document is held at the
/// rename, naming the holder, and the other document and the main cursor go
/// on. Once the holder moves, the rename applies.
#[test]
fn a_ready_document_renamed_to_another_spelling_of_a_held_path_waits_until_it_frees() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-a", "a.md", "hosted a");
    feed.create("owner", 2, "doc-b", "b.md", "hosted b");
    feed.share("doc-a", "a.md");
    feed.share("doc-b", "b.md");
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));

    feed.rename(
        "owner",
        3,
        "doc-b",
        "b.md",
        "A.md",
        "hosted b",
        "moment-owner-2",
    );
    feed.share("doc-b", "A.md");
    feed.replace(
        "owner",
        4,
        "doc-a",
        "a.md",
        "edited a",
        ("doc-a", "hosted a", "moment-owner-1"),
    );
    sync(&client, &mut store);
    assert_eq!(hold(&store, "doc-b"), Some(path_held("A.md", "doc-a")));
    assert_eq!(retained(&store), 0);
    let pair = |left: &str, right: &str| (left.to_owned(), right.to_owned());
    assert_eq!(
        paths(&store).0,
        vec![pair("doc-a", "a.md"), pair("doc-b", "b.md")],
        "the rename waits"
    );
    assert_eq!(
        content(&store).0,
        heads(&[("doc-a", "edited a"), ("doc-b", "hosted b")])
    );
    assert_eq!(count(&store, "SELECT COUNT(*) FROM conflicts"), 0);

    feed.rename(
        "owner",
        5,
        "doc-a",
        "a.md",
        "z.md",
        "edited a",
        "moment-owner-4",
    );
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(
        paths(&store).0,
        vec![pair("doc-a", "z.md"), pair("doc-b", "A.md")]
    );
    assert_eq!(retained(&store), 0);
}

/// Opus's second-round finding: a rename onto another spelling of a held
/// path stopped its ready document at the first refusal, even when the
/// holder moved later in the same pass and the rename applied. A later edit
/// behind a live session then held the document and cut the session off.
/// The document is stopped only once nothing in the pass can free it. The
/// scope keeps its paths, so only the spelling hold can stop `doc-b`.
#[test]
fn a_rename_freed_later_in_its_pass_leaves_the_document_ready() {
    let (_scratch, _path, mut store) = hosted_store();
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
        "doc-b",
        "b.md",
        "A.md",
        "hosted b",
        "moment-owner-2",
    );
    feed.rename(
        "owner",
        4,
        "doc-a",
        "a.md",
        "z.md",
        "hosted a",
        "moment-owner-1",
    );
    feed.replace(
        "owner",
        5,
        "doc-b",
        "A.md",
        "edited b",
        ("doc-b", "hosted b", "moment-owner-3"),
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
    assert!(commit(&client, &mut store, &behind_session));
    assert!(ready(&store, "doc-b"), "the session keeps its document");

    // The session closed.
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    let pair = |left: &str, right: &str| (left.to_owned(), right.to_owned());
    assert_eq!(
        paths(&store).0,
        vec![pair("doc-a", "z.md"), pair("doc-b", "A.md")]
    );
    assert_eq!(
        content(&store).0,
        heads(&[("doc-a", "hosted a"), ("doc-b", "edited b")])
    );
    assert_eq!(retained(&store), 0);
}

/// Reports one document's live session.
struct LiveSession(&'static str);

impl LeaseProbe for LiveSession {
    fn is_live(&self, key: &dohc_engine_collab::DocKey) -> bool {
        key.object_id == self.0
    }
}

/// Sol's third finding: a document became ready once its backfill was
/// fetched, while its rename still waited behind a live session. Its read
/// stops before the rename, and it is held until the rename applies.
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

    // The session closed.
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

/// Sol's fourth finding: nothing compared a document's head with the path its
/// scope names. The scope names `doc-b` at `b.md` before the feed serves the
/// rename that takes it there: `doc-b` is held, naming both paths, while the
/// main cursor goes on, and is ready once the rename applies.
#[test]
fn a_document_away_from_its_scope_path_is_held_until_it_arrives() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-b", "a.md", "hosted b");
    feed.create("owner", 2, "private", "private.md", "private");
    feed.share("doc-b", "b.md");
    sync(&client, &mut store);
    assert_eq!(
        hold(&store, "doc-b"),
        Some(HostedHold::ScopePathMismatch {
            scope_path: "b.md".to_owned(),
            head_path: Some("a.md".to_owned())
        })
    );
    assert_eq!(replica(&store).main_cursor, 3);

    feed.rename(
        "owner",
        3,
        "doc-b",
        "a.md",
        "b.md",
        "hosted b",
        "moment-owner-1",
    );
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(replica(&store).main_cursor, 4);
}

/// Sol's out-of-date pass: pass A completed held `doc-b`'s read with its
/// rename but committed late. Pass B, after it, skipped a later edit on the
/// main feed while `doc-b`'s own read stopped before it, and committed
/// first. A's commit then marked `doc-b` ready, so nothing read the edit
/// again. A pass that read before another committed cannot commit.
#[test]
fn a_pass_another_commit_overtook_cannot_commit() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-b", "a.md", "hosted b");
    feed.share("doc-b", "b.md");
    sync(&client, &mut store);
    feed.rename(
        "owner",
        2,
        "doc-b",
        "a.md",
        "b.md",
        "hosted b",
        "moment-owner-1",
    );
    let late = pass(&client, &mut store, &NoFaults).unwrap();
    assert!(late.pending_cursor.as_ref().unwrap().reads["doc-b"].complete);

    feed.replace(
        "owner",
        3,
        "doc-b",
        "b.md",
        "edited b",
        ("doc-b", "hosted b", "moment-owner-2"),
    );
    let first = client
        .pull_hosted_workspace(
            &mut store,
            &mut WriterDocCache::new(),
            "ws",
            "relay",
            &NoFaults,
            &LiveSession("doc-b"),
        )
        .unwrap();
    assert!(commit(&client, &mut store, &first));
    assert_eq!(hold(&store, "doc-b"), Some(HostedHold::WorkWaiting));
    assert_eq!(replica(&store).main_cursor, 4);

    assert!(!commit(&client, &mut store, &late));
    assert_eq!(hold(&store, "doc-b"), Some(HostedHold::WorkWaiting));
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(
        content(&store).0,
        BTreeMap::from([("doc-b".to_owned(), "edited b".to_owned())])
    );
}

/// Sol's held-backfill review, fourth finding: a ready document whose scope
/// path changed kept its readiness at its old head. `doc-b` is held, naming
/// both paths, and reads its own rows from where the main feed is until the
/// rename that takes it to its new path applies.
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

/// Sol's held-backfill review, third finding: a document that returned
/// before it retired, with its journal and head intact, was held at its
/// creation, which had already applied, because occupancy was checked before
/// the journal. `doc-b` was created at `a.md` and moved to `b.md`; while it
/// was out, `doc-a` took `a.md`. It returns with a new edit.
#[test]
fn a_returning_document_skips_its_applied_history_at_another_documents_path() {
    let (_scratch, _path, mut store, client) = departing_b();
    let feed = client.transport();
    feed.rename(
        "owner",
        2,
        "doc-b",
        "a.md",
        "b.md",
        "hosted b",
        "moment-owner-1",
    );
    feed.share("doc-b", "b.md");
    sync(&client, &mut store);
    feed.unshare("doc-b");
    feed.create("owner", 3, "doc-a", "a.md", "hosted a");
    feed.share("doc-a", "a.md");
    sync(&client, &mut store);
    assert!(ready(&store, "doc-a"));

    feed.replace(
        "owner",
        4,
        "doc-b",
        "b.md",
        "edited b",
        ("doc-b", "hosted b", "moment-owner-2"),
    );
    feed.share("doc-b", "b.md");
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(
        content(&store).0,
        heads(&[("doc-a", "hosted a"), ("doc-b", "edited b")])
    );
    assert_eq!(count(&store, "SELECT COUNT(*) FROM conflicts"), 0);
}

/// Sol's held-backfill review, first finding: a Y.Doc base honored only the
/// documents still in the scope, so it could take a path the file of a
/// retired document still held, and that file's removal would then delete
/// the new document's bytes. It waits like a moment until the file is gone.
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

/// From engine merge 4: a departed document's path, and a retired file's,
/// matched exactly, while capture holds match case aliases and descendants.
/// The PR 4a durability review: nor did it hold the folders above it. Each
/// incoming path waits for `doc-b`, departed and then retired, until its
/// file is gone.
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

/// Sol's held-backfill review, second finding: a held backfill retained
/// every row behind its collision, so one longer than the deferred-work
/// limit failed every pass, froze the main cursor and kept out the rename
/// that would free its path. `doc-b`'s history starts at `a.md`, which
/// `doc-a` holds, and runs past that limit. Nothing of it is retained:
/// `doc-c` keeps syncing, the main cursor moves, `doc-a`'s rename applies,
/// and then `doc-b`'s whole history applies behind it.
#[test]
fn a_held_backfill_longer_than_the_retention_limit_holds_only_its_document() {
    const RENAMES: i64 = 10_001;
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-b", "a.md", "hosted b");
    let mut at = ("a.md", "moment-owner-1".to_owned());
    for seq in 0..RENAMES {
        let to = if at.0 == "x.md" { "y.md" } else { "x.md" };
        feed.rename("peer", seq, "doc-b", at.0, to, "hosted b", &at.1);
        at = (to, format!("moment-peer-{seq}"));
    }
    feed.create("owner", 2, "doc-a", "a.md", "hosted a");
    feed.create("owner", 3, "doc-c", "c.md", "hosted c");
    feed.share("doc-a", "a.md");
    feed.share("doc-c", "c.md");
    sync(&client, &mut store);

    feed.share("doc-b", at.0);
    sync(&client, &mut store);
    assert_eq!(hold(&store, "doc-b"), Some(path_held("a.md", "doc-a")));
    assert_eq!(
        document(&store, "doc-b").unwrap().backfill_cursor,
        1,
        "before its creation"
    );
    assert_eq!(retained(&store), 0);

    feed.replace(
        "owner",
        4,
        "doc-c",
        "c.md",
        "edited c",
        ("doc-c", "hosted c", "moment-owner-3"),
    );
    let end = feed.log.lock().unwrap().len() as i64;
    sync(&client, &mut store);
    assert_eq!(replica(&store).main_cursor, end);
    assert_eq!(
        content(&store).0,
        heads(&[("doc-a", "hosted a"), ("doc-c", "edited c")])
    );
    assert_eq!(hold(&store, "doc-b"), Some(path_held("a.md", "doc-a")));
    assert_eq!(retained(&store), 0);

    feed.rename(
        "owner",
        5,
        "doc-a",
        "a.md",
        "d.md",
        "hosted a",
        "moment-owner-2",
    );
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(retained(&store), 0);
    assert_eq!(count(&store, "SELECT COUNT(*) FROM conflicts"), 0);
    let pair = |left: &str, right: &str| (left.to_owned(), right.to_owned());
    assert_eq!(
        paths(&store).0,
        [
            pair("doc-a", "d.md"),
            pair("doc-b", at.0),
            pair("doc-c", "c.md")
        ]
    );
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM moments WHERE object_id='doc-b'"
        ),
        RENAMES + 1
    );
}

/// Codex's review: each held document read a full page of its own rows on
/// every pass, past the pass's limit, though a stopped one needs only the row
/// it stopped at. Held reads share what the main feed left, and a read cut
/// short goes on in later passes until its document is ready.
#[test]
fn held_reads_share_the_pass_limit() {
    const RENAMES: i64 = crate::MAX_PULL_OPS as i64 + 1;
    const HELD: [&str; 3] = ["doc-b1", "doc-b2", "doc-b3"];
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-a", "a.md", "hosted a");
    feed.create("owner", 2, "doc-c", "c.md", "c 0");
    let mut ends = Vec::new();
    for (index, object_id) in HELD.iter().enumerate() {
        let origin = format!("peer-{index}");
        feed.create(&origin, 0, object_id, "a.md", "hosted b");
        let mut at = ("a.md".to_owned(), format!("moment-{origin}-0"));
        for seq in 1..=RENAMES {
            let to = format!("{}{index}.md", if seq % 2 == 0 { "y" } else { "x" });
            feed.rename(&origin, seq, object_id, &at.0, &to, "hosted b", &at.1);
            at = (to, format!("moment-{origin}-{seq}"));
        }
        ends.push(at.0);
    }
    feed.share("doc-a", "a.md");
    feed.share("doc-c", "c.md");
    sync(&client, &mut store);
    for (object_id, end) in HELD.iter().zip(&ends) {
        feed.share(object_id, end);
    }
    sync(&client, &mut store);
    for object_id in HELD {
        assert_eq!(hold(&store, object_id), Some(path_held("a.md", "doc-a")));
    }

    for seq in 1..=crate::model::MAX_PULL_OPS_PER_PASS as i64 {
        let before = (
            "doc-c",
            format!("c {}", seq - 1),
            format!("moment-owner-{}", seq + 1),
        );
        feed.replace(
            "owner",
            seq + 2,
            "doc-c",
            "c.md",
            &format!("c {seq}"),
            (before.0, &before.1, &before.2),
        );
    }
    let busy = pass(&client, &mut store, &NoFaults).unwrap();
    assert!(
        busy.fetched <= crate::model::MAX_PULL_OPS_PER_PASS + HELD.len(),
        "fetched {}",
        busy.fetched
    );
    assert!(commit(&client, &mut store, &busy));
    for object_id in HELD {
        assert_eq!(hold(&store, object_id), Some(path_held("a.md", "doc-a")));
    }

    feed.rename(
        "owner",
        3 + crate::model::MAX_PULL_OPS_PER_PASS as i64,
        "doc-a",
        "a.md",
        "d.md",
        "hosted a",
        "moment-owner-1",
    );
    sync(&client, &mut store);
    let (heads, _) = content(&store);
    assert_eq!(
        heads["doc-c"],
        format!("c {}", crate::model::MAX_PULL_OPS_PER_PASS)
    );
    for object_id in HELD {
        assert!(ready(&store, object_id));
        assert_eq!(
            count(
                &store,
                &format!("SELECT COUNT(*) FROM moments WHERE object_id='{object_id}'")
            ),
            RENAMES + 1
        );
    }
}

#[test]
fn an_ordinary_replica_has_nothing_to_park() {
    let (_scratch, _path, mut ordinary) = open_store();
    seed_identity(&mut ordinary);
    assert!(
        departed_hosted_documents(&ordinary, "ws")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        park_hosted_document(&mut ordinary, "ws", "doc-b", "main", &NoFaults).unwrap(),
        TxnOutcome::Committed(false)
    );
}

/// Parking: a returning document reads its rows again from cursor zero, and
/// each row its journal holds skips as redelivered, so nothing applies
/// twice. Its head comes back before the rows route, and the pass names its
/// file to materialize.
#[test]
fn a_returning_document_rereads_from_zero_and_skips_what_it_applied() {
    let (_scratch, _path, mut store, client) = departing_b();
    let feed = client.transport();
    feed.replace(
        "owner",
        2,
        "doc-b",
        "a.md",
        "edited b",
        ("doc-b", "hosted b", "moment-owner-1"),
    );
    sync(&client, &mut store);
    let before = (content(&store), coordinates(&store), paths(&store));
    feed.unshare("doc-b");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));
    assert!(content(&store).0.is_empty());

    feed.share("doc-b", "a.md");
    assert_eq!(
        pass(&client, &mut store, &NoFaults).unwrap().pending_cursor,
        None
    );
    let back = pass(&client, &mut store, &NoFaults).unwrap();
    let read = client.transport().pull_requests().last().unwrap().clone();
    assert_eq!((read.object_id.as_deref(), read.cursor), (Some("doc-b"), 0));
    assert_eq!((back.applied, back.skipped), (0, 2));
    assert_eq!(
        back.changed_paths
            .iter()
            .map(|change| (change.path.as_str(), change.operation))
            .collect::<Vec<_>>(),
        [("a.md", "write")]
    );
    assert!(commit(&client, &mut store, &back));
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(
        (content(&store), coordinates(&store), paths(&store)),
        before
    );
}

/// Parking: `doc-b` returns at `b.md`, while its history leaves it at
/// `a.md`, where it parked. Its head comes back there and it is held, naming
/// both paths; each later pass reads one page and finishes, so nothing loops.
/// The rename that takes it to `b.md` makes it ready.
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

/// Parking, path reuse the other way round: `doc-b` returns to `a.md` first,
/// and then `doc-c`, whose history takes `a.md`, joins the scope. `doc-c` is
/// held by `doc-b`, as any backfill at another document's path is.
#[test]
fn a_document_that_takes_a_returned_documents_path_is_held() {
    let (_scratch, _path, mut store, client) = departing_b();
    let feed = client.transport();
    feed.unshare("doc-b");
    sync_parking(&client, &mut store);
    feed.share("doc-b", "a.md");
    sync_parking(&client, &mut store);
    assert!(ready(&store, "doc-b"));

    feed.create("owner", 2, "doc-c", "a.md", "hosted c");
    feed.share("doc-c", "a.md");
    sync_parking(&client, &mut store);
    assert_eq!(hold(&store, "doc-c"), Some(path_held("a.md", "doc-b")));
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b")]));
    assert_eq!(count(&store, "SELECT COUNT(*) FROM conflicts"), 0);
}

/// Parking: two documents parked at one path do not hold each other, and
/// either can come back to it.
#[test]
fn documents_parked_at_one_path_return_in_turn() {
    let (_scratch, _path, mut store, client) = departing_b();
    let feed = client.transport();
    feed.unshare("doc-b");
    feed.replace(
        "owner",
        2,
        "doc-c",
        "a.md",
        "hosted c",
        ("doc-b", "hosted b", "moment-owner-1"),
    );
    feed.share("doc-c", "a.md");
    sync_parking(&client, &mut store);
    assert_eq!(content(&store).0, heads(&[("doc-c", "hosted c")]));
    feed.unshare("doc-c");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));
    assert!(is_parked(&store, "doc-c"));

    feed.share("doc-b", "a.md");
    sync_parking(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b")]));
    assert!(is_parked(&store, "doc-c"));
}

/// Opus's third park review: one reading of the workspace serves a pass's
/// whole unparking, so each return it brings back holds its paths against
/// the next. Two documents parked at one path that return together come
/// back one at a time: `doc-b` first, and `doc-c` stays parked behind it.
#[test]
fn documents_parked_at_one_path_that_return_together_come_back_one_at_a_time() {
    let (_scratch, _path, mut store, client) = departing_b();
    let feed = client.transport();
    feed.unshare("doc-b");
    feed.replace(
        "owner",
        2,
        "doc-c",
        "a.md",
        "hosted c",
        ("doc-b", "hosted b", "moment-owner-1"),
    );
    feed.share("doc-c", "a.md");
    sync_parking(&client, &mut store);
    feed.unshare("doc-c");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b") && is_parked(&store, "doc-c"));

    feed.share("doc-b", "a.md");
    feed.share("doc-c", "a.md");
    sync_parking(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b")]));
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM hosted_parked_snapshots WHERE object_id='doc-c'"
        ),
        1
    );
    assert_eq!(hold(&store, "doc-c"), Some(path_held("a.md", "doc-b")));
}

/// Parking: a return stops at its unparking, before it commits or after it
/// commits but before its pass does, and the host restarts. Either way the
/// return finishes once: its head comes back, the pass names its file, and
/// nothing applies twice.
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

/// Sol's park review: `doc-b` parked at `a.md`, the owner moved it to `b.md`,
/// and `doc-a` took `a.md/child.md`, so `a.md` is a folder here. On its
/// return, `doc-b`'s creation skips as journaled, and the decision it stored
/// to write `a.md` named that folder, which no materialization can write. No
/// stored decision of a document whose heads are parked materializes: the
/// pass names nothing of `doc-b`, holds it, and commits.
#[test]
fn a_returning_document_materializes_nothing_while_its_heads_are_parked() {
    let (_scratch, _path, mut store, client) = departing_b();
    let feed = client.transport();
    feed.unshare("doc-b");
    feed.rename(
        "owner",
        2,
        "doc-b",
        "a.md",
        "b.md",
        "hosted b",
        "moment-owner-1",
    );
    feed.create("owner", 3, "doc-a", "a.md/child.md", "hosted a");
    feed.share("doc-a", "a.md/child.md");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));

    feed.share("doc-b", "b.md");
    assert_eq!(
        pass(&client, &mut store, &NoFaults).unwrap().pending_cursor,
        None
    );
    let back = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(back.skipped, 1, "its creation skips as journaled");
    assert_eq!(back.changed_paths, []);
    assert_eq!(
        back.held,
        BTreeMap::from([("doc-b".to_owned(), path_held("a.md", "doc-a"))])
    );
    assert!(commit(&client, &mut store, &back));
    assert_eq!(hold(&store, "doc-b"), Some(path_held("a.md", "doc-a")));
}

/// Sol's second park review: a parked document's history still removes a
/// file it left at a path nothing holds now, but names none of its parked
/// paths. `doc-b` was created at `x.md` and moved to `a.md`, where it parked;
/// `doc-a` took `a.md`. On its return, its stored delete of the free `x.md`
/// goes out while its heads stay parked, and its write of `a.md` does not.
#[test]
fn a_parked_return_clears_only_the_free_paths_of_its_history() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-b", "x.md", "hosted b");
    feed.rename(
        "owner",
        2,
        "doc-b",
        "x.md",
        "a.md",
        "hosted b",
        "moment-owner-1",
    );
    feed.share("doc-b", "a.md");
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    feed.unshare("doc-b");
    feed.create("owner", 3, "doc-a", "a.md", "hosted a");
    feed.share("doc-a", "a.md");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));
    assert!(ready(&store, "doc-a"));

    feed.share("doc-b", "a.md");
    assert_eq!(
        pass(&client, &mut store, &NoFaults).unwrap().pending_cursor,
        None
    );
    let back = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(back.skipped, 2);
    assert_eq!(
        back.changed_paths
            .iter()
            .map(|change| (change.path.as_str(), change.operation))
            .collect::<Vec<_>>(),
        [("x.md", "delete")]
    );
    assert_eq!(
        back.held,
        BTreeMap::from([("doc-b".to_owned(), path_held("a.md", "doc-a"))])
    );
    assert!(commit(&client, &mut store, &back));
    assert_eq!(hold(&store, "doc-b"), Some(path_held("a.md", "doc-a")));
    assert_eq!(
        count(&store, "SELECT COUNT(*) FROM hosted_parked_snapshots"),
        1
    );
}

/// A stored decision never names a path a document's parked heads come back
/// to, even one nothing holds yet: those heads bring their own writes. A
/// pass brings them back first, so this asks before one does.
#[test]
fn no_stored_decision_names_a_parked_path() {
    let (_scratch, _path, mut store, client) = departing_b();
    client.transport().unshare("doc-b");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));
    assert_eq!(retired_hosted_files(&store, "ws").unwrap(), []);
    let change = |path: &str, operation: &'static str| crate::MomentMaterializationChange {
        version_id: "main".to_owned(),
        path: path.to_owned(),
        operation,
        content_kind: "text",
    };
    let standing = store
        .read_with(|conn| {
            crate::hosted::redelivered_unready(
                &mut crate::hosted::Occupancy::new(conn, "ws"),
                "doc-b",
                [change("A.md", "write"), change("x.md", "delete")],
            )
        })
        .unwrap();
    assert_eq!(standing, [change("x.md", "delete")]);
}

/// Opus's third park review: a stored decision at a document's own head
/// still wrote while the document was held. None stands there; the pass that
/// makes it ready writes its heads. Round four: the fix also dropped paths in
/// another case, inside or above a head, and their deletes are what clear a
/// stale file or folder in the way of the head's write, or rename its file's
/// case, so the page failed or kept the old name. Those stand.
#[test]
fn no_stored_decision_names_a_path_of_its_documents_own_head() {
    let change = |path: &str, operation: &'static str| crate::MomentMaterializationChange {
        version_id: "main".to_owned(),
        path: path.to_owned(),
        operation,
        content_kind: "text",
    };
    for (head, near) in [
        ("P.md", ["p.md", "P.md/x.md", "p.md/x.md"]),
        ("d/x.md", ["d/X.md", "d", "D"]),
    ] {
        let (_scratch, _path, store, _client) = departing_b_at(head);
        let mut standing = near.map(|path| change(path, "delete")).to_vec();
        standing.push(change("free.md", "delete"));
        let stored = [change(head, "write"), change(head, "delete")]
            .into_iter()
            .chain(standing.clone());
        let read = store
            .read_with(|conn| {
                crate::hosted::redelivered_unready(
                    &mut crate::hosted::Occupancy::new(conn, "ws"),
                    "doc-b",
                    stored,
                )
            })
            .unwrap();
        assert_eq!(read, standing, "{head}");
    }
}

/// Opus's second park review: a return checked each stored decision of each
/// journaled row against every head, path alias and retired file, so its
/// cost grew with its history times the workspace. Each document's stored
/// decisions are checked once a pass, against what the workspace holds read
/// once. `doc-b` moved along `p0.md` .. `p24.md` and parked at the last;
/// on its return, beside 24 other documents, the pass reads each of their
/// heads and aliases a bounded number of times, however long its history.
/// Opus's third review: each document asking read the workspace again, so
/// a return of many documents at once cost each of them the workspace. Eight
/// more return with `doc-b`, and the bound still holds.
#[test]
fn a_returns_history_is_checked_against_the_workspace_once() {
    const MOVES: i64 = 24;
    const RETURNS: i64 = 8;
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-b", "p0.md", "hosted b");
    for step in 1..=MOVES {
        feed.rename(
            "owner",
            step + 1,
            "doc-b",
            &format!("p{}.md", step - 1),
            &format!("p{step}.md"),
            "hosted b",
            &format!("moment-owner-{step}"),
        );
    }
    let last = format!("p{MOVES}.md");
    feed.share("doc-b", &last);
    for other in 0..MOVES {
        let object_id = format!("doc-{other}");
        let path = format!("other/{other}.md");
        feed.create("owner", MOVES + 2 + other, &object_id, &path, "other");
        feed.share(&object_id, &path);
    }
    let returning: Vec<_> = (0..RETURNS)
        .map(|back| (format!("ret-{back}"), format!("back/{back}.md")))
        .collect();
    for ((object_id, path), seq) in returning.iter().zip(2 * MOVES + 2..) {
        feed.create("owner", seq, object_id, path, "back");
        feed.share(object_id, path);
    }
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    feed.unshare("doc-b");
    for (object_id, _) in &returning {
        feed.unshare(object_id);
    }
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b") && is_parked(&store, "ret-0"));

    feed.share("doc-b", &last);
    for (object_id, path) in &returning {
        feed.share(object_id, path);
    }
    assert_eq!(
        pass(&client, &mut store, &NoFaults).unwrap().pending_cursor,
        None
    );
    crate::hosted::OCCUPANTS_READ.with(|read| read.set(0));
    let back = pass(&client, &mut store, &NoFaults).unwrap();
    let read = crate::hosted::OCCUPANTS_READ.with(|read| read.get());
    let occupants = count(
        &store,
        "SELECT (SELECT COUNT(*) FROM snapshots) + (SELECT COUNT(*) FROM path_aliases)",
    ) as usize;
    assert_eq!(
        count(&store, "SELECT COUNT(*) FROM hosted_parked_snapshots"),
        0,
        "every return comes back in this pass"
    );
    assert_eq!(back.skipped, MOVES as usize + 1);
    assert!(
        read <= 4 * occupants,
        "read {read} occupants of {occupants} for {MOVES} moves and {RETURNS} more returns"
    );
    assert_eq!(
        back.changed_paths
            .iter()
            .map(|change| change.path.clone())
            .collect::<BTreeSet<_>>(),
        (0..=MOVES).map(|step| format!("p{step}.md")).collect(),
        "its history clears every free path it left, and its head comes back"
    );
    assert!(commit(&client, &mut store, &back));
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
}

/// A returning document that never parked replays its journal too. `doc-b`
/// was created at `x.md` and moved to `a.md`; while it was out, `doc-c` took
/// `x.md/y.md`. The decisions `doc-b`'s rows stored at `x.md` would name
/// `doc-c`'s folder, so the pass names only its head.
#[test]
fn a_returning_documents_stored_decisions_skip_paths_others_hold_now() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-b", "x.md", "hosted b");
    feed.rename(
        "owner",
        2,
        "doc-b",
        "x.md",
        "a.md",
        "hosted b",
        "moment-owner-1",
    );
    feed.share("doc-b", "a.md");
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    feed.unshare("doc-b");
    feed.create("owner", 3, "doc-c", "x.md/y.md", "hosted c");
    feed.share("doc-c", "x.md/y.md");
    sync(&client, &mut store);
    assert!(ready(&store, "doc-c"));
    assert_eq!(departed_hosted_object_ids(&store, "ws").unwrap(), ["doc-b"]);

    feed.share("doc-b", "a.md");
    assert_eq!(
        pass(&client, &mut store, &NoFaults).unwrap().pending_cursor,
        None
    );
    let back = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(back.skipped, 2);
    assert_eq!(
        back.changed_paths
            .iter()
            .map(|change| (change.path.as_str(), change.operation))
            .collect::<Vec<_>>(),
        [("a.md", "write")]
    );
    assert!(commit(&client, &mut store, &back));
    assert!(ready(&store, "doc-b"));
}

/// The durability review of parking, N2: a head or path alias of a parked
/// document outside the parked tables made its unparking fail the whole
/// pass. Its document is held instead, and the others keep syncing.
#[test]
fn a_parked_document_with_a_head_outside_its_parked_tables_is_held() {
    let (_scratch, _path, mut store, client) = departing_b();
    let feed = client.transport();
    feed.unshare("doc-b");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
                 SELECT workspace_id,version_id,path,object_id FROM hosted_parked_path_aliases",
                [],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();

    feed.share("doc-b", "a.md");
    feed.create("owner", 2, "doc-c", "c.md", "hosted c");
    feed.share("doc-c", "c.md");
    sync_parking(&client, &mut store);
    assert!(ready(&store, "doc-c"));
    assert_eq!(hold(&store, "doc-b"), Some(HostedHold::WorkWaiting));
    let again = pass(&client, &mut store, &NoFaults).unwrap();
    assert!(!again.has_more, "nothing loops");
    assert!(commit(&client, &mut store, &again));
    assert_eq!(
        count(&store, "SELECT COUNT(*) FROM hosted_parked_snapshots"),
        1
    );
}

/// The durability review of parking: a return held at its path writes its
/// file only in the pass that unparks it, so a host that stopped after that
/// pass and before materializing it lost the write, and the next pass, with
/// nothing to unpark or read, made `doc-b` ready without its file. `doc-b`
/// returns to `a.md` while `doc-a` holds it; `doc-a` moves, the next pass
/// unparks `doc-b`, and the host stops before materializing. After the
/// restart, the pass that makes `doc-b` ready names its file.
#[test]
fn a_held_return_interrupted_after_its_unparking_names_its_file_when_it_becomes_ready() {
    let (_scratch, path, mut store, client) = departing_b();
    let feed = client.transport();
    feed.unshare("doc-b");
    sync_parking(&client, &mut store);
    feed.create("owner", 2, "doc-a", "a.md", "hosted a");
    feed.share("doc-a", "a.md");
    sync_parking(&client, &mut store);
    feed.share("doc-b", "a.md");
    sync_parking(&client, &mut store);
    assert_eq!(hold(&store, "doc-b"), Some(path_held("a.md", "doc-a")));

    feed.rename(
        "owner",
        3,
        "doc-a",
        "a.md",
        "c.md",
        "hosted a",
        "moment-owner-2",
    );
    let freed = pass(&client, &mut store, &NoFaults).unwrap();
    assert!(freed.has_more, "doc-b comes back on the next pass");
    assert!(commit(&client, &mut store, &freed));
    assert_eq!(hold(&store, "doc-b"), Some(HostedHold::WorkWaiting));
    let unparked = pass(&client, &mut store, &NoFaults).unwrap();
    assert!(
        unparked
            .changed_paths
            .iter()
            .any(|change| change.path == "a.md")
    );
    assert_eq!(
        count(&store, "SELECT COUNT(*) FROM hosted_parked_snapshots"),
        0
    );
    drop(store);

    let mut store = EngineStore::open(&path, 3_000).unwrap();
    let again = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(
        again
            .changed_paths
            .iter()
            .map(|change| (change.path.as_str(), change.operation))
            .collect::<Vec<_>>(),
        [("a.md", "write")]
    );
    assert_eq!(again.held, BTreeMap::new());
    assert_eq!(
        hold(&store, "doc-b"),
        Some(HostedHold::WorkWaiting),
        "ready only once its pass commits"
    );
    assert!(commit(&client, &mut store, &again));
    assert!(ready(&store, "doc-b"));
    assert_eq!(
        content(&store).0,
        heads(&[("doc-a", "hosted a"), ("doc-b", "hosted b")])
    );
}

/// Parking (G4): a parked document is no longer hosted. The replica refuses
/// to write for it before it takes a sequence.
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

/// An activation of `object_id` in namespace `relay`, of `lineage`.
fn activate(store: &mut EngineStore, object_id: &str) -> String {
    let lineage = dohc_engine_storage::hex_sha256(b"activation lineage");
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_storage::put_binary_blob(tx, b"activation lineage")
                .map_err(SyncError::Storage)?;
            tx.execute(
                "INSERT INTO ydoc_owner_activation_sources VALUES \
                 ('activation','relay','ws','main',?1,?2,'moment-owner-1',?3,?2,'{}')",
                params![object_id, lineage, text_sha("hosted b")],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    lineage
}

/// The adoption of `object_id`'s activation, in `namespace`.
fn adopt_activation(store: &mut EngineStore, object_id: &str, lineage: &str, namespace: &str) {
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO live_owner_adoptions (relay_database_namespace,adoption_id, \
                   workspace_id,main_version_id,object_id,lineage_claim_id,binding_json, \
                   source_moment_id,source_digest,source_byte_length, \
                   baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest, \
                   coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor, \
                   terminal_receipt_json,host_coordinate_json,max_pending_bytes,max_pending_age_ms) \
                 VALUES (?1,'activation','ws','main',?2,?3,'{}','moment-owner-1',?4,8,0,0,'e','c', \
                   0,0,0,'{}','{}',1,1)",
                params![namespace, object_id, lineage, text_sha("hosted b")],
            )
            .map_err(SyncError::persist)?;
            tx.execute(ACTIVATE_ADOPTION, params![namespace, "activation", None::<String>])
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

/// Parking (G3): an activation without its adoption resumes only on the
/// exact state it captured, which a return would change. Its document stays
/// departed until the activation is adopted in its own namespace.
#[test]
fn a_document_parks_only_once_every_activation_is_adopted() {
    let (_scratch, _path, mut store, client) = departing_b();
    let lineage = activate(&mut store, "doc-b");
    client.transport().unshare("doc-b");
    sync_parking(&client, &mut store);
    assert!(!hosted_document_parkable(&store, "ws", "doc-b").unwrap());
    assert_eq!(departed_hosted_object_ids(&store, "ws").unwrap(), ["doc-b"]);
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b")]));

    adopt_activation(&mut store, "doc-b", &lineage, "other-relay");
    sync_parking(&client, &mut store);
    assert!(
        !hosted_document_parkable(&store, "ws", "doc-b").unwrap(),
        "an adoption in another namespace is not its own"
    );

    store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "PRAGMA defer_foreign_keys=ON; \
                 UPDATE live_owner_adoptions SET relay_database_namespace='relay'; \
                 UPDATE live_owner_activations SET relay_database_namespace='relay';",
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM ydoc_owner_activation_sources WHERE object_id='doc-b'"
        ),
        1,
        "its activation stays for its return"
    );
}

/// Only a source's own activation row keeps it. A released activation's
/// source stays and parks with its document; a capture no activation records
/// holds parking and goes on release, though another activation is current.
#[test]
fn only_its_own_activation_keeps_a_captured_source() {
    use dohc_engine_collab::live_update_application::release_imported_owner_activation;
    let (_scratch, _path, mut store, client) = departing_b();
    let lineage = activate(&mut store, "doc-b");
    adopt_activation(&mut store, "doc-b", &lineage, "relay");
    store
        .write_with(&NoFaults, |tx| {
            for id in ["released", "unrecorded"] {
                tx.execute(
                    "INSERT INTO ydoc_owner_activation_sources VALUES \
                     (?1,'relay','ws','main','doc-b',?2,'moment-owner-1',?3,?2,'{}')",
                    params![id, lineage, text_sha("hosted b")],
                )
                .map_err(SyncError::persist)?;
            }
            tx.execute(
                "INSERT INTO live_owner_activations (relay_database_namespace,activation_id, \
                   workspace_id,main_version_id,object_id,lineage_claim_id,binding_json, \
                   source_moment_id,source_digest,source_byte_length,host_coordinate_json, \
                   released_at_ms,released_restore_generation,released_accepted_cursor, \
                   released_boundary_json,carried_manifest_json) \
                 VALUES ('relay','released','ws','main','doc-b',?1,'{}','moment-owner-1',?2,8,'{}', \
                   1,0,0,'null','[]')",
                params![lineage, text_sha("hosted b")],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    client.transport().unshare("doc-b");
    sync_parking(&client, &mut store);
    assert!(
        !is_parked(&store, "doc-b"),
        "the current activation does not cover a capture it never recorded"
    );
    assert_eq!(departed_hosted_object_ids(&store, "ws").unwrap(), ["doc-b"]);
    let sources = |store: &EngineStore| {
        count(
            store,
            "SELECT COUNT(*) FROM ydoc_owner_activation_sources WHERE object_id='doc-b'",
        )
    };
    for kept in ["activation", "released"] {
        assert!(
            release_imported_owner_activation(&mut store, "relay", "ws", kept, None, &NoFaults)
                .is_err(),
            "{kept}"
        );
    }
    assert_eq!(sources(&store), 3);
    release_imported_owner_activation(&mut store, "relay", "ws", "unrecorded", None, &NoFaults)
        .unwrap();
    assert_eq!(sources(&store), 2);
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));
    assert_eq!(sources(&store), 2, "recorded sources stay for the return");
}

/// Round 3b's deferred input, through the whole retirement: a Y.Doc update
/// for `doc-b` arrives before its base and waits. `doc-b` leaves and parks
/// with it, and its adopted activation then releases and keeps it. Once
/// `doc-b` returns, the base its return fetches drains the update, and
/// nothing applies twice.
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

    // The adopted activation that holds `doc-b`, with its binding and the
    // accepted history its adoption ended at.
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

/// A folder move is held only while the current activation holds the
/// document. Its release ends that, though the lineage's origin stays; the
/// conflict and binding-change checks read the same current activation.
#[test]
fn a_released_activation_no_longer_holds_a_folder_move() {
    let (_scratch, _path, mut store, _client) = departing_b();
    let lineage = activate(&mut store, "doc-b");
    adopt_activation(&mut store, "doc-b", &lineage, "relay");
    let update = |store: &mut EngineStore, sql: &str| {
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(sql, []).map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .unwrap();
    };
    update(
        &mut store,
        "UPDATE live_owner_activations SET binding_json=json_object('currentPath','a.md')",
    );
    let move_held = |store: &EngineStore| {
        store
            .read_with(|conn| crate::ensure_no_adopted_owner_under_path(conn, "ws", "main", "a.md"))
    };
    assert!(matches!(
        move_held(&store),
        Err(SyncError::LiveDocumentBindingActive)
    ));
    update(
        &mut store,
        "UPDATE live_owner_activations SET released_at_ms=1,released_restore_generation=0, \
           released_accepted_cursor=0,released_boundary_json='null',carried_manifest_json='[]'",
    );
    assert!(move_held(&store).is_ok());
    assert_eq!(
        count(&store, "SELECT COUNT(*) FROM live_owner_adoptions"),
        1,
        "the origin stays"
    );
}

/// Parking keeps the existing restore check: a document whose restore has
/// not resumed stays departed.
#[test]
fn a_document_with_an_unfinished_restore_does_not_park() {
    let (_scratch, _path, mut store, client) = departing_b();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO live_restore_fences (workspace_id,main_version_id,object_id, \
                   relay_database_namespace,operation_id,input_json,receipt_json) \
                 VALUES ('ws','main','doc-b','relay','restore','{\"newFence\":2}','{}')",
                [],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    client.transport().unshare("doc-b");
    sync_parking(&client, &mut store);
    assert!(!hosted_document_parkable(&store, "ws", "doc-b").unwrap());
    assert_eq!(departed_hosted_object_ids(&store, "ws").unwrap(), ["doc-b"]);
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b")]));
}

/// The restores of `doc-b` and the settlements that resumed them, as their
/// rows hold them.
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

/// Parking: retirement unlinked a document's restores from the settlements
/// that resumed them and deleted both, so a restore made before it left could
/// not be reconstructed. Parking keeps the restores, their links and their
/// proposal bytes through a restart and the return, and the document reads
/// the same restore generation after it.
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

/// Serve a peer's `kind` Y.Doc update of `object_id` at `path`, `seq` in its
/// origin, on `lineage`.
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

/// The queued Y.Doc updates of `doc-b`, with the feed each recorded.
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

/// The session's binding of `doc-b` goes, as at its release.
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

/// Parking (G2): `doc-b` has a native live binding when it parks, and while
/// it is parked a peer makes an ordinary edit its session never admitted.
/// On its return the replica keeps that edit queued, refusing nothing, so
/// `doc-b` is held while the binding stands and every pass reports why.
/// Once the binding goes, the edit applies and `doc-b` is ready with it.
#[test]
fn an_unadmitted_edit_made_while_parked_holds_the_returning_document() {
    let (_scratch, _path, mut store) = hosted_store();
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
    settle_live_lineage(&mut store, "doc-b", &lineage);
    feed.unshare("doc-b");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));

    let edit = ydoc.plaintext_insert(8, " and more");
    peer_update(feed, "plaintext", 1, "doc-b", "a.md", edit, &lineage);
    feed.share("doc-b", "a.md");
    sync_parking(&client, &mut store);
    assert_eq!(hold(&store, "doc-b"), Some(HostedHold::LiveEditUnadmitted));
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM replication_refused_ydoc_blobs"
        ),
        0
    );
    assert_eq!(queued_b(&store), r#"[["peer",1,"hosted","relay"]]"#);
    let again = pass(&client, &mut store, &NoFaults).unwrap();
    assert!(!again.has_more);
    assert_eq!(
        again.held,
        BTreeMap::from([("doc-b".to_owned(), HostedHold::LiveEditUnadmitted)])
    );
    assert!(commit(&client, &mut store, &again));
    assert_eq!(hold(&store, "doc-b"), Some(HostedHold::LiveEditUnadmitted));

    release_b(&mut store);
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b and more")]));
    assert_eq!(queued_b(&store), "[]");
}

/// Parking (G2), through native admission: `doc-b` is a richdoc whose native
/// live binding accepted and settled `echo` before it parked. While it is
/// parked, a peer sends `echo` back, or, if `!admitted`, an edit its session
/// never saw. On its return the echo applies and `doc-b` is ready; the edit
/// stays queued, and `doc-b` is held.
fn richdoc_edit_made_while_parked(admitted: bool) {
    let (_scratch, _path, mut store) = hosted_store();
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
    settle_live_lineage(&mut store, "doc-b", &lineage);
    feed.unshare("doc-b");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-b"));

    let edit = if admitted {
        echo
    } else {
        let peer = dohc_engine_collab::Ydoc::wire();
        peer.apply(&base).unwrap();
        peer.richdoc_append_paragraph("unseen")
    };
    peer_update(feed, "richdoc", 1, "doc-b", "a.md", edit, &lineage);
    feed.share("doc-b", "a.md");
    sync_parking(&client, &mut store);
    let refused = count(
        &store,
        "SELECT COUNT(*) FROM replication_refused_ydoc_blobs",
    );
    assert!(coordinates(&store).contains(&("peer".to_owned(), 1)));
    assert_eq!(refused, 0);
    if admitted {
        assert!(ready(&store, "doc-b"));
        assert_eq!(queued_b(&store), "[]");
    } else {
        assert_eq!(hold(&store, "doc-b"), Some(HostedHold::LiveEditUnadmitted));
        assert_eq!(queued_b(&store), r#"[["peer",1,"hosted","relay"]]"#);
        // Opus's second park review: a held document's pass writes none of
        // its heads.
        let again = pass(&client, &mut store, &NoFaults).unwrap();
        assert_eq!(
            again.held,
            BTreeMap::from([("doc-b".to_owned(), HostedHold::LiveEditUnadmitted)])
        );
        assert_eq!(again.changed_paths, []);
        assert!(!again.pending_cursor.as_ref().unwrap().reads["doc-b"].heads_written);
    }
}

/// Opus's second park review: a pass writes the heads only of a document
/// nothing held when it read it, and only that read's commit makes it ready.
/// What held `doc-b` when its pass read it is gone by its commit: it stays
/// held, and the commit says there is more, so the next pass, which writes
/// its heads and makes it ready, comes.
#[test]
fn a_hold_gone_by_commit_leaves_its_document_for_the_pass_that_writes_its_heads() {
    let (_scratch, _path, mut store, client) = departing_b();
    let commit = |store: &mut EngineStore, outcome: &HostedPassOutcome| match client
        .commit_hosted_cursor(
            store,
            "ws",
            outcome.pending_cursor.as_ref().unwrap(),
            &ReleasedTails::uncached(),
            &NoFaults,
        )
        .unwrap()
    {
        TxnOutcome::Committed(commit) => commit,
        TxnOutcome::Crashed { .. } => panic!("no fault was injected"),
    };
    let feed = client.transport();
    feed.unshare("doc-b");
    sync_parking(&client, &mut store);
    feed.share("doc-b", "a.md");
    assert_eq!(
        pass(&client, &mut store, &NoFaults).unwrap().pending_cursor,
        None
    );
    let mut back = pass(&client, &mut store, &NoFaults).unwrap();
    let read = back
        .pending_cursor
        .as_mut()
        .unwrap()
        .reads
        .get_mut("doc-b")
        .unwrap();
    assert!(read.complete && read.heads_written);
    // As if a hold seen when the pass read it, which wrote no heads, went.
    read.heads_written = false;
    assert_eq!(
        commit(&mut store, &back),
        crate::HostedCommit {
            committed: true,
            has_more: true
        }
    );
    assert_eq!(hold(&store, "doc-b"), Some(HostedHold::WorkWaiting));

    let again = pass(&client, &mut store, &NoFaults).unwrap();
    assert!(
        again
            .changed_paths
            .iter()
            .any(|change| change.path == "a.md")
    );
    assert_eq!(
        commit(&mut store, &again),
        crate::HostedCommit {
            committed: true,
            has_more: false
        }
    );
    assert!(ready(&store, "doc-b"));
}

#[test]
fn a_richdoc_edit_its_session_never_admitted_holds_the_returning_document() {
    richdoc_edit_made_while_parked(false);
}

#[test]
fn an_admitted_richdoc_echo_leaves_the_returning_document_ready() {
    richdoc_edit_made_while_parked(true);
}

/// A replica where `doc-b` is ready at `a.md` with a native live binding of
/// its lineage, and never parks: as after Stop, before the replica pulled.
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

/// The drain arm: `doc-b`'s unadmitted edit was queued before its session
/// bound, as one a live session kept queued. The drain that decides it
/// keeps it queued, refusing nothing, and holds the ready `doc-b`; once the
/// binding goes, the drain applies it.
#[test]
fn a_drain_keeps_an_unadmitted_edit_queued_on_a_hosted_replica() {
    let (_scratch, _path, mut store, client, ydoc, lineage) = ready_bound_b();
    let edit = ydoc.plaintext_insert(8, " and more");
    let sha = store.put_binary_blob(&edit).unwrap();
    let key = dohc_engine_collab::DocKey::new("ws", "main", "doc-b").unwrap();
    let op = envelope(
        "peer",
        1,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "doc-b",
            "path": "a.md",
            "contentKind": "plaintext",
            "updateBlobSha256": sha,
            "lineageClaimId": lineage,
            "isBaseState": false
        }),
    );
    crate::apply_envelope_with(&mut store, &op, &NoFaults, |tx, op| {
        crate::ydoc_apply::defer_ydoc_update_in_tx(tx, &key, op, &lineage, 2, Some("relay"))
    })
    .unwrap();
    assert!(ready(&store, "doc-b"));

    let drained = crate::drain_deferred_ydoc_for_key(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .unwrap();
    assert!(drained.refusals.is_empty());
    assert_eq!(drained.drained, 0);
    assert_eq!(hold(&store, "doc-b"), Some(HostedHold::LiveEditUnadmitted));
    assert_eq!(queued_b(&store), r#"[["peer",1,"hosted","relay"]]"#);
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM replication_refused_ydoc_blobs"
        ),
        0
    );

    release_b(&mut store);
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b and more")]));
    assert_eq!(queued_b(&store), "[]");
}

/// The ready hold holds only a ready document of the current scope. One the
/// scope holds for another reason keeps that reason, and one that left the
/// scope keeps its state; each meets its queued edit when a read of it
/// completes.
#[test]
fn the_ready_hold_leaves_other_documents_as_they_are() {
    let hold_b = |store: &mut EngineStore| {
        store
            .write_with(&NoFaults, |tx| {
                crate::hosted::hold_unadmitted_in_tx(tx, "ws", "doc-b")
            })
            .unwrap();
    };
    let (_scratch, _path, mut store, client, _ydoc, _lineage) = ready_bound_b();
    client.transport().share("doc-b", "moved.md");
    sync(&client, &mut store);
    let held = hold(&store, "doc-b");
    assert!(matches!(held, Some(HostedHold::ScopePathMismatch { .. })));
    hold_b(&mut store);
    assert_eq!(hold(&store, "doc-b"), held);

    // Its accepted work is unsettled, so it stays departed and ready.
    let (_scratch, _path, mut store, client, _ydoc, _lineage) = ready_bound_b();
    client.transport().unshare("doc-b");
    sync_parking(&client, &mut store);
    let state = "SELECT state='ready' FROM hosted_documents WHERE object_id='doc-b'";
    assert_eq!(count(&store, state), 1);
    hold_b(&mut store);
    assert_eq!(count(&store, state), 1);
}

/// The ready hold is of the current lineage only: a refused edit of another
/// lineage leaves `doc-b`'s content here whole, so it stays ready.
#[test]
fn an_unadmitted_edit_of_another_lineage_leaves_a_ready_document_ready() {
    let (_scratch, _path, mut store, client, _ydoc, _lineage) = ready_bound_b();
    let other = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "elsewhere");
    peer_update(
        client.transport(),
        "plaintext",
        1,
        "doc-b",
        "a.md",
        other,
        &"f".repeat(64),
    );
    let outcome = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(outcome.held, BTreeMap::new());
    assert!(commit(&client, &mut store, &outcome));
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM replication_refused_ydoc_blobs"
        ),
        1
    );
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

/// Queue `kind` `update` of `doc-b` on `lineage`, as `peer`'s `seq` at
/// relay position `relay_seq`, as a drain leaves one queued.
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

/// Sol's 7h finding and Opus's second: an echo its session admitted, left
/// queued while `doc-b`'s binding stands, holds nothing. `doc-b`'s read
/// completes with only the echo queued once it is back at its scope's path:
/// it waits for that work, the next drain consumes the echo, and `doc-b` is
/// ready with its content as it was.
#[test]
fn a_queued_echo_its_session_admitted_leaves_a_bound_document_ready() {
    let (_scratch, _path, mut store, client, _base, echo, lineage) = ready_bound_richdoc_b();
    let before = content(&store);
    client.transport().share("doc-b", "moved.md");
    sync(&client, &mut store);
    assert!(matches!(
        hold(&store, "doc-b"),
        Some(HostedHold::ScopePathMismatch { .. })
    ));
    queue_b(&mut store, 1, 2, "richdoc", &echo, &lineage);

    client.transport().share("doc-b", "a.md");
    sync(&client, &mut store);
    assert_eq!(hold(&store, "doc-b"), Some(HostedHold::WorkWaiting));
    assert_eq!(queued_b(&store), r#"[["peer",1,"hosted","relay"]]"#);
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(queued_b(&store), "[]");
    assert_eq!(content(&store), before);
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM replication_refused_ydoc_blobs"
        ),
        0
    );
}

/// An echo left queued behind `doc-b`'s unadmitted edit keeps its place.
/// While the binding stands, `doc-b` stays held with both queued, its
/// content as it was, and no pass's drain takes it up again. Once the
/// binding goes, both apply in order, once.
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

/// Opus's 7h first finding: one binding check. A session bound on another
/// lineage of `doc-b` keeps an edit of its current lineage queued as one of
/// that lineage does: `doc-b` is held as live-edit-unadmitted, no drain
/// takes it up again while the binding stands, and once it goes the edit
/// applies.
#[test]
fn a_binding_on_another_lineage_holds_an_unadmitted_edit_until_release() {
    let (_scratch, _path, mut store) = hosted_store();
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
    accept_live_update(&mut store, "doc-b", &"e".repeat(64), b"live update");

    let edit = ydoc.plaintext_insert(8, " and more");
    peer_update(feed, "plaintext", 1, "doc-b", "a.md", edit, &lineage);
    for _ in 0..2 {
        let outcome = pass(&client, &mut store, &NoFaults).unwrap();
        assert_eq!(
            outcome.held,
            BTreeMap::from([("doc-b".to_owned(), HostedHold::LiveEditUnadmitted)])
        );
        assert!(commit(&client, &mut store, &outcome));
        assert_eq!(drained_again(&mut store), Vec::<String>::new());
    }
    assert_eq!(hold(&store, "doc-b"), Some(HostedHold::LiveEditUnadmitted));
    assert_eq!(queued_b(&store), r#"[["peer",1,"hosted","relay"]]"#);
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b")]));

    release_b(&mut store);
    sync(&client, &mut store);
    assert!(ready(&store, "doc-b"));
    assert_eq!(content(&store).0, heads(&[("doc-b", "hosted b and more")]));
    assert_eq!(queued_b(&store), "[]");
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

/// The slice-3 review's second reproduction: the relay serves a refused
/// settlement without validating it, so a refused row naming a hosted
/// document can carry a before side too incomplete to read. Reading it during
/// hydration failed the pass before the refusal was journaled, and every
/// retry met the same row.
#[test]
fn a_refused_settlement_with_an_unreadable_before_side_never_stops_the_feed() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(HostedFeed::new());
    let feed = client.transport();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-a", "a.md", "first");
    let mut refused = envelope(
        "owner",
        2,
        "moment.append",
        json!({
            "momentId": "moment-owner-2",
            "objectId": "doc-a",
            "beforePresent": "present",
            "beforeObjectId": "private"
        }),
    );
    refused.settlement_admission = Some(SettlementAdmission::Refused {
        settlement_id: "unavailable".into(),
        reason: "invalid-proof".into(),
    });
    feed.append(refused);
    feed.replace(
        "owner",
        3,
        "doc-a",
        "a.md",
        "second",
        ("doc-a", "first", "moment-owner-1"),
    );
    feed.share("doc-a", "a.md");
    sync(&client, &mut store);

    assert_eq!(
        content(&store).0,
        BTreeMap::from([("doc-a".to_owned(), "second".to_owned())])
    );
    assert!(coordinates(&store).contains(&("owner".to_owned(), 2)));
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM replication_pending_refusals \
             WHERE origin_id='owner' AND origin_seq=2"
        ),
        1,
        "the refusal is journaled"
    );
    assert!(ready(&store, "doc-a"));
    assert_eq!(
        document(&store, "doc-a").unwrap().backfill_cursor,
        4,
        "the cursor passed the row"
    );
}

/// A before side the feed serves is fetched and kept: the document's own
/// earlier content, or another document the replica hosts. An ordinary
/// replica fetches every before side.
#[test]
fn a_before_side_the_feed_serves_is_fetched_and_kept() {
    let (_scratch, _path, mut store) = hosted_store();
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

/// A hold persisted outside a cursor commit counts as a commit in its own
/// transaction, so a pass pending since then commits nothing over it. The
/// hold reads back with its exact binding, continuation and staleness, and
/// the ready document it holds reads its own rows from the main feed's
/// position.
#[test]
fn a_released_hold_outside_a_commit_invalidates_a_pending_pass() {
    use dohc_engine_collab::live_update_application::{
        IncomingCoordinate, ProtectedTails, ReleasedLineageBinding,
    };
    let (_scratch, _path, mut store) = hosted_store();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "UPDATE hosted_replicas SET main_cursor=7,scope_generation=1; \
                 INSERT INTO hosted_documents (workspace_id,object_id,path,state,scope_generation) \
                 VALUES ('ws','doc','doc.md','ready',1)",
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    let replica = read_hosted_replica(&store, "ws").unwrap().unwrap();
    let pending = HostedCursor {
        scope_generation: replica.scope_generation,
        cursor_commits: replica.cursor_commits,
        main_cursor: Some(9),
        reads: BTreeMap::new(),
        settlement_report_id: None,
    };
    let binding = ReleasedLineageBinding {
        workspace_id: "ws".into(),
        main_version_id: "main".into(),
        object_id: "doc".into(),
        lineage_claim_id: "a".repeat(64),
        current_path: Some("doc.md".into()),
        restore_generation: Some(0),
        incoming: IncomingCoordinate {
            relay_namespace: None,
            replication_epoch: "epoch-1".into(),
            stream_identity: "stream-1".into(),
            origin_id: "peer".into(),
            origin_seq: 3,
            relay_seq: 8,
        },
        head_digest: "b".repeat(64),
        tails: std::sync::Arc::new(ProtectedTails::Invalid),
    };
    store
        .write_with(&NoFaults, |tx| {
            crate::hosted::hold_released_in_tx(
                tx,
                &binding,
                crate::ReleasedHoldContinuation::DependencyDrain,
                true,
            )
        })
        .unwrap();
    assert_eq!(
        crate::commit_hosted_cursor(
            &mut store,
            "ws",
            &pending,
            &ReleasedTails::uncached(),
            &NoFaults
        )
        .unwrap(),
        TxnOutcome::Committed(crate::HostedCommit {
            committed: false,
            has_more: false
        })
    );
    let after = read_hosted_replica(&store, "ws").unwrap().unwrap();
    assert_eq!(
        (after.cursor_commits, after.main_cursor),
        (replica.cursor_commits + 1, 7)
    );
    assert_eq!(
        after.documents["doc"],
        HostedDocumentState {
            path: "doc.md".into(),
            status: HostedDocumentStatus::Held(HostedHold::ReleasedLineageUnsettled {
                binding: Box::new(binding),
                continuation: crate::ReleasedHoldContinuation::DependencyDrain,
                binding_stale: true,
            }),
            backfill_cursor: 7,
        }
    );
}

/// A binding of `object_id`'s lineage at `path` for an update at `relay_seq`.
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

/// A document held for released retained work that nothing holds any more,
/// with no queued update and no row its read stops at, is ready once its
/// next pass commits, and that pass names no hold of it, so the relay host
/// drops the block it kept. A hold an earlier decision stored never outlives
/// a fresh one.
#[test]
fn a_released_hold_nothing_still_justifies_frees_on_the_next_pass() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-a", "a.md", "first");
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    assert!(ready(&store, "doc-a"));
    store
        .write_with(&NoFaults, |tx| {
            crate::hosted::hold_released_in_tx(
                tx,
                &released_binding("doc-a", "a.md", 8),
                crate::ReleasedHoldContinuation::Frozen,
                false,
            )
        })
        .unwrap();
    assert!(matches!(
        document(&store, "doc-a").unwrap().status,
        HostedDocumentStatus::Held(HostedHold::ReleasedLineageUnsettled { .. })
    ));
    let outcome = pass(&client, &mut store, &NoFaults).unwrap();
    assert!(!outcome.held.contains_key("doc-a"), "{outcome:?}");
    assert!(commit(&client, &mut store, &outcome));
    sync(&client, &mut store);
    assert!(ready(&store, "doc-a"));
}

/// Sol's and Opus's r2c-3c-5 finding 1, through the production writers, as
/// Sol's r2c-3c-7 ruling keeps it: a released hold stored, its binding
/// replaced, and the hold freed by the next pass each advance the
/// document's hold revision, so a held proof never reads a binding that
/// changed as current. Storing the hold again as it was advances nothing,
/// and no hold write moves the document's released tail generation, so the
/// validations cached by it stand.
#[test]
fn storing_replacing_and_freeing_a_released_hold_advances_its_revision() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-a", "a.md", "first");
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    assert!(ready(&store, "doc-a"));
    let recorded = store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO released_tail_generations \
                 SELECT workspace_id,main_version_id,'doc-a',1 FROM versioned_workspaces \
                 WHERE workspace_id='ws'",
                [],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    assert_eq!(recorded, TxnOutcome::Committed(1));
    let generation = |store: &EngineStore| {
        count(
            store,
            "SELECT generation FROM released_tail_generations WHERE workspace_id='ws' \
             AND object_id='doc-a' AND version_id= \
               (SELECT main_version_id FROM versioned_workspaces WHERE workspace_id='ws')",
        )
    };
    let revision = |store: &EngineStore| {
        count(
            store,
            "SELECT coalesce((SELECT revision FROM released_hold_revisions \
             WHERE workspace_id='ws' AND object_id='doc-a'),0)",
        )
    };
    let tails = generation(&store);
    let mut before = revision(&store);
    assert_eq!(before, 0, "no hold yet");
    for (what, relay_seq, advances) in [
        ("stored", 8, true),
        ("as it was", 8, false),
        ("replaced", 9, true),
    ] {
        let held = store
            .write_with(&NoFaults, |tx| {
                crate::hosted::hold_released_in_tx(
                    tx,
                    &released_binding("doc-a", "a.md", relay_seq),
                    crate::ReleasedHoldContinuation::Frozen,
                    false,
                )
            })
            .unwrap();
        assert_eq!(held, TxnOutcome::Committed(true), "{what}");
        assert_eq!(revision(&store) > before, advances, "{what}");
        assert_eq!(generation(&store), tails, "{what}: the generation stays");
        before = revision(&store);
    }
    sync(&client, &mut store);
    assert!(ready(&store, "doc-a"));
    assert!(revision(&store) > before, "freed");
}

/// A binding names a relay position from 1. One at 0 would not read back,
/// so no hold stores it: the transaction fails before it counts a commit,
/// and the document stays as it was.
#[test]
fn a_released_hold_whose_binding_does_not_read_back_is_never_stored() {
    let (_scratch, _path, mut store) = hosted_store();
    host_document(&mut store, "doc");
    let before = read_hosted_replica(&store, "ws").unwrap().unwrap();
    let binding = released_binding("doc", "doc.md", 0);
    let held = store.write_with(&NoFaults, |tx| {
        crate::hosted::hold_released_in_tx(
            tx,
            &binding,
            crate::ReleasedHoldContinuation::Frozen,
            false,
        )
    });
    assert!(held.is_err(), "{held:?}");
    assert_eq!(read_hosted_replica(&store, "ws").unwrap().unwrap(), before);
}

/// Sol's r2c-3c-1 finding 2: the store's writer admits a held proof, and
/// releases it, with the same work however many relay namespaces its hold
/// names: neither decodes the binding on the writer's thread, and a hold
/// over 2,000 namespaces takes as many virtual machine steps as one over a
/// single namespace, whether its answer stands or moved.
#[test]
fn a_held_proofs_work_on_the_writer_stays_the_same_however_many_namespaces_it_holds() {
    use dohc_engine_collab::live_update_application::{
        HeldProofJob, ProtectedTail, ProtectedTails, RetainedCoverage,
        binding_decodes_on_this_thread,
    };
    let (_scratch, _path, mut store) = hosted_store();
    host_document(&mut store, "doc");
    let proofs =
        HeldProofs::new(dohc_engine_collab::live_update_application::HeldProofLimit::default());
    let steps = |store: &EngineStore, run: &mut dyn FnMut()| {
        let counted = std::sync::Arc::new(AtomicUsize::new(0));
        let counter = std::sync::Arc::clone(&counted);
        store
            .read_with(|conn| {
                conn.progress_handler(
                    1,
                    Some(move || {
                        counter.fetch_add(1, Ordering::Relaxed);
                        false
                    }),
                )
            })
            .unwrap();
        let decodes = binding_decodes_on_this_thread();
        run();
        assert_eq!(
            binding_decodes_on_this_thread(),
            decodes,
            "the writer decodes no binding"
        );
        store
            .read_with(|conn| conn.progress_handler(0, None::<fn() -> bool>))
            .unwrap();
        counted.load(Ordering::Relaxed)
    };
    let mut work = |namespaces: usize| {
        let mut binding = released_binding("doc", "doc.md", 1);
        binding.tails = std::sync::Arc::new(ProtectedTails::Listed(
            (0..namespaces)
                .map(|index| ProtectedTail {
                    namespace: format!("relay-{index:05}"),
                    activation_id: format!("activation-{index:05}"),
                    release: None,
                    coverage: RetainedCoverage::Invalid,
                })
                .collect(),
        ));
        let held = store
            .write_with(&NoFaults, |tx| {
                crate::hosted::hold_released_in_tx(
                    tx,
                    &binding,
                    ReleasedHoldContinuation::Frozen,
                    false,
                )
            })
            .unwrap();
        assert!(matches!(held, TxnOutcome::Committed(true)), "{namespaces}");
        let proof = prove_held_document(&HeldProofJob::of(&store), "ws", "doc").unwrap();
        let admitted = steps(&store, &mut || {
            drop(admit_held_proof(&store, &proofs, "ws", "doc").unwrap());
        });
        let released = steps(&store, &mut || {
            assert!(release_held_proof(&store, &proof).unwrap().is_some());
        });
        let marked = store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE hosted_documents SET released_hold_binding_stale=1 WHERE object_id='doc'",
                    [],
                )
                .map_err(SyncError::persist)
            })
            .unwrap();
        assert!(matches!(marked, TxnOutcome::Committed(1)), "{namespaces}");
        let moved = steps(&store, &mut || {
            let answer = release_held_proof(&store, &proof).unwrap().unwrap();
            assert_eq!(answer.status, HeldBindingStatus::Stale);
        });
        [admitted, released, moved]
    };
    let one = work(1);
    let many = work(2_000);
    for ((what, one), many) in ["admitted", "released", "moved"].iter().zip(one).zip(many) {
        assert!(
            many < one + 50,
            "{what}: {one} steps over one namespace, {many} over 2,000"
        );
    }
}

/// Sol's r2c-3c-6 finding 2 and Opus's finding 3: a proof reserves what
/// decoding its hold's binding holds, from the binding's stored length,
/// before it reads it. Under a budget smaller than that, it decodes nothing
/// and its callers hear it is too large. The decode count is the evidence:
/// the budget never reserves past itself, so a peak within it shows nothing.
#[test]
fn a_proof_reserves_its_binding_before_it_decodes_it() {
    use dohc_engine_collab::live_update_application::{
        HeldProofLimit, ProofStop, binding_decodes_on_this_thread,
    };
    let (_scratch, _path, mut store) = hosted_store();
    host_document(&mut store, "doc");
    let binding = released_binding("doc", "doc.md", 1);
    let held = store
        .write_with(&NoFaults, |tx| {
            crate::hosted::hold_released_in_tx(
                tx,
                &binding,
                ReleasedHoldContinuation::Frozen,
                false,
            )
        })
        .unwrap();
    assert!(matches!(held, TxnOutcome::Committed(true)), "{held:?}");
    let budget = binding.canonical_json().len() as u64;
    let limit = HeldProofLimit::new(1, budget, 0);
    let proofs = HeldProofs::new(limit.clone());
    let crate::HeldProofAdmission::Started(run, _wait) =
        admit_held_proof(&store, &proofs, "ws", "doc").unwrap()
    else {
        panic!("a free workspace starts its proof")
    };
    let mut observed = None;
    run.prove(|job| {
        let decodes = binding_decodes_on_this_thread();
        let answer = prove_held_document(job, "ws", "doc").map_err(std::sync::Arc::new);
        observed = Some((
            answer
                .as_ref()
                .err()
                .map(|error| matches!(**error, SyncError::Cancelled)),
            job.stopped(),
            binding_decodes_on_this_thread() - decodes,
        ));
        let bytes = answer.as_ref().map_or(0, crate::HeldProof::retained_bytes);
        (answer, bytes)
    });
    let (cancelled, stopped, decodes) = observed.expect("the proof ran");
    assert_eq!(cancelled, Some(true), "it stopped");
    assert_eq!(stopped, Some(ProofStop::TooLarge));
    assert_eq!(decodes, 0, "it decoded nothing");
}

/// Binding version 2 replaced version 1, which nothing reads: a hold that
/// stored a version 1 binding reads as damage, never as no hold, and stays
/// stored.
#[test]
fn a_stored_version_1_binding_reads_as_damage() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/workspace-engine-client/src/relay/releasedLineageBindingVectors.json"
    ))
    .unwrap();
    let v1 = vectors["invalid"]
        .as_array()
        .unwrap()
        .iter()
        .find(|vector| vector["name"] == "a version 1 binding")
        .unwrap()["text"]
        .as_str()
        .unwrap()
        .to_owned();
    let (_scratch, _path, mut store) = hosted_store();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch("UPDATE hosted_replicas SET scope_generation=1")
                .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO hosted_documents (workspace_id,object_id,path,state,scope_generation, \
                   held_reason,released_hold_binding_json,released_hold_binding_digest, \
                   released_hold_continuation) \
                 VALUES ('ws','doc','doc.md','held',1,'released-lineage-unsettled',?1,?2,'frozen')",
                rusqlite::params![v1, "c".repeat(64)],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    let read = read_hosted_replica(&store, "ws");
    assert!(read.is_err(), "{read:?}");
    let stored: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT released_hold_binding_json FROM hosted_documents WHERE object_id='doc'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(stored, v1);
}

/// Queue a Y.Doc update of `object_id` at this coordinate, as a hosted pull
/// under the `relay` feed defers one.
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

/// A page that backfills another document still names each document held
/// for released retained work, so the relay host keeps its block.
#[test]
fn a_backfill_page_reports_a_document_held_for_released_work() {
    let (_scratch, _path, mut store) = hosted_store();
    let client = RelaySyncClient::new(hosted_feed());
    sync(&client, &mut store);
    queue_update(&mut store, "doc-a", "peer", 3);
    let hold = hold_doc_a(&mut store);
    client.transport().share("doc-b", "b.md");
    let adopted = pass(&client, &mut store, &NoFaults).unwrap();
    assert!(
        adopted.pending_cursor.is_none(),
        "the pass adopts the scope"
    );
    let outcome = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(outcome.held.get("doc-a"), Some(&hold), "{outcome:?}");
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

/// Sol's third finding: a released hold whose queued update no longer
/// stands is obsolete, so no pass reports the old binding again. The
/// document's other queued work keeps it from being ready, as ordinary
/// waiting, through every committed pass while that work stays, and it is
/// ready once that work applies.
#[test]
fn a_released_hold_frees_its_binding_once_its_update_is_gone_while_other_work_waits() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-a", "a.md", "first");
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    establish_lineage(&mut store, "doc-a");
    queue_update(&mut store, "doc-a", "peer", 4);
    let justified = {
        queue_update(&mut store, "doc-a", "peer", 3);
        hold_doc_a(&mut store).stale()
    };
    let outcome = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(outcome.held.get("doc-a"), Some(&justified), "{outcome:?}");

    // The held update applied or was refused; the later one still waits.
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM ydoc_deferred_updates WHERE origin_id='peer' AND origin_seq=3",
                [],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    let outcome = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(
        outcome.held.get("doc-a"),
        Some(&HostedHold::WorkWaiting),
        "{outcome:?}"
    );
    assert!(commit(&client, &mut store, &outcome));
    assert_eq!(
        document(&store, "doc-a").unwrap().status,
        HostedDocumentStatus::Held(HostedHold::WorkWaiting)
    );
    for _ in 0..2 {
        let outcome = pass(&client, &mut store, &NoFaults).unwrap();
        assert_eq!(
            outcome.held.get("doc-a"),
            Some(&HostedHold::WorkWaiting),
            "{outcome:?}"
        );
        assert!(commit(&client, &mut store, &outcome));
        assert_eq!(
            document(&store, "doc-a").unwrap().status,
            HostedDocumentStatus::Held(HostedHold::WorkWaiting),
            "the queued update still waits"
        );
    }

    // The last queued update applied.
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM ydoc_deferred_updates", [])
                .map_err(SyncError::persist)
        })
        .unwrap();
    sync(&client, &mut store);
    assert!(ready(&store, "doc-a"));
}

/// Queue a real update of `object_id`'s established lineage at peer 3, the
/// coordinate [`hold_doc_a`]'s binding names, as a hosted pull defers one
/// while a session holds the document.
fn queue_real_update(store: &mut EngineStore, object_id: &str, path: &str) {
    let key = dohc_engine_collab::DocKey::new("ws", "main", object_id).unwrap();
    let head = dohc_engine_collab::load_persisted(store, &key)
        .unwrap()
        .unwrap();
    let sha = store
        .put_binary_blob(&head.doc.plaintext_insert(5, " and more"))
        .unwrap();
    let mut op = envelope(
        "peer",
        3,
        "ydoc.update",
        json!({
            "versionId": "main", "objectId": object_id, "path": path,
            "contentKind": "plaintext", "updateBlobSha256": sha,
            "lineageClaimId": head.marker.lineage_claim_id.unwrap(), "isBaseState": false,
        }),
    );
    op.relay_seq = Some(8);
    crate::router::apply_replication_envelope_in_batch(
        store,
        &mut WriterDocCache::new(),
        &op,
        &NoFaults,
        &AlwaysLive,
        true,
        Some("relay"),
    )
    .unwrap();
}

/// Sol's second and Opus's fourth findings: the pass's drain holds merged,
/// so a frozen hold one step reported outlived the end-of-pass drain that
/// admitted its update, and the pass reported a binding no longer current,
/// which kept its commit from landing. The drain's decision replaces it.
#[test]
fn a_drain_that_admits_a_held_update_clears_the_hold_its_pass_reported() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-a", "a.md", "first");
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    establish_lineage(&mut store, "doc-a");
    queue_real_update(&mut store, "doc-a", "a.md");
    let frozen = hold_doc_a(&mut store);
    // The next op of the document stops at the frozen hold.
    client.transport().replace(
        "owner",
        2,
        "doc-a",
        "a.md",
        "edited",
        ("doc-a", "first", "moment-owner-1"),
    );
    let outcome = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(
        count(&store, "SELECT COUNT(*) FROM ydoc_deferred_updates"),
        0,
        "the end-of-pass drain admitted the held update"
    );
    assert!(outcome.held.contains_key("doc-a"), "{outcome:?}");
    assert_ne!(outcome.held.get("doc-a"), Some(&frozen), "{outcome:?}");
    assert!(
        commit(&client, &mut store, &outcome),
        "no obsolete binding stops the commit"
    );
    assert_ne!(hold(&store, "doc-a"), Some(frozen));
}

/// Sol's third test: queued work of a held document that no op of the pass
/// carries, which only the end-of-pass drain admits, reaches the pass once:
/// the record facts its Collection record's field changes committed, the
/// refusal of an update it applied but could not project, and its head.
#[test]
fn the_end_of_pass_drain_reports_what_it_admits_to_the_pass_once() {
    const RECORD_ID: &str = "rec_eeeeeeeeeeeeeeeeeeeeeeeeee";
    const PATH: &str = "tasks/a.md";
    let markdown = format!("---\nid: {RECORD_ID}\ntitle: Original\n---\n\nBody\n");
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create(
        "owner",
        1,
        "schema",
        "tasks/collection.yaml",
        "fields:\n  title:\n    type: text\n",
    );
    feed.create("owner", 2, "doc-a", PATH, &markdown);
    feed.share("schema", "tasks/collection.yaml");
    feed.share("doc-a", PATH);
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    assert!(ready(&store, "doc-a"));
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, "ws", "main")?;
            dohc_engine_domain::set_collection_adoption_state_in_tx(
                tx, "ws", "main", PATH, RECORD_ID, "adopted",
            )
        })
        .unwrap();
    let key = dohc_engine_collab::DocKey::new("ws", "main", "doc-a").unwrap();
    let local = dohc_engine_collab::Ydoc::wire();
    local
        .rewrite_content_to_markdown(dohc_engine_collab::ContentKind::Richdoc, &markdown)
        .unwrap();
    dohc_engine_collab::claim_base(
        &mut store,
        &key,
        dohc_engine_collab::ContentKind::Richdoc,
        &local.encode_full_state(),
        &NoFaults,
        1_500,
    )
    .unwrap();
    // A session held the document while two field changes arrived.
    for (seq, title) in [(3, "Remote"), (4, "Refused")] {
        let head = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap();
        let remote = dohc_engine_collab::Ydoc::wire();
        remote.apply(&head.doc.encode_full_state()).unwrap();
        let sha = store
            .put_binary_blob(&remote.frontmatter_set("title", title).unwrap())
            .unwrap();
        let mut op = envelope(
            "peer",
            seq,
            "ydoc.update",
            json!({
                "versionId": "main", "objectId": "doc-a", "path": PATH,
                "contentKind": "richdoc", "updateBlobSha256": sha,
                "lineageClaimId": head.marker.lineage_claim_id.unwrap(), "isBaseState": false,
            }),
        );
        op.relay_seq = Some(10 + seq);
        crate::router::apply_replication_envelope_in_batch(
            &mut store,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &AlwaysLive,
            true,
            Some("relay"),
        )
        .unwrap();
    }
    // The later one names a path its document does not have.
    store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "UPDATE replication_log SET payload_json=json_set(payload_json,'$.path','tasks/b.md') \
                   WHERE origin_id='peer' AND origin_seq=4; \
                 UPDATE hosted_documents SET state='held',held_reason='hosted-backfill-work-waiting' \
                   WHERE object_id='doc-a'",
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    assert_eq!(
        count(&store, "SELECT COUNT(*) FROM ydoc_deferred_updates"),
        2
    );

    let outcome = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(
        count(&store, "SELECT COUNT(*) FROM ydoc_deferred_updates"),
        0,
        "the end-of-pass drain admitted both"
    );
    assert_eq!(
        outcome
            .record_facts
            .iter()
            .map(|facts| facts.record_id.as_str())
            .collect::<Vec<_>>(),
        [RECORD_ID, RECORD_ID],
        "{outcome:?}"
    );
    assert!(
        outcome
            .refusals
            .iter()
            .any(|refusal| (refusal.origin_id.as_str(), refusal.origin_seq) == ("peer", 4)),
        "{outcome:?}"
    );
    assert!(
        outcome
            .changed_paths
            .iter()
            .any(|change| change.path == PATH && change.operation == "write"),
        "{outcome:?}"
    );
    assert!(commit(&client, &mut store, &outcome));
    let next = pass(&client, &mut store, &NoFaults).unwrap();
    assert!(next.record_facts.is_empty(), "{next:?}");
}

/// Sol's seventh test: a document held for released work that also has
/// retained work of its own keeps the released hold, its binding and all,
/// through a pass, its commit and a restart. A read of it that completes
/// with nothing stopping it, as a cursor the driver hands back names it,
/// names that hold too while the retained work has still not applied.
#[test]
fn a_released_hold_outranks_the_retained_work_of_its_document() {
    let (_scratch, path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    feed.create("owner", 1, "doc-a", "a.md", "first");
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    establish_lineage(&mut store, "doc-a");
    queue_update(&mut store, "doc-a", "peer", 3);
    // No drain decides the queued update, so the hold claims no currency.
    let released = hold_doc_a(&mut store).stale();
    let identity = read_sync_identity(&store, "ws").unwrap().unwrap();
    crate::deferred::retain(
        &mut store,
        &identity,
        Some("relay"),
        &[&document_op(9, 2, "doc-a")],
        &NoFaults,
    )
    .unwrap();
    assert_eq!(retained(&store), 1);
    let outcome = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(outcome.held.get("doc-a"), Some(&released), "{outcome:?}");
    assert!(commit(&client, &mut store, &outcome));
    assert_eq!(hold(&store, "doc-a"), Some(released.clone()));

    drop(store);
    let mut store = EngineStore::open(&path, 3_000).unwrap();
    assert_eq!(hold(&store, "doc-a"), Some(released.clone()));
    let outcome = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(outcome.held.get("doc-a"), Some(&released), "{outcome:?}");

    crate::deferred::retain(
        &mut store,
        &identity,
        Some("relay"),
        &[&document_op(10, 3, "doc-a")],
        &NoFaults,
    )
    .unwrap();
    let replica = read_hosted_replica(&store, "ws").unwrap().unwrap();
    let completed = HostedCursor {
        scope_generation: replica.scope_generation,
        cursor_commits: replica.cursor_commits,
        main_cursor: None,
        reads: BTreeMap::from([(
            "doc-a".to_owned(),
            crate::HostedRead {
                cursor: replica.documents["doc-a"].backfill_cursor,
                stopped: None,
                complete: true,
                heads_written: false,
            },
        )]),
        settlement_report_id: None,
    };
    assert_eq!(
        crate::commit_hosted_cursor(
            &mut store,
            "ws",
            &completed,
            &ReleasedTails::uncached(),
            &NoFaults
        )
        .unwrap(),
        TxnOutcome::Committed(crate::HostedCommit {
            committed: true,
            has_more: false
        })
    );
    assert_eq!(hold(&store, "doc-a"), Some(released.clone()));
    drop(store);
    let store = EngineStore::open(&path, 3_000).unwrap();
    assert_eq!(hold(&store, "doc-a"), Some(released));
}

/// A released hold for a document no hosted row holds stores nothing and
/// says so, so no drain queues later updates behind it.
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

/// Retained relay work that recorded no feed keeps that when it moves to
/// the Y.Doc queue: it is never relabelled from the configuration.
#[test]
fn retained_work_without_a_recorded_feed_moves_queues_without_one() {
    let (_scratch, _path, mut store) = hosted_store();
    host_document(&mut store, "doc");
    let identity = read_sync_identity(&store, "ws").unwrap().unwrap();
    let op = document_op(1, 5, "doc");
    crate::deferred::retain(&mut store, &identity, Some("relay"), &[&op], &NoFaults).unwrap();
    // As a store from before feeds were recorded has it.
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE relay_deferred_ops SET ingress_kind='legacy-unknown',relay_namespace=NULL",
                [],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    defer_update(&mut store, 1, 5, Some("relay")).unwrap();
    assert_eq!(
        recorded_feeds(&store),
        [
            ("relay".to_owned(), 1, "legacy-unknown".to_owned(), None),
            ("ydoc:-/-".to_owned(), 1, "legacy-unknown".to_owned(), None),
        ]
    );
}

/// What this connection has written, to show a probe wrote nothing.
fn total_changes(store: &EngineStore) -> u64 {
    store
        .read_with(|conn| Ok::<_, SyncError>(conn.total_changes()))
        .unwrap()
}

/// Confirm the origin, and check that it sent exactly one empty push from
/// the start of the host's origin and wrote nothing.
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

/// #2088: the relay may hold the host's origin up to what the replica
/// numbered: nothing on a fresh replica, everything it pushed, or less
/// while journaled rows wait for the next push.
#[test]
fn the_origin_probe_accepts_a_relay_no_further_than_the_replica_numbered() {
    let (_scratch, _path, mut store) = hosted_store();
    host_document(&mut store, "doc-a");
    let client = RelaySyncClient::new(HostedFeed::new());
    confirm(&client, &store).unwrap();

    journal_live_update(&mut store, "doc-a", b"one");
    journal_live_update(&mut store, "doc-a", b"two");
    client
        .push_workspace(&mut store, "ws", &NoFaults, &NoLiveLeases, 3_000, 1_000_000)
        .unwrap();
    assert_eq!(last_outbound_seq(&store), 1);
    confirm(&client, &store).unwrap();

    journal_live_update(&mut store, "doc-a", b"unpushed");
    assert_eq!(last_outbound_seq(&store), 2);
    confirm(&client, &store).unwrap();
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

/// #2088's reproduction: a store restored from a copy older than its last
/// push. The feed serves the host's own rows back, so one pull imports them
/// and the journal's maximum climbs to the relay's, which hides the loss
/// from a push. The counter still says what this store numbered.
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
