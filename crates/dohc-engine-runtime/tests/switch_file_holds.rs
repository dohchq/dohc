use dohc_engine_domain::{CaptureIngest, CreateNamedVersion, VersionedTextStore};
use dohc_engine_runtime::{ActiveVersionSwitch, CancellationToken, NoFaults, WorkspaceSupervisor};
use dohc_engine_storage::{
    EngineStore, FaultPoint,
    capture_file_holds::{self, CaptureFileHold},
};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::sync::Arc;

const WS: &str = "ws-switch-holds";
const OUTSIDE: &str = "outside bytes the switch must preserve\n";

fn seed(store: &mut EngineStore, version: &str, path: &str, text: &str, now: i64) -> String {
    VersionedTextStore::new(store)
        .capture_ingest(
            &CaptureIngest {
                workspace_id: WS.into(),
                version_id: version.into(),
                path: path.into(),
                text: text.into(),
                metadata_origin: "capture".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: now,
                request_id: None,
                claim_foreign_head: false,
            },
            &NoFaults,
        )
        .unwrap()
        .snapshot
        .object_id
}

fn fixture(files: usize, holds: usize, target_path: &str) -> ScratchDir {
    let scratch = ScratchDir::new().unwrap();
    let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", 1, &NoFaults)
        .unwrap();
    for i in 0..files {
        let path = format!("file-{i:04}.txt");
        let object = seed(&mut store, "main", &path, "main\n", 2);
        std::fs::write(
            scratch.path().join(&path),
            if i < holds { OUTSIDE } else { "main\n" },
        )
        .unwrap();
        if i < holds {
            store
                .write_with(&NoFaults, |tx| {
                    capture_file_holds::record_in(
                        tx,
                        &CaptureFileHold {
                            workspace_id: WS.into(),
                            source_version_id: "main".into(),
                            object_id: object,
                            path,
                            observed_sha256: dohc_engine_storage::hex_sha256(OUTSIDE.as_bytes()),
                            observed_size: OUTSIDE.len() as u64,
                            reason: capture_file_holds::NOT_REPRESENTABLE.into(),
                            observed_at_ms: 3,
                            attempt_count: 1,
                            retry_requested: false,
                        },
                    )
                })
                .unwrap();
        }
    }
    VersionedTextStore::new(&mut store)
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: WS.into(),
                new_version_id: "target".into(),
                name: "Target".into(),
                from_version_id: "main".into(),
                now_ms: 4,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    // Use an empty target for deletes, or rewrite all target heads. The case
    // variant deliberately names the same Windows file through another alias.
    if target_path.is_empty() {
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "DELETE FROM snapshots WHERE workspace_id=?1 AND version_id='target'",
                    [WS],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                tx.execute(
                    "DELETE FROM path_aliases WHERE workspace_id=?1 AND version_id='target'",
                    [WS],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)
            })
            .unwrap();
    } else {
        for i in 0..files {
            seed(
                &mut store,
                "target",
                &format!("file-{i:04}.txt"),
                "target\n",
                5,
            );
        }
        if target_path != "file-0000.txt" {
            store.write_with(&NoFaults, |tx| {
                tx.execute("UPDATE snapshots SET path=?1 WHERE workspace_id=?2 AND version_id='target' AND path='file-0000.txt'", [target_path, WS]).map_err(dohc_engine_storage::StorageError::persist_public)?;
                tx.execute("UPDATE path_aliases SET path=?1 WHERE workspace_id=?2 AND version_id='target' AND path='file-0000.txt'", [target_path, WS]).map_err(dohc_engine_storage::StorageError::persist_public)
            }).unwrap();
        }
    }
    scratch
}

fn switch(scratch: &ScratchDir, version: &str, now: i64) -> ActiveVersionSwitch {
    ActiveVersionSwitch {
        workspace_id: WS.into(),
        version_id: version.into(),
        root_dir: scratch.path().to_path_buf(),
        self_writes: Arc::new(()),
        now_ms: now,
    }
}

