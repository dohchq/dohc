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
    let remote_update = remote.frontmatter_set("title", "Remote").unwrap();

    let mut cache = dohc_engine_collab::WriterDocCache::new();
    for index in 0..(dohc_engine_collab::limits::DEFAULT_COMPACTION_THRESHOLD - 1) {
        let filler = local
            .frontmatter_set("padding", &format!("{index}"))
            .unwrap();
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

/// A queued update whose bytes a drain applies and whose path its document
/// no longer has is refused. Its row holds the record facts its apply parked
/// there, so the row leaves only with the cleanup: a refusal that deleted it
/// at once would lose those facts when the drain stops before its cleanup,
/// as one that waits for validation does. After a stopped drain that its
/// caller abandons, as a cancelled one, and again after a restart, the drain
/// that removes the row reports its facts and its refusal once, and history
/// holds one row.
#[test]
fn an_applied_then_refused_update_reports_its_facts_once_after_its_drain_stopped() {
    for restart in [false, true] {
        an_applied_then_refused_update_after_a_stopped_drain(restart);
    }
}

fn an_applied_then_refused_update_after_a_stopped_drain(restart: bool) {
    const RECORD_ID: &str = "rec_dddddddddddddddddddddddddd";
    const OBJECT_ID: &str = "refused-record-object";
    const PATH: &str = "tasks/refused.md";

    let (_scratch, store_path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    seed_text_head(
        &mut engine,
        "refused-record-schema",
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
    let TxnOutcome::Committed(dohc_engine_collab::ClaimOutcome::Claimed {
        base_snapshot_sha: claim_id,
    }) = dohc_engine_collab::claim_base(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Richdoc,
        &base,
        &NoFaults,
        1_500,
    )
    .expect("claim replicated base")
    else {
        panic!("the base is claimed");
    };
    let remote = dohc_engine_collab::Ydoc::wire();
    remote.apply(&base).expect("remote sees base");
    let update_sha = engine
        .put_binary_blob(&remote.frontmatter_set("title", "Remote").unwrap())
        .expect("store remote update");
    let operation = envelope(
        "refused-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main", "objectId": OBJECT_ID, "path": PATH,
            "contentKind": "richdoc", "updateBlobSha256": update_sha,
            "lineageClaimId": claim_id, "isBaseState": false,
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
            ..
        })
    ));
    // The queued payload names a path its document does not have.
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE replication_log SET payload_json=json_set(payload_json,'$.path','tasks/elsewhere.md') \
                 WHERE origin_id='refused-peer'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("name another path");
    let state = |engine: &EngineStore| -> (i64, i64, i64) {
        engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT (SELECT COUNT(*) FROM collection_field_history WHERE record_id=?1), \
                       (SELECT COUNT(*) FROM ydoc_deferred_updates), \
                       (SELECT COUNT(*) FROM replication_pending_refusals \
                        WHERE origin_id='refused-peer')",
                    [RECORD_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            })
            .expect("state")
    };

    // The drain applies the bytes and refuses the row, then stops before
    // its cleanup.
    let (stopped, _cleanup) = crate::drain_deferred_ydoc_for_key_holding_cleanup(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .expect("stopped drain");
    assert_eq!(stopped.record_facts.len(), 1, "{stopped:?}");
    assert_eq!(stopped.refusals.len(), 1, "{stopped:?}");
    assert_eq!(
        state(&engine),
        (1, 1, 0),
        "the row keeps its facts, and nothing refused it yet"
    );

    if restart {
        drop(engine);
        engine = EngineStore::open(&store_path, 3_000).expect("reopen");
    }
    let drained = drain_deferred_ydoc_for_key(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .expect("drain after restart");
    assert_eq!(drained.record_facts, stopped.record_facts);
    assert_eq!(
        drained
            .refusals
            .iter()
            .map(|refusal| (refusal.origin_id.as_str(), refusal.origin_seq))
            .collect::<Vec<_>>(),
        [("refused-peer", 0)]
    );
    assert_eq!(state(&engine), (1, 0, 1));
    let idle = drain_deferred_ydoc_for_key(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .expect("idle drain");
    assert!(idle.record_facts.is_empty() && idle.refusals.is_empty());
}

/// A store holding the adopted Collection record `record_id` at `path`, its
/// document's base claimed, and a peer's title change from `origin` queued
/// behind a live session: the store's scratch tree and path, the store, the
/// document and its lineage.
fn queued_title_change(
    record_id: &str,
    object_id: &str,
    path: &str,
    origin: &str,
) -> (
    ScratchDir,
    std::path::PathBuf,
    EngineStore,
    dohc_engine_collab::DocKey,
    String,
) {
    let (scratch, store_path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    seed_text_head(
        &mut engine,
        &format!("{object_id}-schema"),
        "tasks/collection.yaml",
        "fields:\n  title:\n    type: text\n",
    );
    let markdown = format!("---\nid: {record_id}\ntitle: Original\n---\n\nBody\n");
    seed_text_head(&mut engine, object_id, path, &markdown);
    engine
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, "ws", "main")?;
            dohc_engine_domain::set_collection_adoption_state_in_tx(
                tx, "ws", "main", path, record_id, "adopted",
            )
        })
        .expect("bind adopted collection record");
    let key = dohc_engine_collab::DocKey::new("ws", "main", object_id).expect("key");
    let local = dohc_engine_collab::Ydoc::wire();
    local
        .rewrite_content_to_markdown(dohc_engine_collab::ContentKind::Richdoc, &markdown)
        .expect("seed rich document");
    let base = local.encode_full_state();
    let TxnOutcome::Committed(dohc_engine_collab::ClaimOutcome::Claimed {
        base_snapshot_sha: claim_id,
    }) = dohc_engine_collab::claim_base(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Richdoc,
        &base,
        &NoFaults,
        1_500,
    )
    .expect("claim replicated base")
    else {
        panic!("the base is claimed");
    };
    let remote = dohc_engine_collab::Ydoc::wire();
    remote.apply(&base).expect("remote sees base");
    let update_sha = engine
        .put_binary_blob(&remote.frontmatter_set("title", "Remote").unwrap())
        .expect("store remote update");
    let operation = envelope(
        origin,
        0,
        "ydoc.update",
        json!({
            "versionId": "main", "objectId": object_id, "path": path,
            "contentKind": "richdoc", "updateBlobSha256": update_sha,
            "lineageClaimId": claim_id, "isBaseState": false,
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
            ..
        })
    ));
    (scratch, store_path, engine, key, claim_id)
}

