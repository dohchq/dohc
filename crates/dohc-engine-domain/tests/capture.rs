use dohc_engine_domain::store::text_blob_sha256;
use dohc_engine_domain::{
    CaptureIngest, CaptureRetire, ListMomentsQuery, NoFaults, VersionedTextStore,
    derive_capture_moment_id,
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
fn retire_removes_the_head_and_unknown_path_is_a_clean_no_op() {
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

    let missing = versions
        .capture_retire(&retire("missing.md", 30), &NO_FAULTS)
        .expect("unknown retire");
    assert!(missing.retired.is_none());
    assert!(!missing.deduped);
}

#[test]
fn moment_id_derivation_is_deterministic_for_equal_inputs() {
    let content_sha256 = text_blob_sha256("content");
    let first = derive_capture_moment_id(
        "version",
        "object-id",
        &content_sha256,
        Some("before-moment"),
    );
    let second = derive_capture_moment_id(
        "version",
        "object-id",
        &content_sha256,
        Some("before-moment"),
    );

    assert_eq!(first, second);
    assert_eq!(first.len(), "moment-".len() + 64);
}

#[test]
fn request_ids_replay_ingest_and_retire_exactly_once() {
    let (_scratch, mut store) = open_store();
    let mut write = ingest("a.md", "A", 10);
    write.request_id = Some("capture-write-request".to_owned());
    let first = VersionedTextStore::new(&mut store)
        .capture_ingest(&write, &NO_FAULTS)
        .expect("first capture");
    let replay = VersionedTextStore::new(&mut store)
        .capture_ingest(&write, &NO_FAULTS)
        .expect("capture replay");
    assert!(replay.deduped);
    assert_eq!(replay.moment.moment_id, first.moment.moment_id);

    let mut delete = retire("a.md", 20);
    delete.request_id = Some("capture-retire-request".to_owned());
    let first_delete = VersionedTextStore::new(&mut store)
        .capture_retire(&delete, &NO_FAULTS)
        .expect("first retire");
    let replay_delete = VersionedTextStore::new(&mut store)
        .capture_retire(&delete, &NO_FAULTS)
        .expect("retire replay");
    assert!(replay_delete.deduped);
    assert_eq!(replay_delete.retired, first_delete.retired);
}
