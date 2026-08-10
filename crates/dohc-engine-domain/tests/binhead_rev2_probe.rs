//! BINHEAD (rev2) permanent regressions, ported from the convergence reviewer's
//! adversarial probes. They exercise the binary-head-as-real-head claim end to
//! end: M2 same-path generation supersede against the REAL materializer, and
//! binary-head round-trips through history/rollback. The same-path supersede
//! test is the load-bearing proof for the whole shard.

use dohc_engine_domain::{
    EngineStore, NoFaults, RollbackTextFileMutation, VersionedTextStore, WriteBinaryFile,
    WriteText, binary_rollback_job_identity, write_binary_file_in_tx,
};
use dohc_engine_files::{DurabilityPolicy, JobOutcome, NoBackoff, StdReplacer, run_pending_jobs};
use dohc_engine_storage::{
    FaultPoint, MaterializationJobSpec, Preimage, StorageError, enqueue_job, hex_sha256,
    put_binary_blob,
};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use rusqlite::params;

const WS: &str = "binhead-rev2";

fn open() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let mut store = EngineStore::open(&db, 1).expect("open");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", 1, &NoFaults)
        .expect("main version");
    (scratch, store)
}

fn write_binary(
    store: &mut EngineStore,
    object_id: &str,
    path: &str,
    bytes: &[u8],
    job: &str,
    now: i64,
) -> String {
    let sha = hex_sha256(bytes);
    store
        .write_with(&NoFaults, |tx| {
            put_binary_blob(tx, bytes).map_err(dohc_engine_domain::DomainError::from)?;
            write_binary_file_in_tx(
                tx,
                &WriteBinaryFile {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    object_id: object_id.to_owned(),
                    path: path.to_owned(),
                    binary_sha256: sha.clone(),
                    moment_id: job.to_owned(),
                    metadata_origin: "sync".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    materialize: Some(Preimage::Absent),
                    now_ms: now,
                },
            )
        })
        .expect("write binary head");
    sha
}

fn moment_order(store: &EngineStore, moment_id: &str) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT moment_order FROM moments WHERE moment_id = ?1",
                params![moment_id],
                |r| r.get(0),
            )
        })
        .expect("moment order")
}

/// M2, SAME PATH (the real supersede scenario — the shipped un-ignored test only
/// checks a DIFFERENT path). A binary head at doc.md must consume a moment
/// generation STRICTLY LESS than a subsequent same-path text write, so the
/// materializer's `done_gen > target_generation` newest-wins gate supersedes the
/// older binary when the binary job drains AFTER the newer text job.
#[test]
fn m2_same_path_binary_gen_is_strictly_below_next_text_and_is_superseded() {
    let (scratch, mut store) = open();
    // Binary head first (older generation). Give it a LATE recorded_at so its
    // materialization job sorts AFTER the text job in the drain — modelling the
    // delayed/retried binary drain the M2 bug needed.
    let binary_sha = write_binary(
        &mut store,
        "obj-doc",
        "doc.md",
        b"\x00binary bytes\xff",
        "bin-job",
        100,
    );
    let binary_gen = moment_order(&store, "bin-job");

    // Same-path text write reuses the object; newer generation.
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                object_id: "obj-doc".to_owned(),
                path: "doc.md".to_owned(),
                text: "the newer text".to_owned(),
                moment_id: "text-moment".to_owned(),
                metadata_origin: "user".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 50,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("same-path text write");
    let text_gen = moment_order(&store, "text-moment");

    assert!(
        binary_gen < text_gen,
        "M2: binary gen {binary_gen} must be STRICTLY below same-path text gen {text_gen}"
    );

    // Enqueue the text materialization job at its real generation. Preimage
    // Absent so the drive isolates the generation gate (no preimage confounder).
    let text_bytes = b"the newer text";
    store
        .write_with(&NoFaults, |tx| {
            let sha = put_binary_blob(tx, text_bytes)?;
            enqueue_job(
                tx,
                &MaterializationJobSpec {
                    job_id: "text-job".to_owned(),
                    workspace_id: WS.to_owned(),
                    target_path: "doc.md".to_owned(),
                    content_sha256: sha,
                    preimage: Preimage::Absent,
                    target_generation: text_gen,
                    now_ms: 50,
                },
            )?;
            Ok::<_, StorageError>(())
        })
        .expect("enqueue text job");

    // Drain: text (created_at 50) runs first and wins the path; the older binary
    // (created_at 100) then drains and MUST be superseded (outcome Superseded,
    // not Conflict — if generations had collided the gate would miss and the
    // binary would fall through to a preimage Conflict instead).
    let results = run_pending_jobs(
        &store,
        scratch.path(),
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        200,
        &NoFaults,
    )
    .expect("drain");

    let binary_outcome = results
        .iter()
        .find(|r| r.job_id == "bin-job")
        .map(|r| r.outcome)
        .expect("binary job ran");
    assert_eq!(
        binary_outcome,
        JobOutcome::Superseded,
        "the older binary job must be superseded by the newer same-path text generation"
    );

    let on_disk = std::fs::read(scratch.path().join("doc.md")).expect("read doc.md");
    assert_eq!(
        on_disk, text_bytes,
        "the path must hold the newer text, not the superseded binary bytes"
    );
    let _ = binary_sha;
}