/// What the end-of-pass drain removes stays owed to its pass when a later
/// step, the settlement drain, waits and the request never resumes. The
/// transaction that removes the row writes its drain report, so an abandoned
/// request, or a restart, leaves it for the next request to claim, with its
/// file change. A request reports it until a cursor commit acknowledges it
/// under the token it was claimed with; a commit under an abandoned
/// request's token acknowledges nothing.
#[test]
fn a_released_drains_report_outlives_its_request_until_a_commit_acknowledges_it() {
    const RECORD_ID: &str = "rec_jjjjjjjjjjjjjjjjjjjjjjjjjj";
    const OBJECT_ID: &str = "reported-record-object";
    const PATH: &str = "tasks/reported.md";

    fn commit(engine: &mut EngineStore, token: &str) {
        engine
            .write_with(&NoFaults, |tx| {
                crate::cursor::release_settlement_report_in_tx(tx, "ws", token)
            })
            .expect("commit the cursor");
    }

    for restart in [false, true] {
        let (_scratch, store_path, mut engine, _key, _) =
            queued_title_change(RECORD_ID, OBJECT_ID, PATH, "reported-peer");
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute_batch(&format!(
                    "INSERT OR IGNORE INTO sync_identity(workspace_id,origin_id,replication_epoch, \
                       stream_identity,created_at_ms) VALUES ('ws','service-host:ws','epoch','stream',0); \
                     INSERT INTO hosted_replicas(workspace_id,scope_generation,created_at_ms, \
                       main_cursor,last_outbound_seq) VALUES ('ws',1,0,1,-1); \
                     INSERT INTO hosted_documents(workspace_id,object_id,path,state, \
                       held_reason,scope_generation) VALUES ('ws','{OBJECT_ID}','{PATH}', \
                       'held','hosted-backfill-work-waiting',1);"
                ))
                .map_err(SyncError::persist)
            })
            .expect("hold the document for its queued work");
        let state = |engine: &EngineStore| -> (i64, i64, i64) {
            engine
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT (SELECT COUNT(*) FROM collection_field_history WHERE record_id=?1), \
                           (SELECT COUNT(*) FROM ydoc_deferred_updates), \
                           (SELECT COUNT(*) FROM ydoc_drain_reports)",
                        [RECORD_ID],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                })
                .expect("state")
        };

        let released = crate::ydoc_apply::drain_released_holds(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &BTreeMap::new(),
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("drain the held document");
        assert!(released.waiting.is_none() && released.refusals.is_empty());
        assert!(released.changes.is_empty(), "its change is in the report");
        assert_eq!(
            state(&engine),
            (1, 0, 1),
            "restart={restart}: the row went, its report stays"
        );

        // The request is abandoned at its settlement drain's wait, or the
        // store restarts; the next request claims the report.
        if restart {
            drop(engine);
            engine = EngineStore::open(&store_path, 3_000).expect("reopen");
        }
        let mut first = None;
        let claimed = crate::drain_report::claim(&mut engine, "ws", &mut first, &NoFaults)
            .expect("claim the drain reports");
        assert_eq!(claimed.record_facts.len(), 1, "{claimed:?}");
        assert_eq!(
            claimed
                .extras
                .changes
                .iter()
                .map(|change| (change.path.as_str(), change.operation))
                .collect::<Vec<_>>(),
            [(PATH, "write")],
            "{claimed:?}"
        );
        let first = first.expect("a report token");

        // That request is abandoned before its commit too: the next one
        // claims the report again under a token of its own, once.
        let mut second = None;
        let again = crate::drain_report::claim(&mut engine, "ws", &mut second, &NoFaults)
            .expect("claim again");
        assert_eq!(again.record_facts, claimed.record_facts);
        let second = second.expect("a report token");
        assert_ne!(first, second);
        let mut owned = Some(second.clone());
        assert!(
            crate::drain_report::claim(&mut engine, "ws", &mut owned, &NoFaults)
                .expect("claim what it owns")
                .record_facts
                .is_empty()
        );

        commit(&mut engine, &first);
        assert_eq!(
            state(&engine),
            (1, 0, 1),
            "restart={restart}: an abandoned token acknowledges nothing"
        );
        commit(&mut engine, &second);
        assert_eq!(state(&engine), (1, 0, 0), "restart={restart}: acknowledged");
        assert!(
            crate::drain_report::claim(&mut engine, "ws", &mut None, &NoFaults)
                .expect("claim nothing")
                .record_facts
                .is_empty()
        );
    }
}

