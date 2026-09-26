use super::*;

/// A skip claims client 12 clocks `[0, 3)` but carries no integrable content.
/// Against `clock_collision_pair()`'s first `[0, 2)` update it passes checks
/// 1-3, reaches the persistent apply, then check 4 observes that clock 2 was
/// neither integrated nor parked.
const CHECK4_DISCARDED_SKIP_HEX: &str = "01010c000a0300";

#[test]
fn cached_defer_and_drain_match_the_cold_path() {
    let (_warm_scratch, _warm_path, mut warm_store) = open_store();
    let (_cold_scratch, _cold_path, mut cold_store) = open_store();
    let mut warm_cache = dohc_engine_collab::WriterDocCache::new();
    let mut cold_seed_cache = dohc_engine_collab::WriterDocCache::new();
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-cache-pair").expect("key");

    let author = dohc_engine_collab::Ydoc::wire();
    let local = author.plaintext_insert(0, "local");
    let remote_one = author.plaintext_insert(5, " remote");
    let remote_two = author.plaintext_insert(12, " final");
    let empty_base = dohc_engine_collab::Ydoc::wire().encode_full_state();

    let setup =
        |store: &mut EngineStore, cache: &mut dohc_engine_collab::WriterDocCache| -> String {
            VersionedTextStore::new(store)
                .ensure_main_version("ws", "main", 1_000, &NoFaults)
                .expect("main version");
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                    "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) \
                     VALUES ('ws','object-cache-pair',1_001)",
                    [],
                )
                .map_err(SyncError::persist)?;
                    Ok::<_, SyncError>(())
                })
                .expect("file object");
            let claim = match dohc_engine_collab::claim_base(
                store,
                &key,
                dohc_engine_collab::ContentKind::Plaintext,
                &empty_base,
                &NoFaults,
                1_002,
            )
            .expect("claim base")
            {
                TxnOutcome::Committed(dohc_engine_collab::ClaimOutcome::Claimed {
                    base_snapshot_sha,
                }) => base_snapshot_sha,
                other => panic!("unexpected claim: {other:?}"),
            };
            dohc_engine_collab::record_local_update(
                store,
                cache,
                &key,
                &local,
                dohc_engine_collab::LocalAppend::default(),
                &NoFaults,
                1_003,
                |_tx, _outcome, _update_sha| Ok(()),
            )
            .expect("warm local append");
            claim
        };
    let warm_claim = setup(&mut warm_store, &mut warm_cache);
    let cold_claim = setup(&mut cold_store, &mut cold_seed_cache);
    assert_eq!(warm_claim, cold_claim);

    let remote_one_sha = warm_store
        .put_binary_blob(&remote_one)
        .expect("warm first remote blob");
    cold_store
        .put_binary_blob(&remote_one)
        .expect("cold first remote blob");
    let remote_two_sha = warm_store
        .put_binary_blob(&remote_two)
        .expect("warm second remote blob");
    cold_store
        .put_binary_blob(&remote_two)
        .expect("cold second remote blob");
    let deferred = [
        envelope(
            "peer",
            0,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": "object-cache-pair",
                "path": "notes/cache-pair.md",
                "contentKind": "plaintext",
                "updateBlobSha256": remote_one_sha,
                "lineageClaimId": warm_claim,
                "isBaseState": false
            }),
        ),
        envelope(
            "peer",
            1,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": "object-cache-pair",
                "path": "notes/cache-pair.md",
                "contentKind": "plaintext",
                "updateBlobSha256": remote_two_sha,
                "lineageClaimId": cold_claim,
                "isBaseState": false
            }),
        ),
    ];

    for operation in &deferred {
        let warm = apply_ydoc_envelope(
            &mut warm_store,
            &mut warm_cache,
            operation,
            &NoFaults,
            &AlwaysLive,
        )
        .expect("warm defer");
        let cold = apply_ydoc_envelope(
            &mut cold_store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            operation,
            &NoFaults,
            &AlwaysLive,
        )
        .expect("cold defer");
        assert_eq!(warm, cold);
    }

    let warm_drain = drain_deferred_ydoc_for_key(&mut warm_store, &mut warm_cache, &key, &NoFaults)
        .expect("warm drain");
    let cold_drain = drain_deferred_ydoc_for_key(
        &mut cold_store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .expect("cold drain");
    assert_eq!(warm_drain, cold_drain);

    let warm_doc = dohc_engine_collab::load_persisted(&warm_store, &key)
        .expect("warm persisted")
        .expect("warm doc");
    let cold_doc = dohc_engine_collab::load_persisted(&cold_store, &key)
        .expect("cold persisted")
        .expect("cold doc");
    // One author produced every delta, so no Any::Map or multi-client map
    // iteration can perturb this plaintext full-state encoding: byte equality
    // is the strongest valid assertion here.
    assert_eq!(
        warm_doc.doc.encode_full_state(),
        cold_doc.doc.encode_full_state()
    );
    assert_eq!(
        warm_cache
            .doc_full_state_for_test(&key)
            .expect("warm cache remains resident"),
        cold_doc.doc.encode_full_state()
    );
    assert_eq!(
        warm_cache
            .frontier_matches_doc_for_test(&key)
            .expect("deferred frontier comparison"),
        Some(true),
        "deferred commits keep the companion frontier aligned"
    );
    assert_eq!(
        warm_cache
            .gate_scratch_matches_doc_for_test(&key)
            .expect("deferred scratch comparison"),
        Some(true),
        "deferred commits keep the check-4 scratch aligned"
    );
    let warm_head = VersionedTextStore::new(&mut warm_store)
        .read_text("ws", "main", "notes/cache-pair.md")
        .expect("warm head")
        .expect("warm snapshot");
    let cold_head = VersionedTextStore::new(&mut cold_store)
        .read_text("ws", "main", "notes/cache-pair.md")
        .expect("cold head")
        .expect("cold snapshot");
    assert_eq!(warm_head.text, cold_head.text);
    assert_eq!(warm_head.blob_sha256, cold_head.blob_sha256);
    assert_eq!(warm_head.latest_moment_id, cold_head.latest_moment_id);
    assert_eq!(warm_head.text, "local remote final");

    let stats = warm_cache.stats();
    // The second defer gate has a queued predecessor, and the cached form
    // deliberately reconstructs cold for a non-empty queue: a scratch forked
    // from the cached full state can re-encode delete-set endpoints the gate
    // reads differently than the cold incremental rebuild.
    assert_eq!(
        stats.hits, 2,
        "empty-queue defer gate plus final drain projection"
    );
    assert_eq!(stats.misses, 1, "only the first local append reconstructs");
    assert_eq!(stats.installs, 1);
    assert_eq!(stats.advances, 2, "both committed drain deltas advance");
}

