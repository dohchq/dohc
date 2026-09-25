use std::collections::{BTreeMap, BTreeSet};

use dohc_engine_domain::collections::markdown_frontmatter_json_with_provenance;
use dohc_engine_domain::{
    CollectionFilter, CollectionFilterOperator, CollectionIndexedValueValidation,
    CollectionPendingAdoptionCursor, CollectionQuery, CollectionSchemaReasonCode,
    CollectionSchemaStatus, CollectionSort, DeleteTextFile, DomainError, FieldDefinition,
    MAX_COLLECTION_HISTORY_LIMIT, MAX_COLLECTION_QUERY_LIMIT, MAX_COLLECTION_QUERY_SORTS, NoFaults,
    RenameTextFile, TxnOutcome, VersionedTextStore, ViewSortDirection, WriteText,
    collection_record_markdown_with_id, get_collection, get_collection_record,
    index_collection_frontmatter_apply_in_tx, index_collection_record_text_in_tx, list_collections,
    list_pending_collection_adoptions, parse_collection_schema, query_collection_records,
    reconcile_collections_in_tx, set_collection_adoption_state_in_tx,
    synchronize_collection_frontmatter_index_in_tx,
};
use dohc_engine_storage::{EngineStore, StorageError, hex};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use rusqlite::params;
use serde::Deserialize;
use serde_json::json;

const WORKSPACE_ID: &str = "collection-query-workspace";
const VERSION_ID: &str = "main";
const PERSON_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECOND_PERSON_ID: &str = "rec_eeeeeeeeeeeeeeeeeeeeeeeeee";
const FIRST_TASK_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const SECOND_TASK_ID: &str = "rec_cccccccccccccccccccccccccc";
const DEGRADED_RECORD_ID: &str = "rec_dddddddddddddddddddddddddd";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldPipelineFixture {
    version: u8,
    collection_path: String,
    schema_yaml: String,
    record_markdown: String,
    support_files: Vec<FieldPipelineSupportFile>,
    vectors: Vec<FieldPipelineVector>,
}

#[derive(Deserialize)]
struct FieldPipelineSupportFile {
    path: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldPipelineVector {
    name: String,
    class: String,
    field_name: String,
    field: FieldDefinition,
    value_yaml: String,
    value_yaml_utf8_hex: String,
    expected_index_json: String,
    expected_validation: serde_json::Value,
    expected_wire_json: String,
}

fn write_text(
    store: &mut EngineStore,
    path: &str,
    text: &str,
    sequence: i64,
) -> Result<(), DomainError> {
    write_text_for_object(
        store,
        path,
        text,
        &format!("object-{sequence}"),
        &format!("moment-{sequence}"),
        sequence,
    )
}

fn write_text_for_object(
    store: &mut EngineStore,
    path: &str,
    text: &str,
    object_id: &str,
    moment_id: &str,
    now_ms: i64,
) -> Result<(), DomainError> {
    VersionedTextStore::new(store).write_text(
        &WriteText {
            workspace_id: WORKSPACE_ID.to_owned(),
            version_id: VERSION_ID.to_owned(),
            object_id: object_id.to_owned(),
            path: path.to_owned(),
            text: text.to_owned(),
            moment_id: moment_id.to_owned(),
            metadata_origin: "test".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms,
            request_id: None,
        },
        &NoFaults,
    )?;
    Ok(())
}

fn fresh_store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, VERSION_ID, 1, &NoFaults)
        .expect("main version");
    (scratch, store)
}

#[test]
fn reconcile_does_not_load_unrelated_large_text_snapshot() {
    let (_scratch, mut store) = fresh_store();
    write_text(&mut store, "tasks/collection.yaml", "name: Tasks\n", 2).expect("task schema");
    write_text(&mut store, "tasks/alpha.md", "Alpha task\n", 3).expect("task record");
    write_text(
        &mut store,
        "notes/unrelated.txt",
        &"x".repeat(1024 * 1024),
        4,
    )
    .expect("large unrelated text");

    let poisoned = store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "UPDATE blobs SET text=CAST(x'80' || CAST(substr(text,2) AS BLOB) AS TEXT) \
                 WHERE sha256=(SELECT blob_sha256 FROM snapshots \
                   WHERE workspace_id=?1 AND version_id=?2 AND path='notes/unrelated.txt')",
                params![WORKSPACE_ID, VERSION_ID],
            )
            .map_err(StorageError::persist_public)?;
            Ok(())
        })
        .expect("poison unrelated text body");
    assert!(matches!(poisoned, TxnOutcome::Committed(())));

    // rusqlite rejects the sentinel as UTF-8 if reconciliation selects this
    // body. A successful pass proves the collection query never hydrates it.
    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile without loading unrelated text");
    let TxnOutcome::Committed(reconciled) = reconciled else {
        panic!("collection reconciliation crashed");
    };
    assert_eq!(
        reconciled
            .adoptions
            .iter()
            .map(|candidate| candidate.file_path.as_str())
            .collect::<Vec<_>>(),
        ["tasks/alpha.md"]
    );
}

fn seeded_store() -> (ScratchDir, EngineStore) {
    let (scratch, mut store) = fresh_store();

    write_text(
        &mut store,
        "people/collection.yaml",
        "fields:\n  Title:\n    type: text\n  title:\n    type: text\n  Notes:\n    type: text\n",
        2,
    )
    .expect("people schema");
    write_text(
        &mut store,
        "people/alice.md",
        &format!("---\nid: {PERSON_ID}\nTitle: Wrong case\ntitle: Alice\n---\n"),
        3,
    )
    .expect("person record");
    write_text(
        &mut store,
        "people/bob.MD",
        &format!("---\nid: {SECOND_PERSON_ID}\nNotes: Not a title\n---\n"),
        4,
    )
    .expect("second person record");
    write_text(
        &mut store,
        "tasks/collection.yaml",
        "fields:\n  Title:\n    type: text\n  Status:\n    type: select\n    options: [Todo, Done]\n  Rank:\n    type: number\n  Owner:\n    type: relation\n    collection: people\n    many: false\n",
        5,
    )
    .expect("task schema");
    write_text(
        &mut store,
        "tasks/alpha.md",
        &format!(
            "---\nid: {FIRST_TASK_ID}\nTitle: Alpha\nStatus: Broken\nRank: 1\nOwner: {PERSON_ID}\n---\n"
        ),
        6,
    )
    .expect("first task");
    write_text(
        &mut store,
        "tasks/beta.md",
        &format!(
            "---\nid: {SECOND_TASK_ID}\nTitle: Beta\nStatus: Todo\nRank: 1\nOwner: {SECOND_PERSON_ID}\n---\n"
        ),
        7,
    )
    .expect("second task");
    write_text(&mut store, "broken/collection.yaml", "fields: [", 8).expect("broken schema");
    write_text(
        &mut store,
        "broken/record.md",
        &format!("---\nid: {DEGRADED_RECORD_ID}\nRaw: survives\n---\n"),
        9,
    )
    .expect("degraded record");

    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile collections");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));
    (scratch, store)
}

#[test]
fn duplicate_frontmatter_key_vectors_are_rejected_like_the_ydoc_projection() {
    let (_scratch, mut store) = fresh_store();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/collection-frontmatter.json"))
            .expect("frontmatter fixture parses");
    let vectors = fixture["vectors"]
        .as_array()
        .expect("frontmatter vectors")
        .iter()
        .filter(|vector| {
            vector["name"]
                .as_str()
                .is_some_and(|name| name.starts_with("duplicate-"))
        })
        .collect::<Vec<_>>();
    assert!(
        vectors.len() > 1,
        "the duplicate-key matrix must stay plural"
    );
    write_text(&mut store, "tasks/collection.yaml", "name: Tasks\n", 2).expect("task schema");
    for (index, vector) in vectors.iter().enumerate() {
        assert_eq!(vector["expected"], serde_json::Value::Null);
        let markdown = vector["markdown"].as_str().expect("duplicate-key markdown");
        write_text(
            &mut store,
            &format!("tasks/duplicate-{index}.md"),
            markdown,
            i64::try_from(index).expect("small vector index") + 3,
        )
        .expect("duplicate-key record");
    }

    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile duplicate-key records");
    let TxnOutcome::Committed(reconciled) = reconciled else {
        panic!("duplicate-key reconciliation crashed");
    };

    assert!(reconciled.adoptions.is_empty());
    let binding_count = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM collection_records \
                 WHERE workspace_id=?1 AND version_id=?2 AND file_path LIKE 'tasks/duplicate-%'",
                params![WORKSPACE_ID, VERSION_ID],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("count duplicate-key bindings");
    assert_eq!(binding_count, 0);
}

#[test]
fn shared_collection_field_pipeline_vectors_index_and_query_exactly() {
    let fixture: FieldPipelineFixture =
        serde_json::from_str(include_str!("fixtures/collection-field-pipeline.json"))
            .expect("field pipeline fixture parses");
    assert_eq!(fixture.version, 1);
    assert_eq!(fixture.collection_path, "pipeline");

    let mut types_by_class = BTreeMap::<String, BTreeSet<String>>::new();
    for vector in &fixture.vectors {
        let field_json = serde_json::to_value(&vector.field).expect("serialize field definition");
        let field_type = field_json["type"].as_str().expect("field type");
        types_by_class
            .entry(field_type.to_owned())
            .or_default()
            .insert(vector.class.clone());
        assert_eq!(vector.field.name(), vector.field_name, "{}", vector.name);
        assert_eq!(
            hex(vector.value_yaml.as_bytes()),
            vector.value_yaml_utf8_hex,
            "{} source bytes",
            vector.name
        );
        serde_json::from_str::<serde_json::Value>(&vector.expected_wire_json)
            .unwrap_or_else(|error| panic!("{} wire JSON: {error}", vector.name));
    }
    assert_eq!(
        types_by_class
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "checkbox",
            "date",
            "multi-select",
            "number",
            "person",
            "relation",
            "select",
            "text",
            "url",
        ]
    );
    for (field_type, classes) in &types_by_class {
        assert_eq!(
            classes,
            &BTreeSet::from([
                "edge".to_owned(),
                "flagged".to_owned(),
                "typical".to_owned()
            ]),
            "{field_type} coverage"
        );
    }

    let (_scratch, mut store) = fresh_store();
    write_text(
        &mut store,
        "pipeline/collection.yaml",
        &fixture.schema_yaml,
        2,
    )
    .expect("pipeline schema");
    let mut sequence = 3;
    for support in &fixture.support_files {
        write_text(&mut store, &support.path, &support.text, sequence)
            .expect("pipeline support file");
        sequence += 1;
    }
    let record =
        fixture
            .record_markdown
            .replacen("---\n", &format!("---\nid: {FIRST_TASK_ID}\n"), 1);
    write_text(&mut store, "pipeline/imported.md", &record, sequence).expect("pipeline record");
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile field pipeline");

    let indexed = store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT field_name,value_json,validation_status,validation_reason_json \
                 FROM collection_record_fields \
                 WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3",
            )?;
            let rows =
                statement.query_map(params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        (
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ),
                    ))
                })?;
            rows.collect::<Result<BTreeMap<_, _>, _>>()
        })
        .expect("read exact indexed pipeline bytes");
    assert_eq!(indexed.len(), fixture.vectors.len());
    for vector in &fixture.vectors {
        let (value_json, status, reason_json) = indexed
            .get(&vector.field_name)
            .unwrap_or_else(|| panic!("missing indexed vector {}", vector.name));
        assert_eq!(value_json, &vector.expected_index_json, "{}", vector.name);
        assert_eq!(
            status,
            vector.expected_validation["status"]
                .as_str()
                .expect("validation status"),
            "{}",
            vector.name
        );
        let expected_reason = vector
            .expected_validation
            .get("reason")
            .map(serde_json::Value::to_string);
        assert_eq!(reason_json, &expected_reason, "{}", vector.name);
    }

    let result = store
        .read_with(|conn| {
            query_collection_records(conn, WORKSPACE_ID, "pipeline", &CollectionQuery::default())
        })
        .expect("query field pipeline")
        .expect("pipeline collection");
    let record = result.records.first().expect("pipeline record");
    let queried = record
        .values
        .iter()
        .map(|field| (field.field.clone(), field))
        .collect::<BTreeMap<_, _>>();
    for vector in &fixture.vectors {
        let field = queried
            .get(&vector.field_name)
            .unwrap_or_else(|| panic!("missing queried vector {}", vector.name));
        assert_eq!(
            field.value,
            serde_json::from_str::<serde_json::Value>(&vector.expected_index_json)
                .expect("expected indexed JSON"),
            "{}",
            vector.name
        );
        assert_eq!(
            serde_json::to_value(&field.validation).expect("serialize query validation"),
            vector.expected_validation,
            "{}",
            vector.name
        );
    }
    let relation_edges = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM collection_relation_edges \
                 WHERE workspace_id=?1 AND version_id=?2 AND source_record_id=?3",
                params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("count pipeline relation edges");
    assert_eq!(relation_edges, 3);
}

