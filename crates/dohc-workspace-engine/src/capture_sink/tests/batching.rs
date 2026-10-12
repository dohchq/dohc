use super::*;

#[test]
fn parallel_added_text_preparation_preserves_the_ordered_text_prefix() {
    let scratch = ScratchDir::new().expect("scratch");
    write_file(scratch.path(), "a.md", b"alpha");
    write_file(scratch.path(), "b.md", b"bravo");
    write_file(scratch.path(), "c.png", b"binary route");
    write_file(scratch.path(), "d.md", b"discarded suffix");
    let captured_root = CapturedRoot::bind(scratch.path()).expect("captured root");
    let candidates = [
        AddedTextCandidate {
            path: "a.md",
            media_type: "text/markdown",
        },
        AddedTextCandidate {
            path: "b.md",
            media_type: "text/markdown",
        },
        AddedTextCandidate {
            path: "c.png",
            media_type: "image/png",
        },
        AddedTextCandidate {
            path: "d.md",
            media_type: "text/markdown",
        },
    ];

    let PreparedTextPrefix::Ready(prepared) =
        prepare_added_text_prefix_parallel(scratch.path(), &captured_root, &candidates)
    else {
        panic!("the leading text files should form a batch prefix");
    };

    assert_eq!(prepared.len(), 2);
    assert_eq!(prepared[0].text, "alpha");
    assert_eq!(prepared[0].sha256, hex_sha256(b"alpha"));
    assert_eq!(prepared[1].text, "bravo");
    assert_eq!(prepared[1].sha256, hex_sha256(b"bravo"));
    assert!(matches!(
        prepare_added_text_prefix_parallel(scratch.path(), &captured_root, &candidates[2..],),
        PreparedTextPrefix::FallbackFirst
    ));
}

#[test]
fn parallel_root_mismatch_discards_an_already_prepared_prefix() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let moved_root = root.with_file_name(format!(
        "{}-moved",
        root.file_name().expect("root name").to_string_lossy()
    ));
    write_file(&root, "a.md", b"alpha");
    write_file(&root, "b.md", b"bravo");
    let captured_root = CapturedRoot::bind(&root).expect("captured root");
    let candidates = [
        AddedTextCandidate {
            path: "a.md",
            media_type: "text/markdown",
        },
        AddedTextCandidate {
            path: "b.md",
            media_type: "text/markdown",
        },
    ];
    let first_prepared = AtomicBool::new(false);
    let swapped = AtomicBool::new(false);

    let prepared = prepare_added_text_prefix_parallel_with(
        &candidates,
        |candidate| {
            if candidate.path == "a.md" {
                first_prepared.store(true, Ordering::Release);
                return Ok(CurrentContent::Text("alpha".to_owned()));
            }
            while !first_prepared.load(Ordering::Acquire) {
                std::thread::yield_now();
            }
            if !swapped.swap(true, Ordering::AcqRel) {
                std::fs::rename(&root, &moved_root).expect("move original capture root");
                std::fs::create_dir(&root).expect("recreate capture root");
                write_file(&root, "b.md", b"replacement workspace content");
            }
            read_current_with_canonical_root(
                &root,
                &captured_root,
                candidate.path,
                candidate.media_type,
            )
        },
        || captured_root.still_names(&root),
    );

    std::fs::remove_dir_all(&root).expect("remove replacement capture root");
    std::fs::rename(&moved_root, &root).expect("restore original capture root");
    assert!(matches!(
        prepared,
        PreparedTextPrefix::RootMismatch { attempted: 2 }
    ));
}

#[test]
fn parallel_path_escape_falls_back_without_poisoning_sibling_progress() {
    let candidates = [
        AddedTextCandidate {
            path: "a.md",
            media_type: "text/markdown",
        },
        AddedTextCandidate {
            path: "linked/b.md",
            media_type: "text/markdown",
        },
        AddedTextCandidate {
            path: "c.md",
            media_type: "text/markdown",
        },
    ];
    let read = |candidate: AddedTextCandidate<'_>| match candidate.path {
        "linked/b.md" => Err(ESCAPES_ROOT),
        path => Ok(CurrentContent::Text(path.to_owned())),
    };

    let first = prepare_added_text_prefix_parallel_with(&candidates, read, || true);
    let PreparedTextPrefix::Ready(first) = first else {
        panic!("the good prefix must remain committable");
    };
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].text, "a.md");

    assert!(matches!(
        prepare_added_text_prefix_parallel_with(&candidates[1..], read, || true),
        PreparedTextPrefix::FallbackFirst
    ));
    let PreparedTextPrefix::Ready(last) =
        prepare_added_text_prefix_parallel_with(&candidates[2..], read, || true)
    else {
        panic!("the good suffix must progress after the refused path");
    };
    assert_eq!(last.len(), 1);
    assert_eq!(last[0].text, "c.md");
}

