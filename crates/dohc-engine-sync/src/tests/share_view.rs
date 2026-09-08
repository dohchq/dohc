use super::*;

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

/// Fail closed on shape, not only on value: a served moment whose `versionId`
/// is not one the relay could have issued cannot be version-checked at all, so
/// it is refused rather than applied unchecked. Otherwise a relay disarms the
/// rule above by dropping or corrupting one field. The refusal does not depend
/// on which version the share pinned, and it is counted as the share-boundary
/// event it is rather than as a generic malformed payload.
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

/// The refusal has to be actionable, and an agent reading it acts on the unit.
/// The budget counts UTF-16 code units — `String.length` in the shared rule —
/// so 65 emoji are 130 units over a 128 limit, not 65 "characters". A refusal
/// that reports characters names a number the limit does not compare against,
/// and the caller cannot tell how far over it is.
///
/// The absent case has no observed length to report, and says so rather than
/// inventing a zero.
#[test]
fn an_unusable_version_id_names_the_limit_the_unit_and_the_observed_length() {
    let (_scratch, _path, mut engine) = open_store();
    let boundary = share_view_version_boundary(None);
    let astral = "\u{1f600}".repeat(MAX_SHARE_VERSION_ID_CHARS / 2 + 1);
    assert_eq!(astral.chars().count(), 65);
    let oversized = apply_shared_envelope(
        &mut engine,
        &boundary,
        &share_view_moment(json!({"versionId": astral, "path": "shared/docs/a.md"})),
        &NoFaults,
    )
    .expect_err("an oversized version id is refused");
    assert!(
        matches!(
            &oversized,
            SyncError::ShareVersionUnusable {
                op_kind,
                limit: MAX_SHARE_VERSION_ID_CHARS,
                observed: Some(130)
            } if op_kind == "moment.append"
        ),
        "counting characters reports 65 against a 128 limit, which reads as inside it: {oversized:?}"
    );
    let message = oversized.to_string();
    assert!(
        message.contains("128 UTF-16 code units") && message.contains("130 UTF-16 code units"),
        "the refusal must name the limit, the unit, and the observed length: {message}"
    );
    // This message is persisted as the refusal detail and shown on a notice
    // whose copy deliberately claims no scope. A scope claim here contradicts
    // both that copy and the code that classifies this as malformed.
    assert!(
        !message.contains("outside the share boundary"),
        "the detail claims the share excluded an op it may well cover: {message}"
    );

    let absent = apply_shared_envelope(
        &mut engine,
        &boundary,
        &share_view_moment(json!({"path": "shared/docs/a.md"})),
        &NoFaults,
    )
    .expect_err("a moment with no version id is refused");
    assert!(
        matches!(
            &absent,
            SyncError::ShareVersionUnusable {
                op_kind,
                limit: MAX_SHARE_VERSION_ID_CHARS,
                observed: None
            } if op_kind == "moment.append"
        ),
        "a payload with no version id string has no observed length: {absent:?}"
    );
    assert!(
        absent.to_string().contains("no versionId string"),
        "the refusal must say the field was absent rather than report a zero length: {absent}"
    );
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
                    ops: Vec::new(),
                    next_cursor: 1,
                    has_more: true,
                },
            ),
            (
                1,
                ShareViewResponse {
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

#[test]
fn share_view_pull_accepts_every_tracked_path_selected_by_the_relay() {
    let (_scratch, _path, mut engine) = open_store();
    let op = |seq, path: &str| ShareReplicationEnvelope {
        origin_id: "peer".to_owned(),
        origin_seq: seq,
        op_kind: "moment.append".to_owned(),
        payload: json!({
            "versionId": "main",
            "path": path,
            "payloadAfterPath": path,
            "operation": "selector-only"
        }),
        recorded_at_ms: 10 + seq,
    };
    let client = RelaySyncClient::new(PagedShareRelay::new(
        [],
        [(
            0,
            ShareViewResponse {
                ops: vec![op(0, "docs/a.md"), op(1, "projects/b.md")],
                next_cursor: 2,
                has_more: false,
            },
        )],
    ));
    let granted = tracked_grant(["docs", "projects"]);
    let outcome = client
        .pull_share_view(&mut engine, "ws", "share", &granted, &NoFaults)
        .expect("pull multi-path share");
    assert_eq!(
        (outcome.fetched, outcome.skipped),
        (2, 0),
        "matching only the first granted path permanently drops the other selected path"
    );
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

/// The wiring for the version rule's shape half: `pull_share_view` turns the
/// malformed-payload refusal into a skip before replay, so a relay that
/// strips `versionId` from a served moment gets nothing replayed and its blob
/// is never requested.
#[test]
fn share_view_pull_skips_a_moment_with_no_version_identity_before_requesting_its_blob() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let versioned = b"versioned body".to_vec();
    let stripped = b"stripped body".to_vec();
    let versioned_sha = dohc_engine_storage::hex_sha256(&versioned);
    let stripped_sha = dohc_engine_storage::hex_sha256(&stripped);
    let mut stripped_op = share_view_write_op(1, "docs/stripped.md", &stripped_sha);
    stripped_op
        .payload
        .as_object_mut()
        .expect("moment payload")
        .remove("versionId");
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![
                        share_view_write_op(0, "docs/versioned.md", &versioned_sha),
                        stripped_op,
                    ],
                    next_cursor: 2,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(versioned_sha.clone(), versioned), (stripped_sha, stripped)]),
    );

    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .expect("a malformed served moment is skipped, not fatal");

    assert_eq!(
        *client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls"),
        [versioned_sha],
        "accepting a moment with no version identity replays it and downloads its blob"
    );
    assert_eq!(
        (outcome.fetched, outcome.applied, outcome.skipped),
        (2, 1, 1),
        "the versioned op applies and the stripped one is counted as skipped"
    );
    assert_eq!(
        outcome
            .changed_paths
            .iter()
            .map(|changed| changed.path.as_str())
            .collect::<Vec<_>>(),
        ["docs/versioned.md"]
    );
}

