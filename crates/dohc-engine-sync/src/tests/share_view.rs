use super::*;

#[test]
fn received_collection_projection_reads_pulls_incrementally_without_owner_side_effects() {
    use dohc_engine_domain::{
        CollectionProjection, CollectionQuery, get_collection, get_collection_record,
        list_collections, project_collections_in_tx, query_collection_records,
    };
    for access in [ShareAccess::Edit, ShareAccess::View] {
        let (_scratch, _path, mut engine) = open_store();
        let schema = b"name: Tasks\nfields:\n  Title:\n    type: text\n".to_vec();
        let record_id = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
        let first = format!("---\nid: {record_id}\nTitle: First\n---\nBody\n").into_bytes();
        let second = format!("---\nid: {record_id}\nTitle: Second\n---\nBody\n").into_bytes();
        let unadopted = b"---\nTitle: No owner id yet\n---\n".to_vec();
        let automations = b"version: 1\nautomations:\n  - id: stamp\n    name: Stamp\n    when: record-added\n    do:\n      - set:\n          Title: Ran\n".to_vec();
        let hash = dohc_engine_storage::hex_sha256;
        let client = RelaySyncClient::new(
            PagedShareRelay::new(
                [],
                [
                    (
                        0,
                        ShareViewResponse {
                            work_references: Vec::new(),
                            next_reference_after: None,
                            reference_has_more: false,
                            ops: vec![
                                share_view_write_op(
                                    0,
                                    "docs/tasks/collection.yaml",
                                    &hash(&schema),
                                ),
                                share_view_write_op(1, "docs/tasks/a.md", &hash(&first)),
                                share_view_write_op(
                                    2,
                                    "docs/tasks/unadopted.md",
                                    &hash(&unadopted),
                                ),
                                share_view_write_op(
                                    3,
                                    "docs/tasks/automations.yaml",
                                    &hash(&automations),
                                ),
                                share_view_write_op(4, "private/collection.yaml", &hash(&schema)),
                            ],
                            next_cursor: 5,
                            has_more: false,
                        },
                    ),
                    (
                        5,
                        ShareViewResponse {
                            work_references: Vec::new(),
                            next_reference_after: None,
                            reference_has_more: false,
                            ops: vec![share_view_write_op(5, "docs/tasks/a.md", &hash(&second))],
                            next_cursor: 6,
                            has_more: false,
                        },
                    ),
                ],
            )
            .with_view_blobs(
                [schema, first, second, unadopted, automations]
                    .into_iter()
                    .map(|bytes| (hash(&bytes), bytes)),
            ),
        );
        let grant = ShareGrant {
            paths: vec!["docs".to_owned()],
            version_id: None,
            access,
        };
        let mut projection = CollectionProjection::default();
        for (expected_title, expected_paths) in [
            (
                "First",
                vec![
                    "docs/tasks/a.md",
                    "docs/tasks/collection.yaml",
                    "docs/tasks/unadopted.md",
                ],
            ),
            ("Second", vec!["docs/tasks/a.md"]),
        ] {
            let mut pull = client
                .pull_share_view(&mut engine, "ws", "share", &grant, &NoFaults)
                .unwrap();
            if expected_title == "First" {
                // A crash here leaves snapshots but no cursor. A new worker must
                // not bind records before the shared indexing guard exists.
                let TxnOutcome::Committed((next, paths)) = engine
                    .write_with(&NoFaults, |tx| {
                        project_collections_in_tx(tx, "ws", "main", projection)
                    })
                    .unwrap()
                else {
                    panic!("projection crashed")
                };
                projection = next;
                assert!(paths.is_empty());
                engine
                    .read_with(|conn| {
                        assert_eq!(
                            conn.query_row("SELECT count(*) FROM collection_records", [], |row| {
                                row.get::<_, i64>(0)
                            })?,
                            0
                        );
                        Ok::<_, rusqlite::Error>(())
                    })
                    .unwrap();
                // Restarting after that crash replays already settled writes.
                pull = client
                    .pull_share_view(&mut engine, "ws", "share", &grant, &NoFaults)
                    .unwrap();
                assert_eq!(pull.applied, 0);
                assert!(!pull.changed_paths.is_empty());
            }
            client
                .commit_share_view_cursor(&mut engine, "ws", &pull.pending_cursor, &NoFaults)
                .unwrap();
            let moment_count: i64 = engine
                .read_with(|conn| {
                    conn.query_row("SELECT count(*) FROM moments", [], |row| row.get(0))
                })
                .unwrap();
            let outcome = engine
                .write_with(&NoFaults, |tx| {
                    project_collections_in_tx(tx, "ws", "main", projection)
                })
                .unwrap();
            let TxnOutcome::Committed((next, paths)) = outcome else {
                panic!("projection crashed")
            };
            projection = next;
            assert_eq!(paths, expected_paths);
            engine
                .read_with(|conn| -> Result<(), dohc_engine_domain::DomainError> {
                    let listed = list_collections(conn, "ws", 100, None)?;
                    assert_eq!(listed.collections.len(), 1);
                    assert_eq!(listed.collections[0].path, "docs/tasks");
                    let collection = get_collection(conn, "ws", "docs/tasks")?.unwrap();
                    assert_eq!(collection.schema.fields.len(), 1);
                    let record =
                        get_collection_record(conn, "ws", "docs/tasks", record_id, 100, None)?
                            .unwrap();
                    assert!(record.history.is_empty());
                    let queried = query_collection_records(
                        conn,
                        "ws",
                        "docs/tasks",
                        &CollectionQuery::default(),
                    )?
                    .unwrap();
                    assert_eq!(queried.records.len(), 1);
                    assert_eq!(
                        queried.records[0]
                            .values
                            .iter()
                            .find(|field| field.field == "Title")
                            .unwrap()
                            .value,
                        json!(expected_title)
                    );
                    Ok(())
                })
                .unwrap();
            engine.read_with(|conn| -> Result<(), rusqlite::Error> {
                for table in ["automation_claims", "collection_field_history"] {
                    let count: i64 = conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get(0))?;
                    assert_eq!(count, 0, "projection created {table}");
                }
                assert_eq!(conn.query_row("SELECT count(*) FROM moments", [], |row| row.get::<_, i64>(0))?, moment_count);
                assert_eq!(conn.query_row("SELECT count(*) FROM collection_records WHERE adoption_state<>'adopted'", [], |row| row.get::<_, i64>(0))?, 0);
                Ok(())
            }).unwrap();
            let TxnOutcome::Committed((next, unchanged)) = engine
                .write_with(&NoFaults, |tx| {
                    project_collections_in_tx(tx, "ws", "main", projection)
                })
                .unwrap()
            else {
                panic!("projection crashed")
            };
            projection = next;
            assert!(unchanged.is_empty());
        }
        // Disposable worker state is enough to rebuild an existing store.
        let TxnOutcome::Committed((_, rebuilt)) = engine
            .write_with(&NoFaults, |tx| {
                project_collections_in_tx(tx, "ws", "main", CollectionProjection::default())
            })
            .unwrap()
        else {
            panic!("projection crashed")
        };
        assert!(!rebuilt.is_empty());
    }
}

#[test]
fn share_view_secondary_path_out_of_boundary_is_rejected() {
    let (_scratch, _path, mut engine) = open_store();
    let boundary = ShareBoundary {
        share_id: "share-view".to_owned(),
        surface: ShareSurface::ShareView,
        channel_wire_id: None,
        granted: Some(ShareGrant {
            paths: vec!["shared/docs".to_owned()],
            version_id: None,
            access: ShareAccess::View,
        }),
    };
    let crossing = envelope(
        "view-paths",
        0,
        "moment.append",
        json!({
            "versionId": "main",
            "path": "shared/docs/a.md",
            "payloadAfterPath": "outside/b.md"
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &boundary, &crossing, &NoFaults),
        Err(SyncError::ShareBoundaryViolation)
    ));
    let inside = envelope(
        "view-paths",
        0,
        "moment.append",
        json!({
            "versionId": "main",
            "path": "shared/docs/a.md",
            "payloadAfterPath": "shared/docs/b.md"
        }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &boundary, &inside, &NoFaults),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
}

/// A pinned grant for `shared/docs`, on the version the share names — `None`
/// is the relay's live-follow-main selector.
fn share_view_version_boundary(version_id: Option<&str>) -> ShareBoundary {
    ShareBoundary {
        share_id: "share-view".to_owned(),
        surface: ShareSurface::ShareView,
        channel_wire_id: None,
        granted: Some(ShareGrant {
            paths: vec!["shared/docs".to_owned()],
            version_id: version_id.map(str::to_owned),
            access: ShareAccess::View,
        }),
    }
}

fn share_view_moment(payload: serde_json::Value) -> ReplicationEnvelope {
    envelope("view-version", 0, "moment.append", payload)
}

/// The version rule from the recipient's side, on both selector shapes the
/// relay can state. The relay serves a `moment.append` only when the moment's
/// version equals the share's target version — the selector's `versionId`, or
/// `main` when it names none (`services/sync-relay/src/shareFilter.ts`). This
/// proves the recipient states the same rule for both, so a relay whose
/// selection diverges from the pinned grant cannot land another lineage's
/// moments in the shared view.
///
/// The main-following case is the one worth naming: a grant with NO version is
/// a live-follow of `main`, not "compare nothing". Reading it the second way
/// would make this check vacuous for every path share, which is the dominant
/// shape.
#[test]
fn share_view_moment_from_an_ungranted_version_is_refused_naming_both_versions() {
    let (_scratch, _path, mut engine) = open_store();
    let moment = |version: &str| {
        share_view_moment(json!({
            "versionId": version,
            "operation": "write",
            "path": "shared/docs/a.md",
            "payloadAfterPath": "shared/docs/a.md"
        }))
    };
    for (granted, entitled) in [(None, "main"), (Some("version-granted"), "version-granted")] {
        let boundary = share_view_version_boundary(granted);
        let refusal =
            apply_shared_envelope(&mut engine, &boundary, &moment("version-other"), &NoFaults)
                .expect_err("a moment from an ungranted lineage is refused");
        assert!(
            matches!(
                &refusal,
                SyncError::ShareVersionMismatch { op_kind, granted, offered }
                    if op_kind == "moment.append"
                        && granted == entitled
                        && offered == "version-other"
            ),
            "a {granted:?} grant compares nothing, so the recipient replays a lineage              the grant never named: {refusal:?}"
        );
        let message = refusal.to_string();
        assert!(
            message.contains(entitled) && message.contains("version-other"),
            "the refusal must name the granted and the offered version: {message}"
        );
        assert!(
            matches!(
                apply_shared_envelope(&mut engine, &boundary, &moment(entitled), &NoFaults),
                Ok(ApplyOutcome {
                    primary: ApplyDisposition::Applied(_),
                    refusals: ref outcome_refusals,
                    sharing_declined: ref outcome_sharing_declined,
                }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
            ),
            "the granted version's own moments still apply"
        );
    }
}

#[test]
fn share_view_moment_without_a_version_identity_is_refused_as_malformed() {
    let (_scratch, _path, mut engine) = open_store();
    // Both selector shapes the relay can state: live-follow main, and a
    // named version share.
    for version_id in [None, Some("version-granted")] {
        let boundary = share_view_version_boundary(version_id);
        for stripped in [
            json!({"path": "shared/docs/a.md"}),
            json!({"versionId": null, "path": "shared/docs/a.md"}),
            json!({"versionId": 7, "path": "shared/docs/a.md"}),
            // Not a version id the relay could have issued, so not one this
            // boundary reads as one either — the shared selector rule
            // (`packages/security-contract/src/shareSelector.ts`), held to its
            // oracle in `tests/security_contract.rs`.
            json!({"versionId": "", "path": "shared/docs/a.md"}),
            json!({"versionId": " version-granted", "path": "shared/docs/a.md"}),
            json!({"versionId": "x".repeat(MAX_SHARE_VERSION_ID_CHARS + 1), "path": "shared/docs/a.md"}),
        ] {
            let outcome = apply_shared_envelope(
                &mut engine,
                &boundary,
                &share_view_moment(stripped.clone()),
                &NoFaults,
            );
            assert!(
                matches!(outcome, Err(SyncError::ShareVersionUnusable { .. })),
                "an unchecked payload is accepted, so stripping versionId disarms the version rule: {stripped} -> {outcome:?}"
            );
        }
    }
}

#[test]
fn share_view_pull_returns_one_page_as_a_pending_resumable_cursor() {
    let (_scratch, _path, mut engine) = open_store();
    let client = RelaySyncClient::new(PagedShareRelay::new(
        [],
        [
            (
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: Vec::new(),
                    next_cursor: 1,
                    has_more: true,
                },
            ),
            (
                1,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: Vec::new(),
                    next_cursor: 2,
                    has_more: false,
                },
            ),
        ],
    ));

    let first = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .expect("bounded share-view page");
    assert_eq!((first.fetched, first.pending_cursor.cursor), (0, 1));
    assert!(
        first.has_more,
        "dropping has_more prevents the desktop adapter from draining page two"
    );
    assert_eq!(
        *client
            .transport()
            .view_pulls
            .lock()
            .expect("view pull calls"),
        [(0, crate::model::MAX_PULL_OPS_PER_PASS)],
        "restoring the hasMore loop accumulates the second page"
    );
    assert_eq!(
        read_share_cursor(&engine, "ws", "share", CursorKind::ShareView)
            .expect("uncommitted view cursor"),
        0
    );
    client
        .commit_share_view_cursor(&mut engine, "ws", &first.pending_cursor, &NoFaults)
        .expect("commit first view page");
    let second = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .expect("resume view page");
    assert_eq!(second.pending_cursor.cursor, 2);
    assert!(!second.has_more);
}

fn share_view_write_op(seq: i64, path: &str, sha256: &str) -> ShareReplicationEnvelope {
    ShareReplicationEnvelope {
        origin_id: "peer".to_owned(),
        origin_seq: seq,
        op_kind: "moment.append".to_owned(),
        payload: json!({
            "versionId": "main",
            "operation": "write",
            "path": path,
            "payloadAfterPath": path,
            "payloadAfterBlobSha256": sha256,
            "payloadAfterContentKind": "text"
        }),
        recorded_at_ms: 10 + seq,
    }
}

