use super::*;

#[test]
fn workspace_init_router_apply_is_idempotent_on_replay() {
    let (_scratch, _path, mut engine) = open_store();
    let seed = envelope("workspace-seed-peer", 0, "workspace.init", json!({}));
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

    let operation = envelope("workspace-replay-peer", 0, "workspace.init", json!({}));
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
    let main: (String, String, String, i64) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT w.main_version_id, v.kind, v.name, v.created_at_ms \
                 FROM versioned_workspaces w JOIN versions v \
                   ON v.workspace_id=w.workspace_id AND v.version_id=w.main_version_id \
                 WHERE w.workspace_id='ws'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("main version");
    assert_eq!(main, ("main".into(), "main".into(), "Main".into(), 2_000));
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
}

#[test]
fn workspace_init_repairs_a_workspace_row_missing_its_main_version() {
    let (_scratch, _path, mut engine) = open_store();
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO versioned_workspaces (workspace_id,main_version_id) \
                 VALUES ('ws','main')",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed partial workspace");

    let operation = envelope("partial-workspace-peer", 0, "workspace.init", json!({}));
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
    let main: (String, String, String, i64) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT version_id,kind,name,created_at_ms FROM versions \
                 WHERE workspace_id='ws' AND version_id='main'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("repaired main version");
    assert_eq!(main, ("main".into(), "main".into(), "Main".into(), 2_000));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "partial-workspace-peer").expect("ack"),
        0
    );
}

