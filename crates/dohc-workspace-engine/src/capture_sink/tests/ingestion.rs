use super::*;

#[test]
fn text_ingest_rereads_updates_and_dedupes_equal_content() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "notes/a.md", b"first");

    assert!(matches!(
        ingest(&mut sink, "notes/a.md").expect("first ingest"),
        IngestOutcome::Captured { .. }
    ));
    assert!(matches!(
        ingest(&mut sink, "notes/a.md").expect("equal ingest"),
        IngestOutcome::Captured { .. }
    ));
    write_file(scratch.path(), "notes/a.md", b"latest");
    let updated = ingest(&mut sink, "notes/a.md").expect("updated ingest");
    // The receipt reports the identity of the bytes actually captured.
    assert_eq!(
        updated,
        IngestOutcome::Captured {
            size: 6,
            sha256: hex_sha256(b"latest"),
        }
    );

    drop(sink);
    supervisor.close(&db).expect("close actor");
    let captured = snapshot(&db, "notes/a.md").expect("captured snapshot");
    assert_eq!(captured.text, "latest");
    assert_eq!(
        captured.metadata_origin,
        dohc_engine_domain::store::CAPTURE_ORIGIN
    );
    assert_eq!(moment_count(&db, "notes/a.md"), 2);
}

#[test]
fn binary_ingest_dedupes_equal_bytes() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "logo.png", &[0, 1, 2, 255]);

    assert!(matches!(
        ingest_as(&mut sink, "logo.png", "image/png").expect("first ingest"),
        IngestOutcome::Captured { .. }
    ));
    assert!(matches!(
        ingest_as(&mut sink, "logo.png", "image/png").expect("equal ingest"),
        IngestOutcome::Captured { .. }
    ));

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(
        binary_head(&db, "logo.png").as_deref(),
        Some(hex_sha256(&[0, 1, 2, 255]).as_str())
    );
    assert_eq!(moment_count(&db, "logo.png"), 1);
}

#[test]
fn retire_removes_the_version_head() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "retired.md", b"captured");
    ingest(&mut sink, "retired.md").expect("ingest before retire");
    std::fs::remove_file(scratch.path().join("retired.md")).expect("delete from disk");
    sink.retire("retired.md").expect("retire");

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert!(snapshot(&db, "retired.md").is_none());
}

#[test]
fn oversized_text_retires_stale_authoritative_content() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "oversized.md", b"small");
    ingest(&mut sink, "oversized.md").expect("seed ingest");
    let oversized = vec![b'x'; MAX_CAPTURE_TEXT_BYTES as usize + 1];
    write_file(scratch.path(), "oversized.md", &oversized);
    assert_eq!(
        ingest(&mut sink, "oversized.md").expect("oversized retire"),
        IngestOutcome::NotOwned
    );

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert!(snapshot(&db, "oversized.md").is_none());
}

#[test]
fn image_heavy_excalidraw_is_utf8_text_up_to_max_text_bytes() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    // Three representative 2 MiB image payloads become 8 MiB of base64.
    // The portable JSON remains below MAX_TEXT_BYTES (10,485,760 bytes)
    // and above the 5 MiB binary cap, proving classification selects the
    // text ceiling before the read.
    let encoded = "A".repeat(2_700_000);
    let portable = format!(
        r#"{{"type":"excalidraw","version":2,"source":"https://excalidraw.com","elements":[{{"id":"ea","type":"image","version":1,"versionNonce":1,"isDeleted":false,"index":"a0","fileId":"a"}},{{"id":"eb","type":"image","version":1,"versionNonce":2,"isDeleted":false,"index":"a1","fileId":"b"}},{{"id":"ec","type":"image","version":1,"versionNonce":3,"isDeleted":false,"index":"a2","fileId":"c"}}],"appState":{{}},"files":{{"a":{{"id":"a","mimeType":"image/png","created":1,"dataURL":"data:image/png;base64,{encoded}"}},"b":{{"id":"b","mimeType":"image/jpeg","created":2,"dataURL":"data:image/jpeg;base64,{encoded}"}},"c":{{"id":"c","mimeType":"image/webp","created":3,"dataURL":"data:image/webp;base64,{encoded}"}}}}}}"#
    );
    assert!(portable.len() > MAX_CAPTURE_BINARY_BYTES as usize);
    assert!(portable.len() < MAX_CAPTURE_TEXT_BYTES as usize);
    let imported = dohc_engine_collab::import_portable_scene(&portable)
        .expect("representative healthy scene imports");
    assert_eq!(imported.files.len(), 3);
    write_file(
        scratch.path(),
        "image-heavy.excalidraw",
        portable.as_bytes(),
    );
    assert!(matches!(
        ingest_as(&mut sink, "image-heavy.excalidraw", "application/json")
            .expect("image-heavy scene capture"),
        IngestOutcome::Captured { .. }
    ));
    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(
        snapshot(&db, "image-heavy.excalidraw")
            .expect("captured portable scene")
            .text
            .len(),
        portable.len()
    );
}

