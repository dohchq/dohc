use super::*;

/// #4 (secret tombstone): once a delete wins, a later delivery of an older put
/// must not resurrect the deleted secret (rank against tombstones, not the
/// materialized secret_files tip).
#[test]
fn secret_delete_tombstone_blocks_older_put_resurrection() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = open_store();
    let cipher_a: &[u8] = b"ciphertext-A-payload";
    let cipher_b: &[u8] = b"ciphertext-B-different-payload";
    let sha_a = dohc_engine_storage::hex_sha256(cipher_a);
    let sha_b = dohc_engine_storage::hex_sha256(cipher_b);
    // Prereqs: the target version must exist and the ciphertext blobs must be
    // hydrated (apply_put reads binary_blobs and checks the hash/length).
    let seeded = engine
        .write_with(&NoFaults, |tx| -> Result<(), SyncError> {
            tx.execute(
                "INSERT OR IGNORE INTO versioned_workspaces (workspace_id, main_version_id) VALUES ('ws','v1')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT OR IGNORE INTO versions (workspace_id, version_id, kind, name, created_at_ms) VALUES ('ws','v1','main','Main',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            dohc_engine_storage::put_binary_blob(tx, cipher_a).map_err(SyncError::from)?;
            dohc_engine_storage::put_binary_blob(tx, cipher_b).map_err(SyncError::from)?;
            Ok(())
        })
        .expect("seed secret prereqs");
    assert_eq!(seeded, TxnOutcome::Committed(()));

    let iv = STANDARD.encode([0u8; SECRET_IV_BYTES]);
    let tag = STANDARD.encode([0u8; SECRET_TAG_BYTES]);
    let put = |seq: i64, at: i64, sha: &str, len: i64| ReplicationEnvelope {
        workspace_id: "ws".to_owned(),
        origin_id: "peer".to_owned(),
        origin_seq: seq,
        op_kind: "secret.file.put".to_owned(),
        payload: json!({
            "versionId":"v1","path":"app/.env","metadata":{"origin":"sync"},
            "ivBase64": iv, "authTagBase64": tag, "ciphertextSha256": sha, "byteLength": len
        }),
        recorded_at_ms: at,
        relay_seq: Some(seq),
    };
    // put @10 wins over an empty tip.
    assert!(matches!(
        apply_secret_envelope(
            &mut engine,
            &put(0, 10, &sha_a, cipher_a.len() as i64),
            &NoFaults
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(()),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    // delete @20 wins and removes the materialized secret_files row.
    let delete = ReplicationEnvelope {
        workspace_id: "ws".to_owned(),
        origin_id: "peer".to_owned(),
        origin_seq: 1,
        op_kind: "secret.file.delete".to_owned(),
        payload: json!({"versionId":"v1","path":"app/.env","metadata":{"origin":"sync"}}),
        recorded_at_ms: 20,
        relay_seq: Some(1),
    };
    assert!(matches!(
        apply_secret_envelope(&mut engine, &delete, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(()),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    // A late delivery of an older put (@5) must not resurrect the secret.
    assert!(matches!(
        apply_secret_envelope(
            &mut engine,
            &put(2, 5, &sha_b, cipher_b.len() as i64),
            &NoFaults
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(()),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let materialized: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM secret_files WHERE workspace_id='ws' AND version_id='v1' AND path='app/.env'",
                [],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("secret_files count");
    assert_eq!(
        materialized, 0,
        "delete tombstone must block the older-put resurrection"
    );
}

#[test]
fn secret_and_version_missing_dependencies_retry_and_apply_after_version_arrival() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_secret_scratch, _secret_path, mut secret_engine) = open_store();
    let ciphertext = b"late secret";
    let sha = secret_engine
        .put_binary_blob(ciphertext)
        .expect("secret blob");
    let secret = envelope(
        "late-secret-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "late-secret-version",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": ciphertext.len()
        }),
    );
    assert!(matches!(
        apply_secret_envelope(&mut secret_engine, &secret, &NoFaults),
        Err(SyncError::RetryableState {
            reason: "secret target version is missing"
        })
    ));
    assert_unacked_and_unjournaled(&secret_engine, "late-secret-peer");
    seed_replication_version(&mut secret_engine, "late-secret-version", "named");
    assert!(matches!(
        apply_secret_envelope(&mut secret_engine, &secret, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(()),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let (_version_scratch, _version_path, mut version_engine) = open_store();
    seed_replication_version(&mut version_engine, "main", "main");
    let child = envelope(
        "late-version-child-peer",
        0,
        "version.create",
        json!({
            "versionId": "late-child",
            "name": "Late child",
            "kind": "named",
            "forkVersionId": "late-source",
            "forkMomentId": "late-source-tip",
            "createdAtMs": 30,
            "forkSnapshots": []
        }),
    );
    assert!(matches!(
        apply_replication_envelope(
            &mut version_engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &child,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::RetryableState {
            reason: "version.create source version is missing"
        })
    ));
    assert_unacked_and_unjournaled(&version_engine, "late-version-child-peer");
    let source = envelope(
        "late-version-source-peer",
        0,
        "version.create",
        json!({
            "versionId": "late-source",
            "name": "Late source",
            "kind": "named",
            "createdAtMs": 20,
            "forkSnapshots": []
        }),
    );
    assert!(matches!(
        apply_replication_envelope(
            &mut version_engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &source,
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
        apply_replication_envelope(
            &mut version_engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &child,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let created: bool = version_engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM versions \
                 WHERE workspace_id='ws' AND version_id='late-child')",
                [],
                |row| row.get(0),
            )
        })
        .expect("late child version");
    assert!(
        created,
        "terminal missing-version classification prevents later dependency arrival from reviving the operation"
    );
}

fn assert_unacked_and_unjournaled(engine: &EngineStore, origin_id: &str) {
    assert_eq!(
        read_replication_acked_seq(engine, "ws", origin_id).expect("retry ack"),
        -1
    );
    let journaled: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id=?1",
                [origin_id],
                |row| row.get(0),
            )
        })
        .expect("retry journal");
    assert_eq!(
        journaled, 0,
        "a retryable dependency must not be journaled before it applies"
    );
}

fn seed_secret_fork_state(engine: &mut EngineStore, ciphertext: &[u8]) -> (String, String, String) {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    seed_replication_version(engine, "main", "main");
    seed_replication_version(engine, "feature", "named");
    let sha = engine
        .put_binary_blob(ciphertext)
        .expect("secret ciphertext blob");
    let iv = STANDARD.encode([7_u8; SECRET_IV_BYTES]);
    let tag = STANDARD.encode([9_u8; SECRET_TAG_BYTES]);
    let ciphertext_base64 = STANDARD.encode(ciphertext);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO secret_files \
                 (workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length,updated_at_ms,latest_moment_id) \
                 VALUES ('ws','main','app/.env',?1,?2,?3,?4,100,'source-tip')",
                params![iv, tag, ciphertext_base64, ciphertext.len() as i64],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO secret_files \
                 (workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length,updated_at_ms,latest_moment_id) \
                 VALUES ('ws','main','config/prod.env',?1,?2,?3,?4,101,'source-tip-2')",
                params![iv, tag, ciphertext_base64, ciphertext.len() as i64],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO secret_files \
                 (workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length,updated_at_ms,latest_moment_id) \
                 VALUES ('ws','feature','stale.env',?1,?2,?3,?4,1,'stale-tip')",
                params![iv, tag, ciphertext_base64, ciphertext.len() as i64],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO secret_fork_bases \
                 (workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length) \
                 VALUES ('ws','feature','stale.env',?1,?2,?3,?4)",
                params![iv, tag, ciphertext_base64, ciphertext.len() as i64],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed secret fork state");
    (sha, iv, tag)
}

type SecretSnapshotRow = (String, String, String, i64);

fn map_secret_snapshot_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SecretSnapshotRow> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
}

#[test]
fn secret_version_fork_router_copies_the_complete_payload_and_replays_idempotently() {
    let (_scratch, _path, mut engine) = open_store();
    let ciphertext = b"sealed source bytes";
    let (sha, iv, tag) = seed_secret_fork_state(&mut engine, ciphertext);
    let operation = envelope(
        "secret-fork-peer",
        0,
        "secret.version.fork",
        json!({
            "fromVersionId": "main",
            "toVersionId": "feature",
            "chunkIndex": 0,
            "totalRows": 2,
            "rows": [{
                "path": "app/.env",
                "ivBase64": iv,
                "authTagBase64": tag,
                "ciphertextSha256": sha,
                "byteLength": ciphertext.len(),
                "updatedAtMs": 100
            }, {
                "path": "config/prod.env",
                "ivBase64": iv,
                "authTagBase64": tag,
                "ciphertextSha256": sha,
                "byteLength": ciphertext.len(),
                "updatedAtMs": 101
            }]
        }),
    );

    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &operation,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(RoutedApply { conflict: None, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let rows: (Vec<String>, Vec<String>) = engine
        .read_with(|conn| {
            let files = conn
                .prepare(
                    "SELECT path FROM secret_files WHERE workspace_id='ws' AND version_id='feature' ORDER BY path",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let bases = conn
                .prepare(
                    "SELECT path FROM secret_fork_bases WHERE workspace_id='ws' AND version_id='feature' ORDER BY path",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>((files, bases))
        })
        .expect("secret fork rows");
    assert_eq!(
        rows,
        (
            vec!["app/.env".into(), "config/prod.env".into()],
            vec!["app/.env".into(), "config/prod.env".into()]
        )
    );
    let mut applier_replay = operation.clone();
    applier_replay.origin_id = "secret-fork-applier-replay-peer".into();
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &applier_replay,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(RoutedApply { conflict: None, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let replayed_rows: (i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM secret_files \
                     WHERE workspace_id='ws' AND version_id='feature'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM secret_fork_bases \
                     WHERE workspace_id='ws' AND version_id='feature'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("replayed secret fork rows");
    assert_eq!(replayed_rows, (2, 2));
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &applier_replay,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Skipped,
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
}

#[test]
fn later_secret_version_fork_chunk_preserves_a_local_write_to_its_pending_path() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = open_store();
    let origin_ciphertext = b"origin pending secret";
    let (sha, iv, tag) = seed_secret_fork_state(&mut engine, origin_ciphertext);
    let chunk = |seq, chunk_index, path: &str| {
        envelope(
            "chunked-secret-fork-peer",
            seq,
            "secret.version.fork",
            json!({
                "fromVersionId": "main",
                "toVersionId": "feature",
                "chunkIndex": chunk_index,
                "totalRows": 2,
                "rows": [{
                    "path": path,
                    "ivBase64": iv,
                    "authTagBase64": tag,
                    "ciphertextSha256": sha,
                    "byteLength": origin_ciphertext.len(),
                    "updatedAtMs": 100 + chunk_index
                }]
            }),
        )
    };
    let first = chunk(0, 0, "app/.env");
    let second = chunk(1, 1, "pending.env");
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &first,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(RoutedApply { conflict: None, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let local_ciphertext = b"local edit";
    let local_ciphertext_base64 = STANDARD.encode(local_ciphertext);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO secret_files \
                 (workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length,updated_at_ms,latest_moment_id) \
                 VALUES ('ws','feature','pending.env',?1,?2,?3,?4,200,'local-pending-moment')",
                params![iv, tag, local_ciphertext_base64, local_ciphertext.len() as i64],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("write pending secret locally");

    let second_result = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &second,
        &NoFaults,
        &NoLiveLeases,
    );
    assert!(
        matches!(
            second_result,
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(RoutedApply { conflict: None, .. }),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ),
        "later chunk failed: {second_result:?}"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "chunked-secret-fork-peer").expect("fork ack"),
        1
    );
    let live: (String, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT ciphertext_base64,latest_moment_id FROM secret_files \
                 WHERE workspace_id='ws' AND version_id='feature' AND path='pending.env'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("read pending secret");
    assert_eq!(
        live,
        (local_ciphertext_base64, "local-pending-moment".to_owned())
    );
}

#[test]
fn secret_version_fork_refuses_divergent_chunk_assembly() {
    for (label, chunk_index, total_rows, path) in [
        ("duplicate path", 1, 2, "app/.env"),
        ("skipped chunk", 2, 2, "config/prod.env"),
        ("changed total", 1, 3, "config/prod.env"),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        let ciphertext = b"fork assembly bytes";
        let (sha, iv, tag) = seed_secret_fork_state(&mut engine, ciphertext);
        let chunk = |seq, chunk_index, total_rows, path: &str| {
            envelope(
                "divergent-secret-fork-peer",
                seq,
                "secret.version.fork",
                json!({
                    "fromVersionId": "main",
                    "toVersionId": "feature",
                    "chunkIndex": chunk_index,
                    "totalRows": total_rows,
                    "rows": [{
                        "path": path,
                        "ivBase64": iv,
                        "authTagBase64": tag,
                        "ciphertextSha256": sha,
                        "byteLength": ciphertext.len(),
                        "updatedAtMs": 100 + chunk_index
                    }]
                }),
            )
        };
        assert!(matches!(
            apply_replication_envelope(
                &mut engine,
                &mut dohc_engine_collab::WriterDocCache::new(),
                &chunk(0, 0, 2, "app/.env"),
                &NoFaults,
                &NoLiveLeases
            ),
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(RoutedApply { conflict: None, .. }),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ));
        let result = apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &chunk(1, chunk_index, total_rows, path),
            &NoFaults,
            &NoLiveLeases,
        );
        assert!(
            matches!(
                result,
                Ok(ApplyOutcome {
                    primary: ApplyDisposition::Refused(ReplicationRefusal {
                        reason: RefusalReason::InvalidInput { .. },
                        ..
                    }),
                    refusals: ref outcome_refusals,
                    sharing_declined: ref outcome_sharing_declined,
                }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
            ),
            "{label} was not refused: {result:?}"
        );
    }
}

#[test]
fn secret_version_fork_applies_the_shipped_snapshot_after_a_peer_source_edit() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = open_store();
    let fork_point_ciphertext = b"sealed source bytes";
    let (fork_point_sha, fork_point_iv, fork_point_tag) =
        seed_secret_fork_state(&mut engine, fork_point_ciphertext);
    let peer_ciphertext = b"newer peer source bytes";
    let peer_sha = engine
        .put_binary_blob(peer_ciphertext)
        .expect("peer ciphertext blob");
    let peer_iv = STANDARD.encode([3_u8; SECRET_IV_BYTES]);
    let peer_tag = STANDARD.encode([5_u8; SECRET_TAG_BYTES]);
    let peer_edit = envelope(
        "peer-source-edit",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": peer_iv,
            "authTagBase64": peer_tag,
            "ciphertextSha256": peer_sha,
            "byteLength": peer_ciphertext.len()
        }),
    );
    assert!(matches!(
        apply_secret_envelope(&mut engine, &peer_edit, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(()),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let fork = envelope(
        "fork-after-peer-edit",
        0,
        "secret.version.fork",
        json!({
            "fromVersionId": "main",
            "toVersionId": "feature",
            "chunkIndex": 0,
            "totalRows": 2,
            "rows": [{
                "path": "app/.env",
                "ivBase64": fork_point_iv,
                "authTagBase64": fork_point_tag,
                "ciphertextSha256": fork_point_sha,
                "byteLength": fork_point_ciphertext.len(),
                "updatedAtMs": 100
            }, {
                "path": "config/prod.env",
                "ivBase64": fork_point_iv,
                "authTagBase64": fork_point_tag,
                "ciphertextSha256": fork_point_sha,
                "byteLength": fork_point_ciphertext.len(),
                "updatedAtMs": 101
            }]
        }),
    );

    let outcome = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &fork,
        &NoFaults,
        &NoLiveLeases,
    );
    let ack = read_replication_acked_seq(&engine, "ws", "fork-after-peer-edit").expect("ack");
    assert!(
        matches!(
            outcome,
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(RoutedApply { conflict: None, .. }),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ) && ack == 0,
        "fork outcome: {outcome:?}; ack: {ack}"
    );

    let destination = engine
        .read_with(|conn| {
            let file = conn.query_row(
                "SELECT iv_base64,auth_tag_base64,ciphertext_base64,byte_length \
                 FROM secret_files WHERE workspace_id='ws' AND version_id='feature' AND path='app/.env'",
                [],
                map_secret_snapshot_row,
            )?;
            let base = conn.query_row(
                "SELECT iv_base64,auth_tag_base64,ciphertext_base64,byte_length \
                 FROM secret_fork_bases WHERE workspace_id='ws' AND version_id='feature' AND path='app/.env'",
                [],
                map_secret_snapshot_row,
            )?;
            Ok::<_, rusqlite::Error>((file, base))
        })
        .expect("destination snapshot");
    let shipped = (
        fork_point_iv,
        fork_point_tag,
        STANDARD.encode(fork_point_ciphertext),
        fork_point_ciphertext.len() as i64,
    );
    assert_eq!(destination, (shipped.clone(), shipped));
}

#[test]
fn secret_version_fork_refuses_duplicate_paths() {
    let (_scratch, _path, mut engine) = open_store();
    let ciphertext = b"sealed source bytes";
    let (sha, iv, tag) = seed_secret_fork_state(&mut engine, ciphertext);
    let row = json!({
        "path": "app/.env",
        "ivBase64": iv,
        "authTagBase64": tag,
        "ciphertextSha256": sha,
        "byteLength": ciphertext.len(),
        "updatedAtMs": 100
    });
    let duplicate = envelope(
        "duplicate-fork-peer",
        0,
        "secret.version.fork",
        json!({
            "fromVersionId": "main",
            "toVersionId": "feature",
            "chunkIndex": 0,
            "totalRows": 2,
            "rows": [
                row.clone(),
                row
            ]
        }),
    );
    assert!(matches!(
        apply_replication_envelope(&mut engine,&mut dohc_engine_collab::WriterDocCache::new(), &duplicate, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { ref reason },
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "secret fork contains duplicate paths")
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "duplicate-fork-peer").expect("duplicate ack"),
        0,
        "a duplicate path is a payload fault, not a convergence race"
    );
}

#[test]
fn secret_version_fork_refuses_each_invalid_row_boundary() {
    for (origin, mutation, expected_reason) in [
        (
            "malformed-fork-row",
            ("updatedAtMs", json!("not-an-integer")),
            "secret replication payload is malformed",
        ),
        (
            "bad-fork-iv",
            ("ivBase64", json!("not-base64")),
            "secret fork iv is invalid",
        ),
        (
            "bad-fork-auth-tag",
            ("authTagBase64", json!("not-base64")),
            "secret fork auth tag is invalid",
        ),
        (
            "fork-row-total-overflow",
            ("totalRows", json!(0)),
            "secret fork chunk claims more rows than its declared total",
        ),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        let ciphertext = b"sealed source bytes";
        let (sha, iv, tag) = seed_secret_fork_state(&mut engine, ciphertext);
        let mut payload = json!({
            "fromVersionId": "main",
            "toVersionId": "feature",
            "chunkIndex": 0,
            "totalRows": 1,
            "rows": [{
                "path": "app/.env",
                "ivBase64": iv,
                "authTagBase64": tag,
                "ciphertextSha256": sha,
                "byteLength": ciphertext.len(),
                "updatedAtMs": 100
            }]
        });
        if mutation.0 == "totalRows" {
            payload[mutation.0] = mutation.1;
        } else {
            payload["rows"][0][mutation.0] = mutation.1;
        }
        let operation = envelope(origin, 0, "secret.version.fork", payload);

        assert!(
            matches!(
                apply_replication_envelope(&mut engine,&mut dohc_engine_collab::WriterDocCache::new(), &operation, &NoFaults, &NoLiveLeases),
                Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
                    reason: RefusalReason::InvalidInput { reason },
                    ..
                }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == expected_reason)
            ),
            "{origin} must reject with {expected_reason}"
        );
    }
}

/// An empty fork is the authenticated representation of clearing the
/// destination from an empty source.
#[test]
fn secret_version_fork_with_no_rows_clears_the_destination_secrets() {
    let (_scratch, _path, mut engine) = open_store();
    let ciphertext = b"sealed source bytes";
    seed_secret_fork_state(&mut engine, ciphertext);
    seed_replication_version(&mut engine, "empty-source", "named");

    let operation = envelope(
        "empty-fork-peer",
        0,
        "secret.version.fork",
        json!({
            "fromVersionId": "empty-source",
            "toVersionId": "feature",
            "chunkIndex": 0,
            "totalRows": 0,
            "rows": []
        }),
    );

    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &operation,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(RoutedApply { conflict: None, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let destination: (Vec<String>, Vec<String>) = engine
        .read_with(|conn| {
            let files = conn
                .prepare(
                    "SELECT path FROM secret_files \
                     WHERE workspace_id='ws' AND version_id='feature' ORDER BY path",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let bases = conn
                .prepare(
                    "SELECT path FROM secret_fork_bases \
                     WHERE workspace_id='ws' AND version_id='feature' ORDER BY path",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>((files, bases))
        })
        .expect("destination secrets");
    assert_eq!(
        destination,
        (Vec::<String>::new(), Vec::<String>::new()),
        "an empty fork must clear the destination"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "empty-fork-peer").expect("ack"),
        0
    );
}

#[test]
fn secret_version_fork_uses_peer_local_tip_ids() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    seed_replication_version(&mut engine, "feature", "named");
    let ciphertext = b"sealed source bytes";
    let sha = engine
        .put_binary_blob(ciphertext)
        .expect("secret ciphertext blob");
    let iv = STANDARD.encode([7_u8; SECRET_IV_BYTES]);
    let tag = STANDARD.encode([9_u8; SECRET_TAG_BYTES]);
    let put = envelope(
        "put-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": iv,
            "authTagBase64": tag,
            "ciphertextSha256": sha,
            "byteLength": ciphertext.len()
        }),
    );
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &put,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(RoutedApply { conflict: None, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let fork = envelope(
        "fork-peer",
        0,
        "secret.version.fork",
        json!({
            "fromVersionId": "main",
            "toVersionId": "feature",
            "chunkIndex": 0,
            "totalRows": 1,
            "rows": [{
                "path": "app/.env",
                "ivBase64": iv,
                "authTagBase64": tag,
                "ciphertextSha256": sha,
                "byteLength": ciphertext.len(),
                "updatedAtMs": 100
            }]
        }),
    );
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &fork,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(RoutedApply { conflict: None, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let tips: (String, String) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT latest_moment_id FROM secret_files \
                     WHERE workspace_id='ws' AND version_id='main' AND path='app/.env'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT latest_moment_id FROM secret_files \
                     WHERE workspace_id='ws' AND version_id='feature' AND path='app/.env'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("secret tip ids");
    assert_eq!(tips.0, "secret-sync-put-peer-0");
    assert_eq!(tips.1, "secret-sync-fork-peer-0-0");
}

/// Secret ciphertext refs ride the shared binary-blob transport (5 MiB cap),
/// which is far above the secret domain's own 1 MiB cap. AES-GCM here is
/// length-preserving — IV and tag travel in their own payload fields — so a
/// remote put referencing an oversized hydrated blob would park plaintext-sized
/// ciphertext the local secret write path would have refused.
#[test]
fn secret_put_over_the_domain_cap_is_refused_without_a_tip_or_moment() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let oversized = vec![7_u8; MAX_SECRET_FILE_BYTES + 1];
    let sha = engine
        .put_binary_blob(&oversized)
        .expect("oversized ciphertext blob");

    let operation = envelope(
        "oversized-secret-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": oversized.len()
        }),
    );

    let refusal = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &operation,
        &NoFaults,
        &NoLiveLeases,
    );
    let stored: (i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM secret_files", [], |row| row.get(0))?,
                conn.query_row("SELECT COUNT(*) FROM secret_moments", [], |row| row.get(0))?,
            ))
        })
        .expect("secret rows");
    assert_eq!(stored, (0, 0), "an over-cap put must persist nothing");
    assert!(matches!(
        refusal,
        Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "secret ciphertext metadata is invalid")
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "oversized-secret-peer").expect("ack"),
        0
    );

    // The same put at exactly the cap is admitted, so the guard is a CAP and
    // not a blanket refusal of large secrets.
    let at_cap = vec![7_u8; MAX_SECRET_FILE_BYTES];
    let at_cap_sha = engine
        .put_binary_blob(&at_cap)
        .expect("at-cap ciphertext blob");
    let admitted = envelope(
        "at-cap-secret-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": at_cap_sha,
            "byteLength": at_cap.len()
        }),
    );
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &admitted,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(RoutedApply { conflict: None, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
}

#[test]
fn secret_put_ciphertext_length_mismatch_is_refused_and_acked() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let ciphertext = b"sealed";
    let sha = engine.put_binary_blob(ciphertext).expect("ciphertext blob");
    let operation = envelope(
        "length-mismatch-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": ciphertext.len() - 1
        }),
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine,&mut dohc_engine_collab::WriterDocCache::new(), &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "secret ciphertext blob does not match declared metadata")
    ));
    let stored: (i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM secret_files", [], |row| row.get(0))?,
                conn.query_row("SELECT COUNT(*) FROM secret_moments", [], |row| row.get(0))?,
            ))
        })
        .expect("secret rows");
    assert_eq!(stored, (0, 0));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "length-mismatch-peer").expect("ack"),
        0
    );
}

