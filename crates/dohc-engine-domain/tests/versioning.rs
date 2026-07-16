//! Versioning-domain traces (CAL-2 calibration signal): versioned write→read
//! round-trips, named-version fork isolation, list-versions/list-moments
//! ordering with keyset pagination at limit-1/limit/limit+1, restore preserving
//! both sides, and close/reopen/mutate durability.

use dohc_engine_domain::{
    CreateNamedVersion, ListMomentsQuery, NoFaults, VersionKind, VersionedTextStore, WriteText,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::ScratchDir;

const NO_FAULTS: NoFaults = NoFaults;
const WS: &str = "ws-1";

fn write(version: &str, path: &str, text: &str, moment: &str, object: &str, now: i64) -> WriteText {
    WriteText {
        workspace_id: WS.to_owned(),
        version_id: version.to_owned(),
        object_id: object.to_owned(),
        path: path.to_owned(),
        text: text.to_owned(),
        moment_id: moment.to_owned(),
        metadata_origin: "user".to_owned(),
        author_json: None,
        now_ms: now,
        request_id: None,
    }
}

fn bootstrap(store: &mut EngineStore) {
    VersionedTextStore::new(store)
        .ensure_main_version(WS, "main", 1, &NO_FAULTS)
        .expect("ensure main");
}

// oracle: versioned write → read round-trip, durable across close/reopen.
#[test]
fn write_then_read_round_trip_survives_reopen() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");

    {
        let mut store = EngineStore::open(&db, 1).expect("open");
        bootstrap(&mut store);
        let mut vt = VersionedTextStore::new(&mut store);
        let result = vt
            .write_text(
                &write("main", "notes/a.md", "hello\n", "m1", "o1", 10),
                &NO_FAULTS,
            )
            .expect("write");
        assert!(!result.deduped);
        assert_eq!(result.moment.moment_order, 1);
        let snap = vt
            .read_text(WS, "main", "notes/a.md")
            .expect("read")
            .expect("present");
        assert_eq!(snap.text, "hello\n");
        assert_eq!(snap.object_id, "o1");
    }

    // Reopen: the write is durable, and the store stays writable.
    let mut store = EngineStore::open(&db, 2).expect("reopen");
    let mut vt = VersionedTextStore::new(&mut store);
    let snap = vt
        .read_text(WS, "main", "notes/a.md")
        .expect("read")
        .expect("present");
    assert_eq!(snap.text, "hello\n");
    vt.write_text(
        &write("main", "notes/b.md", "second", "m2", "o2", 20),
        &NO_FAULTS,
    )
    .expect("write after reopen");
    assert_eq!(
        vt.read_text(WS, "main", "notes/b.md")
            .unwrap()
            .unwrap()
            .text,
        "second"
    );
}

// oracle: updating a path in place reuses the object identity and appends a
// moment whose `before` is the prior blob.
#[test]
fn update_in_place_reuses_object_and_records_before() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);

    let first = vt
        .write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("first");
    assert!(!first.moment.before_present);

    let second = vt
        .write_text(
            &write("main", "a.md", "two", "m2", "IGNORED", 20),
            &NO_FAULTS,
        )
        .expect("second");
    // Path already aliased → object identity preserved, supplied object ignored.
    assert_eq!(second.snapshot.object_id, "o1");
    assert!(second.moment.before_present);
    assert_eq!(
        second.moment.before_blob_sha256,
        Some(first.moment.after_blob_sha256.clone())
    );
    assert_eq!(
        vt.read_text(WS, "main", "a.md").unwrap().unwrap().text,
        "two"
    );
}

// oracle: a duplicate caller-supplied moment id in the workspace is rejected.
#[test]
fn duplicate_moment_id_is_rejected() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    vt.write_text(&write("main", "a.md", "one", "dup", "o1", 10), &NO_FAULTS)
        .expect("first");
    let err = vt
        .write_text(&write("main", "b.md", "two", "dup", "o2", 20), &NO_FAULTS)
        .expect_err("duplicate moment id");
    assert_eq!(err.code(), "duplicate-moment-id");
}

