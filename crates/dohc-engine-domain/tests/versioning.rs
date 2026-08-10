//! Versioning-domain traces (CAL-2 calibration signal): versioned write→read
//! round-trips, named-version fork isolation, list-versions/list-moments
//! ordering with keyset pagination at limit-1/limit/limit+1, restore preserving
//! both sides, and close/reopen/mutate durability.

use dohc_engine_domain::{
    CreateNamedVersion, DeleteTextFile, ListMomentsQuery, MergeTextFileFromVersion,
    MergeTextFileResult, MomentOp, NoFaults, RenameTextFile, RollbackTextFileMutation,
    SnapshotContent, VersionKind, VersionedTextStore, WriteText,
};
use dohc_engine_storage::{CompoundWrite, EngineStore, WriteOutcome};
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
        metadata_summary: None,
        metadata_correlation_id: None,
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

fn delete(version: &str, path: &str, moment: &str, now: i64) -> DeleteTextFile {
    DeleteTextFile {
        workspace_id: WS.to_owned(),
        version_id: version.to_owned(),
        path: path.to_owned(),
        moment_id: moment.to_owned(),
        request_id: None,
        metadata_origin: "user".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: now,
    }
}

fn rename(version: &str, from: &str, to: &str, moment: &str, now: i64) -> RenameTextFile {
    RenameTextFile {
        workspace_id: WS.to_owned(),
        version_id: version.to_owned(),
        from_path: from.to_owned(),
        to_path: to.to_owned(),
        moment_id: moment.to_owned(),
        request_id: None,
        metadata_origin: "user".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: now,
    }
}

fn rollback(version: &str, path: &str, moment: &str) -> RollbackTextFileMutation {
    RollbackTextFileMutation {
        workspace_id: WS.to_owned(),
        version_id: version.to_owned(),
        path: path.to_owned(),
        mutation_moment_id: moment.to_owned(),
        request_id: None,
        legacy_before_text: None,
        metadata_origin: "restore".to_owned(),
        author_json: None,
    }
}

#[test]
fn write_text_directly_at_a_secret_path_is_refused_by_the_secret_floor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let err = VersionedTextStore::new(&mut store)
        .write_text(
            &write("main", "secrets/.env.local", "TOKEN=plain", "m1", "o1", 2),
            &NO_FAULTS,
        )
        .expect_err("secret path must not enter plaintext history");
    assert_eq!(err.code(), "invalid-path");
}

#[test]
fn rename_onto_secret_path_is_refused_by_the_secret_floor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut versions = VersionedTextStore::new(&mut store);
    versions
        .write_text(
            &write("main", "notes/a.md", "safe", "m1", "o1", 2),
            &NO_FAULTS,
        )
        .expect("seed tracked text");
    let err = versions
        .rename_text_file(&rename("main", "notes/a.md", ".env", "m2", 3), &NO_FAULTS)
        .expect_err("rename must not smuggle plaintext onto secret floor");
    assert_eq!(err.code(), "invalid-path");
    assert!(
        versions
            .read_text(WS, "main", "notes/a.md")
            .expect("read")
            .is_some()
    );
}

#[test]
fn plaintext_store_door_rejects_reserved_ignored_and_traversal_paths() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut versions = VersionedTextStore::new(&mut store);
    let rejected = [
        "DOHC~1/x.md",
        "node_modules/p/i.md",
        ".git/config.md",
        "shared-with-me/a.md",
        "%2e%2e/evil.md",
    ];

    for (index, path) in rejected.iter().enumerate() {
        let err = versions
            .write_text(
                &write(
                    "main",
                    path,
                    "unsafe",
                    &format!("write-rejected-{index}"),
                    &format!("object-rejected-{index}"),
                    10 + index as i64,
                ),
                &NO_FAULTS,
            )
            .expect_err("ignored/reserved path must not enter plaintext history");
        assert_eq!(err.code(), "invalid-path", "write path {path}");
    }

    let written = versions
        .write_text(
            &write("main", "./notes/a.md", "safe", "m-normalized", "o1", 30),
            &NO_FAULTS,
        )
        .expect("normalized tracked write");
    assert_eq!(written.snapshot.path, "notes/a.md");

    for (index, path) in rejected.iter().enumerate() {
        let err = versions
            .rename_text_file(
                &rename(
                    "main",
                    "./notes/a.md",
                    path,
                    &format!("rename-rejected-{index}"),
                    40 + index as i64,
                ),
                &NO_FAULTS,
            )
            .expect_err("rename destination must pass the plaintext store door");
        assert_eq!(err.code(), "invalid-path", "rename path {path}");
    }

    let read = versions
        .read_text(WS, "main", "notes/a.md")
        .expect("normalized read")
        .expect("normalized alias present");
    assert_eq!(read.text, "safe");
    versions
        .delete_text_file(
            &delete("main", "notes/a.md", "m-delete-normalized", 60),
            &NO_FAULTS,
        )
        .expect("differently-spelled normalized delete");
    assert!(
        versions
            .read_text(WS, "main", "./notes/a.md")
            .expect("normalized absent read")
            .is_none()
    );
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
        first.moment.after_blob_sha256.clone()
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

