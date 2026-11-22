use super::rank::{RRF_K, ScoreDocument, rrf_fuse, score_document_bm25f};
use super::text::{parse_query, render_field_value_json, stem_term};
use super::*;
use crate::links::PARSER_GENERATION;
use crate::search::{ensure_search_index_for_version, search_workspace_page};
use dohc_engine_domain::{
    ChatActorKind, ChatChannelKind, ChatThreadLane, CreateFileThread, LinkedChatStore, SendMessage,
    StartChannelThread, VersionedTextStore, WriteBinary, WriteText,
};
use dohc_engine_storage::{EngineStore, NoFaults, StorageError};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::time::Instant;

const WS: &str = "ws-retrieval";
const VER: &str = "main";

fn setup_store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db path");
    let mut store = EngineStore::open(&db, 1).expect("open store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, VER, 1, &NoFaults)
        .expect("ensure main");
    (scratch, store)
}

fn write_text(store: &mut EngineStore, object_id: &str, path: &str, text: &str, ts: i64) {
    VersionedTextStore::new(store)
        .write_text(
            &WriteText {
                workspace_id: WS.into(),
                version_id: VER.into(),
                object_id: object_id.into(),
                path: path.into(),
                text: text.into(),
                moment_id: format!("m-{object_id}-{ts}"),
                metadata_origin: "test".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: ts,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("write text");
}

fn write_binary(store: &mut EngineStore, object_id: &str, path: &str, bytes: &[u8], ts: i64) {
    VersionedTextStore::new(store)
        .write_binary(
            &WriteBinary {
                workspace_id: WS.into(),
                version_id: VER.into(),
                object_id: object_id.into(),
                path: path.into(),
                bytes: bytes.to_vec(),
                moment_id: format!("mb-{object_id}-{ts}"),
                metadata_origin: "test".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: ts,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("write binary");
}

fn rebuild_search_index(store: &mut EngineStore, root: &Path) {
    store
        .mutate_with_connection(|conn| {
            ensure_search_index_for_version(conn, root, WS, VER, 100, &NoFaults)
        })
        .expect("ensure search index");
}

fn drain_links_sync(store: &mut EngineStore) {
    // Seed and drain every pending link synchronously in test fixtures.
    while crate::links::reseed_step(store).expect("reseed") {}
    loop {
        let seeded = store
            .read_with(|c| {
                c.query_row(
                    "SELECT EXISTS(SELECT 1 FROM link_index_state WHERE seed_phase IN ('deferred','aliases'))",
                    [],
                    |r| r.get::<_, bool>(0),
                )
            })
            .expect("check seed");
        if !seeded {
            break;
        }
        store
            .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
                let mut stmt = tx
                    .prepare(
                        "SELECT path, object_id FROM path_aliases WHERE workspace_id=?1 AND version_id=?2",
                    )
                    .map_err(StorageError::corrupt_public)?;
                let aliases: Vec<(String, String)> = stmt
                    .query_map(params![WS, VER], |r| Ok((r.get(0)?, r.get(1)?)))
                    .map_err(StorageError::corrupt_public)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(StorageError::corrupt_public)?;
                for (path, object_id) in aliases {
                    tx.execute(
                        "INSERT INTO link_aliases(workspace_id,version_id,object_id,path) VALUES(?1,?2,?3,?4) \
                         ON CONFLICT(workspace_id,version_id,path) DO UPDATE SET object_id=excluded.object_id",
                        params![WS, VER, object_id, path],
                    )
                    .map_err(StorageError::corrupt_public)?;
                    tx.execute(
                        "INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES(?1,?2,?3,1) \
                         ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1,retry_after_ms=0",
                        params![WS, VER, object_id],
                    )
                    .map_err(StorageError::corrupt_public)?;
                }
                tx.execute(
                    "UPDATE link_index_state SET parser_generation=?3, seed_phase='draining', seed_after_path='' \
                     WHERE workspace_id=?1 AND version_id=?2",
                    params![WS, VER, PARSER_GENERATION],
                )
                .map_err(StorageError::corrupt_public)?;
                Ok(())
            })
            .expect("seed aliases");
    }
    while let Some((work, head)) = crate::links::prepare(store).expect("prepare link") {
        // Parse and commit via link_sources/links directly through the production Staged stepper.
        let mut staged = crate::links::Staged::new(
            // Use the production parser by keeping a small helper on crate::links.
            parse_for_test(work, head),
        );
        while !staged.step(store, &NoFaults).expect("step link") {}
    }
}

fn parse_for_test(
    work: crate::links::Work,
    head: Option<crate::links::Head>,
) -> crate::links::parser::Parsed {
    crate::links::parser::parse(work, head).expect("parse links")
}

fn default_req(query: &str) -> RetrievalRequest {
    RetrievalRequest {
        query: query.to_owned(),
        surfaces: None,
        path_prefix: None,
        collection_path: None,
        include_neighbors: true,
        limit: DEFAULT_RETRIEVAL_LIMIT,
    }
}

#[test]
fn query_parsing_stems_and_handles_stopwords_and_cjk() {
    assert_eq!(stem_term("medications"), "medication");
    assert_eq!(stem_term("allergies"), "allerg");
    assert_eq!(stem_term("allergy"), "allerg");
    assert_eq!(stem_term("planning"), "plan");
    assert_eq!(stem_term("status"), "status");

    let parsed = parse_query("What are my medications and allergies?").expect("parsed");
    assert_eq!(parsed.terms.len(), 2);
    assert_eq!(parsed.terms[0].raw, "medications");
    assert_eq!(parsed.terms[0].stem, "medication");
    assert_eq!(parsed.terms[1].raw, "allergies");
    assert_eq!(parsed.terms[1].stem, "allerg");

    let cjk = parse_query("東京 ホテル").expect("cjk");
    assert_eq!(cjk.terms.len(), 2);
    assert!(cjk.terms[0].is_cjk);
    assert_eq!(cjk.terms[0].raw, "東京");
    assert!(cjk.fts_terms.contains(&"ホテル".to_owned()));

    let short = parse_query("AI").expect("short");
    assert_eq!(short.terms.len(), 1);
    assert!(short.fts_terms.is_empty());
}

#[test]
fn bm25f_rejects_interior_trigram_noise_and_prefers_multi_term_coverage() {
    let query = parse_query("art museum").expect("query");
    let noise_doc = ScoreDocument {
        title: "Getting Started".into(),
        path: "notes/started.md".into(),
        fields_text: String::new(),
        body: "We started a cart party for our department.".into(),
    };
    let noise_score = score_document_bm25f(&noise_doc, &query);
    assert!(
        !noise_score.has_strong_match,
        "interior substring 'art' in 'started/cart/party' must not pass as a strong word match"
    );

    let single_term_spam = ScoreDocument {
        title: "Random".into(),
        path: "notes/random.md".into(),
        fields_text: String::new(),
        body: "museum museum museum museum museum museum museum museum".into(),
    };
    let both_terms = ScoreDocument {
        title: "Tokyo Art Museum".into(),
        path: "trips/museum.md".into(),
        fields_text: String::new(),
        body: "Visit the contemporary art museum near Roppongi.".into(),
    };
    let spam_score = score_document_bm25f(&single_term_spam, &query);
    let both_score = score_document_bm25f(&both_terms, &query);
    assert!(both_score.has_strong_match);
    assert!(
        both_score.score > spam_score.score,
        "multi-term title+body match ({}) must beat single-term spam ({})",
        both_score.score,
        spam_score.score
    );
}

#[test]
fn rrf_fuse_combines_multiple_signals_deterministically() {
    let lexical = vec!["a".to_owned(), "b".to_owned(), "c".to_owned()];
    let semantic = vec!["b".to_owned(), "d".to_owned(), "a".to_owned()];
    let fused = rrf_fuse(&[(&lexical, 1.5), (&semantic, 1.0)], RRF_K);
    assert!(fused["a"] > fused["c"]);
    assert!(fused["b"] > fused["d"]);
}

#[test]
fn render_field_value_json_unwraps_wire_markers_and_resolves_relations_cleanly() {
    let mut titles = HashMap::new();
    titles.insert(
        "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
        "Dr. Chen".to_owned(),
    );

    assert_eq!(
        render_field_value_json(r#"{"$dohcInt64":"9007199254740993"}"#, &titles).as_deref(),
        Some("9007199254740993")
    );
    assert_eq!(
        render_field_value_json(r#"{"$dohcFloat64":"42.5"}"#, &titles).as_deref(),
        Some("42.5")
    );
    assert_eq!(
        render_field_value_json(r#""rec_aaaaaaaaaaaaaaaaaaaaaaaaaa""#, &titles).as_deref(),
        Some("Dr. Chen")
    );
    assert_eq!(
        render_field_value_json(r#""rec_bbbbbbbbbbbbbbbbbbbbbbbbbb""#, &titles),
        None
    );

    let deep = "{\"a\":".repeat(30) + "1" + &"}".repeat(30);
    assert_eq!(render_field_value_json(&deep, &titles), None);
}

#[test]
fn unified_retrieval_correlates_pages_collections_records_datasets_chats_and_graph() {
    let (scratch, mut store) = setup_store();
    let root = scratch.path();

    // 1. Document Collection: Health/Medications + Contacts
    write_text(
        &mut store,
        "obj-med-schema",
        "Health/Medications/collection.yaml",
        "version: 1\nname: Medications\ndescription: Daily prescriptions and dosages\nfields:\n  - name: dosage\n    type: text\n  - name: prescriber\n    type: relation\n    collection: Contacts\n    many: false\n",
        10,
    );
    write_text(
        &mut store,
        "obj-contacts-schema",
        "Contacts/collection.yaml",
        "version: 1\nname: Contacts\ndescription: Personal doctors and friends\nfields:\n  - name: role\n    type: text\n",
        11,
    );
    write_text(
        &mut store,
        "obj-dr-chen",
        "Contacts/dr-chen.md",
        "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nrole: Primary Care Physician\n---\n\n# Dr. Chen\n\nClinic phone: 555-0199.\n",
        12,
    );
    write_text(
        &mut store,
        "obj-vitd",
        "Health/Medications/vitamin-d3.md",
        "---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\ndosage: 2000 IU daily\nprescriber: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n\n# Vitamin D3\n\nTake with breakfast during winter. See [[Health/annual-checkup]].\n",
        13,
    );
    write_text(
        &mut store,
        "obj-checkup",
        "Health/annual-checkup.md",
        "# Annual Checkup\n\nLab results showed low vitamin levels; follow up in autumn.\n",
        14,
    );
    write_text(
        &mut store,
        "obj-dataset",
        "Finances/Expenses/dataset.json",
        &json!({
            "formatVersion": 1,
            "datasetId": "11111111-1111-4111-8111-111111111111",
            "name": "Medical Expenses",
            "schemaPath": "Finances/Expenses/schema.sql",
            "operationsPath": "Finances/Expenses/ops.ts",
            "tables": [{
                "tableId": "22222222-2222-4222-8222-222222222222",
                "name": "receipts",
                "sqlName": "receipts",
                "primaryKey": "id",
                "fields": [
                    { "fieldId": "33333333-3333-4333-8333-333333333333", "name": "pharmacy", "sqlColumn": "pharmacy", "type": "text", "required": true, "unique": false }
                ]
            }],
            "operations": [{
                "operationId": "44444444-4444-4444-8444-444444444444",
                "name": "listReceipts",
                "label": "List pharmacy receipts",
                "tableId": "22222222-2222-4222-8222-222222222222",
                "kind": "read",
                "access": "owner",
                "readOnly": true,
                "fieldIds": ["33333333-3333-4333-8333-333333333333"]
            }]
        })
        .to_string(),
        15,
    );

    // Populate collection tables (reconcile_collections_in_tx would run via actor; seed exact tables here).
    store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "INSERT INTO collections(workspace_id,version_id,collection_path,schema_path,schema_status,degradation_reasons_json) \
                 VALUES (?1,?2,'Health/Medications','Health/Medications/collection.yaml','valid','[]'), \
                        (?1,?2,'Contacts','Contacts/collection.yaml','valid','[]')",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO collection_records(workspace_id,version_id,record_id,collection_path,file_path,object_id,adoption_state,index_initialized) \
                 VALUES (?1,?2,'rec_aaaaaaaaaaaaaaaaaaaaaaaaaa','Contacts','Contacts/dr-chen.md','obj-dr-chen','adopted',1), \
                        (?1,?2,'rec_bbbbbbbbbbbbbbbbbbbbbbbbbb','Health/Medications','Health/Medications/vitamin-d3.md','obj-vitd','adopted',1)",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO collection_record_fields(workspace_id,version_id,record_id,field_name,value_json,validation_status) \
                 VALUES (?1,?2,'rec_bbbbbbbbbbbbbbbbbbbbbbbbbb','dosage','\"2000 IU daily\"','valid'), \
                        (?1,?2,'rec_bbbbbbbbbbbbbbbbbbbbbbbbbb','prescriber','\"rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\"','valid'), \
                        (?1,?2,'rec_aaaaaaaaaaaaaaaaaaaaaaaaaa','role','\"Primary Care Physician\"','valid')",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO collection_relation_edges(workspace_id,version_id,source_record_id,field_name,target_record_id,target_collection_path,many) \
                 VALUES (?1,?2,'rec_bbbbbbbbbbbbbbbbbbbbbbbbbb','prescriber','rec_aaaaaaaaaaaaaaaaaaaaaaaaaa','Contacts',0)",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            Ok(())
        })
        .expect("seed collections");

    // Chat channel + message mentioning Vitamin D3 file.
    let mut chat = LinkedChatStore::new(&mut store);
    chat.create_channel(
        WS,
        "ch-health",
        "Health",
        ChatChannelKind::Channel,
        20,
        &NoFaults,
    )
    .expect("create channel");
    chat.start_channel_thread(
        &StartChannelThread {
            automation: None,
            workspace_id: WS.into(),
            channel_id: "ch-health".into(),
            thread_id: "thr-health".into(),
            message_id: "msg-1".into(),
            title: Some("Winter supplements".into()),
            lane: ChatThreadLane::Posts,
            own_thread: false,
            author_kind: ChatActorKind::Human,
            author_display_name: "Alice".into(),
            author_owner_display_name: None,
            author_user_id: Some("u-alice".into()),
            origin: None,
            body: "Remember to refill Vitamin D3 before December.".into(),
            needs_decision: false,
            options: Vec::new(),
            attachments: Vec::new(),
            author_agent_id: None,
            author_reported: None,
            work: None,
            wake_agent_ids: Vec::new(),
            now_ms: 25,
            request_id: None,
        },
        &NoFaults,
    )
    .expect("start thread");

    drain_links_sync(&mut store);
    rebuild_search_index(&mut store, root);

    // Query 1: "vitamin dosage" -> hits Vitamin D3 record + chat thread + surfaces Dr. Chen & Annual Checkup via 1-hop graph!
    let token = CancellationToken::new();
    let res = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("vitamin dosage"),
                None,
                false,
                &token,
            )
        })
        .expect("retrieve");

    assert!(res.complete, "expected complete response: {res:?}");
    assert!(!res.policy_degraded);
    assert!(!res.index_building);
    assert_eq!(res.results[0].kind, RetrievalKind::Record);
    assert_eq!(res.results[0].title, "Vitamin D3");
    assert_eq!(
        res.results[0].collection_path.as_deref(),
        Some("Health/Medications")
    );
    assert!(
        res.results[0]
            .matched_fields
            .as_ref()
            .is_some_and(|fields| fields
                .iter()
                .any(|f| f.name == "dosage" && f.value == "2000 IU daily"))
    );
    assert!(
        !res.results[0].snippet.contains("rec_"),
        "frontmatter record id should be stripped from record snippet: {}",
        res.results[0].snippet
    );
    assert!(
        res.results[0]
            .related
            .iter()
            .any(|edge| edge.edge == RetrievalEdgeKind::Relation && edge.title == "Dr. Chen"),
        "expected relation edge to Dr. Chen in inline related: {:?}",
        res.results[0].related
    );
    assert!(
        res.neighbors.iter().any(|n| n.title == "Dr. Chen"),
        "expected Dr. Chen in 1-hop neighbors: {:?}",
        res.neighbors
    );
    assert!(
        res.results
            .iter()
            .any(|hit| hit.kind == RetrievalKind::Chat
                && hit.thread_id.as_deref() == Some("thr-health")),
        "expected chat hit for Winter supplements: {:?}",
        res.results
    );

    // Query 2: "pharmacy receipts" -> discovers transactional dataset.json collection!
    let dataset_res = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("pharmacy receipts"),
                None,
                false,
                &token,
            )
        })
        .expect("retrieve dataset");
    assert!(
        dataset_res.results.iter().any(|hit| {
            hit.kind == RetrievalKind::Collection
                && hit.collection_kind == Some(RetrievalCollectionKind::Transactional)
                && hit.dataset_path.as_deref() == Some("Finances/Expenses/dataset.json")
        }),
        "expected transactional dataset collection hit: {:?}",
        dataset_res.results
    );

    // Query 3: "medications" (plural) -> matches "Medications" collection schema cleanly.
    let coll_res = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("medications"),
                None,
                false,
                &token,
            )
        })
        .expect("retrieve collection");
    assert!(
        coll_res.results.iter().any(|hit| {
            hit.kind == RetrievalKind::Collection
                && hit.collection_path.as_deref() == Some("Health/Medications")
                && hit.record_count == Some(1)
        }),
        "expected document collection hit: {:?}",
        coll_res.results
    );

    // Query 4: includeNeighbors=false suppresses inline related and neighbors.
    let no_neighbors = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &RetrievalRequest {
                    include_neighbors: false,
                    ..default_req("vitamin dosage")
                },
                None,
                false,
                &token,
            )
        })
        .expect("retrieve no neighbors");
    assert!(no_neighbors.neighbors.is_empty());
    assert!(no_neighbors.results.iter().all(|h| h.related.is_empty()));
}

