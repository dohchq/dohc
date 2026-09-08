use super::*;

// ---------------------------------------------------------------------------
// The recipient submits its own changes as a proposal.
// ---------------------------------------------------------------------------

/// A share-view store with an identity, a main version, and the blobs a
/// proposed change names. `seed_identity` journals the origin's op 0, so the
/// first moment below lands at origin_seq 1.
fn proposal_fixture(texts: &[&str]) -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let (scratch, path, mut engine) = open_store();
    seed_identity(&mut engine);
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    for text in texts {
        seed_blob(&mut engine, text);
    }
    (scratch, path, engine)
}

fn seed_blob(engine: &mut EngineStore, text: &str) -> String {
    let sha = dohc_engine_storage::hex_sha256(text.as_bytes());
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![sha, text.len() as i64, text],
            )
            .map_err(SyncError::persist)?;
            Ok::<(), SyncError>(())
        })
        .expect("seed blob");
    sha
}

/// A `moment.append` payload shaped the way this replica's own journal writes
/// one (`outbound.rs`), carrying the fields the proposal scan reads.
fn local_moment_payload(
    moment_id: &str,
    object_id: &str,
    operation: &str,
    before: Option<(&str, &str)>,
    after_path: &str,
    after_text: &str,
) -> serde_json::Value {
    let mut payload = json!({
        "momentId": moment_id,
        "versionId": "main",
        "objectId": object_id,
        "objectCreatedAtMs": 1,
        "path": after_path,
        "recordedAtMs": 2_000,
        "operation": operation,
        "payloadBeforeBlobSha256": null,
        "payloadBeforePath": null,
        "payloadAfterBlobSha256": dohc_engine_storage::hex_sha256(after_text.as_bytes()),
        "payloadAfterPath": after_path,
        "payloadAfterContentKind": "text",
        "payloadAfterByteLength": after_text.len() as i64,
        "metadata": {"origin": "local-file"},
        "beforePresent": "null",
    });
    if let Some((before_path, before_text)) = before {
        payload["payloadBeforePath"] = json!(before_path);
        payload["payloadBeforeBlobSha256"] =
            json!(dohc_engine_storage::hex_sha256(before_text.as_bytes()));
        payload["beforePath"] = json!(before_path);
        payload["beforePresent"] = json!("present");
    }
    payload
}

fn journal_local_moment(engine: &mut EngineStore, payload: &serde_json::Value, at_ms: i64) {
    journal_local_replication_op(
        engine,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "moment.append",
        payload,
        at_ms,
        &NoFaults,
    )
    .expect("journal moment");
}

fn proposal_grant(access: crate::ShareAccess) -> ShareGrant {
    ShareGrant {
        paths: vec!["shared/docs".to_owned()],
        version_id: None,
        access,
    }
}

fn proposal_scan_position(engine: &EngineStore, share_id: &str) -> Option<i64> {
    engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT scanned_seq FROM share_proposal_push_state \
                 WHERE workspace_id='ws' AND share_id=?1",
                [share_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(SyncError::corrupt)
        })
        .expect("scan position")
}

/// The pinned level decides what this replica offers, not just what the relay
/// accepts. A view or comment share must not reach the relay at all.
#[test]
fn share_proposal_submit_offers_nothing_below_edit_level() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1"]);
    journal_local_moment(
        &mut engine,
        &local_moment_payload("m-1", "object-a", "write", None, "shared/docs/a.md", "v1"),
        1_001,
    );

    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    for (access, expected) in [
        (crate::ShareAccess::View, 0_usize),
        (crate::ShareAccess::Comment, 0),
        (crate::ShareAccess::Edit, 1),
    ] {
        let outcome = client
            .submit_share_proposal(
                &mut engine,
                "ws",
                &format!("share-{access:?}"),
                &proposal_grant(access),
                "submit-1",
                &NoFaults,
            )
            .expect("submit");
        assert_eq!(
            outcome.submitted, expected,
            "the pinned level must decide whether this replica offers a change ({access:?})",
        );
        assert_eq!(
            outcome.proposal_id.is_some(),
            expected > 0,
            "a submit that offered nothing must name no proposal ({access:?})",
        );
        if expected == 0 {
            assert!(
                client
                    .transport()
                    .proposal_calls
                    .lock()
                    .expect("calls")
                    .is_empty(),
                "a share below edit level must not contact the relay at all ({access:?})",
            );
        }
    }
    assert_eq!(
        client
            .transport()
            .proposal_calls
            .lock()
            .expect("calls")
            .last()
            .map(String::as_str),
        Some("submit"),
        "an edit-level share submits",
    );
}

