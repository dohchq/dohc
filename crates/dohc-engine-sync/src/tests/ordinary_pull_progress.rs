use super::relay_pull::ClaimRelay;
use super::*;

fn pull_token(engine: &EngineStore) -> Option<String> {
    engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT ordinary_pull_token FROM sync_identity WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// One padding op per page, so a pass stops at its page limit, then an
/// empty end of the log for a later pull.
fn padded_relay(pages: i64) -> PagedRelay {
    let end = PullResponse {
        ops: Vec::new(),
        next_cursor: pages,
        has_more: false,
    };
    PagedRelay::new(
        (0..pages)
            .map(|seq| {
                (
                    seq,
                    PullResponse {
                        ops: vec![envelope("padding-peer", seq, "probe.padding", json!({}))],
                        next_cursor: seq + 1,
                        has_more: seq + 1 < pages,
                    },
                )
            })
            .chain([(pages, end)]),
    )
}

fn pass<T: RelayTransport>(
    client: &RelaySyncClient<T>,
    engine: &mut EngineStore,
) -> (bool, RelayCursor) {
    let page = client.fetch_pull(engine, "ws", &NoFaults).unwrap();
    match client
        .apply_pull(
            engine,
            &mut Default::default(),
            "ws",
            &page,
            &NoFaults,
            &NoLiveLeases,
            2_000,
        )
        .unwrap()
    {
        SyncPassOutcome::Complete {
            has_more,
            pending_cursor: Some(cursor),
            ..
        } => (has_more, cursor),
        other => panic!("{other:?}"),
    }
}

fn prepared_file_relay() -> PagedRelay {
    let mut blobs = BTreeMap::new();
    let ops = (0..2)
        .map(|seq| {
            let path = format!("prepared-{seq}.txt");
            let text = format!("remote {seq}\n");
            let sha = dohc_engine_storage::hex_sha256(text.as_bytes());
            blobs.insert(sha.clone(), text.into_bytes());
            envelope(
                "prepared-peer",
                seq,
                "moment.append",
                json!({
                    "momentId": format!("prepared-moment-{seq}"), "versionId": "main",
                    "objectId": format!("prepared-object-{seq}"), "objectCreatedAtMs": 1,
                    "path": path, "recordedAtMs": 2_000, "operation": "write",
                    "payloadBeforeBlobSha256": null, "payloadBeforePath": null,
                    "payloadAfterBlobSha256": sha, "payloadAfterPath": path,
                    "payloadAfterContentKind": "text", "metadata": {"origin": "sync"},
                    "beforePresent": "absent",
                }),
            )
        })
        .collect();
    let mut relay = PagedRelay::new([(
        0,
        PullResponse {
            ops,
            next_cursor: 2,
            has_more: false,
        },
    )]);
    relay.blobs = blobs;
    relay
}

fn prepared_counts(engine: &EngineStore) -> (i64, i64) {
    engine
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log WHERE origin_id='prepared-peer'",
                    [],
                    |r| r.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE moment_id LIKE 'prepared-moment-%'",
                    [],
                    |r| r.get(0),
                )?,
            ))
        })
        .unwrap()
}

