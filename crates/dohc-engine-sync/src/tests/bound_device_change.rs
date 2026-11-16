use super::*;
use dohc_engine_collab::live_update_application::ReleasedTails;
use dohc_engine_collab::owner_outbox::accepted::{OwnerAcceptedFrameInput, apply_frame_in_tx};
use dohc_engine_collab::owner_outbox::draft::ObservedOwnerBinding;
use dohc_engine_collab::{DocKey, Ydoc};

/// The relay's frame of the device's edit, as the computer bound to the
/// note's live session receives it.
fn receive_frame(store: &mut EngineStore, observed: &ObservedOwnerBinding, update: Vec<u8>) {
    store
        .write_with(&NoFaults, |tx| {
            apply_frame_in_tx(
                tx,
                "ws",
                &OwnerAcceptedFrameInput {
                    binding: observed.binding.clone(),
                    relay_database_namespace: "relay".into(),
                    expected_revision: 1,
                    expected_native_head_sequence: observed.native_head_sequence,
                    previous_accepted_cursor: 0,
                    journal_cursor: 1,
                    update_bytes: update,
                },
                3,
            )
        })
        .unwrap();
}

/// The note's accepted live text here.
fn live_text(store: &mut EngineStore) -> String {
    let key = DocKey::new("ws", "main", "owner").unwrap();
    let TxnOutcome::Committed(Some((_, text))) = store
        .write_with(&NoFaults, |tx| {
            crate::ydoc_apply::observed_owner_projection_in_tx(tx, &key, "owner.md")
        })
        .unwrap()
    else {
        panic!("the note has no accepted live text");
    };
    text
}

/// `owner`'s head: its text's digest and the moment that last wrote it.
fn head(store: &EngineStore) -> (String, String) {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT blob_sha256,latest_moment_id FROM snapshots WHERE object_id='owner'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap()
}

/// A device's file change: `origin`'s first text write of the note, to
/// `text`.
fn device_change(store: &mut EngineStore, origin: &str, text: &str) -> ReplicationEnvelope {
    let (before_sha, before_moment) = head(store);
    let sha = dohc_engine_storage::hex_sha256(text.as_bytes());
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![sha, text.len() as i64, text],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    envelope(
        origin,
        0,
        "moment.append",
        json!({
            "momentId": format!("moment-{origin}-0"),
            "versionId": "main",
            "objectId": "owner",
            "objectCreatedAtMs": 1,
            "path": "owner.md",
            "recordedAtMs": 2_000,
            "operation": "write",
            "payloadBeforeBlobSha256": before_sha,
            "payloadBeforePath": "owner.md",
            "payloadAfterBlobSha256": sha,
            "payloadAfterPath": "owner.md",
            "metadata": {"origin": "sync"},
            "beforePresent": "present",
            "beforeObjectId": "owner",
            "beforeVersionId": "main",
            "beforePath": "owner.md",
            "beforeBlobSha256": before_sha,
            "beforeContentKind": "text",
            "beforeUpdatedAtMs": 1,
            "beforeLatestMomentId": before_moment,
            "beforeMetadata": {"origin": "api"}
        }),
    )
}

fn apply_change(
    store: &mut EngineStore,
    op: &ReplicationEnvelope,
    leases: &dyn LeaseProbe,
) -> Result<ApplyOutcome<i64>, SyncError> {
    crate::moment_apply::apply_moment_envelope(
        store,
        op,
        &NoFaults,
        leases,
        &ReleasedTails::default(),
    )
}

fn has_moment(store: &EngineStore) -> bool {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM moments WHERE moment_id='moment-laptop-0')",
                [],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// The owner edits a live note from a second device. On the computer bound
