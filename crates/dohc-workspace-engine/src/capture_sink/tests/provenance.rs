use super::*;

/// (metadata_summary, metadata_correlation_id) of the latest secret
/// moment for `path`.
fn secret_moment_metadata(db: &Path, path: &str) -> (Option<String>, Option<String>) {
    let store = EngineStore::open(db, 100).expect("reopen store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT metadata_summary, metadata_correlation_id FROM secret_moments \
                     WHERE workspace_id = ?1 AND path = ?2 \
                     ORDER BY moment_order DESC LIMIT 1",
                [WORKSPACE_ID, path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("secret moment metadata")
}

/// (metadata_summary, metadata_correlation_id) of the latest moment for
/// `path`.
fn moment_metadata(db: &Path, path: &str) -> (Option<String>, Option<String>) {
    let store = EngineStore::open(db, 100).expect("reopen store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT metadata_summary, metadata_correlation_id FROM moments \
                     WHERE workspace_id = ?1 AND path = ?2 \
                     ORDER BY moment_order DESC LIMIT 1",
                [WORKSPACE_ID, path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("moment metadata")
}

#[test]
fn a_reconcile_run_stamps_its_summary_and_correlation_on_every_moment() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    // A pre-pass live capture that the reconcile pass will DELETE.
    write_file(scratch.path(), "gone.md", b"deleted while closed");
    let (db, mut live_sink) = sink_for(&scratch, &supervisor);
    assert!(
        matches!(
            ingest(&mut live_sink, "gone.md").expect("seed capture"),
            IngestOutcome::Captured { .. }
        ),
        "dropping the provenance plumb-through in ingest_text / ingest_binary / retire_head (or in the domain's capture paths) fails this: a multi-file offline reconcile would render as ungrouped unlabeled history rows, and a mid-pass DELETE would split the group (history groups only consecutive same-correlation moments)."
    );
    drop(live_sink);
    std::fs::remove_file(scratch.path().join("gone.md")).expect("offline delete");

    write_file(scratch.path(), "notes/a.md", b"offline edit a");
    write_file(scratch.path(), "photo.png", &[0xff, 0x00, 0xfe]);
    write_file(scratch.path(), ".env", b"TOKEN=offline");

    let actor = supervisor.open(&db, 2).expect("open actor").actor;
    let mut sink = StoreCaptureSink::new(StoreCaptureSinkParams {
        provenance: CaptureProvenance {
            summary: Some("Reconciled offline edits".to_owned()),
            correlation_id: Some("reconcile-test-pass".to_owned()),
        },
        ..bound_sink_params(actor, WORKSPACE_ID, VERSION_ID, scratch.path(), 10)
    });
    assert!(matches!(
        ingest(&mut sink, "notes/a.md").expect("text ingest"),
        IngestOutcome::Captured { .. }
    ));
    assert!(matches!(
        ingest_as(&mut sink, "photo.png", "image/png").expect("binary ingest"),
        IngestOutcome::Captured { .. }
    ));
    assert!(matches!(
        ingest(&mut sink, ".env").expect("secret ingest"),
        IngestOutcome::Captured { .. }
    ));
    sink.retire("gone.md").expect("pass delete");
    drop(sink);
    supervisor.close(&db).expect("close actor");

    // The delete moment carries the same provenance as the pass's
    // writes, so the history group stays contiguous.
    for path in ["notes/a.md", "photo.png", "gone.md"] {
        let (summary, correlation) = moment_metadata(&db, path);
        assert_eq!(
            summary.as_deref(),
            Some("Reconciled offline edits"),
            "{path} must carry the pass summary"
        );
        assert_eq!(
            correlation.as_deref(),
            Some("reconcile-test-pass"),
            "{path} must carry the shared pass correlation id"
        );
    }
    // Secret moments keep their per-file label (TS parity) but ride the
    // pass correlation so they group with the plaintext moments.
    let (secret_summary, secret_correlation) = secret_moment_metadata(&db, ".env");
    assert_eq!(secret_summary.as_deref(), Some("Updated .env"));
    assert_eq!(secret_correlation.as_deref(), Some("reconcile-test-pass"));
}

#[test]
fn live_text_captures_carry_no_summary_and_binary_captures_stay_labeled() {
    // TS parity: a live TEXT write carries NO summary (the renderer's
    // copy for null is "Edited <basename>"); only binary (and secret)
    // writes carry the per-file "Updated <basename>" label. Neither
    // mints a correlation id.
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "notes/live.md", b"live edit");
    write_file(scratch.path(), "photo.png", &[0xff, 0x00, 0xfe]);
    assert!(matches!(
        ingest(&mut sink, "notes/live.md").expect("live text ingest"),
        IngestOutcome::Captured { .. }
    ));
    assert!(matches!(
        ingest_as(&mut sink, "photo.png", "image/png").expect("live binary ingest"),
        IngestOutcome::Captured { .. }
    ));
    drop(sink);
    supervisor.close(&db).expect("close actor");

    assert_eq!(moment_metadata(&db, "notes/live.md"), (None, None));
    let (summary, correlation) = moment_metadata(&db, "photo.png");
    assert_eq!(summary.as_deref(), Some("Updated photo.png"));
    assert_eq!(correlation, None);
}

#[test]
fn content_kind_transitions_get_honest_moment_summaries() {
    // TS `writeIfChanged` parity: a tracked path flipping text<->binary
    // keeps its object identity and the moment says so honestly.
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "notes/flip.md", b"plain text");
    assert!(matches!(
        ingest(&mut sink, "notes/flip.md").expect("text ingest"),
        IngestOutcome::Captured { .. }
    ));
    // Binary in disguise under a text suffix: invalid UTF-8 routes to the
    // binary store and the moment records the flip.
    write_file(scratch.path(), "notes/flip.md", &[0xff, 0x00, 0xfe]);
    assert!(matches!(
        ingest(&mut sink, "notes/flip.md").expect("flip to binary"),
        IngestOutcome::Captured { .. }
    ));
    let (summary, _) = moment_metadata(&db, "notes/flip.md");
    assert_eq!(summary.as_deref(), Some("Became a binary file"));

    write_file(scratch.path(), "notes/flip.md", b"text again");
    assert!(matches!(
        ingest(&mut sink, "notes/flip.md").expect("flip back to text"),
        IngestOutcome::Captured { .. }
    ));
    let (summary, _) = moment_metadata(&db, "notes/flip.md");
    assert_eq!(summary.as_deref(), Some("Became a text file"));
    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn suppression_keeps_multiple_pending_identities_per_path() {
    // Two settles can land before capture consumes the first watcher
    // event. Mutation check: restore the single-slot HashMap<_, String>
    // registry — the in-order case consumes sha2 for the first event
    // (mismatch → ingest) and this test fails.
    let writes = SelfWriteSuppression::default();
    // In-order delivery: each event consumes its own identity.
    writes.record("ws", "a.md", "sha1");
    writes.record("ws", "a.md", "sha2");
    assert!(writes.consume("ws", "a.md", "sha1"));
    assert!(writes.consume("ws", "a.md", "sha2"));
    assert!(!writes.consume("ws", "a.md", "sha2"), "single-shot");
    // Coalesced delivery: matching the later identity consumes the
    // superseded earlier one too.
    writes.record("ws", "a.md", "sha1");
    writes.record("ws", "a.md", "sha2");
    assert!(writes.consume("ws", "a.md", "sha2"));
    assert!(
        !writes.consume("ws", "a.md", "sha1"),
        "predecessor consumed"
    );
    // External edit: every pending identity clears (no later-revert
    // suppression) and the observation ingests.
    writes.record("ws", "a.md", "sha1");
    assert!(!writes.consume("ws", "a.md", "external"));
    assert!(!writes.consume("ws", "a.md", "sha1"), "cleared by mismatch");
    // A stale retract removes only its own identity.
    writes.record("ws", "a.md", "sha1");
    writes.record("ws", "a.md", "sha2");
    dohc_engine_runtime::SelfWriteRecorder::retract(&writes, "ws", "a.md", "sha1");
    assert!(writes.consume("ws", "a.md", "sha2"), "newer entry survives");
}