async fn preserves_hold(target_path: &str, crash: bool) {
    let scratch = fixture(2, 1, target_path);
    if target_path == "FILE-0000.TXT" && !scratch.path().join(target_path).exists() {
        return;
    }
    let database = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 6).unwrap().actor;
    let before = actor.capture_file_holds(WS.into()).await.unwrap();
    if crash {
        let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
        assert!(
            actor
                .set_active_version(
                    switch(&scratch, "target", 7),
                    faults.clone(),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
        assert!(faults.fired(), "switch must reach placement with a hold");
        assert_eq!(
            actor.active_version(WS.into()).await.unwrap().version_id,
            "target"
        );
        supervisor.close(&database).unwrap();
        let reopened = supervisor.open(&database, 8).unwrap().actor;
        reopened
            .materialize_replay_pending(scratch.path().to_path_buf(), WS.into(), 9)
            .await
            .unwrap();
        assert_eq!(
            reopened.capture_file_holds(WS.into()).await.unwrap(),
            before
        );
    } else {
        actor
            .set_active_version(
                switch(&scratch, "target", 7),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(actor.capture_file_holds(WS.into()).await.unwrap(), before);
    }
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("file-0000.txt")).unwrap(),
        OUTSIDE
    );
    if target_path.is_empty() {
        assert!(!scratch.path().join("file-0001.txt").exists());
    } else {
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("file-0001.txt")).unwrap(),
            "target\n"
        );
    }
    let actor = supervisor.open(&database, 10).unwrap().actor;
    actor
        .set_active_version(
            switch(&scratch, "main", 11),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(actor.capture_file_holds(WS.into()).await.unwrap(), before);
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("file-0000.txt")).unwrap(),
        OUTSIDE
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("file-0001.txt")).unwrap(),
        "main\n"
    );
    supervisor.close(&database).unwrap();
}

#[tokio::test]
async fn switch_hold_target_rewrite_and_back() {
    preserves_hold("file-0000.txt", false).await;
}
#[tokio::test]
async fn switch_hold_target_delete_and_back() {
    preserves_hold("", false).await;
}
#[tokio::test]
async fn switch_hold_restart_after_switch_commit() {
    preserves_hold("file-0000.txt", true).await;
}
#[tokio::test]
async fn switch_hold_case_alias() {
    preserves_hold("FILE-0000.TXT", false).await;
}

#[tokio::test]
async fn switch_hold_missing_case_alias() {
    let scratch = fixture(2, 1, "FILE-0000.TXT");
    if !scratch.path().join("FILE-0000.TXT").exists() {
        return;
    }
    std::fs::remove_file(scratch.path().join("file-0000.txt")).unwrap();
    let database = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 6).unwrap().actor;
    let before = actor.capture_file_holds(WS.into()).await.unwrap();
    for (version, now) in [("target", 7), ("main", 8)] {
        actor
            .set_active_version(
                switch(&scratch, version, now),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(!scratch.path().join("file-0000.txt").exists());
        assert_eq!(actor.capture_file_holds(WS.into()).await.unwrap(), before);
    }
    supervisor.close(&database).unwrap();
}

/// APFS opens `café` under either Unicode normalization. A switch that
/// writes one spelling must not replace a held file stored under the other.
#[tokio::test]
async fn switch_hold_normalization_alias() {
    let (held, alias) = ("cafe\u{301}.txt", "caf\u{e9}.txt");
    let scratch = ScratchDir::new().unwrap();
    std::fs::write(scratch.path().join(held), OUTSIDE).unwrap();
    if !scratch.path().join(alias).exists() {
        return; // This alias exists only on a normalization-insensitive volume.
    }
    let database = engine_db_path(&scratch).unwrap();
    {
        let mut store = EngineStore::open(&database, 1).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version(WS, "main", 1, &NoFaults)
            .unwrap();
        let object = seed(&mut store, "main", held, "main\n", 2);
        store
            .write_with(&NoFaults, |tx| {
                capture_file_holds::record_in(
                    tx,
                    &CaptureFileHold {
                        workspace_id: WS.into(),
                        source_version_id: "main".into(),
                        object_id: object,
                        path: held.into(),
                        observed_sha256: dohc_engine_storage::hex_sha256(OUTSIDE.as_bytes()),
                        observed_size: OUTSIDE.len() as u64,
                        reason: capture_file_holds::NOT_REPRESENTABLE.into(),
                        observed_at_ms: 3,
                        attempt_count: 1,
                        retry_requested: false,
                    },
                )
            })
            .unwrap();
        VersionedTextStore::new(&mut store)
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: WS.into(),
                    new_version_id: "target".into(),
                    name: "Target".into(),
                    from_version_id: "main".into(),
                    now_ms: 4,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        seed(&mut store, "target", held, "target\n", 5);
        store.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE snapshots SET path=?1 WHERE workspace_id=?2 AND version_id='target' AND path=?3", [alias, WS, held]).map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute("UPDATE path_aliases SET path=?1 WHERE workspace_id=?2 AND version_id='target' AND path=?3", [alias, WS, held]).map_err(dohc_engine_storage::StorageError::persist_public)
        }).unwrap();
    }
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&database, 6).unwrap().actor;
    let before = actor.capture_file_holds(WS.into()).await.unwrap();
    actor
        .set_active_version(
            switch(&scratch, "target", 7),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(actor.capture_file_holds(WS.into()).await.unwrap(), before);
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(held)).unwrap(),
        OUTSIDE
    );
    supervisor.close(&database).unwrap();
}

