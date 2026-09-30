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
fn lower_relay_base_recovers_a_third_copy_as_one_ordinary_sibling() {
    let (_scratch, _path, mut engine) = open_store();
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
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    seed_text_head(
        &mut engine,
        "object-arbitrated",
        "notes/arbitrated.md",
        "losing draft",
    );
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-arbitrated").expect("doc key");
    let loser = dohc_engine_collab::Ydoc::wire();
    loser.plaintext_insert(0, "losing draft");
    let loser_bytes = loser.encode_full_state();
    let loser_claim = dohc_engine_storage::hex_sha256(&loser_bytes);
    let loser_coordinate =
        dohc_engine_collab::BaseRelayCoordinate::new("loser", 0, 20).expect("coordinate");
    assert!(matches!(
        dohc_engine_collab::claim_base_at_relay(
            &mut engine,
            &key,
            dohc_engine_collab::ContentKind::Plaintext,
            &loser_bytes,
            &loser_coordinate,
            &NoFaults,
            1_100,
        ),
        Ok(TxnOutcome::Committed(
            dohc_engine_collab::ClaimOutcome::Claimed { .. }
        ))
    ));
    engine
        .write_with(&NoFaults, |tx| {
            crate::ydoc_apply::project_and_write_in_tx(
                tx,
                &key,
                "notes/arbitrated.md",
                &loser,
                dohc_engine_collab::ContentKind::Plaintext,
                "loser",
                0,
                1_100,
                None,
            )
        })
        .expect("settle the losing base projection");
    let loser_delta = loser.plaintext_insert(12, " plus edit");
    assert!(matches!(
        dohc_engine_collab::apply_remote_update(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &dohc_engine_collab::RemoteUpdate {
                origin_id: "loser".to_owned(),
                origin_seq: 1,
                bytes: loser_delta,
            },
            None,
            None,
            &NoFaults,
            1_150,
        )
        .map(|applied| applied.outcome),
        Ok(TxnOutcome::Committed(
            dohc_engine_collab::ReplicationApplyOutcome::Applied { .. }
        ))
    ));
    engine
        .write_with(&NoFaults, |tx| {
            let sha = dohc_engine_storage::hex_sha256(b"external edit");
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,13,'external edit')",
                [&sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "UPDATE snapshots SET blob_sha256=?1 WHERE object_id='object-arbitrated'",
                [&sha],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("a third copy from an external editor");
    let recovery_projection = dohc_engine_storage::hex_sha256(b"losing draft plus edit");
    let occupied_first_recovery = format!(
        "notes/arbitrated (recovered {} {recovery_projection}).md",
        &loser_claim[..8]
    );
    seed_text_head(
        &mut engine,
        "unrelated-recovery-occupant",
        &occupied_first_recovery,
        "unrelated occupant",
    );

    let winner = dohc_engine_collab::Ydoc::wire();
    winner.plaintext_insert(0, "relay winner");
    let winner_bytes = winner.encode_full_state();
    let winner_claim = engine.put_binary_blob(&winner_bytes).expect("winner blob");
    let mut incoming = envelope(
        "winner",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-arbitrated",
            "path": "notes/arbitrated.md",
            "contentKind": "plaintext",
            "updateBlobSha256": winner_claim,
            "lineageClaimId": winner_claim,
            "isBaseState": true
        }),
    );
    incoming.relay_seq = Some(10);
    let applied = apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &incoming,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("winning base applies");
    let ApplyOutcome {
        primary: ApplyDisposition::Applied(result),
        refusals: ref outcome_refusals,
        sharing_declined: ref outcome_sharing_declined,
    } = applied
    else {
        panic!("winning base did not apply: {applied:?}");
    };
    assert!(outcome_refusals.is_empty());
    assert!(outcome_sharing_declined.is_empty());
    let replacement = result.lineage_replacement.expect("replacement result");
    assert_eq!(replacement.winner_lineage_claim_id, winner_claim);
    assert_eq!(replacement.recovered_paths.len(), 1);
    assert_eq!(
        replacement.recovered_paths[0],
        format!(
            "notes/arbitrated (recovered {} {recovery_projection} 2).md",
            &loser_claim[..8]
        )
    );

    let state: (String, String, String, String, i64, i64, i64, i64, i64, i64) = engine
        .read_with(|conn| {
            let original = conn.query_row(
                "SELECT blob.text FROM snapshots snapshot
                 JOIN blobs blob ON blob.sha256=snapshot.blob_sha256
                 WHERE snapshot.workspace_id='ws' AND snapshot.version_id='main'
                   AND snapshot.path='notes/arbitrated.md'",
                [],
                |row| row.get(0),
            )?;
            let recovered = conn.query_row(
                "SELECT blob.text FROM snapshots snapshot
                 JOIN blobs blob ON blob.sha256=snapshot.blob_sha256
                 WHERE snapshot.workspace_id='ws' AND snapshot.version_id='main'
                   AND snapshot.path=?1",
                [&replacement.recovered_paths[0]],
                |row| row.get(0),
            )?;
            let active_claim = conn.query_row(
                "SELECT lineage_claim_id FROM ydoc_docs
                 WHERE workspace_id='ws' AND version_id='main'
                   AND object_id='object-arbitrated'",
                [],
                |row| row.get(0),
            )?;
            let occupant = conn.query_row(
                "SELECT blob.text FROM snapshots snapshot
                 JOIN blobs blob ON blob.sha256=snapshot.blob_sha256
                 WHERE snapshot.workspace_id='ws' AND snapshot.version_id='main'
                   AND snapshot.path=?1",
                [&occupied_first_recovery],
                |row| row.get(0),
            )?;
            let decisions = conn.query_row(
                "SELECT COUNT(*) FROM ydoc_recovery_decisions WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )?;
            let recovery_moments = conn.query_row(
                "SELECT COUNT(*) FROM moments WHERE workspace_id='ws'
                   AND metadata_correlation_id=?1",
                [format!("ydoc-recovery:v1:{loser_claim}")],
                |row| row.get(0),
            )?;
            let conflicts = conn.query_row(
                "SELECT COUNT(*) FROM conflicts WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )?;
            let outbound_moments = conn.query_row(
                "SELECT COUNT(*) FROM replication_log
                 WHERE workspace_id='ws' AND imported=0 AND op_kind='moment.append'",
                [],
                |row| row.get(0),
            )?;
            let recovery_materializations = conn.query_row(
                "SELECT COUNT(*) FROM materialization_jobs
                 WHERE target_path=?1 AND operation='write'",
                [&replacement.recovered_paths[0]],
                |row| row.get(0),
            )?;
            let losing_updates = conn.query_row(
                "SELECT COUNT(*) FROM ydoc_updates
                 WHERE workspace_id='ws' AND version_id='main'
                   AND object_id='object-arbitrated' AND actor_origin_id='loser'",
                [],
                |row| row.get(0),
            )?;
            Ok::<_, rusqlite::Error>((
                original,
                recovered,
                active_claim,
                occupant,
                decisions,
                recovery_moments,
                conflicts,
                outbound_moments,
                recovery_materializations,
                losing_updates,
            ))
        })
        .expect("arbitrated state");
    assert_eq!(state.0, "external edit");
    assert_eq!(state.1, "losing draft plus edit");
    assert_eq!(state.2, winner_claim);
    assert_eq!(state.3, "unrelated occupant");
    assert_eq!(
        (state.4, state.5, state.6, state.7, state.8, state.9),
        (1, 1, 1, 1, 1, 0),
        "the losing delta is preserved in the sibling and purged from the winner"
    );

    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &incoming,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Skipped,
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let counts: (i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM ydoc_recovery_decisions", [], |row| {
                    row.get(0)
                })?,
                conn.query_row(
                    "SELECT COUNT(*) FROM moments
                     WHERE metadata_correlation_id=?1",
                    [format!("ydoc-recovery:v1:{loser_claim}")],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("retry counts");
    assert_eq!(counts, (1, 1), "retry must not duplicate recovery state");

    let recovered_path = replacement.recovered_paths[0].clone();
    let renamed_path = "notes/kept-recovery.md";
    VersionedTextStore::new(&mut engine)
        .rename_text_file(
            &RenameTextFile {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                from_path: recovered_path.clone(),
                to_path: renamed_path.to_owned(),
                moment_id: "rename-recovered-sibling".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2_100,
            },
            &NoFaults,
        )
        .expect("rename recovered sibling");
    let replay_recovery = |engine: &mut EngineStore| {
        let replayed = engine
            .write_with(&NoFaults, |tx| {
                crate::ydoc_recovery::recover_lineage_in_tx(
                    tx,
                    &key,
                    "notes/arbitrated.md",
                    crate::ydoc_recovery::RecoveryEnvelopeBinding {
                        content_kind: "plaintext",
                        update_blob_sha256: &winner_claim,
                        lineage_claim_id: &winner_claim,
                        is_base_state: true,
                    },
                    &loser_claim,
                    "losing draft plus edit",
                    None,
                    "winner",
                    0,
                    2_000,
                    None,
                )
            })
            .expect("replay recovery decision");
        assert!(matches!(replayed, TxnOutcome::Committed(_)));
    };
    replay_recovery(&mut engine);
    let paths_after_rename: (i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots
                     WHERE workspace_id='ws' AND version_id='main' AND path=?1",
                    [&recovered_path],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots
                     WHERE workspace_id='ws' AND version_id='main' AND path=?1",
                    [renamed_path],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("renamed recovery paths");
    assert_eq!(
        paths_after_rename,
        (0, 1),
        "replay must not recreate a sibling after the user renames it"
    );

    VersionedTextStore::new(&mut engine)
        .delete_text_file(
            &DeleteTextFile {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                path: renamed_path.to_owned(),
                moment_id: "delete-recovered-sibling".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2_200,
            },
            &NoFaults,
        )
        .expect("delete recovered sibling");
    replay_recovery(&mut engine);
    let paths_after_delete: (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots
                     WHERE workspace_id='ws' AND version_id='main' AND path=?1",
                    [&recovered_path],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots
                     WHERE workspace_id='ws' AND version_id='main' AND path=?1",
                    [renamed_path],
                    |row| row.get(0),
                )?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_recovery_decisions", [], |row| {
                    row.get(0)
                })?,
            ))
        })
        .expect("deleted recovery paths");
    assert_eq!(
        paths_after_delete,
        (0, 0, 1),
        "replay must preserve the decision without recreating a deleted sibling"
    );
}