#[test]
fn security_policy_binary_excalidraw_and_degraded_fail_closed() {
    let (scratch, mut store) = setup_store();
    let root = scratch.path();

    write_text(
        &mut store,
        "obj-public",
        "notes/public.md",
        "# Public Note\n\nSee [[private/secret-diary]] and [[boards/arch.excalidraw]] for alpha launch.\n",
        10,
    );
    write_text(
        &mut store,
        "obj-secret",
        "private/secret-diary.md",
        "# Secret Diary\n\nAlpha launch password is TOPSECRET_LAUNCH_CODE.\n",
        11,
    );
    write_text(
        &mut store,
        "obj-binary-later",
        "notes/was-text.md",
        "# Was Text\n\nAlpha launch blueprint before binary overwrite.\n",
        13,
    );
    write_text(
        &mut store,
        "obj-drawing",
        "boards/arch.excalidraw",
        &json!({
            "type": "excalidraw",
            "version": 2,
            "elements": [
                { "type": "text", "text": "Alpha Gateway Live", "originalText": "Alpha Gateway Live", "isDeleted": false },
                { "type": "text", "text": "PURGED_CANVAS_TOKEN", "originalText": "PURGED_CANVAS_TOKEN", "isDeleted": true }
            ]
        })
        .to_string(),
        14,
    );
    write_text(
        &mut store,
        "obj-nullable-rec",
        "Tasks/pending-task.md",
        "# Pending Task\n\nAlpha task waiting for record id adoption.\n",
        15,
    );

    // Seed a collection_records row with NULL record_id (pending adoption) to prove no crash.
    store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "INSERT INTO collections(workspace_id,version_id,collection_path,schema_path,schema_status,degradation_reasons_json) \
                 VALUES (?1,?2,'Tasks','Tasks/collection.yaml','valid','[]')",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO collection_records(workspace_id,version_id,record_id,collection_path,file_path,object_id,adoption_state,index_initialized) \
                 VALUES (?1,?2,NULL,'Tasks','Tasks/pending-task.md','obj-nullable-rec','pending',0)",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            // Defense-in-depth: even if a legacy or corrupted FTS/alias row existed for .env,
            // retrieval must still refuse it via path_is_search_indexed.
            let env_text = "ALPHA_TOKEN=TOPSECRET_ENV_VALUE\n";
            let env_sha = dohc_engine_storage::hex_sha256(env_text.as_bytes());
            tx.execute(
                "INSERT INTO file_objects(workspace_id, object_id, created_at_ms) VALUES (?1, 'obj-env', 12)",
                params![WS],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO blobs(sha256, byte_length, text) VALUES (?1, ?2, ?3)",
                params![env_sha, env_text.len() as i64, env_text],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO snapshots(workspace_id,version_id,object_id,path,blob_sha256,binary_sha256,content_kind,updated_at_ms,latest_moment_id,metadata_origin) \
                 VALUES (?1,?2,'obj-env','.env',?3,NULL,'text',12,'m-env','test')",
                params![WS, VER, env_sha],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO path_aliases(workspace_id,version_id,path,object_id) VALUES (?1,?2,'.env','obj-env')",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO engine_search_files_fts(workspace_id,version_id,object_id,path,text) \
                 VALUES (?1,?2,'obj-env','.env',?3)",
                params![WS, VER, env_text],
            )
            .map_err(StorageError::corrupt_public)?;
            Ok(())
        })
        .expect("seed nullable record");

    // Add a channel chat about alpha so we verify chat survives degraded policy.
    let mut chat = LinkedChatStore::new(&mut store);
    chat.create_channel(
        WS,
        "ch-general",
        "General",
        ChatChannelKind::Channel,
        20,
        &NoFaults,
    )
    .expect("channel");
    chat.start_channel_thread(
        &StartChannelThread {
            automation: None,
            workspace_id: WS.into(),
            channel_id: "ch-general".into(),
            thread_id: "thr-alpha".into(),
            message_id: "msg-alpha".into(),
            title: Some("Alpha discussion".into()),
            lane: ChatThreadLane::Posts,
            own_thread: false,
            author_kind: ChatActorKind::Human,
            author_display_name: "Bob".into(),
            author_owner_display_name: None,
            author_user_id: Some("u-bob".into()),
            origin: None,
            body: "Alpha launch timeline looks good.".into(),
            needs_decision: false,
            options: Vec::new(),
            attachments: Vec::new(),
            author_agent_id: None,
            author_reported: None,
            work: None,
            wake_agent_ids: Vec::new(),
            now_ms: 21,
            request_id: None,
        },
        &NoFaults,
    )
    .expect("thread");

    drain_links_sync(&mut store);
    rebuild_search_index(&mut store, root);

    // Overwrite was-text.md with binary AFTER FTS index was built (leaving stale FTS text).
    write_binary(
        &mut store,
        "obj-binary-later",
        "notes/was-text.md",
        b"\x89PNG\r\n",
        30,
    );

    // Hide private/** via .dohc/visibility.toml AFTER indexing!
    fs::create_dir_all(root.join(".dohc")).expect("mkdir .dohc");
    fs::write(
        root.join(".dohc/visibility.toml"),
        "[[rule]]\npath = \"private/**\"\nvisibility = \"hidden\"\n",
    )
    .expect("write policy");

    let token = CancellationToken::new();
    let res = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("alpha"),
                None,
                false,
                &token,
            )
        })
        .expect("retrieve under policy");

    let all_paths: Vec<&str> = res
        .results
        .iter()
        .filter_map(|h| h.path.as_deref())
        .chain(res.neighbors.iter().filter_map(|n| n.path.as_deref()))
        .chain(
            res.results
                .iter()
                .flat_map(|h| h.related.iter().filter_map(|r| r.path.as_deref())),
        )
        .collect();

    assert!(
        !all_paths.contains(&"private/secret-diary.md"),
        "hidden file leaked: {all_paths:?}"
    );
    let serialized = serde_json::to_string(&res).expect("serialize");
    assert!(
        !serialized.contains("secret-diary"),
        "hidden wikilink target leaked into snippet or result: {serialized}"
    );
    assert!(!all_paths.contains(&".env"), ".env leaked: {all_paths:?}");
    assert!(
        !all_paths.contains(&"notes/was-text.md"),
        "binary head leaked: {all_paths:?}"
    );
    assert!(all_paths.contains(&"notes/public.md"));
    assert!(all_paths.contains(&"boards/arch.excalidraw"));
    assert!(
        res.results
            .iter()
            .any(|h| h.path.as_deref() == Some("Tasks/pending-task.md")
                && h.kind == RetrievalKind::Page),
        "nullable record_id must surface safely as Page"
    );

    // Excalidraw deleted text must NEVER match.
    let deleted_res = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("PURGED_CANVAS_TOKEN"),
                None,
                false,
                &token,
            )
        })
        .expect("retrieve excalidraw deleted");
    assert!(
        deleted_res.results.is_empty(),
        "expected no results for deleted excalidraw text, got {:?}",
        deleted_res.results
    );

    // Now break .dohc/files.toml -> degraded policy must fail ALL files & file edges closed, keeping chat alive!
    fs::write(root.join(".dohc/files.toml"), "not valid [[[ toml").expect("corrupt policy");
    let degraded = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("alpha"),
                None,
                false,
                &token,
            )
        })
        .expect("retrieve degraded");
    assert!(degraded.policy_degraded);
    assert!(!degraded.complete);
    assert!(
        degraded
            .results
            .iter()
            .all(|h| h.kind == RetrievalKind::Chat),
        "degraded policy must suppress all file/collection/record hits: {:?}",
        degraded.results
    );
    assert!(
        degraded.results.iter().all(|h| h.related.is_empty()),
        "degraded policy must suppress all chat-to-file edges"
    );
    assert!(degraded.neighbors.is_empty());
    assert!(
        degraded
            .results
            .iter()
            .any(|h| h.thread_id.as_deref() == Some("thr-alpha")),
        "chat search must stay live under degraded file policy"
    );
}

