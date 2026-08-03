//! Settlement binds the path, so settlement asks origination (#548 review
//! round 3). A lineage with durable rows but no settled artifact has no
//! `path_aliases` row: the first-cursor sweep cannot name it, and a
//! settle-then-close prune would discard the rows with no base ever
//! journaled. The settle is the moment the path becomes durable — it must
//! ask origination again, exactly like the append, the dependency-resolving
//! apply, and the first cursor commit.

use dohc_engine_collab::{ContentKind, DocKey, Regime};
use dohc_engine_domain::VersionedTextStore;
use dohc_engine_runtime::{CancellationToken, NoFaults, SelfWriteRecorder, WorkspaceSupervisor};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::ScratchDir;
use std::sync::Arc;

struct NoRecorder;

impl SelfWriteRecorder for NoRecorder {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

const WS: &str = "ws-settle-origination";
const PATH: &str = "notes/orphan.md";

fn journaled_base_ops(db: &std::path::Path) -> Vec<(String, bool)> {
    let store = EngineStore::open(db, 9_200).expect("open");
    store
        .read_with(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT payload_json FROM replication_log \
                     WHERE workspace_id=?1 AND op_kind='ydoc.update' AND imported=0 \
                     ORDER BY origin_seq",
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
            let rows = stmt
                .query_map([WS], |row| row.get::<_, String>(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
            let mut out = Vec::new();
            for row in rows {
                let payload: serde_json::Value = serde_json::from_str(
                    &row.map_err(dohc_engine_storage::StorageError::corrupt_public)?,
                )
                .expect("payload");
                out.push((
                    payload["updateBlobSha256"]
                        .as_str()
                        .expect("sha")
                        .to_owned(),
                    payload["isBaseState"].as_bool().expect("flag"),
                ));
            }
            Ok::<_, dohc_engine_storage::StorageError>(out)
        })
        .expect("journal scan")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn settlement_originates_the_pathless_owed_lineage() {
    // MUTATION: drop the origination call from `ydoc_settle_on_store`'s
    // success paths — the base assertion below finds an empty journal.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let key = {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        VersionedTextStore::new(&mut store)
            .ensure_main_version(WS, "main", 1, &NoFaults)
            .expect("main version");
        dohc_engine_sync::journal_local_replication_op(
            &mut store,
            WS,
            "local",
            "epoch-1",
            "stream-1",
            "probe.local",
            &serde_json::json!({}),
            2,
            &NoFaults,
        )
        .expect("sync identity");
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO sync_relay_cursors \
                     (workspace_id, cursor, replication_epoch, stream_identity) \
                     VALUES (?1,'0','epoch-1','stream-1')",
                    [WS],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                tx.execute(
                    "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) \
                     VALUES (?1, 'object-orphan', 3)",
                    [WS],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .expect("scaffolding");
        let key = DocKey::new(WS, "main", "object-orphan").expect("key");
        // Durable local rows, but NOTHING settled: no snapshot, no alias —
        // the first-cursor sweep cannot name this lineage.
        let update = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "settle me");
        dohc_engine_collab::record_local_update_creating_marker(
            &mut store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &update,
            None,
            &NoFaults,
            4,
        )
        .expect("local edit");
        key
    };
    assert!(
        journaled_base_ops(&db).is_empty(),
        "nothing originates before settlement binds the path"
    );
    std::fs::create_dir_all(scratch.path().join("notes")).expect("notes dir");

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 5).expect("open actor").actor;
    handle
        .ydoc_settle(
            scratch.path().to_path_buf(),
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            None,
            "origination-session".to_owned(),
            Arc::new(NoRecorder),
            6,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("settle succeeds");
    supervisor.close(&db).expect("close actor");

    let ops = journaled_base_ops(&db);
    assert_eq!(ops.len(), 1, "settlement originates the owed lineage");
    assert!(ops[0].1, "the journaled op is the base state");
    let store = EngineStore::open(&db, 7).expect("inspect");
    let marker = dohc_engine_collab::read_marker(&store, &key)
        .expect("marker read")
        .expect("marker");
    assert_eq!(marker.regime, Regime::Replicated);
    assert!(marker.base_claimed);
    let base_bytes = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT bytes FROM binary_blobs WHERE sha256=?1",
                [ops[0].0.as_str()],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("base blob");
    let peer = dohc_engine_collab::Ydoc::wire();
    peer.apply(&base_bytes).expect("peer base");
    assert_eq!(
        peer.plaintext_string(),
        "settle me",
        "a clean peer reads the settled content from the base alone"
    );
}