#[test]
fn share_view_replay_keeps_declared_agents_in_list_and_detail_through_replay_and_restart() {
    let (_scratch, database, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let body = b"Agent edited while hosted.".to_vec();
    let sha = dohc_engine_storage::hex_sha256(&body);
    let authors = json!([
        {"kind":"agent","agentId":"trip-agent-hosted","agentName":"Trip helper","onBehalfOf":"opaque-relay-owner","depth":0,
         "agentRunId":"private-run","principalId":"fabricated-authority","private":{"path":"private/hidden.md"}},
        {"kind":"agent","agentId":"chained-agent 旅行","onBehalfOf":"local:private-person","depth":64},
        {"kind":"human","humanId":"private-human"},
        {"kind":"unattributed"},
        {"kind":"human","humanId":"person","humanName":"Person"},
        {"kind":"link","publicPrincipalId":"edit-link","label":"Edit link"},
        {"kind":"automation","automationId":"private-automation","depth":1},
        {"kind":"public","principalId":"fabricated-principal","grantId":"fabricated-grant"}
    ]);
    let expected = json!([
        {"kind":"agent","agentId":"trip-agent-hosted","agentName":"Trip helper","onBehalfOf":"opaque-relay-owner"},
        {"kind":"agent","agentId":"chained-agent 旅行","depth":64},
        {"kind":"unattributed"},
        {"kind":"human","humanId":"person","humanName":"Person"},
        {"kind":"link","publicPrincipalId":"edit-link","label":"Edit link"}
    ]);
    let binary = share_view_binary_write_op(1, "docs/blob.bin", &sha);
    let mut rename = share_view_write_op(2, "docs/continued.md", &sha);
    rename.payload["operation"] = json!("rename");
    rename.payload["payloadBeforePath"] = json!("docs/plan.md");
    let mut deletion = share_view_write_op(3, "docs/blob.bin", &sha);
    deletion.payload = json!({"versionId":"main","operation":"delete","path":"docs/blob.bin"});
    let mut wrong_version = share_view_write_op(5, "docs/other.md", &sha);
    wrong_version.payload["versionId"] = json!("other-version");
    let mut ops = vec![
        share_view_write_op(0, "docs/plan.md", &sha),
        binary,
        rename,
        deletion,
        share_view_write_op(4, "private/hidden.md", &sha),
        wrong_version,
    ];
    for op in &mut ops {
        op.payload["authors"] = authors.clone();
        op.payload["momentId"] = json!("owner-source-moment");
        op.payload["metadata"] = json!({"origin":"user","summary":"private-summary","correlationId":"private-correlation"});
    }
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops,
                    next_cursor: 6,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(sha, body)]),
    );
    let first = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .unwrap();
    assert_eq!((first.applied, first.skipped), (4, 2));
    let read = |store: &mut EngineStore| {
        let versioned = VersionedTextStore::new(store);
        let page = versioned
            .list_moments(&dohc_engine_domain::ListMomentsQuery {
                workspace_id: "ws".to_owned(),
                version_id: Some("main".to_owned()),
                object_id: None,
                limit: 20,
                before_moment_order: None,
            })
            .unwrap();
        assert_eq!(page.moments.len(), 4);
        assert!(
            page.moments
                .iter()
                .any(|moment| moment.path == "docs/plan.md"
                    && moment.after_text.as_deref() == Some("Agent edited while hosted."))
        );
        for row in &page.moments {
            let detail = versioned.get_moment("ws", &row.moment_id).unwrap().unwrap();
            assert_eq!(detail.author_json, row.author_json);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(row.author_json.as_deref().unwrap())
                    .unwrap(),
                expected
            );
            assert_eq!(detail.metadata_origin, "sync");
            assert!(detail.metadata_summary.is_none() && detail.metadata_correlation_id.is_none());
        }
        assert!(
            versioned
                .get_moment("ws", "owner-source-moment")
                .unwrap()
                .is_none()
        );
        page
    };
    let original = read(&mut engine);
    let replay = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .unwrap();
    assert_eq!(replay.applied, 0);
    assert_eq!(read(&mut engine), original);
    drop(engine);
    let mut engine = EngineStore::open(&database, 2_000).unwrap();
    assert_eq!(read(&mut engine), original);
}

#[test]
fn share_view_replay_discards_invalid_or_oversized_provenance_without_losing_content() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let body = b"Selected content remains.".to_vec();
    let sha = dohc_engine_storage::hex_sha256(&body);
    let valid =
        json!({"kind":"agent","agentId":"é".repeat(256),"onBehalfOf":"opaque-owner","depth":1});
    let mut mixed = vec![
        json!({"kind":"agent","agentId":""}),
        json!({"kind":"agent","agentId":"é".repeat(257)}),
        json!({"kind":"agent","agentId":"bad\u{0085}id"}),
        json!({"kind":"agent","agentId":1}),
        json!({"kind":"agent","agentId":"agent","onBehalfOf":""}),
        json!({"kind":"agent","agentId":"agent","onBehalfOf":"bad\nprincipal"}),
        json!({"kind":"agent","agentId":"agent","onBehalfOf":1}),
    ];
    for depth in [json!(-1), json!(1.5), json!(65), json!(null), json!("1")] {
        mixed.push(json!({"kind":"agent","agentId":"agent","depth":depth}));
    }
    mixed.push(valid.clone());
    let short = json!({"kind":"agent","agentId":"agent"});
    let cases = [
        json!(mixed),
        json!(null),
        json!({}),
        json!([]),
        json!([{"kind":"agent","agentId":""}]),
        json!(vec![short.clone(); 1_024]),
        json!(vec![short; 1_025]),
        json!(vec![json!({"kind":"agent","agentId":"x".repeat(512)}); 257]),
    ];
    let ops = cases
        .into_iter()
        .enumerate()
        .map(|(index, authors)| {
            let mut op = share_view_write_op(index as i64, &format!("docs/{index}.md"), &sha);
            op.payload["authors"] = authors;
            op
        })
        .collect();
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops,
                    next_cursor: 8,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(sha, body)]),
    );
    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .unwrap();
    assert_eq!((outcome.applied, outcome.skipped), (8, 0));
    let versioned = VersionedTextStore::new(&mut engine);
    let page = versioned
        .list_moments(&dohc_engine_domain::ListMomentsQuery {
            workspace_id: "ws".to_owned(),
            version_id: Some("main".to_owned()),
            object_id: None,
            limit: 20,
            before_moment_order: None,
        })
        .unwrap();
    assert_eq!(page.moments.len(), 8);
    for moment in page.moments {
        assert_eq!(
            moment.after_text.as_deref(),
            Some("Selected content remains.")
        );
        match moment.path.as_str() {
            "docs/0.md" => assert_eq!(
                serde_json::from_str::<serde_json::Value>(moment.author_json.as_deref().unwrap())
                    .unwrap(),
                json!([valid])
            ),
            "docs/5.md" => assert_eq!(
                serde_json::from_str::<serde_json::Value>(moment.author_json.as_deref().unwrap())
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .len(),
                1_024
            ),
            _ => assert!(moment.author_json.is_none()),
        }
    }
}

/// The same served write, on the version a share pinned. A version share's
/// served moments name that version, never `main` — the relay's
/// `targetVersionId` decides which, and this mirrors it in the fixture.
fn share_view_write_op_on(
    seq: i64,
    path: &str,
    sha256: &str,
    version_id: &str,
) -> ShareReplicationEnvelope {
    let mut op = share_view_write_op(seq, path, sha256);
    op.payload["versionId"] = json!(version_id);
    op
}

/// A refusal class the pull's skip arm does not list does not merely lose its
/// copy: it falls to the error arm, ABORTS the pull, and the cursor never
/// advances — so the same page is fetched forever and every valid op behind
/// it is never applied. That is the failure mode a new error variant meeting
/// an old match arm produces, and it is worse than the wrong copy that
/// introduced the variant.
#[test]
fn share_view_pull_completes_past_an_unknown_op_kind_and_applies_its_neighbours() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let body = b"granted body".to_vec();
    let sha = dohc_engine_storage::hex_sha256(&body);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![
                        ShareReplicationEnvelope {
                            origin_id: "peer".to_owned(),
                            origin_seq: 0,
                            op_kind: "future.op".to_owned(),
                            payload: json!({ "versionId": "main", "path": "docs/a.md" }),
                            recorded_at_ms: 10,
                        },
                        share_view_write_op(1, "docs/b.md", &sha),
                    ],
                    next_cursor: 2,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(sha, body)]),
    );

    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .expect("an unlisted refusal class aborts the pull and the page retries forever");

    assert_eq!(
        (outcome.applied, outcome.skipped),
        (1, 1),
        "the unknown kind is skipped and its valid neighbour still applies"
    );
    assert_eq!(
        outcome
            .refusals
            .iter()
            .map(|refusal| (refusal.op_kind.as_str(), refusal.code))
            .collect::<Vec<_>>(),
        [("future.op", "invalid-input")],
        "the promised refusal is never persisted: {:?}",
        outcome.refusals
    );
    assert_eq!(share_view_pull_changed(&outcome), ["docs/b.md"]);
}

/// A malformed envelope is skipped, and its cursor commits past it — so when
/// the op carries a usable origin coordinate, the reason has somewhere to
/// live. An oversized `moment.append` payload is the concrete case: the relay
/// serves it, the engine cannot build an envelope from it, and without this
/// the recipient loses that content permanently with nothing said and no
/// limit named.
#[test]
fn share_view_pull_reports_a_malformed_op_that_still_has_a_coordinate() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let oversized = "x".repeat(MAX_PAYLOAD_JSON_BYTES + 1);
    let oversized_payload = json!({ "versionId": "main", "path": oversized });
    let encoded = serde_json::to_vec(&oversized_payload)
        .expect("payload encodes")
        .len();
    let client = RelaySyncClient::new(PagedShareRelay::new(
        [],
        [(
            0,
            ShareViewResponse {
                work_references: Vec::new(),
                next_reference_after: None,
                reference_has_more: false,
                ops: vec![
                    ShareReplicationEnvelope {
                        origin_id: "peer".to_owned(),
                        origin_seq: 0,
                        op_kind: "moment.append".to_owned(),
                        payload: oversized_payload.clone(),
                        recorded_at_ms: 10,
                    },
                    // No usable coordinate: nothing to file a refusal under.
                    ShareReplicationEnvelope {
                        origin_id: String::new(),
                        origin_seq: 1,
                        op_kind: "moment.append".to_owned(),
                        payload: json!({ "versionId": "main", "path": "docs/a.md" }),
                        recorded_at_ms: 11,
                    },
                ],
                next_cursor: 2,
                has_more: false,
            },
        )],
    ));

    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .expect("a malformed op is skipped, not fatal");

    assert_eq!((outcome.applied, outcome.skipped), (0, 2));
    // Both are recorded. The one with a usable coordinate is filed under it;
    // the one without is filed under WHERE IT sat in the page, because its
    // cursor commits past it either way and "no identity" must not mean "no
    // durable record".
    assert_eq!(
        outcome
            .refusals
            .iter()
            .map(|refusal| (refusal.origin_id.as_str(), refusal.origin_seq))
            .collect::<Vec<_>>(),
        [("peer", 0), ("\u{1f}share-page:0", 1)],
        "a malformed op loses its reason — the one with a coordinate, or the one whose only identity is its page position: {:?}",
        outcome.refusals
    );
    // The op filed under its page position never shows the reader its origin
    // id, so the numbers are all that separate an empty one from a small
    // overrun or from a hundred kilobytes.
    let page_filed = &outcome.refusals[1].detail;
    assert!(
        page_filed.contains("it is empty"),
        "an origin id the reader never sees is refused without naming what was wrong with it: {page_filed}"
    );
    let detail = &outcome.refusals[0].detail;
    assert!(
        detail.contains(&MAX_PAYLOAD_JSON_BYTES.to_string())
            && detail.contains(&encoded.to_string()),
        "the refusal names no limit and no observed size, so one byte over reads like ten times over: {detail}"
    );
}

/// The tie between the page-position namespace and the origin-id validator.
///
/// The namespace is only airtight while `bounded` rejects the character it is
/// built from. Relaxing that validator would silently hand the relay the
/// ability to name an origin inside this recipient's own identity space, so it
/// breaks here instead.
#[test]
fn page_position_origins_cannot_alias_a_relay_origin() {
    let (origin_id, _) = crate::relay::page_position_origin(0, 1);
    assert!(
        crate::model::bounded(&origin_id, "origin").is_err(),
        "a page position is spelled with characters a relay may also use, so the relay can name this recipient's own coordinates: {origin_id:?}"
    );
}

/// The version rule on the PRODUCTION path. `pull_share_view` carries the
/// pinned grant into the boundary, so a relay that serves a moment from a
/// lineage the grant never named is refused before replay: nothing lands, and
/// the moment's blob is never requested. The boundary unit tests prove the
/// refusal; this proves the pull runs it.
#[test]
fn share_view_pull_refuses_a_moment_from_an_ungranted_version_before_requesting_its_blob() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let granted_body = b"granted lineage body".to_vec();
    let ungranted_body = b"ungranted lineage body".to_vec();
    let granted_sha = dohc_engine_storage::hex_sha256(&granted_body);
    let ungranted_sha = dohc_engine_storage::hex_sha256(&ungranted_body);
    let granted_op = share_view_write_op_on(0, "docs/granted.md", &granted_sha, "version-granted");
    let ungranted_op =
        share_view_write_op_on(1, "docs/ungranted.md", &ungranted_sha, "version-other");
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![granted_op, ungranted_op],
                    next_cursor: 2,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([
            (granted_sha.clone(), granted_body),
            (ungranted_sha, ungranted_body),
        ]),
    );

    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &version_grant(["docs"], "version-granted"),
            &NoFaults,
        )
        .expect("an ungranted lineage is skipped, not fatal");

    assert_eq!(
        *client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls"),
        [granted_sha],
        "a pull that does not carry the pinned version downloads the ungranted lineage's blob"
    );
    assert_eq!(
        (outcome.fetched, outcome.applied, outcome.skipped),
        (2, 1, 1),
        "the granted version's moment applies and the other lineage is counted as skipped"
    );
    assert_eq!(
        outcome
            .changed_paths
            .iter()
            .map(|changed| changed.path.as_str())
            .collect::<Vec<_>>(),
        ["docs/granted.md"],
        "the ungranted lineage's moment is replayed into the local view"
    );
    assert_eq!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", "docs/ungranted.md")
            .expect("share-view path read is answerable"),
        None,
        "the ungranted lineage lands in the recipient's shared view"
    );
}