#[test]
fn retrieval_does_not_invalidate_existing_search_page_generation() {
    let (scratch, mut store) = setup_store();
    let root = scratch.path();
    write_text(&mut store, "obj-1", "a.md", "alpha beta gamma", 10);
    rebuild_search_index(&mut store, root);

    let first_page = store
        .mutate_with_connection(|conn| {
            search_workspace_page(conn, root, WS, VER, "alpha", Some(10), 20, None, None)
        })
        .expect("first page");
    let gen_before = first_page.generation;

    let token = CancellationToken::new();
    let _ = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("alpha"),
                None,
                false,
                &token,
            )
        })
        .expect("retrieve");

    let gen_after = store
        .read_with(dohc_engine_storage::search_generation)
        .expect("generation");
    assert_eq!(gen_before, gen_after);
}

#[test]
fn fork_base_binary_head_is_excluded() {
    let (scratch, mut store) = setup_store();
    let root = scratch.path();

    write_text(
        &mut store,
        "obj-fork-bin",
        "notes/forked.md",
        "# Forked\n\nUnique fork token ZEBRA_FORK_TOKEN.\n",
        10,
    );
    rebuild_search_index(&mut store, root);

    // Replace snapshots row with a fork_base_snapshots binary head while leaving stale FTS row.
    store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "DELETE FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id='obj-fork-bin'",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO binary_blobs(sha256, byte_length, bytes) VALUES ('binsha', 4, X'01020304')",
                [],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO fork_base_snapshots(workspace_id,version_id,object_id,path,blob_sha256,binary_sha256,content_kind,updated_at_ms,latest_moment_id,metadata_origin) \
                 VALUES (?1,?2,'obj-fork-bin','notes/forked.md',NULL,'binsha','binary',20,'m-fork','test')",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            Ok(())
        })
        .expect("seed fork binary");

    let token = CancellationToken::new();
    let res = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("ZEBRA_FORK_TOKEN"),
                None,
                false,
                &token,
            )
        })
        .expect("retrieve");
    assert!(
        res.results.is_empty(),
        "binary head in fork_base_snapshots must be excluded: {:?}",
        res.results
    );
}

