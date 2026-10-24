use dohc_engine_crypto::create_key_file;
use dohc_engine_domain::{
    CreateNamedVersion, MergeTextFileFromVersion, RenameTextFile, SecretDelete, SecretDiskIntent,
    SecretFileStore, SecretWrite, VersionedTextStore, WriteText,
};
use dohc_engine_runtime::{
    ActiveVersionSwitch, CancellationToken, NoFaults, PostCommitMaterializeOutcome,
    WorkspaceSupervisor,
};
use dohc_engine_storage::{EngineStore, FaultPoint, JobStatus};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::path::Path;
use std::sync::Arc;

const WS: &str = "merge-case-alias";

fn ignores_case(root: &Path) -> bool {
    std::fs::write(root.join("probe.md"), "probe").unwrap();
    let ignores_case = std::fs::metadata(root.join("PROBE.md")).is_ok();
    std::fs::remove_file(root.join("probe.md")).unwrap();
    if !ignores_case {
        eprintln!("skipping case-only merge: this disk keeps case apart");
    }
    ignores_case
}

fn fork(store: &mut EngineStore) {
    VersionedTextStore::new(store)
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: WS.into(),
                new_version_id: "draft".into(),
                name: "Draft".into(),
                from_version_id: "main".into(),
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
}

fn secret_write(version: &str, path: &str, moment: &str, now_ms: i64) -> SecretWrite {
    SecretWrite {
        workspace_id: WS.into(),
        version_id: version.into(),
        path: path.into(),
        text: "TOKEN=target".into(),
        moment_id: moment.into(),
        metadata_origin: "api".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        now_ms,
        disk_intent: SecretDiskIntent::AlreadyOnDisk,
    }
}

async fn secret_merge_replay(
    write_completed: bool,
    delete_first: bool,
    legacy_write: bool,
    placed: &str,
) {
    let root = ScratchDir::new().unwrap();
    if !ignores_case(&root) {
        return;
    }
    let db = engine_db_path(&root).unwrap();
    let key = create_key_file(&root.join(".dohc/engine")).unwrap();
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version(WS, "main", 1, &NoFaults)
            .unwrap();
        let mut base = secret_write("main", "foo.env", "base", 1);
        base.text = "TOKEN=base".into();
        SecretFileStore::new(&mut store, &key)
            .write_secret_file(&base, &NoFaults)
            .unwrap();
        fork(&mut store);
        let mut secrets = SecretFileStore::new(&mut store, &key);
        secrets
            .delete_secret_file(
                &SecretDelete {
                    workspace_id: WS.into(),
                    version_id: "draft".into(),
                    path: "foo.env".into(),
                    moment_id: "draft-delete".into(),
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: 3,
                },
                &NoFaults,
            )
            .unwrap();
        secrets
            .write_secret_file(
                &secret_write("draft", "Foo.env", "draft-write", 3),
                &NoFaults,
            )
            .unwrap();
    }
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 4).unwrap().actor;
    let paths = if delete_first {
        ["foo.env", "Foo.env"]
    } else {
        ["Foo.env", "foo.env"]
    };
    for (index, path) in paths.into_iter().enumerate() {
        assert!(
            actor
                .apply_secret_file(
                    WS.into(),
                    path.into(),
                    "draft".into(),
                    "main".into(),
                    format!("merge-{path}"),
                    "api".into(),
                    None,
                    None,
                    4 + index as i64,
                    key.clone(),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
                .unwrap()
                .changed
        );
    }
    supervisor.close(&db).unwrap();
    {
        let mut store = EngineStore::open(&db, 5).unwrap();
        let jobs = store.list_pending_materialization_jobs().unwrap();
        let merge_jobs: Vec<_> = jobs
            .iter()
            .filter(|job| job.job_id.starts_with("secret-mat_merge-"))
            .collect();
        assert_eq!(merge_jobs.len(), 2);
        assert_eq!(merge_jobs[0].target_path, paths[0]);
        assert_eq!(merge_jobs[1].target_path, paths[1]);
        if write_completed {
            store
                .mark_materialization_complete("secret-mat_merge-Foo.env", 5)
                .unwrap();
        }
        if legacy_write {
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "UPDATE materialization_jobs SET workspace_id='' WHERE job_id='secret-mat_merge-Foo.env'",
                        [],
                    )
                    .map_err(dohc_engine_storage::StorageError::persist_public)
                })
                .unwrap();
        }
    }
    std::fs::write(root.join("foo.env"), "TOKEN=base").unwrap();
    if !delete_first {
        // The desktop's merge places deletes before writes (#2240).
        std::fs::remove_file(root.join("foo.env")).unwrap();
        std::fs::write(root.join(placed), "TOKEN=target").unwrap();
    }
    let actor = supervisor.open(&db, 6).unwrap().actor;
    if legacy_write {
        // Replay only the delete first. A pending legacy write must keep the
        // alias skip from retiring this job without removing the old entry.
        actor
            .materialize_replay_selected_for_fence(
                root.path().into(),
                WS.into(),
                Arc::new(()),
                vec!["secret-mat_merge-foo.env".into()],
                6,
            )
            .await
            .unwrap();
        assert!(!root.join("foo.env").exists());
    }
    let replay = actor
        .materialize_replay_pending(root.path().into(), WS.into(), 6)
        .await
        .unwrap();
    supervisor.close(&db).unwrap();
    let mut store = EngineStore::open(&db, 7).unwrap();
    assert!(
        SecretFileStore::new(&mut store, &key)
            .materialize_secret_file(WS, "main", "Foo.env")
            .unwrap()
            .is_some()
    );
    assert_eq!(
        store
            .load_materialization_job("secret-mat_merge-foo.env")
            .unwrap()
            .unwrap()
            .status,
        JobStatus::Complete
    );
    assert_eq!(
        std::fs::read(root.join("Foo.env")).unwrap_or_else(|error| panic!("secret lost after replay completed {replay} jobs (write_completed={write_completed}): {error}")),
        b"TOKEN=target"
    );
}