// oracle: writing a NEW path with an object id already bound to another object
// fails closed (never silently reuses/clobbers the other file's snapshot).
#[test]
fn reused_object_id_for_new_path_is_rejected() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);

    vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("first");
    let err = vt
        .write_text(&write("main", "b.md", "two", "m2", "o1", 20), &NO_FAULTS)
        .expect_err("reused object id");
    assert_eq!(err.code(), "invalid-input");
    // a.md's state is untouched.
    assert_eq!(
        vt.read_text(WS, "main", "a.md").unwrap().unwrap().text,
        "one"
    );
    assert!(vt.read_text(WS, "main", "b.md").expect("read").is_none());
}

// oracle: a read against an unknown version fails closed rather than looking
// like a missing file.
#[test]
fn read_text_unknown_version_fails_closed() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let vt = VersionedTextStore::new(&mut store);
    assert_eq!(
        vt.read_text(WS, "ghost", "a.md")
            .expect_err("unknown version")
            .code(),
        "version-not-found"
    );
}

// oracle (exactly-once): a deduped write replay returns the ORIGINAL recorded
// result, never a later write's text/moment on the same path.
#[test]
fn deduped_write_returns_original_not_later_state() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);

    let mut first = write("main", "a.md", "first", "m1", "o1", 10);
    first.request_id = Some("req".to_owned());
    vt.write_text(&first, &NO_FAULTS).expect("first");

    // A later write updates the same path (live snapshot becomes "second"/m2).
    vt.write_text(&write("main", "a.md", "second", "m2", "o1", 20), &NO_FAULTS)
        .expect("second");

    // Replay the original request: must return the ORIGINAL result.
    let replay = vt.write_text(&first, &NO_FAULTS).expect("replay");
    assert!(replay.deduped);
    assert_eq!(replay.snapshot.text, "first");
    assert_eq!(replay.snapshot.latest_moment_id, "m1");
    assert_eq!(replay.moment.moment_id, "m1");
    // The live state is unchanged (still the later write).
    assert_eq!(
        vt.read_text(WS, "main", "a.md").unwrap().unwrap().text,
        "second"
    );
}

// oracle: a reserved / absolute / traversal path is rejected.
#[test]
fn unsafe_paths_are_rejected() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    for (i, bad) in [
        "/abs.md",
        "..\\esc",
        "a\\b.md",
        "C:\\x",
        ".dohc/engine.db",
        "a/../b",
    ]
    .iter()
    .enumerate()
    {
        let err = vt
            .write_text(
                &write("main", bad, "x", &format!("m{i}"), &format!("o{i}"), 10),
                &NO_FAULTS,
            )
            .expect_err("unsafe path");
        assert_eq!(err.code(), "invalid-path", "path {bad:?} must be rejected");
    }
}

// oracle: create-named-version forks correctly — copies snapshots/aliases,
// isolates subsequent writes, and records the fork point.
#[test]
fn create_named_version_forks_and_isolates() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);

    vt.write_text(&write("main", "a.md", "v1", "m1", "o1", 10), &NO_FAULTS)
        .expect("write main");

    let fork = vt
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: WS.to_owned(),
                new_version_id: "feat".to_owned(),
                name: "feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 20,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("fork");
    assert_eq!(fork.kind, VersionKind::Named);
    assert_eq!(fork.fork_version_id.as_deref(), Some("main"));
    assert_eq!(fork.fork_moment_id.as_deref(), Some("m1"));

    // The fork inherits main's content at the fork point.
    assert_eq!(
        vt.read_text(WS, "feat", "a.md").unwrap().unwrap().text,
        "v1"
    );
    let snaps = vt.list_snapshots(WS, "feat").expect("snaps");
    assert_eq!(snaps.len(), 1);
    assert_eq!(snaps[0].object_id, "o1");

    // Writing to the fork updates the shared object in the fork only.
    vt.write_text(&write("feat", "a.md", "v2", "m2", "o1", 30), &NO_FAULTS)
        .expect("write feat");
    assert_eq!(
        vt.read_text(WS, "feat", "a.md").unwrap().unwrap().text,
        "v2"
    );
    assert_eq!(
        vt.read_text(WS, "main", "a.md").unwrap().unwrap().text,
        "v1"
    );

    // A name conflict is rejected.
    let err = vt
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: WS.to_owned(),
                new_version_id: "feat2".to_owned(),
                name: "feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 40,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect_err("name conflict");
    assert_eq!(err.code(), "version-name-conflict");
}