fn conflict_texts(scratch: &ScratchDir) -> Vec<String> {
    std::fs::read_dir(scratch.path())
        .unwrap()
        .filter_map(|entry| {
            let entry = entry.unwrap();
            entry
                .file_name()
                .to_string_lossy()
                .contains("conflict")
                .then(|| std::fs::read_to_string(entry.path()).unwrap())
        })
        .collect()
}

fn delete_input() -> dohc_engine_domain::DeleteTextFile {
    dohc_engine_domain::DeleteTextFile {
        workspace_id: WS.into(),
        version_id: "main".into(),
        path: "file-0000.txt".into(),
        moment_id: "release-delete".into(),
        request_id: None,
        metadata_origin: "api".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 20,
    }
}

fn sync_delete(store: &mut EngineStore) -> Vec<dohc_engine_sync::MomentMaterializationChange> {
    use dohc_engine_sync::{ApplyDisposition, NoLiveLeases, ReplicationEnvelope};
    let head = VersionedTextStore::new(store)
        .read_text(WS, "main", "file-0000.txt")
        .unwrap()
        .unwrap();
    let envelope = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: WS.into(),
        origin_id: "peer-delete".into(),
        origin_seq: 0,
        relay_seq: Some(1),
        op_kind: "moment.append".into(),
        recorded_at_ms: 20,
        payload: serde_json::json!({
            "momentId":"peer-delete", "versionId":"main", "objectId":head.object_id,
            "objectCreatedAtMs":2, "path":head.path, "recordedAtMs":20, "operation":"delete",
            "payloadBeforeBlobSha256":head.blob_sha256, "payloadBeforePath":head.path,
            "payloadBeforeContentKind":"text", "payloadBeforeByteLength":head.text.len(),
            "payloadAfterBlobSha256":head.blob_sha256,
            "payloadAfterPath":head.path, "payloadAfterContentKind":"text", "payloadAfterByteLength":head.text.len(),
            "metadata":{"origin":"sync", "summary":null, "correlationId":null},
            "beforePresent":"present", "beforeObjectId":head.object_id, "beforeVersionId":"main",
            "beforePath":head.path, "beforeBlobSha256":head.blob_sha256, "beforeContentKind":"text",
            "beforeByteLength":head.text.len(), "beforeUpdatedAtMs":head.updated_at_ms,
            "beforeLatestMomentId":head.latest_moment_id,
            "beforeMetadata":{"origin":"local-file", "summary":head.metadata_summary,
                "correlationId":head.metadata_correlation_id}
        }),
    };
    let result = dohc_engine_sync::apply_moment_envelope_detailed(
        store,
        &envelope,
        &NoFaults,
        &NoLiveLeases,
        &dohc_engine_collab::live_update_application::ReleasedTails::default(),
    )
    .unwrap();
    let ApplyDisposition::Applied(result) = result.primary else {
        panic!("sync delete refused: {result:?}")
    };
    result.materialization_changes
}

