//! Y.Doc base ORIGINATION.
//!
//! Journaling an outbound `ydoc.update` needs a replicated exact claim, and
//! before this suite the only thing that established one was the inbound apply
//! of a peer's `isBaseState: true`
//! envelope. No production Rust emitted one, so two daemon peers could join a
//! lineage that already existed and could never start one.
//!
//! Every scenario here replays the originated ops into a clean peer — one with
//! no file and no prior CRDT state, reconstructing from the log alone. That is
//! the only assertion that catches the failure this feature is about: a base
//! that omits rows the origin already held looks perfect from the origin, which
//! reconstructs them from its own private tables.

use dohc_engine_collab::{ContentKind, DocKey, LeaseRegistry, Regime, Ydoc};
use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_engine_runtime::{
    CancellationToken, CaptureIngest, CaptureRetire, NoFaults, RuntimeError, WorkspaceSupervisor,
};
use dohc_engine_storage::{EngineStore, StorageError, TxnOutcome};
use dohc_engine_sync::{
    AlwaysLive, BaseOrigination, NoLiveLeases, ReplicationEnvelope, SyncError, apply_ydoc_envelope,
    drain_deferred_ydoc_for_key, originate_ydoc_base_in_tx,
};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::path::Path;
use std::sync::Arc;
use yrs::{Any, Doc, OffsetKind, Options, ReadTxn, Text, Transact};

/// A locally-originated relay-visible op, shaped as a peer receives it.
#[derive(Debug, Clone)]
struct LoggedOp {
    origin_id: String,
    origin_seq: i64,
    op_kind: String,
    payload: serde_json::Value,
    recorded_at_ms: i64,
}

impl LoggedOp {
    fn is_base(&self) -> bool {
        self.payload.get("isBaseState") == Some(&serde_json::Value::Bool(true))
    }

    fn blob_sha(&self) -> String {
        self.payload
            .get("updateBlobSha256")
            .and_then(serde_json::Value::as_str)
            .expect("every ydoc.update names its blob")
            .to_owned()
    }
}

fn read_local_ops(store: &EngineStore) -> Vec<LoggedOp> {
    store
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT origin_id, origin_seq, op_kind, payload_json, recorded_at_ms \
                 FROM replication_log WHERE imported = 0 ORDER BY origin_id, origin_seq",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    let payload: String = row.get(3)?;
                    Ok(LoggedOp {
                        origin_id: row.get(0)?,
                        origin_seq: row.get(1)?,
                        op_kind: row.get(2)?,
                        payload: serde_json::from_str(&payload).expect("payload json"),
                        recorded_at_ms: row.get(4)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>(rows)
        })
        .expect("read local ops")
}

fn local_ydoc_ops(db: &Path) -> Vec<LoggedOp> {
    let store = EngineStore::open(db, 9_100).expect("open store");
    read_local_ydoc_ops(&store)
}

fn read_local_ydoc_ops(store: &EngineStore) -> Vec<LoggedOp> {
    read_local_ops(store)
        .into_iter()
        .filter(|op| op.op_kind == "ydoc.update")
        .collect()
}

fn read_base_ops_in_log(store: &EngineStore) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE op_kind = 'ydoc.update' \
                   AND json_extract(payload_json, '$.isBaseState') = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("count bases")
}

/// Durable CRDT rows for one lineage: `(updates, snapshots)`.
fn read_lineage_rows(store: &EngineStore, key: &DocKey) -> (i64, i64) {
    store
        .read_with(|conn| {
            let count = |table: &str| -> Result<i64, rusqlite::Error> {
                conn.query_row(
                    &format!(
                        "SELECT COUNT(*) FROM {table} \
                         WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3"
                    ),
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                    |row| row.get(0),
                )
            };
            Ok::<_, rusqlite::Error>((count("ydoc_updates")?, count("ydoc_snapshots")?))
        })
        .expect("count lineage rows")
}

fn deferred_rows(store: &EngineStore, key: &DocKey) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM ydoc_deferred_updates \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |row| row.get(0),
            )
        })
        .expect("count deferred rows")
}

fn marker_state(db: &Path, key: &DocKey) -> (Regime, bool) {
    let store = EngineStore::open(db, 9_102).expect("open store");
    read_marker_state(&store, key)
}

fn read_marker_state(store: &EngineStore, key: &DocKey) -> (Regime, bool) {
    let marker = dohc_engine_collab::read_marker(store, key)
        .expect("read marker")
        .expect("marker exists");
    (
        marker.regime,
        marker.lineage_claim_status.has_claimed_base(),
    )
}

#[derive(Debug, PartialEq, Eq)]
struct YdocSnapshotState {
    up_to_seq: i64,
    snapshot_blob_sha256: String,
    state_vector_blob_sha256: String,
    recorded_at_ms: i64,
}

#[derive(Debug, PartialEq, Eq)]
struct CaptureRetireState {
    aliases: i64,
    snapshots: i64,
    moments: i64,
    replication_log: i64,
    ydoc_docs: i64,
    ydoc_updates: i64,
    ydoc_snapshots: Vec<YdocSnapshotState>,
    ydoc_deferred_updates: i64,
}

