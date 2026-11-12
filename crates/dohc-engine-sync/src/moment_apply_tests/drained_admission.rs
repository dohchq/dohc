//! A host settlement can reach the owner by ordinary sync before the owner's
//! live feed accepts it. It waits in the owner's queue, and the drain writes
//! its moment later. The relay's admission came with it, so that moment must
//! name the authors the relay admitted for it, and no one else.
use super::*;
use crate::moment_apply::pending::drain_to_end;

fn snapshot_of(human: &str) -> Value {
    json!([{"kind":"human","humanId":human,"humanName":human}])
}

fn confirmed(human: &str) -> Value {
    json!([{"kind":"human","humanId":human,"humanName":human,"relayConfirmed":true}])
}

/// `settlement` as the relay delivers it with an accepted admission.
fn admit(mut settlement: ReplicationEnvelope, authors: Value) -> ReplicationEnvelope {
    let id = settlement.payload["momentId"].as_str().unwrap().to_owned();
    settlement.relay_seq = Some(10 + settlement.origin_seq);
    settlement.settlement_admission =
        Some(crate::SettlementAdmission::Accepted { settlement_id: id });
    settlement.admitted_author_snapshot = Some(authors);
    settlement
}

struct Early {
    owner: RestoreOwner,
    /// The host's live update for each settlement, in cursor order.
    frames: Vec<Vec<u8>>,
    settlements: Vec<ReplicationEnvelope>,
}

/// One host settlement of the owner's note per entry, at host cursors 1, 2,
/// and so on, each appending a paragraph. An entry's authors make it an
/// admitted settlement; `None` leaves it without an admission. Nothing is
/// applied yet.
fn early(admitted: &[Option<Value>]) -> Early {
    let mut owner = restore_owner();
    let host = Ydoc::wire();
    host.apply(&owner.checkpoint).unwrap();
    let mut frames = Vec::new();
    let mut settlements = Vec::new();
    for (index, authors) in admitted.iter().enumerate() {
        let cursor = index as i64 + 1;
        frames.push(host.richdoc_append_paragraph(&format!("host save {cursor}")));
        let text = host.project(YdocContentKind::Richdoc).unwrap().content;
        hydrate_texts(&mut owner.store, &[&text]);
        let id = format!("moment-ydoc-{}", ["c", "d", "e"][index].repeat(64));
        retain_restore_audit(
            &owner.store,
            &owner.observed.binding,
            "relay",
            &id,
            &text,
            cursor,
        );
        let mut settlement = envelope(
            "host",
            index as i64,
            "ws",
            present_text_payload(
                &id,
                "object",
                "write",
                "owner.md",
                "owner.md",
                &owner.initial_text,
                &owner.initial_moment,
                &text,
            ),
        );
        settlement.payload["settlementReference"] = json!({
            "formatVersion": 1,
            "recordDigest": "test",
            "record": {"settlementId": id, "momentId": id, "binding": {"workspaceId": "ws"}}
        });
        if let Some(authors) = authors {
            settlement = admit(settlement, authors.clone());
        }
        settlements.push(settlement);
    }
    Early {
        owner,
        frames,
        settlements,
    }
}

/// Each settlement's moment authors, in order. A missing moment panics.
fn authors(store: &EngineStore, settlements: &[ReplicationEnvelope]) -> Vec<Option<Value>> {
    settlements
        .iter()
        .map(|settlement| {
            let author_json: Option<String> = store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT author_json FROM moments WHERE moment_id=?1",
                        [settlement.payload["momentId"].as_str().unwrap()],
                        |row| row.get(0),
                    )
                })
                .unwrap();
            author_json.map(|json| serde_json::from_str(&json).unwrap())
        })
        .collect()
}

fn queue_early(owner: &mut RestoreOwner, settlements: &[ReplicationEnvelope]) {
    for settlement in settlements {
        assert_eq!(
            apply_moment_envelope(&mut owner.store, settlement, &NoFaults).unwrap(),
            ApplyOutcome::new(ApplyDisposition::Applied(0)),
            "the settlement waits for the owner's feed"
        );
    }
    assert_eq!(
        owner
            .store
            .table_row_count("owner_pending_settlements")
            .unwrap(),
        settlements.len() as i64
    );
}