/// A drain applies a queued field change and stops before its cleanup, as
/// one that then waits does; a device binding then appears, so the next
/// drain finds the row a live edit no session admitted. That refusal, its
/// blob and its hold wait for the cleanup like any other, so a drain that
/// stops again keeps the row and the facts parked on it. Whether the request
/// is then abandoned or the store restarts, the drain that completes reports
/// the facts and the refusal once.
#[test]
fn a_live_refusal_keeps_its_rows_facts_until_its_cleanup() {
    for restart in [false, true] {
        a_live_refusal_after_a_stopped_drain(restart);
    }
}

fn a_live_refusal_after_a_stopped_drain(restart: bool) {
    const RECORD_ID: &str = "rec_hhhhhhhhhhhhhhhhhhhhhhhhhh";
    const OBJECT_ID: &str = "live-refused-record-object";
    const PATH: &str = "tasks/live-refused.md";

    let (_scratch, store_path, mut engine, key, claim_id) =
        queued_title_change(RECORD_ID, OBJECT_ID, PATH, "live-peer");
    let state = |engine: &EngineStore| -> (i64, i64, i64, i64) {
        engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT (SELECT COUNT(*) FROM collection_field_history WHERE record_id=?1), \
                       (SELECT COUNT(*) FROM ydoc_deferred_updates WHERE record_facts_json IS NOT NULL), \
                       (SELECT COUNT(*) FROM replication_pending_refusals WHERE origin_id='live-peer'), \
                       (SELECT COUNT(*) FROM replication_refused_ydoc_blobs WHERE origin_id='live-peer')",
                    [RECORD_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
            })
            .expect("state")
    };
    let stopped_drain = |engine: &mut EngineStore| {
        let (stopped, _cleanup) = crate::drain_deferred_ydoc_for_key_holding_cleanup(
            engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &NoFaults,
        )
        .expect("stopped drain");
        stopped
    };

    let applied = stopped_drain(&mut engine);
    assert_eq!(applied.record_facts.len(), 1, "{applied:?}");
    assert!(applied.refusals.is_empty(), "{applied:?}");
    assert_eq!(state(&engine), (1, 1, 0, 0), "the row keeps its facts");

    // A device binding of the document appears before the next drain.
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO live_device_application_bindings VALUES \
                 ('relay','ws','main',?1,?2,?3,'[]',0,'host',1,'instance','connection',1,NULL)",
                params![OBJECT_ID, claim_id, PATH],
            )
            .map_err(SyncError::persist)
        })
        .expect("bind a device");
    let refused = stopped_drain(&mut engine);
    assert_eq!(refused.record_facts, applied.record_facts, "{refused:?}");
    assert_eq!(
        refused
            .refusals
            .iter()
            .map(|refusal| (refusal.origin_id.as_str(), refusal.reason.message()))
            .collect::<Vec<_>>(),
        [("live-peer", crate::ydoc_apply::LIVE_UNADMITTED_UPDATE)]
    );
    assert_eq!(
        state(&engine),
        (1, 1, 0, 0),
        "the row keeps its facts, and nothing refused it yet"
    );

    if restart {
        drop(engine);
        engine = EngineStore::open(&store_path, 3_000).expect("reopen");
    }
    let drained = drain_deferred_ydoc_for_key(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .expect("drain");
    assert_eq!(drained.record_facts, applied.record_facts);
    assert_eq!(drained.refusals, refused.refusals);
    assert_eq!(state(&engine), (1, 0, 1, 1), "refused once, its blob kept");
    let idle = drain_deferred_ydoc_for_key(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .expect("idle drain");
    assert!(idle.record_facts.is_empty() && idle.refusals.is_empty());
}

#[test]
fn resolution_fold_refuses_while_deferred_updates_are_parked() {
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
            (0, 2, 0),
            "the refused clock and its dependent descendant must both enter the causal lineage"
        );
        let disposition:String=engine.read_with(|conn|conn.query_row("SELECT apply_disposition FROM replication_log WHERE workspace_id='ws' AND origin_id=?1 AND origin_seq=0",[&queued_origin],|r|r.get(0))).unwrap();
        assert_eq!(
            disposition, "refused",
            "lineage cleanup must not undo the durable refusal"
        );
    }
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
    let (queued, applied_updates, refusal_rows): (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                    row.get(0)
                })?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| row.get(0))?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_refusals \
                     WHERE workspace_id='ws' AND origin_id='b-invalid-collision' AND origin_seq=0 \
                       AND reason_message='parked ydoc.update could not be applied'",
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
        "the rejected update never entered the lineage, so its refusal must survive"
    );
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
    assert_durable_update_refusals_after_dismissal(&mut engine);
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

