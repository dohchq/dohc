use super::*;
use dohc_engine_runtime::WorkspaceSupervisor;
use dohc_engine_storage::{EngineStore, MaterializationJobSpec, Preimage, enqueue_job};
use dohc_engine_testkit::ScratchDir;

const WORKSPACE_ID: &str = "ws-selected-recovery-replay";
const RECOVERY_PATH: &str = "notes/recovered.md";
const RECOVERY_JOB: &str = "sync-mat_ydoc-recovery-moment-selected";
const UNRELATED_PATH: &str = "unrelated.md";
const UNRELATED_JOB: &str = "unrelated-older-pending";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recovery_replay_ignores_an_older_unrelated_failing_pending_job() {
    let scratch = ScratchDir::new().expect("scratch");
    std::fs::write(scratch.path().join(UNRELATED_PATH), b"external occupant")
        .expect("unrelated occupant");
    let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine database path");
    let mut store = EngineStore::open(&db, 1).expect("open fixture store");
    let unrelated_sha = store
        .put_binary_blob(b"unrelated intended bytes")
        .expect("unrelated blob");
    let recovery_sha = store
        .put_binary_blob(b"recovered lineage")
        .expect("recovery blob");
    store
        .write_with(&NoFaults, |tx| {
            enqueue_job(
                tx,
                &MaterializationJobSpec {
                    job_id: UNRELATED_JOB.to_owned(),
                    workspace_id: WORKSPACE_ID.to_owned(),
                    target_path: UNRELATED_PATH.to_owned(),
                    content_sha256: unrelated_sha.clone(),
                    preimage: Preimage::Absent,
                    target_generation: 1,
                    now_ms: 1,
                },
            )?;
            enqueue_job(
                tx,
                &MaterializationJobSpec {
                    job_id: RECOVERY_JOB.to_owned(),
                    workspace_id: WORKSPACE_ID.to_owned(),
                    target_path: RECOVERY_PATH.to_owned(),
                    content_sha256: recovery_sha.clone(),
                    preimage: Preimage::Absent,
                    target_generation: 2,
                    now_ms: 2,
                },
            )?;
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .expect("seed pending jobs");
    drop(store);

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).expect("open actor").actor;
    let paths = materialize_ydoc_recoveries(
        scratch.path(),
        &actor,
        WORKSPACE_ID,
        &SelfWriteSuppression::default(),
        4,
        vec![dohc_engine_sync::YdocRecoveryMaterialization {
            path: RECOVERY_PATH.to_owned(),
            materialization_job_id: RECOVERY_JOB.to_owned(),
        }],
    )
    .await
    .expect("selected recovery materializes");
    assert_eq!(paths, vec![RECOVERY_PATH]);
    assert_eq!(
        std::fs::read(scratch.path().join(RECOVERY_PATH)).expect("recovery bytes"),
        b"recovered lineage"
    );
    assert_eq!(
        std::fs::read(scratch.path().join(UNRELATED_PATH)).expect("unrelated bytes"),
        b"external occupant",
        "selected recovery replay must not touch an unrelated target"
    );

    let read_only = EngineStore::open_read_only(&db).expect("open read-only store");
    let statuses: (String, String) = read_only
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT status FROM materialization_jobs WHERE job_id=?1",
                    [RECOVERY_JOB],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT status FROM materialization_jobs WHERE job_id=?1",
                    [UNRELATED_JOB],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("materialization statuses");
    assert_eq!(statuses, ("complete".to_owned(), "pending".to_owned()));
    supervisor.close(&db).expect("close actor");
}
