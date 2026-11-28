use super::*;

const PATH: &str = "notes/late.md";
const CLAIM: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const FIRST: &str = "# Late\n\nTyped before.\n";
const SECOND: &str = "# Late\n\nTyped before.\n\nTyped after.\n";

fn replica(origin: &str) -> (ScratchDir, EngineStore) {
    let (scratch, _path, mut store) = open_store();
    seed_replication_version(&mut store, "main", "main");
    adopt_join_identity(
        &mut store, "ws", origin, "epoch-1", "stream-1", 1_000, &NoFaults,
    )
    .expect("identity");
    journal_local_replication_op(
        &mut store,
        "ws",
        origin,
        "epoch-1",
        "stream-1",
        "probe.local",
        &json!({}),
        1_000,
        &NoFaults,
    )
    .expect("probe");
    seed_text_head(&mut store, "late", PATH, "# Late\n");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                 VALUES ('ws',?1,-1)",
                [origin],
            )
            .map_err(SyncError::persist)
        })
        .expect("push lane");
    (scratch, store)
}

fn author(name: &str) -> String {
    json!([{"kind": "human", "humanId": name, "humanName": name}]).to_string()
}

fn recover(store: &mut EngineStore, content: &str, previous: &str, state: &str, by: &str) {
    let key = dohc_engine_collab::DocKey::new("ws", "main", "late").expect("key");
    store
        .write_with(&NoFaults, |tx| {
            crate::ydoc_recovery::recover_inactive_projection_in_tx(
                tx,
                &key,
                PATH,
                CLAIM,
                content,
                &dohc_engine_storage::hex_sha256(previous.as_bytes()),
                state,
                Some(&author(by)),
                2_000,
                None,
            )
        })
        .expect("recover");
}

fn recovered_twice(origin: &str, by: &str) -> (ScratchDir, EngineStore) {
    let (scratch, mut store) = replica(origin);
    recover(&mut store, FIRST, "", "state-1", by);
    recover(&mut store, SECOND, FIRST, "state-2", by);
    (scratch, store)
}

fn moments(store: &EngineStore) -> Vec<String> {
    store
        .read_with(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT moment_id||'|'||object_id||'|'||path||'|'||COALESCE(author_json,'') \
                     FROM moments WHERE moment_id GLOB 'ydoc-*recovery-*' ORDER BY moment_order",
                )
                .map_err(SyncError::corrupt)?;
            statement
                .query_map([], |row| row.get(0))
                .map_err(SyncError::corrupt)?
                .collect::<Result<Vec<String>, _>>()
                .map_err(SyncError::corrupt)
        })
        .expect("moments")
}

fn served(from: &EngineStore, origin: &str, to: &mut EngineStore) -> Vec<ReplicationEnvelope> {
    let mut ops = list_replication_ops(from, "ws", origin, -1, 10).expect("served ops");
    assert_eq!(
        ops.iter().map(|op| op.op_kind.as_str()).collect::<Vec<_>>(),
        ["probe.local", "moment.append", "moment.append"]
    );
    let probe = ops.remove(0);
    apply_envelope_with(to, &probe, &NoFaults, insert_probe).expect("probe");
    ops
}

fn receive(
    store: &mut EngineStore,
    op: &ReplicationEnvelope,
) -> Result<ApplyOutcome<i64>, SyncError> {
    apply_moment_envelope(
        store,
        op,
        &NoFaults,
        &NoLiveLeases,
        &dohc_engine_collab::live_update_application::ReleasedTails::default(),
    )
}

#[test]
fn two_replicas_that_recover_the_same_edits_take_each_others_copies() {
    let (_a_scratch, device_a) = recovered_twice("device-a", "owner");
    let (_b_scratch, mut server_copy) = recovered_twice("server-copy", "service");
    let ids = |store: &EngineStore| {
        moments(store)
            .iter()
            .map(|row| row.split('|').take(3).collect::<Vec<_>>().join("|"))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        ids(&device_a),
        ids(&server_copy),
        "both replicas recover alike"
    );
    assert!(ids(&device_a)[0].starts_with("ydoc-recovery-moment-"));
    assert!(ids(&device_a)[1].starts_with("ydoc-inactive-recovery-"));
    let before = moments(&server_copy);

    for op in served(&device_a, "device-a", &mut server_copy) {
        let applied = receive(&mut server_copy, &op).expect("the same recovery is no collision");
        assert!(
            matches!(applied.primary, ApplyDisposition::Applied(_)),
            "{op:?}"
        );
    }
    assert_eq!(
        moments(&server_copy),
        before,
        "the stored copies keep their own authors and add no history"
    );
}

#[test]
fn a_continuation_from_a_different_state_still_collides() {
    let (_a_scratch, device_a) = recovered_twice("device-a", "owner");
    let (_b_scratch, mut server_copy) = recovered_twice("server-copy", "owner");
    let mut ops = served(&device_a, "device-a", &mut server_copy);
    ops[1].payload["beforeBlobSha256"] = json!(dohc_engine_storage::hex_sha256(b"other"));
    receive(&mut server_copy, &ops[0]).expect("creation");
    assert_invalid_refusal!(receive(&mut server_copy, &ops[1]));
}

#[test]
fn a_replica_that_recovered_itself_reports_its_copy_when_the_matching_moments_arrive() {
    let (_a_scratch, device_a) = recovered_twice("device-a", "service");
    let (_b_scratch, mut owner) = recovered_twice("owner", "owner");
    let ops = served(&device_a, "device-a", &mut owner);
    let copy: String = owner
        .read_with(|conn| {
            conn.query_row(
                "SELECT path FROM snapshots WHERE metadata_correlation_id GLOB 'ydoc-inactive-recovery:*'",
                [],
                |row| row.get(0),
            )
        })
        .expect("the copy");
    let client = RelaySyncClient::new(FakeRelay {
        pull: Mutex::new(Some(PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
            next_cursor: i64::try_from(ops.len()).unwrap(),
            ops,
            has_more: false,
        })),
        ..Default::default()
    });
    let outcome = client
        .pull_chat_workspace(
            &mut owner,
            &mut WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            1_000,
        )
        .expect("the pull goes on");
    let SyncPassOutcome::Complete { changed_paths, .. } = outcome else {
        panic!("{outcome:?}");
    };
    assert!(
        changed_paths
            .iter()
            .any(|change| change.path == copy && change.operation == "write"),
        "{changed_paths:?}"
    );
}
