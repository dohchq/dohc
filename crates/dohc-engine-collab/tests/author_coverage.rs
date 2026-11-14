use crate::common;

use common::*;
use dohc_engine_collab::{
    author_coverage, maybe_compact, record_local_update, CollabError, ContentKind, LocalAppend,
    MarkerCreation, Regime, WriterDocCache, Ydoc,
};
use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
use dohc_engine_storage::{FaultPoint, NoFaults, TxnOutcome};

fn author(scope: &str) -> ChangeAttribution {
    ChangeAttribution {
        actor_kind: ChangeActorKind::Agent,
        on_behalf_of: Some(scope.into()),
        depth: 0,
        run: None,
        agent_run_id: None,
    }
}

fn covered_count(
    store: &dohc_engine_storage::EngineStore,
    key: &dohc_engine_collab::DocKey,
) -> usize {
    store
        .read_with(|conn| author_coverage::reserved_in(conn, key))
        .expect("covered identities")
        .len()
}

fn record_actorless(
    ts: &mut TempStore,
    key: &dohc_engine_collab::DocKey,
    update: &[u8],
    is_seed: bool,
) {
    record_local_update(
        &mut ts.store,
        &mut ts.cache,
        key,
        update,
        LocalAppend {
            marker: Some(MarkerCreation {
                path: Some("authors.txt"),
                content_kind: ContentKind::Plaintext,
                regime: Regime::LocalOnly,
            }),
            is_seed,
            ..LocalAppend::default()
        },
        &NoFaults,
        1,
        |_, _, _| Ok(()),
    )
    .expect("actorless update");
}

fn interval_authors(
    ts: &TempStore,
    key: &dohc_engine_collab::DocKey,
    through: i64,
) -> serde_json::Value {
    let authors = ts
        .store
        .read_with(|conn| author_coverage::interval_in(conn, key, through))
        .expect("interval coverage");
    serde_json::from_str(&authors.json()).expect("author list")
}

#[test]
fn interval_actorless_rows_add_one_marker_alongside_named_authors() {
    let mut ts = fresh_store("interval-actorless");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1);
    let doc = Ydoc::wire();
    record_actorless(&mut ts, &key, &doc.plaintext_insert(0, "a"), false);
    record(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &doc.plaintext_insert(1, "b"),
        "editor",
        "person",
    )
    .expect("named edit");
    let expected = serde_json::json!([
        {"kind":"agent", "agentId":"editor", "onBehalfOf":"person"},
        {"kind":"unattributed"}
    ]);
    assert_eq!(interval_authors(&ts, &key, 2), expected);
    record_actorless(&mut ts, &key, &doc.plaintext_insert(2, "c"), false);
    assert_eq!(interval_authors(&ts, &key, i64::MAX), expected);
    maybe_compact(&mut ts.store, &key, 0, &NoFaults, 2).expect("fold coverage");
    assert_eq!(interval_authors(&ts, &key, i64::MAX), expected);
    ts.store
        .write_with(&NoFaults, |tx| author_coverage::advance_in(tx, &key, false))
        .expect("consume interval");
    assert_eq!(interval_authors(&ts, &key, i64::MAX), serde_json::json!([]));
}

