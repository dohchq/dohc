use super::*;

#[test]
fn leased_ydoc_envelope_acks_and_defers_without_mutating_the_ydoc_log() {
    let (_scratch, _path, mut engine) = open_store();
    // The defer path refuses non-replicated lineages (they can never drain),
    // so the test needs the replicated marker scaffolding first.
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO versioned_workspaces (workspace_id, main_version_id)                  VALUES ('ws','main')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms)                  VALUES ('ws','object-1',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("workspace scaffolding");
    let marker_key = dohc_engine_collab::DocKey::new("ws", "main", "object-1").expect("key");
    dohc_engine_collab::ensure_marker(
        &mut engine,
        &marker_key,
        dohc_engine_collab::ContentKind::Plaintext,
        dohc_engine_collab::Regime::Replicated,
        &NoFaults,
        1_500,
    )
    .expect("replicated marker");
    // A missing blob must refuse before any ack — a deferred coordinate is
    // already acknowledged, and a blob that can never load would strand the
    // drain forever while the peer cursor is past the row.
    let missing = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-1",
            "path": "notes/live.md",
            "contentKind": "plaintext",
            "updateBlobSha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "lineageClaimId": "1111111111111111111111111111111111111111111111111111111111111111",
            "isBaseState": false
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &missing,
            &NoFaults,
            &AlwaysLive
        ),
        Err(SyncError::BlobInvalid)
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "peer").expect("ack"),
        -1,
        "an unloadable blob must leave the coordinate unacked"
    );
    let update_bytes = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "live edit");
    let blob_sha = engine.put_binary_blob(&update_bytes).expect("store blob");
    let op = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-1",
            "path": "notes/live.md",
            "contentKind": "plaintext",
            "updateBlobSha256": blob_sha,
            "lineageClaimId": "1111111111111111111111111111111111111111111111111111111111111111",
            "isBaseState": false
        }),
    );
    let outcome = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &op,
        &NoFaults,
        &AlwaysLive,
    )
    .expect("live lineage defers");
    assert_eq!(
        outcome,
        ApplyOutcome::new(ApplyDisposition::Applied(RoutedApply::default()))
    );
    let deferred_rows: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                row.get(0)
            })
            .map_err(SyncError::corrupt)
        })
        .expect("count deferred Y.Doc coordinates");
    assert_eq!(
        deferred_rows, 1,
        "the durable replay marker replaces any routed caller action"
    );
    let update_rows: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| row.get(0))
                .map_err(SyncError::corrupt)
        })
        .expect("count Y.Doc updates");
    assert_eq!(update_rows, 0, "defer must not append remote Y.Doc bytes");
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "peer").expect("ack"),
        0,
        "the poison-pill coordinate is acknowledged"
    );
}

/// A pre-base update is already ACKed when its eventual base drains it. If
/// the combined document exceeds the text sink's measured cap, the drain must
/// persist and return that terminal refusal before it removes the queue row.
#[test]
fn deferred_ydoc_projection_over_the_text_cap_is_persisted_and_returned() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");

    let source = dohc_engine_collab::Ydoc::wire();
    source.plaintext_insert(0, "seed");
    let base = source.encode_full_state();
    let base_sha = engine.put_binary_blob(&base).expect("base blob");
    let delta = source.plaintext_insert(4, &"a".repeat(MAX_TEXT_BYTES));
    assert!(delta.len() < dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES);
    let delta_sha = engine.put_binary_blob(&delta).expect("delta blob");
    let delta_op = envelope(
        "deferred-over-cap-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-deferred-over-cap",
            "path": "notes/deferred-over-cap.md",
            "contentKind": "plaintext",
            "updateBlobSha256": delta_sha,
            "lineageClaimId": base_sha.clone(),
            "isBaseState": false,
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &delta_op,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(YdocApplyResult {
                deferred: true,
                reason: Some("ydoc-lineage-absent"),
                ..
            }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let base_op = envelope(
        "deferred-over-cap-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-deferred-over-cap",
            "path": "notes/deferred-over-cap.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha,
            "isBaseState": true,
        }),
    );
    let outcome = apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base_op,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("base applies and drains the oversized update");
    let ApplyOutcome {
        primary,
        refusals,
        sharing_declined,
    } = outcome;
    assert!(matches!(primary, ApplyDisposition::Applied(_)));
    assert!(sharing_declined.is_empty());
    let expected_reason = format!(
        "plaintext projection exceeds MAX_TEXT_BYTES: limit {MAX_TEXT_BYTES} bytes, observed at least {} bytes",
        MAX_TEXT_BYTES + 4
    );
    assert_eq!(
        refusals,
        vec![ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "deferred-over-cap-peer".to_owned(),
            origin_seq: 0,
            op_kind: "ydoc.update".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: expected_reason.clone(),
            },
        }],
        "the base caller must receive the owning deferred coordinate's refusal"
    );

    let (queued, persisted_reason, head): (i64, String, String) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                    row.get(0)
                })?,
                conn.query_row(
                    "SELECT reason_message FROM replication_pending_refusals \
                     WHERE workspace_id='ws' AND origin_id='deferred-over-cap-peer' \
                       AND origin_seq=0",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT b.text FROM snapshots AS s \
                     JOIN blobs AS b ON b.sha256=s.blob_sha256 \
                     WHERE s.workspace_id='ws' AND s.version_id='main' \
                       AND s.path='notes/deferred-over-cap.md'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("deferred refusal disposition");
    assert_eq!(queued, 0, "the terminally refused marker must be consumed");
    assert_eq!(persisted_reason, expected_reason);
    assert_eq!(
        head, "seed",
        "the oversized projection must not replace the head"
    );
}

