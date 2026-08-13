//! Y.Doc base ORIGINATION (#378).
//!
//! Journaling an outbound `ydoc.update` needs a replicated exact claim, and
//! before this suite the only thing that established one was the INBOUND apply
//! of a peer's `isBaseState: true`
//! envelope. No production Rust emitted one, so two daemon peers could join a
//! lineage that already existed and could never start one.
//!
//! Every scenario here replays the originated ops into a CLEAN peer — one with
//! no file and no prior CRDT state, reconstructing from the log alone. That is
//! the only assertion that catches the failure this feature is about: a base
//! that omits rows the origin already held looks perfect from the origin, which
//! reconstructs them from its own private tables.

use dohc_engine_collab::{ContentKind, DocKey, LeaseRegistry, Regime, Ydoc};
use dohc_engine_domain::{
    CreateNamedVersion, DeleteTextFile, MergeTextFileFromVersion, MergeTextFileResult,
    RollbackTextFileMutation, VersionedTextStore, WriteText,
};
use dohc_engine_runtime::{
    CancellationToken, CaptureIngest, CaptureRetire, NoFaults, RuntimeError, SelfWriteRecorder,
    WorkspaceSupervisor,
};
use dohc_engine_storage::{EngineStore, StorageError};
use dohc_engine_sync::{
    LeaseProbe, NoLiveLeases, RelayCursor, ReplicationEnvelope, SyncError,
    apply_replication_envelope, apply_ydoc_envelope, commit_relay_cursor,
    drain_deferred_ydoc_for_key,
};
use dohc_engine_testkit::ScratchDir;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use yrs::types::Attrs;
use yrs::{Any, Doc, OffsetKind, Options, ReadTxn, Text, Transact};

struct NoRecorder;

impl SelfWriteRecorder for NoRecorder {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

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
    (
        marker.regime,
        marker.lineage_claim_status.has_claimed_base(),
    )
}

fn lineage_exists(db: &Path, key: &DocKey) -> bool {
    let store = EngineStore::open(db, 9_108).expect("open store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM ydoc_docs \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |row| row.get(0),
            )
        })
        .expect("read lineage presence")
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
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture")
        .snapshot
        .object_id
}

struct OversizedLineage {
    base: Vec<u8>,
    remote_edit: Vec<u8>,
}

/// One projectable document whose accumulated CRDT history is too large to
/// originate as a base. The visible text stays at 1 MiB while interior
/// replacements add the unbounded revision-churn headroom described by #549.
fn oversized_lineage() -> &'static OversizedLineage {
    static LINEAGE: OnceLock<OversizedLineage> = OnceLock::new();
    LINEAGE.get_or_init(|| {
        let doc = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        let text = doc.get_or_insert_text(dohc_engine_collab::ROOT_PLAINTEXT);
        let visible_bytes = 1024 * 1024;
        text.insert(&mut doc.transact_mut(), 0, &"x".repeat(visible_bytes));

        let limit = dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES;
        {
            let mut txn = doc.transact_mut();
            for revision in 0..1_000_u32 {
                let value = format!("revision-{revision:04}-{}", "x".repeat(22 * 1024));
                text.format(
                    &mut txn,
                    revision,
                    1,
                    Attrs::from([("revision".into(), Any::String(value.into()))]),
                );
            }
        }
        let base = doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        assert!(
            base.len() > limit,
            "the fixture must exceed MAX_YDOC_UPDATE_BYTES: {} <= {limit}",
            base.len()
        );
        let projected = Ydoc::wire();
        projected.apply(&base).expect("apply oversized fixture");
        assert_eq!(
            projected
                .project(ContentKind::Plaintext)
                .expect("the oversized state remains projectable")
                .content
                .len(),
            visible_bytes
        );
        let before = doc.transact().state_vector();
        text.insert(&mut doc.transact_mut(), 0, "remote ");
        let remote_edit = doc.transact().encode_state_as_update_v1(&before);
        OversizedLineage { base, remote_edit }
    })
}

