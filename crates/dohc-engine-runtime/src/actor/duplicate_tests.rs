use super::tests::{OP, WS, fixture, rename, seed};
use super::*;
use dohc_engine_storage::{FaultAction, FaultPoint, NoFaults};
use dohc_engine_testkit::engine_db_path;

fn input(op: &str) -> dohc_engine_domain::DuplicateFile {
    dohc_engine_domain::DuplicateFile {
        workspace_id: WS.into(),
        version_id: "main".into(),
        from_path: "source.md".into(),
        to_path: "copy.md".into(),
        operation_id: op.into(),
        author_json: None,
        now_ms: 5,
    }
}
async fn duplicate(
    store: &mut EngineStore,
    root: &Path,
    faults: Arc<dyn FaultInjector>,
) -> Result<HistoryOperation, RuntimeError> {
    let db = store.database_path().to_path_buf();
    let reader = EngineStore::open_read_only(&db)?;
    drop(std::mem::replace(store, reader));
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 5)?.actor;
    let result = actor
        .duplicate_file(input(OP), root.to_path_buf(), faults)
        .await;
    supervisor.close_all()?;
    *store = EngineStore::open(&db, 5)?;
    result
}
fn place(store: &mut EngineStore, root: &Path, result: &HistoryOperation) {
    assert!(
        place_undo_members(store, WS, "main", &result.moments, root, &(), &NoFaults, 6).unwrap()
    );
}
fn undo_copy(
    store: &mut EngineStore,
    root: &Path,
    faults: Arc<dyn FaultInjector>,
) -> Result<HistoryUndoResult, RuntimeError> {
    test_undo_in_turns(store, WS, OP, "undo-copy", None, root, faults, 10)
}
#[tokio::test]
async fn duplicate_source_edit_undo_and_same_request_replay() {
    let (root, mut store) = fixture();
    seed(&mut store, root.path(), "source.md", "source", "Original");
    let copy = duplicate(&mut store, root.path(), Arc::new(NoFaults))
        .await
        .unwrap();
    assert_ne!(copy.moments[0].object_id, "source");
    place(&mut store, root.path(), &copy);
    seed(
        &mut store,
        root.path(),
        "source.md",
        "source-edit",
        "Changed source",
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("copy.md")).unwrap(),
        "Original"
    );
    let source_moment: String = store
        .read_with(|c| {
            c.query_row(
                "SELECT metadata_summary FROM moments WHERE moment_id=?1",
                [&copy.moments[0].moment_id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(source_moment.contains("source"));
    let undone = undo_copy(&mut store, root.path(), Arc::new(NoFaults)).unwrap();
    assert!(undone.materialized);
    assert!(!root.path().join("copy.md").exists());
    let replay = undo_copy(&mut store, root.path(), Arc::new(NoFaults)).unwrap();
    assert!(replay.deduped && replay.materialized);
    assert_eq!(replay.moments, undone.moments);
    // An old Duplicate reply must never resurrect the copy.
    duplicate(&mut store, root.path(), Arc::new(NoFaults))
        .await
        .unwrap();
    assert!(!root.path().join("copy.md").exists());
}
#[tokio::test]
async fn duplicate_refuses_undo_after_edit_move_replacement_or_disk_edit() {
    for change in ["edit", "move", "replace", "disk"] {
        let (root, mut store) = fixture();
        seed(&mut store, root.path(), "source.md", "source", "Original");
        let copy = duplicate(&mut store, root.path(), Arc::new(NoFaults))
            .await
            .unwrap();
        place(&mut store, root.path(), &copy);
        match change {
            "edit" => seed(&mut store, root.path(), "copy.md", "edit", "New copy"),
            "move" => rename(
                &mut store,
                root.path(),
                "copy.md",
                "moved.md",
                "move",
                "dohc-operation:later",
            ),
            "replace" => {
                super::tests::remove(&mut store, root.path(), "copy.md", "delete-copy");
                seed(
                    &mut store,
                    root.path(),
                    "copy.md",
                    "replacement",
                    "Replacement",
                );
            }
            _ => std::fs::write(root.path().join("copy.md"), "External edit").unwrap(),
        }
        let error = undo_copy(&mut store, root.path(), Arc::new(NoFaults)).unwrap_err();
        assert!(
            matches!(error, RuntimeError::Domain(DomainError::UndoRefused { ref path, .. }) if path == "copy.md"),
            "{change}: {error:?}"
        );
        assert!(
            root.path()
                .join(if change == "move" {
                    "moved.md"
                } else {
                    "copy.md"
                })
                .exists()
        );
    }
}
struct CrashAfterCommit;
impl FaultInjector for CrashAfterCommit {
    fn poll(&self, p: FaultPoint) -> FaultAction {
        if p == FaultPoint::StorageAfterCommitBeforeAck {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}
#[tokio::test]
async fn duplicate_commit_crash_restart_replays_placement_and_undo_plan() {
    let (root, mut store) = fixture();
    seed(&mut store, root.path(), "source.md", "source", "Original");
    assert!(matches!(
        duplicate(&mut store, root.path(), Arc::new(CrashAfterCommit)).await,
        Err(RuntimeError::OperationCrashed)
    ));
    assert!(!root.path().join("copy.md").exists());
    let replay = duplicate(&mut store, root.path(), Arc::new(NoFaults))
        .await
        .unwrap();
    place(&mut store, root.path(), &replay);
    assert_eq!(
        std::fs::read_to_string(root.path().join("copy.md")).unwrap(),
        "Original"
    );
    assert!(undo_copy(&mut store, root.path(), Arc::new(CrashAfterCommit)).is_err());
    let db = engine_db_path(&root).unwrap();
    drop(store);
    let mut store = EngineStore::open(&db, 12).unwrap();
    let result = undo_copy(&mut store, root.path(), Arc::new(NoFaults)).unwrap();
    assert!(result.materialized);
    assert!(!root.path().join("copy.md").exists());
    assert!(
        undo_copy(&mut store, root.path(), Arc::new(NoFaults))
            .unwrap()
            .deduped
    );
}
#[tokio::test]
async fn duplicate_fresh_lazy_document_has_no_source_authorship() {
    let (root, mut store) = fixture();
    seed(&mut store, root.path(), "source.md", "source", "Original");
    let mut cache = dohc_engine_collab::WriterDocCache::default();
    let source = super::super::ydoc::ydoc_open_state_on_store(
        &mut store,
        &mut cache,
        WS,
        3,
        true,
        None,
        "main",
        "source.md",
        None,
        true,
        &crate::CancellationToken::new(),
    )
    .unwrap();
    store.write_with(&NoFaults, |tx| tx.execute(r#"UPDATE ydoc_docs SET pending_authors_json='[{"kind":"human","humanId":"source-author"}]' WHERE object_id=?1"#, [&source.key.object_id]).map_err(StorageError::persist_public)).unwrap();
    let copy = duplicate(&mut store, root.path(), Arc::new(NoFaults))
        .await
        .unwrap();
    let id = copy.moments[0].object_id.clone();
    let n: i64 = store
        .read_with(|c| {
            c.query_row(
                "SELECT count(*) FROM ydoc_docs WHERE object_id=?1",
                [&id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(n, 0, "Duplicate leaves the new document lazy");
    let opened = super::super::ydoc::ydoc_open_state_on_store(
        &mut store,
        &mut cache,
        WS,
        7,
        true,
        None,
        "main",
        "copy.md",
        None,
        true,
        &crate::CancellationToken::new(),
    )
    .unwrap();
    assert_ne!(opened.key, source.key);
    let authors: String = store
        .read_with(|c| {
            c.query_row(
                "SELECT pending_authors_json FROM ydoc_docs WHERE object_id=?1",
                [&id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(authors, "[]");
}
#[tokio::test]
async fn duplicate_one_file_commit_timing() {
    let mut samples = vec![];
    for _ in 0..20 {
        let (root, mut store) = fixture();
        seed(
            &mut store,
            root.path(),
            "source.md",
            "source",
            &"content".repeat(10000),
        );
        let db = store.database_path().to_path_buf();
        drop(store);
        let supervisor = crate::WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 5).unwrap().actor;
        let started = std::time::Instant::now();
        actor
            .duplicate_file(input(OP), root.path().to_path_buf(), Arc::new(NoFaults))
            .await
            .unwrap();
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
        supervisor.close_all().unwrap();
    }
    samples.sort_by(f64::total_cmp);
    println!(
        "DUPLICATE_COMMIT_TIMING files=1 samples=20 p50_ms={:.3} p95_ms={:.3} includes=actor,transaction,index,journal excludes=materialization",
        samples[9], samples[18]
    );
}