#[test]
fn live_drain_stops_before_a_foreign_lineage_without_replacing_the_session() {
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    seed_text_head(
        &mut engine,
        "object-live-lineage",
        "notes/live-lineage.md",
        "base",
    );
    let key =
        dohc_engine_collab::DocKey::new("ws", "main", "object-live-lineage").expect("doc key");
    let current = dohc_engine_collab::Ydoc::wire();
    current.plaintext_insert(0, "base");
    let current_base = current.encode_full_state();
    let current_claim = dohc_engine_storage::hex_sha256(&current_base);
    assert!(matches!(
        dohc_engine_collab::claim_base_at_relay(
            &mut engine,
            &key,
            dohc_engine_collab::ContentKind::Plaintext,
            &current_base,
            &dohc_engine_collab::BaseRelayCoordinate::new("current", 0, 5)
                .expect("current coordinate"),
            &NoFaults,
            1_100,
        ),
        Ok(TxnOutcome::Committed(
            dohc_engine_collab::ClaimOutcome::Claimed { .. }
        ))
    ));

    let current_delta = current.plaintext_insert(4, " live");
    let current_delta_sha = engine
        .put_binary_blob(&current_delta)
        .expect("same-lineage delta blob");
    let mut same_lineage = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-live-lineage",
            "path": "notes/live-lineage.md",
            "contentKind": "plaintext",
            "updateBlobSha256": current_delta_sha,
            "lineageClaimId": current_claim,
            "isBaseState": false
        }),
    );
    same_lineage.relay_seq = Some(10);
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &same_lineage,
            &NoFaults,
            &AlwaysLive
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(YdocApplyResult { deferred: true, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let foreign = dohc_engine_collab::Ydoc::wire();
    foreign.plaintext_insert(0, "foreign");
    let foreign_base = foreign.encode_full_state();
    let foreign_claim = engine
        .put_binary_blob(&foreign_base)
        .expect("foreign base blob");
    let mut foreign_lineage = envelope(
        "peer",
        1,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-live-lineage",
            "path": "notes/live-lineage.md",
            "contentKind": "plaintext",
            "updateBlobSha256": foreign_claim,
            "lineageClaimId": foreign_claim,
            "isBaseState": true
        }),
    );
    foreign_lineage.relay_seq = Some(20);
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &foreign_lineage,
            &NoFaults,
            &AlwaysLive
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(YdocApplyResult { deferred: true, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let drained = drain_deferred_ydoc_for_live_session(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        Some(&current_claim),
        &NoFaults,
    )
    .expect("live-session drain");
    assert_eq!(drained.drained, 1, "the current-lineage delta drains");
    assert!(drained.lineage_replacements.is_empty());
    let state: (String, i64, i64, String) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT lineage_claim_id FROM ydoc_docs
                     WHERE workspace_id='ws' AND version_id='main'
                       AND object_id='object-live-lineage'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_deferred_updates
                     WHERE workspace_id='ws' AND version_id='main'
                       AND object_id='object-live-lineage'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_recovery_decisions", [], |row| {
                    row.get(0)
                })?,
                conn.query_row(
                    "SELECT lineage_claim_id FROM ydoc_deferred_updates
                     WHERE workspace_id='ws' AND version_id='main'
                       AND object_id='object-live-lineage'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("live drain state");
    assert_eq!(state, (current_claim, 1, 0, foreign_claim));
    let persisted = dohc_engine_collab::load_persisted(&engine, &key)
        .expect("persisted doc")
        .expect("current lineage");
    assert_eq!(
        persisted
            .doc
            .project(dohc_engine_collab::ContentKind::Plaintext)
            .expect("projection")
            .content,
        "base live"
    );
}

#[test]
fn parked_ydoc_envelope_drains_into_the_lineage_and_redrains_deduped() {
    let (_scratch, _path, mut engine) = open_store();
    // The replicated lineage exists before envelopes arrive (base claim);
    // apply_remote_update refuses NoMarker rather than conjuring one. The
    // version row exists because the drain now projects drained content to
    // the visible head (a real workspace always has its version).
    dohc_engine_domain::VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO versioned_workspaces (workspace_id, main_version_id)                  VALUES ('ws','main')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms)                  VALUES ('ws','object-1',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("workspace scaffolding");
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-1").expect("key");
    let base_bytes = dohc_engine_collab::Ydoc::wire().encode_full_state();
    let lineage_claim_id = match dohc_engine_collab::claim_base(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Plaintext,
        &base_bytes,
        &NoFaults,
        1_500,
    )
    .expect("replicated base claim")
    {
        TxnOutcome::Committed(dohc_engine_collab::ClaimOutcome::Claimed { base_snapshot_sha }) => {
            base_snapshot_sha
        }
        other => panic!("unexpected base claim outcome: {other:?}"),
    };
    let update_bytes = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "parked edit");
    let blob_sha = engine.put_binary_blob(&update_bytes).expect("store blob");
    let op = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-1",
            "path": "notes/live.md",
            "contentKind": "plaintext",
            "updateBlobSha256": blob_sha,
            "lineageClaimId": lineage_claim_id,
            "isBaseState": false
        }),
    );
    let outcome = apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &op,
        &NoFaults,
        &AlwaysLive,
    )
    .expect("live lineage defers");
    assert_eq!(
        outcome,
        ApplyOutcome::new(ApplyDisposition::Applied(YdocApplyResult {
            deferred: true,
            reason: Some("ydoc-session-live"),
            conflicts_opened: 0,
            lineage_replacement: None,
            record_facts: Vec::new(),
        }))
    );

    // The lease is gone (close/eviction/crash — any teardown): the drain must
    // land the acked-but-parked envelope in the durable lineage.
    let drained = drain_deferred_ydoc_for_key(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .expect("drain");
    assert_eq!(drained.drained, 1, "the parked envelope must apply");
    assert!(drained.refusals.is_empty());
    // The drain projects: the drained content is the visible head, not just
    // CRDT rows (a redelivery of the acked coordinate skips the apply
    // closure, so nothing else would ever project it).
    let head_text: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM path_aliases a                  JOIN snapshots s ON s.workspace_id = a.workspace_id AND s.object_id = a.object_id                  JOIN blobs b ON b.sha256 = s.blob_sha256                  WHERE a.workspace_id = 'ws' AND a.version_id = 'main'                    AND a.path = 'notes/live.md'",
                [],
                |r| r.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("drained head");
    assert_eq!(head_text, "parked edit");
    let update_rows: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| row.get(0))
                .map_err(SyncError::corrupt)
        })
        .expect("count Y.Doc updates");
    assert_eq!(update_rows, 1, "the drained update reaches the Y.Doc log");

    let redrained = drain_deferred_ydoc_for_key(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .expect("redrain");
    assert_eq!(
        redrained.drained, 0,
        "replaying the parked row is content-deduped"
    );
    assert!(redrained.refusals.is_empty());
}

