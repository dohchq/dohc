use dohc_engine_domain::{
    CaptureIngest, CaptureIngestBinary, CaptureRetire, DomainError, ListMomentsQuery, NoFaults,
    RenameTextFile, VersionedTextStore, WriteText, binary_rollback_job_identity,
    derive_capture_moment_id, derive_capture_object_id, write_text_in_tx,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::ScratchDir;

const WS: &str = "ws-capture";
const VERSION: &str = "main";
const NO_FAULTS: NoFaults = NoFaults;

fn ingest(path: &str, text: &str, now_ms: i64) -> CaptureIngest {
    CaptureIngest {
        workspace_id: WS.to_owned(),
        version_id: VERSION.to_owned(),
        path: path.to_owned(),
        text: text.to_owned(),
        metadata_origin: "capture-test".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
        claim_foreign_head: true,
    }
}

fn retire(path: &str, now_ms: i64) -> CaptureRetire {
    CaptureRetire {
        workspace_id: WS.to_owned(),
        version_id: VERSION.to_owned(),
        path: path.to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        now_ms,
        request_id: None,
        only_if_text_head: false,
        only_if_capture_origin: false,
        allow_ydoc_origin: true,
    }
}

fn open_store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, VERSION, 1, &NO_FAULTS)
        .expect("ensure main");
    (scratch, store)
}

fn seed_sync_origin(store: &mut EngineStore, origin_id: &str) {
    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "INSERT INTO sync_identity \
                 (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
                 VALUES (?1, ?2, 'epoch', 'stream', 1)",
                [WS, origin_id],
            )
            .expect("seed sync identity");
            Ok::<_, DomainError>(())
        })
        .expect("write sync identity");
}

fn moment_count(store: &mut EngineStore) -> usize {
    VersionedTextStore::new(store)
        .list_moments(&ListMomentsQuery {
            workspace_id: WS.to_owned(),
            version_id: Some(VERSION.to_owned()),
            object_id: None,
            limit: 100,
            before_moment_order: None,
        })
        .expect("list moments")
        .moments
        .len()
}

#[test]
fn object_ids_are_stable_per_path_and_distinct_between_paths() {
    let (_scratch, mut store) = open_store();
    let mut versions = VersionedTextStore::new(&mut store);
    let first = versions
        .capture_ingest(&ingest("notes/a.md", "A", 10), &NO_FAULTS)
        .expect("first capture");
    let same = versions
        .capture_ingest(&ingest("notes/a.md", "B", 20), &NO_FAULTS)
        .expect("same path capture");
    let other = versions
        .capture_ingest(&ingest("notes/b.md", "A", 30), &NO_FAULTS)
        .expect("other path capture");

    assert_eq!(first.snapshot.object_id, same.snapshot.object_id);
    assert_ne!(first.snapshot.object_id, other.snapshot.object_id);
}

#[test]
fn recapturing_a_renamed_path_mints_a_distinct_object() {
    let (_scratch, mut store) = open_store();
    let original = VersionedTextStore::new(&mut store)
        .capture_ingest(&ingest("a.md", "original", 10), &NO_FAULTS)
        .expect("initial capture");
    VersionedTextStore::new(&mut store)
        .rename_text_file(
            &RenameTextFile {
                workspace_id: WS.to_owned(),
                version_id: VERSION.to_owned(),
                from_path: "a.md".to_owned(),
                to_path: "b.md".to_owned(),
                moment_id: "rename-a-to-b".to_owned(),
                request_id: None,
                metadata_origin: "rpc-test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 20,
            },
            &NO_FAULTS,
        )
        .expect("rename capture");

    let recaptured = VersionedTextStore::new(&mut store)
        .capture_ingest(&ingest("a.md", "new", 30), &NO_FAULTS)
        .expect("recapture original path");

    assert_ne!(recaptured.snapshot.object_id, original.snapshot.object_id);
    let renamed = VersionedTextStore::new(&mut store)
        .read_text(WS, VERSION, "b.md")
        .expect("read renamed path")
        .expect("renamed path remains live");
    assert_eq!(renamed.object_id, original.snapshot.object_id);
    assert_eq!(renamed.text, "original");
    let new_path = VersionedTextStore::new(&mut store)
        .read_text(WS, VERSION, "a.md")
        .expect("read recaptured path")
        .expect("recaptured path is live");
    assert_eq!(new_path.object_id, recaptured.snapshot.object_id);
    assert_eq!(new_path.text, "new");
}

#[test]
fn length_prefixed_capture_ids_distinguish_embedded_nul_tuples() {
    const FIRST_WS: &str = "a\0b";
    const FIRST_VERSION: &str = "c";
    const SECOND_WS: &str = "a";
    const SECOND_VERSION: &str = "b\0c";
    const PATH: &str = "same.md";

    let first_id = derive_capture_object_id(FIRST_WS, FIRST_VERSION, PATH);
    let second_id = derive_capture_object_id(SECOND_WS, SECOND_VERSION, PATH);
    assert_ne!(first_id, second_id);

    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(FIRST_WS, FIRST_VERSION, 1, &NO_FAULTS)
        .expect("ensure first tuple");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(SECOND_WS, SECOND_VERSION, 2, &NO_FAULTS)
        .expect("ensure second tuple");

    let capture = |workspace_id: &str, version_id: &str, text: &str, now_ms: i64| CaptureIngest {
        workspace_id: workspace_id.to_owned(),
        version_id: version_id.to_owned(),
        path: PATH.to_owned(),
        text: text.to_owned(),
        metadata_origin: "capture-test".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
        claim_foreign_head: true,
    };
    let first = VersionedTextStore::new(&mut store)
        .capture_ingest(&capture(FIRST_WS, FIRST_VERSION, "first", 10), &NO_FAULTS)
        .expect("capture first tuple");
    let second = VersionedTextStore::new(&mut store)
        .capture_ingest(
            &capture(SECOND_WS, SECOND_VERSION, "second", 20),
            &NO_FAULTS,
        )
        .expect("capture second tuple");

    assert_eq!(first.snapshot.object_id, first_id);
    assert_eq!(second.snapshot.object_id, second_id);
    assert_eq!(first.snapshot.text, "first");
    assert_eq!(second.snapshot.text, "second");
}