fn capture_retire_state(db: &Path, key: &DocKey, path: &str) -> CaptureRetireState {
    let store = EngineStore::open(db, 9_109).expect("open store");
    store
        .read_with(|conn| {
            let lineage_count = |table: &str| -> Result<i64, rusqlite::Error> {
                conn.query_row(
                    &format!(
                        "SELECT COUNT(*) FROM {table} \
                         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3"
                    ),
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                    |row| row.get(0),
                )
            };
            let ydoc_snapshots = {
                let mut statement = conn.prepare(
                    "SELECT up_to_seq, snapshot_blob_sha256, state_vector_blob_sha256, \
                     recorded_at_ms FROM ydoc_snapshots \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
                     ORDER BY up_to_seq",
                )?;
                let rows = statement.query_map(
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                    |row| {
                        Ok(YdocSnapshotState {
                            up_to_seq: row.get(0)?,
                            snapshot_blob_sha256: row.get(1)?,
                            state_vector_blob_sha256: row.get(2)?,
                            recorded_at_ms: row.get(3)?,
                        })
                    },
                )?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            Ok::<_, rusqlite::Error>(CaptureRetireState {
                aliases: conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases \
                     WHERE workspace_id=?1 AND version_id=?2 AND path=?3",
                    rusqlite::params![key.workspace_id, key.version_id, path],
                    |row| row.get(0),
                )?,
                snapshots: lineage_count("snapshots")?,
                moments: conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id=?1 AND object_id=?2",
                    rusqlite::params![key.workspace_id, key.object_id],
                    |row| row.get(0),
                )?,
                replication_log: conn.query_row(
                    "SELECT COUNT(*) FROM replication_log WHERE workspace_id=?1",
                    [&key.workspace_id],
                    |row| row.get(0),
                )?,
                ydoc_docs: lineage_count("ydoc_docs")?,
                ydoc_updates: lineage_count("ydoc_updates")?,
                ydoc_snapshots,
                ydoc_deferred_updates: lineage_count("ydoc_deferred_updates")?,
            })
        })
        .expect("read capture-retire durable state")
}