#[test]
fn drained_parked_update_derives_its_record_facts() {
    const RECORD_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OBJECT_ID: &str = "history-redelivery-object";
    const PATH: &str = "tasks/history.md";

    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    seed_text_head(
        &mut engine,
        "history-redelivery-schema",
        "tasks/collection.yaml",
        "fields:\n  title:\n    type: text\n  padding:\n    type: text\n",
    );
    let markdown = format!("---\nid: {RECORD_ID}\ntitle: Original\n---\n\nBody\n");
    seed_text_head(&mut engine, OBJECT_ID, PATH, &markdown);
    engine
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, "ws", "main")?;
            dohc_engine_domain::set_collection_adoption_state_in_tx(
                tx, "ws", "main", PATH, RECORD_ID, "adopted",
            )
        })
        .expect("bind adopted collection record");

    let key = dohc_engine_collab::DocKey::new("ws", "main", OBJECT_ID).expect("key");
    let local = dohc_engine_collab::Ydoc::wire();
    local
        .rewrite_content_to_markdown(dohc_engine_collab::ContentKind::Richdoc, &markdown)
        .expect("seed rich document");
    let base = local.encode_full_state();
    let claim_id = match dohc_engine_collab::claim_base(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Richdoc,
        &base,
        &NoFaults,
        1_500,
    )
    .expect("claim replicated base")
    {
        TxnOutcome::Committed(dohc_engine_collab::ClaimOutcome::Claimed { base_snapshot_sha }) => {
            base_snapshot_sha
        }
        other => panic!("unexpected base claim: {other:?}"),
    };

    let remote = dohc_engine_collab::Ydoc::wire();
    remote.apply(&base).expect("remote sees base");
    let remote_update = remote.frontmatter_set("title", "Remote");

    let mut cache = dohc_engine_collab::WriterDocCache::new();
    for index in 0..(dohc_engine_collab::limits::DEFAULT_COMPACTION_THRESHOLD - 1) {
        let filler = local.frontmatter_set("padding", &format!("{index}"));
        let outcome = dohc_engine_collab::record_local_update(
            &mut engine,
            &mut cache,
            &key,
            &filler,
            dohc_engine_collab::LocalAppend::default(),
            &NoFaults,
            1_600 + index as i64,
            |_tx, _outcome, _update_sha| Ok(()),
        )
        .expect("append filler update");
        assert!(matches!(outcome, TxnOutcome::Committed(_)));
    }

    let update_sha = engine
        .put_binary_blob(&remote_update)
        .expect("store remote update");
    let operation = envelope(
        "history-redelivery-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": OBJECT_ID,
            "path": PATH,
            "contentKind": "richdoc",
            "updateBlobSha256": update_sha,
            "lineageClaimId": claim_id,
            "isBaseState": false,
            "actorOriginId": "remote-author"
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &operation,
            &NoFaults,
            &AlwaysLive
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(YdocApplyResult { deferred: true, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    // The base arrives and the drain applies the parked edit: its facts
    // surface with the drain, so the pass that completes the dependency
    // fires the parked update's record events.
    let drained = drain_deferred_ydoc_for_key(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .expect("drain");
    assert_eq!(drained.drained, 1);
    assert_eq!(drained.record_facts.len(), 1, "{:?}", drained.record_facts);
    let facts = &drained.record_facts[0];
    assert_eq!(facts.record_id, RECORD_ID);
    assert_eq!(facts.author_origin_id.as_deref(), Some("remote-author"));
    assert_eq!(facts.fields.len(), 1);
    assert_eq!(facts.fields[0].field_name, "title");
}

#[test]
fn compacted_deferred_update_redelivery_does_not_duplicate_collection_history() {
    const RECORD_ID: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OBJECT_ID: &str = "history-redelivery-object";
    const PATH: &str = "tasks/history.md";

    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    seed_text_head(
        &mut engine,
        "history-redelivery-schema",
        "tasks/collection.yaml",
        "fields:\n  title:\n    type: text\n  padding:\n    type: text\n",
    );
    let markdown = format!("---\nid: {RECORD_ID}\ntitle: Original\n---\n\nBody\n");
    seed_text_head(&mut engine, OBJECT_ID, PATH, &markdown);
    engine
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, "ws", "main")?;
            dohc_engine_domain::set_collection_adoption_state_in_tx(
                tx, "ws", "main", PATH, RECORD_ID, "adopted",
            )
        })
        .expect("bind adopted collection record");

    let key = dohc_engine_collab::DocKey::new("ws", "main", OBJECT_ID).expect("key");
    let local = dohc_engine_collab::Ydoc::wire();
    local
        .rewrite_content_to_markdown(dohc_engine_collab::ContentKind::Richdoc, &markdown)
        .expect("seed rich document");
    let base = local.encode_full_state();
    let claim_id = match dohc_engine_collab::claim_base(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Richdoc,
        &base,
        &NoFaults,
        1_500,
    )
    .expect("claim replicated base")
    {
        TxnOutcome::Committed(dohc_engine_collab::ClaimOutcome::Claimed { base_snapshot_sha }) => {
            base_snapshot_sha
        }
        other => panic!("unexpected base claim: {other:?}"),
    };

    let remote = dohc_engine_collab::Ydoc::wire();
    remote.apply(&base).expect("remote sees base");
    let remote_update = remote.frontmatter_set("title", "Remote");

    let mut cache = dohc_engine_collab::WriterDocCache::new();
    for index in 0..(dohc_engine_collab::limits::DEFAULT_COMPACTION_THRESHOLD - 1) {
        let filler = local.frontmatter_set("padding", &format!("{index}"));
        let outcome = dohc_engine_collab::record_local_update(
            &mut engine,
            &mut cache,
            &key,
            &filler,
            dohc_engine_collab::LocalAppend::default(),
            &NoFaults,
            1_600 + index as i64,
            |_tx, _outcome, _update_sha| Ok(()),
        )
        .expect("append filler update");
        assert!(matches!(outcome, TxnOutcome::Committed(_)));
    }

    let update_sha = engine
        .put_binary_blob(&remote_update)
        .expect("store remote update");
    let operation = envelope(
        "history-redelivery-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": OBJECT_ID,
            "path": PATH,
            "contentKind": "richdoc",
            "updateBlobSha256": update_sha,
            "lineageClaimId": claim_id,
            "isBaseState": false,
            "actorOriginId": "remote-author"
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &operation,
            &NoFaults,
            &AlwaysLive
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(YdocApplyResult { deferred: true, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "CREATE TRIGGER inject_deferred_projection_failure \
                 BEFORE INSERT ON moments \
                 BEGIN SELECT RAISE(ABORT, 'injected drain projection failure'); END",
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("install projection failure");

    assert!(matches!(
        drain_deferred_ydoc_for_key(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &NoFaults
        ),
        Err(SyncError::Storage(_))
    ));
    let after_failure: (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM collection_field_history \
                     WHERE workspace_id='ws' AND version_id='main' \
                       AND record_id=?1 AND field_name='title'",
                    [RECORD_ID],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_updates \
                     WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                    [OBJECT_ID],
                    |row| row.get(0),
                )?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                    row.get(0)
                })?,
            ))
        })
        .expect("state after failed projection");
    assert_eq!(
        after_failure,
        (1, 0, 1),
        "the update and its history commit before projection, then compact"
    );

    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch("DROP TRIGGER inject_deferred_projection_failure")
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("clear projection failure");
    let redrained = drain_deferred_ydoc_for_key(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .expect("redrain update");
    assert_eq!(redrained.drained, 1);
    // The failed first drain committed the update, its history row, and its
    // record-event decision, then dropped the derived facts with its error —
    // nothing was emitted. The redrain's replay derives no second fact set
    // (the history insert dedupes by coordinate); it returns the persisted
    // decision instead, so the facts surface exactly once.
    assert_eq!(
        redrained.record_facts.len(),
        1,
        "the redrain returns the committed decision: {:?}",
        redrained.record_facts
    );
    let facts = &redrained.record_facts[0];
    assert_eq!(facts.record_id, RECORD_ID);
    assert_eq!(facts.fields.len(), 1);
    assert_eq!(facts.fields[0].field_name, "title");
    assert_eq!(facts.fields[0].next_json.as_deref(), Some("\"Remote\""));
    let (history_rows, deferred_rows): (i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM collection_field_history \
                     WHERE workspace_id='ws' AND version_id='main' \
                       AND record_id=?1 AND field_name='title'",
                    [RECORD_ID],
                    |row| row.get(0),
                )?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                    row.get(0)
                })?,
            ))
        })
        .expect("state after redelivery");
    assert_eq!(
        history_rows, 1,
        "redelivery must reuse the journal identity"
    );
    assert_eq!(deferred_rows, 0, "successful projection clears the marker");
}