/// The sibling of the bootstrap case. A version share's `version.create`
/// carries the SOURCE version's files at fork time, redacted to the grant —
/// legitimately empty when that version forked with no files, or when none of
/// its files sit inside the granted paths. The relay serves that op either
/// way (`shareFilter.ts` keeps the op and redacts the list), so refusing it
/// for naming no path reports damage on a healthy share.
///
/// Its version is what scopes it, and that is checked. Each snapshot is
/// scoped by its own path, and there are none.
#[test]
fn share_view_admits_a_granted_version_create_that_carries_no_snapshots() {
    let (_scratch, _path, mut engine) = open_store();
    let boundary = ShareBoundary {
        share_id: "share-view".to_owned(),
        surface: ShareSurface::ShareView,
        channel_wire_id: None,
        granted: Some(ShareGrant {
            paths: vec!["shared/docs".to_owned()],
            version_id: Some("version-granted".to_owned()),
            access: ShareAccess::View,
        }),
    };
    let empty = envelope(
        "granter",
        0,
        "version.create",
        json!({ "versionId": "version-granted", "forkSnapshots": [] }),
    );
    assert!(
        matches!(
            apply_shared_envelope(&mut engine, &boundary, &empty, &NoFaults),
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(_),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ),
        "refusing an empty snapshot list records damage on a healthy version share"
    );
    // The version dimension still decides: another version's create is refused
    // whether or not it carries snapshots.
    let ungranted = envelope(
        "granter",
        1,
        "version.create",
        json!({ "versionId": "version-other", "forkSnapshots": [] }),
    );
    // And it names both versions, like the moment path: a reader who cannot
    // see which lineage was offered against the one granted cannot tell a
    // relay serving the wrong version from a share that was never widened.
    let refusal = apply_shared_envelope(&mut engine, &boundary, &ungranted, &NoFaults);
    assert!(
        matches!(
            &refusal,
            Err(SyncError::ShareVersionMismatch { op_kind, granted, offered })
                if op_kind == "version.create"
                    && granted == "version-granted"
                    && offered == "version-other"
        ),
        "an ungranted create names neither version, so the reader is told only that something was outside the share: {refusal:?}"
    );
    // And it says which operation was refused. This detail is persisted and
    // read back later, so calling a create a moment describes an operation
    // that never happened, on a surface where the op itself is gone.
    let detail = refusal
        .expect_err("an ungranted create is refused")
        .to_string();
    assert!(
        detail.contains("version.create") && !detail.contains("moment"),
        "a refused version.create reports itself as a moment: {detail}"
    );
    // The malformed twin says the same thing: a create whose version id is not
    // one the relay could have issued must not report a moment either.
    let unreadable = envelope(
        "granter",
        2,
        "version.create",
        json!({ "versionId": "  padded  ", "forkSnapshots": [] }),
    );
    let malformed = apply_shared_envelope(&mut engine, &boundary, &unreadable, &NoFaults)
        .expect_err("a create with an unusable version id is refused")
        .to_string();
    assert!(
        malformed.contains("version.create") && !malformed.contains("moment"),
        "a create carrying an unreadable version id reports itself as a moment: {malformed}"
    );
    // A moment that references no path stays refused — and as MALFORMED, not
    // as a scope decision: there is nothing to place, and the grant may well
    // have covered whatever it meant to name.
    let pathless = share_view_moment(json!({ "versionId": "version-granted" }));
    assert!(
        matches!(
            apply_shared_envelope(&mut engine, &boundary, &pathless, &NoFaults),
            Err(SyncError::InvalidInput { .. })
        ),
        "a payload with nothing to place is reported as the share excluding it"
    );
    // Only the explicit empty list is healthy. A missing, null, or non-array
    // field is a payload this boundary cannot read: admitting it would replay
    // a version with no files and commit the cursor past it, which is the
    // silent loss this whole mechanism exists to make visible.
    // An unreadable payload shape is refused, and refused as MALFORMED: the
    // reader's copy for a scope decision names the share and its granter, and
    // neither is at fault for a list the relay sent as something other than a
    // list.
    for malformed in [
        json!({ "versionId": "version-granted" }),
        json!({ "versionId": "version-granted", "forkSnapshots": null }),
        json!({ "versionId": "version-granted", "forkSnapshots": {} }),
        json!({ "versionId": "version-granted", "forkSnapshots": "" }),
        json!({ "forkSnapshots": [] }),
        json!({ "versionId": 7, "forkSnapshots": [] }),
        json!({ "versionId": "version-granted", "forkSnapshots": [{ "blobSha256": "a" }] }),
    ] {
        let op = envelope("granter", 2, "version.create", malformed.clone());
        let outcome = apply_shared_envelope(&mut engine, &boundary, &op, &NoFaults);
        // The code is the contract: it is what gets persisted and what the
        // reader's copy branches on. Any malformed-class variant is right
        // here; a scope claim is not.
        assert!(
            matches!(&outcome, Err(error) if error.code() == "invalid-input"),
            "an unreadable payload is admitted like an empty one, or reported as the share excluding it: {malformed} -> {outcome:?}"
        );
    }
}

/// The relay serves `workspace.init` to every path/version share as its
/// bootstrap op, and the relay's own tests pin that. This recipient needs
/// nothing from it, so it is skipped — but a healthy first pull must not
/// report a refusal, or the banner that says "this share stopped carrying
/// changes" fires on every share the moment it is opened.
#[test]
fn share_view_pull_skips_the_relay_bootstrap_op_without_calling_it_a_refusal() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let body = b"granted body".to_vec();
    let sha = dohc_engine_storage::hex_sha256(&body);
    // A real origin id. The bootstrap op the relay serves carries the
    // granter's own origin, so it reaches the boundary — an empty one would
    // be refused as a malformed envelope first and prove nothing.
    let bootstrap = ShareReplicationEnvelope {
        origin_id: "granter".to_owned(),
        origin_seq: 0,
        op_kind: "workspace.init".to_owned(),
        payload: json!({}),
        recorded_at_ms: 5,
    };
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![bootstrap, share_view_write_op(1, "docs/a.md", &sha)],
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
        .expect("a bootstrap op is skipped, not fatal");

    assert_eq!((outcome.applied, outcome.skipped), (1, 1));
    assert_eq!(
        outcome.refusals,
        Vec::new(),
        "reporting the bootstrap skip as a refusal makes every healthy share look damaged"
    );
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

/// The page-position identity has to be idempotent, or the durable record it
/// exists to feed counts the same skipped op again on every re-pull. A page is
/// fetched at a cursor and the log is append-only, so the same cursor returns
/// the same ops in the same order.
#[test]
fn share_view_pull_files_a_coordinateless_skip_under_a_stable_page_position() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let page = || {
        (
            0,
            ShareViewResponse {
                ops: vec![ShareReplicationEnvelope {
                    origin_id: String::new(),
                    origin_seq: 0,
                    op_kind: "moment.append".to_owned(),
                    payload: json!({ "versionId": "main", "path": "docs/a.md" }),
                    recorded_at_ms: 10,
                }],
                next_cursor: 1,
                has_more: false,
            },
        )
    };
    let client = RelaySyncClient::new(PagedShareRelay::new([], [page()]));

    let first = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .expect("a coordinateless op is skipped, not fatal");
    // The cursor is not committed here, so the next pull re-fetches the page —
    // exactly the retry the record has to survive.
    let again = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .expect("the same page pulls again");

    let identity = |outcome: &ShareViewPullOutcome| {
        outcome
            .refusals
            .iter()
            .map(|refusal| (refusal.origin_id.clone(), refusal.origin_seq))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        identity(&first),
        vec![("\u{1f}share-page:0".to_owned(), 0)],
        "an op with no coordinate of its own is filed under where it sat: {:?}",
        first.refusals
    );
    assert_eq!(
        identity(&again),
        identity(&first),
        "an unstable page identity counts the same skipped op again on every re-pull"
    );
}

/// An op kind this engine cannot interpret is not a scope decision: no grant
/// admits it, widening the share changes nothing, and only the sender can fix
/// it. A known kind a share does not carry is the opposite — chats and secrets
/// are outside what any file share covers.
#[test]
fn share_view_separates_an_unknown_op_kind_from_one_a_share_does_not_carry() {
    let (_scratch, _path, mut engine) = open_store();
    let boundary = share_view_version_boundary(None);
    let unknown = envelope(
        "granter",
        0,
        "future.op",
        json!({ "path": "shared/docs/a.md" }),
    );
    let outcome = apply_shared_envelope(&mut engine, &boundary, &unknown, &NoFaults);
    assert!(
        matches!(&outcome, Err(error) if error.code() == "invalid-input"),
        "an op kind nothing can interpret is reported as the share excluding it, and the reader is sent to a granter who cannot widen a grant to admit it: {outcome:?}"
    );
    // A known kind a share does not carry stays a scope decision.
    let chat = envelope(
        "granter",
        1,
        "chat.message.append",
        json!({ "threadId": "t", "path": "shared/docs/a.md" }),
    );
    assert!(
        matches!(
            apply_shared_envelope(&mut engine, &boundary, &chat, &NoFaults),
            Err(SyncError::ShareBoundaryViolation)
        ),
        "a chat op is reported as unreadable rather than out of scope"
    );
}