#[test]
fn new_path_mints_rows_and_identical_capture_is_a_no_op() {
    let (_scratch, mut store) = open_store();
    let first = VersionedTextStore::new(&mut store)
        .capture_ingest(&ingest("notes/a.md", "same", 10), &NO_FAULTS)
        .expect("first capture");

    let (objects, aliases): (i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM file_objects WHERE workspace_id = ?1",
                    [WS],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases WHERE workspace_id = ?1 \
                     AND version_id = ?2 AND path = 'notes/a.md'",
                    [WS, VERSION],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("row counts");
    assert_eq!((objects, aliases), (1, 1));
    assert_eq!(moment_count(&mut store), 1);

    let second = VersionedTextStore::new(&mut store)
        .capture_ingest(&ingest("notes/a.md", "same", 20), &NO_FAULTS)
        .expect("identical capture");
    assert!(second.deduped);
    assert_eq!(second.moment.moment_id, first.moment.moment_id);
    assert_eq!(moment_count(&mut store), 1);
}

#[test]
fn content_revert_gets_a_third_distinct_moment() {
    let (_scratch, mut store) = open_store();
    {
        let mut versions = VersionedTextStore::new(&mut store);
        let first = versions
            .capture_ingest(&ingest("a.md", "A", 10), &NO_FAULTS)
            .expect("A");
        let second = versions
            .capture_ingest(&ingest("a.md", "B", 20), &NO_FAULTS)
            .expect("B");
        let reverted = versions
            .capture_ingest(&ingest("a.md", "A", 30), &NO_FAULTS)
            .expect("revert A");

        assert_ne!(first.moment.moment_id, second.moment.moment_id);
        assert_ne!(first.moment.moment_id, reverted.moment.moment_id);
        assert_ne!(second.moment.moment_id, reverted.moment.moment_id);
        assert_eq!(reverted.snapshot.text, "A");
    }
    assert_eq!(moment_count(&mut store), 3);
}

#[test]
fn retire_then_recapture_reuses_the_object_and_appends_new_history() {
    let (_scratch, mut store) = open_store();
    let mut versions = VersionedTextStore::new(&mut store);
    let first = versions
        .capture_ingest(&ingest("a.md", "X", 10), &NO_FAULTS)
        .expect("first capture");
    let retired = versions
        .capture_retire(&retire("a.md", 20), &NO_FAULTS)
        .expect("retire")
        .retired
        .expect("live path retired");
    let recreated = versions
        .capture_ingest(&ingest("a.md", "X", 30), &NO_FAULTS)
        .expect("recapture");

    assert_eq!(recreated.snapshot.object_id, first.snapshot.object_id);
    assert!(!recreated.deduped);
    assert_ne!(first.moment.moment_id, retired.moment.moment_id);
    assert_ne!(first.moment.moment_id, recreated.moment.moment_id);
    assert_ne!(retired.moment.moment_id, recreated.moment.moment_id);
    assert_eq!(recreated.snapshot.text, "X");
    assert_eq!(moment_count(&mut store), 3);

    let readable = VersionedTextStore::new(&mut store)
        .read_text(WS, VERSION, "a.md")
        .expect("read recaptured path")
        .expect("recaptured path exists");
    assert_eq!(readable.text, "X");
}

#[test]
fn object_ids_are_scoped_between_workspaces_in_one_store() {
    const OTHER_WS: &str = "ws-capture-other";

    let (_scratch, mut store) = open_store();
    VersionedTextStore::new(&mut store)
        .ensure_main_version(OTHER_WS, VERSION, 2, &NO_FAULTS)
        .expect("ensure other workspace");

    let first = VersionedTextStore::new(&mut store)
        .capture_ingest(&ingest("same.md", "first", 10), &NO_FAULTS)
        .expect("first workspace capture");
    let mut other = ingest("same.md", "second", 20);
    other.workspace_id = OTHER_WS.to_owned();
    let second = VersionedTextStore::new(&mut store)
        .capture_ingest(&other, &NO_FAULTS)
        .expect("second workspace capture");

    assert_ne!(first.snapshot.object_id, second.snapshot.object_id);
    assert_eq!(first.snapshot.path, second.snapshot.path);
}

#[test]
fn retire_removes_the_head_and_repeated_or_unknown_paths_are_clean_no_ops() {
    let (_scratch, mut store) = open_store();
    let mut versions = VersionedTextStore::new(&mut store);
    versions
        .capture_ingest(&ingest("a.md", "A", 10), &NO_FAULTS)
        .expect("capture");
    let retired = versions
        .capture_retire(&retire("a.md", 20), &NO_FAULTS)
        .expect("retire");
    assert!(retired.retired.is_some());
    assert!(
        versions
            .read_text(WS, VERSION, "a.md")
            .expect("read")
            .is_none()
    );

    let repeated = versions
        .capture_retire(&retire("a.md", 30), &NO_FAULTS)
        .expect("repeated retire");
    assert!(repeated.retired.is_none());
    assert!(!repeated.deduped);

    let missing = versions
        .capture_retire(&retire("missing.md", 40), &NO_FAULTS)
        .expect("unknown retire");
    assert!(missing.retired.is_none());
    assert!(!missing.deduped);
}

#[test]
fn moment_id_derivation_is_deterministic_for_equal_inputs() {
    let first = derive_capture_moment_id("producer", "workspace", "object-id", 42, "write", "sha");
    let second = derive_capture_moment_id("producer", "workspace", "object-id", 42, "write", "sha");

    assert_eq!(first, second);
    assert_eq!(first.len(), "moment-".len() + 64);
    assert_ne!(
        first,
        derive_capture_moment_id("producer", "workspace", "object-id", 43, "write", "sha")
    );
    assert_ne!(
        first,
        derive_capture_moment_id("producer", "other", "object-id", 42, "write", "sha")
    );
    assert_ne!(
        first,
        derive_capture_moment_id(
            "other-producer",
            "workspace",
            "object-id",
            42,
            "write",
            "sha"
        )
    );
    assert_ne!(
        first,
        derive_capture_moment_id(
            "producer",
            "workspace",
            "object-id",
            42,
            "write",
            "other-sha"
        )
    );
}

#[test]
fn concurrent_capture_moment_ids_are_namespaced_by_replica_origin() {
    let (_scratch_a, mut store_a) = open_store();
    let (_scratch_b, mut store_b) = open_store();
    seed_sync_origin(&mut store_a, "origin-a");
    seed_sync_origin(&mut store_b, "origin-b");

    let captured_a = VersionedTextStore::new(&mut store_a)
        .capture_ingest(&ingest("same.md", "edit from A", 10), &NO_FAULTS)
        .expect("capture A");
    let captured_b = VersionedTextStore::new(&mut store_b)
        .capture_ingest(&ingest("same.md", "edit from B", 10), &NO_FAULTS)
        .expect("capture B");

    assert_eq!(captured_a.snapshot.object_id, captured_b.snapshot.object_id);
    assert_eq!(
        captured_a.moment.moment_order,
        captured_b.moment.moment_order
    );
    assert_ne!(captured_a.moment.moment_id, captured_b.moment.moment_id);
}

#[test]
fn local_capture_does_not_collide_with_an_imported_replica_moment() {
    let (_scratch, mut store) = open_store();
    seed_sync_origin(&mut store, "origin-b");
    let path = "same.md";
    let object_id = derive_capture_object_id(WS, VERSION, path);
    let imported_moment_id = derive_capture_moment_id(
        "origin-a",
        WS,
        &object_id,
        1,
        "write",
        &dohc_engine_storage::hex_sha256(b"shared base"),
    );

    store
        .write_with(&NO_FAULTS, |tx| {
            write_text_in_tx(
                tx,
                &WriteText {
                    workspace_id: WS.to_owned(),
                    version_id: VERSION.to_owned(),
                    object_id: object_id.clone(),
                    path: path.to_owned(),
                    text: "shared base".to_owned(),
                    moment_id: imported_moment_id.clone(),
                    request_id: None,
                    metadata_origin: "replication".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 10,
                },
            )?;
            tx.execute(
                "DELETE FROM materialization_jobs WHERE workspace_id = ?1 AND job_id = ?2",
                [WS, imported_moment_id.as_str()],
            )
            .expect("remove local materialization artifact");
            tx.execute(
                "UPDATE moments SET moment_order = 0 \
                 WHERE workspace_id = ?1 AND moment_id = ?2",
                [WS, imported_moment_id.as_str()],
            )
            .expect("assign imported local order");
            Ok::<_, DomainError>(())
        })
        .expect("import remote moment");

    let captured = VersionedTextStore::new(&mut store)
        .capture_ingest(&ingest(path, "local edit", 20), &NO_FAULTS)
        .expect("capture local edit after import");

    assert_eq!(captured.moment.moment_order, 1);
    assert_ne!(captured.moment.moment_id, imported_moment_id);
    assert_eq!(captured.snapshot.text, "local edit");
}

#[test]
fn request_ids_replay_ingest_and_retire_exactly_once() {
    let (_scratch, mut store) = open_store();
    let mut write = ingest("a.md", "A", 10);
    write.request_id = Some("capture-write-request".to_owned());
    let first = VersionedTextStore::new(&mut store)
        .capture_ingest(&write, &NO_FAULTS)
        .expect("first capture");
    let mut write_replay = write.clone();
    write_replay.now_ms = 999;
    let replay = VersionedTextStore::new(&mut store)
        .capture_ingest(&write_replay, &NO_FAULTS)
        .expect("capture replay");
    assert!(replay.deduped);
    assert_eq!(replay.moment.moment_id, first.moment.moment_id);

    let mut delete = retire("a.md", 20);
    delete.request_id = Some("capture-retire-request".to_owned());
    let first_delete = VersionedTextStore::new(&mut store)
        .capture_retire(&delete, &NO_FAULTS)
        .expect("first retire");
    let mut delete_replay = delete.clone();
    delete_replay.now_ms = 1_999;
    let replay_delete = VersionedTextStore::new(&mut store)
        .capture_retire(&delete_replay, &NO_FAULTS)
        .expect("retire replay");
    assert!(replay_delete.deduped);
    // The replayed inner result reports ITS OWN dedupe honestly; every
    // other field must match the original byte-for-byte.
    let mut expected = first_delete.retired.clone();
    if let Some(expected) = expected.as_mut() {
        expected.deduped = true;
    }
    assert_eq!(replay_delete.retired, expected);
    assert_eq!(moment_count(&mut store), 2);
}

#[test]
fn request_id_reuse_with_changed_capture_provenance_is_rejected() {
    let (_scratch, mut store) = open_store();
    let mut first = ingest("a.md", "A", 10);
    first.request_id = Some("capture-provenance-request".to_owned());
    VersionedTextStore::new(&mut store)
        .capture_ingest(&first, &NO_FAULTS)
        .expect("first capture");

    let mut changed = first.clone();
    changed.metadata_origin = "different-origin".to_owned();
    changed.now_ms = 20;
    let error = VersionedTextStore::new(&mut store)
        .capture_ingest(&changed, &NO_FAULTS)
        .expect_err("changed provenance must not replay");

    assert!(matches!(error, DomainError::IdempotencyKeyReuseMismatch));

    let mut changed_author = first;
    changed_author.author_json = Some(r#"{"name":"different-author"}"#.to_owned());
    changed_author.now_ms = 30;
    let error = VersionedTextStore::new(&mut store)
        .capture_ingest(&changed_author, &NO_FAULTS)
        .expect_err("changed author provenance must not replay");

    assert!(matches!(error, DomainError::IdempotencyKeyReuseMismatch));
    assert_eq!(moment_count(&mut store), 1);
}

#[test]
fn retire_only_if_text_head_never_deletes_a_binary_head() {
    use dohc_engine_domain::{WriteBinaryFile, write_binary_file_in_tx};
    use dohc_engine_storage::{Preimage, hex_sha256, put_binary_blob};

    let (_scratch, mut store) = open_store();
    let bytes = [0xffu8, 0x00, 0xfe];
    let sha = hex_sha256(&bytes);
    store
        .write_with(&NO_FAULTS, |tx| {
            put_binary_blob(tx, &bytes).map_err(DomainError::from)?;
            write_binary_file_in_tx(
                tx,
                &WriteBinaryFile {
                    workspace_id: WS.to_owned(),
                    version_id: VERSION.to_owned(),
                    object_id: "bin-object-1".to_owned(),
                    path: "photo.png".to_owned(),
                    binary_sha256: sha.clone(),
                    moment_id: "binjob-1".to_owned(),
                    metadata_origin: "sync".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    materialize: Some(Preimage::Absent),
                    now_ms: 10,
                },
            )
        })
        .expect("binary head");

    // The plaintext sink's text-only retire must be a no-op on a live binary
    // head — the binary owner's state is not the text plane's to delete.
    let result = VersionedTextStore::new(&mut store)
        .capture_retire(
            &CaptureRetire {
                only_if_text_head: true,
                ..retire("photo.png", 20)
            },
            &NO_FAULTS,
        )
        .expect("text-only retire settles as a no-op");
    assert!(result.retired.is_none());
    assert!(!result.deduped);

    // The unconditional retire still owns the full lifecycle (file gone from
    // disk retires whatever head remains).
    let result = VersionedTextStore::new(&mut store)
        .capture_retire(&retire("photo.png", 30), &NO_FAULTS)
        .expect("full retire");
    assert!(result.retired.is_some());
}

fn ingest_binary(path: &str, bytes: &[u8], now_ms: i64) -> CaptureIngestBinary {
    CaptureIngestBinary {
        workspace_id: WS.to_owned(),
        version_id: VERSION.to_owned(),
        path: path.to_owned(),
        bytes: bytes.to_vec(),
        metadata_origin: "capture-test".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
        claim_foreign_head: true,
    }
}

fn job_count_by_status(store: &EngineStore, status: &str) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM materialization_jobs WHERE status = ?1",
                [status],
                |row| row.get(0),
            )
        })
        .expect("job count")
}

