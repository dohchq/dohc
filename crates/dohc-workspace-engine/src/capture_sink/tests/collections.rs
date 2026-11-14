use super::*;

#[test]
fn excessive_quote_depth_is_held_in_both_collection_capture_routes() {
    for batched in [false, true] {
        let scratch = ScratchDir::new().unwrap();
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        let path = "tasks/empty.md";
        write_file(
            scratch.path(),
            "tasks/collection.yaml",
            b"fields:\n  Title:\n    type: text\n",
        );
        write_file(scratch.path(), path, b"");
        ingest(&mut sink, "tasks/collection.yaml").unwrap();
        ingest(&mut sink, path).unwrap();
        sink.reconcile_collections_observed(None).unwrap();
        seed_captured_richdoc_lineage(&sink, path);
        let conn = Connection::open(&db).unwrap();
        let completed = format!(
            "---\nTitle: Completed\n---\n{} too deep\n",
            "> ".repeat(121)
        );
        let completed = completed.as_bytes();
        write_file(scratch.path(), path, completed);
        if batched {
            write_file(scratch.path(), "tasks/sibling.md", b"Sibling\n");
            let ops = [path, "tasks/sibling.md"].map(|path| CaptureOp::Ingest {
                path: path.into(),
                size: 0,
                sha256: "advisory-sha".into(),
                media_type: "text/markdown",
                mtime_ms: 0,
                reason: IngestReason::Added,
            });
            let BatchIngestResult::Committed(results) = sink.ingest_batch(&ops).unwrap() else {
                panic!("batch must return per-file outcomes");
            };
            assert!(matches!(results[0], Ok(IngestOutcome::Held { .. })));
            assert!(matches!(results[1], Ok(IngestOutcome::Captured { .. })));
        } else {
            assert!(matches!(
                ingest(&mut sink, path),
                Ok(IngestOutcome::Held { .. })
            ));
        }
        let hold: (String, String) = conn
            .query_row(
                "SELECT path, observed_sha256 FROM capture_file_holds WHERE workspace_id=?1",
                [WORKSPACE_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(hold, (path.to_owned(), hex_sha256(completed)));
        assert_eq!(snapshot(&db, path).unwrap().text, "");
        assert_eq!(std::fs::read(scratch.path().join(path)).unwrap(), completed);
        drop(conn);
        drop(sink);
        supervisor.close(&db).unwrap();
    }
}

#[test]
fn unsupported_collection_keeps_record_bytes_and_ids_untouched() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"version: 2\nname: Tasks\n",
    );
    let original = b"---\nTitle: Leave alone\n---\nBody\n";
    write_file(scratch.path(), "tasks/new.md", original);
    ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
    ingest(&mut sink, "tasks/new.md").expect("capture record");
    let moments = moment_count(&db, "tasks/new.md");
    let updates = ydoc_update_count(&db, "tasks/new.md");
    sink.reconcile_collections_observed(None)
        .expect("unsupported schema");
    assert!(collection_record(&db, "tasks/new.md").is_none());
    assert_eq!(
        std::fs::read(scratch.path().join("tasks/new.md")).expect("disk bytes"),
        original
    );
    assert_eq!(
        snapshot(&db, "tasks/new.md")
            .expect("captured bytes")
            .text
            .as_bytes(),
        original
    );
    assert_eq!(moment_count(&db, "tasks/new.md"), moments);
    assert_eq!(ydoc_update_count(&db, "tasks/new.md"), updates);
}

fn enable_sync_for_collection_test(db: &Path) {
    let connection = Connection::open(db).expect("open collection test database");
    connection
        .execute(
            "INSERT INTO sync_identity \
                 (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
                 VALUES (?1, 'local-origin', 'epoch', 'stream', 1)",
            [WORKSPACE_ID],
        )
        .expect("seed collection test sync identity");
    connection
        .execute(
            "INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq) \
                 VALUES (?1, 'local-origin', 0)",
            [WORKSPACE_ID],
        )
        .expect("enable collection test sync");
}

fn adopted_record_id(db: &Path, path: &str) -> String {
    let (record_id, state) = collection_record(db, path).expect("record binding");
    assert_eq!(state, "adopted");
    let record_id = record_id.expect("adopted record id");
    assert!(is_record_id(&record_id), "WP1 record id format");
    record_id
}

fn query_collection(db: &Path, path: &str, resolve_relations: bool) -> CollectionQueryResult {
    let store = EngineStore::open(db, 100).expect("reopen store");
    store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                path,
                &CollectionQuery {
                    resolve_relations,
                    ..CollectionQuery::default()
                },
            )
        })
        .expect("query collection")
        .expect("collection exists")
}

fn get_record(db: &Path, collection_path: &str, record_id: &str) -> CollectionRecordDetails {
    let store = EngineStore::open(db, 100).expect("reopen store");
    store
        .read_with(|conn| {
            get_collection_record(conn, WORKSPACE_ID, collection_path, record_id, 100, None)
        })
        .expect("get collection record")
        .expect("record exists")
}

fn collection_status(db: &Path, path: &str) -> Option<(String, String)> {
    let store = EngineStore::open(db, 100).expect("reopen store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT schema_status, degradation_reasons_json FROM collections \
                     WHERE workspace_id = ?1 AND version_id = ?2 AND collection_path = ?3",
                [WORKSPACE_ID, VERSION_ID, path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
        })
        .expect("collection status")
}

fn indexed_collection_field(
    db: &Path,
    path: &str,
    field: &str,
) -> Option<(String, String, Option<String>)> {
    let store = EngineStore::open(db, 100).expect("reopen store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT f.value_json,f.validation_status,f.validation_reason_json \
                     FROM collection_record_fields f \
                     JOIN collection_records r ON r.workspace_id=f.workspace_id \
                       AND r.version_id=f.version_id AND r.record_id=f.record_id \
                     WHERE r.workspace_id=?1 AND r.version_id=?2 AND r.file_path=?3 \
                       AND f.field_name=?4",
                rusqlite::params![WORKSPACE_ID, VERSION_ID, path, field],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
        })
        .expect("indexed collection field")
}

