//! Y.Doc base ORIGINATION (#378).
//!
//! Journaling an outbound `ydoc.update` needs `regime == Replicated &&
//! base_claimed`, and before this suite the only thing that ever set
//! `base_claimed` was the INBOUND apply of a peer's `isBaseState: true`
//! envelope. No production Rust emitted one, so two daemon peers could join a
//! lineage that already existed and could never start one.
//!
//! Every scenario here replays the originated ops into a CLEAN peer — one with
//! no file and no prior CRDT state, reconstructing from the log alone. That is
//! the only assertion that catches the failure this feature is about: a base
//! that omits rows the origin already held looks perfect from the origin, which
//! reconstructs them from its own private tables.

use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc};
use dohc_engine_domain::VersionedTextStore;
use dohc_engine_runtime::{CancellationToken, CaptureIngest, NoFaults, WorkspaceSupervisor};
use dohc_engine_storage::{EngineStore, StorageError};
use dohc_engine_sync::{NoLiveLeases, ReplicationEnvelope, apply_ydoc_envelope};
use dohc_engine_testkit::ScratchDir;
use std::path::Path;
use std::sync::Arc;

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

/// The ops this machine ORIGINATED (`imported = 0`) — what a push would send.
fn local_ops(db: &Path) -> Vec<LoggedOp> {
    let store = EngineStore::open(db, 9_100).expect("open store");
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

/// Base ops across the WHOLE log, local and imported alike. Base-once is a
/// property of the lineage, not of one machine's outbox.
fn base_ops_in_log(db: &Path) -> i64 {
    let store = EngineStore::open(db, 9_101).expect("open store");
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
fn lineage_rows(db: &Path, key: &DocKey) -> (i64, i64) {
    let store = EngineStore::open(db, 9_105).expect("open store");
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

fn marker_state(db: &Path, key: &DocKey) -> (Regime, bool) {
    let store = EngineStore::open(db, 9_102).expect("open store");
    let marker = dohc_engine_collab::read_marker(&store, key)
        .expect("read marker")
        .expect("marker exists");
    (marker.regime, marker.base_claimed)
}

/// The workspace has an origin identity. This ALONE is not sync: ordinary
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

/// What a chat-only workspace looks like: an identity and nothing else. No
/// relay has ever been contacted for it.
fn chat_minted_identity(db: &Path, workspace_id: &str) {
    seed_identity(db, workspace_id);
}

/// Sync is genuinely on: the workspace has an identity AND a durable relay
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
    store
        .get_binary_blob(sha)
        .expect("read blob")
        .expect("the journaled blob exists locally")
}

/// Replay `ops` into a CLEAN peer and return the text it materialized for
/// `path`. The blobs travel first, exactly as `push_workspace` uploads them
/// before the log ops that reference them.
fn replay_into_clean_peer(
    source_db: &Path,
    ops: &[LoggedOp],
    workspace_id: &str,
    path: &str,
) -> String {
    let scratch = ScratchDir::new().expect("peer scratch");
    let db = scratch.engine_db_path().expect("peer db");
    let mut peer = EngineStore::open(&db, 9_200).expect("open peer store");
    VersionedTextStore::new(&mut peer)
        .ensure_main_version(workspace_id, "main", 1_000, &NoFaults)
        .expect("peer main version");

    for op in ops {
        let bytes = blob_bytes(source_db, &op.blob_sha());
        peer.put_binary_blob(&bytes).expect("peer blob");
        let envelope = ReplicationEnvelope {
            workspace_id: workspace_id.to_owned(),
            origin_id: op.origin_id.clone(),
            origin_seq: op.origin_seq,
            op_kind: op.op_kind.clone(),
            payload: op.payload.clone(),
            recorded_at_ms: op.recorded_at_ms,
        };
        apply_ydoc_envelope(&mut peer, &envelope, &NoFaults, &NoLiveLeases)
            .expect("the clean peer applies every originated op");
    }

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
    .expect("the clean peer materialized the document")
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
    let db = scratch.engine_db_path().expect("db");
    enable_sync(&db, WS);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    let key = DocKey::new(WS, "main", &object_id).expect("key");

    let doc = Ydoc::wire();
    let first = doc.plaintext_insert(0, "hello ");
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            first,
            None,
            // The real seed path: `ydoc.recordUpdate` sets this for the first
            // update of an absent lineage.
            true,
            None,
            200,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("first update");

    let ops = local_ops(&db);
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
            false,
            None,
            300,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("second update");
    supervisor.close(&db).expect("close actor");

    let ops = local_ops(&db);
    assert_eq!(ops.len(), 2, "base once, then deltas");
    assert!(ops[0].is_base());
    assert!(!ops[1].is_base(), "a claimed lineage never re-emits a base");
    assert_eq!(base_ops_in_log(&db), 1);

    assert_eq!(
        replay_into_clean_peer(&db, &ops, WS, PATH),
        "hello world",
        "a peer with no file and no prior state reconstructs the document"
    );
}

/// Edit a lineage twice on a workspace prepared by `prepare`, then assert it
/// stayed private: no replication op, and a prunable local-only marker.
async fn two_edits_originate_nothing(ws: &str, path: &str, prepare: fn(&Path, &str)) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    prepare(&db, ws);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, ws, path, 100).await;
    let key = DocKey::new(ws, "main", &object_id).expect("key");

    let doc = Ydoc::wire();
    for (index, (text, now)) in [("alpha", 200), (" beta", 300)].into_iter().enumerate() {
        let update = doc.plaintext_insert(u32::try_from(index * 5).expect("offset"), text);
        handle
            .ydoc_record_update(
                key.clone(),
                path.to_owned(),
                ContentKind::Plaintext,
                Regime::LocalOnly,
                update,
                None,
                false,
                None,
                now,
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("local-only update");
    }
    supervisor.close(&db).expect("close actor");

    assert!(
        local_ops(&db).is_empty(),
        "a private workspace journals no replication op"
    );
    assert_eq!(
        marker_state(&db, &key),
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

/// A chat-minted `sync_identity` is NOT sync. `local_replication_coordinate`
/// creates that row on every ordinary local chat write — creating a channel is
/// enough — so identity-row existence would promote the private documents of a
/// user who has only ever chatted locally. Promotion is not reversible: the
/// lineage stops pruning on close and starts filling `replication_log`.
///
/// Mutation check: gate origination on `sync_identity` alone (the shape this
/// suite shipped with) and this test fails on both assertions while every
/// other scenario stays green.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_chat_minted_identity_is_not_sync_and_never_originates() {
    two_edits_originate_nothing(
        "ws-originate-chat-only",
        "notes/chat-only.md",
        chat_minted_identity,
    )
    .await;
}

/// PROMOTION. A local-only lineage that already holds durable update rows — the
/// state a crash before settle/close leaves — must publish those rows when it
/// originates. The base encodes the PERSISTED Y.Doc, never a fresh markdown
/// seed, so the clean peer sees the pre-promotion content too.
///
/// Mutation check: encode a fresh seed instead of the persisted lineage (or
/// skip the pre-existing rows) and the origin still looks correct while the
/// clean peer's text loses `alpha` — this test's last assertion fails.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn promotion_publishes_the_rows_the_lineage_already_held() {
    const WS: &str = "ws-originate-promote";
    const PATH: &str = "notes/promoted.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");

    // Phase 1: private workspace, one durable edit, no close.
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    let key = DocKey::new(WS, "main", &object_id).expect("key");
    let doc = Ydoc::wire();
    let alpha = doc.plaintext_insert(0, "alpha");
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            alpha,
            None,
            false,
            None,
            200,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("local-only edit");
    assert!(local_ops(&db).is_empty(), "still private");
    // CRASH-SHAPED exit: the Y.Doc session never closes, so its rows survive.
    // A normal local-only close would PRUNE them and destroy the precondition
    // this scenario exists to test.
    supervisor.close(&db).expect("close actor");

    // Phase 2: the user turns sync on, reopens, and edits again.
    enable_sync(&db, WS);
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 2).expect("reopen actor").actor;
    let state = handle
        .ydoc_open_state(
            WS.to_owned(),
            400,
            true,
            Some(key.clone()),
            "main".to_owned(),
            PATH.to_owned(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("reopen the doc");
    assert!(
        state.lineage_existing,
        "the crash-left rows are still durable"
    );
    let resumed = Ydoc::wire();
    resumed.apply(&state.initial_update).expect("resume");
    assert_eq!(resumed.plaintext_string(), "alpha");

    let beta = resumed.plaintext_insert(5, " beta");
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            beta,
            None,
            false,
            None,
            500,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("promoting edit");

    // A later edit, journaled as a delta against the SAME lineage. Without it
    // a re-seeded base is undetectable: a fresh seed of the current text still
    // reads correctly on its own, and only a delta that references the
    // original Yjs item ids exposes that the base minted new ones.
    let gamma = resumed.plaintext_insert(10, " gamma");
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            gamma,
            None,
            false,
            None,
            600,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("post-promotion edit");
    supervisor.close(&db).expect("close actor");

    let ops = local_ops(&db);
    assert_eq!(ops.len(), 2, "promotion originates one base, then deltas");
    assert!(ops[0].is_base());
    assert!(!ops[1].is_base());
    assert_eq!(base_ops_in_log(&db), 1);
    assert_eq!(marker_state(&db, &key), (Regime::Replicated, true));

    assert_eq!(
        replay_into_clean_peer(&db, &ops, WS, PATH),
        "alpha beta gamma",
        "the promoted base carries the rows the lineage held before promotion, \
         and later deltas still apply to it"
    );
}

/// COLLISION. When a peer's base for the same lineage lands first, the local
/// daemon must not mint a second one: it observes the claim and journals its
/// edit as a delta instead. Within one database SQLite serializes writers, so
/// the concurrent claim reduces to this ordering, and the claim's re-check
/// reads the same transaction that would write the second base.
///
/// Mutation check: drop the `marker.base_claimed` guard in
/// `ydoc_originate_base_in_tx` and a second base appears — both the op-shape
/// assertion and `base_ops_in_log` fail.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_peer_base_that_lands_first_leaves_the_local_edit_a_delta() {
    const WS: &str = "ws-originate-race";
    const PATH: &str = "notes/raced.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    enable_sync(&db, WS);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    let key = DocKey::new(WS, "main", &object_id).expect("key");
    supervisor.close(&db).expect("close actor");

    // The peer wins: its base is claimed before any local edit.
    let peer_doc = Ydoc::wire();
    let peer_base = {
        peer_doc.plaintext_insert(0, "from peer");
        peer_doc.encode_full_state()
    };
    {
        let mut store = EngineStore::open(&db, 9_300).expect("open store");
        let sha = store.put_binary_blob(&peer_base).expect("peer base blob");
        let envelope = ReplicationEnvelope {
            workspace_id: WS.to_owned(),
            origin_id: "peer".to_owned(),
            origin_seq: 0,
            op_kind: "ydoc.update".to_owned(),
            payload: serde_json::json!({
                "versionId": "main",
                "objectId": object_id,
                "path": PATH,
                "contentKind": "plaintext",
                "updateBlobSha256": sha,
                "isBaseState": true
            }),
            recorded_at_ms: 300,
        };
        apply_ydoc_envelope(&mut store, &envelope, &NoFaults, &NoLiveLeases)
            .expect("the peer base applies");
    }
    assert_eq!(marker_state(&db, &key), (Regime::Replicated, true));

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 2).expect("reopen actor").actor;
    let local = peer_doc.plaintext_insert(9, " and me");
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::Replicated,
            local,
            None,
            false,
            None,
            400,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("local edit onto the peer's lineage");
    supervisor.close(&db).expect("close actor");

    let ops = local_ops(&db);
    assert_eq!(ops.len(), 1, "the local edit journals exactly one op");
    assert!(
        !ops[0].is_base(),
        "the lineage already has its base; the local edit is a delta"
    );
    assert_eq!(
        base_ops_in_log(&db),
        1,
        "base-once holds across the whole lineage"
    );
}