/// The secret-path refusal itself is proven at the enforcement function by
/// `share_view_and_shared_channel_fail_closed_outside_boundary`. What this
/// proves is the wiring: `pull_share_view` turns that refusal into a skip
/// before replay, so a misbehaving relay never gets the blob requested and no
/// secret plaintext lands.
#[test]
fn share_view_pull_skips_a_secret_path_write_before_requesting_its_blob() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let tracked = b"tracked body".to_vec();
    let secret = b"AWS_SECRET_ACCESS_KEY=hunter2".to_vec();
    let tracked_sha = dohc_engine_storage::hex_sha256(&tracked);
    let secret_sha = dohc_engine_storage::hex_sha256(&secret);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![
                        share_view_write_op(0, "docs/a.md", &tracked_sha),
                        share_view_write_op(1, "app/.env", &secret_sha),
                    ],
                    next_cursor: 2,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(tracked_sha.clone(), tracked), (secret_sha, secret)]),
    );

    // Both paths sit inside the grant, so only the secret classification can
    // refuse `app/.env`.
    let result = client.pull_share_view(
        &mut engine,
        "ws",
        "share",
        &tracked_grant(["docs", "app"]),
        &NoFaults,
    );

    // Nothing landed. Two independent floors say so — the boundary refusal
    // here, and `write_text`'s storable-path floor in `store.rs` — so this
    // fires only when both regress.
    assert_eq!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", "app/.env")
            .expect("secret path read is answerable"),
        None,
        "losing the boundary refusal AND store.rs's storable floor lands secret plaintext on the read surface"
    );
    // And the blob was never even asked for. Replay downloads it before the
    // storable floor refuses the path, so a swallowed refusal discloses the
    // secret bytes to the client even though nothing lands. Asserted before
    // the outcome so this disclosure, not the later error, is what fails.
    assert_eq!(
        *client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls"),
        [tracked_sha],
        "continuing into replay after the boundary refusal downloads the secret blob"
    );
    let outcome = result.expect("a secret op is skipped, not fatal");
    assert_eq!(
        (outcome.fetched, outcome.applied, outcome.skipped),
        (2, 1, 1),
        "the tracked op applies and the secret one is counted as skipped"
    );
    assert_eq!(
        outcome
            .changed_paths
            .iter()
            .map(|changed| changed.path.as_str())
            .collect::<Vec<_>>(),
        ["docs/a.md"]
    );
}

/// A path grant that follows the workspace's main version — what a recipient
/// pins for every share except a version share.
fn tracked_grant<'a>(paths: impl IntoIterator<Item = &'a str>) -> ShareGrant {
    ShareGrant {
        paths: paths.into_iter().map(str::to_owned).collect(),
        version_id: None,
        access: ShareAccess::View,
    }
}

/// A version grant. NO paths selects every tracked path here — and only here,
/// because the relay serves nothing through a selector with neither dimension.
fn version_grant<'a>(paths: impl IntoIterator<Item = &'a str>, version_id: &str) -> ShareGrant {
    ShareGrant {
        paths: paths.into_iter().map(str::to_owned).collect(),
        version_id: Some(version_id.to_owned()),
        access: ShareAccess::View,
    }
}

fn share_view_pull_changed(outcome: &ShareViewPullOutcome) -> Vec<&str> {
    outcome
        .changed_paths
        .iter()
        .map(|changed| changed.path.as_str())
        .collect()
}

/// The relay picks the page; the recipient re-checks it against the selector
/// the relay itself stated first. A compromised or buggy relay can address an
/// ordinary tracked path outside the granted share — no secret floor and no
/// storable floor stops that one, so the pinned scope is the only gate. It
/// must skip the op before replay, so the ungranted blob is never even
/// requested.
#[test]
fn share_view_pull_skips_a_tracked_path_outside_the_recorded_grant_before_requesting_its_blob() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let granted_body = b"the granted doc".to_vec();
    let ungranted_body = b"salary review: everyone".to_vec();
    let sibling_body = b"a sibling of the granted folder".to_vec();
    let granted_sha = dohc_engine_storage::hex_sha256(&granted_body);
    let ungranted_sha = dohc_engine_storage::hex_sha256(&ungranted_body);
    let sibling_sha = dohc_engine_storage::hex_sha256(&sibling_body);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![
                        share_view_write_op(0, "docs/a.md", &granted_sha),
                        share_view_write_op(1, "private/hr.md", &ungranted_sha),
                        // "docs-private" only SHARES a prefix with "docs" —
                        // it is not beneath it.
                        share_view_write_op(2, "docs-private/leak.md", &sibling_sha),
                    ],
                    next_cursor: 3,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([
            (granted_sha.clone(), granted_body),
            (ungranted_sha, ungranted_body),
            (sibling_sha, sibling_body),
        ]),
    );

    let granted = tracked_grant(["docs"]);
    let result = client.pull_share_view(&mut engine, "ws", "share", &granted, &NoFaults);

    // The disclosure comes first in the causal chain: replay downloads the
    // blob before anything downstream looks at the path, so an inert scope
    // check hands the recipient bytes the granter never shared with them —
    // whether or not the write then lands.
    assert_eq!(
        *client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls"),
        [granted_sha],
        "passing None (or dropping the containment) downloads blobs the share never granted"
    );
    let text = VersionedTextStore::new(&mut engine);
    assert_eq!(
        text.read_text("ws", "main", "private/hr.md")
            .expect("an ungranted tracked path read is answerable"),
        None,
        "an ungranted ordinary path has no second floor — it lands"
    );
    assert_eq!(
        text.read_text("ws", "main", "docs-private/leak.md")
            .expect("a sibling-prefix read is answerable"),
        None,
        "matching the grant by bare string prefix admits a sibling folder"
    );
    let outcome = result.expect("an out-of-scope op is skipped, not fatal");
    assert_eq!(
        (outcome.fetched, outcome.applied, outcome.skipped),
        (3, 1, 2),
        "the in-scope op applies and both out-of-scope ops are counted as skipped"
    );
    assert_eq!(
        share_view_pull_changed(&outcome),
        ["docs/a.md"],
        "equality-only matching drops a file BENEATH the granted path"
    );
}

/// A selector with no paths and no version selects NOTHING. The relay refuses
/// to create one (`validateShareSelector` -> `empty_selector`) and serves
/// nothing through one that exists anyway, so the mirror must admit nothing —
/// reading it as "the whole workspace" would turn the selector the relay is
/// emptiest about into the widest grant the recipient holds.
#[test]
fn share_view_pull_admits_nothing_under_a_grant_that_selects_nothing() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let body = b"pulled under a grant that selects nothing".to_vec();
    let sha = dohc_engine_storage::hex_sha256(&body);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![share_view_write_op(0, "docs/a.md", &sha)],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(sha.clone(), body)]),
    );

    let outcome = client
        .pull_share_view(&mut engine, "ws", "share", &tracked_grant([]), &NoFaults)
        .expect("an out-of-scope op is skipped, not fatal");

    assert_eq!(
        (outcome.applied, outcome.skipped),
        (0, 1),
        "reading no paths as 'the whole workspace' admits every path the relay would serve none of"
    );
    assert!(
        client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls")
            .is_empty(),
        "the op's blob is downloaded before the empty grant refuses it"
    );
    assert_eq!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", "docs/a.md")
            .expect("a tracked read is answerable"),
        None,
        "an op admitted by an empty grant lands on the read surface"
    );
}

/// A grant is a SET of paths (the relay allows up to 100), and each one
/// selects itself and its children independently.
#[test]
fn share_view_pull_enforces_every_path_of_a_multi_path_grant() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let bodies = ["docs body", "projects body", "private body"];
    let shas = bodies
        .iter()
        .map(|body| dohc_engine_storage::hex_sha256(body.as_bytes()))
        .collect::<Vec<_>>();
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![
                        share_view_write_op(0, "docs/a.md", &shas[0]),
                        share_view_write_op(1, "projects/b.md", &shas[1]),
                        share_view_write_op(2, "private/c.md", &shas[2]),
                    ],
                    next_cursor: 3,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs(
            shas.iter()
                .zip(bodies)
                .map(|(sha, body)| (sha.clone(), body.as_bytes().to_vec())),
        ),
    );

    let granted = tracked_grant(["docs", "projects"]);
    let outcome = client
        .pull_share_view(&mut engine, "ws", "share", &granted, &NoFaults)
        .expect("a multi-path grant pulls");

    assert_eq!(
        share_view_pull_changed(&outcome),
        ["docs/a.md", "projects/b.md"],
        "matching only the first granted path drops the second"
    );
    assert_eq!((outcome.applied, outcome.skipped), (2, 1));
    assert_eq!(
        *client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls"),
        shas[..2],
        "the ungranted path's blob is downloaded before the scope is checked"
    );
}
fn share_view_version_create_op(
    seq: i64,
    version_id: &str,
    path: &str,
    sha: &str,
) -> ShareReplicationEnvelope {
    ShareReplicationEnvelope {
        origin_id: "peer".to_owned(),
        origin_seq: seq,
        op_kind: "version.create".to_owned(),
        payload: json!({
            "versionId": version_id,
            "forkSnapshots": [{ "path": path, "blobSha256": sha, "contentKind": "text" }]
        }),
        recorded_at_ms: 10 + seq,
    }
}

/// A path share follows main and is never entitled to a `version.create` —
/// the relay refuses to serve one (`shareFilter.ts`: `selector.versionId ===
/// null` is `allowed: false`), so a recipient that replays one is trusting a
/// relay that just broke its own rule. The snapshot path here is inside the
/// granted paths, so only the version rule can refuse it.
#[test]
fn share_view_pull_refuses_a_version_create_to_a_share_that_granted_only_paths() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let body = b"forked into a path share".to_vec();
    let sha = dohc_engine_storage::hex_sha256(&body);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![share_view_version_create_op(0, "v1", "docs/a.md", &sha)],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(sha, body)]),
    );

    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .expect("an unentitled version.create is skipped, not fatal");

    assert_eq!(
        (outcome.applied, outcome.skipped),
        (0, 1),
        "an unconstrained version reading as 'any version' replays a fork the share never granted"
    );
    assert!(
        client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls")
            .is_empty(),
        "the fork's blob is downloaded before the version is checked"
    );
}

fn share_view_binary_write_op(seq: i64, path: &str, sha256: &str) -> ShareReplicationEnvelope {
    ShareReplicationEnvelope {
        origin_id: "peer".to_owned(),
        origin_seq: seq,
        op_kind: "moment.append".to_owned(),
        payload: json!({
            // The version the grant below follows. A served moment names its
            // version, and the boundary refuses one that does not — without
            // this the op is skipped there and the ceiling under test is
            // never reached.
            "versionId": "main",
            "operation": "write",
            "path": path,
            "payloadAfterPath": path,
            "payloadAfterBlobSha256": sha256,
            "payloadAfterContentKind": "binary"
        }),
        recorded_at_ms: 10 + seq,
    }
}

#[test]
fn a_refused_shared_blob_does_not_freeze_the_share() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let (constraint, limit_bytes) = blob_ceiling(BlobKind::Binary);

    let over_cap = vec![9u8; limit_bytes + 1];
    let over_cap_sha = dohc_engine_storage::hex_sha256(&over_cap);
    let later = b"the update behind the refused one".to_vec();
    let later_sha = dohc_engine_storage::hex_sha256(&later);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![
                        share_view_binary_write_op(0, "docs/over-cap.bin", &over_cap_sha),
                        share_view_write_op(1, "docs/later.md", &later_sha),
                    ],
                    next_cursor: 2,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(over_cap_sha.clone(), over_cap), (later_sha, later)]),
    );

    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .expect("one refused blob aborts the pull and freezes the share");
    assert_eq!(
        (outcome.fetched, outcome.applied, outcome.skipped),
        (2, 1, 1)
    );
    // The cursor advances past the refused op. Without this the same page is
    // fetched forever and nothing later in this share can ever arrive.
    assert_eq!(
        outcome.pending_cursor.cursor, 2,
        "the cursor stalls on the refused op and the share never moves"
    );
    assert_eq!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", "docs/later.md")
            .expect("share-view path read is answerable")
            .map(|snapshot| snapshot.text),
        Some("the update behind the refused one".to_owned()),
        "the op behind the refused one never arrives"
    );
    assert!(
        !engine
            .has_binary_blob(&over_cap_sha)
            .expect("binary blob presence"),
        "the skipped blob must not persist"
    );
    // Advancing must not make the skip silent. The refusal names the op it
    // dropped and keeps the constraint, the limit, the unit and the observed
    // usage — the recipient is told what it will never receive.
    assert_eq!(
        outcome
            .refusals
            .iter()
            .map(|refusal| (
                refusal.origin_id.as_str(),
                refusal.origin_seq,
                refusal.op_kind.as_str(),
                refusal.code,
                refusal.detail.as_str()
            ))
            .collect::<Vec<_>>(),
        [(
            "peer",
            0,
            "moment.append",
            "share-blob-over-ceiling",
            format!(
                "shared blob exceeds {constraint}: limit {limit_bytes} bytes, observed {} bytes — docs/over-cap.bin",
                limit_bytes + 1
            )
            .as_str()
        )],
        "the skip is counted but the reason never reaches the recipient"
    );
}

/// The other half of the disposition, and the one that keeps a frozen share
/// from being traded for silently dropped data.
///
/// A body that does not hash to the sha its op named is the RELAY's copy being
/// wrong, not the op. Repair the blob and this same op applies — so the pull
/// stops rather than committing past content that is still coming. This is
/// `BlobMissing`'s claim in a different tense, and it gets `BlobMissing`'s
/// answer.
///
#[test]
fn a_repairable_blob_integrity_failure_stops_the_pull_instead_of_skipping() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");

    let claimed = b"what the op says the blob is".to_vec();
    let claimed_sha = dohc_engine_storage::hex_sha256(&claimed);
    let served = b"what the relay actually served".to_vec();
    assert_ne!(
        dohc_engine_storage::hex_sha256(&served),
        claimed_sha,
        "the fixture only tests integrity if the served body hashes differently"
    );
    let later = b"the update behind the corrupt one".to_vec();
    let later_sha = dohc_engine_storage::hex_sha256(&later);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![
                        share_view_write_op(0, "docs/corrupt.md", &claimed_sha),
                        share_view_write_op(1, "docs/later.md", &later_sha),
                    ],
                    next_cursor: 2,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(claimed_sha, served), (later_sha, later)]),
    );

    assert_eq!(
        client
            .pull_share_view(
                &mut engine,
                "ws",
                "share",
                &tracked_grant(["docs"]),
                &NoFaults
            )
            .expect_err("a repairable integrity failure is skipped and lost"),
        RelayError::BlobInvalid
    );
    // No cursor is returned at all, so nothing can commit past the refused op
    // and the retry after a repair re-fetches it. That is the reverse path.
    assert_eq!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", "docs/corrupt.md")
            .expect("share-view path read is answerable")
            .map(|snapshot| snapshot.text),
        None,
        "a body that fails its integrity check must not land"
    );
}