fn relation_edge_count(db: &Path, source_path: &str, field: &str, target: &str) -> i64 {
    let store = EngineStore::open(db, 100).expect("reopen store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM collection_relation_edges e \
                     JOIN collection_records r ON r.workspace_id=e.workspace_id \
                       AND r.version_id=e.version_id AND r.record_id=e.source_record_id \
                     WHERE r.workspace_id=?1 AND r.version_id=?2 AND r.file_path=?3 \
                       AND e.field_name=?4 AND e.target_record_id=?5",
                rusqlite::params![WORKSPACE_ID, VERSION_ID, source_path, field, target],
                |row| row.get(0),
            )
        })
        .expect("relation edge count")
}

fn latest_field_history(
    db: &Path,
    source_path: &str,
    field: &str,
) -> (Option<String>, Option<String>, Option<String>) {
    let store = EngineStore::open(db, 100).expect("reopen store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT h.previous_value_json,h.next_value_json,h.author_origin_id \
                     FROM collection_field_history h \
                     JOIN collection_records r ON r.workspace_id=h.workspace_id \
                       AND r.version_id=h.version_id AND r.record_id=h.record_id \
                     WHERE r.workspace_id=?1 AND r.version_id=?2 AND r.file_path=?3 \
                       AND h.field_name=?4 ORDER BY h.history_id DESC LIMIT 1",
                rusqlite::params![WORKSPACE_ID, VERSION_ID, source_path, field],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .expect("latest collection field history")
}

fn latest_ydoc_actor_origin(db: &Path, path: &str) -> Option<String> {
    let store = EngineStore::open(db, 100).expect("reopen store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT u.actor_origin_id FROM ydoc_updates u \
                     JOIN collection_records r ON r.workspace_id = u.workspace_id \
                       AND r.version_id = u.version_id AND r.object_id = u.object_id \
                     WHERE r.workspace_id = ?1 AND r.version_id = ?2 AND r.file_path = ?3 \
                     ORDER BY u.seq DESC LIMIT 1",
                [WORKSPACE_ID, VERSION_ID, path],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
        })
        .expect("Y.Doc actor origin")
}

fn ydoc_update_count(db: &Path, path: &str) -> i64 {
    let store = EngineStore::open(db, 100).expect("reopen store");
    ydoc_update_count_from_store(&store, path)
}

fn ydoc_update_count_from_store(store: &EngineStore, path: &str) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM ydoc_updates u \
                     JOIN collection_records r ON r.workspace_id = u.workspace_id \
                       AND r.version_id = u.version_id AND r.object_id = u.object_id \
                     WHERE r.workspace_id = ?1 AND r.version_id = ?2 AND r.file_path = ?3",
                [WORKSPACE_ID, VERSION_ID, path],
                |row| row.get(0),
            )
        })
        .expect("Y.Doc update count")
}

fn engine_ydoc_update_count(db: &Path, path: &str) -> i64 {
    let store = EngineStore::open(db, 100).expect("reopen store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM ydoc_updates u \
                     JOIN collection_records r ON r.workspace_id = u.workspace_id \
                       AND r.version_id = u.version_id AND r.object_id = u.object_id \
                     WHERE r.workspace_id = ?1 AND r.version_id = ?2 AND r.file_path = ?3 \
                       AND u.actor_origin_id = 'engine'",
                [WORKSPACE_ID, VERSION_ID, path],
                |row| row.get(0),
            )
        })
        .expect("engine Y.Doc update count")
}

#[derive(Clone, Copy, Debug)]
enum GeneratedFrontmatter {
    None,
    Valid,
    Malformed,
}

#[derive(Clone, Debug)]
struct GeneratedAdoptionCase {
    markdown: String,
    frontmatter: GeneratedFrontmatter,
    first_line_len: Option<usize>,
    line_ending: &'static str,
    replicated: bool,
    id_collision_copy: bool,
}

impl GeneratedAdoptionCase {
    fn expected_adoption(&self, record_id: &str) -> Option<String> {
        match self.frontmatter {
            GeneratedFrontmatter::Malformed => None,
            GeneratedFrontmatter::Valid => {
                let first_line_len = self.first_line_len.expect("frontmatter opener");
                let mut adopted = String::with_capacity(
                    self.markdown.len() + RECORD_ID_FRONTMATTER_KEY.len() + record_id.len() + 3,
                );
                adopted.push_str(&self.markdown[..first_line_len]);
                adopted.push_str(RECORD_ID_FRONTMATTER_KEY);
                adopted.push_str(": ");
                adopted.push_str(record_id);
                adopted.push_str(self.line_ending);
                adopted.push_str(&self.markdown[first_line_len..]);
                Some(adopted)
            }
            GeneratedFrontmatter::None => {
                let mut adopted = String::new();
                adopted.push_str("---");
                adopted.push_str(self.line_ending);
                adopted.push_str(RECORD_ID_FRONTMATTER_KEY);
                adopted.push_str(": ");
                adopted.push_str(record_id);
                adopted.push_str(self.line_ending);
                adopted.push_str("---");
                if !self.markdown.is_empty() {
                    adopted.push_str(self.line_ending);
                    adopted.push_str(self.line_ending);
                    adopted.push_str(&self.markdown);
                }
                Some(adopted)
            }
        }
    }
}