#[test]
fn prepared_pull_restart_replays_before_apply_during_apply_and_before_cursor_commit() {
    for boundary in ["before apply", "partial apply", "after apply"] {
        let (scratch, path, mut engine) = open_store();
        seed_identity(&mut engine);
        VersionedTextStore::new(&mut engine)
            .ensure_main_version("ws", "main", 1_000, &NoFaults)
            .unwrap();
        let client = RelaySyncClient::new(prepared_file_relay());
        let page = client.fetch_pull(&mut engine, "ws", &NoFaults).unwrap();
        assert_eq!(prepared_counts(&engine), (0, 0));
        assert_eq!(pull_token(&engine).as_deref(), Some(page.pull_token()));
        assert_eq!(read_relay_cursor(&engine, "ws").unwrap(), None);
        let expected = match boundary {
            "before apply" => 0,
            "partial apply" => {
                let fault = CrashAt {
                    point: FaultPoint::SyncBeforeApplyCommit,
                    nth: 1,
                    seen: AtomicUsize::new(0),
                };
                assert!(
                    client
                        .apply_pull(
                            &mut engine,
                            &mut Default::default(),
                            "ws",
                            &page,
                            &fault,
                            &NoLiveLeases,
                            2_000
                        )
                        .is_err()
                );
                assert_eq!(fault.seen.load(Ordering::SeqCst), 2);
                1
            }
            _ => {
                let fault = ScriptedFaults::crash_at(FaultPoint::SyncBetweenApplyAndCursorCommit);
                assert!(matches!(
                    client
                        .apply_pull(
                            &mut engine,
                            &mut Default::default(),
                            "ws",
                            &page,
                            fault.as_ref(),
                            &NoLiveLeases,
                            2_000
                        )
                        .unwrap(),
                    SyncPassOutcome::CrashedAfterApply { applied: 2, .. }
                ));
                assert!(fault.fired());
                2
            }
        };
        assert_eq!(prepared_counts(&engine), (expected, expected));
        drop(page);
        drop(client);
        drop(engine);

        let mut engine = EngineStore::open(&path, 3_000).unwrap();
        assert_eq!(prepared_counts(&engine), (expected, expected));
        assert_eq!(read_relay_cursor(&engine, "ws").unwrap(), None);
        for seq in 0..2 {
            assert!(!scratch.path().join(format!("prepared-{seq}.txt")).exists());
        }
        let client = RelaySyncClient::new(prepared_file_relay());
        let page = client.fetch_pull(&mut engine, "ws", &NoFaults).unwrap();
        // Applying succeeds with a transport that has no pages or blobs to serve.
        let offline = RelaySyncClient::new(PagedRelay::new([]));
        let result = offline
            .apply_pull(
                &mut engine,
                &mut Default::default(),
                "ws",
                &page,
                &NoFaults,
                &NoLiveLeases,
                3_000,
            )
            .unwrap();
        let SyncPassOutcome::Complete {
            applied,
            skipped,
            refused,
            pending_cursor: Some(cursor),
            changed_paths,
            ..
        } = result
        else {
            panic!("unexpected replay: {result:?}");
        };
        assert_eq!(
            (applied, skipped, refused),
            (2 - expected as usize, expected as usize, 0)
        );
        assert_eq!(
            changed_paths.len(),
            2,
            "replay keeps every unprojected path"
        );
        assert_eq!(prepared_counts(&engine), (2, 2));
        assert_eq!(read_relay_cursor(&engine, "ws").unwrap(), None);
        // Ordinary import returns placement paths; the RPC layer projects them.
        for seq in 0..2 {
            let path = format!("prepared-{seq}.txt");
            assert!(
                changed_paths
                    .iter()
                    .any(|change| change.version_id == "main" && change.path == path)
            );
            let head = VersionedTextStore::new(&mut engine)
                .read_text("ws", "main", &path)
                .unwrap()
                .unwrap();
            assert_eq!(head.text, format!("remote {seq}\n"));
            assert!(!scratch.path().join(path).exists());
        }
        assert_eq!(read_relay_cursor(&engine, "ws").unwrap(), None);
        commit(&offline, &mut engine, &cursor);
        drop(engine);
        let engine = EngineStore::open(&path, 4_000).unwrap();
        assert_eq!(prepared_counts(&engine), (2, 2));
        assert_eq!(read_relay_cursor(&engine, "ws").unwrap().unwrap().cursor, 2);
        assert!(offline.transport().pulls.lock().unwrap().is_empty());
        assert!(
            offline
                .transport()
                .download_batches
                .lock()
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn prepared_pull_refuses_a_changed_identity_or_cursor() {
    for field in [
        "origin_id",
        "replication_epoch",
        "stream_identity",
        "cursor",
    ] {
        let (_scratch, _path, mut engine) = open_store();
        seed_identity(&mut engine);
        let client = RelaySyncClient::new(padded_relay(1));
        let page = client.fetch_pull(&mut engine, "ws", &NoFaults).unwrap();
        if field == "cursor" {
            let (_, cursor) = pass(&client, &mut engine);
            commit(&client, &mut engine, &cursor);
        } else {
            engine
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        &format!(
                            "UPDATE sync_identity SET {field}='changed' WHERE workspace_id='ws'"
                        ),
                        [],
                    )
                    .map_err(SyncError::persist)?;
                    Ok::<_, SyncError>(())
                })
                .unwrap();
        }
        assert!(
            matches!(
                client.apply_pull(
                    &mut engine,
                    &mut Default::default(),
                    "ws",
                    &page,
                    &NoFaults,
                    &NoLiveLeases,
                    2_000
                ),
                Err(RelayError::InvalidResponse)
            ),
            "{field}"
        );
    }
}