#[test]
fn numeric_equality_uses_one_rule_across_every_collection_surface() {
    const FLOAT_TASK_ID: &str = "rec_dddddddddddddddddddddddddd";
    const INTEGER_TASK_ID: &str = "rec_ffffffffffffffffffffffffff";
    let (_scratch, mut store) = fresh_store();
    write_text(
        &mut store,
        "people/collection.yaml",
        "fields:\n  title:\n    type: text\n",
        2,
    )
    .expect("people schema");
    write_text(
        &mut store,
        "people/alice.md",
        &format!("---\nid: {PERSON_ID}\ntitle: Alice\n---\n"),
        3,
    )
    .expect("relation target");
    write_text(
        &mut store,
        "tasks/collection.yaml",
        "fields:\n  priority:\n    type: number\n  bag:\n    type: text\n  owner:\n    type: relation\n    collection: people\n    many: false\n",
        4,
    )
    .expect("task schema");
    for (path, id, priority, bag, sequence) in [
        ("tasks/alpha.md", FIRST_TASK_ID, "1.0", "[1.0]", 5),
        ("tasks/beta.md", SECOND_TASK_ID, "1", "[2]", 6),
        (
            "tasks/float.md",
            FLOAT_TASK_ID,
            "9007199254740992.0",
            "[3]",
            7,
        ),
        (
            "tasks/integer.md",
            INTEGER_TASK_ID,
            "9007199254740993",
            "[4]",
            8,
        ),
    ] {
        write_text(
            &mut store,
            path,
            &format!("---\nid: {id}\npriority: {priority}\nbag: {bag}\nowner: {PERSON_ID}\n---\n"),
            sequence,
        )
        .expect("numeric task record");
    }
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile numeric task records");

    for (name, filter, expected_ids) in [
        (
            "scalar equals",
            CollectionFilter {
                field: "priority".to_owned(),
                operator: CollectionFilterOperator::Equals,
                value: json!(1),
            },
            vec![FIRST_TASK_ID, SECOND_TASK_ID],
        ),
        (
            "array contains",
            CollectionFilter {
                field: "bag".to_owned(),
                operator: CollectionFilterOperator::Contains,
                value: json!(1),
            },
            vec![FIRST_TASK_ID],
        ),
        (
            "unsafe integer remains distinct from adjacent float",
            CollectionFilter {
                field: "priority".to_owned(),
                operator: CollectionFilterOperator::Equals,
                value: json!(9_007_199_254_740_993_i64),
            },
            vec![INTEGER_TASK_ID],
        ),
    ] {
        let result = store
            .read_with(|conn| {
                query_collection_records(
                    conn,
                    WORKSPACE_ID,
                    "tasks",
                    &CollectionQuery {
                        filter: Some(filter.clone()),
                        ..CollectionQuery::default()
                    },
                )
            })
            .unwrap_or_else(|error| panic!("{name} query failed: {error}"))
            .expect("tasks collection");
        assert_eq!(
            result
                .records
                .iter()
                .map(|record| record.id.as_str())
                .collect::<Vec<_>>(),
            expected_ids,
            "{name}"
        );
    }

    let sorted_and_grouped = store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "tasks",
                &CollectionQuery {
                    sort: vec![CollectionSort {
                        field: "priority".to_owned(),
                        direction: ViewSortDirection::Asc,
                    }],
                    group_by: Some("priority".to_owned()),
                    resolve_relations: true,
                    ..CollectionQuery::default()
                },
            )
        })
        .expect("numeric sort/group query")
        .expect("tasks collection");
    assert_eq!(
        sorted_and_grouped
            .records
            .iter()
            .map(|record| record.id.as_str())
            .collect::<Vec<_>>(),
        [
            FIRST_TASK_ID,
            SECOND_TASK_ID,
            FLOAT_TASK_ID,
            INTEGER_TASK_ID,
        ]
    );
    let groups = sorted_and_grouped.groups.expect("priority groups");
    assert_eq!(groups.len(), 3);
    assert_eq!(groups[0].value, json!(1.0));
    assert_eq!(
        groups[0]
            .records
            .iter()
            .map(|record| record.id.as_str())
            .collect::<Vec<_>>(),
        [FIRST_TASK_ID, SECOND_TASK_ID]
    );
    let alpha = groups[0]
        .records
        .iter()
        .find(|record| record.id == FIRST_TASK_ID)
        .expect("alpha group member");
    let owner = alpha
        .values
        .iter()
        .find(|value| value.field == "owner")
        .expect("relation value");
    assert_eq!(owner.resolved_relations[0].label, "Alice");

    let first_page = store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "tasks",
                &CollectionQuery {
                    sort: vec![CollectionSort {
                        field: "priority".to_owned(),
                        direction: ViewSortDirection::Asc,
                    }],
                    limit: 1,
                    ..CollectionQuery::default()
                },
            )
        })
        .expect("first numeric cursor page")
        .expect("tasks collection");
    assert_eq!(first_page.records[0].id, FIRST_TASK_ID);
    let second_page = store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "tasks",
                &CollectionQuery {
                    sort: vec![CollectionSort {
                        field: "priority".to_owned(),
                        direction: ViewSortDirection::Asc,
                    }],
                    cursor: first_page.next_cursor.clone(),
                    limit: 1,
                    ..CollectionQuery::default()
                },
            )
        })
        .expect("second numeric cursor page")
        .expect("tasks collection");
    assert_eq!(second_page.records[0].id, SECOND_TASK_ID);

    let float_frontmatter = json!({
        "id": FIRST_TASK_ID,
        "priority": 1.0,
        "bag": [1.0],
        "owner": PERSON_ID,
    });
    let integer_frontmatter = json!({
        "id": FIRST_TASK_ID,
        "priority": 1,
        "bag": [1],
        "owner": PERSON_ID,
    });
    let deduplicated = store
        .write_with(&NoFaults, |tx| {
            let writes_before = tx.total_changes();
            let _ = index_collection_frontmatter_apply_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "object-5",
                &float_frontmatter,
                &integer_frontmatter,
                &float_frontmatter,
                &integer_frontmatter,
                None,
                Some("editor"),
                None,
                None,
                10,
            )?;
            Ok::<_, DomainError>(tx.total_changes() - writes_before)
        })
        .expect("deduplicate numeric-kind-only apply");
    assert!(matches!(deduplicated, TxnOutcome::Committed(0)));

    let changed_frontmatter = json!({
        "id": FIRST_TASK_ID,
        "priority": 2,
        "bag": [1],
        "owner": PERSON_ID,
    });
    store
        .write_with(&NoFaults, |tx| {
            index_collection_frontmatter_apply_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "object-5",
                &integer_frontmatter,
                &changed_frontmatter,
                &integer_frontmatter,
                &changed_frontmatter,
                None,
                Some("editor"),
                None,
                None,
                11,
            )
        })
        .expect("apply genuinely different number");
    let details = store
        .read_with(|conn| {
            get_collection_record(conn, WORKSPACE_ID, "tasks", FIRST_TASK_ID, 10, None)
        })
        .expect("load numeric history")
        .expect("alpha details");
    assert_eq!(details.history.len(), 1);
    assert_eq!(details.history[0].field, "priority");
    assert_eq!(details.history[0].previous.value, Some(json!(1)));
    assert_eq!(details.history[0].next.value, Some(json!(2)));
    let bag = details
        .record
        .values
        .iter()
        .find(|value| value.field == "bag")
        .expect("preserved flagged value");
    assert!(matches!(
        bag.validation,
        CollectionIndexedValueValidation::Flagged { .. }
    ));
}

#[test]
fn body_only_collection_apply_does_not_rewrite_index_or_history() {
    let (_scratch, mut store) = seeded_store();
    let frontmatter = json!({
        "id": FIRST_TASK_ID,
        "Title": "Alpha",
        "Status": "Broken",
        "Rank": 1,
        "Owner": PERSON_ID,
    });

    let outcome = store
        .write_with(&NoFaults, |tx| {
            let writes_before = tx.total_changes();
            let _ = index_collection_frontmatter_apply_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "object-6",
                &frontmatter,
                &frontmatter,
                &frontmatter,
                &frontmatter,
                None,
                Some("editor"),
                None,
                None,
                10,
            )?;
            Ok::<_, DomainError>(tx.total_changes() - writes_before)
        })
        .expect("apply body-only collection update");
    let TxnOutcome::Committed(index_writes) = outcome else {
        panic!("body-only collection update crashed");
    };
    assert_eq!(
        index_writes, 0,
        "unchanged frontmatter must not rewrite the index"
    );

    let history_count = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM collection_field_history \
                 WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3",
                params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("count body-only field history");
    assert_eq!(history_count, 0, "a body-only update has no field history");
}

#[test]
fn multi_field_history_order_matches_across_independent_stores() {
    const FIELDS: [&str; 12] = [
        "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india",
        "juliet", "kilo", "lima",
    ];

    fn apply_same_update() -> Vec<String> {
        let (_scratch, mut store) = fresh_store();
        let schema = FIELDS
            .iter()
            .map(|field| format!("  {field}:\n    type: text\n"))
            .collect::<String>();
        write_text(
            &mut store,
            "tasks/collection.yaml",
            &format!("fields:\n{schema}"),
            2,
        )
        .expect("multi-field schema");
        let fields = FIELDS
            .iter()
            .map(|field| format!("{field}: before\n"))
            .collect::<String>();
        write_text(
            &mut store,
            "tasks/record.md",
            &format!("---\nid: {FIRST_TASK_ID}\n{fields}---\n"),
            3,
        )
        .expect("multi-field record");
        let reconciled = store
            .write_with(&NoFaults, |tx| {
                reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
            })
            .expect("reconcile multi-field record");
        assert!(matches!(reconciled, TxnOutcome::Committed(_)));

        let mut before = serde_json::Map::new();
        before.insert("id".to_owned(), json!(FIRST_TASK_ID));
        let mut after = before.clone();
        for field in FIELDS {
            before.insert(field.to_owned(), json!("before"));
            after.insert(field.to_owned(), json!("after"));
        }
        let before = serde_json::Value::Object(before);
        let after = serde_json::Value::Object(after);
        let updated = store
            .write_with(&NoFaults, |tx| {
                index_collection_frontmatter_apply_in_tx(
                    tx,
                    WORKSPACE_ID,
                    VERSION_ID,
                    "object-3",
                    &before,
                    &after,
                    &before,
                    &after,
                    None,
                    Some("editor"),
                    None,
                    None,
                    4,
                )
            })
            .expect("apply multi-field update");
        assert!(matches!(updated, TxnOutcome::Committed(Some(_))));

        store
            .read_with(|conn| {
                get_collection_record(
                    conn,
                    WORKSPACE_ID,
                    "tasks",
                    FIRST_TASK_ID,
                    FIELDS.len(),
                    None,
                )
            })
            .expect("get multi-field record")
            .expect("multi-field record exists")
            .history
            .into_iter()
            .map(|entry| entry.field)
            .collect()
    }

    let first = apply_same_update();
    let second = apply_same_update();
    let expected = FIELDS
        .iter()
        .rev()
        .map(|field| (*field).to_owned())
        .collect::<Vec<_>>();
    assert_eq!(first, expected);
    assert_eq!(second, expected);
    assert_eq!(first, second);
}

#[test]
fn reconcile_indexes_fields_added_after_frontmatterless_record_adoption() {
    let (_scratch, mut store) = fresh_store();
    write_text(
        &mut store,
        "tasks/collection.yaml",
        "fields:\n  done:\n    type: checkbox\n  priority:\n    type: number\n  status:\n    type: text\n",
        2,
    )
    .expect("task schema");
    write_text_for_object(
        &mut store,
        "tasks/alpha.md",
        "Alpha task\n",
        "repaired-record-object",
        "frontmatterless-record",
        3,
    )
    .expect("frontmatterless record");

    let first_reconcile = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile frontmatterless record");
    let TxnOutcome::Committed(first_reconcile) = first_reconcile else {
        panic!("frontmatterless reconciliation did not commit");
    };
    let adoption = first_reconcile
        .adoptions
        .first()
        .expect("frontmatterless record adoption");
    let record_id = adoption.record_id.clone();

    write_text_for_object(
        &mut store,
        "tasks/alpha.md",
        &format!("---\nid: {record_id}\n---\n\nAlpha task\n"),
        "repaired-record-object",
        "adopted-record",
        4,
    )
    .expect("adopted record artifact");
    let adoption_applied = store
        .write_with(&NoFaults, |tx| {
            synchronize_collection_frontmatter_index_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "repaired-record-object",
                &json!({ "id": record_id }),
            )?;
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "tasks/alpha.md",
                &record_id,
                "adopted",
            )
        })
        .expect("apply record adoption");
    assert!(matches!(adoption_applied, TxnOutcome::Committed(())));

    write_text_for_object(
        &mut store,
        "tasks/alpha.md",
        &format!(
            "---\nid: {record_id}\ndone: true\npriority: 8\nstatus: repaired\n---\n\nAlpha task\n"
        ),
        "repaired-record-object",
        "repaired-record",
        5,
    )
    .expect("repaired record artifact");
    let repaired = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile repaired record");
    assert!(matches!(repaired, TxnOutcome::Committed(_)));

    let query = store
        .read_with(|conn| {
            query_collection_records(conn, WORKSPACE_ID, "tasks", &CollectionQuery::default())
        })
        .expect("query repaired record")
        .expect("tasks collection");
    assert_eq!(query.records.len(), 1);
    let record = &query.records[0];
    assert_eq!(record.id, record_id);
    for (field, expected) in [
        ("done", json!(true)),
        ("priority", json!(8)),
        ("status", json!("repaired")),
    ] {
        let value = record
            .values
            .iter()
            .find(|value| value.field == field)
            .unwrap_or_else(|| panic!("missing indexed field {field}"));
        assert_eq!(value.value, expected, "typed value for {field}");
        assert_eq!(
            value.validation,
            CollectionIndexedValueValidation::Valid,
            "validation for {field}"
        );
    }
}

#[test]
fn reconcile_clears_unsupported_tag_flag_after_tag_is_removed() {
    let (_scratch, mut store) = fresh_store();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/collection-frontmatter.json"))
            .expect("frontmatter fixture parses");
    let tagged_markdown = fixture["vectors"]
        .as_array()
        .expect("frontmatter vectors")
        .iter()
        .find(|vector| vector["name"].as_str() == Some("unsupported-explicit-tag-keeps-raw-value"))
        .and_then(|vector| vector["markdown"].as_str())
        .expect("unsupported-tag vector")
        .replacen("---\n", &format!("---\nid: {FIRST_TASK_ID}\n"), 1);
    write_text(
        &mut store,
        "tasks/collection.yaml",
        "fields:\n  priority:\n    type: select\n    options: [high]\n",
        2,
    )
    .expect("task schema");
    write_text_for_object(
        &mut store,
        "tasks/tagged.md",
        &tagged_markdown,
        "tagged-record-object",
        "tagged-record",
        3,
    )
    .expect("tagged record");

    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile tagged record");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));

    let query = store
        .read_with(|conn| {
            query_collection_records(conn, WORKSPACE_ID, "tasks", &CollectionQuery::default())
        })
        .expect("query tagged record")
        .expect("tasks collection");
    let priority = query.records[0]
        .values
        .iter()
        .find(|value| value.field == "priority")
        .expect("tagged priority value");
    assert_eq!(priority.value, json!("high"));
    assert_eq!(
        serde_json::to_value(&priority.validation).expect("serialize validation"),
        json!({
            "status": "flagged",
            "reason": { "code": "unsupported-tag", "path": "" }
        })
    );

    let stored = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
                 WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.path='tasks/tagged.md'",
                params![WORKSPACE_ID, VERSION_ID],
                |row| row.get::<_, String>(0),
            )
        })
        .expect("read tagged record after reconciliation");
    assert_eq!(stored, tagged_markdown);

    let untagged_markdown =
        format!("---\nid: {FIRST_TASK_ID}\npriority: high\n---\n\nUntagged priority\n");
    write_text_for_object(
        &mut store,
        "tasks/tagged.md",
        &untagged_markdown,
        "tagged-record-object",
        "untagged-record",
        4,
    )
    .expect("remove unsupported tag");
    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile untagged record");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));

    let query = store
        .read_with(|conn| {
            query_collection_records(conn, WORKSPACE_ID, "tasks", &CollectionQuery::default())
        })
        .expect("query untagged record")
        .expect("tasks collection");
    let priority = query.records[0]
        .values
        .iter()
        .find(|value| value.field == "priority")
        .expect("untagged priority value");
    assert_eq!(priority.value, json!("high"));
    assert_eq!(
        priority.validation,
        CollectionIndexedValueValidation::Valid,
        "removing an unsupported tag must revalidate the unchanged raw value",
    );
}

#[test]
fn reconcile_flags_only_frontmatter_values_beyond_depth_limit_and_keeps_raw_values() {
    let (_scratch, mut store) = fresh_store();
    write_text(
        &mut store,
        "depth/collection.yaml",
        "name: Depth boundary\n",
        2,
    )
    .expect("depth schema");

    let at_limit_yaml = format!("{}\"leaf\"{}", "[".repeat(23), "]".repeat(23));
    let over_limit_yaml = format!("{}\"leaf\"{}", "[".repeat(24), "]".repeat(24));
    write_text(
        &mut store,
        "depth/sample.md",
        &format!(
            "---\nid: {FIRST_TASK_ID}\natLimit: {at_limit_yaml}\noverLimit: {over_limit_yaml}\n---\n"
        ),
        3,
    )
    .expect("depth boundary record");

    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile depth boundary record");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));

    let query = store
        .read_with(|conn| {
            query_collection_records(conn, WORKSPACE_ID, "depth", &CollectionQuery::default())
        })
        .expect("query depth boundary record")
        .expect("depth collection");
    let record = &query.records[0];
    let nested_value = |containers: usize| {
        let mut value = json!("leaf");
        for _ in 0..containers {
            value = json!([value]);
        }
        value
    };
    let at_limit = record
        .values
        .iter()
        .find(|value| value.field == "atLimit")
        .expect("at-limit value");
    assert_eq!(at_limit.value, nested_value(23));
    assert_eq!(
        at_limit.validation,
        CollectionIndexedValueValidation::Untyped,
        "a 24-level field value remains indexable",
    );

    let over_limit = record
        .values
        .iter()
        .find(|value| value.field == "overLimit")
        .expect("over-limit value");
    assert_eq!(
        over_limit.value,
        nested_value(24),
        "depth validation must retain the raw value",
    );
    assert_eq!(
        serde_json::to_value(&over_limit.validation).expect("serialize depth validation"),
        json!({
            "status": "flagged",
            "reason": { "code": "value-depth-exceeded", "path": "" }
        }),
    );
}