/// A deferred drain whose final projection fails has already committed
/// the parked update, its history row, and its record-event decision — but
/// returns an error, dropping the derived facts unemitted. The redrain
/// dedupes the update and returns the persisted decision; the successful
/// drain consumes it, so a third drain finds nothing. The facts surface
/// exactly once and history is never duplicated.
#[test]
fn a_failed_drain_projection_surfaces_record_facts_exactly_once_on_the_redrain() {
    const RECORD_ID: &str = "rec_cccccccccccccccccccccccccc";
    const OBJECT_ID: &str = "projection-failure-object";
    const PATH: &str = "tasks/projection.md";

    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    seed_text_head(
        &mut engine,
        "projection-failure-schema",
        "tasks/collection.yaml",
        "fields:\n  title:\n    type: text\n",
    );
    let markdown = format!("---\nid: {RECORD_ID}\ntitle: Original\n---\n\nBody\n");
    seed_text_head(&mut engine, OBJECT_ID, PATH, &markdown);
    engine
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, "ws", "main")?;
            dohc_engine_domain::set_collection_adoption_state_in_tx(
                tx, "ws", "main", PATH, RECORD_ID, "adopted",
            )
        })
        .expect("bind adopted collection record");

    let key = dohc_engine_collab::DocKey::new("ws", "main", OBJECT_ID).expect("key");
    let local = dohc_engine_collab::Ydoc::wire();
    local
        .rewrite_content_to_markdown(dohc_engine_collab::ContentKind::Richdoc, &markdown)
        .expect("seed rich document");
    let base = local.encode_full_state();
    let claim_id = match dohc_engine_collab::claim_base(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Richdoc,
        &base,
        &NoFaults,
        1_500,
    )
    .expect("claim replicated base")
    {
        TxnOutcome::Committed(dohc_engine_collab::ClaimOutcome::Claimed { base_snapshot_sha }) => {
            base_snapshot_sha
        }
        other => panic!("unexpected base claim: {other:?}"),
    };

    let remote = dohc_engine_collab::Ydoc::wire();
    remote.apply(&base).expect("remote sees base");
    let remote_update = remote.frontmatter_set("title", "Remote");
    let update_sha = engine
        .put_binary_blob(&remote_update)
        .expect("store remote update");
    let operation = envelope(
        "projection-failure-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": OBJECT_ID,
            "path": PATH,
            "contentKind": "richdoc",
            "updateBlobSha256": update_sha,
            "lineageClaimId": claim_id,
            "isBaseState": false,
            "actorOriginId": "remote-author"
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &operation,
            &NoFaults,
            &AlwaysLive
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(YdocApplyResult { deferred: true, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "CREATE TRIGGER inject_projection_failure \
                 BEFORE INSERT ON moments \
                 BEGIN SELECT RAISE(ABORT, 'injected drain projection failure'); END",
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("install projection failure");
    assert!(matches!(
        drain_deferred_ydoc_for_key(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &NoFaults
        ),
        Err(SyncError::Storage(_))
    ));
    // The apply's transaction committed the update, the history row, and the
    // event decision on the still-parked coordinate; the projection failure
    // dropped only the returned facts.
    let (history_after_failure, decision): (i64, Option<String>) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM collection_field_history \
                     WHERE workspace_id='ws' AND version_id='main' \
                       AND record_id=?1 AND field_name='title'",
                    [RECORD_ID],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT record_facts_json FROM ydoc_deferred_updates \
                     WHERE workspace_id='ws' AND origin_id='projection-failure-peer' \
                       AND origin_seq=0",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("state after failed projection");
    assert_eq!(history_after_failure, 1);
    assert!(
        decision.is_some(),
        "the record-event decision persists with the committed update"
    );

    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch("DROP TRIGGER inject_projection_failure")
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("clear projection failure");
    let redrained = drain_deferred_ydoc_for_key(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .expect("redrain update");
    assert_eq!(redrained.drained, 1);
    assert_eq!(
        redrained.record_facts.len(),
        1,
        "{:?}",
        redrained.record_facts
    );
    let facts = &redrained.record_facts[0];
    assert_eq!(facts.record_id, RECORD_ID);
    assert_eq!(facts.collection_path, "tasks");
    assert!(!facts.created);
    assert_eq!(facts.author_origin_id.as_deref(), Some("remote-author"));
    assert_eq!(
        facts.source,
        Some(("projection-failure-peer".to_owned(), 0))
    );
    assert_eq!(facts.fields.len(), 1);
    assert_eq!(facts.fields[0].field_name, "title");
    assert_eq!(
        facts.fields[0].previous_json.as_deref(),
        Some("\"Original\"")
    );
    assert_eq!(facts.fields[0].next_json.as_deref(), Some("\"Remote\""));

    let (history_rows, deferred_rows): (i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM collection_field_history \
                     WHERE workspace_id='ws' AND version_id='main' \
                       AND record_id=?1 AND field_name='title'",
                    [RECORD_ID],
                    |row| row.get(0),
                )?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                    row.get(0)
                })?,
            ))
        })
        .expect("state after redrain");
    assert_eq!(history_rows, 1, "the history row is never duplicated");
    assert_eq!(
        deferred_rows, 0,
        "the successful drain consumes the decision with the marker"
    );

    // Exactly once: with the decision consumed, a further drain has nothing
    // to apply and nothing to surface.
    let idle = drain_deferred_ydoc_for_key(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .expect("idle drain");
    assert_eq!(idle.drained, 0);
    assert!(idle.record_facts.is_empty());
}

