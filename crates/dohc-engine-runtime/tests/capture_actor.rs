use dohc_engine_domain::VersionedTextStore;
use dohc_engine_runtime::{
    CancellationToken, CaptureIngest, CaptureRetire, MAX_CAPTURE_INGEST_BATCH_BYTES,
    MAX_CAPTURE_INGEST_BATCH_OPS, NoFaults, RuntimeError, WorkspaceRootGuard, WorkspaceSupervisor,
};
use dohc_engine_storage::{EngineStore, FaultPoint, StorageError};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::path::Path;
use std::sync::Arc;

const BATCH_WORKSPACE_ID: &str = "ws-capture-batch-fault";

struct ExistingRootGuard;

impl WorkspaceRootGuard for ExistingRootGuard {
    fn validate(&self, root_dir: &Path) -> Result<(), RuntimeError> {
        root_dir
            .is_dir()
            .then_some(())
            .ok_or(RuntimeError::Identity {
                reason: "test workspace root disappeared",
                source: None,
            })
    }
}

fn capture_batch_inputs() -> Vec<CaptureIngest> {
    [
        ("notes/a.md", "alpha"),
        ("notes/b.md", "bravo"),
        ("notes/c.md", "charlie"),
    ]
    .into_iter()
    .map(|(path, text)| CaptureIngest {
        workspace_id: BATCH_WORKSPACE_ID.to_owned(),
        version_id: "main".to_owned(),
        path: path.to_owned(),
        text: text.to_owned(),
        metadata_origin: "capture".to_owned(),
        metadata_summary: Some("Reconciled offline edits".to_owned()),
        metadata_correlation_id: Some("batch-fault".to_owned()),
        author_json: None,
        now_ms: 10,
        request_id: None,
        claim_foreign_head: false,
    })
    .collect()
}