/// The same containment rule the inbound boundary applies, read outbound: a
/// local moment naming a path the grant does not cover is not this share's to
/// offer.
#[test]
fn share_proposal_submit_keeps_changes_inside_the_grant() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["inside", "outside"]);
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-in",
            "object-in",
            "write",
            None,
            "shared/docs/in.md",
            "inside",
        ),
        1_001,
    );
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-out",
            "object-out",
            "write",
            None,
            "other/out.md",
            "outside",
        ),
        1_002,
    );

    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    let outcome = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-grant",
            &proposal_grant(crate::ShareAccess::Edit),
            "submit-1",
            &NoFaults,
        )
        .expect("submit");
    assert_eq!(
        outcome.submitted, 1,
        "a change to a file outside the grant must not be offered",
    );
    let submits = client.transport().proposal_submits.lock().expect("submits");
    let ops = &submits.first().expect("one submit").ops;
    assert_eq!(
        ops.iter()
            .filter_map(|op| op.after_path.as_deref())
            .collect::<Vec<_>>(),
        vec!["shared/docs/in.md"],
        "only the in-grant file may be named on the wire",
    );
    assert!(
        client
            .transport()
            .proposal_calls
            .lock()
            .expect("calls")
            .iter()
            .all(|call| call != &format!("blob:{}", dohc_engine_storage::hex_sha256(b"outside"))),
        "an out-of-grant file's content must never be uploaded to the granter",
    );
}

/// A run of local writes to one file is one change: the base the recipient
/// started from, and the content it ended with.
#[test]
fn share_proposal_submit_consolidates_repeated_edits_to_one_change() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v0", "v1", "v2"]);
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-1",
            "object-a",
            "write",
            Some(("shared/docs/a.md", "v0")),
            "shared/docs/a.md",
            "v1",
        ),
        1_001,
    );
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-2",
            "object-a",
            "write",
            Some(("shared/docs/a.md", "v1")),
            "shared/docs/a.md",
            "v2",
        ),
        1_002,
    );

    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    let outcome = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-consolidate",
            &proposal_grant(crate::ShareAccess::Edit),
            "submit-1",
            &NoFaults,
        )
        .expect("submit");
    assert_eq!(
        outcome.submitted, 1,
        "two writes to one file are one net change, not two",
    );
    let submits = client.transport().proposal_submits.lock().expect("submits");
    let change = submits
        .first()
        .expect("one submit")
        .ops
        .first()
        .expect("one change")
        .clone();
    assert_eq!(
        change.based_on_blob_sha256,
        Some(dohc_engine_storage::hex_sha256(b"v0")),
        "the base is what the recipient started from, not the last local before-side",
    );
    assert_eq!(
        change.after_blob_sha256,
        Some(dohc_engine_storage::hex_sha256(b"v2")),
        "the destination is the LAST write's content, not the first",
    );
    assert_eq!(change.after_byte_length, Some(2));
    assert_eq!(change.operation, "write");
}

/// One moment already states an object's complete post state, so a write and
/// a later rename of the same file collapse into one change: from the path the
/// granter knows to the path the recipient chose.
#[test]
fn share_proposal_submit_carries_a_rename_and_an_edit_as_one_change() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v0", "v1"]);
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-1",
            "object-a",
            "write",
            Some(("shared/docs/a.md", "v0")),
            "shared/docs/a.md",
            "v1",
        ),
        1_001,
    );
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-2",
            "object-a",
            "rename",
            Some(("shared/docs/a.md", "v1")),
            "shared/docs/b.md",
            "v1",
        ),
        1_002,
    );

    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    let outcome = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-rename",
            &proposal_grant(crate::ShareAccess::Edit),
            "submit-1",
            &NoFaults,
        )
        .expect("submit");
    assert_eq!(outcome.submitted, 1);
    let submits = client.transport().proposal_submits.lock().expect("submits");
    let change = submits
        .first()
        .expect("one submit")
        .ops
        .first()
        .expect("one change")
        .clone();
    assert_eq!(
        change.based_on_path.as_deref(),
        Some("shared/docs/a.md"),
        "the base path must be the original path, which is the one the granter has",
    );
    assert_eq!(
        change.after_path.as_deref(),
        Some("shared/docs/b.md"),
        "the destination must be the new path",
    );
    assert_eq!(
        change.operation, "write",
        "a proposal states where the file must end up; the relay derives the moment's own label",
    );
}