#[test]
fn a_second_fetch_gets_a_new_token_and_refuses_apply_after_release() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let client = RelaySyncClient::new(padded_relay(1));
    let first = client.fetch_pull(&mut engine, "ws", &NoFaults).unwrap();
    assert_eq!(pull_token(&engine).as_deref(), Some(first.pull_token()));
    let retry = client.fetch_pull(&mut engine, "ws", &NoFaults).unwrap();
    assert_ne!(retry.pull_token(), first.pull_token());
    abandon_ordinary_pull(&mut engine, "ws", &NoFaults).unwrap();
    assert!(matches!(
        client.apply_pull(
            &mut engine,
            &mut Default::default(),
            "ws",
            &retry,
            &NoFaults,
            &NoLiveLeases,
            2_000
        ),
        Err(RelayError::InvalidResponse)
    ));
    assert_eq!(read_relay_cursor(&engine, "ws").unwrap(), None);
    let next = client.fetch_pull(&mut engine, "ws", &NoFaults).unwrap();
    assert_ne!(next.pull_token(), retry.pull_token());
    assert!(
        client
            .apply_pull(
                &mut engine,
                &mut Default::default(),
                "ws",
                &next,
                &NoFaults,
                &NoLiveLeases,
                2_000
            )
            .is_ok()
    );
}

#[test]
fn prepared_pull_preserves_work_written_after_fetch() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .unwrap();
    let client = RelaySyncClient::new(prepared_file_relay());
    let page = client.fetch_pull(&mut engine, "ws", &NoFaults).unwrap();
    VersionedTextStore::new(&mut engine)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "local-object".into(),
                path: "prepared-0.txt".into(),
                text: "local work\n".into(),
                moment_id: "local-moment".into(),
                metadata_origin: "user".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2_100,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    let result = client
        .apply_pull(
            &mut engine,
            &mut Default::default(),
            "ws",
            &page,
            &NoFaults,
            &NoLiveLeases,
            2_200,
        )
        .unwrap();
    assert!(
        matches!(
            result,
            SyncPassOutcome::Complete {
                conflicts_opened: 1,
                ..
            }
        ),
        "{result:?}"
    );
    let current = VersionedTextStore::new(&mut engine)
        .read_text("ws", "main", "prepared-0.txt")
        .unwrap()
        .unwrap();
    assert_eq!(current.text, "local work\n");
}

#[test]
fn prepared_pull_keeps_operation_page_and_payload_limits() {
    for count in [500, 501] {
        let (_scratch, _path, mut engine) = open_store();
        seed_identity(&mut engine);
        let ops = (0..count)
            .map(|seq| envelope("limit-peer", seq, "probe.padding", json!({})))
            .collect();
        let client = RelaySyncClient::new(PagedRelay::new([(
            0,
            PullResponse {
                ops,
                next_cursor: count,
                has_more: true,
            },
        )]));
        let page = client.fetch_pull(&mut engine, "ws", &NoFaults);
        assert_eq!(page.is_ok(), count == 500);
        assert_eq!(pull_token(&engine).is_some(), count == 500);
        assert_eq!(*client.transport().pulls.lock().unwrap(), [(0, 500)]);
        if let Ok(page) = page {
            let offline = RelaySyncClient::new(PagedRelay::new([]));
            let result = offline
                .apply_pull(
                    &mut engine,
                    &mut Default::default(),
                    "ws",
                    &page,
                    &NoFaults,
                    &NoLiveLeases,
                    2_000,
                )
                .unwrap();
            assert!(matches!(
                result,
                SyncPassOutcome::Complete {
                    fetched: 500,
                    has_more: true,
                    ..
                }
            ));
        }
    }
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let client = RelaySyncClient::new(padded_relay(17));
    let page = client.fetch_pull(&mut engine, "ws", &NoFaults).unwrap();
    assert_eq!(client.transport().pulls.lock().unwrap().len(), 16);
    assert_eq!(pull_token(&engine).as_deref(), Some(page.pull_token()));
    let offline = RelaySyncClient::new(PagedRelay::new([]));
    let result = offline
        .apply_pull(
            &mut engine,
            &mut Default::default(),
            "ws",
            &page,
            &NoFaults,
            &NoLiveLeases,
            2_000,
        )
        .unwrap();
    assert!(matches!(
        result,
        SyncPassOutcome::Complete {
            fetched: 16,
            has_more: true,
            ..
        }
    ));
    for payload_bytes in [
        crate::model::MAX_PAYLOAD_JSON_BYTES,
        crate::model::MAX_PAYLOAD_JSON_BYTES + 1,
    ] {
        let (_scratch, _path, mut engine) = open_store();
        seed_identity(&mut engine);
        let payload = json!("x".repeat(payload_bytes - 2));
        assert_eq!(serde_json::to_vec(&payload).unwrap().len(), payload_bytes);
        let client = RelaySyncClient::new(PagedRelay::new([(
            0,
            PullResponse {
                ops: vec![envelope("limit-peer", 0, "probe.padding", payload)],
                next_cursor: 1,
                has_more: false,
            },
        )]));
        assert_eq!(
            client.fetch_pull(&mut engine, "ws", &NoFaults).is_ok(),
            payload_bytes == crate::model::MAX_PAYLOAD_JSON_BYTES
        );
        assert_eq!(
            pull_token(&engine).is_some(),
            payload_bytes == crate::model::MAX_PAYLOAD_JSON_BYTES
        );
    }
}

