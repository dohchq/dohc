use super::*;
use crate::tests::PagedRelay;
use dohc_engine_domain::VersionedTextStore;
use dohc_engine_storage::NoFaults;
use dohc_engine_testkit::open_store;
use serde_json::json;

fn boundary_objects(delta: isize, _claim: &str) -> Vec<String> {
    (0..(MAX_BASE_REPAIR_LOOKUPS as isize + delta) as usize)
        .map(|index| format!("00000000-0000-0000-0000-{index:012x}"))
        .collect()
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

fn touching(mut relay: PagedRelay, object: &str) -> PagedRelay {
    relay.pages.get_mut(&0).unwrap().ops[0].payload = json!({"objectId": object});
    relay
}

#[test]
fn prepared_repairs_prioritize_the_page_object_past_the_cap() {
    let (_scratch, _path, mut store) = open_store();
    let claim =
        dohc_engine_storage::hex_sha256(&dohc_engine_collab::Ydoc::wire().encode_full_state());
    let mut objects = boundary_objects(0, &claim);
    objects.push("zz-page".into());
    let relay = touching(seed(&mut store, &objects, &claim), "zz-page");
    let client = RelaySyncClient::new(relay);
    let page = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
    assert!(
        page.repairs
            .by_signature()
            .values()
            .any(|decision| matches!(decision,
        BaseRepairDecision::Base {object_id, ..} if object_id == "zz-page"))
    );
    apply(&mut store, &page);
    let unresolved: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM ydoc_base_relay_candidates WHERE object_id='zz-page'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(unresolved, 0);
}

#[test]
fn prepared_repairs_keep_the_earliest_base_when_a_later_copy_arrives() {
    earliest_base_survives_later_copies(false);
}

#[test]
fn prepared_repairs_keep_pending_dependencies_on_the_winning_base() {
    earliest_base_survives_later_copies(true);
}

fn earliest_base_survives_later_copies(pending_dependencies: bool) {
    use dohc_engine_collab::{ContentKind, DocKey, WriterDocCache, Ydoc};

    let (_scratch, _path, mut store) = open_store();
    let padding_claim = dohc_engine_storage::hex_sha256(&Ydoc::wire().encode_full_state());
    let padding: Vec<_> = (0..MAX_BASE_REPAIR_LOOKUPS)
        .map(|index| format!("00000000-0000-0000-0000-{index:012x}"))
        .collect();
    seed(&mut store, &padding, &padding_claim);
    let key = DocKey::new("ws", "main", "zz-document").unwrap();
    let path = "document.md";
    assert!(padding.iter().all(|object| object < &key.object_id));

    let local = Ydoc::wire();
    local.plaintext_insert(0, "local base");
    let local_claim = store.put_binary_blob(&local.encode_full_state()).unwrap();
    let competing = Ydoc::wire();
    competing.plaintext_insert(0, "competing base");
    let competing_claim = store
        .put_binary_blob(&competing.encode_full_state())
        .unwrap();
    assert_ne!(local_claim, competing_claim);
    let base =
        |origin: &str, claim: &str, relay_seq: i64, recorded_at_ms: i64| ReplicationEnvelope {
            workspace_id: "ws".into(),
            origin_id: origin.into(),
            origin_seq: 0,
            op_kind: "ydoc.update".into(),
            payload: json!({
                "versionId": "main",
                "objectId": key.object_id,
                "path": path,
                "contentKind": "plaintext",
                "lineageClaimId": claim,
                "updateBlobSha256": claim,
                "isBaseState": true
            }),
            recorded_at_ms,
            relay_seq: Some(relay_seq),
            settlement_admission: None,
            admitted_author_snapshot: None,
        };
    let original = base("original-base", &local_claim, 5, 1_000);
    let duplicate = base("duplicate-base", &local_claim, 1_002, 1_200);
    let competing = base("competing-base", &competing_claim, 1_001, 1_300);
    let mut cache = WriterDocCache::new();
    let outcome = crate::apply_ydoc_envelope(
        &mut store,
        &mut cache,
        &original,
        &NoFaults,
        &crate::NoLiveLeases,
    )
    .unwrap();
    assert!(matches!(outcome.primary, ApplyDisposition::Applied(_)));
    if pending_dependencies {
        let dependency = Ydoc::wire();
        let _predecessor = dependency.plaintext_insert(0, "dependency");
        let pending = dependency.plaintext_insert(0, "pending ");
        let pending_sha = store.put_binary_blob(&pending).unwrap();
        let mut delta = original.clone();
        delta.origin_id = "pending-dependency".into();
        delta.relay_seq = Some(6);
        delta.recorded_at_ms = 1_100;
        delta.payload["updateBlobSha256"] = json!(pending_sha);
        delta.payload["isBaseState"] = json!(false);
        let outcome = crate::apply_ydoc_envelope(
            &mut store,
            &mut cache,
            &delta,
            &NoFaults,
            &crate::NoLiveLeases,
        )
        .unwrap();
        assert!(matches!(outcome.primary, ApplyDisposition::Applied(_)));
    }
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_docs SET base_relay_seq=NULL \
                 WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                [&key.object_id],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO ydoc_base_relay_candidates \
                 (workspace_id,version_id,object_id,lineage_claim_id,origin_id,origin_seq) \
                 VALUES ('ws','main',?1,?2,?3,0)",
                params![key.object_id, local_claim, original.origin_id],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO sync_relay_cursors \
                 (workspace_id,cursor,replication_epoch,stream_identity,bootstrap_complete) \
                 VALUES ('ws','1000','epoch','stream',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let before = dohc_engine_collab::load_persisted(&store, &key)
        .unwrap()
        .unwrap();
    assert_eq!(
        before.marker.lineage_claim_id.as_deref(),
        Some(local_claim.as_str())
    );
    assert_eq!(before.marker.base_relay_seq, None);
    assert!(!before.marker.base_relay_confirmed_absent);
    assert_eq!(before.doc.has_pending_dependencies(), pending_dependencies);
    assert_eq!(remaining(&store), MAX_BASE_REPAIR_LOOKUPS + 1);

    let mut relay = PagedRelay::new([(
        1_000,
        PullResponse {
            ops: vec![competing.clone(), duplicate.clone()],
            next_cursor: 1_002,
            has_more: false,
        },
    )]);
    for index in 0..padding.len() {
        relay = relay.with_coordinate("peer", index as i64, LogCoordinateResponse::Absent);
    }
    relay = relay.with_coordinate(
        &original.origin_id,
        original.origin_seq,
        LogCoordinateResponse::Present(original.clone()),
    );
    let client = RelaySyncClient::new(relay);
    let page = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
    assert_eq!(
        crate::read_relay_cursor(&store, "ws")
            .unwrap()
            .unwrap()
            .cursor,
        1_000
    );
    assert_eq!(
        dohc_engine_collab::read_marker(&store, &key)
            .unwrap()
            .unwrap()
            .base_relay_seq,
        None
    );
    let offline = RelaySyncClient::new(PagedRelay::new([]));
    let outcome = offline
        .apply_pull(
            &mut store,
            &mut WriterDocCache::new(),
            "ws",
            &page,
            &NoFaults,
            &crate::NoLiveLeases,
            2_000,
        )
        .unwrap();
    assert!(matches!(
        outcome,
        SyncPassOutcome::Complete {
            fetched: 2,
            refused: 0,
            pending_cursor: Some(RelayCursor { cursor: 1_002, .. }),
            ..
        }
    ));
    for origin in [&duplicate.origin_id, &competing.origin_id] {
        assert_eq!(
            crate::read_replication_acked_seq(&store, "ws", origin).unwrap(),
            0
        );
    }
    let archived: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM ydoc_inactive_lineages \
                 WHERE workspace_id='ws' AND version_id='main' \
                   AND object_id=?1 AND lineage_claim_id=?2",
                params![key.object_id, local_claim],
                |row| row.get(0),
            )
        })
        .unwrap();
    if pending_dependencies {
        assert_eq!(archived, 0, "the winning lineage must remain active");
    }
    let after = dohc_engine_collab::load_persisted(&store, &key)
        .unwrap()
        .unwrap();
    assert_eq!(
        after.marker.lineage_claim_id.as_deref(),
        Some(local_claim.as_str()),
        "the base at relay position 5 must beat the base at 1001"
    );
    assert_eq!(after.marker.base_relay_seq, Some(5));
    assert_eq!(
        after.marker.base_origin_id.as_deref(),
        Some(original.origin_id.as_str())
    );
    assert_eq!(after.doc.has_pending_dependencies(), pending_dependencies);
    assert_eq!(
        after.doc.project(ContentKind::Plaintext).unwrap().content,
        "local base"
    );
    assert_eq!(archived, 0);
}

