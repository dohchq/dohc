use super::*;

/// The store's text cap answers the sync path with a refusal, not an abort.
///
/// The gap between the caps makes it reachable: `project` allows
/// `MAX_PROJECTION_BYTES` (16 MiB) and an update may reach
/// `MAX_YDOC_UPDATE_BYTES` (20 MiB), so a doc whose Markdown lands between
/// `MAX_TEXT_BYTES` (10 MiB) and 16 MiB projects fine and is refused only by
/// the store's own write.
///
/// The error CLASS decides durability, not just the wording: `refusal_reason`
/// recognizes `InvalidInput` alone, so only that class is journaled and ACKed.
/// Any other class returns `Err`, the coordinate is never ACKed, and the relay
/// redelivers it forever with every later operation stuck behind it.
///
#[test]
fn ydoc_projection_over_the_text_cap_is_acked_as_a_refusal() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");

    let source = dohc_engine_collab::Ydoc::wire();
    source.plaintext_insert(0, "seed");
    let base = source.encode_full_state();
    assert!(
        base.len() < dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES,
        "the premise is a doc UNDER the update cap, at {} bytes",
        base.len()
    );
    let base_sha = engine.put_binary_blob(&base).expect("base blob");
    let base_op = envelope(
        "over-cap-projection-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-over-cap-projection",
            "path": "notes/over-cap-projection.md",
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
            &base_op,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let delta = source.plaintext_insert(4, &"a".repeat(MAX_TEXT_BYTES));
    assert!(
        delta.len() < dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES,
        "the premise is an update UNDER the update cap, at {} bytes",
        delta.len()
    );
    let delta_sha = engine.put_binary_blob(&delta).expect("delta blob");
    let over_cap = envelope(
        "over-cap-projection-peer",
        1,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-over-cap-projection",
            "path": "notes/over-cap-projection.md",
            "contentKind": "plaintext",
            "updateBlobSha256": delta_sha,
            "lineageClaimId": base_sha,
            "isBaseState": false
        }),
    );

    let refusal = apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &over_cap,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("oversized projection is an acknowledged refusal");
    let expected_reason = format!(
        "plaintext projection exceeds MAX_TEXT_BYTES: limit {MAX_TEXT_BYTES} bytes, observed at least {} bytes",
        MAX_TEXT_BYTES + 4
    );
    assert!(matches!(
        refusal,
        ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { ref reason },
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == &expected_reason)
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "over-cap-projection-peer").expect("ack"),
        1,
        "an unACKed coordinate is redelivered forever"
    );
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-over-cap-projection")
        .expect("doc key");
    let projected = dohc_engine_collab::load_persisted(&engine, &key)
        .expect("load retained Y.Doc")
        .expect("persisted Y.Doc")
        .doc
        .project(dohc_engine_collab::ContentKind::Plaintext)
        .expect("the Y.Doc stays under the projection cap");
    assert_eq!(
        projected.content.len(),
        MAX_TEXT_BYTES + 4,
        "the refused incremental mutation remains canonical"
    );
    let (head_text, persisted_reason): (String, String) = engine
        .read_with(|conn| {
            let head_text = conn
                .query_row(
                    "SELECT b.text FROM path_aliases a \
                 JOIN snapshots s ON s.workspace_id = a.workspace_id AND s.object_id = a.object_id \
                 JOIN blobs b ON b.sha256 = s.blob_sha256 \
                 WHERE a.workspace_id = 'ws' AND a.version_id = 'main' \
                   AND a.path = 'notes/over-cap-projection.md'",
                    [],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)?;
            let persisted_reason = conn
                .query_row(
                    "SELECT reason_message FROM replication_pending_refusals \
                 WHERE workspace_id = 'ws' AND origin_id = 'over-cap-projection-peer' \
                   AND origin_seq = 1",
                    [],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)?;
            Ok::<_, SyncError>((head_text, persisted_reason))
        })
        .expect("head and persisted refusal");
    assert_eq!(head_text, "seed", "the oversized artifact is not written");
    assert_eq!(persisted_reason, expected_reason);
}

#[test]
fn captured_disk_occupant_relocates_the_recovery_exactly_once() {
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    seed_identity(&mut engine);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO sync_relay_cursors
                 (workspace_id,cursor,replication_epoch,stream_identity)
                 VALUES ('ws','0','epoch-1','stream-1')",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("relay contact");
    seed_text_head(
        &mut engine,
        "object-disk-occupant-recovery",
        "notes/disk-occupant.md",
        "external editor draft",
    );
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-disk-occupant-recovery")
        .expect("doc key");
    let loser = dohc_engine_collab::Ydoc::wire();
    loser.plaintext_insert(0, "losing local draft");
    let loser_bytes = loser.encode_full_state();
    let loser_claim = dohc_engine_storage::hex_sha256(&loser_bytes);
    assert!(matches!(
        dohc_engine_collab::claim_base_at_relay(
            &mut engine,
            &key,
            dohc_engine_collab::ContentKind::Plaintext,
            &loser_bytes,
            &dohc_engine_collab::BaseRelayCoordinate::new("loser", 0, 20)
                .expect("loser coordinate"),
            &NoFaults,
            1_100,
        ),
        Ok(TxnOutcome::Committed(
            dohc_engine_collab::ClaimOutcome::Claimed { .. }
        ))
    ));
    let winner = dohc_engine_collab::Ydoc::wire();
    winner.plaintext_insert(0, "winning remote lineage");
    let winner_bytes = winner.encode_full_state();
    let winner_claim = engine.put_binary_blob(&winner_bytes).expect("winner blob");
    let mut winner_base = envelope(
        "disk-occupant-winner",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-disk-occupant-recovery",
            "path": "notes/disk-occupant.md",
            "contentKind": "plaintext",
            "updateBlobSha256": winner_claim,
            "lineageClaimId": winner_claim,
            "isBaseState": true
        }),
    );
    winner_base.relay_seq = Some(10);
    let applied = apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &winner_base,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("winning base");
    assert!(matches!(
        applied,
        ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let recovery_projection = dohc_engine_storage::hex_sha256(b"losing local draft");
    let first_recovery_path = format!(
        "notes/disk-occupant (recovered {} {recovery_projection}).md",
        &loser_claim[..8]
    );
    let (first_recovery_object, first_recovery_moment): (String, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT recovery_object_id,recovery_moment_id
                   FROM ydoc_recovery_decisions
                  WHERE workspace_id='ws' AND origin_id='disk-occupant-winner'
                    AND origin_seq=0",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("first recovery decision");

    // Model the serialized disk boundary: the absent-preimage write found an
    // unexpected file and capture then made those disk bytes authoritative.
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE materialization_jobs SET status='conflict'
                  WHERE job_id='sync-mat_' || ?1",
                [&first_recovery_moment],
            )
            .map_err(SyncError::persist)?;
            dohc_engine_domain::capture_ingest_in_tx(
                tx,
                &dohc_engine_domain::CaptureIngest {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    path: first_recovery_path.clone(),
                    text: "unexpected disk occupant".to_owned(),
                    metadata_origin: dohc_engine_domain::store::CAPTURE_ORIGIN.to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2_100,
                    request_id: None,
                    claim_foreign_head: true,
                },
            )
            .map_err(|error| SyncError::corrupt(std::io::Error::other(error.to_string())))?;
            Ok::<_, SyncError>(())
        })
        .expect("capture unexpected disk occupant");

    let after_commit = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
    assert!(matches!(
        repair_conflicted_ydoc_recoveries(&mut engine, "ws", after_commit.as_ref()),
        Err(SyncError::FaultCrash)
    ));
    let repaired = repair_conflicted_ydoc_recoveries(&mut engine, "ws", &NoFaults)
        .expect("resume the committed relocation");
    let second_recovery_path = format!(
        "notes/disk-occupant (recovered {} {recovery_projection} 2).md",
        &loser_claim[..8]
    );
    assert_eq!(repaired.len(), 1);
    assert_eq!(repaired[0].path, second_recovery_path);
    let current_recovery_moment: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT recovery_moment_id FROM ydoc_recovery_decisions
                  WHERE workspace_id='ws' AND origin_id='disk-occupant-winner'
                    AND origin_seq=0",
                [],
                |row| row.get(0),
            )
        })
        .expect("current recovery moment");
    assert_eq!(
        repaired[0].materialization_job_id,
        format!("sync-mat_{current_recovery_moment}")
    );
    let state: (String, String, String, String, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256
                      WHERE s.workspace_id='ws' AND s.version_id='main' AND s.path=?1",
                    [&first_recovery_path],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256
                      WHERE s.workspace_id='ws' AND s.version_id='main' AND s.path=?1",
                    [&second_recovery_path],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT recovered_path FROM ydoc_recovery_decisions
                      WHERE workspace_id='ws' AND origin_id='disk-occupant-winner'
                        AND origin_seq=0",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT status FROM materialization_jobs
                      WHERE job_id='sync-mat_' || (
                        SELECT recovery_moment_id FROM ydoc_recovery_decisions
                         WHERE workspace_id='ws' AND origin_id='disk-occupant-winner'
                           AND origin_seq=0
                      )",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM moments
                      WHERE workspace_id='ws' AND object_id=?1",
                    [&first_recovery_object],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("relocated recovery state");
    assert_eq!(
        state,
        (
            "unexpected disk occupant".to_owned(),
            "losing local draft".to_owned(),
            second_recovery_path.clone(),
            "pending".to_owned(),
            2,
        )
    );
    let replay_changes =
        crate::ydoc_apply::redelivered_materialization_changes(&engine, &winner_base)
            .expect("redelivered relocation ledger");
    assert!(
        replay_changes
            .iter()
            .any(|change| change.path == second_recovery_path)
    );
    assert!(
        replay_changes
            .iter()
            .all(|change| change.path != first_recovery_path)
    );
}