#[test]
fn actorless_admission_counts_the_marker_and_refuses_before_appending() {
    let mut ts = fresh_store("actorless-capacity");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1);
    let doc = Ydoc::wire();
    record_actorless(&mut ts, &key, &doc.plaintext_insert(0, "seed"), true);
    let named: Vec<_> = (0..author_coverage::MAX_INTERVAL_AUTHORS)
        .map(|index| serde_json::json!({"kind":"human","humanId":format!("person-{index}")}))
        .collect();
    ts.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_docs SET pending_authors_json=?1",
                [serde_json::to_string(&named).unwrap()],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, CollabError>(())
        })
        .unwrap();
    let update = doc.plaintext_insert(4, "a");
    let result = record_local_update(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &update,
        LocalAppend::default(),
        &NoFaults,
        2,
        |_, _, _| Ok(()),
    );
    assert!(matches!(result, Err(CollabError::AuthorCapacity)));
    ts.store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET regime='replicated'", [])
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, CollabError>(())
        })
        .unwrap();
    let remote = dohc_engine_collab::RemoteUpdate {
        origin_id: "peer".into(),
        origin_seq: 1,
        bytes: update.clone(),
    };
    let result = dohc_engine_collab::apply_remote_update(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &remote,
        None,
        None,
        &NoFaults,
        2,
    );
    assert!(matches!(result, Err(CollabError::AuthorCapacity)));
    assert_eq!(
        dohc_engine_collab::read_marker(&ts.store, &key)
            .unwrap()
            .unwrap()
            .head_update_seq,
        1
    );
    assert_eq!(
        covered_count(&ts.store, &key),
        author_coverage::MAX_INTERVAL_AUTHORS
    );
    ts.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_docs SET pending_authors_json=?1",
                [serde_json::to_string(&named[..named.len() - 1]).unwrap()],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, CollabError>(())
        })
        .unwrap();
    dohc_engine_collab::apply_remote_update(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &remote,
        None,
        None,
        &NoFaults,
        2,
    )
    .expect("remote marker fits at the limit");
    record_local_update(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &doc.plaintext_insert(5, "b"),
        LocalAppend::default(),
        &NoFaults,
        3,
        |_, _, _| Ok(()),
    )
    .expect("known local marker fits");
    assert_eq!(
        covered_count(&ts.store, &key),
        author_coverage::MAX_INTERVAL_AUTHORS
    );
    assert_eq!(
        interval_authors(&ts, &key, i64::MAX)
            .as_array()
            .unwrap()
            .iter()
            .filter(|author| author["kind"] == "unattributed")
            .count(),
        1
    );
}

#[test]
fn compensated_settlement_does_not_inherit_relay_confirmation() {
    let mut ts = fresh_store("compensated-confirmation");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1);
    let doc = Ydoc::wire();
    record_human(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &doc.plaintext_insert(0, "edit"),
        "recipient",
    )
    .unwrap();
    let moment_id = "moment-ydoc-reserved";
    let confirmed = serde_json::json!([{"kind":"human","humanId":"recipient","humanName":"Recipient","relayConfirmed":true}]);
    ts.store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT OR IGNORE INTO versions(workspace_id,version_id,kind,name,created_at_ms) VALUES (?1,?2,'main','main',1)", rusqlite::params![key.workspace_id, key.version_id])
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
        let sha = dohc_engine_storage::put_binary_blob(tx, b"edit")?;
        tx.execute("INSERT INTO moments(workspace_id,moment_order,moment_id,version_id,object_id,path,recorded_at_ms,operation,after_content_kind,after_binary_sha256,before_present,metadata_origin,author_json) VALUES (?1,1,?2,?3,?4,'authors.txt',3,'write','binary',?5,0,'ydoc',?6)", rusqlite::params![key.workspace_id, moment_id, key.version_id, key.object_id, sha, confirmed.to_string()])
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
        author_coverage::advance_in(tx, &key, true)?;
        tx.execute("UPDATE ydoc_docs SET settle_seq=1 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3", rusqlite::params![key.workspace_id, key.version_id, key.object_id])
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
        Ok::<_, CollabError>(())
    }).unwrap();
    ts.store
        .write_with(&NoFaults, |tx| {
            author_coverage::compensate_in(tx, &key, Some(moment_id), 4)
        })
        .unwrap();
    let pending: String = ts
        .store
        .read_with(|conn| conn.query_row("SELECT pending_authors_json FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3", rusqlite::params![key.workspace_id, key.version_id, key.object_id], |row| row.get(0)))
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&pending).unwrap(),
        serde_json::json!([{"kind":"human","humanId":"recipient","humanName":"Recipient"}])
    );
    let interval = ts
        .store
        .read_with(|conn| author_coverage::interval_in(conn, &key, i64::MAX))
        .unwrap();
    let entries: Vec<serde_json::Value> = serde_json::from_str(&interval.json()).unwrap();
    assert!(entries
        .iter()
        .all(|author| author.get("relayConfirmed").is_none()));
    let retained: String = ts
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT author_json FROM moments WHERE moment_id=?1",
                [moment_id],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&retained).unwrap(),
        confirmed
    );
}