/// Decision 3, in one integer. The scan stops at the journal's high-water mark
/// read when the submit began, and that mark — not the last op offered — is
/// what the next submit resumes from.
#[test]
fn share_proposal_submit_bounds_the_scan_at_the_submit_moment() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["one", "outside", "three"]);
    journal_local_moment(
        &mut engine,
        &local_moment_payload("m-1", "object-a", "write", None, "shared/docs/a.md", "one"),
        1_001,
    );
    // Journaled inside the window and offered by nobody: the mark must still
    // move past it, or every later submit re-reads it.
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-out",
            "object-out",
            "write",
            None,
            "other/out.md",
            "outside",
        ),
        1_002,
    );

    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    let first = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-bound",
            &proposal_grant(crate::ShareAccess::Edit),
            "submit-1",
            &NoFaults,
        )
        .expect("first submit");
    assert_eq!(first.submitted, 1);
    assert_eq!(
        proposal_scan_position(&engine, "share-bound"),
        Some(2),
        "the recorded position is the journal's high-water mark, not the last op offered",
    );

    // Journaled after the first submit read its mark, so it belongs to the
    // next one — and to that one only.
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-3",
            "object-c",
            "write",
            None,
            "shared/docs/c.md",
            "three",
        ),
        1_003,
    );
    let second = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-bound",
            &proposal_grant(crate::ShareAccess::Edit),
            "submit-2",
            &NoFaults,
        )
        .expect("second submit");
    assert_eq!(
        second.submitted, 1,
        "a submit must carry only what was journaled after the last one",
    );
    let submits = client.transport().proposal_submits.lock().expect("submits");
    assert_eq!(
        submits
            .last()
            .expect("second submit")
            .ops
            .iter()
            .filter_map(|op| op.after_path.as_deref())
            .collect::<Vec<_>>(),
        vec!["shared/docs/c.md"],
        "the second submit must not re-offer the first submit's change",
    );
    assert_eq!(proposal_scan_position(&engine, "share-bound"), Some(3));
}

/// The relay refuses a batch naming a blob it does not hold, at submit and
/// again at accept. So content travels first, ops second — the ordering the
/// owner's own drain uses.
#[test]
fn share_proposal_submit_uploads_blobs_before_the_ops() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["alpha", "beta"]);
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-1",
            "object-a",
            "write",
            None,
            "shared/docs/a.md",
            "alpha",
        ),
        1_001,
    );
    journal_local_moment(
        &mut engine,
        &local_moment_payload("m-2", "object-b", "write", None, "shared/docs/b.md", "beta"),
        1_002,
    );

    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    let outcome = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-blobs",
            &proposal_grant(crate::ShareAccess::Edit),
            "submit-1",
            &NoFaults,
        )
        .expect("submit");
    assert_eq!(outcome.submitted, 2);
    assert_eq!(
        client
            .transport()
            .proposal_calls
            .lock()
            .expect("calls")
            .as_slice(),
        [
            format!("blob:{}", dohc_engine_storage::hex_sha256(b"alpha")),
            format!("blob:{}", dohc_engine_storage::hex_sha256(b"beta")),
            "submit".to_owned(),
        ],
        "every referenced blob must reach the relay before the submit that names it",
    );
    let uploads = client.transport().blob_uploads.lock().expect("uploads");
    assert_eq!(
        uploads
            .iter()
            .map(|upload| upload.bytes.clone())
            .collect::<Vec<_>>(),
        vec![b"alpha".to_vec(), b"beta".to_vec()],
        "the upload must carry the file's own bytes",
    );
}

/// The submit lane proposes FILE changes and nothing else — an allowlist, not
/// a fall-through.
///
/// Containment happens to refuse every other op this engine journals today,
/// because none of them names a tracked path and an after blob. That is a
/// coincidence of the current op set, not a rule: an op naming both would be
/// read as a file change on the strength of its fields alone. The kind is
/// what decides, so the kind is what this asserts.
#[test]
fn share_proposal_submit_proposes_only_file_moments() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1"]);
    let payload = local_moment_payload("m-1", "object-a", "write", None, "shared/docs/a.md", "v1");
    journal_local_replication_op(
        &mut engine,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "secret.file.put",
        &payload,
        1_001,
        &NoFaults,
    )
    .expect("journal");

    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    let outcome = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-kinds",
            &proposal_grant(crate::ShareAccess::Edit),
            "submit-1",
            &NoFaults,
        )
        .expect("submit");
    assert_eq!(
        outcome.submitted, 0,
        "only a moment.append is a file change this share may propose",
    );
    assert!(
        client
            .transport()
            .proposal_calls
            .lock()
            .expect("calls")
            .is_empty(),
        "an op that is not a file moment must reach the relay by no route",
    );
}

/// A base names a file and what the recipient read from it. One half without
/// the other cannot be resolved to a granter moment, so neither half travels.
#[test]
fn share_proposal_submit_drops_a_half_stated_base() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1"]);
    let mut payload =
        local_moment_payload("m-1", "object-a", "write", None, "shared/docs/a.md", "v1");
    // The path half only: the shape a damaged journal row leaves behind.
    payload["payloadBeforePath"] = json!("shared/docs/a.md");
    journal_local_moment(&mut engine, &payload, 1_001);

    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    let outcome = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-half-base",
            &proposal_grant(crate::ShareAccess::Edit),
            "submit-1",
            &NoFaults,
        )
        .expect("submit");
    assert_eq!(outcome.submitted, 1);
    let submits = client.transport().proposal_submits.lock().expect("submits");
    let change = submits
        .first()
        .expect("one submit")
        .ops
        .first()
        .expect("one change")
        .clone();
    assert_eq!(
        (change.based_on_path, change.based_on_blob_sha256),
        (None, None),
        "a base stated by half must be sent as no base at all",
    );
}