#[test]
fn first_inbound_base_over_divergent_plain_head_opens_conflict_not_overwrite() {
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    let local_write = engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws','object-div',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            dohc_engine_domain::write_projected_text_in_tx(
                tx,
                &dohc_engine_domain::WriteText {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "object-div".to_owned(),
                    path: "notes/plan.md".to_owned(),
                    text: "local truth".to_owned(),
                    moment_id: "m-local-1".to_owned(),
                    metadata_origin: "local-file".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1_500,
                    request_id: None,
                },
            )
            .map_err(|error| SyncError::corrupt(std::io::Error::other(error.to_string())))
        })
        .expect("local head");
    assert!(matches!(
        local_write,
        dohc_engine_storage::TxnOutcome::Committed(_)
    ));
    let local_sha = dohc_engine_storage::hex_sha256("local truth".as_bytes());

    let base_doc = dohc_engine_collab::Ydoc::wire();
    base_doc.plaintext_insert(0, "remote truth");
    let base_bytes = base_doc.encode_full_state();
    let base_sha = engine.put_binary_blob(&base_bytes).expect("base blob");
    let base_op = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-div",
            "path": "notes/plan.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha.clone(),
            "isBaseState": true
        }),
    );
    let outcome = apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base_op,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("base applies");
    assert_eq!(
        outcome,
        ApplyOutcome::new(ApplyDisposition::Applied(YdocApplyResult {
            deferred: false,
            reason: Some("ydoc-base-conflict"),
            conflicts_opened: 1,
            lineage_replacement: None,
            record_facts: Vec::new(),
        }))
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "peer").expect("ack"),
        0,
        "the divergent base still acks — the lineage must keep advancing"
    );

    let head_text: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256 = s.blob_sha256 \
                 WHERE s.workspace_id='ws' AND s.version_id='main' AND s.object_id='object-div'",
                [],
                |r| r.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("head");
    assert_eq!(
        head_text, "local truth",
        "the base must not clobber the head"
    );

    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-div").expect("key");
    let marker = dohc_engine_collab::read_marker(&engine, &key)
        .expect("marker read")
        .expect("marker");
    assert_eq!(marker.regime, dohc_engine_collab::Regime::Replicated);
    assert_eq!(
        marker.lineage_claim_status,
        dohc_engine_collab::LineageClaimStatus::Exact,
        "the base claim still lands"
    );

    let remote_sha = dohc_engine_storage::hex_sha256("remote truth".as_bytes());
    let (status, origin, current_blob, incoming_blob): (String, String, String, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT status, metadata_origin, current_blob_sha256, incoming_blob_sha256 \
                 FROM conflicts WHERE workspace_id='ws'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("conflict row");
    assert_eq!((status.as_str(), origin.as_str()), ("open", "sync"));
    assert_eq!(current_blob, local_sha);
    assert_eq!(incoming_blob, remote_sha);
    let incoming_text: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT text FROM blobs WHERE sha256=?1",
                [&remote_sha],
                |r| r.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("incoming blob text");
    assert_eq!(incoming_text, "remote truth");

    // A later delta must not sneak past the open conflict either: the head
    // stays, and the conflict's incoming side coalesces to the freshest
    // remote projection. Mutation check: drop the open-conflict guard in
    // `project_and_write_in_tx` — the head assertion below fails.
    let delta = base_doc.plaintext_insert(0, "more ");
    let delta_sha = engine.put_binary_blob(&delta).expect("delta blob");
    let delta_op = envelope(
        "peer",
        1,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-div",
            "path": "notes/plan.md",
            "contentKind": "plaintext",
            "updateBlobSha256": delta_sha,
            "lineageClaimId": base_sha,
            "isBaseState": false
        }),
    );
    apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &delta_op,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("delta applies");
    let head_after_delta: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256 = s.blob_sha256 \
                 WHERE s.workspace_id='ws' AND s.version_id='main' AND s.object_id='object-div'",
                [],
                |r| r.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("head after delta");
    assert_eq!(head_after_delta, "local truth");
    let merged_sha = dohc_engine_storage::hex_sha256("more remote truth".as_bytes());
    let (conflict_count, incoming_after): (i64, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*), MAX(incoming_blob_sha256) FROM conflicts \
                 WHERE workspace_id='ws' AND status='open'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("coalesced conflict");
    assert_eq!(
        conflict_count, 1,
        "the delta coalesces, it opens nothing new"
    );
    assert_eq!(incoming_after, merged_sha);
}

#[test]
fn a_base_over_an_unmerged_head_conflicts_even_when_the_lineage_holds_rows() {
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws','object-crashed',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("scaffolding");
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-crashed").expect("key");

    let draft = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "crashed draft");
    dohc_engine_collab::record_local_update(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &draft,
        dohc_engine_collab::LocalAppend {
            marker: Some(dohc_engine_collab::MarkerCreation {
                path: Some("notes/crashed.md"),
                content_kind: dohc_engine_collab::ContentKind::Plaintext,
                regime: dohc_engine_collab::Regime::LocalOnly,
            }),
            ..Default::default()
        },
        &NoFaults,
        1_500,
        |_tx, _outcome, _update_sha| Ok(()),
    )
    .expect("crashed draft rows");

    engine
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::write_projected_text_in_tx(
                tx,
                &dohc_engine_domain::WriteText {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "object-crashed".to_owned(),
                    path: "notes/crashed.md".to_owned(),
                    text: "the user's external edit".to_owned(),
                    moment_id: "m-external".to_owned(),
                    metadata_origin: "capture".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1_600,
                    request_id: None,
                },
            )
            .map_err(|error| SyncError::corrupt(std::io::Error::other(error.to_string())))?;
            Ok::<_, SyncError>(())
        })
        .expect("external edit");

    let base_doc = dohc_engine_collab::Ydoc::wire();
    base_doc.plaintext_insert(0, "peer base");
    let base_sha = engine
        .put_binary_blob(&base_doc.encode_full_state())
        .expect("base blob");
    let outcome = apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &envelope(
            "peer",
            0,
            "ydoc.update",
            json!({
                "versionId": "main",
            "objectId": "object-crashed",
            "path": "notes/crashed.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha,
            "isBaseState": true
            }),
        ),
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("base applies");
    let ApplyOutcome {
        primary: ApplyDisposition::Applied(result),
        refusals: ref outcome_refusals,
        sharing_declined: ref outcome_sharing_declined,
    } = outcome
    else {
        panic!("base did not apply: {outcome:?}");
    };
    assert!(outcome_refusals.is_empty());
    assert!(outcome_sharing_declined.is_empty());
    assert_eq!(result.reason, Some("ydoc-base-conflict"));
    assert_eq!(result.conflicts_opened, 1);
    let replacement = result
        .lineage_replacement
        .expect("the local-only lineage is recovered");
    assert_eq!(replacement.recovered_paths.len(), 1);

    let head: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256 = s.blob_sha256 \
                 WHERE s.workspace_id='ws' AND s.object_id='object-crashed'",
                [],
                |r| r.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("head");
    assert_eq!(
        head, "the user's external edit",
        "the external edit survives for review instead of being overwritten"
    );
    let recovered: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
                 WHERE s.workspace_id='ws' AND s.version_id='main' AND s.path=?1",
                [&replacement.recovered_paths[0]],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("recovered local-only draft");
    assert_eq!(recovered, "crashed draft");
}

