use dohc_engine_domain::{
    CollectionFilter, CollectionFilterOperator, CollectionIndexedValueValidation,
    CollectionPendingAdoptionCursor, CollectionQuery, CollectionSchemaReasonCode,
    CollectionSchemaStatus, CollectionSort, DomainError, MAX_COLLECTION_HISTORY_LIMIT,
    MAX_COLLECTION_QUERY_SORTS, NoFaults, TxnOutcome, VersionedTextStore, ViewSortDirection,
    WriteText, get_collection, get_collection_record, list_collections,
    list_pending_collection_adoptions, parse_collection_schema, query_collection_records,
    reconcile_collections_in_tx, set_collection_adoption_state_in_tx,
    synchronize_collection_frontmatter_index_in_tx,
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
    let db = scratch.engine_db_path().expect("engine db path");
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
            get_collection_record(conn, WORKSPACE_ID, "broken", DEGRADED_RECORD_ID, 10, None)
        })
        .expect("get degraded record")
        .expect("degraded record exists");
    assert_eq!(record.collection.status, CollectionSchemaStatus::Degraded);
    assert_eq!(record.record.values[0].value, json!("survives"));
}