#[test]
fn version_create_router_materializes_shipped_fork_snapshots_and_replays_idempotently() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");

    let local_sha = dohc_engine_storage::hex_sha256(b"local source state");
    let shipped_text_sha = dohc_engine_storage::hex_sha256(b"origin fork state");
    let shipped_binary = b"\0origin-binary-fork-state";
    let shipped_binary_sha = engine
        .put_binary_blob(shipped_binary)
        .expect("shipped binary blob");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![local_sha, 18_i64, "local source state"],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![shipped_text_sha, 17_i64, "origin fork state"],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','local-object',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO snapshots \
                 (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin,content_kind,binary_sha256) \
                 VALUES ('ws','main','local-object','local.md',?1,1,'local-moment','api','text',NULL)",
                [&local_sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
                 VALUES ('ws','main','local.md','local-object')",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed fork state");

    let operation = envelope(
        "version-peer",
        0,
        "version.create",
        json!({
            "versionId": "feature",
            "name": "Feature",
            "kind": "named",
            "forkVersionId": "main",
            "forkMomentId": "origin-fork-moment",
            "createdAtMs": 1_500,
            "forkSnapshots": [
                {
                    "objectId": "origin-text-object",
                    "objectCreatedAtMs": 1_100,
                    "path": "origin.md",
                    "blobSha256": shipped_text_sha,
                    "byteLength": 17,
                    "updatedAtMs": 1_200,
                    "latestMomentId": "origin-text-moment",
                    "metadata": {"origin": "sync", "summary": "origin"}
                },
                {
                    "objectId": "origin-binary-object",
                    "objectCreatedAtMs": 1_101,
                    "path": "asset.bin",
                    "contentKind": "binary",
                    "blobSha256": shipped_binary_sha,
                    "byteLength": shipped_binary.len(),
                    "updatedAtMs": 1_201,
                    "latestMomentId": "origin-binary-moment",
                    "metadata": {"origin": "sync", "correlationId": "fork"}
                }
            ]
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
    type CopiedSnapshot = (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    );
    let copied: Vec<CopiedSnapshot> = engine
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT s.path,s.object_id,s.content_kind,s.blob_sha256,s.binary_sha256, \
                        s.metadata_origin,s.metadata_summary,s.metadata_correlation_id \
                 FROM snapshots s WHERE s.workspace_id='ws' AND s.version_id='feature' \
                 ORDER BY s.path",
            )?;
            stmt.query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()
        })
        .expect("copied snapshots");
    assert_eq!(
        copied,
        vec![
            (
                "asset.bin".into(),
                "origin-binary-object".into(),
                "binary".into(),
                None,
                Some(shipped_binary_sha),
                "sync".into(),
                None,
                Some("fork".into()),
            ),
            (
                "origin.md".into(),
                "origin-text-object".into(),
                "text".into(),
                Some(shipped_text_sha),
                None,
                "sync".into(),
                Some("origin".into()),
                None,
            )
        ]
    );
    let fork_base_metadata: Vec<(String, String, Option<String>, Option<String>)> = engine
        .read_with(|conn| {
            conn.prepare(
                "SELECT path,metadata_origin,metadata_summary,metadata_correlation_id \
                 FROM fork_base_snapshots \
                 WHERE workspace_id='ws' AND version_id='feature' ORDER BY path",
            )?
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect()
        })
        .expect("shipped fork-base metadata");
    assert_eq!(
        fork_base_metadata,
        vec![
            ("asset.bin".into(), "sync".into(), None, Some("fork".into())),
            (
                "origin.md".into(),
                "sync".into(),
                Some("origin".into()),
                None
            ),
        ],
        "the dynamic shipped-snapshot insert runs for both destination tables; dropping either optional metadata binding changes these rows.",
    );
    let counts: (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' AND version_id='feature'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases WHERE workspace_id='ws' AND version_id='feature'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM fork_base_snapshots WHERE workspace_id='ws' AND version_id='feature'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("fork row counts");
    assert_eq!(counts, (2, 2, 2));
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
    let replay_counts: (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots \
                     WHERE workspace_id='ws' AND version_id='feature'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases \
                     WHERE workspace_id='ws' AND version_id='feature'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM fork_base_snapshots \
                     WHERE workspace_id='ws' AND version_id='feature'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("replayed fork row counts");
    assert_eq!(replay_counts, (2, 2, 2));
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
}

#[test]
fn later_version_create_chunk_preserves_a_local_write_to_its_pending_path() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let first_sha = dohc_engine_storage::hex_sha256(b"first chunk");
    let pending_sha = dohc_engine_storage::hex_sha256(b"origin pending");
    engine
        .write_with(&NoFaults, |tx| {
            for (sha, text) in [
                (&first_sha, "first chunk"),
                (&pending_sha, "origin pending"),
            ] {
                tx.execute(
                    "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                    params![sha, text.len() as i64, text],
                )
                .map_err(SyncError::persist)?;
            }
            Ok::<_, SyncError>(())
        })
        .expect("seed shipped blobs");
    let chunk = |seq, object_id: &str, path: &str, sha: &str| {
        envelope(
            "chunked-version-peer",
            seq,
            "version.create",
            json!({
                "versionId": "chunked-version",
                "name": "Chunked version",
                "kind": "named",
                "forkVersionId": "main",
                "forkMomentId": "fork-tip",
                "createdAtMs": 1_500,
                "forkSnapshots": [shipped_text_snapshot(object_id, path, sha)]
            }),
        )
    };
    let first = chunk(0, "origin-first-object", "first.md", &first_sha);
    let second = chunk(1, "origin-pending-object", "pending.md", &pending_sha);
    assert!(matches!(
        apply_version_envelope(&mut engine, &first, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(()),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    VersionedTextStore::new(&mut engine)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "chunked-version".to_owned(),
                object_id: "local-pending-object".to_owned(),
                path: "pending.md".to_owned(),
                text: "local edit".to_owned(),
                moment_id: "local-pending-moment".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1_600,
            },
            &NoFaults,
        )
        .expect("write pending path locally");

    let second_result = apply_version_envelope(&mut engine, &second, &NoFaults);
    assert!(
        matches!(
            second_result,
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(()),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ),
        "later chunk failed: {second_result:?}"
    );
    let head = VersionedTextStore::new(&mut engine)
        .read_text("ws", "chunked-version", "pending.md")
        .expect("read pending path")
        .expect("pending path exists");
    assert_eq!(head.text, "local edit");
    let base: (String, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT object_id,blob_sha256 FROM fork_base_snapshots \
                 WHERE workspace_id='ws' AND version_id='chunked-version' AND path='pending.md'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("read fork base");
    assert_eq!(base, ("origin-pending-object".to_owned(), pending_sha));
}

#[test]
fn version_create_stamps_a_shipped_capture_head_as_replicated() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let sha = dohc_engine_storage::hex_sha256(b"captured fork state");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![sha, 19_i64, "captured fork state"],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed shipped capture blob");
    let mut snapshot = shipped_text_snapshot("captured-object", "captured.md", &sha);
    snapshot["metadata"]["origin"] = json!("capture");
    let operation = version_create_with_shipped_snapshots(
        "capture-version-peer",
        "captured-fork",
        vec![snapshot],
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
    let (head_origin, base_origin): (String, String) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT metadata_origin FROM snapshots \
                     WHERE workspace_id='ws' AND version_id='captured-fork' \
                       AND object_id='captured-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT metadata_origin FROM fork_base_snapshots \
                     WHERE workspace_id='ws' AND version_id='captured-fork' \
                       AND object_id='captured-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("read shipped origins");
    assert_eq!(head_origin, "sync");
    assert_eq!(base_origin, "capture");
}

#[test]
fn version_create_shipped_snapshot_rejects_a_missing_blob_deliberately() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let missing_sha = dohc_engine_storage::hex_sha256(b"missing");
    let operation = version_create_with_shipped_snapshots(
        "missing-blob-peer",
        "missing-blob-version",
        vec![shipped_text_snapshot(
            "missing-object",
            "missing.md",
            &missing_sha,
        )],
    );

    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &operation,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::BlobInvalid)
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "missing-blob-peer").expect("ack"),
        -1
    );
    let version_exists: bool = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM versions \
                 WHERE workspace_id='ws' AND version_id='missing-blob-version')",
                [],
                |row| row.get(0),
            )
        })
        .expect("version absence");
    assert!(!version_exists);
}

