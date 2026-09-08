use super::*;

#[test]
fn share_view_and_shared_channel_fail_closed_outside_boundary() {
    let (_scratch, _path, mut engine) = open_store();
    let view = ShareBoundary {
        share_id: "share-view".to_owned(),
        surface: ShareSurface::ShareView,
        channel_wire_id: None,
        granted: Some(ShareGrant {
            paths: vec!["shared/docs".to_owned()],
            version_id: None,
            access: ShareAccess::View,
        }),
    };
    let secret = envelope(
        "peer",
        0,
        "moment.append",
        json!({"versionId":"main","path":"shared/docs/.env"}),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &view, &secret, &NoFaults),
        Err(SyncError::ShareBoundaryViolation)
    ));
    let channel = ShareBoundary {
        share_id: "share-channel".to_owned(),
        surface: ShareSurface::SharedChannel,
        channel_wire_id: Some("wire-allowed".to_owned()),
        granted: None,
    };
    let private = envelope(
        "peer",
        0,
        "chat.follow.set",
        json!({"ownerUserId":"u","targetKind":"channel","targetId":"x","state":"following","atMs":1}),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &channel, &private, &NoFaults),
        Err(SyncError::ShareBoundaryViolation)
    ));
}

#[test]
fn shared_channel_channel_create_without_wire_id_is_rejected() {
    let (_scratch, _path, mut engine) = open_store();
    let boundary = ShareBoundary {
        share_id: "share-channel".to_owned(),
        surface: ShareSurface::SharedChannel,
        channel_wire_id: Some("wire-allowed".to_owned()),
        granted: None,
    };
    let op = envelope(
        "missing-wire",
        0,
        "chat.channel.create",
        json!({
            "channelId": "c-allow",
            "name": "Allowed",
            "slug": "allowed",
            "kind": "channel",
            "createdAtMs": 1
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &boundary, &op, &NoFaults),
        Err(SyncError::ShareBoundaryViolation)
    ));
}