#[test]
fn response_byte_budget_truncates_gracefully_within_limit() {
    let mut hits = Vec::new();
    for i in 0..50 {
        hits.push(RetrievalHit {
            id: format!("page:obj-{i:03}"),
            kind: RetrievalKind::Page,
            title: format!("Document Title {i:03} {}", "X".repeat(120)),
            path: Some(format!("folder/subfolder/document-{i:03}.md")),
            object_id: Some(format!("obj-{i:03}")),
            collection_kind: None,
            collection_path: None,
            dataset_path: None,
            record_id: None,
            fields: None,
            record_count: None,
            matched_fields: None,
            thread_id: None,
            message_id: None,
            author: None,
            created_at_ms: None,
            channel_name: None,
            channel_wire_id: None,
            linked_file_path: None,
            snippet: "A".repeat(250),
            matched_terms: vec!["document".into()],
            related: (0..4)
                .map(|j| RetrievalRelatedEdge {
                    kind: RetrievalKind::Page,
                    edge: RetrievalEdgeKind::Wikilink,
                    direction: RetrievalEdgeDirection::Out,
                    field: None,
                    title: format!("Related {i}-{j} {}", "Y".repeat(80)),
                    path: Some(format!("related/doc-{i}-{j}.md")),
                    object_id: Some(format!("rel-{i}-{j}")),
                    collection_path: None,
                    record_id: None,
                    thread_id: None,
                })
                .collect(),
        });
    }
    let mut response = RetrievalResponse {
        version_id: VER.into(),
        results: hits,
        neighbors: vec![RetrievalNeighbor {
            id: "page:n1".into(),
            kind: RetrievalKind::Page,
            title: "Neighbor".into(),
            path: Some("neighbor.md".into()),
            object_id: Some("n1".into()),
            collection_path: None,
            record_id: None,
            thread_id: None,
            snippet: Some("N".repeat(160)),
            via: vec![RetrievalNeighborVia {
                from_id: "page:obj-000".into(),
                from_title: "Document".into(),
                edge: RetrievalEdgeKind::Wikilink,
                direction: RetrievalEdgeDirection::Out,
                field: None,
            }],
        }],
        complete: true,
        index_building: false,
        policy_degraded: false,
        mounts_covered: true,
        shared_channel_rows_uncovered: 0,
        truncated: false,
    };

    enforce_response_byte_budget(&mut response);
    let encoded_len = serde_json::to_vec(&response).expect("serialize").len();
    assert!(
        encoded_len <= MAX_RETRIEVAL_RESPONSE_BYTES,
        "encoded response ({encoded_len}) exceeded 64 KiB cap"
    );
    assert!(response.truncated);
    assert!(!response.results.is_empty());
}