/// Round-trip: a text write OVER a binary head, then rolling that text moment
/// back, must restore the binary head exactly (content_kind='binary', the
/// original binary sha, empty text), reconstructing the binary preimage from the
/// moment's before_binary_sha256.
#[test]
fn rollback_text_over_binary_restores_the_binary_head() {
    let (_scratch, mut store) = open();
    let binary_sha = write_binary(
        &mut store,
        "obj-doc",
        "doc.md",
        b"\x00original binary\xff",
        "bin-job",
        10,
    );

    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                object_id: "obj-doc".to_owned(),
                path: "doc.md".to_owned(),
                text: "text over binary".to_owned(),
                moment_id: "text-moment".to_owned(),
                metadata_origin: "user".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 20,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("text over binary");

    // Confirm the text moment recorded a BINARY preimage.
    let (before_kind, before_bin): (String, Option<String>) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT before_content_kind, before_binary_sha256 FROM moments \
                 WHERE moment_id = 'text-moment'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .expect("text moment preimage");
    assert_eq!(before_kind, "binary");
    assert_eq!(before_bin.as_deref(), Some(binary_sha.as_str()));

    // Roll the text moment back.
    VersionedTextStore::new(&mut store)
        .rollback_text_file_mutation(
            &RollbackTextFileMutation {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: "doc.md".to_owned(),
                mutation_moment_id: "text-moment".to_owned(),
                request_id: None,
                legacy_before_text: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            &NoFaults,
        )
        .expect("rollback text over binary");

    // The restored head must be the original binary head.
    let (kind, blob_sha, bin_sha): (String, Option<String>, Option<String>) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT content_kind, blob_sha256, binary_sha256 FROM snapshots \
                 WHERE workspace_id = ?1 AND version_id = 'main' AND path = 'doc.md'",
                [WS],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
        })
        .expect("restored snapshot");
    assert_eq!(kind, "binary", "the restored head must be binary");
    assert_eq!(blob_sha, None, "a binary head has no text blob");
    assert_eq!(bin_sha.as_deref(), Some(binary_sha.as_str()));

    // S1 regression: the text-only read surface must NOT serve the restored
    // binary head as an empty text document — it fails closed instead, so a
    // caller can never silently overwrite it as if it were blank text.
    let err = VersionedTextStore::new(&mut store)
        .read_text(WS, "main", "doc.md")
        .expect_err("a binary head must not read back as empty text");
    assert_eq!(err.code(), "binary-head-not-text");
}