#[test]
fn invalid_utf8_and_over_max_text_bytes_excalidraw_are_not_binary() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);

    write_file(scratch.path(), "invalid.excalidraw", &[0xff, 0xfe]);
    assert_eq!(
        ingest_as(&mut sink, "invalid.excalidraw", "application/json")
            .expect("invalid UTF-8 refusal"),
        IngestOutcome::NotOwned
    );
    assert!(binary_head(&db, "invalid.excalidraw").is_none());

    let observed = MAX_CAPTURE_TEXT_BYTES + 1;
    write_file(
        scratch.path(),
        "over-cap.excalidraw",
        &vec![b'x'; observed as usize],
    );
    assert_eq!(MAX_CAPTURE_TEXT_BYTES, 10_485_760);
    assert_eq!(observed, 10_485_761);
    assert_eq!(
        ingest_as(&mut sink, "over-cap.excalidraw", "application/json")
            .expect("MAX_TEXT_BYTES 10,485,760-byte capture refusal at 10,485,761 bytes"),
        IngestOutcome::NotOwned
    );
    assert!(binary_head(&db, "over-cap.excalidraw").is_none());
    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn text_media_that_turns_binary_replaces_the_text_head() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "flip.md", b"was text");
    ingest(&mut sink, "flip.md").expect("seed ingest");
    write_file(scratch.path(), "flip.md", &[0xff, 0xfe, 0x00]);

    let flipped = ingest(&mut sink, "flip.md").expect("binary capture");
    assert_eq!(
        flipped,
        IngestOutcome::Captured {
            size: 3,
            sha256: hex_sha256(&[0xff, 0xfe, 0x00]),
        }
    );

    drop(sink);
    supervisor.close(&db).expect("close actor");
    // One transition: the binary head replaced the text head atomically.
    assert_eq!(
        binary_head(&db, "flip.md").as_deref(),
        Some(hex_sha256(&[0xff, 0xfe, 0x00]).as_str())
    );
    assert_eq!(moment_count(&db, "flip.md"), 2);
}

#[test]
fn non_text_media_never_lands_in_the_plaintext_store() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    // Valid UTF-8 bytes under a binary media type: UTF-8 sniffing alone
    // would capture this as text.
    write_file(scratch.path(), "photo.png", b"plain ascii bytes");

    assert!(matches!(
        ingest_as(&mut sink, "photo.png", "image/png").expect("binary capture"),
        IngestOutcome::Captured { .. }
    ));
    // Content-equality dedupe holds for binary too.
    assert!(matches!(
        ingest_as(&mut sink, "photo.png", "image/png").expect("equal binary"),
        IngestOutcome::Captured { .. }
    ));

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(
        binary_head(&db, "photo.png").as_deref(),
        Some(hex_sha256(b"plain ascii bytes").as_str())
    );
    assert_eq!(moment_count(&db, "photo.png"), 1, "equal re-ingest deduped");
}