#[test]
fn empty_frontmatter_record_is_adopted_with_only_the_minted_id() {
    let (_scratch, mut store) = fresh_store();
    write_text(&mut store, "tasks/collection.yaml", "name: Tasks\n", 2).expect("task schema");
    let empty_frontmatter = "---\n---";
    write_text_for_object(
        &mut store,
        "tasks/empty.md",
        empty_frontmatter,
        "empty-frontmatter-object",
        "empty-frontmatter-record",
        3,
    )
    .expect("empty-frontmatter record");

    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile empty-frontmatter record");
    let TxnOutcome::Committed(reconciled) = reconciled else {
        panic!("empty-frontmatter reconciliation did not commit");
    };
    let adoption = reconciled
        .adoptions
        .iter()
        .find(|candidate| candidate.file_path == "tasks/empty.md")
        .expect("empty-frontmatter record adoption");
    assert!(adoption.lossless_insertion_required);
    assert_eq!(
        collection_record_markdown_with_id(empty_frontmatter, &adoption.record_id),
        Some(format!("---\nid: {}\n---", adoption.record_id))
    );
}

#[test]
fn json_frontmatter_record_keeps_a_valid_flow_mapping_when_adopted() {
    for markdown in [
        "---\n{\"name\":\"Sam\",\"destination\":\"Tokyo\"}\n---\nBody\n",
        "---\r\n# Keep this comment\r\n  {name: Sam, destination: Tokyo}\r\n---\r\nBody\r\n",
        "---\n{}\n---\n",
        "---\n{ # empty mapping\n}\n---",
    ] {
        let original = markdown_frontmatter_json_with_provenance(markdown)
            .unwrap()
            .0;
        let adopted =
            collection_record_markdown_with_id(markdown, PERSON_ID).expect("flow adoption");
        let inserted = format!(
            "\"id\":\"{PERSON_ID}\"{}",
            if original.as_object().unwrap().is_empty() {
                ""
            } else {
                ","
            }
        );
        assert_eq!(adopted.replacen(&inserted, "", 1), markdown);
        let mut expected = original;
        expected["id"] = json!(PERSON_ID);
        assert_eq!(
            markdown_frontmatter_json_with_provenance(&adopted)
                .unwrap()
                .0,
            expected
        );
        let reminted =
            collection_record_markdown_with_id(&adopted, SECOND_PERSON_ID).expect("copy remint");
        assert_eq!(reminted, adopted.replacen(PERSON_ID, SECOND_PERSON_ID, 1));
        expected["id"] = json!(SECOND_PERSON_ID);
        assert_eq!(
            markdown_frontmatter_json_with_provenance(&reminted)
                .unwrap()
                .0,
            expected
        );
    }
}

#[test]
fn record_adoption_refuses_an_insertion_outside_the_root_mapping() {
    for markdown in [
        "---\n{a: 1}: value\nother: 2\n---\n",
        "---\n  name: Sam\n---\n",
    ] {
        assert!(markdown_frontmatter_json_with_provenance(markdown).is_some());
        assert_eq!(
            collection_record_markdown_with_id(markdown, PERSON_ID),
            None
        );
    }
}

#[test]
fn copied_record_cannot_remint_an_id_inside_a_mapping_key() {
    let markdown = format!("---\n{{\"id\":\"{PERSON_ID}\",a: 1}}: value\nid: {PERSON_ID}\n---\n");
    assert_eq!(
        markdown_frontmatter_json_with_provenance(&markdown)
            .unwrap()
            .0["id"],
        PERSON_ID
    );
    assert_eq!(
        collection_record_markdown_with_id(&markdown, SECOND_PERSON_ID),
        None
    );
}

#[test]
fn changing_an_adopted_record_id_keeps_the_query_surface_on_the_engine_id() {
    const RECORD_OBJECT_ID: &str = "changed-id-record-object";
    let (_scratch, mut store) = fresh_store();
    write_text(
        &mut store,
        "tasks/collection.yaml",
        "fields:\n  status:\n    type: text\n",
        2,
    )
    .expect("task schema");
    write_text_for_object(
        &mut store,
        "tasks/alpha.md",
        &format!("---\nid: {FIRST_TASK_ID}\nstatus: before\n---\n"),
        RECORD_OBJECT_ID,
        "changed-id-record",
        3,
    )
    .expect("record with original id");

    let indexed = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("index record with original id");
    assert!(matches!(indexed, TxnOutcome::Committed(_)));
    let adopted = store
        .write_with(&NoFaults, |tx| {
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "tasks/alpha.md",
                FIRST_TASK_ID,
                "adopted",
            )
        })
        .expect("adopt record with original id");
    assert!(matches!(adopted, TxnOutcome::Committed(())));

    write_text_for_object(
        &mut store,
        "tasks/alpha.md",
        &format!("---\nid: {SECOND_TASK_ID}\nstatus: after\n---\n"),
        RECORD_OBJECT_ID,
        "replace-record-id",
        4,
    )
    .expect("replace record id");
    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile replaced record id");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));

    let query = store
        .read_with(|conn| {
            query_collection_records(conn, WORKSPACE_ID, "tasks", &CollectionQuery::default())
        })
        .expect("query record after id edit")
        .expect("tasks collection");
    assert_eq!(query.records.len(), 1);
    let record = &query.records[0];
    assert_eq!(
        record.id, FIRST_TASK_ID,
        "the engine-owned id survives a frontmatter rewrite"
    );
    assert_eq!(record.path, "tasks/alpha.md");
}

#[test]
fn changing_an_adopted_record_id_keeps_authored_history_under_the_engine_id() {
    const RECORD_OBJECT_ID: &str = "changed-id-history-record-object";
    let (_scratch, mut store) = fresh_store();
    write_text(
        &mut store,
        "tasks/collection.yaml",
        "fields:\n  status:\n    type: text\n",
        2,
    )
    .expect("task schema");
    write_text_for_object(
        &mut store,
        "tasks/alpha.md",
        &format!("---\nid: {FIRST_TASK_ID}\nstatus: draft\n---\n"),
        RECORD_OBJECT_ID,
        "changed-id-history-record",
        3,
    )
    .expect("record with original id");

    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)?;
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "tasks/alpha.md",
                FIRST_TASK_ID,
                "adopted",
            )
        })
        .expect("index and adopt record with original id");

    let draft = json!({ "id": FIRST_TASK_ID, "status": "draft" });
    let review = json!({ "id": FIRST_TASK_ID, "status": "review" });
    let done = json!({ "id": FIRST_TASK_ID, "status": "done" });
    store
        .write_with(&NoFaults, |tx| {
            let _ = index_collection_frontmatter_apply_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                RECORD_OBJECT_ID,
                &draft,
                &review,
                &draft,
                &review,
                None,
                Some("human-editor"),
                None,
                None,
                10,
            )?;
            index_collection_frontmatter_apply_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                RECORD_OBJECT_ID,
                &review,
                &done,
                &review,
                &done,
                None,
                Some("agent-editor"),
                None,
                None,
                20,
            )
        })
        .expect("record history before id change");

    write_text_for_object(
        &mut store,
        "tasks/alpha.md",
        &format!("---\nid: {SECOND_TASK_ID}\nstatus: done\n---\n"),
        RECORD_OBJECT_ID,
        "replace-record-id-with-history",
        30,
    )
    .expect("replace record id after history exists");
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile record id change with history");

    let details = store
        .read_with(|conn| {
            get_collection_record(conn, WORKSPACE_ID, "tasks", FIRST_TASK_ID, 10, None)
        })
        .expect("get record under the engine-owned id")
        .expect("the engine-owned id remains the same record");
    assert_eq!(details.history.len(), 2);
    assert_eq!(details.history[0].recorded_at_ms, 20);
    assert_eq!(
        details.history[0].author_origin_id.as_deref(),
        Some("agent-editor")
    );
    assert_eq!(details.history[0].previous.value, Some(json!("review")));
    assert_eq!(details.history[0].next.value, Some(json!("done")));
    assert_eq!(details.history[1].recorded_at_ms, 10);
    assert_eq!(
        details.history[1].author_origin_id.as_deref(),
        Some("human-editor")
    );
    assert_eq!(details.history[1].previous.value, Some(json!("draft")));
    assert_eq!(details.history[1].next.value, Some(json!("review")));

    let replacement_id = store
        .read_with(|conn| {
            get_collection_record(conn, WORKSPACE_ID, "tasks", SECOND_TASK_ID, 10, None)
        })
        .expect("query the user-supplied replacement id");
    assert!(
        replacement_id.is_none(),
        "the user-supplied replacement id never becomes a record"
    );
}

#[test]
fn deleted_record_id_without_field_history_stays_reserved() {
    const SURVIVING_OBJECT_ID: &str = "object-7";
    let (_scratch, mut store) = seeded_store();

    store
        .write_with(&NoFaults, |tx| {
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "tasks/alpha.md",
                FIRST_TASK_ID,
                "adopted",
            )?;
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "tasks/beta.md",
                SECOND_TASK_ID,
                "adopted",
            )
        })
        .expect("adopt records before deleting one");
    let history_count = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM collection_field_history \
                 WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3",
                params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("count deleted record history before deletion");
    assert_eq!(history_count, 0);

    VersionedTextStore::new(&mut store)
        .delete_text_file(
            &DeleteTextFile {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: VERSION_ID.to_owned(),
                path: "tasks/alpha.md".to_owned(),
                moment_id: "delete-unedited-alpha".to_owned(),
                request_id: None,
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
            },
            &NoFaults,
        )
        .expect("delete unedited alpha");
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile deleted unedited alpha");

    write_text_for_object(
        &mut store,
        "tasks/beta.md",
        &format!(
            "---\nid: {FIRST_TASK_ID}\nTitle: Beta\nStatus: Todo\nRank: 1\nOwner: {SECOND_PERSON_ID}\n---\n"
        ),
        SURVIVING_OBJECT_ID,
        "claim-unedited-deleted-alpha-id",
        11,
    )
    .expect("edit beta to claim the unedited deleted id");
    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile unedited deleted id claim");
    let TxnOutcome::Committed(reconciled) = reconciled else {
        panic!("unedited deleted id claim reconciliation crashed");
    };
    let replacement = reconciled
        .adoptions
        .iter()
        .find(|candidate| candidate.object_id == SURVIVING_OBJECT_ID)
        .expect("surviving record receives a replacement id");
    assert_ne!(replacement.record_id, FIRST_TASK_ID);
    assert_eq!(
        replacement.record_id, SECOND_TASK_ID,
        "the survivor keeps its own engine-owned id instead of a remint"
    );
}

#[test]
fn deleted_record_id_stays_reserved_and_keeps_its_history() {
    const DELETED_OBJECT_ID: &str = "object-6";
    const SURVIVING_OBJECT_ID: &str = "object-7";
    let (_scratch, mut store) = seeded_store();

    store
        .write_with(&NoFaults, |tx| {
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "tasks/alpha.md",
                FIRST_TASK_ID,
                "adopted",
            )?;
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "tasks/beta.md",
                SECOND_TASK_ID,
                "adopted",
            )
        })
        .expect("adopt records before deleting one");

    let before = json!({
        "id": FIRST_TASK_ID,
        "Title": "Alpha",
        "Status": "Broken",
        "Rank": 1,
        "Owner": PERSON_ID,
    });
    let after = json!({
        "id": FIRST_TASK_ID,
        "Title": "Alpha edited",
        "Status": "Broken",
        "Rank": 1,
        "Owner": PERSON_ID,
    });
    store
        .write_with(&NoFaults, |tx| {
            index_collection_frontmatter_apply_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                DELETED_OBJECT_ID,
                &before,
                &after,
                &before,
                &after,
                None,
                Some("alpha-editor"),
                None,
                None,
                10,
            )
        })
        .expect("record history for the record that will be deleted");

    VersionedTextStore::new(&mut store)
        .delete_text_file(
            &DeleteTextFile {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: VERSION_ID.to_owned(),
                path: "tasks/alpha.md".to_owned(),
                moment_id: "delete-alpha".to_owned(),
                request_id: None,
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 11,
            },
            &NoFaults,
        )
        .expect("delete alpha");
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile deleted alpha");

    write_text_for_object(
        &mut store,
        "tasks/beta.md",
        &format!(
            "---\nid: {FIRST_TASK_ID}\nTitle: Beta\nStatus: Todo\nRank: 1\nOwner: {SECOND_PERSON_ID}\n---\n"
        ),
        SURVIVING_OBJECT_ID,
        "claim-deleted-alpha-id",
        12,
    )
    .expect("edit beta to claim alpha's deleted id");
    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile deleted id claim");
    let TxnOutcome::Committed(reconciled) = reconciled else {
        panic!("deleted id claim reconciliation crashed");
    };
    let replacement = reconciled
        .adoptions
        .iter()
        .find(|candidate| candidate.object_id == SURVIVING_OBJECT_ID)
        .expect("surviving record receives a replacement id");
    assert_ne!(replacement.record_id, FIRST_TASK_ID);
    assert_eq!(
        replacement.record_id, SECOND_TASK_ID,
        "the survivor keeps its own engine-owned id instead of a remint"
    );

    let replacement_details = store
        .read_with(|conn| {
            get_collection_record(
                conn,
                WORKSPACE_ID,
                "tasks",
                &replacement.record_id,
                10,
                None,
            )
        })
        .expect("load surviving record under its replacement id")
        .expect("surviving record remains indexed");
    assert_eq!(replacement_details.record.path, "tasks/beta.md");
    assert!(
        replacement_details.history.is_empty(),
        "the survivor must not inherit the deleted record's history"
    );

    let deleted_history = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT field_name,previous_value_json,next_value_json,author_origin_id \
                 FROM collection_field_history \
                 WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3",
                params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
        })
        .expect("load deleted record history by its reserved id");
    assert_eq!(
        deleted_history,
        (
            "Title".to_owned(),
            Some("\"Alpha\"".to_owned()),
            Some("\"Alpha edited\"".to_owned()),
            Some("alpha-editor".to_owned()),
        )
    );
}