#[test]
fn rollback_clears_idempotency_ledger_so_stale_retry_does_not_replay() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);

    let mut first = write("main", "a.md", "one", "m1", "o1", 10);
    first.request_id = Some("req-1".to_owned());
    let mut second = write("main", "a.md", "two", "m2", "o1", 20);
    second.request_id = Some("req-2".to_owned());
    {
        let mut vt = VersionedTextStore::new(&mut store);
        vt.write_text(&first, &NO_FAULTS).expect("first");
        vt.write_text(&second, &NO_FAULTS).expect("second");
        vt.rollback_text_file_mutation(&rollback("main", "a.md", "m2"), &NO_FAULTS)
            .expect("rollback second");
    }

    let rolled_back_request_count: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM engine_requests WHERE request_id = 'req-2'",
                [],
                |row| row.get(0),
            )
        })
        .expect("ledger count");
    assert_eq!(rolled_back_request_count, 0);

    let mut vt = VersionedTextStore::new(&mut store);
    let first_replay = vt.write_text(&first, &NO_FAULTS).expect("first replay");
    assert!(first_replay.deduped);
    assert_eq!(first_replay.snapshot.text, "one");
    assert_eq!(first_replay.moment.moment_id, "m1");

    let second_retry = vt.write_text(&second, &NO_FAULTS).expect("second retry");
    assert!(!second_retry.deduped);
    assert_eq!(second_retry.snapshot.text, "two");
    assert_eq!(second_retry.moment.moment_id, "m2");
}