#[test]
fn imported_richdoc_base_binds_its_verified_path_before_owner_enrollment() {
    for existing_head in [false, true] {
        let (_scratch, _path, mut engine) = open_store();
        seed_replication_version(&mut engine, "main", "main");
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.rewrite_content_to_markdown(dohc_engine_collab::ContentKind::Richdoc, "Shared truth")
            .unwrap();
        let markdown = doc
            .project(dohc_engine_collab::ContentKind::Richdoc)
            .unwrap()
            .content;
        if existing_head {
            engine.write_with(&NoFaults, |tx| {
                tx.execute("INSERT INTO file_objects (workspace_id,object_id,created_at_ms) VALUES ('ws','owner-object',1)", []).map_err(SyncError::persist)?;
                dohc_engine_domain::write_projected_text_in_tx(tx, &dohc_engine_domain::WriteText {
                    workspace_id:"ws".into(), version_id:"main".into(), object_id:"owner-object".into(),
                    path:"notes/owner.md".into(), text:markdown.clone(), moment_id:"original".into(),
                    metadata_origin:"local-file".into(), metadata_summary:None, metadata_correlation_id:None,
                    author_json:None, now_ms:1_500, request_id:None,
                }).map_err(|error| SyncError::corrupt(std::io::Error::other(error.to_string())))?;
                Ok::<_,SyncError>(())
            }).unwrap();
        }
        let bytes = doc.encode_full_state();
        let sha = engine.put_binary_blob(&bytes).unwrap();
        let op = envelope(
            "owner-peer",
            0,
            "ydoc.update",
            json!({
                "versionId":"main","objectId":"owner-object","path":"notes/owner.md", "contentKind":"richdoc",
                "updateBlobSha256":sha,"lineageClaimId":sha,"isBaseState":true
            }),
        );
        let mut cache = dohc_engine_collab::WriterDocCache::new();
        let key = dohc_engine_collab::DocKey::new("ws", "main", "owner-object").unwrap();
        let binding = dohc_engine_collab::LiveObjectBinding {
            workspace_id: "ws".into(),
            main_version_id: "main".into(),
            object_id: "owner-object".into(),
            lineage_claim_id: sha,
            current_path: "notes/owner.md".into(),
            selector_paths: vec!["notes".into()],
            restore_fence_generation: 0,
        };
        for _ in 0..2 {
            let outcome =
                apply_ydoc_envelope(&mut engine, &mut cache, &op, &NoFaults, &NoLiveLeases)
                    .unwrap();
            assert!(outcome.refusals.is_empty());
            let marker = dohc_engine_collab::read_marker(&engine, &key)
                .unwrap()
                .unwrap();
            assert_eq!(marker.path.as_deref(), Some("notes/owner.md"));
            assert_eq!(
                marker.head_update_seq, 0,
                "enrollment does not require an artificial local edit"
            );
            let captured = engine
                .read_with(|conn| {
                    dohc_engine_collab::owner_outbox::enrollment::capture_in(conn, &binding)
                })
                .unwrap();
            assert_eq!(captured.native_head_sequence, 0);
            let mut wrong = binding.clone();
            wrong.current_path = "notes/other.md".into();
            assert!(
                engine
                    .read_with(
                        |conn| dohc_engine_collab::owner_outbox::enrollment::capture_in(
                            conn, &wrong
                        )
                    )
                    .is_err()
            );
            assert_eq!(engine.table_row_count("moments").unwrap(), 1);
            assert_eq!(engine.table_row_count("conflicts").unwrap(), 0);
        }
    }
}
fn deliver_fold_moment(origin: &mut EngineStore, peer: &mut EngineStore, id: &str, seq: i64) {
    let payload = origin
        .write_with(&NoFaults, |tx| {
            crate::outbound::moment_append_payload_in_tx(tx, "ws", id)
        })
        .unwrap();
    let TxnOutcome::Committed((payload, at)) = payload else {
        panic!("moment payload");
    };
    let mut op = envelope("fold-origin", seq, "moment.append", payload);
    op.recorded_at_ms = at;
    let applied = crate::apply_replication_envelope(
        peer,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    assert!(
        matches!(applied.primary, ApplyDisposition::Applied(_)),
        "{applied:?}"
    );
    assert!(applied.refusals.is_empty());
}
fn assert_peer_fold_with_base(
    initial: &str,
    chosen: &str,
    refuses: bool,
    settled: Option<&str>,
    reserved: bool,
    desktop_base: Option<&[u8]>,
) {
    use dohc_engine_collab::{ContentKind, DocKey, WriterDocCache, Ydoc};
    const PATH: &str = "tasks/record.md";
    let (_origin_dir, _origin_path, mut origin) = open_store();
    let (_peer_dir, _peer_path, mut peer) = open_store();
    let key = DocKey::new("ws", "main", "fold-record").unwrap();
    for store in [&mut origin, &mut peer] {
        seed_replication_version(store, "main", "main");
        seed_text_head(store, &key.object_id, PATH, initial);
        VersionedTextStore::new(store)
            .write_text(
                &dohc_engine_domain::WriteText {
                    workspace_id: "ws".into(),
                    version_id: "main".into(),
                    object_id: key.object_id.clone(),
                    path: PATH.into(),
                    text: initial.into(),
                    moment_id: "fold-initial".into(),
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1400,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
    }
    let source = Ydoc::wire();
    if let Some(base) = desktop_base {
        source.apply(base).unwrap();
    } else {
        source
            .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, initial)
            .unwrap();
    }
    let initial_body = source.canonical_content()["body"].clone();
    let initial_projection = source.project(ContentKind::Richdoc).unwrap().content;
    let base = source.encode_full_state();
    let claim = dohc_engine_storage::hex_sha256(&base);
    dohc_engine_collab::claim_base(
        &mut origin,
        &key,
        ContentKind::Richdoc,
        &base,
        &NoFaults,
        1500,
    )
    .unwrap();
    origin
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_docs SET last_settled_sha=?1 WHERE object_id=?2",
                params![
                    dohc_engine_storage::hex_sha256(initial.as_bytes()),
                    key.object_id
                ],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    if desktop_base.is_some() {
        dohc_engine_collab::claim_base(
            &mut peer,
            &key,
            ContentKind::Richdoc,
            &base,
            &NoFaults,
            1500,
        )
        .unwrap();
        peer.write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_docs SET last_settled_sha=?1 WHERE object_id=?2",
                params![
                    dohc_engine_storage::hex_sha256(initial.as_bytes()),
                    key.object_id
                ],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    }
    let base_sha = peer.put_binary_blob(&base).unwrap();
    let base_op = envelope(
        "fold-origin",
        0,
        "ydoc.update",
        json!({
            "versionId": "main", "objectId": key.object_id, "path": PATH,
            "contentKind": "richdoc", "updateBlobSha256": base_sha,
            "lineageClaimId": claim, "isBaseState": true
        }),
    );
    let applied = apply_ydoc_envelope(
        &mut peer,
        &mut WriterDocCache::new(),
        &base_op,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    assert!(
        matches!(applied.primary, ApplyDisposition::Applied(_)),
        "{applied:?}"
    );

    if let Some(settled) = settled {
        let delta = source
            .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, settled)
            .unwrap();
        origin.write_with(&NoFaults, |tx| {
            dohc_engine_collab::record_update_in_tx(tx, &key, &delta, Some("editor"), None, 1550)
            .map_err(SyncError::corrupt)?;
            dohc_engine_collab::author_coverage::advance_in(tx, &key, reserved).map_err(SyncError::corrupt)?;
            let result = dohc_engine_domain::write_projected_text_in_tx(tx, &dohc_engine_domain::WriteText {
                workspace_id: "ws".into(), version_id: "main".into(), object_id: key.object_id.clone(),
                path: PATH.into(), text: settled.into(), moment_id: "live-settle".into(),
                metadata_origin: "ydoc".into(), metadata_summary: None, metadata_correlation_id: None,
                author_json: None, now_ms: 1550, request_id: None,
            }).map_err(crate::ydoc_apply::map_domain_hard_error)?;
            tx.execute("UPDATE ydoc_docs SET settle_seq=?1,last_settled_sha=?2,seed_source_sha256=?3 WHERE object_id=?4",
                params![result.moment.moment_order, result.snapshot.blob_sha256,
                    dohc_engine_storage::hex_sha256(initial.as_bytes()), key.object_id]).map_err(SyncError::persist)?;
            dohc_engine_collab::author_coverage::compensate_in(tx, &key, Some("live-settle"), 1551)
                .map_err(SyncError::corrupt)
        }).unwrap();
        let last: Option<String> = origin
            .read_with(|conn| {
                conn.query_row(
                    "SELECT last_settled_sha FROM ydoc_docs WHERE object_id=?1",
                    [&key.object_id],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert!(
            last.is_none(),
            "real compensation clears the source witness"
        );
        let sha = peer.put_binary_blob(&delta).unwrap();
        let op = envelope(
            "fold-origin",
            1,
            "ydoc.update",
            json!({
                "versionId":"main", "objectId":key.object_id, "path":PATH, "contentKind":"richdoc",
                "updateBlobSha256":sha, "lineageClaimId":claim, "isBaseState":false,
            }),
        );
        let applied = apply_ydoc_envelope(
            &mut peer,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(
            matches!(applied.primary, ApplyDisposition::Applied(_)),
            "{applied:?}"
        );
        deliver_fold_moment(&mut origin, &mut peer, "live-settle", 2);
    }

    // Capture installs C before folding. The receiver still has the old file.
    let folded = origin.write_with(&NoFaults, |tx| {
        dohc_engine_domain::write_projected_text_in_tx(
            tx,
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: key.object_id.clone(),
                path: PATH.into(),
                text: chosen.into(),
                moment_id: "fold-choice".into(),
                metadata_origin: "capture".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1600,
                request_id: None,
            },
        )
        .map_err(crate::ydoc_apply::map_domain_hard_error)?;
        crate::ydoc_apply::fold_resolution_into_ydoc_in_tx(
            tx,
            "ws",
            "main",
            &key.object_id,
            PATH,
            chosen,
            1600,
        )
    });
    if refuses {
        assert!(
            matches!(
                folded,
                Err(SyncError::InvalidInput {
                    reason: "ydoc-resolution-not-representable"
                })
            ),
            "{folded:?}"
        );
        let updates: i64 = origin
            .read_with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| row.get(0))
            })
            .unwrap();
        assert_eq!(
            updates,
            i64::from(settled.is_some()),
            "the originated base must survive without replacement or a delta"
        );
    } else {
        folded.unwrap_or_else(|error| panic!("fold {initial:?} -> {chosen:?}: {error:?}"));
        let delta = origin
            .read_with(|conn| {
                let sha: String = conn
                    .query_row(
                        "SELECT update_blob_sha256 FROM ydoc_updates ORDER BY seq DESC LIMIT 1",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                dohc_engine_storage::get_binary_blob(conn, &sha)
            })
            .unwrap()
            .unwrap();
        let delta_sha = peer.put_binary_blob(&delta).unwrap();
        let update = envelope(
            "fold-origin",
            if settled.is_some() { 3 } else { 1 },
            "ydoc.update",
            json!({
                "versionId": "main", "objectId": key.object_id, "path": PATH,
                "contentKind": "richdoc", "updateBlobSha256": delta_sha,
                "lineageClaimId": claim, "isBaseState": false
            }),
        );
        let applied = apply_ydoc_envelope(
            &mut peer,
            &mut WriterDocCache::new(),
            &update,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(
            matches!(applied.primary, ApplyDisposition::Applied(_)),
            "{applied:?}"
        );
        assert!(applied.refusals.is_empty());
        deliver_fold_moment(
            &mut origin,
            &mut peer,
            "fold-choice",
            if settled.is_some() { 4 } else { 2 },
        );
    }
    let expected = if refuses {
        settled.unwrap_or(initial)
    } else {
        chosen
    };
    for store in [&mut origin, &mut peer] {
        let snapshot = VersionedTextStore::new(store)
            .read_text("ws", "main", PATH)
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.text, expected);
        let projection = store
            .read_with(|conn| {
                let doc = dohc_engine_collab::load_doc_in(conn, &key).unwrap();
                if desktop_base.is_some() {
                    assert_eq!(doc.canonical_content()["body"], initial_body);
                }
                crate::ydoc_apply::project_ydoc_with_store(conn, &key, &doc, ContentKind::Richdoc)
            })
            .unwrap();
        assert_eq!(
            projection.content,
            if refuses && desktop_base.is_some() {
                &initial_projection
            } else {
                expected
            }
        );
        let conflicts: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM conflicts WHERE status='open'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(conflicts, 0);
    }
}

#[test]
fn a_fold_that_cannot_reproduce_the_choice_refuses_instead_of_diverging() {
    assert_refused_fold("", false);
    assert_refused_fold("original", false);
    assert_refused_fold("", true);
}

fn assert_refused_fold(initial: &str, chosen_file_head: bool) {
    // The fold's markdown parser is ASSERTED to be the projector's inverse
    // and nothing makes that true. Past the quote budget the leftover `> `
    // markers become paragraph text and the projector escapes them to
    // `&gt;` — so the fold would commit a lineage projecting bytes the user
    // never chose while stamping last_settled_sha with the chosen text's
    // hash in the same statement: the head file saying one thing, the CRDT
    // another, and the marker asserting they agree. That is a silent
    // reversal, arriving through the fold itself.
    //
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws','object-unrepresentable',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("scaffolding");
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-unrepresentable").expect("key");
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.rewrite_content_to_markdown(dohc_engine_collab::ContentKind::Richdoc, initial)
        .expect("seed rich document");
    dohc_engine_collab::claim_base(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Richdoc,
        &doc.encode_full_state(),
        &NoFaults,
        1_500,
    )
    .expect("claim");

    // Deeper than the fold's recursion budget: representable as markdown,
    // not reproducible by the parser.
    let unrepresentable = format!("{}deep", "> ".repeat(200));
    if chosen_file_head {
        // Even identical disk bytes cannot prove the parser retained content.
        engine
            .write_with(&NoFaults, |tx| {
                dohc_engine_domain::write_projected_text_in_tx(
                    tx,
                    &dohc_engine_domain::WriteText {
                        workspace_id: "ws".to_owned(),
                        version_id: "main".to_owned(),
                        object_id: key.object_id.clone(),
                        path: "notes/unrepresentable.md".to_owned(),
                        text: unrepresentable.clone(),
                        moment_id: "unrepresentable-head".to_owned(),
                        metadata_origin: "local-file".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 1_550,
                        request_id: None,
                    },
                )
            })
            .expect("chosen file head");
    }
    let refused = engine.write_with(&NoFaults, |tx| {
        crate::ydoc_apply::fold_resolution_into_ydoc_in_tx(
            tx,
            "ws",
            "main",
            "object-unrepresentable",
            "notes/unrepresentable.md",
            &unrepresentable,
            1_600,
        )
    });
    assert!(
        matches!(
            refused,
            Err(SyncError::InvalidInput {
                reason: "ydoc-resolution-not-representable"
            })
        ),
        "a fold that cannot reproduce the choice must refuse: {refused:?}"
    );

    let (updates, settled): (i64, Option<String>) = engine
        .read_with(|conn| {
            Ok::<_, SyncError>((
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_updates WHERE workspace_id='ws' \
                     AND object_id='object-unrepresentable'",
                    [],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)?,
                conn.query_row(
                    "SELECT last_settled_sha FROM ydoc_docs WHERE workspace_id='ws' \
                     AND object_id='object-unrepresentable'",
                    [],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)?,
            ))
        })
        .expect("post-refusal state");
    assert_eq!(updates, 0, "the refused fold appended nothing");
    assert_ne!(
        settled.as_deref(),
        Some(dohc_engine_storage::hex_sha256(unrepresentable.as_bytes()).as_str()),
        "and never stamped the choice it could not store"
    );
}

#[test]
fn a_resolution_over_an_incomplete_lineage_refuses() {
    // One property with the orientation fix: the reviewed bytes are the
    // bytes that end up in the lineage, permanently.
    //
    // An out-of-order cross-origin update is appended to `ydoc_updates`
    // while its predecessor is missing, and `apply_ydoc_envelope` skips its
    // projection for exactly that reason. Resolving over that document
    // reviews a partial lineage: when the predecessor lands it integrates
    // the unseen update and projects it through a review gate that has
    // already closed, changing the approved head with no second review.
    //
    // The deferred-queue check one guard above cannot see this — those rows
    // were never applied at all, while these are already in the lineage.
    // Two different records of "not whole yet", which is how consulting one
    // of them missed the other.
    //
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws','object-partial',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("scaffolding");
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-partial").expect("key");

    // A claimed lineage, so the fold reaches its completeness check.
    let base_doc = dohc_engine_collab::Ydoc::wire();
    base_doc.plaintext_insert(0, "base text");
    let base_sha = engine
        .put_binary_blob(&base_doc.encode_full_state())
        .expect("base blob");
    apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &envelope(
            "peer",
            0,
            "ydoc.update",
            json!({
                "versionId": "main",
            "objectId": "object-partial",
            "path": "notes/partial.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha.clone(),
            "isBaseState": true
            }),
        ),
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("base claims");

    let dep_doc = dohc_engine_collab::Ydoc::wire();
    let _predecessor = dep_doc.plaintext_insert(0, "dep base");
    let dependent = dep_doc.plaintext_insert(0, "more ");
    let dependent_sha = engine.put_binary_blob(&dependent).expect("dependent blob");
    apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &envelope(
            "dep-peer",
            0,
            "ydoc.update",
            json!({
                "versionId": "main",
            "objectId": "object-partial",
            "path": "notes/partial.md",
            "contentKind": "plaintext",
            "updateBlobSha256": dependent_sha,
            "lineageClaimId": base_sha,
            "isBaseState": false
            }),
        ),
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("the dependent update parks in the lineage");
    let persisted = dohc_engine_collab::load_persisted(&engine, &key)
        .expect("load")
        .expect("lineage");
    assert!(
        persisted.doc.has_pending_dependencies(),
        "precondition: the lineage is genuinely incomplete"
    );

    let refused = engine.write_with(&NoFaults, |tx| {
        crate::ydoc_apply::fold_resolution_into_ydoc_in_tx(
            tx,
            "ws",
            "main",
            "object-partial",
            "notes/partial.md",
            "the reviewer's choice",
            1_700,
        )
    });
    assert!(
        matches!(
            refused,
            Err(SyncError::InvalidInput {
                reason: "ydoc-incomplete-lineage"
            })
        ),
        "a resolution over a partial lineage must refuse: {refused:?}"
    );
    let before_retire: (i64, i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_updates WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='object-partial'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_snapshots WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='object-partial'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_deferred_updates WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='object-partial'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='object-partial'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("lineage before retirement");
    let retired = engine.write_with(&NoFaults, |tx| {
        crate::retire_ydoc_lineage_in_tx(tx, "ws", "main", "object-partial")
    });
    assert!(matches!(
        retired,
        Err(SyncError::RetryableState {
            reason: "ydoc-incomplete-lineage"
        })
    ));
    let after_retire: (i64, i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_updates WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='object-partial'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_snapshots WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='object-partial'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_deferred_updates WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='object-partial'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='object-partial'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("lineage after refused retirement");
    assert_eq!(after_retire, before_retire);
}

#[test]
fn ydoc_storage_failure_is_hard_unacked_and_retryable() {
    let (_scratch, _path, mut engine) = open_store();
    let install_abort_trigger = |engine: &mut EngineStore, trigger_name: &str, table_name: &str| {
        let sql = format!(
            "CREATE TRIGGER {trigger_name} BEFORE INSERT ON {table_name} \
                 BEGIN SELECT RAISE(ABORT, 'injected Y.Doc storage failure'); END"
        );
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute_batch(&sql).map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("install fault trigger");
    };
    let drop_trigger = |engine: &mut EngineStore, trigger_name: &str| {
        let sql = format!("DROP TRIGGER {trigger_name}");
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute_batch(&sql).map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("clear fault trigger");
    };
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws', 'object-storage-fault', 1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("file object");

    let doc = dohc_engine_collab::Ydoc::wire();
    doc.plaintext_insert(0, "base");
    let base_sha = engine
        .put_binary_blob(&doc.encode_full_state())
        .expect("base blob");
    let base = envelope(
        "storage-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-storage-fault",
            "path": "notes/storage-fault.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha.clone(),
            "isBaseState": true
        }),
    );
    install_abort_trigger(
        &mut engine,
        "inject_ydoc_base_storage_failure",
        "ydoc_snapshots",
    );
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &base,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::Storage(_))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "storage-base-peer").expect("base ack"),
        -1,
        "a base-claim storage failure must leave the coordinate retryable"
    );
    drop_trigger(&mut engine, "inject_ydoc_base_storage_failure");
    apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("base applies");

    let update_sha = engine
        .put_binary_blob(&doc.plaintext_insert(0, "updated "))
        .expect("update blob");
    let update = envelope(
        "storage-update-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-storage-fault",
            "path": "notes/storage-fault.md",
            "contentKind": "plaintext",
            "updateBlobSha256": update_sha,
            "lineageClaimId": base_sha,
            "isBaseState": false
        }),
    );
    for (trigger_name, table_name) in [
        ("inject_ydoc_update_storage_failure", "ydoc_updates"),
        ("inject_ydoc_projection_storage_failure", "moments"),
        (
            "inject_ydoc_materialization_storage_failure",
            "materialization_jobs",
        ),
    ] {
        install_abort_trigger(&mut engine, trigger_name, table_name);
        assert!(matches!(
            apply_ydoc_envelope(
                &mut engine,
                &mut dohc_engine_collab::WriterDocCache::new(),
                &update,
                &NoFaults,
                &NoLiveLeases
            ),
            Err(SyncError::Storage(_))
        ));
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", "storage-update-peer").expect("ack"),
            -1,
            "a local storage failure must not retire the remote coordinate"
        );
        let imported: i64 = engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log \
                     WHERE workspace_id='ws' AND origin_id='storage-update-peer'",
                    [],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)
            })
            .expect("imported row count");
        assert_eq!(imported, 0, "a hard failure must not be journaled");
        drop_trigger(&mut engine, trigger_name);
    }

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
                deferred: false,
                reason: None,
                conflicts_opened: 0,
                lineage_replacement: None,
                record_facts: _,
            }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "storage-update-peer").expect("retry ack"),
        0
    );
}