#[test]
fn resolution_fold_refuses_while_deferred_updates_are_parked() {
    // Acked-but-parked remote updates were never part of
    // either reviewed side, and their drain runs after the review gate
    // closes. The fold — and with it the whole resolution transaction —
    // refuses until they drain.
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws','object-parked',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO ydoc_deferred_updates \
                 (workspace_id, version_id, object_id, origin_id, origin_seq, recorded_at_ms) \
                 VALUES ('ws','main','object-parked','peer',0,1_500)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("parked row");
    let refused = engine.write_with(&NoFaults, |tx| {
        crate::ydoc_apply::fold_resolution_into_ydoc_in_tx(
            tx,
            "ws",
            "main",
            "object-parked",
            "notes/parked.md",
            "chosen text",
            1_600,
        )
    });
    assert!(
        matches!(
            refused,
            Err(SyncError::InvalidInput {
                reason: "ydoc-deferred-updates-pending"
            })
        ),
        "a parked queue must refuse the resolution: {refused:?}"
    );
}

#[test]
fn ydoc_update_before_base_is_parked_then_drained_when_lineage_arrives() {
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");

    let doc = dohc_engine_collab::Ydoc::wire();
    doc.plaintext_insert(0, "base");
    let base_sha = engine
        .put_binary_blob(&doc.encode_full_state())
        .expect("base blob");
    let update_sha = engine
        .put_binary_blob(&doc.plaintext_insert(0, "before "))
        .expect("dependent update blob");
    let update = envelope(
        "early-update-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-out-of-order",
            "path": "notes/out-of-order.md",
            "contentKind": "plaintext",
            "updateBlobSha256": update_sha,
            "lineageClaimId": base_sha.clone(),
            "isBaseState": false
        }),
    );
    assert_eq!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &update,
            &NoFaults,
            &NoLiveLeases
        )
        .expect("early update parks"),
        ApplyOutcome::new(ApplyDisposition::Applied(YdocApplyResult {
            deferred: true,
            reason: Some("ydoc-lineage-absent"),
            conflicts_opened: 0,
            lineage_replacement: None,
            record_facts: Vec::new(),
        }))
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "early-update-peer").expect("update ack"),
        0
    );
    let parked: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                row.get(0)
            })
            .map_err(SyncError::corrupt)
        })
        .expect("parked row count");
    assert_eq!(parked, 1);

    let base = envelope(
        "late-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-out-of-order",
            "path": "notes/out-of-order.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha,
            "isBaseState": true
        }),
    );
    apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("base arrives and drains");
    let (parked, updates, head): (i64, i64, String) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                    row.get(0)
                })?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| row.get(0))?,
                conn.query_row(
                    "SELECT b.text FROM snapshots s \
                     JOIN blobs b ON b.sha256=s.blob_sha256 \
                     WHERE s.workspace_id='ws' AND s.version_id='main' \
                       AND s.path='notes/out-of-order.md'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("drained lineage");
    assert_eq!(parked, 0, "the base arrival drains the parked coordinate");
    assert_eq!(updates, 1, "the dependent update reaches the lineage");
    assert_eq!(head, "before base");
}

#[test]
fn ydoc_prebase_content_kind_refusal_retains_clocks_for_a_dependent_descendant() {
    for (case, base_kind, queued_kind) in [
        ("plaintext-base", "plaintext", "richdoc"),
        ("richdoc-base", "richdoc", "plaintext"),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        VersionedTextStore::new(&mut engine)
            .ensure_main_version("ws", "main", 1_300, &NoFaults)
            .expect("main version");

        let base_doc = dohc_engine_collab::Ydoc::wire();
        match base_kind {
            "plaintext" => {
                base_doc.plaintext_insert(0, "base");
            }
            "richdoc" => {
                base_doc.richdoc_append_paragraph("base");
            }
            _ => unreachable!(),
        }
        let queued_doc = dohc_engine_collab::Ydoc::wire();
        let queued_bytes = match queued_kind {
            "plaintext" => queued_doc.plaintext_insert(0, "queued"),
            "richdoc" => queued_doc.richdoc_append_paragraph("queued"),
            _ => unreachable!(),
        };
        let descendant_bytes = match queued_kind {
            "plaintext" => queued_doc.plaintext_insert(6, "-descendant"),
            "richdoc" => queued_doc.richdoc_append_paragraph("descendant"),
            _ => unreachable!(),
        };
        let base_sha = engine
            .put_binary_blob(&base_doc.encode_full_state())
            .expect("base blob");
        let queued_sha = engine.put_binary_blob(&queued_bytes).expect("queued blob");
        let descendant_sha = engine
            .put_binary_blob(&descendant_bytes)
            .expect("descendant blob");
        let object_id = format!("object-kind-{case}");
        let path = format!("notes/{case}.md");
        let queued_origin = format!("queued-kind-{case}-peer");
        let queued = envelope(
            &queued_origin,
            0,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": object_id,
                "path": path,
                "contentKind": queued_kind,
                "updateBlobSha256": queued_sha,
                "lineageClaimId": base_sha.clone(),
                "isBaseState": false
            }),
        );
        assert!(matches!(
            apply_ydoc_envelope(
                &mut engine,
                &mut dohc_engine_collab::WriterDocCache::new(),
                &queued,
                &NoFaults,
                &NoLiveLeases
            ),
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(YdocApplyResult {
                    deferred: true,
                    reason: Some("ydoc-lineage-absent"),
                    conflicts_opened: 0,
                    lineage_replacement: None,
                    record_facts: _,
                }),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ));
        let descendant = envelope(
            &queued_origin,
            1,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": object_id,
                "path": path,
                "contentKind": base_kind,
                "updateBlobSha256": descendant_sha,
                "lineageClaimId": base_sha.clone(),
                "isBaseState": false
            }),
        );
        assert!(matches!(
            apply_ydoc_envelope(
                &mut engine,
                &mut dohc_engine_collab::WriterDocCache::new(),
                &descendant,
                &NoFaults,
                &NoLiveLeases
            ),
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(YdocApplyResult {
                    deferred: true,
                    reason: Some("ydoc-lineage-absent"),
                    conflicts_opened: 0,
                    lineage_replacement: None,
                    record_facts: _,
                }),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ));

        let base = envelope(
            &format!("base-kind-{case}-peer"),
            0,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": object_id,
                "path": path,
                "contentKind": base_kind,
                "updateBlobSha256": base_sha.clone(),
                "lineageClaimId": base_sha,
                "isBaseState": true
            }),
        );
        let outcome = apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &base,
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("base applies and mismatched kind is drained");
        let ApplyOutcome {
            primary,
            refusals,
            sharing_declined,
        } = outcome;
        assert!(sharing_declined.is_empty());
        assert!(matches!(primary, ApplyDisposition::Applied(_)));
        assert_eq!(
            refusals,
            vec![ReplicationRefusal {
                workspace_id: "ws".to_owned(),
                origin_id: queued_origin.clone(),
                origin_seq: 0,
                op_kind: "ydoc.update".to_owned(),
                reason: RefusalReason::InvalidInput {
                    reason: "ydoc.update content kind does not match the established lineage"
                        .to_owned(),
                },
            }],
            "{case}: omitting the marker-kind comparison silently accepts the hidden-root edit"
        );

        let key = dohc_engine_collab::DocKey::new("ws", "main", &object_id).expect("doc key");
        let persisted = dohc_engine_collab::load_persisted(&engine, &key)
            .expect("load lineage")
            .expect("persisted lineage");
        let projected = persisted
            .doc
            .project(
                dohc_engine_collab::ContentKind::parse(base_kind)
                    .expect("established content kind"),
            )
            .expect("project established kind");
        assert!(projected.content.contains("base"));
        assert!(
            !projected.content.contains("queued"),
            "the refused alternate-root edit must not project through the established kind"
        );
        assert!(
            !persisted.doc.has_pending_dependencies(),
            "{case}: refusing before applying the mismatched coordinate strands its descendant"
        );
        let (deferred, updates, refusal_rows): (i64, i64, i64) = engine
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT COUNT(*) FROM ydoc_deferred_updates \
                         WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                        [&object_id],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM ydoc_updates \
                         WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                        [&object_id],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM replication_pending_refusals \
                         WHERE workspace_id='ws' AND origin_id=?1 AND origin_seq=0",
                        [&queued_origin],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("mismatched-kind disposition");
        assert_eq!(
            (deferred, updates, refusal_rows),
            (0, 2, 1),
            "the refused clock and its dependent descendant must both enter the causal lineage"
        );
    }
}

