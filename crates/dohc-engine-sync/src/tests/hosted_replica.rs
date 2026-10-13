use super::*;
use std::cell::Cell;

const HOST: &str = "service-host:host";

fn hosted_store() -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let (scratch, path, mut store) = open_store();
    assert_eq!(
        create_hosted_replica(
            &mut store, "ws", HOST, "epoch-1", "stream-1", 1_000, &NoFaults
        )
        .unwrap(),
        TxnOutcome::Committed(AdoptJoinIdentityOutcome::Adopted)
    );
    (scratch, path, store)
}

fn op(seq: i64, body: &str) -> ReplicationEnvelope {
    envelope("owner", seq, "probe.remote", json!({ "body": body }))
}

/// Admit `op`, counting how often its mutation runs.
fn admit(
    store: &mut EngineStore,
    op: &ReplicationEnvelope,
    mutations: &Cell<usize>,
) -> Result<ApplyDisposition<()>, SyncError> {
    apply_envelope_with(store, op, &NoFaults, |_tx, _op| {
        mutations.set(mutations.get() + 1);
        Ok(())
    })
    .map(|outcome| outcome.primary)
}

fn journaled(store: &EngineStore) -> Vec<i64> {
    store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT origin_seq FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id='owner' ORDER BY origin_seq",
            )?;
            let rows = statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<i64>, _>>()?;
            Ok::<_, rusqlite::Error>(rows)
        })
        .unwrap()
}

fn retained(store: &EngineStore) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM relay_deferred_ops", [], |row| {
                row.get(0)
            })
        })
        .unwrap()
}

#[test]
fn a_replica_is_hosted_only_by_its_row() {
    let (_scratch, _path, mut store) = open_store();
    for refused in [
        create_hosted_replica(
            &mut store,
            "ws",
            "origin:host",
            "epoch-1",
            "stream-1",
            1,
            &NoFaults,
        ),
        adopt_join_identity(&mut store, "ws", HOST, "epoch-1", "stream-1", 1, &NoFaults),
    ] {
        assert!(matches!(refused, Err(SyncError::InvalidInput { .. })));
    }
    seed_identity(&mut store);
    assert!(
        matches!(
            create_hosted_replica(&mut store, "ws", HOST, "epoch-1", "stream-1", 1, &NoFaults),
            Err(SyncError::InvalidInput { .. })
        ),
        "an ordinary replica never becomes hosted"
    );

    let (_scratch, _path, mut hosted) = hosted_store();
    assert_eq!(
        create_hosted_replica(&mut hosted, "ws", HOST, "epoch-1", "stream-1", 1, &NoFaults)
            .unwrap(),
        TxnOutcome::Committed(AdoptJoinIdentityOutcome::AlreadyMatched)
    );
    assert!(
        matches!(
            adopt_join_identity(
                &mut hosted,
                "ws",
                "origin:x",
                "epoch-1",
                "stream-1",
                1,
                &NoFaults
            ),
            Err(SyncError::InvalidInput { .. })
        ),
        "a hosted replica never becomes ordinary"
    );
}

#[test]
fn hosted_admission_takes_sparse_origins_that_ordinary_admission_refuses() {
    let mutations = Cell::new(0);
    let (_ordinary_scratch, _ordinary_path, mut ordinary) = open_store();
    seed_identity(&mut ordinary);
    assert_eq!(
        admit(&mut ordinary, &op(0, "first"), &mutations).unwrap(),
        ApplyDisposition::Applied(())
    );
    assert!(matches!(
        admit(&mut ordinary, &op(2, "after a gap"), &mutations),
        Err(SyncError::SequenceGap)
    ));
    assert_eq!(
        read_replication_acked_seq(&ordinary, "ws", "owner").unwrap(),
        0
    );

    let (_scratch, _path, mut hosted) = hosted_store();
    for seq in [0, 2, 5] {
        assert_eq!(
            admit(&mut hosted, &op(seq, "sparse"), &mutations).unwrap(),
            ApplyDisposition::Applied(())
        );
    }
    assert_eq!(mutations.get(), 4);
    assert_eq!(journaled(&hosted), [0, 2, 5]);
    assert_eq!(
        read_replication_acked_seq(&hosted, "ws", "owner").unwrap(),
        -1,
        "sparse admission never moves the ordinary ack"
    );
}