#[test]
fn scene_base_and_asset_moment_converge_in_both_arrival_orders() {
    let make_ops = |engine: &mut EngineStore| {
        seed_identity(engine);
        seed_replication_version(engine, "main", "main");
        let object_id = "scene-object";
        let asset_id = "image-file";
        let asset_bytes = vec![1_u8, 2, 3, 4, 5];
        let asset_sha = dohc_engine_storage::hex_sha256(&asset_bytes);
        let asset_ref =
            dohc_engine_collab::scene_asset_ref("ws", "main", object_id, &asset_sha, "image/png")
                .expect("asset ref");
        let portable = serde_json::to_string(&json!({
            "type": "excalidraw", "version": 2, "source": "https://excalidraw.com",
            "elements": [{ "id": "image", "type": "image", "version": 1,
                "versionNonce": 1, "isDeleted": false, "index": "a0", "fileId": asset_id }],
            "appState": {},
            "files": { (asset_id): { "id": asset_id, "mimeType": "image/png", "created": 1,
                "dataURL": "data:image/png;base64,AQIDBAU=" } }
        }))
        .expect("portable scene");
        let imported = dohc_engine_collab::import_portable_scene(&portable).expect("import");
        let records = BTreeMap::from([(
            asset_id.to_owned(),
            serde_json::to_string(&json!({
                "created": 1, "id": asset_id, "mimeType": "image/png",
                "ref": asset_ref, "sha256": asset_sha
            }))
            .expect("asset record"),
        )]);
        let asset_update =
            dohc_engine_collab::encode_scene_asset_records(&records).expect("asset-root update");
        let base_update =
            dohc_engine_collab::merge_updates(&[imported.initial_update, asset_update])
                .expect("scene base");
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.apply(&base_update).expect("base applies");
        let ydoc_sha = engine
            .put_binary_blob(&doc.encode_full_state())
            .expect("ydoc blob");
        assert_eq!(
            engine.put_binary_blob(&asset_bytes).expect("asset blob"),
            asset_sha
        );
        let asset = envelope(
            "asset-peer",
            0,
            "moment.append",
            json!({
                "momentId": "asset-moment", "versionId": "main",
                "objectId": "asset-object", "objectCreatedAtMs": 1,
                "path": asset_ref, "recordedAtMs": 2_000, "operation": "write",
                "payloadBeforeBlobSha256": null, "payloadBeforePath": null,
                "payloadAfterBlobSha256": asset_sha, "payloadAfterPath": asset_ref,
                "payloadAfterContentKind": "binary", "payloadAfterByteLength": asset_bytes.len(),
                "metadata": {"origin": "sync"}, "beforePresent": "absent"
            }),
        );
        let scene = envelope(
            "scene-peer",
            0,
            "ydoc.update",
            json!({
                "versionId": "main", "objectId": object_id,
                "path": "drawings/board.excalidraw", "contentKind": "scene",
                "updateBlobSha256": ydoc_sha, "lineageClaimId": ydoc_sha,
                "isBaseState": true
            }),
        );
        (asset, scene, asset_ref, portable)
    };

    let (scratch_a, path_a, mut asset_first) = open_store();
    let (asset_a, scene_a, asset_ref_a, _) = make_ops(&mut asset_first);
    let asset_first_pull = RelaySyncClient::new(FakeRelay {
        refuse_oversized_proofs: false,
        push_budget_limit: None,
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
            ops: vec![asset_a, scene_a],
            next_cursor: 2,
            has_more: false,
        })),
        ..Default::default()
    });
    let SyncPassOutcome::Complete {
        changed_paths: asset_first_changes,
        applied: 2,
        refused: 0,
        ..
    } = asset_first_pull
        .pull_chat_workspace(
            &mut asset_first,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            2_100,
        )
        .expect("asset-first relay pull")
    else {
        panic!("asset-first relay pull must complete");
    };

    let (scratch_b, path_b, mut scene_first) = open_store();
    let (asset_b, scene_b, asset_ref_b, portable) = make_ops(&mut scene_first);
    let scene_first_pull = RelaySyncClient::new(FakeRelay {
        refuse_oversized_proofs: false,
        push_budget_limit: None,
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            work_references: Vec::new(),
            next_reference_after: None,
            reference_has_more: false,
            ops: vec![scene_b, asset_b],
            next_cursor: 2,
            has_more: false,
        })),
        ..Default::default()
    });
    let SyncPassOutcome::Complete {
        changed_paths: scene_first_changes,
        applied: 2,
        refused: 0,
        ..
    } = scene_first_pull
        .pull_chat_workspace(
            &mut scene_first,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            2_100,
        )
        .expect("scene-first relay pull retries after the asset moment")
    else {
        panic!("scene-first relay pull must complete");
    };

    let read_head = |engine: &EngineStore| {
        engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
                     WHERE s.workspace_id='ws' AND s.version_id='main' \
                       AND s.path='drawings/board.excalidraw'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .map_err(SyncError::corrupt)
            })
            .expect("portable head")
    };
    let expected: serde_json::Value = serde_json::from_str(&portable).expect("expected JSON");
    let first: serde_json::Value = serde_json::from_str(&read_head(&asset_first)).expect("first");
    let second: serde_json::Value = serde_json::from_str(&read_head(&scene_first)).expect("second");
    assert_eq!(first, expected);
    assert_eq!(second, expected);
    assert_eq!(
        first["files"]["image-file"]["dataURL"],
        "data:image/png;base64,AQIDBAU="
    );
    let conflicts: i64 = scene_first
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM conflicts", [], |row| row.get(0))
                .map_err(SyncError::corrupt)
        })
        .expect("conflict count");
    assert_eq!(conflicts, 0);

    for (store, scratch, asset_ref, changes) in [
        (
            &mut asset_first,
            &scratch_a,
            &asset_ref_a,
            &asset_first_changes,
        ),
        (
            &mut scene_first,
            &scratch_b,
            &asset_ref_b,
            &scene_first_changes,
        ),
    ] {
        assert_eq!(
            changes
                .iter()
                .map(|change| (change.path.as_str(), change.content_kind))
                .collect::<BTreeMap<_, _>>(),
            BTreeMap::from([
                ("drawings/board.excalidraw", "text"),
                (asset_ref.as_str(), "binary"),
            ]),
            "the real pull must expose both disk debts before its cursor commits"
        );
        let materialized = dohc_engine_files::run_pending_jobs(
            store,
            scratch.path(),
            &MaterializeOptions {
                holds: None,
                policy: dohc_engine_files::DurabilityPolicy::per_os(),
                replacer: &dohc_engine_files::StdReplacer,
                backoff: &dohc_engine_files::NoBackoff,
                now_ms: 2_500,
                faults: &NoFaults,
            },
        )
        .expect("materialize replicated scene and sidecar");
        assert!(
            materialized
                .iter()
                .all(|result| matches!(result.outcome, dohc_engine_files::JobOutcome::Completed)),
            "replicated scene projection must not conflict"
        );
        for change in changes {
            if change.operation != "write" || change.content_kind != "binary" {
                continue;
            }
            let head = VersionedTextStore::new(store)
                .read_binary("ws", "main", &change.path)
                .expect("read authoritative binary head")
                .expect("binary head exists");
            let target = scratch.join(&change.path);
            std::fs::create_dir_all(target.parent().expect("asset parent"))
                .expect("create asset directory");
            std::fs::write(target, head.bytes).expect("materialize relay binary debt");
        }
        let disk: serde_json::Value = serde_json::from_slice(
            &std::fs::read(scratch.join("drawings/board.excalidraw"))
                .expect("materialized portable scene"),
        )
        .expect("portable scene JSON");
        assert_eq!(disk, expected);
        assert_eq!(
            std::fs::read(scratch.join(asset_ref)).expect("materialized sidecar"),
            [1, 2, 3, 4, 5]
        );
    }
    drop(asset_first);
    let restarted_asset_first = EngineStore::open(&path_a, 3_000).expect("restart asset-first");
    assert!(
        dohc_engine_collab::load_persisted(
            &restarted_asset_first,
            &dohc_engine_collab::DocKey::new("ws", "main", "scene-object").expect("key")
        )
        .expect("load asset-first after restart")
        .is_some()
    );
    drop(scene_first);
    let reopened = EngineStore::open(&path_b, 3_000).expect("restart store");
    let key = dohc_engine_collab::DocKey::new("ws", "main", "scene-object").expect("key");
    let folded = dohc_engine_collab::load_persisted(&reopened, &key)
        .expect("load after restart")
        .expect("scene lineage")
        .doc
        .fold_scene();
    assert_eq!(folded.elements[0]["fileId"], "image-file");
}