/// A refusal is data the recipient persists and reads back, so it has to be
/// well formed whatever it is diagnosing. The relay picks the op kind: an
/// empty one makes the client's strict decode throw, wedging the pull on
/// every retry, and an oversized one lands in the registry and breaks the
/// next workspace listing. Neither is a diagnostic — both are the relay
/// choosing how this client fails.
#[test]
fn share_view_pull_reports_an_unusable_op_kind_under_a_bounded_placeholder() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let client = RelaySyncClient::new(PagedShareRelay::new(
        [],
        [(
            0,
            ShareViewResponse {
                ops: vec![
                    ShareReplicationEnvelope {
                        origin_id: "peer".to_owned(),
                        origin_seq: 0,
                        op_kind: String::new(),
                        payload: json!({ "versionId": "main", "path": "docs/a.md" }),
                        recorded_at_ms: 10,
                    },
                    ShareReplicationEnvelope {
                        origin_id: "peer".to_owned(),
                        origin_seq: 1,
                        op_kind: "k".repeat(200),
                        payload: json!({ "versionId": "main", "path": "docs/b.md" }),
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
        .expect("an unusable op kind is skipped, not fatal");

    assert_eq!(
        outcome
            .refusals
            .iter()
            .map(|refusal| refusal.op_kind.as_str())
            .collect::<Vec<_>>(),
        ["invalid-op-kind", "invalid-op-kind"],
        "copying the relay's op kind wedges the client's decode or poisons its registry: {:?}",
        outcome.refusals
    );
    for refusal in &outcome.refusals {
        // The bounds the recipient's schema enforces, in the unit it counts.
        assert!(!refusal.op_kind.is_empty());
        assert!(refusal.op_kind.encode_utf16().count() <= 128);
        assert!(!refusal.detail.is_empty());
        assert!(refusal.detail.encode_utf16().count() <= 2048);
        // The cause still reaches the reader, and the coordinate is real.
        assert!(refusal.detail.contains("op_kind"), "{}", refusal.detail);
        assert_eq!(refusal.origin_id, "peer");
    }
    // The placeholder took the value away, so the numbers are the only thing
    // left that says how unusable it was: a one-byte overrun and a kilobyte
    // of junk read identically without them.
    assert!(
        outcome.refusals[1].detail.contains("at most 128 bytes")
            && outcome.refusals[1].detail.contains("offered 200 bytes"),
        "the refusal names no limit and no observed size for a value it also hid: {}",
        outcome.refusals[1].detail
    );
    assert!(
        outcome.refusals[0].detail.contains("offered 0 bytes"),
        "an empty op kind measures as zero rather than saying nothing: {}",
        outcome.refusals[0].detail
    );
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

/// An origin id can break its rule three ways, and the refusal must name the
/// one that fired.
///
/// This reader never sees the value — the op is filed under its page position
/// — so the message is all they get. Citing the length bound for a short id
/// carrying a control byte reports a constraint the op satisfied, which reads
/// as a contradiction and sends the reader looking for a size problem that
/// does not exist.
#[test]
fn a_refused_origin_id_names_the_clause_it_broke() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let malformed = |origin_id: String| ShareReplicationEnvelope {
        origin_id,
        origin_seq: 0,
        op_kind: "moment.append".to_owned(),
        payload: json!({ "versionId": "main", "path": "docs/a.md" }),
        recorded_at_ms: 10,
    };
    let oversized = "p".repeat(crate::model::MAX_IDENTIFIER_BYTES + 1);
    let client = RelaySyncClient::new(PagedShareRelay::new(
        [],
        [(
            0,
            ShareViewResponse {
                ops: vec![
                    malformed(String::new()),
                    malformed(oversized),
                    // Short, well under the byte bound, and still refused —
                    // the case a length-only message misreports.
                    malformed("peer\u{1}one".to_owned()),
                ],
                next_cursor: 3,
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
        .expect("malformed ops are skipped, not fatal");

    let details = outcome
        .refusals
        .iter()
        .map(|refusal| refusal.detail.as_str())
        .collect::<Vec<_>>();
    assert_eq!(details.len(), 3, "{details:?}");
    assert!(
        details[0].contains("it is empty") && !details[0].contains("bytes"),
        "an empty origin id is reported against a size bound it did not break: {}",
        details[0]
    );
    assert!(
        details[1].contains(&format!(
            "at most {} bytes, offered {} bytes",
            crate::model::MAX_IDENTIFIER_BYTES,
            crate::model::MAX_IDENTIFIER_BYTES + 1
        )),
        "the one clause that has numbers reports none, so one byte over reads like ten times over: {}",
        details[1]
    );
    assert!(
        details[2].contains("it carries a control byte") && !details[2].contains("bytes,"),
        "a short origin id refused for a control byte is told a length limit it satisfies: {}",
        details[2]
    );
}

/// A sequence outside the wire range is the coordinate's other half, and it is
/// refused for the same reason it cannot be one: the op is filed under its page
/// position, so the reader never sees the value.
///
/// The bare reason names no range and no offered number, which leaves "outside
/// the wire integer range" indistinguishable between a negative sequence, an
/// off-by-one at the boundary, and a number a hundred times too large.
#[test]
fn a_refused_origin_seq_names_the_range_and_what_was_offered() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let out_of_range = |origin_seq: i64| ShareReplicationEnvelope {
        origin_id: "peer".to_owned(),
        origin_seq,
        op_kind: "moment.append".to_owned(),
        payload: json!({ "versionId": "main", "path": "docs/a.md" }),
        recorded_at_ms: 10,
    };
    let client = RelaySyncClient::new(PagedShareRelay::new(
        [],
        [(
            0,
            ShareViewResponse {
                ops: vec![
                    out_of_range(-1),
                    out_of_range(crate::model::MAX_WIRE_INTEGER + 1),
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
        .expect("an out-of-range sequence is skipped, not fatal");

    let range = format!("0 to {} inclusive", crate::model::MAX_WIRE_INTEGER);
    let details = outcome
        .refusals
        .iter()
        .map(|refusal| refusal.detail.as_str())
        .collect::<Vec<_>>();
    assert_eq!(details.len(), 2, "{details:?}");
    assert!(
        details[0].contains(&range) && details[0].contains("offered -1"),
        "a sequence the reader never sees is refused with no range and no offered value: {}",
        details[0]
    );
    assert!(
        details[1].contains(&range)
            && details[1].contains(&format!("offered {}", crate::model::MAX_WIRE_INTEGER + 1)),
        "one past the range reads the same as a number a hundred times too large: {}",
        details[1]
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

/// The aliasing hole itself: a relay origin named exactly like the readable
/// part of a page position.
///
/// Both refusals are durable and both commit their cursor, so they must be two
/// records. Sharing one coordinate would make the recipient's merge read the
/// second as a retry of the first — and an acknowledgement of the first would
/// then hide a later, different refusal that never spoke for itself.
#[test]
fn a_relay_origin_named_like_a_page_position_stays_a_separate_refusal() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let client = RelaySyncClient::new(PagedShareRelay::new(
        [],
        [(
            0,
            ShareViewResponse {
                ops: vec![
                    // A valid relay origin id spelled like the readable part of
                    // a page position, at the sequence the op below sits at.
                    ShareReplicationEnvelope {
                        origin_id: "share-page:0".to_owned(),
                        origin_seq: 1,
                        op_kind: "moment.append".to_owned(),
                        payload: json!({ "versionId": "main" }),
                        recorded_at_ms: 10,
                    },
                    // Index 1 of the page fetched at cursor 0: the synthetic
                    // coordinate the op above is trying to occupy.
                    ShareReplicationEnvelope {
                        origin_id: String::new(),
                        origin_seq: 7,
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
        .expect("malformed ops are skipped, not fatal");

    assert_eq!((outcome.applied, outcome.skipped), (0, 2));
    let coordinates = outcome
        .refusals
        .iter()
        .map(|refusal| (refusal.origin_id.as_str(), refusal.origin_seq))
        .collect::<Vec<_>>();
    assert_eq!(
        coordinates,
        [("share-page:0", 1), ("\u{1f}share-page:0", 1)],
        "a relay origin can occupy a page-position coordinate, so one refusal is merged away as a retry of the other: {coordinates:?}"
    );
}

/// A skipped op must not be a silent one. The pull keeps going — one op a
/// diverging relay serves must not wedge the share — so the only way the
/// recipient learns its shared view stopped carrying a granter's edits is the
/// refusal the outcome carries. It has to hold the constraint, and for a
/// version refusal the limit, the unit and the observed usage.
#[test]
fn share_view_pull_reports_why_it_skipped_a_version_refused_op() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let body = b"granted body".to_vec();
    let sha = dohc_engine_storage::hex_sha256(&body);
    let mismatched = share_view_write_op_on(0, "docs/other.md", &sha, "version-other");
    let mut unusable = share_view_write_op(1, "docs/unusable.md", &sha);
    unusable.payload["versionId"] = json!("\u{1f600}".repeat(MAX_SHARE_VERSION_ID_CHARS / 2 + 1));
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![mismatched, unusable],
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
            &version_grant(["docs"], "version-granted"),
            &NoFaults,
        )
        .expect("refused ops are skipped, not fatal");

    assert_eq!(outcome.skipped, 2);
    assert_eq!(
        outcome
            .refusals
            .iter()
            .map(|refusal| (refusal.origin_seq, refusal.op_kind.as_str(), refusal.code))
            .collect::<Vec<_>>(),
        [
            // A mismatch IS a scope decision: the grant names one version and
            // the op is on another.
            (0, "moment.append", "share-boundary-violation"),
            // An unusable version id is not. The grant may well cover the
            // update, and the client's copy must not send the reader to the
            // granter about a field only the relay can fix.
            (1, "moment.append", "invalid-input")
        ],
        "dropping the refusal detail leaves the caller a bare skipped count, or files a malformed field under the share's scope: {:?}",
        outcome.refusals
    );
    assert!(
        outcome.refusals[0].detail.contains("version-granted")
            && outcome.refusals[0].detail.contains("version-other"),
        "a mismatch must reach the caller naming both versions: {}",
        outcome.refusals[0].detail
    );
    assert!(
        outcome.refusals[1].detail.contains("128 UTF-16 code units")
            && outcome.refusals[1].detail.contains("130 UTF-16 code units"),
        "an unusable version id must reach the caller naming its limit, unit and observed usage: {}",
        outcome.refusals[1].detail
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

/// A share-view DELETE has no second floor. `replay_share_delete` reaches
/// `validate_addressable_plaintext_path`, which deliberately admits secret
/// paths so an absence check answers honestly, so `share.rs`'s boundary is the
/// only gate — a relay-sent delete for a secret path must leave the file.
#[test]
fn share_view_pull_skips_a_secret_path_delete_that_nothing_downstream_would_stop() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let plaintext = "AWS_SECRET_ACCESS_KEY=hunter2";
    seed_text_head(&mut engine, "secret-object", "app/.env", plaintext);
    let client = RelaySyncClient::new(PagedShareRelay::new(
        [],
        [(
            0,
            ShareViewResponse {
                ops: vec![ShareReplicationEnvelope {
                    origin_id: "peer".to_owned(),
                    origin_seq: 0,
                    op_kind: "moment.append".to_owned(),
                    payload: json!({
                        "versionId": "main",
                        "operation": "delete",
                        "path": "app/.env"
                    }),
                    recorded_at_ms: 10,
                }],
                next_cursor: 1,
                has_more: false,
            },
        )],
    ));

    let outcome = client
        // `app` is granted, so the secret classification is the only gate.
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["app"]),
            &NoFaults,
        )
        .expect("a secret delete is skipped, not fatal");

    assert_eq!((outcome.applied, outcome.skipped), (0, 1));
    assert!(
        outcome.changed_paths.is_empty(),
        "continuing into replay reports the secret path as changed"
    );
    assert_eq!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", "app/.env")
            .expect("secret path read is answerable")
            .map(|snapshot| snapshot.text),
        Some(plaintext.to_owned()),
        "continuing into replay lets a relay delete a secret-shadowed file"
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

/// A version share can select NO paths, which grants the whole tracked
/// workspace — the relay's `pathVisibleThroughShare` answers
/// `selector.versionId !== null` for that selector, so the mirror admits every
/// tracked path too.
#[test]
fn share_view_pull_applies_every_tracked_path_under_a_whole_workspace_version_grant() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let first = b"first body".to_vec();
    let second = b"second body".to_vec();
    let first_sha = dohc_engine_storage::hex_sha256(&first);
    let second_sha = dohc_engine_storage::hex_sha256(&second);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![
                        share_view_write_op_on(0, "docs/a.md", &first_sha, "shared-version"),
                        share_view_write_op_on(1, "projects/b.md", &second_sha, "shared-version"),
                    ],
                    next_cursor: 2,
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
            &version_grant([], "shared-version"),
            &NoFaults,
        )
        .expect("a whole-workspace version grant pulls");

    assert_eq!(
        (outcome.applied, outcome.skipped),
        (2, 0),
        "reading a versioned empty-path grant as 'nothing granted' refuses a whole-workspace share"
    );
    assert_eq!(
        share_view_pull_changed(&outcome),
        ["docs/a.md", "projects/b.md"]
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

/// A ShareView boundary with NO grant is not "unscoped", it is closed. The RPC
/// layer already requires a selector; this is the type-level backstop for any
/// caller that builds the boundary directly.
#[test]
fn share_view_boundary_without_a_grant_admits_nothing() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let boundary = crate::ShareBoundary {
        share_id: "share".to_owned(),
        surface: crate::ShareSurface::ShareView,
        channel_wire_id: None,
        granted: None,
    };
    let envelope = ReplicationEnvelope {
        workspace_id: "ws".to_owned(),
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        op_kind: "moment.append".to_owned(),
        payload: json!({"path": "docs/a.md", "operation": "write"}),
        recorded_at_ms: 10,
        relay_seq: None,
    };

    assert!(
        matches!(
            crate::apply_shared_envelope(&mut engine, &boundary, &envelope, &NoFaults),
            Err(SyncError::ShareBoundaryViolation)
        ),
        "an absent grant reading as 'enforce nothing' admits every path"
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

/// A version share grants one version. `version.create` is the only inbound op
/// that still carries a version identity — the relay minimizes a served
/// `moment.append` down to paths, blob and operation — so it is the only one
/// the recipient can check, and it must name the granted version.
#[test]
fn share_view_pull_skips_a_version_create_from_a_version_the_share_did_not_grant() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let granted_body = b"the granted version".to_vec();
    let other_body = b"a version nobody shared".to_vec();
    let granted_sha = dohc_engine_storage::hex_sha256(&granted_body);
    let other_sha = dohc_engine_storage::hex_sha256(&other_body);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![
                        share_view_version_create_op(0, "v1", "docs/a.md", &granted_sha),
                        share_view_version_create_op(1, "v2", "docs/b.md", &other_sha),
                    ],
                    next_cursor: 2,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(granted_sha.clone(), granted_body), (other_sha, other_body)]),
    );

    // A whole-workspace path scope: the version is the only thing separating
    // these two ops, so nothing else can be what refuses the second.
    let granted = ShareGrant {
        paths: Vec::new(),
        version_id: Some("v1".to_owned()),
        access: ShareAccess::View,
    };
    let outcome = client
        .pull_share_view(&mut engine, "ws", "share", &granted, &NoFaults)
        .expect("an ungranted version is skipped, not fatal");

    assert_eq!(
        *client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls"),
        [granted_sha],
        "dropping the version check downloads a blob from a version the share never granted"
    );
    assert_eq!(
        share_view_pull_changed(&outcome),
        ["docs/a.md"],
        "the granted version applies and the other one lands nothing"
    );
    assert_eq!((outcome.applied, outcome.skipped), (1, 1));
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

#[test]
fn share_view_actor_replay_does_not_redownload_completed_blob_prefixes() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let blobs = [b"first".to_vec(), b"second".to_vec(), b"third".to_vec()];
    let snapshots = blobs
        .iter()
        .enumerate()
        .map(|(index, bytes)| {
            json!({
                "path": format!("docs/{index}.md"),
                "blobSha256": dohc_engine_storage::hex_sha256(bytes),
                "contentKind": "text"
            })
        })
        .collect::<Vec<_>>();
    let op = ShareReplicationEnvelope {
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        op_kind: "version.create".to_owned(),
        payload: json!({"versionId": "shared-version", "forkSnapshots": snapshots}),
        recorded_at_ms: 10,
    };
    let relay = PagedShareRelay::new(
        [],
        [(
            0,
            ShareViewResponse {
                ops: vec![op],
                next_cursor: 1,
                has_more: false,
            },
        )],
    )
    .with_view_blobs(
        blobs
            .iter()
            .map(|bytes| (dohc_engine_storage::hex_sha256(bytes), bytes.clone())),
    );
    let client = RelaySyncClient::new(relay);

    client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &version_grant(["docs"], "shared-version"),
            &NoFaults,
        )
        .expect("initial multi-blob pull");
    client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &version_grant(["docs"], "shared-version"),
            &NoFaults,
        )
        .expect("actor-style replay without cursor commit");
    assert_eq!(
        client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls")
            .len(),
        blobs.len(),
        "fetching before the idempotency lookup redownloads the completed prefix"
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

fn share_view_binary_pull(
    engine: &mut EngineStore,
    path: &str,
    bytes: Vec<u8>,
) -> Result<ShareViewPullOutcome, RelayError> {
    let sha256 = dohc_engine_storage::hex_sha256(&bytes);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![share_view_binary_write_op(0, path, &sha256)],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(sha256, bytes)]),
    );
    // The write must sit inside the grant, or the op is skipped and this helper
    // stops exercising the ceiling it exists to test. Granting the exact path
    // keeps that true whatever path a caller passes.
    client.pull_share_view(engine, "ws", "share", &tracked_grant([path]), &NoFaults)
}

/// A shared write reaches the store through `write_binary`, which never passes
/// the bytes through `hydrate_blob_content`. Nothing on that path applied the
/// binary ceiling, so the only floor left was the generic 64 MiB blob store —
/// a share could persist a binary an ordinary capture refuses.
///
/// The refusal is a skip, not a failed pull — `a_refused_shared_blob_does_not
/// _freeze_the_share` holds that half — so this one pins the ceiling and the
/// measurements the skip carries.
///
#[test]
fn an_oversized_shared_binary_is_refused_before_it_reaches_the_store() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let (constraint, limit_bytes) = blob_ceiling(BlobKind::Binary);

    let over_cap = vec![7u8; limit_bytes + 1];
    let over_cap_sha = dohc_engine_storage::hex_sha256(&over_cap);
    let refused = share_view_binary_pull(&mut engine, "docs/over-cap.bin", over_cap)
        .expect("an over-cap shared binary is skipped, not fatal");
    assert_eq!(
        (refused.fetched, refused.applied, refused.skipped),
        (1, 0, 1)
    );
    // The refusal keeps its measurements. The constraint, the limit and the
    // observed usage are what tell a reader which ceiling refused and by how
    // much; a skip that flattened them to "something was skipped" would be
    // unactionable.
    assert_eq!(
        refused
            .refusals
            .iter()
            .map(|refusal| (refusal.code, refusal.detail.as_str()))
            .collect::<Vec<_>>(),
        [(
            "share-blob-over-ceiling",
            format!(
                "shared blob exceeds {constraint}: limit {limit_bytes} bytes, observed {} bytes — docs/over-cap.bin",
                limit_bytes + 1
            )
            .as_str()
        )]
    );
    assert!(
        !engine
            .has_binary_blob(&over_cap_sha)
            .expect("binary blob presence"),
        "an over-cap shared binary must not persist under the 64 MiB store bound"
    );

    // The ceiling must not reject work the store accepts everywhere else.
    let at_cap = vec![7u8; limit_bytes];
    let at_cap_sha = dohc_engine_storage::hex_sha256(&at_cap);
    let outcome = share_view_binary_pull(&mut engine, "docs/at-cap.bin", at_cap)
        .expect("an at-cap shared binary replays");
    assert_eq!((outcome.fetched, outcome.applied), (1, 1));
    assert!(
        engine
            .has_binary_blob(&at_cap_sha)
            .expect("binary blob presence")
    );
}

/// One op the recipient will never apply must not take the whole share with it.
///
/// A binary over the kind ceiling is refused deterministically — the same body
/// comes back on every pull — so aborting there left the share cursor at 0,
/// re-fetched the identical refusal forever, and held every later op in the
/// share behind it with no recipient-side recovery. The cursor records how far
/// the share was read; the refusal records that this op never applied.
///
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

/// The other half of the disposition, and the one that keeps this fix from
/// trading a frozen share for silently dropped data.
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

/// The permanent twin that used to share `BlobInvalid`'s variant and therefore
/// its disposition. An op naming a blob reference that is not a sha256 asks
/// for nothing the relay could serve, so no repair makes it replayable and
/// holding the cursor on it would freeze the share forever.
///
#[test]
fn a_share_op_naming_an_unusable_blob_reference_is_permanent_and_skipped() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");

    let later = b"the update behind the unusable reference".to_vec();
    let later_sha = dohc_engine_storage::hex_sha256(&later);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![
                        share_view_write_op(0, "docs/unusable.md", "not-a-sha256"),
                        share_view_write_op(1, "docs/later.md", &later_sha),
                    ],
                    next_cursor: 2,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(later_sha.clone(), later)]),
    );

    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .expect("an unusable blob reference freezes the share forever");
    assert_eq!(
        (
            outcome.fetched,
            outcome.applied,
            outcome.skipped,
            outcome.pending_cursor.cursor
        ),
        (2, 1, 1, 2)
    );
    assert_eq!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", "docs/later.md")
            .expect("share-view path read is answerable")
            .map(|snapshot| snapshot.text),
        Some("the update behind the unusable reference".to_owned()),
        "the op behind the unusable reference never arrives"
    );
    // The blob was never requested: there is no sha to request.
    assert_eq!(
        *client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls"),
        [later_sha],
        "an unusable reference must not reach the transport"
    );
    assert_eq!(
        outcome
            .refusals
            .iter()
            .map(|refusal| (refusal.origin_seq, refusal.code, refusal.detail.as_str()))
            .collect::<Vec<_>>(),
        [(
            0,
            "invalid-input",
            "share op is not replayable: share write names a blob reference that is not a sha256 — docs/unusable.md"
        )],
        "the skip is counted but the reason never reaches the recipient"
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

/// A rename replays as a write of the new path then a delete of the old one.
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

/// "Too large" is a PERMANENT refusal that commits the cursor past the op, so
/// it may only ever be said about bytes proven to be the ones the op named.
///
/// A relay serving oversized junk for an op that names a small file is the
/// counter-case: measured before the hash, it reads as the granter's file
/// being too big, and the skip drops content the relay can still serve
/// correctly. The transport's own overflow (`blob_body_overflow`, which cannot
/// even report an exact size) is the same claim with even less evidence.
///
#[test]
fn an_oversized_body_that_is_not_the_named_blob_stops_the_pull() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let (_constraint, limit_bytes) = blob_ceiling(BlobKind::Binary);

    // The op names a small file. The relay serves an oversized body for it, so
    // the size is the served junk's and says nothing about the granter's file.
    let named = b"the small file the op actually names".to_vec();
    let named_sha = dohc_engine_storage::hex_sha256(&named);
    let junk = vec![8u8; limit_bytes + 1];
    assert_ne!(
        dohc_engine_storage::hex_sha256(&junk),
        named_sha,
        "the fixture only tests authentication if the served body is not the named one"
    );
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![share_view_binary_write_op(0, "docs/small.bin", &named_sha)],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(named_sha, junk)]),
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
            .expect_err("an unauthenticated oversized body is skipped as permanent"),
        RelayError::BlobInvalid,
        "an oversized body that is not the named blob is an integrity failure, not a ceiling one"
    );
}

/// The record unit must match the cursor unit.
///
/// The recipient's durable record is keyed by origin coordinate and by nothing
/// else (`mergeShareSkippedOps` in `apps/desktop/src/workspaces/registryStore.ts`
/// — membership in `counted` is the only duplicate test). Every blob in one
/// `version.create` shares that coordinate, so one refusal per blob meant the
/// record kept the first and dropped the rest UNCOUNTED: two files gone, a
/// notice saying one, and the cursor already past both.
///
/// So the op is the record. The count leads the detail, because the detail is
/// bounded and a truncated list must still say how many files it is short.
///
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

/// The transport's own overflow is the weakest evidence of all: it stops at its
/// read bound, so it cannot even report an exact size, and the bytes it
/// abandoned were never checked against the sha the op named
/// (`blob_body_overflow`, `crates/dohc-engine-sync-http/src/lib.rs`). Treating
/// that as the granter's file being too big would commit the cursor past an op
/// the relay can still serve correctly.
///
#[test]
fn a_transport_overflow_stops_the_pull_rather_than_skipping_the_op() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");

    let named = b"a perfectly small shared file".to_vec();
    let named_sha = dohc_engine_storage::hex_sha256(&named);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![share_view_write_op(0, "docs/small.md", &named_sha)],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blob_errors([(
            named_sha,
            // Exactly what the HTTP transport raises: no exact size, because it
            // never finished reading the body.
            RelayError::BlobTooLarge {
                constraint: "MAX_INGEST_BLOB_BYTES",
                limit_bytes: 64 * 1024 * 1024,
                observed: ObservedBytes::AtLeast(64 * 1024 * 1024 + 1),
            },
        )]),
    );

    let error = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .expect_err("an unread oversized body is skipped as if it were permanent");
    assert!(
        matches!(error, RelayError::BlobTooLarge { .. }),
        "unexpected refusal: {error:?}"
    );
}

/// The measurements must outlive the bound, whatever the path costs.
///
/// A refusal detail is bounded at `MAX_REFUSAL_DETAIL_UNITS` because the
/// recipient decodes it strictly, and the path inside it is the one part no
/// limit anywhere covers: `classify_share_path` admits a tracked path of any
/// length, so a served op chooses how much of the budget the path eats. With
/// the path first it ate all of it, and the record that committed the cursor
/// past this file named no constraint, no limit, no unit and no usage — the
/// one thing AGENTS.md requires a rejection to carry.
///
/// So the reason goes first and the path goes last. Truncation then costs the
/// tail of a path, which the coordinate and op kind still place, instead of
/// the whole reason.
///
#[test]
fn a_refusal_keeps_its_measurements_when_the_path_exhausts_the_detail_bound() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let (constraint, limit_bytes) = blob_ceiling(BlobKind::Binary);

    // A path the share boundary classifies `Tracked` and that alone overruns
    // the whole detail budget: 40 segments of 60 units is 2,444.
    let long_path = format!("docs/{}/report.bin", "d".repeat(300));
    assert!(
        long_path.encode_utf16().count() > 200,
        "the fixture only tests elision if the path exceeds its detail share"
    );

    let over_cap = vec![6u8; limit_bytes + 1];
    let over_cap_sha = dohc_engine_storage::hex_sha256(&over_cap);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![share_view_binary_write_op(0, &long_path, &over_cap_sha)],
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
            &tracked_grant(["docs"]),
            &NoFaults,
        )
        .expect("an over-cap blob is skipped, not fatal");
    assert_eq!(
        (outcome.fetched, outcome.applied, outcome.skipped),
        (1, 0, 1)
    );
    let detail = outcome.refusals[0].detail.as_str();
    // The bound still holds: the recipient rejects a longer one outright.
    assert!(
        detail.encode_utf16().count() <= crate::relay::MAX_REFUSAL_DETAIL_UNITS,
        "the detail must be bounded to what the recipient can persist"
    );
    // The path is cut to its own budget, not to whatever is left of the
    // detail's. Cut to the detail's, one refusal fills the record and the next
    // one in the same op gets nothing —
    // `a_long_path_does_not_cost_the_next_refusals_measurements` is that case.
    assert!(
        detail.encode_utf16().count() < crate::relay::MAX_REFUSAL_DETAIL_UNITS,
        "the path is unbounded and spends the whole detail budget"
    );
    // And it still opens with the reason, measurements intact.
    assert!(
        detail.starts_with(&format!(
            "shared blob exceeds {constraint}: limit {limit_bytes} bytes, observed {} bytes — docs/",
            limit_bytes + 1
        )),
        "the path pushed the constraint, limit, unit and usage out of the record: {detail}"
    );
}

/// Reason-before-path saved one entry's measurements. It did not save the
/// next entry's.
///
/// A `version.create` refusing several snapshots writes one record, and the
/// entries were concatenated whole: `reason — path; reason — path`. An
/// unbounded path in entry one therefore spent the budget entry two's
/// measurements needed, and the aggregate truncation put the same rejection
/// back that the per-entry order had just removed — one level up.
///
/// So a path gets a budget of its own, and the list stops at the last entry
/// that fits and says how many it did not list. Every entry the record shows
/// is complete. None is ever half-written.
///
#[test]
fn a_long_path_does_not_cost_the_next_refusals_measurements() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let (constraint, limit_bytes) = blob_ceiling(BlobKind::Binary);

    // First snapshot's path alone overruns the whole detail budget.
    let long_path = format!(
        "docs/{}.bin",
        (0..40)
            .map(|index| format!("{}{index:02}", "d".repeat(58)))
            .collect::<Vec<_>>()
            .join("/")
    );
    assert!(
        long_path.encode_utf16().count() > crate::relay::MAX_REFUSAL_DETAIL_UNITS,
        "the fixture only tests the aggregate bound if entry one can exhaust it"
    );

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
                { "path": long_path, "blobSha256": first_sha, "contentKind": "binary" },
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
                    ops: vec![op],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(first_sha, first_over), (second_sha, second_over)]),
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
    let detail = outcome.refusals[0].detail.as_str();
    assert!(
        detail.encode_utf16().count() <= crate::relay::MAX_REFUSAL_DETAIL_UNITS,
        "the detail must stay inside what the recipient can persist"
    );
    // The count still leads.
    assert!(
        detail.starts_with("2 files in this operation were not applied: "),
        "the record must still say how many files it is short: {detail}"
    );
    // And the second file's measurements survived the first file's path.
    assert!(
        detail.contains(&format!(
            "shared blob exceeds {constraint}: limit {limit_bytes} bytes, observed {} bytes — docs/second.bin",
            limit_bytes + 2
        )),
        "entry one's path pushed entry two's constraint, limit, unit and usage out of the record: {detail}"
    );
}

/// One record per coordinate means one code for however many blobs an op
/// refused, so a mixed op has to choose — and it must not choose the one that
/// carries an instruction.
///
/// `share-blob-over-ceiling` sends the reader to the granter for a smaller
/// file. That is right for the oversized snapshot and a false instruction for
/// the one refused because its blob reference is not a sha256, which no
/// smaller file repairs. So a mixed op reports the generic code, which claims
/// nothing it cannot keep, and the detail still names both.
///
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
    // Both are still named, so nothing is hidden by the cautious code.
    for path in ["docs/over-cap.bin", "docs/unusable.md"] {
        assert!(
            refusal.detail.contains(path),
            "the record must still name every file it lost: {}",
            refusal.detail
        );
    }
}

