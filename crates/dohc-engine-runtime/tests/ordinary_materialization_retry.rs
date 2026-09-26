use dohc_engine_domain::{DeleteTextFile, VersionedTextStore, WriteText};
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn case_only_replacement_keeps_the_file_and_changes_its_spelling() {
    check_case_replacement("file.md", "FILE.md", false).await;
    check_case_replacement("FILE.md", "file.md", false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn case_only_directory_replacement_preserves_siblings() {
    let aliases = std::cell::Cell::new(false);
    let scratch = materialize_page(
        |domain| {
            domain.write_text(&write_at("Dir/Sub/a.md", "o-a", "old", "m1", 1), &NoFaults).unwrap();
            domain.delete_text_file(&delete_at("Dir/Sub/a.md", "m2", 2), &NoFaults).unwrap();
            domain.write_text(&write_at("dir/sub/a.md", "o-b", "old", "m3", 3), &NoFaults).unwrap();
        },
        |root| {
            std::fs::create_dir_all(root.join("Dir/Sub")).unwrap();
            std::fs::write(root.join("Dir/Sub/a.md"), "old").unwrap();
            std::fs::write(root.join("Dir/keep.md"), "keep").unwrap();
            aliases.set(matches!((file_id::get_file_id(root.join("Dir")), file_id::get_file_id(root.join("dir"))),
                (Ok(a), Ok(b)) if a == b));
        },
        vec![change("dir/sub/a.md", "write"), change("Dir/Sub/a.md", "delete")],
    ).await;
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("dir/sub/a.md")).unwrap(),
        "old"
    );
    assert!(dohc_engine_files::target_has_requested_name(
        scratch.path(),
        &scratch.path().join("dir/sub/a.md")
    ));
    let sibling = if aliases.get() {
        "dir/keep.md"
    } else {
        "Dir/keep.md"
    };
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(sibling)).unwrap(),
        "keep"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn differently_cased_directory_can_become_a_file() {
    let scratch = materialize_page(
        |domain| {
            domain
                .write_text(&write_at("D/sub/a.md", "o-a", "old", "m1", 1), &NoFaults)
                .unwrap();
            domain
                .delete_text_file(&delete_at("D/sub/a.md", "m2", 2), &NoFaults)
                .unwrap();
            domain
                .write_text(&write_at("d", "o-b", "new", "m3", 3), &NoFaults)
                .unwrap();
        },
        |root| {
            std::fs::create_dir_all(root.join("D/sub")).unwrap();
            std::fs::write(root.join("D/sub/a.md"), "old").unwrap();
        },
        vec![change("d", "write"), change("D/sub/a.md", "delete")],
    )
    .await;
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("d")).unwrap(),
        "new"
    );
    assert!(!scratch.path().join("D/sub/a.md").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn collision_key_match_does_not_skip_deleting_a_distinct_windows_file() {
    check_case_replacement("\u{1e9e}.md", "ss.md", false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn collision_key_hard_links_still_delete_the_old_name() {
    check_case_replacement("\u{1e9e}.md", "ss.md", true).await;
}

async fn check_case_replacement(old_path: &str, new_path: &str, hard_link: bool) {
    for new_text in ["old", "new"] {
        for delete_first in [false, true] {
            let mut page = vec![change(new_path, "write"), change(old_path, "delete")];
            if delete_first {
                page.reverse();
            }
            let scratch = materialize_page(
                |domain| {
                    domain
                        .write_text(&write_at(old_path, "o-a", "old", "m1", 1), &NoFaults)
                        .unwrap();
                    domain
                        .delete_text_file(&delete_at(old_path, "m2", 2), &NoFaults)
                        .unwrap();
                    domain
                        .write_text(&write_at(new_path, "o-b", new_text, "m3", 3), &NoFaults)
                        .unwrap();
                },
                |root| {
                    std::fs::write(root.join(old_path), "old").unwrap();
                    if hard_link {
                        std::fs::hard_link(root.join(old_path), root.join(new_path)).unwrap();
                    }
                },
                page,
            )
            .await;
            assert_eq!(
                std::fs::read_to_string(scratch.path().join(new_path)).unwrap(),
                new_text
            );
            let names: Vec<_> = std::fs::read_dir(scratch.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            assert!(names.iter().any(|name| name == new_path));
            assert!(!names.iter().any(|name| name == old_path));
        }
    }
}