/// The workspace has an origin identity. This alone is not sync: ordinary
/// local chat writes mint one (`local_replication_coordinate`), so
/// [`chat_minted_identity`] is the shape a purely private workspace reaches.
fn seed_identity(db: &Path, workspace_id: &str) {
    let mut store = EngineStore::open(db, 9_103).expect("open store");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO sync_identity \
                 (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
                 VALUES (?1, 'origin-local', 'epoch-local', 'stream-local', 1)",
                rusqlite::params![workspace_id],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("seed identity");
}

/// Sync is genuinely on: the workspace has an identity and a durable relay
/// position, which only a committed pull cursor or a successful push writes.
/// That pair is what makes a lineage eligible to originate.
fn enable_sync(db: &Path, workspace_id: &str) {
    seed_identity(db, workspace_id);
    let mut store = EngineStore::open(db, 9_106).expect("open store");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO sync_relay_push_state \
                 (workspace_id, origin_id, pushed_seq) VALUES (?1, 'origin-local', 0)",
                rusqlite::params![workspace_id],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("enable sync");
}

fn blob_bytes(db: &Path, sha: &str) -> Vec<u8> {
    let store = EngineStore::open(db, 9_104).expect("open store");
    read_blob_bytes(&store, sha)
}

fn read_blob_bytes(store: &EngineStore, sha: &str) -> Vec<u8> {
    store
        .get_binary_blob(sha)
        .expect("read blob")
        .expect("the journaled blob exists locally")
}

/// Replay `ops` into a clean peer and return the text it materialized for
/// `path`. The blobs travel first, exactly as `push_workspace` uploads them
/// before the log ops that reference them.
fn replay_into_clean_peer(
    source: &EngineStore,
    ops: &[LoggedOp],
    workspace_id: &str,
    path: &str,
) -> String {
    let scratch = ScratchDir::new().expect("peer scratch");
    let db = engine_db_path(&scratch).expect("peer db");
    let mut peer = EngineStore::open(&db, 9_200).expect("open peer store");
    VersionedTextStore::new(&mut peer)
        .ensure_main_version(workspace_id, "main", 1_000, &NoFaults)
        .expect("peer main version");

    // This focused replay omits unrelated ops before the first Y.Doc coordinate.
    let origins = ops
        .iter()
        .map(|op| op.origin_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        origins.len(),
        1,
        "sequence rebasing requires one originating stream"
    );
    let first_origin_seq = ops.first().map_or(0, |op| op.origin_seq);
    for op in ops {
        let bytes = read_blob_bytes(source, &op.blob_sha());
        peer.put_binary_blob(&bytes).expect("peer blob");
        let envelope = ReplicationEnvelope {
            settlement_admission: None,
            admitted_author_snapshot: None,
            workspace_id: workspace_id.to_owned(),
            origin_id: op.origin_id.clone(),
            origin_seq: op.origin_seq - first_origin_seq,
            relay_seq: Some(op.origin_seq - first_origin_seq),
            op_kind: op.op_kind.clone(),
            payload: op.payload.clone(),
            recorded_at_ms: op.recorded_at_ms,
        };
        apply_ydoc_envelope(
            &mut peer,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &envelope,
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("the clean peer applies every originated op");
    }

    peer_text(&peer, workspace_id, path)
}

/// The text `peer` materialized for `path` on main.
fn peer_text(peer: &EngineStore, workspace_id: &str, path: &str) -> String {
    peer.read_with(|conn| {
        conn.query_row(
            "SELECT b.text FROM path_aliases a \
             JOIN snapshots s ON s.workspace_id = a.workspace_id AND s.object_id = a.object_id \
             JOIN blobs b ON b.sha256 = s.blob_sha256 \
             WHERE a.workspace_id = ?1 AND a.version_id = 'main' AND a.path = ?2",
            rusqlite::params![workspace_id, path],
            |row| row.get::<_, String>(0),
        )
    })
    .expect("the peer materialized the document")
}

async fn capture_seed(
    handle: &dohc_engine_runtime::ActorHandle,
    workspace_id: &str,
    path: &str,
    now_ms: i64,
) -> String {
    handle
        .capture_ingest(
            CaptureIngest {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: path.to_owned(),
                text: "seed\n".to_owned(),
                metadata_origin: "capture".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms,
                request_id: Some(format!("origination-seed-{now_ms}")),
                claim_foreign_head: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture")
        .snapshot
        .object_id
}

/// The fresh-creation path: a first edit on a synced workspace mints exactly
/// one base, later edits journal deltas, and a clean peer rebuilds the document
/// from that pair alone.
///
/// Mutation check: sever the claim (make `ydoc_originate_base_in_tx` return
/// `Ok(None)` unconditionally) and this test fails at the first assertion —
/// nothing is journaled at all, because `emit_outbound` stays false forever.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_first_edit_on_a_synced_workspace_originates_one_base_then_deltas() {
    const WS: &str = "ws-originate-fresh";
    const PATH: &str = "notes/rich.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    enable_sync(&db, WS);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    let key = DocKey::new(WS, "main", &object_id).expect("key");

    let doc = Ydoc::wire();
    let first = doc.plaintext_insert(0, "hello ");
    let first_append = handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            first,
            None,
            None,
            None,
            // The real seed path: `ydoc.recordUpdate` sets this for the first
            // update of an absent lineage.
            true,
            None,
            None,
            200,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("first update");

    let ops = local_ydoc_ops(&db);
    assert_eq!(ops.len(), 1, "the first edit originates exactly one op");
    assert!(ops[0].is_base(), "and that op is the base state");
    assert_eq!(ops[0].op_kind, "ydoc.update");
    assert_eq!(
        marker_state(&db, &key),
        (Regime::Replicated, true),
        "originating promotes the lineage and claims its base"
    );

    let second = doc.plaintext_insert(6, "world");
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            second,
            None,
            None,
            first_append.lineage_claim_id,
            false,
            None,
            None,
            300,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("second update");
    supervisor.close(&db).expect("close actor");
    let store = EngineStore::open(&db, 9_107).expect("reopen for assertions");

    let ops = read_local_ydoc_ops(&store);
    assert_eq!(ops.len(), 2, "base once, then deltas");
    assert!(ops[0].is_base());
    assert!(!ops[1].is_base(), "a claimed lineage never re-emits a base");
    assert_eq!(read_base_ops_in_log(&store), 1);

    assert_eq!(
        replay_into_clean_peer(&store, &ops, WS, PATH),
        "hello world",
        "a peer with no file and no prior state reconstructs the document"
    );
}

/// Edit a lineage twice on a workspace prepared by `prepare`, then assert it
/// stayed private: no replication op, and a prunable local-only marker.
async fn two_edits_originate_nothing(ws: &str, path: &str, prepare: fn(&Path, &str)) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    prepare(&db, ws);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, ws, path, 100).await;
    let key = DocKey::new(ws, "main", &object_id).expect("key");

    let doc = Ydoc::wire();
    for (index, (text, now)) in [("alpha", 200), (" beta", 300)].into_iter().enumerate() {
        let update = doc.plaintext_insert(u32::try_from(index * 5).expect("offset"), text);
        let append = handle
            .ydoc_record_update(
                key.clone(),
                path.to_owned(),
                ContentKind::Plaintext,
                Regime::LocalOnly,
                update,
                None,
                None,
                None,
                false,
                None,
                None,
                now,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
            )
            .await
            .expect("local-only update");
        // The benign reasons a lineage does not originate stay silent. A
        // private workspace has no peer to share with — that is not a decline
        // the user has to hear about.
        assert_eq!(append.sharing_declined, None);
    }
    supervisor.close(&db).expect("close actor");
    let store = EngineStore::open(&db, 9_107).expect("reopen for assertions");

    assert!(
        read_local_ydoc_ops(&store).is_empty(),
        "a private workspace journals no replication op"
    );
    assert_eq!(
        read_marker_state(&store, &key),
        (Regime::LocalOnly, false),
        "and its lineage stays prunable local-only"
    );
}

/// A workspace that never contacted a relay is private: it originates nothing,
/// and its lineage stays prunable local-only however many times it is edited.
///
/// Mutation check: drop the relay-replication gate in
/// `ydoc_originate_base_in_tx` and the claim still succeeds while
/// `journal_local_op_in_tx` refuses, which rolls back the user's edit — this
/// test fails on the op count and the marker.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unsynced_workspace_never_originates() {
    two_edits_originate_nothing("ws-originate-private", "notes/private.md", |_, _| {}).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_lease_blocks_capture_retire_until_retry_and_rolls_back_every_row() {
    const WS: &str = "ws-originate-capture-live-lease";
    const PATH: &str = "notes/live-capture-retire.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    enable_sync(&db, WS);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    let key = DocKey::new(WS, "main", &object_id).expect("key");
    let doc = Ydoc::wire();
    let first_append = handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            doc.plaintext_insert(0, "first live edit\n"),
            None,
            None,
            None,
            false,
            None,
            None,
            200,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("record first Y.Doc update");
    supervisor.close(&db).expect("close actor for fixture seed");

    let mut store = EngineStore::open(&db, 9_351).expect("open fixture store");
    dohc_engine_collab::maybe_compact(&mut store, &key, 0, &NoFaults, 250)
        .expect("seed a durable Y.Doc snapshot");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO ydoc_deferred_updates \
                 (workspace_id, version_id, object_id, origin_id, origin_seq, recorded_at_ms) \
                 VALUES (?1, ?2, ?3, 'deferred-peer', 0, 260)",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("seed a deferred Y.Doc update");
    drop(store);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 2).expect("reopen actor").actor;
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::Replicated,
            doc.plaintext_insert(16, "second live edit\n"),
            None,
            None,
            first_append.lineage_claim_id,
            false,
            None,
            None,
            270,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("record a post-snapshot Y.Doc update");

    let before = capture_retire_state(&db, &key, PATH);
    assert_eq!(before.aliases, 1, "the captured path is live");
    assert_eq!(before.snapshots, 1, "the text snapshot is live");
    assert!(before.moments > 0, "the text history is seeded");
    assert!(before.replication_log > 0, "the outbound log is seeded");
    assert_eq!(
        (
            before.ydoc_docs,
            before.ydoc_updates,
            before.ydoc_deferred_updates,
        ),
        (1, 1, 1),
        "every Y.Doc lineage table has a rollback witness"
    );
    assert_eq!(
        before
            .ydoc_snapshots
            .iter()
            .map(|snapshot| snapshot.up_to_seq)
            .collect::<Vec<_>>(),
        vec![0, 1],
        "the durable lineage has its base snapshot and compacted snapshot"
    );

    let input = CaptureRetire {
        workspace_id: WS.to_owned(),
        version_id: "main".to_owned(),
        path: PATH.to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        now_ms: 300,
        request_id: None,
        only_if_text_head: true,
        only_if_capture_origin: true,
        allow_ydoc_origin: true,
    };
    let leases = LeaseRegistry::new();
    let lease = leases.acquire(&key).expect("hold live session lease");
    let error = dohc_engine_testkit::capture::retire_captured_path(
        &handle,
        input.clone(),
        scratch.path(),
        leases.clone(),
        Arc::new(NoFaults),
    )
    .await
    .expect_err("a live Y.Doc lease must make capture retirement retryable");
    assert!(matches!(
        error,
        RuntimeError::Sync(SyncError::RetryableState {
            reason: dohc_engine_runtime::actor::CAPTURE_RETIRE_WAITS_FOR_SESSION
        })
    ));
    assert_eq!(
        capture_retire_state(&db, &key, PATH),
        before,
        "the retryable refusal must roll back the snapshot, moment, log, and lineage deletes"
    );
    drop(lease);

    // An internal attempt's release wakes nothing, so capture must not wait
    // for it: its lease refuses as an ordinary retryable failure.
    let internal = leases.acquire_internal(&key).expect("hold internal lease");
    let error = dohc_engine_testkit::capture::retire_captured_path(
        &handle,
        input.clone(),
        scratch.path(),
        leases.clone(),
        Arc::new(NoFaults),
    )
    .await
    .expect_err("an internal lease must make capture retirement retryable");
    assert!(matches!(
        error,
        RuntimeError::Sync(SyncError::RetryableState {
            reason: "ydoc-session-live"
        })
    ));
    assert_eq!(capture_retire_state(&db, &key, PATH), before);
    drop(internal);

    let error = dohc_engine_testkit::capture::retire_captured_path(
        &handle,
        input.clone(),
        scratch.path(),
        leases.clone(),
        Arc::new(NoFaults),
    )
    .await
    .expect_err("an unseen deferred update must keep retirement retryable");
    assert!(matches!(
        error,
        RuntimeError::Sync(SyncError::RetryableState {
            reason: "ydoc-deferred-updates-pending"
        })
    ));
    assert_eq!(
        capture_retire_state(&db, &key, PATH),
        before,
        "the deferred-update refusal must also roll back every delete"
    );

    supervisor.close(&db).expect("close actor to drain fixture");
    let mut store = EngineStore::open(&db, 9_352).expect("open fixture store");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM ydoc_deferred_updates \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("resolve the fixture's deferred update");
    drop(store);

    let handle = supervisor
        .open(&db, 3)
        .expect("reopen actor for retry")
        .actor;
    let retired = dohc_engine_testkit::capture::retire_captured_path(
        &handle,
        input,
        scratch.path(),
        leases,
        Arc::new(NoFaults),
    )
    .await
    .expect("capture retire retries after the session closes");
    assert!(retired.retired.is_some());
    let after = capture_retire_state(&db, &key, PATH);
    assert_eq!((after.aliases, after.snapshots), (0, 0));
    assert_eq!(after.moments, before.moments + 1);
    assert_eq!(after.replication_log, before.replication_log + 1);
    assert_eq!(
        (
            after.ydoc_docs,
            after.ydoc_updates,
            after.ydoc_deferred_updates,
        ),
        (0, 0, 0),
        "the successful retry retires the complete Y.Doc lineage"
    );
    assert!(
        after.ydoc_snapshots.is_empty(),
        "the successful retry removes every Y.Doc snapshot"
    );
    supervisor.close(&db).expect("close actor");
}