fn seed_unclaimed_oversized_lineage(db: &Path, key: &DocKey, path: &str) {
    let fixture = oversized_lineage();
    let mut store = EngineStore::open(db, 9_107).expect("open store");
    let base_sha = store
        .put_binary_blob(&fixture.base)
        .expect("store oversized private base");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO ydoc_docs \
                 (workspace_id, version_id, object_id, content_kind, regime, \
                  head_update_seq, head_snapshot_seq, lineage_claim_status, updated_at_ms, path) \
                 VALUES (?1, ?2, ?3, 'plaintext', 'replicated', 1, 0, 'unclaimed', 150, ?4)",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id, path],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO ydoc_updates \
                 (workspace_id, version_id, object_id, seq, update_blob_sha256, \
                  actor_origin_id, recorded_at_ms) \
                 VALUES (?1, ?2, ?3, 1, ?4, NULL, 150)",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id, base_sha,],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("seed unclaimed oversized lineage");
}

fn remote_edit_envelope(
    store: &mut EngineStore,
    key: &DocKey,
    path: &str,
    recorded_at_ms: i64,
) -> ReplicationEnvelope {
    let edit_sha = store
        .put_binary_blob(&oversized_lineage().remote_edit)
        .expect("store remote edit");
    ReplicationEnvelope {
        workspace_id: key.workspace_id.clone(),
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        op_kind: "ydoc.update".to_owned(),
        payload: serde_json::json!({
            "versionId": key.version_id,
            "objectId": key.object_id,
            "path": path,
            "contentKind": "plaintext",
            "updateBlobSha256": edit_sha,
            "isBaseState": false
        }),
        recorded_at_ms,
    }
}

fn assert_oversized_decline(declined: &dohc_engine_sync::SharingDeclined, path: &str) {
    assert_eq!(declined.path, path);
    assert_eq!(declined.constraint, "MAX_YDOC_UPDATE_BYTES");
    assert_eq!(
        declined.limit_bytes,
        dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES
    );
    assert!(
        declined.observed_bytes > declined.limit_bytes,
        "the decline must report the oversized base: {declined:?}"
    );
}