/// Rolling back a FIRST binary write (no preimage) removes the file and GCs the
/// object — the binary head is not left as a phantom absent-text snapshot.
///
/// M1: the write also enqueued a durable materialization job. Rollback must
/// cancel it, so DRAINING the materializer afterward leaves NO file on disk. The
/// pre-M1 code left the pending job, and the drain resurrected the rolled-back
/// bytes onto disk while the DB said the path was absent.
#[test]
fn rollback_first_binary_write_removes_file_and_object() {
    let (scratch, mut store) = open();
    write_binary(
        &mut store,
        "obj-doc",
        "doc.md",
        b"\x00first binary\xff",
        "bin-job",
        10,
    );

    VersionedTextStore::new(&mut store)
        .rollback_text_file_mutation(
            &RollbackTextFileMutation {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: "doc.md".to_owned(),
                mutation_moment_id: "bin-job".to_owned(),
                request_id: None,
                legacy_before_text: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            &NoFaults,
        )
        .expect("rollback first binary write");

    // M1: the rolled-back mutation's ORIGINAL job must be cancelled so it can
    // never re-materialize the rolled-back bytes. A compensating restore job is
    // enqueued unconditionally (a harmless no-op here, since the bytes never
    // reached disk in this pending-no-drain case).
    let restore_job_id = binary_rollback_job_identity(WS, "main", "bin-job");
    let (orig, restore): (i64, i64) = store
        .read_with(|conn| {
            let o: i64 = conn.query_row(
                "SELECT COUNT(*) FROM materialization_jobs WHERE job_id = 'bin-job'",
                [],
                |r| r.get(0),
            )?;
            let r: i64 = conn.query_row(
                "SELECT COUNT(*) FROM materialization_jobs \
                 WHERE job_id = ?1 AND status = 'pending'",
                [restore_job_id],
                |r| r.get(0),
            )?;
            Ok::<_, rusqlite::Error>((o, r))
        })
        .expect("job counts");
    assert_eq!(orig, 0, "the original binary job must be cancelled");
    assert_eq!(restore, 1, "a compensating restore job must be enqueued");

    // DISK-STATE proof: draining the materializer must NOT resurrect the file.
    run_pending_jobs(
        &store,
        scratch.path(),
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        200,
        &NoFaults,
    )
    .expect("drain after rollback");
    assert!(
        !scratch.path().join("doc.md").exists(),
        "M1: no file may be resurrected onto disk after rolling back a binary write"
    );

    let (snap_count, obj_count, compensation_count): (i64, i64, i64) = store
        .read_with(|conn| {
            let s: i64 = conn.query_row(
                "SELECT COUNT(*) FROM snapshots WHERE workspace_id = ?1 AND path = 'doc.md'",
                [WS],
                |r| r.get(0),
            )?;
            let o: i64 = conn.query_row(
                "SELECT COUNT(*) FROM file_objects WHERE object_id = 'obj-doc'",
                [],
                |r| r.get(0),
            )?;
            let c: i64 = conn.query_row(
                "SELECT COUNT(*) FROM moments \
                 WHERE workspace_id = ?1 AND object_id = 'obj-doc' AND operation = 'delete'",
                [WS],
                |r| r.get(0),
            )?;
            Ok::<_, rusqlite::Error>((s, o, c))
        })
        .expect("counts");
    assert_eq!(snap_count, 0, "the binary snapshot must be gone");
    assert_eq!(
        obj_count, 1,
        "the compensating delete moment keeps its historical object"
    );
    assert_eq!(
        compensation_count, 1,
        "rollback must append one compensating delete moment"
    );

    let view = VersionedTextStore::new(&mut store)
        .read_text(WS, "main", "doc.md")
        .expect("read");
    assert!(
        view.is_none(),
        "the path must read as absent after rollback"
    );
}

/// M1 COMPLETED-job half: rolling back a first binary write whose materialization
/// job ALREADY drained to disk must reconcile disk with the absent DB head. The
/// pending-cancel fix alone left disk holding the rolled-back bytes while the DB
/// said absent; the rollback must enqueue a compensating DELETE so a later drain
/// removes the file. Proven against DISK, not just DB.
#[test]
fn rollback_of_completed_binary_write_deletes_the_materialized_file() {
    let (scratch, mut store) = open();
    write_binary(
        &mut store,
        "obj-doc",
        "doc.md",
        b"\x00materialized binary\xff",
        "bin-job",
        10,
    );

    // Drain FIRST so the binary write is really on disk and its job is COMPLETE.
    run_pending_jobs(
        &store,
        scratch.path(),
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        50,
        &NoFaults,
    )
    .expect("drain write to disk");
    assert!(
        scratch.path().join("doc.md").exists(),
        "the binary write must be materialized on disk before rollback"
    );

    // Roll the completed binary write back.
    VersionedTextStore::new(&mut store)
        .rollback_text_file_mutation(
            &RollbackTextFileMutation {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: "doc.md".to_owned(),
                mutation_moment_id: "bin-job".to_owned(),
                request_id: None,
                legacy_before_text: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            &NoFaults,
        )
        .expect("rollback completed binary write");

    // A compensating job must be pending (the original completed job is not
    // replayed; a NEW delete job restores disk).
    let pending: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM materialization_jobs WHERE status = 'pending'",
                [],
                |r| r.get(0),
            )
        })
        .expect("pending job count");
    assert_eq!(
        pending, 1,
        "rollback of a completed write must enqueue a compensating job"
    );

    // DISK-STATE proof: draining removes the resurrected file so disk matches the
    // absent DB head.
    run_pending_jobs(
        &store,
        scratch.path(),
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        60,
        &NoFaults,
    )
    .expect("drain compensating delete");
    assert!(
        !scratch.path().join("doc.md").exists(),
        "M1: disk must match the rolled-back absent head, not keep the binary bytes"
    );

    let view = VersionedTextStore::new(&mut store)
        .read_text(WS, "main", "doc.md")
        .expect("read");
    assert!(view.is_none(), "the DB head must be absent after rollback");
}

