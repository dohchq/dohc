use super::*;

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
    sink.reconcile_collections().expect("unsupported schema");
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

fn set_richdoc_frontmatter_and_settle(
    sink: &StoreCaptureSink,
    path: &str,
    field: &str,
    value: &str,
) {
    let actor = sink.actor.clone();
    let root_dir = sink.shadow_root.clone();
    let self_writes = Arc::new(sink.self_writes.clone());
    let path = path.to_owned();
    let field = field.to_owned();
    let value = value.to_owned();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("test rich-document edit runtime")
        .block_on(async move {
            let state = actor
                .ydoc_open_state(
                    WORKSPACE_ID.to_owned(),
                    13,
                    false,
                    None,
                    VERSION_ID.to_owned(),
                    path.clone(),
                    Some(ContentKind::Richdoc),
                    CancellationToken::new(),
                )
                .await
                .expect("open existing rich-document fixture");
            assert!(state.lineage_existing, "fixture must already be adopted");
            let doc = Ydoc::wire();
            doc.apply(&state.initial_update)
                .expect("apply existing rich-document state");
            let update = doc.frontmatter_set(&field, &value).unwrap();
            let append = actor
                .ydoc_record_update(
                    state.key.clone(),
                    path.clone(),
                    ContentKind::Richdoc,
                    state.regime,
                    update,
                    None,
                    None,
                    state.lineage_claim_id,
                    false,
                    None,
                    None,
                    14,
                    Arc::new(FilesNoFaults),
                    CancellationToken::new(),
                    None,
                )
                .await
                .expect("record rich-document frontmatter edit");
            actor
                .ydoc_settle(
                    root_dir,
                    state.key,
                    path,
                    ContentKind::Richdoc,
                    append.lineage_claim_id,
                    state.head_blob_sha256,
                    "capture-sink-frontmatter-edit".to_owned(),
                    self_writes,
                    15,
                    Arc::new(FilesNoFaults),
                    CancellationToken::new(),
                    None,
                )
                .await
                .expect("settle rich-document frontmatter edit");
        });
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

fn ydoc_update_count_for_object(db: &Path, path: &str) -> i64 {
    let object_id = snapshot(db, path).expect("Y.Doc object snapshot").object_id;
    let store = EngineStore::open(db, 100).expect("reopen store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM ydoc_updates \
                     WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                [WORKSPACE_ID, VERSION_ID, object_id.as_str()],
                |row| row.get(0),
            )
        })
        .expect("Y.Doc object update count")
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

