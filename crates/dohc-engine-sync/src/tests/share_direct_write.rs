use super::share_proposal::{
    journal_local_moment, local_moment_payload, proposal_fixture, proposal_grant,
};
use super::*;

// ---------------------------------------------------------------------------
// The recipient writes a Collection's own files directly (ADR 0013).
// ---------------------------------------------------------------------------

const SHARE: &str = "share-direct";

fn edit_grant() -> ShareGrant {
    proposal_grant(crate::ShareAccess::Edit)
}

fn push(
    client: &RelaySyncClient<PagedShareRelay>,
    engine: &mut EngineStore,
) -> DirectWritePushOutcome {
    client
        .push_direct_writes(engine, "ws", SHARE, &edit_grant(), &NoFaults, 0)
        .expect("direct push")
}

fn propose(
    client: &RelaySyncClient<PagedShareRelay>,
    engine: &mut EngineStore,
    submit_id: &str,
) -> ShareProposalSubmitOutcome {
    client
        .submit_share_proposal(engine, "ws", SHARE, &edit_grant(), submit_id, &NoFaults, 0)
        .expect("proposal submit")
}

fn written_paths(client: &RelaySyncClient<PagedShareRelay>) -> Vec<Vec<String>> {
    client
        .transport()
        .collection_writes
        .lock()
        .expect("writes")
        .iter()
        .map(|write| {
            write
                .changes
                .iter()
                .filter_map(|change| change.after_path.clone())
                .collect()
        })
        .collect()
}

fn proposed_paths(client: &RelaySyncClient<PagedShareRelay>) -> Vec<String> {
    client
        .transport()
        .proposal_submits
        .lock()
        .expect("submits")
        .iter()
        .flat_map(|submit| submit.ops.iter())
        .filter_map(|op| op.after_path.clone())
        .collect()
}

fn edit_moment(
    moment: &str,
    object: &str,
    path: &str,
    before: &str,
    after: &str,
) -> serde_json::Value {
    local_moment_payload(moment, object, "write", Some((path, before)), path, after)
}

fn create_moment(moment: &str, object: &str, path: &str, text: &str) -> serde_json::Value {
    local_moment_payload(moment, object, "write", None, path, text)
}

/// A schema this replica holds on main, as a pulled file would be.
fn hold_schema(engine: &mut EngineStore, folder: &str) {
    VersionedTextStore::new(engine)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: format!("pulled-{folder}"),
                path: format!("{folder}/collection.yaml"),
                text: "fields: {}\n".to_owned(),
                moment_id: format!("pulled-moment-{folder}"),
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1_500,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("pulled schema");
}

#[test]
fn direct_push_writes_a_schema_edit_and_send_changes_never_offers_it() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2", "v3"]);
    let schema = "shared/docs/packing/collection.yaml";
    journal_local_moment(
        &mut engine,
        &edit_moment("m-1", "object-schema", schema, "v1", "v2"),
        1_001,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    let outcome = push(&client, &mut engine);
    assert_eq!(
        outcome.writes,
        vec![DirectWriteReport {
            paths: vec![schema.to_owned()],
            result: DirectWriteResult::Written,
        }],
    );
    let writes = client
        .transport()
        .collection_writes
        .lock()
        .expect("writes")
        .clone();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].changes[0].based_on_blob_sha256.as_deref(),
        Some(dohc_engine_storage::hex_sha256(b"v1").as_str()),
        "the write states the content the recipient read",
    );
    assert!(writes[0].submit_id.starts_with("direct-"));

    assert_eq!(
        propose(&client, &mut engine, "submit-1").submitted,
        0,
        "a written file is not offered again"
    );

    // A later edit is offered, based on what the direct lane wrote.
    journal_local_moment(
        &mut engine,
        &edit_moment("m-2", "object-schema", schema, "v2", "v3"),
        1_002,
    );
    let before_push = push(&client, &mut engine);
    assert_eq!(
        before_push.writes.len(),
        1,
        "the direct lane takes the later edit too"
    );
    journal_local_moment(
        &mut engine,
        &edit_moment("m-3", "object-schema", schema, "v3", "v1"),
        1_003,
    );
    assert_eq!(propose(&client, &mut engine, "submit-2").submitted, 1);
    let submits = client
        .transport()
        .proposal_submits
        .lock()
        .expect("submits")
        .clone();
    assert_eq!(
        submits[0].ops[0].based_on_blob_sha256.as_deref(),
        Some(dohc_engine_storage::hex_sha256(b"v3").as_str()),
        "the proposal builds on the last content the direct lane wrote",
    );
}

