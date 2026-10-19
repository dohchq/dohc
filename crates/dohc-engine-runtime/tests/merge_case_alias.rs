use dohc_engine_crypto::create_key_file;
use dohc_engine_domain::{
    CreateNamedVersion, SecretDelete, SecretDiskIntent, SecretFileStore, SecretWrite,
    VersionedTextStore,
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

async fn secret_merge_replay(write_completed: bool, delete_first: bool, legacy_write: bool) {
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
        std::fs::write(root.join("Foo.env"), "TOKEN=target").unwrap();
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
    secret_merge_replay(false, false, false).await;
}

#[tokio::test]
async fn secret_case_only_merge_survives_replay_after_write_completed() {
    secret_merge_replay(true, false, false).await;
}

#[tokio::test]
async fn secret_case_only_merge_delete_first_survives_reopen() {
    secret_merge_replay(false, true, false).await;
}

#[tokio::test]
async fn secret_case_only_merge_delete_first_waits_for_legacy_write() {
    secret_merge_replay(false, true, true).await;
}

#[tokio::test]
async fn secret_delete_with_live_exact_tip_keeps_main_behavior() {
    // Main's tip-present check completes this delete before alias retirement runs.
    let root = ScratchDir::new().unwrap();
    let db = engine_db_path(&root).unwrap();
    let key = create_key_file(&root).unwrap();
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