#[test]
fn binary_capture_persists_a_jobless_binary_head_and_dedupes() {
    use dohc_engine_storage::hex_sha256;

    let (_scratch, mut store) = open_store();
    let bytes = [0xffu8, 0x00, 0x01, 0x02];
    let first = VersionedTextStore::new(&mut store)
        .capture_ingest_binary(&ingest_binary("photo.png", &bytes, 10), &NO_FAULTS)
        .expect("first binary capture");
    assert!(!first.deduped);
    assert_eq!(first.binary_sha256, hex_sha256(&bytes));

    // Capture-from-disk must never enqueue a RUNNABLE job (the bytes came
    // FROM disk — TS oracle parity: capture never writes disk), but it records
    // a COMPLETED marker so the materializer's staleness gate supersedes any
    // older still-pending job for the path.
    assert_eq!(job_count_by_status(&store, "pending"), 0);
    assert_eq!(job_count_by_status(&store, "complete"), 1);

    // Content-equality no-op: the interleave-safety guarantee.
    let second = VersionedTextStore::new(&mut store)
        .capture_ingest_binary(&ingest_binary("photo.png", &bytes, 20), &NO_FAULTS)
        .expect("equal binary capture");
    assert!(second.deduped);
    assert_eq!(second.moment_order, first.moment_order);
    assert_eq!(moment_count(&mut store), 1);

    // Changed bytes append one new moment on the same object.
    let third = VersionedTextStore::new(&mut store)
        .capture_ingest_binary(&ingest_binary("photo.png", &[0xaa, 0xbb], 30), &NO_FAULTS)
        .expect("changed binary capture");
    assert!(!third.deduped);
    assert_eq!(third.object_id, first.object_id);
    assert_eq!(moment_count(&mut store), 2);
}

