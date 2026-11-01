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
    tokio::task::spawn_blocking(move || supervisor.close_all())
        .await
        .unwrap()?;
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
async fn duplicate_undo_before_create_placement_cancels_copy_without_conflict() {
    let (root, mut store) = fixture();
    seed(&mut store, root.path(), "source.md", "source", "Original");
    // This actor has no placement driver. The create stays pending until Undo.
    let copy = duplicate(&mut store, root.path(), Arc::new(NoFaults))
        .await
        .unwrap();
    let jobs = |store: &EngineStore| -> Vec<(String, String)> {
        store.read_with(|conn| {
            conn.prepare("SELECT operation,status FROM materialization_jobs WHERE workspace_id=?1 AND target_path='copy.md' ORDER BY target_generation")?
                .query_map([WS], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<_, _>>()
        }).unwrap()
    };
    assert_eq!(jobs(&store), vec![("write".into(), "pending".into())]);
    assert!(!root.path().join("copy.md").exists());
    let undone = undo_copy(&mut store, root.path(), Arc::new(NoFaults)).unwrap();
    assert!(undone.materialized);
    assert!(undone.not_restored.is_empty());
    assert_eq!(undone.moments.len(), 1);
    assert_eq!(undone.moments[0].object_id, copy.moments[0].object_id);
    assert_eq!(undone.moments[0].operation, "delete");
    assert!(
        VersionedTextStore::new(&mut store)
            .read_text(WS, "main", "copy.md")
            .unwrap()
            .is_none()
    );
    assert!(!root.path().join("copy.md").exists());
    let settled = vec![
        ("write".into(), "cancelled".into()),
        ("delete".into(), "complete".into()),
    ];
    assert_eq!(jobs(&store), settled);
    let preimage: (bool, Option<String>) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT preimage_present,preimage_sha256 FROM materialization_jobs WHERE workspace_id=?1 AND target_path='copy.md' AND operation='delete'",
                [WS],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!(preimage, (false, None));
    let replay = undo_copy(&mut store, root.path(), Arc::new(NoFaults)).unwrap();
    assert!(replay.deduped && replay.materialized);
    assert_eq!(replay.moments, undone.moments);
    // Startup replay must never publish the cancelled create.
    let db = store.database_path().to_path_buf();
    drop(store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 12).unwrap().actor;
    assert_eq!(
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            actor.materialize_replay_pending_counting(
                root.path().to_path_buf(),
                WS.into(),
                12,
                None
            )
        )
        .await
        .expect("startup replay of cancelled Duplicate did not finish")
        .unwrap(),
        0
    );
    tokio::task::spawn_blocking(move || supervisor.close_all())
        .await
        .unwrap()
        .unwrap();
    let store = EngineStore::open(&db, 13).unwrap();
    assert!(!root.path().join("copy.md").exists());
    assert_eq!(jobs(&store), settled);
    assert_eq!(
        std::fs::read_to_string(root.path().join("source.md")).unwrap(),
        "Original"
    );
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
    let summary: String = store
        .read_with(|c| {
            c.query_row(
                "SELECT metadata_summary FROM moments WHERE moment_id=?1",
                [&copy.moments[0].moment_id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(summary, "Duplicated source.md");
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
    let db = engine_db_path(&root).unwrap();
    drop(store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 6).unwrap().actor;
    // The workspace.open startup path: no capture hold and no Duplicate retry.
    assert_eq!(
        actor
            .materialize_replay_pending_counting(root.path().to_path_buf(), WS.into(), 6, None)
            .await
            .unwrap(),
        1
    );
    tokio::task::spawn_blocking(move || supervisor.close_all())
        .await
        .unwrap()
        .unwrap();
    let mut store = EngineStore::open(&db, 7).unwrap();
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
    dohc_engine_collab::ensure_marker(
        &mut store,
        &source.key,
        source.content_kind,
        source.regime,
        &NoFaults,
        3,
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
    assert!(!opened.lineage_existing);
    assert_eq!(opened.seed_content.as_deref(), Some("Original"));
    let authors: Option<String> = store
        .read_with(|c| {
            c.query_row(
                "SELECT pending_authors_json FROM ydoc_docs WHERE object_id=?1",
                [&id],
                |r| r.get(0),
            )
            .optional()
        })
        .unwrap();
    assert_eq!(authors, None);
}
#[tokio::test]
async fn duplicate_undo_replays_across_authors_with_first_attribution() {
    let (root, mut store) = fixture();
    seed(&mut store, root.path(), "source.md", "source", "Original");
    let copy = duplicate(&mut store, root.path(), Arc::new(NoFaults))
        .await
        .unwrap();
    place(&mut store, root.path(), &copy);
    let first_author = r#"[{"kind":"human","humanId":"person"}]"#;
    let second_author = r#"[{"kind":"agent","agentId":"agent","onBehalfOf":"person"}]"#;
    store
        .read_with(|conn| {
            let fingerprint = |operation, author| {
                dohc_engine_domain::undo_request_fingerprint(conn, WS, operation, Some(author))
                    .unwrap()
            };
            assert_eq!(
                fingerprint(OP, first_author),
                fingerprint(OP, second_author)
            );
            assert_ne!(
                fingerprint("dohc-operation:other", first_author),
                fingerprint("dohc-operation:other", second_author)
            );
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    let first = test_undo_in_turns(
        &mut store,
        WS,
        OP,
        "undo-copy",
        Some(first_author),
        root.path(),
        Arc::new(NoFaults),
        10,
    )
    .unwrap();
    let replay = test_undo_in_turns(
        &mut store,
        WS,
        OP,
        "undo-copy",
        Some(second_author),
        root.path(),
        Arc::new(NoFaults),
        11,
    )
    .unwrap();
    assert!(replay.deduped && replay.materialized);
    assert_eq!(first.moments, replay.moments);
    let author: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT author_json FROM moments WHERE moment_id=?1",
                [&first.moments[0].moment_id],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(author, first_author);
}

#[tokio::test]
async fn duplicate_live_bound_copy_undo_refusal_names_the_copy() {
    let (root, mut store) = fixture();
    seed(&mut store, root.path(), "source.md", "source", "Original");
    let copy = duplicate(&mut store, root.path(), Arc::new(NoFaults))
        .await
        .unwrap();
    place(&mut store, root.path(), &copy);
    let claim = store.put_binary_blob(b"lineage").unwrap();
    let digest = dohc_engine_storage::hex_sha256(b"Original");
    // The adoption and the activation it makes current.
    store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO live_owner_adoptions(relay_database_namespace,adoption_id,workspace_id,main_version_id,object_id,lineage_claim_id,binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,max_pending_bytes,max_pending_age_ms) VALUES('relay','adoption',?1,'main',?2,?4,'{\"currentPath\":\"copy.md\"}',?3,?5,8,0,0,'evidence','coverage',0,0,0,'{}','{}',100,100)", params![WS,copy.moments[0].object_id,copy.moments[0].moment_id,claim,digest]).map_err(StorageError::persist_public)?;
        tx.execute("INSERT INTO live_owner_activations(relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,origin_adoption_id,binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,host_coordinate_json,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,max_pending_bytes,max_pending_age_ms) SELECT relay_database_namespace,adoption_id,workspace_id,main_version_id,object_id,lineage_claim_id,adoption_id,binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,host_coordinate_json,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,max_pending_bytes,max_pending_age_ms FROM live_owner_adoptions", []).map_err(StorageError::persist_public)
    }).unwrap();
    let error = undo_copy(&mut store, root.path(), Arc::new(NoFaults)).unwrap_err();
    assert!(
        matches!(error, RuntimeError::Domain(DomainError::UndoRefused {ref path,reason:"This copy is a shared live file. Continue editing at its current location"}) if path == "copy.md"),
        "{error:?}"
    );
}