#[test]
fn reconcile_settles_deferred_and_raced_paths_without_degrading() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), ".env", b"TOKEN=x");
    write_file(scratch.path(), "b-good.md", b"good");
    let ingest_op = |path: &str| CaptureOp::Ingest {
        path: path.to_owned(),
        size: 1,
        sha256: "stale".to_owned(),
        mtime_ms: 0,
        media_type: "text/markdown",
        reason: IngestReason::Added,
    };
    let plan = ReconcilePlan {
        from_generation: ScanGeneration(0),
        to_generation: ScanGeneration(1),
        ops: vec![
            ingest_op(".env"),
            ingest_op("b-good.md"),
            ingest_op("c-gone.md"),
        ],
        retained_over_cap: Vec::new(),
        unconfirmed_removed: Vec::new(),
        degraded: false,
        degraded_paths: Vec::new(),
        prepared_from_dirty: true,
        dirty_epoch: 0,
    };

    let result = apply_reconcile_plan(&plan, &mut sink, &FilesNoFaults);
    // The text sibling and the secret apply (the secret into the
    // encrypted store); only the raced-away path settles as not-owned.
    assert_eq!(result.applied_paths, [".env", "b-good.md"]);
    assert_eq!(result.not_owned_paths, ["c-gone.md"]);
    assert!(result.failed_applies.is_empty());
    assert!(!result.degraded);

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert!(snapshot(&db, ".env").is_none());
    assert!(snapshot(&db, "c-gone.md").is_none());
    assert_eq!(
        snapshot(&db, "b-good.md").expect("sibling snapshot").text,
        "good"
    );
}

#[test]
fn store_refused_name_settles_as_not_owned_instead_of_degrading() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    // Legal on-disk names the scan floor tracks but the domain store's
    // stricter admission gate refuses (`..` substring). Retrying can never
    // succeed, so the op must settle instead of poisoning every capture
    // run as degraded.
    write_file(scratch.path(), "release..notes.md", b"legal on disk");

    assert_eq!(
        ingest(&mut sink, "release..notes.md").expect("refused name settles"),
        IngestOutcome::NotOwned
    );
    // Once the file is gone, a planned retire of the refused name is a
    // clean no-op (the store can never have held a head for it).
    std::fs::remove_file(scratch.path().join("release..notes.md")).expect("delete");
    sink.retire("release..notes.md")
        .expect("nothing to retire under a refused name");

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(moment_count(&db, "release..notes.md"), 0);
}

#[test]
fn retire_is_refused_when_a_regular_file_reappeared() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "back.md", b"captured");
    ingest(&mut sink, "back.md").expect("seed ingest");

    // A Retire op prepared from a scan that saw the path absent must be
    // refused if the file reappeared before the apply — retiring would
    // forget the manifest entry while a live disk file has no snapshot.
    assert_eq!(sink.retire("back.md"), Err(RETIRE_RACED));

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(
        snapshot(&db, "back.md").expect("head retained").text,
        "captured"
    );
}

#[test]
fn binary_flip_and_revert_to_identical_text_recaptures_the_head() {
    use dohc_engine_files::{
        CancellationToken, ReconcileController, ReconcileRun, ScanBounds, Scanner, apply_then_ack,
    };

    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    let scanner = Scanner::new(ScanBounds::default()).expect("scanner");
    let mut controller = ReconcileController::new();
    let reconcile = |controller: &mut ReconcileController| match controller
        .reconcile(&scanner, scratch.path(), &CancellationToken::new())
        .expect("reconcile")
    {
        ReconcileRun::Completed(plan) => plan,
        other => panic!("expected completed plan, got {other:?}"),
    };

    // Capture the original text through the full plan/ack cycle.
    write_file(scratch.path(), "flip.md", b"same bytes");
    let plan = reconcile(&mut controller);
    apply_then_ack(&mut controller, &plan, &mut sink, &FilesNoFaults).expect("seed ack");
    assert!(controller.tracks_path("flip.md"));

    // Flip to binary: the binary head is captured and the manifest
    // records the binary bytes' hash.
    write_file(scratch.path(), "flip.md", &[0xff, 0xfe, 0x00]);
    controller.mark_dirty();
    let plan = reconcile(&mut controller);
    apply_then_ack(&mut controller, &plan, &mut sink, &FilesNoFaults).expect("flip ack");
    assert!(
        controller.tracks_path("flip.md"),
        "a captured binary flip records the binary hash"
    );

    // Revert to the exact original text bytes: the manifest holds the
    // binary hash, so this diffs as a change and re-ingests as text.
    write_file(scratch.path(), "flip.md", b"same bytes");
    controller.mark_dirty();
    let plan = reconcile(&mut controller);
    apply_then_ack(&mut controller, &plan, &mut sink, &FilesNoFaults).expect("revert ack");

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(
        snapshot(&db, "flip.md").expect("recaptured head").text,
        "same bytes"
    );
}