fn commit<T: RelayTransport>(
    client: &RelaySyncClient<T>,
    engine: &mut EngineStore,
    cursor: &RelayCursor,
) {
    let outcome = client
        .commit_pull_cursor(engine, "ws", cursor, &NoFaults, &NoLiveLeases, 2_000)
        .unwrap();
    assert!(matches!(outcome, TxnOutcome::Committed(_)));
}

fn completion(cursor: &RelayCursor) -> &OrdinaryPullCompletion {
    cursor.ordinary_pull.as_ref().expect("a pull's cursor")
}

fn begin(engine: &mut EngineStore) -> String {
    let identity = read_sync_identity(engine, "ws").unwrap().unwrap();
    match crate::cursor::begin_ordinary_pull(engine, &identity, &NoFaults).unwrap() {
        TxnOutcome::Committed(token) => token,
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_fresh_identity_has_no_unfinished_ordinary_pull() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    assert_eq!(pull_token(&engine), None);
}

#[test]
fn a_pull_owns_its_progress_across_reopening_until_its_terminal_commit() {
    let (_scratch, path, mut engine) = open_store();
    seed_identity(&mut engine);
    let pages = i64::try_from(crate::model::MAX_PULL_PAGES_PER_PASS).unwrap() + 1;
    let client = RelaySyncClient::new(padded_relay(pages));

    let (has_more, first) = pass(&client, &mut engine);
    assert!(has_more);
    assert!(!completion(&first).terminal);
    assert_eq!(
        pull_token(&engine).as_ref(),
        Some(&completion(&first).token)
    );
    commit(&client, &mut engine, &first);
    assert_eq!(
        pull_token(&engine).as_ref(),
        Some(&completion(&first).token),
        "a page before the last leaves the pull unfinished"
    );

    drop(engine);
    let mut engine = EngineStore::open(&path, 3_000).unwrap();
    assert_eq!(
        pull_token(&engine).as_ref(),
        Some(&completion(&first).token)
    );

    let (has_more, last) = pass(&client, &mut engine);
    assert!(!has_more);
    assert!(completion(&last).terminal);
    assert_ne!(completion(&last).token, completion(&first).token);
    assert_eq!(pull_token(&engine).as_ref(), Some(&completion(&last).token));
    commit(&client, &mut engine, &last);
    assert_eq!(pull_token(&engine), None);
}

#[test]
fn only_the_pulls_own_terminal_cursor_under_its_identity_finishes_it() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let client = RelaySyncClient::new(padded_relay(1));
    let (_, cursor) = pass(&client, &mut engine);
    let token = completion(&cursor).token.clone();
    let finishing = |token: &str| {
        Some(OrdinaryPullCompletion {
            token: token.to_owned(),
            terminal: true,
        })
    };
    let refused = [
        RelayCursor {
            ordinary_pull: finishing("another-pull"),
            ..cursor.clone()
        },
        RelayCursor {
            replication_epoch: "epoch-2".to_owned(),
            ordinary_pull: finishing(&token),
            ..cursor.clone()
        },
        RelayCursor {
            stream_identity: "stream-2".to_owned(),
            ordinary_pull: finishing(&token),
            ..cursor.clone()
        },
        // A cursor without the pull's authority: synthetic, or stored.
        RelayCursor {
            ordinary_pull: None,
            ..cursor.clone()
        },
    ];
    for stale in &refused {
        commit(&client, &mut engine, stale);
        assert_eq!(pull_token(&engine).as_ref(), Some(&token), "{stale:?}");
    }
    let stored = read_relay_cursor(&engine, "ws").unwrap().unwrap();
    assert_eq!(stored.ordinary_pull, None);
    commit(&client, &mut engine, &stored);
    assert_eq!(pull_token(&engine).as_ref(), Some(&token));
    let share_view = ShareCursor {
        kind: CursorKind::ShareView,
        share_id: "share".to_owned(),
        cursor: cursor.cursor,
    };
    commit_share_cursor(&mut engine, "ws", &share_view, &NoFaults).unwrap();
    assert_eq!(pull_token(&engine).as_ref(), Some(&token));

    commit(&client, &mut engine, &cursor);
    assert_eq!(pull_token(&engine), None);
}