#[test]
fn direct_push_leaves_every_other_change_on_proposals() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2", "note", "moved"]);
    let schema = "shared/docs/packing/collection.yaml";
    journal_local_moment(
        &mut engine,
        &edit_moment("m-1", "object-schema", schema, "v1", "v2"),
        1_001,
    );
    journal_local_moment(
        &mut engine,
        &create_moment("m-2", "object-note", "shared/docs/packing/a.md", "note"),
        1_002,
    );
    // A moved schema and an automations file in a folder that is no
    // Collection stay on proposals.
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-3",
            "object-moved",
            "write",
            Some(("shared/docs/old/collection.yaml", "v1")),
            "shared/docs/new/collection.yaml",
            "moved",
        ),
        1_003,
    );
    journal_local_moment(
        &mut engine,
        &create_moment(
            "m-4",
            "object-auto",
            "shared/docs/plain/automations.yaml",
            "note",
        ),
        1_004,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    push(&client, &mut engine);
    assert_eq!(written_paths(&client), vec![vec![schema.to_owned()]]);

    propose(&client, &mut engine, "submit-1");
    let mut proposed = proposed_paths(&client);
    proposed.sort();
    assert_eq!(
        proposed,
        vec![
            "shared/docs/new/collection.yaml",
            "shared/docs/packing/a.md",
            "shared/docs/plain/automations.yaml",
        ],
    );
}

#[test]
fn direct_push_writes_automations_beside_a_collection() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["rules"]);
    hold_schema(&mut engine, "shared/docs/packing");
    journal_local_moment(
        &mut engine,
        &create_moment(
            "m-1",
            "object-auto",
            "shared/docs/packing/automations.yaml",
            "rules",
        ),
        1_001,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    push(&client, &mut engine);
    assert_eq!(
        written_paths(&client),
        vec![vec!["shared/docs/packing/automations.yaml".to_owned()]],
    );
}

#[test]
fn direct_push_sends_a_new_collection_as_one_batch_schema_first() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["a", "b", "rules", "schema", "image"]);
    let folder = "shared/docs/ideas";
    journal_local_moment(
        &mut engine,
        &create_moment("m-1", "object-a", &format!("{folder}/a.md"), "a"),
        1_001,
    );
    journal_local_moment(
        &mut engine,
        &create_moment("m-2", "object-b", &format!("{folder}/B.MD"), "b"),
        1_002,
    );
    journal_local_moment(
        &mut engine,
        &create_moment(
            "m-3",
            "object-rules",
            &format!("{folder}/automations.yaml"),
            "rules",
        ),
        1_003,
    );
    journal_local_moment(
        &mut engine,
        &create_moment(
            "m-4",
            "object-schema",
            &format!("{folder}/collection.yaml"),
            "schema",
        ),
        1_004,
    );
    journal_local_moment(
        &mut engine,
        &create_moment(
            "m-5",
            "object-image",
            &format!("{folder}/notes.txt"),
            "image",
        ),
        1_005,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    push(&client, &mut engine);
    assert_eq!(
        written_paths(&client),
        vec![vec![
            format!("{folder}/collection.yaml"),
            format!("{folder}/automations.yaml"),
            format!("{folder}/a.md"),
            format!("{folder}/B.MD"),
        ]],
    );
    let calls = client
        .transport()
        .proposal_calls
        .lock()
        .expect("calls")
        .clone();
    assert_eq!(
        calls.last().map(String::as_str),
        Some("write"),
        "content travels before the write"
    );

    propose(&client, &mut engine, "submit-1");
    assert_eq!(proposed_paths(&client), vec![format!("{folder}/notes.txt")]);
}