#[test]
fn prepared_page_waits_for_repairs_that_exceed_the_cap() {
    let (_scratch, _path, mut store) = open_store();
    let claim =
        dohc_engine_storage::hex_sha256(&dohc_engine_collab::Ydoc::wire().encode_full_state());
    let objects: Vec<_> = (0..600).map(|index| format!("doc-{index:05}")).collect();
    let mut relay = seed(&mut store, &objects, &claim);
    relay.pages.get_mut(&0).unwrap().ops[0].payload = json!({"objects": objects.iter()
        .map(|object| json!({"objectId": object})).collect::<Vec<_>>()});
    let client = RelaySyncClient::new(relay);
    let mut before = objects.len();
    loop {
        let page = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
        match client.apply_pull(
            &mut store,
            &mut Default::default(),
            "ws",
            &page,
            &NoFaults,
            &crate::NoLiveLeases,
            2_000,
        ) {
            Err(RelayError::RepairPending) => {
                let after = remaining(&store);
                assert!(after > 0 && after < before);
                assert_eq!(crate::read_relay_cursor(&store, "ws").unwrap(), None);
                before = after;
            }
            Ok(_) => {
                assert_eq!(remaining(&store), 0);
                break;
            }
            Err(error) => panic!("unexpected pull: {error:?}"),
        }
    }
}