#[test]
fn a_restored_store_pulls_under_a_new_token_its_old_cursor_cannot_finish() {
    let (scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let client = RelaySyncClient::new(padded_relay(1));
    let (_, before_backup) = pass(&client, &mut engine);
    let backup = scratch.path().join("backup.db");
    engine
        .read_with(|conn| conn.execute("VACUUM INTO ?1", [backup.to_str().unwrap()]))
        .unwrap();
    drop(engine);

    let mut restored = EngineStore::open(&backup, 3_000).unwrap();
    assert_eq!(
        pull_token(&restored).as_ref(),
        Some(&completion(&before_backup).token)
    );
    let (_, after_restore) = pass(&client, &mut restored);
    assert_ne!(
        completion(&after_restore).token,
        completion(&before_backup).token
    );
    commit(&client, &mut restored, &before_backup);
    assert_eq!(
        pull_token(&restored).as_ref(),
        Some(&completion(&after_restore).token)
    );
    commit(&client, &mut restored, &after_restore);
    assert_eq!(pull_token(&restored), None);
}

#[test]
fn deleting_the_identity_takes_its_unfinished_pull_with_it() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let client = RelaySyncClient::new(padded_relay(1));
    let (_, cursor) = pass(&client, &mut engine);
    let insert = "INSERT INTO sync_identity \
        (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
        VALUES ('ws','local','epoch-1','stream-1',1000)";
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM sync_identity WHERE workspace_id='ws'", [])
                .map_err(SyncError::persist)?;
            assert_eq!(
                tx.query_row(
                    "SELECT COUNT(*) FROM sync_identity WHERE ordinary_pull_token IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(SyncError::corrupt)?,
                0
            );
            tx.execute(insert, []).map_err(SyncError::persist)
        })
        .unwrap();
    assert_eq!(pull_token(&engine), None);
    commit(&client, &mut engine, &cursor);
    assert_eq!(pull_token(&engine), None);
}

#[test]
fn each_saved_claim_refusal_abandons_the_pull_and_a_pending_claim_does_not() {
    for refusal in [
        RelayError::WorkspaceUnavailable,
        RelayError::EpochSuperseded,
        RelayError::IdentityNotRecognized,
        RelayError::IdentityRequired,
        RelayError::StreamIdentityMismatch,
    ] {
        let (_scratch, _path, mut engine) = open_store();
        seed_identity(&mut engine);
        let token = begin(&mut engine);
        let identity = read_sync_identity(&engine, "ws").unwrap().unwrap();
        let request = ClaimRequest {
            workspace_id: "ws".to_owned(),
            replication_epoch: identity.replication_epoch,
            stream_identity: identity.stream_identity,
        };
        let client = RelaySyncClient::new(ClaimRelay::default());
        // An unanswered claim saves only `pending`.
        *client.transport().refusal.lock().unwrap() = Some(RelayError::Partitioned);
        assert!(
            client
                .claim_workspace(&mut engine, request.clone(), None, &NoFaults)
                .is_err()
        );
        assert_eq!(pull_token(&engine), Some(token));
        *client.transport().refusal.lock().unwrap() = Some(refusal.clone());
        assert_eq!(
            client.claim_workspace(&mut engine, request, None, &NoFaults),
            Err(refusal.clone())
        );
        assert_eq!(pull_token(&engine), None, "{refusal:?}");
    }
}