#[test]
fn different_scene_seeds_open_a_version_conflict() {
    for deferred in [false, true] {
        let (_scratch, _path, mut engine) = open_store();
        seed_identity(&mut engine);
        VersionedTextStore::new(&mut engine)
            .ensure_main_version("ws", "main", 1_000, &NoFaults)
            .expect("main version");
        let scene = |element_id: &str| {
            json!({
                "type": "excalidraw",
                "version": 2,
                "source": "https://excalidraw.com",
                "elements": [{
                    "id": element_id,
                    "type": "rectangle",
                    "version": 1,
                    "versionNonce": 1,
                    "isDeleted": false,
                    "index": "a0"
                }],
                "appState": {},
                "files": {}
            })
            .to_string()
        };
        let path = "drawings/arbitrated.excalidraw";
        let loser_portable = scene("losing-rectangle");
        seed_text_head(
            &mut engine,
            "object-arbitrated-scene",
            path,
            &loser_portable,
        );
        let key = dohc_engine_collab::DocKey::new("ws", "main", "object-arbitrated-scene")
            .expect("scene key");
        let loser = dohc_engine_collab::Ydoc::wire();
        loser
            .apply(
                &dohc_engine_collab::import_portable_scene(&loser_portable)
                    .expect("losing scene import")
                    .initial_update,
            )
            .expect("losing scene applies");
        let loser_bytes = loser.encode_full_state();
        let loser_claim = dohc_engine_storage::hex_sha256(&loser_bytes);
        assert!(matches!(
            dohc_engine_collab::claim_base_at_relay(
                &mut engine,
                &key,
                dohc_engine_collab::ContentKind::Scene,
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
        engine
            .write_with(&NoFaults, |tx| {
                crate::ydoc_apply::project_and_write_in_tx(
                    tx,
                    &key,
                    path,
                    &loser,
                    dohc_engine_collab::ContentKind::Scene,
                    "loser",
                    0,
                    1_100,
                    None,
                )
            })
            .expect("settle the losing scene projection");

        let moments_before: i64 = engine
            .read_with(|conn| conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0)))
            .unwrap();
        let winner = dohc_engine_collab::Ydoc::wire();
        winner
            .apply(
                &dohc_engine_collab::import_portable_scene(&scene("winning-rectangle"))
                    .expect("winning scene import")
                    .initial_update,
            )
            .expect("winning scene applies");
        let winner_bytes = winner.encode_full_state();
        let winner_claim = engine.put_binary_blob(&winner_bytes).expect("winner blob");
        let mut incoming = envelope(
            "winner",
            0,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": key.object_id,
                "path": path,
                "contentKind": "scene",
                "updateBlobSha256": winner_claim,
                "lineageClaimId": winner_claim,
                "isBaseState": true
            }),
        );
        incoming.relay_seq = Some(10);
        let applied = apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &incoming,
            &NoFaults,
            if deferred { &AlwaysLive } else { &NoLiveLeases },
        )
        .expect("winning scene base applies");
        let ApplyOutcome {
            primary: ApplyDisposition::Applied(result),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        } = applied
        else {
            panic!("winning scene base did not apply: {applied:?}");
        };
        assert!(outcome_refusals.is_empty());
        assert!(outcome_sharing_declined.is_empty());
        let result = if deferred {
            let drain = drain_deferred_ydoc_for_key(
                &mut engine,
                &mut dohc_engine_collab::WriterDocCache::new(),
                &key,
                &NoFaults,
            )
            .unwrap();
            crate::YdocApplyResult {
                deferred: false,
                reason: Some("ydoc-base-conflict"),
                conflicts_opened: drain.conflicts_opened,
                lineage_replacement: drain.lineage_replacements.into_iter().next(),
                record_facts: drain.record_facts,
            }
        } else {
            result
        };
        let replacement = result
            .lineage_replacement
            .expect("scene replacement result");
        assert_eq!(replacement.winner_lineage_claim_id, winner_claim);
        assert!(replacement.recovered_paths.is_empty());
        assert_eq!(result.conflicts_opened, 1);
        assert_eq!(result.reason, Some("ydoc-base-conflict"));
        let (current, incoming_text, head, recoveries): (String, String, String, i64) = engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT c.text,i.text,h.text,(SELECT COUNT(*) FROM ydoc_recovery_decisions)
            FROM conflicts f JOIN blobs c ON c.sha256=f.current_blob_sha256
            JOIN blobs i ON i.sha256=f.incoming_blob_sha256
            JOIN snapshots s ON s.object_id=f.current_object_id
            JOIN blobs h ON h.sha256=s.blob_sha256 WHERE f.status='open'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
            })
            .expect("visible scene conflict");
        assert_eq!(head, current);
        assert_eq!(recoveries, 0);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&current).unwrap()["elements"][0]["id"],
            "losing-rectangle"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&incoming_text).unwrap()["elements"][0]["id"],
            "winning-rectangle"
        );
        let moments_after: i64 = engine
            .read_with(|conn| conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0)))
            .unwrap();
        assert_eq!(
            moments_after, moments_before,
            "a settled local scene needs no new history entry"
        );
        assert_ne!(loser_claim, winner_claim);
        resolve_seed_conflict(&mut engine, &key, true);
        assert_eq!(
            VersionedTextStore::new(&mut engine)
                .read_text("ws", "main", path)
                .unwrap()
                .unwrap()
                .text,
            current
        );
    }
}

#[test]
fn distinct_lineages_with_identical_text_keep_the_winner_without_conflict() {
    for deferred in [false, true] {
        let (_scratch, _path, mut engine) = open_store();
        VersionedTextStore::new(&mut engine)
            .ensure_main_version("ws", "main", 1_000, &NoFaults)
            .expect("main version");
        seed_text_head(
            &mut engine,
            "object-matching-lineages",
            "notes/matching-lineages.md",
            "same text",
        );
        let key = dohc_engine_collab::DocKey::new("ws", "main", "object-matching-lineages")
            .expect("doc key");
        let loser = dohc_engine_collab::Ydoc::wire();
        loser.plaintext_insert(0, "same text");
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
        winner.plaintext_insert(0, "same text");
        let winner_bytes = winner.encode_full_state();
        let winner_claim = engine.put_binary_blob(&winner_bytes).expect("winner blob");
        assert_ne!(
            winner_claim, loser_claim,
            "the test needs independent lineages"
        );
        let mut incoming = envelope(
            "winner",
            0,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": "object-matching-lineages",
                "path": "notes/matching-lineages.md",
                "contentKind": "plaintext",
                "updateBlobSha256": winner_claim,
                "lineageClaimId": winner_claim,
                "isBaseState": true
            }),
        );
        incoming.relay_seq = Some(10);
        let ApplyOutcome {
            primary: ApplyDisposition::Applied(result),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        } = apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &incoming,
            &NoFaults,
            if deferred { &AlwaysLive } else { &NoLiveLeases },
        )
        .expect("winning base applies")
        else {
            panic!("winning base did not apply");
        };
        assert!(outcome_refusals.is_empty());
        assert!(outcome_sharing_declined.is_empty());
        let result = if deferred {
            let drain = drain_deferred_ydoc_for_key(
                &mut engine,
                &mut dohc_engine_collab::WriterDocCache::new(),
                &key,
                &NoFaults,
            )
            .unwrap();
            crate::YdocApplyResult {
                deferred: false,
                reason: None,
                conflicts_opened: drain.conflicts_opened,
                lineage_replacement: drain.lineage_replacements.into_iter().next(),
                record_facts: drain.record_facts,
            }
        } else {
            result
        };
        let replacement = result.lineage_replacement.expect("replacement result");
        assert!(replacement.recovered_paths.is_empty());
        assert_eq!(result.conflicts_opened, 0);
        let counts: (i64, i64) = engine
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row("SELECT COUNT(*) FROM conflicts", [], |row| row.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM ydoc_recovery_decisions", [], |row| {
                        row.get(0)
                    })?,
                ))
            })
            .unwrap();
        assert_eq!(counts, (0, 0));
        assert_eq!(
            dohc_engine_collab::read_marker(&engine, &key)
                .unwrap()
                .unwrap()
                .lineage_claim_id,
            Some(winner_claim)
        );
        assert_eq!(
            VersionedTextStore::new(&mut engine)
                .read_text("ws", "main", "notes/matching-lineages.md")
                .unwrap()
                .unwrap()
                .text,
            "same text"
        );
    }
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
fn a_losing_lineage_delta_is_acked_without_entering_the_winner() {
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    seed_text_head(
        &mut engine,
        "object-lineage-delta",
        "notes/lineage-delta.md",
        "winner",
    );
    let key =
        dohc_engine_collab::DocKey::new("ws", "main", "object-lineage-delta").expect("doc key");
    let winner = dohc_engine_collab::Ydoc::wire();
    winner.plaintext_insert(0, "winner");
    let winner_base = winner.encode_full_state();
    let winner_claim = dohc_engine_storage::hex_sha256(&winner_base);
    assert!(matches!(
        dohc_engine_collab::claim_base_at_relay(
            &mut engine,
            &key,
            dohc_engine_collab::ContentKind::Plaintext,
            &winner_base,
            &dohc_engine_collab::BaseRelayCoordinate::new("winner", 0, 1)
                .expect("winner coordinate"),
            &NoFaults,
            1_100,
        ),
        Ok(TxnOutcome::Committed(
            dohc_engine_collab::ClaimOutcome::Claimed { .. }
        ))
    ));

    let loser = dohc_engine_collab::Ydoc::wire();
    loser.plaintext_insert(0, "loser base");
    let loser_claim = dohc_engine_storage::hex_sha256(&loser.encode_full_state());
    let losing_delta = loser.plaintext_insert(10, " must not merge");
    let losing_delta_sha = engine
        .put_binary_blob(&losing_delta)
        .expect("losing delta blob");
    let mut incoming = envelope(
        "loser",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-lineage-delta",
            "path": "notes/lineage-delta.md",
            "contentKind": "plaintext",
            "updateBlobSha256": losing_delta_sha,
            "lineageClaimId": loser_claim,
            "isBaseState": false
        }),
    );
    incoming.relay_seq = Some(2);
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &incoming,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(YdocApplyResult {
                reason: Some("ydoc-lineage-lost"),
                ..
            }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let persisted = dohc_engine_collab::load_persisted(&engine, &key)
        .expect("persisted doc")
        .expect("winner lineage");
    assert_eq!(persisted.marker.lineage_claim_id, Some(winner_claim));
    assert_eq!(
        persisted
            .doc
            .project(dohc_engine_collab::ContentKind::Plaintext)
            .expect("winner projection")
            .content,
        "winner"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "loser").expect("loser ack"),
        0,
        "the losing coordinate is durably handled"
    );
}

#[test]
fn applied_ydoc_envelopes_materialize_the_projection_with_the_cursorable_ack() {
    // Oracle parity (`projectYDocUpdate` → `writeTextFileInDb` → CRDT rows):
    // an applied (non-deferred) ydoc envelope must advance the visible head
    // (moment + snapshot + pending materialization job) in the same
    // admission transaction as its ack — not just the CRDT log. Mutation
    // check: drop the `project_and_write_in_tx` calls in
    // `apply_ydoc_envelope`'s base/update arms — both head assertions below
    // fail while the ops still report applied.
    let (_scratch, _path, mut engine) = open_store();
    dohc_engine_domain::VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms)                  VALUES ('ws','object-mat',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("scaffolding");

    // Base envelope (fresh replica): the FILE head appears, not just rows.
    let base_doc = dohc_engine_collab::Ydoc::wire();
    let base_bytes = {
        base_doc.plaintext_insert(0, "base seed");
        base_doc.encode_full_state()
    };
    let base_sha = engine.put_binary_blob(&base_bytes).expect("base blob");
    let base_op = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-mat",
            "path": "notes/replicated.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha.clone(),
            "isBaseState": true
        }),
    );
    apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base_op,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("base applies");
    let (head_text, head_origin): (String, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text, s.metadata_origin FROM path_aliases a \
                 JOIN snapshots s ON s.workspace_id = a.workspace_id AND s.object_id = a.object_id \
                 JOIN blobs b ON b.sha256 = s.blob_sha256 \
                 WHERE a.workspace_id = 'ws' AND a.version_id = 'main' \
                   AND a.path = 'notes/replicated.md'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("base head");
    assert_eq!(head_text, "base seed", "the base must materialize a head");
    assert_eq!(head_origin, "ydoc");
    let pending_jobs: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM materialization_jobs WHERE status = 'pending'",
                [],
                |r| r.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("jobs");
    assert_eq!(pending_jobs, 1, "the disk write is durably enqueued");

    // Update envelope: the head advances to the merged projection.
    let delta = base_doc.plaintext_insert(0, "updated ");
    let delta_sha = engine.put_binary_blob(&delta).expect("delta blob");
    let update_op = envelope(
        "peer",
        1,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-mat",
            "path": "notes/replicated.md",
            "contentKind": "plaintext",
            "updateBlobSha256": delta_sha,
            "lineageClaimId": base_sha,
            "isBaseState": false
        }),
    );
    apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &update_op,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("update applies");
    let updated_text: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM path_aliases a \
                 JOIN snapshots s ON s.workspace_id = a.workspace_id AND s.object_id = a.object_id \
                 JOIN blobs b ON b.sha256 = s.blob_sha256 \
                 WHERE a.workspace_id = 'ws' AND a.version_id = 'main' \
                   AND a.path = 'notes/replicated.md'",
                [],
                |r| r.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("updated head");
    assert_eq!(updated_text, "updated base seed");
}

