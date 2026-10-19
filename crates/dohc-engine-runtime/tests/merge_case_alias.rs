use dohc_engine_crypto::create_key_file;
use dohc_engine_domain::{
    CreateNamedVersion, MergeTextFileFromVersion, RenameTextFile, SecretDelete, SecretDiskIntent,
    SecretFileStore, SecretWrite, VersionedTextStore, WriteText,
};
use dohc_engine_runtime::{CancellationToken, NoFaults, WorkspaceSupervisor};
use dohc_engine_storage::{EngineStore, JobStatus};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
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

async fn secret_merge_replay(write_completed: bool) {
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
        SecretFileStore::new(&mut store, &key)
            .write_secret_file(&secret_write("main", "foo.env", "base", 1), &NoFaults)
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
    for path in ["Foo.env", "foo.env"] {
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
                    4,
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
        assert_eq!(merge_jobs[0].target_path, "Foo.env");
        assert_eq!(merge_jobs[1].target_path, "foo.env");
        if write_completed {
            store
                .mark_materialization_complete("secret-mat_merge-Foo.env", 5)
                .unwrap();
        }
    }
    // The desktop's merge places deletes before writes (#2240).
    std::fs::write(root.join("foo.env"), "TOKEN=base").unwrap();
    std::fs::remove_file(root.join("foo.env")).unwrap();
    std::fs::write(root.join("Foo.env"), "TOKEN=target").unwrap();
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
    secret_merge_replay(false).await;
}

#[tokio::test]
async fn secret_case_only_merge_survives_replay_after_write_completed() {
    secret_merge_replay(true).await;
}

#[tokio::test]
async fn text_case_only_merge_survives_reopen_replay() {
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
                    text: "target text".into(),
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
    }
    std::fs::write(root.join("notes.md"), "target text").unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 4).unwrap().actor;
    for path in ["Notes.md", "notes.md"] {
        let result = actor
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
                    now_ms: 4,
                },
                root.path().into(),
                Arc::new(()),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        eprintln!("text merge {path}: {:?}", result.materialize_outcome);
    }
    supervisor.close(&db).unwrap();
    let actor = supervisor.open(&db, 5).unwrap().actor;
    actor
        .materialize_replay_pending(root.path().into(), WS.into(), 5)
        .await
        .unwrap();
    supervisor.close(&db).unwrap();
    assert_eq!(
        std::fs::read(root.join("Notes.md")).expect("text survives merge and reopen"),
        b"target text"
    );
}