#[test]
fn declared_seed_is_not_an_author_and_coverage_tracks_fold_reset_and_consumption() {
    let mut ts = fresh_store("seed-author-index");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1);
    let doc = Ydoc::wire();
    record_local_update(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &doc.plaintext_insert(0, "seed"),
        LocalAppend {
            marker: Some(MarkerCreation {
                path: Some("authors.txt"),
                content_kind: ContentKind::Plaintext,
                regime: Regime::LocalOnly,
            }),
            actor_origin_id: Some("opener"),
            attribution: Some(&author("person")),
            is_seed: true,
            ..LocalAppend::default()
        },
        &NoFaults,
        1,
        |_, _, _| Ok(()),
    )
    .expect("declared seed");
    assert_eq!(covered_count(&ts.store, &key), 0);
    assert!(ts
        .store
        .read_with(|conn| author_coverage::interval_in(conn, &key, i64::MAX))
        .expect("seed coverage")
        .is_empty());
    record(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &doc.plaintext_insert(4, " edit"),
        "editor",
        "person",
    )
    .expect("edit");
    assert_eq!(covered_count(&ts.store, &key), 1);
    maybe_compact(&mut ts.store, &key, 0, &NoFaults, 2).expect("fold");
    assert_eq!(covered_count(&ts.store, &key), 1);
    let authors = ts
        .store
        .read_with(|conn| author_coverage::interval_in(conn, &key, i64::MAX))
        .expect("folded coverage");
    assert_eq!(authors.len(), 1);
    assert!(authors.json().contains("editor"));
    assert!(!authors.json().contains("opener"));
    ts.store
        .write_with(&NoFaults, |tx| author_coverage::advance_in(tx, &key, false))
        .expect("consume");
    assert_eq!(covered_count(&ts.store, &key), 0);
    record(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &doc.plaintext_insert(9, " next"),
        "next",
        "person",
    )
    .expect("next interval");
    assert_eq!(covered_count(&ts.store, &key), 1);
    ts.store
        .write_with(&NoFaults, |tx| {
            author_coverage::reset_in(tx, &key, false)?;
            tx.execute(
                "DELETE FROM ydoc_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, CollabError>(())
        })
        .expect("discard lineage");
    assert_eq!(covered_count(&ts.store, &key), 0);
}

fn record(
    store: &mut dohc_engine_storage::EngineStore,
    cache: &mut WriterDocCache,
    key: &dohc_engine_collab::DocKey,
    update: &[u8],
    id: &str,
    scope: &str,
) -> Result<TxnOutcome<dohc_engine_collab::AppendOutcome>, CollabError> {
    record_local_update(
        store,
        cache,
        key,
        update,
        LocalAppend {
            marker: Some(MarkerCreation {
                path: Some("authors.txt"),
                content_kind: ContentKind::Plaintext,
                regime: Regime::LocalOnly,
            }),
            actor_origin_id: Some(id),
            attribution: Some(&author(scope)),
            ..LocalAppend::default()
        },
        &NoFaults,
        1,
        |_, _, _| Ok(()),
    )
}

fn record_in_run(
    ts: &mut TempStore,
    key: &dohc_engine_collab::DocKey,
    update: &[u8],
    agent_run_id: Option<&str>,
) {
    let attribution = ChangeAttribution {
        agent_run_id: agent_run_id.map(str::to_owned),
        ..author("person")
    };
    record_local_update(
        &mut ts.store,
        &mut ts.cache,
        key,
        update,
        LocalAppend {
            marker: Some(MarkerCreation {
                path: Some("authors.txt"),
                content_kind: ContentKind::Plaintext,
                regime: Regime::LocalOnly,
            }),
            actor_origin_id: Some("codex"),
            attribution: Some(&attribution),
            ..LocalAppend::default()
        },
        &NoFaults,
        1,
        |_, _, _| Ok(()),
    )
    .expect("agent edit");
}

#[test]
fn two_unsettled_runs_by_one_agent_stay_two_authors_through_compaction() {
    let mut ts = fresh_store("two-agent-runs");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1);
    let doc = Ydoc::wire();
    record_in_run(&mut ts, &key, &doc.plaintext_insert(0, "a"), Some("run-a"));
    record_in_run(&mut ts, &key, &doc.plaintext_insert(1, "b"), Some("run-b"));
    record_in_run(&mut ts, &key, &doc.plaintext_insert(2, "c"), Some("run-a"));
    record_in_run(&mut ts, &key, &doc.plaintext_insert(3, "d"), None);
    // Coverage lists authors in identity order: a run sorts before none.
    let expected = serde_json::json!([
        {"kind":"agent", "agentId":"codex", "onBehalfOf":"person", "agentRunId":"run-a"},
        {"kind":"agent", "agentId":"codex", "onBehalfOf":"person", "agentRunId":"run-b"},
        {"kind":"agent", "agentId":"codex", "onBehalfOf":"person"},
    ]);
    assert_eq!(interval_authors(&ts, &key, i64::MAX), expected);
    assert_eq!(covered_count(&ts.store, &key), 3);
    maybe_compact(&mut ts.store, &key, 0, &NoFaults, 2).expect("fold coverage");
    assert_eq!(interval_authors(&ts, &key, i64::MAX), expected);
    assert_eq!(covered_count(&ts.store, &key), 3);
}