#[test]
fn shared_channel_cross_channel_thread_and_message_are_rejected() {
    let (_scratch, _path, mut engine) = open_store();
    let other = ShareBoundary {
        share_id: "share-other".to_owned(),
        surface: ShareSurface::SharedChannel,
        channel_wire_id: Some("wire-other".to_owned()),
        granted: None,
    };
    let channel = envelope(
        "cross-channel",
        0,
        "chat.channel.create",
        json!({
            "channelId": "c-other",
            "name": "Other",
            "slug": "other",
            "kind": "channel",
            "createdAtMs": 1,
            "wireId": "wire-other"
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &other, &channel, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let thread = envelope(
        "cross-channel",
        1,
        "chat.thread.create",
        json!({
            "threadId": "t-other",
            "title": "Other thread",
            "createdAtMs": 2,
            "channelWireId": "wire-other"
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &other, &thread, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));

    let allowed = ShareBoundary {
        share_id: "share-allowed".to_owned(),
        surface: ShareSurface::SharedChannel,
        channel_wire_id: Some("wire-allowed".to_owned()),
        granted: None,
    };
    let foreign_thread = envelope(
        "cross-channel",
        2,
        "chat.thread.create",
        json!({
            "threadId": "t-foreign",
            "title": "Foreign thread",
            "createdAtMs": 3,
            "channelWireId": "wire-other"
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &allowed, &foreign_thread, &NoFaults),
        Err(SyncError::ShareBoundaryViolation)
    ));
    let foreign_message = envelope(
        "cross-channel",
        2,
        "chat.message.append",
        json!({
            "messageId": "m-other",
            "threadId": "t-other",
            "authorKind": "human",
            "authorDisplayName": "User",
            "body": "Outside the grant",
            "createdAtMs": 4
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &allowed, &foreign_message, &NoFaults),
        Err(SyncError::ShareBoundaryViolation)
    ));
}

#[test]
fn shared_channel_correctly_scoped_ops_apply() {
    let (_scratch, _path, mut engine) = open_store();
    let boundary = ShareBoundary {
        share_id: "share-allowed".to_owned(),
        surface: ShareSurface::SharedChannel,
        channel_wire_id: Some("wire-allowed".to_owned()),
        granted: None,
    };
    let channel = envelope(
        "allowed-channel",
        0,
        "chat.channel.create",
        json!({
            "channelId": "c-allow",
            "name": "Allowed",
            "slug": "allowed",
            "kind": "channel",
            "createdAtMs": 1,
            "wireId": "wire-allowed"
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &boundary, &channel, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let thread = envelope(
        "allowed-channel",
        1,
        "chat.thread.create",
        json!({
            "threadId": "t-allow",
            "title": "Allowed thread",
            "createdAtMs": 2,
            "channelWireId": "wire-allowed"
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &boundary, &thread, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let message = envelope(
        "allowed-channel",
        2,
        "chat.message.append",
        json!({
            "messageId": "m-allow",
            "threadId": "t-allow",
            "authorKind": "human",
            "authorDisplayName": "User",
            "body": "Inside the grant",
            "createdAtMs": 3
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &boundary, &message, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let rows: Vec<(String, String)> = engine
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT message_id,text FROM engine_search_chat_messages_fts \
                 WHERE workspace_id='ws' AND thread_id='t-allow' ORDER BY message_id",
            )?;
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .expect("shared-channel search rows");
    assert_eq!(
        rows,
        vec![
            (
                CHAT_THREAD_HEADER_MESSAGE_ID.to_owned(),
                "Allowed thread".to_owned()
            ),
            ("m-allow".to_owned(), "User\nInside the grant".to_owned())
        ]
    );
}

#[test]
fn shared_channel_pull_stops_at_one_completed_page_and_resumes_from_its_cursor() {
    let (_scratch, _path, mut engine) = open_store();
    let client = RelaySyncClient::new(PagedShareRelay::new(
        [
            (
                0,
                SharedChannelResponse {
                    ops: Vec::new(),
                    next_cursor: 1,
                    has_more: true,
                    push: None,
                },
            ),
            (
                1,
                SharedChannelResponse {
                    ops: Vec::new(),
                    next_cursor: 2,
                    has_more: false,
                    push: None,
                },
            ),
        ],
        [],
    ));

    let first = client
        .pull_shared_channel(&mut engine, "ws", "share", "channel-wire", &NoFaults)
        .expect("bounded shared-channel page");
    assert_eq!((first.fetched, first.next_cursor), (0, 1));
    assert!(
        first.has_more,
        "dropping has_more prevents the desktop adapter from draining page two"
    );
    assert_eq!(
        *client
            .transport()
            .shared_pulls
            .lock()
            .expect("shared pull calls"),
        [0],
        "restoring the hasMore loop consumes the second page in one actor turn"
    );
    assert_eq!(
        read_share_cursor(&engine, "ws", "share", CursorKind::SharedChannel)
            .expect("committed shared cursor"),
        1
    );

    let second = client
        .pull_shared_channel(&mut engine, "ws", "share", "channel-wire", &NoFaults)
        .expect("resumed shared-channel page");
    assert_eq!(second.next_cursor, 2);
}

#[test]
fn shared_channel_boundary_rejection_commits_its_only_op_and_next_pull_proceeds() {
    let (_scratch, _path, mut engine) = open_store();
    let rejected = ShareReplicationEnvelope {
        origin_id: "shared-peer".to_owned(),
        origin_seq: 0,
        op_kind: "chat.channel.create".to_owned(),
        payload: json!({
            "channelId": "outside-channel",
            "wireId": "outside-wire",
            "name": "Outside",
            "slug": "outside",
            "kind": "channel",
            "createdAtMs": 10
        }),
        recorded_at_ms: 10,
    };
    let admitted = ShareReplicationEnvelope {
        origin_id: "shared-peer".to_owned(),
        origin_seq: 1,
        op_kind: "chat.channel.create".to_owned(),
        payload: json!({
            "channelId": "inside-channel",
            "wireId": "channel-wire",
            "name": "Inside",
            "slug": "inside",
            "kind": "channel",
            "createdAtMs": 20
        }),
        recorded_at_ms: 20,
    };
    let client = RelaySyncClient::new(PagedShareRelay::new(
        [
            (
                0,
                SharedChannelResponse {
                    ops: vec![rejected],
                    next_cursor: 1,
                    has_more: true,
                    push: None,
                },
            ),
            (
                1,
                SharedChannelResponse {
                    ops: vec![admitted],
                    next_cursor: 2,
                    has_more: false,
                    push: None,
                },
            ),
        ],
        [],
    ));

    let first = client
        .pull_shared_channel(&mut engine, "ws", "share", "channel-wire", &NoFaults)
        .expect("boundary rejection is a reported, acknowledged outcome");
    assert_eq!(
        first,
        SharedChannelPullOutcome {
            fetched: 1,
            has_more: true,
            applied: 0,
            refused: 1,
            rejections: vec![SharedChannelRejection {
                origin_id: "shared-peer".to_owned(),
                origin_seq: 0,
                op_kind: "chat.channel.create".to_owned(),
                reason: "share-boundary-violation".to_owned(),
            }],
            skipped: 0,
            next_cursor: 1,
        }
    );
    assert_eq!(
        read_share_cursor(&engine, "ws", "share", CursorKind::SharedChannel)
            .expect("rejected page cursor"),
        1,
        "returning ShareOperationRejected before commit leaves this at zero"
    );

    let second = client
        .pull_shared_channel(&mut engine, "ws", "share", "channel-wire", &NoFaults)
        .expect("the page after the rejected-only page must remain reachable");
    assert_eq!(
        (
            second.fetched,
            second.applied,
            second.refused,
            second.next_cursor
        ),
        (1, 1, 0, 2)
    );
    assert_eq!(
        *client
            .transport()
            .shared_pulls
            .lock()
            .expect("shared pull calls"),
        [0, 1],
        "failing to commit the rejected boundary refetches cursor zero"
    );
}

#[test]
fn shared_channel_push_resumes_from_durable_physical_and_dense_positions() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO chat_channels \
                 (workspace_id,channel_id,name,slug,kind,created_at_ms,updated_at_ms) \
                 VALUES ('ws','channel','Channel','channel','channel',1,1)",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_channel_wire_ids (workspace_id,wire_id,channel_id) \
                 VALUES ('ws','channel-wire','channel')",
                [],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO chat_threads \
                 (workspace_id,thread_id,title,created_at_ms,updated_at_ms,channel_id) \
                 VALUES ('ws','thread','Thread',1,1,'channel')",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("shared channel fixture");
    assert_eq!(
        journal_local_replication_op(
            &mut engine,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "chat.message.append",
            &json!({"threadId": "thread"}),
            1_001,
            &NoFaults,
        )
        .expect("journal first eligible op"),
        TxnOutcome::Committed(1)
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    assert_eq!(
        client
            .push_shared_channel(&mut engine, "ws", "share", "channel-wire", &NoFaults)
            .expect("first shared push")
            .pushed,
        1
    );

    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM chat_threads WHERE workspace_id='ws' AND thread_id='thread'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("remove historical eligibility fixture");
    assert_eq!(
        journal_local_replication_op(
            &mut engine,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "chat.channel.create",
            &json!({"wireId": "channel-wire"}),
            1_002,
            &NoFaults,
        )
        .expect("journal next eligible op"),
        TxnOutcome::Committed(2)
    );
    assert_eq!(
        client
            .push_shared_channel(&mut engine, "ws", "share", "channel-wire", &NoFaults)
            .expect("incremental shared push")
            .pushed,
        1
    );

    let pushes = client
        .transport()
        .shared_pushes
        .lock()
        .expect("shared push calls");
    assert_eq!(pushes.len(), 2);
    assert_eq!(pushes[0].ops[0].origin_seq, 0);
    assert_eq!(
        pushes[1].ops[0].origin_seq, 1,
        "rescanning from -1 recomputes the removed op as ineligible and reuses dense zero"
    );
    drop(pushes);
    let state: (i64, Option<i64>) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT pushed_seq,dense_seq FROM shared_channel_push_state \
                 WHERE workspace_id='ws' AND share_id='share'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("durable shared push state");
    assert_eq!(state, (2, Some(1)));
}

#[test]
fn shared_channel_push_bootstraps_legacy_state_without_a_dense_position() {
    let (_scratch, _path, mut engine) = open_store();
    seed_identity(&mut engine);
    assert_eq!(
        journal_local_replication_op(
            &mut engine,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "chat.channel.create",
            &json!({"wireId": "channel-wire"}),
            1_001,
            &NoFaults,
        )
        .expect("journal legacy eligible op"),
        TxnOutcome::Committed(1)
    );
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO shared_channel_push_state \
                 (workspace_id,share_id,pushed_seq,dense_seq) \
                 VALUES ('ws','share',1,NULL)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("legacy shared push state");
    assert_eq!(
        journal_local_replication_op(
            &mut engine,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "chat.channel.create",
            &json!({"wireId": "channel-wire"}),
            1_002,
            &NoFaults,
        )
        .expect("journal post-migration op"),
        TxnOutcome::Committed(2)
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    assert_eq!(
        client
            .push_shared_channel(&mut engine, "ws", "share", "channel-wire", &NoFaults)
            .expect("bootstrap shared push")
            .pushed,
        1
    );
    let pushes = client
        .transport()
        .shared_pushes
        .lock()
        .expect("shared push calls");
    assert_eq!(pushes.len(), 1);
    assert_eq!(
        pushes[0].ops[0].origin_seq, 1,
        "the migrated physical cursor must bootstrap its matching dense coordinate"
    );
}