fn collection_adoption_cases() -> impl Strategy<Value = GeneratedAdoptionCase> {
    (
        0u8..3,
        prop::bool::ANY,
        0u8..3,
        0u8..3,
        any::<bool>(),
        any::<i32>(),
        prop::collection::vec(
            any::<char>().prop_filter("body line content", |character| {
                !matches!(character, '\r' | '\n')
            }),
            0..96,
        ),
        prop::collection::vec(
            any::<char>().prop_filter("table cell line content", |character| {
                !matches!(character, '\r' | '\n')
            }),
            0..32,
        ),
        prop::bool::ANY,
        prop::bool::ANY,
        prop::bool::ANY,
    )
        .prop_map(
            |(
                frontmatter_kind,
                crlf,
                opener_whitespace,
                closer_whitespace,
                done,
                estimate,
                paragraph_chars,
                cell_chars,
                trailing_newline,
                replicated,
                id_collision_copy,
            )| {
                let line_ending = if crlf { "\r\n" } else { "\n" };
                let whitespace = |kind| match kind {
                    0 => "",
                    1 => " ",
                    _ => "\t",
                };
                let paragraph: String = paragraph_chars.into_iter().collect();
                let cell: String = cell_chars.into_iter().collect();
                let mut body = format!(
                    "Paragraph: {paragraph}{line_ending}{line_ending}| Key | Value |{line_ending}| --- | --- |{line_ending}| generated | {cell} |{line_ending}{line_ending}**bold** _italic_ `code` [link](https://example.com)"
                );
                if trailing_newline {
                    body.push_str(line_ending);
                }

                let frontmatter = match frontmatter_kind {
                    0 => GeneratedFrontmatter::None,
                    1 => GeneratedFrontmatter::Valid,
                    _ => GeneratedFrontmatter::Malformed,
                };
                if matches!(frontmatter, GeneratedFrontmatter::None) {
                    return GeneratedAdoptionCase {
                        markdown: body,
                        frontmatter,
                        first_line_len: None,
                        line_ending,
                        replicated,
                        id_collision_copy,
                    };
                }

                let opener = format!("---{}{line_ending}", whitespace(opener_whitespace));
                let yaml = if matches!(frontmatter, GeneratedFrontmatter::Valid) {
                    format!(
                        "done: {done}{line_ending}estimate: {estimate}{line_ending}tags: [alpha, beta]{line_ending}nested:{line_ending}  enabled: true{line_ending}"
                    )
                } else {
                    format!("broken: [{line_ending}")
                };
                let closer = format!("---{}", whitespace(closer_whitespace));
                let eof_shape = (opener_whitespace + closer_whitespace) % 3;
                let markdown = match eof_shape {
                    0 => format!("{opener}{yaml}{closer}"),
                    1 => format!("{opener}{yaml}{closer}{line_ending}"),
                    _ => format!(
                        "{opener}{yaml}{closer}{line_ending}{line_ending}{body}"
                    ),
                };
                GeneratedAdoptionCase {
                    first_line_len: Some(opener.len()),
                    markdown,
                    frontmatter,
                    line_ending,
                    replicated,
                    id_collision_copy,
                }
            },
        )
}

fn copied_collection_adoption_sink(
    scratch: &ScratchDir,
    supervisor: &WorkspaceSupervisor,
) -> (PathBuf, StoreCaptureSink) {
    // These cases vary record adoption, not schema creation. Copy only the
    // closed empty schema; each case still opens its own actor and root guard.
    static IMAGE: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    let bytes = IMAGE.get_or_init(|| {
        let scratch = ScratchDir::new().expect("schema scratch");
        let db = dohc_engine_testkit::engine_db_path(&scratch).expect("schema db path");
        let store = EngineStore::open(&db, 1).expect("create empty schema");
        assert!(store.was_freshly_created());
        drop(store);
        assert!(!db.with_file_name("engine.db-wal").exists());
        assert!(!db.with_file_name("engine.db-shm").exists());
        std::fs::read(db).expect("read closed empty schema")
    });
    let db = dohc_engine_testkit::engine_db_path(scratch).expect("case db path");
    assert!(!db.exists(), "a copied case requires a new database");
    std::fs::write(db, bytes).expect("copy empty schema");
    sink_for(scratch, supervisor)
}

#[test]
fn copied_collection_adoption_stores_are_isolated_and_survive_reopen() {
    let first = ScratchDir::new().expect("first scratch");
    let second = ScratchDir::new().expect("second scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (first_db, mut first_sink) = copied_collection_adoption_sink(&first, &supervisor);
    let (second_db, mut second_sink) = copied_collection_adoption_sink(&second, &supervisor);
    assert_eq!(supervisor.actor_count(), 2);
    assert_ne!(
        file_id::get_file_id(&first_db).expect("first physical database"),
        file_id::get_file_id(&second_db).expect("second physical database"),
    );
    for (scratch, db, sink) in [
        (&first, &first_db, &first_sink),
        (&second, &second_db, &second_sink),
    ] {
        assert!(
            sink.captured_root()
                .expect("bound root")
                .still_names(scratch.path())
        );
        let store = EngineStore::open_read_only(db).expect("read empty copied database");
        for table in [
            "shadow_clone",
            "versioned_workspaces",
            "file_objects",
            "ydoc_docs",
            "collection_records",
            "sync_identity",
        ] {
            let count: i64 = store
                .read_with(|conn| {
                    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })
                })
                .expect("count empty case rows");
            assert_eq!(count, 0, "copied {table} must start empty");
        }
    }
    assert!(
        !first_sink
            .captured_root()
            .expect("first root")
            .still_names(second.path())
    );
    let mut expected = Vec::new();
    for (scratch, sink, title) in [
        (&first, &mut first_sink, "First"),
        (&second, &mut second_sink, "Second"),
    ] {
        write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
        write_file(scratch.path(), "tasks/record.md", title.as_bytes());
        ingest(sink, "tasks/collection.yaml").expect("capture schema");
        ingest(sink, "tasks/record.md").expect("capture record");
        sink.reconcile_collections_observed(None)
            .expect("first adoption pass");
        seed_captured_richdoc_lineage(sink, "tasks/record.md");
        sink.reconcile_collections_observed(None)
            .expect("seeded adoption pass");
        expected.push(
            std::fs::read_to_string(scratch.path().join("tasks/record.md")).expect("adopted bytes"),
        );
    }
    let first_id = adopted_record_id(&first_db, "tasks/record.md");
    let second_id = adopted_record_id(&second_db, "tasks/record.md");
    assert_ne!(first_id, second_id);
    assert_eq!(expected[0], format!("---\nid: {first_id}\n---\n\nFirst"));
    assert_eq!(expected[1], format!("---\nid: {second_id}\n---\n\nSecond"));
    drop(first_sink);
    drop(second_sink);
    supervisor.close(&first_db).expect("close first actor");
    supervisor.close(&second_db).expect("close second actor");
    assert_eq!(supervisor.actor_count(), 0);
    for (db, expected) in [(&first_db, &expected[0]), (&second_db, &expected[1])] {
        let reopened = supervisor.open(db, 100).expect("reopen actor");
        assert!(!reopened.store_freshly_created);
        let mut store = EngineStore::open_read_only(db).expect("read reopened case");
        assert_eq!(
            snapshot_from_store(&mut store, "tasks/record.md")
                .expect("durable record")
                .text,
            *expected
        );
        assert_eq!(ydoc_update_count_from_store(&store, "tasks/record.md"), 2);
        drop(store);
        drop(reopened);
        supervisor.close(db).expect("close reopened actor");
    }
}