#[test]
fn rollback_purges_versioned_and_merge_requests_but_preserves_compound_rows() {
    // MUTATION: drop the kind predicate -> the compound collision is deleted.
    // MUTATION: drop `merge` from the IN list -> the merge retry reconstructs a
    // deleted moment instead of re-executing.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);

    VersionedTextStore::new(&mut store)
        .write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("first versioned write");

    // The first versioned write consumed replication seq 1. This compound
    // write therefore records result_seq 2, which intentionally collides with
    // the next versioned moment_order.
    let compound = CompoundWrite {
        request_id: "compound-collision".to_owned(),
        doc_id: "compound-document".to_owned(),
        body: "durable body".to_owned(),
        op_kind: "compound-write".to_owned(),
        now_ms: 15,
    };
    assert_eq!(
        store
            .commit_compound(&compound, &NO_FAULTS)
            .expect("compound write"),
        WriteOutcome::Acked {
            seq: 2,
            deduped: false,
        }
    );

    let mut second = write("main", "a.md", "two", "m2", "o1", 20);
    second.request_id = Some("versioned-collision".to_owned());
    {
        let mut versions = VersionedTextStore::new(&mut store);
        let written = versions
            .write_text(&second, &NO_FAULTS)
            .expect("second versioned write");
        assert_eq!(written.moment.moment_order, 2);
        versions
            .rollback_text_file_mutation(&rollback("main", "a.md", "m2"), &NO_FAULTS)
            .expect("rollback second versioned write");
    }

    let surviving_kind: Option<String> = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT kind FROM engine_requests WHERE request_id = 'compound-collision'",
                [],
                |row| row.get(0),
            )
        })
        .expect("compound ledger survives");
    assert_eq!(surviving_kind.as_deref(), Some("compound"));

    let merge = MergeTextFileFromVersion {
        workspace_id: WS.to_owned(),
        target_version_id: "main".to_owned(),
        source_version_id: "feat".to_owned(),
        path: "a.md".to_owned(),
        object_id: "ignored".to_owned(),
        moment_id: "merge-retry-moment".to_owned(),
        request_id: Some("merge-retry-request".to_owned()),
        conflict_id: "merge-retry-conflict".to_owned(),
        metadata_origin: "user".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 40,
    };
    {
        let mut versions = VersionedTextStore::new(&mut store);
        versions
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: WS.to_owned(),
                    new_version_id: "feat".to_owned(),
                    name: "feature".to_owned(),
                    from_version_id: "main".to_owned(),
                    now_ms: 30,
                    request_id: None,
                },
                &NO_FAULTS,
            )
            .expect("fork for merge");
        versions
            .write_text(
                &write("feat", "a.md", "three", "merge-source", "ignored", 35),
                &NO_FAULTS,
            )
            .expect("merge source write");
        versions
            .set_active_version(WS, "feat", &NO_FAULTS)
            .expect("make merge target inactive");
        assert!(matches!(
            versions
                .merge_text_file_from_version(&merge, &NO_FAULTS)
                .expect("first merge"),
            MergeTextFileResult::Write { .. }
        ));
        versions
            .rollback_text_file_mutation(
                &rollback("main", "a.md", "merge-retry-moment"),
                &NO_FAULTS,
            )
            .expect("rollback merge moment");
    }
    let merge_ledger_count: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM engine_requests WHERE request_id = 'merge-retry-request'",
                [],
                |row| row.get(0),
            )
        })
        .expect("merge ledger count");
    assert_eq!(merge_ledger_count, 0);
    let merge_retry = VersionedTextStore::new(&mut store)
        .merge_text_file_from_version(&merge, &NO_FAULTS)
        .expect("merge retry re-executes");
    assert!(matches!(
        merge_retry,
        MergeTextFileResult::Write { write, .. }
            if !write.deduped && write.moment.moment_id == "merge-retry-moment"
    ));

    let surviving_kind_after_merge: Option<String> = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT kind FROM engine_requests WHERE request_id = 'compound-collision'",
                [],
                |row| row.get(0),
            )
        })
        .expect("compound ledger still survives merge rollback");
    assert_eq!(surviving_kind_after_merge.as_deref(), Some("compound"));

    assert_eq!(
        store
            .commit_compound(&compound, &NO_FAULTS)
            .expect("compound replay"),
        WriteOutcome::Acked {
            seq: 2,
            deduped: true,
        }
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
    let _ = vt;
    store
        .read_with(|conn| {
            conn.execute(
                "UPDATE snapshots \
                 SET metadata_summary='imported summary', \
                     metadata_correlation_id='imported correlation' \
                 WHERE workspace_id=?1 AND version_id='main' AND object_id='o1'",
                [WS],
            )
        })
        .expect("seed complete source metadata");
    let mut vt = VersionedTextStore::new(&mut store);

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
    let _ = vt;
    let copied_metadata = store
        .read_with(|conn| {
            let read = |table: &str| {
                conn.query_row(
                    &format!(
                        "SELECT metadata_origin,metadata_summary,metadata_correlation_id \
                         FROM {table} \
                         WHERE workspace_id=?1 AND version_id='feat' AND object_id='o1'"
                    ),
                    [WS],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
            };
            Ok::<_, rusqlite::Error>((read("snapshots")?, read("fork_base_snapshots")?))
        })
        .expect("copied metadata");
    let expected_metadata = (
        "user".to_owned(),
        Some("imported summary".to_owned()),
        Some("imported correlation".to_owned()),
    );
    // MUTATION: omitting either ordinal-18 column from either INSERT...SELECT
    // loses provenance from the live fork or its frozen comparison base.
    assert_eq!(
        copied_metadata,
        (expected_metadata.clone(), expected_metadata)
    );
    let mut vt = VersionedTextStore::new(&mut store);

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
    assert_eq!(
        base[0].content,
        SnapshotContent::Text {
            text: "v1".to_owned()
        }
    );
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

// oracle: versions-get-main-version is read-only: absent before bootstrap and
// byte-identical to ensure-main's record afterward.
#[test]
fn get_main_version_returns_none_then_the_ensured_main() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    let mut vt = VersionedTextStore::new(&mut store);
    assert_eq!(vt.get_main_version(WS).expect("get before"), None);
    let ensured = vt
        .ensure_main_version(WS, "main", 1, &NO_FAULTS)
        .expect("ensure");
    assert_eq!(vt.get_main_version(WS).expect("get after"), Some(ensured));
}

// oracle: versions-delete-text-file appends a delete moment and removes only
// the current version's alias/snapshot.
#[test]
fn delete_text_file_records_moment_and_removes_current_snapshot() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    let written = vt
        .write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("write");
    let deleted = vt
        .delete_text_file(&delete("main", "a.md", "m2", 20), &NO_FAULTS)
        .expect("delete");
    assert_eq!(deleted.object.object_id, "o1");
    assert_eq!(deleted.before, written.snapshot);
    assert_eq!(deleted.moment.operation, MomentOp::Delete);
    assert!(deleted.moment.before_present);
    assert_eq!(
        deleted.moment.before_latest_moment_id.as_deref(),
        Some("m1")
    );
    assert_eq!(
        vt.get_moment(WS, "m2").expect("moment"),
        Some(deleted.moment)
    );
    assert!(vt.read_text(WS, "main", "a.md").expect("read").is_none());
    assert!(vt.list_snapshots(WS, "main").expect("snapshots").is_empty());
}

// oracle: versions-delete-text-file rejects a caller-supplied duplicate moment
// id before changing the file.
#[test]
fn delete_text_file_rejects_duplicate_moment_id() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("write");
    let err = vt
        .delete_text_file(&delete("main", "a.md", "m1", 20), &NO_FAULTS)
        .expect_err("duplicate");
    assert_eq!(err.code(), "duplicate-moment-id");
    assert_eq!(
        vt.read_text(WS, "main", "a.md").unwrap().unwrap().text,
        "one"
    );
}