#[test]
fn changed_id_owner_malformed_then_same_id_copy_keeps_changed_id_reserved() {
    const OWNER_OBJECT_ID: &str = "changed-id-malformed-owner";
    const COPY_OBJECT_ID: &str = "changed-id-malformed-copy";
    const OWNER_PATH: &str = "tasks/owner.md";
    const COPY_PATH: &str = "tasks/copy.md";
    let (_scratch, mut store) = fresh_store();
    write_text(&mut store, "tasks/collection.yaml", "name: Tasks\n", 2).expect("task schema");
    write_text_for_object(
        &mut store,
        OWNER_PATH,
        &format!("---\nid: {FIRST_TASK_ID}\nTitle: Owner\n---\n"),
        OWNER_OBJECT_ID,
        "changed-id-owner-original",
        3,
    )
    .expect("original owner record");
    let indexed = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile original owner");
    assert!(matches!(indexed, TxnOutcome::Committed(_)));
    let adopted = store
        .write_with(&NoFaults, |tx| {
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                OWNER_PATH,
                FIRST_TASK_ID,
                "adopted",
            )
        })
        .expect("adopt original owner");
    assert!(matches!(adopted, TxnOutcome::Committed(())));

    write_text_for_object(
        &mut store,
        OWNER_PATH,
        &format!("---\nid: {SECOND_TASK_ID}\nTitle: Changed id\n---\n"),
        OWNER_OBJECT_ID,
        "change-owner-id-before-malformed",
        4,
    )
    .expect("change owner id");
    let changed = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile changed owner id");
    assert!(matches!(changed, TxnOutcome::Committed(_)));

    write_text_for_object(
        &mut store,
        OWNER_PATH,
        "---\nid: [\n---\n",
        OWNER_OBJECT_ID,
        "malform-changed-id-owner",
        5,
    )
    .expect("malform changed-id owner");
    let malformed = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile malformed changed-id owner");
    assert!(matches!(malformed, TxnOutcome::Committed(_)));

    write_text_for_object(
        &mut store,
        COPY_PATH,
        &format!("---\nid: {SECOND_TASK_ID}\nTitle: Copy\n---\n"),
        COPY_OBJECT_ID,
        "copy-changed-id-owner",
        6,
    )
    .expect("copy changed owner id");
    let copied = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile copy of changed-id owner");
    assert!(matches!(copied, TxnOutcome::Committed(_)));
    let copy_id = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT record_id FROM collection_records \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![WORKSPACE_ID, VERSION_ID, COPY_OBJECT_ID],
                |row| row.get::<_, String>(0),
            )
        })
        .expect("copy binding after changed-id owner became malformed");
    assert_ne!(
        copy_id, SECOND_TASK_ID,
        "the malformed owner still reserves its changed id"
    );
}

#[test]
fn rename_and_same_id_copy_keep_identity_and_history_with_the_original_object() {
    const ORIGINAL_OBJECT_ID: &str = "rename-owner-object";
    const COPY_OBJECT_ID: &str = "same-id-copy-object";
    const ORIGINAL_PATH: &str = "tasks/original.md";
    const RENAMED_PATH: &str = "tasks/z-original.md";
    const COPY_PATH: &str = "tasks/a-copy.md";
    let (_scratch, mut store) = fresh_store();
    write_text(
        &mut store,
        "tasks/collection.yaml",
        "fields:\n  Title:\n    type: text\n",
        2,
    )
    .expect("task schema");
    write_text_for_object(
        &mut store,
        ORIGINAL_PATH,
        &format!("---\nid: {FIRST_TASK_ID}\nTitle: Before\n---\n"),
        ORIGINAL_OBJECT_ID,
        "rename-owner-record",
        3,
    )
    .expect("original record");
    let indexed = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("index original record");
    assert!(matches!(indexed, TxnOutcome::Committed(_)));
    let adopted = store
        .write_with(&NoFaults, |tx| {
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                ORIGINAL_PATH,
                FIRST_TASK_ID,
                "adopted",
            )
        })
        .expect("adopt original record");
    assert!(matches!(adopted, TxnOutcome::Committed(())));

    let before = json!({ "id": FIRST_TASK_ID, "Title": "Before" });
    let after = json!({ "id": FIRST_TASK_ID, "Title": "Edited" });
    write_text_for_object(
        &mut store,
        ORIGINAL_PATH,
        &format!("---\nid: {FIRST_TASK_ID}\nTitle: Edited\n---\n"),
        ORIGINAL_OBJECT_ID,
        "edit-before-rename",
        4,
    )
    .expect("edit original record");
    let history_added = store
        .write_with(&NoFaults, |tx| {
            index_collection_frontmatter_apply_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                ORIGINAL_OBJECT_ID,
                &before,
                &after,
                &before,
                &after,
                None,
                Some("editor"),
                None,
                None,
                4,
            )
        })
        .expect("record original field history");
    assert!(matches!(history_added, TxnOutcome::Committed(Some(_))));

    VersionedTextStore::new(&mut store)
        .rename_text_file(
            &RenameTextFile {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: VERSION_ID.to_owned(),
                from_path: ORIGINAL_PATH.to_owned(),
                to_path: RENAMED_PATH.to_owned(),
                moment_id: "rename-original-record".to_owned(),
                request_id: None,
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 5,
            },
            &NoFaults,
        )
        .expect("rename original record");
    write_text_for_object(
        &mut store,
        COPY_PATH,
        &format!("---\nid: {FIRST_TASK_ID}\nTitle: Copy\n---\n"),
        COPY_OBJECT_ID,
        "capture-same-id-copy",
        6,
    )
    .expect("capture same-id copy");

    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile rename and same-id copy together");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));
    let bindings = store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT record_id,file_path,object_id FROM collection_records \
                 WHERE workspace_id=?1 AND version_id=?2 AND collection_path='tasks' \
                 ORDER BY file_path",
            )?;
            statement
                .query_map(params![WORKSPACE_ID, VERSION_ID], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .expect("load rename and copy bindings");
    assert_eq!(bindings.len(), 2);
    let original = bindings
        .iter()
        .find(|(_, _, object_id)| object_id == ORIGINAL_OBJECT_ID)
        .expect("renamed original binding");
    assert_eq!(original.0, FIRST_TASK_ID);
    assert_eq!(original.1, RENAMED_PATH);
    let copy = bindings
        .iter()
        .find(|(_, _, object_id)| object_id == COPY_OBJECT_ID)
        .expect("copy binding");
    assert_ne!(copy.0, FIRST_TASK_ID, "the copy must receive a fresh id");
    assert_eq!(copy.1, COPY_PATH);

    let details = store
        .read_with(|conn| {
            get_collection_record(conn, WORKSPACE_ID, "tasks", FIRST_TASK_ID, 10, None)
        })
        .expect("get original record after rename")
        .expect("original record identity survives rename");
    assert_eq!(details.record.path, RENAMED_PATH);
    assert_eq!(details.history.len(), 1);
    assert_eq!(details.history[0].field, "Title");
    assert_eq!(details.history[0].previous.value, Some(json!("Before")));
    assert_eq!(details.history[0].next.value, Some(json!("Edited")));
}

#[test]
fn reconcile_indexes_non_finite_yaml_numbers_without_dropping_them() {
    let (_scratch, mut store) = fresh_store();
    let field_value_fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/collection-field-values.json"))
            .expect("field-value fixture parses");
    let nan_yaml = field_value_fixture["vectors"]
        .as_array()
        .expect("field-value vectors")
        .iter()
        .find(|vector| vector["name"].as_str() == Some("number-flagged-non-finite"))
        .and_then(|vector| vector["valueYaml"].as_str())
        .expect("non-finite number vector");
    write_text(
        &mut store,
        "measurements/collection.yaml",
        "fields:\n  NotANumber:\n    type: number\n  PositiveInfinity:\n    type: number\n  NegativeInfinity:\n    type: number\n  QuotedNan:\n    type: number\n",
        2,
    )
    .expect("measurement schema");
    write_text(
        &mut store,
        "measurements/sample.md",
        &format!(
            "---\nid: {FIRST_TASK_ID}\nNotANumber: {nan_yaml}\nPositiveInfinity: .inf\nNegativeInfinity: -.INF\nQuotedNan: \".nan\"\n---\n"
        ),
        3,
    )
    .expect("measurement record");

    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile measurements");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));

    let query = store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "measurements",
                &CollectionQuery::default(),
            )
        })
        .expect("query measurements")
        .expect("measurement collection");
    let record = query.records.first().expect("measurement record");
    for (field, expected) in [
        ("NotANumber", json!(".nan")),
        ("PositiveInfinity", json!(".inf")),
        ("NegativeInfinity", json!("-.inf")),
    ] {
        let value = record
            .values
            .iter()
            .find(|value| value.field == field)
            .unwrap_or_else(|| panic!("missing indexed field {field}"));
        assert_eq!(value.value, expected, "preserved value for {field}");
        assert_eq!(
            serde_json::to_value(&value.validation).expect("serialize validation"),
            json!({
                "status": "flagged",
                "reason": { "code": "number-not-finite", "path": "" }
            }),
            "validation for {field}"
        );
    }

    let quoted = record
        .values
        .iter()
        .find(|value| value.field == "QuotedNan")
        .expect("quoted NaN field");
    assert_eq!(quoted.value, json!(".nan"));
    assert_eq!(
        serde_json::to_value(&quoted.validation).expect("serialize validation"),
        json!({
            "status": "flagged",
            "reason": { "code": "expected-number", "path": "" }
        })
    );
}

// Both `.nan` spellings coerce to the string ".nan", so the synced
// moment.append lane could not tell a non-finite number from a string that
// merely spells one and flagged both expected-number. The parse provenance
// now rides the apply; the stored value stays the coerced string.
#[test]
fn moment_lane_indexing_distinguishes_non_finite_numbers_from_nan_strings() {
    let (_scratch, mut store) = fresh_store();
    write_text(
        &mut store,
        "measurements/collection.yaml",
        "fields:
  estimate:
    type: number
",
        2,
    )
    .expect("measurement schema");
    write_text(
        &mut store,
        "measurements/unquoted.md",
        &format!(
            "---
id: {FIRST_TASK_ID}
estimate: 0
---
"
        ),
        3,
    )
    .expect("unquoted seed");
    write_text(
        &mut store,
        "measurements/quoted.md",
        &format!(
            "---
id: {SECOND_TASK_ID}
estimate: 0
---
"
        ),
        4,
    )
    .expect("quoted seed");
    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile measurements");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));

    for (object_id, text, now) in [
        (
            "object-3",
            format!(
                "---
id: {FIRST_TASK_ID}
estimate: .nan
---
"
            ),
            5,
        ),
        (
            "object-4",
            format!(
                "---
id: {SECOND_TASK_ID}
estimate: \".nan\"
---
"
            ),
            6,
        ),
    ] {
        let before = json!({ "estimate": 0 });
        let (after, provenance) =
            markdown_frontmatter_json_with_provenance(&text).expect("incoming frontmatter parses");
        let applied = store
            .write_with(&NoFaults, |tx| {
                index_collection_frontmatter_apply_in_tx(
                    tx,
                    WORKSPACE_ID,
                    VERSION_ID,
                    object_id,
                    &before,
                    &after,
                    &before,
                    &after,
                    Some(&provenance),
                    Some("peer"),
                    None,
                    Some(("peer", now)),
                    now,
                )
            })
            .expect("apply synced frontmatter");
        assert!(matches!(applied, TxnOutcome::Committed(Some(_))));
    }

    let query = store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "measurements",
                &CollectionQuery::default(),
            )
        })
        .expect("query measurements")
        .expect("measurement collection");
    let validation = |record_id: &str| {
        let record = query
            .records
            .iter()
            .find(|record| record.id == record_id)
            .unwrap_or_else(|| panic!("missing record {record_id}"));
        let value = record
            .values
            .iter()
            .find(|value| value.field == "estimate")
            .expect("estimate value");
        assert_eq!(value.value, json!(".nan"), "the coerced value is preserved");
        serde_json::to_value(&value.validation).expect("serialize validation")
    };
    assert_eq!(
        validation(FIRST_TASK_ID),
        json!({
            "status": "flagged",
            "reason": { "code": "number-not-finite", "path": "" }
        }),
        "an unquoted .nan is a non-finite number"
    );
    assert_eq!(
        validation(SECOND_TASK_ID),
        json!({
            "status": "flagged",
            "reason": { "code": "expected-number", "path": "" }
        }),
        "a quoted \".nan\" is a string in a number field"
    );
}

#[test]
fn a_same_value_provenance_change_refreshes_the_flag_reason() {
    let (_scratch, mut store) = fresh_store();
    write_text(
        &mut store,
        "measurements/collection.yaml",
        "fields:
  estimate:
    type: number
",
        2,
    )
    .expect("measurement schema");
    write_text(
        &mut store,
        "measurements/one.md",
        &format!(
            "---
id: {FIRST_TASK_ID}
estimate: 0
---
"
        ),
        3,
    )
    .expect("seed");
    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile measurements");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));

    // Unquoted .nan, then the quoted string: the coerced JSON value is the
    // same ".nan" both times, so nothing but the provenance changes.
    let mut before = json!({ "estimate": 0 });
    for (text, now) in [
        (
            format!(
                "---
id: {FIRST_TASK_ID}
estimate: .nan
---
"
            ),
            5,
        ),
        (
            format!(
                "---
id: {FIRST_TASK_ID}
estimate: \".nan\"
---
"
            ),
            6,
        ),
    ] {
        let (after, provenance) =
            markdown_frontmatter_json_with_provenance(&text).expect("incoming frontmatter parses");
        let applied = store
            .write_with(&NoFaults, |tx| {
                index_collection_frontmatter_apply_in_tx(
                    tx,
                    WORKSPACE_ID,
                    VERSION_ID,
                    "object-3",
                    &before,
                    &after,
                    &before,
                    &after,
                    Some(&provenance),
                    Some("peer"),
                    None,
                    Some(("peer", now)),
                    now,
                )
            })
            .expect("apply synced frontmatter");
        assert!(matches!(applied, TxnOutcome::Committed(_)));
        before = after;
    }

    let query = store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "measurements",
                &CollectionQuery::default(),
            )
        })
        .expect("query measurements")
        .expect("measurement collection");
    let record = query
        .records
        .iter()
        .find(|record| record.id == FIRST_TASK_ID)
        .expect("record");
    let value = record
        .values
        .iter()
        .find(|value| value.field == "estimate")
        .expect("estimate value");
    assert_eq!(value.value, json!(".nan"));
    assert_eq!(
        serde_json::to_value(&value.validation).expect("serialize validation"),
        json!({
            "status": "flagged",
            "reason": { "code": "expected-number", "path": "" }
        }),
        "the quoted rewrite replaces the non-finite reason even though the value is unchanged"
    );
}

/// A file written with no Y.Doc lineage indexes against the stored index,
/// where both `.nan` spellings are the same ".nan". The write changes no
/// value, yet each spelling still replaces the other's flag reason.
#[test]
fn a_file_write_of_the_same_value_refreshes_the_flag_reason() {
    let (_scratch, mut store) = fresh_store();
    write_text(
        &mut store,
        "measurements/collection.yaml",
        "fields:\n  estimate:\n    type: number\n",
        2,
    )
    .expect("measurement schema");
    let unquoted = format!("---\nid: {FIRST_TASK_ID}\nestimate: .nan\n---\n");
    let quoted = format!("---\nid: {FIRST_TASK_ID}\nestimate: \".nan\"\n---\n");
    write_text(&mut store, "measurements/one.md", &unquoted, 3).expect("seed");
    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile measurements");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));
    let reason = |store: &EngineStore| -> String {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT json_extract(validation_reason_json, '$.code') \
                     FROM collection_record_fields \
                     WHERE workspace_id = ?1 AND record_id = ?2 AND field_name = 'estimate'",
                    params![WORKSPACE_ID, FIRST_TASK_ID],
                    |row| row.get(0),
                )
            })
            .expect("estimate reason")
    };
    assert_eq!(reason(&store), "number-not-finite");
    for (text, expected, now) in [
        (&quoted, "expected-number", 5),
        (&unquoted, "number-not-finite", 6),
    ] {
        let facts = store
            .write_with(&NoFaults, |tx| {
                index_collection_record_text_in_tx(
                    tx,
                    WORKSPACE_ID,
                    VERSION_ID,
                    "object-3",
                    "measurements/one.md",
                    text,
                    None,
                    None,
                    now,
                )
            })
            .expect("index the file");
        assert!(
            matches!(facts, TxnOutcome::Committed(None)),
            "the value did not change"
        );
        assert_eq!(reason(&store), expected);
    }
}