async fn release_without_capture(action: &str) {
    let scratch = if action == "rollback" || action == "actor-rollback" {
        let scratch = fixture(0, 0, "");
        let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 5).unwrap();
        let object = seed(&mut store, "main", "file-0000.txt", "main\n", 5);
        seed(&mut store, "target", "file-0000.txt", "target\n", 6);
        store
            .write_with(&NoFaults, |tx| {
                capture_file_holds::record_in(
                    tx,
                    &CaptureFileHold {
                        workspace_id: WS.into(),
                        source_version_id: "main".into(),
                        object_id: object,
                        path: "file-0000.txt".into(),
                        observed_sha256: dohc_engine_storage::hex_sha256(OUTSIDE.as_bytes()),
                        observed_size: OUTSIDE.len() as u64,
                        reason: capture_file_holds::NOT_REPRESENTABLE.into(),
                        observed_at_ms: 7,
                        attempt_count: 1,
                        retry_requested: false,
                    },
                )
            })
            .unwrap();
        std::fs::write(scratch.path().join("file-0000.txt"), OUTSIDE).unwrap();
        scratch
    } else {
        fixture(2, 1, "file-0000.txt")
    };
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 6).unwrap().actor;
    actor
        .set_active_version(
            switch(&scratch, "target", 7),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    supervisor.close(&db).unwrap();
    let mut store = EngineStore::open(&db, 10).unwrap();
    let planned = store
        .list_pending_materialization_jobs()
        .unwrap()
        .into_iter()
        .find(|job| job.target_path == "file-0000.txt" && job.job_id.starts_with("version-switch-"))
        .unwrap();
    assert_eq!(
        planned.preimage,
        dohc_engine_storage::Preimage::Present(dohc_engine_storage::hex_sha256(b"main\n")),
        "a parked switch must authorize only a recorded source head"
    );
    match action {
        "delete" => {
            VersionedTextStore::new(&mut store)
                .delete_text_file(&delete_input(), &NoFaults)
                .unwrap();
        }
        "rename" => {
            VersionedTextStore::new(&mut store)
                .rename_text_file(
                    &dohc_engine_domain::RenameTextFile {
                        workspace_id: WS.into(),
                        version_id: "main".into(),
                        from_path: "file-0000.txt".into(),
                        to_path: "renamed.txt".into(),
                        moment_id: "release-rename".into(),
                        request_id: None,
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 20,
                    },
                    &NoFaults,
                )
                .unwrap();
        }
        "sync" => {
            sync_delete(&mut store);
        }
        "actor-rollback" => {
            let head = VersionedTextStore::new(&mut store)
                .read_text(WS, "main", "file-0000.txt")
                .unwrap()
                .unwrap();
            drop(store);
            let actor = supervisor.open(&db, 20).unwrap().actor;
            actor
                .versioned_text_rollback(
                    dohc_engine_domain::RollbackTextFileMutation {
                        workspace_id: WS.into(),
                        version_id: "main".into(),
                        path: head.path,
                        mutation_moment_id: head.latest_moment_id,
                        request_id: None,
                        metadata_origin: "restore".into(),
                        author_json: None,
                    },
                    scratch.path().into(),
                    Arc::new(()),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            supervisor.close(&db).unwrap();
            store = EngineStore::open(&db, 21).unwrap();
            let job = store
                .load_materialization_job(&planned.job_id)
                .unwrap()
                .unwrap();
            assert_eq!(
                job.preimage, planned.preimage,
                "actor reconcile must retain the parked overwrite authority"
            );
        }
        "rollback" => {
            let head = VersionedTextStore::new(&mut store)
                .read_text(WS, "main", "file-0000.txt")
                .unwrap()
                .unwrap();
            VersionedTextStore::new(&mut store)
                .rollback_text_file_mutation(
                    &dohc_engine_domain::RollbackTextFileMutation {
                        workspace_id: WS.into(),
                        version_id: "main".into(),
                        path: head.path,
                        mutation_moment_id: head.latest_moment_id,
                        request_id: None,
                        metadata_origin: "restore".into(),
                        author_json: None,
                    },
                    &NoFaults,
                )
                .unwrap();
        }
        _ => unreachable!(),
    }
    assert!(
        store
            .read_with(|conn| capture_file_holds::list_in(conn, WS))
            .unwrap()
            .is_empty()
    );
    drop(store);
    let actor = supervisor.open(&db, 21).unwrap().actor;
    actor
        .materialize_replay_pending(scratch.path().to_path_buf(), WS.into(), 22)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("file-0000.txt")).unwrap(),
        OUTSIDE,
        "an orphan release cannot authorize overwriting an unrecorded observation"
    );
    assert_eq!(conflict_texts(&scratch), vec!["target\n".to_owned()]);
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn review_hold_delete_without_capture_preserves_outside() {
    release_without_capture("delete").await;
}
#[tokio::test]
async fn review_hold_rename_without_capture_preserves_outside() {
    release_without_capture("rename").await;
}
#[tokio::test]
async fn review_hold_sync_without_capture_preserves_outside() {
    release_without_capture("sync").await;
}
#[tokio::test]
async fn review_hold_rollback_without_capture_preserves_outside() {
    release_without_capture("rollback").await;
}