#[test]
fn non_ownable_ingest_spares_a_ydoc_head_but_retires_a_capture_head() {
    // AUDIT-SILENTSAVE. Pins the sink wiring directly: that the
    // NonOwnable branch passes allow_ydoc_origin=false. The rpc test
    // covers the same rule end to end, but only while the driver keeps
    // offering that path — this does not depend on the driver at all.
    //
    // A settled Y.Doc past MAX_CAPTURE_TEXT_BYTES arrives here as
    // NonOwnable. Retiring it destroys a document the user just saved.
    // An ordinary CAPTURE head of the same shape must still retire.
    let scratch = ScratchDir::new().expect("scratch");
    let db = dohc_engine_testkit::engine_db_path(&scratch).expect("db");
    let mut store = EngineStore::open(&db, 1).expect("store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, VERSION_ID, 1, &FilesNoFaults)
        .expect("main");

    // A materialized Y.Doc head, exactly as a settle leaves it.
    store
        .write_with(&FilesNoFaults, |tx| {
            dohc_engine_domain::write_projected_text_in_tx(
                tx,
                &dohc_engine_domain::WriteText {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    version_id: VERSION_ID.to_owned(),
                    object_id: "obj-sink-ydoc".to_owned(),
                    path: "notes/settled.md".to_owned(),
                    text: "settled body".to_owned(),
                    moment_id: "m-sink-ydoc".to_owned(),
                    metadata_origin: "ydoc".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
            )?;
            Ok::<(), dohc_engine_domain::DomainError>(())
        })
        .expect("ydoc head");
    drop(store);

    // An ordinary captured head at another path, via the sink itself.
    let supervisor = WorkspaceSupervisor::new();
    let (_db, mut seed_sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "notes/plain.md", b"plain body");
    assert!(matches!(
        ingest(&mut seed_sink, "notes/plain.md").expect("seed ingest"),
        IngestOutcome::Captured { .. }
    ));
    assert!(snapshot(&db, "notes/plain.md").is_some());

    // Both files are now NON-OWNABLE on disk: past the text cap.
    let over_cap = vec![b'x'; (MAX_CAPTURE_TEXT_BYTES + 1) as usize];
    write_file(scratch.path(), "notes/settled.md", &over_cap);
    write_file(scratch.path(), "notes/plain.md", &over_cap);

    let (_db2, mut sink) = sink_for(&scratch, &supervisor);
    assert!(matches!(
        ingest(&mut sink, "notes/settled.md").expect("ydoc ingest"),
        IngestOutcome::NotOwned
    ));
    assert!(matches!(
        ingest(&mut sink, "notes/plain.md").expect("capture ingest"),
        IngestOutcome::NotOwned
    ));

    // The assertion: ownership decided, not the classification alone.
    assert!(
        snapshot(&db, "notes/settled.md").is_some(),
        "a settled Y.Doc head must survive a not-engine-ownable ingest"
    );
    assert!(
        snapshot(&db, "notes/plain.md").is_none(),
        "an ordinary capture head must still retire when it stops being ownable"
    );
}