#[test]
fn collection_reconcile_keeps_fresh_lossless_mode_distinct_from_established_repair() {
    let (_scratch, mut store) = fresh_store();
    write_text(&mut store, "tasks/collection.yaml", "name: Tasks\n", 2).expect("task schema");
    write_text_for_object(
        &mut store,
        "tasks/fresh.md",
        "Fresh body\n",
        "fresh-object",
        "fresh-record",
        3,
    )
    .expect("fresh record");

    for attempt in 0..2 {
        let reconciled = store
            .write_with(&NoFaults, |tx| {
                reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
            })
            .expect("reconcile fresh record");
        let TxnOutcome::Committed(reconciled) = reconciled else {
            panic!("fresh reconciliation crashed");
        };
        let fresh = reconciled
            .adoptions
            .iter()
            .find(|candidate| candidate.file_path == "tasks/fresh.md")
            .expect("fresh adoption candidate");
        assert!(
            fresh.lossless_insertion_required,
            "fresh retry {attempt} must stay lossless"
        );
    }
    let (fresh_id, fresh_state) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT record_id,adoption_state FROM collection_records \
                 WHERE workspace_id=?1 AND version_id=?2 AND file_path='tasks/fresh.md'",
                params![WORKSPACE_ID, VERSION_ID],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
        })
        .expect("fresh adoption state");
    assert_eq!(fresh_state, "pending-lossless");
    let deferred_fresh = store
        .write_with(&NoFaults, |tx| {
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "tasks/fresh.md",
                &fresh_id,
                "deferred-conflict-lossless",
            )
        })
        .expect("defer fresh lossless adoption");
    assert!(matches!(deferred_fresh, TxnOutcome::Committed(())));
    let retried_fresh = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("retry deferred fresh record");
    let TxnOutcome::Committed(retried_fresh) = retried_fresh else {
        panic!("deferred fresh reconciliation crashed");
    };
    assert!(
        retried_fresh
            .adoptions
            .iter()
            .find(|candidate| candidate.file_path == "tasks/fresh.md")
            .expect("retried fresh adoption candidate")
            .lossless_insertion_required
    );

    write_text_for_object(
        &mut store,
        "tasks/established.md",
        &format!("---\nid: {PERSON_ID}\n---\n\nEstablished body\n"),
        "established-object",
        "established-record",
        4,
    )
    .expect("established record");
    let parsed = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile parsed record");
    let TxnOutcome::Committed(parsed) = parsed else {
        panic!("parsed reconciliation crashed");
    };
    let parsed = parsed
        .adoptions
        .iter()
        .find(|candidate| candidate.file_path == "tasks/established.md")
        .expect("parsed adoption candidate");
    assert!(!parsed.lossless_insertion_required);
    let adopted = store
        .write_with(&NoFaults, |tx| {
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "tasks/established.md",
                PERSON_ID,
                "adopted",
            )
        })
        .expect("mark parsed record adopted");
    assert!(matches!(adopted, TxnOutcome::Committed(())));

    write_text_for_object(
        &mut store,
        "tasks/established.md",
        "Established body without id\n",
        "established-object",
        "established-id-removed",
        5,
    )
    .expect("remove established id");
    for attempt in 0..2 {
        let reconciled = store
            .write_with(&NoFaults, |tx| {
                reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
            })
            .expect("reconcile established repair");
        let TxnOutcome::Committed(reconciled) = reconciled else {
            panic!("established repair reconciliation crashed");
        };
        let established = reconciled
            .adoptions
            .iter()
            .find(|candidate| candidate.file_path == "tasks/established.md")
            .expect("established repair candidate");
        assert!(
            !established.lossless_insertion_required,
            "established retry {attempt} must remain a semantic repair"
        );
    }
    let deferred_established = store
        .write_with(&NoFaults, |tx| {
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "tasks/established.md",
                PERSON_ID,
                "deferred-conflict",
            )
        })
        .expect("defer established repair");
    assert!(matches!(deferred_established, TxnOutcome::Committed(())));
    let retried_established = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("retry deferred established repair");
    let TxnOutcome::Committed(retried_established) = retried_established else {
        panic!("deferred established repair reconciliation crashed");
    };
    assert!(
        !retried_established
            .adoptions
            .iter()
            .find(|candidate| candidate.file_path == "tasks/established.md")
            .expect("retried established repair candidate")
            .lossless_insertion_required
    );
    let established_state = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT adoption_state FROM collection_records \
                 WHERE workspace_id=?1 AND version_id=?2 AND file_path='tasks/established.md'",
                params![WORKSPACE_ID, VERSION_ID],
                |row| row.get::<_, String>(0),
            )
        })
        .expect("established repair state");
    assert_eq!(established_state, "pending");
}

#[test]
fn query_uses_indexed_values_flags_filter_sort_group_and_relation_labels() {
    let (_scratch, store) = seeded_store();
    let sorted = store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "tasks",
                &CollectionQuery {
                    filter: None,
                    sort: vec![
                        CollectionSort {
                            field: "Rank".to_owned(),
                            direction: ViewSortDirection::Asc,
                        },
                        CollectionSort {
                            field: "Title".to_owned(),
                            direction: ViewSortDirection::Desc,
                        },
                    ],
                    group_by: Some("Status".to_owned()),
                    resolve_relations: true,
                    ..CollectionQuery::default()
                },
            )
        })
        .expect("query")
        .expect("tasks collection");
    assert_eq!(
        sorted
            .records
            .iter()
            .map(|record| record.id.as_str())
            .collect::<Vec<_>>(),
        vec![SECOND_TASK_ID, FIRST_TASK_ID]
    );
    let alpha = sorted
        .records
        .iter()
        .find(|record| record.id == FIRST_TASK_ID)
        .expect("alpha record");
    assert!(!alpha.conflicted);
    let status = alpha
        .values
        .iter()
        .find(|value| value.field == "Status")
        .expect("status value");
    assert_eq!(status.value, json!("Broken"));
    assert!(matches!(
        status.validation,
        CollectionIndexedValueValidation::Flagged { .. }
    ));
    let owner = alpha
        .values
        .iter()
        .find(|value| value.field == "Owner")
        .expect("owner value");
    assert_eq!(owner.resolved_relations.len(), 1);
    assert_eq!(owner.resolved_relations[0].record_id, PERSON_ID);
    assert_eq!(owner.resolved_relations[0].label, "Alice");
    let beta = sorted
        .records
        .iter()
        .find(|record| record.id == SECOND_TASK_ID)
        .expect("beta record");
    let beta_owner = beta
        .values
        .iter()
        .find(|value| value.field == "Owner")
        .expect("beta owner value");
    assert_eq!(beta_owner.resolved_relations[0].record_id, SECOND_PERSON_ID);
    assert_eq!(beta_owner.resolved_relations[0].label, "bob");
    let broken_group = sorted
        .groups
        .as_ref()
        .expect("groups")
        .iter()
        .find(|group| group.value == json!("Broken"))
        .expect("raw flagged group");
    assert_eq!(broken_group.records[0].id, FIRST_TASK_ID);

    let contains = store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "tasks",
                &CollectionQuery {
                    filter: Some(CollectionFilter {
                        field: "Title".to_owned(),
                        operator: CollectionFilterOperator::Contains,
                        value: json!("Alp"),
                    }),
                    ..CollectionQuery::default()
                },
            )
        })
        .expect("contains query")
        .expect("tasks collection");
    assert_eq!(contains.records.len(), 1);
    assert_eq!(contains.records[0].id, FIRST_TASK_ID);

    let equals = store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "tasks",
                &CollectionQuery {
                    filter: Some(CollectionFilter {
                        field: "Status".to_owned(),
                        operator: CollectionFilterOperator::Equals,
                        value: json!("Todo"),
                    }),
                    ..CollectionQuery::default()
                },
            )
        })
        .expect("equals query")
        .expect("tasks collection");
    assert_eq!(equals.records.len(), 1);
    assert_eq!(equals.records[0].id, SECOND_TASK_ID);
}

#[test]
fn filtered_query_does_not_hydrate_unrelated_fields_for_dropped_records() {
    let (_scratch, mut store) = seeded_store();
    let poisoned = store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            let updated = tx
                .execute(
                    "UPDATE collection_record_fields SET validation_reason_json='{}' \
                     WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3 \
                       AND field_name='Rank'",
                    params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID],
                )
                .map_err(StorageError::persist_public)?;
            assert_eq!(updated, 1, "the dropped record must have a poisoned field");
            Ok(())
        })
        .expect("poison an unrelated field on the nonmatching record");
    assert!(matches!(poisoned, TxnOutcome::Committed(())));

    let filtered = store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "tasks",
                &CollectionQuery {
                    filter: Some(CollectionFilter {
                        field: "Status".to_owned(),
                        operator: CollectionFilterOperator::Equals,
                        value: json!("Todo"),
                    }),
                    ..CollectionQuery::default()
                },
            )
        })
        .expect("query without hydrating the dropped record")
        .expect("tasks collection");
    assert_eq!(
        filtered
            .records
            .iter()
            .map(|record| record.id.as_str())
            .collect::<Vec<_>>(),
        [SECOND_TASK_ID]
    );
    assert!(
        filtered.records[0]
            .values
            .iter()
            .any(|value| value.field == "Rank" && value.value == json!(1)),
        "the matching record still hydrates its complete field set"
    );
}

#[test]
fn relation_resolution_only_reads_records_on_the_selected_page() {
    let (_scratch, mut store) = seeded_store();
    let sort = vec![CollectionSort {
        field: "Title".to_owned(),
        direction: ViewSortDirection::Asc,
    }];
    let poisoned = store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            let updated = tx
                .execute(
                    "UPDATE collection_relation_edges \
                     SET target_collection_path=CAST(x'80' AS TEXT) \
                     WHERE workspace_id=?1 AND version_id=?2 AND source_record_id=?3 \
                       AND field_name='Owner'",
                    params![WORKSPACE_ID, VERSION_ID, SECOND_TASK_ID],
                )
                .map_err(StorageError::persist_public)?;
            assert_eq!(
                updated, 1,
                "the later page must have a poisoned relation edge"
            );
            Ok(())
        })
        .expect("poison the relation edge after the first page");
    assert!(matches!(poisoned, TxnOutcome::Committed(())));

    let first_page = store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "tasks",
                &CollectionQuery {
                    sort: sort.clone(),
                    limit: 1,
                    resolve_relations: true,
                    ..CollectionQuery::default()
                },
            )
        })
        .expect("resolve only the first page")
        .expect("tasks collection");
    assert_eq!(first_page.records.len(), 1);
    assert_eq!(first_page.records[0].id, FIRST_TASK_ID);
    let first_owner = first_page.records[0]
        .values
        .iter()
        .find(|value| value.field == "Owner")
        .expect("first-page owner");
    assert_eq!(first_owner.resolved_relations[0].label, "Alice");
    let cursor = first_page.next_cursor.expect("second page cursor");

    let repaired_and_poisoned = store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            let repaired = tx
                .execute(
                    "UPDATE collection_relation_edges SET target_collection_path='people' \
                     WHERE workspace_id=?1 AND version_id=?2 AND source_record_id=?3 \
                       AND field_name='Owner'",
                    params![WORKSPACE_ID, VERSION_ID, SECOND_TASK_ID],
                )
                .map_err(StorageError::persist_public)?;
            assert_eq!(repaired, 1);
            let poisoned = tx
                .execute(
                    "UPDATE collection_relation_edges \
                     SET target_collection_path=CAST(x'80' AS TEXT) \
                     WHERE workspace_id=?1 AND version_id=?2 AND source_record_id=?3 \
                       AND field_name='Owner'",
                    params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID],
                )
                .map_err(StorageError::persist_public)?;
            assert_eq!(
                poisoned, 1,
                "the prior page must have a poisoned relation edge"
            );
            Ok(())
        })
        .expect("move the relation poison behind the cursor");
    assert!(matches!(repaired_and_poisoned, TxnOutcome::Committed(())));

    let second_page = store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "tasks",
                &CollectionQuery {
                    sort,
                    limit: 1,
                    cursor: Some(cursor),
                    resolve_relations: true,
                    ..CollectionQuery::default()
                },
            )
        })
        .expect("resolve only the page after the cursor")
        .expect("tasks collection");
    assert_eq!(second_page.records.len(), 1);
    assert_eq!(second_page.records[0].id, SECOND_TASK_ID);
    let second_owner = second_page.records[0]
        .values
        .iter()
        .find(|value| value.field == "Owner")
        .expect("second-page owner");
    assert_eq!(second_owner.resolved_relations[0].label, "bob");
}

#[test]
fn sorted_collection_query_cursor_pages_are_gapless_and_duplicate_free() {
    let (_scratch, store) = seeded_store();
    let sort = vec![
        CollectionSort {
            field: "Rank".to_owned(),
            direction: ViewSortDirection::Asc,
        },
        CollectionSort {
            field: "Title".to_owned(),
            direction: ViewSortDirection::Desc,
        },
    ];
    let expected = store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "tasks",
                &CollectionQuery {
                    sort: sort.clone(),
                    ..CollectionQuery::default()
                },
            )
        })
        .expect("full sorted query")
        .expect("tasks collection")
        .records
        .into_iter()
        .map(|record| record.id)
        .collect::<Vec<_>>();

    let mut cursor = None;
    let mut paged = Vec::new();
    loop {
        let page = store
            .read_with(|conn| {
                query_collection_records(
                    conn,
                    WORKSPACE_ID,
                    "tasks",
                    &CollectionQuery {
                        sort: sort.clone(),
                        limit: 1,
                        cursor: cursor.clone(),
                        ..CollectionQuery::default()
                    },
                )
            })
            .expect("sorted page")
            .expect("tasks collection");
        paged.extend(page.records.into_iter().map(|record| record.id));
        let Some(next_cursor) = page.next_cursor else {
            break;
        };
        assert_eq!(next_cursor.sort_values.len(), sort.len());
        cursor = Some(next_cursor);
    }

    assert_eq!(
        paged, expected,
        "page boundaries must preserve sorted order"
    );
    assert_eq!(
        paged.iter().collect::<std::collections::HashSet<_>>().len(),
        paged.len(),
        "exclusive cursors must not repeat a boundary record"
    );
}

