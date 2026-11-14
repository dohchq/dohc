//! Version identity, write boundaries, history, replay, and rollback traces.

use dohc_engine_domain::store::SourceCaptureBounds;
use dohc_engine_domain::{
    CreateNamedVersion, DeleteTextFile, ListMomentsQuery, MergeTextFileFromVersion,
    MergeTextFileResult, NoFaults, RenameTextFile, RollbackTextFileMutation, VersionKind,
    VersionedTextStore, WriteText,
};
use dohc_engine_storage::{EngineStore, StorageError, hex_sha256};
use dohc_engine_testkit::{ScratchDir, engine_db_path};

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

#[test]
fn captures_selected_source_identity_and_refuses_missing_or_duplicate_paths() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    VersionedTextStore::new(&mut store)
        .write_text(
            &write("main", "notes/a.md", "hello", "m1", "o1", 2),
            &NO_FAULTS,
        )
        .expect("write");
    let bounds = SourceCaptureBounds {
        max_input_files: 4,
        max_input_bytes: 1024,
    };
    let capture = VersionedTextStore::new(&mut store)
        .capture_sources(WS, "main", &["notes/a.md".into()], &bounds)
        .expect("capture");
    assert_eq!(capture.files[0].path, "notes/a.md");
    assert_eq!(capture.total_bytes, 5);
    assert_eq!(capture.files[0].sha256, hex_sha256(b"hello"));
    assert_eq!(capture.files[0].object_id, "o1");
    assert_eq!(capture.files[0].latest_moment_id, "m1");
    VersionedTextStore::new(&mut store)
        .write_text(
            &write("main", "notes/a.md", "changed", "m2", "o1", 3),
            &NO_FAULTS,
        )
        .expect("change");
    let pinned = VersionedTextStore::new(&mut store)
        .read_text_blob(WS, &capture.files[0].sha256)
        .expect("blob")
        .expect("retained");
    assert_eq!(pinned.text.as_deref(), Some("hello"));
    let changed = VersionedTextStore::new(&mut store)
        .capture_sources(WS, "main", &["notes/a.md".into()], &bounds)
        .expect("recapture");
    assert_ne!(capture.source_digest, changed.source_digest);
    let err = VersionedTextStore::new(&mut store)
        .capture_sources(
            WS,
            "main",
            &["notes/a.md".into(), "notes/a.md".into()],
            &bounds,
        )
        .expect_err("duplicate");
    assert_eq!(err.code(), "invalid-input");
    for path in ["missing.js", ".env", "../outside.js", ".dohc/engine.db"] {
        assert!(
            VersionedTextStore::new(&mut store)
                .capture_sources(WS, "main", &[path.into()], &bounds)
                .is_err(),
            "{path}"
        );
    }
    for (workspace, version) in [("elsewhere", "main"), (WS, "missing")] {
        assert!(
            VersionedTextStore::new(&mut store)
                .capture_sources(workspace, version, &["notes/a.md".into()], &bounds)
                .is_err()
        );
    }
    assert!(
        VersionedTextStore::new(&mut store)
            .capture_sources(
                WS,
                "main",
                &["notes/a.md".into()],
                &SourceCaptureBounds {
                    max_input_files: 1,
                    max_input_bytes: 6
                }
            )
            .is_err()
    );
    store.read_with(|conn| conn.execute("INSERT INTO ydoc_docs (workspace_id,version_id,object_id,updated_at_ms) VALUES (?1,'main','o1',3)", [WS])).expect("marker");
    assert!(
        VersionedTextStore::new(&mut store)
            .capture_sources(WS, "main", &["notes/a.md".into()], &bounds)
            .is_err()
    );
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
        metadata_origin: "restore".to_owned(),
        author_json: None,
    }
}

#[test]
fn write_text_directly_at_a_secret_path_is_refused_by_the_secret_floor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
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
fn plaintext_store_door_rejects_reserved_ignored_and_traversal_paths() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
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

#[test]
fn deduped_write_returns_original_not_later_state() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);

    let mut first = write("main", "a.md", "first", "m1", "o1", 10);
    first.request_id = Some("req".to_owned());
    vt.write_text(&first, &NO_FAULTS).expect("first");

    vt.write_text(&write("main", "a.md", "second", "m2", "o1", 20), &NO_FAULTS)
        .expect("second");

    let replay = vt.write_text(&first, &NO_FAULTS).expect("replay");
    assert!(replay.deduped);
    assert_eq!(replay.snapshot.text, "first");
    assert_eq!(replay.snapshot.latest_moment_id, "m1");
    assert_eq!(replay.moment.moment_id, "m1");
    assert_eq!(
        vt.read_text(WS, "main", "a.md").unwrap().unwrap().text,
        "second"
    );

    let mut mismatch = first;
    mismatch.text = "changed request body".to_owned();
    let error = vt
        .write_text(&mismatch, &NO_FAULTS)
        .expect_err("changed request must not replay");
    assert_eq!(error.code(), "idempotency-key-reuse-mismatch");
}