/// REDELIVERY (idempotence). A base whose acknowledgement was lost comes back
/// on the same coordinate. The divergence check must not turn that valid retry
/// into an error, and it must not mint a second base.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn redelivering_an_originated_base_is_idempotent() {
    const WS: &str = "ws-originate-redeliver";
    const PATH: &str = "notes/redelivered.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    enable_sync(&db, WS);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    let key = DocKey::new(WS, "main", &object_id).expect("key");
    let doc = Ydoc::wire();
    let update = doc.plaintext_insert(0, "once");
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            update,
            None,
            false,
            None,
            200,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("originating edit");
    supervisor.close(&db).expect("close actor");

    let ops = local_ops(&db);
    assert_eq!(ops.len(), 1);
    assert!(ops[0].is_base());

    // The very same base bytes come back from the relay.
    let base_bytes = blob_bytes(&db, &ops[0].blob_sha());
    let mut store = EngineStore::open(&db, 9_400).expect("open store");
    let envelope = ReplicationEnvelope {
        workspace_id: WS.to_owned(),
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        op_kind: "ydoc.update".to_owned(),
        payload: serde_json::json!({
            "versionId": "main",
            "objectId": object_id,
            "path": PATH,
            "contentKind": "plaintext",
            "updateBlobSha256": dohc_engine_storage::hex_sha256(&base_bytes),
            "isBaseState": true
        }),
        recorded_at_ms: 500,
    };
    apply_ydoc_envelope(&mut store, &envelope, &NoFaults, &NoLiveLeases)
        .expect("a redelivered identical base resumes instead of failing");
    drop(store);

    assert_eq!(marker_state(&db, &key), (Regime::Replicated, true));
    assert_eq!(
        local_ops(&db).len(),
        1,
        "redelivery originates nothing further"
    );
}