#[test]
fn pending_collection_adoptions_page_completely_past_the_protocol_collection_limit() {
    const PENDING: usize = 16_385;
    const PAGE_LIMIT: usize = 257;
    const EMPTY_SHA: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    let (_scratch, mut store) = fresh_store();
    let seeded = store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "INSERT INTO collections \
                 (workspace_id,version_id,collection_path,schema_path,schema_status,\
                  degradation_reasons_json) \
                 VALUES (?1,?2,'pending','pending/collection.yaml','valid','[]')",
                params![WORKSPACE_ID, VERSION_ID],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,0,'')",
                [EMPTY_SHA],
            )
            .map_err(StorageError::persist_public)?;
            for index in 0..PENDING {
                let object_id = format!("pending-object-{index:05}");
                let file_path = format!("pending/{index:05}.md");
                let record_id = format!("rec_{index:026}");
                tx.execute(
                    "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                     VALUES (?1,?2,?3)",
                    params![WORKSPACE_ID, object_id, index as i64],
                )
                .map_err(StorageError::persist_public)?;
                tx.execute(
                    "INSERT INTO snapshots \
                     (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,\
                      latest_moment_id,metadata_origin) \
                     VALUES (?1,?2,?3,?4,?5,?6,?7,'capture')",
                    params![
                        WORKSPACE_ID,
                        VERSION_ID,
                        object_id,
                        file_path,
                        EMPTY_SHA,
                        index as i64,
                        format!("pending-moment-{index:05}")
                    ],
                )
                .map_err(StorageError::persist_public)?;
                tx.execute(
                    "INSERT INTO collection_records \
                     (workspace_id,version_id,record_id,collection_path,file_path,object_id,\
                      adoption_state,index_initialized) \
                     VALUES (?1,?2,?3,'pending',?4,?5,'pending',0)",
                    params![WORKSPACE_ID, VERSION_ID, record_id, file_path, object_id],
                )
                .map_err(StorageError::persist_public)?;
            }
            Ok(())
        })
        .expect("seed pending adoption set");
    assert!(matches!(seeded, TxnOutcome::Committed(())));

    let mut cursor: Option<CollectionPendingAdoptionCursor> = None;
    let mut record_ids = Vec::with_capacity(PENDING);
    loop {
        let page = store
            .read_with(|conn| {
                list_pending_collection_adoptions(conn, WORKSPACE_ID, PAGE_LIMIT, cursor.as_ref())
            })
            .expect("pending adoption page");
        assert!(page.adoptions.len() <= PAGE_LIMIT);
        record_ids.extend(page.adoptions.into_iter().map(|entry| entry.record_id));
        let Some(next_cursor) = page.next_cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }

    assert_eq!(record_ids.len(), PENDING);
    assert!(record_ids.windows(2).all(|pair| pair[0] < pair[1]));
    record_ids.dedup();
    assert_eq!(record_ids.len(), PENDING);
}

#[test]
fn collection_query_refuses_more_than_eight_sort_clauses() {
    let (_scratch, store) = seeded_store();
    let error = store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "tasks",
                &CollectionQuery {
                    sort: (0..=MAX_COLLECTION_QUERY_SORTS)
                        .map(|index| CollectionSort {
                            field: format!("Sort {index}"),
                            direction: ViewSortDirection::Asc,
                        })
                        .collect(),
                    ..CollectionQuery::default()
                },
            )
        })
        .expect_err("the sort-clause bound must be enforced in the domain");
    assert!(matches!(
        error,
        DomainError::InvalidInput {
            reason: "collection query sort limit is exceeded"
        }
    ));
}

#[test]
fn button_field_keeps_a_stray_value_flagged_and_refuses_filter_sort_and_group() {
    let (_scratch, mut store) = fresh_store();
    write_text(
        &mut store,
        "invoices/collection.yaml",
        "fields:\n  Title:\n    type: text\n  Mark paid:\n    type: button\n",
        2,
    )
    .expect("invoice schema");
    write_text(
        &mut store,
        "invoices/twelve.md",
        &format!("---\nid: {FIRST_TASK_ID}\nTitle: Invoice 12\nMark paid: true\n---\n"),
        3,
    )
    .expect("invoice record");
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile invoices");

    let result = store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "invoices",
                &CollectionQuery {
                    sort: vec![CollectionSort {
                        field: "Title".into(),
                        direction: ViewSortDirection::Asc,
                    }],
                    ..CollectionQuery::default()
                },
            )
        })
        .expect("query invoices")
        .expect("invoice collection");
    assert_eq!(result.collection.status, CollectionSchemaStatus::Valid);
    let stray = result.records[0]
        .values
        .iter()
        .find(|value| value.field == "Mark paid")
        .expect("the stray value is kept");
    assert_eq!(stray.value, json!(true));
    assert_eq!(
        serde_json::to_value(&stray.validation).expect("serialize validation"),
        json!({ "status": "flagged", "reason": { "code": "expected-empty", "path": "" } })
    );

    let refused = |query: CollectionQuery| {
        store
            .read_with(|conn| query_collection_records(conn, WORKSPACE_ID, "invoices", &query))
            .expect_err("a button field has no value to query")
    };
    let filter = refused(CollectionQuery {
        filter: Some(CollectionFilter {
            field: "Mark paid".into(),
            operator: CollectionFilterOperator::Equals,
            value: json!(true),
        }),
        ..CollectionQuery::default()
    });
    assert!(matches!(
        filter,
        DomainError::InvalidInput {
            reason: "collection query cannot filter by a button field"
        }
    ));
    let sort = refused(CollectionQuery {
        sort: vec![CollectionSort {
            field: "Mark paid".into(),
            direction: ViewSortDirection::Desc,
        }],
        ..CollectionQuery::default()
    });
    assert!(matches!(
        sort,
        DomainError::InvalidInput {
            reason: "collection query cannot sort by a button field"
        }
    ));
    let group = refused(CollectionQuery {
        group_by: Some("Mark paid".into()),
        ..CollectionQuery::default()
    });
    assert!(matches!(
        group,
        DomainError::InvalidInput {
            reason: "collection query cannot group by a button field"
        }
    ));

    // Button names are cached by schema content, so a changed schema is
    // read again: once Mark paid is text, a sort on it works.
    write_text_for_object(
        &mut store,
        "invoices/collection.yaml",
        "fields:\n  Title:\n    type: text\n  Mark paid:\n    type: text\n",
        "object-2",
        "moment-4",
        4,
    )
    .expect("invoice schema without the button");
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile the changed schema");
    store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "invoices",
                &CollectionQuery {
                    sort: vec![CollectionSort {
                        field: "Mark paid".into(),
                        direction: ViewSortDirection::Asc,
                    }],
                    ..CollectionQuery::default()
                },
            )
        })
        .expect("a text field sorts")
        .expect("invoice collection");
}

#[test]
fn get_record_history_is_bounded_and_newest_first() {
    let (_scratch, mut store) = seeded_store();
    let seeded = store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            for (recorded_at_ms, next) in [(100_i64, "one"), (300, "three"), (200, "two")] {
                tx.execute(
                    "INSERT INTO collection_field_history \
                     (workspace_id,version_id,record_id,field_name,previous_value_json,\
                      next_value_json,author_origin_id,recorded_at_ms) \
                     VALUES (?1,?2,?3,'Title',NULL,?4,'origin',?5)",
                    params![
                        WORKSPACE_ID,
                        VERSION_ID,
                        FIRST_TASK_ID,
                        serde_json::to_string(next).expect("history JSON"),
                        recorded_at_ms
                    ],
                )
                .map_err(StorageError::persist_public)?;
            }
            Ok(())
        })
        .expect("seed history");
    assert!(matches!(seeded, TxnOutcome::Committed(())));
    let mut before_history_id = None;
    let mut recorded_at_ms = Vec::new();
    for _ in 0..3 {
        let record = store
            .read_with(|conn| {
                get_collection_record(
                    conn,
                    WORKSPACE_ID,
                    "tasks",
                    FIRST_TASK_ID,
                    1,
                    before_history_id,
                )
            })
            .expect("get history page")
            .expect("record exists");
        assert_eq!(record.history.len(), 1);
        let entry = &record.history[0];
        before_history_id = Some(entry.history_id);
        recorded_at_ms.push(entry.recorded_at_ms);
    }
    assert_eq!(recorded_at_ms, vec![300, 200, 100]);
}

#[test]
fn before_history_id_cursor_pages_equal_timestamps_without_gaps_or_duplicates() {
    let (_scratch, mut store) = seeded_store();
    let seeded = store
        .write_with(&NoFaults, |tx| -> Result<Vec<i64>, StorageError> {
            let mut history_ids = Vec::new();
            for field_name in ["Title", "Status", "Rank", "Owner"] {
                tx.execute(
                    "INSERT INTO collection_field_history \
                     (workspace_id,version_id,record_id,field_name,previous_value_json,\
                      next_value_json,author_origin_id,recorded_at_ms) \
                     VALUES (?1,?2,?3,?4,NULL,'\"next\"','origin',200)",
                    params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID, field_name],
                )
                .map_err(StorageError::persist_public)?;
                history_ids.push(tx.last_insert_rowid());
            }
            Ok(history_ids)
        })
        .expect("seed equal-timestamp history");
    let TxnOutcome::Committed(mut expected_history_ids) = seeded else {
        panic!("equal-timestamp history seed crashed");
    };
    expected_history_ids.sort_unstable_by(|left, right| right.cmp(left));

    let mut before_history_id = None;
    let mut pages = Vec::new();
    for _ in 0..3 {
        let record = store
            .read_with(|conn| {
                get_collection_record(
                    conn,
                    WORKSPACE_ID,
                    "tasks",
                    FIRST_TASK_ID,
                    2,
                    before_history_id,
                )
            })
            .expect("get equal-timestamp history page")
            .expect("record exists");
        before_history_id = record.history.last().map(|entry| entry.history_id);
        pages.push(record.history);
    }

    assert_eq!(
        pages.iter().map(Vec::len).collect::<Vec<_>>(),
        vec![2, 2, 0]
    );
    assert_eq!(
        pages[0].last().expect("first page boundary").recorded_at_ms,
        pages[1]
            .first()
            .expect("second page boundary")
            .recorded_at_ms
    );
    let history_ids = pages
        .iter()
        .flatten()
        .map(|entry| entry.history_id)
        .collect::<Vec<_>>();
    assert_eq!(
        history_ids, expected_history_ids,
        "history cursor skipped rows"
    );
    let mut unique_history_ids = history_ids.clone();
    unique_history_ids.sort_unstable();
    unique_history_ids.dedup();
    assert_eq!(
        unique_history_ids.len(),
        history_ids.len(),
        "history cursor duplicated rows"
    );
}

#[test]
fn over_limit_record_history_is_clamped_and_pages_without_gaps() {
    let (_scratch, mut store) = seeded_store();
    let seeded = store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            for recorded_at_ms in 0..=MAX_COLLECTION_HISTORY_LIMIT as i64 {
                tx.execute(
                    "INSERT INTO collection_field_history \
                     (workspace_id,version_id,record_id,field_name,previous_value_json,\
                      next_value_json,author_origin_id,recorded_at_ms) \
                     VALUES (?1,?2,?3,'Title',NULL,'\"next\"','origin',?4)",
                    params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID, recorded_at_ms],
                )
                .map_err(StorageError::persist_public)?;
            }
            Ok(())
        })
        .expect("seed over-limit history");
    assert!(matches!(seeded, TxnOutcome::Committed(())));

    let expected_count = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM collection_field_history \
                 WHERE workspace_id=?1 AND version_id=?2 AND record_id=?3",
                params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("count history");
    let expected_count = usize::try_from(expected_count).expect("non-negative history count");
    assert!(expected_count > MAX_COLLECTION_HISTORY_LIMIT);

    let mut before_history_id = None;
    let mut history = Vec::new();
    for _ in 0..=(expected_count / MAX_COLLECTION_HISTORY_LIMIT) + 1 {
        let record = store
            .read_with(|conn| {
                get_collection_record(
                    conn,
                    WORKSPACE_ID,
                    "tasks",
                    FIRST_TASK_ID,
                    usize::MAX,
                    before_history_id,
                )
            })
            .expect("get history page")
            .expect("record exists");
        assert!(record.history.len() <= MAX_COLLECTION_HISTORY_LIMIT);
        let Some(last) = record.history.last() else {
            break;
        };
        before_history_id = Some(last.history_id);
        history.extend(record.history);
    }

    assert_eq!(history.len(), expected_count);
    assert!(history.windows(2).all(|entries| {
        (entries[0].recorded_at_ms, entries[0].history_id)
            > (entries[1].recorded_at_ms, entries[1].history_id)
    }));
    let mut history_ids = history
        .iter()
        .map(|entry| entry.history_id)
        .collect::<Vec<_>>();
    history_ids.sort_unstable();
    history_ids.dedup();
    assert_eq!(history_ids.len(), expected_count);
}

#[test]
fn conflicted_files_surface_the_pending_record_in_query_and_get_record() {
    let (_scratch, mut store) = fresh_store();
    write_text(
        &mut store,
        "contended/collection.yaml",
        "fields:\n  Title:\n    type: text\n",
        2,
    )
    .expect("schema");
    for (path, sequence) in [("contended/first.md", 3_i64), ("contended/second.md", 4)] {
        write_text(
            &mut store,
            path,
            &format!("---\nid: {PERSON_ID}\nTitle: Contended\n---\n"),
            sequence,
        )
        .expect("contending record");
    }
    let seeded = store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "INSERT INTO collections \
                 (workspace_id,version_id,collection_path,schema_path,schema_status,\
                  degradation_reasons_json) \
                 VALUES (?1,?2,'contended','contended/collection.yaml','valid','[]')",
                params![WORKSPACE_ID, VERSION_ID],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO collection_records \
                 (workspace_id,version_id,record_id,collection_path,file_path,object_id,\
                  adoption_state,index_initialized) \
                 VALUES (?1,?2,?3,'contended','contended/absent.md','object-3',\
                         'adopted',0)",
                params![WORKSPACE_ID, VERSION_ID, PERSON_ID],
            )
            .map_err(StorageError::persist_public)?;
            for (conflict_id, path, object_id) in [
                ("contended-first", "contended/first.md", "object-3"),
                ("contended-second", "contended/second.md", "object-4"),
            ] {
                tx.execute(
                    "INSERT INTO conflicts (\
                        workspace_id, conflict_id, path, target_version_id, source_version_id, \
                        created_at_ms, updated_at_ms, status, chosen_from, metadata_origin, \
                        base_exists, base_path, current_exists, current_path, current_object_id, \
                        incoming_exists, incoming_path, incoming_object_id\
                     ) VALUES (?1, ?2, ?3, ?4, ?4, \
                        10, 10, 'open', 'current', 'sync', \
                        0, ?3, 1, ?3, ?5, 1, ?3, ?5)",
                    params![WORKSPACE_ID, conflict_id, path, VERSION_ID, object_id],
                )
                .map_err(StorageError::persist_public)?;
            }
            Ok(())
        })
        .expect("seed absent owner and conflicts");
    assert!(matches!(seeded, TxnOutcome::Committed(())));

    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile contended conflicted files");
    assert!(matches!(reconciled, TxnOutcome::Committed(_)));
    let bindings = store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT record_id,adoption_state FROM collection_records \
                 WHERE workspace_id=?1 AND version_id=?2 AND collection_path='contended' \
                 ORDER BY file_path",
            )?;
            statement
                .query_map(params![WORKSPACE_ID, VERSION_ID], |row| {
                    Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .expect("load contended bindings");
    assert_eq!(bindings.len(), 2);
    assert_eq!(
        bindings
            .iter()
            .filter(|(record_id, _)| record_id.as_deref() == Some(PERSON_ID))
            .count(),
        1
    );
    assert_eq!(
        bindings
            .iter()
            .filter(|(record_id, _)| record_id.is_none())
            .count(),
        1
    );
    assert!(
        bindings
            .iter()
            .all(|(_, state)| state == "deferred-conflict")
    );

    let queried = store
        .read_with(|conn| {
            query_collection_records(conn, WORKSPACE_ID, "contended", &CollectionQuery::default())
        })
        .expect("query contended collection")
        .expect("contended collection exists");
    assert_eq!(queried.records.len(), 1);
    assert!(queried.records[0].conflicted);

    let record = store
        .read_with(|conn| {
            get_collection_record(conn, WORKSPACE_ID, "contended", PERSON_ID, 10, None)
        })
        .expect("get contended record")
        .expect("contended record exists");
    assert!(record.record.conflicted);
}

#[test]
fn malformed_present_relation_target_preserves_inbound_relation_through_repair() {
    let (_scratch, mut store) = seeded_store();
    let adopted = store
        .write_with(&NoFaults, |tx| {
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "people/alice.md",
                PERSON_ID,
                "adopted",
            )
        })
        .expect("adopt relation target");
    assert!(matches!(adopted, TxnOutcome::Committed(())));

    let relation_count = |store: &EngineStore| {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM collection_relation_edges \
                     WHERE workspace_id=?1 AND version_id=?2 AND source_record_id=?3 \
                       AND target_record_id=?4",
                    params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID, PERSON_ID],
                    |row| row.get::<_, i64>(0),
                )
            })
            .expect("count inbound relation")
    };
    assert_eq!(relation_count(&store), 1);

    write_text_for_object(
        &mut store,
        "people/alice.md",
        "---\nid: [\n---\n",
        "object-3",
        "malformed-relation-target",
        50,
    )
    .expect("write malformed relation target");
    let malformed = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile malformed relation target");
    let TxnOutcome::Committed(malformed) = malformed else {
        panic!("malformed relation target reconciliation crashed");
    };
    assert!(
        malformed.relation_cleanups.is_empty(),
        "a present malformed target must defer dangling-relation cleanup: {:?}",
        malformed.relation_cleanups
    );
    assert_eq!(relation_count(&store), 1);

    write_text_for_object(
        &mut store,
        "people/alice.md",
        &format!("---\nid: {PERSON_ID}\ntitle: Alice repaired\n---\n"),
        "object-3",
        "repaired-relation-target",
        51,
    )
    .expect("repair relation target");
    let repaired = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile repaired relation target");
    let TxnOutcome::Committed(repaired) = repaired else {
        panic!("repaired relation target reconciliation crashed");
    };
    assert!(repaired.relation_cleanups.is_empty());
    assert_eq!(relation_count(&store), 1);
}