proptest! {
    // The repository default is 256 cases and honors PROPTEST_CASES.
    #![proptest_config(ProptestConfig::default())]

    #[test]
    fn collection_record_adoption_is_lossless_or_side_effect_free(
        case in collection_adoption_cases()
    ) {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = copied_collection_adoption_sink(&scratch, &supervisor);
        write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
        write_file(scratch.path(), "tasks/generated.md", case.markdown.as_bytes());
        ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
        ingest(&mut sink, "tasks/generated.md").expect("capture generated record");
        let (original_moments, original_updates) = {
            let store = EngineStore::open_read_only(&db).expect("read captured record");
            (
                moment_count_from_store(&store, "tasks/generated.md"),
                ydoc_update_count_from_store(&store, "tasks/generated.md"),
            )
        };

        sink.reconcile_collections_observed(None).expect("first adoption pass");
        if case.expected_adoption("placeholder").is_some() {
            if case.replicated {
                enable_sync_for_collection_test(&db);
            }
            seed_captured_richdoc_lineage(&sink, "tasks/generated.md");
            sink.reconcile_collections_observed(None).expect("seeded adoption pass");
        }

        let original_binding = {
            let store = EngineStore::open_read_only(&db).expect("read adopted binding");
            collection_record_from_store(&store, "tasks/generated.md")
        };
        if case.id_collision_copy
            && let Some((Some(original_id), state)) = original_binding.as_ref()
            && state == "adopted"
        {
            let original = std::fs::read_to_string(
                scratch.path().join("tasks/generated.md"),
            )
            .expect("read adopted generated record");
            std::fs::copy(
                scratch.path().join("tasks/generated.md"),
                scratch.path().join("tasks/generated-copy.md"),
            )
            .expect("copy adopted generated record");
            ingest(&mut sink, "tasks/generated-copy.md").expect("capture generated copy");
            seed_captured_richdoc_lineage(&sink, "tasks/generated-copy.md");
            sink.reconcile_collections_observed(None).expect("adopt generated copy");

            let (copy_id, copy_stored) = {
                let mut store = EngineStore::open_read_only(&db).expect("read adopted copy");
                let (copy_id, state) = collection_record_from_store(&store, "tasks/generated-copy.md")
                    .expect("record binding");
                assert_eq!(state, "adopted");
                let copy_id = copy_id.expect("adopted record id");
                assert!(is_record_id(&copy_id), "WP1 record id format");
                let copy_stored = snapshot_from_store(&mut store, "tasks/generated-copy.md")
                    .expect("generated copy snapshot");
                (copy_id, copy_stored)
            };
            prop_assert_ne!(copy_id.as_str(), original_id.as_str());
            let id_line = format!("id: {original_id}{}", case.line_ending);
            let replacement = format!("id: {copy_id}{}", case.line_ending);
            let expected_copy = original.replacen(&id_line, &replacement, 1);
            prop_assert_ne!(expected_copy.as_str(), original.as_str());
            let copy_disk = std::fs::read_to_string(
                scratch.path().join("tasks/generated-copy.md"),
            )
            .expect("read adopted generated copy");
            prop_assert_eq!(copy_disk.as_str(), expected_copy.as_str());
            prop_assert_eq!(copy_stored.text.as_str(), expected_copy.as_str());
            let original_after_copy =
                std::fs::read_to_string(scratch.path().join("tasks/generated.md"))
                    .expect("reread adopted generated record");
            prop_assert_eq!(original_after_copy.as_str(), original.as_str());
        }

        let disk = std::fs::read(scratch.path().join("tasks/generated.md"))
            .expect("read generated record");
        let (stored, binding, final_moments, final_updates) = {
            let mut store = EngineStore::open_read_only(&db).expect("read adopted record");
            (
                snapshot_from_store(&mut store, "tasks/generated.md").expect("generated snapshot"),
                collection_record_from_store(&store, "tasks/generated.md"),
                moment_count_from_store(&store, "tasks/generated.md"),
                ydoc_update_count_from_store(&store, "tasks/generated.md"),
            )
        };
        drop(sink);
        supervisor.close(&db).expect("close actor");

        match binding {
            Some((Some(record_id), state)) if state == "adopted" => {
                let expected = case.expected_adoption(&record_id).unwrap_or_else(|| {
                    panic!("malformed frontmatter must not acquire a binding")
                });
                prop_assert_eq!(disk.as_slice(), expected.as_bytes());
                prop_assert_eq!(stored.text.as_bytes(), expected.as_bytes());
                prop_assert_eq!(final_moments, original_moments + 1);
                prop_assert_eq!(final_updates, original_updates + 2);
            }
            None => {
                prop_assert!(case.expected_adoption("placeholder").is_none());
                prop_assert_eq!(disk.as_slice(), case.markdown.as_bytes());
                prop_assert_eq!(stored.text.as_bytes(), case.markdown.as_bytes());
                prop_assert_eq!(final_moments, original_moments);
                prop_assert_eq!(final_updates, original_updates);
            }
            third => {
                prop_assert!(false, "forbidden adoption outcome: {third:?}");
            }
        }
    }
}

