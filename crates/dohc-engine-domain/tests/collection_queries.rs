use std::collections::{BTreeMap, BTreeSet};

use dohc_engine_domain::{
    CollectionFilter, CollectionFilterOperator, CollectionIndexedValueValidation, CollectionQuery,
    CollectionSchemaReasonCode, CollectionSchemaStatus, CollectionSort, DeleteTextFile,
    DomainError, FieldDefinition, MAX_COLLECTION_QUERY_LIMIT, NoFaults, RenameTextFile, TxnOutcome,
    VersionedTextStore, ViewSortDirection, WriteText, get_collection, get_collection_record,
    index_collection_frontmatter_apply_in_tx, list_collections, query_collection_records,
    reconcile_collections_in_tx, set_collection_adoption_state_in_tx,
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
    let mut store = dohc_engine_testkit::open_empty_store(&db, 1);
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, VERSION_ID, 1, &NoFaults)
        .expect("main version");
    (scratch, store)
}

#[test]
fn unsupported_collection_version_does_not_bind_or_adopt_records() {
    let (_scratch, mut store) = fresh_store();
    write_text(
        &mut store,
        "tasks/collection.yaml",
        "version: 2\nname: Tasks\n",
        2,
    )
    .expect("schema");
    write_text(&mut store, "tasks/new.md", "---\nTitle: New\n---\n", 3).expect("record");
    write_text(
        &mut store,
        "tasks/existing.md",
        &format!("---\nid: {FIRST_TASK_ID}\n---\n"),
        4,
    )
    .expect("record with id");
    let result = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile");
    let TxnOutcome::Committed(result) = result else {
        panic!("reconciliation crashed")
    };
    assert!(result.adoptions.is_empty());
    let collection = store
        .read_with(|conn| get_collection(conn, WORKSPACE_ID, "tasks"))
        .expect("read collection")
        .expect("diagnostic");
    assert_eq!(collection.record_count, 0);
    assert_eq!(
        collection.reasons[0].code,
        CollectionSchemaReasonCode::UnsupportedVersion
    );
    let error = store
        .read_with(|conn| {
            get_collection_record(conn, WORKSPACE_ID, "tasks", FIRST_TASK_ID, 10, None)
        })
        .expect_err("unsupported reader");
    assert!(
        error
            .to_string()
            .contains("collection.yaml uses a newer version. Update dohc")
    );
    write_text_for_object(
        &mut store,
        "tasks/collection.yaml",
        "version: 1\nname: Tasks\n",
        "object-2",
        "moment-5",
        5,
    )
    .expect("supported schema");
    let result = store
        .write_with(&NoFaults, |tx| {
            reconcile_collections_in_tx(tx, WORKSPACE_ID, VERSION_ID)
        })
        .expect("reconcile supported");
    let TxnOutcome::Committed(result) = result else {
        panic!("reconciliation crashed")
    };
    assert_eq!(result.adoptions.len(), 2);
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
fn get_record_history_reads_link_author_without_an_account_actor() {
    let (_scratch, mut store) = seeded_store();
    let author = json!({"kind":"link","grantId":"grant","grantGeneration":2,"publicPrincipalId":"public-holder"});
    store.write_with(&NoFaults, |tx| -> Result<(), StorageError> {
        tx.execute("INSERT INTO collection_field_history(workspace_id,version_id,record_id,field_name,recorded_at_ms,link_author_json) VALUES (?1,?2,?3,'Status',100,?4)",
            params![WORKSPACE_ID, VERSION_ID, FIRST_TASK_ID, author.to_string()]).map_err(StorageError::persist_public)?;
        Ok(())
    }).unwrap();
    let details = store
        .read_with(|conn| {
            get_collection_record(conn, WORKSPACE_ID, "tasks", FIRST_TASK_ID, 10, None)
        })
        .unwrap()
        .unwrap();
    let row = serde_json::to_value(&details.history[0]).unwrap();
    assert_eq!(row["linkAuthor"], author);
    assert_eq!(row["actorKind"], serde_json::Value::Null);
    assert_eq!(row["authorOriginId"], serde_json::Value::Null);
    for share_id in ["recipient-share", "link-holder-share"] {
        store.write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute("INSERT INTO share_view_cursors(workspace_id,share_id,cursor) VALUES (?1,?2,'0')", params![WORKSPACE_ID, share_id]).map_err(StorageError::persist_public)?;
            // A received binding must not read even residual owner history.
            tx.execute("UPDATE collection_field_history SET link_author_json='invalid'", []).map_err(StorageError::persist_public)?;
            Ok(())
        }).unwrap();
        let received = store
            .read_with(|conn| {
                get_collection_record(conn, WORKSPACE_ID, "tasks", FIRST_TASK_ID, 10, Some(-1))
            })
            .unwrap()
            .unwrap();
        assert!(received.history.is_empty(), "{share_id}");
        assert_eq!(received.next_before_history_id, None);
        store
            .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
                tx.execute("DELETE FROM share_view_cursors", [])
                    .map_err(StorageError::persist_public)?;
                Ok(())
            })
            .unwrap();
    }
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