#[test]
fn version_create_shipped_snapshot_accepts_only_oracle_content_kinds() {
    for (index, content_kind) in [None, Some("text"), Some("binary")].into_iter().enumerate() {
        let (_scratch, _path, mut engine) = open_store();
        seed_replication_version(&mut engine, "main", "main");
        let text_sha = dohc_engine_storage::hex_sha256(b"content");
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,7,'content')",
                    [&text_sha],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed text blob");
        let binary_sha = engine
            .put_binary_blob(b"content")
            .expect("seed binary blob");
        let mut snapshot = shipped_text_snapshot(
            &format!("valid-kind-object-{index}"),
            &format!("valid-kind-{index}.md"),
            if content_kind == Some("binary") {
                &binary_sha
            } else {
                &text_sha
            },
        );
        if let Some(kind) = content_kind {
            snapshot["contentKind"] = json!(kind);
        }
        let operation = version_create_with_shipped_snapshots(
            &format!("valid-kind-peer-{index}"),
            &format!("valid-kind-version-{index}"),
            vec![snapshot],
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
                    primary: ApplyDisposition::Applied(RoutedApply { conflict: None, .. }),
                    refusals: ref outcome_refusals,
                    sharing_declined: ref outcome_sharing_declined,
                }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
            ),
            "{content_kind:?} must remain accepted"
        );
    }
}