/// A delete removes content the granter holds. With no stated base there is
/// nothing to remove, and the relay refuses the shape — so offering it would
/// fail the whole submit for a change that describes nothing.
#[test]
fn share_proposal_submit_offers_no_delete_of_a_file_the_granter_never_had() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2"]);
    // Created locally, then deleted locally: the granter never saw either op.
    journal_local_moment(
        &mut engine,
        &local_moment_payload("m-1", "object-a", "write", None, "shared/docs/a.md", "v1"),
        1_001,
    );
    journal_local_moment(
        &mut engine,
        &local_moment_payload("m-2", "object-a", "delete", None, "shared/docs/a.md", "v1"),
        1_002,
    );
    // A second file the granter does have, so the submit is not empty for an
    // unrelated reason.
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-3",
            "object-b",
            "delete",
            Some(("shared/docs/b.md", "v2")),
            "shared/docs/b.md",
            "v2",
        ),
        1_003,
    );

    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    let outcome = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-delete",
            &proposal_grant(crate::ShareAccess::Edit),
            "submit-1",
            &NoFaults,
        )
        .expect("submit");
    assert_eq!(
        outcome.submitted, 1,
        "a delete with no stated base names nothing to remove",
    );
    let submits = client.transport().proposal_submits.lock().expect("submits");
    let change = submits
        .first()
        .expect("one submit")
        .ops
        .first()
        .expect("one change")
        .clone();
    assert_eq!(change.operation, "delete");
    assert_eq!(change.based_on_path.as_deref(), Some("shared/docs/b.md"));
    assert_eq!(
        (
            change.after_path,
            change.after_blob_sha256,
            change.after_content_kind,
            change.after_byte_length
        ),
        (None, None, None, None),
        "a delete lands nowhere, so it states no after side",
    );
}

/// A local write to file `index`, inside the grant.
fn journal_numbered_write(engine: &mut EngineStore, index: usize, at_ms: i64) {
    let text = format!("v{index}");
    seed_blob(engine, &text);
    journal_local_moment(
        engine,
        &local_moment_payload(
            &format!("m-{index}-{at_ms}"),
            &format!("object-{index}"),
            "write",
            None,
            &format!("shared/docs/{index}.md"),
            &text,
        ),
        at_ms,
    );
}

/// One submit is one batch and one relay transaction, so it carries at most
/// the batch the relay accepts. The BOUND stops the scan; it must never refuse
/// the submit, because the changes are net-per-file and accumulate — a refusal
/// re-collects the same over-limit set on every later press, and there is
/// nothing the recipient can do to make it smaller.
#[test]
fn share_proposal_submit_sends_a_bounded_batch_and_then_the_rest() {
    let (_scratch, _path, mut engine) = proposal_fixture(&[]);
    let over_limit = crate::MAX_SHARE_PROPOSAL_OPS + 2;
    for index in 0..over_limit {
        journal_numbered_write(&mut engine, index, 1_001 + index as i64);
    }

    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    let first = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-over-limit",
            &proposal_grant(crate::ShareAccess::Edit),
            "submit-1",
            &NoFaults,
        )
        .expect("an over-limit recipient must still be able to send");
    assert_eq!(
        first.submitted,
        crate::MAX_SHARE_PROPOSAL_OPS,
        "one submit carries at most the batch the relay accepts",
    );
    assert!(
        first.more_pending,
        "a submit that left changes behind must say so, or the recipient \
         has no reason to press again",
    );

    let second = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-over-limit",
            &proposal_grant(crate::ShareAccess::Edit),
            "submit-2",
            &NoFaults,
        )
        .expect("second submit");
    assert_eq!(
        second.submitted,
        over_limit - crate::MAX_SHARE_PROPOSAL_OPS,
        "the changes the bound held back must travel in the next submit",
    );
    assert!(
        !second.more_pending,
        "a submit that emptied the window must not ask for another",
    );

    let submits = client.transport().proposal_submits.lock().expect("submits");
    let offered = submits
        .iter()
        .flat_map(|submit| submit.ops.iter())
        .filter_map(|op| op.after_path.clone())
        .collect::<Vec<_>>();
    let distinct = offered.iter().cloned().collect::<BTreeSet<_>>();
    assert_eq!(
        (offered.len(), distinct.len()),
        (over_limit, over_limit),
        "across the two submits every file must reach the granter exactly once",
    );
}

/// The submit bound is one number enforced in two places: this scan stops at
/// it, and the relay route refuses past it. Two copies that drift give a
/// recipient a scan that collects more than the relay will take, and every
/// submit then fails on a number nobody can see from here.
#[test]
fn the_submit_bound_matches_the_relay_contract() {
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/security-contract/src/shareProposalBound.ts"),
    )
    .expect("the relay's own copy of the submit bound");
    let declared = source
        .split("export const MAX_SHARE_PROPOSAL_OPS =")
        .nth(1)
        .and_then(|rest| rest.split(';').next())
        .map(str::trim)
        .and_then(|value| value.replace('_', "").parse::<usize>().ok())
        .expect("MAX_SHARE_PROPOSAL_OPS is declared as a plain integer");
    assert_eq!(
        declared,
        crate::MAX_SHARE_PROPOSAL_OPS,
        "a scan bound above the relay's own bound makes every large submit fail",
    );
}