// oracle: versions-delete-text-file reports file-not-found for an absent path.
#[test]
fn delete_text_file_reports_file_not_found() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    assert_eq!(
        vt.delete_text_file(&delete("main", "missing.md", "m1", 10), &NO_FAULTS)
            .expect_err("missing")
            .code(),
        "file-not-found"
    );
}

// oracle: versions-delete-text-file is version-local; a sibling fork keeps the
// shared object's inherited snapshot.
#[test]
fn delete_text_file_does_not_affect_sibling_fork() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("write");
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
    vt.delete_text_file(&delete("main", "a.md", "m2", 30), &NO_FAULTS)
        .expect("delete");
    assert!(vt.read_text(WS, "main", "a.md").unwrap().is_none());
    let sibling = vt.read_text(WS, "feat", "a.md").unwrap().unwrap();
    assert_eq!(sibling.object_id, "o1");
    assert_eq!(sibling.text, "one");
}

// oracle: versions-rename-text-file preserves object/content, moves the alias,
// and appends a rename moment whose preimage points at the prior head.
#[test]
fn rename_text_file_moves_alias_and_preserves_identity() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("write");
    let renamed = vt
        .rename_text_file(&rename("main", "a.md", "b.md", "m2", 20), &NO_FAULTS)
        .expect("rename");
    assert_eq!(renamed.object.object_id, "o1");
    assert_eq!(renamed.moment.operation, MomentOp::Rename);
    assert_eq!(
        renamed.moment.before_latest_moment_id.as_deref(),
        Some("m1")
    );
    assert_eq!(
        vt.get_moment(WS, "m2").expect("moment"),
        Some(renamed.moment)
    );
    assert!(vt.read_text(WS, "main", "a.md").unwrap().is_none());
    let after = vt.read_text(WS, "main", "b.md").unwrap().unwrap();
    assert_eq!(after.object_id, "o1");
    assert_eq!(after.text, "one");
}

// oracle: versions-rename-text-file rejects identical source/destination.
#[test]
fn rename_text_file_rejects_same_path() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("write");
    assert_eq!(
        vt.rename_text_file(&rename("main", "a.md", "a.md", "m2", 20), &NO_FAULTS)
            .expect_err("same path")
            .code(),
        "invalid-path"
    );
}

// oracle: versions-rename-text-file reports file-not-found for a missing source.
#[test]
fn rename_text_file_reports_missing_source() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    assert_eq!(
        vt.rename_text_file(&rename("main", "missing.md", "b.md", "m1", 10), &NO_FAULTS,)
            .expect_err("missing")
            .code(),
        "file-not-found"
    );
}

// oracle: versions-rename-text-file refuses to replace a different target object.
#[test]
fn rename_text_file_rejects_occupied_destination() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("write a");
    vt.write_text(&write("main", "b.md", "two", "m2", "o2", 20), &NO_FAULTS)
        .expect("write b");
    assert_eq!(
        vt.rename_text_file(&rename("main", "a.md", "b.md", "m3", 30), &NO_FAULTS)
            .expect_err("occupied")
            .code(),
        "target-path-exists"
    );
}

// oracle: versions-rollback-text-file-mutation removes a first write and
// appends a compensating delete that keeps the historical object reachable.
#[test]
fn rollback_first_write_removes_file_and_garbage_collects_object() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    {
        let mut vt = VersionedTextStore::new(&mut store);
        vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
            .expect("write");
        vt.rollback_text_file_mutation(&rollback("main", "a.md", "m1"), &NO_FAULTS)
            .expect("rollback");
        assert!(vt.read_text(WS, "main", "a.md").unwrap().is_none());
        assert!(vt.get_moment(WS, "m1").unwrap().is_none());
    }
    let (object_count, compensation_count): (i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM file_objects \
                     WHERE workspace_id = ?1 AND object_id = 'o1'",
                    [WS],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM moments \
                     WHERE workspace_id = ?1 AND object_id = 'o1' AND operation = 'delete'",
                    [WS],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("counts");
    assert_eq!(object_count, 1);
    assert_eq!(compensation_count, 1);
}

// oracle: versions-rollback-text-file-mutation restores an overwrite's exact
// prior snapshot and removes the mutation moment.
#[test]
fn rollback_overwrite_restores_prior_text() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("first");
    vt.write_text(&write("main", "a.md", "two", "m2", "o1", 20), &NO_FAULTS)
        .expect("second");
    vt.rollback_text_file_mutation(&rollback("main", "a.md", "m2"), &NO_FAULTS)
        .expect("rollback");
    let restored = vt.read_text(WS, "main", "a.md").unwrap().unwrap();
    assert_eq!(restored.text, "one");
    assert!(restored.latest_moment_id.starts_with("rollback-"));
    let compensation = vt
        .get_moment(WS, &restored.latest_moment_id)
        .unwrap()
        .expect("compensating write");
    assert_eq!(compensation.operation, MomentOp::Write);
    assert_eq!(compensation.before_latest_moment_id.as_deref(), Some("m2"));
}