#[test]
fn secret_put_corrupt_local_ciphertext_blob_is_hard_and_unacked() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let honest_ciphertext = b"honest";
    let corrupt_ciphertext = b"sealed";
    assert_eq!(
        honest_ciphertext.len(),
        corrupt_ciphertext.len(),
        "the corruption fixture must isolate digest mismatch from byte-length mismatch"
    );
    let sha = dohc_engine_storage::hex_sha256(honest_ciphertext);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO binary_blobs (sha256, byte_length, bytes) VALUES (?1, ?2, ?3)",
                params![sha, corrupt_ciphertext.len() as i64, corrupt_ciphertext],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("corrupt local blob fixture");
    let operation = envelope(
        "corrupt-secret-blob-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": honest_ciphertext.len()
        }),
    );

    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &operation,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::Storage(
            dohc_engine_storage::StorageError::BlobIntegrity { .. }
        ))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "corrupt-secret-blob-peer").expect("ack"),
        -1,
        "local blob corruption must leave the peer coordinate retryable"
    );
    let stored: (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM secret_files", [], |row| row.get(0))?,
                conn.query_row("SELECT COUNT(*) FROM secret_moments", [], |row| row.get(0))?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log \
                     WHERE workspace_id='ws' AND origin_id='corrupt-secret-blob-peer'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("corrupt refusal state");
    assert_eq!(stored, (0, 0, 0));
}