#[test]
fn first_inbound_base_over_divergent_plain_head_opens_conflict_not_overwrite() {
    // The receiver's head came from capture/local writes and belongs to
    // no shared lineage. The first inbound base must not silently replace it:
    // the lineage lands (claimed, acked), the head stays, and one moment-lane
    // shaped sync conflict opens. Mutation check: restore the unconditional
    // `project_and_write_in_tx` call in the base branch — the head assertion
    // and the conflict-count assertion below both fail.
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

    // The head is untouched.
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

    // The lineage itself landed: replicated marker, claimed base.
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

    // One moment-lane shaped conflict: current = local head, incoming = the
    // base projection, both hydratable from `blobs`.
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
    // `lineage_has_state` was a proxy for "the head was merged", and the two
    // come apart exactly where it matters. A local-only session crashes
    // leaving durable unmaterialized rows; capture then records an external
    // disk edit, so the visible head is newer than anything the lineage
    // produced. The union is the crashed draft plus the peer's base — the
    // captured head is in neither — yet the proxy said "rows exist, so the
    // CRDT is the merge" and the projection overwrote the user's edit with
    // no conflict at all.
    //
    // The fact is `last_settled_sha`: the content this lineage last put on
    // disk. Same move as the resolve path, where `metadata_origin == "sync"`
    // was replaced by the head ids the payload already carried.
    //
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

    // A local-only session that crashed: durable rows, never settled.
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

    // Capture records an EXTERNAL disk edit: the head is now newer than
    // anything this lineage produced.
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

// A base imported from the relay names another device's history. A session
// that opened the lineage unclaimed must not read it as its own claim.
#[test]
fn a_base_imported_from_the_relay_is_not_originated_here() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.rewrite_content_to_markdown(dohc_engine_collab::ContentKind::Richdoc, "From a peer")
        .unwrap();
    let bytes = doc.encode_full_state();
    let sha = engine.put_binary_blob(&bytes).unwrap();
    let op = envelope(
        "owner-peer",
        0,
        "ydoc.update",
        json!({
            "versionId":"main","objectId":"peer-object","path":"notes/peer.md", "contentKind":"richdoc",
            "updateBlobSha256":sha,"lineageClaimId":sha,"isBaseState":true
        }),
    );
    let outcome = apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    assert!(outcome.refusals.is_empty());
    let key = dohc_engine_collab::DocKey::new("ws", "main", "peer-object").unwrap();
    let marker = dohc_engine_collab::read_marker(&engine, &key)
        .unwrap()
        .expect("imported marker");
    assert_eq!(marker.lineage_claim_id.as_deref(), Some(sha.as_str()));
    assert_eq!(marker.base_origin_id.as_deref(), Some("owner-peer"));
    assert!(
        !engine
            .read_with(|conn| crate::lineage_originated_here(conn, &key, &marker))
            .unwrap()
    );
}

#[test]
fn first_inbound_base_matching_the_local_head_needs_no_conflict() {
    // The convergent twin of the divergence test: a head whose bytes already
    // equal the base's projection fast-forwards silently.
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws','object-same',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            dohc_engine_domain::write_projected_text_in_tx(
                tx,
                &dohc_engine_domain::WriteText {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "object-same".to_owned(),
                    path: "notes/same.md".to_owned(),
                    text: "shared truth".to_owned(),
                    moment_id: "m-local-same".to_owned(),
                    metadata_origin: "local-file".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1_500,
                    request_id: None,
                },
            )
            .map_err(|error| SyncError::corrupt(std::io::Error::other(error.to_string())))?;
            Ok::<_, SyncError>(())
        })
        .expect("local head");
    let base_doc = dohc_engine_collab::Ydoc::wire();
    base_doc.plaintext_insert(0, "shared truth");
    let base_bytes = base_doc.encode_full_state();
    let base_sha = engine.put_binary_blob(&base_bytes).expect("base blob");
    let base_op = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-same",
            "path": "notes/same.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha,
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
            reason: None,
            conflicts_opened: 0,
            lineage_replacement: None,
            record_facts: Vec::new(),
        }))
    );
    let conflicts: i64 = engine
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM conflicts", [], |r| r.get(0))
                .map_err(SyncError::corrupt)
        })
        .expect("conflict count");
    assert_eq!(
        conflicts, 0,
        "a matching head fast-forwards without a conflict"
    );
}

#[test]
fn a_coalesced_conflict_still_recounts_on_redelivery() {
    // A later delta coalesces the conflict and rewrites its
    // incoming anchor, so a crash-redelivery recount keyed on the conflict
    // row finds nothing. The count now lives in an immutable per-envelope
    // decision record.
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws','object-recount',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            dohc_engine_domain::write_projected_text_in_tx(
                tx,
                &dohc_engine_domain::WriteText {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "object-recount".to_owned(),
                    path: "notes/recount.md".to_owned(),
                    text: "local truth".to_owned(),
                    moment_id: "m-recount-local".to_owned(),
                    metadata_origin: "local-file".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1_500,
                    request_id: None,
                },
            )
            .map_err(|error| SyncError::corrupt(std::io::Error::other(error.to_string())))?;
            Ok::<_, SyncError>(())
        })
        .expect("local head");
    let base_doc = dohc_engine_collab::Ydoc::wire();
    base_doc.plaintext_insert(0, "remote truth");
    let base_sha = engine
        .put_binary_blob(&base_doc.encode_full_state())
        .expect("base blob");
    let base_op = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-recount",
            "path": "notes/recount.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha.clone(),
            "isBaseState": true
        }),
    );
    apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base_op,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("base conflicts");
    // A later delta coalesces the conflict, rewriting its incoming anchor.
    let delta = base_doc.plaintext_insert(0, "more ");
    let delta_sha = engine.put_binary_blob(&delta).expect("delta blob");
    let delta_op = envelope(
        "peer",
        1,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-recount",
            "path": "notes/recount.md",
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
    .expect("delta coalesces");
    assert_eq!(
        crate::router::redelivered_conflicts_opened(&engine, &base_op).expect("recount"),
        1,
        "the redelivered base still reports the conflict it opened"
    );
}

#[test]
fn a_fold_that_cannot_reproduce_the_choice_refuses_instead_of_diverging() {
    // The fold's markdown parser is ASSERTED to be the projector's inverse
    // and nothing makes that true. Past the quote budget the leftover `> `
    // markers become paragraph text and the projector escapes them to
    // `&gt;` — so the fold would commit a lineage projecting bytes the user
    // never chose while stamping last_settled_sha with the chosen text's
    // hash in the same statement: the head file saying one thing, the CRDT
    // another, and the marker asserting they agree. That is the silent
    // reversal this PR exists to close, arriving through the fold itself.
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
    doc.richdoc_append_paragraph("original");
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

    // And it left nothing behind: no appended update, and the settle marker
    // does not claim bytes the lineage cannot produce.
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
fn recounting_a_malformed_redelivery_returns_zero_instead_of_wedging() {
    // A malformed `ydoc.update` is refused and ACKED. If the process then
    // crashes before the relay cursor commits, the next pull replays that
    // coordinate as `Skipped` and asks the recount helper about it. Decoding
    // the payload again returned InvalidInput and aborted the whole pull, so
    // every retry wedged on an operation already durably handled — the
    // coordinate can never be got past.
    //
    // The decision record is keyed by the ENVELOPE coordinate and needs no
    // payload, so absence reads as zero.
    //
    let (_scratch, _path, engine) = open_store();
    let malformed = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({ "versionId": 5, "not": "a ydoc.update payload" }),
    );
    assert_eq!(
        crate::router::redelivered_conflicts_opened(&engine, &malformed)
            .expect("a malformed redelivery must recount as zero, not abort the pull"),
        0,
        "reparse the payload in `redelivered_conflicts_opened` — this returns Err and the assertion below fails.",
    );
    assert!(
        crate::router::redelivered_materialization_changes(&engine, &malformed)
            .expect("a malformed redelivery cannot have a materialization")
            .is_empty()
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

    // A third origin's dependent update lands without its predecessor: it is
    // durably in `ydoc_updates` and the doc reports a missing dependency.
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
fn a_fold_the_parser_can_reproduce_still_commits() {
    // The guard must not refuse everything: a rich choice the parser does
    // model folds and journals as before.
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws','object-representable',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("scaffolding");
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-representable").expect("key");
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.richdoc_append_paragraph("original");
    dohc_engine_collab::claim_base(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Richdoc,
        &doc.encode_full_state(),
        &NoFaults,
        1_500,
    )
    .expect("claim");
    let chosen = "# Heading\n\nchosen body\n\n- one\n- two";
    engine
        .write_with(&NoFaults, |tx| {
            crate::ydoc_apply::fold_resolution_into_ydoc_in_tx(
                tx,
                "ws",
                "main",
                "object-representable",
                "notes/representable.md",
                chosen,
                1_600,
            )
        })
        .expect("a representable choice folds");
    let persisted = dohc_engine_collab::load_persisted(&engine, &key)
        .expect("load")
        .expect("lineage");
    assert_eq!(
        persisted
            .doc
            .project(dohc_engine_collab::ContentKind::Richdoc)
            .expect("projection")
            .content,
        chosen,
        "the lineage projects exactly the chosen bytes"
    );
}

#[test]
fn resolution_fold_names_the_cap_it_hits() {
    // The fold's size refusal must name the constraint, the
    // limit, and the observed bytes.
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws','object-fold-cap',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("scaffolding");
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-fold-cap").expect("key");
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.plaintext_insert(0, "small");
    dohc_engine_collab::claim_base(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Plaintext,
        &doc.encode_full_state(),
        &NoFaults,
        1_500,
    )
    .expect("claim");
    let oversized = "x".repeat(dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES + 1);
    let refused = engine.write_with(&NoFaults, |tx| {
        crate::ydoc_apply::fold_resolution_into_ydoc_in_tx(
            tx,
            "ws",
            "main",
            "object-fold-cap",
            "notes/fold-cap.md",
            &oversized,
            1_600,
        )
    });
    match refused {
        Err(SyncError::BlobTooLarge {
            constraint,
            limit_bytes,
            observed_bytes,
        }) => {
            assert!(constraint.contains("MAX_YDOC_UPDATE_BYTES"));
            assert_eq!(
                limit_bytes,
                dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES
            );
            assert!(observed_bytes > limit_bytes, "observed usage is reported");
        }
        other => panic!("the fold cap must name limit and usage: {other:?}"),
    }
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
fn external_text_write_to_a_closed_scene_retires_the_lineage_for_reseed() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let object_id = "closed-scene";
    let path = "drawings/closed.excalidraw";
    let imported = dohc_engine_collab::import_portable_scene(
        &json!({
            "type": "excalidraw",
            "version": 2,
            "source": "https://excalidraw.com",
            "elements": [],
            "appState": {},
            "files": {}
        })
        .to_string(),
    )
    .expect("import scene");
    let base_sha = engine
        .put_binary_blob(&imported.initial_update)
        .expect("store scene base");
    let base = envelope(
        "closed-scene-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": object_id,
            "path": path,
            "contentKind": "scene",
            "updateBlobSha256": base_sha,
            "lineageClaimId": base_sha,
            "isBaseState": true
        }),
    );
    let base_outcome = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    );
    assert!(
        matches!(
            base_outcome,
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(_),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ),
        "unexpected scene base outcome: {base_outcome:?}"
    );

    // An external edit lands while the drawing is closed. A scene has no
    // Markdown fold, so the reconcile must retire the lineage — the file is
    // canonical and the next open seeds a fresh scene from it — instead of
    // failing and rolling the external edit's write back.
    let changed = json!({
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": [{
            "id": "external-shape",
            "type": "rectangle",
            "version": 1,
            "versionNonce": 1,
            "isDeleted": false,
            "index": "a0"
        }],
        "appState": {},
        "files": {}
    })
    .to_string();
    engine
        .write_with(&NoFaults, |tx| {
            crate::ydoc_apply::reconcile_local_resulting_head_in_tx(
                tx,
                "ws",
                "main",
                object_id,
                crate::ydoc_apply::ResultingHead::Text {
                    path,
                    text: &changed,
                },
                None,
                None,
                4_000,
            )
        })
        .expect("the external scene edit reconciles instead of failing");
    let remaining: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT (SELECT COUNT(*) FROM ydoc_docs \
                   WHERE workspace_id='ws' AND version_id='main' AND object_id=?1) \
                 + (SELECT COUNT(*) FROM ydoc_updates \
                   WHERE workspace_id='ws' AND version_id='main' AND object_id=?1) \
                 + (SELECT COUNT(*) FROM ydoc_snapshots \
                   WHERE workspace_id='ws' AND version_id='main' AND object_id=?1)",
                [object_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("count retired lineage rows");
    assert_eq!(
        remaining, 0,
        "the retired scene lineage leaves no CRDT rows"
    );
}