#[tokio::test]
async fn secret_case_only_merge_survives_reopen_replay() {
    secret_merge_replay(false, false, false, "Foo.env").await;
}

#[tokio::test]
async fn secret_case_only_merge_survives_replay_after_write_completed() {
    secret_merge_replay(true, false, false, "Foo.env").await;
}

/// On macOS a write over equal bytes keeps the stored spelling, so the file
/// is still stored as `foo.env` when the old spelling's delete replays.
#[tokio::test]
async fn secret_case_only_merge_survives_replay_with_old_spelling_stored() {
    secret_merge_replay(false, false, false, "foo.env").await;
}

#[tokio::test]
async fn secret_case_only_merge_delete_first_survives_reopen() {
    secret_merge_replay(false, true, false, "Foo.env").await;
}

#[tokio::test]
async fn secret_case_only_merge_delete_first_waits_for_legacy_write() {
    secret_merge_replay(false, true, true, "Foo.env").await;
}

#[tokio::test]
async fn secret_delete_with_live_exact_tip_keeps_main_behavior() {
    // Main's tip-present check completes this delete before alias retirement runs.
    let root = ScratchDir::new().unwrap();
    let db = engine_db_path(&root).unwrap();
    let key = create_key_file(&root.join(".dohc/engine")).unwrap();
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version(WS, "main", 1, &NoFaults)
            .unwrap();
        let mut secrets = SecretFileStore::new(&mut store, &key);
        secrets
            .write_secret_file(&secret_write("main", "foo.env", "base", 1), &NoFaults)
            .unwrap();
        secrets
            .delete_secret_file(
                &SecretDelete {
                    workspace_id: WS.into(),
                    version_id: "main".into(),
                    path: "foo.env".into(),
                    moment_id: "delete".into(),
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: 2,
                },
                &NoFaults,
            )
            .unwrap();
        secrets
            .write_secret_file(&secret_write("main", "foo.env", "restore", 3), &NoFaults)
            .unwrap();
        assert_eq!(
            store
                .load_materialization_job("secret-mat_delete")
                .unwrap()
                .unwrap()
                .status,
            JobStatus::Pending
        );
    }
    std::fs::write(root.join("foo.env"), "TOKEN=disk").unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 4).unwrap().actor;
    actor
        .materialize_replay_pending(root.path().into(), WS.into(), 4)
        .await
        .unwrap();
    supervisor.close(&db).unwrap();
    assert_eq!(std::fs::read(root.join("foo.env")).unwrap(), b"TOKEN=disk");
    let store = EngineStore::open(&db, 5).unwrap();
    assert_eq!(
        store
            .load_materialization_job("secret-mat_delete")
            .unwrap()
            .unwrap()
            .status,
        JobStatus::Complete
    );
}