#[test]
fn ydoc_prebase_update_with_an_existing_other_alias_retries_before_parking() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let head_sha = dohc_engine_storage::hex_sha256(b"existing");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,8,'existing')",
                [&head_sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','object-prebase-path',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO snapshots \
                 (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin,content_kind,binary_sha256) \
                 VALUES ('ws','main','object-prebase-path','notes/a.md',?1,1,'existing-moment','api','text',NULL)",
                [&head_sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
                 VALUES ('ws','main','notes/a.md','object-prebase-path')",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("existing identity");
    let update_sha = engine
        .put_binary_blob(&dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "queued"))
        .expect("update blob");
    let update = envelope(
        "prebase-path-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-prebase-path",
            "path": "notes/b.md",
            "contentKind": "plaintext",
            "updateBlobSha256": update_sha,
            "lineageClaimId": "1111111111111111111111111111111111111111111111111111111111111111",
            "isBaseState": false
        }),
    );

    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &update,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::RetryableState {
            reason: "ydoc.update object already occupies another path"
        })
    ));
    let (deferred, docs, updates): (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                    row.get(0)
                })?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_docs", [], |row| row.get(0))?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| row.get(0))?,
            ))
        })
        .expect("pre-base disposition");
    assert_eq!(
        (deferred, docs, updates),
        (0, 0, 0),
        "the transient identity race must not mutate or park"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "prebase-path-peer").expect("retryable ack"),
        -1,
        "classifying the local identity pin InvalidInput permanently ACKs the update"
    );

    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM snapshots
                 WHERE workspace_id='ws' AND version_id='main'
                   AND object_id='object-prebase-path'",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "DELETE FROM path_aliases
                 WHERE workspace_id='ws' AND version_id='main'
                   AND object_id='object-prebase-path'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("later delete frees the identity");
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &update,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(YdocApplyResult {
                deferred: true,
                reason: Some("ydoc-lineage-absent"),
                conflicts_opened: 0,
                lineage_replacement: None,
                record_facts: _,
            }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let deferred: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM ydoc_deferred_updates
                 WHERE workspace_id='ws' AND origin_id='prebase-path-peer'
                   AND origin_seq=0",
                [],
                |row| row.get(0),
            )
        })
        .expect("parked after identity resolves");
    assert_eq!(deferred, 1);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "prebase-path-peer").expect("park ack"),
        0
    );
}

#[test]
fn ydoc_prebase_update_for_missing_version_retries_then_parks_after_version_create() {
    let (_scratch, _path, mut engine) = open_store();
    let update_bytes = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "orphan");
    let update_sha = engine
        .put_binary_blob(&update_bytes)
        .expect("orphan update blob");
    let update = envelope(
        "missing-version-ydoc-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "never-created",
            "objectId": "object-never-created",
            "path": "notes/orphan.md",
            "contentKind": "plaintext",
            "updateBlobSha256": update_sha,
            "lineageClaimId": "1111111111111111111111111111111111111111111111111111111111111111",
            "isBaseState": false
        }),
    );

    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &update,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::RetryableState {
            reason: "ydoc.update version is missing"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "missing-version-ydoc-peer").expect("retry ack"),
        -1
    );
    let (objects, deferred, refusal_rows): (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM file_objects \
                     WHERE workspace_id='ws' AND object_id='object-never-created'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_deferred_updates \
                     WHERE workspace_id='ws' AND version_id='never-created'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_refusals \
                     WHERE workspace_id='ws' AND origin_id='missing-version-ydoc-peer' \
                       AND origin_seq=0 AND reason_message='ydoc.update version is missing'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("missing-version disposition");
    assert_eq!(
        (objects, deferred, refusal_rows),
        (0, 0, 0),
        "classifying the dependency as invalid input journals and retires the coordinate"
    );
    seed_replication_version(&mut engine, "never-created", "branch");
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &update,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(YdocApplyResult {
                deferred: true,
                reason: Some("ydoc-lineage-absent"),
                conflicts_opened: 0,
                lineage_replacement: None,
                record_facts: _,
            }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "missing-version-ydoc-peer")
            .expect("applied ack"),
        0
    );
}

#[test]
fn ydoc_base_replaces_prebase_placeholder_timestamp_with_base_provenance() {
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");

    let doc = dohc_engine_collab::Ydoc::wire();
    doc.plaintext_insert(0, "base");
    let base_sha = engine
        .put_binary_blob(&doc.encode_full_state())
        .expect("base blob");
    let update_sha = engine
        .put_binary_blob(&doc.plaintext_insert(0, "updated "))
        .expect("dependent update blob");
    let mut update = envelope(
        "timestamp-update-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-base-timestamp",
            "path": "notes/base-timestamp.md",
            "contentKind": "plaintext",
            "updateBlobSha256": update_sha,
            "lineageClaimId": base_sha.clone(),
            "isBaseState": false
        }),
    );
    update.recorded_at_ms = 2_000;
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &update,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(YdocApplyResult {
                deferred: true,
                reason: Some("ydoc-lineage-absent"),
                conflicts_opened: 0,
                lineage_replacement: None,
                record_facts: _,
            }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let placeholder_timestamp: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT created_at_ms FROM file_objects \
                 WHERE workspace_id='ws' AND object_id='object-base-timestamp'",
                [],
                |row| row.get(0),
            )
        })
        .expect("placeholder timestamp");
    assert_eq!(placeholder_timestamp, 2_000);

    let mut base = envelope(
        "timestamp-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-base-timestamp",
            "path": "notes/base-timestamp.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha,
            "isBaseState": true
        }),
    );
    base.recorded_at_ms = 7_000;
    apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("base arrives");
    let created_at_ms: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT created_at_ms FROM file_objects \
                 WHERE workspace_id='ws' AND object_id='object-base-timestamp'",
                [],
                |row| row.get(0),
            )
        })
        .expect("base timestamp");
    assert_eq!(
        created_at_ms, 7_000,
        "retaining the placeholder time (or only the earliest time) loses base provenance"
    );
}