#[test]
fn version_create_unknown_content_kind_is_refused_and_acked() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let text_sha = dohc_engine_storage::hex_sha256(b"content");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,7,'content')",
                [&text_sha],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed text blob");
    let mut snapshot = shipped_text_snapshot("richdoc-object", "richdoc.md", &text_sha);
    snapshot["contentKind"] = json!("richdoc");
    let operation = version_create_with_shipped_snapshots(
        "richdoc-refusal-peer",
        "richdoc-refusal-version",
        vec![snapshot],
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine,&mut dohc_engine_collab::WriterDocCache::new(), &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "version.create shipped snapshot content kind is invalid")
    ));
    let (journaled, versions, snapshots): (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log \
                     WHERE workspace_id='ws' AND origin_id='richdoc-refusal-peer' AND origin_seq=0",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM versions \
                     WHERE workspace_id='ws' AND version_id='richdoc-refusal-version'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots \
                     WHERE workspace_id='ws' AND version_id='richdoc-refusal-version'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("refusal persistence");
    assert_eq!(journaled, 1, "the refused coordinate must be journaled");
    assert_eq!(
        versions, 0,
        "the pre-validation version insert must roll back"
    );
    assert_eq!(snapshots, 0, "the refused snapshot must roll back");
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "richdoc-refusal-peer").expect("ack"),
        0
    );

    let next = envelope(
        "richdoc-refusal-peer",
        1,
        "chat.channel.create",
        json!({
            "channelId": "after-richdoc-refusal",
            "name": "Still moving",
            "slug": "still-moving",
            "kind": "channel",
            "createdAtMs": 2_001
        }),
    );
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &next,
            &NoFaults,
            &NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "richdoc-refusal-peer").expect("ack"),
        1,
        "the refused operation must not wedge its origin"
    );
}

#[test]
fn version_create_shipped_snapshot_rejects_duplicate_paths_deliberately() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let sha = dohc_engine_storage::hex_sha256(b"content");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,7,'content')",
                [&sha],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed blob");
    let operation = version_create_with_shipped_snapshots(
        "duplicate-path-peer",
        "duplicate-path-version",
        vec![
            shipped_text_snapshot("first-object", "same.md", &sha),
            shipped_text_snapshot("second-object", "same.md", &sha),
        ],
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine,&mut dohc_engine_collab::WriterDocCache::new(), &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "version.create shipped snapshot paths must be unique")
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "duplicate-path-peer").expect("ack"),
        0
    );
}

#[test]
fn version_create_shipped_snapshot_rejects_unsafe_and_secret_paths() {
    for (index, path) in ["../escape.md", "config/.env"].into_iter().enumerate() {
        let (_scratch, _path, mut engine) = open_store();
        seed_replication_version(&mut engine, "main", "main");
        let sha = dohc_engine_storage::hex_sha256(b"content");
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,7,'content')",
                    [&sha],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed blob");
        let origin = format!("unsafe-path-peer-{index}");
        let version_id = format!("unsafe-path-version-{index}");
        let operation = version_create_with_shipped_snapshots(
            &origin,
            &version_id,
            vec![shipped_text_snapshot("unsafe-object", path, &sha)],
        );

        assert!(matches!(
            apply_replication_envelope(&mut engine,&mut dohc_engine_collab::WriterDocCache::new(), &operation, &NoFaults, &NoLiveLeases),
            Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
                reason: RefusalReason::InvalidInput {
                    ref reason
                },
                ..
            }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "version.create shipped snapshot path must be tracked")
        ));
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", &origin).expect("ack"),
            0,
            "{path}"
        );
    }
}

/// A `version.create` shipping a TEXT fork snapshot at a secret-classified path
/// is a disclosure op: `blobs`/`snapshots`/`path_aliases` are the ordinary
/// plaintext surface, and `read_text` deliberately admits secret paths so an
/// absence check answers honestly — so a persisted `.env` alias hands the
/// plaintext straight back through the normal read surface. Asserting the error
/// is not enough; this asserts the plaintext is not readable afterwards.
#[test]
fn version_create_secret_fork_snapshot_never_becomes_readable_plaintext() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let plaintext = "AWS_SECRET_ACCESS_KEY=hunter2";
    let sha = dohc_engine_storage::hex_sha256(plaintext.as_bytes());
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![sha, plaintext.len() as i64, plaintext],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed secret plaintext blob");

    let disclosure = version_create_with_shipped_snapshots(
        "secret-snapshot-peer",
        "feature",
        vec![shipped_text_snapshot("secret-object", "app/.env", &sha)],
    );
    let refusal = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &disclosure,
        &NoFaults,
        &NoLiveLeases,
    );

    // Create `feature` honestly. If the disclosure op had persisted anything,
    // this becomes a no-op over the already-created version and the secret
    // alias below is live.
    let honest = envelope(
        "honest-version-peer",
        0,
        "version.create",
        json!({
            "versionId": "feature",
            "name": "Feature",
            "kind": "named",
            "forkVersionId": "main",
            "createdAtMs": 1_500,
            "forkSnapshots": []
        }),
    );
    assert!(matches!(
        apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &honest,
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
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "feature", "app/.env")
            .expect("secret path read is answerable"),
        None,
        "a replicated fork snapshot must never make secret plaintext readable"
    );
    let alias_rows: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT (SELECT COUNT(*) FROM path_aliases WHERE path='app/.env') \
                 + (SELECT COUNT(*) FROM snapshots WHERE path='app/.env') \
                 + (SELECT COUNT(*) FROM fork_base_snapshots WHERE path='app/.env') \
                 + (SELECT COUNT(*) FROM file_objects WHERE object_id='secret-object')",
                [],
                |row| row.get(0),
            )
        })
        .expect("secret alias rows");
    assert_eq!(alias_rows, 0, "nothing from the disclosure op may persist");
    assert!(matches!(
        refusal,
        Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "version.create shipped snapshot path must be tracked")
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "secret-snapshot-peer").expect("ack"),
        0
    );
}