#[test]
fn read_only_store_serves_retrieval_without_writes() {
    let scratch = ScratchDir::new().expect("scratch");
    let root = scratch.path();
    let db = engine_db_path(&scratch).expect("db path");
    {
        let mut writer = EngineStore::open(&db, 1).expect("open writer");
        VersionedTextStore::new(&mut writer)
            .ensure_main_version(WS, VER, 1, &NoFaults)
            .expect("ensure main");
        write_text(
            &mut writer,
            "obj-ro",
            "notes/readonly.md",
            "# Readonly Note\n\nQuerying from a read-only SQLite handle.\n",
            10,
        );
        rebuild_search_index(&mut writer, root);
    }

    let reader = EngineStore::open_read_only(&db).expect("open read-only");
    let token = CancellationToken::new();
    let res = reader
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("readonly handle"),
                None,
                false,
                &token,
            )
        })
        .expect("retrieve read-only");
    assert_eq!(res.results.len(), 1);
    assert_eq!(res.results[0].path.as_deref(), Some("notes/readonly.md"));
}

#[test]
#[ignore = "20,000-file retrieval latency and recall benchmark; run explicitly with --ignored --nocapture"]
fn benchmark_twenty_thousand_files_retrieval() {
    const TOTAL_FILES: usize = 20_000;
    let (scratch, mut store) = setup_store();
    let root = scratch.path();

    let setup_start = Instant::now();
    store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            let mut insert_obj = tx
                .prepare("INSERT INTO file_objects(workspace_id, object_id, created_at_ms) VALUES (?1, ?2, 1)")
                .map_err(StorageError::corrupt_public)?;
            let mut insert_blob = tx
                .prepare("INSERT OR IGNORE INTO blobs(sha256, byte_length, text) VALUES (?1, ?2, ?3)")
                .map_err(StorageError::corrupt_public)?;
            let mut insert_snap = tx
                .prepare(
                    "INSERT INTO snapshots(workspace_id, version_id, object_id, path, blob_sha256, binary_sha256, content_kind, updated_at_ms, latest_moment_id, metadata_origin) \
                     VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'text', 1, 'm-init', 'test')",
                )
                .map_err(StorageError::corrupt_public)?;
            let mut insert_alias = tx
                .prepare("INSERT INTO path_aliases(workspace_id, version_id, path, object_id) VALUES (?1, ?2, ?3, ?4)")
                .map_err(StorageError::corrupt_public)?;
            let mut insert_fts = tx
                .prepare("INSERT INTO engine_search_files_fts(workspace_id, version_id, object_id, path, text) VALUES (?1, ?2, ?3, ?4, ?5)")
                .map_err(StorageError::corrupt_public)?;

            for i in 0..TOTAL_FILES {
                let object_id = format!("obj-{i:05}");
                let folder = match i % 5 {
                    0 => "Projects",
                    1 => "Notes",
                    2 => "Journal",
                    3 => "Reference",
                    _ => "Archive",
                };
                let path = format!("{folder}/doc-{i:05}.md");
                let body = if i == 12_345 {
                    "# Tokyo Autumn Trip\n\nBooked hotel near Shinjuku Station with Alice. Budget target is 240000 JPY. See [[Projects/doc-12346]].\n".to_owned()
                } else if i == 12_346 {
                    "# Shinjuku Budget Breakdown\n\nFlights, JR Pass, ryokan deposit, and ramen stops.\n".to_owned()
                } else if i == 4_200 {
                    "# Q3 AI Architecture Review\n\nLatency targets and storage notes for local-first retrieval.\n".to_owned()
                } else if i % 40 == 0 {
                    format!("# Project Status {i}\n\nWeekly project plan and budget status update for quarter {}.\n", i % 4 + 1)
                } else {
                    format!("# Entry {i}\n\nRoutine workspace note number {i} covering design, operations, and planning.\n")
                };
                let sha = format!("sha-{i:05}");
                insert_obj.execute(params![WS, object_id]).map_err(StorageError::corrupt_public)?;
                insert_blob.execute(params![sha, body.len() as i64, body]).map_err(StorageError::corrupt_public)?;
                insert_snap.execute(params![WS, VER, object_id, path, sha]).map_err(StorageError::corrupt_public)?;
                insert_alias.execute(params![WS, VER, path, object_id]).map_err(StorageError::corrupt_public)?;
                insert_fts.execute(params![WS, VER, object_id, path, body]).map_err(StorageError::corrupt_public)?;
            }
            tx.execute(
                "INSERT INTO engine_search_index_state(workspace_id, version_id, indexed_at_ms, file_policy_degraded) \
                 VALUES (?1, ?2, -2, 0) \
                 ON CONFLICT(workspace_id, version_id) DO UPDATE SET indexed_at_ms=-2, file_policy_degraded=0",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "UPDATE link_index_state SET parser_generation=?3, seed_phase='ready' WHERE workspace_id=?1 AND version_id=?2",
                params![WS, VER, PARSER_GENERATION],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute("DELETE FROM link_pending WHERE workspace_id=?1 AND version_id=?2", params![WS, VER])
                .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO link_sources(workspace_id,version_id,object_id,source_hash,path,title,parser_generation,status,reason,index_key) \
                 VALUES (?1,?2,'obj-12345','sha-12345','Projects/doc-12345.md','Tokyo Autumn Trip',?3,'indexed',NULL,'k1')",
                params![WS, VER, PARSER_GENERATION],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO links(workspace_id,version_id,object_id,index_key,ordinal,literal,kind,fragment,start_utf16,end_utf16,line,snippet) \
                 VALUES (?1,?2,'obj-12345','k1',0,'Projects/doc-12346','wikilink',NULL,0,20,3,'See [[Projects/doc-12346]]')",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            Ok(())
        })
        .expect("seed 20k files");

    let seed_ms = setup_start.elapsed().as_secs_f64() * 1000.0;
    let resolver = store
        .read_with(|c| Resolver::paths_for_version(c, WS, VER))
        .expect("paths");
    let resolver = Resolver::new(resolver);
    let token = CancellationToken::new();

    for (label, query_text, expected_top_path) in [
        (
            "multi-term-rare",
            "tokyo shinjuku hotel",
            Some("Projects/doc-12345.md"),
        ),
        (
            "short-plus-word",
            "Q3 AI architecture",
            Some("Projects/doc-04200.md"),
        ),
        ("broad-multi-term", "project plan budget", None),
        ("single-broad", "planning", None),
        ("short-only", "Q3", None),
    ] {
        let mut samples = Vec::new();
        let mut last_res = None;
        for _ in 0..7 {
            let started = Instant::now();
            let res = store
                .read_with(|conn| {
                    retrieve_workspace_on_conn(
                        conn,
                        root,
                        WS,
                        VER,
                        &default_req(query_text),
                        Some(&resolver),
                        false,
                        &token,
                    )
                })
                .expect("benchmark query");
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
            last_res = Some(res);
        }
        samples.sort_by(f64::total_cmp);
        let res = last_res.expect("result");
        if let Some(expected) = expected_top_path {
            assert_eq!(
                res.results.first().and_then(|h| h.path.as_deref()),
                Some(expected),
                "query {label} expected top hit {expected}, got {:?}",
                res.results.first()
            );
        }
        println!(
            "RETRIEVAL_20K_BENCH {}",
            json!({
                "query": label,
                "text": query_text,
                "seedMs": seed_ms,
                "medianMs": samples[samples.len() / 2],
                "minMs": samples[0],
                "maxMs": samples[samples.len() - 1],
                "results": res.results.len(),
                "neighbors": res.neighbors.len(),
                "topPath": res.results.first().and_then(|h| h.path.as_deref()),
            })
        );
    }
}