fn initialize_replicating_workspace(db: &Path) {
    let mut store = EngineStore::open(db, 1).expect("open store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(BATCH_WORKSPACE_ID, "main", 1, &NoFaults)
        .expect("ensure main version");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO sync_identity \
                 (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
                 VALUES (?1, 'origin-local', 'epoch-local', 'stream-local', 1)",
                [BATCH_WORKSPACE_ID],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq) \
                 VALUES (?1, 'origin-local', 0)",
                [BATCH_WORKSPACE_ID],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("seed sync state");
}

#[derive(Debug, PartialEq, Eq)]
struct CaptureBatchState {
    storage_rows: i64,
    snapshots: Vec<(String, String)>,
    moments: Vec<String>,
    search: Vec<(String, String)>,
    outbound: Vec<String>,
}

fn capture_batch_state(db: &Path) -> CaptureBatchState {
    let store = EngineStore::open(db, 100).expect("inspect batch state");
    store
        .read_with(|conn| {
            let storage_rows = conn.query_row(
                "SELECT \
                   (SELECT COUNT(*) FROM path_aliases WHERE workspace_id=?1) + \
                   (SELECT COUNT(*) FROM snapshots WHERE workspace_id=?1) + \
                   (SELECT COUNT(*) FROM moments WHERE workspace_id=?1) + \
                   (SELECT COUNT(*) FROM file_objects WHERE workspace_id=?1)",
                [BATCH_WORKSPACE_ID],
                |row| row.get(0),
            )?;
            let snapshots = conn
                .prepare(
                    "SELECT s.path,b.text FROM snapshots s \
                     JOIN blobs b ON b.sha256=s.blob_sha256 \
                     WHERE s.workspace_id=?1 ORDER BY s.path",
                )?
                .query_map([BATCH_WORKSPACE_ID], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let moments = conn
                .prepare("SELECT path FROM moments WHERE workspace_id=?1 ORDER BY moment_order")?
                .query_map([BATCH_WORKSPACE_ID], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let search = conn
                .prepare(
                    "SELECT path,text FROM engine_search_files_fts \
                     WHERE workspace_id=?1 ORDER BY path",
                )?
                .query_map([BATCH_WORKSPACE_ID], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let outbound = conn
                .prepare(
                    "SELECT json_extract(payload_json,'$.path') FROM replication_log \
                     WHERE workspace_id=?1 AND imported=0 AND op_kind='moment.append' \
                     ORDER BY origin_seq",
                )?
                .query_map([BATCH_WORKSPACE_ID], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok::<_, rusqlite::Error>(CaptureBatchState {
                storage_rows,
                snapshots,
                moments,
                search,
                outbound,
            })
        })
        .expect("query batch state")
}

fn expected_capture_batch_state() -> CaptureBatchState {
    CaptureBatchState {
        storage_rows: 12,
        snapshots: vec![
            ("notes/a.md".to_owned(), "alpha".to_owned()),
            ("notes/b.md".to_owned(), "bravo".to_owned()),
            ("notes/c.md".to_owned(), "charlie".to_owned()),
        ],
        moments: vec![
            "notes/a.md".to_owned(),
            "notes/b.md".to_owned(),
            "notes/c.md".to_owned(),
        ],
        search: vec![
            ("notes/a.md".to_owned(), "alpha".to_owned()),
            ("notes/b.md".to_owned(), "bravo".to_owned()),
            ("notes/c.md".to_owned(), "charlie".to_owned()),
        ],
        outbound: vec![
            "notes/a.md".to_owned(),
            "notes/b.md".to_owned(),
            "notes/c.md".to_owned(),
        ],
    }
}

#[test]
fn blocking_capture_variants_round_trip_through_the_actor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;

    let written = handle
        .capture_ingest_blocking(
            CaptureIngest {
                workspace_id: "ws-actor-capture".to_owned(),
                version_id: "main".to_owned(),
                path: "notes/a.md".to_owned(),
                text: "captured".to_owned(),
                metadata_origin: "actor-test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
                request_id: Some("actor-capture-request".to_owned()),
                claim_foreign_head: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
        )
        .expect("blocking capture");

    assert_eq!(written.snapshot.text, "captured");
    assert_eq!(written.snapshot.path, "notes/a.md");

    let retired = handle
        .capture_retire_blocking(
            CaptureRetire {
                workspace_id: "ws-actor-capture".to_owned(),
                version_id: "main".to_owned(),
                path: "notes/a.md".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 20,
                request_id: Some("actor-retire-request".to_owned()),
                only_if_text_head: false,
                only_if_capture_origin: false,
                allow_ydoc_origin: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
        )
        .expect("blocking retire");
    assert!(retired.retired.is_some());
    supervisor.close(&db).expect("close actor");
}

#[test]
fn bounded_capture_batch_contains_a_leased_path_and_replays_without_duplicates() {
    const WORKSPACE_ID: &str = "ws-capture-batch";
    const VERSION_ID: &str = "main";
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let policy = Arc::new(dohc_engine_runtime::search::read_engine_search_policy(
        scratch.path(),
    ));

    let input = |path: &str, text: &str| CaptureIngest {
        workspace_id: WORKSPACE_ID.to_owned(),
        version_id: VERSION_ID.to_owned(),
        path: path.to_owned(),
        text: text.to_owned(),
        metadata_origin: "capture".to_owned(),
        metadata_summary: Some("Reconciled offline edits".to_owned()),
        metadata_correlation_id: Some("batch-pass".to_owned()),
        author_json: None,
        now_ms: 10,
        request_id: None,
        claim_foreign_head: false,
    };
    let inputs = vec![
        input("notes/a.md", "alpha batch needle"),
        input("notes/b.md", "bravo batch needle"),
        input("notes/c.md", "charlie batch needle"),
    ];
    let leased_object =
        dohc_engine_domain::derive_capture_object_id(WORKSPACE_ID, VERSION_ID, "notes/b.md");
    let leased_key =
        dohc_engine_collab::DocKey::new(WORKSPACE_ID, VERSION_ID, &leased_object).expect("key");
    let leases = dohc_engine_collab::LeaseRegistry::new();
    let held = leases.acquire(&leased_key).expect("hold middle path live");

    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let first = handle
        .capture_ingest_batch_blocking(
            inputs.clone(),
            Arc::clone(&policy),
            leases.clone(),
            Arc::new(NoFaults),
            scratch.path().to_path_buf(),
            Arc::new(ExistingRootGuard),
        )
        .expect("commit successful siblings");
    assert_eq!(first.len(), 3);
    assert!(
        first[0]
            .as_ref()
            .is_ok_and(|write| !write.deduped && !write.moment.before_present)
    );
    assert!(matches!(
        &first[1],
        Err(RuntimeError::Sync(
            dohc_engine_sync::SyncError::RetryableState { reason }
        )) if *reason == dohc_engine_runtime::CAPTURE_NEW_FILE_LIVE
    ));
    assert!(
        first[2]
            .as_ref()
            .is_ok_and(|write| !write.deduped && !write.moment.before_present)
    );
    assert_eq!(
        first[0]
            .as_ref()
            .expect("first capture")
            .moment
            .moment_order,
        1
    );
    assert_eq!(
        first[2]
            .as_ref()
            .expect("third capture")
            .moment
            .moment_order,
        2,
        "the failed middle savepoint must not consume the batch order cursor"
    );
    supervisor.close(&db).expect("close after partial batch");

    let state = |expected_paths: &[&str]| {
        let store = EngineStore::open(&db, 100).expect("inspect batch state");
        store
            .read_with(|conn| {
                let read_paths = |table: &str| -> rusqlite::Result<Vec<String>> {
                    let mut statement = conn.prepare(&format!(
                        "SELECT path FROM {table} WHERE workspace_id=?1 ORDER BY path"
                    ))?;
                    statement
                        .query_map([WORKSPACE_ID], |row| row.get(0))?
                        .collect()
                };
                let paths = read_paths("snapshots")?;
                let moments: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id=?1",
                    [WORKSPACE_ID],
                    |row| row.get(0),
                )?;
                let search_paths = read_paths("engine_search_files_fts")?;
                Ok::<_, rusqlite::Error>((paths, moments, search_paths))
            })
            .map(|(paths, moments, search_paths)| {
                let expected = expected_paths
                    .iter()
                    .map(|path| (*path).to_owned())
                    .collect::<Vec<_>>();
                assert_eq!(paths, expected);
                assert_eq!(moments, expected_paths.len() as i64);
                assert_eq!(search_paths, expected);
            })
            .expect("query batch state");
    };
    state(&["notes/a.md", "notes/c.md"]);

    drop(held);
    let handle = supervisor.open(&db, 2).expect("reopen actor").actor;
    let replay = handle
        .capture_ingest_batch_blocking(
            inputs,
            policy,
            leases,
            Arc::new(NoFaults),
            scratch.path().to_path_buf(),
            Arc::new(ExistingRootGuard),
        )
        .expect("retry whole chunk after lease release");
    assert!(replay[0].as_ref().is_ok_and(|write| write.deduped));
    assert!(replay[1].as_ref().is_ok_and(|write| !write.deduped));
    assert!(replay[2].as_ref().is_ok_and(|write| write.deduped));
    assert_eq!(
        replay[1]
            .as_ref()
            .expect("retried middle capture")
            .moment
            .moment_order,
        3,
        "the leading dedupe must not consume the batch order cursor"
    );
    supervisor.close(&db).expect("close after replay");
    state(&["notes/a.md", "notes/b.md", "notes/c.md"]);
}

#[test]
fn capture_batch_rejects_a_missing_named_version_before_writing() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    initialize_replicating_workspace(&db);
    let mut inputs = capture_batch_inputs();
    for input in &mut inputs {
        input.version_id = "missing-version".to_owned();
    }
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let error = handle
        .capture_ingest_batch_blocking(
            inputs,
            Arc::new(dohc_engine_runtime::search::read_engine_search_policy(
                scratch.path(),
            )),
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            scratch.path().to_path_buf(),
            Arc::new(ExistingRootGuard),
        )
        .expect_err("missing named version must be rejected");
    assert!(matches!(
        error,
        RuntimeError::Domain(dohc_engine_domain::DomainError::VersionNotFound)
    ));
    supervisor.close(&db).expect("close actor");

    let store = EngineStore::open(&db, 100).expect("inspect refused batch");
    let written: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT \
                   (SELECT COUNT(*) FROM path_aliases WHERE workspace_id=?1) + \
                   (SELECT COUNT(*) FROM snapshots WHERE workspace_id=?1) + \
                   (SELECT COUNT(*) FROM moments WHERE workspace_id=?1) + \
                   (SELECT COUNT(*) FROM file_objects WHERE workspace_id=?1)",
                [BATCH_WORKSPACE_ID],
                |row| row.get(0),
            )
        })
        .expect("count refused batch state");
    assert_eq!(written, 0);
}

#[test]
fn capture_batch_refuses_invalid_shapes_before_mutation() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let before = capture_batch_state(&db);
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let policy = Arc::new(dohc_engine_runtime::search::read_engine_search_policy(
        scratch.path(),
    ));
    let leases = dohc_engine_collab::LeaseRegistry::new();
    let empty = handle
        .capture_ingest_batch_blocking(
            Vec::new(),
            Arc::clone(&policy),
            leases.clone(),
            Arc::new(NoFaults),
            scratch.path().to_path_buf(),
            Arc::new(ExistingRootGuard),
        )
        .expect("empty batch is a no-op");
    assert!(empty.is_empty());

    let template = capture_batch_inputs().remove(0);
    let error = handle
        .capture_ingest_batch_blocking(
            vec![template.clone(); MAX_CAPTURE_INGEST_BATCH_OPS + 1],
            Arc::clone(&policy),
            leases.clone(),
            Arc::new(NoFaults),
            scratch.path().to_path_buf(),
            Arc::new(ExistingRootGuard),
        )
        .expect_err("overlong batch must be refused");
    assert!(matches!(
        error,
        RuntimeError::Domain(dohc_engine_domain::DomainError::InvalidInput {
            reason: "capture batch exceeds actor bounds"
        })
    ));

    let mut oversized = template.clone();
    oversized.text = "x".repeat(MAX_CAPTURE_INGEST_BATCH_BYTES + 1);
    let error = handle
        .capture_ingest_batch_blocking(
            vec![oversized],
            Arc::clone(&policy),
            leases.clone(),
            Arc::new(NoFaults),
            scratch.path().to_path_buf(),
            Arc::new(ExistingRootGuard),
        )
        .expect_err("oversized batch must be refused");
    assert!(matches!(
        error,
        RuntimeError::Domain(dohc_engine_domain::DomainError::InvalidInput {
            reason: "capture batch exceeds actor bounds"
        })
    ));

    let mut mismatched = template.clone();
    mismatched.version_id = "another-version".to_owned();
    let error = handle
        .capture_ingest_batch_blocking(
            vec![template, mismatched],
            policy,
            leases,
            Arc::new(NoFaults),
            scratch.path().to_path_buf(),
            Arc::new(ExistingRootGuard),
        )
        .expect_err("mixed coordinates must be refused");
    assert!(matches!(
        error,
        RuntimeError::Domain(dohc_engine_domain::DomainError::InvalidInput {
            reason: "capture batch coordinates do not match"
        })
    ));

    supervisor.close(&db).expect("close actor");
    assert_eq!(capture_batch_state(&db), before);
}