#[test]
fn scene_base_permanently_refuses_forged_asset_authority() {
    let sha = "11".repeat(32);
    let other_sha = "22".repeat(32);
    let png_ref =
        dohc_engine_collab::scene_asset_ref("ws", "main", "scene-forged", &sha, "image/png")
            .expect("PNG ref");
    let mismatched_hash_ref =
        dohc_engine_collab::scene_asset_ref("ws", "main", "scene-forged", &other_sha, "image/png")
            .expect("other hash ref");
    let cross_workspace_ref = dohc_engine_collab::scene_asset_ref(
        "other-workspace",
        "main",
        "scene-forged",
        &sha,
        "image/png",
    )
    .expect("cross-workspace ref");
    let cross_version_ref = dohc_engine_collab::scene_asset_ref(
        "ws",
        "other-version",
        "scene-forged",
        &sha,
        "image/png",
    )
    .expect("cross-version ref");
    for (case, mime_type, asset_ref) in [
        ("unrelated", "image/png", "user/image.png".to_owned()),
        ("hash-filename", "image/png", mismatched_hash_ref),
        ("mime-extension", "image/jpeg", png_ref.clone()),
        ("cross-workspace", "image/png", cross_workspace_ref),
        ("cross-version", "image/png", cross_version_ref),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        seed_replication_version(&mut engine, "main", "main");
        let portable = json!({
            "type": "excalidraw", "version": 2, "source": "https://excalidraw.com",
            "elements": [{ "id": "image", "type": "image", "version": 1,
                "versionNonce": 1, "isDeleted": false, "index": "a0", "fileId": "file" }],
            "appState": {},
            "files": { "file": { "id": "file", "mimeType": "image/png", "created": 1,
                "dataURL": "data:image/png;base64,AQIDBA==" } }
        })
        .to_string();
        let imported = dohc_engine_collab::import_portable_scene(&portable).expect("scene import");
        let records = BTreeMap::from([(
            "file".to_owned(),
            json!({
                "created": 1, "id": "file", "mimeType": mime_type,
                "ref": asset_ref, "sha256": sha
            })
            .to_string(),
        )]);
        let asset_update = dohc_engine_collab::encode_scene_asset_records(&records)
            .expect("structurally valid forged record");
        let update = dohc_engine_collab::merge_updates(&[imported.initial_update, asset_update])
            .expect("merge scene");
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.apply(&update).expect("scene applies");
        let update_sha = engine
            .put_binary_blob(&doc.encode_full_state())
            .expect("scene blob");
        let operation = envelope(
            &format!("forged-{case}"),
            0,
            "ydoc.update",
            json!({
                "versionId": "main", "objectId": "scene-forged",
                "path": "drawings/forged.excalidraw", "contentKind": "scene",
                "updateBlobSha256": update_sha, "isBaseState": true
            }),
        );
        assert!(
            matches!(
                apply_replication_envelope(
                    &mut engine,
                    &mut dohc_engine_collab::WriterDocCache::new(),
                    &operation,
                    &NoFaults,
                    &NoLiveLeases
                ),
                Ok(ApplyOutcome {
                    primary: ApplyDisposition::Refused(ReplicationRefusal {
                        reason: RefusalReason::InvalidInput { .. },
                        ..
                    }),
                    refusals: ref outcome_refusals,
                    sharing_declined: ref outcome_sharing_declined,
                }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
            ),
            "{case}"
        );
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", &format!("forged-{case}"))
                .expect("refusal ack"),
            0,
            "{case} must be terminal instead of retrying forever"
        );
        assert!(
            dohc_engine_collab::read_marker(
                &engine,
                &dohc_engine_collab::DocKey::new("ws", "main", "scene-forged").expect("key")
            )
            .expect("marker read")
            .is_none(),
            "{case} must not retain a refused lineage"
        );
    }
}

#[test]
fn refused_ydoc_projection_retains_clocks_for_a_dependent_descendant() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");

    let source = dohc_engine_collab::Ydoc::wire();
    source.plaintext_insert(0, "base");
    let base_sha = engine
        .put_binary_blob(&source.encode_full_state())
        .expect("base blob");
    let refused_sha = engine
        .put_binary_blob(&source.plaintext_insert(4, " refused-clock"))
        .expect("refused update blob");
    let descendant_sha = engine
        .put_binary_blob(&source.plaintext_insert(18, " descendant"))
        .expect("descendant update blob");
    let base = envelope(
        "clock-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-causal-refusal",
            "path": "notes/causal-refusal.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha.clone(),
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
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    seed_text_head(
        &mut engine,
        "object-causal-occupant",
        "notes/occupied-causal.md",
        "occupied",
    );
    let refused = envelope(
        "clock-update-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-causal-refusal",
            "path": "notes/occupied-causal.md",
            "contentKind": "plaintext",
            "updateBlobSha256": refused_sha,
            "lineageClaimId": base_sha.clone(),
            "isBaseState": false
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &refused,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Refused(ReplicationRefusal {
                reason: RefusalReason::InvalidInput { .. },
                ..
            }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let descendant = envelope(
        "clock-update-peer",
        1,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-causal-refusal",
            "path": "notes/causal-refusal.md",
            "contentKind": "plaintext",
            "updateBlobSha256": descendant_sha,
            "lineageClaimId": base_sha,
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
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-causal-refusal").expect("key");
    let persisted = dohc_engine_collab::load_persisted(&engine, &key)
        .expect("load")
        .expect("lineage");
    let causal_text = persisted.doc.plaintext_string();
    assert!(
        !persisted.doc.has_pending_dependencies(),
        "rolling back the refused update strands its descendant behind a missing clock"
    );
    assert!(
        causal_text.contains("refused-clock") && causal_text.contains("descendant"),
        "the causal bytes converge in the Y.Doc without projecting through the occupied path: {causal_text:?}"
    );
    let visible: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM path_aliases a \
                 JOIN snapshots s ON s.workspace_id=a.workspace_id \
                   AND s.version_id=a.version_id AND s.object_id=a.object_id \
                 JOIN blobs b ON b.sha256=s.blob_sha256 \
                 WHERE a.workspace_id='ws' AND a.version_id='main' \
                   AND a.path='notes/causal-refusal.md'",
                [],
                |row| row.get(0),
            )
        })
        .expect("visible causal head");
    assert_eq!(visible, causal_text);
}