fn assert_remote_edit_committed(store: &EngineStore, key: &DocKey) {
    let persisted = dohc_engine_collab::load_persisted(store, key)
        .expect("load persisted lineage")
        .expect("lineage exists");
    assert!(
        persisted.doc.plaintext_string().starts_with("remote "),
        "the edit remains in the lineage when base origination declines"
    );
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
    assert!(drained.sharing_declined.is_empty());
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

/// The deferred-drain boundary returns an actionable decline without rolling
/// back the remote edit that made an oversized unclaimed lineage complete.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn draining_an_edit_surfaces_an_oversized_base_decline() {
    const WS: &str = "ws-oversized-drain-decline";
    const PATH: &str = "notes/oversized-drain.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    enable_sync(&db, WS);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    supervisor.close(&db).expect("close actor");
    let key = DocKey::new(WS, "main", object_id).expect("key");
    seed_unclaimed_oversized_lineage(&db, &key, PATH);

    let mut store = EngineStore::open(&db, 9_501).expect("open store");
    let envelope = remote_edit_envelope(&mut store, &key, PATH, 300);
    let parked = apply_ydoc_envelope(&mut store, &envelope, &NoFaults, &AlwaysLiveLease)
        .expect("park remote edit behind the live lease");
    assert!(matches!(
        parked,
        dohc_engine_sync::ApplyOutcome::Applied(ref result) if result.deferred
    ));

    let drained =
        drain_deferred_ydoc_for_key(&mut store, &key, &NoFaults).expect("drain remote edit");
    assert_eq!(drained.drained, 1);
    assert_eq!(drained.sharing_declined.len(), 1);
    assert_oversized_decline(&drained.sharing_declined[0], PATH);
    assert_remote_edit_committed(&store, &key);
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
    let applied = apply_ydoc_envelope(&mut store, &envelope, &NoFaults, &NoLiveLeases)
        .expect("ordinary predecessor apply");
    assert!(matches!(
        applied,
        dohc_engine_sync::ApplyOutcome::Applied(_)
    ));
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

/// The ordinary apply boundary returns the same actionable decline and keeps
/// the edit when the completed base is too large to originate.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn applying_an_edit_surfaces_an_oversized_base_decline() {
    const WS: &str = "ws-oversized-apply-decline";
    const PATH: &str = "notes/oversized-apply.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    enable_sync(&db, WS);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    supervisor.close(&db).expect("close actor");
    let key = DocKey::new(WS, "main", object_id).expect("key");
    seed_unclaimed_oversized_lineage(&db, &key, PATH);

    let mut store = EngineStore::open(&db, 9_511).expect("open store");
    let envelope = remote_edit_envelope(&mut store, &key, PATH, 300);
    let applied = apply_ydoc_envelope(&mut store, &envelope, &NoFaults, &NoLiveLeases)
        .expect("apply remote edit");
    let dohc_engine_sync::ApplyOutcome::WithDiagnostics {
        outcome,
        refusals,
        sharing_declined,
    } = applied
    else {
        panic!("the remote edit must apply and surface its sharing decline");
    };
    assert!(matches!(
        *outcome,
        dohc_engine_sync::ApplyOutcome::Applied(_)
    ));
    assert!(refusals.is_empty());
    assert_eq!(sharing_declined.len(), 1);
    assert_oversized_decline(&sharing_declined[0], PATH);
    assert_remote_edit_committed(&store, &key);
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

/// A crash can leave a private Y.Doc lineage durable without a live lease. If
/// the user deletes that closed file before first relay contact, the deletion
/// must retire the lineage. Otherwise enrollment sees the orphaned marker,
/// publishes its stale path as a Y.Doc base, and excludes the delete moment
/// from the ordinary moment lane.
///
/// Mutation check: omit lineage retirement from ordinary delete. Enrollment
/// then emits a `ydoc.update`, retains the marker, and never journals the
/// delete moment.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deleting_a_crash_left_ydoc_before_enrollment_retires_the_lineage() {
    const WS: &str = "ws-originate-delete-before-enrollment";
    const PATH: &str = "notes/deleted.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    seed_identity(&db, WS);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    let key = DocKey::new(WS, "main", &object_id).expect("key");
    let doc = Ydoc::wire();
    let update = doc.plaintext_insert(0, "private edit");
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
        .expect("private Y.Doc edit");
    assert_eq!(
        marker_state(&db, &key),
        (Regime::LocalOnly, false),
        "the private lineage exists before the crash-shaped close"
    );
    // No session close ran. This is the durable state left by a daemon crash:
    // the next process has no live lease, but the lineage rows remain.
    supervisor
        .close(&db)
        .expect("stop actor without a Y.Doc close");

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 2).expect("reopen actor").actor;
    handle
        .versioned_text_delete(
            DeleteTextFile {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: PATH.to_owned(),
                moment_id: "moment-delete-private-ydoc".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 300,
            },
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("delete the closed Y.Doc file");
    supervisor.close(&db).expect("close actor after delete");

    let mut store = EngineStore::open(&db, 9_350).expect("open store for enrollment");
    let cursor = RelayCursor {
        cursor: 0,
        replication_epoch: "epoch-local".to_owned(),
        stream_identity: "stream-local".to_owned(),
        refusal_report_id: None,
    };
    commit_relay_cursor(&mut store, WS, &cursor, &NoFaults, 400)
        .expect("first relay position enrolls the workspace");
    let (markers, snapshots): (i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id=?1 AND version_id='main' AND object_id=?2",
                    rusqlite::params![WS, object_id],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id=?1 AND version_id='main' AND object_id=?2",
                    rusqlite::params![WS, object_id],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("inspect deleted lineage");
    drop(store);
    assert_eq!(
        (markers, snapshots),
        (0, 0),
        "the deleted file stays absent"
    );

    let ops = local_ops(&db);
    assert!(
        ops.iter().all(|op| op.op_kind != "ydoc.update"),
        "enrollment must not publish the deleted lineage: {ops:?}"
    );
    assert!(
        ops.iter().any(|op| {
            op.op_kind == "moment.append"
                && op
                    .payload
                    .get("momentId")
                    .and_then(serde_json::Value::as_str)
                    == Some("moment-delete-private-ydoc")
                && op
                    .payload
                    .get("operation")
                    .and_then(serde_json::Value::as_str)
                    == Some("delete")
        }),
        "the ordinary delete moment is the relay representation: {ops:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_retiring_a_closed_ydoc_head_retires_the_lineage() {
    const WS: &str = "ws-originate-capture-retire";
    const PATH: &str = "notes/capture-retired.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    let key = DocKey::new(WS, "main", &object_id).expect("key");
    let doc = Ydoc::wire();
    let update = doc.plaintext_insert(0, "edited while closed\n");
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
        .expect("record private Y.Doc update");
    assert!(lineage_exists(&db, &key));

    let retired = handle
        .capture_retire(
            CaptureRetire {
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
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture retire");
    assert!(retired.retired.is_some(), "the Y.Doc-owned head is retired");
    assert!(
        !lineage_exists(&db, &key),
        "capture retirement must remove the canonical lineage with its snapshot"
    );
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_lease_blocks_capture_retire_until_retry_and_rolls_back_every_row() {
    const WS: &str = "ws-originate-capture-live-lease";
    const PATH: &str = "notes/live-capture-retire.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    enable_sync(&db, WS);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    let key = DocKey::new(WS, "main", &object_id).expect("key");
    let doc = Ydoc::wire();
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            doc.plaintext_insert(0, "first live edit\n"),
            None,
            false,
            None,
            200,
            Arc::new(NoFaults),
            CancellationToken::new(),
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
            false,
            None,
            270,
            Arc::new(NoFaults),
            CancellationToken::new(),
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
    let error = handle
        .capture_retire(
            input.clone(),
            leases.clone(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect_err("a live Y.Doc lease must make capture retirement retryable");
    assert!(matches!(
        error,
        RuntimeError::Sync(SyncError::RetryableState {
            reason: "ydoc-session-live"
        })
    ));
    assert_eq!(
        capture_retire_state(&db, &key, PATH),
        before,
        "the retryable refusal must roll back the snapshot, moment, log, and lineage deletes"
    );

    drop(lease);
    let error = handle
        .capture_retire(
            input.clone(),
            leases.clone(),
            Arc::new(NoFaults),
            CancellationToken::new(),
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
    let retired = handle
        .capture_retire(input, leases, Arc::new(NoFaults), CancellationToken::new())
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn merge_fast_forward_delete_retires_the_target_ydoc_lineage() {
    const WS: &str = "ws-originate-merge-delete";
    const PATH: &str = "notes/merge-deleted.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    handle
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WS.to_owned(),
                new_version_id: "source".to_owned(),
                name: "Source".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 150,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("create source version");

    let key = DocKey::new(WS, "main", &object_id).expect("key");
    let doc = Ydoc::wire();
    let update = doc.plaintext_insert(0, "seed\n");
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
        .expect("record target Y.Doc state");
    handle
        .versioned_text_delete(
            DeleteTextFile {
                workspace_id: WS.to_owned(),
                version_id: "source".to_owned(),
                path: PATH.to_owned(),
                moment_id: "moment-source-delete".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 250,
            },
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("delete source path");
    assert!(lineage_exists(&db, &key));

    let merged = handle
        .versioned_text_merge(
            MergeTextFileFromVersion {
                workspace_id: WS.to_owned(),
                target_version_id: "main".to_owned(),
                source_version_id: "source".to_owned(),
                path: PATH.to_owned(),
                object_id: "unused-merge-object".to_owned(),
                moment_id: "moment-merge-delete".to_owned(),
                request_id: None,
                conflict_id: "conflict-merge-delete".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 300,
            },
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("merge source deletion");
    assert!(matches!(merged.merge, MergeTextFileResult::Delete { .. }));
    assert!(
        !lineage_exists(&db, &key),
        "merge deletion must retire the target's canonical lineage"
    );
    supervisor.close(&db).expect("close actor");
}

/// COLLISION. When a peer's base for the same lineage lands first, the local
/// daemon must not mint a second one: it observes the claim and journals its
/// edit as a delta instead. Within one database SQLite serializes writers, so
/// the concurrent claim reduces to this ordering, and the claim's re-check
/// reads the same transaction that would write the second base.
///
/// Mutation check: drop the exact-claim guard in
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rollback_reconciles_a_closed_replicated_lineage_to_the_restored_text() {
    const WS: &str = "ws-rollback-closed-lineage";
    const PATH: &str = "notes/rollback.md";
    const BEFORE: &str = "seed\n";
    const AFTER: &str = "seed\nafter\n";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    std::fs::create_dir_all(scratch.path().join("notes")).expect("notes directory");
    std::fs::write(scratch.path().join(PATH), BEFORE).expect("seed disk");
    enable_sync(&db, WS);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let object_id = capture_seed(&handle, WS, PATH, 100).await;
    let key = DocKey::new(WS, "main", &object_id).expect("key");
    let opened = handle
        .ydoc_open_state(
            WS.to_owned(),
            150,
            true,
            Some(key.clone()),
            "main".to_owned(),
            PATH.to_owned(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("open seeded document");
    let doc = Ydoc::wire();
    doc.apply(&opened.initial_update)
        .expect("load seeded state");
    let seed = opened.seed_content.as_deref().expect("Markdown seed");
    doc.plaintext_insert(0, seed);
    assert_eq!(doc.plaintext_string(), BEFORE);
    doc.plaintext_insert(BEFORE.len() as u32, "after\n");
    let update = doc.encode_full_state();
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            opened.regime,
            update,
            None,
            false,
            None,
            200,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("record later text");
    let settled = handle
        .ydoc_settle(
            scratch.path().to_path_buf(),
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            opened.head_blob_sha256,
            "rollback-source-session".to_owned(),
            Arc::new(NoRecorder),
            250,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("settle later text");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(PATH)).expect("settled disk"),
        AFTER
    );
    handle
        .ydoc_close_session(
            key.clone(),
            300,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("close replicated lineage");
    assert_eq!(marker_state(&db, &key), (Regime::Replicated, true));

    handle
        .versioned_text_rollback(
            RollbackTextFileMutation {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: PATH.to_owned(),
                mutation_moment_id: settled.moment_id,
                request_id: None,
                legacy_before_text: None,
                metadata_origin: "test-rollback".to_owned(),
                author_json: None,
            },
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("roll back the settled edit");
    assert_eq!(marker_state(&db, &key), (Regime::Replicated, true));
    assert_eq!(
        local_ydoc_ops(&db).len(),
        2,
        "rollback must journal one canonical rewrite after the original base"
    );
    // Plaintext rollback is DB-only; model its external disk projection so
    // the follow-up settle isolates the retained CRDT lineage.
    std::fs::write(scratch.path().join(PATH), BEFORE).expect("project rollback to disk");
    let reopened = handle
        .ydoc_open_state(
            WS.to_owned(),
            350,
            true,
            Some(key.clone()),
            "main".to_owned(),
            PATH.to_owned(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("reopen after rollback");
    let resumed = Ydoc::wire();
    resumed
        .apply(&reopened.initial_update)
        .expect("load rolled-back state");
    assert_eq!(
        resumed.plaintext_string(),
        BEFORE,
        "a closed replicated lineage must project the restored head"
    );

    let next = resumed.plaintext_insert(BEFORE.len() as u32, "next\n");
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            reopened.regime,
            next,
            None,
            false,
            None,
            400,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("record edit after rollback");
    handle
        .ydoc_settle(
            scratch.path().to_path_buf(),
            key,
            PATH.to_owned(),
            ContentKind::Plaintext,
            reopened.head_blob_sha256,
            "rollback-follow-up-session".to_owned(),
            Arc::new(NoRecorder),
            450,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("settle edit after rollback");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(PATH)).expect("follow-up disk"),
        "seed\nnext\n",
        "the next valid delta must build on the restored head"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ordinary_text_write_sends_one_canonical_rewrite_before_its_moment() {
    const WS: &str = "ws-ordinary-write-order";
    const PATH: &str = "notes/ordered.md";
    const OBJECT: &str = "ordered-object";
    const BEFORE: &str = "before\n";
    const AFTER: &str = "after\n";
    let source_scratch = ScratchDir::new().expect("source scratch");
    let source_db = source_scratch.engine_db_path().expect("source db");
    let peer_scratch = ScratchDir::new().expect("peer scratch");
    let peer_db = peer_scratch.engine_db_path().expect("peer db");
    let base_doc = Ydoc::wire();
    base_doc.plaintext_insert(0, BEFORE);
    let base = base_doc.encode_full_state();

    for db in [&source_db, &peer_db] {
        let mut store = EngineStore::open(db, 1).expect("open replica");
        let mut versions = VersionedTextStore::new(&mut store);
        versions
            .ensure_main_version(WS, "main", 1, &NoFaults)
            .expect("main version");
        versions
            .write_text(
                &WriteText {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    object_id: OBJECT.to_owned(),
                    path: PATH.to_owned(),
                    text: BEFORE.to_owned(),
                    moment_id: "ordered-base-moment".to_owned(),
                    metadata_origin: "test".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 10,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("seed matching head");
        let key = DocKey::new(WS, "main", OBJECT).expect("key");
        dohc_engine_collab::claim_base(
            &mut store,
            &key,
            ContentKind::Plaintext,
            &base,
            &NoFaults,
            20,
        )
        .expect("claim matching base");
    }
    enable_sync(&source_db, WS);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor
        .open(&source_db, 2)
        .expect("open source actor")
        .actor;
    handle
        .versioned_text_write(
            WriteText {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                object_id: OBJECT.to_owned(),
                path: PATH.to_owned(),
                text: AFTER.to_owned(),
                moment_id: "ordered-write-moment".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 30,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("ordinary text write");
    supervisor.close(&source_db).expect("close source actor");

    let ops = local_ops(&source_db);
    assert_eq!(
        ops.iter().map(|op| op.op_kind.as_str()).collect::<Vec<_>>(),
        vec!["ydoc.update", "moment.append"],
        "the canonical CRDT rewrite must precede the artifact moment"
    );

    let source = EngineStore::open(&source_db, 40).expect("open source store");
    let text_blobs: Vec<(String, i64, String)> = source
        .read_with(|conn| {
            let mut statement = conn.prepare("SELECT sha256, byte_length, text FROM blobs")?;
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<Result<Vec<_>, _>>()
        })
        .expect("source text blobs");
    let mut peer = EngineStore::open(&peer_db, 40).expect("open peer store");
    peer.write_with(&NoFaults, |tx| {
        for (sha, byte_length, text) in &text_blobs {
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?1, ?2, ?3)",
                rusqlite::params![sha, byte_length, text],
            )
            .map_err(StorageError::persist_public)?;
        }
        Ok::<_, StorageError>(())
    })
    .expect("copy text blobs");
    for op in &ops {
        if op.op_kind == "ydoc.update" {
            let sha = op.blob_sha();
            let bytes = source
                .get_binary_blob(&sha)
                .expect("read update blob")
                .expect("update blob exists");
            peer.put_binary_blob(&bytes).expect("copy update blob");
        }
        let envelope = ReplicationEnvelope {
            workspace_id: WS.to_owned(),
            origin_id: op.origin_id.clone(),
            origin_seq: op.origin_seq,
            op_kind: op.op_kind.clone(),
            payload: op.payload.clone(),
            recorded_at_ms: op.recorded_at_ms,
        };
        apply_replication_envelope(&mut peer, &envelope, &NoFaults, &NoLiveLeases)
            .expect("apply ordered operation");
    }
    let peer_local_ydoc_ops: i64 = peer
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log WHERE imported=0 AND op_kind='ydoc.update'",
                [],
                |row| row.get(0),
            )
        })
        .expect("peer local Y.Doc operations");
    assert_eq!(
        peer_local_ydoc_ops, 0,
        "the receiver must not mint a second rewrite"
    );

    let key = DocKey::new(WS, "main", OBJECT).expect("key");
    let source_doc = dohc_engine_collab::load_persisted(&source, &key)
        .expect("load source lineage")
        .expect("source lineage")
        .doc;
    let peer_doc = dohc_engine_collab::load_persisted(&peer, &key)
        .expect("load peer lineage")
        .expect("peer lineage")
        .doc;
    let source_state = source_doc.encode_full_state();
    let peer_state = peer_doc.encode_full_state();
    source_doc.apply(&peer_state).expect("merge peer state");
    peer_doc.apply(&source_state).expect("merge source state");
    assert_eq!(source_doc.plaintext_string(), AFTER);
    assert_eq!(peer_doc.plaintext_string(), AFTER);
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