#[test]
fn ydoc_prebase_drain_refuses_invalid_update_and_continues_in_order() {
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");

    // Both updates are individually valid, but they redefine client 12 clock
    // 0 with different content. The second must become a terminal refusal only
    // after the first arrives as the base.
    let (base_bytes, invalid_bytes) = clock_collision_pair();
    let valid_before = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "valid-before ");
    let valid_after = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, " valid-after");
    let base_sha = engine.put_binary_blob(&base_bytes).expect("base blob");
    let updates = [
        (
            "a-valid-before",
            engine
                .put_binary_blob(&valid_before)
                .expect("first valid blob"),
        ),
        (
            "b-invalid-collision",
            engine
                .put_binary_blob(&invalid_bytes)
                .expect("invalid-against-base blob"),
        ),
        (
            "c-valid-after",
            engine
                .put_binary_blob(&valid_after)
                .expect("second valid blob"),
        ),
    ];
    for (origin, sha) in updates {
        let update = envelope(
            origin,
            0,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": "object-drain-refusal",
                "path": "notes/drain-refusal.md",
                "contentKind": "plaintext",
                "updateBlobSha256": sha,
                "lineageClaimId": base_sha.clone(),
                "isBaseState": false
            }),
        );
        assert!(matches!(
            apply_ydoc_envelope(
                &mut engine,
                &mut dohc_engine_collab::WriterDocCache::new(),
                &update,
                &NoFaults,
                &NoLiveLeases
            ),
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(YdocApplyResult {
                    deferred: true,
                    reason: Some("ydoc-lineage-absent"),
                    conflicts_opened: 0,
                    lineage_replacement: None,
                    record_facts: _,
                }),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ));
    }

    let base = envelope(
        "base-after-three",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-drain-refusal",
            "path": "notes/drain-refusal.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha,
            "isBaseState": true
        }),
    );
    let base_outcome = apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("base applies and drains");
    let ApplyOutcome {
        primary: base_primary,
        refusals: drain_refusals,
        sharing_declined,
    } = base_outcome;
    assert!(sharing_declined.is_empty());
    assert!(matches!(base_primary, ApplyDisposition::Applied(_)));
    assert_eq!(
        drain_refusals,
        vec![ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "b-invalid-collision".to_owned(),
            origin_seq: 0,
            op_kind: "ydoc.update".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "parked ydoc.update could not be applied".to_owned(),
            },
        }],
        "persisting without returning the drain refusal hides it from the base caller"
    );

    let key =
        dohc_engine_collab::DocKey::new("ws", "main", "object-drain-refusal").expect("doc key");
    let persisted = dohc_engine_collab::load_persisted(&engine, &key)
        .expect("load lineage")
        .expect("persisted lineage");
    let text = persisted.doc.plaintext_string();
    assert!(
        text.contains("valid-before "),
        "the valid update before the refusal must apply: {text:?}"
    );
    assert!(
        text.contains(" valid-after"),
        "the valid update after the refusal must still apply: {text:?}"
    );
    let (queued, applied_updates, refusal_rows, reason): (i64, i64, i64, String) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                    row.get(0)
                })?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| row.get(0))?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_refusals \
                     WHERE workspace_id='ws' AND origin_id='b-invalid-collision' AND origin_seq=0",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT reason_message FROM replication_pending_refusals \
                     WHERE workspace_id='ws' AND origin_id='b-invalid-collision' AND origin_seq=0",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("drain disposition");
    assert_eq!(queued, 0, "all three deferred markers must be consumed");
    assert_eq!(
        applied_updates, 2,
        "only the two valid parked updates may enter the lineage"
    );
    assert_eq!(
        refusal_rows, 1,
        "omitting refusal persistence loses the invalid coordinate"
    );
    assert_eq!(reason, "parked ydoc.update could not be applied");
    assert_eq!(
        drain_deferred_ydoc_for_key(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &NoFaults
        )
        .expect("redrain")
        .drained,
        0,
        "retaining the invalid marker wedges every later drain"
    );
}

#[test]
fn ydoc_prebase_path_mismatch_is_refused_but_retains_causal_bytes() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let base_doc = dohc_engine_collab::Ydoc::wire();
    base_doc.plaintext_insert(0, "base");
    let base_sha = engine
        .put_binary_blob(&base_doc.encode_full_state())
        .expect("base blob");
    let update_sha = engine
        .put_binary_blob(&dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "queued"))
        .expect("pre-base blob");
    let update = envelope(
        "prebase-mismatch-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-prebase-mismatch",
            "path": "notes/b.md",
            "contentKind": "plaintext",
            "updateBlobSha256": update_sha,
            "lineageClaimId": base_sha.clone(),
            "isBaseState": false
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &update,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(YdocApplyResult {
                deferred: true,
                reason: Some("ydoc-lineage-absent"),
                conflicts_opened: 0,
                lineage_replacement: None,
                record_facts: _,
            }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let base = envelope(
        "prebase-mismatch-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-prebase-mismatch",
            "path": "notes/a.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha,
            "isBaseState": true
        }),
    );

    let outcome = apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("base applies and mismatched path drains");
    let ApplyOutcome {
        primary,
        refusals,
        sharing_declined,
    } = outcome;
    assert!(sharing_declined.is_empty());
    assert!(matches!(primary, ApplyDisposition::Applied(_)));
    assert_eq!(
        refusals,
        vec![ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "prebase-mismatch-peer".to_owned(),
            origin_seq: 0,
            op_kind: "ydoc.update".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "ydoc.update object already occupies another path".to_owned(),
            },
        }],
        "validating only after apply silently admits path B's bytes"
    );
    let key =
        dohc_engine_collab::DocKey::new("ws", "main", "object-prebase-mismatch").expect("doc key");
    let persisted = dohc_engine_collab::load_persisted(&engine, &key)
        .expect("load")
        .expect("lineage");
    let (deferred, updates, path_b): (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                    row.get(0)
                })?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| row.get(0))?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases \
                     WHERE workspace_id='ws' AND version_id='main' AND path='notes/b.md'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("drain state");
    let causal_text = persisted.doc.plaintext_string();
    assert!(
        causal_text.contains("base") && causal_text.contains("queued"),
        "the refused coordinate's clocks stay in the lineage without binding path B: {causal_text:?}"
    );
    assert_eq!(
        (deferred, updates, path_b),
        (0, 1, 0),
        "dropping refused CRDT bytes loses clocks needed by dependent descendants"
    );
}