// oracle (P1 regression): a fork records the SOURCE version's latest moment as
// its fork point, never the workspace-global latest — even when the global
// latest belongs to a sibling fork.
#[test]
fn cross_version_fork_records_source_version_latest_moment() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);

    // main gets m1; feat forks from main then gets m2 (the GLOBAL latest).
    vt.write_text(&write("main", "a.md", "v1", "m1", "o1", 10), &NO_FAULTS)
        .expect("write main");
    vt.create_named_version(
        &CreateNamedVersion {
            workspace_id: WS.to_owned(),
            new_version_id: "feat".to_owned(),
            name: "feature".to_owned(),
            from_version_id: "main".to_owned(),
            now_ms: 20,
            request_id: None,
        },
        &NO_FAULTS,
    )
    .expect("fork feat");
    vt.write_text(&write("feat", "a.md", "v2", "m2", "o1", 30), &NO_FAULTS)
        .expect("write feat");

    // Fork feat2 from main. Global latest is m2 (feat); the correct fork point
    // is main's latest, m1.
    let feat2 = vt
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: WS.to_owned(),
                new_version_id: "feat2".to_owned(),
                name: "feature2".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 40,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("fork feat2");
    assert_eq!(
        feat2.fork_moment_id.as_deref(),
        Some("m1"),
        "fork point must be the SOURCE (main) latest, not the global latest m2"
    );
    // The fork base and snapshot describe main's state (v1), never feat's (v2).
    assert_eq!(
        vt.read_text(WS, "feat2", "a.md").unwrap().unwrap().text,
        "v1"
    );
    let base = vt.list_fork_base_snapshots(WS, "feat2").expect("fork base");
    assert_eq!(base.len(), 1);
    assert_eq!(base[0].text, "v1");
}

// oracle: list-versions is ordered by (created_at_ms, name, version_id).
#[test]
fn list_versions_is_ordered() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store); // main @ created_at 1
    let mut vt = VersionedTextStore::new(&mut store);

    for (id, name, now) in [("vb", "bbb", 5), ("va", "aaa", 5), ("vc", "ccc", 3)] {
        vt.create_named_version(
            &CreateNamedVersion {
                workspace_id: WS.to_owned(),
                new_version_id: id.to_owned(),
                name: name.to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: now,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect("fork");
    }
    let versions = vt.list_versions(WS).expect("list");
    let order: Vec<&str> = versions.iter().map(|v| v.version_id.as_str()).collect();
    // main(1) < vc(3) < [va,vb same time → by name aaa<bbb].
    assert_eq!(order, vec!["main", "vc", "va", "vb"]);
}

// oracle: list-moments keyset pagination at limit-1 / limit / limit+1.
#[test]
fn list_moments_keyset_pagination_edges() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);

    // Five moments, orders 1..=5.
    for i in 1..=5 {
        vt.write_text(
            &write(
                "main",
                "a.md",
                &format!("v{i}"),
                &format!("m{i}"),
                "o1",
                i as i64,
            ),
            &NO_FAULTS,
        )
        .expect("write");
    }

    let query = |limit: i64, before: Option<i64>| ListMomentsQuery {
        workspace_id: WS.to_owned(),
        version_id: None,
        object_id: None,
        limit,
        before_moment_order: before,
    };

    // limit == N: full page, no next cursor.
    let full = vt.list_moments(&query(5, None)).expect("page");
    assert_eq!(full.moments.len(), 5);
    assert_eq!(full.latest_moment_order, Some(5));
    assert_eq!(full.next_before_moment_order, None);
    // Newest first.
    assert_eq!(full.moments[0].moment_order, 5);
    assert_eq!(full.moments[4].moment_order, 1);

    // limit+1 > N: still full, no cursor.
    let over = vt.list_moments(&query(6, None)).expect("page");
    assert_eq!(over.moments.len(), 5);
    assert_eq!(over.next_before_moment_order, None);

    // limit-1 < N: partial page with a cursor; the next page finishes it.
    let first = vt.list_moments(&query(4, None)).expect("page");
    assert_eq!(first.moments.len(), 4);
    assert_eq!(first.moments[0].moment_order, 5);
    assert_eq!(first.moments[3].moment_order, 2);
    assert_eq!(first.next_before_moment_order, Some(2));
    assert_eq!(first.latest_moment_order, Some(5));

    let second = vt.list_moments(&query(4, Some(2))).expect("page");
    assert_eq!(second.moments.len(), 1);
    assert_eq!(second.moments[0].moment_order, 1);
    assert_eq!(second.next_before_moment_order, None);

    // A bad version filter fails closed.
    let mut bad = query(4, None);
    bad.version_id = Some("nope".to_owned());
    assert_eq!(
        vt.list_moments(&bad).expect_err("bad version").code(),
        "version-not-found"
    );

    // A non-positive limit is invalid input.
    assert_eq!(
        vt.list_moments(&query(0, None))
            .expect_err("bad limit")
            .code(),
        "invalid-input"
    );
}