#[test]
fn repeated_compaction_keeps_metadata_constant_and_crash_atomic() {
    let dir = unique_dir("author-fold-crash");
    let key = test_key();
    let mut store = open_at(&dir, 1);
    seed_parents(&mut store, &key, 1);
    let mut cache = WriterDocCache::new();
    let doc = Ydoc::wire();
    let mut sizes = Vec::new();
    for round in 0..4 {
        for index in 0..64 {
            let offset = round * 64 + index;
            record(
                &mut store,
                &mut cache,
                &key,
                &doc.plaintext_insert(offset, "x"),
                if index % 2 == 0 { "a" } else { "b" },
                "person",
            )
            .expect("record");
        }
        sizes.push(
            store
                .read_with(|conn| author_coverage::interval_in(conn, &key, i64::MAX))
                .expect("coverage")
                .json()
                .len(),
        );
    }
    assert!(sizes.iter().all(|size| *size == sizes[0]));
    println!("AUTHOR_MEASURE updates=64,128,192,256 metadata_bytes={sizes:?}");
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let next = dohc_engine_collab::load_persisted(&store, &key)
            .expect("load")
            .expect("doc")
            .doc;
        let offset = next.plaintext_string().len() as u32;
        record(
            &mut store,
            &mut cache,
            &key,
            &next.plaintext_insert(offset, "y"),
            "new",
            "person",
        )
        .expect("record");
        let faults = OneShotCrash::at(point);
        let outcome = maybe_compact(&mut store, &key, 0, &faults, 2).expect("faulted fold");
        assert!(matches!(outcome, TxnOutcome::Crashed { .. }));
        drop(store);
        store = reopen(&dir);
        cache = WriterDocCache::new();
        let authors = store
            .read_with(|conn| author_coverage::interval_in(conn, &key, i64::MAX))
            .expect("recovered authors");
        assert_eq!(authors.len(), 3);
    }
}

#[test]
fn one_identity_keeps_its_deepest_accepted_chain() {
    let mut authors = author_coverage::Authors::default();
    authors
        .union_json(
            r#"[{"kind":"automation","automationId":"stamp","onBehalfOf":"person","depth":32}]"#,
        )
        .expect("first");
    authors
        .union_json(
            r#"[{"kind":"automation","automationId":"stamp","onBehalfOf":"person","depth":1}]"#,
        )
        .expect("second");
    assert_eq!(authors.len(), 1);
    assert_eq!(
        dohc_engine_domain::moment_author_depth(Some(&authors.json())),
        32
    );
}

fn record_human(
    store: &mut dohc_engine_storage::EngineStore,
    cache: &mut WriterDocCache,
    key: &dohc_engine_collab::DocKey,
    update: &[u8],
    person: &str,
) -> Result<TxnOutcome<dohc_engine_collab::AppendOutcome>, CollabError> {
    let attribution = ChangeAttribution {
        actor_kind: ChangeActorKind::Human,
        on_behalf_of: Some(person.into()),
        depth: 0,
        run: None,
        agent_run_id: None,
    };
    record_local_update(
        store,
        cache,
        key,
        update,
        LocalAppend {
            marker: Some(MarkerCreation {
                path: Some("authors.txt"),
                content_kind: ContentKind::Plaintext,
                regime: Regime::LocalOnly,
            }),
            actor_origin_id: Some(person),
            attribution: Some(&attribution),
            ..LocalAppend::default()
        },
        &NoFaults,
        2,
        |_, _, _| Ok(()),
    )
}