#[test]
fn secret_put_corrupt_local_ciphertext_length_is_hard_and_unacked() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let ciphertext = b"honest";
    let sha = dohc_engine_storage::hex_sha256(ciphertext);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO binary_blobs (sha256, byte_length, bytes) VALUES (?1, 99, ?2)",
                params![sha, ciphertext],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("corrupt local length fixture");
    let operation = envelope(
        "corrupt-secret-length-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": ciphertext.len()
        }),
    );

    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &operation,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::Storage(
            dohc_engine_storage::StorageError::StateCorrupt { .. }
        ))
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "corrupt-secret-length-peer").expect("ack"),
        -1,
        "local length corruption must stay hard and retryable"
    );
}

#[test]
fn secret_put_rejects_noncanonical_shadow_path_but_accepts_canonical_spelling() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let ciphertext = b"canonical-secret-ciphertext";
    let sha = engine
        .put_binary_blob(ciphertext)
        .expect("secret ciphertext blob");
    let payload = |path: &str| {
        json!({
            "versionId": "main",
            "path": path,
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": ciphertext.len()
        })
    };

    let seed = envelope(
        "canonical-secret-seed",
        0,
        "secret.file.put",
        payload("a/b.env"),
    );
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &seed,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(RoutedApply { conflict: None, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let shadow = envelope(
        "noncanonical-secret-peer",
        0,
        "secret.file.put",
        payload("a//b.env"),
    );
    let refusal = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &shadow,
        &NoFaults,
        &NoLiveLeases,
    );
    let paths = engine
        .read_with(|conn| {
            conn.prepare(
                "SELECT path FROM secret_files \
                 WHERE workspace_id='ws' AND version_id='main' ORDER BY path",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()
        })
        .expect("secret paths");
    if matches!(
        refusal,
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(RoutedApply { conflict: None, .. }),
            ..
        })
    ) {
        assert_eq!(
            paths,
            vec!["a//b.env", "a/b.env"],
            "current-code bug proof: the raw wire spelling persists beside its canonical alias"
        );
    }
    assert!(matches!(
        refusal,
        Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "secret replication path must be canonical")
    ));
    assert_eq!(
        paths,
        vec!["a/b.env"],
        "without the canonical guard, the raw wire spelling persists as a shadow row"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "noncanonical-secret-peer").expect("ack"),
        0
    );

    let mut canonical = envelope(
        "canonical-secret-update",
        0,
        "secret.file.put",
        payload("a/b.env"),
    );
    canonical.recorded_at_ms = 3_000;
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &canonical,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(RoutedApply { conflict: None, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "canonical-secret-update").expect("ack"),
        0
    );
}