#[tokio::test]
async fn review_hold_round_trip_keeps_no_switch_jobs() {
    let scratch = fixture(2, 1, "file-0000.txt");
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 6).unwrap().actor;
    for (version, now) in [("target", 7), ("main", 8)] {
        actor
            .set_active_version(
                switch(&scratch, version, now),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .unwrap();
    }
    supervisor.close(&db).unwrap();
    let store = EngineStore::open(&db, 9).unwrap();
    assert!(
        !store
            .list_pending_materialization_jobs()
            .unwrap()
            .iter()
            .any(|job| job.job_id.starts_with("version-switch-")),
        "returning to the source version must cancel the parked switch intent"
    );
}

#[tokio::test]
async fn review_hold_ancestor_does_not_fail_switch() {
    let scratch = fixture(2, 1, "file-0000.txt/trip.md");
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 6).unwrap().actor;
    actor
        .set_active_version(
            switch(&scratch, "target", 7),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("file-0000.txt")).unwrap(),
        OUTSIDE
    );
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn review_active_sync_delete_keeps_unrecorded_hold_bytes() {
    let scratch = fixture(2, 1, "file-0000.txt");
    let db = engine_db_path(&scratch).unwrap();
    let changes = {
        let mut store = EngineStore::open(&db, 6).unwrap();
        sync_delete(&mut store)
    };
    assert_eq!(changes.len(), 1);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 21).unwrap().actor;
    // A refusal is acceptable; deleting the unrecorded bytes is not.
    let _ = actor
        .materialize_relay_page(
            WS.into(),
            scratch.path().to_path_buf(),
            changes,
            Arc::new(()),
            22,
            CancellationToken::new(),
        )
        .await;
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("file-0000.txt")).unwrap(),
        OUTSIDE
    );
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn review_new_hold_uses_an_absent_preimage() {
    let scratch = fixture(2, 1, "file-0000.txt");
    let db = engine_db_path(&scratch).unwrap();
    {
        let mut store = EngineStore::open(&db, 6).unwrap();
        store.write_with(&NoFaults, |tx| tx.execute("DELETE FROM snapshots WHERE workspace_id=?1 AND version_id='main' AND path='file-0000.txt'", [WS]).map_err(dohc_engine_storage::StorageError::persist_public)).unwrap();
    }
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 7).unwrap().actor;
    actor
        .set_active_version(
            switch(&scratch, "target", 8),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    supervisor.close(&db).unwrap();
    let store = EngineStore::open(&db, 9).unwrap();
    let job = store
        .list_pending_materialization_jobs()
        .unwrap()
        .into_iter()
        .find(|job| job.target_path == "file-0000.txt")
        .unwrap();
    assert_eq!(job.preimage, dohc_engine_storage::Preimage::Absent);
}