// oracle: versions-rollback-text-file-mutation restores the source alias of a rename.
#[test]
fn rollback_rename_restores_original_path() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("write");
    vt.rename_text_file(&rename("main", "a.md", "b.md", "m2", 20), &NO_FAULTS)
        .expect("rename");
    vt.rollback_text_file_mutation(&rollback("main", "b.md", "m2"), &NO_FAULTS)
        .expect("rollback");
    assert!(vt.read_text(WS, "main", "b.md").unwrap().is_none());
    assert_eq!(
        vt.read_text(WS, "main", "a.md").unwrap().unwrap().text,
        "one"
    );
}

// oracle: versions-rollback-text-file-mutation restores deleted content.
#[test]
fn rollback_delete_restores_deleted_content() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("write");
    vt.delete_text_file(&delete("main", "a.md", "m2", 20), &NO_FAULTS)
        .expect("delete");
    vt.rollback_text_file_mutation(&rollback("main", "a.md", "m2"), &NO_FAULTS)
        .expect("rollback");
    assert_eq!(
        vt.read_text(WS, "main", "a.md").unwrap().unwrap().text,
        "one"
    );
}

// oracle: versions-rollback-text-file-mutation refuses a non-tip object mutation.
#[test]
fn rollback_rejects_non_latest_mutation() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("first");
    vt.write_text(&write("main", "a.md", "two", "m2", "o1", 20), &NO_FAULTS)
        .expect("second");
    assert_eq!(
        vt.rollback_text_file_mutation(&rollback("main", "a.md", "m1"), &NO_FAULTS)
            .expect_err("not latest")
            .code(),
        "invalid-input"
    );
}

// oracle: versions-rollback-text-file-mutation refuses the exact fork-point
// moment because the child snapshot directly depends on it.
#[test]
fn rollback_rejects_moment_used_as_fork_point_preimage() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("write");
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
    assert_eq!(
        vt.rollback_text_file_mutation(&rollback("main", "a.md", "m1"), &NO_FAULTS)
            .expect_err("dependent")
            .code(),
        "invalid-input"
    );
}

// oracle: versions-rollback-text-file-mutation follows before_latest_moment_id;
// a child rewrite keeps its inherited producer moment alive even after the
// child's snapshot head advances.
#[test]
fn rollback_rejects_moment_referenced_by_child_preimage_pointer() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("write shared");
    vt.write_text(
        &write("main", "marker.md", "marker", "m2", "marker", 20),
        &NO_FAULTS,
    )
    .expect("fork marker");
    vt.create_named_version(
        &CreateNamedVersion {
            workspace_id: WS.to_owned(),
            new_version_id: "feat".to_owned(),
            name: "feature".to_owned(),
            from_version_id: "main".to_owned(),
            now_ms: 30,
            request_id: None,
        },
        &NO_FAULTS,
    )
    .expect("fork");
    let child = vt
        .write_text(&write("feat", "a.md", "two", "m3", "o1", 40), &NO_FAULTS)
        .expect("child rewrite");
    assert_eq!(child.moment.before_latest_moment_id.as_deref(), Some("m1"));
    assert_eq!(
        vt.rollback_text_file_mutation(&rollback("main", "a.md", "m1"), &NO_FAULTS)
            .expect_err("preimage dependent")
            .code(),
        "invalid-input"
    );
}

#[test]
fn rollback_rejects_migrated_null_link_dependent() {
    let fidelity = ScratchDir::new().expect("fidelity scratch");
    let fidelity_db = fidelity.engine_db_path().expect("fidelity db");
    let mut fidelity_store = EngineStore::open(&fidelity_db, 1).expect("fidelity open");
    bootstrap(&mut fidelity_store);
    {
        let mut vt = VersionedTextStore::new(&mut fidelity_store);
        vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
            .expect("fidelity main write");
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
        .expect("fidelity fork");
        let child = vt
            .write_text(&write("feat", "a.md", "two", "m2", "o1", 30), &NO_FAULTS)
            .expect("fidelity child write");
        assert_eq!(child.moment.before_latest_moment_id.as_deref(), Some("m1"));
        vt.rollback_text_file_mutation(&rollback("feat", "a.md", "m2"), &NO_FAULTS)
            .expect("child rollback with intact link");
        let restored = vt.read_text(WS, "feat", "a.md").unwrap().unwrap();
        assert_eq!(restored.text, "one");
        assert!(restored.latest_moment_id.starts_with("rollback-"));
        assert_eq!(
            vt.get_moment(WS, &restored.latest_moment_id)
                .unwrap()
                .expect("compensating write")
                .before_latest_moment_id
                .as_deref(),
            Some("m2")
        );
    }

    let reject = ScratchDir::new().expect("reject scratch");
    let reject_db = reject.engine_db_path().expect("reject db");
    let mut reject_store = EngineStore::open(&reject_db, 1).expect("reject open");
    bootstrap(&mut reject_store);
    {
        let mut vt = VersionedTextStore::new(&mut reject_store);
        vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
            .expect("main write");
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
        vt.write_text(&write("feat", "a.md", "two", "m2", "o1", 30), &NO_FAULTS)
            .expect("child write");
    }
    reject_store
        .read_with(|conn| {
            conn.execute(
                "UPDATE moments SET before_latest_moment_id = NULL \
                 WHERE workspace_id = ?1 AND moment_id = 'm2'",
                [WS],
            )
        })
        .expect("clear migrated link");
    let mut vt = VersionedTextStore::new(&mut reject_store);
    assert_eq!(
        vt.rollback_text_file_mutation(&rollback("main", "a.md", "m1"), &NO_FAULTS)
            .expect_err("unresolved dependent")
            .code(),
        "invalid-input"
    );
}