fn seed_warm_and_cold_remote_lineage(
    warm_store: &mut EngineStore,
    warm_cache: &mut dohc_engine_collab::WriterDocCache,
    cold_store: &mut EngineStore,
    object_id: &str,
    path: &str,
    content_kind: &str,
) -> (dohc_engine_collab::DocKey, String) {
    seed_replication_version(warm_store, "main", "main");
    seed_replication_version(cold_store, "main", "main");
    let key = dohc_engine_collab::DocKey::new("ws", "main", object_id).expect("key");
    let empty_base = dohc_engine_collab::Ydoc::wire().encode_full_state();
    let warm_claim = warm_store
        .put_binary_blob(&empty_base)
        .expect("warm empty base");
    let cold_claim = cold_store
        .put_binary_blob(&empty_base)
        .expect("cold empty base");
    assert_eq!(warm_claim, cold_claim);
    let base = envelope(
        "cache-pair-base",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": object_id,
            "path": path,
            "contentKind": content_kind,
            "updateBlobSha256": warm_claim.clone(),
            "lineageClaimId": warm_claim.clone(),
            "isBaseState": true
        }),
    );
    let warm_base = apply_ydoc_envelope(warm_store, warm_cache, &base, &NoFaults, &NoLiveLeases)
        .expect("warm base");
    let cold_base = apply_ydoc_envelope(
        cold_store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("cold base");
    assert_eq!(warm_base, cold_base);

    // This valid empty-state row changes no content. It establishes identical
    // durable replay paths while retaining only the warm side's installed doc.
    let mut cold_seed_cache = dohc_engine_collab::WriterDocCache::new();
    let warm_seed = dohc_engine_collab::record_local_update(
        warm_store,
        warm_cache,
        &key,
        &empty_base,
        dohc_engine_collab::LocalAppend::default(),
        &NoFaults,
        2_001,
        |_tx, _outcome, _update_sha| Ok(()),
    )
    .expect("warm cache seed");
    let cold_seed = dohc_engine_collab::record_local_update(
        cold_store,
        &mut cold_seed_cache,
        &key,
        &empty_base,
        dohc_engine_collab::LocalAppend::default(),
        &NoFaults,
        2_001,
        |_tx, _outcome, _update_sha| Ok(()),
    )
    .expect("cold cache seed");
    assert_eq!(warm_seed, cold_seed);
    assert!(warm_cache.contains_for_test(&key));
    (key, warm_claim)
}

#[derive(Clone, Copy)]
struct RemoteDeltaTarget<'a> {
    object_id: &'a str,
    path: &'a str,
    content_kind: &'a str,
    claim: &'a str,
}

fn remote_delta_operation(
    store: &mut EngineStore,
    target: RemoteDeltaTarget<'_>,
    origin: &str,
    origin_seq: i64,
    bytes: &[u8],
) -> ReplicationEnvelope {
    let update_sha = store.put_binary_blob(bytes).expect("remote update blob");
    envelope(
        origin,
        origin_seq,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": target.object_id,
            "path": target.path,
            "contentKind": target.content_kind,
            "updateBlobSha256": update_sha,
            "lineageClaimId": target.claim,
            "isBaseState": false
        }),
    )
}