#[test]
fn a_stale_or_refused_write_is_not_sent_again_and_stays_available_to_send_changes() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2"]);
    let first = "shared/docs/one/collection.yaml";
    let second = "shared/docs/two/collection.yaml";
    journal_local_moment(
        &mut engine,
        &edit_moment("m-1", "object-one", first, "v1", "v2"),
        1_001,
    );
    journal_local_moment(
        &mut engine,
        &edit_moment("m-2", "object-two", second, "v1", "v2"),
        1_002,
    );
    let relay = PagedShareRelay::new([], []);
    relay
        .collection_write_answers
        .lock()
        .expect("answers")
        .extend([
            Ok(ShareCollectionWriteResponse::Stale {
                path: first.to_owned(),
                current_blob_sha256: Some("f".repeat(64)),
            }),
            Ok(ShareCollectionWriteResponse::Refused {
                reason: "not a valid collection.yaml".to_owned(),
            }),
        ]);
    let client = RelaySyncClient::new(relay);

    let outcome = push(&client, &mut engine);
    assert_eq!(
        outcome
            .writes
            .iter()
            .map(|write| write.result.clone())
            .collect::<Vec<_>>(),
        vec![
            DirectWriteResult::Stale {
                path: first.to_owned(),
                current_blob_sha256: Some("f".repeat(64)),
            },
            DirectWriteResult::Refused {
                reason: "not a valid collection.yaml".to_owned(),
            },
        ],
    );
    assert!(
        push(&client, &mut engine).writes.is_empty(),
        "a decided write is not sent again"
    );
    assert_eq!(written_paths(&client).len(), 2);

    propose(&client, &mut engine, "submit-1");
    let mut proposed = proposed_paths(&client);
    proposed.sort();
    assert_eq!(proposed, vec![first, second]);
}

#[test]
fn a_write_whose_answer_was_lost_is_sent_again_as_the_same_request_after_another_edit() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2", "v3"]);
    let schema = "shared/docs/packing/collection.yaml";
    journal_local_moment(
        &mut engine,
        &edit_moment("m-1", "object-schema", schema, "v1", "v2"),
        1_001,
    );
    let relay = PagedShareRelay::new([], []);
    relay
        .collection_write_answers
        .lock()
        .expect("answers")
        .push_back(Err(RelayError::HttpStatus(429)));
    let client = RelaySyncClient::new(relay);

    // The relay may have taken the write; its answer never arrived.
    assert_eq!(
        client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0),
        Err(RelayError::HttpStatus(429)),
    );
    // Another edit before the next push does not change the write in flight.
    journal_local_moment(
        &mut engine,
        &edit_moment("m-2", "object-schema", schema, "v2", "v3"),
        1_002,
    );
    assert_eq!(push(&client, &mut engine).writes.len(), 1);
    let writes = client
        .transport()
        .collection_writes
        .lock()
        .expect("writes")
        .clone();
    assert_eq!(writes.len(), 2);
    assert_eq!(
        writes[0], writes[1],
        "a retry sends the request it recorded, under its submit id"
    );
    // The later edit goes in the next push, based on what was written.
    assert_eq!(push(&client, &mut engine).writes.len(), 1);
    let writes = client
        .transport()
        .collection_writes
        .lock()
        .expect("writes")
        .clone();
    assert_eq!(writes.len(), 3);
    assert_eq!(
        writes[2].changes[0].based_on_blob_sha256.as_deref(),
        Some(dohc_engine_storage::hex_sha256(b"v2").as_str()),
    );
    assert_ne!(writes[2].submit_id, writes[0].submit_id);
}