#[test]
fn retried_identity_blocked_ydoc_base_does_not_drain_its_prebase_queue() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");

    let source = dohc_engine_collab::Ydoc::wire();
    source.plaintext_insert(0, "base");
    let base_sha = engine
        .put_binary_blob(&source.encode_full_state())
        .expect("base blob");
    let queued_sha = engine
        .put_binary_blob(&source.plaintext_insert(4, " queued"))
        .expect("queued blob");
    let queued = envelope(
        "refused-base-queued-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-refused-base",
            "path": "notes/refused-base.md",
            "contentKind": "plaintext",
            "updateBlobSha256": queued_sha,
            "lineageClaimId": base_sha.clone(),
            "isBaseState": false
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &queued,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(YdocApplyResult { deferred: true, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    seed_text_head(
        &mut engine,
        "object-refused-base-occupant",
        "notes/refused-base.md",
        "occupied",
    );
    let base = envelope(
        "refused-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-refused-base",
            "path": "notes/refused-base.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha,
            "isBaseState": true
        }),
    );

    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &base,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::RetryableState {
            reason: "ydoc.update path is occupied by another object"
        })
    ));
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &base,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::RetryableState {
            reason: "ydoc.update path is occupied by another object"
        })
    ));
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-refused-base").expect("key");
    let (queued_rows, update_rows): (i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_deferred_updates \
                     WHERE workspace_id='ws' AND version_id='main' \
                       AND object_id='object-refused-base'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_updates \
                     WHERE workspace_id='ws' AND version_id='main' \
                       AND object_id='object-refused-base'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("refused base state");
    assert!(
        dohc_engine_collab::read_marker(&engine, &key)
            .expect("marker read")
            .is_none()
    );
    assert_eq!(
        (queued_rows, update_rows),
        (1, 0),
        "ACKing the identity-blocked base lets replay drain against a lineage that never materialized"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "refused-base-peer").expect("retryable ack"),
        -1
    );
}

#[test]
fn live_lease_on_local_only_lineage_is_retryable_unacked_and_unjournaled() {
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws', 'object-local-lease', 1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("file object");
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-local-lease").expect("doc key");
    dohc_engine_collab::ensure_marker(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Plaintext,
        dohc_engine_collab::Regime::LocalOnly,
        &NoFaults,
        1_500,
    )
    .expect("local marker");
    let sha = engine
        .put_binary_blob(&dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "remote"))
        .expect("update blob");
    let update = envelope(
        "local-lease-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-local-lease",
            "path": "notes/local-lease.md",
            "contentKind": "plaintext",
            "updateBlobSha256": sha,
            "lineageClaimId": "1111111111111111111111111111111111111111111111111111111111111111",
            "isBaseState": false
        }),
    );

    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &update,
            &NoFaults,
            &AlwaysLive
        ),
        Err(SyncError::RetryableState {
            reason: "live lease on a non-replicated Y.Doc lineage"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "local-lease-peer").expect("ack"),
        -1
    );
    let journaled: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id='local-lease-peer'",
                [],
                |row| row.get(0),
            )
        })
        .expect("lease-race journal count");
    assert_eq!(
        journaled, 0,
        "treating the lease race as a terminal refusal journals the coordinate"
    );
}

#[test]
fn a_deferred_base_replaces_local_only_rows_and_recovers_their_content() {
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','object-deferred-promote',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("file object");
    let key =
        dohc_engine_collab::DocKey::new("ws", "main", "object-deferred-promote").expect("key");
    dohc_engine_collab::ensure_marker(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Plaintext,
        dohc_engine_collab::Regime::LocalOnly,
        &NoFaults,
        1_450,
    )
    .expect("local-only marker");
    let local_update = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "local-part ");
    dohc_engine_collab::record_local_update(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &local_update,
        dohc_engine_collab::LocalAppend::default(),
        &NoFaults,
        1_460,
        |_tx, _outcome, _update_sha| Ok(()),
    )
    .expect("local row");
    // Same witness pin as the pulled-base twin: the deferred drain's
    // replacement must clear the seed source with the rows it described.
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_docs SET seed_source_sha256='caffee00' \
                 WHERE workspace_id='ws' AND version_id='main' \
                   AND object_id='object-deferred-promote'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed source stamp");

    let base_doc = dohc_engine_collab::Ydoc::wire();
    base_doc.plaintext_insert(0, "base-part");
    let base_bytes = base_doc.encode_full_state();
    let base_sha = engine.put_binary_blob(&base_bytes).expect("base blob");
    let payload = json!({
        "versionId": "main",
        "objectId": "object-deferred-promote",
        "path": "notes/deferred-promoted.md",
        "contentKind": "plaintext",
        "updateBlobSha256": base_sha,
        "lineageClaimId": base_sha,
        "isBaseState": true
    });
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_log \
                 (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported,apply_disposition) \
                 VALUES ('ws','deferred-base-peer',0,'ydoc.update',?1,2_000,1,'applied')",
                [payload.to_string()],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO ydoc_deferred_updates \
                 (workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms,lineage_claim_id,relay_seq) \
                 VALUES ('ws','main','object-deferred-promote','deferred-base-peer',0,2_000,?1,10)",
                [base_sha],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("deferred base row");

    let drained = drain_deferred_ydoc_for_key(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .expect("drain deferred base");
    assert_eq!(drained.drained, 1);
    let replacement = drained
        .lineage_replacements
        .first()
        .expect("local-only lineage replacement");
    assert_eq!(replacement.recovered_paths.len(), 1);
    let (head, recovered, update_rows, seed_source): (String, String, i64, Option<String>) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
                         WHERE s.workspace_id='ws' AND s.version_id='main' \
                           AND s.object_id='object-deferred-promote'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
                         WHERE s.workspace_id='ws' AND s.version_id='main' AND s.path=?1",
                    [&replacement.recovered_paths[0]],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_updates \
                         WHERE workspace_id='ws' AND version_id='main' \
                           AND object_id='object-deferred-promote'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT seed_source_sha256 FROM ydoc_docs \
                         WHERE workspace_id='ws' AND version_id='main' \
                           AND object_id='object-deferred-promote'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("deferred replacement state");
    assert_eq!(head, "base-part");
    assert_eq!(recovered, "local-part ");
    assert_eq!(
        update_rows, 0,
        "the local lineage must not remain in the winner"
    );
    assert_eq!(
        seed_source, None,
        "the lineage replacement must clear the seed-source witness (#815)"
    );
}