#[test]
fn secret_put_rejects_synthesized_moment_id_owned_by_unrelated_local_history() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let ciphertext = b"collision-secret-ciphertext";
    let sha = engine
        .put_binary_blob(ciphertext)
        .expect("secret ciphertext blob");
    engine
        .write_with(&NoFaults, |tx| -> Result<(), SyncError> {
            tx.execute(
                "INSERT INTO secret_moments \
                 (workspace_id,moment_order,moment_id,version_id,path,recorded_at_ms,operation,metadata_origin,after_present) \
                 VALUES ('ws',1,'secret-sync-collision-peer-0','main','unrelated.env',100,'delete','api',0)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok(())
        })
        .expect("seed colliding local secret moment");

    let operation = envelope(
        "collision-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "target.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": ciphertext.len()
        }),
    );
    let refusal = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &operation,
        &NoFaults,
        &NoLiveLeases,
    );
    let state = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM secret_files \
                     WHERE workspace_id='ws' AND version_id='main' AND path='target.env'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                conn.query_row(
                    "SELECT path FROM secret_moments \
                     WHERE workspace_id='ws' AND moment_id='secret-sync-collision-peer-0'",
                    [],
                    |row| row.get::<_, String>(0),
                )?,
            ))
        })
        .expect("secret collision state");
    if matches!(
        refusal,
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(RoutedApply { conflict: None, .. }),
            ..
        })
    ) {
        assert_eq!(
            state,
            (1, "unrelated.env".to_owned()),
            "current-code bug proof: the tip references an unrelated pre-existing history row"
        );
    }
    assert!(matches!(
        refusal,
        Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "replicated secret moment id collides with existing history")
    ));
    assert_eq!(
        state,
        (0, "unrelated.env".to_owned()),
        "the collision must roll back the incoming tip and preserve the existing owner"
    );
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "collision-peer").expect("ack"),
        0
    );
}