#[test]
fn malformed_relation_target_renamed_within_its_collection_preserves_inbound_relation() {
    const ORIGINAL_PATH: &str = "people/alice.md";
    const RENAMED_PATH: &str = "people/alice-renamed.md";
    const TARGET_OBJECT_ID: &str = "object-3";
    let (_scratch, mut store) = seeded_store();
    let adopted = store
        .write_with(&NoFaults, |tx| {
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                ORIGINAL_PATH,
                PERSON_ID,
                "adopted",
            )
        })
        .expect("adopt relation target before malformed rename");
    assert!(matches!(adopted, TxnOutcome::Committed(())));

    write_text_for_object(
        &mut store,
        ORIGINAL_PATH,
        "---\nid: [\n---\n",
        TARGET_OBJECT_ID,
        "malformed-target-before-rename",
        50,
    )
    .expect("write malformed relation target before rename");
    let malformed = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile malformed relation target before rename");
    let TxnOutcome::Committed(malformed) = malformed else {
        panic!("malformed relation target reconciliation crashed");
    };
    assert!(malformed.relation_cleanups.is_empty());

    VersionedTextStore::new(&mut store)
        .rename_text_file(
            &RenameTextFile {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: VERSION_ID.to_owned(),
                from_path: ORIGINAL_PATH.to_owned(),
                to_path: RENAMED_PATH.to_owned(),
                moment_id: "rename-malformed-relation-target".to_owned(),
                request_id: None,
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 51,
            },
            &NoFaults,
        )
        .expect("rename malformed relation target");
    let renamed = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile renamed malformed relation target");
    let TxnOutcome::Committed(renamed) = renamed else {
        panic!("renamed malformed relation target reconciliation crashed");
    };
    assert!(
        renamed.relation_cleanups.is_empty(),
        "a malformed target renamed within its collection still owns its id: {:?}",
        renamed.relation_cleanups
    );
    let relation_count = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM collection_relation_edges \
                 WHERE workspace_id=?1 AND version_id=?2 AND source_record_id=?3 \
                   AND target_record_id=?4",
                params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID, PERSON_ID],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("count relation after malformed target rename");
    assert_eq!(relation_count, 1);

    write_text_for_object(
        &mut store,
        RENAMED_PATH,
        &format!("---\nid: {PERSON_ID}\nName: Alice repaired\n---\n"),
        TARGET_OBJECT_ID,
        "repair-renamed-malformed-target",
        52,
    )
    .expect("repair renamed malformed target");
    let repaired = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile repaired renamed target");
    let TxnOutcome::Committed(repaired) = repaired else {
        panic!("repaired renamed target reconciliation crashed");
    };
    assert!(repaired.relation_cleanups.is_empty());
}

#[test]
fn valid_target_id_change_keeps_inbound_relations_on_the_engine_id() {
    const CHANGED_PERSON_ID: &str = "rec_ffffffffffffffffffffffffff";
    const NEW_REFERRER_ID: &str = "rec_yyyyyyyyyyyyyyyyyyyyyyyyyy";
    let (_scratch, mut store) = seeded_store();
    let adopted = store
        .write_with(&NoFaults, |tx| {
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "people/alice.md",
                PERSON_ID,
                "adopted",
            )
        })
        .expect("adopt relation target before id change");
    assert!(matches!(adopted, TxnOutcome::Committed(())));

    write_text_for_object(
        &mut store,
        "people/alice.md",
        &format!("---\nid: {CHANGED_PERSON_ID}\ntitle: Alice changed id\n---\n"),
        "object-3",
        "change-relation-target-id",
        50,
    )
    .expect("change relation target id");
    write_text_for_object(
        &mut store,
        "tasks/new-referrer.md",
        &format!(
            "---\nid: {NEW_REFERRER_ID}\nTitle: New referrer\nStatus: Todo\nRank: 2\nOwner: {CHANGED_PERSON_ID}\n---\n"
        ),
        "new-id-referrer-object",
        "new-id-referrer-moment",
        51,
    )
    .expect("write relation to changed id");

    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile changed relation target id");
    let TxnOutcome::Committed(reconciled) = reconciled else {
        panic!("changed relation target id reconciliation crashed");
    };
    assert!(
        reconciled.relation_cleanups.is_empty(),
        "the engine-owned id never departs, so no inbound relation needs cleanup: {:?}",
        reconciled.relation_cleanups
    );

    let tasks = store
        .read_with(|conn| {
            query_collection_records(
                conn,
                WORKSPACE_ID,
                "tasks",
                &CollectionQuery {
                    resolve_relations: true,
                    ..CollectionQuery::default()
                },
            )
        })
        .expect("query referrers after target id change")
        .expect("tasks collection");
    let original_owner = tasks
        .records
        .iter()
        .find(|record| record.id == FIRST_TASK_ID)
        .expect("original referrer")
        .values
        .iter()
        .find(|value| value.field == "Owner")
        .expect("original relation");
    assert_eq!(original_owner.resolved_relations.len(), 1);
    assert_eq!(original_owner.resolved_relations[0].record_id, PERSON_ID);
    let new_owner = tasks
        .records
        .iter()
        .find(|record| record.id == NEW_REFERRER_ID)
        .expect("new-id referrer")
        .values
        .iter()
        .find(|value| value.field == "Owner")
        .expect("new-id relation");
    // Until the engine write-back reverts the file, the raw frontmatter still
    // claims the replacement id, so the edge survives as an unindexed
    // placeholder: the raw id is its label because no record backs it.
    assert_eq!(new_owner.resolved_relations.len(), 1);
    assert_eq!(new_owner.resolved_relations[0].record_id, CHANGED_PERSON_ID);
    assert_eq!(
        new_owner.resolved_relations[0].label, CHANGED_PERSON_ID,
        "the user-supplied replacement id never becomes a record-backed resolution"
    );
}

#[test]
fn repaired_malformed_owner_keeps_its_id_from_a_same_id_copy() {
    const TARGET_PATH: &str = "people/alice.md";
    const TARGET_OBJECT_ID: &str = "object-3";
    const COPY_PATH: &str = "people/alice-copy.md";
    const COPY_OBJECT_ID: &str = "malformed-owner-copy-object";
    let (_scratch, mut store) = seeded_store();
    let adopted = store
        .write_with(&NoFaults, |tx| {
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                TARGET_PATH,
                PERSON_ID,
                "adopted",
            )
        })
        .expect("adopt target before malformed copy sequence");
    assert!(matches!(adopted, TxnOutcome::Committed(())));

    write_text_for_object(
        &mut store,
        TARGET_PATH,
        &format!("---\nid: {PERSON_ID}\nName: Alice revised\n---\n"),
        TARGET_OBJECT_ID,
        "valid-target-before-malformed-copy",
        50,
    )
    .expect("write valid target revision");
    let valid = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile valid target revision");
    assert!(matches!(valid, TxnOutcome::Committed(_)));

    write_text_for_object(
        &mut store,
        TARGET_PATH,
        "---\nid: [\n---\n",
        TARGET_OBJECT_ID,
        "malformed-owner-before-copy",
        51,
    )
    .expect("write malformed owner");
    let malformed = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile malformed owner");
    let TxnOutcome::Committed(malformed) = malformed else {
        panic!("malformed owner reconciliation crashed");
    };
    assert!(malformed.relation_cleanups.is_empty());

    write_text_for_object(
        &mut store,
        COPY_PATH,
        &format!("---\nid: {PERSON_ID}\nName: Alice copy\n---\n"),
        COPY_OBJECT_ID,
        "same-id-copy-while-owner-malformed",
        52,
    )
    .expect("write same-id copy while owner is malformed");
    let copied = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile same-id copy while owner is malformed");
    let TxnOutcome::Committed(copied) = copied else {
        panic!("same-id copy reconciliation crashed");
    };
    assert!(copied.relation_cleanups.is_empty());
    let copy_id_while_malformed = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT record_id FROM collection_records \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![WORKSPACE_ID, VERSION_ID, COPY_OBJECT_ID],
                |row| row.get::<_, String>(0),
            )
        })
        .expect("copy binding while original is malformed");
    assert_ne!(copy_id_while_malformed, PERSON_ID);

    write_text_for_object(
        &mut store,
        TARGET_PATH,
        &format!("---\nid: {PERSON_ID}\nName: Alice repaired\n---\n"),
        TARGET_OBJECT_ID,
        "repair-owner-after-same-id-copy",
        53,
    )
    .expect("repair original owner after copy");
    let repaired = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile repaired original owner after copy");
    let TxnOutcome::Committed(repaired) = repaired else {
        panic!("repaired original owner reconciliation crashed");
    };
    assert!(repaired.relation_cleanups.is_empty());
    let bindings = store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT record_id,object_id FROM collection_records \
                 WHERE workspace_id=?1 AND version_id=?2 AND collection_path='people' \
                 ORDER BY object_id",
            )?;
            statement
                .query_map(params![WORKSPACE_ID, VERSION_ID], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .expect("load repaired owner and copy bindings");
    let target = bindings
        .iter()
        .find(|(_, object_id)| object_id == TARGET_OBJECT_ID)
        .expect("repaired owner binding");
    assert_eq!(target.0, PERSON_ID);
    let copy = bindings
        .iter()
        .find(|(_, object_id)| object_id == COPY_OBJECT_ID)
        .expect("same-id copy binding after repair");
    assert_ne!(copy.0, PERSON_ID);
}

#[test]
fn resolving_a_conflict_after_an_id_change_keeps_the_engine_id_and_inbound_relation() {
    const TARGET_PATH: &str = "people/alice.md";
    const TARGET_OBJECT_ID: &str = "object-3";
    const CHANGED_ID: &str = "rec_ffffffffffffffffffffffffff";
    let (_scratch, mut store) = seeded_store();
    let adopted = store
        .write_with(&NoFaults, |tx| {
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                TARGET_PATH,
                PERSON_ID,
                "adopted",
            )
        })
        .expect("adopt target before conflict resolution sequence");
    assert!(matches!(adopted, TxnOutcome::Committed(())));

    let conflict_opened = store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "INSERT INTO conflicts (\
                    workspace_id, conflict_id, path, target_version_id, source_version_id, \
                    created_at_ms, updated_at_ms, status, chosen_from, metadata_origin, \
                    base_exists, base_path, current_exists, current_path, current_object_id, \
                    incoming_exists, incoming_path, incoming_object_id\
                 ) VALUES (?1, 'resolve-after-id-change', ?2, ?3, ?3, \
                    50, 50, 'open', 'current', 'sync', \
                    0, ?2, 1, ?2, ?4, 1, ?2, ?4)",
                params![WORKSPACE_ID, TARGET_PATH, VERSION_ID, TARGET_OBJECT_ID],
            )
            .map_err(StorageError::persist_public)?;
            Ok(())
        })
        .expect("open target conflict before id change");
    assert!(matches!(conflict_opened, TxnOutcome::Committed(())));

    write_text_for_object(
        &mut store,
        TARGET_PATH,
        &format!("---\nid: {CHANGED_ID}\ntitle: Alice changed\n---\n"),
        TARGET_OBJECT_ID,
        "change-id-before-conflict-resolution",
        51,
    )
    .expect("change target id while conflict is open");
    let changed = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile changed id while conflict is open");
    let TxnOutcome::Committed(changed) = changed else {
        panic!("changed-id conflict reconciliation crashed");
    };
    assert!(changed.relation_cleanups.is_empty());

    let conflict_resolved = store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "UPDATE conflicts SET status='resolved' \
                 WHERE workspace_id=?1 AND conflict_id='resolve-after-id-change'",
                [WORKSPACE_ID],
            )
            .map_err(StorageError::persist_public)?;
            Ok(())
        })
        .expect("resolve target conflict after id change");
    assert!(matches!(conflict_resolved, TxnOutcome::Committed(())));

    for pass in 0..2 {
        let resolved = store
            .write_with(&NoFaults, |tx| {
                reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
            })
            .expect("reconcile resolved changed-id target");
        let TxnOutcome::Committed(resolved) = resolved else {
            panic!("resolved changed-id reconciliation crashed");
        };
        assert!(
            resolved.relation_cleanups.is_empty(),
            "pass {pass}: the engine-owned id never departs, so nothing needs cleanup: {:?}",
            resolved.relation_cleanups
        );
    }
    let binding = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT record_id FROM collection_records \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![WORKSPACE_ID, VERSION_ID, TARGET_OBJECT_ID],
                |row| row.get::<_, String>(0),
            )
        })
        .expect("load resolved changed-id target binding");
    assert_eq!(
        binding, PERSON_ID,
        "the binding keeps its engine-owned id through the resolved conflict"
    );
    let relation_count = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM collection_relation_edges \
                 WHERE workspace_id=?1 AND version_id=?2 AND source_record_id=?3 \
                   AND target_record_id=?4",
                params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID, PERSON_ID],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("count original relation that stays valid");
    assert_eq!(relation_count, 1);
}

