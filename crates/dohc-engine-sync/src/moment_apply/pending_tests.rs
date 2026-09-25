use std::sync::atomic::{AtomicUsize, Ordering};

use dohc_engine_collab::DocKey;
use dohc_engine_domain::{
    CollectionFieldChangeFact, CollectionRecordApplyFacts, VersionedTextStore,
};
use dohc_engine_storage::{EngineStore, NoFaults, TxnOutcome};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use rusqlite::params;
use serde_json::json;

use super::{
    MomentMaterializationChange, pending::drain_and_claim, record_materialization_changes,
};
use crate::{
    LeaseProbe, NoLiveLeases, RelayCursor, ReplicationEnvelope, SyncError, commit_relay_cursor,
};

fn test_store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 1_000).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .unwrap();
    (scratch, store)
}

fn seed_applied(
    store: &mut EngineStore,
    count: i64,
    facts: Option<&CollectionRecordApplyFacts>,
) -> Vec<MomentMaterializationChange> {
    let changes = (0..count)
        .map(|seq| MomentMaterializationChange {
            version_id: "main".into(),
            path: format!("document-{seq}.md"),
            operation: "write",
            content_kind: "text",
        })
        .collect::<Vec<_>>();
    let outcome = store
        .write_with(&NoFaults, |tx| {
            for (seq, change) in changes.iter().enumerate() {
                let seq = seq as i64;
                let envelope = ReplicationEnvelope {
                    workspace_id: "ws".into(),
                    origin_id: "peer".into(),
                    origin_seq: seq,
                    op_kind: "moment.append".into(),
                    payload: json!({}),
                    recorded_at_ms: 2_000 + seq,
                    relay_seq: None,
                };
                tx.execute(
                    "INSERT INTO replication_log \
                     (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                     VALUES ('ws','peer',?1,'moment.append','{}',?2,1)",
                    params![seq, envelope.recorded_at_ms],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "INSERT INTO owner_pending_settlements \
                     (workspace_id,origin_id,origin_seq,main_version_id,object_id,lineage_claim_id,\
                      relay_namespace,binding_json,terminal_cursor,applied,record_facts_json) \
                     VALUES ('ws','peer',?1,'main',?2,'lineage','relay','{}',?1,1,?3)",
                    params![
                        seq,
                        format!("object-{seq}"),
                        facts.map(|value| serde_json::to_string(value).unwrap())
                    ],
                )
                .map_err(SyncError::persist)?;
                record_materialization_changes(tx, &envelope, std::slice::from_ref(change))?;
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
    assert!(matches!(outcome, TxnOutcome::Committed(())));
    changes
}

fn commit_report(store: &mut EngineStore, report_id: Option<String>) {
    let outcome = commit_relay_cursor(
        store,
        "ws",
        &RelayCursor {
            bootstrap_complete: true,
            cursor: 65,
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            refusal_report_id: None,
            settlement_report_id: report_id,
        },
        &NoFaults,
        3_000,
    )
    .unwrap();
    assert!(matches!(outcome, TxnOutcome::Committed(_)));
}

fn queued(store: &EngineStore) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM owner_pending_settlements",
                [],
                |row| row.get(0),
            )
        })
        .unwrap()
}

struct FirstPageLive {
    probes: AtomicUsize,
}

impl LeaseProbe for FirstPageLive {
    fn is_live(&self, key: &DocKey) -> bool {
        self.probes.fetch_add(1, Ordering::Relaxed);
        key.workspace_id == "ws" && key.version_id == "main" && key.object_id != "object-64"
    }
}

#[test]
fn leased_page_rotates_without_hot_looping_or_starving_a_later_document() {
    let (_scratch, mut store) = test_store();
    let expected = seed_applied(&mut store, 65, None);
    let leases = FirstPageLive {
        probes: AtomicUsize::new(0),
    };

    let first = drain_and_claim(&mut store, "ws", &NoFaults, &leases).unwrap();
    assert!(first.changes.is_empty());
    assert!(first.report_id.is_none());
    assert!(!first.has_more, "a wholly leased page must not hot-loop");
    assert_eq!(leases.probes.load(Ordering::Relaxed), 65);

    leases.probes.store(0, Ordering::Relaxed);
    let second = drain_and_claim(&mut store, "ws", &NoFaults, &leases).unwrap();
    assert_eq!(second.changes, vec![expected[64].clone()]);
    assert!(second.report_id.is_some());
    assert!(leases.probes.load(Ordering::Relaxed) <= 65);
    commit_report(&mut store, second.report_id);
    assert_eq!(queued(&store), 64);

    let remaining = drain_and_claim(&mut store, "ws", &NoFaults, &leases).unwrap();
    assert!(remaining.changes.is_empty());
    assert!(!remaining.has_more);
}

#[test]
fn pending_reports_page_at_64_and_cursor_commit_releases_only_that_page() {
    let (_scratch, mut store) = test_store();
    let expected = seed_applied(&mut store, 65, None);
    let first = drain_and_claim(&mut store, "ws", &NoFaults, &NoLiveLeases).unwrap();
    assert_eq!(first.changes, expected[..64]);
    assert!(first.has_more);
    assert_eq!(
        queued(&store),
        65,
        "reporting must retain rows until commit"
    );
    commit_report(&mut store, first.report_id);
    assert_eq!(queued(&store), 1);

    let second = drain_and_claim(&mut store, "ws", &NoFaults, &NoLiveLeases).unwrap();
    assert_eq!(second.changes, expected[64..]);
    assert!(!second.has_more);
    commit_report(&mut store, second.report_id);
    assert_eq!(queued(&store), 0);
}

#[test]
fn reopened_pending_report_replays_collection_facts_and_rejects_stale_ack() {
    let (scratch, mut store) = test_store();
    let facts = CollectionRecordApplyFacts {
        collection_path: "tasks".into(),
        record_id: "record-1".into(),
        created: false,
        author_origin_id: Some("peer".into()),
        attribution: None,
        source: Some(("peer".into(), 0)),
        recorded_at_ms: 2_000,
        fields: vec![CollectionFieldChangeFact {
            field_name: "status".into(),
            previous_json: Some("\"open\"".into()),
            next_json: Some("\"done\"".into()),
            history_id: 7,
        }],
    };
    let expected = seed_applied(&mut store, 1, Some(&facts));
    let first = drain_and_claim(&mut store, "ws", &NoFaults, &NoLiveLeases).unwrap();
    assert_eq!(first.record_facts, vec![facts.clone()]);
    drop(store);

    let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 3_000).unwrap();
    let replay = drain_and_claim(&mut store, "ws", &NoFaults, &NoLiveLeases).unwrap();
    assert_eq!(replay.changes, expected);
    assert_eq!(replay.record_facts, vec![facts]);
    assert_ne!(first.report_id, replay.report_id);
    commit_report(&mut store, first.report_id);
    assert_eq!(
        queued(&store),
        1,
        "stale report cannot acknowledge a newer claim"
    );
    commit_report(&mut store, replay.report_id);
    assert_eq!(queued(&store), 0);
}