const WS_TWO_DEVICES: &str = "ws-two-devices";

/// The file a device holds before it opens it. Two devices that received the
/// file from the relay hold the same object and the same head moment.
fn seed_shared_file(db: &Path, object_id: &str, path: &str, moment_id: &str, text: &str) {
    let mut store = EngineStore::open(db, 9_111).expect("open store");
    let mut versions = VersionedTextStore::new(&mut store);
    versions
        .ensure_main_version(WS_TWO_DEVICES, "main", 1, &NoFaults)
        .expect("main version");
    versions
        .write_text(
            &WriteText {
                workspace_id: WS_TWO_DEVICES.to_owned(),
                version_id: "main".to_owned(),
                object_id: object_id.to_owned(),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: moment_id.to_owned(),
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("seed shared file");
}

/// Open `path` as the editor does and build the seed it sends: the head's text
/// under the Yjs client the engine names. The Rust editor stand-in builds
/// different bytes than the TypeScript editor, but two devices running the
/// same editor build the same bytes; the e2e two-client test covers the real
/// editor.
async fn open_with_seed(
    handle: &dohc_engine_runtime::ActorHandle,
    workspace_id: &str,
    path: &str,
) -> (DocKey, u32, Vec<u8>) {
    let state = handle
        .ydoc_open_state(
            workspace_id.to_owned(),
            150,
            true,
            None,
            "main".to_owned(),
            path.to_owned(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("open");
    let client_id = state
        .seed_client_id
        .expect("an absent lineage names its seed client");
    let text = state
        .seed_content
        .expect("an absent lineage carries seed content");
    let doc = Doc::with_options(Options {
        client_id: yrs::ClientID::new(u64::from(client_id)),
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    let root = doc.get_or_insert_text(dohc_engine_collab::ROOT_PLAINTEXT);
    root.insert(&mut doc.transact_mut(), 0, &text);
    let seed = doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    (state.key, client_id, seed)
}

/// Record `update` as the editor's next write to `key`.
async fn record_editor_update(
    handle: &dohc_engine_runtime::ActorHandle,
    key: &DocKey,
    path: &str,
    update: Vec<u8>,
    lineage: Option<String>,
    seeding: bool,
) -> Option<String> {
    handle
        .ydoc_record_update(
            key.clone(),
            path.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            update,
            None,
            None,
            lineage,
            seeding,
            None,
            None,
            200,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("record editor update")
        .lineage_claim_id
}

/// One device opens the document, seeds it, and types `edit` at the end.
async fn open_and_type(db: &Path, path: &str, edit: &str) -> DocKey {
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(db, 1).expect("open actor").actor;
    let (key, _, seed) = open_with_seed(&handle, WS_TWO_DEVICES, path).await;
    let claim = record_editor_update(&handle, &key, path, seed.clone(), None, true).await;
    let doc = Ydoc::wire();
    doc.apply(&seed).expect("apply seed");
    let end = u32::try_from(doc.plaintext_string().encode_utf16().count()).expect("length");
    record_editor_update(
        &handle,
        &key,
        path,
        doc.plaintext_insert(end, edit),
        claim,
        false,
    )
    .await;
    supervisor.close(db).expect("close actor");
    key
}

/// `ops` as another device receives them from the relay: under `origin`,
/// renumbered from zero, at `relay_seqs`, each with its blob.
fn relayed(
    from: &Path,
    ops: &[LoggedOp],
    origin: &str,
    relay_seqs: &[i64],
) -> Vec<(ReplicationEnvelope, Vec<u8>)> {
    let first = ops.first().map_or(0, |op| op.origin_seq);
    ops.iter()
        .zip(relay_seqs)
        .map(|(op, relay_seq)| {
            (
                ReplicationEnvelope {
                    settlement_admission: None,
                    admitted_author_snapshot: None,
                    workspace_id: WS_TWO_DEVICES.to_owned(),
                    origin_id: origin.to_owned(),
                    origin_seq: op.origin_seq - first,
                    relay_seq: Some(*relay_seq),
                    op_kind: op.op_kind.clone(),
                    payload: op.payload.clone(),
                    recorded_at_ms: op.recorded_at_ms,
                },
                blob_bytes(from, &op.blob_sha()),
            )
        })
        .collect()
}

fn deliver(
    to: &mut EngineStore,
    envelopes: &[(ReplicationEnvelope, Vec<u8>)],
    leases: &dyn dohc_engine_sync::LeaseProbe,
) {
    for (envelope, blob) in envelopes {
        to.put_binary_blob(blob).expect("copy blob");
        apply_ydoc_envelope(
            to,
            &mut dohc_engine_collab::WriterDocCache::new(),
            envelope,
            &NoFaults,
            leases,
        )
        .expect("apply relayed op");
    }
}

/// The text of every moment recorded for `object_id`, oldest first.
fn moment_texts(store: &EngineStore, object_id: &str) -> Vec<String> {
    store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT b.text FROM moments m JOIN blobs b ON b.sha256 = m.after_blob_sha256 \
                 WHERE m.workspace_id = ?1 AND m.object_id = ?2 ORDER BY m.moment_order",
            )?;
            let rows = statement
                .query_map(rusqlite::params![WS_TWO_DEVICES, object_id], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>(rows)
        })
        .expect("read moment texts")
}

/// The relay position a device holds for `key`'s base, and the local bases
/// still waiting to learn theirs.
fn base_position(store: &EngineStore, key: &DocKey) -> (Option<String>, Option<i64>, i64) {
    store
        .read_with(|conn| {
            let (origin, relay_seq) = conn.query_row(
                "SELECT base_origin_id, base_relay_seq FROM ydoc_docs \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let candidates = conn.query_row(
                "SELECT COUNT(*) FROM ydoc_base_relay_candidates \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |row| row.get(0),
            )?;
            Ok::<_, rusqlite::Error>((origin, relay_seq, candidates))
        })
        .expect("read base position")
}

/// What the pull's repair does before it applies a page: learn where this
/// device's own base landed on the relay, and drop the pending position.
fn learn_own_base_position(
    store: &mut EngineStore,
    key: &DocKey,
    own_base: &LoggedOp,
    relay_seq: i64,
) {
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_collab::record_base_coordinate_in_tx(
                tx,
                dohc_engine_collab::BaseCoordinateRecord {
                    key,
                    lineage_claim_id: &own_base.blob_sha(),
                    origin_id: &own_base.origin_id,
                    origin_seq: own_base.origin_seq,
                    relay_seq: Some(relay_seq),
                    now_ms: 450,
                },
            )?;
            tx.execute(
                "DELETE FROM ydoc_base_relay_candidates                  WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(|error| {
                dohc_engine_collab::CollabError::Storage(StorageError::persist_public(error))
            })?;
            Ok::<_, dohc_engine_collab::CollabError>(())
        })
        .expect("learn own base position");
}

fn settle_head(store: &mut EngineStore, key: &DocKey, path: &str) {
    let doc = dohc_engine_collab::load_persisted(store, key)
        .expect("load")
        .expect("lineage")
        .doc;
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_sync::project_and_write_in_tx(
                tx,
                key,
                path,
                &doc,
                ContentKind::Plaintext,
                "origin-local",
                99,
                400,
                None,
                None,
            )
        })
        .expect("settle");
}