/// The skip unit must be the refusal unit.
///
/// A `version.create` carries one blob per fork snapshot. Refusing one of them
/// says nothing about the others, but skipping the whole OP dropped every
/// snapshot behind the refused one — permanently, because the cursor commits
/// past the op either way. One oversized file silently cost its siblings.
///
/// The invariant: after a refused blob, the remaining blobs in that op are all
/// applied. Never a prefix. So the refused file is second of three here — a
/// per-op skip keeps the first and loses the third, which is exactly the shape
/// a first-only or last-only fixture cannot see.
///
#[test]
fn one_refused_snapshot_does_not_drop_the_rest_of_a_shared_version() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let (constraint, limit_bytes) = blob_ceiling(BlobKind::Binary);

    let first = b"first snapshot".to_vec();
    let over_cap = vec![4u8; limit_bytes + 1];
    let third = b"third snapshot".to_vec();
    let first_sha = dohc_engine_storage::hex_sha256(&first);
    let over_cap_sha = dohc_engine_storage::hex_sha256(&over_cap);
    let third_sha = dohc_engine_storage::hex_sha256(&third);
    let op = ShareReplicationEnvelope {
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        op_kind: "version.create".to_owned(),
        payload: json!({
            "versionId": "shared-version",
            "forkSnapshots": [
                { "path": "docs/first.md", "blobSha256": first_sha, "contentKind": "text" },
                {
                    "path": "docs/over-cap.bin",
                    "blobSha256": over_cap_sha,
                    "contentKind": "binary"
                },
                { "path": "docs/third.md", "blobSha256": third_sha, "contentKind": "text" },
            ]
        }),
        recorded_at_ms: 10,
    };
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![op],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([
            (first_sha, first),
            (over_cap_sha.clone(), over_cap),
            (third_sha, third),
        ]),
    );

    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &version_grant(["docs"], "shared-version"),
            &NoFaults,
        )
        .expect("one refused snapshot does not fail the page");
    assert_eq!(
        (outcome.fetched, outcome.applied, outcome.skipped),
        (1, 2, 1),
        "two snapshots applied and exactly the refused one is counted skipped"
    );
    let text = VersionedTextStore::new(&mut engine);
    // Both survivors, asserted apart. The one after the refusal is the whole
    // point: a per-op skip keeps the first and silently loses this one.
    assert_eq!(
        text.read_text("ws", "main", "docs/first.md")
            .expect("share-view path read is answerable")
            .map(|snapshot| snapshot.text),
        Some("first snapshot".to_owned()),
        "the snapshot before the refused one must land"
    );
    assert_eq!(
        text.read_text("ws", "main", "docs/third.md")
            .expect("share-view path read is answerable")
            .map(|snapshot| snapshot.text),
        Some("third snapshot".to_owned()),
        "refusing per op drops every snapshot behind the refused one"
    );
    assert!(
        !engine
            .has_binary_blob(&over_cap_sha)
            .expect("binary blob presence"),
        "the refused snapshot itself must not persist"
    );
    // One refusal, naming the blob that was actually dropped — not one refusal
    // standing in for however many files went with it.
    assert_eq!(
        outcome
            .refusals
            .iter()
            .map(|refusal| (
                refusal.op_kind.as_str(),
                refusal.code,
                refusal.detail.as_str()
            ))
            .collect::<Vec<_>>(),
        [(
            "version.create",
            "share-blob-over-ceiling",
            format!(
                "shared blob exceeds {constraint}: limit {limit_bytes} bytes, observed {} bytes — docs/over-cap.bin",
                limit_bytes + 1
            )
            .as_str()
        )]
    );
}

/// A received rename preserves the old path when its replacement is refused.
/// Skipping per blob must not let the delete run alone: the old path would go
/// while its replacement never arrived, which loses the file outright — worse
/// than not renaming it and worse than the freeze this change removes.
///
#[test]
fn a_rename_whose_replacement_is_refused_keeps_the_old_path() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let (_constraint, limit_bytes) = blob_ceiling(BlobKind::Binary);

    let original = b"the file that already exists".to_vec();
    let original_sha = dohc_engine_storage::hex_sha256(&original);
    let over_cap = vec![5u8; limit_bytes + 1];
    let over_cap_sha = dohc_engine_storage::hex_sha256(&over_cap);
    let mut rename = share_view_binary_write_op(1, "docs/new.bin", &over_cap_sha);
    rename.payload["operation"] = json!("rename");
    rename.payload["payloadBeforePath"] = json!("docs/old.md");
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![share_view_write_op(0, "docs/old.md", &original_sha), rename],
                    next_cursor: 2,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(original_sha, original), (over_cap_sha, over_cap)]),
    );

    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .expect("a refused replacement does not fail the page");
    assert_eq!(
        (outcome.fetched, outcome.applied, outcome.skipped),
        (2, 1, 1)
    );
    let text = VersionedTextStore::new(&mut engine);
    assert_eq!(
        text.read_text("ws", "main", "docs/old.md")
            .expect("share-view path read is answerable")
            .map(|snapshot| snapshot.text),
        Some("the file that already exists".to_owned()),
        "the rename's delete ran after its write was refused, losing the file"
    );
    assert_eq!(
        text.read_text("ws", "main", "docs/new.bin")
            .expect("share-view path read is answerable")
            .map(|snapshot| snapshot.text),
        None,
        "the refused replacement must not land either"
    );
}

#[test]
fn two_refused_snapshots_are_recorded_as_one_op_naming_both() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let (constraint, limit_bytes) = blob_ceiling(BlobKind::Binary);

    let kept = b"the snapshot that survives".to_vec();
    let kept_sha = dohc_engine_storage::hex_sha256(&kept);
    let first_over = vec![1u8; limit_bytes + 1];
    let second_over = vec![2u8; limit_bytes + 2];
    let first_sha = dohc_engine_storage::hex_sha256(&first_over);
    let second_sha = dohc_engine_storage::hex_sha256(&second_over);
    let op = ShareReplicationEnvelope {
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        op_kind: "version.create".to_owned(),
        payload: json!({
            "versionId": "shared-version",
            "forkSnapshots": [
                { "path": "docs/first.bin", "blobSha256": first_sha, "contentKind": "binary" },
                { "path": "docs/kept.md", "blobSha256": kept_sha, "contentKind": "text" },
                { "path": "docs/second.bin", "blobSha256": second_sha, "contentKind": "binary" },
            ]
        }),
        recorded_at_ms: 10,
    };
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![op],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([
            (first_sha, first_over),
            (kept_sha, kept),
            (second_sha, second_over),
        ]),
    );

    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &version_grant(["docs"], "shared-version"),
            &NoFaults,
        )
        .expect("two refused snapshots do not fail the page");
    // Two blobs lost, so `skipped` counts two — the tally is per blob because
    // two files really are missing.
    assert_eq!(
        (outcome.fetched, outcome.applied, outcome.skipped),
        (1, 1, 2)
    );
    // One durable record, because the recipient can hold only one per
    // coordinate. Emitting two would silently become one.
    assert_eq!(
        outcome.refusals.len(),
        1,
        "a second refusal shares this op's coordinate and the recipient drops it"
    );
    let refusal = &outcome.refusals[0];
    assert_eq!(
        (refusal.origin_id.as_str(), refusal.origin_seq, refusal.code),
        ("peer", 0, "share-blob-over-ceiling")
    );
    // The count leads, then every lost file's measurements with its name. A
    // reader must be able to see that two files are missing and which. Each
    // entry puts its reason before its path for the same reason the count
    // leads: the detail is bounded, and truncation must cost a path tail.
    assert_eq!(
        refusal.detail,
        format!(
            "2 files in this operation were not applied: \
             shared blob exceeds {constraint}: \
             limit {limit_bytes} bytes, observed {} bytes — docs/first.bin; \
             shared blob exceeds {constraint}: \
             limit {limit_bytes} bytes, observed {} bytes — docs/second.bin",
            limit_bytes + 1,
            limit_bytes + 2
        ),
        "the record names one file, or loses the count, or loses a measurement"
    );
    assert_eq!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", "docs/kept.md")
            .expect("share-view path read is answerable")
            .map(|snapshot| snapshot.text),
        Some("the snapshot that survives".to_owned()),
        "the healthy snapshot between two refused ones still lands"
    );
}

#[test]
fn an_op_refusing_two_classes_at_once_claims_neither_instruction() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let (_constraint, limit_bytes) = blob_ceiling(BlobKind::Binary);

    let over_cap = vec![7u8; limit_bytes + 1];
    let over_cap_sha = dohc_engine_storage::hex_sha256(&over_cap);
    let op = ShareReplicationEnvelope {
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        op_kind: "version.create".to_owned(),
        payload: json!({
            "versionId": "shared-version",
            "forkSnapshots": [
                // Oversized: the granter can act.
                { "path": "docs/over-cap.bin", "blobSha256": over_cap_sha, "contentKind": "binary" },
                // Unusable reference: nobody can.
                { "path": "docs/unusable.md", "blobSha256": "not-a-sha256", "contentKind": "text" },
            ]
        }),
        recorded_at_ms: 10,
    };
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![op],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(over_cap_sha, over_cap)]),
    );

    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &version_grant(["docs"], "shared-version"),
            &NoFaults,
        )
        .expect("two refused snapshots do not fail the page");
    assert_eq!(
        (outcome.fetched, outcome.applied, outcome.skipped),
        (1, 0, 2)
    );
    let refusal = &outcome.refusals[0];
    assert_eq!(
        refusal.code, "invalid-input",
        "a mixed op reports an instruction that is false for one of its blobs"
    );
    for path in ["docs/over-cap.bin", "docs/unusable.md"] {
        assert!(
            refusal.detail.contains(path),
            "the record must still name every file it lost: {}",
            refusal.detail
        );
    }
}

#[test]
fn a_record_too_small_for_every_refusal_lists_whole_ones_and_counts_the_rest() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let (_constraint, limit_bytes) = blob_ceiling(BlobKind::Binary);

    // Ten refused snapshots whose paths sit just under the per-path budget,
    // so the detail cannot hold them all and each is worth naming in full.
    let refused_count = 10;
    let bodies: Vec<Vec<u8>> = (0..refused_count)
        .map(|index| vec![u8::try_from(index).expect("small"); limit_bytes + 1 + index])
        .collect();
    let paths: Vec<String> = (0..refused_count)
        .map(|index| format!("docs/{}{index:02}/file.bin", "d".repeat(178)))
        .collect();
    for path in &paths {
        assert!(
            path.encode_utf16().count() <= 200,
            "each path must fit its budget whole, or this tests truncation instead"
        );
    }
    let snapshots: Vec<serde_json::Value> = paths
        .iter()
        .zip(&bodies)
        .map(|(path, body)| {
            json!({
                "path": path,
                "blobSha256": dohc_engine_storage::hex_sha256(body),
                "contentKind": "binary",
            })
        })
        .collect();
    let op = ShareReplicationEnvelope {
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        op_kind: "version.create".to_owned(),
        payload: json!({ "versionId": "shared-version", "forkSnapshots": snapshots }),
        recorded_at_ms: 10,
    };
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![op],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs(
            bodies
                .iter()
                .map(|body| (dohc_engine_storage::hex_sha256(body), body.clone())),
        ),
    );

    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &version_grant(["docs"], "shared-version"),
            &NoFaults,
        )
        .expect("ten refused snapshots do not fail the page");
    assert_eq!(outcome.skipped, refused_count);
    let detail = outcome.refusals[0].detail.clone();
    assert!(
        detail.encode_utf16().count() <= crate::relay::MAX_REFUSAL_DETAIL_UNITS,
        "the detail must stay inside what the recipient can persist"
    );

    let head = format!("{refused_count} files in this operation were not applied: ");
    let body = detail
        .strip_prefix(&head)
        .unwrap_or_else(|| panic!("the count must lead: {detail}"));
    let parts: Vec<&str> = body.split("; ").collect();
    // The fixture is only about overflow if the record could not hold them all.
    assert!(
        parts.len() < refused_count,
        "the detail held every refusal, so this proves nothing about overflow"
    );
    let (entries, tail) = parts.split_at(parts.len() - 1);
    let unlisted: usize = tail[0]
        .strip_prefix("and ")
        .and_then(|rest| rest.strip_suffix(" more"))
        .unwrap_or_else(|| panic!("the record stops mid-entry and counts nothing: {detail}"))
        .parse()
        .expect("the unlisted count is a number");
    assert_eq!(
        entries.len() + unlisted,
        refused_count,
        "the record's own count does not add up to the files it lost"
    );
    // Every entry it did show is whole: its measurements and its full path.
    for (index, entry) in entries.iter().enumerate() {
        assert_eq!(
            *entry,
            format!(
                "shared blob exceeds MAX_CAPTURE_BINARY_FILE_BYTES: limit {limit_bytes} bytes, \
                 observed {} bytes — {}",
                limit_bytes + 1 + index,
                paths[index]
            ),
            "entry {index} is a fragment rather than a whole refusal"
        );
    }
}

/// Two refused files that differ only past the path budget must still read
/// apart.
///
/// A head-only cut made them identical in the record, and the record is all
/// the reader has once the cursor commits. Eliding a healthy path is normal,
/// not pathological: the relay admits a granted path of `MAX_SHARE_PATH_CHARS`
/// (1,024) and the files under it are longer still, while one refusal's share
/// of the detail is 200. So the cut is marked, the file name is kept, and the
/// marker carries how much went — two paths sharing a head and a tail still
/// differ by that count.
///
#[test]
fn two_refused_paths_that_differ_past_the_budget_are_still_told_apart() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let (_constraint, limit_bytes) = blob_ceiling(BlobKind::Binary);

    let prefix = format!("docs/{}", "d".repeat(300));
    let first_path = format!("{prefix}/quarterly-report.bin");
    let second_path = format!("{prefix}/annual-report.bin");
    let first = vec![1u8; limit_bytes + 1];
    let second = vec![2u8; limit_bytes + 2];
    let first_sha = dohc_engine_storage::hex_sha256(&first);
    let second_sha = dohc_engine_storage::hex_sha256(&second);
    let op = ShareReplicationEnvelope {
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        op_kind: "version.create".to_owned(),
        payload: json!({
            "versionId": "shared-version",
            "forkSnapshots": [
                { "path": first_path, "blobSha256": first_sha, "contentKind": "binary" },
                { "path": second_path, "blobSha256": second_sha, "contentKind": "binary" },
            ]
        }),
        recorded_at_ms: 10,
    };
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![op],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(first_sha, first), (second_sha, second)]),
    );

    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &version_grant(["docs"], "shared-version"),
            &NoFaults,
        )
        .expect("two refused snapshots do not fail the page");
    assert_eq!(outcome.skipped, 2);
    let detail = outcome.refusals[0].detail.clone();
    let head = "2 files in this operation were not applied: ";
    let entries: Vec<&str> = detail
        .strip_prefix(head)
        .unwrap_or_else(|| panic!("the count must lead: {detail}"))
        .split("; ")
        .collect();
    assert_eq!(entries.len(), 2, "both refusals must be listed: {detail}");
    assert_ne!(
        entries[0], entries[1],
        "two different missing files are recorded identically"
    );
    // The file name is what the reader needs to act, so it survives the cut.
    assert!(
        detail.contains("quarterly-report.bin") && detail.contains("annual-report.bin"),
        "the cut kept the shared folders and dropped the file names: {detail}"
    );
    assert!(
        detail.encode_utf16().count() <= crate::relay::MAX_REFUSAL_DETAIL_UNITS,
        "the detail must stay inside what the recipient can persist"
    );
}