#[test]
fn prepared_page_retries_changed_repairs_once_then_applies() {
    let (_scratch, _path, mut store) = open_store();
    let claim =
        dohc_engine_storage::hex_sha256(&dohc_engine_collab::Ydoc::wire().encode_full_state());
    let client = RelaySyncClient::new(touching(seed(&mut store, &["doc".into()], &claim), "doc"));
    let page = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
    change_candidate(&mut store);
    assert_repair_retry(&client, &mut store, &page);
    let page = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
    apply(&mut store, &page);
    assert_eq!(remaining(&store), 0);
}

fn change_candidate(store: &mut EngineStore) {
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE replication_log SET recorded_at_ms=recorded_at_ms+1 WHERE origin_id='peer'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

fn assert_repair_retry(
    client: &RelaySyncClient<PagedRelay>,
    store: &mut EngineStore,
    page: &PreparedOrdinaryPull,
) {
    assert!(matches!(
        client.apply_pull(
            store,
            &mut Default::default(),
            "ws",
            page,
            &NoFaults,
            &crate::NoLiveLeases,
            2_000
        ),
        Err(RelayError::RepairPending)
    ));
    assert_eq!(crate::read_relay_cursor(store, "ws").unwrap(), None);
    let (token, applied): (Option<String>, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT ordinary_pull_token FROM sync_identity WHERE workspace_id='ws'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log WHERE origin_id='remote'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .unwrap();
    assert_eq!(token, None);
    assert_eq!(applied, 0);
}

#[test]
fn repeated_repair_changes_finish_at_the_fetch_writer_boundary() {
    let (_scratch, _path, mut store) = open_store();
    let claim =
        dohc_engine_storage::hex_sha256(&dohc_engine_collab::Ydoc::wire().encode_full_state());
    let client = RelaySyncClient::new(touching(seed(&mut store, &["doc".into()], &claim), "doc"));
    for _ in 0..3 {
        let page = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
        change_candidate(&mut store);
        assert_repair_retry(&client, &mut store, &page);
    }
    let page = client
        .fetch_pull_settling_repairs(&mut store, "ws", &NoFaults)
        .unwrap();
    assert_eq!(remaining(&store), 0);
    change_candidate(&mut store);
    apply(&mut store, &page);
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
    let origin = "origin_0123456789abcdef0123456789abcdef";
    let mut relay = seed(&mut store, &objects, &claim);
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE replication_log SET origin_id=?1 WHERE origin_id='peer'",
                [origin],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "UPDATE ydoc_base_relay_candidates SET origin_id=?1 WHERE origin_id='peer'",
                [origin],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    for index in 0..objects.len() {
        relay = relay.with_coordinate(origin, index as i64, LogCoordinateResponse::Absent);
    }
    let client = RelaySyncClient::new(relay);
    let page = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
    assert_eq!(remaining(&store), objects.len(), "fetch applies no repair");
    let held = objects.len().min(MAX_BASE_REPAIR_LOOKUPS);
    assert_eq!(page.repairs.decisions.len(), held);
    assert_eq!(
        client.transport().coordinate_lookups.lock().unwrap().len(),
        held
    );
    assert!(
        page.repairs
            .decisions
            .iter()
            .all(|(_, decision)| matches!(decision,
        BaseRepairDecision::Base {object_id, origin_id, lineage_claim_id, ..}
        if object_id.len() == 36 && origin_id == origin && lineage_claim_id.len() == 64))
    );
    apply(&mut store, &page);
    assert_eq!(remaining(&store), usize::from(delta > 0));
    let next = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
    assert_eq!(next.repairs.decisions.len(), usize::from(delta > 0));
    if delta > 0 {
        assert!(matches!(
            &next.repairs.decisions[0].1,
            BaseRepairDecision::Base {
                origin_seq: 256,
                ..
            }
        ));
    }
    assert_eq!(
        client.transport().coordinate_lookups.lock().unwrap().len(),
        objects.len()
    );
    apply(&mut store, &next);
    assert_eq!(
        remaining(&store),
        0,
        "every deferred repair arrives on the next fetch"
    );
}

#[test]
fn prepared_repair_answers_just_under_the_count_cap() {
    boundary(-1);
}

#[test]
fn prepared_repair_answers_exactly_at_the_count_cap() {
    boundary(0);
}

#[test]
fn prepared_repair_answer_257_starts_the_next_fetch() {
    boundary(1);
}

#[test]
fn prepared_repairs_replay_after_a_stop_before_apply() {
    let (_scratch, path, mut store) = open_store();
    let claim =
        dohc_engine_storage::hex_sha256(&dohc_engine_collab::Ydoc::wire().encode_full_state());
    let objects = boundary_objects(0, &claim);
    let client = RelaySyncClient::new(seed(&mut store, &objects, &claim));
    let first = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
    let decisions = first.repairs.decisions.clone();
    assert_eq!(decisions.len(), MAX_BASE_REPAIR_LOOKUPS);
    let ops = first.ops.lock().unwrap().clone();
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
    assert_eq!(*second.ops.lock().unwrap(), ops);
    assert_eq!(second.repairs.decisions, decisions);
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
    assert_eq!(page.repairs.decisions.len(), 1);
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
fn prepared_deferred_repairs_share_the_count_cap_and_resume_on_the_next_fetch() {
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
    let held = first.repairs.decisions.len();
    assert!(held > 0 && held < 600);
    assert_eq!(held, MAX_BASE_REPAIR_LOOKUPS);
    assert_eq!(unresolved(&store), 600, "fetch applies no deferred repair");
    apply(&mut store, &first);
    assert_eq!(unresolved(&store), 600 - held);
    while unresolved(&store) > 0 {
        let before = unresolved(&store);
        let next = client.fetch_pull(&mut store, "ws", &NoFaults).unwrap();
        assert_eq!(
            next.repairs.decisions.len(),
            before.min(MAX_BASE_REPAIR_LOOKUPS)
        );
        apply(&mut store, &next);
        assert!(unresolved(&store) < before);
    }
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
