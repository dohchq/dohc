use dohc_engine_domain::{DeleteTextFile, RenameTextFile, VersionedTextStore, WriteText};
use dohc_engine_runtime::{CancellationToken, NoFaults, WorkspaceSupervisor};
use dohc_engine_storage::EngineStore;
use dohc_engine_sync::MomentMaterializationChange;
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::sync::Arc;

fn write(text: &str, moment: &str, now_ms: i64) -> WriteText {
    WriteText {
        workspace_id: "workspace".into(),
        version_id: "main".into(),
        object_id: "object".into(),
        path: "file.md".into(),
        text: text.into(),
        moment_id: moment.into(),
        metadata_origin: "sync".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn earlier_page_write_materializes_the_current_deletion_before_cursor_commit() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        let mut domain = VersionedTextStore::new(&mut store);
        domain
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        domain
            .write_text(&write("old", "write", 1), &NoFaults)
            .unwrap();
        domain
            .set_active_version("workspace", "main", &NoFaults)
            .unwrap();
        domain
            .delete_text_file(
                &DeleteTextFile {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    path: "file.md".into(),
                    moment_id: "delete".into(),
                    request_id: None,
                    metadata_origin: "sync".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                },
                &NoFaults,
            )
            .unwrap();
    }
    std::fs::write(scratch.path().join("file.md"), "old").unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    let page = vec![MomentMaterializationChange {
        version_id: "main".into(),
        path: "file.md".into(),
        operation: "write",
        content_kind: "text",
    }];
    for now in [4, 5] {
        actor
            .materialize_relay_page(
                "workspace".into(),
                scratch.path().to_path_buf(),
                page.clone(),
                Arc::new(()),
                now,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(!scratch.path().join("file.md").exists());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn earlier_page_delete_materializes_the_current_write_instead_of_erasing_it() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        let mut domain = VersionedTextStore::new(&mut store);
        domain
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        // The disk holds an earlier head, so the store has its bytes and the
        // write may replace them.
        domain
            .write_text(&write("old", "earlier", 1), &NoFaults)
            .unwrap();
        domain
            .write_text(&write("new head", "recreated", 2), &NoFaults)
            .unwrap();
        domain
            .set_active_version("workspace", "main", &NoFaults)
            .unwrap();
    }
    std::fs::write(scratch.path().join("file.md"), "old").unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    let page = vec![MomentMaterializationChange {
        version_id: "main".into(),
        path: "file.md".into(),
        operation: "delete",
        content_kind: "text",
    }];
    actor
        .materialize_relay_page(
            "workspace".into(),
            scratch.path().to_path_buf(),
            page,
            Arc::new(()),
            4,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("file.md")).unwrap(),
        "new head"
    );
}

fn write_at(path: &str, object: &str, text: &str, moment: &str, now_ms: i64) -> WriteText {
    WriteText {
        path: path.into(),
        object_id: object.into(),
        ..write(text, moment, now_ms)
    }
}

fn delete_at(path: &str, moment: &str, now_ms: i64) -> DeleteTextFile {
    DeleteTextFile {
        workspace_id: "workspace".into(),
        version_id: "main".into(),
        path: path.into(),
        moment_id: moment.into(),
        request_id: None,
        metadata_origin: "sync".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
    }
}

fn change(path: &str, operation: &'static str) -> MomentMaterializationChange {
    MomentMaterializationChange {
        version_id: "main".into(),
        path: path.into(),
        operation,
        content_kind: "text",
    }
}

/// Apply `moments` to a fresh store, lay `disk` out, and materialize `page`.
async fn materialize_page(
    moments: impl FnOnce(&mut VersionedTextStore<'_>),
    disk: impl FnOnce(&std::path::Path),
    page: Vec<MomentMaterializationChange>,
) -> ScratchDir {
    materialize_pages(moments, disk, vec![page]).await
}

async fn materialize_pages(
    moments: impl FnOnce(&mut VersionedTextStore<'_>),
    disk: impl FnOnce(&std::path::Path),
    pages: Vec<Vec<MomentMaterializationChange>>,
) -> ScratchDir {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        let mut domain = VersionedTextStore::new(&mut store);
        domain
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        moments(&mut domain);
        domain
            .set_active_version("workspace", "main", &NoFaults)
            .unwrap();
    }
    disk(scratch.path());
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 10).unwrap().actor;
    for page in pages {
        actor
            .materialize_relay_page(
                "workspace".into(),
                scratch.path().to_path_buf(),
                page,
                Arc::new(()),
                11,
                CancellationToken::new(),
            )
            .await
            .expect("the page materializes");
    }
    supervisor.close(&db).expect("close actor");
    assert!(
        EngineStore::open(&db, 12)
            .unwrap()
            .list_pending_materialization_jobs()
            .unwrap()
            .is_empty()
    );
    scratch
}