#[test]
fn binary_capture_replaces_a_text_head_and_text_recaptures_over_binary() {
    let (_scratch, mut store) = open_store();
    VersionedTextStore::new(&mut store)
        .capture_ingest(&ingest("flip.md", "was text", 10), &NO_FAULTS)
        .expect("seed text");
    let flipped = VersionedTextStore::new(&mut store)
        .capture_ingest_binary(&ingest_binary("flip.md", &[0xff, 0xfe], 20), &NO_FAULTS)
        .expect("flip to binary");
    assert!(!flipped.deduped);

    // read_text fails closed on the binary head (BINHEAD contract).
    let err = VersionedTextStore::new(&mut store)
        .read_text(WS, VERSION, "flip.md")
        .expect_err("binary head is not text");
    assert!(matches!(err, DomainError::BinaryHeadNotText));

    // And text capture flips it back on the SAME object.
    let back = VersionedTextStore::new(&mut store)
        .capture_ingest(&ingest("flip.md", "text again", 30), &NO_FAULTS)
        .expect("flip back to text");
    assert_eq!(back.moment.object_id, flipped.object_id);
    let snapshot = VersionedTextStore::new(&mut store)
        .read_text(WS, VERSION, "flip.md")
        .expect("read text")
        .expect("text head");
    assert_eq!(snapshot.text, "text again");
}

#[test]
fn binary_capture_request_id_replays_and_rejects_reuse() {
    let (_scratch, mut store) = open_store();
    let mut input = ingest_binary("img.png", &[1, 2, 3], 10);
    input.request_id = Some("req-bin-1".to_owned());
    let first = VersionedTextStore::new(&mut store)
        .capture_ingest_binary(&input, &NO_FAULTS)
        .expect("first");
    let replay = VersionedTextStore::new(&mut store)
        .capture_ingest_binary(&input, &NO_FAULTS)
        .expect("replay");
    assert!(replay.deduped);
    assert_eq!(replay.moment_order, first.moment_order);
    assert_eq!(moment_count(&mut store), 1);

    let mut reused = ingest_binary("img.png", &[9, 9, 9], 20);
    reused.request_id = Some("req-bin-1".to_owned());
    let err = VersionedTextStore::new(&mut store)
        .capture_ingest_binary(&reused, &NO_FAULTS)
        .expect_err("payload mismatch under a reused request id");
    assert!(matches!(err, DomainError::IdempotencyKeyReuseMismatch));
}

#[test]
fn binary_capture_over_cap_and_bad_paths_are_refused() {
    let (_scratch, mut store) = open_store();
    let oversized = vec![0u8; dohc_engine_domain::MAX_CAPTURE_BINARY_FILE_BYTES + 1];
    let err = VersionedTextStore::new(&mut store)
        .capture_ingest_binary(&ingest_binary("big.bin", &oversized, 10), &NO_FAULTS)
        .expect_err("over-cap bytes are refused");
    assert!(matches!(err, DomainError::InvalidInput { .. }));

    for bad in [".env", ".dohc/x.bin", "a\u{0}b.bin", "../escape.bin"] {
        let err = VersionedTextStore::new(&mut store)
            .capture_ingest_binary(&ingest_binary(bad, &[1], 10), &NO_FAULTS)
            .expect_err("non-storable path refused");
        assert!(matches!(err, DomainError::InvalidPath { .. }), "{bad}");
    }
}

