//! On the owner's own computer a shared note is live through its owner
//! binding, with no relay activation. Capture holds a file that changed
//! outside dohc there, as it does on a relay host, and never holds the text
//! dohc itself puts in the file (#4003, #2756).
use super::*;
use crate::{CaptureLineage, admit_capture_in_tx, prepare_local_ydoc_lineage_in_tx};

const OUTSIDE: &str = "Changed outside dohc.\n";

/// The owner's durable rows, which capture's decision must leave alone.
fn owner_rows(store: &EngineStore) -> Vec<String> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT json_array(o.outbox_id,o.state,o.pending_bytes,o.quarantine_reason,b.binding_revision,b.accepted_cursor) \
                 FROM ydoc_owner_bindings b LEFT JOIN owner_ydoc_outboxes o ON o.workspace_id=b.workspace_id \
                 AND o.main_version_id=b.main_version_id AND o.object_id=b.object_id ORDER BY 1",
            )?
            .query_map([], |row| row.get(0))?
            .collect()
        })
        .unwrap()
}

/// What capture decides for `text` at `owner.md`. Deciding writes nothing.
fn admission(store: &mut EngineStore, text: &str) -> CaptureLineage {
    let key = DocKey::new("ws", "main", "object").unwrap();
    let before = owner_rows(store);
    let dohc_engine_storage::TxnOutcome::Committed(outcome) = store
        .write_with(&NoFaults, |tx| {
            let prepared = prepare_local_ydoc_lineage_in_tx(tx, &key)?;
            admit_capture_in_tx(tx, &prepared, "owner.md", text)
        })
        .unwrap()
    else {
        panic!("the decision must complete")
    };
    assert_eq!(owner_rows(store), before, "deciding writes no owner row");
    outcome
}

fn no_activation(store: &EngineStore) {
    let activations: i64 = store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM live_owner_activations", [], |row| row.get(0))
        })
        .unwrap();
    assert_eq!(activations, 0, "the desktop's shape has no activation");
}

/// The owner's binding with nothing pending: its own text is not held, and
/// bytes from outside are.
#[test]
fn a_bound_note_holds_an_outside_change_and_not_its_own_text() {
    let mut owner = restore_owner();
    no_activation(&owner.store);
    let initial = owner.initial_text.clone();
    assert_ne!(admission(&mut owner.store, &initial), CaptureLineage::HeldOutside);
    assert_eq!(admission(&mut owner.store, OUTSIDE), CaptureLineage::HeldOutside);
}

/// The relay accepted the owner's typing and sync then brought the settled
/// text, which the materializer wrote. Neither the file that still trails the
/// accepted note nor the text sync wrote is held.
#[test]
fn text_dohc_wrote_from_sync_is_not_held() {
    let mut owner = restore_owner();
    let host = Ydoc::wire();
    host.apply(&owner.checkpoint).unwrap();
    let frame = host.richdoc_append_paragraph("OWNER-1");
    let text = host.project(YdocContentKind::Richdoc).unwrap().content;
    hydrate_texts(&mut owner.store, &[&text]);
    let id = format!("moment-ydoc-{}", "c".repeat(64));
    retain_restore_audit(&owner.store, &owner.observed.binding, "relay", &id, &text, 1);
    apply_test_owner_frame(&mut owner, frame, 1);
    no_activation(&owner.store);

    // Accepted, not yet settled: the file holds the bytes dohc recorded.
    let initial = owner.initial_text.clone();
    assert_eq!(
        admission(&mut owner.store, &initial),
        CaptureLineage::KeepTail,
        "a file only behind its accepted note keeps the note as it is"
    );
    assert_eq!(admission(&mut owner.store, OUTSIDE), CaptureLineage::HeldOutside);

    let mut settlement = restore_settlement(
        "host",
        &id,
        &owner.initial_text,
        &owner.initial_moment,
        &text,
    );
    settlement.payload["settlementReference"] = json!({
        "formatVersion": 1,
        "recordDigest": "test",
        "record": {"settlementId": id, "momentId": id, "binding": {"workspaceId": "ws"}}
    });
    settlement.relay_seq = Some(11);
    settlement.settlement_admission = Some(crate::SettlementAdmission::Accepted {
        settlement_id: id.clone(),
    });
    settlement.admitted_author_snapshot =
        Some(json!([{"kind":"human","humanId":"owner","humanName":"owner"}]));
    assert!(matches!(
        apply_moment_envelope(&mut owner.store, &settlement, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Applied(_)
    ));
    assert_eq!(
        snapshot(&owner.store, "object").map(|(_, _, digest, moment)| (digest, moment)),
        Some((text_sha(&text), id)),
        "sync recorded the settled text, which the materializer writes"
    );
    assert_ne!(admission(&mut owner.store, &text), CaptureLineage::HeldOutside);
    assert_eq!(admission(&mut owner.store, OUTSIDE), CaptureLineage::HeldOutside);
}

/// A quarantined draft keeps its binding, so its note still holds an outside
/// change, and deciding leaves the draft's recovery row as it was.
#[test]
fn a_quarantined_draft_still_holds_an_outside_change() {
    use dohc_engine_collab::owner_outbox::{OwnerOutboxQuarantineInput, draft::append_draft_in_tx};
    let mut owner = restore_owner();
    let typed = Ydoc::wire();
    typed.apply(&owner.checkpoint).unwrap();
    let update = typed.richdoc_append_paragraph("OWNER-1");
    let binding = owner.observed.binding.clone();
    let revision = owner.observed.revision;
    let dohc_engine_storage::TxnOutcome::Committed(draft) = owner
        .store
        .write_with(&NoFaults, |tx| {
            append_draft_in_tx(tx, "ws", &binding, revision, "typed".into(), update, 3)
        })
        .unwrap()
    else {
        panic!("draft must commit")
    };
    dohc_engine_collab::owner_outbox::quarantine(
        &mut owner.store,
        "ws",
        OwnerOutboxQuarantineInput {
            outbox_id: draft.outbox_id,
            reason: "binding-changed".into(),
            observed_binding: None,
        },
        4,
    )
    .unwrap();
    let rows = owner_rows(&owner.store);
    assert!(
        rows.iter().any(|row| row.contains("quarantined")),
        "the draft is quarantined: {rows:?}"
    );
    no_activation(&owner.store);
    assert_eq!(admission(&mut owner.store, OUTSIDE), CaptureLineage::HeldOutside);
    let initial = owner.initial_text.clone();
    assert_ne!(admission(&mut owner.store, &initial), CaptureLineage::HeldOutside);
}
