use dohc_engine_domain::{
    CaptureIngest, CaptureRetire, DomainError, ListMomentsQuery, NoFaults, RenameTextFile,
    VersionedTextStore, derive_capture_moment_id, derive_capture_object_id,
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
        author_json: None,
        now_ms,
        request_id: None,
    }
}

fn retire(path: &str, now_ms: i64) -> CaptureRetire {
    CaptureRetire {
        workspace_id: WS.to_owned(),
        version_id: VERSION.to_owned(),
        path: path.to_owned(),
        now_ms,
        request_id: None,
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
                metadata_origin: "rpc-test".to_owned(),
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
        author_json: None,
        now_ms,
        request_id: None,
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
    assert_eq!(
        first.moment.moment_id,
        derive_capture_moment_id(WS, &first.snapshot.object_id, first.moment.moment_order)
    );
    assert_eq!(
        retired.moment.moment_id,
        derive_capture_moment_id(WS, &first.snapshot.object_id, retired.moment.moment_order)
    );
    assert_eq!(
        recreated.moment.moment_id,
        derive_capture_moment_id(WS, &first.snapshot.object_id, recreated.moment.moment_order)
    );
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
    let first = derive_capture_moment_id("workspace", "object-id", 42);
    let second = derive_capture_moment_id("workspace", "object-id", 42);

    assert_eq!(first, second);
    assert_eq!(first.len(), "moment-".len() + 64);
    assert_ne!(
        first,
        derive_capture_moment_id("workspace", "object-id", 43)
    );
    assert_ne!(first, derive_capture_moment_id("other", "object-id", 42));
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
    assert_eq!(replay_delete.retired, first_delete.retired);
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

    let mut changed = first;
    changed.metadata_origin = "different-origin".to_owned();
    changed.now_ms = 20;
    let error = VersionedTextStore::new(&mut store)
        .capture_ingest(&changed, &NO_FAULTS)
        .expect_err("changed provenance must not replay");

    assert!(matches!(error, DomainError::IdempotencyKeyReuseMismatch));
    assert_eq!(moment_count(&mut store), 1);
}