/// M1 COMPLETED-job half, OVERWRITE branch: rolling back a binary write that
/// overwrote a PREVIOUS binary head, after both reached disk, must restore disk
/// to the PREVIOUS content (not leave the rolled-back bytes). Exercises the
/// compensating WRITE (restore-previous) branch, not just the delete branch.
#[test]
fn rollback_of_completed_binary_overwrite_restores_previous_content_on_disk() {
    let (scratch, mut store) = open();
    let prev_bytes = b"\x00previous binary\xff".as_slice();
    let prev_sha = write_binary(&mut store, "obj-doc", "doc.md", prev_bytes, "bin-job-1", 10);
    // Overwrite with new binary content at the same path/object. A real overwrite
    // carries the previous content as its preimage so the materializer replaces it
    // on disk (rather than conflict-preserving as an unexpected external write).
    let newer_bytes = b"\x00newer binary\xff".as_slice();
    let newer_sha = hex_sha256(newer_bytes);
    store
        .write_with(&NoFaults, |tx| {
            put_binary_blob(tx, newer_bytes).map_err(dohc_engine_domain::DomainError::from)?;
            write_binary_file_in_tx(
                tx,
                &WriteBinaryFile {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "obj-doc".to_owned(),
                    path: "doc.md".to_owned(),
                    binary_sha256: newer_sha,
                    moment_id: "bin-job-2".to_owned(),
                    metadata_origin: "sync".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    materialize: Some(Preimage::Present(prev_sha.clone())),
                    now_ms: 20,
                },
            )
        })
        .expect("overwrite binary head");

    // Drain both writes to disk; the newest content wins the path.
    run_pending_jobs(
        &store,
        scratch.path(),
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        50,
        &NoFaults,
    )
    .expect("drain writes to disk");
    assert_eq!(
        std::fs::read(scratch.path().join("doc.md")).expect("read doc.md"),
        b"\x00newer binary\xff",
        "disk must hold the newer binary before rollback"
    );

    // Roll the overwrite back → head restored to the previous binary content.
    VersionedTextStore::new(&mut store)
        .rollback_text_file_mutation(
            &RollbackTextFileMutation {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: "doc.md".to_owned(),
                mutation_moment_id: "bin-job-2".to_owned(),
                request_id: None,
                legacy_before_text: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            &NoFaults,
        )
        .expect("rollback completed binary overwrite");

    // Drain the compensating restore → disk holds the PREVIOUS content again.
    run_pending_jobs(
        &store,
        scratch.path(),
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        60,
        &NoFaults,
    )
    .expect("drain compensating restore");
    assert_eq!(
        std::fs::read(scratch.path().join("doc.md")).expect("read doc.md"),
        prev_bytes,
        "M1: disk must be restored to the previous binary content after rollback"
    );

    // The DB head matches: previous binary sha.
    let (kind, bin): (String, Option<String>) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT content_kind, binary_sha256 FROM snapshots \
                 WHERE workspace_id = ?1 AND version_id = 'main' AND path = 'doc.md'",
                [WS],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .expect("restored head");
    assert_eq!(kind, "binary");
    assert_eq!(bin.as_deref(), Some(prev_sha.as_str()));
}

/// Finding 2 (hardening): a TEXT rollback must NEVER touch a materialization job
/// that merely shares the mutation moment id. The disk-reconciliation path runs
/// ONLY for a binary WRITE moment (and only against a job whose content matches
/// this write's bytes), so an unrelated same-id job survives untouched — a text
/// mutation cannot cancel or compensate against it.
#[test]
fn text_rollback_does_not_touch_a_materialization_job_with_the_same_id() {
    let (_scratch, mut store) = open();
    // A pre-existing pending materialization job whose id collides with the text
    // write's moment id below.
    let other_bytes = b"\x00unrelated\xff".as_slice();
    store
        .write_with(&NoFaults, |tx| {
            let sha = put_binary_blob(tx, other_bytes)?;
            enqueue_job(
                tx,
                &MaterializationJobSpec {
                    job_id: "text-moment".to_owned(),
                    workspace_id: WS.to_owned(),
                    target_path: "unrelated.bin".to_owned(),
                    content_sha256: sha,
                    preimage: Preimage::Absent,
                    target_generation: 1,
                    now_ms: 5,
                },
            )?;
            Ok::<_, StorageError>(())
        })
        .expect("enqueue unrelated job");

    // A text write whose moment id equals the unrelated job id.
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                object_id: "obj-doc".to_owned(),
                path: "doc.md".to_owned(),
                text: "hello".to_owned(),
                moment_id: "text-moment".to_owned(),
                metadata_origin: "user".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("text write");

    // Roll the TEXT write back.
    VersionedTextStore::new(&mut store)
        .rollback_text_file_mutation(
            &RollbackTextFileMutation {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: "doc.md".to_owned(),
                mutation_moment_id: "text-moment".to_owned(),
                request_id: None,
                legacy_before_text: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            &NoFaults,
        )
        .expect("rollback text write");

    // The unrelated job must be untouched (still pending, same target).
    let (status, target): (String, String) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT status, target_path FROM materialization_jobs WHERE job_id = 'text-moment'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .expect("job still present");
    assert_eq!(status, "pending", "the unrelated job must remain pending");
    assert_eq!(
        target, "unrelated.bin",
        "the unrelated job must be untouched"
    );
}

/// Finding A (crash-consistency): a PENDING materialization job does NOT prove
/// the bytes never reached disk — the materializer can crash AFTER the atomic
/// rename lands but BEFORE marking the job complete
/// (`MaterializeAfterRenameBeforeComplete`), leaving the written bytes on disk
/// with a still-pending job. Rolling that write back must reconcile DISK anyway:
/// the compensating delete runs even though the original job was only pending.
#[test]
fn rollback_of_pending_binary_write_with_bytes_on_disk_cleans_disk() {
    let (scratch, mut store) = open();
    write_binary(
        &mut store,
        "obj-doc",
        "doc.md",
        b"\x00crash binary\xff",
        "bin-job",
        10,
    );

    // Crash AFTER the rename lands but BEFORE marking complete: bytes ON DISK,
    // job stays PENDING.
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterRenameBeforeComplete);
    let results = run_pending_jobs(
        &store,
        scratch.path(),
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        20,
        faults.as_ref(),
    )
    .expect("drain with post-rename crash");
    assert!(
        matches!(
            results.last().map(|r| r.outcome),
            Some(JobOutcome::Crashed(
                FaultPoint::MaterializeAfterRenameBeforeComplete
            ))
        ),
        "the materializer must crash after the rename, before completing"
    );
    assert!(
        scratch.path().join("doc.md").exists(),
        "bytes must be on disk after the post-rename crash"
    );
    let pending: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM materialization_jobs \
                 WHERE job_id = 'bin-job' AND status = 'pending'",
                [],
                |r| r.get(0),
            )
        })
        .expect("pending count");
    assert_eq!(pending, 1, "the crashed job must remain pending");

    // Roll back — must reconcile disk even though the job was only pending.
    VersionedTextStore::new(&mut store)
        .rollback_text_file_mutation(
            &RollbackTextFileMutation {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: "doc.md".to_owned(),
                mutation_moment_id: "bin-job".to_owned(),
                request_id: None,
                legacy_before_text: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            &NoFaults,
        )
        .expect("rollback pending-but-on-disk binary write");

    // Drain the compensating delete → disk cleaned to match the absent DB head.
    run_pending_jobs(
        &store,
        scratch.path(),
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        30,
        &NoFaults,
    )
    .expect("drain compensating delete");
    assert!(
        !scratch.path().join("doc.md").exists(),
        "M1 crash window: disk must be cleaned to match the rolled-back absent head"
    );
    assert!(
        VersionedTextStore::new(&mut store)
            .read_text(WS, "main", "doc.md")
            .expect("read")
            .is_none(),
        "the DB head must be absent after rollback"
    );
}