/// Two devices open the same file before either has seen the other's copy,
/// and each types into it. Both seed the same bytes, so both originate the
/// same base: each base resumes on the other device, and both edits merge
/// into one lineage. Nothing is set aside as a losing lineage, and a resumed
/// base never rolls the file back.
///
/// Device A has not pushed its own base when B's arrives, so A's position
/// comes from B's base and A's pending local position is dropped.
///
/// Mutation check: seed one device under another Yjs client and the bases
/// differ, so one device's edit is dropped. Project the base on a resumed
/// claim and a file reverts to the bare seed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_devices_that_seed_the_same_file_merge_into_one_lineage() {
    const PATH: &str = "notes/shared.md";
    const OBJECT: &str = "shared-object";
    let (a_scratch, b_scratch) = (
        ScratchDir::new().expect("scratch a"),
        ScratchDir::new().expect("scratch b"),
    );
    let a = engine_db_path(&a_scratch).expect("db a");
    let b = engine_db_path(&b_scratch).expect("db b");
    for db in [&a, &b] {
        enable_sync(db, WS_TWO_DEVICES);
        seed_shared_file(db, OBJECT, PATH, "relayed-moment", "seed");
    }
    let key = open_and_type(&a, PATH, " from A").await;
    assert_eq!(open_and_type(&b, PATH, " from B").await, key);

    let (a_ops, b_ops) = (local_ydoc_ops(&a), local_ydoc_ops(&b));
    assert!(a_ops[0].is_base() && b_ops[0].is_base());
    assert_eq!(
        a_ops[0].blob_sha(),
        b_ops[0].blob_sha(),
        "both devices originate the same base"
    );
    // Relay order: B's base, A's base, B's edit, A's edit. A pulls before it
    // pushes, so A has not learned where its own base landed.
    let from_a = relayed(&a, &a_ops, "device-a", &[2, 4]);
    let from_b = relayed(&b, &b_ops, "device-b", &[1, 3]);

    let mut a_store = EngineStore::open(&a, 9_113).expect("open a");
    let mut b_store = EngineStore::open(&b, 9_114).expect("open b");
    // Each device's edit reached its own file before the other's ops arrive.
    settle_head(&mut a_store, &key, PATH);
    settle_head(&mut b_store, &key, PATH);
    assert_eq!(
        base_position(&a_store, &key).2,
        1,
        "A's base awaits its position"
    );

    // A has the document closed: B's ops apply as they arrive.
    deliver(&mut a_store, &from_b[..1], &NoLiveLeases);
    assert_eq!(
        moment_texts(&a_store, OBJECT).last().map(String::as_str),
        Some("seed from A"),
        "a base the lineage already holds changes nothing"
    );
    assert_eq!(
        base_position(&a_store, &key),
        (Some("device-b".to_owned()), Some(1), 0),
        "B's base is where the lineage starts, and A's pending position is dropped"
    );
    deliver(&mut a_store, &from_b[1..], &NoLiveLeases);
    // B pushed first, and its pull learns that before applying A's ops.
    learn_own_base_position(&mut b_store, &key, &b_ops[0], 1);
    // B has the document open: A's ops wait until B closes it.
    deliver(&mut b_store, &from_a, &AlwaysLive);
    assert_eq!(deferred_rows(&b_store, &key), 2);
    drain_deferred_ydoc_for_key(
        &mut b_store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .expect("drain B");
    let (_, b_relay_seq, b_pending) = base_position(&b_store, &key);
    assert_eq!(
        (b_relay_seq, b_pending),
        (Some(1), 0),
        "both devices place the lineage's base at the same relay position"
    );

    let text = |store: &EngineStore| {
        dohc_engine_collab::load_persisted(store, &key)
            .expect("load")
            .expect("lineage")
            .doc
            .plaintext_string()
    };
    let merged = text(&a_store);
    assert!(
        ["seed from A from B", "seed from B from A"].contains(&merged.as_str()),
        "each edit appears once after the seed: {merged:?}"
    );
    assert_eq!(text(&b_store), merged, "both devices hold one document");
    for store in [&a_store, &b_store] {
        let texts = moment_texts(store, OBJECT);
        assert_eq!(texts.last(), Some(&merged), "the file carries both edits");
        assert_eq!(
            texts.iter().filter(|text| text.as_str() == "seed").count(),
            1,
            "no moment rolls the file back to the bare seed: {texts:?}"
        );
        let set_aside: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT (SELECT COUNT(*) FROM ydoc_recovery_decisions) \
                          + (SELECT COUNT(*) FROM path_aliases WHERE path <> ?1)",
                    [PATH],
                    |row| row.get(0),
                )
            })
            .expect("count recovered copies");
        assert_eq!(set_aside, 0, "no edit is set aside as a recovered copy");
    }
}