#[test]
fn capture_batch_replaces_a_duplicate_path_without_duplicate_fts_rows() {
    const WORKSPACE_ID: &str = "ws-capture-batch-duplicate";
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let policy = Arc::new(dohc_engine_runtime::search::read_engine_search_policy(
        scratch.path(),
    ));
    let input = |text: &str, now_ms: i64| CaptureIngest {
        workspace_id: WORKSPACE_ID.to_owned(),
        version_id: "main".to_owned(),
        path: "notes/repeated.md".to_owned(),
        text: text.to_owned(),
        metadata_origin: "capture".to_owned(),
        metadata_summary: Some("Reconciled offline edits".to_owned()),
        metadata_correlation_id: Some("duplicate-path".to_owned()),
        author_json: None,
        now_ms,
        request_id: None,
        claim_foreign_head: false,
    };
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let results = handle
        .capture_ingest_batch_blocking(
            vec![
                input("alpha-only search body", 10),
                input("bravo-only search body", 20),
            ],
            policy,
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            scratch.path().to_path_buf(),
            Arc::new(ExistingRootGuard),
        )
        .expect("capture duplicate path batch");
    assert!(
        results[0]
            .as_ref()
            .is_ok_and(|write| !write.deduped && !write.moment.before_present)
    );
    assert!(
        results[1]
            .as_ref()
            .is_ok_and(|write| !write.deduped && write.moment.before_present)
    );
    supervisor.close(&db).expect("close actor");

    let store = EngineStore::open(&db, 100).expect("inspect duplicate batch");
    let (moments, rows, indexed): (i64, i64, String) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id=?1",
                    [WORKSPACE_ID],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM engine_search_files_fts WHERE workspace_id=?1",
                    [WORKSPACE_ID],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT text FROM engine_search_files_fts WHERE workspace_id=?1",
                    [WORKSPACE_ID],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("read duplicate batch state");
    assert_eq!((moments, rows), (2, 1));
    assert_eq!(indexed, "bravo-only search body");
}