#[test]
fn replicated_text_write_to_a_scene_retires_the_receiver_lineage() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let object_id = "replicated-scene";
    let path = "drawings/replicated.excalidraw";
    let imported = dohc_engine_collab::import_portable_scene(
        &json!({
            "type": "excalidraw",
            "version": 2,
            "source": "https://excalidraw.com",
            "elements": [],
            "appState": {},
            "files": {}
        })
        .to_string(),
    )
    .expect("import scene");
    let base_sha = engine
        .put_binary_blob(&imported.initial_update)
        .expect("store scene base");
    let base = envelope(
        "replicated-scene-base-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": object_id,
            "path": path,
            "contentKind": "scene",
            "updateBlobSha256": base_sha,
            "lineageClaimId": base_sha,
            "isBaseState": true
        }),
    );
    let base_outcome = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    );
    assert!(
        matches!(
            base_outcome,
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(_),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ),
        "unexpected scene base outcome: {base_outcome:?}"
    );

    // The origin of an external scene edit retires its lineage without
    // emitting a rewrite, so a receiver applying the replicated file moment
    // must converge the same way instead of waiting forever for a rewrite
    // that is never coming.
    let changed = json!({
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": [{
            "id": "replicated-shape",
            "type": "rectangle",
            "version": 1,
            "versionNonce": 1,
            "isDeleted": false,
            "index": "a0"
        }],
        "appState": {},
        "files": {}
    })
    .to_string();
    engine
        .write_with(&NoFaults, |tx| {
            crate::ydoc_apply::reconcile_imported_resulting_head_in_tx(
                tx,
                "ws",
                "main",
                object_id,
                crate::ydoc_apply::ResultingHead::Text {
                    path,
                    text: &changed,
                },
                4_000,
            )
        })
        .expect("the replicated scene edit converges instead of waiting for a rewrite");
    let remaining: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT (SELECT COUNT(*) FROM ydoc_docs \
                   WHERE workspace_id='ws' AND version_id='main' AND object_id=?1) \
                 + (SELECT COUNT(*) FROM ydoc_updates \
                   WHERE workspace_id='ws' AND version_id='main' AND object_id=?1) \
                 + (SELECT COUNT(*) FROM ydoc_snapshots \
                   WHERE workspace_id='ws' AND version_id='main' AND object_id=?1)",
                [object_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("count retired lineage rows");
    assert_eq!(
        remaining, 0,
        "the retired scene lineage leaves no CRDT rows"
    );
}

