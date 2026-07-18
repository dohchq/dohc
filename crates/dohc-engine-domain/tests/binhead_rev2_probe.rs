//! BINHEAD (rev2) permanent regressions, ported from the convergence reviewer's
//! adversarial probes. They exercise the binary-head-as-real-head claim end to
//! end: M2 same-path generation supersede against the REAL materializer, and
//! binary-head round-trips through history/rollback. The same-path supersede
//! test is the load-bearing proof for the whole shard.

use dohc_engine_domain::{
    EngineStore, NoFaults, RollbackTextFileMutation, VersionedTextStore, WriteBinaryFile,
    WriteText, write_binary_file_in_tx,
};
use dohc_engine_files::{DurabilityPolicy, JobOutcome, NoBackoff, StdReplacer, run_pending_jobs};
use dohc_engine_storage::{
    MaterializationJobSpec, Preimage, StorageError, enqueue_job, hex_sha256, put_binary_blob,
};
use dohc_engine_testkit::ScratchDir;
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
                    job_id: job.to_owned(),
                    preimage: Preimage::Absent,
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
                legacy_before_text: None,
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
#[test]
fn rollback_first_binary_write_removes_file_and_object() {
    let (_scratch, mut store) = open();
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
                legacy_before_text: None,
            },
            &NoFaults,
        )
        .expect("rollback first binary write");

    let (snap_count, obj_count): (i64, i64) = store
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
            Ok::<_, rusqlite::Error>((s, o))
        })
        .expect("counts");
    assert_eq!(snap_count, 0, "the binary snapshot must be gone");
    assert_eq!(obj_count, 0, "the object must be garbage-collected");

    let view = VersionedTextStore::new(&mut store)
        .read_text(WS, "main", "doc.md")
        .expect("read");
    assert!(
        view.is_none(),
        "the path must read as absent after rollback"
    );
}