/// Drive two release test binaries alternately through stdin. Both directions
/// are timed, with each paired fixture at the same version before each switch.
#[tokio::test]
#[ignore = "interactive release benchmark"]
async fn switch_hold_interactive_cost() {
    use std::io::{BufRead, Write};
    let counts: Vec<usize> = std::env::var("SWITCH_HOLD_COUNTS")
        .unwrap_or_else(|_| "0,1,100".into())
        .split(',')
        .map(|value| value.parse().unwrap())
        .collect();
    let supervisor = WorkspaceSupervisor::new();
    let mut fixtures = Vec::new();
    for count in counts {
        let scratch = fixture(1000, count, "file-0000.txt");
        let database = engine_db_path(&scratch).unwrap();
        let actor = supervisor.open(&database, 6).unwrap().actor;
        fixtures.push((count, scratch, database, actor, false));
    }
    println!("BENCH_READY");
    std::io::stdout().flush().unwrap();
    for (now, line) in (7..).zip(std::io::stdin().lock().lines()) {
        let line = line.unwrap();
        if line == "stop" {
            break;
        }
        let index: usize = line.parse().unwrap();
        let (_, scratch, _, actor, at_target) = &mut fixtures[index];
        let version = if *at_target { "main" } else { "target" };
        let started = std::time::Instant::now();
        actor
            .set_active_version(
                switch(scratch, version, now),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        *at_target = !*at_target;
        println!("BENCH_SAMPLE {index} {elapsed:.6}");
        std::io::stdout().flush().unwrap();
    }
    for (_, _, database, _, _) in &fixtures {
        supervisor.close(database).unwrap();
    }
}

#[test]
#[ignore = "release benchmark for the indexed hold snapshot"]
fn switch_hold_indexed_read_cost() {
    for count in [0, 1, 100] {
        let scratch = fixture(1000, count, "file-0000.txt");
        let store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 6).unwrap();
        let mut samples = Vec::new();
        for sample in 0..24 {
            let start = std::time::Instant::now();
            for _ in 0..1000 {
                std::hint::black_box(dohc_engine_files::PlacementHolds::load(&store, WS).unwrap());
            }
            let elapsed_us = start.elapsed().as_secs_f64() * 1000.0;
            if sample >= 3 {
                samples.push(elapsed_us);
            }
        }
        println!("HOLD_LOOKUP held={count} samples_us={samples:?}");
        samples.sort_by(f64::total_cmp);
        println!(
            "HOLD_LOOKUP held={count} median_us={:.6} p95_us={:.6}",
            samples[10], samples[19]
        );
    }
}

#[tokio::test]
async fn review2_relay_keeps_recorded_hold_preimage() {
    let scratch = fixture(2, 1, "file-0000.txt");
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 6).unwrap().actor;
    actor
        .set_active_version(
            switch(&scratch, "target", 7),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    supervisor.close(&db).unwrap();
    {
        let mut store = EngineStore::open(&db, 8).unwrap();
        seed(&mut store, "target", "file-0000.txt", "Relay target.\n", 8);
    }
    let actor = supervisor.open(&db, 9).unwrap().actor;
    actor
        .materialize_relay_page(
            WS.into(),
            scratch.path().into(),
            vec![dohc_engine_sync::MomentMaterializationChange {
                version_id: "target".into(),
                path: "file-0000.txt".into(),
                operation: "write",
                content_kind: "text",
            }],
            Arc::new(()),
            10,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    supervisor.close(&db).unwrap();
    let mut store = EngineStore::open(&db, 11).unwrap();
    let jobs: Vec<_> = store
        .list_pending_materialization_jobs()
        .unwrap()
        .into_iter()
        .filter(|job| {
            job.target_path == "file-0000.txt" && job.job_id.starts_with("version-switch-")
        })
        .collect();
    assert!(!jobs.is_empty());
    for job in &jobs {
        assert_eq!(
            job.preimage,
            dohc_engine_storage::Preimage::Present(dohc_engine_storage::hex_sha256(b"main\n"))
        );
    }
    assert_eq!(
        jobs.len(),
        1,
        "relay must keep only its latest parked intent"
    );
    VersionedTextStore::new(&mut store)
        .delete_text_file(&delete_input(), &NoFaults)
        .unwrap();
    drop(store);
    let actor = supervisor.open(&db, 21).unwrap().actor;
    actor
        .materialize_replay_pending(scratch.path().into(), WS.into(), 22)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("file-0000.txt")).unwrap(),
        OUTSIDE
    );
    assert_eq!(conflict_texts(&scratch), vec!["Relay target.\n".to_owned()]);
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn review2_inactive_actor_rollback_keeps_outside_bytes() {
    release_without_capture("actor-rollback").await;
}

#[tokio::test]
async fn review3_case_alias_switch_places_selected_bytes_without_conflicts() {
    let scratch = fixture(0, 0, "");
    std::fs::write(scratch.path().join("Notes.md"), "p\n").unwrap();
    if !scratch.path().join("notes.md").exists() {
        return; // This alias exists only on a case-insensitive filesystem.
    }
    let db = engine_db_path(&scratch).unwrap();
    {
        let mut store = EngineStore::open(&db, 2).unwrap();
        seed(&mut store, "main", "Notes.md", "p\n", 2);
        seed(&mut store, "target", "notes.md", "X\n", 5);
    }
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 6).unwrap().actor;
    actor
        .set_active_version(
            switch(&scratch, "target", 7),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("notes.md")).unwrap(),
        "X\n"
    );
    assert!(conflict_texts(&scratch).is_empty());
    supervisor.close(&db).unwrap();
}