#[test]
fn oversized_hydrated_scene_base_is_refused_without_storing_the_projection() {
    const ASSET_BYTES: usize = 3 * 1024 * 1024;
    const ASSET_IDS: [&str; 4] = ["image-a", "image-b", "image-c", "image-d"];

    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    seed_replication_version(&mut engine, "main", "main");
    let object_id = "scene-over-projection-cap";
    let drawing_path = "drawings/over-cap.excalidraw";
    let asset_bytes = vec![7_u8; ASSET_BYTES];
    let asset_sha = dohc_engine_storage::hex_sha256(&asset_bytes);
    let asset_ref =
        dohc_engine_collab::scene_asset_ref("ws", "main", object_id, &asset_sha, "image/png")
            .expect("asset ref");
    VersionedTextStore::new(&mut engine)
        .write_binary(
            &WriteBinary {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: "oversized-scene-asset".to_owned(),
                path: asset_ref.clone(),
                bytes: asset_bytes,
                moment_id: "oversized-scene-asset-write".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1_500,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("store authoritative asset");

    let elements = ASSET_IDS
        .iter()
        .enumerate()
        .map(|(index, id)| {
            json!({
                "id": format!("element-{index}"),
                "type": "image",
                "version": 1,
                "versionNonce": index + 1,
                "isDeleted": false,
                "index": format!("a{index}"),
                "fileId": id,
            })
        })
        .collect::<Vec<_>>();
    let files = ASSET_IDS
        .iter()
        .map(|id| {
            (
                (*id).to_owned(),
                json!({
                    "id": id,
                    "mimeType": "image/png",
                    "created": 1,
                    "dataURL": "data:image/png;base64,AQ==",
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let portable = json!({
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": elements,
        "appState": {},
        "files": files,
    })
    .to_string();
    let imported = dohc_engine_collab::import_portable_scene(&portable).expect("scene import");
    let records = ASSET_IDS
        .iter()
        .map(|id| {
            (
                (*id).to_owned(),
                json!({
                    "created": 1,
                    "id": id,
                    "mimeType": "image/png",
                    "ref": asset_ref,
                    "sha256": asset_sha,
                })
                .to_string(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let asset_update =
        dohc_engine_collab::encode_scene_asset_records(&records).expect("asset records");
    let base_update = dohc_engine_collab::merge_updates(&[imported.initial_update, asset_update])
        .expect("scene base");
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&base_update).expect("scene applies");
    let key = dohc_engine_collab::DocKey::new("ws", "main", object_id).expect("scene key");
    let projection_error = engine
        .read_with(|conn| {
            project_ydoc_with_store(conn, &key, &doc, dohc_engine_collab::ContentKind::Scene)
        })
        .expect_err("the shared runtime/sync projector must enforce the cap");
    let (actual_bytes, limit_bytes) = match projection_error {
        SyncError::ProjectionTooLarge {
            constraint: "MAX_PROJECTION_BYTES",
            actual_bytes,
            limit_bytes,
        } => (actual_bytes, limit_bytes),
        other => panic!("unexpected projection error: {other}"),
    };
    assert_eq!(
        limit_bytes,
        dohc_engine_collab::limits::MAX_PROJECTION_BYTES
    );
    assert!(actual_bytes > limit_bytes);
    let update_sha = engine
        .put_binary_blob(&doc.encode_full_state())
        .expect("scene update blob");
    let operation = envelope(
        "oversized-scene-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": object_id,
            "path": drawing_path,
            "contentKind": "scene",
            "updateBlobSha256": update_sha,
            "lineageClaimId": update_sha,
            "isBaseState": true,
        }),
    );

    let outcome = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &operation,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("oversized projection is a terminal refusal");
    assert!(
        matches!(
            outcome,
            ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
                reason: RefusalReason::InvalidInput { ref reason },
                ..
            }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == &format!(
                "scene projection exceeds MAX_PROJECTION_BYTES: limit {limit_bytes} bytes, observed at least {actual_bytes} bytes"
            ))
        ),
        "unexpected oversized scene outcome: {outcome:?}"
    );
    assert!(
        dohc_engine_collab::read_marker(&engine, &key)
            .expect("read marker")
            .is_none(),
        "the refused base must not store a canonical lineage"
    );
    let (drawing_heads, drawing_jobs, text_blobs): (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, SyncError>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' \
                     AND version_id='main' AND path=?1",
                    [drawing_path],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)?,
                conn.query_row(
                    "SELECT COUNT(*) FROM materialization_jobs WHERE workspace_id='ws' \
                     AND target_path=?1",
                    [drawing_path],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)?,
                conn.query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get(0))
                    .map_err(SyncError::corrupt)?,
            ))
        })
        .expect("inspect refused projection");
    assert_eq!((drawing_heads, drawing_jobs, text_blobs), (0, 0, 0));
}

#[test]
fn an_old_scene_asset_tombstone_cannot_authorize_a_reused_path() {
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    let drawing_object_id = "scene-tombstone-owner";
    let asset_bytes = vec![1_u8, 2, 3, 4, 5];
    let asset_sha = dohc_engine_storage::hex_sha256(&asset_bytes);
    let asset_ref = dohc_engine_collab::scene_asset_ref(
        "ws",
        "main",
        drawing_object_id,
        &asset_sha,
        "image/png",
    )
    .expect("asset ref");
    let replacement_bytes = vec![9_u8, 8, 7, 6];
    let replacement_sha = dohc_engine_storage::hex_sha256(&replacement_bytes);
    let replacement_ref = dohc_engine_collab::scene_asset_ref(
        "ws",
        "main",
        drawing_object_id,
        &replacement_sha,
        "image/png",
    )
    .expect("replacement asset ref");

    {
        let mut versioned = VersionedTextStore::new(&mut engine);
        versioned
            .write_binary(
                &WriteBinary {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "asset-a".to_owned(),
                    path: asset_ref.clone(),
                    bytes: asset_bytes,
                    moment_id: "asset-a-write".to_owned(),
                    metadata_origin: "ydoc".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1_400,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("write original asset");
        versioned
            .delete_text_file(
                &DeleteTextFile {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    path: asset_ref.clone(),
                    moment_id: "asset-a-delete".to_owned(),
                    request_id: None,
                    metadata_origin: "capture".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1_500,
                },
                &NoFaults,
            )
            .expect("retire original asset");
        versioned
            .write_binary(
                &WriteBinary {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "asset-b".to_owned(),
                    path: asset_ref.clone(),
                    bytes: replacement_bytes.clone(),
                    moment_id: "asset-b-write".to_owned(),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1_600,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("reuse path");
        versioned
            .delete_text_file(
                &DeleteTextFile {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    path: asset_ref.clone(),
                    moment_id: "asset-b-delete".to_owned(),
                    request_id: None,
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1_700,
                },
                &NoFaults,
            )
            .expect("delete replacement");
        versioned
            .write_binary(
                &WriteBinary {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "asset-c".to_owned(),
                    path: replacement_ref.clone(),
                    bytes: replacement_bytes,
                    moment_id: "asset-c-write".to_owned(),
                    metadata_origin: "ydoc".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1_800,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("write current canonical asset");
        versioned
            .delete_text_file(
                &DeleteTextFile {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    path: replacement_ref.clone(),
                    moment_id: "asset-c-delete".to_owned(),
                    request_id: None,
                    metadata_origin: "capture".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1_900,
                },
                &NoFaults,
            )
            .expect("retire current canonical asset");
    }

    let portable = json!({
        "type": "excalidraw", "version": 2, "source": "https://excalidraw.com",
        "elements": [{ "id": "image", "type": "image", "version": 1,
            "versionNonce": 1, "isDeleted": false, "index": "a0", "fileId": "file" }],
        "appState": {},
        "files": { "file": { "id": "file", "mimeType": "image/png", "created": 1,
            "dataURL": "data:image/png;base64,AQIDBAU=" } }
    })
    .to_string();
    let imported = dohc_engine_collab::import_portable_scene(&portable).expect("scene import");
    let records = BTreeMap::from([(
        "file".to_owned(),
        json!({ "created": 1, "id": "file", "mimeType": "image/png",
            "ref": asset_ref, "sha256": asset_sha })
        .to_string(),
    )]);
    let assets = dohc_engine_collab::encode_scene_asset_records(&records).expect("asset record");
    let update = dohc_engine_collab::merge_updates(&[imported.initial_update, assets])
        .expect("scene update");
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&update).expect("apply scene");
    let key = dohc_engine_collab::DocKey::new("ws", "main", drawing_object_id).expect("key");

    assert!(matches!(
        engine.read_with(|conn| project_ydoc_with_store(
            conn,
            &key,
            &doc,
            dohc_engine_collab::ContentKind::Scene,
        )),
        Err(SyncError::RetryableState {
            reason: "scene asset head is pending"
        })
    ));

    let current_records = BTreeMap::from([(
        "file".to_owned(),
        json!({ "created": 1, "id": "file", "mimeType": "image/png",
            "ref": replacement_ref, "sha256": replacement_sha })
        .to_string(),
    )]);
    let current_assets =
        dohc_engine_collab::encode_scene_asset_records(&current_records).expect("asset record");
    let current_update = dohc_engine_collab::merge_updates(&[
        dohc_engine_collab::import_portable_scene(&portable)
            .expect("scene import")
            .initial_update,
        current_assets,
    ])
    .expect("scene update");
    let current_doc = dohc_engine_collab::Ydoc::wire();
    current_doc.apply(&current_update).expect("apply scene");
    let projection = engine
        .read_with(|conn| {
            project_ydoc_with_store(
                conn,
                &key,
                &current_doc,
                dohc_engine_collab::ContentKind::Scene,
            )
        })
        .expect("the current retired asset projects");
    let projected: serde_json::Value =
        serde_json::from_str(&projection.content).expect("projected scene");
    assert_eq!(
        projected["files"]["file"]["dataURL"],
        "data:image/png;base64,CQgHBg=="
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
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![asset_a, scene_a],
            next_cursor: 2,
            has_more: false,
        })),
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
        pushes: Mutex::new(Vec::new()),
        pull: Mutex::new(Some(PullResponse {
            ops: vec![scene_b, asset_b],
            next_cursor: 2,
            has_more: false,
        })),
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
fn ydoc_base_retries_until_a_concurrent_binary_head_is_deleted_then_converges() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let binary = b"device X binary";
    let binary_sha = engine.put_binary_blob(binary).expect("binary payload");
    let binary_write = envelope(
        "device-x",
        0,
        "moment.append",
        json!({
            "momentId": "device-x-binary",
            "versionId": "main",
            "objectId": "device-x-object",
            "objectCreatedAtMs": 1,
            "path": "notes/a.md",
            "recordedAtMs": 2_000,
            "operation": "write",
            "payloadBeforeBlobSha256": null,
            "payloadBeforePath": null,
            "payloadAfterBlobSha256": binary_sha,
            "payloadAfterPath": "notes/a.md",
            "payloadAfterContentKind": "binary",
            "payloadAfterByteLength": binary.len(),
            "metadata": {"origin": "sync"},
            "beforePresent": "absent"
        }),
    );
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &binary_write,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let binary_head: (String, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT object_id,content_kind FROM snapshots
                 WHERE workspace_id='ws' AND version_id='main' AND path='notes/a.md'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("device X binary head");
    assert_eq!(
        binary_head,
        ("device-x-object".to_owned(), "binary".to_owned())
    );

    let ydoc = dohc_engine_collab::Ydoc::wire();
    ydoc.plaintext_insert(0, "device Y document");
    let base_sha = engine
        .put_binary_blob(&ydoc.encode_full_state())
        .expect("device Y base");
    let base = envelope(
        "device-y",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "device-y-object",
            "path": "notes/a.md",
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
            reason: "ydoc.update targets a binary head"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "device-y").expect("base retry ack"),
        -1,
        "InvalidInput would ACK and permanently lose device Y's base"
    );
    let ydoc_rows: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM ydoc_docs
                 WHERE workspace_id='ws' AND object_id='device-y-object'",
                [],
                |row| row.get(0),
            )
        })
        .expect("no premature lineage");
    assert_eq!(ydoc_rows, 0);

    let binary_delete = envelope(
        "device-x",
        1,
        "moment.append",
        json!({
            "momentId": "device-x-delete",
            "versionId": "main",
            "objectId": "device-x-object",
            "objectCreatedAtMs": 1,
            "path": "notes/a.md",
            "recordedAtMs": 2_001,
            "operation": "delete",
            "payloadBeforeBlobSha256": binary_sha,
            "payloadBeforePath": "notes/a.md",
            "payloadBeforeContentKind": "binary",
            "payloadBeforeByteLength": binary.len(),
            "payloadAfterBlobSha256": binary_sha,
            "payloadAfterPath": "notes/a.md",
            "payloadAfterContentKind": "binary",
            "payloadAfterByteLength": binary.len(),
            "metadata": {"origin": "sync"},
            "beforePresent": "present",
            "beforeObjectId": "device-x-object",
            "beforeVersionId": "main",
            "beforePath": "notes/a.md",
            "beforeBlobSha256": binary_sha,
            "beforeContentKind": "binary",
            "beforeByteLength": binary.len(),
            "beforeUpdatedAtMs": 2_000,
            "beforeLatestMomentId": "device-x-binary",
            "beforeMetadata": {"origin": "sync"}
        }),
    );
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &binary_delete,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &base,
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
        read_replication_acked_seq(&engine, "ws", "device-y").expect("base ack"),
        0
    );
    let key =
        dohc_engine_collab::DocKey::new("ws", "main", "device-y-object").expect("device Y key");
    let persisted = dohc_engine_collab::load_persisted(&engine, &key)
        .expect("load converged lineage")
        .expect("device Y lineage");
    assert_eq!(
        persisted
            .doc
            .project(dohc_engine_collab::ContentKind::Plaintext)
            .expect("project converged base")
            .content,
        "device Y document"
    );
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
fn later_losing_base_and_delta_are_acked_without_touching_the_winner() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let first_doc = dohc_engine_collab::Ydoc::wire();
    first_doc.plaintext_insert(0, "first");
    let first_sha = engine
        .put_binary_blob(&first_doc.encode_full_state())
        .expect("first base");
    let second_doc = dohc_engine_collab::Ydoc::wire();
    second_doc.plaintext_insert(0, "second");
    let second_sha = engine
        .put_binary_blob(&second_doc.encode_full_state())
        .expect("second base");
    let base = |origin: &str, relay_seq: i64, sha: &str| {
        let mut envelope = envelope(
            origin,
            0,
            "ydoc.update",
            json!({
                "versionId": "main",
                "objectId": "object-divergent-base",
                "path": "notes/divergent-base.md",
                "contentKind": "plaintext",
                "updateBlobSha256": sha,
                "lineageClaimId": sha,
                "isBaseState": true
            }),
        );
        envelope.relay_seq = Some(relay_seq);
        envelope
    };
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &base("first-base-peer", 1, &first_sha),
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let losing_base = apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base("second-base-peer", 2, &second_sha),
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("later base is handled");
    assert!(matches!(
        losing_base,
        ApplyOutcome {
            primary: ApplyDisposition::Applied(YdocApplyResult {
                reason: Some("ydoc-base-already-won"),
                lineage_replacement: None,
                ..
            }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let losing_delta = second_doc.plaintext_insert(6, " delta");
    let losing_delta_sha = engine.put_binary_blob(&losing_delta).expect("losing delta");
    let mut delta = envelope(
        "second-base-peer",
        1,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-divergent-base",
            "path": "notes/divergent-base.md",
            "contentKind": "plaintext",
            "updateBlobSha256": losing_delta_sha,
            "lineageClaimId": second_sha,
            "isBaseState": false
        }),
    );
    delta.relay_seq = Some(3);
    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &delta,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(YdocApplyResult {
                reason: Some("ydoc-lineage-lost"),
                lineage_replacement: None,
                ..
            }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "second-base-peer").expect("loser ack"),
        1,
        "the losing lineage is durably handled"
    );
    let state: (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log \
                     WHERE workspace_id='ws' AND origin_id='second-base-peer'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row("SELECT COUNT(*) FROM ydoc_recovery_decisions", [], |row| {
                    row.get(0)
                })?,
                conn.query_row(
                    "SELECT COUNT(*) FROM moments \
                     WHERE metadata_correlation_id LIKE 'ydoc-recovery:v1:%'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("losing-lineage records");
    assert_eq!(state, (2, 0, 0), "AlreadyWon never creates a sibling");
    let key =
        dohc_engine_collab::DocKey::new("ws", "main", "object-divergent-base").expect("doc key");
    let persisted = dohc_engine_collab::load_persisted(&engine, &key)
        .expect("load")
        .expect("lineage");
    assert_eq!(persisted.marker.lineage_claim_id, Some(first_sha));
    assert_eq!(persisted.doc.plaintext_string(), "first");
    assert!(
        !persisted.doc.has_pending_dependencies(),
        "losing-lineage bytes must not add pending clocks to the winner"
    );
}

#[test]
fn a_pulled_base_preserves_local_only_rows_in_a_conflict() {
    // A local-only lineage has no relay identity. Preserve its content in
    // the conflict before installing the incoming causal lineage.
    let (_scratch, _path, mut engine) = open_store();
    dohc_engine_domain::VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms)                  VALUES ('ws','object-promote',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("scaffolding");
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object-promote").expect("key");
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
    // A lineage the client seeded from a captured head. The
    // replacement below must clear this witness — the winning base holds
    // content the file does not, and a surviving stamp would feed the
    // seed-only settle skip a lie about the replaced lineage.
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_docs SET seed_source_sha256='caffee00' \
                 WHERE workspace_id='ws' AND version_id='main' \
                   AND object_id='object-promote'",
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
    let base_op = envelope(
        "peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-promote",
            "path": "notes/promoted.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha,
            "isBaseState": true
        }),
    );
    let ApplyOutcome {
        primary: ApplyDisposition::Applied(result),
        refusals: ref outcome_refusals,
        sharing_declined: ref outcome_sharing_declined,
    } = apply_ydoc_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base_op,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("base applies")
    else {
        panic!("base did not apply");
    };
    assert!(outcome_refusals.is_empty());
    assert!(outcome_sharing_declined.is_empty());
    let replacement = result
        .lineage_replacement
        .expect("local-only lineage replacement");
    assert!(replacement.recovered_paths.is_empty());
    assert_eq!(result.conflicts_opened, 1);

    let head_text: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM path_aliases a \
                 JOIN snapshots s ON s.workspace_id = a.workspace_id AND s.object_id = a.object_id \
                 JOIN blobs b ON b.sha256 = s.blob_sha256 \
                 WHERE a.workspace_id = 'ws' AND a.version_id = 'main' \
                   AND a.path = 'notes/promoted.md'",
                [],
                |r| r.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("promoted head");
    assert_eq!(head_text, "local-part ");
    let recovered_text: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM conflicts c JOIN blobs b ON b.sha256=c.incoming_blob_sha256 WHERE c.status='open'",
                [],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("recovered local content");
    assert_eq!(recovered_text, "base-part");
    let seed_source: Option<String> = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT seed_source_sha256 FROM ydoc_docs \
                 WHERE workspace_id='ws' AND version_id='main' \
                   AND object_id='object-promote'",
                [],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("seed source after replacement");
    assert_eq!(
        seed_source, None,
        "the lineage replacement must clear the seed-source witness (#815)"
    );
}

#[test]
fn divergent_base_waits_for_the_existing_base_relay_position() {
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .expect("main version");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','object-pending-base-order',1_400)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("file object");
    let key =
        dohc_engine_collab::DocKey::new("ws", "main", "object-pending-base-order").expect("key");
    let local = dohc_engine_collab::Ydoc::wire();
    local.plaintext_insert(0, "local base");
    let local_bytes = local.encode_full_state();
    let local_claim = match dohc_engine_collab::claim_base(
        &mut engine,
        &key,
        dohc_engine_collab::ContentKind::Plaintext,
        &local_bytes,
        &NoFaults,
        1_500,
    )
    .expect("claim base without relay position")
    {
        TxnOutcome::Committed(dohc_engine_collab::ClaimOutcome::Claimed { base_snapshot_sha }) => {
            base_snapshot_sha
        }
        other => panic!("unexpected local base outcome: {other:?}"),
    };
    let incoming = dohc_engine_collab::Ydoc::wire();
    incoming.plaintext_insert(0, "incoming base");
    let incoming_bytes = incoming.encode_full_state();
    let incoming_sha = engine
        .put_binary_blob(&incoming_bytes)
        .expect("incoming base blob");
    let operation = envelope(
        "pending-base-order-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": "object-pending-base-order",
            "path": "notes/pending-base-order.md",
            "contentKind": "plaintext",
            "updateBlobSha256": incoming_sha,
            "lineageClaimId": incoming_sha,
            "isBaseState": true
        }),
    );

    assert!(matches!(
        apply_ydoc_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &operation,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::RetryableState {
            reason: "Y.Doc base is waiting for its authenticated relay position"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "pending-base-order-peer").expect("ack"),
        -1
    );
    let marker = dohc_engine_collab::read_marker(&engine, &key)
        .expect("read marker")
        .expect("marker");
    assert_eq!(marker.lineage_claim_id, Some(local_claim));
    assert_eq!(marker.base_relay_seq, None);
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
    for bytes in binary {
        target.put_binary_blob(&bytes).unwrap();
    }
    target
        .write_with(&NoFaults, |tx| {
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
fn winner_with_unsettled_or_net_zero_edits_reviews_resolution_without_retrying() {
    use dohc_engine_collab::{ContentKind, DocKey, WriterDocCache, Ydoc};
    for (edit, keep_current) in [
        (0, false),
        (0, true),
        (1, false),
        (1, true),
        (2, false),
        (2, true),
    ] {
        let (_sa, _pa, mut a) = open_store();
        let (_sb, _pb, mut b) = open_store();
        let key = DocKey::new("ws", "main", "changed-winner").unwrap();
        let path = "notes/changed-winner.md";
        let loser = Ydoc::wire();
        loser.plaintext_insert(0, "local seed");
        let winner = Ydoc::wire();
        winner.plaintext_insert(0, "remote seed");
        for (store, doc, text, origin, relay) in [
            (&mut a, &loser, "local seed", "loser", 20),
            (&mut b, &winner, "remote seed", "winner", 10),
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
                &doc.encode_full_state(),
                &dohc_engine_collab::BaseRelayCoordinate::new(origin, 0, relay).unwrap(),
                &NoFaults,
                1100,
            )
            .unwrap();
        }
        let sha = a.put_binary_blob(&winner.encode_full_state()).unwrap();
        let mut base = envelope(
            "winner",
            0,
            "ydoc.update",
            json!({
                "versionId":"main","objectId":key.object_id,"path":path,"contentKind":"plaintext",
                "updateBlobSha256":sha,"lineageClaimId":sha,"isBaseState":true
            }),
        );
        base.relay_seq = Some(10);
        apply_ydoc_envelope(
            &mut a,
            &mut WriterDocCache::new(),
            &base,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        let update = if edit == 2 {
            winner.plaintext_delete(0, 1)
        } else {
            winner.plaintext_insert(0, "new ")
        };
        for bytes in
            std::iter::once(update).chain((edit == 1).then(|| winner.plaintext_delete(0, 4)))
        {
            dohc_engine_collab::record_local_update(
                &mut b,
                &mut WriterDocCache::new(),
                &key,
                &bytes,
                dohc_engine_collab::LocalAppend::default(),
                &NoFaults,
                1200,
                |_tx, _outcome, _sha| Ok(()),
            )
            .unwrap();
        }
        let before = dohc_engine_collab::load_persisted(&b, &key)
            .unwrap()
            .unwrap()
            .doc
            .encode_full_state();
        resolve_seed_conflict(&mut a, &key, keep_current);
        copy_seed_blobs(&a, &mut b);
        for op in seed_resolution_ops(&a, "resolver") {
            let applied = crate::apply_replication_envelope(
                &mut b,
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
            assert!(applied.refusals.is_empty());
            let replay = crate::apply_replication_envelope(
                &mut b,
                &mut WriterDocCache::new(),
                &op,
                &NoFaults,
                &NoLiveLeases,
            )
            .unwrap();
            assert!(matches!(replay.primary, ApplyDisposition::Skipped));
        }
        assert_eq!(
            before,
            dohc_engine_collab::load_persisted(&b, &key)
                .unwrap()
                .unwrap()
                .doc
                .encode_full_state()
        );
        let open: i64 = b
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM conflicts WHERE status='open'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(open, 1);
        if edit == 0 {
            let recovered: i64 = b
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
                 WHERE s.object_id <> 'changed-winner' AND b.text='new remote seed'",
                        [],
                        |row| row.get(0),
                    )
                })
                .unwrap();
            assert_eq!(
                recovered, 1,
                "unsettled edits remain visible as a recovery file"
            );
        }
    }
}

#[test]
fn equal_base_projection_preserves_pending_dependencies_until_review() {
    use dohc_engine_collab::{ContentKind, DocKey, WriterDocCache, Ydoc};
    for (deferred, deletion, existing_review) in [
        (false, false, false),
        (true, false, false),
        (false, true, false),
        (true, true, false),
        (false, false, true),
        (true, true, true),
    ] {
        let (_scratch, db_path, mut store) = open_store();
        seed_identity(&mut store);
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1000, &NoFaults)
            .unwrap();
        let key = DocKey::new("ws", "main", "pending-seed").unwrap();
        let path = "notes/pending-seed.md";
        seed_resolution_head(&mut store, &key.object_id, path, "same");
        let local = Ydoc::wire();
        local.plaintext_insert(0, "same");
        let claim = store.put_binary_blob(&local.encode_full_state()).unwrap();
        dohc_engine_collab::claim_base_at_relay(
            &mut store,
            &key,
            ContentKind::Plaintext,
            &local.encode_full_state(),
            &dohc_engine_collab::BaseRelayCoordinate::new("local", 0, 20).unwrap(),
            &NoFaults,
            1100,
        )
        .unwrap();
        let dependency = Ydoc::wire();
        let predecessor = dependency.plaintext_insert(0, "dependency");
        let pending = if deletion {
            dependency.plaintext_delete(0, 1)
        } else {
            dependency.plaintext_insert(0, "pending ")
        };
        let pending_sha = store.put_binary_blob(&pending).unwrap();
        let delta = |sha: &str, origin: &str| {
            envelope(
                origin,
                0,
                "ydoc.update",
                json!({
                    "versionId":"main","objectId":key.object_id,"path":path,"contentKind":"plaintext",
                    "updateBlobSha256":sha,"lineageClaimId":claim,"isBaseState":false
                }),
            )
        };
        apply_ydoc_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &delta(&pending_sha, "pending"),
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        if existing_review {
            let snapshot = VersionedTextStore::new(&mut store)
                .read_text("ws", "main", path)
                .unwrap()
                .unwrap();
            let mut prior = snapshot.clone();
            prior.text = "prior incoming".to_owned();
            prior.blob_sha256 = dohc_engine_storage::hex_sha256(prior.text.as_bytes());
            prior.latest_moment_id = "prior-incoming".to_owned();
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "INSERT OR IGNORE INTO blobs(sha256,byte_length,text) VALUES (?1,?2,?3)",
                        params![prior.blob_sha256, prior.text.len() as i64, prior.text],
                    )
                    .map_err(SyncError::persist)?;
                    let side =
                        dohc_engine_domain::ConflictFileState::text(path, Some(snapshot.clone()));
                    dohc_engine_domain::insert_text_conflict_if_absent(
                        tx,
                        &dohc_engine_domain::TextConflict {
                            conflict_id: "existing-review".to_owned(),
                            workspace_id: "ws".to_owned(),
                            path: path.to_owned(),
                            target_version_id: "main".to_owned(),
                            source_version_id: "peer".to_owned(),
                            created_at_ms: 1200,
                            updated_at_ms: 1200,
                            status: dohc_engine_domain::ConflictStatus::Open,
                            chosen_from: dohc_engine_domain::ConflictChoice::Current,
                            resolution: None,
                            metadata: dohc_engine_domain::ConflictMetadata::origin("sync"),
                            base: side.clone(),
                            current: side,
                            incoming: dohc_engine_domain::ConflictFileState::text(
                                path,
                                Some(prior.clone()),
                            ),
                        },
                    )
                    .map_err(|error| {
                        SyncError::corrupt(std::io::Error::other(error.to_string()))
                    })?;
                    Ok::<_, SyncError>(())
                })
                .unwrap();
            let update = local.plaintext_insert(0, "unsettled ");
            dohc_engine_collab::record_local_update(
                &mut store,
                &mut WriterDocCache::new(),
                &key,
                &update,
                dohc_engine_collab::LocalAppend::default(),
                &NoFaults,
                1300,
                |_tx, _outcome, _sha| Ok(()),
            )
            .unwrap();
        }
        let incoming = Ydoc::wire();
        incoming.plaintext_insert(0, "same");
        let sha = store
            .put_binary_blob(&incoming.encode_full_state())
            .unwrap();
        let mut base = envelope(
            "remote",
            0,
            "ydoc.update",
            json!({
                "versionId":"main","objectId":key.object_id,"path":path,"contentKind":"plaintext",
                "updateBlobSha256":sha,"lineageClaimId":sha,"isBaseState":true
            }),
        );
        base.relay_seq = Some(10);
        apply_ydoc_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &base,
            &NoFaults,
            if deferred { &AlwaysLive } else { &NoLiveLeases },
        )
        .unwrap();
        if deferred {
            let crashed = drain_deferred_ydoc_for_key(
                &mut store,
                &mut WriterDocCache::new(),
                &key,
                ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck).as_ref(),
            );
            assert!(crashed.is_err());
        }
        drop(store);
        let mut store = EngineStore::open(&db_path, 2000).unwrap();
        if deferred {
            drain_deferred_ydoc_for_key(&mut store, &mut WriterDocCache::new(), &key, &NoFaults)
                .unwrap();
        }
        let persisted = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap();
        assert!(!persisted.doc.has_pending_dependencies());
        assert_eq!(
            persisted.marker.lineage_claim_id.as_deref(),
            Some(sha.as_str())
        );
        let retained: Vec<u8> = store.read_with(|conn| conn.query_row(
            "SELECT b.bytes FROM ydoc_inactive_lineages l JOIN binary_blobs b ON b.sha256=l.full_state_blob_sha256 WHERE l.lineage_claim_id=?1",
            [&claim], |row| row.get(0))).unwrap();
        let archived = Ydoc::wire();
        archived.apply(&retained).unwrap();
        assert!(archived.has_pending_dependencies());
        if existing_review {
            let recovered: i64 = store.read_with(|conn| conn.query_row(
                "SELECT COUNT(*) FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.object_id LIKE 'ydoc-recovery-object-%' AND b.text IN ('unsettled same','prior incoming')",
                [],|row| row.get(0))).unwrap();
            assert_eq!(
                recovered, 2,
                "both previously unreviewed texts remain visible"
            );
        }
        let replay = apply_ydoc_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &base,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(matches!(replay.primary, ApplyDisposition::Skipped));
        let predecessor_sha = store.put_binary_blob(&predecessor).unwrap();
        apply_ydoc_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &delta(&predecessor_sha, "predecessor"),
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        let persisted = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap();
        assert!(!persisted.doc.has_pending_dependencies());
        assert_eq!(persisted.doc.plaintext_string(), "same");
        let recovered: String = store.read_with(|conn| conn.query_row(
            "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.object_id LIKE 'ydoc-recovery-object-%' AND b.text LIKE '%ependency%'", [], |row| row.get(0))).unwrap();
        assert!(recovered.contains(if deletion {
            "ependency"
        } else {
            "pending dependency"
        }));
        let count = |store: &EngineStore| {
            store.read_with(|conn| conn.query_row("SELECT COUNT(*) FROM snapshots WHERE object_id LIKE 'ydoc-recovery-object-%'",[],|row| row.get::<_,i64>(0))).unwrap()
        };
        let recovery_count = count(&store);
        for seq in 0..3 {
            let update = local.plaintext_insert(0, "late ");
            let sha = store.put_binary_blob(&update).unwrap();
            let mut op = delta(&sha, "late-loser");
            op.origin_seq = seq;
            op.payload["path"] = json!("notes/renamed-loser.md");
            op.payload["contentKind"] = json!("richdoc");
            apply_ydoc_envelope(
                &mut store,
                &mut WriterDocCache::new(),
                &op,
                &NoFaults,
                if deferred { &AlwaysLive } else { &NoLiveLeases },
            )
            .unwrap();
            if deferred {
                drain_deferred_ydoc_for_key(
                    &mut store,
                    &mut WriterDocCache::new(),
                    &key,
                    &NoFaults,
                )
                .unwrap();
            }
            assert_eq!(
                count(&store),
                recovery_count,
                "later batches update the same recovery file"
            );
        }
        let late_text:String = store.read_with(|conn| conn.query_row(
            "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.metadata_correlation_id LIKE 'ydoc-inactive-recovery:%'",
            [],|row| row.get(0))).unwrap();
        assert!(late_text.contains("late late late"), "{late_text}");
        let update = incoming.plaintext_insert(0, "winner edit ");
        let update_sha = store.put_binary_blob(&update).unwrap();
        let mut update_op = delta(&update_sha, "remote");
        update_op.origin_seq = 1;
        update_op.payload["lineageClaimId"] = json!(sha);
        apply_ydoc_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &update_op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        let incoming_text: String = store.read_with(|conn| conn.query_row(
            "SELECT b.text FROM conflicts c JOIN blobs b ON b.sha256=c.incoming_blob_sha256 WHERE c.status='open'", [], |row| row.get(0))).unwrap();
        assert_eq!(incoming_text, "winner edit same");
        resolve_seed_conflict(&mut store, &key, false);
        assert_eq!(
            dohc_engine_collab::load_persisted(&store, &key)
                .unwrap()
                .unwrap()
                .doc
                .plaintext_string(),
            "winner edit same"
        );
    }
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
            // Restart after the local commit, before any resolution delivery.
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