fn text_write(version: &str, path: &str, text: &str, moment: &str) -> WriteText {
    WriteText {
        workspace_id: WS.into(),
        version_id: version.into(),
        object_id: format!("object-{moment}"),
        path: path.into(),
        text: text.into(),
        moment_id: moment.into(),
        metadata_origin: "api".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 1,
        request_id: None,
    }
}

fn complete_pending_jobs(store: &mut EngineStore) {
    for job in store.list_pending_materialization_jobs().unwrap() {
        store.mark_materialization_complete(&job.job_id, 1).unwrap();
    }
}

fn disk_names(root: &Path) -> Vec<String> {
    let mut names: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name != ".dohc")
        .collect();
    names.sort();
    names
}

/// A draft renames Main's `from` to `to`. Main's file is stored on disk as
/// `before`, and the merged file should end stored as `after`.
struct CaseRename<'a> {
    from: &'a str,
    to: &'a str,
    before: &'a str,
    after: &'a str,
}

const NOTES: CaseRename = CaseRename {
    from: "notes.md",
    to: "Notes.md",
    before: "notes.md",
    after: "Notes.md",
};

/// Main has `from`; the draft edits it to `text` and renames it to `to`.
/// The folder holds Main's file at `before`.
fn seed_case_only_rename(root: &Path, db: &Path, rename: &CaseRename, text: &str) {
    let CaseRename { from, to, .. } = *rename;
    let mut store = EngineStore::open(db, 1).unwrap();
    let mut texts = VersionedTextStore::new(&mut store);
    texts.ensure_main_version(WS, "main", 1, &NoFaults).unwrap();
    texts
        .write_text(&text_write("main", from, "old", "base"), &NoFaults)
        .unwrap();
    fork(&mut store);
    let mut texts = VersionedTextStore::new(&mut store);
    texts
        .write_text(&text_write("draft", from, text, "edit"), &NoFaults)
        .unwrap();
    texts
        .rename_text_file(
            &RenameTextFile {
                workspace_id: WS.into(),
                version_id: "draft".into(),
                from_path: from.into(),
                to_path: to.into(),
                moment_id: "rename".into(),
                request_id: None,
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 3,
            },
            &NoFaults,
        )
        .unwrap();
    complete_pending_jobs(&mut store);
    if let Some((folder, _)) = rename.before.rsplit_once('/') {
        std::fs::create_dir_all(root.join(folder)).unwrap();
    }
    std::fs::write(root.join(rename.before), "old").unwrap();
}

fn merge(path: &str, now_ms: i64) -> MergeTextFileFromVersion {
    MergeTextFileFromVersion {
        workspace_id: WS.into(),
        target_version_id: "main".into(),
        source_version_id: "draft".into(),
        path: path.into(),
        object_id: format!("merged-{path}"),
        moment_id: format!("merge-{path}"),
        request_id: None,
        conflict_id: format!("conflict-{path}"),
        metadata_origin: "api".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
    }
}