#[test]
fn compacted_human_coverage_enforces_capacity_without_refusing_known_authors_or_retries() {
    let mut ts = fresh_store("human-author-capacity");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1);
    dohc_engine_collab::ensure_marker(
        &mut ts.store,
        &key,
        ContentKind::Plaintext,
        Regime::LocalOnly,
        &NoFaults,
        1,
    )
    .expect("marker");
    let folded: Vec<_> = (0..author_coverage::MAX_INTERVAL_AUTHORS)
        .map(|index| {
            let person = format!("person-{index}");
            serde_json::json!({"kind":"human","humanId":person,"onBehalfOf":person})
        })
        .collect();
    let json = serde_json::to_string(&folded).unwrap();
    ts.store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE ydoc_docs SET pending_authors_json=?4 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            rusqlite::params![key.workspace_id,key.version_id,key.object_id,json]).map_err(dohc_engine_storage::StorageError::persist_public)?;
        Ok::<_, CollabError>(())
    }).expect("coverage retained by compaction");
    let doc = Ydoc::wire();
    let first = doc.plaintext_insert(0, "x");
    let admitted = record_human(&mut ts.store, &mut ts.cache, &key, &first, "person-0")
        .expect("known person enters");
    assert!(matches!(admitted, TxnOutcome::Committed(outcome) if outcome.settlement_requested));
    let before = dohc_engine_collab::read_marker(&ts.store, &key)
        .unwrap()
        .unwrap();
    let refused = record_human(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &doc.plaintext_insert(1, "y"),
        "new-person",
    );
    assert!(matches!(refused, Err(CollabError::AuthorCapacity)));
    assert_eq!(
        dohc_engine_collab::read_marker(&ts.store, &key)
            .unwrap()
            .unwrap()
            .head_update_seq,
        before.head_update_seq
    );
    let duplicate = record_human(&mut ts.store, &mut ts.cache, &key, &first, "another-person")
        .expect("retry at capacity");
    assert!(matches!(duplicate, TxnOutcome::Committed(outcome) if outcome.deduped));
    let peer = dohc_engine_collab::load_persisted(&ts.store, &key)
        .unwrap()
        .unwrap()
        .doc;
    assert_eq!(
        peer.plaintext_string(),
        "x",
        "the refused update did not reach the document"
    );
    record_human(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &peer.plaintext_insert(1, "z"),
        "person-0",
    )
    .expect("known person still enters");
    maybe_compact(&mut ts.store, &key, 0, &NoFaults, 3).expect("fold at capacity");
    assert_eq!(
        covered_count(&ts.store, &key),
        author_coverage::MAX_INTERVAL_AUTHORS
    );
}

#[test]
fn already_admitted_remote_authors_never_wedge_coverage_readers() {
    let mut ts = fresh_store("remote-author-summary");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1);
    let remote_count = author_coverage::MAX_INTERVAL_AUTHORS + 1;
    let entries: Vec<serde_json::Value> = (0..remote_count)
        .map(|index| serde_json::json!({"kind":"agent","agentId":format!("remote-{index}")}))
        .collect();
    ts.store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO ydoc_docs(workspace_id,version_id,object_id,updated_at_ms,pending_authors_json) VALUES (?1,?2,?3,1,?4)",
            rusqlite::params![key.workspace_id,key.version_id,key.object_id,serde_json::to_string(&entries).expect("summary")]).map_err(dohc_engine_storage::StorageError::persist_public)?;
        Ok::<_,dohc_engine_storage::StorageError>(())
    }).expect("remote summary");
    let known = author("person");
    ts.store
        .read_with(|conn| {
            assert_eq!(
                author_coverage::reserved_in(conn, &key)?.len(),
                remote_count
            );
            assert!(author_coverage::check_admission_in(
                conn,
                &key,
                Some("remote-0"),
                Some(&ChangeAttribution {
                    on_behalf_of: None,
                    ..known.clone()
                })
            )?);
            assert!(matches!(
                author_coverage::check_admission_in(conn, &key, Some("new"), Some(&known)),
                Err(CollabError::AuthorCapacity)
            ));
            Ok::<_, CollabError>(())
        })
        .expect("known authors and readers stay usable");
}