#[test]
fn hosted_backfill_below_applied_coordinates_applies_exactly_once() {
    let mutations = Cell::new(0);
    let (_scratch, _path, mut store) = hosted_store();
    for (seq, body) in [(5, "later"), (2, "backfill")] {
        assert_eq!(
            admit(&mut store, &op(seq, body), &mutations).unwrap(),
            ApplyDisposition::Applied(())
        );
    }
    for (seq, body) in [(2, "backfill"), (5, "later")] {
        assert_eq!(
            admit(&mut store, &op(seq, body), &mutations).unwrap(),
            ApplyDisposition::Skipped,
            "redelivery of {seq}"
        );
    }
    assert!(matches!(
        admit(&mut store, &op(2, "divergent"), &mutations),
        Err(SyncError::CoordinateDiverged)
    ));
    assert_eq!(mutations.get(), 2);
    assert_eq!(journaled(&store), [2, 5]);
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "owner").unwrap(),
        -1
    );
}

#[test]
fn hosted_deferred_work_replays_by_coordinate_membership() {
    let mutations = Cell::new(0);
    let (_scratch, _path, mut store) = hosted_store();
    let identity = read_sync_identity(&store, "ws").unwrap().unwrap();
    let (early, late) = (op(3, "early"), op(7, "late"));
    crate::deferred::retain(&mut store, &identity, &[&early, &late], &NoFaults).unwrap();
    let held = |store: &EngineStore| crate::deferred::read(store, "ws", &identity).unwrap().1;
    assert_eq!(held(&store), BTreeSet::from(["owner".to_owned()]));

    admit(&mut store, &early, &mutations).unwrap();
    assert!(
        crate::deferred::has_unapplied(&store, "ws").unwrap(),
        "the later coordinate still waits"
    );
    admit(&mut store, &late, &mutations).unwrap();
    assert!(!crate::deferred::has_unapplied(&store, "ws").unwrap());
    assert!(held(&store).is_empty());
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "owner").unwrap(),
        -1
    );
}