/// A path the store door will never accept must be skipped, not held.
///
/// `classify_share_path` admits these — no segment is `.`, `..`, or empty —
/// so the boundary passes them to replay, where `write_text` refuses them:
/// `validate_path` rejects `..` anywhere in the path, and
/// `validate_workspace_path` rejects an all-dot or all-space segment. Both
/// arrive as `DomainError::InvalidPath`. Mapped to
/// `RelayError::Local("invalid-path")`, with no refusal code, that would
/// abort the pull: the cursor would never commit, and every op behind the bad
/// path would never arrive.
///
/// The rules are pure over a path fixed in the served op, so asking again
/// returns the same refusal forever: permanent, therefore skipped, and the
/// cursor commits past it.
///
#[test]
fn a_permanently_invalid_share_path_is_skipped_instead_of_freezing_the_share() {
    for (bad_path, reason) in [
        ("docs/a..b.md", "path must not contain traversal segments"),
        (
            "docs/   /inner.md",
            "path is not eligible for plaintext storage",
        ),
        (
            "docs/.../inner.md",
            "path is not eligible for plaintext storage",
        ),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        seed_replication_version(&mut engine, "main", "main");
        assert_eq!(
            classify_share_path(bad_path),
            PathClass::Tracked,
            "the fixture only tests the store door if the boundary admits {bad_path}"
        );

        let refused = b"the body of the unusable path".to_vec();
        let refused_sha = dohc_engine_storage::hex_sha256(&refused);
        let later = b"the update behind the unusable path".to_vec();
        let later_sha = dohc_engine_storage::hex_sha256(&later);
        let client = RelaySyncClient::new(
            PagedShareRelay::new(
                [],
                [(
                    0,
                    ShareViewResponse {
                        work_references: Vec::new(),
                        next_reference_after: None,
                        reference_has_more: false,
                        ops: vec![
                            share_view_write_op(0, bad_path, &refused_sha),
                            share_view_write_op(1, "docs/later.md", &later_sha),
                        ],
                        next_cursor: 2,
                        has_more: false,
                    },
                )],
            )
            .with_view_blobs([(refused_sha, refused), (later_sha.clone(), later)]),
        );

        let outcome = client
            .pull_share_view(
                &mut engine,
                "ws",
                "share",
                &tracked_grant(["docs"]),
                &NoFaults,
            )
            .unwrap_or_else(|error| panic!("{bad_path} freezes the share forever: {error}"));
        assert_eq!(
            (
                outcome.fetched,
                outcome.applied,
                outcome.skipped,
                outcome.pending_cursor.cursor
            ),
            (2, 1, 1, 2),
            "the cursor must commit past {bad_path}"
        );
        assert_eq!(
            VersionedTextStore::new(&mut engine)
                .read_text("ws", "main", "docs/later.md")
                .expect("share-view path read is answerable")
                .map(|snapshot| snapshot.text),
            Some("the update behind the unusable path".to_owned()),
            "the op behind {bad_path} never arrives"
        );
        // The blob was never requested. The store door's rules are pure over
        // the path, so the refusal needs no bytes to reach — and asked after
        // the fetch instead, every row naming an unusable path downloaded and
        // hashed a body up to the kind ceiling to learn what the path already
        // said.
        assert_eq!(
            *client
                .transport()
                .share_blob_calls
                .lock()
                .expect("share blob calls"),
            [later_sha],
            "move the path check back below `share_blob` and the \
             refused path fetches its blob first"
        );
        // The refusal NAMES the constraint and the file it cost, because the
        // record is all the reader has once the cursor commits.
        assert_eq!(
            outcome
                .refusals
                .iter()
                .map(|refusal| (refusal.origin_seq, refusal.code, refusal.detail.as_str()))
                .collect::<Vec<_>>(),
            [(
                0,
                "invalid-input",
                format!("share op is not replayable: {reason} — {bad_path}").as_str()
            )],
            "the skip is counted but the reason never reaches the recipient"
        );
    }
}

// The recipient's half of "chat follows the share". The relay
// decides what to serve; this boundary decides what to place, against the
// selector the recipient pinned. Every case drives the real
// `apply_shared_envelope`, because a test that faked the resolving would
// prove nothing about the boundary.
//
// The world each case builds: `shared/docs/in.md` is inside the grant and
// `private/out.md` is not, both as real file objects with real path aliases.
fn share_view_chat_fixture() -> (ScratchDir, std::path::PathBuf, EngineStore, ShareBoundary) {
    let (scratch, path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    seed_text_head(&mut engine, "object-in", "shared/docs/in.md", "inside");
    seed_text_head(&mut engine, "object-out", "private/out.md", "outside");
    let boundary = ShareBoundary {
        share_id: "share-view".to_owned(),
        surface: ShareSurface::ShareView,
        channel_wire_id: None,
        granted: Some(ShareGrant {
            paths: vec!["shared/docs".to_owned()],
            version_id: None,
            access: crate::ShareAccess::Comment,
        }),
    };
    (scratch, path, engine, boundary)
}

fn thread_create(seq: i64, thread_id: &str, extra: serde_json::Value) -> ReplicationEnvelope {
    let mut payload = json!({
        "threadId": thread_id,
        "title": "About the shared file",
        "createdAtMs": 100,
        "linkedAtMs": 101,
    });
    let object = payload.as_object_mut().expect("object");
    for (key, value) in extra.as_object().expect("extra object") {
        object.insert(key.clone(), value.clone());
    }
    envelope("granter", seq, "chat.thread.create", payload)
}

fn thread_message(seq: i64, thread_id: &str, message_id: &str) -> ReplicationEnvelope {
    envelope(
        "granter",
        seq,
        "chat.message.append",
        json!({
            "messageId": message_id,
            "threadId": thread_id,
            "authorKind": "human",
            "authorDisplayName": "Granter",
            "authorUserId": "granter-user",
            "body": "hello",
            "createdAtMs": 200,
        }),
    )
}

fn thread_row_path(engine: &EngineStore, thread_id: &str) -> Option<String> {
    engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT a.path FROM chat_threads t \
                 JOIN path_aliases a \
                   ON a.workspace_id = t.workspace_id AND a.object_id = t.linked_object_id \
                 WHERE t.workspace_id = 'ws' AND t.thread_id = ?1 AND a.version_id = 'main'",
                params![thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(SyncError::corrupt)
        })
        .expect("thread path")
}

#[test]
fn share_view_applies_chat_about_an_in_grant_file_and_binds_it_locally() {
    let (_scratch, _path, mut engine, boundary) = share_view_chat_fixture();
    // The relay serves `linkedPath`, never the granter's object id: this store
    // minted its own, and the path is the only name both sides can read.
    let create = thread_create(0, "thread-in", json!({ "linkedPath": "shared/docs/in.md" }));
    apply_shared_envelope(&mut engine, &boundary, &create, &NoFaults).expect("create applies");
    assert_eq!(
        thread_row_path(&engine, "thread-in").as_deref(),
        Some("shared/docs/in.md"),
        "the served path must bind to THIS store's object for that path",
    );

    let message = thread_message(1, "thread-in", "m-1");
    apply_shared_envelope(&mut engine, &boundary, &message, &NoFaults).expect("message applies");
    let body: Option<String> = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT body FROM chat_messages WHERE workspace_id='ws' AND message_id='m-1'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(SyncError::corrupt)
        })
        .expect("message read");
    assert_eq!(body.as_deref(), Some("hello"));
}

#[test]
fn share_view_refuses_a_thread_create_carrying_a_shape_a_share_never_carries() {
    // `linkedObjectId` and `linkedPathHint` are the granter's own fields. A
    // relay offering one is offering something this boundary must not place —
    // malformed, not out of scope, because no grant admits it and widening the
    // share changes nothing.
    for extra in [
        json!({ "linkedObjectId": "object-in" }),
        json!({ "linkedPath": "shared/docs/in.md", "linkedObjectId": "object-in" }),
        json!({ "linkedPath": "shared/docs/in.md", "linkedPathHint": "shared/docs/in.md" }),
    ] {
        let (_scratch, _path, mut engine, boundary) = share_view_chat_fixture();
        let create = thread_create(0, "thread-in", extra.clone());
        assert!(
            matches!(
                apply_shared_envelope(&mut engine, &boundary, &create, &NoFaults),
                Err(SyncError::InvalidInput { .. })
            ),
            "{extra} must be refused outright",
        );
        assert_eq!(thread_row_path(&engine, "thread-in"), None);
    }
}

#[test]
fn share_view_refuses_a_thread_about_a_file_outside_the_grant() {
    let (_scratch, _path, mut engine, boundary) = share_view_chat_fixture();
    let create = thread_create(0, "thread-out", json!({ "linkedPath": "private/out.md" }));
    assert!(matches!(
        apply_shared_envelope(&mut engine, &boundary, &create, &NoFaults),
        Err(SyncError::ShareBoundaryViolation)
    ));
    // And a path this surface never replays at all.
    let secret = thread_create(
        0,
        "thread-secret",
        json!({ "linkedPath": "shared/docs/.env" }),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &boundary, &secret, &NoFaults),
        Err(SyncError::ShareBoundaryViolation)
    ));
    // A create naming a path inside the grant that this store does not track
    // is refused at apply, not at the boundary: the grant covers it, and the
    // file simply has not arrived. It lands in the refusal lane rather than as
    // an error, which is what makes the skip visible instead of silent.
    let absent = thread_create(
        0,
        "thread-absent",
        json!({ "linkedPath": "shared/docs/gone.md" }),
    );
    let outcome = apply_shared_envelope(&mut engine, &boundary, &absent, &NoFaults)
        .expect("a missing file is a refusal, not a failed pull");
    let refusal = match outcome {
        ApplyOutcome {
            primary: ApplyDisposition::Refused(refusal),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() => refusal,
        other => panic!("expected a recorded refusal, got {other:?}"),
    };
    assert_eq!(refusal.op_kind, "chat.thread.create");
    assert!(
        refusal
            .reason
            .message()
            .contains("names no file in this workspace"),
        "the refusal must say which constraint the op hit, got {:?}",
        refusal.reason,
    );
    assert_eq!(thread_row_path(&engine, "thread-absent"), None);
}

#[test]
fn share_view_refuses_a_thread_scoped_op_whose_thread_is_unknown_or_out_of_grant() {
    let (_scratch, _path, mut engine, boundary) = share_view_chat_fixture();
    // Unknown locally: the four thread-scoped kinds carry no file of their
    // own, so an unresolved thread is the boundary's answer, not a guess.
    assert!(matches!(
        apply_shared_envelope(
            &mut engine,
            &boundary,
            &thread_message(0, "thread-nowhere", "m"),
            &NoFaults
        ),
        Err(SyncError::ShareBoundaryViolation)
    ));

    // Known locally, but bound to a file outside the grant. The thread row is
    // planted directly, because the boundary would never have placed it.
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO chat_threads \
                 (workspace_id,thread_id,title,created_at_ms,updated_at_ms,linked_object_id,linked_path_hint,linked_at_ms,channel_id) \
                 VALUES ('ws','thread-out','Outside',1,1,'object-out',NULL,1,NULL)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("plant thread");
    for (index, kind, payload) in [
        (
            0_i64,
            "chat.message.append",
            json!({"messageId":"m","threadId":"thread-out","authorKind":"human","authorDisplayName":"G","body":"x","createdAtMs":1}),
        ),
        (
            0,
            "chat.reaction.set",
            json!({"reactionId":"r","messageId":"m","threadId":"thread-out","emoji":"👍","authorId":"u","authorKind":"human","authorDisplayName":"U","state":"added","atMs":1}),
        ),
        (
            0,
            "chat.decision.set",
            json!({"threadId":"thread-out","messageId":"m","state":"open","atMs":1}),
        ),
        (
            0,
            "chat.attachment.add",
            json!({"attachmentId":"a","threadId":"thread-out","messageId":"m","targetKind":"file","createdAtMs":1}),
        ),
    ] {
        assert!(
            matches!(
                apply_shared_envelope(
                    &mut engine,
                    &boundary,
                    &envelope("granter", index, kind, payload),
                    &NoFaults
                ),
                Err(SyncError::ShareBoundaryViolation)
            ),
            "{kind} on an out-of-grant thread must be refused",
        );
    }
}

#[test]
fn share_view_never_carries_the_readers_own_state_or_any_other_chat_kind() {
    let (_scratch, _path, mut engine, boundary) = share_view_chat_fixture();
    for (kind, payload) in [
        (
            "chat.follow.set",
            json!({"ownerUserId":"u","targetKind":"thread","targetId":"thread-in","state":"following","atMs":1}),
        ),
        (
            "chat.feed.read.set",
            json!({"ownerUserId":"u","lastSeenCreatedAtMs":1,"lastSeenMessageId":"m","atMs":1}),
        ),
        (
            "chat.thread.read.set",
            json!({"accountUserId":"u","threadId":"thread-in","lastReadCreatedAtMs":1,"lastReadMessageId":"m","atMs":1}),
        ),
        (
            "chat.channel.create",
            json!({"channelId":"c","name":"General","slug":"general","kind":"channel","createdAtMs":1,"wireId":"wire"}),
        ),
    ] {
        assert!(
            matches!(
                apply_shared_envelope(
                    &mut engine,
                    &boundary,
                    &envelope("granter", 0, kind, payload),
                    &NoFaults
                ),
                Err(SyncError::ShareBoundaryViolation)
            ),
            "{kind} must never cross a file share",
        );
    }
}

/// Addendum B: the granter's own lane applying a RECIPIENT's create. The op
/// arrives naming the file by path, and the granter binds it to its object for
/// that path — the mirror image of what the recipient does with the granter's
/// threads, through the one apply rule both sides share.
#[test]
fn a_recipient_thread_create_binds_to_the_granters_own_object_on_the_owner_lane() {
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    seed_text_head(&mut engine, "granter-object", "shared/docs/in.md", "inside");
    let operation = envelope(
        "relay:share-member:recipient",
        0,
        "chat.thread.create",
        json!({
            "threadId": "thread-from-recipient",
            "title": "A question",
            "createdAtMs": 1,
            "linkedAtMs": 1,
            "linkedPath": "shared/docs/in.md",
        }),
    );
    apply_chat_envelope(&mut engine, &operation, &NoFaults).expect("recipient thread applies");
    let bound: Option<(String, Option<String>)> = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT linked_object_id, linked_path_hint FROM chat_threads \
                 WHERE workspace_id='ws' AND thread_id='thread-from-recipient'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(SyncError::corrupt)
        })
        .expect("thread row");
    assert_eq!(
        bound,
        Some((
            "granter-object".to_owned(),
            Some("shared/docs/in.md".to_owned())
        )),
        "the granter must resolve the path to its own object, never store the path as an id",
    );
}

#[test]
fn share_view_chat_composes_paths_with_a_version() {
    for (label, version_id, expect_chat) in [
        ("paths only", None, true),
        ("paths AND a version", Some("v1"), true),
        ("version only", Some("v1"), false),
    ] {
        let (_scratch, _path, mut engine, _default) = share_view_chat_fixture();
        let paths = if label == "version only" {
            Vec::new()
        } else {
            vec!["shared/docs".to_owned()]
        };
        let boundary = ShareBoundary {
            share_id: "share-compose".to_owned(),
            surface: ShareSurface::ShareView,
            channel_wire_id: None,
            granted: Some(ShareGrant {
                paths,
                version_id: version_id.map(str::to_owned),
                access: crate::ShareAccess::Comment,
            }),
        };
        let create = thread_create(
            0,
            "thread-compose",
            json!({ "linkedPath": "shared/docs/in.md" }),
        );
        let applied = apply_shared_envelope(&mut engine, &boundary, &create, &NoFaults).is_ok();
        assert_eq!(
            applied, expect_chat,
            "the inbound boundary read the wrong dimension ({label})",
        );
    }
}

