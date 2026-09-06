use super::*;

fn secret_tip_capture_owned(db: &Path, path: &str) -> Option<bool> {
    use rusqlite::OptionalExtension;
    let store = EngineStore::open(db, 100).expect("reopen store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT m.capture_owned FROM secret_files f \
                     JOIN secret_moments m ON m.workspace_id = f.workspace_id \
                       AND m.moment_id = f.latest_moment_id \
                     WHERE f.workspace_id = ?1 AND f.version_id = ?2 AND f.path = ?3",
                [WORKSPACE_ID, VERSION_ID, path],
                |row| row.get::<_, bool>(0),
            )
            .optional()
        })
        .expect("secret ownership query")
}

#[test]
fn secret_capture_encrypts_dedupes_and_retires() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), ".env", b"TOKEN=alpha");

    let first = ingest(&mut sink, ".env").expect("secret capture");
    assert_eq!(
        first,
        IngestOutcome::Captured {
            size: 11,
            sha256: hex_sha256(b"TOKEN=alpha"),
        }
    );
    // The key file was minted on first use and is reused thereafter.
    let key_path = scratch.path().join(".dohc/engine/secret.key");
    let key_bytes = std::fs::read(&key_path).expect("key file exists");
    assert!(matches!(
        ingest(&mut sink, ".env").expect("equal secret capture"),
        IngestOutcome::Captured { .. }
    ));
    assert_eq!(
        std::fs::read(&key_path).expect("key file stable"),
        key_bytes,
        "an existing key is never regenerated"
    );

    // Delete from disk: the plan retire removes the encrypted tip.
    std::fs::remove_file(scratch.path().join(".env")).expect("delete");
    sink.retire(".env").expect("secret retire");

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(secret_tip_len(&db, ".env"), None, "tip retired");
    assert_eq!(moment_count(&db, ".env"), 0, "plaintext tables untouched");
}

#[test]
fn secret_key_is_not_minted_in_a_replacement_root_after_plaintext_read() {
    let store_scratch = ScratchDir::new().expect("store scratch");
    let capture_scratch = ScratchDir::new().expect("capture scratch");
    let root = capture_scratch.path().to_path_buf();
    let moved_root = root.with_file_name(format!(
        "{}-moved",
        root.file_name().expect("root name").to_string_lossy()
    ));
    let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("open actor").actor;
    write_file(&root, ".env", b"TOKEN=original");
    let mut sink = StoreCaptureSink::new(sink_params(actor, &root, 10));

    let content = sink
        .read_current_secret(".env")
        .expect("read original plaintext");
    std::fs::rename(&root, &moved_root).expect("move original capture root");
    std::fs::create_dir(&root).expect("recreate capture root");
    let result = sink.ingest_secret_content(".env", true, false, content);
    let replacement_key_exists = root.join(".dohc/engine/secret.key").exists();

    std::fs::remove_dir_all(&root).expect("remove replacement capture root");
    std::fs::rename(&moved_root, &root).expect("restore original capture root");
    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(result, Err(ESCAPES_ROOT));
    assert!(
        !replacement_key_exists,
        "replacement root must receive no key"
    );
    assert_eq!(secret_tip_len(&db, ".env"), None);
}

#[test]
fn secret_changed_ingest_consumes_an_engine_self_write() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine db path");
    let key = create_key_file(scratch.path()).expect("secret key");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, VERSION_ID, 1, &FilesNoFaults)
        .expect("main");
    SecretFileStore::new(&mut store, &key)
        .write_secret_file(
            &SecretWrite {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: VERSION_ID.to_owned(),
                path: ".env".to_owned(),
                text: "MODE=feature\n".to_owned(),
                moment_id: "switch-owned-by-api".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 2,
                disk_intent: SecretDiskIntent::Materialize,
            },
            &FilesNoFaults,
        )
        .expect("API secret");
    drop(store);
    write_file(scratch.path(), ".env", b"MODE=feature\n");

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).expect("actor").actor;
    let self_writes = SelfWriteSuppression::default();
    self_writes.record(WORKSPACE_ID, ".env", &hex_sha256(b"MODE=feature\n"));
    let mut sink = StoreCaptureSink::new(StoreCaptureSinkParams {
        self_writes,
        ..sink_params(actor, scratch.path(), 4)
    });
    let observed_sha = match sink.read_current_secret(".env").expect("read secret") {
        SecretContent::Text(text) => hex_sha256(text.as_bytes()),
        SecretContent::Untracked => panic!("fixture secret must be tracked"),
    };
    assert!(
        sink.self_writes
            .has_pending(WORKSPACE_ID, ".env", &observed_sha),
        "fixture must arm the exact identity capture will observe"
    );

    assert!(matches!(
        ingest(&mut sink, ".env").expect("suppressed switch observation"),
        IngestOutcome::Captured { .. }
    ));

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(
        secret_tip_capture_owned(&db, ".env"),
        Some(false),
        "observing the engine's own switch write must not grant capture ownership"
    );
}

#[test]
fn secret_that_stops_being_utf8_text_retires_the_tip() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), ".env", b"TOKEN=alpha");
    ingest(&mut sink, ".env").expect("seed secret");

    // Binary-in-disguise is not capturable secret text (TS parity: the
    // secret read has no binary route) — the stale tip must retire.
    write_file(scratch.path(), ".env", &[0xff, 0x00, 0xfe]);
    assert_eq!(
        ingest(&mut sink, ".env").expect("untracked secret"),
        IngestOutcome::NotOwned
    );

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(secret_tip_len(&db, ".env"), None);
}

#[test]
fn secret_retire_is_refused_when_the_file_reappeared() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), ".env", b"TOKEN=alpha");
    ingest(&mut sink, ".env").expect("seed secret");

    // A Retire op prepared from an absent-scan must refuse if the secret
    // file reappeared before the apply.
    assert_eq!(sink.retire(".env"), Err(RETIRE_RACED));

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(secret_tip_len(&db, ".env"), Some(11), "tip retained");
}

#[test]
fn missing_key_over_existing_secret_state_fails_closed_instead_of_reminting() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), ".env", b"TOKEN=alpha");
    ingest(&mut sink, ".env").expect("seed secret");
    drop(sink);

    // A backup restored without the key file / accidental deletion.
    std::fs::remove_file(scratch.path().join(".dohc/engine/secret.key")).expect("lose key");

    let actor = supervisor.open(&db, 1).expect("reopen actor").actor;
    let mut fresh = StoreCaptureSink::new(sink_params(actor, scratch.path(), 30));
    write_file(scratch.path(), ".env", b"TOKEN=changed");
    let err = ingest(&mut fresh, ".env").expect_err("must not mint over live secret state");
    assert_eq!(err.reason, "workspace secret key unavailable");
    assert!(
        !scratch.path().join(".dohc/engine/secret.key").exists(),
        "no fresh key was minted over the orphaned history"
    );

    drop(fresh);
    supervisor.close(&db).expect("close actor");
    assert_eq!(secret_tip_len(&db, ".env"), Some(11), "tip retained");
}

#[test]
fn non_canonical_secret_names_are_refused_both_ways() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    // A literal on-disk `%2eenv` decodes to the durable key `.env`;
    // capturing it would create an encrypted head under an aliased key.
    write_file(scratch.path(), "%2eenv", b"TOKEN=evil");

    assert_eq!(
        ingest(&mut sink, "%2eenv").expect("refused, settled"),
        IngestOutcome::NotOwned
    );
    sink.retire("%2eenv").expect("refused retire is a no-op");

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(secret_tip_len(&db, ".env"), None);
    assert_eq!(secret_tip_len(&db, "%2eenv"), None);
}