#[test]
fn added_batch_preserves_a_foreign_head_and_indexes_its_new_sibling() {
    const WORKSPACE_ID: &str = "ws-capture-batch-foreign";
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let policy = Arc::new(dohc_engine_runtime::search::read_engine_search_policy(
        scratch.path(),
    ));
    let input = |path: &str, text: &str, origin: &str, claim_foreign_head: bool| CaptureIngest {
        workspace_id: WORKSPACE_ID.to_owned(),
        version_id: "main".to_owned(),
        path: path.to_owned(),
        text: text.to_owned(),
        metadata_origin: origin.to_owned(),
        metadata_summary: Some("Reconciled offline edits".to_owned()),
        metadata_correlation_id: Some("foreign-head".to_owned()),
        author_json: None,
        now_ms: 10,
        request_id: None,
        claim_foreign_head,
    };
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let foreign = handle
        .capture_ingest_with_search_policy_blocking(
            input(
                "notes/foreign.md",
                "foreign authoritative body",
                "api",
                true,
            ),
            Arc::clone(&policy),
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
        )
        .expect("seed foreign head");
    assert!(!foreign.moment.before_present);

    let results = handle
        .capture_ingest_batch_blocking(
            vec![
                input("notes/foreign.md", "stale disk body", "capture", false),
                input("notes/new.md", "new sibling body", "capture", false),
            ],
            policy,
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            scratch.path().to_path_buf(),
            Arc::new(ExistingRootGuard),
        )
        .expect("capture added batch around foreign head");
    assert!(matches!(
        &results[0],
        Err(RuntimeError::Domain(
            dohc_engine_domain::DomainError::CaptureNotOwned
        ))
    ));
    assert!(
        results[1]
            .as_ref()
            .is_ok_and(|write| !write.deduped && !write.moment.before_present)
    );
    supervisor.close(&db).expect("close actor");

    let store = EngineStore::open(&db, 100).expect("inspect foreign batch");
    let indexed = store
        .read_with(|conn| {
            conn.prepare(
                "SELECT path,text FROM engine_search_files_fts \
                 WHERE workspace_id=?1 ORDER BY path",
            )?
            .query_map([WORKSPACE_ID], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<(String, String)>>>()
        })
        .expect("read foreign batch FTS");
    assert_eq!(
        indexed,
        vec![
            (
                "notes/foreign.md".to_owned(),
                "foreign authoritative body".to_owned(),
            ),
            ("notes/new.md".to_owned(), "new sibling body".to_owned()),
        ]
    );
}

#[test]
fn capture_batch_storage_before_persist_rolls_back_the_whole_chunk() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    initialize_replicating_workspace(&db);
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let policy = Arc::new(dohc_engine_runtime::search::read_engine_search_policy(
        scratch.path(),
    ));
    let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);

    let error = handle
        .capture_ingest_batch_blocking(
            capture_batch_inputs(),
            Arc::clone(&policy),
            dohc_engine_collab::LeaseRegistry::new(),
            faults.clone(),
            scratch.path().to_path_buf(),
            Arc::new(ExistingRootGuard),
        )
        .expect_err("pre-persist fault reports an uncertain batch");
    assert!(matches!(error, RuntimeError::OperationCrashed));
    assert!(faults.fired());
    supervisor.close(&db).expect("close after rollback");
    assert_eq!(
        capture_batch_state(&db),
        CaptureBatchState {
            storage_rows: 0,
            snapshots: Vec::new(),
            moments: Vec::new(),
            search: Vec::new(),
            outbound: Vec::new(),
        },
        "snapshots, history, FTS, and outbound rows roll back together"
    );

    let handle = supervisor.open(&db, 2).expect("reopen actor").actor;
    let replay = handle
        .capture_ingest_batch_blocking(
            capture_batch_inputs(),
            policy,
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            scratch.path().to_path_buf(),
            Arc::new(ExistingRootGuard),
        )
        .expect("replay rolled-back batch");
    assert!(
        replay
            .iter()
            .all(|result| result.as_ref().is_ok_and(|write| !write.deduped))
    );
    supervisor.close(&db).expect("close after replay");
    assert_eq!(capture_batch_state(&db), expected_capture_batch_state());
}