#[test]
fn largest_serialized_authors_fit_the_entry_bound() {
    use dohc_engine_collab::live_update_application::LiveAuthorEntry;
    use dohc_engine_domain::collections::MAX_AUTOMATION_RUN_NAME_BYTES;
    use dohc_engine_domain::{
        moment_author_json, AutomationRunAttribution, SharedChangeAuthor, MAX_AUTHOR_FIELD_BYTES,
        MAX_CHANGE_ATTRIBUTION_DEPTH,
    };

    let check = |json: String| {
        let entries: Vec<serde_json::Value> = serde_json::from_str(&json).expect("author list");
        assert_eq!(entries.len(), 1);
        let bytes = entries[0].to_string().len();
        assert!(
            bytes <= author_coverage::MAX_AUTHOR_ENTRY_BYTES,
            "{} author uses {bytes} bytes, exceeding MAX_AUTHOR_ENTRY_BYTES ({})",
            entries[0]["kind"],
            author_coverage::MAX_AUTHOR_ENTRY_BYTES,
        );
    };
    for escaped in ['"', '\\'] {
        let field = escaped.to_string().repeat(MAX_AUTHOR_FIELD_BYTES);
        for actor_kind in [
            ChangeActorKind::Human,
            ChangeActorKind::Agent,
            ChangeActorKind::Automation,
        ] {
            let attribution = ChangeAttribution {
                actor_kind,
                on_behalf_of: Some(field.clone()),
                depth: MAX_CHANGE_ATTRIBUTION_DEPTH,
                run: (actor_kind == ChangeActorKind::Automation).then(|| {
                    AutomationRunAttribution {
                        claim_id: field.clone(),
                        automation_name: escaped.to_string().repeat(MAX_AUTOMATION_RUN_NAME_BYTES),
                    }
                }),
                agent_run_id: (actor_kind == ChangeActorKind::Agent).then(|| field.clone()),
            };
            attribution.validate().expect("bounded native attribution");
            check(moment_author_json(Some(&field), Some(&attribution)).expect("native author"));
        }
        for author in [
            LiveAuthorEntry::Unattributed {},
            LiveAuthorEntry::Human {
                human_id: field.clone(),
                human_name: field.clone(),
            },
            LiveAuthorEntry::Link {
                public_principal_id: field.clone(),
                label: field.clone(),
            },
            LiveAuthorEntry::Agent {
                agent_id: field.clone(),
                agent_name: Some(field.clone()),
                on_behalf_of: Some(field.clone()),
                depth: Some(u8::try_from(MAX_CHANGE_ATTRIBUTION_DEPTH).expect("wire depth")),
            },
        ] {
            author.validate().expect("bounded live author");
            check(serde_json::to_string(&[author]).expect("live author"));
        }
        for author in [
            SharedChangeAuthor::Named {
                user_id: field.clone(),
                grant_id: field.clone(),
                grant_generation: 9_007_199_254_740_991,
            },
            SharedChangeAuthor::Link {
                grant_id: field.clone(),
                principal_id: field.clone(),
                grant_generation: 9_007_199_254_740_991,
            },
        ] {
            check(author_coverage::shared_json(&author).expect("bounded shared author"));
        }
    }

    // A control character serializes to six bytes, three times what the bound allows for.
    let control = "\u{1}";
    assert!(dohc_engine_collab::validate_actor_origin_id(control).is_err());
    let native = |actor_kind: ChangeActorKind, fields: [&str; 4]| ChangeAttribution {
        actor_kind,
        on_behalf_of: Some(fields[0].to_owned()),
        depth: 0,
        run: (actor_kind == ChangeActorKind::Automation).then(|| AutomationRunAttribution {
            claim_id: fields[1].to_owned(),
            automation_name: fields[2].to_owned(),
        }),
        agent_run_id: (actor_kind == ChangeActorKind::Agent).then(|| fields[3].to_owned()),
    };
    for (actor_kind, field) in [
        (ChangeActorKind::Human, 0),
        (ChangeActorKind::Agent, 0),
        (ChangeActorKind::Agent, 3),
        (ChangeActorKind::Automation, 0),
        (ChangeActorKind::Automation, 1),
        (ChangeActorKind::Automation, 2),
    ] {
        let mut fields = ["a"; 4];
        assert!(native(actor_kind, fields).validate().is_ok());
        fields[field] = control;
        assert!(
            native(actor_kind, fields).validate().is_err(),
            "native field {field} admits a control character"
        );
    }
    let live = |kind: &str, fields: [&str; 3]| match kind {
        "human" => LiveAuthorEntry::Human {
            human_id: fields[0].to_owned(),
            human_name: fields[1].to_owned(),
        },
        "link" => LiveAuthorEntry::Link {
            public_principal_id: fields[0].to_owned(),
            label: fields[1].to_owned(),
        },
        _ => LiveAuthorEntry::Agent {
            agent_id: fields[0].to_owned(),
            agent_name: Some(fields[1].to_owned()),
            on_behalf_of: Some(fields[2].to_owned()),
            depth: Some(0),
        },
    };
    for (kind, field) in [
        ("human", 0),
        ("human", 1),
        ("link", 0),
        ("link", 1),
        ("agent", 0),
        ("agent", 1),
        ("agent", 2),
    ] {
        let mut fields = ["a"; 3];
        assert!(live(kind, fields).validate().is_ok());
        fields[field] = control;
        assert!(
            live(kind, fields).validate().is_err(),
            "live {kind} field {field} admits a control character"
        );
    }
}