/// The submit bound and the replication page size are different numbers for
/// different things. Collapsing them re-couples one user act to a paging size,
/// which is how the bound came to sit inside measured healthy work.
/// Checked when this crate's TEST TARGET compiles — this module is
/// `cfg(test)`, so the assertion is evaluated by `cargo test`/`nextest`
/// builds rather than by a plain `cargo build`. The gate compiles the tests,
/// so a violation fails the gate before any test runs. It is a const
/// assertion because the relationship between two constants is a fact about
/// the constants, not about any run.
const _: () = assert!(
    crate::MAX_SHARE_PROPOSAL_OPS > crate::MAX_PUSH_OPS_PER_BATCH,
    "a submit bounded by the page size rejects a week of ordinary work",
);

#[test]
fn the_submit_bound_is_not_the_replication_page_size() {
    assert_eq!(crate::MAX_PUSH_OPS_PER_BATCH, 500);
    assert_eq!(crate::MAX_SHARE_PROPOSAL_OPS, 2_500);
}

/// The bound counts FILES, and it stops at the op that would admit one file
/// too many. An op folding into a file the scan already holds is not that op,
/// so no file is ever offered half consolidated and then offered again.
#[test]
fn share_proposal_submit_never_splits_one_file_across_two_submits() {
    let (_scratch, _path, mut engine) = proposal_fixture(&[]);
    // Exactly the batch, so the scan is full but has stopped at nothing.
    for index in 0..crate::MAX_SHARE_PROPOSAL_OPS {
        journal_numbered_write(&mut engine, index, 1_001 + index as i64);
    }
    // A later edit to a file already held. It must fold into this submit.
    seed_blob(&mut engine, "0-final");
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-0-final",
            "object-0",
            "write",
            Some(("shared/docs/0.md", "v0")),
            "shared/docs/0.md",
            "0-final",
        ),
        9_001,
    );
    // The new file that stops the scan.
    journal_numbered_write(&mut engine, crate::MAX_SHARE_PROPOSAL_OPS, 9_002);

    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    let grant = proposal_grant(crate::ShareAccess::Edit);
    let first = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-split",
            &grant,
            "submit-1",
            &NoFaults,
        )
        .expect("first submit");
    assert_eq!(first.submitted, crate::MAX_SHARE_PROPOSAL_OPS);
    assert!(first.more_pending);
    let second = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-split",
            &grant,
            "submit-2",
            &NoFaults,
        )
        .expect("second submit");

    let submits = client.transport().proposal_submits.lock().expect("submits");
    let for_file_zero = submits
        .iter()
        .flat_map(|submit| submit.ops.iter())
        .filter(|op| op.after_path.as_deref() == Some("shared/docs/0.md"))
        .collect::<Vec<_>>();
    assert_eq!(
        for_file_zero.len(),
        1,
        "a file the scan already holds must not be offered once per submit",
    );
    assert_eq!(
        for_file_zero[0].after_blob_sha256.as_deref(),
        Some(dohc_engine_storage::hex_sha256(b"0-final").as_str()),
        "the offered change must be the file's LAST state, not the state \
         it had when the bound filled up",
    );
    assert_eq!(
        submits
            .last()
            .expect("second submit")
            .ops
            .iter()
            .filter_map(|op| op.after_path.as_deref())
            .collect::<Vec<_>>(),
        vec![format!("shared/docs/{}.md", crate::MAX_SHARE_PROPOSAL_OPS)],
        "the second submit carries the file the bound refused, and only it",
    );
    assert_eq!(second.submitted, 1);
}