#[test]
fn capture_batch_storage_after_commit_replays_without_duplicate_side_effects() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    initialize_replicating_workspace(&db);
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let policy = Arc::new(dohc_engine_runtime::search::read_engine_search_policy(
        scratch.path(),
    ));
    let faults = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);

    let error = handle
        .capture_ingest_batch_blocking(
            capture_batch_inputs(),
            Arc::clone(&policy),
            dohc_engine_collab::LeaseRegistry::new(),
            faults.clone(),
            scratch.path().to_path_buf(),
            Arc::new(ExistingRootGuard),
        )
        .expect_err("post-commit fault reports an uncertain batch");
    assert!(matches!(error, RuntimeError::OperationCrashed));
    assert!(faults.fired());
    supervisor.close(&db).expect("close after uncertain commit");
    assert_eq!(
        capture_batch_state(&db),
        expected_capture_batch_state(),
        "the whole batch committed before the acknowledgement was lost"
    );

    let handle = supervisor.open(&db, 2).expect("reopen actor").actor;
    let replay = handle
        .capture_ingest_batch_blocking(
            capture_batch_inputs(),
            policy,
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            scratch.path().to_path_buf(),
            Arc::new(ExistingRootGuard),
        )
        .expect("replay uncertain batch");
    assert!(
        replay
            .iter()
            .all(|result| result.as_ref().is_ok_and(|write| write.deduped))
    );
    supervisor.close(&db).expect("close after replay");
    assert_eq!(
        capture_batch_state(&db),
        expected_capture_batch_state(),
        "replay must not duplicate moments, outbound rows, or FTS entries"
    );
}