/// One page turns the file `notes` into a directory holding `work.md`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_page_turns_a_file_into_a_directory() {
    let scratch = materialize_page(
        |domain| {
            domain
                .write_text(&write_at("notes", "o-notes", "old", "m1", 1), &NoFaults)
                .unwrap();
            domain
                .delete_text_file(&delete_at("notes", "m2", 2), &NoFaults)
                .unwrap();
            domain
                .write_text(
                    &write_at("notes/work.md", "o-work", "work", "m3", 3),
                    &NoFaults,
                )
                .unwrap();
        },
        |root| std::fs::write(root.join("notes"), "old").unwrap(),
        vec![change("notes/work.md", "write"), change("notes", "delete")],
    )
    .await;
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes").join("work.md")).unwrap(),
        "work"
    );
}

/// One page turns the directory `d` into a file, after deleting its only
/// tracked file.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_page_turns_a_directory_into_a_file() {
    let scratch = materialize_page(
        |domain| {
            domain
                .write_text(&write_at("d/sub/a.md", "o-a", "a", "m1", 1), &NoFaults)
                .unwrap();
            domain
                .delete_text_file(&delete_at("d/sub/a.md", "m2", 2), &NoFaults)
                .unwrap();
            domain
                .write_text(&write_at("d", "o-d", "file d", "m3", 3), &NoFaults)
                .unwrap();
        },
        |root| {
            std::fs::create_dir_all(root.join("d/sub")).unwrap();
            std::fs::write(root.join("d/sub/a.md"), "a").unwrap();
        },
        vec![change("d", "write"), change("d/sub/a.md", "delete")],
    )
    .await;
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("d")).unwrap(),
        "file d"
    );
}

