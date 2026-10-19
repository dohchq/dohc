use dohc_engine_crypto::create_key_file;
use dohc_engine_domain::{
    CreateNamedVersion, MergeTextFileFromVersion, RenameTextFile, SecretDelete, SecretDiskIntent,
    SecretFileStore, SecretWrite, VersionedTextStore, WriteText,
};
use dohc_engine_runtime::{CancellationToken, NoFaults, WorkspaceSupervisor};
use dohc_engine_storage::{
    EngineStore, JobStatus, MaterializationJobSpec, Preimage, enqueue_delete_job, hex_sha256,
    put_binary_blob,
};
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

async fn secret_merge_replay(write_completed: bool, delete_first: bool) {
    let root = ScratchDir::new().unwrap();
    if !ignores_case(&root) {
        return;
    }
    let db = engine_db_path(&root).unwrap();
    let key = create_key_file(&root).unwrap();
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
        let store = EngineStore::open(&db, 5).unwrap();
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
    }
    // The desktop's merge places deletes before writes (#2240).
    std::fs::write(root.join("foo.env"), "TOKEN=base").unwrap();
    if !delete_first {
        std::fs::remove_file(root.join("foo.env")).unwrap();
        std::fs::write(root.join("Foo.env"), "TOKEN=target").unwrap();
    }
    let actor = supervisor.open(&db, 6).unwrap().actor;
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
    secret_merge_replay(false, false).await;
}

#[tokio::test]
async fn secret_case_only_merge_survives_replay_after_write_completed() {
    secret_merge_replay(true, false).await;
}

#[tokio::test]
async fn secret_case_only_merge_delete_first_survives_reopen() {
    secret_merge_replay(false, true).await;
}

async fn text_merge_replay(delete_first: bool) {
    let root = ScratchDir::new().unwrap();
    if !ignores_case(&root) {
        return;
    }
    let db = engine_db_path(&root).unwrap();
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        let mut versions = VersionedTextStore::new(&mut store);
        versions
            .ensure_main_version(WS, "main", 1, &NoFaults)
            .unwrap();
        versions
            .write_text(
                &WriteText {
                    workspace_id: WS.into(),
                    version_id: "main".into(),
                    object_id: "notes".into(),
                    path: "notes.md".into(),
                    text: "old".into(),
                    moment_id: "base".into(),
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        fork(&mut store);
        VersionedTextStore::new(&mut store)
            .rename_text_file(
                &RenameTextFile {
                    workspace_id: WS.into(),
                    version_id: "draft".into(),
                    from_path: "notes.md".into(),
                    to_path: "Notes.md".into(),
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
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: WS.into(),
                    version_id: "draft".into(),
                    object_id: "notes".into(),
                    path: "Notes.md".into(),
                    text: "new".into(),
                    moment_id: "draft-edit".into(),
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 3,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
    }
    std::fs::write(root.join("notes.md"), "old").unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 4).unwrap().actor;
    let paths = if delete_first {
        ["notes.md", "Notes.md"]
    } else {
        ["Notes.md", "notes.md"]
    };
    for (index, path) in paths.into_iter().enumerate() {
        actor
            .versioned_text_merge(
                MergeTextFileFromVersion {
                    workspace_id: WS.into(),
                    target_version_id: "main".into(),
                    source_version_id: "draft".into(),
                    path: path.into(),
                    object_id: format!("merge-{path}"),
                    moment_id: format!("merge-{path}"),
                    request_id: None,
                    conflict_id: format!("conflict-{path}"),
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 4 + index as i64,
                },
                root.path().into(),
                Arc::new(()),
                if delete_first {
                    ScriptedFaults::crash_at(
                        dohc_engine_storage::FaultPoint::MaterializeAfterJobCommit,
                    )
                } else {
                    Arc::new(NoFaults)
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
    }
    supervisor.close(&db).unwrap();
    if delete_first {
        let store = EngineStore::open(&db, 5).unwrap();
        let jobs = store.list_pending_materialization_jobs().unwrap();
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].target_path, "notes.md");
        assert_eq!(jobs[1].target_path, "Notes.md");
    }
    let actor = supervisor.open(&db, 5).unwrap().actor;
    actor
        .materialize_replay_pending(root.path().into(), WS.into(), 5)
        .await
        .unwrap();
    supervisor.close(&db).unwrap();
    if delete_first {
        assert_eq!(std::fs::read(root.join("Notes.md")).unwrap(), b"new");
        assert!(!std::fs::read_dir(&root).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".conflict")
        }));
        return;
    }
    assert_eq!(
        std::fs::read(root.join("Notes.md")).expect("text survives merge and reopen"),
        b"old"
    );
    let names: Vec<_> = std::fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(names.iter().any(|name| name == "notes.md"));
    assert!(!names.iter().any(|name| name == "Notes.md"));
    let conflict = names
        .iter()
        .find(|name| name.ends_with(".conflict"))
        .unwrap();
    assert_eq!(std::fs::read(root.join(conflict)).unwrap(), b"new");
    let mut store = EngineStore::open(&db, 6).unwrap();
    let versions = VersionedTextStore::new(&mut store);
    assert!(
        versions
            .read_text(WS, "main", "notes.md")
            .unwrap()
            .is_none()
    );
    let tip = versions.read_text(WS, "main", "Notes.md").unwrap().unwrap();
    assert_eq!(tip.text, "new");
    assert!(
        store
            .list_pending_materialization_jobs()
            .unwrap()
            .is_empty()
    );

    // The remaining durability bug: capture would respell the merged tip back
    // to the old disk name and ingest its old bytes. Keep this outcome explicit.
    use dohc_engine_files::{
        ManifestEntry, ReconcileController, ReconcileRun, ScanBounds, ScanGeneration, ScanManifest,
        Scanner,
    };
    let manifest = ScanManifest::from_entries([(
        tip.path,
        ManifestEntry {
            size: 3,
            sha256: tip.blob_sha256,
            mtime_ms: 0,
        },
    )]);
    let mut controller = ReconcileController::rehydrated(manifest, ScanGeneration(0));
    let scanner = Scanner::new(ScanBounds::default()).unwrap();
    let ReconcileRun::Completed(plan) = controller
        .reconcile(&scanner, &root, &CancellationToken::new())
        .unwrap()
    else {
        panic!("capture scan did not complete")
    };
    let respell = plan.respelled_retires.get("Notes.md").unwrap();
    // Issue #2297: capture respells the merged tip back to the old disk name.
    assert_eq!(respell.path, "notes.md");
    assert_eq!(respell.sha256, hex_sha256(b"old"));
}