/// A file the recipient edited out of the shared paths is not this share's to
/// offer at all — not even the state it held before it left. It is dropped
/// whole and counted, because a silent drop leaves the recipient believing it
/// sent work it never sent.
#[test]
fn share_proposal_submit_counts_a_file_edited_out_of_the_share() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2", "kept"]);
    journal_local_moment(
        &mut engine,
        &local_moment_payload("m-1", "object-a", "write", None, "shared/docs/a.md", "v1"),
        1_001,
    );
    // The same file, moved out of the grant.
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-2",
            "object-a",
            "write",
            Some(("shared/docs/a.md", "v1")),
            "other/a.md",
            "v2",
        ),
        1_002,
    );
    // A file that never leaves, so the submit is not empty for another reason.
    journal_local_moment(
        &mut engine,
        &local_moment_payload("m-3", "object-b", "write", None, "shared/docs/b.md", "kept"),
        1_003,
    );

    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    let outcome = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-outside",
            &proposal_grant(crate::ShareAccess::Edit),
            "submit-1",
            &NoFaults,
        )
        .expect("submit");
    assert_eq!(
        outcome.skipped_outside_share, 1,
        "a file dropped for leaving the share must be counted to the recipient",
    );
    assert_eq!(outcome.submitted, 1);
    let submits = client.transport().proposal_submits.lock().expect("submits");
    let ops = &submits.first().expect("one submit").ops;
    assert_eq!(
        ops.iter()
            .filter_map(|op| op.after_path.as_deref())
            .collect::<Vec<_>>(),
        vec!["shared/docs/b.md"],
        "the pre-move state of a file that left the share must not be offered",
    );
    let calls = client.transport().proposal_calls.lock().expect("calls");
    for text in [&b"v1"[..], &b"v2"[..]] {
        assert!(
            !calls.contains(&format!("blob:{}", dohc_engine_storage::hex_sha256(text))),
            "the content of a file outside the share must reach the granter by no route",
        );
    }
}

/// The count is a PATH verdict, not a story about how a file got there: a
/// file that was never in the shared paths counts exactly like one an edit
/// moved out, because both state the same fact to the recipient — the file is
/// not part of this share, and it was not sent.
///
/// And the count travels even when the submit offers nothing. A recipient
/// whose every edit named a path outside the share is exactly the one that
/// needs telling.
#[test]
fn share_proposal_submit_counts_files_outside_the_shared_paths_when_it_offers_nothing() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["one", "two"]);
    // Neither file was ever inside the shared paths. Both are counted anyway.
    for (index, (moment_id, object_id, path, text)) in [
        ("m-1", "object-a", "other/a.md", "one"),
        ("m-2", "object-b", "elsewhere/b.md", "two"),
    ]
    .into_iter()
    .enumerate()
    {
        journal_local_moment(
            &mut engine,
            &local_moment_payload(moment_id, object_id, "write", None, path, text),
            1_001 + index as i64,
        );
    }

    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    let outcome = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-all-outside",
            &proposal_grant(crate::ShareAccess::Edit),
            "submit-1",
            &NoFaults,
        )
        .expect("submit");
    assert_eq!(
        (outcome.submitted, outcome.skipped_outside_share),
        (0, 2),
        "a submit that offered nothing must still count the files that \
         sit outside the shared paths, whether or not they ever sat inside them",
    );
    assert!(
        outcome.proposal_id.is_none(),
        "a submit with nothing to offer names no proposal",
    );
}

/// One local write to a file the grant does not cover.
fn journal_numbered_outside_write(engine: &mut EngineStore, index: usize, at_ms: i64) {
    let text = format!("out{index}");
    seed_blob(engine, &text);
    journal_local_moment(
        engine,
        &local_moment_payload(
            &format!("m-out-{index}"),
            &format!("object-out-{index}"),
            "write",
            None,
            &format!("other/{index}.md"),
            &text,
        ),
        at_ms,
    );
}

/// The count crosses a contract that caps it at the batch bound, and the cap
/// is parsed after the submit succeeded and the scan position moved on. An
/// honest larger number would therefore report a working submit as a failure
/// whose retry offers nothing, because the window is already consumed.
#[test]
fn share_proposal_submit_saturates_the_skipped_count_at_the_bound() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["kept"]);
    let outside = crate::MAX_SHARE_PROPOSAL_OPS + 1;
    for index in 0..outside {
        journal_numbered_outside_write(&mut engine, index, 1_001 + index as i64);
    }
    // One file inside the grant, so the submit really reaches the relay.
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-in",
            "object-in",
            "write",
            None,
            "shared/docs/in.md",
            "kept",
        ),
        9_001,
    );

    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    let outcome = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-saturate",
            &proposal_grant(crate::ShareAccess::Edit),
            "submit-1",
            &NoFaults,
        )
        .expect("dropping more files than the bound must not fail the submit");
    assert_eq!(
        outcome.skipped_outside_share,
        crate::MAX_SHARE_PROPOSAL_OPS,
        "the reported count must saturate at the bound the contract accepts",
    );
    assert_eq!(outcome.submitted, 1, "the in-grant file must still travel",);
}

/// The bound stops the scan at the op that would admit one file too many, so a
/// scan holding exactly the bound stopped at nothing and has nothing left to
/// offer. Saying otherwise sends the recipient back for a submit that carries
/// no change.
#[test]
fn share_proposal_submit_at_exactly_the_bound_asks_for_no_second_press() {
    let (_scratch, _path, mut engine) = proposal_fixture(&[]);
    for index in 0..crate::MAX_SHARE_PROPOSAL_OPS {
        journal_numbered_write(&mut engine, index, 1_001 + index as i64);
    }

    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    let outcome = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-at-bound",
            &proposal_grant(crate::ShareAccess::Edit),
            "submit-1",
            &NoFaults,
        )
        .expect("submit");
    assert_eq!(
        outcome.submitted,
        crate::MAX_SHARE_PROPOSAL_OPS,
        "a scan that fits exactly must carry every file it holds",
    );
    assert!(
        !outcome.more_pending,
        "a scan that ended AT the bound left nothing behind and must not \
         ask for another press",
    );
}