// A share view's own sync identity, and the narrow lane term
// that lets its file writes journal.
//
// A share view replicates through a SHARE, so it holds `share_view_cursors`
// and none of the owner-lane tables. Before this it had no identity at all:
// its file writes never journalled and every proposal refused before the
// relay was contacted.

/// The share-lane state a real share view holds after its first pull: a
/// cursor for the share, and no owner-lane position of any kind.
fn seed_share_view_cursor(engine: &mut EngineStore, share_id: &str) {
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO share_view_cursors (workspace_id,share_id,cursor) \
                 VALUES ('ws',?1,'3')",
                [share_id],
            )
            .map_err(SyncError::persist)?;
            Ok::<(), SyncError>(())
        })
        .expect("share view cursor");
}
fn record(engine: &mut EngineStore, origin_id: &str) -> ShareViewIdentityOutcome {
    match record_share_view_identity(
        engine,
        "ws",
        ShareViewIdentity {
            origin_id,
            replication_epoch: "epoch-share",
            stream_identity: "stream-share",
        },
        1_000,
        &NoFaults,
    )
    .expect("record share view identity")
    {
        TxnOutcome::Committed(outcome) => outcome,
        TxnOutcome::Crashed { .. } => panic!("recording crashed"),
    }
}

#[test]
fn only_the_file_moment_journal_reads_the_share_lane() {
    for (label, recorded, unrelated_identity, lane, expected) in [
        ("nothing at all", false, false, None, (false, false)),
        (
            "an edit share view",
            true,
            false,
            Some("share_view_cursors"),
            (false, true),
        ),
        (
            "a read-only share view with an unrelated identity",
            false,
            true,
            Some("share_view_cursors"),
            (false, false),
        ),
        (
            "an owner push position",
            false,
            true,
            Some("sync_relay_push_state"),
            (true, true),
        ),
        (
            "a shared channel cursor",
            false,
            true,
            Some("shared_channel_cursors"),
            (false, false),
        ),
        (
            "a shared channel push position",
            false,
            true,
            Some("shared_channel_push_state"),
            (false, false),
        ),
    ] {
        let (_scratch, _path, mut engine) = open_store();
        if recorded {
            assert_eq!(
                record(&mut engine, "origin-lane"),
                ShareViewIdentityOutcome::Recorded
            );
        }
        if unrelated_identity {
            // No level and no lane: just a row that cannot authorize a file
            // moment journal by itself.
            engine
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "INSERT OR IGNORE INTO sync_identity                          (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms)                          VALUES ('ws','origin-chat','epoch-chat','stream-chat',1)",
                        [],
                    )
                    .map_err(SyncError::persist)?;
                    Ok::<(), SyncError>(())
                })
                .expect("chat-minted identity");
        }
        if let Some(table) = lane {
            let sql = match table {
                "sync_relay_push_state" => {
                    "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq)                      VALUES ('ws','origin-lane',0)"
                }
                "share_view_cursors" => {
                    "INSERT INTO share_view_cursors (workspace_id,share_id,cursor)                      VALUES ('ws','share','3')"
                }
                "shared_channel_cursors" => {
                    "INSERT INTO shared_channel_cursors (workspace_id,share_id,cursor)                      VALUES ('ws','share','3')"
                }
                "shared_channel_push_state" => {
                    "INSERT INTO shared_channel_push_state                      (workspace_id,share_id,pushed_seq) VALUES ('ws','share',0)"
                }
                other => panic!("no fixture for {other}"),
            };
            engine
                .write_with(&NoFaults, |tx| {
                    tx.execute(sql, []).map_err(SyncError::persist)?;
                    Ok::<(), SyncError>(())
                })
                .expect("lane fixture");
        }
        assert_eq!(
            lane_answers(&mut engine),
            expected,
            "a predicate read the wrong lane ({label})",
        );
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum JournalLane {
    Owner,
    EditShare,
    Local,
}

fn journal_lane_store(lane: JournalLane) -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let (scratch, path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    if lane == JournalLane::EditShare {
        seed_share_view_cursor(&mut engine, "share-journal");
        assert_eq!(
            record(&mut engine, "local"),
            ShareViewIdentityOutcome::Recorded
        );
    } else {
        adopt_join_identity(
            &mut engine,
            "ws",
            "local",
            "epoch-share",
            "stream-share",
            1_000,
            &NoFaults,
        )
        .expect("identity");
        if lane == JournalLane::Owner {
            crate::cursor::write_pushed_seq(
                &mut engine,
                "ws",
                "local",
                -1,
                &NoFaults,
                &NoLiveLeases,
                1_001,
            )
            .expect("owner relay position");
        }
    }
    (scratch, path, engine)
}

fn local_lane_ops(engine: &EngineStore, kind: &str) -> Vec<ReplicationEnvelope> {
    list_replication_ops(engine, "ws", "local", -1, MAX_PULL_OPS)
        .expect("local operations")
        .into_iter()
        .filter(|op| op.op_kind == kind)
        .collect()
}

/// A real fold must save the choice in every lane. Only an owner can send its Y.Doc update.
#[test]
fn resolution_fold_journals_a_ydoc_update_only_in_the_owner_lane() {
    use dohc_engine_collab::{ContentKind, DocKey, Ydoc};

    for lane in [
        JournalLane::Owner,
        JournalLane::EditShare,
        JournalLane::Local,
    ] {
        for (point, committed) in [
            (FaultPoint::StorageBeforePersist, false),
            (FaultPoint::StorageAfterCommitBeforeAck, true),
        ] {
            let (_scratch, database, mut engine) = journal_lane_store(lane);
            let path = "shared/docs/fold.md";
            seed_text_head(&mut engine, "object-fold", path, "original");
            let key = DocKey::new("ws", "main", "object-fold").unwrap();
            let doc = Ydoc::wire();
            doc.plaintext_insert(0, "original");
            let claim = dohc_engine_storage::hex_sha256(&doc.encode_full_state());
            dohc_engine_collab::claim_base(
                &mut engine,
                &key,
                ContentKind::Plaintext,
                &doc.encode_full_state(),
                &NoFaults,
                1_100,
            )
            .expect("exact lineage");
            let fold = |engine: &mut EngineStore,
                        faults: &dyn dohc_engine_storage::FaultInjector| {
                engine.write_with(faults, |tx| {
                    crate::ydoc_apply::fold_resolution_into_ydoc_in_tx(
                        tx,
                        "ws",
                        "main",
                        "object-fold",
                        path,
                        "chosen",
                        1_200,
                    )
                })
            };
            let fault = ScriptedFaults::crash_at(point);
            assert!(matches!(fold(&mut engine, fault.as_ref()).unwrap(),
                TxnOutcome::Crashed { committed: actual } if actual == committed));
            assert!(fault.fired());
            drop(engine);
            let mut engine = EngineStore::open(&database, 1_300).unwrap();
            let projected = |engine: &EngineStore| {
                dohc_engine_collab::load_persisted(engine, &key)
                    .unwrap()
                    .unwrap()
                    .doc
                    .project(ContentKind::Plaintext)
                    .unwrap()
                    .content
            };
            assert_eq!(
                projected(&engine),
                if committed { "chosen" } else { "original" }
            );
            assert_eq!(
                local_lane_ops(&engine, "ydoc.update").len(),
                usize::from(committed && lane == JournalLane::Owner)
            );
            assert!(matches!(
                fold(&mut engine, &NoFaults).unwrap(),
                TxnOutcome::Committed(())
            ));
            assert_eq!(projected(&engine), "chosen");
            let ops = local_lane_ops(&engine, "ydoc.update");
            assert_eq!(
                ops.len(),
                usize::from(lane == JournalLane::Owner),
                "{lane:?}"
            );
            if let Some(op) = ops.first() {
                assert_eq!(op.payload["lineageClaimId"], claim);
                assert_eq!(op.payload["isBaseState"], false);
                assert_eq!(op.payload["path"], path);
                let bytes = engine
                    .get_binary_blob(op.payload["updateBlobSha256"].as_str().unwrap())
                    .unwrap()
                    .unwrap();
                doc.apply(&bytes).unwrap();
                assert_eq!(
                    doc.project(ContentKind::Plaintext).unwrap().content,
                    "chosen"
                );
            }
        }
    }
}

fn journal_lane_conflict(
    engine: &mut EngineStore,
) -> crate::conflict_resolve_v1::BuiltConflictResolveV1 {
    use crate::conflict_resolve_v1::*;

    let current = "current";
    let result = "result";
    let current_sha = dohc_engine_storage::hex_sha256(current.as_bytes());
    let result_sha = dohc_engine_storage::hex_sha256(result.as_bytes());
    engine
        .write_with(&NoFaults, |tx| {
            for (sha, text) in [(&current_sha, current), (&result_sha, result)] {
                tx.execute(
                    "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                    params![sha, text.len() as i64, text],
                )
                .map_err(SyncError::persist)?;
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let head = |moment: &str, sha: &str, text: &str, at_ms| {
        HeadV1::Present(PresentHeadV1 {
            path_ref: 0,
            object_id: "object-conflict".to_owned(),
            latest_moment_id: moment.to_owned(),
            content_kind: HeadContentKindV1::Text,
            blob_sha256: sha.to_owned(),
            byte_length: text.len() as i64,
            updated_at_ms: at_ms,
        })
    };
    build_conflict_resolve_v1(ConflictResolveV1 {
        workspace_id: "ws".to_owned(),
        conflict_id: "conflict-journal".to_owned(),
        chosen_from: ResolveChoiceV1::Incoming,
        resolution: ResolutionV1::AppliedIncoming,
        target_version_id: "main".to_owned(),
        source_version_id: "peer-main".to_owned(),
        paths: vec!["shared/docs/conflict.md".to_owned()],
        current: head("moment-current", &current_sha, current, 10),
        incoming: head("moment-incoming", &result_sha, result, 20),
        result: head("moment-result", &result_sha, result, 30),
        effect_context: EffectContextV1 {
            recorded_at_ms: 30,
            metadata: MetadataV1 {
                origin: "api".to_owned(),
                summary: None,
                correlation_id: None,
            },
            author: None,
            current_object_created_at_ms: Some(1),
            result_object_created_at_ms: Some(1),
        },
        effects: vec![EffectV1 {
            kind: EffectKindV1::Write,
            moment_id: "moment-result".to_owned(),
            payload_sha256: String::new(),
        }],
        lineage_transition: None,
        exported_before: None,
    })
    .expect("validated conflict carrier")
}

/// Share cursors never enroll owner work. First owner contact must backfill a former share store.
#[test]
fn origination_and_conflict_outbox_wait_for_owner_contact_not_a_share_cursor() {
    use dohc_engine_collab::{
        ContentKind, DocKey, LocalAppend, MarkerCreation, Regime, WriterDocCache, Ydoc,
    };

    for lane in [
        JournalLane::Owner,
        JournalLane::EditShare,
        JournalLane::Local,
    ] {
        for first_contact_is_push in [false, true] {
            let (_scratch, database, mut engine) = journal_lane_store(lane);
            let path = "shared/docs/unclaimed.md";
            seed_text_head(&mut engine, "object-unclaimed", path, "draft");
            let key = DocKey::new("ws", "main", "object-unclaimed").unwrap();
            let doc = Ydoc::wire();
            let update = doc.plaintext_insert(0, "draft");
            dohc_engine_collab::record_local_update(
                &mut engine,
                &mut WriterDocCache::new(),
                &key,
                &update,
                LocalAppend {
                    marker: Some(MarkerCreation {
                        path: Some(path),
                        content_kind: ContentKind::Plaintext,
                        regime: Regime::LocalOnly,
                    }),
                    ..Default::default()
                },
                &NoFaults,
                1_100,
                |_, _, _| Ok(()),
            )
            .unwrap();
            let outcome = engine
                .write_with(&NoFaults, |tx| {
                    originate_ydoc_base_in_tx(tx, &key, path, None, None, 1_200)
                })
                .unwrap();
            assert!(
                matches!(
                    outcome,
                    TxnOutcome::Committed(BaseOrigination::Originated { .. })
                ) == (lane == JournalLane::Owner)
            );
            if lane != JournalLane::Owner {
                assert_eq!(outcome, TxnOutcome::Committed(BaseOrigination::NothingToDo));
            }
            let built = journal_lane_conflict(&mut engine);
            let fault = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
            assert!(matches!(
                engine
                    .write_with(fault.as_ref(), |tx| {
                        crate::conflict_outbox::persist_local_conflict_resolve_v1_in_tx(
                            tx, &built, 0,
                        )
                    })
                    .unwrap(),
                TxnOutcome::Crashed { committed: true }
            ));
            drop(engine);
            let mut engine = EngineStore::open(&database, 1_300).unwrap();
            let pending = |engine: &EngineStore| {
                engine
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM replication_pending_conflict_bundles WHERE workspace_id='ws'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                })
                .unwrap()
            };
            assert_eq!(pending(&engine), i64::from(lane != JournalLane::Owner));
            assert_eq!(
                local_lane_ops(&engine, "conflict.resolve").len(),
                usize::from(lane == JournalLane::Owner)
            );
            commit_share_cursor(
                &mut engine,
                "ws",
                &ShareCursor {
                    kind: CursorKind::ShareView,
                    share_id: "share-journal".to_owned(),
                    cursor: 7,
                },
                &NoFaults,
            )
            .unwrap();
            assert_eq!(pending(&engine), i64::from(lane != JournalLane::Owner));
            assert_eq!(
                local_lane_ops(&engine, "ydoc.update").len(),
                usize::from(lane == JournalLane::Owner)
            );
            assert_eq!(
                local_lane_ops(&engine, "conflict.resolve").len(),
                usize::from(lane == JournalLane::Owner)
            );
            if lane != JournalLane::Owner {
                assert!(local_lane_ops(&engine, "moment.append").is_empty());
                let marker = engine
                    .read_with(|conn| dohc_engine_collab::read_marker_in(conn, &key))
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    marker.lineage_claim_status,
                    dohc_engine_collab::LineageClaimStatus::Unclaimed
                );
            }
            let owner_cursor = RelayCursor {
                cursor: 5,
                replication_epoch: "epoch-share".to_owned(),
                stream_identity: "stream-share".to_owned(),
                bootstrap_complete: true,
                settlement_report_id: None,
                ordinary_pull: None,
            };
            let fault = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
            let contact = if first_contact_is_push {
                crate::cursor::write_pushed_seq(
                    &mut engine,
                    "ws",
                    "local",
                    -1,
                    fault.as_ref(),
                    &NoLiveLeases,
                    1_400,
                )
                .map(|outcome| matches!(outcome, TxnOutcome::Crashed { committed: true }))
            } else {
                commit_relay_cursor(
                    &mut engine,
                    "ws",
                    &owner_cursor,
                    fault.as_ref(),
                    &NoLiveLeases,
                    1_400,
                )
                .map(|outcome| matches!(outcome, TxnOutcome::Crashed { committed: true }))
            };
            assert!(contact.expect("owner contact"));
            drop(engine);
            let mut engine = EngineStore::open(&database, 1_500).unwrap();
            if first_contact_is_push {
                assert!(read_relay_cursor(&engine, "ws").unwrap().is_none());
            } else {
                assert_eq!(read_relay_cursor(&engine, "ws").unwrap().unwrap().cursor, 5);
            }
            assert_eq!(
                read_share_cursor(&engine, "ws", "share-journal", CursorKind::ShareView).unwrap(),
                7
            );
            assert_eq!(pending(&engine), 0);
            let bases = local_lane_ops(&engine, "ydoc.update");
            assert_eq!(bases.len(), 1);
            let resolves = local_lane_ops(&engine, "conflict.resolve");
            let shadows = local_lane_ops(&engine, "moment.append");
            assert_eq!(resolves.len(), 1);
            assert_eq!(shadows.len(), 1);
            assert_eq!(shadows[0].origin_seq, resolves[0].origin_seq + 1);
            assert_eq!(bases[0].payload["isBaseState"], true);
            assert_eq!(resolves[0].payload, built.value);
            assert_eq!(shadows[0].payload, built.validated.shadows[0]);
            let before = list_replication_ops(&engine, "ws", "local", -1, MAX_PULL_OPS).unwrap();
            commit_relay_cursor(
                &mut engine,
                "ws",
                &owner_cursor,
                &NoFaults,
                &NoLiveLeases,
                1_600,
            )
            .unwrap();
            assert_eq!(
                list_replication_ops(&engine, "ws", "local", -1, MAX_PULL_OPS).unwrap(),
                before
            );
        }
    }
}