#[test]
fn different_document_seeds_keep_unsettled_edits_in_a_version_conflict() {
    use dohc_engine_collab::{ContentKind, DocKey, WriterDocCache, Ydoc};
    for deferred in [false, true] {
        let (_scratch, _path, mut engine) = open_store();
        VersionedTextStore::new(&mut engine)
            .ensure_main_version("ws", "main", 1_000, &NoFaults)
            .unwrap();
        let path = "notes/seed-conflict.md";
        seed_text_head(&mut engine, "seed-conflict", path, "local seed");
        let key = DocKey::new("ws", "main", "seed-conflict").unwrap();
        let local = Ydoc::wire();
        local.richdoc_append_paragraph("local seed");
        let base = local.encode_full_state();
        dohc_engine_collab::claim_base_at_relay(
            &mut engine,
            &key,
            ContentKind::Richdoc,
            &base,
            &dohc_engine_collab::BaseRelayCoordinate::new("local", 0, 20).unwrap(),
            &NoFaults,
            1_100,
        )
        .unwrap();
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_docs SET seed_source_sha256=?1 WHERE object_id='seed-conflict'",
                    [dohc_engine_storage::hex_sha256(b"local seed")],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .unwrap();
        let edit = local.richdoc_append_paragraph("unsaved local edit");
        dohc_engine_collab::apply_remote_update(
            &mut engine,
            &mut WriterDocCache::new(),
            &key,
            &dohc_engine_collab::RemoteUpdate {
                origin_id: "local".into(),
                origin_seq: 1,
                bytes: edit,
            },
            None,
            None,
            &NoFaults,
            1_200,
        )
        .unwrap();
        let remote = Ydoc::wire();
        remote.richdoc_append_paragraph("remote seed");
        let claim = engine.put_binary_blob(&remote.encode_full_state()).unwrap();
        let mut base_op = envelope(
            "remote",
            0,
            "ydoc.update",
            json!({
                "versionId": "main", "objectId": key.object_id, "path": path,
                "contentKind": "richdoc", "updateBlobSha256": claim,
                "lineageClaimId": claim, "isBaseState": true,
            }),
        );
        base_op.relay_seq = Some(10);
        let leases: &dyn LeaseProbe = if deferred { &AlwaysLive } else { &NoLiveLeases };
        let outcome = apply_ydoc_envelope(
            &mut engine,
            &mut WriterDocCache::new(),
            &base_op,
            &NoFaults,
            leases,
        )
        .unwrap();
        let ApplyDisposition::Applied(result) = outcome.primary else {
            panic!("base did not apply")
        };
        if deferred {
            assert!(result.deferred);
            let drained = drain_deferred_ydoc_for_key(
                &mut engine,
                &mut WriterDocCache::new(),
                &key,
                &NoFaults,
            )
            .unwrap();
            assert!(drained.lineage_replacements[0].recovered_paths.is_empty());
        } else {
            assert_eq!(result.conflicts_opened, 1);
            assert!(
                result
                    .lineage_replacement
                    .unwrap()
                    .recovered_paths
                    .is_empty()
            );
        }
        assert_eq!(
            crate::ydoc_apply::redelivered_conflicts_opened(&engine, &base_op).unwrap(),
            1
        );
        assert!(
            crate::ydoc_apply::redelivered_materialization_changes(&engine, &base_op)
                .unwrap()
                .iter()
                .any(|change| change.path == path)
        );
        let sides = |engine: &EngineStore| {
            engine
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT c.text,i.text,h.text,(SELECT COUNT(*) FROM ydoc_recovery_decisions)
                FROM conflicts f JOIN blobs c ON c.sha256=f.current_blob_sha256
                JOIN blobs i ON i.sha256=f.incoming_blob_sha256
                JOIN snapshots s ON s.object_id=f.current_object_id
                JOIN blobs h ON h.sha256=s.blob_sha256 WHERE f.status='open'",
                        [],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, i64>(3)?,
                            ))
                        },
                    )
                })
                .unwrap()
        };
        let (current, incoming, head, recoveries) = sides(&engine);
        assert!(current.contains("local seed") && current.contains("unsaved local edit"));
        assert_eq!(head, current);
        assert!(incoming.contains("remote seed"));
        assert_eq!(recoveries, 0);
        let delta = remote.richdoc_append_paragraph("remote edit");
        let sha = engine.put_binary_blob(&delta).unwrap();
        let mut delta_op = envelope(
            "remote",
            1,
            "ydoc.update",
            json!({
                "versionId": "main", "objectId": key.object_id, "path": path,
                "contentKind": "richdoc", "updateBlobSha256": sha,
                "lineageClaimId": claim, "isBaseState": false,
            }),
        );
        delta_op.relay_seq = Some(11);
        apply_ydoc_envelope(
            &mut engine,
            &mut WriterDocCache::new(),
            &delta_op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        let after = sides(&engine);
        assert_eq!(after.0, current);
        assert!(after.1.contains("remote seed") && after.1.contains("remote edit"));
        assert_eq!(after.2, current);
        let replay = apply_ydoc_envelope(
            &mut engine,
            &mut WriterDocCache::new(),
            &base_op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(matches!(replay.primary, ApplyDisposition::Skipped));
        assert_eq!(sides(&engine), after);
        resolve_seed_conflict(&mut engine, &key, deferred);
        let chosen = VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", path)
            .unwrap()
            .unwrap();
        assert_eq!(chosen.text, if deferred { after.0 } else { after.1 });
    }
}

fn changed_paths_of(changes: &[crate::MomentMaterializationChange]) -> Vec<String> {
    let mut paths: Vec<String> = changes.iter().map(|change| change.path.clone()).collect();
    paths.sort();
    paths
}

#[test]
fn an_ingress_drains_recovered_sibling_and_head_reach_its_drain_report_once() {
    for stopped_first in [false, true] {
        ingress_drain_reports_its_sibling(stopped_first);
    }
}

fn ingress_drain_reports_its_sibling(stopped_first: bool) {
    use dohc_engine_collab::{ContentKind, DocKey, WriterDocCache, Ydoc};
    const HEAD: &str = "notes/arbitrated.md";
    let (_scratch, store_path, mut engine) = open_store();
    seed_identity(&mut engine);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO sync_relay_cursors \
                 (workspace_id,cursor,replication_epoch,stream_identity) \
                 VALUES ('ws','0','epoch-1','stream-1')",
                [],
            )
            .map_err(SyncError::persist)
        })
        .expect("relay contact");
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    seed_text_head(&mut engine, "object-arbitrated", HEAD, "losing draft");
    let key = DocKey::new("ws", "main", "object-arbitrated").expect("doc key");
    let loser = Ydoc::wire();
    loser.plaintext_insert(0, "losing draft");
    dohc_engine_collab::claim_base_at_relay(
        &mut engine,
        &key,
        ContentKind::Plaintext,
        &loser.encode_full_state(),
        &dohc_engine_collab::BaseRelayCoordinate::new("loser", 0, 20).expect("coordinate"),
        &NoFaults,
        1_100,
    )
    .expect("claim the losing base");
    engine
        .write_with(&NoFaults, |tx| {
            crate::ydoc_apply::project_and_write_in_tx(
                tx,
                &key,
                HEAD,
                &loser,
                ContentKind::Plaintext,
                "loser",
                0,
                1_100,
                None,
                None,
            )
        })
        .expect("settle the losing base projection");
    dohc_engine_collab::apply_remote_update(
        &mut engine,
        &mut WriterDocCache::new(),
        &key,
        &dohc_engine_collab::RemoteUpdate {
            origin_id: "loser".to_owned(),
            origin_seq: 1,
            bytes: loser.plaintext_insert(12, " plus edit"),
        },
        None,
        None,
        &NoFaults,
        1_150,
    )
    .expect("the losing lineage's unsettled edit");
    // An external head that matches neither the losing side nor its last
    // settled text, so the base's replacement needs three copies.
    engine
        .write_with(&NoFaults, |tx| {
            let sha = dohc_engine_storage::hex_sha256(b"relay winner");
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,12,'relay winner')",
                [&sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "UPDATE snapshots SET blob_sha256=?1 WHERE object_id='object-arbitrated'",
                [&sha],
            )
            .map_err(SyncError::persist)
        })
        .expect("a third copy from an external editor");
    let winner = Ydoc::wire();
    winner.plaintext_insert(0, "relay winner");
    let winner_claim = engine
        .put_binary_blob(&winner.encode_full_state())
        .expect("winner blob");
    // A real delta queues behind the base, so the drain's head differs from
    // the external head and is written.
    let queued_delta = winner.plaintext_insert(12, " queued");
    let queued_sha = engine
        .put_binary_blob(&queued_delta)
        .expect("queued delta blob");
    for (seq, relay_seq, sha, is_base) in
        [(0, 10, &winner_claim, true), (1, 11, &queued_sha, false)]
    {
        let mut queued = envelope(
            "winner",
            seq,
            "ydoc.update",
            json!({
                "versionId": "main", "objectId": "object-arbitrated", "path": HEAD,
                "contentKind": "plaintext", "updateBlobSha256": sha,
                "lineageClaimId": winner_claim, "isBaseState": is_base
            }),
        );
        queued.relay_seq = Some(relay_seq);
        apply_ydoc_envelope(
            &mut engine,
            &mut WriterDocCache::new(),
            &queued,
            &NoFaults,
            &AlwaysLive,
        )
        .expect("queue the winning base and delta");
    }
    let siblings = |engine: &EngineStore| -> Vec<(String, String)> {
        engine
            .read_with(|conn| {
                let mut statement = conn.prepare(
                    "SELECT object_id,path FROM snapshots \
                     WHERE path<>?1 AND path LIKE 'notes/arbitrated%' ORDER BY path",
                )?;
                statement
                    .query_map([HEAD], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .expect("siblings")
    };

    let mut stopped_siblings = None;
    if stopped_first {
        let (stopped, _cleanup) = crate::drain_deferred_ydoc_for_key_holding_cleanup(
            &mut engine,
            &mut WriterDocCache::new(),
            &key,
            &NoFaults,
        )
        .expect("stopped drain");
        assert_eq!(stopped.lineage_replacements.len(), 1, "{stopped:?}");
        stopped_siblings = Some(siblings(&engine));
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE materialization_jobs SET status='complete',completed_at_ms=0 \
                     WHERE status='pending'",
                    [],
                )
                .map_err(SyncError::persist)
            })
            .expect("the files are written");
        drop(engine);
        engine = EngineStore::open(&store_path, 3_000).expect("reopen");
    }

    let later = winner.plaintext_insert(19, " later");
    let later_sha = engine.put_binary_blob(&later).expect("later blob");
    let mut incoming = envelope(
        "winner",
        2,
        "ydoc.update",
        json!({
            "versionId": "main", "objectId": "object-arbitrated", "path": HEAD,
            "contentKind": "plaintext", "updateBlobSha256": later_sha,
            "lineageClaimId": winner_claim, "isBaseState": false
        }),
    );
    incoming.relay_seq = Some(12);
    let outcome = crate::ydoc_apply::apply_ydoc_envelope_in_batch(
        &mut engine,
        &mut WriterDocCache::new(),
        &incoming,
        &NoFaults,
        &NoLiveLeases,
        true,
        None,
        &Default::default(),
    )
    .expect("the envelope's ingress");
    let ApplyDisposition::Applied(applied) = outcome.primary else {
        panic!("stopped_first={stopped_first}: the envelope applies");
    };
    let recovered = applied
        .lineage_replacement
        .expect("the drained base replaced the lineage")
        .recovered_paths;
    assert_eq!(recovered.len(), 1, "stopped_first={stopped_first}");
    let mut expected = vec![HEAD.to_owned(), recovered[0].clone()];
    expected.sort();
    if let Some(stopped) = stopped_siblings {
        assert_eq!(siblings(&engine), stopped, "one sibling, the same one");
    }
    assert_eq!(siblings(&engine).len(), 1);

    let mut first = None;
    let claimed = crate::drain_report::claim(&mut engine, "ws", &mut first, &NoFaults)
        .expect("claim the drain reports");
    assert_eq!(
        changed_paths_of(&claimed.extras.changes),
        expected,
        "stopped_first={stopped_first}: {claimed:?}"
    );
    assert_eq!(claimed.extras.conflicts_opened, 0);
    let mut second = None;
    let again =
        crate::drain_report::claim(&mut engine, "ws", &mut second, &NoFaults).expect("claim again");
    assert_eq!(changed_paths_of(&again.extras.changes), expected);
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
            .changes
            .is_empty()
    );
}