#[test]
fn collection_adoption_writes_one_engine_id_and_self_write_does_not_loop() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
    write_file(scratch.path(), "tasks/alpha.md", b"Alpha task\n");
    ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
    ingest(&mut sink, "tasks/alpha.md").expect("capture record");
    assert_eq!(moment_count(&db, "tasks/alpha.md"), 1);
    assert_eq!(ydoc_update_count(&db, "tasks/alpha.md"), 0);
    seed_captured_richdoc_lineage(&sink, "tasks/alpha.md");

    assert_eq!(
        sink.reconcile_collections_observed(None)
            .expect("adopt record")
            .changed_paths,
        ["tasks/alpha.md"]
    );
    let record_id = adopted_record_id(&db, "tasks/alpha.md");
    let written = std::fs::read_to_string(scratch.path().join("tasks/alpha.md"))
        .expect("read adopted artifact");
    assert!(written.contains(&record_id));
    assert_eq!(
        snapshot(&db, "tasks/alpha.md")
            .expect("adopted snapshot")
            .text,
        written
    );
    assert_eq!(
        moment_count(&db, "tasks/alpha.md"),
        2,
        "settlement journals the engine-authored projected file moment"
    );
    assert_eq!(ydoc_update_count(&db, "tasks/alpha.md"), 2);
    assert_eq!(engine_ydoc_update_count(&db, "tasks/alpha.md"), 1);
    assert_eq!(
        latest_ydoc_actor_origin(&db, "tasks/alpha.md").as_deref(),
        Some("engine")
    );

    let written_sha = hex_sha256(written.as_bytes());
    assert!(
        sink.self_writes
            .has_pending(WORKSPACE_ID, "tasks/alpha.md", &written_sha),
        "the settle must arm watcher suppression before replacing the file"
    );
    ingest(&mut sink, "tasks/alpha.md").expect("consume self-write observation");
    assert!(
        !sink
            .self_writes
            .has_pending(WORKSPACE_ID, "tasks/alpha.md", &written_sha),
        "watcher suppression is single-shot"
    );
    assert_eq!(moment_count(&db, "tasks/alpha.md"), 2);
    assert_eq!(ydoc_update_count(&db, "tasks/alpha.md"), 2);
    assert_eq!(engine_ydoc_update_count(&db, "tasks/alpha.md"), 1);
    assert!(
        sink.reconcile_collections_observed(None)
            .expect("idempotent reconciliation")
            .changed_paths
            .is_empty()
    );
    assert_eq!(moment_count(&db, "tasks/alpha.md"), 2);
    assert_eq!(ydoc_update_count(&db, "tasks/alpha.md"), 2);
    assert_eq!(engine_ydoc_update_count(&db, "tasks/alpha.md"), 1);

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn deleting_relation_target_writes_back_and_histories_the_engine_drop() {
    const SOURCE_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TARGET_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"name: Tasks\nfields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
    );
    write_file(
        scratch.path(),
        "tasks/source.md",
        format!("---\nid: {SOURCE_ID}\nrelated: {TARGET_ID}\n---\n\nSource\n").as_bytes(),
    );
    write_file(
        scratch.path(),
        "tasks/target.md",
        format!("---\nid: {TARGET_ID}\n---\n\nTarget\n").as_bytes(),
    );
    ingest(&mut sink, "tasks/collection.yaml").expect("capture relation schema");
    ingest(&mut sink, "tasks/source.md").expect("capture referrer");
    ingest(&mut sink, "tasks/target.md").expect("capture target");
    for path in ["tasks/source.md", "tasks/target.md"] {
        seed_captured_richdoc_lineage(&sink, path);
    }
    assert_eq!(
        sink.reconcile_collections_observed(None)
            .expect("adopt indexed relation")
            .changed_paths,
        ["tasks/source.md", "tasks/target.md"]
    );
    assert_eq!(
        relation_edge_count(&db, "tasks/source.md", "related", TARGET_ID),
        1
    );

    std::fs::remove_file(scratch.path().join("tasks/target.md")).expect("delete target");
    sink.retire("tasks/target.md").expect("retire target");
    assert_eq!(
        sink.reconcile_collections_observed(None)
            .expect("drop inbound relation")
            .changed_paths,
        ["tasks/source.md"]
    );
    assert_eq!(
        relation_edge_count(&db, "tasks/source.md", "related", TARGET_ID),
        0
    );
    assert_eq!(
        indexed_collection_field(&db, "tasks/source.md", "related"),
        None
    );
    assert!(
        !std::fs::read_to_string(scratch.path().join("tasks/source.md"))
            .expect("read cleaned referrer")
            .contains("related:"),
        "the relation is removed through the projected frontmatter write"
    );
    assert_eq!(
        latest_field_history(&db, "tasks/source.md", "related"),
        (
            Some(format!("\"{TARGET_ID}\"")),
            None,
            Some("engine".to_owned())
        )
    );
    let relation_history_count = get_record(&db, "tasks", SOURCE_ID)
        .history
        .iter()
        .filter(|entry| entry.field == "related")
        .count();
    assert_eq!(relation_history_count, 1);
    assert_eq!(
        latest_ydoc_actor_origin(&db, "tasks/source.md").as_deref(),
        Some("engine")
    );
    assert_eq!(engine_ydoc_update_count(&db, "tasks/source.md"), 1);

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn relation_cleanup_preserves_source_backed_body_bytes() {
    const TARGET_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    const BODY: &[u8] = concat!(
        "\r\n",
        "| Metric | Value |\r\n",
        "| ------ | ----- |\r\n",
        "| apples | 10    |\r\n",
        "\r\n",
        "- parent\r\n",
        "  - nested with **bold** and [details](https://example.com)"
    )
    .as_bytes();
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"name: Tasks\nfields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
    );
    let mut source = format!("--- \r\nrelated:   {TARGET_ID}\r\n---\t\r\n").into_bytes();
    source.extend_from_slice(BODY);
    write_file(scratch.path(), "tasks/source.md", &source);
    write_file(
        scratch.path(),
        "tasks/target.md",
        format!("---\nid: {TARGET_ID}\n---\n\nTarget\n").as_bytes(),
    );
    for path in [
        "tasks/collection.yaml",
        "tasks/source.md",
        "tasks/target.md",
    ] {
        ingest(&mut sink, path).unwrap_or_else(|_| panic!("capture {path}"));
    }
    for path in ["tasks/source.md", "tasks/target.md"] {
        seed_captured_richdoc_lineage(&sink, path);
    }

    sink.reconcile_collections_observed(None)
        .expect("adopt records");
    let adopted = std::fs::read(scratch.path().join("tasks/source.md"))
        .expect("read source-preserved record");
    assert!(
        adopted.ends_with(BODY),
        "adoption must establish the source-preserved body fixture"
    );
    assert_eq!(
        relation_edge_count(&db, "tasks/source.md", "related", TARGET_ID),
        1
    );

    std::fs::remove_file(scratch.path().join("tasks/target.md")).expect("delete target");
    sink.retire("tasks/target.md").expect("retire target");
    assert_eq!(
        sink.reconcile_collections_observed(None)
            .expect("drop inbound relation")
            .changed_paths,
        ["tasks/source.md"]
    );

    let cleaned =
        std::fs::read(scratch.path().join("tasks/source.md")).expect("read settled referrer");
    assert_ne!(cleaned, adopted, "cleanup must remove the relation field");
    assert!(
        !String::from_utf8(cleaned.clone())
            .expect("rich-document artifact remains UTF-8")
            .contains("related:"),
        "the settled frontmatter must drop the relation"
    );
    assert!(
        cleaned.ends_with(BODY),
        "a frontmatter-only cleanup must keep the source-backed body byte-identical"
    );

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn re_adopting_the_same_file_without_an_id_preserves_identity_history_and_relations() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    let reader = Arc::new(dohc_engine_reader::Reader::new(Some(
        crate::rpc::markdown_recovery::tests::witness_reader(&scratch, "witness-safe"),
    )));
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(sink.actor.configure_reader_resolver(Arc::new(
            dohc_engine_collab::reader_resolver::ReaderResolver::new(reader),
        )))
        .unwrap();
    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"name: Tasks\nfields:\n  title:\n    type: text\n  related:\n    type: relation\n    collection: tasks\n    many: false\n",
    );
    write_file(scratch.path(), "tasks/source.md", b"Source\n");
    write_file(scratch.path(), "tasks/target.md", b"Target\n");
    for path in [
        "tasks/collection.yaml",
        "tasks/source.md",
        "tasks/target.md",
    ] {
        ingest(&mut sink, path).unwrap_or_else(|_| panic!("capture {path}"));
    }
    for path in ["tasks/source.md", "tasks/target.md"] {
        seed_captured_richdoc_lineage(&sink, path);
    }
    sink.reconcile_collections_observed(None)
        .expect("adopt records");
    let source_id = adopted_record_id(&db, "tasks/source.md");
    let target_id = adopted_record_id(&db, "tasks/target.md");

    let adopted_source = std::fs::read_to_string(scratch.path().join("tasks/source.md"))
        .expect("read adopted source");
    let edited_source = adopted_source.replace(
        &format!("id: {source_id}\n---"),
        &format!("id: {source_id}\nrelated: {target_id}\n---"),
    );
    assert_ne!(
        edited_source, adopted_source,
        "the fixture must add the inbound relation"
    );
    write_file(scratch.path(), "tasks/source.md", edited_source.as_bytes());
    let adopted_target = std::fs::read_to_string(scratch.path().join("tasks/target.md"))
        .expect("read adopted target");
    let edited_target = adopted_target.replace(
        &format!("id: {target_id}\n---"),
        &format!("id: {target_id}\ntitle: Edited\n---"),
    );
    assert_ne!(
        edited_target, adopted_target,
        "the fixture must edit the target title"
    );
    write_file(scratch.path(), "tasks/target.md", edited_target.as_bytes());
    ingest(&mut sink, "tasks/source.md").expect("capture inbound relation");
    ingest(&mut sink, "tasks/target.md").expect("capture target edit");
    assert!(
        get_record(&db, "tasks", &target_id)
            .history
            .iter()
            .any(|entry| entry.field == "title"),
        "the fixture must create target history before re-adoption"
    );
    let related_before = query_collection(&db, "tasks", true)
        .records
        .into_iter()
        .find(|record| record.id == source_id)
        .expect("source before re-adoption")
        .values
        .into_iter()
        .find(|value| value.field == "related")
        .expect("inbound relation before re-adoption");
    assert_eq!(
        related_before.resolved_relations[0].record_id, target_id,
        "the fixture must create an inbound relation edge"
    );

    let target_with_id = std::fs::read_to_string(scratch.path().join("tasks/target.md"))
        .expect("read target before stripping id");
    let stripped_target = target_with_id.replace(&format!("id: {target_id}\n"), "");
    assert_ne!(
        stripped_target, target_with_id,
        "the fixture must strip the target id"
    );
    write_file(
        scratch.path(),
        "tasks/target.md",
        stripped_target.as_bytes(),
    );
    ingest(&mut sink, "tasks/target.md").expect("capture stripped record id");
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(sink.actor.reconcile_collections_guarded(
            WORKSPACE_ID.into(),
            VERSION_ID.into(),
            sink.shadow_root.clone(),
            sink.leases.clone(),
            Arc::new(sink.self_writes.clone()),
            sink.now_ms,
            Arc::new(NoFaults),
            CancellationToken::new(),
            sink.root_guard().unwrap(),
        ))
        .expect("re-adopt record after id removal");

    assert_eq!(
        adopted_record_id(&db, "tasks/target.md"),
        target_id,
        "the same file object keeps its bound record id"
    );
    let repaired_target = std::fs::read_to_string(scratch.path().join("tasks/target.md"))
        .expect("read re-adopted target");
    assert!(
        repaired_target.contains(&format!("id: {target_id}\n")),
        "re-adoption must restore the bound id to the artifact"
    );
    assert!(
        get_record(&db, "tasks", &target_id)
            .history
            .iter()
            .any(|entry| entry.field == "title"),
        "the original record history stays addressable"
    );
    let related_after = query_collection(&db, "tasks", true)
        .records
        .into_iter()
        .find(|record| record.id == source_id)
        .expect("source after re-adoption")
        .values
        .into_iter()
        .find(|value| value.field == "related")
        .expect("inbound relation after re-adoption");
    assert_eq!(
        related_after.value,
        serde_json::Value::String(target_id.clone())
    );
    assert_eq!(related_after.resolved_relations[0].record_id, target_id);

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn broken_collection_schema_degrades_and_recovers_without_data_loss() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"name: Tasks\nfields:\n  estimate:\n    type: number\n",
    );
    write_file(
        scratch.path(),
        "tasks/alpha.md",
        b"---\nestimate: nope\n---\n\nAlpha\n",
    );
    ingest(&mut sink, "tasks/collection.yaml").expect("capture valid schema");
    ingest(&mut sink, "tasks/alpha.md").expect("capture record");
    seed_captured_richdoc_lineage(&sink, "tasks/alpha.md");

    assert_eq!(
        sink.reconcile_collections_observed(None)
            .expect("adopt record under valid schema")
            .changed_paths,
        ["tasks/alpha.md"]
    );
    assert_eq!(
        collection_status(&db, "tasks"),
        Some(("valid".to_owned(), "[]".to_owned()))
    );
    let record_id = adopted_record_id(&db, "tasks/alpha.md");
    assert_eq!(moment_count(&db, "tasks/alpha.md"), 2);
    assert_eq!(ydoc_update_count(&db, "tasks/alpha.md"), 2);
    let indexed =
        indexed_collection_field(&db, "tasks/alpha.md", "estimate").expect("estimate indexed");
    assert_eq!(indexed.0, "\"nope\"");
    assert_eq!(indexed.1, "flagged");
    assert!(
        indexed
            .2
            .expect("validation reason before schema degradation")
            .contains("expected-number")
    );
    let valid_record = std::fs::read_to_string(scratch.path().join("tasks/alpha.md"))
        .expect("read adopted record before schema degradation");

    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"fields:\n  title: [\n",
    );
    ingest(&mut sink, "tasks/collection.yaml").expect("capture broken schema");
    assert!(
        sink.reconcile_collections_observed(None)
            .expect("fail-soft collection reconciliation")
            .changed_paths
            .is_empty()
    );
    let (status, reasons) = collection_status(&db, "tasks").expect("collection detected");
    assert_eq!(status, "degraded");
    assert_ne!(reasons, "[]");
    assert_eq!(adopted_record_id(&db, "tasks/alpha.md"), record_id);
    assert_eq!(
        indexed_collection_field(&db, "tasks/alpha.md", "estimate"),
        Some(("\"nope\"".to_owned(), "untyped".to_owned(), None))
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("tasks/alpha.md"))
            .expect("read record while schema is degraded"),
        valid_record
    );

    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"name: Tasks\nfields:\n  estimate:\n    type: number\n",
    );
    ingest(&mut sink, "tasks/collection.yaml").expect("capture repaired schema");
    assert!(
        sink.reconcile_collections_observed(None)
            .expect("recover collection schema")
            .changed_paths
            .is_empty()
    );
    assert_eq!(
        collection_status(&db, "tasks"),
        Some(("valid".to_owned(), "[]".to_owned()))
    );
    assert_eq!(adopted_record_id(&db, "tasks/alpha.md"), record_id);
    let indexed =
        indexed_collection_field(&db, "tasks/alpha.md", "estimate").expect("estimate indexed");
    assert_eq!(indexed.0, "\"nope\"");
    assert_eq!(indexed.1, "flagged");
    assert!(
        indexed
            .2
            .expect("validation reason after schema recovery")
            .contains("expected-number")
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("tasks/alpha.md"))
            .expect("read record after schema recovery"),
        valid_record,
        "schema recovery must not rewrite or drop record data"
    );

    std::fs::remove_file(scratch.path().join("tasks/collection.yaml")).expect("remove schema");
    sink.retire("tasks/collection.yaml").expect("retire schema");
    assert!(
        sink.reconcile_collections_observed(None)
            .expect("remove disappeared collection")
            .changed_paths
            .is_empty()
    );
    assert_eq!(collection_status(&db, "tasks"), None);
    assert_eq!(collection_record(&db, "tasks/alpha.md"), None);

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn disk_writes_to_a_record_claim_once_each_and_body_edits_claim_nothing() {
    use dohc_engine_domain::{AutomationChangeKind, AutomationSubscription, AutomationTrigger};
    const RECORD_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        dohc_engine_domain::subscribe_automation(
            &mut store,
            WORKSPACE_ID,
            &AutomationSubscription {
                automation_id: "collection:tasks#watch".to_owned(),
                prefix: "tasks".to_owned(),
                kinds: vec![
                    AutomationChangeKind::Added,
                    AutomationChangeKind::Changed,
                    AutomationChangeKind::Removed,
                ],
                fields: None,
            },
            1,
            &FilesNoFaults,
        )
        .expect("subscribe");
    }
    let kinds = |sink: &StoreCaptureSink| -> Vec<AutomationChangeKind> {
        sink.take_automation_claims()
            .iter()
            .map(|claim| {
                assert_eq!(claim.record_id.as_deref(), Some(RECORD_ID));
                claim.change.kind
            })
            .collect()
    };
    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"name: Tasks\nfields:\n  status:\n    type: text\n",
    );
    ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
    let record =
        |status: &str, body: &str| format!("---\nid: {RECORD_ID}\nstatus: {status}\n---\n\n{body}");
    write_file(
        scratch.path(),
        "tasks/alpha.md",
        record("todo", "Body").as_bytes(),
    );
    ingest(&mut sink, "tasks/alpha.md").expect("capture new record");
    assert!(kinds(&sink).is_empty(), "an unbound file claims nothing");
    let claims = sink
        .reconcile_collections_observed(None)
        .expect("bind the record")
        .automation_claims;
    assert_eq!(
        claims
            .iter()
            .map(|claim| claim.change.kind)
            .collect::<Vec<_>>(),
        vec![AutomationChangeKind::Added]
    );
    assert!(
        sink.reconcile_collections_observed(None)
            .expect("reconcile again")
            .automation_claims
            .is_empty(),
        "a second pass adds nothing"
    );

    write_file(
        scratch.path(),
        "tasks/alpha.md",
        record("done", "Body").as_bytes(),
    );
    ingest(&mut sink, "tasks/alpha.md").expect("capture a field edit");
    let claims = sink.take_automation_claims();
    assert_eq!(claims.len(), 1, "{claims:?}");
    assert_eq!(claims[0].change.kind, AutomationChangeKind::Changed);
    assert!(matches!(
        claims[0].trigger,
        AutomationTrigger::History { .. }
    ));
    assert_eq!(
        indexed_collection_field(&db, "tasks/alpha.md", "status").map(|(value, _, _)| value),
        Some("\"done\"".to_owned()),
        "capture indexes the edit of a record with no lineage"
    );

    write_file(
        scratch.path(),
        "tasks/alpha.md",
        record("done", "New body").as_bytes(),
    );
    ingest(&mut sink, "tasks/alpha.md").expect("capture a body edit");
    assert!(kinds(&sink).is_empty(), "a body-only edit claims nothing");

    std::fs::remove_file(scratch.path().join("tasks/alpha.md")).expect("delete record");
    sink.retire("tasks/alpha.md").expect("retire record");
    let mut removed = kinds(&sink);
    removed.extend(
        sink.reconcile_collections_observed(None)
            .expect("unbind the record")
            .automation_claims
            .iter()
            .map(|claim| claim.change.kind),
    );
    assert_eq!(removed, vec![AutomationChangeKind::Removed]);

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