/// A declared agent is the largest live entry: an id, a name and a principal,
/// each up to 512 bytes that escape to twice their size, and its depth. The
/// host admits it at 3,143 bytes, and the interval admits it too. The
/// interval's bound is one byte larger, for an agent in a run on the owner's
/// devices. One more byte of id escapes to two, outside both bounds.
#[test]
fn the_largest_declared_agent_fits_one_entry_and_a_larger_one_does_not() {
    use dohc_engine_collab::live_update_application::LiveAuthorEntry;
    let mut ts = fresh_store("largest-declared-agent");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1);
    dohc_engine_collab::ensure_marker(
        &mut ts.store,
        &key,
        ContentKind::Plaintext,
        Regime::LocalOnly,
        &NoFaults,
        1,
    )
    .expect("marker");
    let field = dohc_engine_domain::MAX_AUTHOR_FIELD_BYTES;
    let agent = |id_bytes: usize| LiveAuthorEntry::Agent {
        agent_id: "\"".repeat(id_bytes),
        agent_name: Some("\"".repeat(field)),
        on_behalf_of: Some("\"".repeat(field)),
        depth: Some(64),
    };
    let largest = agent(field);
    largest
        .validate()
        .expect("the host admits the largest declared agent");
    let json = serde_json::to_string(&[&largest]).expect("entry");
    assert_eq!(json.len() - "[]".len(), 3_143);
    // An agent in a run on the owner's devices sets the bound, one byte over.
    assert_eq!(author_coverage::MAX_AUTHOR_ENTRY_BYTES, 3_144);
    ts.store
        .write_with(&NoFaults, |tx| {
            author_coverage::admit_accepted_in(tx, &key, &[json])
        })
        .expect("the interval admits the largest declared agent");
    assert_eq!(covered_count(&ts.store, &key), 1);

    let larger = agent(field + 1);
    assert!(larger.validate().is_err());
    let json = serde_json::to_string(&[&larger]).expect("entry");
    assert!(matches!(
        ts.store.write_with(&NoFaults, |tx| {
            author_coverage::admit_accepted_in(tx, &key, &[json])
        }),
        Err(CollabError::AuthorEntryTooLarge)
    ));
    assert_eq!(covered_count(&ts.store, &key), 1);
}

fn pending_authors(
    store: &dohc_engine_storage::EngineStore,
    key: &dohc_engine_collab::DocKey,
) -> String {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT pending_authors_json FROM ydoc_docs \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |row| row.get(0),
            )
        })
        .expect("pending authors")
}

fn admit_accepted(
    store: &mut dohc_engine_storage::EngineStore,
    key: &dohc_engine_collab::DocKey,
    author: serde_json::Value,
) -> Result<TxnOutcome<()>, CollabError> {
    let json = serde_json::Value::Array(vec![author]).to_string();
    store.write_with(&NoFaults, |tx| {
        author_coverage::admit_accepted_in(tx, key, &[json])
    })
}