/// Origination promotes a lineage MID-SESSION, and the session opened before it
/// still reports the regime it saw then. Close must read the marker, not that
/// stale view: a local-only close prunes every CRDT row, which would delete the
/// base the same session just claimed and strand every peer bootstrapping from
/// it.
///
/// Mutation check: pass the session's opening regime to `close_session` instead
/// of reading the marker, and the prune branch runs — both row counts drop to
/// zero and this test fails.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn closing_a_session_that_originated_mid_flight_keeps_the_base() {
    const WS: &str = "ws-originate-close";
    const PATH: &str = "notes/closed.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    enable_sync(&db, WS);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    let key = DocKey::new(WS, "main", &object_id).expect("key");

    // The session opens LOCAL-ONLY; the edit below promotes it underneath.
    let state = handle
        .ydoc_open_state(
            WS.to_owned(),
            150,
            true,
            None,
            "main".to_owned(),
            PATH.to_owned(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("open");
    assert_eq!(
        state.regime,
        Regime::LocalOnly,
        "the session's view is local-only when it opens"
    );

    let doc = Ydoc::wire();
    let update = doc.plaintext_insert(0, "durable");
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            update,
            None,
            false,
            None,
            200,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("originating edit");
    assert_eq!(marker_state(&db, &key), (Regime::Replicated, true));

    handle
        .ydoc_close_session(
            key.clone(),
            300,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("close the session");
    supervisor.close(&db).expect("close actor");

    let (updates, snapshots) = lineage_rows(&db, &key);
    assert!(
        updates > 0 || snapshots > 0,
        "a replicated close compacts and KEEPS the lineage; it must never prune \
         the base a peer bootstraps from (updates={updates}, snapshots={snapshots})"
    );
    assert_eq!(marker_state(&db, &key), (Regime::Replicated, true));
    assert_eq!(base_ops_in_log(&db), 1, "and close emits no second base");
}