#[test]
fn simultaneous_seed_resolutions_replay_the_same_choice_or_review_different_choices() {
    use dohc_engine_collab::{ContentKind, DocKey, WriterDocCache, Ydoc};
    for (same_choice, resolve_on_a, keep_next, edited, crossing, crossing_edit) in [
        (true, true, true, false, false, 0),
        (true, true, true, true, false, 0),
        (false, true, true, false, false, 0),
        (false, true, false, false, false, 0),
        (false, false, true, false, false, 0),
        (false, false, false, false, false, 0),
        (false, true, true, false, true, 0),
        (false, true, false, false, true, 0),
        (false, true, true, false, true, 1),
        (false, true, false, false, true, 1),
        (false, true, true, false, true, 2),
        (false, true, false, false, true, 2),
        (false, true, true, false, true, 3),
        (false, true, false, false, true, 3),
        (false, true, true, false, true, 4),
        (false, true, false, false, true, 4),
        (false, true, true, false, true, 5),
        (false, true, false, false, true, 5),
        (false, true, true, false, true, 6),
    ] {
        let (_sa, _pa, mut a) = open_store();
        let (_sb, _pb, mut b) = open_store();
        let key = DocKey::new("ws", "main", "concurrent-seeds").unwrap();
        let path = "notes/concurrent-seeds.md";
        let loser = Ydoc::wire();
        loser.plaintext_insert(0, "local seed");
        let winner = Ydoc::wire();
        winner.plaintext_insert(0, "remote seed");
        for store in [&mut a, &mut b] {
            seed_identity(store);
            VersionedTextStore::new(store)
                .ensure_main_version("ws", "main", 1000, &NoFaults)
                .unwrap();
            seed_resolution_head(store, &key.object_id, path, "local seed");
            dohc_engine_collab::claim_base_at_relay(
                store,
                &key,
                ContentKind::Plaintext,
                &loser.encode_full_state(),
                &dohc_engine_collab::BaseRelayCoordinate::new("loser", 0, 20).unwrap(),
                &NoFaults,
                1100,
            )
            .unwrap();
            let sha = store.put_binary_blob(&winner.encode_full_state()).unwrap();
            let mut op = envelope(
                "winner",
                0,
                "ydoc.update",
                json!({
                    "versionId":"main","objectId":key.object_id,"path":path,"contentKind":"plaintext",
                    "updateBlobSha256":sha,"lineageClaimId":sha,"isBaseState":true
                }),
            );
            op.relay_seq = Some(10);
            apply_ydoc_envelope(
                store,
                &mut WriterDocCache::new(),
                &op,
                &NoFaults,
                &NoLiveLeases,
            )
            .unwrap();
        }
        resolve_seed_conflict_with_faults(
            &mut a,
            &key,
            true,
            &NoFaults,
            false,
            "resolution-write-a",
            10_000,
        );
        resolve_seed_conflict_with_faults(
            &mut b,
            &key,
            same_choice,
            &NoFaults,
            false,
            "resolution-write-b",
            10_001,
        );
        let a_ops = seed_resolution_ops(&a, "resolution-a");
        let b_ops = seed_resolution_ops(&b, "resolution-b");
        if edited {
            let doc = dohc_engine_collab::load_persisted(&a, &key)
                .unwrap()
                .unwrap()
                .doc;
            let update = doc.plaintext_insert(0, "unsettled ");
            dohc_engine_collab::record_local_update(
                &mut a,
                &mut WriterDocCache::new(),
                &key,
                &update,
                dohc_engine_collab::LocalAppend::default(),
                &NoFaults,
                10_002,
                |_tx, _outcome, _sha| Ok(()),
            )
            .unwrap();
        }
        copy_seed_blobs(&a, &mut b);
        copy_seed_blobs(&b, &mut a);
        for (store, ops, expected) in [
            (
                &mut a,
                &b_ops,
                if edited {
                    "unsettled local seed"
                } else {
                    "local seed"
                },
            ),
            (
                &mut b,
                &a_ops,
                if same_choice {
                    "local seed"
                } else {
                    "remote seed"
                },
            ),
        ] {
            for op in ops {
                let applied = crate::apply_replication_envelope(
                    store,
                    &mut WriterDocCache::new(),
                    op,
                    &NoFaults,
                    &NoLiveLeases,
                )
                .unwrap();
                assert!(
                    matches!(applied.primary, ApplyDisposition::Applied(_)),
                    "{applied:?}"
                );
            }
            let reviews: i64 = store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM conflicts WHERE status='open'",
                        [],
                        |row| row.get(0),
                    )
                })
                .unwrap();
            assert_eq!(
                reviews,
                if !same_choice || expected.starts_with("unsettled ") {
                    1
                } else {
                    0
                }
            );
            let doc = dohc_engine_collab::load_persisted(store, &key)
                .unwrap()
                .unwrap();
            assert_eq!(doc.doc.plaintext_string(), expected);
        }
        if edited {
            resolve_seed_conflict_with_faults(
                &mut a,
                &key,
                true,
                &NoFaults,
                false,
                "after-equivalent-choice",
                11_000,
            );
        } else if same_choice {
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
            assert_seed_heads_and_delete_converge(&mut a, &mut b, &key, path);
        } else {
            let (resolver, receiver) = if resolve_on_a {
                (&mut a, &mut b)
            } else {
                (&mut b, &mut a)
            };
            let mut clone = if crossing_edit == 3 {
                let clone_path = _pa.with_extension("review-clone.sqlite");
                resolver
                    .read_with(|conn| {
                        conn.execute("VACUUM INTO ?1", [clone_path.to_str().unwrap()])
                    })
                    .unwrap();
                Some(EngineStore::open(&clone_path, 10_500).unwrap())
            } else {
                None
            };
            let receiver = clone.as_mut().unwrap_or(receiver);
            resolve_seed_conflict_with_faults(
                resolver,
                &key,
                keep_next,
                &NoFaults,
                false,
                "second-choice",
                11_000,
            );
            let crossing_ops = if crossing {
                resolve_seed_conflict_with_faults(
                    receiver,
                    &key,
                    true,
                    &NoFaults,
                    false,
                    "crossing-choice",
                    11_001,
                );
                let mut ops = seed_resolution_ops(receiver, "crossing-resolver");
                ops.retain(|op| op.recorded_at_ms == 11_001);
                for (seq, op) in ops.iter_mut().enumerate() {
                    op.origin_seq = seq as i64;
                }
                copy_seed_blobs(receiver, resolver);
                ops
            } else {
                Vec::new()
            };
            let mut crossing_updates = Vec::new();
            if crossing_edit > 0 && crossing_edit != 3 && crossing_edit < 5 {
                for store in [&mut *resolver, &mut *receiver] {
                    let doc = dohc_engine_collab::load_persisted(store, &key)
                        .unwrap()
                        .unwrap()
                        .doc;
                    if crossing_edit == 4 {
                        let update = doc.plaintext_insert(0, "settled ");
                        dohc_engine_collab::record_local_update(
                            store,
                            &mut WriterDocCache::new(),
                            &key,
                            &update,
                            dohc_engine_collab::LocalAppend::default(),
                            &NoFaults,
                            11_002,
                            |_tx, _outcome, _sha| Ok(()),
                        )
                        .unwrap();
                        store
                            .write_with(&NoFaults, |tx| {
                                crate::ydoc_apply::project_and_write_in_tx(
                                    tx,
                                    &key,
                                    path,
                                    &doc,
                                    ContentKind::Plaintext,
                                    "settled-crossing",
                                    0,
                                    11_002,
                                    None,
                                )
                            })
                            .unwrap();
                    }
                    let update = if crossing_edit == 1 || crossing_edit == 4 {
                        doc.plaintext_insert(0, "between choices ")
                    } else {
                        doc.plaintext_delete(0, 1)
                    };
                    crossing_updates.push((
                        dohc_engine_collab::read_marker(store, &key)
                            .unwrap()
                            .unwrap()
                            .lineage_claim_id
                            .unwrap(),
                        if crossing_edit == 4 {
                            doc.encode_full_state()
                        } else {
                            update.clone()
                        },
                        doc.plaintext_string(),
                    ));
                    dohc_engine_collab::record_local_update(
                        store,
                        &mut WriterDocCache::new(),
                        &key,
                        &update,
                        dohc_engine_collab::LocalAppend::default(),
                        &NoFaults,
                        11_002,
                        |_tx, _outcome, _sha| Ok(()),
                    )
                    .unwrap();
                }
            }
            let mut ops = seed_resolution_ops(resolver, "second-resolver");
            ops.retain(|op| op.recorded_at_ms == 11_000);
            assert!(!ops.is_empty());
            copy_seed_blobs(resolver, receiver);
            if crossing_edit == 6 {
                let resolver_claim = dohc_engine_collab::read_marker(resolver, &key)
                    .unwrap()
                    .unwrap()
                    .lineage_claim_id;
                let receiver_claim = dohc_engine_collab::read_marker(receiver, &key)
                    .unwrap()
                    .unwrap()
                    .lineage_claim_id;
                let (store, winning_ops) = if resolver_claim > receiver_claim {
                    (&mut *resolver, &crossing_ops)
                } else {
                    (&mut *receiver, &ops)
                };
                let doc = dohc_engine_collab::load_persisted(store, &key)
                    .unwrap()
                    .unwrap()
                    .doc;
                let update = doc.plaintext_insert(
                    0,
                    &"x".repeat(dohc_engine_collab::limits::MAX_PROJECTION_BYTES),
                );
                dohc_engine_collab::record_local_update(
                    store,
                    &mut WriterDocCache::new(),
                    &key,
                    &update,
                    dohc_engine_collab::LocalAppend::default(),
                    &NoFaults,
                    11_002,
                    |_tx, _outcome, _sha| Ok(()),
                )
                .unwrap();
                for (seq, op) in winning_ops.iter().enumerate() {
                    let mut op = op.clone();
                    op.origin_seq = seq as i64;
                    let outcome = crate::apply_replication_envelope(
                        store,
                        &mut WriterDocCache::new(),
                        &op,
                        &NoFaults,
                        &NoLiveLeases,
                    )
                    .unwrap();
                    if seq == 0 {
                        assert!(
                            matches!(outcome.primary, ApplyDisposition::Refused(_)),
                            "{outcome:?}"
                        );
                    } else {
                        assert!(
                            matches!(outcome.primary, ApplyDisposition::Applied(_)),
                            "{outcome:?}"
                        );
                    }
                    assert_eq!(
                        crate::read_replication_acked_seq(store, "ws", &op.origin_id).unwrap(),
                        seq as i64
                    );
                    let replay = crate::apply_replication_envelope(
                        store,
                        &mut WriterDocCache::new(),
                        &op,
                        &NoFaults,
                        &NoLiveLeases,
                    )
                    .unwrap();
                    assert!(matches!(replay.primary, ApplyDisposition::Skipped));
                }
                assert_eq!(
                    dohc_engine_collab::load_persisted(store, &key)
                        .unwrap()
                        .unwrap()
                        .doc
                        .plaintext_string(),
                    doc.plaintext_string()
                );
                continue;
            }
            if crossing_edit == 5 {
                for store in [&mut *resolver, &mut *receiver] {
                    let input = dohc_engine_domain::RenameTextFile {
                        workspace_id: "ws".into(),
                        version_id: "main".into(),
                        from_path: path.into(),
                        to_path: "notes/renamed.md".into(),
                        moment_id: "concurrent-rename".into(),
                        request_id: None,
                        metadata_origin: "sync".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 11_002,
                    };
                    VersionedTextStore::new(store)
                        .rename_text_file_with(&input, &NoFaults, |tx, result| {
                            crate::reconcile_local_resulting_head_in_tx(
                                tx,
                                "ws",
                                "main",
                                &key.object_id,
                                crate::ResultingHead::Text {
                                    path: &result.after.path,
                                    text: &result.after.text,
                                },
                                None,
                                None,
                                11_002,
                            )
                            .map(|_| ())
                            .map_err(|error| {
                                dohc_engine_domain::DomainError::Storage(
                                    dohc_engine_storage::StorageError::corrupt_public(error),
                                )
                            })
                        })
                        .unwrap();
                }
            }
            for (seq, op) in ops.iter_mut().enumerate() {
                op.origin_seq = seq as i64;
                let applied = crate::apply_replication_envelope(
                    receiver,
                    &mut WriterDocCache::new(),
                    op,
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
            for op in &crossing_ops {
                let outcome = crate::apply_replication_envelope(
                    resolver,
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
            }
            assert_eq!(
                dohc_engine_collab::read_marker(resolver, &key)
                    .unwrap()
                    .unwrap()
                    .lineage_claim_id,
                dohc_engine_collab::read_marker(receiver, &key)
                    .unwrap()
                    .unwrap()
                    .lineage_claim_id,
            );
            if crossing_edit == 5 {
                for store in [&mut *resolver, &mut *receiver] {
                    let before: (String, String) = store
                        .read_with(|conn| {
                            conn.query_row(
                                "SELECT path,latest_moment_id FROM snapshots WHERE object_id=?1",
                                [&key.object_id],
                                |row| Ok((row.get(0)?, row.get(1)?)),
                            )
                        })
                        .unwrap();
                    assert_eq!(
                        before,
                        ("notes/renamed.md".into(), "concurrent-rename".into())
                    );
                    assert_eq!(
                        dohc_engine_collab::read_marker(store, &key)
                            .unwrap()
                            .unwrap()
                            .path
                            .as_deref(),
                        Some("notes/renamed.md")
                    );
                }
                continue;
            }
            for (index, (claim, update, _)) in crossing_updates.iter().enumerate() {
                for store in [&mut *resolver, &mut *receiver] {
                    let sha = store.put_binary_blob(update).unwrap();
                    let op = envelope(
                        &format!("crossing-edit-{index}"),
                        0,
                        "ydoc.update",
                        json!({
                            "versionId":"main","objectId":key.object_id,"path":path,"contentKind":"plaintext",
                            "updateBlobSha256":sha,"lineageClaimId":claim,"isBaseState":false,
                        }),
                    );
                    apply_ydoc_envelope(
                        store,
                        &mut WriterDocCache::new(),
                        &op,
                        &NoFaults,
                        &NoLiveLeases,
                    )
                    .unwrap();
                }
            }
            for store in [&*resolver, &*receiver] {
                let mut visible:Vec<String> = store.read_with(|conn| conn.prepare(
                    "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.object_id LIKE 'ydoc-recovery-object-%'")?
                    .query_map([],|row| row.get(0))?.collect::<Result<_,_>>()).unwrap();
                visible.push(
                    dohc_engine_collab::load_persisted(store, &key)
                        .unwrap()
                        .unwrap()
                        .doc
                        .plaintext_string(),
                );
                for (_, _, text) in &crossing_updates {
                    assert!(visible.contains(text), "missing {text:?} from {visible:?}");
                }
            }
            assert_seed_edits_converge(resolver, receiver, &key, path);
            assert_seed_heads_and_delete_converge(resolver, receiver, &key, path);
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

fn assert_seed_edits_converge(
    a: &mut EngineStore,
    b: &mut EngineStore,
    key: &dohc_engine_collab::DocKey,
    path: &str,
) {
    use dohc_engine_collab::WriterDocCache;
    for (reverse, origin, text) in [(false, "edit-a", "from A "), (true, "edit-b", "from B ")] {
        let (source, target) = if reverse {
            (&mut *b, &mut *a)
        } else {
            (&mut *a, &mut *b)
        };
        let doc = dohc_engine_collab::load_persisted(source, key)
            .unwrap()
            .unwrap();
        let claim = doc.marker.lineage_claim_id.unwrap();
        let update = doc.doc.plaintext_insert(0, text);
        for store in [source, target] {
            let sha = store.put_binary_blob(&update).unwrap();
            let op = envelope(
                origin,
                0,
                "ydoc.update",
                json!({"versionId":"main","objectId":key.object_id,"path":path,
                "contentKind":"plaintext","updateBlobSha256":sha,"lineageClaimId":claim,"isBaseState":false}),
            );
            apply_ydoc_envelope(
                store,
                &mut WriterDocCache::new(),
                &op,
                &NoFaults,
                &NoLiveLeases,
            )
            .unwrap();
        }
    }
    let left = dohc_engine_collab::load_persisted(a, key)
        .unwrap()
        .unwrap()
        .doc
        .plaintext_string();
    let right = dohc_engine_collab::load_persisted(b, key)
        .unwrap()
        .unwrap()
        .doc
        .plaintext_string();
    assert_eq!(left, right);
    assert!(left.contains("from A") && left.contains("from B"));
}

#[test]
fn local_unpublished_authors_survive_compaction_base_replacement_and_local_choice() {
    use dohc_engine_collab::{ContentKind, DocKey, LocalAppend, Regime, WriterDocCache, Ydoc};
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
            dohc_engine_collab::ensure_marker(
                &mut engine,
                &key,
                ContentKind::Plaintext,
                Regime::LocalOnly,
                &NoFaults,
                1_100,
            )
            .unwrap();
            let local = Ydoc::wire();
            let edit = local.plaintext_insert(0, "Bob's local edit");
            let attribution = ChangeAttribution {
                actor_kind: ChangeActorKind::Agent,
                on_behalf_of: None,
                depth: 0,
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
fn incomplete_local_side_retains_authors_until_its_recovery_moment() {
    use dohc_engine_collab::{ContentKind, DocKey, LocalAppend, Regime, WriterDocCache, Ydoc};
    use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
    for deferred in [false, true] {
        let (_scratch, db, mut engine) = open_store();
        VersionedTextStore::new(&mut engine)
            .ensure_main_version("ws", "main", 1_000, &NoFaults)
            .unwrap();
        let path = "notes/pending-author.md";
        let key = DocKey::new("ws", "main", "pending-author").unwrap();
        dohc_engine_collab::ensure_marker(
            &mut engine,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_100,
        )
        .unwrap();
        let local = Ydoc::wire();
        let first = local.plaintext_insert(0, "first");
        let second = local.plaintext_insert(5, " Bob");
        let attribution = ChangeAttribution {
            actor_kind: ChangeActorKind::Agent,
            on_behalf_of: None,
            depth: 0,
        };
        dohc_engine_collab::record_local_update(
            &mut engine,
            &mut WriterDocCache::new(),
            &key,
            &second,
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
        let remote = Ydoc::wire();
        remote.plaintext_insert(0, "remote");
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
            drain_deferred_ydoc_for_key(&mut engine, &mut WriterDocCache::new(), &key, &NoFaults)
                .unwrap();
        }
        let (claim, pending): (String, String) = engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT lineage_claim_id,pending_authors_json FROM ydoc_inactive_lineages \
             WHERE object_id=?1",
                    [&key.object_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&pending).unwrap()[0]["agentId"],
            "bob"
        );
        drop(engine);
        let mut engine = EngineStore::open(&db, 2_000).unwrap();
        let first_sha = engine.put_binary_blob(&first).unwrap();
        let predecessor = envelope(
            "local-predecessor",
            0,
            "ydoc.update",
            json!({
                "versionId":"main", "objectId":key.object_id, "path":path,
                "contentKind":"plaintext", "updateBlobSha256":first_sha,
                "lineageClaimId":claim, "isBaseState":false,
            }),
        );
        apply_ydoc_envelope(
            &mut engine,
            &mut WriterDocCache::new(),
            &predecessor,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        let authors: String = engine
            .read_with(|conn| {
                conn.query_row(
            "SELECT m.author_json FROM moments m JOIN blobs b ON b.sha256=m.after_blob_sha256 \
             WHERE b.text='first Bob'", [], |row| row.get(0))
            })
            .unwrap();
        assert_eq!(authors, pending);
        let remaining: String = engine
            .read_with(|conn| {
                conn.query_row(
            "SELECT pending_authors_json FROM ydoc_inactive_lineages WHERE lineage_claim_id=?1",
            [&claim], |row| row.get(0))
            })
            .unwrap();
        assert_eq!(remaining, "[]");
    }
}