// oracle: versions-rollback-text-file-mutation never rewrites local state from
// a sync_record_only peer-divergence row.
#[test]
fn rollback_rejects_sync_record_only_moment() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let blob = {
        let mut vt = VersionedTextStore::new(&mut store);
        vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
            .expect("write")
            .snapshot
            .blob_sha256
    };
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO moments (workspace_id, moment_order, moment_id, version_id, object_id, \
                 path, recorded_at_ms, operation, after_blob_sha256, before_present, \
                 before_blob_sha256, before_latest_moment_id, metadata_origin, author_json, \
                 sync_record_only) VALUES (?1, 2, 'peer', 'main', 'o1', 'a.md', 20, 'write', \
                 ?2, 2, ?2, 'm1', 'sync', NULL, 1)",
                rusqlite::params![WS, blob],
            )
        })
        .expect("insert peer moment");
    let mut vt = VersionedTextStore::new(&mut store);
    assert_eq!(
        vt.rollback_text_file_mutation(&rollback("main", "a.md", "peer"), &NO_FAULTS)
            .expect_err("record only")
            .code(),
        "invalid-input"
    );
}

// oracle: versions-rollback-text-file-mutation refuses a rename rollback when
// its source path has since been occupied by a different object.
#[test]
fn rollback_rejects_occupied_restore_path() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);
    vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("write");
    vt.rename_text_file(&rename("main", "a.md", "b.md", "m2", 20), &NO_FAULTS)
        .expect("rename");
    vt.write_text(&write("main", "a.md", "other", "m3", "o2", 30), &NO_FAULTS)
        .expect("occupy source");
    assert_eq!(
        vt.rollback_text_file_mutation(&rollback("main", "b.md", "m2"), &NO_FAULTS)
            .expect_err("occupied")
            .code(),
        "target-path-exists"
    );
}

// oracle: versions-rollback-text-file-mutation reconstructs a legacy missing
// preimage from the earlier moment plus caller-supplied legacy text.
#[test]
fn rollback_legacy_moment_uses_supplied_before_text() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    {
        let mut vt = VersionedTextStore::new(&mut store);
        vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
            .expect("first");
        vt.write_text(&write("main", "a.md", "two", "m2", "o1", 20), &NO_FAULTS)
            .expect("second");
    }
    store
        .read_with(|conn| {
            conn.execute(
                "UPDATE moments SET before_present = 0, before_blob_sha256 = NULL, \
                 before_latest_moment_id = NULL WHERE workspace_id = ?1 AND moment_id = 'm2'",
                [WS],
            )
        })
        .expect("legacy update");
    let mut input = rollback("main", "a.md", "m2");
    input.legacy_before_text = Some("one".to_owned());
    let mut vt = VersionedTextStore::new(&mut store);
    vt.rollback_text_file_mutation(&input, &NO_FAULTS)
        .expect("legacy rollback");
    let restored = vt.read_text(WS, "main", "a.md").unwrap().unwrap();
    assert_eq!(restored.text, "one");
    assert!(restored.latest_moment_id.starts_with("rollback-"));
    assert_eq!(
        vt.get_moment(WS, &restored.latest_moment_id)
            .unwrap()
            .expect("compensating write")
            .before_latest_moment_id
            .as_deref(),
        Some("m2")
    );
}

// oracle: versions-rollback-text-file-mutation fails closed for a legacy-unset
// first mutation because no prior snapshot or caller text can reconstruct it.
#[test]
fn rollback_legacy_moment_without_preimage_or_text_is_rejected() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    {
        let mut vt = VersionedTextStore::new(&mut store);
        vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
            .expect("write");
    }
    store
        .read_with(|conn| {
            conn.execute(
                "UPDATE moments SET before_present = 0 WHERE workspace_id = ?1 AND moment_id = 'm1'",
                [WS],
            )
        })
        .expect("legacy update");
    let mut vt = VersionedTextStore::new(&mut store);
    assert_eq!(
        vt.rollback_text_file_mutation(&rollback("main", "a.md", "m1"), &NO_FAULTS)
            .expect_err("missing legacy preimage")
            .code(),
        "invalid-input"
    );
}