#[test]
fn rollback_purges_versioned_and_merge_requests_but_preserves_other_kinds() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);

    VersionedTextStore::new(&mut store)
        .write_text(&write("main", "a.md", "one", "m1", "o1", 10), &NO_FAULTS)
        .expect("first versioned write");

    store
        .write_with(&NO_FAULTS, |tx| {
            tx.execute(
                "INSERT INTO engine_requests \
                 (request_id, payload_hash, result_seq, committed_at, kind) \
                 VALUES ('chat-collision', 'hash', 2, 15, 'chat')",
                [],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("chat ledger row");

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
                "SELECT kind FROM engine_requests WHERE request_id = 'chat-collision'",
                [],
                |row| row.get(0),
            )
        })
        .expect("chat ledger survives");
    assert_eq!(surviving_kind.as_deref(), Some("chat"));

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
                .merge_text_file_from_version_with(&merge, &NO_FAULTS, |_, _| Ok(()))
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
        .merge_text_file_from_version_with(&merge, &NO_FAULTS, |_, _| Ok(()))
        .expect("merge retry re-executes");
    assert!(matches!(
        merge_retry,
        MergeTextFileResult::Write { write, .. }
            if !write.deduped && write.moment.moment_id == "merge-retry-moment"
    ));

    let surviving_kind_after_merge: Option<String> = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT kind FROM engine_requests WHERE request_id = 'chat-collision'",
                [],
                |row| row.get(0),
            )
        })
        .expect("chat ledger still survives merge rollback");
    assert_eq!(surviving_kind_after_merge.as_deref(), Some("chat"));
}

#[test]
fn create_named_version_forks_and_isolates() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
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
    assert_eq!(
        copied_metadata,
        (expected_metadata.clone(), expected_metadata),
        "omitting either ordinal-18 column from either INSERT...SELECT loses provenance from the live fork or its frozen comparison base.",
    );
    let mut vt = VersionedTextStore::new(&mut store);

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

#[test]
fn list_moments_keyset_pagination_edges() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let mut store = EngineStore::open(&db, 1).expect("open");
    bootstrap(&mut store);
    let mut vt = VersionedTextStore::new(&mut store);

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

    let full = vt.list_moments(&query(5, None)).expect("page");
    assert_eq!(full.moments.len(), 5);
    assert_eq!(full.latest_moment_order, Some(5));
    assert_eq!(full.next_before_moment_order, None);
    assert_eq!(full.moments[0].moment_order, 5);
    assert_eq!(full.moments[4].moment_order, 1);

    let over = vt.list_moments(&query(6, None)).expect("page");
    assert_eq!(over.moments.len(), 5);
    assert_eq!(over.next_before_moment_order, None);

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

    let mut bad = query(4, None);
    bad.version_id = Some("nope".to_owned());
    assert_eq!(
        vt.list_moments(&bad).expect_err("bad version").code(),
        "version-not-found"
    );

    assert_eq!(
        vt.list_moments(&query(0, None))
            .expect_err("bad limit")
            .code(),
        "invalid-input"
    );
}

#[test]
fn delete_text_file_does_not_affect_sibling_fork() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
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

#[test]
fn rollback_delete_restores_deleted_content() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
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

#[test]
fn rollback_rejects_non_latest_mutation() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
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

#[test]
fn rollback_rejects_migrated_null_link_dependent() {
    let fidelity = ScratchDir::new().expect("fidelity scratch");
    let fidelity_db = engine_db_path(&fidelity).expect("fidelity db");
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
    let reject_db = engine_db_path(&reject).expect("reject db");
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

#[test]
fn rollback_rejects_occupied_restore_path() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
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

/// Moment PAYLOAD provenance is what the OPERATION carried; the `before_*`
/// columns are what this store can roll back to. They coincide for every
/// locally authored operation except rename, where the payload moved from one
/// path to another — so a writer that just mirrors the row's own path silently
/// loses the source. Pins what each writer stores.
#[test]
fn every_moment_writer_records_payload_provenance() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
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

    let first = provenance("m1");
    assert_eq!(first.0, None, "a first write has no payload-before path");
    assert_eq!(first.1, None, "a first write has no payload-before kind");
    assert_eq!(first.2, None, "a first write has no payload-before digest");
    assert_eq!(first.3, "a.md", "payload-after path is where it landed");

    let overwrite = provenance("m2");
    assert_eq!(overwrite.0.as_deref(), Some("a.md"));
    assert_eq!(overwrite.1.as_deref(), Some("text"));
    assert_eq!(
        overwrite.2,
        blob_of("m1"),
        "an overwrite's payload-before is the content it replaced"
    );
    assert_eq!(overwrite.3, "a.md");

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

    let deleted = provenance("m4");
    assert_eq!(deleted.0.as_deref(), Some("b.md"));
    assert_eq!(deleted.3, "b.md");
    assert_eq!(
        deleted.2,
        blob_of("m4"),
        "a delete's payload-before is the content it removed"
    );
}