proptest! {
    // The repository default is 256 cases and honors PROPTEST_CASES.
    #![proptest_config(ProptestConfig::default())]

    #[test]
    fn collection_record_adoption_is_lossless_or_side_effect_free(
        case in collection_adoption_cases()
    ) {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor = WorkspaceSupervisor::new();
        let (db, mut sink) = sink_for(&scratch, &supervisor);
        write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
        write_file(scratch.path(), "tasks/generated.md", case.markdown.as_bytes());
        ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
        ingest(&mut sink, "tasks/generated.md").expect("capture generated record");
        let original_moments = moment_count(&db, "tasks/generated.md");
        let original_updates = ydoc_update_count(&db, "tasks/generated.md");

        sink.reconcile_collections().expect("first adoption pass");
        if case.expected_adoption("placeholder").is_some() {
            if case.replicated {
                enable_sync_for_collection_test(&db);
            }
            seed_captured_richdoc_lineage(&sink, "tasks/generated.md");
            sink.reconcile_collections().expect("seeded adoption pass");
        }

        let original_binding = collection_record(&db, "tasks/generated.md");
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
            sink.reconcile_collections().expect("adopt generated copy");

            let copy_id = adopted_record_id(&db, "tasks/generated-copy.md");
            prop_assert_ne!(copy_id.as_str(), original_id.as_str());
            let id_line = format!("id: {original_id}{}", case.line_ending);
            let replacement = format!("id: {copy_id}{}", case.line_ending);
            let expected_copy = original.replacen(&id_line, &replacement, 1);
            prop_assert_ne!(expected_copy.as_str(), original.as_str());
            let copy_disk = std::fs::read_to_string(
                scratch.path().join("tasks/generated-copy.md"),
            )
            .expect("read adopted generated copy");
            let copy_stored = snapshot(&db, "tasks/generated-copy.md")
                .expect("generated copy snapshot");
            prop_assert_eq!(copy_disk.as_str(), expected_copy.as_str());
            prop_assert_eq!(copy_stored.text.as_str(), expected_copy.as_str());
            let original_after_copy =
                std::fs::read_to_string(scratch.path().join("tasks/generated.md"))
                    .expect("reread adopted generated record");
            prop_assert_eq!(original_after_copy.as_str(), original.as_str());
        }

        let disk = std::fs::read(scratch.path().join("tasks/generated.md"))
            .expect("read generated record");
        let stored = snapshot(&db, "tasks/generated.md").expect("generated snapshot");
        let binding = collection_record(&db, "tasks/generated.md");
        let final_moments = moment_count(&db, "tasks/generated.md");
        let final_updates = ydoc_update_count(&db, "tasks/generated.md");
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
fn frontmatterless_collection_adoption_preserves_leading_blank_lines_and_markdown_bytes() {
    const MARKDOWN: &str = "\n\n| Key | Value |\n| --- | --- |\n| generated |  |\n\n**bold** _italic_ `code` [link](https://example.com)";

    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
    write_file(scratch.path(), "tasks/generated.md", MARKDOWN.as_bytes());
    ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
    ingest(&mut sink, "tasks/generated.md").expect("capture generated record");

    sink.reconcile_collections().expect("first adoption pass");
    seed_captured_richdoc_lineage(&sink, "tasks/generated.md");
    sink.reconcile_collections().expect("seeded adoption pass");

    let (record_id, state) = collection_record(&db, "tasks/generated.md")
        .and_then(|(record_id, state)| record_id.map(|record_id| (record_id, state)))
        .expect("adopted collection record");
    assert_eq!(state, "adopted");
    let expected = format!("---\nid: {record_id}\n---\n\n{MARKDOWN}");
    assert_eq!(
        std::fs::read(scratch.path().join("tasks/generated.md")).expect("read adopted record"),
        expected.as_bytes()
    );
    assert_eq!(
        snapshot(&db, "tasks/generated.md")
            .expect("adopted snapshot")
            .text,
        expected
    );

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn oversized_lossless_collection_adoption_declines_visibly_without_retrying() {
    const RECORD_ID_BYTES: usize = "rec_".len() + 26;
    const INSERTED_FRONTMATTER_BYTES: usize = "---\nid: \n---\n\n".len() + RECORD_ID_BYTES;

    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    let markdown = "x".repeat(MAX_TEXT_BYTES - INSERTED_FRONTMATTER_BYTES);
    write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
    write_file(scratch.path(), "tasks/oversized.md", markdown.as_bytes());
    ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
    ingest(&mut sink, "tasks/oversized.md").expect("capture oversized record");
    sink.reconcile_collections().expect("first adoption pass");
    let canonical_padding = "x".repeat(MAX_TEXT_BYTES - 64);
    // Canonical trailing newlines avoid retaining a second copy of the padding.
    seed_captured_richdoc_lineage_from_markdown(
        &sink,
        "tasks/oversized.md",
        format!("---\npadding: {canonical_padding}\n---\n\n"),
    );
    let moments_before = moment_count(&db, "tasks/oversized.md");
    let updates_before = ydoc_update_count_for_object(&db, "tasks/oversized.md");

    assert!(
        sink.reconcile_collections()
            .expect("decline oversized adoption")
            .is_empty()
    );
    assert_eq!(collection_record(&db, "tasks/oversized.md"), None);
    assert_eq!(
        collection_status(&db, "tasks"),
        Some((
            "degraded".to_owned(),
            "[{\"code\":\"record-too-large-for-adoption\",\"path\":\"tasks/oversized.md\"}]"
                .to_owned(),
        ))
    );
    assert_eq!(
        std::fs::read(scratch.path().join("tasks/oversized.md")).expect("read declined record"),
        markdown.as_bytes()
    );
    assert_eq!(
        snapshot(&db, "tasks/oversized.md")
            .expect("declined record snapshot")
            .text,
        markdown
    );
    assert_eq!(moment_count(&db, "tasks/oversized.md"), moments_before);
    assert_eq!(
        ydoc_update_count_for_object(&db, "tasks/oversized.md"),
        updates_before
    );

    assert!(
        sink.reconcile_collections()
            .expect("repeat declined adoption reconciliation")
            .is_empty()
    );
    assert_eq!(collection_record(&db, "tasks/oversized.md"), None);
    assert_eq!(moment_count(&db, "tasks/oversized.md"), moments_before);
    assert_eq!(
        ydoc_update_count_for_object(&db, "tasks/oversized.md"),
        updates_before
    );

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn oversized_collection_adoption_retries_after_watcher_shrinks_record() {
    const RECORD_ID_BYTES: usize = "rec_".len() + 26;
    const INSERTED_ID_LINE_BYTES: usize = "id: \n".len() + RECORD_ID_BYTES;
    const SHRUNK: &str = "---\ntitle: Small enough now\n---\n";

    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    let wrapper_bytes = "---\npadding: \n---".len();
    let oversized = format!(
        "---\npadding: {}\n---",
        "x".repeat(MAX_TEXT_BYTES - INSERTED_ID_LINE_BYTES + 1 - wrapper_bytes)
    );
    assert_eq!(oversized.len() + INSERTED_ID_LINE_BYTES, MAX_TEXT_BYTES + 1);
    write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
    write_file(scratch.path(), "tasks/oversized.md", oversized.as_bytes());
    ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
    ingest(&mut sink, "tasks/oversized.md").expect("capture oversized record");
    assert!(
        sink.reconcile_collections()
            .expect("bind oversized adoption")
            .is_empty()
    );
    let record_id = collection_record(&db, "tasks/oversized.md")
        .and_then(|(record_id, state)| (state == "pending-lossless").then_some(record_id).flatten())
        .expect("pending oversized adoption");
    let mut connection = Connection::open(&db).expect("open decline connection");
    let transaction = connection.transaction().expect("begin decline transaction");
    decline_oversized_collection_adoption_in_tx(
        &transaction,
        WORKSPACE_ID,
        VERSION_ID,
        "tasks",
        "tasks/oversized.md",
        &record_id,
    )
    .expect("persist oversized decline");
    transaction.commit().expect("commit oversized decline");
    drop(connection);
    assert!(
        sink.reconcile_collections()
            .expect("retain oversized decline")
            .is_empty()
    );
    assert_eq!(collection_record(&db, "tasks/oversized.md"), None);

    write_file(scratch.path(), "tasks/oversized.md", SHRUNK.as_bytes());
    ingest(&mut sink, "tasks/oversized.md").expect("capture watcher shrink");
    assert!(
        sink.reconcile_collections()
            .expect("re-offer repaired adoption")
            .is_empty()
    );
    seed_captured_richdoc_lineage(&sink, "tasks/oversized.md");
    assert_eq!(
        sink.reconcile_collections()
            .expect("retry repaired adoption"),
        ["tasks/oversized.md"]
    );

    let (adopted_record_id, state) = collection_record(&db, "tasks/oversized.md")
        .and_then(|(record_id, state)| record_id.map(|record_id| (record_id, state)))
        .expect("adopted repaired record");
    assert_eq!(state, "adopted");
    assert_eq!(
        collection_status(&db, "tasks"),
        Some(("valid".to_owned(), "[]".to_owned()))
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("tasks/oversized.md"))
            .expect("read adopted repaired record"),
        format!("---\nid: {adopted_record_id}\ntitle: Small enough now\n---\n")
    );

    drop(sink);
    supervisor.close(&db).expect("close actor");
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
        sink.reconcile_collections().expect("adopt record"),
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
        sink.reconcile_collections()
            .expect("idempotent reconciliation")
            .is_empty()
    );
    assert_eq!(moment_count(&db, "tasks/alpha.md"), 2);
    assert_eq!(ydoc_update_count(&db, "tasks/alpha.md"), 2);
    assert_eq!(engine_ydoc_update_count(&db, "tasks/alpha.md"), 1);

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn reserved_collection_schema_is_text_under_the_scanners_unknown_media_type() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");

    assert!(matches!(
        ingest_as(
            &mut sink,
            "tasks/collection.yaml",
            "application/octet-stream"
        )
        .expect("capture reserved collection schema"),
        IngestOutcome::Captured { .. }
    ));

    drop(sink);
    supervisor.close(&db).expect("close actor");
    assert_eq!(
        snapshot(&db, "tasks/collection.yaml")
            .expect("collection schema text snapshot")
            .text,
        "name: Tasks\n"
    );
    assert!(binary_head(&db, "tasks/collection.yaml").is_none());
}

#[test]
fn collection_adoption_seeds_typed_frontmatter_and_multi_relation_edges() {
    const FIRST_TARGET_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SECOND_TARGET_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"name: Tasks\nfields:\n  estimate:\n    type: number\n  done:\n    type: checkbox\n  related:\n    type: relation\n    collection: tasks\n    many: true\n",
    );
    write_file(
        scratch.path(),
        "tasks/alpha.md",
        format!(
            "---\nestimate: 3\ndone: true\nrelated: [{FIRST_TARGET_ID}, {SECOND_TARGET_ID}]\n---\n\nAlpha\n"
        )
        .as_bytes(),
    );
    write_file(
        scratch.path(),
        "tasks/first.md",
        format!("---\nid: {FIRST_TARGET_ID}\n---\n\nFirst\n").as_bytes(),
    );
    write_file(
        scratch.path(),
        "tasks/second.md",
        format!("---\nid: {SECOND_TARGET_ID}\n---\n\nSecond\n").as_bytes(),
    );
    for path in [
        "tasks/collection.yaml",
        "tasks/alpha.md",
        "tasks/first.md",
        "tasks/second.md",
    ] {
        ingest(&mut sink, path).unwrap_or_else(|_| panic!("capture {path}"));
    }
    for path in ["tasks/alpha.md", "tasks/first.md", "tasks/second.md"] {
        seed_captured_richdoc_lineage(&sink, path);
    }

    sink.reconcile_collections().expect("adopt typed record");
    assert_eq!(
        indexed_collection_field(&db, "tasks/alpha.md", "estimate"),
        Some(("3".to_owned(), "valid".to_owned(), None))
    );
    assert_eq!(
        indexed_collection_field(&db, "tasks/alpha.md", "done"),
        Some(("true".to_owned(), "valid".to_owned(), None))
    );
    assert_eq!(
        indexed_collection_field(&db, "tasks/alpha.md", "related"),
        Some((
            format!("[\"{FIRST_TARGET_ID}\",\"{SECOND_TARGET_ID}\"]"),
            "valid".to_owned(),
            None,
        ))
    );
    for target in [FIRST_TARGET_ID, SECOND_TARGET_ID] {
        assert_eq!(
            relation_edge_count(&db, "tasks/alpha.md", "related", target),
            1,
            "adoption must preserve the edge to {target}"
        );
    }

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn imported_collection_record_with_an_existing_id_tracks_later_capture_edits() {
    const RECORD_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"name: Tasks\nfields:\n  status:\n    type: text\n",
    );
    write_file(
        scratch.path(),
        "tasks/imported.md",
        format!("---\nid: {RECORD_ID}\nstatus: todo\n---\n\nImported").as_bytes(),
    );
    ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
    ingest(&mut sink, "tasks/imported.md").expect("capture imported record");
    seed_captured_richdoc_lineage(&sink, "tasks/imported.md");
    sink.reconcile_collections().expect("adopt imported record");
    assert_eq!(adopted_record_id(&db, "tasks/imported.md"), RECORD_ID);

    let adopted = std::fs::read_to_string(scratch.path().join("tasks/imported.md"))
        .expect("read adopted record");
    let edited = adopted.replace("status: todo", "status: done");
    assert_ne!(edited, adopted, "the fixture must edit the status field");
    write_file(scratch.path(), "tasks/imported.md", edited.as_bytes());
    ingest(&mut sink, "tasks/imported.md").expect("capture imported record edit");
    sink.reconcile_collections()
        .expect("reconcile imported record edit");

    let queried = query_collection(&db, "tasks", false);
    let record = queried
        .records
        .iter()
        .find(|record| record.id == RECORD_ID)
        .expect("imported record in collection query");
    let status = record
        .values
        .iter()
        .find(|value| value.field == "status")
        .expect("edited status in collection query");
    assert_eq!(status.value, serde_json::Value::String("done".to_owned()));

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn invalid_collection_value_roundtrips_and_schema_edit_only_revalidates() {
    const RECORD_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    let record = format!("---\nid: {RECORD_ID}\nestimate: nope\n---\n\nTask body\n");
    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"name: Tasks\nfields:\n  estimate:\n    type: number\n",
    );
    write_file(scratch.path(), "tasks/alpha.md", record.as_bytes());
    ingest(&mut sink, "tasks/collection.yaml").expect("capture number schema");
    ingest(&mut sink, "tasks/alpha.md").expect("capture invalid record");

    assert!(
        sink.reconcile_collections()
            .expect("index invalid value")
            .is_empty()
    );
    let indexed =
        indexed_collection_field(&db, "tasks/alpha.md", "estimate").expect("estimate indexed");
    assert_eq!(indexed.0, "\"nope\"");
    assert_eq!(indexed.1, "flagged");
    assert!(
        indexed
            .2
            .expect("validation reason")
            .contains("expected-number")
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("tasks/alpha.md"))
            .expect("read invalid artifact"),
        record,
        "validation must not rewrite the record"
    );

    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"name: Tasks\nfields:\n  estimate:\n    type: text\n",
    );
    ingest(&mut sink, "tasks/collection.yaml").expect("capture text schema");
    assert!(
        sink.reconcile_collections()
            .expect("revalidate existing index")
            .is_empty()
    );
    assert_eq!(
        indexed_collection_field(&db, "tasks/alpha.md", "estimate"),
        Some(("\"nope\"".to_owned(), "valid".to_owned(), None))
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("tasks/alpha.md"))
            .expect("read revalidated artifact"),
        record,
        "schema revalidation must not touch the value or file"
    );

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
        sink.reconcile_collections()
            .expect("adopt indexed relation"),
        ["tasks/source.md", "tasks/target.md"]
    );
    assert_eq!(
        relation_edge_count(&db, "tasks/source.md", "related", TARGET_ID),
        1
    );

    std::fs::remove_file(scratch.path().join("tasks/target.md")).expect("delete target");
    sink.retire("tasks/target.md").expect("retire target");
    assert_eq!(
        sink.reconcile_collections().expect("drop inbound relation"),
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

    sink.reconcile_collections().expect("adopt records");
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
        sink.reconcile_collections().expect("drop inbound relation"),
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
fn changing_relation_target_id_reasserts_the_engine_id_and_keeps_the_edge() {
    const SOURCE_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TARGET_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    const NEW_TARGET_ID: &str = "rec_cccccccccccccccccccccccccc";
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
    sink.reconcile_collections()
        .expect("adopt indexed relation");
    assert_eq!(
        relation_edge_count(&db, "tasks/source.md", "related", TARGET_ID),
        1
    );

    set_richdoc_frontmatter_and_settle(
        &sink,
        "tasks/target.md",
        RECORD_ID_FRONTMATTER_KEY,
        NEW_TARGET_ID,
    );
    let changed = sink
        .reconcile_collections()
        .expect("re-assert the engine-owned target id");

    assert_eq!(
        adopted_record_id(&db, "tasks/target.md"),
        TARGET_ID,
        "the engine-owned id survives the live id rewrite"
    );
    assert!(
        changed.iter().any(|path| path == "tasks/target.md"),
        "the target must settle through the attributed engine write-back"
    );
    assert!(
        std::fs::read_to_string(scratch.path().join("tasks/target.md"))
            .expect("read re-asserted target")
            .contains(&format!("id: {TARGET_ID}")),
        "the write-back restores the engine id in the settled file"
    );
    assert_eq!(
        relation_edge_count(&db, "tasks/source.md", "related", TARGET_ID),
        1,
        "the inbound relation stays valid because its target never departed"
    );
    assert!(
        std::fs::read_to_string(scratch.path().join("tasks/source.md"))
            .expect("read untouched referrer after target id re-assertion")
            .contains(&format!("related: {TARGET_ID}")),
        "the referrer keeps its relation untouched"
    );
    let relation_history_count = get_record(&db, "tasks", SOURCE_ID)
        .history
        .iter()
        .filter(|entry| entry.field == "related")
        .count();
    assert_eq!(
        relation_history_count, 0,
        "no engine-authored relation drop is recorded"
    );
    assert_eq!(
        latest_ydoc_actor_origin(&db, "tasks/target.md").as_deref(),
        Some("engine"),
        "the id write-back is an engine-attributed Y.Doc write"
    );
    assert_eq!(
        engine_ydoc_update_count(&db, "tasks/target.md"),
        1,
        "the id write-back lands exactly one engine Y.Doc update"
    );
    assert!(
        sink.reconcile_collections()
            .expect("idempotent reconciliation after the id write-back")
            .is_empty(),
        "the re-asserted id must not keep settling"
    );
    assert_eq!(
        engine_ydoc_update_count(&db, "tasks/target.md"),
        1,
        "re-running reconciliation must not loop engine updates onto the target"
    );

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn moving_relation_target_out_of_declared_collection_drops_it_once_with_engine_history() {
    const SOURCE_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TARGET_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"name: Tasks\nfields:\n  related:\n    type: relation\n    collection: people\n    many: false\n",
    );
    write_file(scratch.path(), "people/collection.yaml", b"name: People\n");
    write_file(
        scratch.path(),
        "archive/collection.yaml",
        b"name: Archive\n",
    );
    write_file(
        scratch.path(),
        "tasks/source.md",
        format!("---\nid: {SOURCE_ID}\nrelated: {TARGET_ID}\n---\n\nSource\n").as_bytes(),
    );
    write_file(
        scratch.path(),
        "people/target.md",
        format!("---\nid: {TARGET_ID}\n---\n\nTarget\n").as_bytes(),
    );
    for path in [
        "tasks/collection.yaml",
        "people/collection.yaml",
        "archive/collection.yaml",
        "tasks/source.md",
        "people/target.md",
    ] {
        ingest(&mut sink, path).unwrap_or_else(|_| panic!("capture {path}"));
    }
    for path in ["tasks/source.md", "people/target.md"] {
        seed_captured_richdoc_lineage(&sink, path);
    }
    sink.reconcile_collections()
        .expect("adopt cross-collection relation");
    assert_eq!(adopted_record_id(&db, "tasks/source.md"), SOURCE_ID);
    assert_eq!(adopted_record_id(&db, "people/target.md"), TARGET_ID);
    assert_eq!(
        relation_edge_count(&db, "tasks/source.md", "related", TARGET_ID),
        1
    );

    std::fs::rename(
        scratch.path().join("people/target.md"),
        scratch.path().join("archive/target.md"),
    )
    .expect("move target out of declared collection");
    sink.retire("people/target.md")
        .expect("retire target's declared collection path");
    ingest(&mut sink, "archive/target.md").expect("capture moved target");
    seed_captured_richdoc_lineage(&sink, "archive/target.md");
    let changed = sink
        .reconcile_collections()
        .expect("drop relation to moved target");
    assert!(
        changed.iter().any(|path| path == "tasks/source.md"),
        "moving the target out of its declared collection must settle the referrer"
    );
    assert_eq!(adopted_record_id(&db, "archive/target.md"), TARGET_ID);
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
            .expect("read cleaned referrer after target move")
            .contains("related:"),
        "the moved target is removed through the projected frontmatter write"
    );
    assert_eq!(
        latest_field_history(&db, "tasks/source.md", "related"),
        (
            Some(format!("\"{TARGET_ID}\"")),
            None,
            Some("engine".to_owned())
        )
    );
    assert_eq!(
        latest_ydoc_actor_origin(&db, "tasks/source.md").as_deref(),
        Some("engine")
    );
    let relation_history_count = get_record(&db, "tasks", SOURCE_ID)
        .history
        .iter()
        .filter(|entry| entry.field == "related")
        .count();
    assert_eq!(relation_history_count, 1);

    std::fs::rename(
        scratch.path().join("archive/target.md"),
        scratch.path().join("people/target.md"),
    )
    .expect("move target back to declared collection");
    sink.retire("archive/target.md")
        .expect("retire target's archive path");
    ingest(&mut sink, "people/target.md").expect("capture restored target");
    seed_captured_richdoc_lineage(&sink, "people/target.md");
    sink.reconcile_collections()
        .expect("reconcile restored target");
    assert_eq!(adopted_record_id(&db, "people/target.md"), TARGET_ID);
    assert_eq!(
        relation_edge_count(&db, "tasks/source.md", "related", TARGET_ID),
        0,
        "moving the target back must not resurrect the removed relation"
    );
    assert_eq!(
        indexed_collection_field(&db, "tasks/source.md", "related"),
        None
    );
    let relation_history_count = get_record(&db, "tasks", SOURCE_ID)
        .history
        .iter()
        .filter(|entry| entry.field == "related")
        .count();
    assert_eq!(
        relation_history_count, 1,
        "restoring the target must not author another source-field change"
    );

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn copied_source_preserved_collection_record_keeps_bytes_modulo_fresh_id() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
    let source = concat!(
        "--- \r\n",
        "status:   open\r\n",
        "---\t\r\n",
        "\r\n",
        "| Metric | Value |\r\n",
        "| ------ | ----- |\r\n",
        "| apples | 10    |\r\n",
        "\r\n",
        "- parent\r\n",
        "  - nested with **bold** and [details](https://example.com)"
    );
    write_file(scratch.path(), "tasks/original.md", source.as_bytes());
    ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
    ingest(&mut sink, "tasks/original.md").expect("capture original");
    seed_captured_richdoc_lineage(&sink, "tasks/original.md");
    sink.reconcile_collections().expect("adopt original");
    let original_id = adopted_record_id(&db, "tasks/original.md");
    let original = std::fs::read_to_string(scratch.path().join("tasks/original.md"))
        .expect("read adopted original");
    let original_snapshot = snapshot(&db, "tasks/original.md").expect("original snapshot");
    assert_eq!(original_snapshot.text, original);

    std::fs::copy(
        scratch.path().join("tasks/original.md"),
        scratch.path().join("tasks/copy.md"),
    )
    .expect("copy record");
    ingest(&mut sink, "tasks/copy.md").expect("capture copy");
    seed_captured_richdoc_lineage(&sink, "tasks/copy.md");
    assert_eq!(
        sink.reconcile_collections().expect("adopt copy"),
        ["tasks/copy.md"]
    );
    let copy_id = adopted_record_id(&db, "tasks/copy.md");
    assert_ne!(copy_id, original_id);
    assert_eq!(adopted_record_id(&db, "tasks/original.md"), original_id);
    let copy_text =
        std::fs::read_to_string(scratch.path().join("tasks/copy.md")).expect("read copied record");
    let expected = original.replacen(
        &format!("id: {original_id}\r\n"),
        &format!("id: {copy_id}\r\n"),
        1,
    );
    assert_ne!(expected, original, "the expected bytes must replace the id");
    assert_eq!(copy_text, expected);
    assert_eq!(
        snapshot(&db, "tasks/copy.md")
            .expect("copied record snapshot")
            .text,
        expected
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("tasks/original.md"))
            .expect("reread adopted original"),
        original
    );

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn re_adopting_the_same_file_without_an_id_preserves_identity_history_and_relations() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
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
    sink.reconcile_collections().expect("adopt records");
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
    sink.reconcile_collections()
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
        sink.reconcile_collections()
            .expect("adopt record under valid schema"),
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
        sink.reconcile_collections()
            .expect("fail-soft collection reconciliation")
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
        sink.reconcile_collections()
            .expect("recover collection schema")
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
        sink.reconcile_collections()
            .expect("remove disappeared collection")
            .is_empty()
    );
    assert_eq!(collection_status(&db, "tasks"), None);
    assert_eq!(collection_record(&db, "tasks/alpha.md"), None);

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn collection_record_binding_follows_frontmatter_id_across_rename() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
    write_file(scratch.path(), "tasks/before.md", b"Before\n");
    ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
    ingest(&mut sink, "tasks/before.md").expect("capture record");
    seed_captured_richdoc_lineage(&sink, "tasks/before.md");
    sink.reconcile_collections().expect("adopt record");
    let record_id = adopted_record_id(&db, "tasks/before.md");

    std::fs::rename(
        scratch.path().join("tasks/before.md"),
        scratch.path().join("tasks/after.md"),
    )
    .expect("rename record");
    sink.retire("tasks/before.md").expect("retire old path");
    ingest(&mut sink, "tasks/after.md").expect("capture new path");
    seed_captured_richdoc_lineage(&sink, "tasks/after.md");
    let renamed_record = std::fs::read_to_string(scratch.path().join("tasks/after.md"))
        .expect("read renamed record before adoption");
    assert_eq!(
        sink.reconcile_collections().expect("reconcile rename"),
        ["tasks/after.md"],
        "the renamed object settles after the shared rich-document import"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("tasks/after.md"))
            .expect("read adopted renamed record"),
        renamed_record,
        "a rename with a valid id must preserve the artifact byte-for-byte"
    );
    assert_eq!(adopted_record_id(&db, "tasks/after.md"), record_id);
    assert!(collection_record(&db, "tasks/before.md").is_none());

    std::fs::rename(
        scratch.path().join("tasks/after.md"),
        scratch.path().join("outside.md"),
    )
    .expect("move record out");
    sink.retire("tasks/after.md")
        .expect("retire collection path");
    ingest(&mut sink, "outside.md").expect("capture outside file");
    sink.reconcile_collections().expect("reconcile move out");
    assert!(collection_record(&db, "tasks/after.md").is_none());
    assert!(collection_record(&db, "outside.md").is_none());

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