fn accept_frames(owner: &mut RestoreOwner, frames: Vec<Vec<u8>>) {
    for (index, frame) in frames.into_iter().enumerate() {
        apply_test_owner_frame(owner, frame, index as i64 + 1);
    }
}

/// Drain again and deliver every settlement again: neither changes a moment.
fn assert_settled(owner: &mut RestoreOwner, settlements: &[ReplicationEnvelope]) {
    let named = authors(&owner.store, settlements);
    let moments = owner.store.table_row_count("moments").unwrap();
    drain_to_end(&mut owner.store, "ws", &NoFaults, &NoLiveLeases).unwrap();
    for settlement in settlements {
        assert_eq!(
            apply_moment_envelope(&mut owner.store, settlement, &NoFaults)
                .unwrap()
                .primary,
            ApplyDisposition::Skipped
        );
    }
    assert_eq!(authors(&owner.store, settlements), named);
    assert_eq!(owner.store.table_row_count("moments").unwrap(), moments);
}

/// The recipient's first delivery reached the owner before the owner's feed
/// did. The drain wrote its moment with no authors, though the relay had
/// admitted the recipient. Each drained moment takes the admission stored
/// for its own coordinate, the first behind the feed's head and the last at
/// it, and one with no admission stays without authors.
#[test]
fn a_drained_settlement_takes_the_authors_admitted_for_its_coordinate() {
    let Early {
        mut owner,
        frames,
        settlements,
    } = early(&[
        Some(snapshot_of("recipient")),
        None,
        Some(snapshot_of("owner")),
    ]);
    queue_early(&mut owner, &settlements);
    assert_eq!(
        owner
            .store
            .table_row_count("live_settlement_publication_admissions")
            .unwrap(),
        2,
        "both admissions are stored before the drain"
    );
    accept_frames(&mut owner, frames);
    let drained = drain_to_end(&mut owner.store, "ws", &NoFaults, &NoLiveLeases).unwrap();
    assert!(drained.report_id.is_some());
    assert_eq!(
        authors(&owner.store, &settlements),
        [Some(confirmed("recipient")), None, Some(confirmed("owner"))]
    );
    assert_settled(&mut owner, &settlements);
}

/// An admission that arrives once the drain has written the moment names it.
#[test]
fn an_admission_after_the_drain_names_the_drained_moment() {
    let Early {
        mut owner,
        frames,
        settlements,
    } = early(&[None]);
    queue_early(&mut owner, &settlements);
    accept_frames(&mut owner, frames);
    drain_to_end(&mut owner.store, "ws", &NoFaults, &NoLiveLeases).unwrap();
    assert_eq!(authors(&owner.store, &settlements), [None]);
    let admitted = [admit(settlements[0].clone(), snapshot_of("recipient"))];
    assert_eq!(
        apply_moment_envelope(&mut owner.store, &admitted[0], &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Skipped
    );
    assert_eq!(
        authors(&owner.store, &admitted),
        [Some(confirmed("recipient"))]
    );
    assert_settled(&mut owner, &admitted);
}

/// A settlement that arrives after the owner's feed applies at once with its
/// authors, and a drain afterwards leaves them as they are.
#[test]
fn a_settlement_after_its_frame_keeps_its_authors_through_a_drain() {
    let Early {
        mut owner,
        frames,
        settlements,
    } = early(&[Some(snapshot_of("recipient"))]);
    accept_frames(&mut owner, frames);
    assert!(matches!(
        apply_moment_envelope(&mut owner.store, &settlements[0], &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Applied(_)
    ));
    assert_eq!(
        owner
            .store
            .table_row_count("owner_pending_settlements")
            .unwrap(),
        0
    );
    assert_eq!(
        authors(&owner.store, &settlements),
        [Some(confirmed("recipient"))]
    );
    assert_settled(&mut owner, &settlements);
}