#[test]
fn a_replayed_conflict_opening_base_reports_its_conflict_once() {
    use dohc_engine_collab::{ContentKind, DocKey, WriterDocCache, Ydoc};
    let path = "notes/replayed-conflict.md";
    let (_scratch, store_path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .unwrap();
    seed_text_head(&mut engine, "replayed-conflict", path, "local seed");
    let key = DocKey::new("ws", "main", "replayed-conflict").unwrap();
    let local = Ydoc::wire();
    local.richdoc_append_paragraph("local seed");
    dohc_engine_collab::claim_base_at_relay(
        &mut engine,
        &key,
        ContentKind::Richdoc,
        &local.encode_full_state(),
        &dohc_engine_collab::BaseRelayCoordinate::new("local", 0, 20).unwrap(),
        &NoFaults,
        1_100,
    )
    .unwrap();
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_docs SET seed_source_sha256=?1 WHERE object_id='replayed-conflict'",
                [dohc_engine_storage::hex_sha256(b"local seed")],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    dohc_engine_collab::apply_remote_update(
        &mut engine,
        &mut WriterDocCache::new(),
        &key,
        &dohc_engine_collab::RemoteUpdate {
            origin_id: "local".into(),
            origin_seq: 1,
            bytes: local.richdoc_append_paragraph("unsaved local edit"),
        },
        None,
        None,
        &NoFaults,
        1_200,
    )
    .unwrap();
    let remote = Ydoc::wire();
    remote.richdoc_append_paragraph("remote seed");
    let claim = engine.put_binary_blob(&remote.encode_full_state()).unwrap();
    let mut base_op = envelope(
        "remote",
        0,
        "ydoc.update",
        json!({
            "versionId": "main", "objectId": key.object_id, "path": path,
            "contentKind": "richdoc", "updateBlobSha256": claim,
            "lineageClaimId": claim, "isBaseState": true,
        }),
    );
    base_op.relay_seq = Some(10);
    apply_ydoc_envelope(
        &mut engine,
        &mut WriterDocCache::new(),
        &base_op,
        &NoFaults,
        &AlwaysLive,
    )
    .unwrap();
    let state = |engine: &EngineStore| -> (i64, i64, i64, i64) {
        engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT (SELECT COUNT(*) FROM conflicts), \
                       (SELECT COUNT(*) FROM moments WHERE object_id<>'replayed-conflict'), \
                       (SELECT COUNT(*) FROM snapshots), \
                       (SELECT COUNT(*) FROM ydoc_deferred_updates)",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
            })
            .unwrap()
    };
    let (stopped, _cleanup) = crate::drain_deferred_ydoc_for_key_holding_cleanup(
        &mut engine,
        &mut WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .unwrap();
    assert_eq!(stopped.conflicts_opened, 1);
    let (conflicts, others, snapshots, queued) = state(&engine);
    assert_eq!((conflicts, queued), (1, 1), "the base's row stays queued");
    drop(engine);
    let mut engine = EngineStore::open(&store_path, 3_000).unwrap();

    let later = remote.richdoc_append_paragraph("remote later");
    let later_sha = engine.put_binary_blob(&later).unwrap();
    let mut incoming = envelope(
        "remote",
        1,
        "ydoc.update",
        json!({
            "versionId": "main", "objectId": key.object_id, "path": path,
            "contentKind": "richdoc", "updateBlobSha256": later_sha,
            "lineageClaimId": claim, "isBaseState": false,
        }),
    );
    incoming.relay_seq = Some(11);
    let outcome = crate::ydoc_apply::apply_ydoc_envelope_in_batch(
        &mut engine,
        &mut WriterDocCache::new(),
        &incoming,
        &NoFaults,
        &NoLiveLeases,
        true,
        None,
        &Default::default(),
    )
    .unwrap();
    let ApplyDisposition::Applied(applied) = outcome.primary else {
        panic!("the envelope applies");
    };
    assert_eq!(applied.conflicts_opened, 0, "the report counts it");
    let claimed = crate::drain_report::claim(&mut engine, "ws", &mut None, &NoFaults).unwrap();
    assert_eq!(claimed.extras.conflicts_opened, 1, "{claimed:?}");
    assert_eq!(
        state(&engine),
        (conflicts, others, snapshots, 0),
        "no conflict, recovered copy or snapshot twice"
    );
}

fn resolve_seed_conflict(
    engine: &mut EngineStore,
    key: &dohc_engine_collab::DocKey,
    keep_current: bool,
) {
    resolve_seed_conflict_with_faults(
        engine,
        key,
        keep_current,
        &NoFaults,
        false,
        "resolved-seed",
        10_000,
    );
}

fn resolve_seed_conflict_with_faults(
    engine: &mut EngineStore,
    key: &dohc_engine_collab::DocKey,
    keep_current: bool,
    faults: &dyn dohc_engine_storage::FaultInjector,
    crash_after_commit: bool,
    write_moment_id: &str,
    now_ms: i64,
) {
    use dohc_engine_domain::{ResolveConflictKind, ResolveTextConflict};
    let conflict_id = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT conflict_id FROM conflicts WHERE status='open'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    let input = ResolveTextConflict {
        workspace_id: key.workspace_id.clone(),
        conflict_id,
        resolution: if keep_current {
            ResolveConflictKind::KeepCurrent
        } else {
            ResolveConflictKind::ApplyIncoming
        },
        object_id: key.object_id.clone(),
        write_moment_id: write_moment_id.into(),
        delete_moment_id: "resolved-seed-delete".into(),
        metadata_origin: "sync".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
        conflict_answer_budget_bytes: usize::MAX,
    };
    let map_error = |error| {
        dohc_engine_domain::DomainError::Storage(dohc_engine_storage::StorageError::corrupt_public(
            error,
        ))
    };
    let result = VersionedTextStore::new(engine).resolve_text_conflict_with(
        &input,
        faults,
        |tx, conflict, _| {
            crate::prepare_local_conflict_resolve_v1_in_tx(tx, &input, conflict).map_err(map_error)
        },
        |tx, result, prepared| {
            crate::commit_local_conflict_resolve_v1_in_tx(tx, &prepared, result).map_err(map_error)
        },
    );
    if crash_after_commit {
        assert!(
            result.is_err(),
            "the committed resolution must lose its acknowledgement"
        );
        return;
    }
    let result = result.expect("either version-conflict choice must resolve");
    assert_eq!(
        result.conflict.status,
        dohc_engine_domain::ConflictStatus::Resolved
    );
}

