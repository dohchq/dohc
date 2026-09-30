mod common;

use common::*;
use dohc_engine_collab::{author_coverage, record_local_update, maybe_compact, ContentKind, Regime,
    LocalAppend, MarkerCreation, WriterDocCache, Ydoc, CollabError};
use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
use dohc_engine_storage::{NoFaults, FaultPoint, TxnOutcome};
use std::time::Instant;

fn author(scope: &str) -> ChangeAttribution {
    ChangeAttribution { actor_kind: ChangeActorKind::Agent, on_behalf_of: Some(scope.into()), depth: 0 }
}

fn record(store: &mut dohc_engine_storage::EngineStore, cache: &mut WriterDocCache,
    key: &dohc_engine_collab::DocKey, update: &[u8], id: &str, scope: &str)
    -> Result<TxnOutcome<dohc_engine_collab::AppendOutcome>, CollabError> {
    record_local_update(store,cache,key,update,LocalAppend {
        marker: Some(MarkerCreation { path: Some("authors.txt"), content_kind: ContentKind::Plaintext, regime: Regime::LocalOnly }),
        actor_origin_id: Some(id), attribution: Some(&author(scope)),
        ..LocalAppend::default()
    },&NoFaults,1,|_,_,_| Ok(()))
}

#[test]
fn identities_are_scoped_bounded_and_known_authors_still_enter_at_capacity() {
    let mut ts=fresh_store("author-capacity");
    let key=test_key(); seed_parents(&mut ts.store,&key,1);
    let doc=Ydoc::wire();
    let started=Instant::now();
    for index in 0..author_coverage::MAX_INTERVAL_AUTHORS {
        record(&mut ts.store,&mut ts.cache,&key,&doc.plaintext_insert(index as u32,"x"),
            "shared-agent-name",&format!("person-{index}")).expect("admit distinct scoped author");
    }
    let admitted=started.elapsed();
    let before=ts.store.read_with(|conn| author_coverage::reserved_in(conn,&key)).expect("authors");
    assert_eq!(before.len(),1024);
    let refused=record(&mut ts.store,&mut ts.cache,&key,&doc.plaintext_insert(1024,"y"),"new-agent","new-person");
    assert!(matches!(refused,Err(CollabError::AuthorCapacity)));
    assert_eq!(dohc_engine_collab::read_marker(&ts.store,&key).expect("marker").expect("exists").head_update_seq,1024);
    // The refused update never reached the document. Use a peer of the admitted state.
    let peer=dohc_engine_collab::load_persisted(&ts.store,&key).expect("load").expect("doc").doc;
    record(&mut ts.store,&mut ts.cache,&key,&peer.plaintext_insert(1024,"z"),"shared-agent-name","person-0").expect("known author remains admissible");
    maybe_compact(&mut ts.store,&key,0,&NoFaults,2).expect("fold");
    let after=ts.store.read_with(|conn| author_coverage::reserved_in(conn,&key)).expect("authors");
    assert_eq!(before.json(),after.json());
    println!("AUTHOR_MEASURE identities=1024 admit_total_ms={} metadata_before_fold_bytes={} metadata_after_fold_bytes={}",admitted.as_millis(),before.json().len(),after.json().len());
}

#[test]
fn repeated_compaction_keeps_metadata_constant_and_crash_atomic() {
    let dir=unique_dir("author-fold-crash");
    let key=test_key();
    let mut store=open_at(&dir,1); seed_parents(&mut store,&key,1);
    let mut cache=WriterDocCache::new();
    let doc=Ydoc::wire();
    let mut sizes=Vec::new();
    for round in 0..4 {
        for index in 0..64 {
            let offset=round*64+index;
            record(&mut store,&mut cache,&key,&doc.plaintext_insert(offset,"x"),if index%2==0 {"a"} else {"b"},"person").expect("record");
        }
        sizes.push(store.read_with(|conn| author_coverage::interval_in(conn,&key,i64::MAX)).expect("coverage").json().len());
    }
    assert!(sizes.iter().all(|size| *size==sizes[0]));
    println!("AUTHOR_MEASURE updates=64,128,192,256 metadata_bytes={sizes:?}");
    for point in [FaultPoint::StorageBeforePersist,FaultPoint::StorageAfterCommitBeforeAck] {
        let next=dohc_engine_collab::load_persisted(&store,&key).expect("load").expect("doc").doc;
        let offset=next.plaintext_string().len() as u32;
        record(&mut store,&mut cache,&key,&next.plaintext_insert(offset,"y"),"new","person").expect("record");
        let faults=OneShotCrash::at(point);
        let outcome=maybe_compact(&mut store,&key,0,&faults,2).expect("faulted fold");
        assert!(matches!(outcome,TxnOutcome::Crashed { .. }));
        drop(store); store=reopen(&dir); cache=WriterDocCache::new();
        let authors=store.read_with(|conn| author_coverage::interval_in(conn,&key,i64::MAX)).expect("recovered authors");
        assert_eq!(authors.len(),3);
    }
}

#[test]
fn oversized_summary_entry_is_refused_without_truncation() {
    let mut authors=author_coverage::Authors::default();
    let json=serde_json::json!([{"kind":"agent","agentId":"a","name":"n".repeat(4096)}]).to_string();
    assert!(matches!(authors.union_json(&json),Err(CollabError::AuthorEntryTooLarge)));
    assert!(authors.is_empty());
}