fn assert_durable_update_refusals_after_dismissal(engine: &mut EngineStore) {
    let notices = crate::list_refusal_notices(engine, "ws").unwrap();
    assert!(!notices.is_empty());
    for notice in notices {
        crate::dismiss_refusal_notice(
            engine,
            "ws",
            &notice.notice_id,
            &notice.refusal_coordinates,
            &NoFaults,
        )
        .unwrap();
        for coordinate in notice.refusal_coordinates {
            let crate::RefusalCoordinate::Replication {
                origin_id,
                origin_seq,
            } = coordinate
            else {
                panic!("expected a replication refusal coordinate");
            };
            let disposition: String = engine.read_with(|conn| conn.query_row(
                "SELECT apply_disposition FROM replication_log WHERE workspace_id='ws' AND origin_id=?1 AND origin_seq=?2",
                rusqlite::params![origin_id, origin_seq], |row| row.get(0))).unwrap();
            assert_eq!(
                disposition, "refused",
                "refusal must survive notice dismissal"
            );
        }
    }
}

#[test]
fn parked_inactive_invalid_update_keeps_refused_disposition_after_dismissal() {
    assert_parked_inactive_refusal(true, 0);
}

fn assert_parked_inactive_refusal(collision: bool, waiting: u8) {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let source = dohc_engine_collab::Ydoc::wire();
    source.plaintext_insert(0, "a");
    let old_bytes = source.encode_full_state();
    let old_sha = engine.put_binary_blob(&old_bytes).unwrap();
    let base = envelope(
        "base-peer",
        0,
        "ydoc.update",
        json!({"versionId":"main","objectId":"inactive-refusal","path":"inactive.md","contentKind":"plaintext","updateBlobSha256":old_sha,"lineageClaimId":old_sha,"isBaseState":true}),
    );
    apply_ydoc_envelope(
        &mut engine,
        &mut Default::default(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    let key = dohc_engine_collab::DocKey::new("ws", "main", "inactive-refusal").unwrap();
    let vector_sha = dohc_engine_storage::hex_sha256(&source.encode_state_vector());
    engine
        .write_with(&NoFaults, |tx| {
            dohc_engine_collab::archive_active_lineage_in_tx(
                tx,
                &key,
                &old_sha,
                &vector_sha,
                Some(&dohc_engine_storage::hex_sha256(b"a")),
                2,
            )
        })
        .unwrap();
    let replacement = dohc_engine_collab::Ydoc::wire();
    replacement.plaintext_insert(0, "a");
    let replacement_sha = engine
        .put_binary_blob(&replacement.encode_full_state())
        .unwrap();
    let mut replacement_base = base.clone();
    replacement_base.origin_id = "replacement-peer".into();
    replacement_base.payload["updateBlobSha256"] = json!(replacement_sha);
    replacement_base.payload["lineageClaimId"] = json!(replacement_sha);
    apply_ydoc_envelope(
        &mut engine,
        &mut Default::default(),
        &replacement_base,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    let bytes = if collision {
        let marker = b"plainText";
        let content_at = old_bytes
            .windows(marker.len())
            .position(|bytes| bytes == marker)
            .unwrap()
            + marker.len()
            + 1;
        let mut bytes = old_bytes.clone();
        assert_eq!(bytes[content_at], b'a');
        bytes[content_at] = b'b';
        bytes
    } else {
        source.plaintext_insert(0, &"x".repeat(MAX_TEXT_BYTES))
    };
    let update_sha = engine.put_binary_blob(&bytes).unwrap();
    let mut delta = envelope(
        "late-peer",
        0,
        "ydoc.update",
        json!({"versionId":"main","objectId":"inactive-refusal","path":"inactive.md","contentKind":"plaintext","updateBlobSha256":update_sha,"lineageClaimId":old_sha,"isBaseState":false}),
    );
    delta.relay_seq = Some(110);
    let parked = apply_ydoc_envelope(
        &mut engine,
        &mut Default::default(),
        &delta,
        &NoFaults,
        &crate::ydoc_apply::AlwaysLive,
    )
    .unwrap();
    assert!(matches!(
        parked.primary,
        ApplyDisposition::Applied(YdocApplyResult { deferred: true, .. })
    ));
    if waiting != 0 {
        if waiting == 2 {
            let current_delta = replacement.plaintext_insert(1, " tail");
            let sha = engine.put_binary_blob(&current_delta).unwrap();
            let mut active = delta.clone();
            active.origin_id = "current-peer".into();
            active.relay_seq = Some(111);
            active.payload["lineageClaimId"] = json!(replacement_sha);
            active.payload["updateBlobSha256"] = json!(sha);
            apply_ydoc_envelope(
                &mut engine,
                &mut Default::default(),
                &active,
                &NoFaults,
                &crate::ydoc_apply::AlwaysLive,
            )
            .unwrap();
        }
        engine.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET settle_prior_update_seq=0,settle_seq=(SELECT m.moment_order FROM moments m JOIN snapshots s ON s.latest_moment_id=m.moment_id WHERE s.object_id='inactive-refusal')", []).unwrap();
            tx.execute("INSERT INTO materialization_jobs(job_id,target_path,content_sha256,preimage_present,target_generation,created_at_ms,workspace_id) SELECT 'ydoc-mat_'||latest_moment_id,path,blob_sha256,1,999,0,workspace_id FROM snapshots WHERE object_id='inactive-refusal' ON CONFLICT(job_id) DO UPDATE SET status='pending',completed_at_ms=NULL", []).unwrap();
            Ok::<_,SyncError>(())
        }).unwrap();
        // A drain that waits for its projection decides nothing, its
        // archived lineage's update included. That update stays queued, and
        // the drain that applies it to the archive reports its refusal once.
        let (drained, _cleanup) = crate::ydoc_apply::drain_ended_session_holding_cleanup(
            &mut engine,
            &mut Default::default(),
            &key,
            &NoLiveLeases,
            &NoFaults,
        )
        .unwrap();
        assert_eq!((drained.refusals.len(), drained.drained), (0, 0));
        let queued: bool = engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM ydoc_deferred_updates WHERE origin_id='late-peer')",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert!(queued, "the archived lineage's update waits");
        let tails =
            dohc_engine_collab::live_update_application::ReleasedTails::default().bound_to(&engine);
        let inactive = crate::ydoc_apply::drain_inactive_ydoc_updates(
            &mut engine,
            crate::ydoc_apply::InactiveScope::Document(&key, &[]),
            &tails,
            &mut Vec::new(),
            crate::ydoc_apply::DrainReporting::Returned,
            &NoFaults,
        )
        .unwrap();
        assert_eq!(inactive.refusals.len(), 1, "{:?}", inactive.refusals);
        // The drain took the archived lineage's last queued row and left its
        // document no hold, so a hold the pass reported for that lineage is
        // cleared in the same pass.
        let freed = std::collections::BTreeSet::from([old_sha.clone()]);
        assert_eq!(inactive.cleared.get("inactive-refusal"), Some(&freed));
        assert_eq!(inactive.cleared.len(), 1);
        assert!(inactive.holds.is_empty());
        return;
    }
    let drained =
        crate::drain_deferred_ydoc_for_key(&mut engine, &mut Default::default(), &key, &NoFaults)
            .unwrap();
    assert_eq!(
        drained.refusals.len(),
        1,
        "collision={collision}: {drained:?}"
    );
    assert_durable_update_refusals_after_dismissal(&mut engine);
}