/// The relay keeps a known author's first name in its window, but each new
/// editor session delivers the name that session derived. At the byte bound a
/// longer name waits for a settlement like a new author and writes nothing.
/// An unchanged or equally long name still applies.
#[test]
fn a_known_author_cannot_lengthen_its_name_past_the_byte_bound() {
    let mut ts = fresh_store("known-author-name-growth");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1);
    dohc_engine_collab::ensure_marker(
        &mut ts.store,
        &key,
        ContentKind::Plaintext,
        Regime::LocalOnly,
        &NoFaults,
        1,
    )
    .expect("marker");
    let human = |index: usize, name: &str| {
        serde_json::json!({
            "kind": "human",
            "humanId": format!("{index:04}{}", "h".repeat(116)),
            "humanName": name,
        })
    };
    let seed = |store: &mut dohc_engine_storage::EngineStore, count: usize| {
        let pending = serde_json::Value::Array((0..count).map(|index| human(index, "A")).collect())
            .to_string();
        assert!(pending.len() <= author_coverage::MAX_INTERVAL_AUTHOR_BYTES);
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_docs SET pending_authors_json=?4 \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id, pending],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok::<_, CollabError>(())
            })
            .expect("seed coverage");
        pending
    };
    // As many equal entries as the byte bound holds, each with its comma.
    let entry_bytes = human(0, "A").to_string().len();
    let full = (author_coverage::MAX_INTERVAL_AUTHOR_BYTES - 1) / (entry_bytes + 1);
    assert!(full < author_coverage::MAX_INTERVAL_AUTHORS);
    let seeded = seed(&mut ts.store, full);
    assert!(matches!(
        admit_accepted(&mut ts.store, &key, human(full, "A")),
        Err(CollabError::AuthorCapacity)
    ));
    let longer = "A".repeat(dohc_engine_domain::MAX_AUTHOR_FIELD_BYTES);
    assert!(matches!(
        admit_accepted(&mut ts.store, &key, human(0, &longer)),
        Err(CollabError::AuthorCapacity)
    ));
    assert_eq!(pending_authors(&ts.store, &key), seeded);
    for name in ["A", "B"] {
        admit_accepted(&mut ts.store, &key, human(0, name))
            .expect("a known author with an equally long name applies");
    }
    let covered = ts
        .store
        .read_with(|conn| author_coverage::reserved_in(conn, &key))
        .expect("coverage");
    assert_eq!(covered.len(), full);
    assert!(covered.journal_bytes() <= author_coverage::MAX_INTERVAL_AUTHOR_BYTES);

    seed(&mut ts.store, full - 4);
    admit_accepted(&mut ts.store, &key, human(0, &longer))
        .expect("a longer name applies while it fits");
    let covered = ts
        .store
        .read_with(|conn| author_coverage::reserved_in(conn, &key))
        .expect("coverage");
    assert_eq!(covered.len(), full - 4);
    assert!(covered.json().contains(&longer));
    assert!(covered.journal_bytes() <= author_coverage::MAX_INTERVAL_AUTHOR_BYTES);
}

#[test]
fn retained_rebase_keeps_only_uncovered_identities() {
    let mut ts = fresh_store("retained-rebase-identities");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1);
    let doc = Ydoc::wire();
    record(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &doc.plaintext_insert(0, "a"),
        "alice",
        "person",
    )
    .expect("alice");
    ts.store
        .write_with(&NoFaults, |tx| author_coverage::advance_in(tx, &key, false))
        .expect("consume alice");
    record(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &doc.plaintext_insert(1, "b"),
        "bob",
        "person",
    )
    .expect("bob");
    ts.store
        .write_with(&NoFaults, |tx| {
            author_coverage::reset_in(tx, &key, true)?;
            tx.execute(
                "DELETE FROM ydoc_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, CollabError>(())
        })
        .expect("retained rebase");
    let covered = ts
        .store
        .read_with(|conn| author_coverage::reserved_in(conn, &key))
        .expect("covered identities");
    assert_eq!(covered.len(), 1);
    assert!(covered.json().contains("bob"));
    assert!(!covered.json().contains("alice"));
}

#[test]
fn control_character_author_fields_are_refused_before_admission() {
    let mut ts = fresh_store("author-control-refusal");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1);
    let doc = Ydoc::wire();
    for (id, scope) in [
        ("agent\n", "person"),
        ("agent\u{0085}", "person"),
        ("agent", "person\u{0085}"),
    ] {
        assert!(matches!(
            record(
                &mut ts.store,
                &mut ts.cache,
                &key,
                &doc.plaintext_insert(0, "x"),
                id,
                scope
            ),
            Err(CollabError::InvalidIdentifier { .. })
        ));
    }
    assert!(dohc_engine_collab::read_marker(&ts.store, &key)
        .expect("marker query")
        .is_none());
}