#[tokio::test]
async fn text_case_only_merge_known_bug_respells_to_old_disk_name() {
    text_merge_replay(false).await;
}

#[tokio::test]
async fn text_case_only_merge_delete_first_survives_reopen() {
    text_merge_replay(true).await;
}

async fn ordinary_delete_replay(exact_tip: bool, fence: bool) {
    let root = ScratchDir::new().unwrap();
    let db = engine_db_path(&root).unwrap();
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version(WS, "main", 1, &NoFaults)
            .unwrap();
        if exact_tip {
            VersionedTextStore::new(&mut store)
                .write_text(
                    &WriteText {
                        workspace_id: WS.into(),
                        version_id: "main".into(),
                        object_id: "exact-tip".into(),
                        path: "delete.md".into(),
                        text: "old".into(),
                        moment_id: "base".into(),
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 1,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
        }
        store
            .write_with(&NoFaults, |tx| {
                let sha = put_binary_blob(tx, b"old")?;
                enqueue_delete_job(
                    tx,
                    &MaterializationJobSpec {
                        job_id: "ordinary-delete".into(),
                        workspace_id: WS.into(),
                        target_path: "delete.md".into(),
                        content_sha256: sha,
                        preimage: Preimage::Present(hex_sha256(b"old")),
                        target_generation: 2,
                        now_ms: 2,
                    },
                )
            })
            .unwrap();
    }
    std::fs::write(root.join("delete.md"), "old").unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    if fence {
        actor
            .materialize_replay_pending_for_fence(root.path().into(), WS.into(), Arc::new(()), 3)
            .await
            .unwrap();
    } else {
        assert_eq!(
            actor
                .materialize_replay_pending(root.path().into(), WS.into(), 3)
                .await
                .unwrap(),
            1
        );
    }
    supervisor.close(&db).unwrap();
    // The alias skip must not retire a delete whose exact path is live.
    assert!(!root.join("delete.md").exists());
    let store = EngineStore::open(&db, 4).unwrap();
    assert_eq!(
        store
            .load_materialization_job("ordinary-delete")
            .unwrap()
            .unwrap()
            .status,
        JobStatus::Complete
    );
}

#[tokio::test]
async fn ordinary_delete_without_alias_still_unlinks() {
    ordinary_delete_replay(false, false).await;
}

#[tokio::test]
async fn exact_live_tip_does_not_skip_preimage_checked_delete() {
    ordinary_delete_replay(true, false).await;
}

#[tokio::test]
async fn exact_live_tip_does_not_skip_preimage_checked_delete_at_fence() {
    ordinary_delete_replay(true, true).await;
}