#[test]
fn council_r1_regressions_scope_live_blob_revisions_datasets_and_share_cursors() {
    let (scratch, mut store) = setup_store();
    let root = scratch.path();
    let token = CancellationToken::new();

    // 1. Scoped search must not be displaced by 170 stronger outside matches.
    for i in 0..170 {
        write_text(
            &mut store,
            &format!("obj-noise-{i:03}"),
            &format!("Other/noise-{i:03}.md"),
            "# Quartz Quartz Quartz\n\nQuartz quartz quartz quartz quartz.\n",
            10 + i,
        );
    }
    write_text(
        &mut store,
        "obj-target",
        "Target/in-scope.md",
        "# In Scope Note\n\nMentions quartz once.\n",
        200,
    );

    // 2. Root-level dataset revisions must not surface, while >64 KiB datasets with 40 tables do.
    write_text(
        &mut store,
        "obj-root-rev",
        "revisions/1-abc/dataset.json",
        r#"{"formatVersion":1,"name":"Ghost Revision Dataset","tables":[{"name":"ghost","fields":[{"name":"title","type":"text"}]}]}"#,
        201,
    );
    let mut big_tables = Vec::new();
    for t in 0..40 {
        let mut fields = Vec::new();
        for f in 0..70 {
            let fname = if t == 39 && f == 69 {
                "deep_zanzibar_column".to_owned()
            } else {
                format!("col_{t}_{f}_padding_descriptor_field_name")
            };
            fields.push(json!({ "name": fname, "type": "text" }));
        }
        big_tables.push(json!({ "name": format!("tbl_{t}"), "fields": fields }));
    }
    let big_dataset_json = json!({
        "formatVersion": 1,
        "name": "Large Ledger",
        "tables": big_tables,
    })
    .to_string();
    assert!(
        big_dataset_json.len() > 64 * 1024 && big_dataset_json.len() < 256 * 1024,
        "expected descriptor between 64 KiB and 256 KiB, got {}",
        big_dataset_json.len()
    );
    write_text(
        &mut store,
        "obj-big-ds",
        "BigData/dataset.json",
        &big_dataset_json,
        202,
    );

    // 3. Stale FTS text (deleted Excalidraw text) must never leak when scoring reads the live blob.
    write_text(
        &mut store,
        "obj-excal",
        "boards/stale.excalidraw",
        &json!({
            "type": "excalidraw",
            "version": 2,
            "elements": [
                { "type": "text", "text": "Current Live Canvas", "isDeleted": false }
            ]
        })
        .to_string(),
        203,
    );

    // 4. Symmetric city/cities stemming.
    write_text(
        &mut store,
        "obj-cities",
        "notes/cities.md",
        "# European Cities\n\nTravel guide for major cities.\n",
        204,
    );

    // 5. Deleted collection.yaml must not appear as a parent Collection graph node,
    //    and pending (record_id IS NULL) rows must not inflate recordCount.
    write_text(
        &mut store,
        "obj-orphan-rec",
        "GhostColl/item.md",
        "---\nstatus: open\n---\n# Orphan Record\n\nUnique phantom_schema_token body.\n",
        205,
    );
    store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "INSERT INTO collections(workspace_id,version_id,collection_path,schema_path,schema_status,degradation_reasons_json) \
                 VALUES (?1,?2,'GhostColl','GhostColl/collection.yaml','valid','[]')",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO collection_records(workspace_id,version_id,record_id,collection_path,file_path,object_id,adoption_state,index_initialized) \
                 VALUES (?1,?2,'rec-ghost-1','GhostColl','GhostColl/item.md','obj-orphan-rec','adopted',1)",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            Ok(())
        })
        .expect("seed ghost collection");

    rebuild_search_index(&mut store, root);

    // Poison FTS row for boards/stale.excalidraw with stale deleted token (simulating frozen degraded FTS).
    store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "UPDATE engine_search_files_fts SET text = 'STALE_FROZEN_DELETED_CANVAS' \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = 'obj-excal'",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            Ok(())
        })
        .expect("poison fts");

    // Verify scoped search finds Target/in-scope.md despite 170 stronger outside matches.
    let mut scoped_req = default_req("quartz");
    scoped_req.path_prefix = Some("Target".into());
    let scoped = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(conn, root, WS, VER, &scoped_req, None, false, &token)
        })
        .expect("scoped retrieval");
    assert_eq!(scoped.results.len(), 1);
    assert_eq!(
        scoped.results[0].path.as_deref(),
        Some("Target/in-scope.md")
    );

    // Verify root-level revisions/1-abc/dataset.json is excluded.
    let ghost_rev = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("Ghost Revision Dataset"),
                None,
                false,
                &token,
            )
        })
        .expect("ghost revision query");
    assert!(
        !ghost_rev
            .results
            .iter()
            .any(|h| h.dataset_path.as_deref() == Some("revisions/1-abc/dataset.json")),
        "root dataset revision must never surface: {:?}",
        ghost_rev.results
    );

    // Verify >64 KiB dataset descriptor + 40th table / 70th field is discoverable.
    let big_ds = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("deep_zanzibar_column"),
                None,
                false,
                &token,
            )
        })
        .expect("large dataset query");
    assert!(
        big_ds
            .results
            .iter()
            .any(|h| h.dataset_path.as_deref() == Some("BigData/dataset.json")),
        "expected large dataset hit, got {:?}",
        big_ds.results
    );

    // Verify stale FTS text NEVER leaks even when search_index_building is true.
    let stale_res = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("STALE_FROZEN_DELETED_CANVAS"),
                None,
                true,
                &token,
            )
        })
        .expect("stale fts query");
    assert!(
        stale_res.results.is_empty(),
        "stale FTS text leaked: {:?}",
        stale_res.results
    );

    // Verify symmetric city <-> cities stemming.
    let city_res = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("city"),
                None,
                false,
                &token,
            )
        })
        .expect("city query");
    assert!(
        city_res
            .results
            .iter()
            .any(|h| h.path.as_deref() == Some("notes/cities.md")),
        "expected 'city' to match 'cities', got {:?}",
        city_res.results
    );

    // Verify deleted collection.yaml does not appear in related or neighbors.
    let ghost_coll = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("phantom_schema_token"),
                None,
                false,
                &token,
            )
        })
        .expect("ghost collection query");
    assert_eq!(ghost_coll.results.len(), 1);
    assert!(
        !ghost_coll.results[0]
            .related
            .iter()
            .any(|edge| edge.kind == RetrievalKind::Collection),
        "deleted schema leaked into related: {:?}",
        ghost_coll.results[0].related
    );
    assert!(
        !ghost_coll
            .neighbors
            .iter()
            .any(|n| n.kind == RetrievalKind::Collection),
        "deleted schema leaked into neighbors: {:?}",
        ghost_coll.neighbors
    );

    // Verify shared-with-me/ filter prefix is rejected.
    let mut mount_req = default_req("quartz");
    mount_req.path_prefix = Some("shared-with-me/Team".into());
    let mount_err = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(conn, root, WS, VER, &mount_req, None, false, &token)
        })
        .expect_err("shared-with-me pathPrefix must be refused");
    assert!(mount_err.to_string().contains("shared-with-me"));

    // Verify durable share_view_cursors row refuses retrieval.
    store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "INSERT INTO share_view_cursors(workspace_id, share_id, cursor) \
                 VALUES (?1, 'sh-1', 'cur-1')",
                params![WS],
            )
            .map_err(StorageError::corrupt_public)?;
            Ok(())
        })
        .expect("seed share_view_cursors");
    let share_err = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("quartz"),
                None,
                false,
                &token,
            )
        })
        .expect_err("durable share store must be refused");
    assert!(share_err.to_string().contains("received shares"));
}