#[test]
fn conflicted_owner_keeps_its_ids_when_changed_frontmatter_is_copied_then_the_file_moves() {
    const TARGET_PATH: &str = "people/alice.md";
    const RENAMED_PATH: &str = "people/alice-renamed.md";
    const TARGET_OBJECT_ID: &str = "object-3";
    const COPY_PATH: &str = "people/alice-copy.md";
    const COPY_OBJECT_ID: &str = "changed-id-conflict-copy";
    const CHANGED_ID: &str = "rec_ffffffffffffffffffffffffff";
    let (_scratch, mut store) = seeded_store();
    let adopted = store
        .write_with(&NoFaults, |tx| {
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                TARGET_PATH,
                PERSON_ID,
                "adopted",
            )
        })
        .expect("adopt target before conflict sequence");
    assert!(matches!(adopted, TxnOutcome::Committed(())));

    let conflict_opened = store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "INSERT INTO conflicts (\
                    workspace_id, conflict_id, path, target_version_id, source_version_id, \
                    created_at_ms, updated_at_ms, status, chosen_from, metadata_origin, \
                    base_exists, base_path, current_exists, current_path, current_object_id, \
                    incoming_exists, incoming_path, incoming_object_id\
                 ) VALUES (?1, 'changed-id-rename-conflict', ?2, ?3, ?3, \
                    50, 50, 'open', 'current', 'sync', \
                    0, ?2, 1, ?2, ?4, 1, ?2, ?4)",
                params![WORKSPACE_ID, TARGET_PATH, VERSION_ID, TARGET_OBJECT_ID],
            )
            .map_err(StorageError::persist_public)?;
            Ok(())
        })
        .expect("open target conflict");
    assert!(matches!(conflict_opened, TxnOutcome::Committed(())));

    write_text_for_object(
        &mut store,
        TARGET_PATH,
        &format!("---\nid: {CHANGED_ID}\ntitle: Alice changed\n---\n"),
        TARGET_OBJECT_ID,
        "change-id-under-conflict",
        51,
    )
    .expect("change target id under conflict");
    let changed = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile changed id under conflict");
    let TxnOutcome::Committed(changed) = changed else {
        panic!("changed-id conflict reconciliation crashed");
    };
    assert!(changed.relation_cleanups.is_empty());

    write_text_for_object(
        &mut store,
        COPY_PATH,
        &format!("---\nid: {CHANGED_ID}\ntitle: Alice copy\n---\n"),
        COPY_OBJECT_ID,
        "copy-changed-id-under-conflict",
        52,
    )
    .expect("copy changed id under conflict");
    let copied = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile changed-id copy under conflict");
    let TxnOutcome::Committed(copied) = copied else {
        panic!("changed-id copy conflict reconciliation crashed");
    };
    assert!(copied.relation_cleanups.is_empty());
    let copied_binding = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT record_id FROM collection_records \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![WORKSPACE_ID, VERSION_ID, COPY_OBJECT_ID],
                |row| row.get::<_, String>(0),
            )
        })
        .expect("load changed-id copy binding");
    assert_ne!(copied_binding, CHANGED_ID);

    VersionedTextStore::new(&mut store)
        .rename_text_file(
            &RenameTextFile {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: VERSION_ID.to_owned(),
                from_path: TARGET_PATH.to_owned(),
                to_path: RENAMED_PATH.to_owned(),
                moment_id: "rename-changed-id-conflict".to_owned(),
                request_id: None,
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 53,
            },
            &NoFaults,
        )
        .expect("rename changed-id conflicted target");
    let renamed = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile renamed changed-id conflicted target");
    let TxnOutcome::Committed(renamed) = renamed else {
        panic!("renamed changed-id conflict reconciliation crashed");
    };
    assert!(
        renamed.relation_cleanups.is_empty(),
        "the open conflict keeps the original record id attached to its object: {:?}",
        renamed.relation_cleanups
    );
    let binding = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT record_id,file_path,object_id FROM collection_records \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![WORKSPACE_ID, VERSION_ID, TARGET_OBJECT_ID],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
        })
        .expect("load renamed conflicted binding");
    assert_eq!(
        binding,
        (
            PERSON_ID.to_owned(),
            RENAMED_PATH.to_owned(),
            TARGET_OBJECT_ID.to_owned(),
        )
    );
    let relation_count = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM collection_relation_edges \
                 WHERE workspace_id=?1 AND version_id=?2 AND source_record_id=?3 \
                   AND target_record_id=?4",
                params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID, PERSON_ID],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("count relation after conflicted target rename");
    assert_eq!(relation_count, 1);
}

#[test]
fn malformed_conflicted_owner_keeps_its_changed_id_reserved_from_an_existing_copy() {
    const TARGET_PATH: &str = "people/alice.md";
    const TARGET_OBJECT_ID: &str = "object-3";
    const COPY_PATH: &str = "people/alice-copy-malformed.md";
    const COPY_OBJECT_ID: &str = "changed-id-conflict-malformed-copy";
    const CHANGED_ID: &str = "rec_ffffffffffffffffffffffffff";
    let (_scratch, mut store) = seeded_store();
    let adopted = store
        .write_with(&NoFaults, |tx| {
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                TARGET_PATH,
                PERSON_ID,
                "adopted",
            )
        })
        .expect("adopt target before malformed conflict sequence");
    assert!(matches!(adopted, TxnOutcome::Committed(())));

    let conflict_opened = store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "INSERT INTO conflicts (\
                    workspace_id, conflict_id, path, target_version_id, source_version_id, \
                    created_at_ms, updated_at_ms, status, chosen_from, metadata_origin, \
                    base_exists, base_path, current_exists, current_path, current_object_id, \
                    incoming_exists, incoming_path, incoming_object_id\
                 ) VALUES (?1, 'changed-id-malformed-conflict', ?2, ?3, ?3, \
                    50, 50, 'open', 'current', 'sync', \
                    0, ?2, 1, ?2, ?4, 1, ?2, ?4)",
                params![WORKSPACE_ID, TARGET_PATH, VERSION_ID, TARGET_OBJECT_ID],
            )
            .map_err(StorageError::persist_public)?;
            Ok(())
        })
        .expect("open target conflict before malformed sequence");
    assert!(matches!(conflict_opened, TxnOutcome::Committed(())));

    write_text_for_object(
        &mut store,
        TARGET_PATH,
        &format!("---\nid: {CHANGED_ID}\ntitle: Alice changed\n---\n"),
        TARGET_OBJECT_ID,
        "change-id-before-malformed-conflict",
        51,
    )
    .expect("change target id under conflict");
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile changed id under conflict");

    write_text_for_object(
        &mut store,
        COPY_PATH,
        &format!("---\nid: {CHANGED_ID}\ntitle: Alice copy\n---\n"),
        COPY_OBJECT_ID,
        "copy-changed-id-before-owner-malformed",
        52,
    )
    .expect("copy changed id before owner becomes malformed");
    store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile changed-id copy");

    write_text_for_object(
        &mut store,
        TARGET_PATH,
        "---\nid: [\n---\n",
        TARGET_OBJECT_ID,
        "malform-changed-id-conflicted-owner",
        53,
    )
    .expect("make conflicted changed-id owner malformed");
    let malformed = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile malformed conflicted owner");
    let TxnOutcome::Committed(malformed) = malformed else {
        panic!("malformed conflicted owner reconciliation crashed");
    };
    assert!(malformed.relation_cleanups.is_empty());

    let copy_record_id = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT record_id FROM collection_records \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![WORKSPACE_ID, VERSION_ID, COPY_OBJECT_ID],
                |row| row.get::<_, String>(0),
            )
        })
        .expect("load copy binding after owner becomes malformed");
    assert_ne!(
        copy_record_id, CHANGED_ID,
        "the copy cannot take the changed id while its original owner object remains"
    );
}

#[test]
fn fresh_conflicted_record_keeps_its_id_and_relation_until_conflict_resolution() {
    const TARGET_ID: &str = "rec_ffffffffffffffffffffffffff";
    const TARGET_PATH: &str = "people/fresh.md";
    const TARGET_OBJECT_ID: &str = "fresh-target-object";
    let (_scratch, mut store) = seeded_store();
    write_text_for_object(
        &mut store,
        TARGET_PATH,
        &format!("---\nid: {TARGET_ID}\nName: Fresh target\n---\n"),
        TARGET_OBJECT_ID,
        "fresh-target-moment",
        50,
    )
    .expect("fresh target record");
    write_text_for_object(
        &mut store,
        "tasks/alpha.md",
        &format!(
            "---\nid: {FIRST_TASK_ID}\nTitle: Alpha\nStatus: Broken\nRank: 1\nOwner: {TARGET_ID}\n---\n"
        ),
        "object-6",
        "retarget-fresh-record",
        51,
    )
    .expect("relation to fresh target");
    let indexed = store
        .write_with(&NoFaults, |tx| {
            synchronize_collection_frontmatter_index_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                "object-6",
                &json!({
                    "id": FIRST_TASK_ID,
                    "Title": "Alpha",
                    "Status": "Broken",
                    "Rank": 1,
                    "Owner": TARGET_ID,
                }),
            )
        })
        .expect("index relation to fresh target");
    assert!(matches!(indexed, TxnOutcome::Committed(())));
    let seeded = store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "INSERT INTO conflicts (\
                    workspace_id, conflict_id, path, target_version_id, source_version_id, \
                    created_at_ms, updated_at_ms, status, chosen_from, metadata_origin, \
                    base_exists, base_path, current_exists, current_path, current_object_id, \
                    incoming_exists, incoming_path, incoming_object_id\
                 ) VALUES (?1, 'fresh-target-conflict', ?2, ?3, ?3, \
                    52, 52, 'open', 'current', 'sync', \
                    0, ?2, 1, ?2, ?4, 1, ?2, ?4)",
                params![WORKSPACE_ID, TARGET_PATH, VERSION_ID, TARGET_OBJECT_ID],
            )
            .map_err(StorageError::persist_public)?;
            Ok(())
        })
        .expect("seed target conflict");
    assert!(matches!(seeded, TxnOutcome::Committed(())));

    let conflicted = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile fresh conflicted target");
    let TxnOutcome::Committed(conflicted) = conflicted else {
        panic!("fresh conflicted reconciliation crashed");
    };
    assert!(conflicted.relation_cleanups.is_empty());
    let binding = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT record_id,adoption_state FROM collection_records \
                 WHERE workspace_id=?1 AND version_id=?2 AND file_path=?3",
                params![WORKSPACE_ID, VERSION_ID, TARGET_PATH],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
            )
        })
        .expect("fresh conflicted target binding");
    assert_eq!(
        binding,
        (Some(TARGET_ID.to_owned()), "deferred-conflict".to_owned())
    );

    let relation_count = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM collection_relation_edges \
                 WHERE workspace_id=?1 AND version_id=?2 AND source_record_id=?3 \
                   AND target_record_id=?4",
                params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID, TARGET_ID],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("source relation survives conflict");
    assert_eq!(relation_count, 1);

    let conflict_resolved = store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "UPDATE conflicts SET status='resolved' \
                 WHERE workspace_id=?1 AND conflict_id='fresh-target-conflict'",
                [WORKSPACE_ID],
            )
            .map_err(StorageError::persist_public)?;
            Ok(())
        })
        .expect("resolve target conflict");
    assert!(matches!(conflict_resolved, TxnOutcome::Committed(())));
    let cleared = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile after target conflict clears");
    let TxnOutcome::Committed(cleared) = cleared else {
        panic!("cleared target reconciliation crashed");
    };
    assert!(
        cleared
            .adoptions
            .iter()
            .any(|candidate| candidate.record_id == TARGET_ID)
    );
    let adopted = store
        .write_with(&NoFaults, |tx| {
            set_collection_adoption_state_in_tx(
                tx,
                WORKSPACE_ID,
                VERSION_ID,
                TARGET_PATH,
                TARGET_ID,
                "adopted",
            )
        })
        .expect("finish target adoption");
    assert!(matches!(adopted, TxnOutcome::Committed(())));
    let reconciled_again = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("second reconcile after target conflict clears");
    assert!(matches!(reconciled_again, TxnOutcome::Committed(_)));
    let relation_count = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM collection_relation_edges \
                 WHERE workspace_id=?1 AND version_id=?2 AND source_record_id=?3 \
                   AND target_record_id=?4",
                params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID, TARGET_ID],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("source relation survives the resolved conflict reconcile");
    assert_eq!(relation_count, 1);
    let resolved = store
        .read_with(|conn| get_collection_record(conn, WORKSPACE_ID, "people", TARGET_ID, 10, None))
        .expect("get resolved target")
        .expect("resolved target remains indexed");
    assert!(!resolved.record.conflicted);
}

#[test]
fn root_schema_is_visible_as_degraded_but_does_not_collect_root_markdown() {
    let (_scratch, mut store) = fresh_store();
    write_text(
        &mut store,
        "collection.yaml",
        "fields:\n  Title:\n    type: text\n",
        2,
    )
    .expect("root schema");
    write_text(&mut store, "root.md", "---\nTitle: Root record\n---\n", 3).expect("root markdown");

    let reconciled = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile root schema");
    let TxnOutcome::Committed(reconciled) = reconciled else {
        panic!("root-schema reconcile crashed");
    };
    assert!(reconciled.adoptions.is_empty());
    let listed = store
        .read_with(|conn| list_collections(conn, WORKSPACE_ID, MAX_COLLECTION_QUERY_LIMIT, None))
        .expect("list collections");
    let root_status = listed
        .collections
        .iter()
        .find(|collection| collection.path == ".")
        .expect("root schema status is visible");
    assert_eq!(root_status.status, CollectionSchemaStatus::Degraded);
    assert_eq!(
        serde_json::to_value(&root_status.reasons).expect("serialize reasons"),
        json!([{"code": "root-collection-unsupported", "path": ""}])
    );
    assert!(
        store
            .read_with(|conn| get_collection(conn, WORKSPACE_ID, "."))
            .expect("get sentinel")
            .is_none(),
        "the diagnostic sentinel is not an addressable collection"
    );
    assert!(
        store
            .read_with(|conn| {
                query_collection_records(conn, WORKSPACE_ID, ".", &CollectionQuery::default())
            })
            .expect("query sentinel")
            .is_none(),
        "the diagnostic sentinel cannot be queried as a collection"
    );
    let relation_to_sentinel = parse_collection_schema(
        "fields:\n  Root:\n    type: relation\n    collection: .\n    many: false\n",
    );
    assert!(relation_to_sentinel.reasons.iter().any(|reason| {
        reason.code == CollectionSchemaReasonCode::InvalidRelationTarget
            && reason.path == "/fields/Root/collection"
    }));
    let root_binding_count = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM collection_records \
                 WHERE workspace_id=?1 AND version_id=?2 AND file_path='root.md'",
                params![WORKSPACE_ID, VERSION_ID],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("count root bindings");
    assert_eq!(root_binding_count, 0);
}

#[test]
fn every_read_answers_for_a_degraded_collection() {
    let (_scratch, store) = seeded_store();
    let listed = store
        .read_with(|conn| list_collections(conn, WORKSPACE_ID, MAX_COLLECTION_QUERY_LIMIT, None))
        .expect("list collections");
    let summary = listed
        .collections
        .iter()
        .find(|collection| collection.path == "broken")
        .expect("degraded collection listed");
    assert_eq!(summary.status, CollectionSchemaStatus::Degraded);
    assert_eq!(
        summary.reasons[0].code,
        CollectionSchemaReasonCode::InvalidYaml
    );

    let collection = store
        .read_with(|conn| get_collection(conn, WORKSPACE_ID, "broken"))
        .expect("get collection")
        .expect("degraded collection exists");
    assert_eq!(collection.status, CollectionSchemaStatus::Degraded);
    assert_eq!(collection.record_count, 1);

    let query = store
        .read_with(|conn| {
            query_collection_records(conn, WORKSPACE_ID, "broken", &CollectionQuery::default())
        })
        .expect("query degraded collection")
        .expect("degraded collection exists");
    assert_eq!(query.collection.status, CollectionSchemaStatus::Degraded);
    assert_eq!(query.records.len(), 1);
    assert!(matches!(
        query.records[0].values[0].validation,
        CollectionIndexedValueValidation::Untyped
    ));

    let record = store
        .read_with(|conn| {
            get_collection_record(conn, WORKSPACE_ID, "broken", DEGRADED_RECORD_ID, 10, None)
        })
        .expect("get degraded record")
        .expect("degraded record exists");
    assert_eq!(record.collection.status, CollectionSchemaStatus::Degraded);
    assert_eq!(record.record.values[0].value, json!("survives"));
}