fn busy_batch_fixture() -> (
    ScratchDir,
    WorkspaceSupervisor,
    PathBuf,
    StoreCaptureSink,
    Connection,
) {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "a.md", b"alpha");
    write_file(scratch.path(), "b.md", b"bravo");
    let writer = Connection::open(&db).expect("fixture writer");
    writer
        .execute_batch("CREATE TABLE retry_payload(body BLOB)")
        .unwrap();
    let reader = Connection::open(&db).expect("pinned reader");
    reader
        .execute_batch("BEGIN; SELECT count(*) FROM retry_payload")
        .unwrap();
    writer
        .execute_batch("INSERT INTO retry_payload VALUES(zeroblob(28*1024*1024))")
        .unwrap();
    (scratch, supervisor, db, sink, reader)
}

#[test]
fn capture_sink_busy_batch_has_no_failed_receipt_or_rescan() {
    use dohc_engine_files::{
        ReconcileController, ReconcileRun, ScanBounds, Scanner, apply_then_ack,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    let (scratch, supervisor, db, mut sink, reader) = busy_batch_fixture();
    let waits = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&waits);
    sink.batch_retry.wait = Some(Box::new(move |_| {
        if observed.fetch_add(1, Ordering::Relaxed) == 0 {
            // Release the actual pin; the actor's handoff waits for checkpoint progress.
            reader.execute_batch("ROLLBACK").unwrap();
        }
    }));
    let scanner = Scanner::new(ScanBounds::default()).unwrap();
    let mut controller = ReconcileController::new();
    let token = CancellationToken::new();
    let ReconcileRun::Completed(plan) = controller
        .reconcile(&scanner, scratch.path(), &token)
        .unwrap()
    else {
        panic!("expected added text plan");
    };
    assert_eq!(plan.ops.len(), 2);
    let receipt = apply_then_ack(&mut controller, &plan, &mut sink, &FilesNoFaults).unwrap();
    assert!(
        waits.load(Ordering::Relaxed) > 0,
        "real FileLocked must traverse the sink retry"
    );
    assert!(receipt.failed_applies.is_empty(), "{receipt:?}");
    assert!(!receipt.degraded);
    assert_eq!(receipt.applied_paths, ["a.md", "b.md"]);
    assert!(
        !controller.is_dirty(),
        "a clean receipt must not schedule the driver's 500 ms rescan"
    );
    assert!(matches!(
        controller
            .reconcile_if_dirty(&scanner, scratch.path(), &token)
            .unwrap(),
        ReconcileRun::Converged
    ));
    assert_eq!(snapshot(&db, "a.md").unwrap().text, "alpha");
    assert_eq!(snapshot(&db, "b.md").unwrap().text, "bravo");

    drop(sink);
    supervisor.close(&db).unwrap();
}

#[test]
fn capture_sink_cancellation_stops_an_inflight_busy_batch() {
    use dohc_engine_files::{ReconcileController, ReconcileRun, ScanBounds, Scanner};
    use std::sync::atomic::{AtomicUsize, Ordering};

    let (scratch, supervisor, db, original, reader) = busy_batch_fixture();
    drop(original);
    let cancel = CancellationToken::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let mut params = bound_sink_params(actor, WORKSPACE_ID, VERSION_ID, scratch.path(), 10);
    params.cancel = cancel.clone();
    let mut sink = StoreCaptureSink::new(params);
    let waits = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&waits);
    sink.batch_retry.wait = Some(Box::new(move |_| {
        assert_eq!(
            observed.fetch_add(1, Ordering::Relaxed),
            0,
            "cancelled sink must not retry again"
        );
        cancel.cancel();
    }));
    let scanner = Scanner::new(ScanBounds::default()).unwrap();
    let ReconcileRun::Completed(plan) = ReconcileController::new()
        .reconcile(&scanner, scratch.path(), &CancellationToken::new())
        .unwrap()
    else {
        panic!("expected added text plan");
    };
    let receipt = apply_reconcile_plan(&plan, &mut sink, &FilesNoFaults);
    assert_eq!(waits.load(Ordering::Relaxed), 1);
    assert_eq!(receipt.failed_applies, ["a.md", "b.md"]);
    assert!(receipt.applied_paths.is_empty());
    assert!(receipt.degraded);
    reader.execute_batch("ROLLBACK").unwrap();
    drop(sink);
    supervisor.close(&db).unwrap();
}

#[test]
fn single_file_ingest_and_retire_end_the_shared_busy_episode() {
    let scratch = ScratchDir::new().unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    let hold = sink.actor.defer_link_drain_for_capture();
    write_file(scratch.path(), "single.md", b"single");
    sink.batch_retry.exhaust_for_test();
    ingest(&mut sink, "single.md").unwrap();
    sink.batch_retry.run(|| Ok(())).unwrap();
    assert_eq!(snapshot(&db, "single.md").unwrap().text, "single");

    std::fs::remove_file(scratch.path().join("single.md")).unwrap();
    sink.batch_retry.exhaust_for_test();
    sink.retire("single.md").unwrap();
    sink.batch_retry.run(|| Ok(())).unwrap();
    assert!(snapshot(&db, "single.md").is_none());
    drop(hold);
    drop(sink);
    supervisor.close(&db).unwrap();
}