#[test]
fn recovered_share_file_moment_survives_restart_and_submits_within_its_grant() {
    use crate::ydoc_recovery::{RecoveryEnvelopeBinding, recover_lineage_in_tx};
    use dohc_engine_collab::{DocKey, Ydoc};

    for lane in [
        JournalLane::Owner,
        JournalLane::EditShare,
        JournalLane::Local,
    ] {
        for (point, committed) in [
            (FaultPoint::StorageBeforePersist, false),
            (FaultPoint::StorageAfterCommitBeforeAck, true),
        ] {
            let (_scratch, database, mut engine) = journal_lane_store(lane);
            let key = DocKey::new("ws", "main", "object-recovery").unwrap();
            let losing_doc = Ydoc::wire();
            losing_doc.plaintext_insert(0, "saved draft");
            let losing = engine
                .put_binary_blob(&losing_doc.encode_full_state())
                .unwrap();
            let incoming_doc = Ydoc::wire();
            incoming_doc.plaintext_insert(0, "remote winner");
            let incoming = engine
                .put_binary_blob(&incoming_doc.encode_full_state())
                .unwrap();
            let binding = RecoveryEnvelopeBinding {
                content_kind: "plaintext",
                update_blob_sha256: &incoming,
                lineage_claim_id: &incoming,
                is_base_state: true,
            };
            let recover =
                |engine: &mut EngineStore, faults: &dyn dohc_engine_storage::FaultInjector| {
                    engine.write_with(faults, |tx| {
                        recover_lineage_in_tx(
                            tx,
                            &key,
                            "shared/docs/draft.md",
                            binding.clone(),
                            &losing,
                            "saved draft",
                            None,
                            "remote",
                            0,
                            1_200,
                            None,
                        )
                    })
                };
            let fault = ScriptedFaults::crash_at(point);
            assert!(matches!(recover(&mut engine, fault.as_ref()).unwrap(),
                TxnOutcome::Crashed { committed: actual } if actual == committed));
            drop(engine);
            let mut engine = EngineStore::open(&database, 1_300).unwrap();
            assert_eq!(
                local_lane_ops(&engine, "moment.append").len(),
                usize::from(committed && lane != JournalLane::Local)
            );
            let TxnOutcome::Committed(created) = recover(&mut engine, &NoFaults).unwrap() else {
                panic!("recovery retry crashed");
            };
            assert_eq!(
                recover(&mut engine, &NoFaults).unwrap(),
                TxnOutcome::Committed(created.clone())
            );
            let moments = local_lane_ops(&engine, "moment.append");
            assert_eq!(moments.len(), usize::from(lane != JournalLane::Local));
            assert!(local_lane_ops(&engine, "ydoc.update").is_empty());
            let counts: (i64, i64, i64) = engine
                .read_with(|conn| {
                    Ok::<_, rusqlite::Error>((
                        conn.query_row("SELECT COUNT(*) FROM ydoc_recovery_decisions", [], |r| {
                            r.get(0)
                        })?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM moments WHERE moment_id=?1",
                            [&created.moment_id],
                            |r| r.get(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM materialization_jobs WHERE target_path=?1",
                            [&created.path],
                            |r| r.get(0),
                        )?,
                    ))
                })
                .unwrap();
            assert_eq!(counts, (1, 1, 1));
            let forged = engine.write_with(&NoFaults, |tx| {
                recover_lineage_in_tx(
                    tx,
                    &key,
                    "shared/docs/draft.md",
                    RecoveryEnvelopeBinding {
                        lineage_claim_id: &losing,
                        ..binding.clone()
                    },
                    &losing,
                    "saved draft",
                    None,
                    "remote",
                    0,
                    1_200,
                    None,
                )
            });
            assert!(matches!(forged, Err(SyncError::CoordinateDiverged)));
            if lane != JournalLane::EditShare {
                continue;
            }
            assert_eq!(moments[0].payload["momentId"], created.moment_id);
            let client = RelaySyncClient::new(PagedShareRelay::new([], []));
            for (share, grant) in [
                (
                    "outside",
                    ShareGrant {
                        paths: vec!["private".to_owned()],
                        version_id: None,
                        access: ShareAccess::Edit,
                    },
                ),
                (
                    "version",
                    ShareGrant {
                        paths: vec![],
                        version_id: Some("other".to_owned()),
                        access: ShareAccess::Edit,
                    },
                ),
            ] {
                assert_eq!(
                    client
                        .submit_share_proposal(
                            &mut engine,
                            "ws",
                            share,
                            &grant,
                            "excluded",
                            &NoFaults,
                            0
                        )
                        .unwrap()
                        .submitted,
                    0
                );
            }
            assert!(client.transport().proposal_calls.lock().unwrap().is_empty());
            let grant = share_proposal::proposal_grant(ShareAccess::Edit);
            let outcome = client
                .submit_share_proposal(
                    &mut engine,
                    "ws",
                    "share-journal",
                    &grant,
                    "recovered-submit",
                    &NoFaults,
                    0,
                )
                .unwrap();
            assert_eq!(outcome.submitted, 1);
            assert!(outcome.proposal_id.is_some());
            let submits = client.transport().proposal_submits.lock().unwrap();
            assert_eq!(submits.len(), 1);
            assert_eq!(submits[0].ops.len(), 1);
            let change = &submits[0].ops[0];
            assert_eq!(change.operation, "write");
            assert_eq!(change.based_on_path, None);
            assert_eq!(change.based_on_blob_sha256, None);
            assert_eq!(change.after_path.as_deref(), Some(created.path.as_str()));
            let sha = dohc_engine_storage::hex_sha256(b"saved draft");
            assert_eq!(change.after_blob_sha256.as_deref(), Some(sha.as_str()));
            assert_eq!(change.after_content_kind.as_deref(), Some("text"));
            assert_eq!(change.after_byte_length, Some(11));
            assert_eq!(
                client.transport().proposal_calls.lock().unwrap().as_slice(),
                [format!("blob:{sha}"), "submit".to_owned()]
            );
            assert_eq!(
                client.transport().blob_uploads.lock().unwrap()[0]
                    .bytes
                    .as_slice(),
                b"saved draft"
            );
            let scanned: i64 = engine.read_with(|conn| {
                conn.query_row(
                    "SELECT scanned_seq FROM share_proposal_push_state WHERE workspace_id='ws' AND share_id='share-journal'",
                    [], |row| row.get(0),
                )
            }).unwrap();
            assert_eq!(scanned, moments[0].origin_seq);
            drop(submits);
            drop(engine);
            let mut engine = EngineStore::open(&database, 1_400).unwrap();
            assert_eq!(
                client
                    .submit_share_proposal(
                        &mut engine,
                        "ws",
                        "share-journal",
                        &grant,
                        "recovered-again",
                        &NoFaults,
                        0
                    )
                    .unwrap()
                    .submitted,
                0
            );
            assert_eq!(client.transport().proposal_submits.lock().unwrap().len(), 1);
            assert!(local_lane_ops(&engine, "ydoc.update").is_empty());
        }
    }
}

#[test]
fn received_token_survives_rename_delete_restore_and_visible_half_reentry() {
    for binary in [false, true] {
        let (_scratch, _path, mut engine) = open_store();
        let token = format!("share-object:v1:{}", "a".repeat(64));
        let body = b"received body".to_vec();
        let sha = dohc_engine_storage::hex_sha256(&body);
        let write = |seq, path| {
            let mut op = if binary {
                share_view_binary_write_op(seq, path, &sha)
            } else {
                share_view_write_op(seq, path, &sha)
            };
            op.payload["objectId"] = json!(token);
            op
        };
        let mut rename = write(1, "docs/b.md");
        rename.payload["operation"] = json!("rename");
        rename.payload["payloadBeforePath"] = json!("docs/a.md");
        let delete = |seq| {
            let mut op = write(seq, "docs/b.md");
            op.payload = json!({"versionId":"main","objectId":token,"operation":"delete","path":"docs/b.md"});
            op
        };
        // A move out is the visible delete; a move back is the visible create.
        let pages = [
            vec![write(0, "docs/a.md"), rename],
            vec![delete(2)],
            vec![write(3, "docs/b.md")],
            vec![delete(4)],
            vec![write(5, "docs/b.md")],
        ];
        let mut cursor = 0;
        let responses = pages
            .into_iter()
            .map(|ops| {
                let since = cursor;
                cursor += ops.len() as i64;
                (
                    since,
                    ShareViewResponse {
                        work_references: Vec::new(),
                        next_reference_after: None,
                        reference_has_more: false,
                        ops,
                        next_cursor: cursor,
                        has_more: false,
                    },
                )
            })
            .collect::<Vec<_>>();
        let client = RelaySyncClient::new(
            PagedShareRelay::new([], responses).with_view_blobs([(sha.clone(), body)]),
        );
        for expected in [
            Some("docs/b.md"),
            None,
            Some("docs/b.md"),
            None,
            Some("docs/b.md"),
        ] {
            let pull = client
                .pull_share_view(
                    &mut engine,
                    "ws",
                    "share",
                    &tracked_grant(["docs"]),
                    &NoFaults,
                )
                .unwrap();
            assert_eq!(pull.skipped, 0);
            engine.read_with(|conn| {
                let path: Option<String> = conn.query_row("SELECT path FROM path_aliases WHERE workspace_id='ws' AND object_id=?1", [&token], |row|row.get(0)).optional()?;
                assert_eq!(path.as_deref(),expected);
                assert_eq!(conn.query_row("SELECT COUNT(*) FROM file_objects WHERE workspace_id='ws'",[],|row|row.get::<_,i64>(0))?,1);
                Ok::<_,rusqlite::Error>(())
            }).unwrap();
            let retry = client
                .pull_share_view(
                    &mut engine,
                    "ws",
                    "share",
                    &tracked_grant(["docs"]),
                    &NoFaults,
                )
                .unwrap();
            assert_eq!(retry.applied, 0);
            client
                .commit_share_view_cursor(&mut engine, "ws", &pull.pending_cursor, &NoFaults)
                .unwrap();
        }
    }
}