fn apply_remote_cache_pair(
    warm_store: &mut EngineStore,
    warm_cache: &mut dohc_engine_collab::WriterDocCache,
    cold_store: &mut EngineStore,
    target: RemoteDeltaTarget<'_>,
    origin: &str,
    origin_seq: i64,
    bytes: &[u8],
) -> ApplyOutcome<YdocApplyResult> {
    let operation = remote_delta_operation(warm_store, target, origin, origin_seq, bytes);
    let cold_sha = cold_store
        .put_binary_blob(bytes)
        .expect("cold remote update blob");
    assert_eq!(
        operation.payload["updateBlobSha256"],
        json!(cold_sha),
        "paired stores address the same remote bytes"
    );
    let warm = apply_ydoc_envelope(warm_store, warm_cache, &operation, &NoFaults, &NoLiveLeases)
        .expect("warm remote apply");
    let cold = apply_ydoc_envelope(
        cold_store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &operation,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("cold remote apply");
    assert_eq!(warm, cold, "cached and cold remote verdicts");
    assert!(
        matches!(
            &warm,
            ApplyOutcome {
                primary: ApplyDisposition::Applied(_),
                refusals: outcome_refusals,
                sharing_declined: outcome_sharing_declined,
            } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ),
        "ordinary remote candidate must apply: {warm:?}"
    );
    warm
}

fn assert_remote_cache_matches_cold(
    warm_store: &EngineStore,
    warm_cache: &dohc_engine_collab::WriterDocCache,
    cold_store: &EngineStore,
    key: &dohc_engine_collab::DocKey,
) {
    let warm = dohc_engine_collab::load_persisted(warm_store, key)
        .expect("warm persisted")
        .expect("warm lineage");
    let cold = dohc_engine_collab::load_persisted(cold_store, key)
        .expect("cold persisted")
        .expect("cold lineage");
    assert!(
        dohc_engine_collab::replay_parity::structurally_equal_v2_for_test(&warm.doc, &cold.doc)
            .expect("warm/cold remote structure")
    );
    assert_eq!(
        warm_cache
            .frontier_matches_doc_for_test(key)
            .expect("remote frontier comparison"),
        Some(true)
    );
    assert_eq!(
        warm_cache
            .gate_scratch_matches_doc_for_test(key)
            .expect("remote scratch comparison"),
        Some(true)
    );
}

#[test]
fn remote_frontier_fold_retains_an_identity_covered_by_delete() {
    let (_warm_scratch, _warm_path, mut warm_store) = open_store();
    let (_cold_scratch, _cold_path, mut cold_store) = open_store();
    let mut warm_cache = dohc_engine_collab::WriterDocCache::new();
    let object_id = "object-remote-retire-identity";
    let path = "cache/remote-retire-identity.md";
    let (key, claim) = seed_warm_and_cold_remote_lineage(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        object_id,
        path,
        "plaintext",
    );
    let target = RemoteDeltaTarget {
        object_id,
        path,
        content_kind: "plaintext",
        claim: &claim,
    };
    let producer = dohc_engine_collab::Ydoc::wire();
    let insert = producer.plaintext_insert(0, "ab");
    apply_remote_cache_pair(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        target,
        "remote-retire-identity",
        0,
        &insert,
    );
    assert_eq!(
        warm_cache.frontier_fact_counts_for_test(&key),
        Some((2, 0, 0))
    );

    let delete = producer.plaintext_delete(0, 1);
    apply_remote_cache_pair(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        target,
        "remote-retire-identity",
        1,
        &delete,
    );
    assert_eq!(
        warm_cache.frontier_fact_counts_for_test(&key),
        Some((2, 0, 2))
    );
    assert_remote_cache_matches_cold(&warm_store, &warm_cache, &cold_store, &key);
}

#[test]
fn remote_frontier_fold_retains_a_string_run_across_a_mid_run_delete() {
    let (_warm_scratch, _warm_path, mut warm_store) = open_store();
    let (_cold_scratch, _cold_path, mut cold_store) = open_store();
    let mut warm_cache = dohc_engine_collab::WriterDocCache::new();
    let object_id = "object-remote-split-run";
    let path = "cache/remote-split-run.md";
    let (key, claim) = seed_warm_and_cold_remote_lineage(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        object_id,
        path,
        "plaintext",
    );
    let target = RemoteDeltaTarget {
        object_id,
        path,
        content_kind: "plaintext",
        claim: &claim,
    };
    let producer = dohc_engine_collab::Ydoc::wire();
    let insert = producer.plaintext_insert(0, "abcde");
    apply_remote_cache_pair(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        target,
        "remote-split-run",
        0,
        &insert,
    );
    let delete = producer.plaintext_delete(2, 1);
    apply_remote_cache_pair(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        target,
        "remote-split-run",
        1,
        &delete,
    );
    assert_eq!(
        warm_cache.frontier_fact_counts_for_test(&key),
        Some((5, 0, 2))
    );
    assert_remote_cache_matches_cold(&warm_store, &warm_cache, &cold_store, &key);
}

#[test]
fn remote_frontier_fold_retains_a_deleted_scalar_interior() {
    let (_warm_scratch, _warm_path, mut warm_store) = open_store();
    let (_cold_scratch, _cold_path, mut cold_store) = open_store();
    let mut warm_cache = dohc_engine_collab::WriterDocCache::new();
    let object_id = "object-remote-retire-interior";
    let path = "cache/remote-retire-interior.md";
    let (key, claim) = seed_warm_and_cold_remote_lineage(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        object_id,
        path,
        "plaintext",
    );
    let target = RemoteDeltaTarget {
        object_id,
        path,
        content_kind: "plaintext",
        claim: &claim,
    };
    let producer = dohc_engine_collab::Ydoc::wire();
    let insert = producer.plaintext_insert(0, "😀");
    apply_remote_cache_pair(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        target,
        "remote-retire-interior",
        0,
        &insert,
    );
    assert_eq!(
        warm_cache.frontier_fact_counts_for_test(&key),
        Some((2, 1, 0))
    );

    let delete = producer.plaintext_delete(0, 2);
    apply_remote_cache_pair(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        target,
        "remote-retire-interior",
        1,
        &delete,
    );
    assert_eq!(
        warm_cache.frontier_fact_counts_for_test(&key),
        Some((2, 1, 2))
    );
    assert_remote_cache_matches_cold(&warm_store, &warm_cache, &cold_store, &key);
}

#[test]
fn remote_frontier_delete_endpoints_canonicalize_across_pending_integration() {
    let (_warm_scratch, _warm_path, mut warm_store) = open_store();
    let (_cold_scratch, _cold_path, mut cold_store) = open_store();
    let mut warm_cache = dohc_engine_collab::WriterDocCache::new();
    let object_id = "object-remote-pending-delete";
    let path = "cache/remote-pending-delete.md";
    let (key, claim) = seed_warm_and_cold_remote_lineage(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        object_id,
        path,
        "plaintext",
    );
    let target = RemoteDeltaTarget {
        object_id,
        path,
        content_kind: "plaintext",
        claim: &claim,
    };
    let producer = dohc_engine_collab::Ydoc::wire();
    let dependency = producer.plaintext_insert(0, "abc");
    let delete_first = producer.plaintext_delete(0, 1);
    let delete_second = producer.plaintext_delete(0, 1);

    for (origin_seq, update) in [(0, &delete_second), (1, &delete_first)] {
        apply_remote_cache_pair(
            &mut warm_store,
            &mut warm_cache,
            &mut cold_store,
            target,
            "remote-pending-delete",
            origin_seq,
            update,
        );
        assert_eq!(
            warm_cache
                .frontier_fact_counts_for_test(&key)
                .map(|facts| facts.2),
            Some(2),
            "adjacent remote coverage emits one canonical endpoint pair"
        );
    }
    assert_eq!(
        dohc_engine_collab::load_persisted(&warm_store, &key)
            .expect("parked load")
            .expect("parked lineage")
            .doc
            .plaintext_string(),
        ""
    );

    apply_remote_cache_pair(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        target,
        "remote-pending-delete",
        2,
        &dependency,
    );
    assert_eq!(
        dohc_engine_collab::load_persisted(&warm_store, &key)
            .expect("integrated load")
            .expect("integrated lineage")
            .doc
            .plaintext_string(),
        "c"
    );
    assert_eq!(
        warm_cache.frontier_fact_counts_for_test(&key),
        Some((3, 0, 2))
    );
    assert_remote_cache_matches_cold(&warm_store, &warm_cache, &cold_store, &key);
}

#[test]
fn cached_remote_frontier_refusal_leaves_the_persistent_scratch_untouched() {
    let (_warm_scratch, _warm_path, mut warm_store) = open_store();
    let (_cold_scratch, _cold_path, mut cold_store) = open_store();
    let mut warm_cache = dohc_engine_collab::WriterDocCache::new();
    let object_id = "object-remote-frontier-refusal";
    let path = "cache/remote-frontier-refusal.md";
    let (key, claim) = seed_warm_and_cold_remote_lineage(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        object_id,
        path,
        "plaintext",
    );
    let target = RemoteDeltaTarget {
        object_id,
        path,
        content_kind: "plaintext",
        claim: &claim,
    };
    let base = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "z");
    apply_remote_cache_pair(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        target,
        "remote-frontier-refusal",
        0,
        &base,
    );
    assert!(warm_cache.gate_scratch_is_resident_for_test(&key));

    let hostile = flip_byte(&base, b'z', b'y');
    let operation = remote_delta_operation(
        &mut warm_store,
        target,
        "remote-frontier-refusal",
        1,
        &hostile,
    );
    cold_store
        .put_binary_blob(&hostile)
        .expect("cold hostile blob");
    let warm = apply_ydoc_envelope(
        &mut warm_store,
        &mut warm_cache,
        &operation,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("warm frontier refusal");
    let cold = apply_ydoc_envelope(
        &mut cold_store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &operation,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("cold frontier refusal");
    assert_eq!(warm, cold);
    assert!(matches!(
        warm,
        ApplyOutcome {
            primary: ApplyDisposition::Refused(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert!(
        warm_cache.gate_scratch_is_resident_for_test(&key),
        "checks 1-3 refuse before mutating the remote scratch"
    );
    assert_remote_cache_matches_cold(&warm_store, &warm_cache, &cold_store, &key);
}

#[test]
fn cached_remote_check4_refusal_evicts_only_scratch_and_a_valid_gate_rebuilds_it() {
    let (_warm_scratch, _warm_path, mut warm_store) = open_store();
    let (_cold_scratch, _cold_path, mut cold_store) = open_store();
    let mut warm_cache = dohc_engine_collab::WriterDocCache::new();
    let object_id = "object-remote-check4-refusal";
    let path = "cache/remote-check4-refusal.md";
    let (key, claim) = seed_warm_and_cold_remote_lineage(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        object_id,
        path,
        "plaintext",
    );
    let target = RemoteDeltaTarget {
        object_id,
        path,
        content_kind: "plaintext",
        claim: &claim,
    };
    let (u1, _) = clock_collision_pair();
    apply_remote_cache_pair(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        target,
        "remote-check4-refusal",
        0,
        &u1,
    );
    assert!(warm_cache.gate_scratch_is_resident_for_test(&key));

    let hostile = decode_hex(CHECK4_DISCARDED_SKIP_HEX);
    let operation = remote_delta_operation(
        &mut warm_store,
        target,
        "remote-check4-refusal",
        1,
        &hostile,
    );
    cold_store
        .put_binary_blob(&hostile)
        .expect("cold check4 blob");
    let warm = apply_ydoc_envelope(
        &mut warm_store,
        &mut warm_cache,
        &operation,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("warm check4 refusal");
    let cold = apply_ydoc_envelope(
        &mut cold_store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &operation,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("cold check4 refusal");
    assert_eq!(warm, cold);
    assert!(matches!(
        warm,
        ApplyOutcome {
            primary: ApplyDisposition::Refused(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert!(
        warm_cache.contains_for_test(&key),
        "check4 refusal preserves the writer doc and frontier"
    );
    assert_eq!(
        warm_cache
            .frontier_matches_doc_for_test(&key)
            .expect("frontier after check4 refusal"),
        Some(true)
    );
    assert!(
        !warm_cache.gate_scratch_is_resident_for_test(&key),
        "the mutated check4 scratch has no rollback and must be evicted"
    );

    let valid = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "valid-after-refusal");
    apply_remote_cache_pair(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        target,
        "remote-check4-refusal",
        2,
        &valid,
    );
    assert_remote_cache_matches_cold(&warm_store, &warm_cache, &cold_store, &key);
}

#[cfg(debug_assertions)]
#[test]
fn cached_remote_scratch_apply_error_evicts_only_scratch_and_a_valid_gate_rebuilds_it() {
    let (_warm_scratch, _warm_path, mut warm_store) = open_store();
    let (_cold_scratch, _cold_path, mut cold_store) = open_store();
    let mut warm_cache = dohc_engine_collab::WriterDocCache::new();
    let object_id = "object-remote-scratch-apply-error";
    let path = "cache/remote-scratch-apply-error.md";
    let (key, claim) = seed_warm_and_cold_remote_lineage(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        object_id,
        path,
        "plaintext",
    );
    let target = RemoteDeltaTarget {
        object_id,
        path,
        content_kind: "plaintext",
        claim: &claim,
    };
    let base = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "base");
    apply_remote_cache_pair(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        target,
        "remote-scratch-apply-error",
        0,
        &base,
    );
    assert!(warm_cache.gate_scratch_is_resident_for_test(&key));

    let rejected = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "rejected");
    let operation = remote_delta_operation(
        &mut warm_store,
        target,
        "remote-scratch-apply-error",
        1,
        &rejected,
    );
    let outcome =
        dohc_engine_collab::replay_parity::with_armed_scratch_apply_error_for_test(|| {
            apply_ydoc_envelope(
                &mut warm_store,
                &mut warm_cache,
                &operation,
                &NoFaults,
                &NoLiveLeases,
            )
        })
        .expect("scratch apply error is a contained refusal");
    assert!(matches!(
        outcome,
        ApplyOutcome {
            primary: ApplyDisposition::Refused(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert!(warm_cache.contains_for_test(&key));
    assert_eq!(
        warm_cache
            .frontier_matches_doc_for_test(&key)
            .expect("frontier after scratch apply error"),
        Some(true)
    );
    assert!(!warm_cache.gate_scratch_is_resident_for_test(&key));

    let valid = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "valid-after-error");
    apply_remote_cache_pair(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        target,
        "remote-scratch-rebuild",
        0,
        &valid,
    );
    assert_remote_cache_matches_cold(&warm_store, &warm_cache, &cold_store, &key);
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "FR1-VALID")]
fn remote_frontier_oracle_catches_a_poisoned_identity() {
    let (_warm_scratch, _warm_path, mut warm_store) = open_store();
    let (_cold_scratch, _cold_path, mut cold_store) = open_store();
    let mut warm_cache = dohc_engine_collab::WriterDocCache::new();
    let object_id = "object-remote-frontier-poison";
    let path = "cache/remote-frontier-poison.md";
    let (key, claim) = seed_warm_and_cold_remote_lineage(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        object_id,
        path,
        "plaintext",
    );
    let target = RemoteDeltaTarget {
        object_id,
        path,
        content_kind: "plaintext",
        claim: &claim,
    };
    let u1 = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "a");
    apply_remote_cache_pair(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        target,
        "remote-frontier-poison",
        0,
        &u1,
    );
    warm_cache.poison_frontier_for_test(&key);

    let u2 = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "b");
    let operation =
        remote_delta_operation(&mut warm_store, target, "remote-frontier-poison", 1, &u2);
    let _ = apply_ydoc_envelope(
        &mut warm_store,
        &mut warm_cache,
        &operation,
        &NoFaults,
        &NoLiveLeases,
    );
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "FR1-VALID")]
fn remote_frontier_oracle_catches_a_poisoned_multi_unit_string_run() {
    let (_warm_scratch, _warm_path, mut warm_store) = open_store();
    let (_cold_scratch, _cold_path, mut cold_store) = open_store();
    let mut warm_cache = dohc_engine_collab::WriterDocCache::new();
    let object_id = "object-remote-frontier-run-poison";
    let path = "cache/remote-frontier-run-poison.md";
    let (key, claim) = seed_warm_and_cold_remote_lineage(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        object_id,
        path,
        "plaintext",
    );
    let target = RemoteDeltaTarget {
        object_id,
        path,
        content_kind: "plaintext",
        claim: &claim,
    };
    let producer = dohc_engine_collab::Ydoc::wire();
    let u1 = producer.plaintext_insert(0, "a😀b");
    apply_remote_cache_pair(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        target,
        "remote-frontier-run-poison",
        0,
        &u1,
    );
    warm_cache.poison_frontier_for_test(&key);

    let u2 = producer.plaintext_insert(4, "c");
    let operation = remote_delta_operation(
        &mut warm_store,
        target,
        "remote-frontier-run-poison",
        1,
        &u2,
    );
    let _ = apply_ydoc_envelope(
        &mut warm_store,
        &mut warm_cache,
        &operation,
        &NoFaults,
        &NoLiveLeases,
    );
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "FR2-VALID")]
fn remote_scratch_oracle_catches_a_poisoned_scratch() {
    let (_warm_scratch, _warm_path, mut warm_store) = open_store();
    let (_cold_scratch, _cold_path, mut cold_store) = open_store();
    let mut warm_cache = dohc_engine_collab::WriterDocCache::new();
    let object_id = "object-remote-scratch-poison";
    let path = "cache/remote-scratch-poison.md";
    let (key, claim) = seed_warm_and_cold_remote_lineage(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        object_id,
        path,
        "plaintext",
    );
    let target = RemoteDeltaTarget {
        object_id,
        path,
        content_kind: "plaintext",
        claim: &claim,
    };
    let u1 = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "a");
    apply_remote_cache_pair(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        target,
        "remote-scratch-poison",
        0,
        &u1,
    );
    warm_cache.poison_gate_scratch_for_test(&key);

    let u2 = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "b");
    let operation =
        remote_delta_operation(&mut warm_store, target, "remote-scratch-poison", 1, &u2);
    let _ = apply_ydoc_envelope(
        &mut warm_store,
        &mut warm_cache,
        &operation,
        &NoFaults,
        &NoLiveLeases,
    );
}

#[derive(serde::Deserialize)]
struct RemoteCacheFixtureCorpus {
    scenarios: Vec<RemoteCacheScenario>,
}

#[derive(serde::Deserialize)]
struct RemoteCacheScenario {
    name: String,
    #[serde(rename = "contentKind")]
    content_kind: String,
    #[serde(rename = "authoredUpdates")]
    authored_updates: Vec<RemoteCacheAuthoredUpdate>,
    #[serde(rename = "replayOrder")]
    replay_order: Vec<String>,
}

#[derive(serde::Deserialize)]
struct RemoteCacheAuthoredUpdate {
    id: String,
    #[serde(rename = "updateBase64")]
    update_base64: String,
}

#[test]
fn cross_engine_replay_fixtures_match_cold_through_a_warmed_remote_cache() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    const FIXTURES: &str =
        include_str!("../../../../tools/rust-engine-program/ydoc-replay-fixtures.json");
    let fixtures: RemoteCacheFixtureCorpus =
        serde_json::from_str(FIXTURES).expect("Y.Doc replay fixtures");
    assert!(fixtures.scenarios.len() >= 6, "retain the full T6 corpus");

    for (scenario_index, scenario) in fixtures.scenarios.iter().enumerate() {
        let (_warm_scratch, _warm_path, mut warm_store) = open_store();
        let (_cold_scratch, _cold_path, mut cold_store) = open_store();
        let mut warm_cache = dohc_engine_collab::WriterDocCache::new();
        let object_id = format!("object-remote-cache-{scenario_index}");
        let extension = if scenario.content_kind == "scene" {
            "excalidraw"
        } else {
            "md"
        };
        let path = format!("cache/{scenario_index}.{extension}");
        let (key, claim) = seed_warm_and_cold_remote_lineage(
            &mut warm_store,
            &mut warm_cache,
            &mut cold_store,
            &object_id,
            &path,
            &scenario.content_kind,
        );
        let updates: BTreeMap<&str, &RemoteCacheAuthoredUpdate> = scenario
            .authored_updates
            .iter()
            .map(|update| (update.id.as_str(), update))
            .collect();
        assert_eq!(updates.len(), scenario.authored_updates.len());
        let before = warm_cache.stats();

        for (step, update_id) in scenario.replay_order.iter().enumerate() {
            let update = updates.get(update_id.as_str()).unwrap_or_else(|| {
                panic!("{} references unknown update {update_id}", scenario.name)
            });
            let bytes = STANDARD
                .decode(&update.update_base64)
                .unwrap_or_else(|error| panic!("{} {update_id}: {error}", scenario.name));
            let warm_sha = warm_store
                .put_binary_blob(&bytes)
                .expect("warm fixture blob");
            let cold_sha = cold_store
                .put_binary_blob(&bytes)
                .expect("cold fixture blob");
            assert_eq!(warm_sha, cold_sha);
            let mut operation = envelope(
                &format!("fixture-{scenario_index}-{step}"),
                0,
                "ydoc.update",
                json!({
                    "versionId": "main",
                    "objectId": object_id.clone(),
                    "path": path.clone(),
                    "contentKind": scenario.content_kind.clone(),
                    "updateBlobSha256": warm_sha,
                    "lineageClaimId": claim.clone(),
                    "isBaseState": false
                }),
            );
            operation.relay_seq = Some(i64::try_from(step + 1).expect("relay sequence"));
            let warm = apply_ydoc_envelope(
                &mut warm_store,
                &mut warm_cache,
                &operation,
                &NoFaults,
                &NoLiveLeases,
            )
            .unwrap_or_else(|error| panic!("{} {update_id} warm: {error}", scenario.name));
            let cold = apply_ydoc_envelope(
                &mut cold_store,
                &mut dohc_engine_collab::WriterDocCache::new(),
                &operation,
                &NoFaults,
                &NoLiveLeases,
            )
            .unwrap_or_else(|error| panic!("{} {update_id} cold: {error}", scenario.name));
            assert_eq!(
                warm, cold,
                "{} {update_id} warm/cold verdict",
                scenario.name
            );
        }

        let after = warm_cache.stats();
        let count = u64::try_from(scenario.replay_order.len()).expect("fixture update count");
        assert_eq!(
            after.hits - before.hits,
            count,
            "{} every remote candidate gates on the warmed cache",
            scenario.name
        );
        assert_eq!(
            after.advances - before.advances,
            count,
            "{} every committed remote candidate advances the cache",
            scenario.name
        );
        let warm = dohc_engine_collab::load_persisted(&warm_store, &key)
            .expect("warm persisted")
            .expect("warm lineage");
        let cold = dohc_engine_collab::load_persisted(&cold_store, &key)
            .expect("cold persisted")
            .expect("cold lineage");
        assert!(
            dohc_engine_collab::replay_parity::structurally_equal_v2_for_test(&warm.doc, &cold.doc)
                .expect("warm/cold scan_v2"),
            "{} final warm/cold replay structure",
            scenario.name
        );
        let cached = dohc_engine_collab::Ydoc::wire();
        cached
            .apply(
                &warm_cache
                    .doc_full_state_for_test(&key)
                    .expect("remote cache remains resident"),
            )
            .expect("cached full state");
        assert!(
            dohc_engine_collab::replay_parity::structurally_equal_v2_for_test(&cached, &cold.doc)
                .expect("cache/cold scan_v2"),
            "{} final cache/cold replay structure",
            scenario.name
        );
        assert_eq!(
            warm_cache
                .frontier_matches_doc_for_test(&key)
                .expect("remote frontier comparison"),
            Some(true),
            "{} remote commits keep the companion frontier aligned",
            scenario.name
        );
        assert_eq!(
            warm_cache
                .gate_scratch_matches_doc_for_test(&key)
                .expect("remote scratch comparison"),
            Some(true),
            "{} remote commits keep the check-4 scratch aligned",
            scenario.name
        );
        let warm_head = VersionedTextStore::new(&mut warm_store)
            .read_text("ws", "main", &path)
            .expect("warm visible head")
            .expect("warm visible snapshot");
        let cold_head = VersionedTextStore::new(&mut cold_store)
            .read_text("ws", "main", &path)
            .expect("cold visible head")
            .expect("cold visible snapshot");
        assert_eq!(
            warm_head.text, cold_head.text,
            "{} visible text",
            scenario.name
        );
        assert_eq!(
            warm_head.blob_sha256, cold_head.blob_sha256,
            "{} visible digest",
            scenario.name
        );
        assert_eq!(
            warm_head.latest_moment_id, cold_head.latest_moment_id,
            "{} visible moment",
            scenario.name
        );
    }
}

#[test]
fn refused_remote_projection_retains_and_advances_the_warmed_cache() {
    let (_warm_scratch, _warm_path, mut warm_store) = open_store();
    let (_cold_scratch, _cold_path, mut cold_store) = open_store();
    let mut warm_cache = dohc_engine_collab::WriterDocCache::new();
    let object_id = "object-cache-refusal";
    let path = "notes/cache-refusal.md";
    let (key, claim) = seed_warm_and_cold_remote_lineage(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        object_id,
        path,
        "plaintext",
    );
    seed_text_head(
        &mut warm_store,
        "object-cache-refusal-occupant",
        "notes/cache-refusal-occupied.md",
        "occupied",
    );
    seed_text_head(
        &mut cold_store,
        "object-cache-refusal-occupant",
        "notes/cache-refusal-occupied.md",
        "occupied",
    );

    let source = dohc_engine_collab::Ydoc::wire();
    let refused_bytes = source.plaintext_insert(0, "refused-clock");
    let descendant_bytes = source.plaintext_insert(13, " descendant");
    let warm_refused_sha = warm_store
        .put_binary_blob(&refused_bytes)
        .expect("warm refused blob");
    let cold_refused_sha = cold_store
        .put_binary_blob(&refused_bytes)
        .expect("cold refused blob");
    assert_eq!(warm_refused_sha, cold_refused_sha);
    let refused = envelope(
        "cache-refusal-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": object_id,
            "path": "notes/cache-refusal-occupied.md",
            "contentKind": "plaintext",
            "updateBlobSha256": warm_refused_sha,
            "lineageClaimId": claim.clone(),
            "isBaseState": false
        }),
    );
    let before = warm_cache.stats();
    let warm_refusal = apply_ydoc_envelope(
        &mut warm_store,
        &mut warm_cache,
        &refused,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("warm retained refusal");
    let cold_refusal = apply_ydoc_envelope(
        &mut cold_store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &refused,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("cold retained refusal");
    assert_eq!(warm_refusal, cold_refusal);
    assert!(matches!(
        warm_refusal,
        ApplyOutcome {
            primary: ApplyDisposition::Refused(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let after_refusal = warm_cache.stats();
    assert_eq!(after_refusal.hits, before.hits + 1);
    assert_eq!(
        after_refusal.advances,
        before.advances + 1,
        "the retained domain mutation advances the cache"
    );
    assert!(warm_cache.contains_for_test(&key));
    assert_eq!(
        warm_cache
            .frontier_matches_doc_for_test(&key)
            .expect("retained-refusal frontier comparison"),
        Some(true),
        "a committed projection refusal advances the frontier"
    );
    assert_eq!(
        warm_cache
            .gate_scratch_matches_doc_for_test(&key)
            .expect("retained-refusal scratch comparison"),
        Some(true),
        "a committed projection refusal advances the check-4 scratch"
    );

    let warm_descendant_sha = warm_store
        .put_binary_blob(&descendant_bytes)
        .expect("warm descendant blob");
    let cold_descendant_sha = cold_store
        .put_binary_blob(&descendant_bytes)
        .expect("cold descendant blob");
    assert_eq!(warm_descendant_sha, cold_descendant_sha);
    let descendant = envelope(
        "cache-refusal-peer",
        1,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": object_id,
            "path": path,
            "contentKind": "plaintext",
            "updateBlobSha256": warm_descendant_sha,
            "lineageClaimId": claim,
            "isBaseState": false
        }),
    );
    let warm_descendant = apply_ydoc_envelope(
        &mut warm_store,
        &mut warm_cache,
        &descendant,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("warm descendant");
    let cold_descendant = apply_ydoc_envelope(
        &mut cold_store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &descendant,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("cold descendant");
    assert_eq!(warm_descendant, cold_descendant);
    assert!(matches!(
        warm_descendant,
        ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let final_stats = warm_cache.stats();
    assert_eq!(final_stats.hits, before.hits + 2);
    assert_eq!(final_stats.advances, before.advances + 2);

    let warm = dohc_engine_collab::load_persisted(&warm_store, &key)
        .expect("warm persisted")
        .expect("warm lineage");
    let cold = dohc_engine_collab::load_persisted(&cold_store, &key)
        .expect("cold persisted")
        .expect("cold lineage");
    assert!(!warm.doc.has_pending_dependencies());
    assert!(!cold.doc.has_pending_dependencies());
    assert!(
        dohc_engine_collab::replay_parity::structurally_equal_v2_for_test(&warm.doc, &cold.doc)
            .expect("warm/cold refused lineage")
    );
    let cached = dohc_engine_collab::Ydoc::wire();
    cached
        .apply(
            &warm_cache
                .doc_full_state_for_test(&key)
                .expect("advanced cache state"),
        )
        .expect("cached full state");
    assert!(
        dohc_engine_collab::replay_parity::structurally_equal_v2_for_test(&cached, &cold.doc)
            .expect("cache/cold refused lineage")
    );
    let warm_head = VersionedTextStore::new(&mut warm_store)
        .read_text("ws", "main", path)
        .expect("warm head")
        .expect("warm snapshot");
    let cold_head = VersionedTextStore::new(&mut cold_store)
        .read_text("ws", "main", path)
        .expect("cold head")
        .expect("cold snapshot");
    assert_eq!(warm_head.text, cold_head.text);
    assert!(warm_head.text.contains("refused-clock"));
    assert!(warm_head.text.contains("descendant"));
}

fn assert_remote_cache_crash_seam(point: FaultPoint, committed: bool) {
    let (_warm_scratch, _warm_path, mut warm_store) = open_store();
    let (_cold_scratch, _cold_path, mut cold_store) = open_store();
    let mut warm_cache = dohc_engine_collab::WriterDocCache::new();
    let object_id = format!("object-cache-crash-{}", point.as_str().replace('.', "-"));
    let path = format!("notes/{object_id}.md");
    let (key, claim) = seed_warm_and_cold_remote_lineage(
        &mut warm_store,
        &mut warm_cache,
        &mut cold_store,
        &object_id,
        &path,
        "plaintext",
    );
    let source = dohc_engine_collab::Ydoc::wire();
    let first = source.plaintext_insert(0, "first");
    let second = source.plaintext_insert(5, " second");
    let warm_sha = warm_store.put_binary_blob(&first).expect("warm crash blob");
    let cold_sha = cold_store.put_binary_blob(&first).expect("cold crash blob");
    assert_eq!(warm_sha, cold_sha);
    let operation = envelope(
        "cache-crash-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": object_id,
            "path": path,
            "contentKind": "plaintext",
            "updateBlobSha256": warm_sha,
            "lineageClaimId": claim.clone(),
            "isBaseState": false
        }),
    );
    let before = warm_cache.stats();
    let warm_faults = ScriptedFaults::crash_at(point);
    let cold_faults = ScriptedFaults::crash_at(point);
    let warm_outcome = apply_ydoc_envelope(
        &mut warm_store,
        &mut warm_cache,
        &operation,
        warm_faults.as_ref(),
        &NoLiveLeases,
    )
    .expect("warm crash outcome");
    let cold_outcome = apply_ydoc_envelope(
        &mut cold_store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &operation,
        cold_faults.as_ref(),
        &NoLiveLeases,
    )
    .expect("cold crash outcome");
    assert_eq!(warm_outcome, cold_outcome);
    assert_eq!(
        warm_outcome,
        ApplyOutcome::new(ApplyDisposition::Crashed { committed })
    );
    assert_eq!(warm_cache.stats().hits, before.hits + 1);
    assert_eq!(
        warm_cache.stats().advances,
        before.advances,
        "a cache cannot advance before an acknowledged commit"
    );

    if committed {
        assert!(
            !warm_cache.contains_for_test(&key),
            "a durable-but-unacked append evicts the cache"
        );
        let warm = dohc_engine_collab::load_persisted(&warm_store, &key)
            .expect("warm durable crash state")
            .expect("warm lineage");
        let cold = dohc_engine_collab::load_persisted(&cold_store, &key)
            .expect("cold durable crash state")
            .expect("cold lineage");
        assert!(
            dohc_engine_collab::replay_parity::structurally_equal_v2_for_test(&warm.doc, &cold.doc)
                .expect("post-commit crash parity")
        );
        assert_eq!(
            apply_ydoc_envelope(
                &mut warm_store,
                &mut warm_cache,
                &operation,
                &NoFaults,
                &NoLiveLeases,
            )
            .expect("warm crash retry"),
            ApplyOutcome::new(ApplyDisposition::Skipped)
        );
        assert!(!warm_cache.contains_for_test(&key));

        let warm_second_sha = warm_store
            .put_binary_blob(&second)
            .expect("warm post-crash blob");
        let cold_second_sha = cold_store
            .put_binary_blob(&second)
            .expect("cold post-crash blob");
        assert_eq!(warm_second_sha, cold_second_sha);
        let second_operation = envelope(
            "cache-crash-peer",
            1,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": object_id,
                "path": path,
                "contentKind": "plaintext",
                "updateBlobSha256": warm_second_sha,
                "lineageClaimId": claim,
                "isBaseState": false
            }),
        );
        let before_rebuild = warm_cache.stats();
        let warm_second = apply_ydoc_envelope(
            &mut warm_store,
            &mut warm_cache,
            &second_operation,
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("warm post-crash append");
        let cold_second = apply_ydoc_envelope(
            &mut cold_store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &second_operation,
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("cold post-crash append");
        assert_eq!(warm_second, cold_second);
        assert_eq!(warm_cache.stats().misses, before_rebuild.misses + 1);
        assert_eq!(warm_cache.stats().installs, before_rebuild.installs + 1);
        assert!(warm_cache.contains_for_test(&key));
        assert_eq!(
            warm_cache
                .frontier_matches_doc_for_test(&key)
                .expect("post-crash rebuilt frontier"),
            Some(true)
        );
        assert_eq!(
            warm_cache
                .gate_scratch_matches_doc_for_test(&key)
                .expect("post-crash rebuilt scratch"),
            Some(true)
        );
    } else {
        assert!(
            warm_cache.contains_for_test(&key),
            "a rolled-back transaction preserves the validated cache entry"
        );
        assert_eq!(
            warm_cache
                .frontier_matches_doc_for_test(&key)
                .expect("frontier after remote rollback"),
            Some(true),
            "the read-only writer doc and frontier survive rollback"
        );
        assert!(
            !warm_cache.gate_scratch_is_resident_for_test(&key),
            "the accepted candidate mutated the rollback-less scratch"
        );
        let retry_before = warm_cache.stats();
        let warm_retry = apply_ydoc_envelope(
            &mut warm_store,
            &mut warm_cache,
            &operation,
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("warm rollback retry");
        let cold_retry = apply_ydoc_envelope(
            &mut cold_store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &operation,
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("cold rollback retry");
        assert_eq!(warm_retry, cold_retry);
        assert!(matches!(
            warm_retry,
            ApplyOutcome {
                primary: ApplyDisposition::Applied(_),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ));
        assert_eq!(warm_cache.stats().hits, retry_before.hits + 1);
        assert_eq!(warm_cache.stats().advances, retry_before.advances + 1);
        assert_eq!(
            warm_cache
                .frontier_matches_doc_for_test(&key)
                .expect("frontier after remote rollback retry"),
            Some(true)
        );
        assert_eq!(
            warm_cache
                .gate_scratch_matches_doc_for_test(&key)
                .expect("scratch after remote rollback retry"),
            Some(true),
            "the retry rebuilds the missing scratch and commits it"
        );
    }
}

#[test]
fn sync_rollback_keeps_the_warmed_remote_cache_valid() {
    assert_remote_cache_crash_seam(FaultPoint::SyncBeforeApplyCommit, false);
}

#[test]
fn storage_rollback_keeps_the_warmed_remote_cache_valid() {
    assert_remote_cache_crash_seam(FaultPoint::StorageBeforePersist, false);
}

#[test]
fn storage_committed_crash_evicts_and_rebuilds_the_remote_cache() {
    assert_remote_cache_crash_seam(FaultPoint::StorageAfterCommitBeforeAck, true);
}

#[test]
fn pulled_lineage_replacement_evicts_the_warmed_remote_path_entry() {
    let (_scratch, _path, mut store) = open_store();
    seed_replication_version(&mut store, "main", "main");
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-cache-replaced")
        .expect("replacement key");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','object-cache-replaced',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("replacement object");
    dohc_engine_collab::ensure_marker(
        &mut store,
        &key,
        dohc_engine_collab::ContentKind::Plaintext,
        dohc_engine_collab::Regime::LocalOnly,
        &NoFaults,
        1_000,
    )
    .expect("local marker");
    let local = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "local draft");
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    dohc_engine_collab::record_local_update(
        &mut store,
        &mut cache,
        &key,
        &local,
        dohc_engine_collab::LocalAppend::default(),
        &NoFaults,
        1_001,
        |_tx, _outcome, _update_sha| Ok(()),
    )
    .expect("warm local lineage");
    assert!(cache.contains_for_test(&key));
    let before = cache.stats();

    let incoming = dohc_engine_collab::Ydoc::wire();
    incoming.plaintext_insert(0, "remote winner");
    let incoming_bytes = incoming.encode_full_state();
    let claim = store
        .put_binary_blob(&incoming_bytes)
        .expect("incoming base blob");
    let base = envelope(
        "cache-replacement-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-cache-replaced",
            "path": "notes/cache-replaced.md",
            "contentKind": "plaintext",
            "updateBlobSha256": claim.clone(),
            "lineageClaimId": claim,
            "isBaseState": true
        }),
    );
    let outcome = apply_ydoc_envelope(&mut store, &mut cache, &base, &NoFaults, &NoLiveLeases)
        .expect("replace local lineage");
    let ApplyOutcome {
        primary: ApplyDisposition::Applied(result),
        refusals: ref outcome_refusals,
        sharing_declined: ref outcome_sharing_declined,
    } = outcome
    else {
        panic!("replacement did not apply: {outcome:?}");
    };
    assert!(outcome_refusals.is_empty());
    assert!(outcome_sharing_declined.is_empty());
    assert!(result.lineage_replacement.is_some());
    assert!(!cache.contains_for_test(&key));
    assert_eq!(
        cache.stats().removes,
        before.removes + 1,
        "the base payload evicts before its replacement transaction"
    );
}