/// A record whose Y.Doc lineage holds content folds a disk edit into the
/// lineage, and the fold's field changes claim in the capture transaction.
#[test]
fn a_frontmatter_only_capture_keeps_a_nested_list_in_history_and_the_index() {
    const RECORD_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    let path = "tasks/nested.md";
    let original = format!("---\nid: {RECORD_ID}\nstatus: open\n---\n- parent\n  - child");
    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"name: Tasks\nfields:\n  status:\n    type: text\n",
    );
    write_file(scratch.path(), path, original.as_bytes());
    ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
    ingest(&mut sink, path).expect("capture record");
    seed_captured_richdoc_lineage(&sink, path);
    sink.reconcile_collections_observed(None)
        .expect("adopt nested-list record");
    assert_eq!(adopted_record_id(&db, path), RECORD_ID);
    let connection = rusqlite::Connection::open(&db).unwrap();
    let key = dohc_engine_collab::DocKey::new(
        WORKSPACE_ID,
        VERSION_ID,
        snapshot(&db, path).unwrap().object_id,
    )
    .unwrap();
    let retained = dohc_engine_sync::project_ydoc_with_store(
        &connection,
        &key,
        &dohc_engine_collab::load_doc_in(&connection, &key).unwrap(),
        ContentKind::Richdoc,
    )
    .unwrap()
    .content;
    drop(connection);
    let before = moment_count(&db, path);
    let chosen = original.replace("status: open", "status: done");
    write_file(scratch.path(), path, chosen.as_bytes());
    ingest(&mut sink, path).expect("capture frontmatter-only edit");
    assert_eq!(snapshot(&db, path).unwrap().text, chosen);
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(path)).unwrap(),
        chosen
    );
    assert_eq!(moment_count(&db, path), before + 2);
    assert_eq!(
        indexed_collection_field(&db, path, "status").unwrap().0,
        "\"done\""
    );
    let connection = rusqlite::Connection::open(&db).unwrap();
    let recovery: (String, String, Option<String>) = connection
        .query_row(
            "SELECT before.text,after.text,m.before_latest_moment_id FROM moments m
             JOIN blobs before ON before.sha256=m.before_blob_sha256
             JOIN blobs after ON after.sha256=m.after_blob_sha256
             WHERE m.workspace_id=?1 AND m.path=?2 AND m.metadata_origin='capture-recovery'",
            [WORKSPACE_ID, path],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(recovery, (retained, chosen.clone(), None));
    let key = dohc_engine_collab::DocKey::new(
        WORKSPACE_ID,
        VERSION_ID,
        snapshot(&db, path).unwrap().object_id,
    )
    .unwrap();
    let doc = dohc_engine_collab::load_doc_in(&connection, &key).unwrap();
    assert_eq!(
        dohc_engine_sync::project_ydoc_with_store(&connection, &key, &doc, ContentKind::Richdoc)
            .unwrap()
            .content,
        chosen
    );
    drop(connection);
    drop(sink);
    supervisor.close(&db).expect("close actor");
}