/// A pulled granter change must never be offered back to the granter.
///
/// The scan reads this replica's journal under the workspace's single
/// `sync_identity` origin and filters per op by `op_kind` alone, so if the
/// share-view pull journaled what it applied, the recipient's next submit
/// would offer the granter its own edit back with a stale base.
///
/// It does not: `replay_share_write` writes through
/// `VersionedTextStore::write_text` in `dohc-engine-domain`, and that door
/// appends no `replication_log` row. The `replication_log` row the scan
/// reads is appended by `journal_moment_outbound_in_tx`
/// (`dohc-engine-runtime/src/actor.rs`), which sits on the LOCAL write path
/// alone. This test is the standing proof of that gap.
#[test]
fn share_proposal_submit_never_offers_a_pulled_granter_change_back() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["mine"]);
    let granter_bytes = b"the granter wrote this".to_vec();
    let granter_sha = dohc_engine_storage::hex_sha256(&granter_bytes);
    let client = RelaySyncClient::new(
        PagedShareRelay::new(
            [],
            [(
                0,
                ShareViewResponse {
                    ops: vec![ShareReplicationEnvelope {
                        origin_id: "granter".to_owned(),
                        origin_seq: 0,
                        op_kind: "moment.append".to_owned(),
                        payload: json!({
                            "versionId": "main",
                            "operation": "write",
                            "path": "shared/docs/granter.md",
                            "payloadAfterPath": "shared/docs/granter.md",
                            "payloadAfterBlobSha256": granter_sha,
                            "payloadAfterContentKind": "text",
                        }),
                        recorded_at_ms: 1_500,
                    }],
                    next_cursor: 1,
                    has_more: false,
                },
            )],
        )
        .with_view_blobs([(granter_sha.clone(), granter_bytes)]),
    );
    let granted = proposal_grant(crate::ShareAccess::Edit);
    let pulled = client
        .pull_share_view(&mut engine, "ws", "share-echo", &granted, &NoFaults)
        .expect("pull");
    assert_eq!(
        (pulled.fetched, pulled.applied),
        (1, 1),
        "the granter's change must LAND locally, or this test proves nothing",
    );
    // A local edit to a different file, so an empty offer cannot pass this
    // test by the scan being broken.
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-mine",
            "object-mine",
            "write",
            None,
            "shared/docs/mine.md",
            "mine",
        ),
        9_001,
    );

    let outcome = client
        .submit_share_proposal(
            &mut engine,
            "ws",
            "share-echo",
            &granted,
            "submit-1",
            &NoFaults,
        )
        .expect("submit");
    assert_eq!(
        outcome.submitted, 1,
        "a pulled granter change must not join this replica's own offer",
    );
    let submits = client.transport().proposal_submits.lock().expect("submits");
    assert_eq!(
        submits
            .iter()
            .flat_map(|submit| submit.ops.iter())
            .filter_map(|op| op.after_path.as_deref())
            .collect::<Vec<_>>(),
        vec!["shared/docs/mine.md"],
        "the granter's own path must never be named back to the granter",
    );
    assert!(
        !client
            .transport()
            .proposal_calls
            .lock()
            .expect("calls")
            .contains(&format!("blob:{granter_sha}")),
        "the granter's own content must not be uploaded back to the granter",
    );
}

/// The granter's two moments for one file: `granter-m0` produced `v0`, and
/// `granter-m1` produced `v1` and is the head.
fn granter_fixture() -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let (scratch, path, mut engine) = open_store();
    VersionedTextStore::new(&mut engine)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    seed_granter_lineage(&mut engine);
    (scratch, path, engine)
}

fn seed_granter_lineage(engine: &mut EngineStore) {
    seed_blob(engine, "v0");
    seed_blob(engine, "v1");
    seed_blob(engine, "v2");
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','granter-object',1)",
                [],
            )
            .map_err(SyncError::persist)?;
            for (order, moment_id, text) in [(0_i64, "granter-m0", "v0"), (1, "granter-m1", "v1")] {
                tx.execute(
                    "INSERT INTO moments (
                       workspace_id,moment_order,moment_id,version_id,object_id,path,
                       recorded_at_ms,operation,after_blob_sha256,before_present,
                       metadata_origin,after_content_kind
                     ) VALUES ('ws',?1,?2,'main','granter-object','shared/docs/a.md',?3,
                               'write',?4,1,'api','text')",
                    params![
                        order,
                        moment_id,
                        100 + order,
                        dohc_engine_storage::hex_sha256(text.as_bytes())
                    ],
                )
                .map_err(SyncError::persist)?;
            }
            tx.execute(
                "INSERT INTO snapshots \
                 (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,\
                  latest_moment_id,metadata_origin,content_kind,binary_sha256) \
                 VALUES ('ws','main','granter-object','shared/docs/a.md',?1,101,\
                         'granter-m1','api','text',NULL)",
                params![dohc_engine_storage::hex_sha256(b"v1")],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
                 VALUES ('ws','main','shared/docs/a.md','granter-object')",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<(), SyncError>(())
        })
        .expect("seed granter lineage");
}