#[test]
fn collection_adoption_waits_for_an_open_file_conflict_to_resolve() {
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(scratch.path(), "tasks/collection.yaml", b"name: Tasks\n");
    write_file(scratch.path(), "tasks/blocked.md", b"Blocked\n");
    ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
    ingest(&mut sink, "tasks/blocked.md").expect("capture record");
    let object_id = snapshot(&db, "tasks/blocked.md")
        .expect("record snapshot")
        .object_id;
    let connection = rusqlite::Connection::open(&db).expect("open conflict connection");
    connection
        .execute(
            "INSERT INTO conflicts (\
                    workspace_id, conflict_id, path, target_version_id, source_version_id, \
                    created_at_ms, updated_at_ms, status, chosen_from, metadata_origin, \
                    base_exists, base_path, current_exists, current_path, current_object_id, \
                    incoming_exists, incoming_path, incoming_object_id\
                 ) VALUES (?1, 'collection-adoption-conflict', ?2, ?3, ?3, \
                    10, 10, 'open', 'current', 'sync', \
                    0, ?2, 1, ?2, ?4, 1, ?2, ?4)",
            rusqlite::params![WORKSPACE_ID, "tasks/blocked.md", VERSION_ID, object_id],
        )
        .expect("insert open conflict");
    drop(connection);

    assert!(
        sink.reconcile_collections()
            .expect("defer conflicted record")
            .is_empty()
    );
    assert_eq!(
        collection_record(&db, "tasks/blocked.md"),
        Some((None, "deferred-conflict-lossless".to_owned()))
    );
    assert_eq!(moment_count(&db, "tasks/blocked.md"), 1);
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("tasks/blocked.md"))
            .expect("read deferred record"),
        "Blocked\n"
    );

    let connection = rusqlite::Connection::open(&db).expect("open resolution connection");
    connection
        .execute(
            "UPDATE conflicts SET status = 'resolved', updated_at_ms = 20 \
                 WHERE workspace_id = ?1 AND conflict_id = 'collection-adoption-conflict'",
            [WORKSPACE_ID],
        )
        .expect("resolve conflict");
    drop(connection);
    assert!(
        sink.reconcile_collections()
            .expect("bind record after conflict resolution")
            .is_empty(),
        "the engine must wait for the shared rich-document importer"
    );
    assert_eq!(
        collection_record(&db, "tasks/blocked.md").map(|(_, state)| state),
        Some("pending-lossless".to_owned())
    );
    seed_captured_richdoc_lineage(&sink, "tasks/blocked.md");
    assert_eq!(
        sink.reconcile_collections()
            .expect("adopt shared-imported record after conflict resolution"),
        ["tasks/blocked.md"]
    );
    adopted_record_id(&db, "tasks/blocked.md");
    assert_eq!(moment_count(&db, "tasks/blocked.md"), 2);
    assert_eq!(ydoc_update_count(&db, "tasks/blocked.md"), 2);

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