/// The local plaintext write path stores the CANONICAL path
/// (`validate_plaintext_storable_path` returns the normalized form). A
/// replicated fork snapshot persists its wire path verbatim, so a
/// non-canonical spelling of a tracked path would mint a second, shadow alias
/// for the same logical file that the canonical read surface cannot see.
#[test]
fn version_create_fork_snapshot_refuses_a_non_canonical_tracked_path() {
    for (index, path) in ["notes/./plan.md", "notes//plan.md", "notes\\plan.md"]
        .into_iter()
        .enumerate()
    {
        let (_scratch, _path, mut engine) = open_store();
        seed_replication_version(&mut engine, "main", "main");
        let sha = dohc_engine_storage::hex_sha256(b"content");
        engine
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,7,'content')",
                    [&sha],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("seed blob");
        let origin = format!("shadow-alias-peer-{index}");
        let version_id = format!("shadow-alias-version-{index}");
        let operation = version_create_with_shipped_snapshots(
            &origin,
            &version_id,
            vec![shipped_text_snapshot("shadow-object", path, &sha)],
        );

        assert!(
            matches!(
                apply_replication_envelope(&mut engine,&mut dohc_engine_collab::WriterDocCache::new(), &operation, &NoFaults, &NoLiveLeases),
                Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
                    reason: RefusalReason::InvalidInput {
                        ref reason
                    },
                    ..
                }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "version.create shipped snapshot path must be canonical")
            ),
            "{path}"
        );
        let (persisted, version_rows): (i64, i64) = engine
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT (SELECT COUNT(*) FROM path_aliases) \
                         + (SELECT COUNT(*) FROM snapshots)",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM versions \
                         WHERE workspace_id='ws' AND version_id=?1",
                        [&version_id],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("alias rows");
        assert_eq!(persisted, 0, "{path}");
        assert_eq!(
            version_rows, 0,
            "the version inserted before snapshot validation must roll back: {path}"
        );
        assert_eq!(
            read_replication_acked_seq(&engine, "ws", &origin).expect("ack"),
            0,
            "{path}"
        );
    }
}