/// The moment the relay builds at accept, with the base rewritten to the
/// granter's own moment (decision 5).
fn accepted_change_payload(
    base_moment_id: &str,
    base_text: &str,
    after_text: &str,
) -> serde_json::Value {
    json!({
        "momentId": "relay-minted-moment",
        "versionId": "main",
        "objectId": "granter-object",
        "objectCreatedAtMs": 1,
        "path": "shared/docs/a.md",
        "recordedAtMs": 3_000,
        "operation": "write",
        "payloadBeforeBlobSha256": dohc_engine_storage::hex_sha256(base_text.as_bytes()),
        "payloadBeforePath": "shared/docs/a.md",
        "payloadAfterBlobSha256": dohc_engine_storage::hex_sha256(after_text.as_bytes()),
        "payloadAfterPath": "shared/docs/a.md",
        "payloadAfterContentKind": "text",
        "payloadAfterByteLength": after_text.len() as i64,
        "metadata": {
            "origin": "sync",
            "summary": "Accepted changes from alex@example.com",
            "correlationId": null,
        },
        "beforePresent": "present",
        "beforeObjectId": "granter-object",
        "beforeVersionId": "main",
        "beforePath": "shared/docs/a.md",
        "beforeBlobSha256": dohc_engine_storage::hex_sha256(base_text.as_bytes()),
        "beforeContentKind": "text",
        "beforeByteLength": base_text.len() as i64,
        "beforeUpdatedAtMs": 100,
        "beforeLatestMomentId": base_moment_id,
    })
}

fn apply_accepted_change(
    engine: &mut EngineStore,
    payload: serde_json::Value,
) -> MomentApplyResult {
    let operation = envelope("share:share-1:recipient", 0, "moment.append", payload);
    match apply_moment_envelope_detailed(engine, &operation, &NoFaults, &NoLiveLeases)
        .expect("accepted change applies")
    {
        ApplyOutcome {
            primary: ApplyDisposition::Applied(result),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        } if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() => result,
        other => panic!("accepted change must apply: {other:?}"),
    }
}

/// The recipient was current, so the rewritten base IS the granter's head. The
/// accept is a clean apply — this is what makes the base rewrite worth doing.
#[test]
fn an_accepted_change_on_the_granters_head_applies_without_a_conflict() {
    let (_scratch, _path, mut engine) = granter_fixture();

    let result = apply_accepted_change(
        &mut engine,
        accepted_change_payload("granter-m1", "v1", "v2"),
    );
    assert_eq!(
        result.conflicts_opened, 0,
        "a change based on the granter's own head must not open a conflict",
    );
    let head: (String, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT latest_moment_id,blob_sha256 FROM snapshots \
                 WHERE workspace_id='ws' AND version_id='main' AND object_id='granter-object'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("head");
    assert_eq!(
        head,
        (
            "relay-minted-moment".to_owned(),
            dohc_engine_storage::hex_sha256(b"v2")
        ),
        "a clean accept must move the granter's head to the accepted content",
    );
}

/// The file drifted after the recipient read it, so the rewritten base is a
/// real, older granter moment. One conflict, with a correct three-way base —
/// never a silent overwrite.
#[test]
fn an_accepted_change_on_a_stale_base_opens_one_conflict_against_that_base() {
    let (_scratch, _path, mut engine) = granter_fixture();

    let result = apply_accepted_change(
        &mut engine,
        accepted_change_payload("granter-m0", "v0", "v2"),
    );
    assert_eq!(
        result.conflicts_opened, 1,
        "a drifted file must open exactly one conflict, never overwrite",
    );
    let base: (String, String, String) = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT base_latest_moment_id,base_blob_sha256,current_blob_sha256 \
                 FROM conflicts WHERE workspace_id='ws' AND status='open'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("conflict row");
    assert_eq!(
        base,
        (
            "granter-m0".to_owned(),
            dohc_engine_storage::hex_sha256(b"v0"),
            dohc_engine_storage::hex_sha256(b"v1")
        ),
        "the conflict's base must be the OLDER granter moment the recipient read, \
         with the granter's current content on the other side",
    );
    let head: String = engine
        .read_with(|conn| {
            conn.query_row(
                "SELECT blob_sha256 FROM snapshots \
                 WHERE workspace_id='ws' AND version_id='main' AND object_id='granter-object'",
                [],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .expect("head");
    assert_eq!(
        head,
        dohc_engine_storage::hex_sha256(b"v1"),
        "a conflicted accept must leave the granter's content untouched",
    );
}