#[test]
fn secret_put_refuses_and_acks_synthesized_moment_id_owned_by_plaintext_history() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let plaintext_sha = dohc_engine_storage::hex_sha256(b"plaintext owner");
    engine
        .write_with(&NoFaults, |tx| -> Result<(), SyncError> {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) \
                 VALUES (?1,15,'plaintext owner')",
                [&plaintext_sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','plaintext-owner',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO moments \
                 (workspace_id,moment_order,moment_id,version_id,object_id,path, \
                  recorded_at_ms,operation,after_blob_sha256,before_present, \
                  metadata_origin,after_content_kind) \
                 VALUES ('ws',1,'secret-sync-plaintext-collision-peer-0','main', \
                         'plaintext-owner','owner.md',100,'write',?1,1,'api','text')",
                [&plaintext_sha],
            )
            .map_err(SyncError::persist)?;
            Ok(())
        })
        .expect("seed colliding plaintext moment");
    let ciphertext = b"cross-table-secret-ciphertext";
    let ciphertext_sha = engine
        .put_binary_blob(ciphertext)
        .expect("secret ciphertext blob");
    let operation = envelope(
        "plaintext-collision-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "target.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": ciphertext_sha,
            "byteLength": ciphertext.len()
        }),
    );

    assert!(
        matches!(
            apply_replication_envelope(&mut engine,&mut dohc_engine_collab::WriterDocCache::new(), &operation, &NoFaults, &NoLiveLeases),
            Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
                reason: RefusalReason::InvalidInput { ref reason },
                ..
            }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "replicated secret moment id collides with existing history")
        ),
        "checking only secret_moments permits the synthesized secret ID to alias an unrelated plaintext row in the shared identity namespace."
    );
    let state: (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments \
                     WHERE workspace_id='ws' \
                       AND moment_id='secret-sync-plaintext-collision-peer-0'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM secret_moments \
                     WHERE workspace_id='ws' \
                       AND moment_id='secret-sync-plaintext-collision-peer-0'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM secret_files \
                     WHERE workspace_id='ws' AND version_id='main' AND path='target.env'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("cross-table collision state");
    assert_eq!(state, (1, 0, 0));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "plaintext-collision-peer").expect("ack"),
        0
    );
}

