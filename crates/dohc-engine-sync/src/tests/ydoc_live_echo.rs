use super::*;
use dohc_engine_collab::{
    ContentKind, DocKey, LeaseRegistry, LocalAppend, WriterDocCache, Ydoc, claim_base,
    record_local_update, replay_parity::replay_validation_calls_for_test,
};

struct Fixture {
    path: std::path::PathBuf,
    store: EngineStore,
    cache: WriterDocCache,
    key: DocKey,
    author: Ydoc,
    echo: ReplicationEnvelope,
    _scratch: ScratchDir,
}

fn fixture(size: usize) -> Fixture {
    let (scratch, path, mut store) = open_store();
    adopt_join_identity(
        &mut store, "ws", "local", "epoch-1", "stream-1", 1000, &NoFaults,
    )
    .unwrap();
    seed_replication_version(&mut store, "main", "main");
    let key = DocKey::new("ws", "main", "live-echo").unwrap();
    let author = Ydoc::wire();
    let base = author.plaintext_insert(0, &"a".repeat(size));
    store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO file_objects(workspace_id,object_id,created_at_ms) VALUES('ws','live-echo',1000)", [])
            .map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    }).unwrap();
    claim_base(
        &mut store,
        &key,
        ContentKind::Plaintext,
        &base,
        &NoFaults,
        1001,
    )
    .unwrap();
    let claim = dohc_engine_collab::read_marker(&store, &key)
        .unwrap()
        .unwrap()
        .lineage_claim_id
        .unwrap();
    let mut cache = WriterDocCache::new();
    let update = author.plaintext_insert(size as u32, "b");
    record_local_update(
        &mut store,
        &mut cache,
        &key,
        &update,
        LocalAppend::default(),
        &NoFaults,
        1002,
        |tx, _, sha| {
            journal_local_op_in_tx(
                tx,
                "ws",
                "ydoc.update",
                &ydoc_update_payload(
                    &key,
                    "notes/live-echo.md",
                    ContentKind::Plaintext,
                    sha,
                    &claim,
                    None,
                    None,
                    false,
                ),
                1002,
            )
            .map_err(|error| dohc_engine_collab::CollabError::Corrupt {
                reason: error.to_string(),
            })?;
            Ok(())
        },
    )
    .unwrap();
    let mut echo = list_replication_ops(&store, "ws", "local", -1, 10)
        .unwrap()
        .remove(0);
    echo.relay_seq = Some(1);
    Fixture {
        _scratch: scratch,
        path,
        store,
        cache,
        key,
        author,
        echo,
    }
}

#[test]
fn live_local_echo_skips_replay_on_first_pull_and_retry() {
    let mut f = fixture(50 * 1024);
    let leases = LeaseRegistry::default();
    let _lease = leases.acquire(&f.key).unwrap();
    let relay = PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![f.echo.clone()],
            next_cursor: 1,
            has_more: false,
        },
    )]);
    let client = RelaySyncClient::new(relay);
    let before = replay_validation_calls_for_test();
    for _ in 0..2 {
        let outcome = client
            .pull_chat_workspace(&mut f.store, &mut f.cache, "ws", &NoFaults, &leases, 2000)
            .unwrap();
        assert!(matches!(
            outcome,
            SyncPassOutcome::Complete {
                applied: 0,
                skipped: 1,
                refused: 0,
                ..
            }
        ));
    }
    assert_eq!(
        replay_validation_calls_for_test() - before,
        0,
        "exact local echoes must not replay the document"
    );
    assert_eq!(
        read_replication_acked_seq(&f.store, "ws", "local").unwrap(),
        0
    );
    assert_eq!(
        f.store
            .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &f.key))
            .unwrap()
            .plaintext_string(),
        f.author.plaintext_string()
    );
}

#[test]
fn live_local_echo_changed_payload_replays_and_rejects_divergence() {
    let mut f = fixture(100);
    let bytes = f.author.plaintext_insert(101, "changed");
    f.echo.payload["updateBlobSha256"] = json!(f.store.put_binary_blob(&bytes).unwrap());
    let before = replay_validation_calls_for_test();
    assert!(matches!(
        apply_ydoc_envelope(&mut f.store, &mut f.cache, &f.echo, &NoFaults, &AlwaysLive),
        Err(SyncError::CoordinateDiverged)
    ));
    assert!(replay_validation_calls_for_test() > before);
    assert_eq!(
        read_replication_acked_seq(&f.store, "ws", "local").unwrap(),
        -1
    );
}

#[test]
fn live_local_echo_missing_or_corrupt_blob_stays_retryable() {
    for corrupt in [false, true] {
        let mut f = fixture(100);
        // Bypass foreign keys only on the corruption connection.
        let corrupt_conn =
            rusqlite::Connection::open(dohc_engine_storage::sqlite_path(f.path.as_ref())).unwrap();
        corrupt_conn
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        let sql = if corrupt {
            "UPDATE binary_blobs SET bytes=x'0000' WHERE sha256=?1"
        } else {
            "DELETE FROM binary_blobs WHERE sha256=?1"
        };
        corrupt_conn
            .execute(sql, [f.echo.payload["updateBlobSha256"].as_str().unwrap()])
            .unwrap();
        drop(corrupt_conn);
        assert!(matches!(
            apply_ydoc_envelope(&mut f.store, &mut f.cache, &f.echo, &NoFaults, &AlwaysLive),
            Err(SyncError::BlobInvalid)
        ));
        assert_eq!(
            read_replication_acked_seq(&f.store, "ws", "local").unwrap(),
            -1
        );
    }
}