#[test]
fn binary_write_rejects_the_reserved_capture_origin_at_the_domain_door() {
    // MUTATION: drop the binary-door reservation -> an internal caller can
    // mark DB-only bytes capture-owned and the next disk pass retires them.
    let scratch = ScratchDir::new().unwrap();
    let mut store = EngineStore::open(&scratch.engine_db_path().unwrap(), 1).unwrap();
    bootstrap(&mut store);
    let error = VersionedTextStore::new(&mut store)
        .write_binary(
            &dohc_engine_domain::WriteBinary {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                object_id: "bin-object".to_owned(),
                path: "asset.bin".to_owned(),
                bytes: vec![1, 2, 3],
                moment_id: "bin-capture-origin".to_owned(),
                metadata_origin: "capture".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
                request_id: None,
            },
            &NO_FAULTS,
        )
        .expect_err("reserved origin must refuse");
    assert_eq!(error.code(), "invalid-input", "unexpected error: {error}");
    let (moments, blobs, requests) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM moments", [], |row| {
                    row.get::<_, i64>(0)
                })?,
                conn.query_row("SELECT COUNT(*) FROM binary_blobs", [], |row| {
                    row.get::<_, i64>(0)
                })?,
                conn.query_row("SELECT COUNT(*) FROM engine_requests", [], |row| {
                    row.get::<_, i64>(0)
                })?,
            ))
        })
        .unwrap();
    assert_eq!(
        (moments, blobs, requests),
        (0, 0, 0),
        "a refused reserved-origin write must leave no rows behind"
    );
}

