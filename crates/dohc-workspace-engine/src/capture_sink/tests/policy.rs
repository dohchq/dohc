use super::*;

#[test]
fn an_unreadable_policy_holds_capture_instead_of_widening_or_retiring() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();

    // Establish a capture-owned head under a healthy (absent) policy.
    write_file(scratch.path(), "kept.md", b"captured content");
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    assert!(matches!(
        ingest(&mut sink, "kept.md").expect("healthy ingest"),
        IngestOutcome::Captured { .. }
    ));
    drop(sink);

    // files.toml becomes unreadable (a directory is deterministic on
    // every platform: exists, not a regular file). The narrowing set is
    // now unknown — a fresh sink must hold, not widen to floor-only and
    // not retire.
    std::fs::create_dir_all(scratch.path().join(".dohc/files.toml")).expect("dir-as-policy");
    write_file(scratch.path(), "kept.md", b"edited while unreadable");
    let (_, mut sink) = sink_for(&scratch, &supervisor);
    assert!(
        ingest(&mut sink, "kept.md").is_err(),
        "unknown policy must fail the op (stays dirty, retried), not capture"
    );
    assert_eq!(
        snapshot(&db, "kept.md").expect("head survives").text,
        "captured content",
        "the held op must neither update nor retire the existing head"
    );

    // A MALFORMED file is a different case: the ratified WS-F rule keeps
    // capture floor-only (writes are never dropped for a bad policy).
    std::fs::remove_dir_all(scratch.path().join(".dohc/files.toml")).expect("rm dir");
    write_file(
        scratch.path(),
        ".dohc/files.toml",
        b"this is [not valid toml",
    );
    let (_, mut sink) = sink_for(&scratch, &supervisor);
    assert!(
        matches!(
            ingest(&mut sink, "kept.md").expect("malformed policy still captures"),
            IngestOutcome::Captured { .. }
        ),
        "WS-F: a malformed policy must not drop writes"
    );
    assert_eq!(
        snapshot(&db, "kept.md").expect("head updated").text,
        "edited while unreadable"
    );
}

#[test]
fn ignored_binary_and_secret_routes_do_not_write() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "binary.md", &[0xff, 0x00, 0xfe]);
    write_file(scratch.path(), ".env", b"TOKEN=secret");

    assert_eq!(
        ingest(&mut sink, ".dohc/ignored.md").expect("ignored path"),
        IngestOutcome::NotOwned
    );
    // Binary content captures as a BINHEAD binary head; secret content
    // captures into the encrypted store (never the plaintext one).
    assert!(matches!(
        ingest(&mut sink, "binary.md").expect("binary capture"),
        IngestOutcome::Captured { .. }
    ));
    assert!(matches!(
        ingest(&mut sink, ".env").expect("secret capture"),
        IngestOutcome::Captured { .. }
    ));

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(moment_count(&db, ".dohc/ignored.md"), 0);
    assert_eq!(moment_count(&db, "binary.md"), 1);
    assert!(binary_head(&db, "binary.md").is_some());
    // The plaintext tables never see the secret; the encrypted tip does.
    assert_eq!(moment_count(&db, ".env"), 0);
    assert_eq!(secret_tip_len(&db, ".env"), Some(12));
}

#[test]
fn files_toml_tracked_false_narrows_and_retires() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut seed_sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "private/journal.md", b"personal");
    write_file(scratch.path(), "public.md", b"shared");
    ingest(&mut seed_sink, "private/journal.md").expect("seed private");
    ingest(&mut seed_sink, "public.md").expect("seed public");
    drop(seed_sink);

    write_file(
        scratch.path(),
        ".dohc/files.toml",
        b"[[rule]]\npath = \"private/**\"\ntracked = false\n",
    );
    // The policy snapshot is read at construction: a fresh sink sees it.
    let actor = supervisor.open(&db, 1).expect("reopen actor").actor;
    let mut sink = StoreCaptureSink::new(bound_sink_params(
        actor,
        WORKSPACE_ID,
        VERSION_ID,
        scratch.path(),
        20,
    ));
    assert_eq!(
        ingest(&mut sink, "private/journal.md").expect("narrowed"),
        IngestOutcome::NotOwned
    );
    assert!(matches!(
        ingest(&mut sink, "public.md").expect("still tracked"),
        IngestOutcome::Captured { .. }
    ));

    drop(sink);
    supervisor.close(&db).expect("close actor");
    // The opted-out path was retired, not left stale-but-authoritative.
    assert!(snapshot(&db, "private/journal.md").is_none());
    assert_eq!(
        snapshot(&db, "public.md").expect("public head").text,
        "shared"
    );
}

#[test]
fn broken_files_toml_keeps_capture_floor_only() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    write_file(scratch.path(), ".dohc/files.toml", b"not = valid policy [[");
    write_file(scratch.path(), "notes/a.md", b"kept");
    let (db, mut sink) = sink_for(&scratch, &supervisor);

    // WS-F: a malformed policy never drops writes — capture stays
    // floor-only rather than failing closed.
    assert!(matches!(
        ingest(&mut sink, "notes/a.md").expect("floor-only capture"),
        IngestOutcome::Captured { .. }
    ));

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(snapshot(&db, "notes/a.md").expect("head").text, "kept");
}