#[test]
fn a_hosted_replica_starts_with_no_pull_and_an_ordinary_one_stays_ordinary() {
    let (_scratch, _path, mut hosted) = open_store();
    let origin = format!("{}host", crate::SERVICE_HOST_ORIGIN_PREFIX);
    create_hosted_replica(
        &mut hosted,
        "ws",
        &origin,
        "epoch-1",
        "stream-1",
        1_000,
        &NoFaults,
    )
    .unwrap();
    assert_eq!(pull_token(&hosted), None);

    let (_scratch, _path, mut ordinary) = open_store();
    seed_identity(&mut ordinary);
    let token = begin(&mut ordinary);
    assert!(matches!(
        create_hosted_replica(
            &mut ordinary,
            "ws",
            &origin,
            "epoch-1",
            "stream-1",
            1_000,
            &NoFaults
        ),
        Err(SyncError::InvalidInput {
            reason: "a replica cannot change between hosted and ordinary"
        })
    ));
    assert_eq!(pull_token(&ordinary), Some(token));
}

#[test]
fn abandoning_the_pull_keeps_what_it_applied_and_where_it_stopped() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let client = RelaySyncClient::new(padded_relay(1));
    let (_, cursor) = pass(&client, &mut engine);
    let applied = |engine: &EngineStore| {
        engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log WHERE origin_id='padding-peer'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
            })
            .unwrap()
    };
    let before = applied(&engine);
    assert!(before > 0);
    assert!(matches!(
        abandon_ordinary_pull(&mut engine, "ws", &NoFaults).unwrap(),
        TxnOutcome::Committed(true)
    ));
    assert_eq!(pull_token(&engine), None);
    assert!(matches!(
        abandon_ordinary_pull(&mut engine, "ws", &NoFaults).unwrap(),
        TxnOutcome::Committed(false)
    ));
    assert_eq!(applied(&engine), before);
    assert_eq!(read_relay_cursor(&engine, "ws").unwrap(), None);
    // The abandoned pass's own cursor still commits its position.
    commit(&client, &mut engine, &cursor);
    assert_eq!(
        read_relay_cursor(&engine, "ws").unwrap().map(|c| c.cursor),
        Some(1)
    );
    // Resuming sync pulls under a fresh token, replays what it already
    // applied once, and finishes normally.
    let (has_more, next) = pass(&client, &mut engine);
    assert!(!has_more);
    assert_ne!(completion(&next).token, completion(&cursor).token);
    assert_eq!(pull_token(&engine).as_ref(), Some(&completion(&next).token));
    commit(&client, &mut engine, &next);
    assert_eq!(pull_token(&engine), None);
    assert_eq!(applied(&engine), before);
}

#[test]
fn a_pass_that_fails_after_applying_an_envelope_stays_unfinished_across_reopening() {
    let (_scratch, path, mut engine) = open_store();
    seed_identity(&mut engine);
    let applied = |engine: &EngineStore| {
        engine
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log WHERE origin_id='padding-peer'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
            })
            .unwrap()
    };
    let client = RelaySyncClient::new(padded_relay(2));
    let second_envelope = CrashAt {
        point: FaultPoint::SyncBeforeApplyCommit,
        nth: 1,
        seen: AtomicUsize::new(0),
    };
    assert!(
        client
            .pull_chat_workspace(
                &mut engine,
                &mut Default::default(),
                "ws",
                &second_envelope,
                &NoLiveLeases,
                2_000,
            )
            .is_err()
    );
    assert_eq!(applied(&engine), 1, "the first envelope committed");
    let token = pull_token(&engine).expect("the failed pass still owns its progress");

    drop(engine);
    let mut engine = EngineStore::open(&path, 3_000).unwrap();
    assert_eq!(pull_token(&engine).as_ref(), Some(&token));
    let (has_more, retry) = pass(&client, &mut engine);
    assert!(!has_more);
    assert_ne!(completion(&retry).token, token);
    commit(&client, &mut engine, &retry);
    assert_eq!(pull_token(&engine), None);
    assert_eq!(
        applied(&engine),
        2,
        "the retry applies the first envelope once"
    );
}

#[test]
fn a_failed_fetch_changes_no_pull_progress() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let offline = RelaySyncClient::new(PagedRelay::new([]));
    let fetch = |engine: &mut EngineStore| {
        offline.pull_chat_workspace(
            engine,
            &mut Default::default(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            2_000,
        )
    };
    assert!(fetch(&mut engine).is_err());
    assert_eq!(
        pull_token(&engine),
        None,
        "with no earlier pass nothing waits"
    );
    let token = begin(&mut engine);
    assert!(fetch(&mut engine).is_err());
    assert_eq!(
        pull_token(&engine),
        Some(token),
        "an earlier pass's progress still waits"
    );
}