#[test]
fn council_r2_and_codex_regressions() {
    let (scratch, mut store) = setup_store();
    let root = scratch.path();
    let token = CancellationToken::new();

    fs::create_dir_all(root.join(".dohc")).expect("mkdir .dohc");
    fs::write(
        root.join(".dohc/visibility.toml"),
        "[[rule]]\npath = \"private/**\"\nvisibility = \"hidden\"\n",
    )
    .expect("write visibility policy");

    // 1. Hidden wikilinks inside headings, <angle> markdown links with titles,
    //    fragmented chat mentions, and bare wikilinks in chat must all be redacted.
    write_text(
        &mut store,
        "obj-secret",
        "private/secret-diary.md",
        "# Secret Diary\n\nHidden vault notes.\n",
        10,
    );
    write_text(
        &mut store,
        "obj-heading-leak",
        "notes/heading-leak.md",
        "# Aurora [[private/secret-diary]]\n\nSee [doc](<private/secret-diary.md> \"Secret Title\") and [[notes/hub]].\n",
        11,
    );
    write_text(
        &mut store,
        "obj-hub",
        "notes/hub.md",
        "# Aurora Hub\n\nLinks to [[notes/heading-leak]].\n",
        12,
    );

    // 2. CamelCase pages and identifiers.
    write_text(
        &mut store,
        "obj-camel-1",
        "docs/ProjectPlan.md",
        "# ProjectPlan\n\nRoadmap for iPhone rollout.\n",
        13,
    );

    // 3. Stale relation title in link_sources with pending reindex + pending record_id IS NULL row.
    write_text(
        &mut store,
        "obj-col-schema",
        "People/collection.yaml",
        "version: 1\nname: People\ndescription: Directory\nfields:\n  - name: role\n    type: text\n",
        14,
    );
    write_text(
        &mut store,
        "obj-tasks-schema",
        "Tasks/collection.yaml",
        "version: 1\nname: Tasks\ndescription: Work items\nfields:\n  - name: owner\n    type: relation\n    collection: People\n    many: false\n",
        15,
    );
    write_text(
        &mut store,
        "obj-person",
        "People/alice.md",
        "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nrole: Lead\n---\n# Old Removed Title\n\nProfile body.\n",
        16,
    );
    write_text(
        &mut store,
        "obj-pending-person",
        "People/pending.md",
        "# Pending Person\n\nAwaiting adoption.\n",
        17,
    );
    write_text(
        &mut store,
        "obj-task",
        "Tasks/ship.md",
        "---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\nowner: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n# Ship Release\n\nRelies on owner relation.\n",
        18,
    );
    store
        .write_with(&NoFaults, |tx| -> Result<(), StorageError> {
            tx.execute(
                "INSERT INTO collections(workspace_id,version_id,collection_path,schema_path,schema_status,degradation_reasons_json) \
                 VALUES (?1,?2,'People','People/collection.yaml','valid','[]'), \
                        (?1,?2,'Tasks','Tasks/collection.yaml','valid','[]')",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO collection_records(workspace_id,version_id,record_id,collection_path,file_path,object_id,adoption_state,index_initialized) \
                 VALUES (?1,?2,'rec_aaaaaaaaaaaaaaaaaaaaaaaaaa','People','People/alice.md','obj-person','adopted',1), \
                        (?1,?2,NULL,'People','People/pending.md','obj-pending-person','pending',0), \
                        (?1,?2,'rec_bbbbbbbbbbbbbbbbbbbbbbbbbb','Tasks','Tasks/ship.md','obj-task','adopted',1)",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO collection_record_fields(workspace_id,version_id,record_id,field_name,value_json,validation_status) \
                 VALUES (?1,?2,'rec_bbbbbbbbbbbbbbbbbbbbbbbbbb','owner','\"rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\"','valid')",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO collection_relation_edges(workspace_id,version_id,source_record_id,field_name,target_record_id,target_collection_path,many) \
                 VALUES (?1,?2,'rec_bbbbbbbbbbbbbbbbbbbbbbbbbb','owner','rec_aaaaaaaaaaaaaaaaaaaaaaaaaa','People',0)",
                params![WS, VER],
            )
            .map_err(StorageError::corrupt_public)?;
            Ok(())
        })
        .expect("seed relation collections");

    // 4. Case-sensitive prefix isolation: 170 lowercase target/ files must not displace Target/in-scope.md.
    for i in 0..170 {
        write_text(
            &mut store,
            &format!("obj-lower-{i:03}"),
            &format!("target/noise-{i:03}.md"),
            "# Amber Amber Amber\n\nAmber amber amber amber amber.\n",
            30 + i,
        );
    }
    write_text(
        &mut store,
        "obj-upper-target",
        "Target/in-scope.md",
        "# Upper Target Note\n\nMentions amber once.\n",
        250,
    );

    // 5. Chat pre-limit pathPrefix, redaction of fragmented mentions & bare wikilinks, and >8 KiB chat body.
    let mut chat = LinkedChatStore::new(&mut store);
    chat.create_channel(
        WS,
        "ch-noise",
        "Noise",
        ChatChannelKind::Channel,
        300,
        &NoFaults,
    )
    .expect("noise channel");
    for i in 0..170 {
        chat.start_channel_thread(
            &StartChannelThread {
                automation: None,
                workspace_id: WS.into(),
                channel_id: "ch-noise".into(),
                thread_id: format!("thr-noise-{i:03}"),
                message_id: format!("msg-noise-{i:03}"),
                title: Some(format!("Lantern chatter {i}")),
                lane: ChatThreadLane::Posts,
                own_thread: false,
                author_kind: ChatActorKind::Human,
                author_display_name: "Noise".into(),
                author_owner_display_name: None,
                author_user_id: Some("u-noise".into()),
                origin: None,
                body: "lantern lantern lantern lantern".into(),
                needs_decision: false,
                options: Vec::new(),
                attachments: Vec::new(),
                author_agent_id: None,
                author_reported: None,
                work: None,
                wake_agent_ids: Vec::new(),
                now_ms: 301 + i,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("noise thread");
    }
    chat.create_thread(
        &CreateFileThread {
            workspace_id: WS.into(),
            thread_id: "thr-target-file".into(),
            title: "Upper Target Chat".into(),
            linked_object_id: "obj-upper-target".into(),
            linked_path_hint: Some("Target/in-scope.md".into()),
            now_ms: 500,
            request_id: "req-file-thread".into(),
        },
        &NoFaults,
    )
    .expect("file thread");
    chat.send_message(
        &SendMessage {
            workspace_id: WS.into(),
            thread_id: "thr-target-file".into(),
            message_id: "msg-target-1".into(),
            author_kind: ChatActorKind::Human,
            author_display_name: "Alice".into(),
            author_owner_display_name: None,
            author_user_id: Some("u-alice".into()),
            parent_message_id: None,
            origin: None,
            body: "Mentions lantern once in file chat.".into(),
            needs_decision: false,
            options: Vec::new(),
            attachments: Vec::new(),
            automation: None,
            author_agent_id: None,
            author_reported: None,
            work: None,
            wake_agent_ids: Vec::new(),
            now_ms: 501,
            request_id: None,
        },
        &NoFaults,
    )
    .expect("file chat message");

    let long_prefix = "padding ".repeat(1400);
    assert!(long_prefix.len() > 10_000);
    chat.start_channel_thread(
        &StartChannelThread {
            automation: None,
            workspace_id: WS.into(),
            channel_id: "ch-noise".into(),
            thread_id: "thr-long-and-redact".into(),
            message_id: "msg-long-1".into(),
            title: Some("Aurora mentions".into()),
            lane: ChatThreadLane::Posts,
            own_thread: false,
            author_kind: ChatActorKind::Human,
            author_display_name: "Bob".into(),
            author_owner_display_name: None,
            author_user_id: Some("u-bob".into()),
            origin: None,
            body: format!(
                "Check @[private/secret-diary.md#scope] @[.env#DATABASE_URL] [[secret-diary]]\n{long_prefix}\nDeep tail token ZIRCONIUM_TAIL_MATCH."
            ),
            needs_decision: false,
            options: Vec::new(),
            attachments: Vec::new(),
            author_agent_id: None,
            author_reported: None,
            work: None,
            wake_agent_ids: Vec::new(),
            now_ms: 510,
            request_id: None,
        },
        &NoFaults,
    )
    .expect("long chat thread");

    drain_links_sync(&mut store);

    // Update Alice's heading AFTER link indexing without draining link_pending, leaving stale link_sources.title.
    write_text(
        &mut store,
        "obj-person",
        "People/alice.md",
        "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nrole: Lead\n---\n# Alice Fresh Heading\n\nProfile body.\n",
        600,
    );
    rebuild_search_index(&mut store, root);

    // Check 1: hidden wikilink in heading + <angle> markdown link + chat fragment/bare mentions are all redacted.
    let aurora = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("aurora"),
                None,
                false,
                &token,
            )
        })
        .expect("aurora query");
    let aurora_json = serde_json::to_string(&aurora).expect("serialize aurora");
    assert!(
        !aurora_json.contains("secret-diary")
            && !aurora_json.contains("Secret Title")
            && !aurora_json.contains(".env")
            && !aurora_json.contains("DATABASE_URL"),
        "hidden reference leaked in titles, snippets, or graph: {aurora_json}"
    );
    let leak_hit = aurora
        .results
        .iter()
        .find(|h| h.path.as_deref() == Some("notes/heading-leak.md"))
        .expect("heading-leak hit");
    assert_eq!(leak_hit.title, "Aurora");
    assert!(
        aurora
            .results
            .iter()
            .any(|h| h.thread_id.as_deref() == Some("thr-long-and-redact")),
        "expected Aurora mentions chat thread in results: {:?}",
        aurora.results
    );
    let secret_query = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("secret-diary"),
                None,
                false,
                &token,
            )
        })
        .expect("secret-diary query");
    assert!(
        secret_query.results.is_empty(),
        "hidden title/link reference must not be searchable: {:?}",
        secret_query.results
    );

    // Check 2: adversarial 256 KiB bracket-heavy input finishes quickly in O(N).
    let hostile = "[".repeat(256 * 1024);
    let started = Instant::now();
    let cleaned = redact_file_references(&hostile, |_| true, |_| true, |_| true);
    assert_eq!(cleaned.len(), hostile.len());
    assert!(
        started.elapsed().as_millis() < 2000,
        "redact_file_references took too long on hostile brackets: {:?}",
        started.elapsed()
    );

    // Check 3: CamelCase queries ProjectPlan and iPhone match cleanly.
    for q in ["ProjectPlan", "iPhone"] {
        let camel = store
            .read_with(|conn| {
                retrieve_workspace_on_conn(
                    conn,
                    root,
                    WS,
                    VER,
                    &default_req(q),
                    None,
                    false,
                    &token,
                )
            })
            .expect("camel query");
        assert!(
            camel
                .results
                .iter()
                .any(|h| h.path.as_deref() == Some("docs/ProjectPlan.md")),
            "expected camelCase query {q:?} to match docs/ProjectPlan.md, got {:?}",
            camel.results
        );
    }

    // Check 4: stale relation title refreshed from live blob + pending record_id IS NULL excluded from recordCount.
    let task_res = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("Ship Alice Fresh Heading"),
                None,
                false,
                &token,
            )
        })
        .expect("fresh relation title query");
    let ship_hit = task_res
        .results
        .iter()
        .find(|h| h.path.as_deref() == Some("Tasks/ship.md"))
        .expect("expected Tasks/ship.md to match fresh relation title");
    assert!(
        ship_hit
            .matched_fields
            .as_ref()
            .is_some_and(|fs| fs.iter().any(|f| f.value == "Alice Fresh Heading")),
        "expected fresh relation title in matched_fields: {:?}",
        ship_hit.matched_fields
    );
    let stale_rel = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &default_req("Ship Old Removed Title"),
                None,
                false,
                &token,
            )
        })
        .expect("stale relation title query");
    let stale_serialized = serde_json::to_string(&stale_rel).expect("serialize stale rel");
    assert!(
        !stale_serialized.contains("Old Removed Title"),
        "stale relation title leaked: {stale_serialized}"
    );
    let people_coll = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &RetrievalRequest {
                    surfaces: Some(vec![RetrievalKind::Collection]),
                    ..default_req("People")
                },
                None,
                false,
                &token,
            )
        })
        .expect("people collection query");
    let people_hit = people_coll
        .results
        .iter()
        .find(|h| h.collection_path.as_deref() == Some("People"))
        .expect("people collection hit");
    assert_eq!(
        people_hit.record_count,
        Some(1),
        "pending record_id IS NULL row must not inflate recordCount"
    );

    // Check 5: case-sensitive pathPrefix Target does not get displaced by 170 target/ files.
    let case_scoped = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &RetrievalRequest {
                    path_prefix: Some("Target".into()),
                    ..default_req("amber")
                },
                None,
                false,
                &token,
            )
        })
        .expect("case-sensitive scoped query");
    assert_eq!(case_scoped.results.len(), 1);
    assert_eq!(
        case_scoped.results[0].path.as_deref(),
        Some("Target/in-scope.md")
    );
    assert!(case_scoped.complete);

    // Check 6: chat pathPrefix is pushed into SQL before candidate limits.
    let chat_scoped = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &RetrievalRequest {
                    surfaces: Some(vec![RetrievalKind::Chat]),
                    path_prefix: Some("Target".into()),
                    ..default_req("lantern")
                },
                None,
                false,
                &token,
            )
        })
        .expect("scoped chat query");
    assert_eq!(chat_scoped.results.len(), 1);
    assert_eq!(
        chat_scoped.results[0].thread_id.as_deref(),
        Some("thr-target-file")
    );
    assert!(chat_scoped.complete);

    // Check 7: chat message match past character 8,192 is preserved and produces a snippet.
    let long_chat = store
        .read_with(|conn| {
            retrieve_workspace_on_conn(
                conn,
                root,
                WS,
                VER,
                &RetrievalRequest {
                    surfaces: Some(vec![RetrievalKind::Chat]),
                    ..default_req("ZIRCONIUM_TAIL_MATCH")
                },
                None,
                false,
                &token,
            )
        })
        .expect("long chat query");
    assert_eq!(long_chat.results.len(), 1);
    assert_eq!(
        long_chat.results[0].thread_id.as_deref(),
        Some("thr-long-and-redact")
    );
    assert!(
        long_chat.results[0]
            .snippet
            .contains("ZIRCONIUM_TAIL_MATCH"),
        "expected tail match in snippet, got {:?}",
        long_chat.results[0].snippet
    );

    // Check 8: SQLite OperationInterrupted on a chat-only query maps cleanly to RuntimeError::Cancelled.
    let paths = store
        .read_with(|conn| Resolver::paths_for_version(conn, WS, VER))
        .expect("paths");
    let resolver = Resolver::new(paths);
    store
        .hooks_with(|conn| conn.progress_handler(20, Some(|| true)))
        .expect("install interrupt handler");
    let interrupted = store.read_with(|conn| {
        retrieve_workspace_on_conn(
            conn,
            root,
            WS,
            VER,
            &RetrievalRequest {
                surfaces: Some(vec![RetrievalKind::Chat]),
                ..default_req("lantern")
            },
            Some(&resolver),
            false,
            &token,
        )
    });
    store
        .hooks_with(|conn| conn.progress_handler(0, None::<fn() -> bool>))
        .expect("clear interrupt handler");
    assert!(
        matches!(interrupted, Err(RuntimeError::Cancelled)),
        "expected SQLite interrupt during chat query to map to RuntimeError::Cancelled, got {interrupted:?}"
    );
}
