use super::*;
use crate::tests::PagedRelay;
use dohc_engine_domain::VersionedTextStore;
use dohc_engine_storage::NoFaults;
use dohc_engine_testkit::open_store;
use serde_json::json;

fn decision(index: usize, object_id: String, claim: &str) -> BaseRepairDecision {
    BaseRepairDecision::Base {
        version_id: "main".into(),
        object_id,
        lineage_claim_id: claim.into(),
        origin_id: "peer".into(),
        origin_seq: index as i64,
        relay_seq: None,
        recorded_at_ms: 1_000,
    }
}

fn encoded_len(index: usize, object_id: String, claim: &str) -> usize {
    serde_json::to_vec(&("0".repeat(64), decision(index, object_id, claim)))
        .unwrap()
        .len()
        + 1
}

fn boundary_objects(delta: isize, claim: &str) -> Vec<String> {
    let mut objects = Vec::new();
    let mut bytes = 0;
    loop {
        let object = format!("doc-{:05}", objects.len());
        let next = encoded_len(objects.len(), object.clone(), claim);
        if bytes + next >= MAX_PREPARED_BASE_REPAIR_BYTES {
            break;
        }
        objects.push(object);
        bytes += next;
    }
    let padding = (MAX_PREPARED_BASE_REPAIR_BYTES - bytes) as isize + delta;
    assert!(padding >= 0);
    objects
        .last_mut()
        .unwrap()
        .push_str(&"x".repeat(padding as usize));
    assert!(objects.last().unwrap().len() <= crate::model::MAX_IDENTIFIER_BYTES);
    objects
}

fn seed(store: &mut EngineStore, objects: &[String], claim: &str) -> PagedRelay {
    VersionedTextStore::new(store)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .unwrap();
    crate::adopt_join_identity(store, "ws", "local", "epoch", "stream", 1_000, &NoFaults).unwrap();
    store
        .put_binary_blob(&dohc_engine_collab::Ydoc::wire().encode_full_state())
        .unwrap();
    store.write_with(&NoFaults, |tx| {
        for (index, object) in objects.iter().enumerate() {
            let path = format!("{object}.md");
            let payload = json!({"versionId": "main", "objectId": object, "path": path,
                "contentKind": "plaintext", "lineageClaimId": claim, "updateBlobSha256": claim, "isBaseState": true});
            tx.execute("INSERT INTO file_objects (workspace_id,object_id,created_at_ms) VALUES ('ws',?1,1000)", [object]).map_err(SyncError::persist)?;
            tx.execute("INSERT INTO ydoc_docs (workspace_id,version_id,object_id,content_kind,regime,updated_at_ms,path,lineage_claim_status,lineage_claim_id) VALUES ('ws','main',?1,'plaintext','replicated',1000,?2,'exact',?3)",
                params![object, path, claim]).map_err(SyncError::persist)?;
            tx.execute("INSERT INTO replication_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported,apply_disposition) VALUES ('ws','peer',?1,'ydoc.update',?2,1000,1,'applied')",
                params![index as i64, payload.to_string()]).map_err(SyncError::persist)?;
            tx.execute("INSERT INTO ydoc_base_relay_candidates (workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq) VALUES ('ws','main',?1,?2,'peer',?3)",
                params![object, claim, index as i64]).map_err(SyncError::persist)?;
        }
        Ok::<_, SyncError>(())
    }).unwrap();
    let mut relay = PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![ReplicationEnvelope {
                workspace_id: "ws".into(),
                origin_id: "remote".into(),
                origin_seq: 0,
                relay_seq: Some(1),
                op_kind: "workspace.init".into(),
                payload: json!({}),
                recorded_at_ms: 1_000,
                settlement_admission: None,
                admitted_author_snapshot: None,
            }],
            next_cursor: 1,
            has_more: false,
        },
    )]);
    for index in 0..objects.len() {
        relay = relay.with_coordinate("peer", index as i64, LogCoordinateResponse::Absent);
    }
    relay
}

fn remaining(store: &EngineStore) -> usize {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM ydoc_base_relay_candidates",
                [],
                |row| row.get::<_, i64>(0),
            )
        })
        .unwrap()
        .try_into()
        .unwrap()
}

fn apply(store: &mut EngineStore, page: &PreparedOrdinaryPull) {
    let offline = RelaySyncClient::new(PagedRelay::new([]));
    let result = offline
        .apply_pull(
            store,
            &mut Default::default(),
            "ws",
            page,
            &NoFaults,
            &crate::NoLiveLeases,
            2_000,
        )
        .unwrap();
    assert!(matches!(
        result,
        SyncPassOutcome::Complete { fetched: 1, .. }
    ));
}