/// Moment PAYLOAD provenance is what the OPERATION carried; the `before_*`
/// columns are what this store can roll back to. They coincide for every
/// locally authored operation EXCEPT rename, where the payload moved from one
/// path to another — so a writer that just mirrors the row's own path silently
/// loses the source. Pins what each writer stores.
#[test]
fn every_moment_writer_records_payload_provenance() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    {
        let mut vt = VersionedTextStore::new(&mut store);
        vt.write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
            .expect("first write");
        vt.write_text(&write("main", "a.md", "two", "m2", "o1", 20), &NO_FAULTS)
            .expect("overwrite");
        vt.rename_text_file(&rename("main", "a.md", "b.md", "m3", 30), &NO_FAULTS)
            .expect("rename");
        vt.delete_text_file(&delete("main", "b.md", "m4", 40), &NO_FAULTS)
            .expect("delete");
    }

    type Provenance = (Option<String>, Option<String>, Option<String>, String);
    let provenance = |moment_id: &str| -> Provenance {
        let id = moment_id.to_owned();
        store
            .read_with(move |conn| {
                Ok::<Provenance, dohc_engine_domain::DomainError>(
                    conn.query_row(
                        "SELECT payload_before_path, payload_before_content_kind, \
                         payload_before_blob_sha256, \
                         payload_after_path FROM moments WHERE moment_id = ?1",
                        rusqlite::params![id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .expect("provenance columns"),
                )
            })
            .expect("read provenance")
    };
    let blob_of = |moment_id: &str| -> Option<String> {
        let id = moment_id.to_owned();
        store
            .read_with(move |conn| {
                Ok::<_, dohc_engine_domain::DomainError>(
                    conn.query_row(
                        "SELECT after_blob_sha256 FROM moments WHERE moment_id = ?1",
                        rusqlite::params![id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .expect("after digest"),
                )
            })
            .expect("read after digest")
    };

    // A FIRST write carries no before payload.
    let first = provenance("m1");
    assert_eq!(first.0, None, "a first write has no payload-before path");
    assert_eq!(first.1, None, "a first write has no payload-before kind");
    assert_eq!(first.2, None, "a first write has no payload-before digest");
    assert_eq!(first.3, "a.md", "payload-after path is where it landed");

    // An OVERWRITE carries the replaced content, at the same path.
    let overwrite = provenance("m2");
    assert_eq!(overwrite.0.as_deref(), Some("a.md"));
    assert_eq!(overwrite.1.as_deref(), Some("text"));
    assert_eq!(
        overwrite.2,
        blob_of("m1"),
        "an overwrite's payload-before is the content it replaced"
    );
    assert_eq!(overwrite.3, "a.md");

    // THE CASE THAT DIVERGES: the payload moved a.md -> b.md.
    let renamed = provenance("m3");
    assert_eq!(
        renamed.0.as_deref(),
        Some("a.md"),
        "a rename's payload came FROM the source path"
    );
    assert_eq!(
        renamed.3, "b.md",
        "a rename's payload landed at the destination"
    );
    assert_eq!(
        renamed.2,
        blob_of("m2"),
        "a rename carries unchanged content"
    );

    // A DELETE carries the removed content on BOTH sides (oracle parity).
    let deleted = provenance("m4");
    assert_eq!(deleted.0.as_deref(), Some("b.md"));
    assert_eq!(deleted.3, "b.md");
    assert_eq!(
        deleted.2,
        blob_of("m4"),
        "a delete's payload-before is the content it removed"
    );
}

/// The binary head writer (`persist_binary_head_in_tx`) is the fourth moment
/// writer and the only one that can record a BINARY payload-before, so it is
/// the only coverage for a BINARY payload-before digest. Without this, deleting
/// the payload columns from that INSERT — or swapping the text and binary
/// digest parameters — leaves the whole suite green.
#[test]
fn the_binary_head_writer_records_payload_provenance() {
    use dohc_engine_domain::WriteBinary;

    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);

    let binary = |path: &str, bytes: Vec<u8>, moment: &str, now: i64| WriteBinary {
        workspace_id: WS.to_owned(),
        version_id: "main".to_owned(),
        object_id: "obj-bin".to_owned(),
        path: path.to_owned(),
        bytes,
        moment_id: moment.to_owned(),
        metadata_origin: "user".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: now,
        request_id: None,
    };
    {
        let mut vt = VersionedTextStore::new(&mut store);
        // A TEXT head first, so the second write has a text payload-before and
        // the third has a BINARY one.
        vt.write_text(
            &write("main", "img.bin", "placeholder", "b1", "obj-bin", 10),
            &NO_FAULTS,
        )
        .expect("text head");
        vt.write_binary(&binary("img.bin", vec![1, 2, 3], "b2", 20), &NO_FAULTS)
            .expect("binary over text");
        vt.write_binary(&binary("img.bin", vec![4, 5, 6], "b3", 30), &NO_FAULTS)
            .expect("binary over binary");
    }

    let row = |moment_id: &str| -> (Option<String>, Option<String>, Option<String>, String) {
        let id = moment_id.to_owned();
        store
            .read_with(move |conn| {
                Ok::<_, dohc_engine_domain::DomainError>(
                    conn.query_row(
                        "SELECT payload_before_path, payload_before_content_kind, \
                         payload_before_blob_sha256, \
                         payload_after_path FROM moments WHERE moment_id = ?1",
                        rusqlite::params![id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                    )
                    .expect("provenance row"),
                )
            })
            .expect("read provenance")
    };
    let digests = |moment_id: &str| -> (Option<String>, Option<String>) {
        let id = moment_id.to_owned();
        store
            .read_with(move |conn| {
                Ok::<_, dohc_engine_domain::DomainError>(
                    conn.query_row(
                        "SELECT after_blob_sha256, after_binary_sha256 \
                         FROM moments WHERE moment_id = ?1",
                        rusqlite::params![id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .expect("after digests"),
                )
            })
            .expect("read after digests")
    };

    // Binary over TEXT: the payload-before is the replaced TEXT, so the digest
    // belongs in the blob column and the binary column stays empty.
    let over_text = row("b2");
    assert_eq!(over_text.0.as_deref(), Some("img.bin"));
    assert_eq!(over_text.1.as_deref(), Some("text"));
    assert_eq!(
        over_text.2,
        digests("b1").0,
        "a TEXT preimage puts its text digest in the shared column"
    );
    assert_eq!(over_text.3, "img.bin");

    // Binary over BINARY: the payload-before digest goes in the SAME shared
    // column, tagged by kind — not a separate binary column.
    let over_binary = row("b3");
    assert_eq!(over_binary.0.as_deref(), Some("img.bin"));
    assert_eq!(over_binary.1.as_deref(), Some("binary"));
    assert_eq!(
        over_binary.2,
        digests("b2").1,
        "a BINARY preimage puts its BINARY digest in the SAME shared column —          the oracle's shape, which its readers discriminate by content kind"
    );
    assert_eq!(over_binary.3, "img.bin");

    // The payload-AFTER pair carries ONE digest, selected by kind — the oracle's
    // single-column shape that the shared contract and the TS readers expect.
    let after = |moment_id: &str| -> (Option<String>, Option<String>) {
        let id = moment_id.to_owned();
        store
            .read_with(move |conn| {
                Ok::<_, dohc_engine_domain::DomainError>(
                    conn.query_row(
                        "SELECT payload_after_content_kind, payload_after_blob_sha256 \
                         FROM moments WHERE moment_id = ?1",
                        rusqlite::params![id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .expect("payload-after pair"),
                )
            })
            .expect("read payload-after")
    };
    assert_eq!(
        after("b1"),
        (Some("text".to_owned()), digests("b1").0),
        "a text moment's payload-after digest is its TEXT blob"
    );
    assert_eq!(
        after("b3"),
        (Some("binary".to_owned()), digests("b3").1),
        "a binary moment's payload-after digest is its BINARY digest"
    );
}
