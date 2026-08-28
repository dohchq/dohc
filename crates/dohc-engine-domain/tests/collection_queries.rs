use dohc_engine_domain::{
    CollectionFilter, CollectionFilterOperator, CollectionIndexedValueValidation, CollectionQuery,
    CollectionSchemaReasonCode, CollectionSchemaStatus, CollectionSort, DomainError, NoFaults,
    TxnOutcome, VersionedTextStore, ViewSortDirection, WriteText, get_collection,
    get_collection_record, list_collections, query_collection_records, reconcile_collections_in_tx,
};
use dohc_engine_storage::{EngineStore, StorageError};
use dohc_engine_testkit::ScratchDir;
use rusqlite::params;
use serde_json::json;

const WORKSPACE_ID: &str = "collection-query-workspace";
const VERSION_ID: &str = "main";
const PERSON_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECOND_PERSON_ID: &str = "rec_eeeeeeeeeeeeeeeeeeeeeeeeee";
const FIRST_TASK_ID: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const SECOND_TASK_ID: &str = "rec_cccccccccccccccccccccccccc";
const DEGRADED_RECORD_ID: &str = "rec_dddddddddddddddddddddddddd";

fn write_text(
    store: &mut EngineStore,
    path: &str,
    text: &str,
    sequence: i64,
) -> Result<(), DomainError> {
    VersionedTextStore::new(store).write_text(
        &WriteText {
            workspace_id: WORKSPACE_ID.to_owned(),
            version_id: VERSION_ID.to_owned(),
            object_id: format!("object-{sequence}"),
            path: path.to_owned(),
            text: text.to_owned(),
            moment_id: format!("moment-{sequence}"),
            metadata_origin: "test".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: sequence,
            request_id: None,
        },
        &NoFaults,
    )?;
    Ok(())
}

fn seeded_store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, VERSION_ID, 1, &NoFaults)
        .expect("main version");

    write_text(
        &mut store,
        "people/collection.yaml",
        "fields:\n  Title:\n    type: text\n  Notes:\n    type: text\n",
        2,
    )
    .expect("people schema");
    write_text(
        &mut store,
        "people/alice.md",
        &format!("---\nid: {PERSON_ID}\nTitle: Alice\n---\n"),
        3,
    )
    .expect("person record");
    write_text(
        &mut store,
        "people/bob.md",
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
    let record = store
        .read_with(|conn| get_collection_record(conn, WORKSPACE_ID, "tasks", FIRST_TASK_ID, 2))
        .expect("get record")
        .expect("record exists");
    assert_eq!(
        record
            .history
            .iter()
            .map(|entry| entry.recorded_at_ms)
            .collect::<Vec<_>>(),
        vec![300, 200]
    );
    assert_eq!(record.history[0].next.value, Some(json!("three")));
}

#[test]
fn every_read_answers_for_a_degraded_collection() {
    let (_scratch, store) = seeded_store();
    let listed = store
        .read_with(|conn| list_collections(conn, WORKSPACE_ID))
        .expect("list collections");
    let summary = listed
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
            get_collection_record(conn, WORKSPACE_ID, "broken", DEGRADED_RECORD_ID, 10)
        })
        .expect("get degraded record")
        .expect("degraded record exists");
    assert_eq!(record.collection.status, CollectionSchemaStatus::Degraded);
    assert_eq!(record.record.values[0].value, json!("survives"));
}