fn boundary(delta: isize) {
    let (_scratch, _path, mut store) = open_store();
    let claim =
        dohc_engine_storage::hex_sha256(&dohc_engine_collab::Ydoc::wire().encode_full_state());
    let objects = boundary_objects(delta, &claim);
    let client = RelaySyncClient::new(seed(&mut store, &objects, &claim));
    let page = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
    assert_eq!(remaining(&store), objects.len(), "fetch applies no repair");
    assert!(page.repairs.encoded.len() <= MAX_PREPARED_BASE_REPAIR_BYTES);
    assert_eq!(
        page.repairs.encoded.capacity(),
        MAX_PREPARED_BASE_REPAIR_BYTES
    );
    if delta <= 0 {
        assert_eq!(
            page.repairs.encoded.len(),
            (MAX_PREPARED_BASE_REPAIR_BYTES as isize + delta) as usize
        );
    } else {
        assert_eq!(page.repairs.decode().unwrap().len(), objects.len() - 1);
    }
    apply(&mut store, &page);
    assert_eq!(remaining(&store), usize::from(delta > 0));
    let next = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
    assert_eq!(next.repairs.decode().unwrap().len(), usize::from(delta > 0));
    apply(&mut store, &next);
    assert_eq!(
        remaining(&store),
        0,
        "every deferred repair arrives on the next fetch"
    );
}

#[test]
fn prepared_repair_answers_just_under_the_byte_cap() {
    boundary(-1);
}

#[test]
fn prepared_repair_answers_exactly_at_the_byte_cap() {
    boundary(0);
}

#[test]
fn prepared_repair_answers_over_the_byte_cap_wait_for_the_next_fetch() {
    boundary(1);
}

#[test]
fn a_repair_answer_larger_than_the_byte_cap_goes_alone_in_its_batch() {
    // Identifiers cap a real answer far below the cap; this pins progress anyway.
    let mut answers = BaseRepairAnswers::default();
    let wide = "x".repeat(MAX_PREPARED_BASE_REPAIR_BYTES);
    assert!(
        answers
            .keep(wide.clone(), decision(0, "a".into(), "claim"))
            .unwrap()
    );
    assert!(answers.encoded.len() > MAX_PREPARED_BASE_REPAIR_BYTES);
    assert!(
        !answers
            .keep("0".repeat(64), decision(1, "b".into(), "claim"))
            .unwrap()
    );
    let kept = answers.decode().unwrap();
    assert_eq!(kept.len(), 1);
    assert!(kept.contains_key(&wide));
}

#[test]
fn prepared_repairs_replay_after_a_stop_before_apply() {
    let (_scratch, path, mut store) = open_store();
    let claim =
        dohc_engine_storage::hex_sha256(&dohc_engine_collab::Ydoc::wire().encode_full_state());
    let objects = boundary_objects(0, &claim);
    let client = RelaySyncClient::new(seed(&mut store, &objects, &claim));
    let first = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
    let encoded = first.repairs.encoded.clone();
    assert_eq!(encoded.len(), MAX_PREPARED_BASE_REPAIR_BYTES);
    let ops = first.ops.clone();
    drop(first);
    drop(store);
    let mut store = EngineStore::open(&path, 2_000).unwrap();
    assert_eq!(remaining(&store), objects.len());
    assert_eq!(crate::read_relay_cursor(&store, "ws").unwrap(), None);
    let imported: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log WHERE origin_id='remote'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(imported, 0);
    let second = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
    assert_eq!(second.ops, ops);
    assert_eq!(second.repairs.encoded, encoded);
    assert_eq!(remaining(&store), objects.len());
    assert_eq!(crate::read_relay_cursor(&store, "ws").unwrap(), None);
    apply(&mut store, &second);
    assert_eq!(remaining(&store), 0);
}

#[test]
fn prepared_repairs_keep_a_group_wider_than_a_lookup_batch_atomic() {
    let (_scratch, _path, mut store) = open_store();
    let claim =
        dohc_engine_storage::hex_sha256(&dohc_engine_collab::Ydoc::wire().encode_full_state());
    let objects: Vec<_> = (0..600).map(|index| format!("doc-{index:05}")).collect();
    let mut relay = seed(&mut store, &objects, &claim);
    store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE ydoc_base_relay_candidates SET object_id='doc-00000'", []).map_err(SyncError::persist)?;
        tx.execute("UPDATE replication_log SET payload_json=json_set(payload_json,'$.objectId','doc-00000','$.path','doc-00000.md') WHERE origin_id='peer'", []).map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    }).unwrap();
    let payload: serde_json::Value =
        store
            .read_with(|conn| {
                conn.query_row(
        "SELECT payload_json FROM replication_log WHERE origin_id='peer' AND origin_seq=0", [],
        |row| row.get::<_, String>(0))
            })
            .map(|payload| serde_json::from_str(&payload).unwrap())
            .unwrap();
    for index in 0..600 {
        relay = relay.with_coordinate(
            "peer",
            index,
            LogCoordinateResponse::Present(ReplicationEnvelope {
                workspace_id: "ws".into(),
                origin_id: "peer".into(),
                origin_seq: index,
                relay_seq: Some(600 - index),
                op_kind: "ydoc.update".into(),
                payload: payload.clone(),
                recorded_at_ms: 1_000,
                settlement_admission: None,
                admitted_author_snapshot: None,
            }),
        );
    }
    let client = RelaySyncClient::new(relay);
    let page = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
    assert_eq!(remaining(&store), 600);
    assert_eq!(page.repairs.decode().unwrap().len(), 1);
    assert!(page.repairs.encoded.len() < MAX_PREPARED_BASE_REPAIR_BYTES);
    apply(&mut store, &page);
    assert_eq!(remaining(&store), 0);
    let sequence: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT base_relay_seq FROM ydoc_docs WHERE object_id='doc-00000'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        sequence, 1,
        "the minimum answer was in the last lookup batch"
    );
}