#[test]
fn version_create_shipped_payload_materializes_only_workspace_scoped_rows() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    seed_replication_version_in_workspace(&mut engine, "foreign-ws", "main", "main");
    let source_sha = dohc_engine_storage::hex_sha256(b"legacy source");
    let foreign_sha = dohc_engine_storage::hex_sha256(b"foreign source");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,13,'legacy source')",
                [&source_sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,14,'foreign source')",
                [&foreign_sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','legacy-object',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO snapshots \
                 (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id, \
                  metadata_origin,metadata_summary,metadata_correlation_id,content_kind,binary_sha256) \
                 VALUES ('ws','main','legacy-object','legacy.md',?1,2,'legacy-moment', \
                         'sync','legacy summary','legacy correlation','text',NULL)",
                [&source_sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
                 VALUES ('ws','main','legacy.md','legacy-object')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('foreign-ws','foreign-object',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO snapshots \
                 (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin,content_kind,binary_sha256) \
                 VALUES ('foreign-ws','main','foreign-object','foreign.md',?1,2,'foreign-moment','sync','text',NULL)",
                [&foreign_sha],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
                 VALUES ('foreign-ws','main','foreign.md','foreign-object')",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("seed legacy source");
    let operation = envelope(
        "legacy-version-peer",
        0,
        "version.create",
        json!({
            "versionId": "legacy-feature",
            "name": "Legacy feature",
            "kind": "named",
            "forkVersionId": "main",
            "forkMomentId": "legacy-moment",
            "createdAtMs": 1_500,
            "forkSnapshots": [{
                "objectId": "legacy-object",
                "objectCreatedAtMs": 1,
                "path": "legacy.md",
                "contentKind": "text",
                "blobSha256": source_sha,
                "updatedAtMs": 2,
                "latestMomentId": "legacy-moment",
                "metadata": {
                    "origin": "sync",
                    "summary": "legacy summary",
                    "correlationId": "legacy correlation"
                }
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
    let counts: (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots \
                     WHERE workspace_id='ws' AND version_id='legacy-feature' \
                       AND object_id='legacy-object' AND content_kind='text'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases \
                     WHERE workspace_id='ws' AND version_id='legacy-feature' \
                       AND path='legacy.md' AND object_id='legacy-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM fork_base_snapshots \
                     WHERE workspace_id='ws' AND version_id='legacy-feature' \
                       AND object_id='legacy-object' AND content_kind='text'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("shipped rows");
    assert_eq!(counts, (1, 1, 1));
    type Metadata = (String, Option<String>, Option<String>);
    let copied_metadata: (Metadata, Metadata) = engine
        .read_with(|conn| {
            let read = |table: &str| {
                conn.query_row(
                    &format!(
                        "SELECT metadata_origin,metadata_summary,metadata_correlation_id \
                         FROM {table} WHERE workspace_id='ws' \
                         AND version_id='legacy-feature' AND object_id='legacy-object'"
                    ),
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            };
            Ok::<_, rusqlite::Error>((read("snapshots")?, read("fork_base_snapshots")?))
        })
        .expect("shipped metadata");
    let expected_metadata = (
        "sync".to_owned(),
        Some("legacy summary".to_owned()),
        Some("legacy correlation".to_owned()),
    );
    assert_eq!(
        copied_metadata,
        (expected_metadata.clone(), expected_metadata),
        "either shipped insert dropping a metadata column changes this tuple.",
    );
    let foreign_destination_rows: (i64, i64, i64) = engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots \
                     WHERE workspace_id='foreign-ws' AND version_id='legacy-feature'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases \
                     WHERE workspace_id='foreign-ws' AND version_id='legacy-feature'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM fork_base_snapshots \
                     WHERE workspace_id='foreign-ws' AND version_id='legacy-feature'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("foreign destination rows");
    assert_eq!(foreign_destination_rows, (0, 0, 0));
}

#[test]
fn version_create_rejects_a_version_id_owned_by_another_workspace() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    seed_replication_version_in_workspace(&mut engine, "foreign-ws", "foreign-version", "named");
    let operation = envelope(
        "collision-peer",
        0,
        "version.create",
        json!({
            "versionId": "foreign-version",
            "name": "Collision",
            "kind": "named",
            "createdAtMs": 1_500,
            "forkSnapshots": []
        }),
    );

    assert!(matches!(
        apply_replication_envelope(&mut engine,&mut dohc_engine_collab::WriterDocCache::new(), &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput {
                ref reason
            },
            ..
        }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "version id belongs to another workspace")
    ));
    assert_eq!(
        read_replication_acked_seq(&engine, "ws", "collision-peer").expect("ack"),
        0
    );
    let local_collision: bool = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM versions \
                 WHERE workspace_id='ws' AND version_id='foreign-version')",
                [],
                |row| row.get(0),
            )
        })
        .expect("local collision");
    assert!(!local_collision);
}