/// to the note's live session, the device's file change whose text the live
/// note already holds is the note's history: no file write, no conflict.
/// One whose text differs, or that comes from a share, gets today's answer.
#[test]
fn a_device_file_change_the_live_note_already_holds_is_history_on_the_bound_computer() {
    let (_dir, mut store, observed, checkpoint) = owner_publication::fixture();
    let device = Ydoc::wire();
    device.apply(&checkpoint).unwrap();
    let update = device.richdoc_append_paragraph("from the laptop");
    let before = head(&store);

    let other = device_change(&mut store, "phone", "some other text\n");
    let outcome = apply_change(&mut store, &other, &NoLiveLeases).unwrap();
    assert!(
        matches!(
            &outcome.primary,
            ApplyDisposition::Refused(refusal)
                if Some(&refusal.reason)
                    == crate::apply::refusal_reason(&SyncError::LiveDocumentBindingActive).as_ref()
        ),
        "{:?}",
        outcome.primary
    );
    assert!(!has_moment(&store));

    receive_frame(&mut store, &observed, update);
    let text = live_text(&mut store);
    let shared = device_change(&mut store, "share:recipient", &text);
    let outcome = apply_change(&mut store, &shared, &NoLiveLeases).unwrap();
    assert!(
        matches!(outcome.primary, ApplyDisposition::Refused(_)),
        "{:?}",
        outcome.primary
    );

    let change = device_change(&mut store, "laptop", &text);
    let outcome = apply_change(&mut store, &change, &NoLiveLeases).unwrap();
    assert!(
        matches!(outcome.primary, ApplyDisposition::Applied(0)),
        "{:?}",
        outcome.primary
    );
    assert!(has_moment(&store));
    assert_eq!(head(&store), before);
}

/// The bound computer's own edit waits on the relay while the relay accepts
/// the device's edit. The waiting edit is not in the text a device's file
/// change is compared with, and does not keep that change from being history.
#[test]
fn a_device_file_change_pairs_only_with_text_the_relay_accepted() {
    let (_dir, mut store, observed, checkpoint) = owner_publication::fixture();
    let device = Ydoc::wire();
    device.apply(&checkpoint).unwrap();
    let update = device.richdoc_append_paragraph("from the laptop");
    let before = head(&store);
    let local = Ydoc::wire();
    local.apply(&checkpoint).unwrap();
    dohc_engine_collab::owner_outbox::draft::append_draft_cached(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        "ws",
        dohc_engine_collab::owner_outbox::draft::OwnerDraftAppendInput {
            person_edit: true,
            binding: observed.binding.clone(),
            expected_revision: Some(1),
            append_key: "waiting-edit".into(),
            update: local.richdoc_append_paragraph("not accepted yet"),
            now_ms: 3,
            agent_declaration: None,
            agent_run_id: None,
            automation_declaration: None,
        },
        &NoFaults,
    )
    .unwrap();

    receive_frame(&mut store, &observed, update);
    let text = live_text(&mut store);
    assert!(text.contains("from the laptop"), "{text}");
    assert!(!text.contains("not accepted yet"), "{text}");
    let change = device_change(&mut store, "laptop", &text);
    let outcome = apply_change(&mut store, &change, &NoLiveLeases).unwrap();
    assert!(
        matches!(outcome.primary, ApplyDisposition::Applied(0)),
        "{:?}",
        outcome.primary
    );
    assert!(has_moment(&store));
    assert_eq!(head(&store), before);
}

/// With the note open live on the bound computer, the device's file change
/// can arrive before the relay's frame of its edit. It waits, and once the
/// frame arrives it is the note's history.
#[test]
fn a_device_file_change_waits_for_its_frame_on_the_bound_computer() {
    let (_dir, mut store, observed, checkpoint) = owner_publication::fixture();
    let device = Ydoc::wire();
    device.apply(&checkpoint).unwrap();
    let update = device.richdoc_append_paragraph("from the laptop");
    let before = head(&store);
    let expected = {
        let (_dir, mut copy, observed, _) = owner_publication::fixture();
        receive_frame(&mut copy, &observed, update.clone());
        live_text(&mut copy)
    };

    let change = device_change(&mut store, "laptop", &expected);
    let waits = apply_change(&mut store, &change, &crate::ydoc_apply::AlwaysLive);
    assert!(
        matches!(waits, Err(SyncError::RetryableState { .. })),
        "{waits:?}"
    );
    assert!(!has_moment(&store));

    receive_frame(&mut store, &observed, update);
    let outcome = apply_change(&mut store, &change, &crate::ydoc_apply::AlwaysLive).unwrap();
    assert!(
        matches!(outcome.primary, ApplyDisposition::Applied(0)),
        "{:?}",
        outcome.primary
    );
    assert!(has_moment(&store));
    assert_eq!(head(&store), before);
}
