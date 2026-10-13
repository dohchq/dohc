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
#[cfg(windows)]
#[tokio::test]
async fn switch_hold_windows_case_alias() {
    preserves_hold("FILE-0000.TXT", false).await;
}

#[cfg(windows)]
#[tokio::test]
async fn switch_hold_missing_windows_case_alias() {
    let scratch = fixture(2, 1, "FILE-0000.TXT");
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