#[test]
fn prepared_deferred_repairs_share_the_byte_cap_and_resume_on_the_next_fetch() {
    let (_scratch, _path, mut store) = open_store();
    let claim =
        dohc_engine_storage::hex_sha256(&dohc_engine_collab::Ydoc::wire().encode_full_state());
    let objects: Vec<_> = (0..600).map(|index| format!("doc-{index:05}")).collect();
    let mut relay = seed(&mut store, &objects, &claim);
    store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO ydoc_deferred_updates (workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq,recorded_at_ms) SELECT workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq,1000 FROM ydoc_base_relay_candidates", []).map_err(SyncError::persist)?;
        tx.execute("DELETE FROM ydoc_base_relay_candidates", []).map_err(SyncError::persist)?;
        tx.execute("UPDATE ydoc_docs SET base_relay_confirmed_absent=1", []).map_err(SyncError::persist)?;
        tx.execute("UPDATE replication_log SET payload_json=json_set(payload_json,'$.isBaseState',json('false')) WHERE origin_id='peer'", []).map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    }).unwrap();
    for index in 0..600 {
        let payload: serde_json::Value = store.read_with(|conn| conn.query_row(
            "SELECT payload_json FROM replication_log WHERE origin_id='peer' AND origin_seq=?1", [index],
            |row| row.get::<_, String>(0))).map(|payload| serde_json::from_str(&payload).unwrap()).unwrap();
        relay = relay.with_coordinate(
            "peer",
            index,
            LogCoordinateResponse::Present(ReplicationEnvelope {
                workspace_id: "ws".into(),
                origin_id: "peer".into(),
                origin_seq: index,
                relay_seq: Some(index + 1),
                op_kind: "ydoc.update".into(),
                payload,
                recorded_at_ms: 1_000,
                settlement_admission: None,
                admitted_author_snapshot: None,
            }),
        );
    }
    let unresolved = |store: &EngineStore| -> usize {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_deferred_updates WHERE relay_seq IS NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
            })
            .unwrap()
            .try_into()
            .unwrap()
    };
    let client = RelaySyncClient::new(relay);
    let first = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
    let held = first.repairs.decode().unwrap().len();
    assert!(held > 0 && held < 600);
    assert!(first.repairs.encoded.len() <= MAX_PREPARED_BASE_REPAIR_BYTES);
    assert_eq!(unresolved(&store), 600, "fetch applies no deferred repair");
    apply(&mut store, &first);
    assert_eq!(unresolved(&store), 600 - held);
    let second = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
    assert_eq!(second.repairs.decode().unwrap().len(), 600 - held);
    apply(&mut store, &second);
    assert_eq!(unresolved(&store), 0);
}

#[test]
fn prepared_repairs_leave_a_changed_candidate_group_for_the_next_fetch() {
    let (_scratch, _path, mut store) = open_store();
    let claim =
        dohc_engine_storage::hex_sha256(&dohc_engine_collab::Ydoc::wire().encode_full_state());
    let relay = seed(&mut store, &["doc-00000".into()], &claim).with_coordinate(
        "peer",
        1,
        LogCoordinateResponse::Absent,
    );
    let client = RelaySyncClient::new(relay);
    let page = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
    store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO replication_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported,apply_disposition) SELECT workspace_id,origin_id,1,op_kind,payload_json,recorded_at_ms,imported,apply_disposition FROM replication_log WHERE origin_id='peer' AND origin_seq=0", []).map_err(SyncError::persist)?;
        tx.execute("INSERT INTO ydoc_base_relay_candidates (workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq) SELECT workspace_id,version_id,object_id,lineage_claim_id,origin_id,1 FROM ydoc_base_relay_candidates", []).map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    }).unwrap();
    apply(&mut store, &page);
    assert_eq!(
        remaining(&store),
        2,
        "a stale answer must not discard a new candidate"
    );
    let page = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
    apply(&mut store, &page);
    assert_eq!(remaining(&store), 0);
}