#[test]
fn a_later_write_that_fails_keeps_an_earlier_one_delivered_and_holds_send_changes() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2"]);
    let first = "shared/docs/one/collection.yaml";
    let second = "shared/docs/two/collection.yaml";
    journal_local_moment(
        &mut engine,
        &edit_moment("m-1", "object-one", first, "v1", "v2"),
        1_001,
    );
    journal_local_moment(
        &mut engine,
        &edit_moment("m-2", "object-two", second, "v1", "v2"),
        1_002,
    );
    let relay = PagedShareRelay::new([], []);
    relay
        .collection_write_answers
        .lock()
        .expect("answers")
        .extend([
            Ok(ShareCollectionWriteResponse::Written {
                paths: vec![first.to_owned()],
            }),
            Err(RelayError::ServerInternal),
        ]);
    let client = RelaySyncClient::new(relay);

    assert_eq!(
        client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0),
        Err(RelayError::ServerInternal),
    );
    // The first write is delivered, and the second is still open: Send
    // changes offers neither, and stops before the open one.
    let outcome = propose(&client, &mut engine, "submit-1");
    assert_eq!(outcome.submitted, 0);
    assert!(outcome.more_pending);

    // The next push sends only the open write, and reports both.
    let pushed = push(&client, &mut engine);
    assert_eq!(
        pushed
            .writes
            .iter()
            .map(|write| write.paths.clone())
            .collect::<Vec<_>>(),
        vec![vec![first.to_owned()], vec![second.to_owned()]],
    );
    assert_eq!(
        written_paths(&client),
        vec![
            vec![first.to_owned()],
            vec![second.to_owned()],
            vec![second.to_owned()],
        ]
    );
    assert_eq!(propose(&client, &mut engine, "submit-2").submitted, 0);
}

#[test]
fn a_relay_that_does_not_take_direct_writes_leaves_the_change_to_send_changes() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2"]);
    let schema = "shared/docs/packing/collection.yaml";
    journal_local_moment(
        &mut engine,
        &edit_moment("m-1", "object-schema", schema, "v1", "v2"),
        1_001,
    );
    let relay = PagedShareRelay::new([], []);
    relay
        .collection_write_answers
        .lock()
        .expect("answers")
        .push_back(Err(RelayError::ShareUnavailable));
    let client = RelaySyncClient::new(relay);

    assert_eq!(
        client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0),
        Err(RelayError::ShareUnavailable),
    );
    // No write is left open, so Send changes offers the change.
    assert_eq!(propose(&client, &mut engine, "submit-1").submitted, 1);
    assert_eq!(proposed_paths(&client), vec![schema.to_owned()]);
}

#[test]
fn an_upload_the_grant_can_no_longer_make_leaves_the_change_to_send_changes() {
    for (error, dropped) in [
        (RelayError::ShareReadOnly, true),
        (RelayError::Forbidden, true),
        (RelayError::Partitioned, false),
    ] {
        let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2"]);
        let schema = "shared/docs/packing/collection.yaml";
        journal_local_moment(
            &mut engine,
            &edit_moment("m-1", "object-schema", schema, "v1", "v2"),
            1_001,
        );
        let relay = PagedShareRelay::new([], []);
        relay
            .blob_upload_errors
            .lock()
            .expect("upload errors")
            .push_back(error.clone());
        let client = RelaySyncClient::new(relay);

        assert_eq!(
            client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0),
            Err(error.clone()),
        );
        assert!(written_paths(&client).is_empty(), "{error:?}");
        // A lasting no drops the plan, so Send changes offers the change. A
        // failure that may pass keeps it, and Send changes waits.
        let proposed = propose(&client, &mut engine, "submit-1").submitted;
        assert_eq!(proposed, usize::from(dropped), "{error:?}");
    }
}

#[test]
fn a_refused_edit_after_a_delivered_create_keeps_the_create_delivered() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["rules", "rules two"]);
    hold_schema(&mut engine, "shared/docs/packing");
    let path = "shared/docs/packing/automations.yaml";
    journal_local_moment(
        &mut engine,
        &create_moment("m-1", "object-auto", path, "rules"),
        1_001,
    );
    let relay = PagedShareRelay::new([], []);
    let client = RelaySyncClient::new(relay);
    assert_eq!(
        push(&client, &mut engine).writes[0].result,
        DirectWriteResult::Written
    );

    journal_local_moment(
        &mut engine,
        &edit_moment("m-2", "object-auto", path, "rules", "rules two"),
        1_002,
    );
    client
        .transport()
        .collection_write_answers
        .lock()
        .expect("answers")
        .push_back(Ok(ShareCollectionWriteResponse::Refused {
            reason: "changes an automation with a personal step".to_owned(),
        }));
    assert!(matches!(
        push(&client, &mut engine).writes[0].result,
        DirectWriteResult::Refused { .. }
    ));

    // Deleting the file leaves a delete for Send changes, based on the
    // content the direct lane delivered.
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-3",
            "object-auto",
            "delete",
            Some((path, "rules two")),
            path,
            "rules two",
        ),
        1_003,
    );
    assert_eq!(propose(&client, &mut engine, "submit-1").submitted, 1);
    let submits = client
        .transport()
        .proposal_submits
        .lock()
        .expect("submits")
        .clone();
    let op = &submits[0].ops[0];
    assert_eq!(op.operation, "delete");
    assert_eq!(op.based_on_path.as_deref(), Some(path));
    assert_eq!(
        op.based_on_blob_sha256.as_deref(),
        Some(dohc_engine_storage::hex_sha256(b"rules").as_str()),
    );
}