#[test]
fn rollback_of_a_capture_binary_moment_still_restores_disk() {
    use dohc_engine_domain::RollbackTextFileMutation;

    let (_scratch, mut store) = open_store();
    VersionedTextStore::new(&mut store)
        .capture_ingest(&ingest("flip.md", "original text", 10), &NO_FAULTS)
        .expect("seed text");
    let flipped = VersionedTextStore::new(&mut store)
        .capture_ingest_binary(&ingest_binary("flip.md", &[0xde, 0xad], 20), &NO_FAULTS)
        .expect("binary capture");
    assert_eq!(
        job_count_by_status(&store, "pending"),
        0,
        "capture never enqueues runnable work"
    );

    VersionedTextStore::new(&mut store)
        .rollback_text_file_mutation(
            &RollbackTextFileMutation {
                workspace_id: WS.to_owned(),
                version_id: VERSION.to_owned(),
                path: "flip.md".to_owned(),
                mutation_moment_id: flipped.moment_id.clone(),
                request_id: None,
                legacy_before_text: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            &NO_FAULTS,
        )
        .expect("rollback the capture binary moment");

    // The rolled-back head must be reconciled TO disk even though capture
    // never enqueued a job — otherwise disk keeps the newer bytes while the
    // reconcile manifest records them as captured, and the DB head silently
    // diverges forever.
    let restore_job_id = binary_rollback_job_identity(WS, VERSION, &flipped.moment_id);
    let restore_jobs: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM materialization_jobs \
                 WHERE job_id = ?1 AND status = 'pending'",
                [restore_job_id],
                |row| row.get(0),
            )
        })
        .expect("restore job count");
    assert_eq!(restore_jobs, 1, "the compensating restore must be enqueued");

    let snapshot = VersionedTextStore::new(&mut store)
        .read_text(WS, VERSION, "flip.md")
        .expect("read text")
        .expect("restored text head");
    assert_eq!(snapshot.text, "original text");
}

#[test]
fn capture_supersedes_an_older_pending_materialization_job() {
    use dohc_engine_domain::{WriteBinaryFile, write_binary_file_in_tx};
    use dohc_engine_files::{
        DurabilityPolicy, JobOutcome, NoBackoff, StdReplacer, run_pending_jobs,
    };
    use dohc_engine_storage::{Preimage, hex_sha256, put_binary_blob};

    let (scratch, mut store) = open_store();
    let disk_bytes = b"bytes the user wrote";
    let stale_bytes = b"stale resolve content";
    std::fs::write(scratch.path().join("doc.bin"), disk_bytes).expect("seed disk");

    // An older mirrored-resolve write enqueues a PENDING job whose preimage
    // matches the CURRENT disk bytes (the exact codex-review scenario).
    let stale_sha = hex_sha256(stale_bytes);
    store
        .write_with(&NO_FAULTS, |tx| {
            put_binary_blob(tx, stale_bytes).map_err(DomainError::from)?;
            write_binary_file_in_tx(
                tx,
                &WriteBinaryFile {
                    workspace_id: WS.to_owned(),
                    version_id: VERSION.to_owned(),
                    object_id: "resolve-object".to_owned(),
                    path: "doc.bin".to_owned(),
                    binary_sha256: stale_sha.clone(),
                    moment_id: "resolve-moment".to_owned(),
                    metadata_origin: "sync".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    materialize: Some(Preimage::Present(hex_sha256(disk_bytes))),
                    now_ms: 10,
                },
            )
        })
        .expect("older resolve write with pending job");

    // The user's on-disk bytes are captured at a NEWER generation.
    VersionedTextStore::new(&mut store)
        .capture_ingest_binary(&ingest_binary("doc.bin", disk_bytes, 20), &NO_FAULTS)
        .expect("capture the live disk bytes");

    // Draining the materializer must SUPERSEDE the stale job — never regress
    // disk behind the captured head.
    let results = run_pending_jobs(
        &store,
        scratch.path(),
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        200,
        &NO_FAULTS,
    )
    .expect("drain");
    let stale = results
        .iter()
        .find(|result| result.job_id == "resolve-moment")
        .expect("stale job drained");
    assert!(
        matches!(stale.outcome, JobOutcome::Superseded),
        "stale job must be superseded, got {:?}",
        stale.outcome
    );
    assert_eq!(
        std::fs::read(scratch.path().join("doc.bin")).expect("read disk"),
        disk_bytes,
        "disk must keep the captured bytes"
    );
}