/// The path agents use (commitment 5): a record written, edited, and
/// deleted on disk claims on this computer, once per change. The record has
/// no Y.Doc lineage, so capture itself indexes its frontmatter; a body-only
/// edit changes no field and claims nothing.
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
    sink.reconcile_collections().expect("bind the record");
    assert_eq!(kinds(&sink), vec![AutomationChangeKind::Added]);
    sink.reconcile_collections().expect("reconcile again");
    assert!(kinds(&sink).is_empty(), "a second pass adds nothing");

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
    sink.reconcile_collections().expect("unbind the record");
    assert_eq!(kinds(&sink), vec![AutomationChangeKind::Removed]);

    drop(sink);
    supervisor.close(&db).expect("close actor");
}

/// A record whose Y.Doc lineage holds content folds a disk edit into the
/// lineage, and the fold's field changes claim in the capture transaction.
#[test]
fn a_disk_edit_folded_into_a_record_lineage_claims_once() {
    use dohc_engine_domain::{AutomationChangeKind, AutomationSubscription};
    const RECORD_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    let scratch = ScratchDir::new().expect("scratch");
    let supervisor = WorkspaceSupervisor::new();
    let (db, mut sink) = sink_for(&scratch, &supervisor);
    write_file(
        scratch.path(),
        "tasks/collection.yaml",
        b"name: Tasks\nfields:\n  status:\n    type: text\n",
    );
    write_file(
        scratch.path(),
        "tasks/imported.md",
        format!("---\nid: {RECORD_ID}\nstatus: todo\n---\n\nImported").as_bytes(),
    );
    ingest(&mut sink, "tasks/collection.yaml").expect("capture schema");
    ingest(&mut sink, "tasks/imported.md").expect("capture record");
    seed_captured_richdoc_lineage(&sink, "tasks/imported.md");
    sink.reconcile_collections().expect("adopt record");
    assert_eq!(adopted_record_id(&db, "tasks/imported.md"), RECORD_ID);
    {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        dohc_engine_domain::subscribe_automation(
            &mut store,
            WORKSPACE_ID,
            &AutomationSubscription {
                automation_id: "collection:tasks#status".to_owned(),
                prefix: "tasks".to_owned(),
                kinds: vec![AutomationChangeKind::Changed],
                fields: Some(vec!["status".to_owned()]),
            },
            1,
            &FilesNoFaults,
        )
        .expect("subscribe");
    }
    sink.take_automation_claims();

    let adopted = std::fs::read_to_string(scratch.path().join("tasks/imported.md"))
        .expect("read adopted record");
    write_file(
        scratch.path(),
        "tasks/imported.md",
        adopted.replace("status: todo", "status: done").as_bytes(),
    );
    ingest(&mut sink, "tasks/imported.md").expect("capture the edit");
    let claims = sink.take_automation_claims();
    assert_eq!(claims.len(), 1, "{claims:?}");
    assert_eq!(claims[0].automation_id, "collection:tasks#status");
    assert_eq!(claims[0].change.kind, AutomationChangeKind::Changed);
    assert!(
        ydoc_update_count(&db, "tasks/imported.md") > 0,
        "the edit folded into the record's lineage"
    );

    drop(sink);
    supervisor.close(&db).expect("close actor");
}