/// Bounding each path is not enough on its own: enough refusals still overrun
/// the record. What must never happen is a HALF-written entry.
///
/// An op can refuse more blobs than the detail can name — a `version.create`
/// carries a snapshot per file. Concatenating them all and letting
/// `ShareViewRefusal::new` cut the tail leaves the last entry sliced through
/// its measurements or its path, and says nothing about the ones past it. So
/// entries are added only while the whole detail still fits, and the record
/// says how many it did not list.
///
/// The invariant: every entry the record shows is complete, and the ones it
/// cannot show are counted. Never a fragment.
///
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

/// A refused blob is fetched once, however many rows of an op name it.
///
/// Skipping per blob made the replay a loop, and `replay_share_write` is keyed
/// by PATH: its request record is per path, and a refused write writes no
/// record at all. So every row naming the same blob downloaded and hashed the
/// whole body again. A 256 KiB `version.create` holds thousands of snapshot
/// rows and a blob runs to the kind ceiling, so one refresh could move
/// gigabytes to reach the same refusal thousands of times — and, because
/// nothing is recorded, move them again on the next pull.
///
/// The decision is a property of the bytes and the kind the op claims for
/// them, not of the path, so it is remembered under that key for the pull.
///
#[test]
fn one_refused_blob_is_fetched_once_however_many_rows_name_it() {
    let (_scratch, _path, mut engine) = open_store();
    seed_replication_version(&mut engine, "main", "main");
    let (_constraint, limit_bytes) = blob_ceiling(BlobKind::Binary);

    let rows = 5;
    let over_cap = vec![3u8; limit_bytes + 1];
    let over_cap_sha = dohc_engine_storage::hex_sha256(&over_cap);
    let snapshots: Vec<serde_json::Value> = (0..rows)
        .map(|index| {
            json!({
                "path": format!("docs/copy-{index}.bin"),
                "blobSha256": over_cap_sha,
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
                    ops: vec![op],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(over_cap_sha.clone(), over_cap)]),
    );

    let outcome = client
        .pull_share_view(
            &mut engine,
            "ws",
            "share",
            &version_grant(["docs"], "shared-version"),
            &NoFaults,
        )
        .expect("the refused rows do not fail the page");
    // Every row is still its own refusal: five files really are missing.
    assert_eq!((outcome.applied, outcome.skipped), (0, rows));
    assert_eq!(
        *client
            .transport()
            .share_blob_calls
            .lock()
            .expect("share blob calls"),
        [over_cap_sha],
        "the same refused body is downloaded and hashed once per row"
    );
    // And the record still names each row, so the saving costs no detail.
    let detail = &outcome.refusals[0].detail;
    for index in 0..rows {
        assert!(
            detail.contains(&format!("docs/copy-{index}.bin")),
            "the record must still name every file it lost: {detail}"
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

    // A shared prefix far longer than one refusal's path budget, so the two
    // paths are identical until well past the cut.
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
/// arrive as `DomainError::InvalidPath`, which the generic `domain` mapping
/// turned into `RelayError::Local("invalid-path")` — no refusal code, so the
/// pull ABORTED. The cursor never committed and every op behind the bad path
/// never arrived (#649, the failure mode).
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

/// The other half of the same answer: a domain failure that is not about the
/// path keeps the pull's abort.
///
/// `replayed_domain` reclassifies exactly one class. A store that was busy or
/// a read that came back corrupt says nothing about the op, and advancing the
/// cursor past it would drop content this recipient can still receive — the
/// dropped-data failure the skip rule exists to avoid.
///
#[test]
fn a_domain_failure_that_is_not_the_path_still_stops_the_pull() {
    use dohc_engine_domain::DomainError;
    use dohc_engine_storage::StorageError;

    // Typed across the replay route, so `store_busy` in the workspace-engine
    // crate answers it the same way it answers every other route. Under
    // `Local("file-locked")` it reached the wire as INTERNAL / retry "no",
    // because that recognizer matches storage variants and a relay error
    // carries none.
    let busy = crate::relay::replayed_domain(DomainError::Storage(StorageError::FileLocked));
    assert_eq!(
        busy,
        RelayError::StoreBusy,
        "the busy store loses its type on the replay route"
    );
    assert_eq!(
        busy.share_replay_refusal_code(),
        None,
        "a busy store is skipped as if it were permanent"
    );
    assert_eq!(
        crate::relay::replayed_domain(DomainError::Storage(StorageError::StateCorrupt {
            source: None
        }))
        .share_replay_refusal_code(),
        None,
        "a corrupt read commits the cursor past content still coming"
    );
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
    // The allowlist is exactly five kinds. `chat.follow.set` and
    // `chat.feed.read.set` are the reader's own state and fall through to the
    // file boundary's terminal deny, the same way they do for a channel share.
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

#[test]
fn share_view_chat_still_refuses_a_file_op_outside_the_grant() {
    // The chat branch must not have widened the file branch on its way in.
    let (_scratch, _path, mut engine, boundary) = share_view_chat_fixture();
    let outside = envelope(
        "granter",
        0,
        "moment.append",
        json!({"versionId":"main","path":"private/out.md"}),
    );
    assert!(matches!(
        apply_shared_envelope(&mut engine, &boundary, &outside, &NoFaults),
        Err(SyncError::ShareBoundaryViolation)
    ));
}

#[test]
fn share_view_refuses_a_thread_create_that_names_no_file_at_all() {
    // A create with NO binding is not a file thread the relay could have
    // served. Without this the boundary would have to invent a path to test,
    // which is how a share admits a thread it never authorized.
    let (_scratch, _path, mut engine, boundary) = share_view_chat_fixture();
    let create = thread_create(0, "thread-bare", json!({}));
    assert!(
        matches!(
            apply_shared_envelope(&mut engine, &boundary, &create, &NoFaults),
            Err(SyncError::InvalidInput { .. })
        ),
        "a create with no linkedPath must be refused, never defaulted",
    );
    assert_eq!(thread_row_path(&engine, "thread-bare"), None);
}

#[test]
fn a_chat_thread_create_naming_its_file_twice_is_refused_on_the_owner_lane() {
    // The share boundary refuses this shape before apply ever sees it, so this
    // covers the other door: the granter's own lane, where a recipient's
    // pushed op arrives through the owner bucket. Reading either half of a
    // doubly-named link would let one op bind one thread to two files.
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    seed_text_head(&mut engine, "object-in", "shared/docs/in.md", "inside");
    let operation = envelope(
        "granter",
        0,
        "chat.thread.create",
        json!({
            "threadId": "thread-double",
            "title": "Double",
            "createdAtMs": 1,
            "linkedAtMs": 1,
            "linkedObjectId": "object-in",
            "linkedPath": "shared/docs/in.md",
        }),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
    let rows: i64 = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM chat_threads WHERE workspace_id='ws' AND thread_id='thread-double'",
                [],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("thread row count");
    assert_eq!(rows, 0);
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
        "share:share-1:recipient",
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

/// The same op when the path names nothing this workspace tracks. Refused, and
/// recorded — a thread bound to no file would read as a channel thread with no
/// channel.
#[test]
fn a_recipient_thread_create_for_an_untracked_path_is_refused_on_the_owner_lane() {
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    let operation = envelope(
        "share:share-1:recipient",
        0,
        "chat.thread.create",
        json!({
            "threadId": "thread-orphan",
            "title": "About a file that moved",
            "createdAtMs": 1,
            "linkedAtMs": 1,
            "linkedPath": "shared/docs/renamed-away.md",
        }),
    );
    assert_invalid_refusal!(apply_chat_envelope(&mut engine, &operation, &NoFaults));
}

/// P1 (review of bcdc31e0). A grant with NO paths is a version share, and
/// `path_within_grant` reads an empty path list as "every tracked path". For
/// files that is bounded by the version check; chat has no version to check,
/// so the same rule would admit the discussion about every file on main.
#[test]
fn share_view_carries_no_chat_through_a_version_share() {
    let (_scratch, _path, mut engine, _boundary) = share_view_chat_fixture();
    let version_only = ShareBoundary {
        share_id: "share-version".to_owned(),
        surface: ShareSurface::ShareView,
        channel_wire_id: None,
        granted: Some(ShareGrant {
            paths: Vec::new(),
            version_id: Some("v1".to_owned()),
            access: crate::ShareAccess::Comment,
        }),
    };
    let create = thread_create(0, "thread-in", json!({ "linkedPath": "shared/docs/in.md" }));
    assert!(
        matches!(
            apply_shared_envelope(&mut engine, &version_only, &create, &NoFaults),
            Err(SyncError::ShareBoundaryViolation)
        ),
        "a version share must carry no conversation about any file",
    );
    assert_eq!(thread_row_path(&engine, "thread-in"), None);
}

/// The allowlist and the match arms that act on it must name the same kinds.
///
/// The previous version of this test asserted the outcome was not
/// `UnsupportedOperation`, which both the chat branch and the terminal deny
/// satisfy — it could not fail for the mutation it was labelled with. This one
/// makes the dispatch observable: an in-grant op of each kind must apply, and
/// the terminal deny can never produce that.
#[test]
fn share_view_chat_kinds_and_the_boundary_match_agree() {
    use crate::share::SHARE_VIEW_CHAT_KINDS;
    let (_scratch, _path, mut engine, boundary) = share_view_chat_fixture();

    // The thread and message the last three kinds hang off, applied through
    // the same boundary so nothing is planted behind it.
    apply_shared_envelope(
        &mut engine,
        &boundary,
        &thread_create(
            0,
            "thread-kinds",
            json!({ "linkedPath": "shared/docs/in.md" }),
        ),
        &NoFaults,
    )
    .expect("create applies");
    apply_shared_envelope(
        &mut engine,
        &boundary,
        &thread_message(1, "thread-kinds", "m-kinds"),
        &NoFaults,
    )
    .expect("message applies");

    let payload_for = |kind: &str| match kind {
        "chat.reaction.set" => json!({
            "reactionId": "r-kinds",
            "messageId": "m-kinds",
            "threadId": "thread-kinds",
            "emoji": "👍",
            "authorId": "u",
            "authorKind": "human",
            "authorDisplayName": "U",
            "state": "added",
            "atMs": 10,
        }),
        "chat.decision.set" => json!({
            "threadId": "thread-kinds",
            "messageId": "m-kinds",
            "state": "open",
            "atMs": 10,
        }),
        "chat.attachment.add" => json!({
            "attachmentId": "a-kinds",
            "threadId": "thread-kinds",
            "messageId": "m-kinds",
            "targetKind": "file",
            "createdAtMs": 10,
        }),
        other => panic!("no payload for {other}"),
    };

    let mut seq = 2_i64;
    for kind in SHARE_VIEW_CHAT_KINDS {
        // The first two already applied above; the rest apply here. Every kind
        // on the list must reach the chat branch and be applied by it.
        if kind == "chat.thread.create" || kind == "chat.message.append" {
            continue;
        }
        let outcome = apply_shared_envelope(
            &mut engine,
            &boundary,
            &envelope("granter", seq, kind, payload_for(kind)),
            &NoFaults,
        )
        .unwrap_or_else(|error| panic!("{kind} was refused: {error:?}"));
        assert!(
            matches!(
                outcome,
                ApplyOutcome {
                    primary: ApplyDisposition::Applied(_),
                    refusals: ref outcome_refusals,
                    sharing_declined: ref outcome_sharing_declined,
                } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
            ),
            "{kind} is on SHARE_VIEW_CHAT_KINDS but the match does not apply it",
        );
        seq += 1;
    }
}

/// The other half of the accept-door conversion: a
/// recipient's create reaches the GRANTER naming the granter's own object,
/// because the relay converted it. It takes the ordinary object lane — the
/// same one the granter's own creates take — with no share context needed.
#[test]
fn a_recipient_thread_create_arrives_object_bound_on_the_owner_lane() {
    let (_scratch, _path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    seed_text_head(&mut engine, "granter-object", "shared/docs/in.md", "inside");
    let operation = envelope(
        "share:share-1:recipient",
        0,
        "chat.thread.create",
        json!({
            "threadId": "thread-from-recipient",
            "title": "A question",
            "createdAtMs": 1,
            "linkedAtMs": 1,
            "linkedObjectId": "granter-object",
        }),
    );
    apply_chat_envelope(&mut engine, &operation, &NoFaults).expect("recipient thread applies");
    let bound: Option<String> = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT linked_object_id FROM chat_threads \
                 WHERE workspace_id='ws' AND thread_id='thread-from-recipient'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(SyncError::corrupt)
        })
        .expect("thread row");
    assert_eq!(bound.as_deref(), Some("granter-object"));
}

/// The same composability question on the recipient's side, at both of its
/// denial sites. `paths` and `versionId` are independent dimensions, so the
/// paths-only rule must key on "names no paths" — never on "names a version".
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

fn recorded_origin(engine: &EngineStore) -> Option<String> {
    engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT origin_id FROM sync_identity WHERE workspace_id='ws'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(SyncError::corrupt)
        })
        .expect("read identity")
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

/// A read-only share records no identity, and the identity half of the
/// predicate is what keeps its writes local. This covers both View and
/// Comment at the storage boundary; the runtime level test pins each answer.
///
/// This is also the safety test for that conjunct.
/// `journal_local_payload_json_in_tx` Refuses without an identity, and the
/// refusal rolls the user's edit back with it — so a predicate that answered
/// true here would not journal a moment, it would destroy the write.
#[test]
fn a_read_only_share_view_enrols_nothing_and_its_writes_stay_local() {
    let (_scratch, _path, mut engine) = open_store();
    seed_share_view_cursor(&mut engine, "share-view-only");
    assert_eq!(
        recorded_origin(&engine),
        None,
        "a read-only share must never be given an identity",
    );
    assert_eq!(
        lane_answers(&mut engine),
        (false, false),
        "a share cursor without an identity must journal nothing",
    );
}

#[test]
fn enrolling_twice_keeps_the_first_identity() {
    let (_scratch, _path, mut engine) = open_store();
    seed_share_view_cursor(&mut engine, "share-comment");
    assert_eq!(
        record(&mut engine, "origin-first"),
        ShareViewIdentityOutcome::Recorded
    );
    assert_eq!(
        record(&mut engine, "origin-second"),
        ShareViewIdentityOutcome::AlreadyRecorded,
        "a refresh must not re-mint an origin",
    );
    assert_eq!(
        recorded_origin(&engine).as_deref(),
        Some("origin-first"),
        "a second origin would split this replica's log in two",
    );
}

/// Which lane makes a workspace journal, read through both real predicates.
///
/// The driver is the recorded Edit lane, because that is the fact. An earlier
/// revision keyed the share term on `EXISTS(sync_identity)`. The unrelated
/// identity row below is the case that proxy got wrong: an identity alone
/// cannot prove that a share view may send file changes.
///
/// The OWNER-lane predicate — which the Y.Doc lanes, the conflict outbox and
/// cursor advancement read — must stay false for every share view. Nothing
/// drains a `ydoc.update` from one, so widening it would leave rows in the
/// recipient's database forever.
///
/// The shared-channel rows are the term this PR deliberately did not add: a
/// channel is joined by an ordinary workspace, so counting it would make
/// every local file moment journal in a workspace whose owner never enabled
/// cloud sync.
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

/// Which predicate each journal site reads.
///
/// This is a POSITION pin, and its limits are worth stating: it greps source
/// TEXT, so it cannot see a call reached through an alias or a helper, and it
/// says nothing about a site in a file it does not name. It is here because
/// the behavioural version is not cheap — journaling a `ydoc.update` needs a
/// live session settling with an exact lineage claim, which no share-view
/// fixture in this repo builds. Its sibling above proves the two predicates
/// genuinely disagree for a share view; this proves each site asks the one it
/// should.
///
/// What it protects: a share carries the ops the share covers, so a
/// `ydoc.update` journaled in a share view is a row nothing ever drains. The
/// same holds for the conflict outbox and cursor advancement. A recovered
/// FILE moment is the opposite case — an edit share can drain it through the
/// proposal submit — so `ydoc_recovery` is pinned to the other predicate.
#[test]
fn the_ydoc_journal_reads_the_owner_lane_predicate() {
    for (label, source) in [
        ("ydoc_apply", include_str!("../ydoc_apply.rs")),
        ("ydoc_origination", include_str!("../ydoc_origination.rs")),
        ("conflict_outbox", include_str!("../conflict_outbox.rs")),
        ("cursor", include_str!("../cursor.rs")),
    ] {
        assert!(
            source.contains("workspace_replicates_with_relay_in_tx"),
            "{label} must ask the OWNER-lane predicate",
        );
        assert!(
            !source.contains("workspace_journals_file_moments_in_tx"),
            "{label} must NOT read the share lane — a share cannot \
             carry what it journals, so the rows would never drain",
        );
    }
    // The other direction. A recovered FILE moment is drainable by an edit
    // share, so this site must ask the same question the ordinary moment
    // journal asks. The two disagreeing would strand a recovered change the
    // recipient can see and never send.
    let recovery = include_str!("../ydoc_recovery.rs");
    assert!(
        recovery.contains("workspace_journals_file_moments_in_tx"),
        "the recovery moment journal must read the share lane",
    );
    assert!(
        !recovery.contains("workspace_replicates_with_relay_in_tx"),
        "the recovery moment journal must not fall back to the owner lane",
    );
}