#[test]
fn received_head_replaces_local_draft_and_version_snapshot_gets_tokens() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    VersionedTextStore::new(&mut engine)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "local-proposal".into(),
                path: "docs/a.md".into(),
                text: "draft".into(),
                moment_id: "local-draft".into(),
                metadata_origin: "user".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    let token = format!("share-object:v1:{}", "a".repeat(64));
    let body = b"accepted".to_vec();
    let sha = dohc_engine_storage::hex_sha256(&body);
    let mut op = share_view_write_op(0, "docs/a.md", &sha);
    op.payload["objectId"] = json!(token);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![op],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(sha.clone(), body.clone())]),
    );
    client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .unwrap();
    engine.read_with(|conn| {assert_eq!(conn.query_row("SELECT object_id FROM path_aliases WHERE workspace_id='ws' AND path='docs/a.md'",[],|row|row.get::<_,String>(0))?,token);Ok::<_,rusqlite::Error>(())}).unwrap();
    // This draft was never submitted. Its current head retires, but history remains readable.
    let history = VersionedTextStore::new(&mut engine)
        .history_page("ws", Some("main"), Some("local-proposal"), None, 50, None)
        .unwrap();
    assert_eq!(history.moments.len(), 1);
    assert_eq!(history.moments[0].moment_id, "local-draft");
    let draft = VersionedTextStore::new(&mut engine)
        .get_moment("ws", "local-draft")
        .unwrap()
        .unwrap();
    assert_eq!(draft.object_id, "local-proposal");
    engine
        .read_with(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT text FROM blobs WHERE sha256=?1",
                    [draft.after_blob_sha256.as_ref().unwrap()],
                    |row| row.get::<_, String>(0)
                )?,
                "draft"
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases WHERE object_id='local-proposal'",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                0
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE object_id='local-proposal'",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                0
            );
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    let (_scratch2, _path2, mut version_engine) = open_store();
    seed_replication_version(&mut version_engine, "main", "main");
    VersionedTextStore::new(&mut version_engine)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "private-owner-object".into(),
                path: "docs/private.md".into(),
                text: "draft".into(),
                moment_id: "private-draft".into(),
                metadata_origin: "user".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();

    let mut snapshot = share_view_write_op(0, "docs/a.md", &sha);
    snapshot.op_kind = "version.create".into();
    snapshot.payload = json!({"versionId":"v","forkSnapshots":[{"path":"docs/a.md","objectId":token,"blobSha256":sha}]});
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    work_references: vec![
                        serde_json::from_value(json!({
                            "reference": "V".repeat(43), "createdAtMs": 1,
                            "target": {"kind":"file", "versionId":"v", "objectId":token},
                        }))
                        .unwrap(),
                        serde_json::from_value(json!({"reference":"W".repeat(43),"createdAtMs":1,
                            "target":{"kind":"file","versionId":"wrong-version","objectId":token}})).unwrap(),
                        serde_json::from_value(json!({"reference":"F".repeat(43),"createdAtMs":1,
                            "target":{"kind":"file","versionId":"v","objectId":"private-owner-object"}})).unwrap(),
                    ],
                    next_reference_after: Some("mapping-page".into()),
                    reference_has_more: true,
                    ops: vec![snapshot],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(sha, body)]),
    );
    let pull = client
        .pull_share_view(
            &mut version_engine,
            "ws",
            "share",
            &ShareGrant {
                paths: vec!["docs".into()],
                version_id: Some("v".into()),
                access: ShareAccess::View,
            },
            &NoFaults,
        )
        .unwrap();
    version_engine.read_with(|conn| {assert_eq!(conn.query_row("SELECT object_id FROM path_aliases WHERE workspace_id='ws' AND path='docs/a.md'",[],|row|row.get::<_,String>(0))?,token);Ok::<_,rusqlite::Error>(())}).unwrap();
    version_engine
        .read_with(|conn| {
            assert_eq!(
                crate::share::object_main_path(conn, "ws", "private-owner-object")
                    .unwrap()
                    .as_deref(),
                Some("docs/private.md")
            );
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    for reference in ["W", "F"] {
        assert!(matches!(
            dohc_engine_domain::work_references::resolve_work_reference(
                &version_engine,
                "ws",
                &reference.repeat(43)
            )
            .unwrap(),
            dohc_engine_domain::work_references::WorkReferenceResolution::Unknown
        ));
    }
    assert!(pull.has_more);
    assert!(matches!(
        dohc_engine_domain::work_references::resolve_work_reference(&version_engine, "ws", &"V".repeat(43)).unwrap(),
        dohc_engine_domain::work_references::WorkReferenceResolution::Found {
            state: dohc_engine_domain::work_references::WorkTargetState::Live,
            path: Some(path), ..
        } if path == "docs/a.md"
    ));
}

fn received_rename_mismatch_replays_as_write_delete(case: &str) {
    let (_scratch, _path, mut engine) = open_store();
    let token = format!("share-object:v1:{}", "c".repeat(64));
    let body = b"source content".to_vec();
    let sha = dohc_engine_storage::hex_sha256(&body);
    let mut initial = share_view_write_op(0, "docs/a.md", &sha);
    initial.payload["objectId"] = json!(token);
    let mut rename = share_view_write_op(1, "docs/b.md", &sha);
    rename.payload["objectId"] = json!(token);
    rename.payload["operation"] = json!("rename");
    rename.payload["payloadBeforePath"] = json!("docs/a.md");
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [
                (
                    0,
                    ShareViewResponse {
                        work_references: Vec::new(),
                        next_reference_after: None,
                        reference_has_more: false,
                        ops: vec![initial],
                        next_cursor: 1,
                        has_more: false,
                    },
                ),
                (
                    1,
                    ShareViewResponse {
                        work_references: Vec::new(),
                        next_reference_after: None,
                        reference_has_more: false,
                        ops: vec![rename],
                        next_cursor: 2,
                        has_more: false,
                    },
                ),
                (
                    2,
                    ShareViewResponse {
                        work_references: Vec::new(),
                        next_reference_after: None,
                        reference_has_more: false,
                        ops: vec![],
                        next_cursor: 2,
                        has_more: false,
                    },
                ),
            ],
        )
        .with_view_blobs([(sha.clone(), body)]),
    );
    let grant = tracked_grant(["docs"]);
    let pull = client
        .pull_share_view(&mut engine, "ws", "share", &grant, &NoFaults)
        .unwrap();
    client
        .commit_share_view_cursor(&mut engine, "ws", &pull.pending_cursor, &NoFaults)
        .unwrap();
    match case {
        "missing" => {
            VersionedTextStore::new(&mut engine)
                .delete_text_file(
                    &dohc_engine_domain::DeleteTextFile {
                        workspace_id: "ws".into(),
                        version_id: "main".into(),
                        path: "docs/a.md".into(),
                        moment_id: "local-delete".into(),
                        request_id: None,
                        metadata_origin: "user".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 10,
                    },
                    &NoFaults,
                )
                .unwrap();
        }
        "edited" | "occupied" => {
            VersionedTextStore::new(&mut engine)
                .write_text(
                    &dohc_engine_domain::WriteText {
                        workspace_id: "ws".into(),
                        version_id: "main".into(),
                        object_id: "local-draft".into(),
                        path: if case == "edited" {
                            "docs/a.md"
                        } else {
                            "docs/b.md"
                        }
                        .into(),
                        text: "unsubmitted edit".into(),
                        moment_id: "local-edit".into(),
                        request_id: None,
                        metadata_origin: "user".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 10,
                    },
                    &NoFaults,
                )
                .unwrap();
        }
        _ => unreachable!(),
    }
    let pull = client
        .pull_share_view(&mut engine, "ws", "share", &grant, &NoFaults)
        .expect("a rename mismatch must not strand the share cursor");
    assert_eq!(pull.skipped, 0);
    engine.read_with(|conn| {
        let (id, actual_sha): (String, String) = conn.query_row(
            "SELECT a.object_id,s.blob_sha256 FROM path_aliases a JOIN snapshots s USING(workspace_id,version_id,object_id) WHERE a.workspace_id='ws' AND a.path='docs/b.md'", [], |row| Ok((row.get(0)?,row.get(1)?)))?;
        assert_eq!(id, token);
        assert_eq!(actual_sha, sha);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM path_aliases WHERE workspace_id='ws' AND path='docs/a.md'", [], |row| row.get::<_,i64>(0))?,0);
        Ok::<_,rusqlite::Error>(())
    }).unwrap();
    // Retrying before cursor publication must reuse both fallback receipts.
    assert_eq!(
        client
            .pull_share_view(&mut engine, "ws", "share", &grant, &NoFaults)
            .unwrap()
            .applied,
        0
    );
    client
        .commit_share_view_cursor(&mut engine, "ws", &pull.pending_cursor, &NoFaults)
        .unwrap();
    assert_eq!(
        client
            .pull_share_view(&mut engine, "ws", "share", &grant, &NoFaults)
            .unwrap()
            .applied,
        0
    );
}

#[test]
fn received_rename_falls_back_after_unsubmitted_edit() {
    received_rename_mismatch_replays_as_write_delete("edited");
}
fn received_rename_retry_preserves_recreated_source(fallback: bool, quit: bool) {
    for binary in [false, true] {
        let (_scratch, database, mut engine) = open_store();
        let token = format!("share-object:v1:{}", "e".repeat(64));
        let new_token = format!("share-object:v1:{}", "f".repeat(64));
        let body = b"source content".to_vec();
        let recreated = b"a different file at the old path".to_vec();
        let later = b"fetched after the rename and re-create".to_vec();
        let sha = dohc_engine_storage::hex_sha256(&body);
        let recreated_sha = dohc_engine_storage::hex_sha256(&recreated);
        let later_sha = dohc_engine_storage::hex_sha256(&later);
        let write = |seq, path, sha: &str, token: &str| {
            let mut op = if binary {
                share_view_binary_write_op(seq, path, sha)
            } else {
                share_view_write_op(seq, path, sha)
            };
            op.payload["objectId"] = json!(token);
            op
        };
        let mut rename = write(1, "docs/b.md", &sha, &token);
        rename.payload["operation"] = json!("rename");
        rename.payload["payloadBeforePath"] = json!("docs/a.md");
        let pages = [
            (
                0,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![write(0, "docs/a.md", &sha, &token)],
                    next_cursor: 1,
                    has_more: false,
                },
            ),
            (
                1,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![
                        rename,
                        write(2, "docs/a.md", &recreated_sha, &new_token),
                        share_view_write_op(3, "docs/later.md", &later_sha),
                    ],
                    next_cursor: 4,
                    has_more: false,
                },
            ),
            (
                4,
                ShareViewResponse {
                    work_references: Vec::new(),
                    next_reference_after: None,
                    reference_has_more: false,
                    ops: vec![],
                    next_cursor: 4,
                    has_more: false,
                },
            ),
        ];
        let blobs = [
            (sha.clone(), body),
            (recreated_sha.clone(), recreated),
            (later_sha.clone(), later),
        ];
        let client = RelaySyncClient::new(
            PagedShareRelay::new([], pages.clone()).with_view_blobs(blobs.clone()),
        );
        let grant = tracked_grant(["docs"]);
        let initial = client
            .pull_share_view(&mut engine, "ws", "share", &grant, &NoFaults)
            .unwrap();
        client
            .commit_share_view_cursor(&mut engine, "ws", &initial.pending_cursor, &NoFaults)
            .unwrap();
        if fallback {
            VersionedTextStore::new(&mut engine)
                .write_text(
                    &dohc_engine_domain::WriteText {
                        workspace_id: "ws".into(),
                        version_id: "main".into(),
                        object_id: token.clone(),
                        path: "docs/a.md".into(),
                        text: "unsubmitted recipient edit".into(),
                        moment_id: "local-edit".into(),
                        request_id: None,
                        metadata_origin: "user".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 10,
                    },
                    &NoFaults,
                )
                .unwrap();
        }
        if quit {
            client
                .pull_share_view(&mut engine, "ws", "share", &grant, &NoFaults)
                .unwrap();
            // Quit after replay, before publishing the returned cursor.
            drop(engine);
            engine = EngineStore::open(&database, 20).unwrap();
        } else {
            let failed = RelaySyncClient::new(
                PagedShareRelay::new([], pages)
                    .with_view_blobs(blobs)
                    .with_view_blob_errors([(later_sha, RelayError::InvalidResponse)]),
            );
            assert_eq!(
                failed
                    .pull_share_view(&mut engine, "ws", "share", &grant, &NoFaults)
                    .unwrap_err(),
                RelayError::InvalidResponse,
            );
        }
        let assert_heads = |engine: &EngineStore| {
            engine.read_with(|conn| {
                for (path, expected_token, expected_sha) in [
                    ("docs/a.md", &new_token, &recreated_sha),
                    ("docs/b.md", &token, &sha),
                ] {
                    let head: Option<(String, String)> = conn.query_row(
                        "SELECT a.object_id,CASE s.content_kind WHEN 'binary' THEN s.binary_sha256 ELSE s.blob_sha256 END
                         FROM path_aliases a JOIN snapshots s USING(workspace_id,version_id,object_id)
                         WHERE a.workspace_id='ws' AND a.version_id='main' AND a.path=?1",
                        [path], |row| Ok((row.get(0)?,row.get(1)?)),
                    ).optional()?;
                    assert_eq!(head, Some((expected_token.clone(), expected_sha.clone())), "{path}, binary={binary}, fallback={fallback}");
                }
                Ok::<_, rusqlite::Error>(())
            }).unwrap();
        };
        assert_heads(&engine);
        let retry = client
            .pull_share_view(&mut engine, "ws", "share", &grant, &NoFaults)
            .unwrap();
        assert_heads(&engine);
        assert_eq!(retry.applied, usize::from(!quit));
        assert_eq!(retry.skipped, 0);
        client
            .commit_share_view_cursor(&mut engine, "ws", &retry.pending_cursor, &NoFaults)
            .unwrap();
        assert_eq!(
            client
                .pull_share_view(&mut engine, "ws", "share", &grant, &NoFaults)
                .unwrap()
                .applied,
            0
        );
    }
}

#[test]
fn received_native_rename_retry_keeps_recreated_source_after_quit_before_cursor_commit() {
    received_rename_retry_preserves_recreated_source(false, true);
}

#[test]
fn received_fallback_rename_commits_write_and_delete_together() {
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let (_scratch, database, mut engine) = open_store();
        let old_token = format!("share-object:v1:{}", "a".repeat(64));
        let new_token = format!("share-object:v1:{}", "b".repeat(64));
        let body = b"source content".to_vec();
        let sha = dohc_engine_storage::hex_sha256(&body);
        let mut initial = share_view_write_op(0, "docs/a.md", &sha);
        initial.payload["objectId"] = json!(old_token);
        let mut rename = share_view_write_op(1, "docs/b.md", &sha);
        rename.payload["objectId"] = json!(new_token);
        rename.payload["operation"] = json!("rename");
        rename.payload["payloadBeforePath"] = json!("docs/a.md");
        let client = RelaySyncClient::new(
            PagedShareRelay::new(
                [],
                [
                    (
                        0,
                        ShareViewResponse {
                            work_references: Vec::new(),
                            next_reference_after: None,
                            reference_has_more: false,
                            ops: vec![initial],
                            next_cursor: 1,
                            has_more: false,
                        },
                    ),
                    (
                        1,
                        ShareViewResponse {
                            work_references: Vec::new(),
                            next_reference_after: None,
                            reference_has_more: false,
                            ops: vec![rename],
                            next_cursor: 2,
                            has_more: false,
                        },
                    ),
                ],
            )
            .with_view_blobs([(sha, body)]),
        );
        let grant = tracked_grant(["docs"]);
        let initial = client
            .pull_share_view(&mut engine, "ws", "share", &grant, &NoFaults)
            .unwrap();
        client
            .commit_share_view_cursor(&mut engine, "ws", &initial.pending_cursor, &NoFaults)
            .unwrap();
        let fault = ScriptedFaults::crash_at(point);
        assert!(
            client
                .pull_share_view(&mut engine, "ws", "share", &grant, fault.as_ref())
                .is_err()
        );
        drop(engine);
        let mut engine = EngineStore::open(&database, 20).unwrap();
        let committed = point == FaultPoint::StorageAfterCommitBeforeAck;
        engine.read_with(|conn| {
            for (path, expected) in [
                ("docs/a.md", if committed { None } else { Some(&old_token) }),
                ("docs/b.md", if committed { Some(&new_token) } else { None }),
            ] {
                let id: Option<String> = conn.query_row(
                    "SELECT object_id FROM path_aliases WHERE workspace_id='ws' AND version_id='main' AND path=?1",
                    [path], |row| row.get(0),
                ).optional()?;
                assert_eq!(id.as_ref(), expected, "fallback must publish both effects or neither");
            }
            Ok::<_, rusqlite::Error>(())
        }).unwrap();
        let retry = client
            .pull_share_view(&mut engine, "ws", "share", &grant, &NoFaults)
            .unwrap();
        assert_eq!(retry.skipped, 0);
        engine.read_with(|conn| {
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM path_aliases WHERE workspace_id='ws' AND path='docs/a.md'", [], |row| row.get::<_,i64>(0))?, 0);
            Ok::<_,rusqlite::Error>(())
        }).unwrap();
    }
}

/// Both predicates, read through the real functions inside one transaction.
fn lane_answers(engine: &mut EngineStore) -> (bool, bool) {
    let outcome = engine
        .write_with(&NoFaults, |tx| {
            Ok::<(bool, bool), SyncError>((
                workspace_replicates_with_relay_in_tx(tx, "ws")?,
                crate::workspace_journals_file_moments_in_tx(tx, "ws")?,
            ))
        })
        .expect("lane answers");
    match outcome {
        TxnOutcome::Committed(answers) => answers,
        TxnOutcome::Crashed { .. } => panic!("lane read crashed"),
    }
}