/// A lineage that grew LOCAL-ONLY past `MAX_YDOC_UPDATE_BYTES` and then reached
/// a synced workspace must not lose the edit that tries to promote it.
///
/// `claim_base_in_tx` measures the base against a cap written for one update.
/// A base is a full state, so a big enough lineage fails that check — and the
/// claim runs inside the append transaction, so the refusal rolls the user's
/// valid edit back with it, permanently: the claim stays unclaimed, so every
/// later edit takes the same branch and fails the same way.
///
/// Origination declines instead. The document keeps working and keeps markdown
/// as its artifact.
///
/// #549 measured the bound this lineage has to clear, so the size here is now
/// far past any real document: 22.5 MB of state, against a cap that covers a
/// rich document at `MAX_TEXT_BYTES` with churn headroom. The branch stays
/// because churn has no upper bound, not because ordinary documents reach it.
///
/// Mutation check: drop the size check in `ydoc_originate_base_in_tx` and the
/// promoting edit itself fails, before any assertion runs —
/// `Collab(UpdateTooLarge { actual: 22500047, max: 20971520 })`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lineage_too_large_to_originate_still_accepts_the_edit() {
    const WS: &str = "ws-originate-oversize";
    const PATH: &str = "notes/oversize.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    let key = DocKey::new(WS, "main", &object_id).expect("key");

    // Grow the lineage past the cap while the workspace is still private. Each
    // update stays well under it; only the accumulated full state passes it.
    let doc = Ydoc::wire();
    let chunk = "x".repeat(4_500_000);
    for (index, now) in [200, 300, 400, 410, 420].into_iter().enumerate() {
        let update =
            doc.plaintext_insert(u32::try_from(index * chunk.len()).expect("offset"), &chunk);
        handle
            .ydoc_record_update(
                key.clone(),
                PATH.to_owned(),
                ContentKind::Plaintext,
                Regime::LocalOnly,
                update,
                None,
                None,
                None,
                false,
                None,
                None,
                now,
                Arc::new(NoFaults),
                CancellationToken::new(),
                None,
            )
            .await
            .expect("a local-only append under the per-update cap");
    }

    // Sync turns on for a lineage that is already too large to encode as a base.
    enable_sync(&db, WS);

    let update = doc.plaintext_insert(0, "tiny");
    let append = handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            update,
            None,
            None,
            None,
            false,
            None,
            None,
            500,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("the promoting edit is accepted, not rolled back");
    supervisor.close(&db).expect("close actor");
    let store = EngineStore::open(&db, 9_107).expect("reopen for assertions");

    // The decline says WHY. It used to be `Ok(None)` — the same answer
    // origination gives for "already claimed", "this workspace does not
    // replicate", and "a dependency is unresolved" — so a document that had
    // quietly stopped being shareable was indistinguishable from one that had
    // nothing to do.
    let declined = append
        .sharing_declined
        .expect("a lineage past the base cap declines OUT LOUD");
    assert_eq!(declined.path, PATH);
    assert_eq!(declined.constraint, "MAX_YDOC_UPDATE_BYTES");
    assert_eq!(
        declined.limit_bytes,
        dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES
    );
    assert!(
        declined.observed_bytes > declined.limit_bytes,
        "the refusal reports the size it measured: {declined:?}"
    );
    let named = declined.to_string();
    for part in [
        PATH,
        "MAX_YDOC_UPDATE_BYTES",
        &declined.limit_bytes.to_string(),
        &declined.observed_bytes.to_string(),
        "bytes",
        "Reduce the file to share it.",
    ] {
        assert!(
            named.contains(part),
            "the refusal must name {part}: {named}"
        );
    }

    assert!(
        read_local_ydoc_ops(&store).is_empty(),
        "an oversize lineage journals nothing rather than half a base"
    );
    assert_eq!(
        read_marker_state(&store, &key),
        (Regime::LocalOnly, false),
        "and it stays local-only, with markdown as its artifact"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn opening_a_document_with_a_deferred_different_seed_requires_conflict_review() {
    const PATH: &str = "notes/seed-conflict.md";
    const OBJECT: &str = "seed-conflict";
    let a_scratch = ScratchDir::new().unwrap();
    let b_scratch = ScratchDir::new().unwrap();
    let a = engine_db_path(&a_scratch).unwrap();
    let b = engine_db_path(&b_scratch).unwrap();
    for (db, text, moment) in [
        (&a, "local seed", "local-head"),
        (&b, "remote seed", "remote-head"),
    ] {
        enable_sync(db, WS_TWO_DEVICES);
        seed_shared_file(db, OBJECT, PATH, moment, text);
    }
    let key = open_and_type(&a, PATH, " plus local edit").await;
    open_and_type(&b, PATH, " plus remote edit").await;
    let a_ops = local_ydoc_ops(&a);
    let b_ops = local_ydoc_ops(&b);
    let remote = relayed(&b, &b_ops, "device-b", &[1, 3]);
    {
        let mut store = EngineStore::open(&a, 300).unwrap();
        settle_head(&mut store, &key, PATH);
        learn_own_base_position(&mut store, &key, &a_ops[0], 2);
        deliver(&mut store, &remote, &AlwaysLive);
        assert_eq!(deferred_rows(&store, &key), 2);
    }
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&a, 400).unwrap().actor;
    let opened = handle
        .ydoc_open_state(
            WS_TWO_DEVICES.to_owned(),
            500,
            true,
            Some(key.clone()),
            "main".to_owned(),
            PATH.to_owned(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(opened, Err(RuntimeError::YdocOpenConflict { .. })));
    supervisor.close(&a).unwrap();
    let store = EngineStore::open(&a, 600).unwrap();
    assert_eq!(
        deferred_rows(&store, &key),
        0,
        "refused opens finish the drain so resolution can proceed"
    );
    let sides: (String, String) = store
        .read_with(|conn| {
            conn.query_row(
        "SELECT c.text,i.text FROM conflicts f JOIN blobs c ON c.sha256=f.current_blob_sha256
         JOIN blobs i ON i.sha256=f.incoming_blob_sha256 WHERE f.status='open'", [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
        })
        .unwrap();
    assert_eq!(
        sides,
        (
            "local seed plus local edit".to_owned(),
            "remote seed plus remote edit".to_owned()
        )
    );
    let conflict_id: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT conflict_id FROM conflicts WHERE status='open'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    drop(store);
    let actor = supervisor.open(&a, 700).unwrap().actor;
    let resolved = actor
        .conflict_resolve(
            dohc_engine_domain::ResolveTextConflict {
                workspace_id: WS_TWO_DEVICES.into(),
                conflict_id,
                resolution: dohc_engine_domain::ResolveConflictKind::ApplyIncoming,
                object_id: OBJECT.into(),
                write_moment_id: "resolve-after-open".into(),
                delete_moment_id: "delete-after-open".into(),
                metadata_origin: "sync".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 800,
                request_id: None,
                conflict_answer_budget_bytes: usize::MAX,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            std::sync::Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        resolved.conflict.status,
        dohc_engine_domain::ConflictStatus::Resolved
    );
    supervisor.close(&a).unwrap();
}

/// The rich-document schema version a stored Y.Doc update names, if any.
fn schema_version(update: &[u8]) -> Option<Any> {
    use yrs::Map;
    use yrs::updates::decoder::Decode;
    let doc = Doc::new();
    let meta = doc.get_or_insert_map(dohc_engine_collab::ROOT_META);
    doc.transact_mut()
        .apply_update(yrs::Update::decode_v1(update).expect("decode update"))
        .expect("apply update");
    match meta.get(&doc.transact(), "schemaVersion") {
        None => None,
        Some(yrs::Out::Any(value)) => Some(value),
        Some(other) => panic!("schemaVersion holds a shared type: {other:?}"),
    }
}

/// Open `path` as New page does: the editor opens before the engine has
/// captured a file, so there is no head and no seed.
async fn open_new_page(
    handle: &dohc_engine_runtime::ActorHandle,
    workspace_id: &str,
    path: &str,
) -> dohc_engine_runtime::YdocOpenState {
    let state = handle
        .ydoc_open_state(
            workspace_id.to_owned(),
            150,
            true,
            None,
            "main".to_owned(),
            path.to_owned(),
            Some(ContentKind::Richdoc),
            CancellationToken::new(),
        )
        .await
        .expect("open a new page");
    assert!(
        state.head_blob_sha256.is_none(),
        "New page opens with no head"
    );
    assert!(state.seed_content.is_none(), "and with nothing to seed");
    state
}

/// The editor's first update to a lineage-absent session, as `ydoc.recordUpdate`
/// sends it: it requires an empty lineage and names no seed source.
async fn record_first_new_page_update(
    handle: &dohc_engine_runtime::ActorHandle,
    key: &DocKey,
    path: &str,
    update: Vec<u8>,
) -> Option<String> {
    handle
        .ydoc_record_update(
            key.clone(),
            path.to_owned(),
            ContentKind::Richdoc,
            Regime::LocalOnly,
            update,
            None,
            None,
            None,
            true,
            None,
            None,
            200,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("record the first update")
        .lineage_claim_id
}

async fn settle_note(
    handle: &dohc_engine_runtime::ActorHandle,
    root: &Path,
    key: &DocKey,
    path: &str,
    claim: Option<String>,
    session: &str,
    now_ms: i64,
) {
    handle
        .ydoc_settle(
            root.to_path_buf(),
            key.clone(),
            path.to_owned(),
            ContentKind::Richdoc,
            claim,
            None,
            session.to_owned(),
            Arc::new(()),
            now_ms,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .expect("settle the note");
}

/// The first version a New page note claims must name its schema version
/// (#3790). Nothing seeds such a note, so its editor's update holds only the
/// typed body, and the live host refuses a first version without the version.
fn assert_first_version_names_its_schema_version(store: &EngineStore, case: &str) {
    let ops = read_local_ydoc_ops(store);
    assert_eq!(read_base_ops_in_log(store), 1, "{case}: one first version");
    let base = ops.iter().find(|op| op.is_base()).expect("the base op");
    assert_eq!(
        schema_version(&read_blob_bytes(store, &base.blob_sha())),
        Some(Any::Number(1.0)),
        "{case}: the first version a New page note claims names schemaVersion 1"
    );
}

/// The rich-document schema version the stored lineage names, if any.
fn stored_schema_version(store: &EngineStore, key: &DocKey) -> Option<Any> {
    let doc = store
        .read_with(|conn| dohc_engine_collab::load_doc_in(conn, key))
        .expect("load the stored lineage");
    schema_version(&doc.encode_full_state())
}

/// `(settled_update_seq, head_update_seq)` for one lineage.
fn settled_and_head(store: &EngineStore, key: &DocKey) -> (Option<i64>, i64) {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT settled_update_seq, head_update_seq FROM ydoc_docs \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("read the lineage's positions")
}

/// A New page note typed and saved before its workspace synced, so nothing
/// claimed it: its one update has no schema version, and its head is settled.
async fn saved_unclaimed_new_page(db: &Path, root: &Path, ws: &str, path: &str) -> DocKey {
    std::fs::create_dir_all(root.join("notes")).expect("notes dir");
    std::fs::write(root.join(path), "").expect("New page's empty file");
    seed_identity(db, ws);
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(db, 1).expect("open actor").actor;
    let state = open_new_page(&handle, ws, path).await;
    let typed = Ydoc::wire().richdoc_append_paragraph("Typed before sync.");
    let claim = record_first_new_page_update(&handle, &state.key, path, typed).await;
    assert!(
        claim.is_none(),
        "a workspace that does not sync claims nothing"
    );
    settle_note(
        &handle,
        root,
        &state.key,
        path,
        None,
        "new-page-session",
        400,
    )
    .await;
    supervisor.close(db).expect("close actor");
    state.key
}

/// The schema version is written in the claim's own transaction. A claim that
/// rolls back leaves no version, no claim and no row behind, and its retry
/// proposes the same first version.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rolled_back_claim_leaves_no_schema_version_and_its_retry_proposes_the_same_base() {
    const WS: &str = "ws-new-page-rollback";
    const PATH: &str = "notes/rolled-back.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let key = saved_unclaimed_new_page(&db, scratch.path(), WS, PATH).await;
    enable_sync(&db, WS);
    let mut store = EngineStore::open(&db, 9_107).expect("open store");
    let rows = read_lineage_rows(&store, &key);
    let positions = settled_and_head(&store, &key);
    assert_eq!(stored_schema_version(&store, &key), None);

    let mut proposed = None;
    let rolled_back = store.write_with(&NoFaults, |tx| {
        let BaseOrigination::Originated { base_snapshot_sha } =
            originate_ydoc_base_in_tx(tx, &key, PATH, None, None, 600)?
        else {
            panic!("the saved note originates");
        };
        proposed = Some(base_snapshot_sha);
        Err::<(), _>(SyncError::RetryableState {
            reason: "roll the claim back",
        })
    });
    assert!(matches!(rolled_back, Err(SyncError::RetryableState { .. })));
    assert_eq!(read_lineage_rows(&store, &key), rows, "no row stays behind");
    assert_eq!(
        settled_and_head(&store, &key),
        positions,
        "the head stays where it was"
    );
    assert!(!read_marker_state(&store, &key).1, "no claim stays behind");
    assert_eq!(
        stored_schema_version(&store, &key),
        None,
        "no schema version stays behind"
    );
    assert!(
        read_local_ydoc_ops(&store).is_empty(),
        "nothing is journaled"
    );

    let TxnOutcome::Committed(retried) = store
        .write_with(&NoFaults, |tx| {
            originate_ydoc_base_in_tx(tx, &key, PATH, None, None, 700)
        })
        .expect("retry the claim")
    else {
        panic!("the retried claim commits");
    };
    assert_eq!(
        retried,
        BaseOrigination::Originated {
            base_snapshot_sha: proposed.expect("the rolled-back claim proposed a base"),
        },
        "the retry proposes the same first version"
    );
    assert_eq!(
        read_lineage_rows(&store, &key).0,
        rows.0 + 1,
        "the claim adds the schema version's one row"
    );
    assert_first_version_names_its_schema_version(&store, "retried claim");
}
