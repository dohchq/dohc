mod common;

use common::*;
use dohc_engine_collab::{
    author_coverage, maybe_compact, record_local_update, CollabError, ContentKind, LocalAppend,
    MarkerCreation, Regime, WriterDocCache, Ydoc,
};
use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
use dohc_engine_storage::{FaultPoint, NoFaults, TxnOutcome};
use std::time::Instant;

fn author(scope: &str) -> ChangeAttribution {
    ChangeAttribution {
        actor_kind: ChangeActorKind::Agent,
        on_behalf_of: Some(scope.into()),
        depth: 0,
    }
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

#[test]
fn identities_are_scoped_bounded_and_known_authors_still_enter_at_capacity() {
    let mut ts = fresh_store("author-capacity");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1);
    let doc = Ydoc::wire();
    let started = Instant::now();
    let mut admission_us = Vec::new();
    for index in 0..author_coverage::MAX_INTERVAL_AUTHORS {
        let admission_started = Instant::now();
        record(
            &mut ts.store,
            &mut ts.cache,
            &key,
            &doc.plaintext_insert(index as u32, "x"),
            "shared-agent-name",
            &format!("person-{index}"),
        )
        .expect("admit distinct scoped author");
        admission_us.push(admission_started.elapsed().as_micros());
    }
    let admitted = started.elapsed();
    admission_us.sort_unstable();
    println!(
        "AUTHOR_MEASURE durable_admission_p95_us={} durable_admission_p99_us={}",
        admission_us[972], admission_us[1013]
    );
    let before = ts
        .store
        .read_with(|conn| author_coverage::reserved_in(conn, &key))
        .expect("authors");
    assert_eq!(before.len(), 1024);
    let refused = record(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &doc.plaintext_insert(1024, "y"),
        "new-agent",
        "new-person",
    );
    assert!(matches!(refused, Err(CollabError::AuthorCapacity)));
    assert_eq!(
        dohc_engine_collab::read_marker(&ts.store, &key)
            .expect("marker")
            .expect("exists")
            .head_update_seq,
        1024
    );
    // The refused update never reached the document. Use a peer of the admitted state.
    let peer = dohc_engine_collab::load_persisted(&ts.store, &key)
        .expect("load")
        .expect("doc")
        .doc;
    record(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &peer.plaintext_insert(1024, "z"),
        "shared-agent-name",
        "person-0",
    )
    .expect("known author remains admissible");
    maybe_compact(&mut ts.store, &key, 0, &NoFaults, 2).expect("fold");
    let after = ts
        .store
        .read_with(|conn| author_coverage::reserved_in(conn, &key))
        .expect("authors");
    assert_eq!(before.json(), after.json());
    println!("AUTHOR_MEASURE identities=1024 admit_total_ms={} metadata_before_fold_bytes={} metadata_after_fold_bytes={}",admitted.as_millis(),before.json().len(),after.json().len());
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
fn oversized_summary_entry_is_refused_without_truncation() {
    let mut authors = author_coverage::Authors::default();
    let json =
        serde_json::json!([{"kind":"agent","agentId":"a","name":"n".repeat(4096)}]).to_string();
    assert!(matches!(
        authors.union_json(&json),
        Err(CollabError::AuthorEntryTooLarge)
    ));
    assert!(authors.is_empty());
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

#[test]
fn winning_base_replacement_clears_compacted_losing_authors() {
    let mut ts = fresh_store("author-base-reset");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1);
    let first = Ydoc::wire();
    first.plaintext_insert(0, "losing base");
    dohc_engine_collab::claim_base_at_relay(
        &mut ts.store,
        &key,
        ContentKind::Plaintext,
        &first.encode_full_state(),
        &dohc_engine_collab::BaseRelayCoordinate::new("first", 1, 10).expect("coordinate"),
        &NoFaults,
        2,
    )
    .expect("first base");
    dohc_engine_collab::record_local_update(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &first.plaintext_insert(11, " edit"),
        LocalAppend {
            actor_origin_id: Some("losing-agent"),
            attribution: Some(&author("person")),
            ..LocalAppend::default()
        },
        &NoFaults,
        3,
        |_, _, _| Ok(()),
    )
    .expect("admit losing edit");
    maybe_compact(&mut ts.store, &key, 0, &NoFaults, 4).expect("fold losing edit");
    assert_eq!(
        ts.store
            .read_with(|conn| author_coverage::interval_in(conn, &key, i64::MAX))
            .expect("before")
            .len(),
        1
    );
    let winner = Ydoc::wire();
    winner.plaintext_insert(0, "winning base");
    let outcome = dohc_engine_collab::claim_base_at_relay(
        &mut ts.store,
        &key,
        ContentKind::Plaintext,
        &winner.encode_full_state(),
        &dohc_engine_collab::BaseRelayCoordinate::new("winner", 1, 5).expect("coordinate"),
        &NoFaults,
        5,
    )
    .expect("replace losing base");
    assert!(matches!(
        outcome,
        TxnOutcome::Committed(dohc_engine_collab::ClaimOutcome::Replaced { .. })
    ));
    assert!(ts
        .store
        .read_with(|conn| author_coverage::interval_in(conn, &key, i64::MAX))
        .expect("after")
        .is_empty());
    assert_eq!(
        dohc_engine_collab::load_persisted(&ts.store, &key)
            .expect("load")
            .expect("lineage")
            .doc
            .plaintext_string(),
        "winning base"
    );
}

#[test]
fn human_automation_context_is_not_enabled_as_settlement_authorship() {
    let mut ts = fresh_store("human-context-coverage");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1);
    let doc = Ydoc::wire();
    let attribution = ChangeAttribution {
        actor_kind: ChangeActorKind::Human,
        on_behalf_of: Some("person".into()),
        depth: 0,
    };
    let admitted = record_local_update(
        &mut ts.store,
        &mut ts.cache,
        &key,
        &doc.plaintext_insert(0, "human edit"),
        LocalAppend {
            marker: Some(MarkerCreation {
                path: Some("authors.txt"),
                content_kind: ContentKind::Plaintext,
                regime: Regime::LocalOnly,
            }),
            actor_origin_id: Some("device"),
            attribution: Some(&attribution),
            ..LocalAppend::default()
        },
        &NoFaults,
        2,
        |_, _, _| Ok(()),
    )
    .expect("main automation context remains admissible");
    assert!(matches!(admitted, TxnOutcome::Committed(outcome) if !outcome.settlement_requested));
    maybe_compact(&mut ts.store, &key, 0, &NoFaults, 3).expect("fold");
    assert!(ts
        .store
        .read_with(|conn| author_coverage::reserved_in(conn, &key))
        .expect("coverage")
        .is_empty());
}

#[test]
fn already_admitted_remote_authors_never_wedge_coverage_readers() {
    let mut ts = fresh_store("remote-author-summary");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1);
    let entries: Vec<serde_json::Value> = (0..1025)
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
            assert_eq!(author_coverage::reserved_in(conn, &key)?.len(), 1025);
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