// oracle: restore (set-active-version) preserves BOTH sides — the restored
// version becomes active while the previously-active one keeps its content.
#[test]
fn restore_preserves_both_sides() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);

    vt.write_text(&write("main", "a.md", "main-v", "m1", "o1", 10), &NO_FAULTS)
        .expect("write main");
    vt.create_named_version(
        &CreateNamedVersion {
            workspace_id: WS.to_owned(),
            new_version_id: "feat".to_owned(),
            name: "feature".to_owned(),
            from_version_id: "main".to_owned(),
            now_ms: 20,
            request_id: None,
        },
        &NO_FAULTS,
    )
    .expect("fork");
    vt.write_text(&write("feat", "a.md", "feat-v", "m2", "o1", 30), &NO_FAULTS)
        .expect("write feat");

    // Default active is main.
    assert_eq!(vt.get_active_version(WS).unwrap().version_id, "main");

    // Switch to feat, then restore to main.
    vt.set_active_version(WS, "feat", &NO_FAULTS)
        .expect("activate feat");
    assert_eq!(
        vt.read_text_active(WS, "a.md").unwrap().unwrap().text,
        "feat-v"
    );

    vt.set_active_version(WS, "main", &NO_FAULTS)
        .expect("restore main");
    assert_eq!(vt.get_active_version(WS).unwrap().version_id, "main");
    // Both sides survive the restore.
    assert_eq!(
        vt.read_text_active(WS, "a.md").unwrap().unwrap().text,
        "main-v"
    );
    assert_eq!(
        vt.read_text(WS, "feat", "a.md").unwrap().unwrap().text,
        "feat-v"
    );
    assert_eq!(
        vt.read_text(WS, "main", "a.md").unwrap().unwrap().text,
        "main-v"
    );

    // Restoring to an unknown version fails closed.
    assert_eq!(
        vt.set_active_version(WS, "ghost", &NO_FAULTS)
            .expect_err("no version")
            .code(),
        "version-not-found"
    );
}

// oracle: ensure-main-version is idempotent (bootstrap path).
#[test]
fn ensure_main_version_is_idempotent() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    let mut vt = VersionedTextStore::new(&mut store);
    let a = vt
        .ensure_main_version(WS, "main", 1, &NO_FAULTS)
        .expect("first");
    let b = vt
        .ensure_main_version(WS, "main", 2, &NO_FAULTS)
        .expect("again");
    assert_eq!(a, b);
    assert_eq!(vt.list_versions(WS).expect("list").len(), 1);
}
