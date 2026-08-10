//! #738/#739 follow-up (codex P1, PR #747): `cancel_pending_jobs_for_path`
//! must not cancel a PRIOR pending DELETE job for the same path -- only a
//! superseded WRITE. A delete -> recreate -> delete sequence, each blocked
//! from reaching disk, otherwise strands the original bytes: the old delete
//! (the only one whose preimage matches disk) gets cancelled, and the newest
//! delete's preimage no longer matches the untouched disk bytes, so replay
//! conflicts instead of clearing the path -- the old file survives on disk at
//! a path the user deleted twice.

use dohc_engine_domain::{DeleteTextFile, WriteBinary};
use dohc_engine_runtime::{CancellationToken, NoFaults, SelfWriteRecorder, WorkspaceSupervisor};
use dohc_engine_storage::FaultPoint;
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use std::sync::Arc;

struct NoRecorder;

impl SelfWriteRecorder for NoRecorder {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

fn binary_input(
    object_id: &str,
    moment_id: &str,
    request_id: &str,
    bytes: Vec<u8>,
    now_ms: i64,
) -> WriteBinary {
    WriteBinary {
        workspace_id: "ws-delete-cancel-scope".to_owned(),
        version_id: "main".to_owned(),
        object_id: object_id.to_owned(),
        path: "asset.bin".to_owned(),
        bytes,
        moment_id: moment_id.to_owned(),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: Some(request_id.to_owned()),
    }
}

fn delete_input(moment_id: &str, request_id: &str, now_ms: i64) -> DeleteTextFile {
    DeleteTextFile {
        workspace_id: "ws-delete-cancel-scope".to_owned(),
        version_id: "main".to_owned(),
        path: "asset.bin".to_owned(),
        moment_id: moment_id.to_owned(),
        request_id: Some(request_id.to_owned()),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
    }
}

/// delete -> recreate -> delete, each blocked from reaching disk by a
/// one-shot post-commit materialize crash, then unblocked (a fresh actor over
/// the same db replays every pending job with no faults -- the daemon-restart
/// shape).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_delete_does_not_strand_the_first_deletes_own_pending_job() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let target = scratch.path().join("asset.bin");

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;

    // v1 materializes cleanly: disk holds B0.
    actor
        .versioned_binary_write(
            binary_input("obj-v1", "moment-v1", "req-v1", vec![1, 1, 1], 10),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("v1 write committed");
    assert_eq!(std::fs::read(&target).expect("v1 on disk"), vec![1, 1, 1]);

    // Delete #1: commits (preimage = B0), but its post-commit materialize is
    // blocked (simulating a file lock) -- job D1 stays PENDING, disk still B0.
    actor
        .versioned_text_delete(
            delete_input("moment-delete-1", "req-delete-1", 20),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit),
            CancellationToken::new(),
        )
        .await
        .expect("delete #1 committed");
    assert_eq!(
        std::fs::read(&target).expect("still B0 on disk after blocked delete"),
        vec![1, 1, 1]
    );

    // Recreate at the same path with B1: commits, but its post-commit
    // materialize is ALSO blocked -- job W stays PENDING, disk still B0.
    actor
        .versioned_binary_write(
            binary_input("obj-v2", "moment-v2", "req-v2", vec![2, 2, 2], 30),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit),
            CancellationToken::new(),
        )
        .await
        .expect("recreate committed");
    assert_eq!(
        std::fs::read(&target).expect("still B0 on disk after blocked recreate"),
        vec![1, 1, 1]
    );

    // Delete #2: `cancel_pending_jobs_for_path` fires here. Commits (preimage
    // = B1, the DB's current head), and is ALSO blocked from disk.
    actor
        .versioned_text_delete(
            delete_input("moment-delete-2", "req-delete-2", 40),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit),
            CancellationToken::new(),
        )
        .await
        .expect("delete #2 committed");

    supervisor.close(&db).expect("close before restart");

    // "Unlock" + restart: a fresh actor over the same db replays every
    // pending job with no faults, exactly like a daemon restart.
    let restarted = WorkspaceSupervisor::new();
    let restarted_actor = restarted.open(&db, 1000).expect("reopen actor").actor;
    restarted_actor
        .materialize_replay_pending(
            scratch.path().to_path_buf(),
            "ws-delete-cancel-scope".to_owned(),
            1000,
        )
        .await
        .expect("replay pending jobs");

    // The path was deleted twice; nothing must survive on disk, and no stale
    // B0 bytes may resurrect under a job nothing will ever revisit.
    assert!(
        !target.exists(),
        "a path deleted twice must not survive replay: {:?}",
        std::fs::read(&target)
    );

    restarted.close(&db).expect("close after replay");
}