#[test]
fn ydoc_drain_waiting_nonempty_queue_leaves_inactive_update_queued() {
    assert_parked_inactive_refusal(true, 2);
}

/// A drain report this build cannot read fails the claim that meets it once,
/// and is gone after it; the reports beside it stay owed and the next claim
/// reports them.
#[test]
fn an_unreadable_drain_report_fails_one_claim_and_the_rest_stay_owed() {
    let (_scratch, _path, mut engine) = open_store();
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "INSERT INTO ydoc_drain_reports(workspace_id,origin_id,origin_seq,report_json) \
                   VALUES ('ws','peer',1,'{\"changes\":[{\"versionId\":\"main\",\"path\":\"a.md\", \
                     \"operation\":\"rename\",\"contentKind\":\"text\"}]}'); \
                 INSERT INTO ydoc_drain_reports(workspace_id,origin_id,origin_seq,report_json) \
                   VALUES ('ws','peer',2,'{\"conflictsOpened\":1}');",
            )
            .map_err(SyncError::persist)
        })
        .expect("store the reports");
    let mut token = None;
    assert!(matches!(
        crate::drain_report::claim(&mut engine, "ws", &mut token, &NoFaults),
        Err(SyncError::Storage(_))
    ));
    assert_eq!(engine.table_row_count("ydoc_drain_reports").unwrap(), 1);
    let claimed = crate::drain_report::claim(&mut engine, "ws", &mut None, &NoFaults)
        .expect("the next claim reports the rest");
    assert_eq!(claimed.extras.conflicts_opened, 1);
}