#[test]
fn recapture_after_rollback_advances_past_the_durable_restore() {
    use dohc_engine_domain::RollbackTextFileMutation;

    let (_scratch, mut store) = open_store();
    let first = VersionedTextStore::new(&mut store)
        .capture_ingest_binary(&ingest_binary("doc.bin", &[0x01, 0x02], 10), &NO_FAULTS)
        .expect("first capture");

    VersionedTextStore::new(&mut store)
        .rollback_text_file_mutation(
            &RollbackTextFileMutation {
                workspace_id: WS.to_owned(),
                version_id: VERSION.to_owned(),
                path: "doc.bin".to_owned(),
                mutation_moment_id: first.moment_id.clone(),
                request_id: None,
                legacy_before_text: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            &NO_FAULTS,
        )
        .expect("rollback the capture");

    // The rollback deletes the moment, but its durable restore generation is
    // now the ordering high-water mark. Recapture must advance beyond it and
    // record a distinct completed marker for the newly observed bytes.
    let second = VersionedTextStore::new(&mut store)
        .capture_ingest_binary(&ingest_binary("doc.bin", &[0x03, 0x04], 20), &NO_FAULTS)
        .expect("recapture after rollback");
    assert!(!second.deduped);
    assert!(
        second.moment_order > first.moment_order,
        "history surgery must not move the durable generation backward"
    );
    assert_ne!(
        second.moment_id, first.moment_id,
        "the advanced order derives a distinct capture marker"
    );

    let marker: (String, i64) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT content_sha256, target_generation FROM materialization_jobs \
                 WHERE job_id = ?1 AND status = 'complete'",
                [second.moment_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("reclaimed marker");
    assert_eq!(
        marker.0, second.binary_sha256,
        "marker carries the NEW bytes"
    );
    assert_eq!(marker.1, second.moment_order);
}

#[test]
fn deduped_capture_marks_the_confirmed_head_as_materialized() {
    use dohc_engine_domain::{WriteBinaryFile, write_binary_file_in_tx};
    use dohc_engine_files::{
        DurabilityPolicy, JobOutcome, NoBackoff, StdReplacer, run_pending_jobs,
    };
    use dohc_engine_storage::{Preimage, hex_sha256, put_binary_blob};

    let (scratch, mut store) = open_store();
    let live_bytes = b"bytes on disk and in the head";
    let stale_bytes = b"older stale content";
    std::fs::write(scratch.path().join("doc.bin"), live_bytes).expect("seed disk");

    // Two sequential resolve writes to the SAME path leave an OLDER pending
    // job (stale bytes, preimage matching the current disk) beneath the head
    // whose own newer job is also still pending.
    store
        .write_with(&NO_FAULTS, |tx| {
            put_binary_blob(tx, stale_bytes).map_err(DomainError::from)?;
            write_binary_file_in_tx(
                tx,
                &WriteBinaryFile {
                    workspace_id: WS.to_owned(),
                    version_id: VERSION.to_owned(),
                    object_id: "doc-object".to_owned(),
                    path: "doc.bin".to_owned(),
                    binary_sha256: hex_sha256(stale_bytes),
                    moment_id: "old-moment".to_owned(),
                    metadata_origin: "sync".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    materialize: Some(Preimage::Present(hex_sha256(live_bytes))),
                    now_ms: 5,
                },
            )?;
            put_binary_blob(tx, live_bytes).map_err(DomainError::from)?;
            write_binary_file_in_tx(
                tx,
                &WriteBinaryFile {
                    workspace_id: WS.to_owned(),
                    version_id: VERSION.to_owned(),
                    object_id: "doc-object".to_owned(),
                    path: "doc.bin".to_owned(),
                    binary_sha256: hex_sha256(live_bytes),
                    moment_id: "live-moment".to_owned(),
                    metadata_origin: "sync".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    materialize: Some(Preimage::Present(hex_sha256(live_bytes))),
                    now_ms: 10,
                },
            )
        })
        .expect("two resolve writes with pending jobs");

    // Capture observes bytes equal to the head: a DEDUPED no-op for history,
    // but it must still mark the confirmed head as materialized so the stale
    // job cannot run first and regress the verified disk bytes.
    let deduped = VersionedTextStore::new(&mut store)
        .capture_ingest_binary(&ingest_binary("doc.bin", live_bytes, 20), &NO_FAULTS)
        .expect("deduped capture");
    assert!(deduped.deduped);

    let results = run_pending_jobs(
        &store,
        scratch.path(),
        DurabilityPolicy::none(),
        &StdReplacer,
        &NoBackoff,
        200,
        &NO_FAULTS,
    )
    .expect("drain");
    let stale = results
        .iter()
        .find(|result| result.job_id == "old-moment")
        .expect("stale job drained");
    assert!(
        matches!(stale.outcome, JobOutcome::Superseded),
        "stale job must be superseded by the dedupe marker, got {:?}",
        stale.outcome
    );
    assert_eq!(
        std::fs::read(scratch.path().join("doc.bin")).expect("read disk"),
        live_bytes,
        "disk must keep the confirmed bytes"
    );
}

#[test]
fn the_capture_origin_is_reserved_on_the_public_write_path() {
    use dohc_engine_domain::{WriteText, validate_write_input};

    // A caller must not be able to FORGE capture ownership: a write claiming
    // the reserved origin would be seeded as capture-owned on the next open
    // and retired for having no disk counterpart.
    let forged = WriteText {
        workspace_id: WS.to_owned(),
        version_id: VERSION.to_owned(),
        object_id: "obj-forged".to_owned(),
        path: "forged.md".to_owned(),
        text: "written by an RPC caller".to_owned(),
        moment_id: "m-forged".to_owned(),
        metadata_origin: "capture".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 10,
        request_id: None,
    };
    let err = validate_write_input(&forged).expect_err("reserved origin must be refused");
    assert!(matches!(err, DomainError::InvalidInput { .. }));

    // And — the case that matters — the REAL write path must refuse it too.
    // A guard living only in the validator would never see the RPC surface,
    // which reaches write_text_in_tx through the normalizer instead.
    let (_scratch, mut store) = open_store();
    let err = VersionedTextStore::new(&mut store)
        .write_text(&forged, &NO_FAULTS)
        .expect_err("the real write path must reserve the capture origin");
    assert!(matches!(err, DomainError::InvalidInput { .. }));

    // Every ordinary origin still passes.
    let ordinary = WriteText {
        metadata_origin: "api".to_owned(),
        ..forged
    };
    validate_write_input(&ordinary).expect("ordinary origins are unaffected");
}

#[test]
fn a_claimed_dedupe_transfers_ownership_to_capture() {
    let (_scratch, mut store) = open_store();
    // A foreign writer establishes the head.
    VersionedTextStore::new(&mut store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: WS.to_owned(),
                version_id: VERSION.to_owned(),
                object_id: "obj-shared".to_owned(),
                path: "shared.md".to_owned(),
                text: "same bytes".to_owned(),
                moment_id: "m-foreign".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("foreign write");
    store
        .read_with(|conn| {
            conn.execute(
                "UPDATE snapshots SET metadata_summary = 'peer summary', \
                 metadata_correlation_id = 'peer correlation' \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = 'obj-shared'",
                [WS, VERSION],
            )
        })
        .expect("seed imported metadata");

    // Capture OBSERVES the same bytes on disk (a claimed capture that
    // dedupes). Ownership must transfer, or later disk-driven retires stay
    // blocked forever against a head capture legitimately claimed.
    let mut claimed = ingest("shared.md", "same bytes", 20);
    claimed.claim_foreign_head = true;
    VersionedTextStore::new(&mut store)
        .capture_ingest(&claimed, &NO_FAULTS)
        .expect("claimed dedupe");

    let metadata: (String, Option<String>, Option<String>) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT metadata_origin, metadata_summary, metadata_correlation_id \
                 FROM snapshots WHERE workspace_id = ?1 AND path = ?2",
                [WS, "shared.md"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .expect("head metadata");
    // MUTATION: retaining either imported optional column in the ownership
    // transfer makes this tuple disagree with capture's local provenance.
    assert_eq!(
        metadata,
        ("capture-test".to_owned(), None, None),
        "a claimed dedupe must replace the complete metadata tuple"
    );
}

#[test]
fn disk_driven_retire_owns_materialized_ydoc_heads() {
    let (_scratch, mut store) = open_store();
    // Seed a materialized Y.Doc head exactly as a settle does (the generic
    // write path reserves the 'ydoc' origin).
    store
        .write_with(&NO_FAULTS, |tx| {
            dohc_engine_domain::write_projected_text_in_tx(
                tx,
                &dohc_engine_domain::WriteText {
                    workspace_id: WS.to_owned(),
                    version_id: VERSION.to_owned(),
                    object_id: "obj-ydoc-retire".to_owned(),
                    path: "notes/settled.md".to_owned(),
                    text: "settled body".to_owned(),
                    moment_id: "m-ydoc-retire".to_owned(),
                    metadata_origin: "ydoc".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 10,
                    request_id: None,
                },
            )
        })
        .expect("ydoc head");
    // The manifest seeds 'ydoc' rows into the baseline scanner, so its file
    // deleted while the daemon was down MUST retire the head — a stale
    // snapshot must not stay readable forever. Mutation check: drop the
    // YDOC_ORIGIN arm from `capture_retire_in_tx`'s origin gate — this
    // retire settles as a no-op and the assertion fails.
    let result = VersionedTextStore::new(&mut store)
        .capture_retire(
            &CaptureRetire {
                only_if_capture_origin: true,
                ..retire("notes/settled.md", 20)
            },
            &NO_FAULTS,
        )
        .expect("disk-driven retire");
    assert!(
        result.retired.is_some(),
        "materialized ydoc heads are disk-owned"
    );

    // RPC/agent-origin heads stay protected from disk-driven retires.
    VersionedTextStore::new(&mut store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: WS.to_owned(),
                version_id: VERSION.to_owned(),
                object_id: "obj-api-retire".to_owned(),
                path: "notes/api.md".to_owned(),
                text: "api body".to_owned(),
                moment_id: "m-api-retire".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 30,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("api write");
    let protected = VersionedTextStore::new(&mut store)
        .capture_retire(
            &CaptureRetire {
                only_if_capture_origin: true,
                ..retire("notes/api.md", 40)
            },
            &NO_FAULTS,
        )
        .expect("protected retire is a no-op");
    assert!(protected.retired.is_none(), "RPC heads stay protected");
}

#[test]
fn snapshot_metadata_reports_which_paths_the_ydoc_editor_owns() {
    // AUDIT-SILENTSAVE round 4 (D3). `has_ydoc_marker` is what stops the
    // desktop capture layer from retiring a settled Y.Doc for exceeding a cap
    // a Y.Doc is not bound by. The whole daemon half of that fix rests on this
    // EXISTS subquery, so it is asserted BOTH ways here rather than only
    // through the e2e.
    let (_scratch, mut store) = open_store();

    // An ordinary captured text file: no Y.Doc lineage.
    VersionedTextStore::new(&mut store)
        .capture_ingest(&ingest("notes/plain.md", "plain body", 10), &NO_FAULTS)
        .expect("plain ingest");

    // A materialized Y.Doc head plus its marker, exactly as a settle leaves
    // them (the marker is what ydoc.open/close key off; the snapshot alone is
    // just text).
    store
        .write_with(&NO_FAULTS, |tx| {
            dohc_engine_domain::write_projected_text_in_tx(
                tx,
                &dohc_engine_domain::WriteText {
                    workspace_id: WS.to_owned(),
                    version_id: VERSION.to_owned(),
                    object_id: "obj-ydoc-marker".to_owned(),
                    path: "notes/settled.md".to_owned(),
                    text: "settled body".to_owned(),
                    moment_id: "m-ydoc-marker".to_owned(),
                    metadata_origin: "ydoc".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 20,
                    request_id: None,
                },
            )?;
            tx.execute(
                "INSERT INTO ydoc_docs \
                 (workspace_id, version_id, object_id, updated_at_ms) \
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![WS, VERSION, "obj-ydoc-marker", 20i64],
            )
            .expect("ydoc marker insert");
            Ok::<(), DomainError>(())
        })
        .expect("ydoc marker");

    let rows = VersionedTextStore::new(&mut store)
        .list_snapshot_metadata(WS, VERSION, None, 50)
        .expect("list metadata");
    let marker_for = |path: &str| {
        rows.iter()
            .find(|row| row.path == path)
            .unwrap_or_else(|| panic!("no row for {path}"))
            .has_ydoc_marker
    };

    assert!(
        marker_for("notes/settled.md"),
        "a path with a ydoc_docs marker must report has_ydoc_marker"
    );
    assert!(
        !marker_for("notes/plain.md"),
        "an ordinary captured file must NOT report has_ydoc_marker"
    );
}

#[test]
fn a_non_ownable_retire_must_not_destroy_a_materialized_ydoc_head() {
    // AUDIT-SILENTSAVE round 3. The origin gate admits Y.Doc heads so a file
    // DELETED while the daemon was down still retires. The capture sink then
    // reused that permission for a different reason — "no longer
    // engine-ownable" — and a settled Y.Doc past the 128 KiB capture cap is
    // reported exactly that way. Result: the user pastes 131 KB, sees an
    // honest "Saved" with the bytes on disk, quits, reopens, and reconcile
    // journals "Stopped tracking non-text content" over a document they are
    // actively editing. The reason must decide, not the origin alone.
    let (_scratch, mut store) = open_store();
    store
        .write_with(&NO_FAULTS, |tx| {
            dohc_engine_domain::write_projected_text_in_tx(
                tx,
                &dohc_engine_domain::WriteText {
                    workspace_id: WS.to_owned(),
                    version_id: VERSION.to_owned(),
                    object_id: "obj-ydoc-overcap".to_owned(),
                    path: "notes/huge.md".to_owned(),
                    text: "settled body past the capture cap".to_owned(),
                    moment_id: "m-ydoc-overcap".to_owned(),
                    metadata_origin: "ydoc".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 10,
                    request_id: None,
                },
            )
        })
        .expect("ydoc head");

    let refused = VersionedTextStore::new(&mut store)
        .capture_retire(
            &CaptureRetire {
                only_if_capture_origin: true,
                // The "stopped being ownable" reason: a Y.Doc's own artifact
                // is never that.
                allow_ydoc_origin: false,
                ..retire("notes/huge.md", 20)
            },
            &NO_FAULTS,
        )
        .expect("non-ownable retire settles");
    assert!(
        refused.retired.is_none(),
        "a settled Y.Doc head must survive a not-engine-ownable retire"
    );

    // The head is genuinely still readable — not merely "no moment minted".
    let head = VersionedTextStore::new(&mut store)
        .read_text(WS, VERSION, "notes/huge.md")
        .expect("read head");
    assert!(
        head.is_some(),
        "the Y.Doc head must still be there after the refused retire"
    );

    // And the DELETE reason still retires it, so a file removed while the
    // daemon was down does not leave a stale snapshot readable forever.
    let deleted = VersionedTextStore::new(&mut store)
        .capture_retire(
            &CaptureRetire {
                only_if_capture_origin: true,
                allow_ydoc_origin: true,
                ..retire("notes/huge.md", 30)
            },
            &NO_FAULTS,
        )
        .expect("delete-driven retire");
    assert!(
        deleted.retired.is_some(),
        "the delete reason must still own materialized ydoc heads"
    );
}

#[test]
fn capture_ingest_persists_the_supplied_summary_and_correlation() {
    // MUTATION: reverting either plumb-through in capture_ingest_in_tx /
    // capture_ingest_binary_in_tx (back to hardcoded None) fails this test —
    // the daemon reconcile pass depends on both reaching the moment row.
    let (_scratch, mut store) = open_store();
    let mut text_input = ingest("notes/a.md", "A", 10);
    text_input.metadata_summary = Some("Reconciled offline edits".to_owned());
    text_input.metadata_correlation_id = Some("reconcile-1".to_owned());
    let text_result = VersionedTextStore::new(&mut store)
        .capture_ingest(&text_input, &NO_FAULTS)
        .expect("text capture");
    assert_eq!(
        text_result.moment.metadata_summary.as_deref(),
        Some("Reconciled offline edits")
    );
    assert_eq!(
        text_result.moment.metadata_correlation_id.as_deref(),
        Some("reconcile-1")
    );

    let mut binary_input = ingest_binary("img.png", &[0xff, 0x00, 0x01], 20);
    binary_input.metadata_summary = Some("Reconciled offline edits".to_owned());
    binary_input.metadata_correlation_id = Some("reconcile-1".to_owned());
    let binary_result = VersionedTextStore::new(&mut store)
        .capture_ingest_binary(&binary_input, &NO_FAULTS)
        .expect("binary capture");
    let moments = VersionedTextStore::new(&mut store)
        .list_moments(&ListMomentsQuery {
            workspace_id: WS.to_owned(),
            version_id: Some(VERSION.to_owned()),
            object_id: Some(binary_result.object_id.clone()),
            limit: 10,
            before_moment_order: None,
        })
        .expect("list binary moments");
    let moment = moments
        .moments
        .iter()
        .find(|moment| moment.moment_id == binary_result.moment_id)
        .expect("binary capture moment");
    assert_eq!(
        moment.metadata_summary.as_deref(),
        Some("Reconciled offline edits")
    );
    assert_eq!(
        moment.metadata_correlation_id.as_deref(),
        Some("reconcile-1")
    );

    // The RETIRE path too: a delete recorded mid-pass must carry the pass
    // provenance or it splits the history group.
    let mut retire_input = retire("notes/a.md", 30);
    retire_input.metadata_summary = Some("Reconciled offline edits".to_owned());
    retire_input.metadata_correlation_id = Some("reconcile-1".to_owned());
    let retired = VersionedTextStore::new(&mut store)
        .capture_retire(&retire_input, &NO_FAULTS)
        .expect("retire")
        .retired
        .expect("head existed");
    assert_eq!(
        retired.moment.metadata_summary.as_deref(),
        Some("Reconciled offline edits")
    );
    assert_eq!(
        retired.moment.metadata_correlation_id.as_deref(),
        Some("reconcile-1")
    );
}

#[test]
fn live_capture_labels_default_at_the_primitive() {
    // TS `writeIfChanged` parity, enforced at the capture primitive: a plain
    // live TEXT capture carries NO summary, a live BINARY capture carries
    // "Updated <basename>", and content-kind flips get the honest
    // transition labels.
    let (_scratch, mut store) = open_store();
    let plain = VersionedTextStore::new(&mut store)
        .capture_ingest(&ingest("notes/plain.md", "text", 10), &NO_FAULTS)
        .expect("plain text capture");
    assert_eq!(plain.moment.metadata_summary, None);

    let binary = VersionedTextStore::new(&mut store)
        .capture_ingest_binary(&ingest_binary("photo.png", &[0xaa, 0xbb], 20), &NO_FAULTS)
        .expect("binary capture");
    let listed = VersionedTextStore::new(&mut store)
        .list_moments(&ListMomentsQuery {
            workspace_id: WS.to_owned(),
            version_id: Some(VERSION.to_owned()),
            object_id: Some(binary.object_id.clone()),
            limit: 10,
            before_moment_order: None,
        })
        .expect("list binary moments");
    assert_eq!(
        listed.moments[0].metadata_summary.as_deref(),
        Some("Updated photo.png")
    );

    // text -> binary flip on the same object.
    let flipped = VersionedTextStore::new(&mut store)
        .capture_ingest_binary(
            &ingest_binary("notes/plain.md", &[0xff, 0x00], 30),
            &NO_FAULTS,
        )
        .expect("flip to binary");
    let listed = VersionedTextStore::new(&mut store)
        .list_moments(&ListMomentsQuery {
            workspace_id: WS.to_owned(),
            version_id: Some(VERSION.to_owned()),
            object_id: Some(flipped.object_id.clone()),
            limit: 10,
            before_moment_order: None,
        })
        .expect("list flip moments");
    assert_eq!(
        listed.moments[0].metadata_summary.as_deref(),
        Some("Became a binary file")
    );

    // ...and back to text.
    let back = VersionedTextStore::new(&mut store)
        .capture_ingest(&ingest("notes/plain.md", "text again", 40), &NO_FAULTS)
        .expect("flip back to text");
    assert_eq!(
        back.moment.metadata_summary.as_deref(),
        Some("Became a text file")
    );
}