#[test]
fn hosted_conflict_child_waits_for_its_withheld_parent() {
    use crate::conflict_resolve_v1::{
        ConflictResolveV1, EffectContextV1, EffectKindV1, EffectV1, HeadContentKindV1, HeadV1,
        MetadataV1, PresentHeadV1, ResolutionV1, ResolveChoiceV1, build_conflict_resolve_v1,
    };

    let (_scratch, _path, mut store) = hosted_store();
    seed_replication_version(&mut store, "main", "main");
    let result_text = "resolved by the owner";
    let result_sha = dohc_engine_storage::hex_sha256(result_text.as_bytes());
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![result_sha, result_text.len() as i64, result_text],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let result = HeadV1::Present(PresentHeadV1 {
        path_ref: 0,
        object_id: "hosted-object".to_owned(),
        latest_moment_id: "owner-moment".to_owned(),
        content_kind: HeadContentKindV1::Text,
        blob_sha256: result_sha,
        byte_length: result_text.len() as i64,
        updated_at_ms: 21,
    });
    let built = build_conflict_resolve_v1(ConflictResolveV1 {
        workspace_id: "ws".to_owned(),
        conflict_id: "owner-conflict".to_owned(),
        chosen_from: ResolveChoiceV1::Incoming,
        resolution: ResolutionV1::AppliedIncoming,
        target_version_id: "main".to_owned(),
        source_version_id: "peer".to_owned(),
        paths: vec!["hosted.md".to_owned()],
        current: HeadV1::Absent { path_ref: 0 },
        incoming: result.clone(),
        result,
        effect_context: EffectContextV1 {
            recorded_at_ms: 21,
            metadata: MetadataV1 {
                origin: "sync".to_owned(),
                summary: None,
                correlation_id: None,
            },
            author: None,
            current_object_created_at_ms: None,
            result_object_created_at_ms: Some(20),
        },
        effects: vec![EffectV1 {
            kind: EffectKindV1::Write,
            moment_id: "owner-moment".to_owned(),
            payload_sha256: String::new(),
        }],
        lineage_transition: None,
        exported_before: None,
    })
    .unwrap();
    let mut parent = envelope("owner", 0, "conflict.resolve", built.value.clone());
    parent.recorded_at_ms = 21;
    let mut child = envelope(
        "owner",
        1,
        "moment.append",
        built.validated.shadows[0].clone(),
    );
    child.recorded_at_ms = 21;

    assert!(matches!(
        apply_replication_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &child,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::RetryableState {
            reason: crate::hosted::CONFLICT_PARENT_WITHHELD
        })
    ));
    assert!(
        journaled(&store).is_empty(),
        "a waiting child is not admitted"
    );

    let client = RelaySyncClient::new(PagedRelay::new([
        (
            0,
            PullResponse {
                ops: vec![child],
                next_cursor: 1,
                has_more: false,
            },
        ),
        (
            1,
            PullResponse {
                ops: vec![parent],
                next_cursor: 2,
                has_more: false,
            },
        ),
    ]));
    for pass in 1..=2 {
        let SyncPassOutcome::Complete {
            pending_cursor: Some(pending),
            ..
        } = client
            .pull_chat_workspace(
                &mut store,
                &mut WriterDocCache::new(),
                "ws",
                &NoFaults,
                &NoLiveLeases,
                1_000 + pass,
            )
            .unwrap()
        else {
            panic!("completed pass {pass}");
        };
        assert_eq!(
            pending.cursor, pass,
            "the cursor moves past a waiting child"
        );
        client
            .commit_pull_cursor(
                &mut store,
                "ws",
                &pending,
                &NoFaults,
                &NoLiveLeases,
                1_000 + pass,
            )
            .unwrap();
        if pass == 1 {
            assert_eq!(retained(&store), 1, "the child is kept for retry");
            assert!(journaled(&store).is_empty());
        }
    }
    assert_eq!(retained(&store), 0);
    assert_eq!(journaled(&store), [0, 1]);
    let moments: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' AND moment_id='owner-moment'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        moments, 1,
        "the resolution applies once, through its parent"
    );
}

#[test]
fn hosted_outbound_sequences_survive_purged_journal_rows_and_reopen() {
    let (_scratch, path, mut store) = hosted_store();
    let journal = |store: &mut EngineStore| match journal_local_replication_op(
        store,
        "ws",
        HOST,
        "epoch-1",
        "stream-1",
        "probe.local",
        &json!({}),
        1_000,
        &NoFaults,
    )
    .unwrap()
    {
        TxnOutcome::Committed(seq) => seq,
        TxnOutcome::Crashed { .. } => panic!("no fault was injected"),
    };
    let mut written = vec![journal(&mut store), journal(&mut store)];
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM replication_log WHERE workspace_id='ws'", [])
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    drop(store);

    let mut store = EngineStore::open(&path, 2_000).unwrap();
    written.push(journal(&mut store));
    let TxnOutcome::Committed(in_tx) = store
        .write_with(&NoFaults, |tx| {
            journal_local_op_in_tx(tx, "ws", "probe.local", &json!({}), 2_000)
        })
        .unwrap()
    else {
        panic!("no fault was injected");
    };
    written.push(in_tx);
    assert_eq!(written, [0, 1, 2, 3]);
}