#[test]
fn file_resolution_tracks_rename_delete_reuse_versions_and_restart() {
    use dohc_engine_domain::{FileResolution as R, FileResolveTarget as T};
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    {
        let mut store = EngineStore::open(&db, 1).unwrap();
        bootstrap(&mut store);
        let mut domain = VersionedTextStore::new(&mut store);
        domain
            .write_text(&write("main", " a.md ", "body", "m1", "o1", 2), &NO_FAULTS)
            .unwrap();
        assert_eq!(
            domain
                .resolve_files(
                    WS,
                    None,
                    &[
                        T::Path(" a.md ".into()),
                        T::Path("missing.md".into()),
                        T::Path("../bad".into()),
                        T::ObjectId("".into()),
                        T::Invalid
                    ]
                )
                .unwrap()
                .1,
            vec![
                R::Found {
                    object_id: "o1".into(),
                    path: " a.md ".into()
                },
                R::Absent,
                R::Invalid,
                R::Invalid,
                R::Invalid
            ]
        );
        assert_eq!(
            domain
                .resolve_files(WS, Some("unknown"), &[T::Invalid])
                .unwrap_err()
                .code(),
            "version-not-found"
        );
        assert!(domain.resolve_files("foreign", Some("main"), &[]).is_err());
        domain
            .write_binary(
                &dohc_engine_domain::WriteBinary {
                    workspace_id: WS.into(),
                    version_id: "main".into(),
                    object_id: "binary".into(),
                    path: "photo.png".into(),
                    bytes: vec![1, 2],
                    moment_id: "binary-m".into(),
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 3,
                    request_id: None,
                },
                &NO_FAULTS,
            )
            .unwrap();
        assert_eq!(
            domain
                .resolve_files(
                    WS,
                    None,
                    &[T::Path("photo.png".into()), T::ObjectId("binary".into())]
                )
                .unwrap()
                .1,
            vec![
                R::Found {
                    object_id: "binary".into(),
                    path: "photo.png".into()
                };
                2
            ]
        );
        domain
            .create_named_version(
                &CreateNamedVersion {
                    workspace_id: WS.into(),
                    new_version_id: "draft".into(),
                    name: "Draft".into(),
                    from_version_id: "main".into(),
                    now_ms: 3,
                    request_id: None,
                },
                &NO_FAULTS,
            )
            .unwrap();
        domain
            .rename_text_file(
                &RenameTextFile {
                    workspace_id: WS.into(),
                    version_id: "main".into(),
                    from_path: " a.md ".into(),
                    to_path: "moved.md".into(),
                    moment_id: "m2".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 4,
                },
                &NO_FAULTS,
            )
            .unwrap();
        assert_eq!(
            domain
                .resolve_files(
                    WS,
                    Some("main"),
                    &[T::Path(" a.md ".into()), T::ObjectId("o1".into())]
                )
                .unwrap()
                .1,
            vec![
                R::Absent,
                R::Found {
                    object_id: "o1".into(),
                    path: "moved.md".into()
                }
            ]
        );
        domain
            .delete_text_file(
                &DeleteTextFile {
                    workspace_id: WS.into(),
                    version_id: "main".into(),
                    path: "moved.md".into(),
                    moment_id: "m3".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 5,
                },
                &NO_FAULTS,
            )
            .unwrap();
        domain
            .write_text(&write("main", "moved.md", "new", "m4", "o2", 6), &NO_FAULTS)
            .unwrap();
        domain.set_active_version(WS, "draft", &NO_FAULTS).unwrap();
        assert_eq!(
            domain
                .resolve_files(WS, None, &[T::ObjectId("o1".into())])
                .unwrap(),
            (
                "draft".into(),
                vec![R::Found {
                    object_id: "o1".into(),
                    path: " a.md ".into()
                }]
            )
        );
    }
    let mut store = EngineStore::open(&db, 7).unwrap();
    let domain = VersionedTextStore::new(&mut store);
    assert_eq!(
        domain
            .resolve_files(
                WS,
                Some("main"),
                &[T::ObjectId("o1".into()), T::Path("moved.md".into())]
            )
            .unwrap()
            .1,
        vec![
            R::Absent,
            R::Found {
                object_id: "o2".into(),
                path: "moved.md".into()
            }
        ]
    );
    assert_eq!(domain.resolve_files(WS, None, &[]).unwrap().0, "draft");
}
