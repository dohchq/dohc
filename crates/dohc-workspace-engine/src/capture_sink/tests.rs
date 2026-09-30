use super::*;
use dohc_engine_collab::{ContentKind, Ydoc};
use dohc_engine_domain::{
    CollectionQuery, CollectionQueryResult, CollectionRecordDetails, MAX_TEXT_BYTES,
    RECORD_ID_FRONTMATTER_KEY, SecretDiskIntent, SecretFileStore, SecretWrite, VersionedTextStore,
    decline_oversized_collection_adoption_in_tx, get_collection_record, is_record_id,
    query_collection_records,
};
use dohc_engine_files::{
    CancellationToken, CaptureOp, ReconcilePlan, ScanGeneration, apply_reconcile_plan,
};
use dohc_engine_runtime::WorkspaceSupervisor;
use dohc_engine_storage::{EngineStore, NoFaults as FilesNoFaults};
use dohc_engine_testkit::ScratchDir;
use proptest::prelude::*;
use rusqlite::{Connection, OptionalExtension};
use std::sync::Condvar;
use std::time::Duration;

const WORKSPACE_ID: &str = "ws-capture-sink";
const VERSION_ID: &str = "main";

fn sink_for(scratch: &ScratchDir, supervisor: &WorkspaceSupervisor) -> (PathBuf, StoreCaptureSink) {
    let db = dohc_engine_testkit::engine_db_path(scratch).expect("engine db path");
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    (
        db,
        StoreCaptureSink::new(bound_sink_params(
            actor,
            WORKSPACE_ID,
            VERSION_ID,
            scratch.path(),
            10,
        )),
    )
}

fn write_file(root: &Path, path: &str, bytes: &[u8]) {
    let absolute = root.join(path);
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent).expect("create file parent");
    }
    std::fs::write(absolute, bytes).expect("write fixture");
}

fn ingest(sink: &mut StoreCaptureSink, path: &str) -> Result<IngestOutcome, CaptureError> {
    ingest_as(sink, path, "text/markdown")
}

fn ingest_as(
    sink: &mut StoreCaptureSink,
    path: &str,
    media_type: &str,
) -> Result<IngestOutcome, CaptureError> {
    sink.ingest(path, 0, "advisory-sha", media_type, IngestReason::Changed)
}

fn seed_captured_richdoc_lineage(sink: &StoreCaptureSink, path: &str) {
    let markdown = std::fs::read_to_string(sink.shadow_root.join(path))
        .unwrap_or_else(|_| panic!("read captured rich-document fixture {path}"));
    seed_captured_richdoc_lineage_from_markdown(sink, path, markdown);
}

fn seed_captured_richdoc_lineage_from_markdown(
    sink: &StoreCaptureSink,
    path: &str,
    markdown: String,
) {
    let actor = sink.actor.clone();
    let path = path.to_owned();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("test rich-document runtime")
        .block_on(async move {
            let state = actor
                .ydoc_open_state(
                    WORKSPACE_ID.to_owned(),
                    11,
                    false,
                    None,
                    VERSION_ID.to_owned(),
                    path.clone(),
                    Some(ContentKind::Richdoc),
                    CancellationToken::new(),
                )
                .await
                .expect("open captured rich-document fixture");
            assert!(
                !state.lineage_existing,
                "fixture must start without canonical Y.Doc lineage"
            );

            // These engine tests use the limited helper only to establish
            // simple fixture lineage. Production adoption imports through
            // the desktop's shared @dohc/ydoc-projection path.
            let doc = Ydoc::wire();
            doc.apply(&state.initial_update)
                .expect("apply initial rich-document fixture state");
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, &markdown)
                .expect("seed simple rich-document fixture");
            actor
                .ydoc_record_update(
                    state.key,
                    path,
                    ContentKind::Richdoc,
                    state.regime,
                    doc.encode_full_state(),
                    None,
                    None,
                    state.lineage_claim_id,
                    true,
                    state.owner_seed_source,
                    None,
                    12,
                    Arc::new(FilesNoFaults),
                    CancellationToken::new(),
                    None,
                )
                .await
                .expect("record simple rich-document fixture seed");
        });
}

fn snapshot(db: &Path, path: &str) -> Option<dohc_engine_domain::TextSnapshot> {
    let mut store = EngineStore::open(db, 100).expect("reopen store");
    snapshot_from_store(&mut store, path)
}

fn snapshot_from_store(
    store: &mut EngineStore,
    path: &str,
) -> Option<dohc_engine_domain::TextSnapshot> {
    VersionedTextStore::new(store)
        .read_text(WORKSPACE_ID, VERSION_ID, path)
        .expect("read captured text")
}

/// The current binary head's sha256 for `path`, if the head is binary.
fn binary_head(db: &Path, path: &str) -> Option<String> {
    use rusqlite::OptionalExtension;
    let store = EngineStore::open(db, 100).expect("reopen store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT s.binary_sha256 FROM snapshots s \
                     JOIN path_aliases a ON a.workspace_id = s.workspace_id \
                       AND a.version_id = s.version_id AND a.object_id = s.object_id \
                     WHERE s.workspace_id = ?1 AND a.path = ?2 \
                       AND s.content_kind = 'binary'",
                [WORKSPACE_ID, path],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
        })
        .expect("binary head query")
        .flatten()
}

/// The encrypted tip's plaintext byte length for a secret path (metadata
/// only — the test never decrypts).
fn secret_tip_len(db: &Path, path: &str) -> Option<i64> {
    use rusqlite::OptionalExtension;
    let store = EngineStore::open(db, 100).expect("reopen store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT byte_length FROM secret_files WHERE workspace_id = ?1 AND path = ?2",
                [WORKSPACE_ID, path],
                |row| row.get::<_, i64>(0),
            )
            .optional()
        })
        .expect("secret tip query")
}

fn moment_count(db: &Path, path: &str) -> i64 {
    let store = EngineStore::open(db, 100).expect("reopen store");
    moment_count_from_store(&store, path)
}

fn moment_count_from_store(store: &EngineStore, path: &str) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM moments WHERE workspace_id = ?1 AND path = ?2",
                [WORKSPACE_ID, path],
                |row| row.get(0),
            )
        })
        .expect("moment count")
}

fn collection_record(db: &Path, path: &str) -> Option<(Option<String>, String)> {
    let store = EngineStore::open(db, 100).expect("reopen store");
    collection_record_from_store(&store, path)
}

fn collection_record_from_store(
    store: &EngineStore,
    path: &str,
) -> Option<(Option<String>, String)> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT record_id, adoption_state FROM collection_records \
                     WHERE workspace_id = ?1 AND version_id = ?2 AND file_path = ?3",
                [WORKSPACE_ID, VERSION_ID, path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
        })
        .expect("collection record")
}

mod batching;
mod collections;
mod ingestion;
mod policy;
mod provenance;
mod root_binding;
mod secrets;
