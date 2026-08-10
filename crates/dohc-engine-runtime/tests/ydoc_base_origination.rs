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
use dohc_engine_sync::{
    LeaseProbe, NoLiveLeases, ReplicationEnvelope, apply_ydoc_envelope, drain_deferred_ydoc_for_key,
};
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

/// The ops this machine originated (`imported = 0`), in relay order.
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

fn local_ydoc_ops(db: &Path) -> Vec<LoggedOp> {
    local_ops(db)
        .into_iter()
        .filter(|op| op.op_kind == "ydoc.update")
        .collect()
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
        let bytes = blob_bytes(source_db, &op.blob_sha());
        peer.put_binary_blob(&bytes).expect("peer blob");
        let envelope = ReplicationEnvelope {
            workspace_id: workspace_id.to_owned(),
            origin_id: op.origin_id.clone(),
            origin_seq: op.origin_seq - first_origin_seq,
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
            false,
            None,
            300,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("second update");
    supervisor.close(&db).expect("close actor");

    let ops = local_ydoc_ops(&db);
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

#[derive(Debug, Clone, Copy)]
struct AlwaysLiveLease;

impl LeaseProbe for AlwaysLiveLease {
    fn is_live(&self, _key: &DocKey) -> bool {
        true
    }
}

/// A dependent local update cannot originate until its missing predecessor
/// arrives. When that predecessor arrives through the deferred-drain path, the
/// drain must retry origination without waiting for another local edit.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn draining_a_late_predecessor_retries_origination() {
    const WS: &str = "ws-originate-after-drain";
    const PATH: &str = "notes/deferred.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    enable_sync(&db, WS);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    let key = DocKey::new(WS, "main", &object_id).expect("key");

    let doc = Ydoc::wire();
    let predecessor = doc.plaintext_insert(0, "dep base");
    let dependent = doc.plaintext_insert(0, "more ");
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::Replicated,
            dependent,
            None,
            false,
            None,
            200,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("record dependent update");
    supervisor.close(&db).expect("close actor");

    assert_eq!(
        marker_state(&db, &key),
        (Regime::Replicated, false),
        "the unresolved dependency leaves the base unclaimed"
    );
    assert!(
        local_ydoc_ops(&db).is_empty(),
        "an incomplete state cannot be journaled as a base"
    );

    let mut store = EngineStore::open(&db, 9_500).expect("open store");
    let predecessor_sha = store
        .put_binary_blob(&predecessor)
        .expect("store predecessor blob");
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
            "updateBlobSha256": predecessor_sha,
            "isBaseState": false
        }),
        recorded_at_ms: 300,
    };
    let parked = apply_ydoc_envelope(&mut store, &envelope, &NoFaults, &AlwaysLiveLease)
        .expect("park predecessor behind the live lease");
    assert!(
        matches!(
            parked,
            dohc_engine_sync::ApplyOutcome::Applied(ref result) if result.deferred
        ),
        "the predecessor is deferred"
    );

    let drained =
        drain_deferred_ydoc_for_key(&mut store, &key, &NoFaults).expect("drain predecessor");
    assert_eq!(drained.drained, 1);
    drop(store);

    assert_eq!(
        marker_state(&db, &key),
        (Regime::Replicated, true),
        "the drain retries and claims the base"
    );
    let ops = local_ydoc_ops(&db);
    assert_eq!(ops.len(), 1, "the drain journals one originated base");
    assert!(ops[0].is_base());
    assert_eq!(base_ops_in_log(&db), 1);
    assert_eq!(
        replay_into_clean_peer(&db, &ops, WS, PATH),
        "more dep base",
        "the originated base carries the resolved dependent state"
    );
}