#[test]
fn live_local_echo_with_deferred_row_still_replays() {
    let mut f = fixture(100);
    f.store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO ydoc_deferred_updates(workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms,lineage_claim_id,relay_seq) VALUES('ws','main','live-echo','local',0,1002,?1,1)", [f.echo.payload["lineageClaimId"].as_str().unwrap()]).map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    }).unwrap();
    let before = replay_validation_calls_for_test();
    let outcome =
        apply_ydoc_envelope(&mut f.store, &mut f.cache, &f.echo, &NoFaults, &AlwaysLive).unwrap();
    assert!(matches!(outcome.primary, ApplyDisposition::Skipped));
    assert!(replay_validation_calls_for_test() > before);
    assert_eq!(
        f.store
            .read_with(|conn| conn.query_row(
                "SELECT COUNT(*) FROM ydoc_deferred_updates",
                [],
                |r| r.get::<_, i64>(0)
            ))
            .unwrap(),
        1
    );
}

#[test]
fn live_local_echo_after_lineage_replacement_still_replays() {
    let mut f = fixture(100);
    let next_claim = f
        .store
        .put_binary_blob(&Ydoc::wire().encode_full_state())
        .unwrap();
    f.store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE ydoc_docs SET lineage_parent_claim_id=lineage_claim_id,lineage_claim_id=?1,lineage_epoch_tag=?2 WHERE object_id='live-echo'", [next_claim, "f".repeat(64)]).map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    }).unwrap();
    let before = replay_validation_calls_for_test();
    let outcome =
        apply_ydoc_envelope(&mut f.store, &mut f.cache, &f.echo, &NoFaults, &AlwaysLive).unwrap();
    assert!(matches!(outcome.primary, ApplyDisposition::Skipped));
    assert!(replay_validation_calls_for_test() > before);
}

#[test]
fn live_local_echo_after_journal_crash_reopens_and_retries() {
    let mut f = fixture(100);
    drop(f.store);
    f.store = EngineStore::open(&f.path, 2000).unwrap();
    f.cache = WriterDocCache::new();
    let before = replay_validation_calls_for_test();
    let crash = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
    for faults in [
        crash.as_ref() as &dyn dohc_engine_storage::FaultInjector,
        &NoFaults,
    ] {
        let outcome =
            apply_ydoc_envelope(&mut f.store, &mut f.cache, &f.echo, faults, &AlwaysLive).unwrap();
        assert!(matches!(
            outcome.primary,
            ApplyDisposition::Skipped | ApplyDisposition::Crashed { committed: true }
        ));
    }
    assert_eq!(replay_validation_calls_for_test() - before, 0);
    assert_eq!(
        read_replication_acked_seq(&f.store, "ws", "local").unwrap(),
        0
    );
    assert!(crash.fired());
}

#[test]
fn live_local_echo_with_a_deferred_predecessor_still_replays() {
    let mut f = fixture(100);
    let mut predecessor = f.echo.clone();
    predecessor.origin_id = "peer".into();
    predecessor.payload["updateBlobSha256"] = json!(
        f.store
            .put_binary_blob(&f.author.plaintext_insert(101, "remote"))
            .unwrap()
    );
    let queued = apply_ydoc_envelope(
        &mut f.store,
        &mut f.cache,
        &predecessor,
        &NoFaults,
        &AlwaysLive,
    )
    .unwrap();
    assert!(matches!(
        queued.primary,
        ApplyDisposition::Applied(YdocApplyResult { deferred: true, .. })
    ));
    f.echo.relay_seq = Some(2);
    let before = replay_validation_calls_for_test();
    let outcome =
        apply_ydoc_envelope(&mut f.store, &mut f.cache, &f.echo, &NoFaults, &AlwaysLive).unwrap();
    assert!(matches!(outcome.primary, ApplyDisposition::Skipped));
    assert!(replay_validation_calls_for_test() > before);
}

#[test]
fn live_local_echo_without_a_committed_journal_row_is_validated_and_deferred() {
    let mut f = fixture(100);
    // A rolled-back journal insert must not authorize an echo skip.
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch("SAVEPOINT failed_journal")
                .map_err(SyncError::persist)?;
            journal_local_op_in_tx(tx, "ws", "ydoc.update", &f.echo.payload, 1003)?;
            tx.execute_batch("ROLLBACK TO failed_journal; RELEASE failed_journal")
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    // The first local coordinate has already been acknowledged.
    apply_envelope_with(&mut f.store, &f.echo, &NoFaults, |_, _| Ok(())).unwrap();
    f.echo.origin_seq = 1;
    f.echo.relay_seq = Some(2);
    let before = replay_validation_calls_for_test();
    let outcome =
        apply_ydoc_envelope(&mut f.store, &mut f.cache, &f.echo, &NoFaults, &AlwaysLive).unwrap();
    assert!(matches!(
        outcome.primary,
        ApplyDisposition::Applied(YdocApplyResult { deferred: true, .. })
    ));
    assert!(replay_validation_calls_for_test() > before);
    assert_eq!(
        read_replication_acked_seq(&f.store, "ws", "local").unwrap(),
        1
    );
}