#[test]
fn a_new_collection_batch_stops_at_its_byte_bound_and_at_a_second_spelling() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["schema", "a", "b", "c"]);
    let folder = "shared/docs/ideas";
    let big = |moment: &str, object: &str, name: &str, text: &str| {
        let mut payload = create_moment(moment, object, &format!("{folder}/{name}"), text);
        payload["payloadAfterByteLength"] = json!(3 * 1024 * 1024);
        payload
    };
    journal_local_moment(
        &mut engine,
        &create_moment(
            "m-1",
            "object-schema",
            &format!("{folder}/collection.yaml"),
            "schema",
        ),
        1_001,
    );
    journal_local_moment(&mut engine, &big("m-2", "object-a", "a.md", "a"), 1_002);
    journal_local_moment(&mut engine, &big("m-3", "object-b", "b.md", "b"), 1_003);
    journal_local_moment(
        &mut engine,
        &create_moment("m-4", "object-c", &format!("{folder}/A.MD"), "c"),
        1_004,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    push(&client, &mut engine);
    assert_eq!(
        written_paths(&client),
        vec![vec![
            format!("{folder}/collection.yaml"),
            format!("{folder}/a.md")
        ]],
        "b.md does not fit the batch, and A.MD is a.md on some disks",
    );
    propose(&client, &mut engine, "submit-1");
    let mut proposed = proposed_paths(&client);
    proposed.sort();
    assert_eq!(
        proposed,
        vec![format!("{folder}/A.MD"), format!("{folder}/b.md")]
    );
}

#[test]
fn a_scan_of_nothing_but_new_collections_still_moves_on() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["schema"]);
    let count = crate::MAX_SHARE_PROPOSAL_OPS + 1;
    for index in 0..count {
        journal_local_moment(
            &mut engine,
            &create_moment(
                &format!("m-{index}"),
                &format!("object-{index}"),
                &format!("shared/docs/c{index}/collection.yaml"),
                "schema",
            ),
            1_001,
        );
    }
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    let first = push(&client, &mut engine);
    assert_eq!(first.writes.len(), crate::MAX_SHARE_PROPOSAL_OPS);
    assert!(first.more_pending);
    let second = push(&client, &mut engine);
    assert_eq!(second.writes.len(), 1);
    assert!(!second.more_pending);
    assert_eq!(written_paths(&client).len(), count);
}

#[test]
fn an_open_write_does_not_stop_send_changes_below_what_was_delivered() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2", "v3", "note"]);
    let schema = "shared/docs/packing/collection.yaml";
    journal_local_moment(
        &mut engine,
        &edit_moment("m-1", "object-schema", schema, "v1", "v2"),
        1_001,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    assert_eq!(push(&client, &mut engine).writes.len(), 1);

    // A plain file, then another schema edit whose write stays open.
    journal_local_moment(
        &mut engine,
        &create_moment("m-2", "object-note", "shared/docs/packing/a.md", "note"),
        1_002,
    );
    journal_local_moment(
        &mut engine,
        &edit_moment("m-3", "object-schema", schema, "v2", "v3"),
        1_003,
    );
    client
        .transport()
        .collection_write_answers
        .lock()
        .expect("answers")
        .push_back(Err(RelayError::ServerInternal));
    assert_eq!(
        client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0),
        Err(RelayError::ServerInternal),
    );
    // Send changes reads past the delivered edit and offers the plain file,
    // then stops at the open edit.
    let outcome = propose(&client, &mut engine, "submit-1");
    assert_eq!(outcome.submitted, 1);
    assert!(outcome.more_pending);
    assert_eq!(
        proposed_paths(&client),
        vec!["shared/docs/packing/a.md".to_owned()]
    );
}