fn seed_resolution_head(store: &mut EngineStore, object: &str, path: &str, text: &str) {
    use dohc_engine_domain::WriteText;
    VersionedTextStore::new(store)
        .write_text(
            &WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: object.into(),
                path: path.into(),
                text: text.into(),
                moment_id: format!("seed-{}", dohc_engine_storage::hex_sha256(text.as_bytes())),
                metadata_origin: "sync".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
}

fn copy_seed_blobs(source: &EngineStore, target: &mut EngineStore) {
    let text: Vec<(String, String)> = source
        .read_with(|conn| {
            conn.prepare("SELECT sha256,text FROM blobs")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<_, _>>()
        })
        .unwrap();
    let binary: Vec<Vec<u8>> = source
        .read_with(|conn| {
            conn.prepare("SELECT bytes FROM binary_blobs")?
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()
        })
        .unwrap();
    target
        .write_with(&NoFaults, |tx| {
            for bytes in binary {
                dohc_engine_storage::blob::put_binary_blob(tx, &bytes)?;
            }
            for (sha, text) in text {
                tx.execute(
                    "INSERT OR IGNORE INTO blobs(sha256,byte_length,text) VALUES (?1,?2,?3)",
                    params![sha, text.len() as i64, text],
                )
                .map_err(SyncError::persist)?;
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

fn seed_resolution_ops(store: &EngineStore, origin: &str) -> Vec<ReplicationEnvelope> {
    let rows: Vec<(String,String,i64)> = store.read_with(|conn| {
        conn.prepare("SELECT op_kind,payload_json,recorded_at_ms FROM replication_pending_conflict_ops ORDER BY bundle_order,op_index")?
            .query_map([], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?.collect::<Result<_,_>>()
    }).unwrap();
    assert!(!rows.is_empty());
    rows.into_iter()
        .enumerate()
        .map(|(seq, (kind, payload, at))| {
            let mut op = envelope(
                origin,
                seq as i64,
                &kind,
                serde_json::from_str(&payload).unwrap(),
            );
            op.recorded_at_ms = at;
            op
        })
        .collect()
}

#[test]
fn seed_resolution_converges_on_both_peers_in_both_delivery_orders_after_restart() {
    use dohc_engine_collab::{ContentKind, DocKey, WriterDocCache, Ydoc};
    for keep_current in [false, true] {
        for resolve_first in [false, true] {
            let (_a_scratch, a_path, mut a) = open_store();
            let (_b_scratch, _b_path, mut b) = open_store();
            let key = DocKey::new("ws", "main", "two-seeds").unwrap();
            let path = "notes/two-seeds.md";
            let a_doc = Ydoc::wire();
            a_doc.plaintext_insert(0, "local seed");
            let b_doc = Ydoc::wire();
            b_doc.plaintext_insert(0, "remote seed");
            let a_bytes = a_doc.encode_full_state();
            let b_bytes = b_doc.encode_full_state();
            let mut bases = Vec::new();
            for (store, doc, origin, relay, text) in [
                (&mut a, &a_bytes, "loser", 20, "local seed"),
                (&mut b, &b_bytes, "winner", 10, "remote seed"),
            ] {
                seed_identity(store);
                VersionedTextStore::new(store)
                    .ensure_main_version("ws", "main", 1000, &NoFaults)
                    .unwrap();
                seed_resolution_head(store, &key.object_id, path, text);
                dohc_engine_collab::claim_base_at_relay(
                    store,
                    &key,
                    ContentKind::Plaintext,
                    doc,
                    &dohc_engine_collab::BaseRelayCoordinate::new(origin, 0, relay).unwrap(),
                    &NoFaults,
                    1100,
                )
                .unwrap();
                let sha = store.put_binary_blob(doc).unwrap();
                let mut op = envelope(
                    origin,
                    0,
                    "ydoc.update",
                    json!({
                        "versionId":"main","objectId":key.object_id,"path":path,"contentKind":"plaintext",
                        "updateBlobSha256":sha,"lineageClaimId":sha,"isBaseState":true
                    }),
                );
                op.relay_seq = Some(relay);
                bases.push(op);
            }
            copy_seed_blobs(&b, &mut a);
            copy_seed_blobs(&a, &mut b);
            apply_ydoc_envelope(
                &mut a,
                &mut WriterDocCache::new(),
                &bases[1],
                &NoFaults,
                &NoLiveLeases,
            )
            .unwrap();
            if !resolve_first {
                apply_ydoc_envelope(
                    &mut b,
                    &mut WriterDocCache::new(),
                    &bases[0],
                    &NoFaults,
                    &NoLiveLeases,
                )
                .unwrap();
            }
            resolve_seed_conflict_with_faults(
                &mut a,
                &key,
                keep_current,
                ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck).as_ref(),
                true,
                "resolved-seed",
                10_000,
            );
            drop(a);
            let mut a = EngineStore::open(&a_path, 11000).unwrap();
            let ops = seed_resolution_ops(&a, "resolver");
            copy_seed_blobs(&a, &mut b);
            for op in &ops {
                let outcome = crate::apply_replication_envelope(
                    &mut b,
                    &mut WriterDocCache::new(),
                    op,
                    &NoFaults,
                    &NoLiveLeases,
                )
                .unwrap();
                assert!(
                    matches!(outcome.primary, ApplyDisposition::Applied(_)),
                    "{outcome:?}"
                );
                assert!(outcome.refusals.is_empty());
            }
            if resolve_first {
                apply_ydoc_envelope(
                    &mut b,
                    &mut WriterDocCache::new(),
                    &bases[0],
                    &NoFaults,
                    &NoLiveLeases,
                )
                .unwrap();
            }
            for op in &ops {
                let outcome = crate::apply_replication_envelope(
                    &mut b,
                    &mut WriterDocCache::new(),
                    op,
                    &NoFaults,
                    &NoLiveLeases,
                )
                .unwrap();
                assert!(matches!(outcome.primary, ApplyDisposition::Skipped));
            }
            assert_eq!(
                dohc_engine_collab::read_marker(&a, &key)
                    .unwrap()
                    .unwrap()
                    .lineage_claim_id,
                dohc_engine_collab::read_marker(&b, &key)
                    .unwrap()
                    .unwrap()
                    .lineage_claim_id
            );
            for store in [&a, &b] {
                let (text,conflicts):(String,i64)=store.read_with(|conn| conn.query_row(
                    "SELECT b.text,(SELECT COUNT(*) FROM conflicts WHERE status='open') FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.object_id='two-seeds'", [],
                    |row| Ok((row.get(0)?,row.get(1)?)))).unwrap();
                assert_eq!(
                    text,
                    if keep_current {
                        "local seed"
                    } else {
                        "remote seed"
                    }
                );
                assert_eq!(conflicts, 0);
            }

            assert_seed_heads_and_delete_converge(&mut a, &mut b, &key, path);
        }
    }
}

fn assert_seed_heads_and_delete_converge(
    a: &mut EngineStore,
    b: &mut EngineStore,
    key: &dohc_engine_collab::DocKey,
    path: &str,
) {
    let head = |store: &EngineStore| {
        store.read_with(|conn| conn.query_row("SELECT latest_moment_id FROM snapshots WHERE workspace_id='ws' AND object_id=?1",[&key.object_id],|row| row.get::<_,String>(0))).unwrap()
    };
    assert_eq!(head(a), head(b), "resolution adopts the same history head");
    VersionedTextStore::new(a)
        .delete_text_file(
            &DeleteTextFile {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                path: path.into(),
                moment_id: "after-resolution-delete".into(),
                request_id: None,
                metadata_origin: "sync".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 12_000,
            },
            &NoFaults,
        )
        .unwrap();
    let payload = a
        .write_with(&NoFaults, |tx| {
            crate::outbound::moment_append_payload_in_tx(tx, "ws", "after-resolution-delete")
        })
        .unwrap();
    let TxnOutcome::Committed((payload, at)) = payload else {
        panic!("delete payload")
    };
    let mut op = envelope("after-resolution", 0, "moment.append", payload);
    op.recorded_at_ms = at;
    let result = crate::apply_replication_envelope(
        b,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    assert!(
        matches!(result.primary, ApplyDisposition::Applied(_)),
        "{result:?}"
    );
    let (heads, conflicts): (i64, i64) = b
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE object_id=?1",
                    [&key.object_id],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM conflicts WHERE status='open'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .unwrap();
    assert_eq!((heads, conflicts), (0, 0));
}
fn prepare_unpublished_lineage(
    engine: &mut EngineStore,
    key: &dohc_engine_collab::DocKey,
    live: bool,
) {
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) VALUES (?1, ?2, 1100)",
                rusqlite::params![key.workspace_id, key.object_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .unwrap();
    dohc_engine_collab::ensure_marker(
        engine,
        key,
        dohc_engine_collab::ContentKind::Plaintext,
        if live {
            dohc_engine_collab::Regime::Replicated
        } else {
            dohc_engine_collab::Regime::LocalOnly
        },
        &NoFaults,
        1_100,
    )
    .unwrap();
}

#[test]
fn local_unpublished_authors_survive_compaction_base_replacement_and_local_choice() {
    use dohc_engine_collab::{DocKey, LocalAppend, WriterDocCache, Ydoc};
    use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
    for deferred in [false, true] {
        for external_head in [false, true] {
            let (_scratch, _db, mut engine) = open_store();
            VersionedTextStore::new(&mut engine)
                .ensure_main_version("ws", "main", 1_000, &NoFaults)
                .unwrap();
            let path = "notes/retained-author.md";
            let key = DocKey::new("ws", "main", "retained-author").unwrap();
            if external_head {
                seed_text_head(&mut engine, &key.object_id, path, "external head");
            }
            prepare_unpublished_lineage(&mut engine, &key, deferred);
            let local = Ydoc::wire();
            let edit = local.plaintext_insert(0, "Bob's local edit");
            let attribution = ChangeAttribution {
                actor_kind: ChangeActorKind::Agent,
                on_behalf_of: None,
                depth: 0,
                run: None,
                agent_run_id: None,
            };
            dohc_engine_collab::record_local_update(
                &mut engine,
                &mut WriterDocCache::new(),
                &key,
                &edit,
                LocalAppend {
                    actor_origin_id: Some("bob"),
                    attribution: Some(&attribution),
                    ensure_parent_row: true,
                    ..Default::default()
                },
                &NoFaults,
                1_200,
                |_, _, _| Ok(()),
            )
            .unwrap();
            dohc_engine_collab::maybe_compact(&mut engine, &key, 0, &NoFaults, 1_250).unwrap();
            let remote = Ydoc::wire();
            remote.plaintext_insert(0, "remote content");
            let sha = engine.put_binary_blob(&remote.encode_full_state()).unwrap();
            let mut op = envelope(
                "remote",
                0,
                "ydoc.update",
                json!({
                    "versionId":"main", "objectId":key.object_id, "path":path,
                    "contentKind":"plaintext", "updateBlobSha256":sha,
                    "lineageClaimId":sha, "isBaseState":true,
                }),
            );
            op.relay_seq = Some(10);
            apply_ydoc_envelope(
                &mut engine,
                &mut WriterDocCache::new(),
                &op,
                &NoFaults,
                if deferred { &AlwaysLive } else { &NoLiveLeases },
            )
            .unwrap();
            if deferred {
                drain_deferred_ydoc_for_key(
                    &mut engine,
                    &mut WriterDocCache::new(),
                    &key,
                    &NoFaults,
                )
                .unwrap();
            }
            let authors: String = engine
                .read_with(|conn| {
                    conn.query_row(
                "SELECT m.author_json FROM moments m JOIN blobs b ON b.sha256=m.after_blob_sha256 \
                 WHERE m.workspace_id='ws' AND b.text='Bob''s local edit'",
                [], |row| row.get(0))
                })
                .unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&authors).unwrap()[0]["agentId"],
                "bob"
            );
            let pending: String = engine
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT pending_authors_json FROM ydoc_docs WHERE object_id=?1",
                        [&key.object_id],
                        |row| row.get(0),
                    )
                })
                .unwrap();
            assert_eq!(
                pending, "[]",
                "the winning lineage does not inherit the losing author"
            );
            if !external_head {
                resolve_seed_conflict(&mut engine, &key, true);
                let kept = VersionedTextStore::new(&mut engine)
                    .read_text("ws", "main", path)
                    .unwrap()
                    .unwrap();
                assert_eq!(kept.text, "Bob's local edit");
                let credited: i64 = engine
                    .read_with(|conn| {
                        conn.query_row(
                            "SELECT COUNT(*) FROM moments WHERE author_json=?1",
                            [&authors],
                            |row| row.get(0),
                        )
                    })
                    .unwrap();
                assert_eq!(
                    credited, 1,
                    "choosing the preserved side keeps its original author moment"
                );
            } else {
                let author_snapshot: String = engine
                    .read_with(|conn| {
                        conn.query_row(
                            "SELECT recovery_author_json FROM ydoc_recovery_decisions",
                            [],
                            |row| row.get(0),
                        )
                    })
                    .unwrap();
                assert_eq!(author_snapshot, authors);
                let replay = apply_ydoc_envelope(
                    &mut engine,
                    &mut WriterDocCache::new(),
                    &op,
                    &NoFaults,
                    &NoLiveLeases,
                )
                .unwrap();
                assert!(matches!(replay.primary, ApplyDisposition::Skipped));
            }
        }
    }
}

#[test]
fn plain_owner_drain_keeps_declared_agent() {
    use dohc_engine_collab::{ContentKind, DocKey, WriterDocCache, Ydoc};
    let (_scratch, _db, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .unwrap();
    let path = "notes/agent.md";
    let key = DocKey::new("ws", "main", "agent-drain").unwrap();
    seed_text_head(&mut engine, &key.object_id, path, "seed");
    let source = Ydoc::wire();
    source.plaintext_insert(0, "seed");
    let base = source.encode_full_state();
    let claim = dohc_engine_storage::hex_sha256(&base);
    dohc_engine_collab::claim_base_at_relay(
        &mut engine,
        &key,
        ContentKind::Plaintext,
        &base,
        &dohc_engine_collab::BaseRelayCoordinate::new("source", 0, 0).unwrap(),
        &NoFaults,
        1_100,
    )
    .unwrap();
    for seq in 0..2 {
        let update = source.plaintext_insert(0, "x");
        let sha = engine.put_binary_blob(&update).unwrap();
        let mut op = envelope(
            "computer-a",
            seq,
            "ydoc.update",
            json!({
                "versionId":"main", "objectId":key.object_id, "path":path,
                "contentKind":"plaintext", "updateBlobSha256":sha,
                "lineageClaimId":claim, "isBaseState":false,
                "actorOriginId":"agent-x", "attribution":{"actorKind":"agent","depth":0},
                "authors":[{"kind":"human","humanId":"forged-recipient"}],
            }),
        );
        op.relay_seq = Some(seq + 1);
        let parked = apply_ydoc_envelope(
            &mut engine,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &AlwaysLive,
        )
        .unwrap();
        assert!(matches!(parked.primary, ApplyDisposition::Applied(result) if result.deferred));
    }
    let drained =
        drain_deferred_ydoc_for_key(&mut engine, &mut WriterDocCache::new(), &key, &NoFaults)
            .unwrap();
    assert_eq!(drained.drained, 2);
    let head = VersionedTextStore::new(&mut engine)
        .read_text("ws", "main", path)
        .unwrap()
        .unwrap();
    assert_eq!(head.text, "xxseed");
    let moment = VersionedTextStore::new(&mut engine)
        .get_moment("ws", &head.latest_moment_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(moment.author_json.as_deref().unwrap()).unwrap(),
        json!([{"kind":"agent","agentId":"agent-x"}])
    );
}

/// `refuses` is `[without final newline, with final newline]`. A refused fold
/// keeps the file's exact bytes and the seeded body.
fn assert_desktop_frontmatter_fold(index: usize, refuses: [bool; 2]) {
    use base64::Engine;
    let rows: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../../tools/rust-engine-program/nested1b-desktop-folds.json"
    ))
    .unwrap();
    let row = &rows[index];
    let source = row["source"].as_str().unwrap();
    let base = base64::engine::general_purpose::STANDARD
        .decode(row["desktopBase64"].as_str().unwrap())
        .unwrap();
    // The seed reads both files as the same body; the engine writes the second.
    let forms = [source.to_owned(), format!("{source}\n")];
    for (initial, refuses) in forms.iter().zip(refuses) {
        assert_peer_fold_with_base(
            initial,
            &initial.replace("todo", "done"),
            refuses,
            None,
            false,
            Some(&base),
        );
    }
}

#[test]
fn nested1b_desktop_frontmatter_link() {
    // Only the engine's own form folds; the file without it is held.
    assert_desktop_frontmatter_fold(0, [true, false]);
}
#[test]
fn nested1b_desktop_frontmatter_setext_holds() {
    assert_desktop_frontmatter_fold(6, [true, true]);
}
