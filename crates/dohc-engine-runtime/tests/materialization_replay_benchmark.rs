use dohc_engine_domain::VersionedTextStore;
use dohc_engine_runtime::WorkspaceSupervisor;
use dohc_engine_storage::{
    EngineStore, MaterializationJobSpec, NoFaults, Preimage, StorageError, enqueue_delete_job,
    hex_sha256,
};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use rusqlite::params;
use std::time::Instant;

// Run explicitly with --ignored --nocapture; fixture creation is outside the timer.
#[tokio::test]
#[ignore = "replay scaling benchmark: 1,000 real deletes at 0 and 20,000 live paths"]
async fn alias_free_delete_replay_scaling() {
    const WS: &str = "replay-benchmark";
    const DELETES: usize = 1_000;
    for active_paths in [0, 20_000] {
        for sample in 0..3 {
            let root = ScratchDir::new().unwrap();
            let db = engine_db_path(&root).unwrap();
            let mut store = EngineStore::open(&db, 1).unwrap();
            VersionedTextStore::new(&mut store)
                .ensure_main_version(WS, "main", 1, &NoFaults)
                .unwrap();
            let sha = hex_sha256(b"old");
            store.write_with(&NoFaults, |tx| {
                tx.execute("INSERT INTO blobs(sha256,byte_length,text) VALUES (?1,3,'old')", [&sha])
                    .map_err(StorageError::persist_public)?;
                for n in 0..active_paths {
                    let object = format!("live-{n}");
                    let path = format!("live-{n}.md");
                    tx.execute("INSERT INTO file_objects(workspace_id,object_id,created_at_ms) VALUES (?1,?2,1)",params![WS,object])
                        .map_err(StorageError::persist_public)?;
                    tx.execute("INSERT INTO path_aliases(workspace_id,version_id,path,object_id) VALUES (?1,'main',?2,?3)",params![WS,path,object])
                        .map_err(StorageError::persist_public)?;
                    tx.execute("INSERT INTO snapshots(workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin) VALUES (?1,'main',?2,?3,?4,1,'fixture','api')",params![WS,object,path,sha])
                        .map_err(StorageError::persist_public)?;
                }
                for n in 0..DELETES {
                    enqueue_delete_job(tx, &MaterializationJobSpec {
                        job_id: format!("benchmark-delete-{n:04}"),
                        workspace_id: WS.into(),
                        target_path: format!("deleted-{n}.md"),
                        content_sha256: sha.clone(),
                        preimage: Preimage::Present(sha.clone()),
                        target_generation: 1,
                        now_ms: 2,
                    })?;
                }
                Ok::<_, StorageError>(())
            }).unwrap();
            drop(store);
            for n in 0..DELETES {
                std::fs::write(root.join(format!("deleted-{n}.md")), "old").unwrap();
            }
            let supervisor = WorkspaceSupervisor::new();
            let actor = supervisor.open(&db, 3).unwrap().actor;
            let start = Instant::now();
            let completed = actor
                .materialize_replay_pending(root.path().into(), WS.into(), 3)
                .await
                .unwrap();
            let elapsed = start.elapsed();
            assert_eq!(completed, DELETES);
            supervisor.close(&db).unwrap();
            assert!(!root.join("deleted-0.md").exists());
            println!(
                "replay_benchmark active_paths={active_paths} deletes={DELETES} sample={sample} elapsed_ms={:.3}",
                elapsed.as_secs_f64() * 1000.0
            );
        }
    }
}