/// The refusals of `origin` in `refusals`, as coordinate and reason.
fn refusals_of(refusals: &[crate::ReplicationRefusal], origin: &str) -> Vec<(i64, String)> {
    refusals
        .iter()
        .filter(|refusal| refusal.origin_id == origin)
        .map(|refusal| (refusal.origin_seq, refusal.reason.message().to_owned()))
        .collect()
}

/// A queued row whose content kind the head refuses applies its bytes first,
/// and a later row of the same lineage projects the head, so the cleanup
/// clears the lineage's notices, the refusal it just persisted among them.
/// Its drain report keeps that refusal, so a request abandoned at a later
/// wait, or a restart, still reports it, once, until a commit acknowledges
/// it.
#[test]
fn a_refusal_its_projection_clears_stays_in_the_drain_report() {
    const RECORD_ID: &str = "rec_kkkkkkkkkkkkkkkkkkkkkkkkkk";
    const OBJECT_ID: &str = "kind-refused-record-object";
    const PATH: &str = "tasks/kind-refused.md";

    for restart in [false, true] {
        let (_scratch, store_path, mut engine, key, claim_id) =
            queued_title_change(RECORD_ID, OBJECT_ID, PATH, "kind-peer");
        let base = dohc_engine_collab::load_persisted(&engine, &key)
            .expect("load head")
            .expect("head")
            .doc
            .encode_full_state();
        let remote = dohc_engine_collab::Ydoc::wire();
        remote.apply(&base).expect("remote sees the base");
        let paragraph = engine
            .put_binary_blob(&remote.richdoc_append_paragraph("Later."))
            .expect("store the paragraph");
        let later = envelope(
            "kind-later",
            0,
            "ydoc.update",
            json!({
                "versionId": "main", "objectId": OBJECT_ID, "path": PATH,
                "contentKind": "richdoc", "updateBlobSha256": paragraph,
                "lineageClaimId": claim_id, "isBaseState": false,
                "actorOriginId": "remote-author"
            }),
        );
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &later,
            &NoFaults,
            &AlwaysLive,
        )
        .expect("queue the paragraph");
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE replication_log \
                     SET payload_json=json_set(payload_json,'$.contentKind','plaintext') \
                     WHERE origin_id='kind-peer'",
                    [],
                )
                .map_err(SyncError::persist)?;
                tx.execute_batch(&format!(
                    "INSERT OR IGNORE INTO sync_identity(workspace_id,origin_id,replication_epoch, \
                       stream_identity,created_at_ms) VALUES ('ws','service-host:ws','epoch','stream',0); \
                     INSERT INTO hosted_replicas(workspace_id,scope_generation,created_at_ms, \
                       main_cursor,last_outbound_seq) VALUES ('ws',1,0,1,-1); \
                     INSERT INTO hosted_documents(workspace_id,object_id,path,state, \
                       held_reason,scope_generation) VALUES ('ws','{OBJECT_ID}','{PATH}', \
                       'held','hosted-backfill-work-waiting',1);"
                ))
                .map_err(SyncError::persist)
            })
            .expect("name another content kind, and hold the document");
        let pending = |engine: &EngineStore| -> i64 {
            engine
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM replication_pending_refusals \
                         WHERE origin_id='kind-peer'",
                        [],
                        |row| row.get(0),
                    )
                })
                .expect("pending refusals")
        };

        let released = crate::ydoc_apply::drain_released_holds(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &BTreeMap::new(),
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("drain the held document");
        assert!(released.waiting.is_none());
        let owed = refusals_of(&released.refusals, "kind-peer");
        assert_eq!(owed.len(), 1, "restart={restart}: {:?}", released.refusals);
        assert_eq!(
            pending(&engine),
            0,
            "restart={restart}: the projection cleared its notice"
        );

        // The request is abandoned at a later wait, or the store restarts.
        if restart {
            drop(engine);
            engine = EngineStore::open(&store_path, 3_000).expect("reopen");
        }
        let mut first = None;
        let claimed = crate::drain_report::claim(&mut engine, "ws", &mut first, &NoFaults)
            .expect("claim the drain reports");
        assert_eq!(
            refusals_of(&claimed.extras.refusals, "kind-peer"),
            owed,
            "restart={restart}: the report keeps the refusal"
        );
        // That request is abandoned too: the next one reports it once more.
        let mut second = None;
        let again = crate::drain_report::claim(&mut engine, "ws", &mut second, &NoFaults)
            .expect("claim again");
        assert_eq!(refusals_of(&again.extras.refusals, "kind-peer"), owed);
        engine
            .write_with(&NoFaults, |tx| {
                crate::cursor::release_settlement_report_in_tx(
                    tx,
                    "ws",
                    second.as_deref().expect("a report token"),
                )
            })
            .expect("commit the cursor");
        assert!(
            crate::drain_report::claim(&mut engine, "ws", &mut None, &NoFaults)
                .expect("claim nothing")
                .extras
                .refusals
                .is_empty(),
            "restart={restart}: acknowledged"
        );
    }
}