#[test]
fn secret_put_redelivery_skips_its_own_synthesized_moment() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let ciphertext = b"redelivery-secret-ciphertext";
    let sha = engine
        .put_binary_blob(ciphertext)
        .expect("secret ciphertext blob");
    let operation = envelope(
        "redelivery-secret-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": "app/.env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": ciphertext.len()
        }),
    );
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &operation,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(RoutedApply { conflict: None, .. }),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &operation,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Skipped,
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let history_rows: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM secret_moments \
                 WHERE workspace_id='ws' AND moment_id='secret-sync-redelivery-secret-peer-0'",
                [],
                |row| row.get(0),
            )
        })
        .expect("secret history count");
    assert_eq!(history_rows, 1);
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "redelivery-secret-peer").expect("ack"),
        0
    );
}

#[test]
fn secret_put_reports_active_protected_disk_work_on_apply_and_redelivery() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    seed_replication_version(&mut engine, "feature", "branch");
    let ciphertext = b"protected relay bytes";
    let sha = engine
        .put_binary_blob(ciphertext)
        .expect("secret ciphertext blob");
    let operation = envelope(
        "protected-put-peer",
        0,
        "secret.file.put",
        json!({
            "versionId": "main",
            "path": ".env",
            "metadata": {"origin": "sync"},
            "ivBase64": STANDARD.encode([1_u8; SECRET_IV_BYTES]),
            "authTagBase64": STANDARD.encode([2_u8; SECRET_TAG_BYTES]),
            "ciphertextSha256": sha,
            "byteLength": ciphertext.len()
        }),
    );

    let applied = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &operation,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("apply protected put");
    assert!(matches!(
        applied,
        ApplyOutcome { primary: ApplyDisposition::Applied(RoutedApply {
            materialization_changes,
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (materialization_changes == [MomentMaterializationChange {
            version_id: "main".to_owned(),
            path: ".env".to_owned(),
            operation: "write",
            content_kind: "secret",
        }])
    ));

    engine
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO active_versions (workspace_id,version_id) VALUES ('ws','feature') \
                 ON CONFLICT(workspace_id) DO UPDATE SET version_id=excluded.version_id",
                [],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .expect("switch active version after protected put");

    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &operation,
            &NoFaults,
            &NoLiveLeases,
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Skipped,
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        crate::router::redelivered_materialization_changes(&engine, &operation)
            .expect("redelivered protected put disk work"),
        [MomentMaterializationChange {
            version_id: "main".to_owned(),
            path: ".env".to_owned(),
            operation: "write",
            content_kind: "secret",
        }],
        "a crash before cursor commit must make the exact protected write retryable"
    );
}

#[test]
fn secret_delete_reports_active_protected_disk_work_on_apply_and_redelivery() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    seed_replication_version(&mut engine, "feature", "branch");
    let operation = envelope(
        "protected-delete-peer",
        0,
        "secret.file.delete",
        json!({
            "versionId": "main",
            "path": ".env",
            "metadata": {"origin": "sync"}
        }),
    );

    let applied = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &operation,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("apply protected delete");
    assert!(matches!(
        applied,
        ApplyOutcome { primary: ApplyDisposition::Applied(RoutedApply {
            materialization_changes,
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (materialization_changes == [MomentMaterializationChange {
            version_id: "main".to_owned(),
            path: ".env".to_owned(),
            operation: "delete",
            content_kind: "secret",
        }])
    ));

    engine
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO active_versions (workspace_id,version_id) VALUES ('ws','feature') \
                 ON CONFLICT(workspace_id) DO UPDATE SET version_id=excluded.version_id",
                [],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .expect("switch active version after protected delete");

    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &operation,
            &NoFaults,
            &NoLiveLeases,
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Skipped,
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        crate::router::redelivered_materialization_changes(&engine, &operation)
            .expect("redelivered protected delete disk work"),
        [MomentMaterializationChange {
            version_id: "main".to_owned(),
            path: ".env".to_owned(),
            operation: "delete",
            content_kind: "secret",
        }],
        "a crash before cursor commit must make the exact protected delete retryable"
    );
}

#[test]
fn relay_secret_fork_reports_active_disk_work_across_crash_redelivery() {
    let (_scratch, path, mut engine) = open_store();
    seed_identity(&mut engine);
    let ciphertext = b"protected fork bytes";
    let (sha, iv, tag) = seed_secret_fork_state(&mut engine, ciphertext);
    engine
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO active_versions (workspace_id,version_id) VALUES ('ws','feature') \
                 ON CONFLICT(workspace_id) DO UPDATE SET version_id=excluded.version_id",
                [],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .expect("activate fork destination");
    let first = envelope(
        "active-fork-peer",
        0,
        "secret.version.fork",
        json!({
            "fromVersionId": "main",
            "toVersionId": "feature",
            "chunkIndex": 0,
            "totalRows": 2,
            "rows": [{
                "path": "app/.env",
                "ivBase64": iv,
                "authTagBase64": tag,
                "ciphertextSha256": sha,
                "byteLength": ciphertext.len(),
                "updatedAtMs": 100
            }]
        }),
    );
    assert!(matches!(
        apply_replication_envelope(&mut engine,&mut dohc_engine_collab::WriterDocCache::new(), &first, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome { primary: ApplyDisposition::Applied(RoutedApply {
            materialization_changes,
            conflict: None,
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (materialization_changes.is_empty())
    ));
    assert!(
        crate::router::redelivered_materialization_changes(&engine, &first)
            .expect("partial fork redelivery")
            .is_empty()
    );
    let partial_paths: (Vec<String>, Vec<String>) = engine
        .read_with(|conn| {
            let files = conn
                .prepare(
                    "SELECT path FROM secret_files \
                     WHERE workspace_id='ws' AND version_id='feature' ORDER BY path",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let bases = conn
                .prepare(
                    "SELECT path FROM secret_fork_bases \
                     WHERE workspace_id='ws' AND version_id='feature' ORDER BY path",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>((files, bases))
        })
        .expect("partial fork destination paths");
    assert_eq!(
        partial_paths,
        (vec!["stale.env".into()], vec!["stale.env".into()])
    );
    drop(engine);
    let mut engine = EngineStore::open(&path, 2_500).expect("reopen between fork chunks");

    let operation = envelope(
        "active-fork-peer",
        1,
        "secret.version.fork",
        json!({
            "fromVersionId": "main",
            "toVersionId": "feature",
            "chunkIndex": 1,
            "totalRows": 2,
            "rows": [{
                "path": "config/prod.env",
                "ivBase64": iv,
                "authTagBase64": tag,
                "ciphertextSha256": sha,
                "byteLength": ciphertext.len(),
                "updatedAtMs": 101
            }]
        }),
    );
    let client = RelaySyncClient::new(PagedRelay::new([(
        0,
        PullResponse {
            ops: vec![operation],
            next_cursor: 1,
            has_more: false,
        },
    )]));
    let expected = vec![
        MomentMaterializationChange {
            version_id: "feature".to_owned(),
            path: "app/.env".to_owned(),
            operation: "write",
            content_kind: "secret",
        },
        MomentMaterializationChange {
            version_id: "feature".to_owned(),
            path: "config/prod.env".to_owned(),
            operation: "write",
            content_kind: "secret",
        },
        MomentMaterializationChange {
            version_id: "feature".to_owned(),
            path: "stale.env".to_owned(),
            operation: "delete",
            content_kind: "secret",
        },
    ];

    let faults = ScriptedFaults::crash_at(FaultPoint::SyncBetweenApplyAndCursorCommit);
    let first = client
        .pull_chat_workspace(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            faults.as_ref(),
            &NoLiveLeases,
            2_000,
        )
        .expect("pull active secret fork");
    assert!(matches!(
        first,
        SyncPassOutcome::CrashedAfterApply {
            applied: 1,
            changed_paths,
            ..
        } if changed_paths == expected
    ));

    drop(engine);
    let mut reopened = EngineStore::open(&path, 3_000).expect("reopen after pull crash");
    reopened
        .read_with(|conn| {
            conn.execute(
                "UPDATE active_versions SET version_id='main' WHERE workspace_id='ws'",
                [],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .expect("switch active version after apply");
    let retry = client
        .pull_chat_workspace(
            &mut reopened,
            &mut dohc_engine_collab::WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            3_000,
        )
        .expect("redeliver active secret fork");
    assert!(matches!(
        retry,
        SyncPassOutcome::Complete {
            applied: 0,
            skipped: 1,
            changed_paths,
            ..
        } if changed_paths == expected
    ));

    let (stored_paths, pending_assemblies): (Vec<String>, i64) = reopened
        .read_with(|conn| {
            let paths = conn
                .prepare(
                    "SELECT path FROM secret_files \
                     WHERE workspace_id='ws' AND version_id='feature' ORDER BY path",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let assemblies = conn.query_row(
                "SELECT COUNT(*) FROM engine_requests \
                 WHERE kind='sync-secret-fork-assembly'",
                [],
                |row| row.get(0),
            )?;
            Ok::<_, rusqlite::Error>((paths, assemblies))
        })
        .expect("fork destination paths");
    assert_eq!(stored_paths, ["app/.env", "config/prod.env"]);
    assert_eq!(pending_assemblies, 0);
}