#[test]
fn a_crash_before_the_cursor_commit_waits_until_a_retry_and_an_empty_terminal_page_finish() {
    let (_scratch, path, mut engine) = open_store();
    seed_identity(&mut engine);
    let client = RelaySyncClient::new(padded_relay(1));
    let crash = ScriptedFaults::crash_at(FaultPoint::SyncBetweenApplyAndCursorCommit);
    let crashed = match client
        .pull_chat_workspace(
            &mut engine,
            &mut Default::default(),
            "ws",
            crash.as_ref(),
            &NoLiveLeases,
            2_000,
        )
        .unwrap()
    {
        SyncPassOutcome::CrashedAfterApply { pending_cursor, .. } => pending_cursor,
        other => panic!("{other:?}"),
    };
    assert!(completion(&crashed).terminal);
    drop(engine);
    let mut engine = EngineStore::open(&path, 3_000).unwrap();
    assert_eq!(
        pull_token(&engine).as_ref(),
        Some(&completion(&crashed).token)
    );

    let (_, retry) = pass(&client, &mut engine);
    commit(&client, &mut engine, &retry);
    assert_eq!(pull_token(&engine), None);
    // A later pass finds the end of the log: an empty terminal page.
    let (has_more, empty) = pass(&client, &mut engine);
    assert!(!has_more);
    assert_eq!(
        pull_token(&engine).as_ref(),
        Some(&completion(&empty).token)
    );
    commit(&client, &mut engine, &empty);
    assert_eq!(pull_token(&engine), None);
}

/// Crashes the `nth` time a pass reaches `point`, before its transaction
/// commits.
struct CrashAt {
    point: FaultPoint,
    nth: usize,
    seen: AtomicUsize,
}

impl dohc_engine_storage::FaultInjector for CrashAt {
    fn poll(&self, point: FaultPoint) -> dohc_engine_storage::FaultAction {
        if point == self.point && self.seen.fetch_add(1, Ordering::SeqCst) == self.nth {
            dohc_engine_storage::FaultAction::Crash
        } else {
            dohc_engine_storage::FaultAction::Continue
        }
    }
}

#[test]
fn a_rolled_back_transition_keeps_the_previous_state_and_its_pull() {
    let crash = |nth| CrashAt {
        point: FaultPoint::StorageBeforePersist,
        nth,
        seen: AtomicUsize::new(0),
    };

    // The terminal commit.
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    let client = RelaySyncClient::new(padded_relay(1));
    let (_, cursor) = pass(&client, &mut engine);
    let token = completion(&cursor).token.clone();
    assert!(matches!(
        client
            .commit_pull_cursor(&mut engine, "ws", &cursor, &crash(0), &NoLiveLeases, 2_000)
            .unwrap(),
        TxnOutcome::Crashed { committed: false }
    ));
    assert_eq!(read_relay_cursor(&engine, "ws").unwrap(), None);
    assert_eq!(pull_token(&engine).as_ref(), Some(&token));

    // Abandoning it.
    assert!(matches!(
        abandon_ordinary_pull(&mut engine, "ws", &crash(0)).unwrap(),
        TxnOutcome::Crashed { committed: false }
    ));
    assert_eq!(pull_token(&engine).as_ref(), Some(&token));

    // Saving a claim refusal, after `pending` committed.
    let identity = read_sync_identity(&engine, "ws").unwrap().unwrap();
    let claims = RelaySyncClient::new(ClaimRelay::default());
    *claims.transport().refusal.lock().unwrap() = Some(RelayError::EpochSuperseded);
    assert!(
        claims
            .claim_workspace(
                &mut engine,
                ClaimRequest {
                    workspace_id: "ws".to_owned(),
                    replication_epoch: identity.replication_epoch,
                    stream_identity: identity.stream_identity,
                },
                None,
                &crash(1),
            )
            .is_err()
    );
    let claim_state = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT claim_state FROM sync_identity WHERE workspace_id='ws'",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
        })
        .unwrap();
    assert_eq!(claim_state.as_deref(), Some("pending"));
    assert_eq!(pull_token(&engine), Some(token));
}