async fn descendant_aliases_precede_directory_replacement(same_case: bool, reverse: bool) {
    let mut page = vec![
        change(if same_case { "d/a.md" } else { "d/A.md" }, "write"),
        change("d/a.md", "delete"),
        change("d", "write"),
    ];
    if reverse {
        page.reverse();
    }
    let scratch = materialize_page(
        |domain| {
            domain
                .write_text(&write_at("d/a.md", "o-a", "a", "m1", 1), &NoFaults)
                .unwrap();
            domain
                .delete_text_file(&delete_at("d/a.md", "m2", 2), &NoFaults)
                .unwrap();
            domain
                .write_text(&write_at("d", "o-d", "file d", "m3", 3), &NoFaults)
                .unwrap();
        },
        |root| {
            std::fs::create_dir(root.join("d")).unwrap();
            std::fs::write(root.join("d/a.md"), "a").unwrap();
        },
        page,
    )
    .await;
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("d")).unwrap(),
        "file d"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn descendant_alias_write_then_delete_precedes_directory_replacement() {
    descendant_aliases_precede_directory_replacement(false, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn descendant_alias_delete_then_write_precedes_directory_replacement() {
    descendant_aliases_precede_directory_replacement(false, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn descendant_same_case_write_then_delete_precedes_directory_replacement() {
    descendant_aliases_precede_directory_replacement(true, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn descendant_same_case_delete_then_write_precedes_directory_replacement() {
    descendant_aliases_precede_directory_replacement(true, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn differently_cased_ancestor_waits_for_descendant_write() {
    for sequential in [true, false] {
        let scratch = ScratchDir::new().unwrap();
        std::fs::create_dir(scratch.path().join("d")).unwrap();
        std::fs::write(scratch.path().join("d/a.md"), "old").unwrap();
        if !scratch.path().join("D/a.md").exists() {
            return; // This dependency exists only on a case-insensitive filesystem.
        }
        let db = engine_db_path(&scratch).unwrap();
        {
            let mut store = EngineStore::open(&db, 1).unwrap();
            let mut domain = VersionedTextStore::new(&mut store);
            domain
                .ensure_main_version("workspace", "main", 0, &NoFaults)
                .unwrap();
            domain
                .write_text(&write_at("d/a.md", "o-a", "old", "m1", 1), &NoFaults)
                .unwrap();
            domain
                .rename_text_file(
                    &RenameTextFile {
                        workspace_id: "workspace".into(),
                        version_id: "main".into(),
                        from_path: "d/a.md".into(),
                        to_path: "D/a.md".into(),
                        moment_id: "m2".into(),
                        request_id: None,
                        metadata_origin: "sync".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 2,
                    },
                    &NoFaults,
                )
                .unwrap();
            domain
                .write_text(&write_at("D/a.md", "o-a", "new", "m3", 3), &NoFaults)
                .unwrap();
            domain
                .write_text(&write_at("d", "o-d", "parent", "m4", 4), &NoFaults)
                .unwrap();
            domain
                .set_active_version("workspace", "main", &NoFaults)
                .unwrap();
        }
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 10).unwrap().actor;
        let page = vec![
            change("d/a.md", "delete"),
            change("D/a.md", "write"),
            change("d", "write"),
        ];
        // Single-entry pages reproduce main's sequential probe and replay.
        let pages = if sequential {
            page.into_iter().map(|entry| vec![entry]).collect()
        } else {
            vec![page]
        };
        for now in [11, 12] {
            let mut outcome = Ok(());
            for page in &pages {
                outcome = actor
                    .materialize_relay_page(
                        "workspace".into(),
                        scratch.path().to_path_buf(),
                        page.clone(),
                        Arc::new(()),
                        now,
                        CancellationToken::new(),
                    )
                    .await;
                if outcome.is_err() {
                    break;
                }
            }
            assert!(matches!(
                outcome,
                Err(dohc_engine_runtime::RuntimeError::Domain(
                    dohc_engine_domain::DomainError::InvalidPath { .. }
                ))
            ));
            assert!(scratch.path().join("d").is_dir());
            assert_eq!(
                std::fs::read_to_string(scratch.path().join("D/a.md")).unwrap(),
                "new"
            );
        }
        supervisor.close(&db).unwrap();
        assert!(
            EngineStore::open(&db, 13)
                .unwrap()
                .list_pending_materialization_jobs()
                .unwrap()
                .is_empty()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn directory_replacement_retries_after_the_delete_batch() {
    let scratch = materialize_page(
        |domain| {
            domain
                .write_text(&write_at("d/sub/a.md", "o-a", "a", "m1", 1), &NoFaults)
                .unwrap();
            domain
                .delete_text_file(&delete_at("d/sub/a.md", "m2", 2), &NoFaults)
                .unwrap();
            domain
                .write_text(&write_at("d", "o-d", "file d", "m3", 3), &NoFaults)
                .unwrap();
        },
        |root| {
            std::fs::create_dir_all(root.join("d/sub")).unwrap();
            std::fs::write(root.join("d/sub/a.md"), "a").unwrap();
        },
        // Stop at the crash boundary: the delete batch has committed, but
        // the next batch has not removed the directory or written its file.
        vec![change("d/sub/a.md", "delete")],
    )
    .await;
    assert!(scratch.path().join("d/sub").is_dir());
    assert!(!scratch.path().join("d/sub/a.md").exists());

    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 12).unwrap().actor;
    actor
        .materialize_relay_page(
            "workspace".into(),
            scratch.path().to_path_buf(),
            vec![change("d", "write"), change("d/sub/a.md", "delete")],
            Arc::new(()),
            13,
            CancellationToken::new(),
        )
        .await
        .expect("retry finishes the directory replacement");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("d")).unwrap(),
        "file d"
    );
}

async fn case_only_rename_matches_sequential_replay(text: &str, write_first: bool) {
    // Main probes and materializes each entry before moving to the next.
    // Single-entry pages reproduce that order without a second implementation.
    for (source, destination) in [("FILE.md", "file.md"), ("file.md", "FILE.md")] {
        let mut page = vec![change(source, "delete"), change(destination, "write")];
        if write_first {
            page.reverse();
        }
        let seed = |domain: &mut VersionedTextStore<'_>| {
            domain
                .write_text(&write_at(source, "o-file", "old", "m1", 1), &NoFaults)
                .unwrap();
            domain
                .rename_text_file(
                    &RenameTextFile {
                        workspace_id: "workspace".into(),
                        version_id: "main".into(),
                        from_path: source.into(),
                        to_path: destination.into(),
                        moment_id: "m2".into(),
                        request_id: None,
                        metadata_origin: "sync".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 2,
                    },
                    &NoFaults,
                )
                .unwrap();
            domain
                .write_text(&write_at(destination, "o-file", text, "m3", 3), &NoFaults)
                .unwrap();
        };
        let disk = |root: &std::path::Path| std::fs::write(root.join(source), "old").unwrap();
        let sequential = materialize_pages(
            seed,
            disk,
            page.iter().cloned().map(|change| vec![change]).collect(),
        )
        .await;
        let batched = materialize_page(seed, disk, page).await;
        let files = |root: &std::path::Path| {
            let mut files: Vec<_> = std::fs::read_dir(root)
                .unwrap()
                .map(Result::unwrap)
                .filter(|entry| entry.file_type().unwrap().is_file())
                .map(|entry| (entry.file_name(), std::fs::read(entry.path()).unwrap()))
                .collect();
            files.sort();
            files
        };
        assert_eq!(
            files(batched.path()),
            files(sequential.path()),
            "{source} -> {destination}, write_first={write_first}"
        );
        if !write_first {
            assert_eq!(
                files(batched.path()),
                vec![(
                    std::ffi::OsString::from(destination),
                    text.as_bytes().to_vec()
                )]
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn case_only_rename_equal_bytes_delete_first() {
    case_only_rename_matches_sequential_replay("old", false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn case_only_rename_equal_bytes_write_first() {
    case_only_rename_matches_sequential_replay("old", true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn case_only_rename_changed_bytes_delete_first() {
    case_only_rename_matches_sequential_replay("new", false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn case_only_rename_changed_bytes_write_first() {
    case_only_rename_matches_sequential_replay("new", true).await;
}