/// The ordinary non-leased apply path can also complete a local dependent
/// update. It must retry origination after it projects the complete lineage.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn applying_a_late_predecessor_without_a_lease_retries_origination() {
    const WS: &str = "ws-originate-after-ordinary-apply";
    const PATH: &str = "notes/ordinary.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    enable_sync(&db, WS);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    let key = DocKey::new(WS, "main", &object_id).expect("key");
    let doc = Ydoc::wire();
    let predecessor = doc.plaintext_insert(0, "dep base");
    let dependent = doc.plaintext_insert(0, "more ");
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::Replicated,
            dependent,
            None,
            false,
            None,
            200,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("record dependent update");
    supervisor.close(&db).expect("close actor");
    assert_eq!(marker_state(&db, &key), (Regime::Replicated, false));

    let mut store = EngineStore::open(&db, 9_510).expect("open store");
    let predecessor_sha = store
        .put_binary_blob(&predecessor)
        .expect("store predecessor blob");
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
            "updateBlobSha256": predecessor_sha,
            "isBaseState": false
        }),
        recorded_at_ms: 300,
    };
    apply_ydoc_envelope(&mut store, &envelope, &NoFaults, &NoLiveLeases)
        .expect("ordinary predecessor apply");
    drop(store);

    assert_eq!(
        marker_state(&db, &key),
        (Regime::Replicated, true),
        "the ordinary apply retries and claims the base"
    );
    let ops = local_ydoc_ops(&db);
    assert_eq!(ops.len(), 1, "the ordinary apply journals one base");
    assert!(ops[0].is_base());
    assert_eq!(replay_into_clean_peer(&db, &ops, WS, PATH), "more dep base");
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
        let append = handle
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
        // #632: the benign reasons a lineage does not originate stay silent. A
        // private workspace has no peer to share with — that is not a decline
        // the user has to hear about.
        assert_eq!(append.sharing_declined, None);
    }
    supervisor.close(&db).expect("close actor");

    assert!(
        local_ydoc_ops(&db).is_empty(),
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
    assert!(local_ydoc_ops(&db).is_empty(), "still private");
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
    let promoted = handle
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
    // #632, the other half: a lineage that DOES originate reports no decline.
    // MUTATION: report the decline unconditionally, or tighten
    // `MAX_YDOC_UPDATE_BYTES` under a healthy document, and this fails.
    assert_eq!(promoted.sharing_declined, None);

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

    let ops = local_ydoc_ops(&db);
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

    let ops = local_ydoc_ops(&db);
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

    let ops = local_ydoc_ops(&db);
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
        local_ydoc_ops(&db).len(),
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

/// A lineage that grew LOCAL-ONLY past `MAX_YDOC_UPDATE_BYTES` and then reached
/// a synced workspace must not lose the edit that tries to promote it.
///
/// `claim_base_in_tx` measures the base against a cap written for one update.
/// A base is a full state, so a big enough lineage fails that check — and the
/// claim runs inside the append transaction, so the refusal rolls the user's
/// valid edit back with it, permanently: `base_claimed` stays false, so every
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
    let db = scratch.engine_db_path().expect("db");

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
                false,
                None,
                now,
                Arc::new(NoFaults),
                CancellationToken::new(),
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
            false,
            None,
            500,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("the promoting edit is accepted, not rolled back");
    supervisor.close(&db).expect("close actor");

    // #632: the decline says WHY. It used to be `Ok(None)` — the same answer
    // origination gives for "already claimed", "this workspace does not
    // replicate", and "a dependency is unresolved" — so a document that had
    // quietly stopped being shareable was indistinguishable from one that had
    // nothing to do.
    let declined = append
        .sharing_declined
        .expect("a lineage past the base cap declines OUT LOUD");
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
        "MAX_YDOC_UPDATE_BYTES",
        &declined.limit_bytes.to_string(),
        &declined.observed_bytes.to_string(),
        "bytes",
    ] {
        assert!(
            named.contains(part),
            "the refusal must name {part}: {named}"
        );
    }

    assert!(
        local_ydoc_ops(&db).is_empty(),
        "an oversize lineage journals nothing rather than half a base"
    );
    assert_eq!(
        marker_state(&db, &key),
        (Regime::LocalOnly, false),
        "and it stays local-only, with markdown as its artifact"
    );
}

/// The defect #549 names, from the other side: a document whose Y.Doc state is
/// larger than the OLD inherited cap must originate now.
///
/// 5 MiB of full state is reached by a rich document holding roughly 3.5 MiB of
/// markdown — a third of what the store accepts as a body. Under the old cap
/// that document silently stopped being shareable the moment its workspace
/// synced. This grows a lineage past that number, turns sync on, and asserts
/// the base is claimed and journaled.
///
/// Mutation check: put `MAX_YDOC_UPDATE_BYTES` back to `5 * 1024 * 1024` and
/// origination declines — `base_ops_in_log` is 0 and the marker stays
/// `(LocalOnly, false)`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lineage_past_the_old_inherited_cap_originates() {
    const WS: &str = "ws-originate-past-old-cap";
    const PATH: &str = "notes/long-design-doc.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    let key = DocKey::new(WS, "main", &object_id).expect("key");

    // Past the old 5 MiB cap, far inside the measured one.
    let doc = Ydoc::wire();
    let chunk = "y".repeat(3_000_000);
    for (index, now) in [200, 300].into_iter().enumerate() {
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
                false,
                None,
                now,
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("a local-only append");
    }

    enable_sync(&db, WS);

    let update = doc.plaintext_insert(0, "tiny");
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
            500,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("the promoting edit is accepted");
    supervisor.close(&db).expect("close actor");

    assert_eq!(
        marker_state(&db, &key),
        (Regime::Replicated, true),
        "a document this size must promote to a shared lineage"
    );
    assert_eq!(base_ops_in_log(&db), 1, "and journal exactly one base");

    let ops = local_ydoc_ops(&db);
    let base = ops
        .iter()
        .find(|op| op.is_base())
        .expect("the base op is journaled");
    let bytes = blob_bytes(&db, &base.blob_sha());
    assert!(
        bytes.len() > 5 * 1024 * 1024,
        "the base is genuinely past the old cap ({} bytes)",
        bytes.len()
    );
    assert!(
        bytes.len() <= dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES,
        "and inside the measured one"
    );
    // The base a peer bootstraps from must carry the whole document.
    let peer = Ydoc::wire();
    peer.apply(&bytes).expect("a clean peer replays the base");
    assert_eq!(
        peer.plaintext_string().len(),
        doc.plaintext_string().len(),
        "the base reconstructs the document"
    );
}