/// The desktop merges the path Main loses first. With `replay`, both merge
/// jobs are left pending, as after a crash, and run on reopen.
async fn text_case_only_merge(replay: bool, text: &str) {
    let root = ScratchDir::new().unwrap();
    if !ignores_case(&root) {
        return;
    }
    let db = engine_db_path(&root).unwrap();
    seed_case_only_rename(&root, &db, &NOTES, text);
    let supervisor = WorkspaceSupervisor::new();
    if replay {
        let mut store = EngineStore::open(&db, 4).unwrap();
        for (now_ms, path) in [(4, "notes.md"), (5, "Notes.md")] {
            VersionedTextStore::new(&mut store)
                .merge_text_file_from_version_with(&merge(path, now_ms), &NoFaults, |_, _| Ok(()))
                .unwrap();
        }
        assert_eq!(store.list_pending_materialization_jobs().unwrap().len(), 2);
        drop(store);
        let actor = supervisor.open(&db, 6).unwrap().actor;
        actor
            .materialize_replay_pending(root.path().into(), WS.into(), 6)
            .await
            .unwrap();
    } else {
        let actor = supervisor.open(&db, 4).unwrap().actor;
        for (now_ms, path) in [(4, "notes.md"), (5, "Notes.md")] {
            actor
                .versioned_text_merge(
                    merge(path, now_ms),
                    root.path().into(),
                    Arc::new(()),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
        }
    }
    supervisor.close(&db).unwrap();
    // Capture respells a head whose file is stored under another spelling,
    // so the stored name must be the new one.
    assert_eq!(disk_names(&root), ["Notes.md"]);
    assert_eq!(
        std::fs::read(root.join("Notes.md")).unwrap(),
        text.as_bytes()
    );
    let store = EngineStore::open(&db, 7).unwrap();
    assert!(
        store
            .list_pending_materialization_jobs()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn text_case_only_merge_keeps_the_new_spelling() {
    text_case_only_merge(false, "new").await;
}

#[tokio::test]
async fn text_case_only_merge_survives_reopen_replay() {
    text_case_only_merge(true, "new").await;
}

/// The merge's delete of `from` fails for a moment, as a busy file makes it,
/// and stays pending. The merge then writes `to`. With `edit`, the person
/// changes the file before that write (#2369).
async fn text_case_only_merge_after_failed_delete(
    rename: CaseRename<'_>,
    text: &str,
    edit: Option<&str>,
) {
    let CaseRename {
        from,
        to,
        before,
        after,
    } = rename;
    let root = ScratchDir::new().unwrap();
    let db = engine_db_path(&root).unwrap();
    seed_case_only_rename(&root, &db, &rename, text);
    // Main's file can be stored as `before` only on a disk that gives both
    // spellings that file.
    for spelling in [from, to] {
        if std::fs::metadata(root.join(spelling)).is_err() {
            eprintln!("skipping: this disk keeps {before} and {spelling} apart");
            return;
        }
    }
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 4).unwrap().actor;
    let busy = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
    let deleted = actor
        .versioned_text_merge(
            merge(from, 4),
            root.path().into(),
            Arc::new(()),
            busy.clone(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(busy.fired() && !deleted.materialized);
    if let Some(edit) = edit {
        std::fs::write(root.join(before), edit).unwrap();
    }
    let written = actor
        .versioned_text_merge(
            merge(to, 5),
            root.path().into(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    // A later replay must keep what the merge left.
    actor
        .materialize_replay_pending(root.path().into(), WS.into(), 6)
        .await
        .unwrap();
    supervisor.close(&db).unwrap();
    let store = EngineStore::open(&db, 7).unwrap();
    assert!(
        store
            .list_pending_materialization_jobs()
            .unwrap()
            .is_empty()
    );
    let write_status = store
        .load_materialization_job(&format!("merge-mat_merge-{to}"))
        .unwrap()
        .unwrap()
        .status;
    let Some(edit) = edit else {
        let mut folder = root.path().to_path_buf();
        for segment in after.split('/') {
            assert_eq!(disk_names(&folder), [segment]);
            folder.push(segment);
        }
        assert_eq!(std::fs::read(folder).unwrap(), text.as_bytes());
        assert!(written.materialized);
        assert_eq!(write_status, JobStatus::Complete);
        return;
    };
    let [copy, kept]: [String; 2] = disk_names(&root).try_into().unwrap();
    assert!(copy.starts_with(&format!("{to}.")) && copy.ends_with(".conflict"));
    assert_eq!(kept, after);
    assert_eq!(std::fs::read(root.join(kept)).unwrap(), edit.as_bytes());
    assert_eq!(std::fs::read(root.join(copy)).unwrap(), text.as_bytes());
    assert_eq!(
        written.materialize_outcome,
        PostCommitMaterializeOutcome::Conflict
    );
    assert_eq!(write_status, JobStatus::Conflict);
}

#[tokio::test]
async fn text_case_only_merge_after_a_failed_delete_keeps_the_new_spelling() {
    text_case_only_merge_after_failed_delete(NOTES, "new", None).await;
}

#[tokio::test]
async fn text_case_only_merge_after_a_failed_delete_with_equal_bytes_keeps_the_new_spelling() {
    text_case_only_merge_after_failed_delete(NOTES, "old", None).await;
}

#[tokio::test]
async fn text_case_only_merge_after_a_failed_delete_keeps_an_edit_to_the_old_spelling() {
    let rename = CaseRename {
        after: "notes.md",
        ..NOTES
    };
    text_case_only_merge_after_failed_delete(rename, "new", Some("edited")).await;
}

/// Only the folder's capitals change. A write places only the file, so the
/// folder keeps its stored spelling.
#[tokio::test]
async fn text_case_only_merge_after_a_failed_delete_writes_into_a_folder_renamed_by_case() {
    let rename = CaseRename {
        from: "drafts/notes.md",
        to: "Drafts/notes.md",
        before: "drafts/notes.md",
        after: "drafts/notes.md",
    };
    text_case_only_merge_after_failed_delete(rename, "new", None).await;
}

/// After the merge above, Main's `Drafts/notes.md` is stored as
/// `drafts/notes.md`. A second merge then changes the file name's capitals.
#[tokio::test]
async fn text_case_only_merge_after_a_failed_delete_respells_a_file_stored_under_old_folder_capitals()
 {
    let rename = CaseRename {
        from: "Drafts/notes.md",
        to: "Drafts/Notes.md",
        before: "drafts/notes.md",
        after: "drafts/Notes.md",
    };
    text_case_only_merge_after_failed_delete(rename, "new", None).await;
}

/// The second merge instead changes the folder's capitals back, to the
/// spelling the disk already stores.
#[tokio::test]
async fn text_case_only_merge_after_a_failed_delete_respells_back_to_the_stored_spelling() {
    let rename = CaseRename {
        from: "Drafts/notes.md",
        to: "drafts/notes.md",
        before: "drafts/notes.md",
        after: "drafts/notes.md",
    };
    text_case_only_merge_after_failed_delete(rename, "new", None).await;
}

/// Main's name is NFC, and the disk stores the file under the NFD name.
#[tokio::test]
async fn text_case_only_merge_after_a_failed_delete_respells_a_file_stored_in_another_normalization()
 {
    let rename = CaseRename {
        from: "caf\u{e9}.md",
        to: "Caf\u{e9}.md",
        before: "cafe\u{301}.md",
        after: "Caf\u{e9}.md",
    };
    text_case_only_merge_after_failed_delete(rename, "new", None).await;
}

#[tokio::test]
async fn text_case_only_merge_with_equal_bytes_keeps_the_new_spelling() {
    text_case_only_merge(false, "old").await;
    text_case_only_merge(true, "old").await;
}

/// A switch's delete of `path` that couldn't finish replays after the person
/// renamed `from` to `to` on disk and capture recorded the file at `renamed`
/// (#2299).
async fn pending_switch_delete_after_rename(path: &str, from: &str, to: &str, renamed: &str) {
    let root = ScratchDir::new().unwrap();
    if !ignores_case(&root) {
        return;
    }
    let db = engine_db_path(&root).unwrap();
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        let mut texts = VersionedTextStore::new(&mut store);
        texts.ensure_main_version(WS, "main", 1, &NoFaults).unwrap();
        fork(&mut store);
        VersionedTextStore::new(&mut store)
            .write_text(&text_write("main", path, "text", "base"), &NoFaults)
            .unwrap();
        complete_pending_jobs(&mut store);
    }
    if let Some((folder, _)) = path.rsplit_once('/') {
        std::fs::create_dir_all(root.join(folder)).unwrap();
    }
    std::fs::write(root.join(path), "text").unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 2).unwrap().actor;
    let crash = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
    let _ = actor
        .set_active_version(
            ActiveVersionSwitch {
                workspace_id: WS.into(),
                version_id: "draft".into(),
                root_dir: root.path().into(),
                self_writes: Arc::new(()),
                now_ms: 2,
            },
            crash.clone(),
            CancellationToken::new(),
        )
        .await;
    assert!(crash.fired());
    supervisor.close(&db).unwrap();
    {
        let mut store = EngineStore::open(&db, 3).unwrap();
        let pending = store.list_pending_materialization_jobs().unwrap();
        assert_eq!(pending.len(), 1);
        assert!(pending[0].job_id.starts_with("version-switch-mat_"));
        std::fs::rename(root.join(from), root.join(to)).unwrap();
        // Capture records the renamed file, with the bytes the delete expects.
        let mut capture = text_write("draft", renamed, "text", "renamed");
        capture.now_ms = 3;
        VersionedTextStore::new(&mut store)
            .write_text(&capture, &NoFaults)
            .unwrap();
    }
    let actor = supervisor.open(&db, 4).unwrap().actor;
    actor
        .materialize_replay_pending(root.path().into(), WS.into(), 4)
        .await
        .unwrap();
    supervisor.close(&db).unwrap();
    let stored = format!("{to}{}", &path[from.len()..]);
    let mut folder = root.path().to_path_buf();
    for segment in stored.split('/') {
        assert_eq!(disk_names(&folder), [segment]);
        folder.push(segment);
    }
    assert_eq!(std::fs::read(folder).unwrap(), b"text");
    let store = EngineStore::open(&db, 5).unwrap();
    assert!(
        store
            .list_pending_materialization_jobs()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn pending_switch_delete_keeps_a_file_renamed_by_case() {
    pending_switch_delete_after_rename("notes.md", "notes.md", "Notes.md", "Notes.md").await;
}

#[tokio::test]
async fn pending_switch_delete_keeps_a_file_in_a_folder_renamed_by_case() {
    pending_switch_delete_after_rename("drafts/notes.md", "drafts", "Drafts", "Drafts/notes.md")
        .await;
}

/// The person respells the file back to the old spelling while the head at
/// the new one is still live.
#[tokio::test]
async fn pending_switch_delete_keeps_a_file_respelled_back() {
    pending_switch_delete_after_rename("notes.md", "notes.md", "notes.md", "Notes.md").await;
}

#[tokio::test]
async fn pending_switch_delete_keeps_a_file_renamed_by_normalization() {
    pending_switch_delete_after_rename(
        "caf\u{e9}.md",
        "caf\u{e9}.md",
        "cafe\u{301}.md",
        "cafe\u{301}.md",
    )
    .await;
}