#[test]
fn only_a_failure_that_may_pass_keeps_the_plan() {
    for (error, kept) in [
        (RelayError::ShareUnavailable, false),
        (RelayError::ShareReadOnly, false),
        (RelayError::Forbidden, false),
        (RelayError::BadRequest, false),
        (RelayError::PayloadTooLarge, false),
        (RelayError::Conflict, false),
        (RelayError::Partitioned, true),
        (RelayError::ServerInternal, true),
        (RelayError::HttpStatus(429), true),
        (RelayError::HttpStatus(503), true),
        (RelayError::BlobReferenceMissing, true),
    ] {
        let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2"]);
        let schema = "shared/docs/packing/collection.yaml";
        journal_local_moment(
            &mut engine,
            &edit_moment("m-1", "object-schema", schema, "v1", "v2"),
            1_001,
        );
        let relay = PagedShareRelay::new([], []);
        relay
            .collection_write_answers
            .lock()
            .expect("answers")
            .push_back(Err(error.clone()));
        let client = RelaySyncClient::new(relay);
        assert_eq!(
            client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0),
            Err(error.clone()),
        );
        let outcome = propose(&client, &mut engine, "submit-1");
        assert_eq!(outcome.submitted, usize::from(!kept), "{error:?}");
    }
}

#[test]
fn a_new_collection_the_scan_bound_cuts_is_sent_whole_by_the_next_push() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["schema", "record"]);
    let folder = "shared/docs/ideas";
    journal_local_moment(
        &mut engine,
        &create_moment(
            "m-schema",
            "object-schema",
            &format!("{folder}/collection.yaml"),
            "schema",
        ),
        1_001,
    );
    // Enough other files that the scan holds its bound before the record.
    for index in 1..crate::MAX_SHARE_PROPOSAL_OPS {
        journal_local_moment(
            &mut engine,
            &create_moment(
                &format!("m-bulk-{index}"),
                &format!("object-bulk-{index}"),
                &format!("shared/docs/bulk/{index}.txt"),
                "record",
            ),
            1_001,
        );
    }
    journal_local_moment(
        &mut engine,
        &create_moment(
            "m-record",
            "object-record",
            &format!("{folder}/a.md"),
            "record",
        ),
        1_002,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    let first = push(&client, &mut engine);
    assert!(
        first.writes.is_empty(),
        "a Collection the bound cut is not sent in part"
    );
    assert!(first.more_pending);
    let second = push(&client, &mut engine);
    assert_eq!(
        written_paths(&client),
        vec![vec![
            format!("{folder}/collection.yaml"),
            format!("{folder}/a.md")
        ]],
    );
    assert!(!second.more_pending);
}

#[test]
fn direct_push_starts_after_what_send_changes_already_sent() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2"]);
    let schema = "shared/docs/packing/collection.yaml";
    journal_local_moment(
        &mut engine,
        &edit_moment("m-1", "object-schema", schema, "v1", "v2"),
        1_001,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    assert_eq!(propose(&client, &mut engine, "submit-1").submitted, 1);
    assert!(
        push(&client, &mut engine).writes.is_empty(),
        "a proposed change is not also written"
    );
}

#[test]
fn direct_push_writes_nothing_below_edit_or_on_another_version() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2"]);
    journal_local_moment(
        &mut engine,
        &edit_moment(
            "m-1",
            "object-schema",
            "shared/docs/packing/collection.yaml",
            "v1",
            "v2",
        ),
        1_001,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    let mut version = edit_grant();
    version.version_id = Some("draft".to_owned());
    for granted in [
        proposal_grant(crate::ShareAccess::View),
        proposal_grant(crate::ShareAccess::Comment),
        version,
    ] {
        let outcome = client
            .push_direct_writes(&mut engine, "ws", SHARE, &granted, &NoFaults, 0)
            .expect("push");
        assert!(outcome.writes.is_empty());
    }
    assert!(
        client
            .transport()
            .proposal_calls
            .lock()
            .expect("calls")
            .is_empty()
    );
}