#[tokio::test]
async fn async_capture_variants_round_trip_and_honor_precancellation() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;

    let written = handle
        .capture_ingest(
            CaptureIngest {
                workspace_id: "ws-actor-async-capture".to_owned(),
                version_id: "main".to_owned(),
                path: "notes/async.md".to_owned(),
                text: "captured asynchronously".to_owned(),
                metadata_origin: "actor-test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
                request_id: Some("actor-async-capture-request".to_owned()),
                claim_foreign_head: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("async capture");
    assert_eq!(written.snapshot.text, "captured asynchronously");

    let retired = handle
        .capture_retire(
            CaptureRetire {
                workspace_id: "ws-actor-async-capture".to_owned(),
                version_id: "main".to_owned(),
                path: "notes/async.md".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 20,
                request_id: Some("actor-async-retire-request".to_owned()),
                only_if_text_head: false,
                only_if_capture_origin: false,
                allow_ydoc_origin: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("async retire");
    assert!(retired.retired.is_some());

    let retained = handle
        .capture_ingest(
            CaptureIngest {
                workspace_id: "ws-actor-async-capture".to_owned(),
                version_id: "main".to_owned(),
                path: "notes/retained.md".to_owned(),
                text: "must survive cancelled retire".to_owned(),
                metadata_origin: "actor-test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 25,
                request_id: None,
                claim_foreign_head: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture retained path");

    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let error = handle
        .capture_ingest(
            CaptureIngest {
                workspace_id: "ws-actor-async-capture".to_owned(),
                version_id: "main".to_owned(),
                path: "notes/cancelled.md".to_owned(),
                text: "must not be written".to_owned(),
                metadata_origin: "actor-test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 30,
                request_id: None,
                claim_foreign_head: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            cancelled,
        )
        .await
        .expect_err("pre-cancelled capture must fail");
    assert!(matches!(error, RuntimeError::Cancelled));

    let cancelled_read = handle
        .versioned_text_read(
            "ws-actor-async-capture".to_owned(),
            "main".to_owned(),
            "notes/cancelled.md".to_owned(),
            CancellationToken::new(),
        )
        .await
        .expect("read cancelled ingest path");
    assert!(cancelled_read.is_none());

    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let error = handle
        .capture_retire(
            CaptureRetire {
                workspace_id: "ws-actor-async-capture".to_owned(),
                version_id: "main".to_owned(),
                path: "notes/retained.md".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 40,
                request_id: None,
                only_if_text_head: false,
                only_if_capture_origin: false,
                allow_ydoc_origin: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            cancelled,
        )
        .await
        .expect_err("pre-cancelled retire must fail");
    assert!(matches!(error, RuntimeError::Cancelled));

    let retained_read = handle
        .versioned_text_read(
            "ws-actor-async-capture".to_owned(),
            "main".to_owned(),
            "notes/retained.md".to_owned(),
            CancellationToken::new(),
        )
        .await
        .expect("read retained path")
        .expect("retained path must remain present");
    assert_eq!(retained_read, retained.snapshot);

    supervisor.close(&db).expect("close actor");

    let store = EngineStore::open(&db, 50).expect("reopen store");
    let (cancelled_snapshots, cancelled_moments, retained_snapshots, retained_moments): (
        i64,
        i64,
        i64,
        i64,
    ) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id = ?1 \
                     AND version_id = ?2 AND path = ?3",
                    ["ws-actor-async-capture", "main", "notes/cancelled.md"],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id = ?1 \
                     AND version_id = ?2 AND path = ?3",
                    ["ws-actor-async-capture", "main", "notes/cancelled.md"],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id = ?1 \
                     AND version_id = ?2 AND path = ?3",
                    ["ws-actor-async-capture", "main", "notes/retained.md"],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id = ?1 \
                     AND version_id = ?2 AND path = ?3",
                    ["ws-actor-async-capture", "main", "notes/retained.md"],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("capture persistence counts");
    assert_eq!((cancelled_snapshots, cancelled_moments), (0, 0));
    assert_eq!((retained_snapshots, retained_moments), (1, 1));
}

#[tokio::test]
async fn binary_capture_round_trips_through_the_actor_both_ways() {
    use dohc_engine_runtime::CaptureIngestBinary;

    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let input = |bytes: &[u8], now_ms: i64| CaptureIngestBinary {
        workspace_id: "ws-actor-capture-bin".to_owned(),
        version_id: "main".to_owned(),
        path: "photo.png".to_owned(),
        bytes: bytes.to_vec(),
        metadata_origin: "actor-test".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
        claim_foreign_head: true,
    };

    let written = handle
        .capture_ingest_binary(
            input(&[0xff, 0x00], 10),
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("async binary capture");
    assert!(!written.deduped);

    // Content-equality dedupe through the actor (the blocking variant is
    // exercised end-to-end by the capture-sink tests, which run outside a
    // tokio runtime as the real reconcile driver will).
    let deduped = handle
        .capture_ingest_binary(
            input(&[0xff, 0x00], 20),
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("equal binary capture");
    assert!(deduped.deduped);
    assert_eq!(deduped.moment_order, written.moment_order);

    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let err = handle
        .capture_ingest_binary(
            input(&[1], 30),
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            cancelled,
        )
        .await
        .expect_err("pre-cancelled binary capture is refused");
    assert!(matches!(err, RuntimeError::Cancelled));

    supervisor.close(&db).expect("close actor");
}

#[tokio::test]
async fn live_lease_blocks_text_and_binary_capture_without_mutation_until_retry() {
    use dohc_engine_runtime::CaptureIngestBinary;

    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let workspace_id = "ws-live-capture";
    let path = "notes/live.md";
    let object_id = dohc_engine_domain::derive_capture_object_id(workspace_id, "main", path);
    let key = dohc_engine_collab::DocKey::new(workspace_id, "main", &object_id)
        .expect("capture Y.Doc key");
    let leases = dohc_engine_collab::LeaseRegistry::new();
    let state = || {
        let store = EngineStore::open(&db, 100).expect("inspect capture state");
        store
            .read_with(|conn| {
                let count = |table: &str| -> rusqlite::Result<i64> {
                    conn.query_row(
                        &format!("SELECT COUNT(*) FROM {table} WHERE workspace_id=?1"),
                        [workspace_id],
                        |row| row.get(0),
                    )
                };
                let request_count =
                    conn.query_row("SELECT COUNT(*) FROM engine_requests", [], |row| {
                        row.get::<_, i64>(0)
                    })?;
                Ok::<_, rusqlite::Error>((
                    count("snapshots")?,
                    count("moments")?,
                    count("replication_log")?,
                    count("engine_search_files_fts")?,
                    count("materialization_jobs")?,
                    count("ydoc_docs")?,
                    count("ydoc_updates")?,
                    count("ydoc_snapshots")?,
                    count("ydoc_deferred_updates")?,
                    request_count,
                ))
            })
            .expect("capture state")
    };
    let durable_state = || {
        let store = EngineStore::open(&db, 100).expect("inspect exact capture state");
        store
            .read_with(|conn| {
                let rows = |table: &str, workspace_scoped: bool| {
                    let sql = if workspace_scoped {
                        format!("SELECT * FROM {table} WHERE workspace_id=?1 ORDER BY rowid")
                    } else {
                        format!("SELECT * FROM {table} ORDER BY rowid")
                    };
                    let mut statement = conn.prepare(&sql)?;
                    let column_count = statement.column_count();
                    let mut query = if workspace_scoped {
                        statement.query([workspace_id])?
                    } else {
                        statement.query([])?
                    };
                    let mut result = Vec::new();
                    while let Some(row) = query.next()? {
                        let mut values = Vec::with_capacity(column_count);
                        for column in 0..column_count {
                            let value = match row.get_ref(column)? {
                                rusqlite::types::ValueRef::Null => "null".to_owned(),
                                rusqlite::types::ValueRef::Integer(value) => {
                                    format!("integer:{value}")
                                }
                                rusqlite::types::ValueRef::Real(value) => {
                                    format!("real:{value}")
                                }
                                rusqlite::types::ValueRef::Text(value) => {
                                    format!("text:{}", String::from_utf8_lossy(value))
                                }
                                rusqlite::types::ValueRef::Blob(value) => {
                                    format!("blob:{value:?}")
                                }
                            };
                            values.push(value);
                        }
                        result.push(values);
                    }
                    Ok::<_, rusqlite::Error>(result)
                };
                [
                    ("file_objects", true),
                    ("path_aliases", true),
                    ("blobs", false),
                    ("binary_blobs", false),
                    ("snapshots", true),
                    ("moments", true),
                    ("replication_log", true),
                    ("engine_search_files_fts", true),
                    ("materialization_jobs", true),
                    ("engine_requests", false),
                    ("ydoc_docs", true),
                    ("ydoc_updates", true),
                    ("ydoc_snapshots", true),
                    ("ydoc_deferred_updates", true),
                ]
                .into_iter()
                .map(|(table, scoped)| Ok((table, rows(table, scoped)?)))
                .collect::<rusqlite::Result<Vec<_>>>()
            })
            .expect("exact capture state")
    };
    let text_input = |request_id: &str| CaptureIngest {
        workspace_id: workspace_id.to_owned(),
        version_id: "main".to_owned(),
        path: path.to_owned(),
        text: "captured text".to_owned(),
        metadata_origin: "capture".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 10,
        request_id: Some(request_id.to_owned()),
        claim_foreign_head: true,
    };
    let binary_input = |request_id: &str| CaptureIngestBinary {
        workspace_id: workspace_id.to_owned(),
        version_id: "main".to_owned(),
        path: path.to_owned(),
        bytes: b"binary replacement".to_vec(),
        metadata_origin: "capture".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 20,
        request_id: Some(request_id.to_owned()),
        claim_foreign_head: true,
    };
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;

    let text_lease = leases.acquire(&key).expect("hold absent text path live");
    let before_text = durable_state();
    let refused = handle
        .capture_ingest_indexed(
            text_input("text-capture"),
            scratch.path().to_path_buf(),
            leases.clone(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect_err("live lease must block text capture");
    assert!(matches!(
        refused,
        RuntimeError::Sync(dohc_engine_sync::SyncError::RetryableState { reason })
            if reason == dohc_engine_runtime::CAPTURE_NEW_FILE_LIVE
    ));
    assert_eq!(state(), (0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
    assert_eq!(durable_state(), before_text);
    drop(text_lease);
    handle
        .capture_ingest_indexed(
            text_input("text-capture"),
            scratch.path().to_path_buf(),
            leases.clone(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("text capture retries after lease release");
    let after_text = state();
    assert_eq!(after_text, (1, 1, 0, 1, 0, 0, 0, 0, 0, 1));

    let text_lease = leases.acquire(&key).expect("hold recorded text head live");
    let before_text_replay = durable_state();
    let replay = handle
        .capture_ingest_indexed(
            text_input("text-capture"),
            scratch.path().to_path_buf(),
            leases.clone(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("a committed text request replays while its lease is live");
    assert!(replay.deduped);
    assert_eq!(state(), after_text);
    assert_eq!(durable_state(), before_text_replay);
    let refused = handle
        .capture_ingest_indexed(
            text_input("text-new"),
            scratch.path().to_path_buf(),
            leases.clone(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect_err("a new equal-text request must not bypass the live lease");
    assert!(matches!(
        refused,
        RuntimeError::Sync(dohc_engine_sync::SyncError::RetryableState {
            reason: "ydoc-session-live"
        })
    ));
    assert_eq!(state(), after_text);
    assert_eq!(durable_state(), before_text_replay);
    drop(text_lease);

    let binary_lease = leases.acquire(&key).expect("hold text head live");
    let before_binary = durable_state();
    let refused = handle
        .capture_ingest_binary(
            binary_input("binary-capture"),
            leases.clone(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect_err("live lease must block binary capture");
    assert!(matches!(
        refused,
        RuntimeError::Sync(dohc_engine_sync::SyncError::RetryableState {
            reason: "ydoc-session-live"
        })
    ));
    assert_eq!(state(), after_text);
    assert_eq!(durable_state(), before_binary);
    drop(binary_lease);
    handle
        .capture_ingest_binary(
            binary_input("binary-capture"),
            leases.clone(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("binary capture retries after lease release");
    let after_binary = state();
    assert_eq!(after_binary, (1, 2, 0, 0, 1, 0, 0, 0, 0, 2));

    let binary_lease = leases
        .acquire(&key)
        .expect("hold recorded binary head live");
    let before_binary_replay = durable_state();
    let replay = handle
        .capture_ingest_binary(
            binary_input("binary-capture"),
            leases.clone(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("a committed binary request replays while its lease is live");
    assert!(replay.deduped);
    assert_eq!(state(), after_binary);
    assert_eq!(durable_state(), before_binary_replay);
    let refused = handle
        .capture_ingest_binary(
            binary_input("binary-new"),
            leases,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect_err("a new equal-binary request must not bypass the live lease");
    assert!(matches!(
        refused,
        RuntimeError::Sync(dohc_engine_sync::SyncError::RetryableState {
            reason: "ydoc-session-live"
        })
    ));
    assert_eq!(state(), after_binary);
    assert_eq!(durable_state(), before_binary_replay);
    drop(binary_lease);

    supervisor.close(&db).expect("close actor");
}

/// A capture that saw a path missing asks the actor to confirm it. The
/// materializer runs on the actor's thread, so a replace caught between its
/// two renames is finished by then and the retire is refused.
#[test]
fn an_absence_retire_is_refused_while_the_file_is_on_disk_or_displaced() {
    const WORKSPACE_ID: &str = "ws-absence-retire";
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let retire = || CaptureRetire {
        workspace_id: WORKSPACE_ID.to_owned(),
        version_id: "main".to_owned(),
        path: "notes/a.md".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        now_ms: 20,
        request_id: None,
        only_if_text_head: false,
        only_if_capture_origin: false,
        allow_ydoc_origin: true,
    };
    let retire_absent = |handle: &dohc_engine_runtime::ActorHandle| {
        handle.capture_retire_materialized_blocking_guarded(
            retire(),
            scratch.path().to_path_buf(),
            true,
            Arc::new(()),
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            Arc::new(ExistingRootGuard),
        )
    };
    let refused = |result: Result<_, RuntimeError>| {
        matches!(
            result,
            Err(RuntimeError::Sync(
                dohc_engine_sync::SyncError::RetryableState { .. }
            ))
        )
    };

    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    handle
        .capture_ingest_blocking(
            CaptureIngest {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: "main".to_owned(),
                path: "notes/a.md".to_owned(),
                text: "captured".to_owned(),
                metadata_origin: "capture".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
                request_id: None,
                claim_foreign_head: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
        )
        .expect("capture");
    std::fs::create_dir_all(scratch.path().join("notes")).expect("notes dir");
    std::fs::write(scratch.path().join("notes/a.md"), "captured").expect("file on disk");
    assert!(
        refused(retire_absent(&handle)),
        "a file on disk is not a delete"
    );
    supervisor.close(&db).expect("close actor");

    // A replace staged the target and could not put it back: the file sits
    // in staging, under the name that spells job `job`, with the target name
    // empty.
    let staging = scratch.path().join(".dohc/engine/displaced");
    std::fs::create_dir_all(&staging).expect("staging dir");
    std::fs::rename(scratch.path().join("notes/a.md"), staging.join("6a6f62.0"))
        .expect("empty the name");
    let store = EngineStore::open(&db, 15).expect("store");
    store.put_binary_blob(b"ours").expect("job content");
    store
        .open_displacement(&dohc_engine_storage::DisplacementSpec {
            job_id: "job".to_owned(),
            workspace_id: WORKSPACE_ID.to_owned(),
            target_path: "notes/a.md".to_owned(),
            displaced_name: "6a6f62.0".to_owned(),
            expected_sha256: dohc_engine_storage::hex_sha256(b"captured"),
            content_sha256: Some(dohc_engine_storage::hex_sha256(b"ours")),
            now_ms: 15,
        })
        .expect("open displacement");
    drop(store);
    let handle = supervisor.open(&db, 16).expect("reopen actor").actor;
    assert!(
        refused(retire_absent(&handle)),
        "a path an unfinished replace moved aside is not a delete"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes/a.md")).expect("returned"),
        "captured",
        "the refused confirmation put the displaced file back"
    );
    assert!(!staging.join("6a6f62.0").exists());
    supervisor.close(&db).expect("close actor");

    std::fs::remove_file(scratch.path().join("notes/a.md")).expect("a real delete");
    let handle = supervisor.open(&db, 18).expect("reopen actor").actor;
    let retired = retire_absent(&handle).expect("a confirmed absence retires");
    assert!(retired.retired.is_some(), "the head was intact until now");
    supervisor.close(&db).expect("close actor");
}
