use dohc_engine_domain::{
    CollectionFilter, CollectionFilterOperator, CollectionIndexedValueValidation, CollectionQuery,
    CollectionSchemaReasonCode, CollectionSchemaStatus, CollectionSort, DomainError,
    MAX_COLLECTION_HISTORY_LIMIT, NoFaults, TxnOutcome, VersionedTextStore, ViewSortDirection,
    WriteText, get_collection, get_collection_record, list_collections, parse_collection_schema,
    query_collection_records, reconcile_collections_in_tx,
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

fn fresh_store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("engine db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WORKSPACE_ID, VERSION_ID, 1, &NoFaults)
        .expect("main version");
    (scratch, store)
}

fn seeded_store() -> (ScratchDir, EngineStore) {
    let (scratch, mut store) = fresh_store();

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
fn over_limit_record_history_request_is_clamped_to_the_maximum() {
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

    let record = store
        .read_with(|conn| {
            get_collection_record(conn, WORKSPACE_ID, "tasks", FIRST_TASK_ID, usize::MAX)
        })
        .expect("get record")
        .expect("record exists");
    assert_eq!(record.history.len(), MAX_COLLECTION_HISTORY_LIMIT);
    assert_eq!(
        record.history.first().map(|entry| entry.recorded_at_ms),
        Some(MAX_COLLECTION_HISTORY_LIMIT as i64)
    );
}

#[test]
fn conflicted_files_contending_for_an_absent_owner_id_leave_one_pending() {
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
        .read_with(|conn| list_collections(conn, WORKSPACE_ID))
        .expect("list collections");
    let root_status = listed
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
