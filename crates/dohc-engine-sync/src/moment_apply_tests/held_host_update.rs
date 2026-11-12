//! The service host's update of a live note can reach the note's owner by
//! ordinary sync before the owner's feed accepts the same event. The owner
//! holds it until its feed can say whether it is an echo, and refuses it,
//! exactly as it would have on arrival, when the host's next op shows it was
//! no live delivery, or when the binding ends.
use super::*;
use crate::ydoc_apply::{
    LIVE_UNADMITTED_UPDATE, decide_owner_holds, decide_owner_holds_in_workspace, unbind_owner_in_tx,
};
use dohc_engine_collab::WriterDocCache;

const HOST: &str = "service-host:host";

fn key() -> DocKey {
    DocKey::new("ws", "main", "object").unwrap()
}

/// The host's update `bytes` at `seq`, as ordinary sync delivers it.
fn host_update(owner: &RestoreOwner, seq: i64, bytes: &[u8]) -> ReplicationEnvelope {
    let digest = owner.store.put_binary_blob(bytes).unwrap();
    ReplicationEnvelope {
        op_kind: "ydoc.update".into(),
        relay_seq: Some(100 + seq),
        payload: crate::ydoc_update_payload(
            &key(),
            "owner.md",
            YdocContentKind::Richdoc,
            &digest,
            &owner.observed.binding.lineage_claim_id,
            None,
            None,
            false,
        ),
        ..envelope(HOST, seq, "ws", json!({}))
    }
}

/// The host's audit at `seq` of the live delivery whose update is `digest`
/// and whose feed event is `event_count`, applied as an owner applies it. Its
/// parser is covered separately, so only the payload and the event row a hold
/// reads are real. The note's journal is the relay's alone here, so the
/// event's cursor is its count.
fn apply_audit(owner: &mut RestoreOwner, seq: i64, digest: &str, event_count: i64) {
    apply_audit_at(owner, seq, digest, event_count, Some(event_count));
}

/// [`apply_audit`] for an event the relay journaled at `cursor`. The relay's
/// journal cursor counts every note's events, so it runs ahead of the note's
/// own count once another note shares the journal. With no `cursor`, the
/// audit applies without its event row, a state no real apply leaves.
fn apply_audit_at(
    owner: &mut RestoreOwner,
    seq: i64,
    digest: &str,
    event_count: i64,
    cursor: Option<i64>,
) {
    let lineage = owner.observed.binding.lineage_claim_id.clone();
    let record = owner
        .store
        .put_binary_blob(format!("record-{event_count}").as_bytes())
        .unwrap();
    let audit = ReplicationEnvelope {
        op_kind: "live.audit.application".into(),
        relay_seq: Some(100 + seq),
        payload: json!({
            "relayDatabaseNamespace": "relay",
            "mainVersionId": "main",
            "objectId": "object",
            "lineageClaimId": owner.observed.binding.lineage_claim_id,
            "eventCount": event_count,
            "manifest": {},
            "updateBlobSha256": digest,
        }),
        ..envelope(HOST, seq, "ws", json!({}))
    };
    crate::apply_envelope_with(&mut owner.store, &audit, &NoFaults, |tx, _| {
        tx.execute(
            "INSERT INTO live_audit_record_manifests VALUES (?1,'{}',?1)",
            [&record],
        )
        .map_err(SyncError::persist)?;
        let Some(cursor) = cursor else {
            return Ok(());
        };
        tx.execute(
            "INSERT INTO live_audit_events(relay_database_namespace,workspace_id,main_version_id,\
             object_id,lineage_claim_id,event_count,record_digest,evidence_digest,journal_cursor,\
             delivery_id,accepting_host_epoch) VALUES ('relay','ws','main','object',?1,?2,?3,?3,?4,?5,1)",
            params![lineage, event_count, record, cursor, format!("delivery-{cursor}")],
        )
        .map_err(SyncError::persist)?;
        Ok(())
    })
    .unwrap();
}

/// The relay's journal is shared, so another note's events took cursors
/// between this note's. The owner holds the host's update until its feed
/// reaches the event's cursor, not its count: here its second event, at
/// cursor 5, while the feed has accepted the first, at cursor 2.
#[test]
fn a_held_update_waits_for_its_events_journal_cursor_not_its_count() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [earlier] = host_edits(&owner, ["the note's first event"]);
    apply_test_owner_frame(&mut owner, earlier, 2);
    let [edit] = host_edits(&owner, ["the note's second event"]);
    let update = host_update(&owner, 0, &edit);
    assert_held(arrive(&mut owner, &mut cache, &update));
    apply_audit_at(&mut owner, 1, &digest_of(&update), 2, Some(5));
    assert!(pass_ends(&mut owner, &mut cache).is_empty());
    assert_eq!(held(&owner), [0], "the feed has not reached cursor 5");
    accept(&mut owner, &mut cache, edit, 5);
    assert!(held(&owner).is_empty());
    assert!(refused(&owner).is_empty());
}

/// An applied audit without its event row: the owner can't tell where the
/// feed delivers the event, so it keeps holding, even with its feed past the
/// event's count. The feed delivering the update still ends the hold.
#[test]
fn a_held_update_whose_audit_has_no_event_row_stays_held() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [earlier] = host_edits(&owner, ["the note's first event"]);
    apply_test_owner_frame(&mut owner, earlier, 3);
    let [edit] = host_edits(&owner, ["the note's second event"]);
    let update = host_update(&owner, 0, &edit);
    assert_held(arrive(&mut owner, &mut cache, &update));
    apply_audit_at(&mut owner, 1, &digest_of(&update), 2, None);
    assert!(pass_ends(&mut owner, &mut cache).is_empty());
    assert_eq!(held(&owner), [0], "no event row: keep holding");
    accept(&mut owner, &mut cache, edit, 6);
    assert!(held(&owner).is_empty());
    assert!(refused(&owner).is_empty());
}

fn digest_of(update: &ReplicationEnvelope) -> String {
    update.payload["updateBlobSha256"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Whether `update` arrived to be held: applied, queued, not refused.
fn arrive(
    owner: &mut RestoreOwner,
    cache: &mut WriterDocCache,
    update: &ReplicationEnvelope,
) -> ApplyDisposition<crate::YdocApplyResult> {
    apply_ydoc_envelope(&mut owner.store, cache, update, &NoFaults, &NoLiveLeases)
        .unwrap()
        .primary
}

fn assert_held(disposition: ApplyDisposition<crate::YdocApplyResult>) {
    assert!(
        matches!(&disposition, ApplyDisposition::Applied(result) if result.deferred),
        "the owner holds the host's update, not {disposition:?}"
    );
}

/// The host's queued updates, in arrival order.
fn held(owner: &RestoreOwner) -> Vec<i64> {
    owner
        .store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT origin_seq FROM ydoc_deferred_updates WHERE origin_id=?1 \
                 ORDER BY relay_seq,origin_seq",
            )?;
            statement
                .query_map([HOST], |row| row.get(0))?
                .collect::<Result<Vec<i64>, _>>()
        })
        .unwrap()
}

fn refused(owner: &RestoreOwner) -> Vec<(i64, String)> {
    owner
        .store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT origin_seq,reason_message FROM replication_pending_refusals \
                 ORDER BY origin_seq",
            )?;
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap()
}

/// What the owner keeps for the host's update at `seq`, field by field: its
/// pending refusal, its journal disposition, its kept bytes, the workspace's
/// Notices, and the note's text and history.
fn record_of(owner: &RestoreOwner, seq: i64) -> Value {
    let text = dohc_engine_collab::load_persisted(&owner.store, &key())
        .unwrap()
        .unwrap()
        .doc
        .project(YdocContentKind::Richdoc)
        .unwrap()
        .content;
    json!({"rows": rows_of(owner, seq), "notices": notices(owner), "text": text})
}

fn notices(owner: &RestoreOwner) -> String {
    let notices = crate::refusal_notices::list_refusal_notices(&owner.store, "ws").unwrap();
    format!("{notices:?}")
}

/// `record_of` without the note's text, for a note whose lineage is gone.
fn rows_of(owner: &RestoreOwner, seq: i64) -> Value {
    owner
        .store
        .read_with(|conn| {
            let refusal: Option<(String, String, String)> = conn
                .query_row(
                    "SELECT op_kind,reason_code,reason_message FROM replication_pending_refusals \
                     WHERE origin_id=?1 AND origin_seq=?2",
                    params![HOST, seq],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let disposition: Option<String> = conn
                .query_row(
                    "SELECT apply_disposition FROM replication_log WHERE origin_id=?1 AND origin_seq=?2",
                    params![HOST, seq],
                    |row| row.get(0),
                )
                .optional()?;
            let kept: Option<String> = conn
                .query_row(
                    "SELECT update_sha256 FROM replication_refused_ydoc_blobs \
                     WHERE origin_id=?1 AND origin_seq=?2",
                    params![HOST, seq],
                    |row| row.get(0),
                )
                .optional()?;
            let counts: (i64, i64, i64) = conn.query_row(
                "SELECT (SELECT COUNT(*) FROM ydoc_updates),(SELECT COUNT(*) FROM moments),\
                 (SELECT COUNT(*) FROM ydoc_deferred_updates WHERE origin_id=?1 AND origin_seq=?2)",
                params![HOST, seq],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            Ok::<_, rusqlite::Error>(json!({
                "refusal": refusal,
                "disposition": disposition,
                "kept": kept,
                "updates": counts.0,
                "moments": counts.1,
                "queued": counts.2,
            }))
        })
        .unwrap()
}

/// The owner's feed accepts `update` at `cursor`, and the owner decides what
/// it holds, as each committed frame does.
fn accept(owner: &mut RestoreOwner, cache: &mut WriterDocCache, update: Vec<u8>, cursor: i64) {
    apply_test_owner_frame(owner, update, cursor);
    let decided = decide_owner_holds(&mut owner.store, cache, &key(), &NoFaults).unwrap();
    assert!(decided.waiting.is_none());
}

/// What the owner decides as a pull pass ends.
fn pass_ends(owner: &mut RestoreOwner, cache: &mut WriterDocCache) -> Vec<ReplicationRefusal> {
    let decided =
        decide_owner_holds_in_workspace(&mut owner.store, cache, "ws", &NoFaults).unwrap();
    assert!(decided.waiting.is_none());
    decided.refusals
}

/// A host whose next edits append `paragraphs` to the owner's note: each
/// paragraph's update bytes, in order.
fn host_edits<const N: usize>(owner: &RestoreOwner, paragraphs: [&str; N]) -> [Vec<u8>; N] {
    let host = Ydoc::wire();
    host.apply(&owner.checkpoint).unwrap();
    paragraphs.map(|paragraph| host.richdoc_append_paragraph(paragraph))
}

/// The recipient typed; the service host's update of it reached the owner
/// 34 ms before the owner's feed, and the owner refused its own edit's echo.
/// It now waits, through the host's audit, for the feed, and leaves as the
/// echo it is: no refusal, no Notice, nothing written, nothing reported.
#[test]
fn a_host_update_ahead_of_the_feed_waits_for_it_and_leaves_as_an_echo() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [edit] = host_edits(&owner, ["recipient typing"]);
    let update = host_update(&owner, 0, &edit);
    let before = record_of(&owner, -1);
    assert_held(arrive(&mut owner, &mut cache, &update));
    assert_eq!(held(&owner), [0]);
    assert!(pass_ends(&mut owner, &mut cache).is_empty());
    apply_audit(&mut owner, 1, &digest_of(&update), 1);
    assert!(
        pass_ends(&mut owner, &mut cache).is_empty(),
        "the audit names it and the feed has not reached it"
    );
    assert_eq!(held(&owner), [0]);
    let while_held = record_of(&owner, 0);
    assert_eq!(while_held["rows"]["refusal"], Value::Null);
    assert_eq!(while_held["rows"]["disposition"], "applied");
    assert_eq!(while_held["rows"]["updates"], before["rows"]["updates"]);
    assert_eq!(while_held["rows"]["moments"], before["rows"]["moments"]);
    assert_eq!(while_held["notices"], before["notices"]);
    accept(&mut owner, &mut cache, edit, 1);
    assert!(held(&owner).is_empty());
    assert!(refused(&owner).is_empty());
    let after = record_of(&owner, 0);
    assert_eq!(after["rows"]["disposition"], "applied");
    assert_eq!(after["rows"]["kept"], Value::Null);
    assert_eq!(after["notices"], before["notices"]);
    assert!(pass_ends(&mut owner, &mut cache).is_empty());
    assert!(matches!(
        arrive(&mut owner, &mut cache, &update),
        ApplyDisposition::Skipped
    ));
}

/// The host's next op is no audit, so the update was no live delivery. The
/// owner refuses it as the pass ends, and keeps exactly what it keeps for
/// one it refuses on arrival: the same refusal, journal disposition, kept
/// bytes, Notice and text. Nothing about the owner's note changes.
#[test]
fn a_host_update_no_audit_follows_is_refused_as_on_arrival() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [first, second] = host_edits(&owner, ["not live", "after it"]);
    let update = host_update(&owner, 0, &first);
    assert_held(arrive(&mut owner, &mut cache, &update));
    // The next host update arrives behind the held one.
    let next = host_update(&owner, 1, &second);
    assert_held(arrive(&mut owner, &mut cache, &next));
    let refusals = pass_ends(&mut owner, &mut cache);
    assert_eq!(
        refusals
            .iter()
            .map(|refusal| (refusal.origin_seq, refusal.reason.message().to_owned()))
            .collect::<Vec<_>>(),
        [(0, LIVE_UNADMITTED_UPDATE.to_owned())]
    );
    assert_eq!(held(&owner), [1], "the next one waits for its own audit");
    let decided = record_of(&owner, 0);

    assert_eq!(decided, refused_on_arrival(&first));
    assert_eq!(decided["rows"]["disposition"], "refused");
    assert_eq!(decided["rows"]["kept"], json!(digest_of(&update)));
    assert!(!decided["text"].as_str().unwrap().contains("not live"));
}

/// What a fresh owner keeps for the host's update `bytes` at sequence 0 when
/// it refuses it on arrival, because the host's next op is already known and
/// is no audit.
fn refused_on_arrival(bytes: &[u8]) -> Value {
    let mut twin = restore_owner();
    let mut cache = WriterDocCache::new();
    let update = host_update(&twin, 0, bytes);
    let next = twin.store.put_binary_blob(b"the host's next op").unwrap();
    let payload = serde_json::to_string(&json!({ "updateBlobSha256": next })).unwrap();
    twin.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,\
                 recorded_at_ms,imported,apply_disposition) VALUES ('ws',?1,1,'ydoc.update',?2,1,1,'applied')",
                params![HOST, payload],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)
        })
        .unwrap();
    assert!(matches!(
        arrive(&mut twin, &mut cache, &update),
        ApplyDisposition::Refused(refusal) if refusal.reason.message() == LIVE_UNADMITTED_UPDATE
    ));
    record_of(&twin, 0)
}

/// The host's `update`, queued for another reason than a hold: here as a
/// session lease or an unbound note queues it. Its row is the row a hold
/// writes, so from here on it is held the same way.
fn queued_for_another_reason(owner: &mut RestoreOwner, update: &ReplicationEnvelope) {
    let lineage = owner.observed.binding.lineage_claim_id.clone();
    let relay_seq = update.relay_seq.unwrap();
    crate::apply_envelope_with(&mut owner.store, update, &NoFaults, |tx, op| {
        crate::ydoc_apply::defer_ydoc_update_in_tx(tx, &key(), op, &lineage, relay_seq, None)
    })
    .unwrap();
    assert_eq!(held(owner), [update.origin_seq]);
}

/// The owner's Stop, with the relay's cut at `cut`, releases the note and
/// ends its binding.
fn stop(owner: &mut RestoreOwner, cut: i64) {
    use dohc_engine_collab::owner_outbox::{OwnerOutboxError, release};
    let binding = owner.observed.binding.clone();
    let dohc_engine_storage::TxnOutcome::Committed(stop) = owner
        .store
        .write_with(&NoFaults, |tx| {
            release::request_in_tx(tx, &key(), 21)?;
            crate::ydoc_apply::unbind_owner_in_tx(
                tx,
                &key(),
                |_| OwnerOutboxError::Corrupt,
                |tx| {
                    release::release_in_tx(
                        tx,
                        &binding,
                        Some(cut),
                        None,
                        22,
                        |_, _, _, _, _| Ok(()),
                    )
                },
            )
        })
        .unwrap()
    else {
        panic!("Stop must commit")
    };
    assert!(stop.deferred.is_none(), "the Stop releases the binding");
    assert_eq!(
        owner.store.table_row_count("ydoc_owner_bindings").unwrap(),
        0
    );
}

/// A host update another reason queued is held as one that arrived early:
/// the feed delivering its bytes ends it as an echo.
#[test]
fn a_host_update_queued_for_another_reason_leaves_as_an_echo() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [edit] = host_edits(&owner, ["queued for another reason"]);
    let update = host_update(&owner, 0, &edit);
    let before = record_of(&owner, -1);
    queued_for_another_reason(&mut owner, &update);
    assert!(pass_ends(&mut owner, &mut cache).is_empty());
    assert_eq!(held(&owner), [0], "held, not refused or applied");
    apply_audit(&mut owner, 1, &digest_of(&update), 1);
    accept(&mut owner, &mut cache, edit, 1);
    assert!(held(&owner).is_empty());
    assert!(refused(&owner).is_empty());
    let after = record_of(&owner, 0);
    assert_eq!(after["rows"]["disposition"], "applied");
    assert_eq!(after["rows"]["kept"], Value::Null);
    assert_eq!(after["notices"], before["notices"]);
}

/// A host update another reason queued whose bytes never match is refused
/// at the same end as one held on arrival, with what a refusal on arrival
/// keeps.
#[test]
fn a_host_update_queued_for_another_reason_that_never_matches_is_refused() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [edit] = host_edits(&owner, ["never matches"]);
    let update = host_update(&owner, 0, &edit);
    queued_for_another_reason(&mut owner, &update);
    assert!(pass_ends(&mut owner, &mut cache).is_empty());
    apply_audit(&mut owner, 1, &"f".repeat(64), 1);
    assert_eq!(pass_ends(&mut owner, &mut cache).len(), 1);
    assert!(held(&owner).is_empty());
    assert_eq!(record_of(&owner, 0), refused_on_arrival(&edit));
}

/// Stop ends the binding after the feed delivered a held update's bytes,
/// before anything decided the hold: the update leaves as the echo it is,
/// with no refusal and no Notice.
#[test]
fn a_stop_after_the_feed_delivered_a_held_update_refuses_nothing() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [edit] = host_edits(&owner, ["delivered before Stop"]);
    let update = host_update(&owner, 0, &edit);
    let before = record_of(&owner, -1);
    assert_held(arrive(&mut owner, &mut cache, &update));
    apply_audit(&mut owner, 1, &digest_of(&update), 1);
    apply_test_owner_frame(&mut owner, edit, 1);
    stop(&mut owner, 1);
    assert!(held(&owner).is_empty());
    assert!(refused(&owner).is_empty());
    let after = record_of(&owner, 0);
    assert_eq!(after["rows"]["disposition"], "applied");
    assert_eq!(after["rows"]["kept"], Value::Null);
    assert_eq!(after["notices"], before["notices"]);
}

/// Stop ends the binding while the owner holds an update the feed never
/// delivered: it is refused as on arrival, its bytes are kept for review, and
/// the note never takes it.
#[test]
fn a_stop_while_holding_an_undelivered_update_refuses_it() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [edit] = host_edits(&owner, ["never delivered"]);
    let update = host_update(&owner, 0, &edit);
    assert_held(arrive(&mut owner, &mut cache, &update));
    stop(&mut owner, 0);
    assert!(held(&owner).is_empty());
    assert_eq!(refused(&owner), [(0, LIVE_UNADMITTED_UPDATE.to_owned())]);
    let record = record_of(&owner, 0);
    assert_eq!(record["rows"]["disposition"], "refused");
    assert_eq!(record["rows"]["kept"], json!(digest_of(&update)));
    assert_ne!(record["notices"], "[]");
    assert!(!record["text"].as_str().unwrap().contains("never delivered"));
}

/// The owner's Stop while the relay has not accepted an edit of the owner's,
/// recorded with the feed behind: the Stop releases the note but keeps its
/// binding until that edit is settled.
fn deferred_stop(owner: &mut RestoreOwner) {
    use dohc_engine_collab::owner_outbox::{OwnerOutboxError, draft::append_draft_in_tx, release};
    use dohc_engine_storage::TxnOutcome;
    let observed = owner.observed.clone();
    let [unsent] = host_edits(owner, ["the owner's unsent edit"]);
    assert!(matches!(
        owner.store.write_with(&NoFaults, |tx| {
            append_draft_in_tx(
                tx,
                "ws",
                &observed.binding,
                observed.revision,
                "unsent".into(),
                unsent,
                20,
            )
        }),
        Ok(TxnOutcome::Committed(_))
    ));
    let cursor = observed.accepted_cursor;
    let TxnOutcome::Committed(stop) = owner
        .store
        .write_with(&NoFaults, |tx| {
            release::request_in_tx(tx, &key(), 21)?;
            unbind_owner_in_tx(
                tx,
                &key(),
                |_| OwnerOutboxError::Corrupt,
                |tx| {
                    release::release_in_tx(
                        tx,
                        &observed.binding,
                        Some(cursor + 1),
                        None,
                        22,
                        |_, _, _, _, _| Ok(()),
                    )
                },
            )
        })
        .unwrap()
    else {
        panic!("Stop must commit")
    };
    assert!(
        stop.deferred.is_some(),
        "the Stop waits on the owner's unsent edit"
    );
    assert_eq!(
        owner.store.table_row_count("ydoc_owner_bindings").unwrap(),
        1
    );
}

/// The service host's queued rows marked as held.
fn flagged(owner: &RestoreOwner) -> i64 {
    owner
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM ydoc_deferred_updates WHERE deferred_while_bound=1",
                [],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// A Stop is recorded while the owner holds the host's update and its feed is
/// behind, and it waits on the owner's unsent edit, so it keeps the binding.
/// The Stop refuses the held update as on arrival: no hold exists under a
/// released binding. A host update that arrives after it is refused at once,
/// with no held row and nothing queued.
#[test]
fn a_deferred_stop_refuses_a_host_update_at_once_and_queues_nothing() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [first, later] = host_edits(&owner, ["held at the Stop", "after the Stop"]);
    let update = host_update(&owner, 0, &first);
    assert_held(arrive(&mut owner, &mut cache, &update));
    apply_audit(&mut owner, 1, &digest_of(&update), 1);
    deferred_stop(&mut owner);
    assert!(held(&owner).is_empty(), "the Stop decided the hold");
    assert_eq!(refused(&owner), [(0, LIVE_UNADMITTED_UPDATE.to_owned())]);
    assert_eq!(rows_of(&owner, 0)["kept"], json!(digest_of(&update)));

    let after = host_update(&owner, 2, &later);
    assert!(matches!(
        arrive(&mut owner, &mut cache, &after),
        ApplyDisposition::Refused(refusal) if refusal.reason.message() == LIVE_UNADMITTED_UPDATE
    ));
    assert_eq!(
        owner
            .store
            .table_row_count("ydoc_deferred_updates")
            .unwrap(),
        0,
        "nothing is queued under the released binding"
    );
    assert_eq!(
        refused(&owner),
        [
            (0, LIVE_UNADMITTED_UPDATE.to_owned()),
            (2, LIVE_UNADMITTED_UPDATE.to_owned())
        ]
    );
    let record = record_of(&owner, 2);
    assert_eq!(record["rows"]["disposition"], "refused");
    assert_eq!(record["rows"]["kept"], json!(digest_of(&after)));
    let text = record["text"].as_str().unwrap();
    assert!(!text.contains("held at the Stop") && !text.contains("after the Stop"));
}

/// A held host update, and then a Stop that stays deferred: the Stop decides
/// the hold, and deleting, archiving or replacing the note proceeds past the
/// binding it keeps, with the update refused once, as on arrival.
#[test]
fn retirement_proceeds_past_a_deferred_stop_that_decided_a_hold() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [edit] = host_edits(&owner, ["held at a deferred Stop"]);
    let update = host_update(&owner, 0, &edit);
    assert_held(arrive(&mut owner, &mut cache, &update));
    deferred_stop(&mut owner);
    assert_eq!(flagged(&owner), 0);
    assert_eq!(
        owner.store.table_row_count("ydoc_owner_bindings").unwrap(),
        1
    );
    assert!(matches!(
        retire(&mut owner),
        Ok(dohc_engine_storage::TxnOutcome::Committed(()))
    ));
    assert_eq!(
        owner.store.table_row_count("ydoc_owner_bindings").unwrap(),
        0
    );
    assert!(held(&owner).is_empty());
    assert_eq!(refused(&owner), [(0, LIVE_UNADMITTED_UPDATE.to_owned())]);
    assert_eq!(rows_of(&owner, 0)["kept"], json!(digest_of(&update)));
}

/// A marked row under a Stop that released its note but keeps its binding:
/// no hold exists under the release, so the next pull pass decides it
/// without waiting for the feed. Its update is refused as on arrival, its
/// bytes are kept and nothing stays queued, while the binding stays.
#[test]
fn a_marked_row_under_a_released_binding_is_decided_at_the_next_pass() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [edit] = host_edits(&owner, ["queued under a deferred Stop"]);
    deferred_stop(&mut owner);
    let update = host_update(&owner, 0, &edit);
    // The state is built by a direct call because no production path queues
    // a row under a released binding; it is not reachable.
    queued_for_another_reason(&mut owner, &update);
    assert_eq!(flagged(&owner), 1);
    assert_eq!(pass_ends(&mut owner, &mut cache).len(), 1);
    assert!(held(&owner).is_empty());
    assert_eq!(refused(&owner), [(0, LIVE_UNADMITTED_UPDATE.to_owned())]);
    assert_eq!(rows_of(&owner, 0)["kept"], json!(digest_of(&update)));
    assert_eq!(
        owner.store.table_row_count("ydoc_owner_bindings").unwrap(),
        1
    );
}

/// A Resume clears a deferred Stop while a marked row is queued under the
/// binding it kept. Nothing refuses the binding as corrupt: it stands, and
/// the row stays held for the binding's own end to decide.
#[test]
fn a_resume_over_a_marked_row_keeps_the_binding_and_the_hold() {
    use dohc_engine_collab::owner_outbox::{OwnerOutboxError, release};
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [edit] = host_edits(&owner, ["queued under a deferred Stop"]);
    deferred_stop(&mut owner);
    let update = host_update(&owner, 0, &edit);
    // The state is built by a direct call because no production path queues
    // a row under a released binding; it is not reachable.
    queued_for_another_reason(&mut owner, &update);
    assert_eq!(flagged(&owner), 1);
    owner
        .store
        .write_with(&NoFaults, |tx| release::clear_in_tx(tx, &key()))
        .unwrap();
    assert_eq!(owner.store.table_row_count("owner_live_stops").unwrap(), 0);
    assert!(!matches!(bind(&mut owner), Err(OwnerOutboxError::Corrupt)));
    assert_eq!(
        owner.store.table_row_count("ydoc_owner_bindings").unwrap(),
        1
    );
    assert!(pass_ends(&mut owner, &mut cache).is_empty());
    assert_eq!(held(&owner), [0]);
    assert_eq!(flagged(&owner), 1);
    assert!(refused(&owner).is_empty());
}

/// The owner installs `owner.observed` as its binding.
fn bind(
    owner: &mut RestoreOwner,
) -> Result<(), dohc_engine_collab::owner_outbox::OwnerOutboxError> {
    let observed = owner.observed.clone();
    let checkpoint = owner.checkpoint.clone();
    owner
        .store
        .write_with(&NoFaults, |tx| {
            dohc_engine_collab::owner_outbox::draft::install_observed_binding_in_tx(
                tx,
                "ws",
                &observed,
                &checkpoint,
            )
        })
        .map(|_| ())
}

/// The host's `update` queued with no binding over it, and, if `marked`,
/// marked as held: what an older build or a lost decision could leave.
fn left_queued(owner: &mut RestoreOwner, update: &ReplicationEnvelope, marked: bool) {
    queued_for_another_reason(owner, update);
    assert_eq!(flagged(owner), 0, "no binding marks it");
    owner
        .store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_deferred_updates SET deferred_while_bound=?1",
                [marked],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)
        })
        .unwrap();
    assert_eq!(flagged(owner), i64::from(marked));
}

/// A binding never takes over a held row an earlier binding left undecided:
/// the bind is refused, a fresh bind and a rebind after Stop alike, and it
/// installs nothing. The same bind over the same row unmarked succeeds.
#[test]
fn a_bind_is_refused_over_a_held_row_left_undecided() {
    use dohc_engine_collab::owner_outbox::OwnerOutboxError;
    for after_stop in [false, true] {
        let owner = |marked: bool| {
            let mut owner = if after_stop {
                let mut owner = restore_owner();
                stop(&mut owner, 0);
                owner
            } else {
                unbound_restore_owner()
            };
            let [edit] = host_edits(&owner, ["left undecided"]);
            let update = host_update(&owner, 0, &edit);
            left_queued(&mut owner, &update, marked);
            owner
        };
        let mut control = owner(false);
        assert!(
            bind(&mut control).is_ok(),
            "after Stop: {after_stop}; an unmarked row refuses no bind"
        );
        let mut marked = owner(true);
        assert!(
            matches!(bind(&mut marked), Err(OwnerOutboxError::Corrupt)),
            "after Stop: {after_stop}"
        );
        assert_eq!(
            marked.store.table_row_count("ydoc_owner_bindings").unwrap(),
            0
        );
        assert_eq!(held(&marked), [0], "the refused bind changes nothing");
        assert_eq!(flagged(&marked), 1);
    }
}

/// The one change for a row queued for another reason: still queued when the
/// binding ends, it is refused there and kept for review. Before holds, it
/// stayed queued past the binding, and the next ordinary drain applied it.
#[test]
fn a_host_update_queued_for_another_reason_is_refused_when_the_binding_ends() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [edit] = host_edits(&owner, ["queued across the binding"]);
    let update = host_update(&owner, 0, &edit);
    queued_for_another_reason(&mut owner, &update);
    stop(&mut owner, 0);
    assert!(
        held(&owner).is_empty(),
        "nothing is left for a drain to apply"
    );
    assert_eq!(refused(&owner), [(0, LIVE_UNADMITTED_UPDATE.to_owned())]);
    let record = record_of(&owner, 0);
    assert_eq!(record["rows"]["kept"], json!(digest_of(&update)));
    assert_ne!(record["notices"], "[]");
    assert!(pass_ends(&mut owner, &mut cache).is_empty());
    assert!(
        !record_of(&owner, 0)["text"]
            .as_str()
            .unwrap()
            .contains("queued across the binding")
    );
}

/// An ordinary imported text moment arrives while the owner holds the host's
/// update. The bound note refuses it as on main, and it decides nothing: the
/// binding stays and so does the hold. If the feed then delivers the update,
/// it leaves as the echo it is, with no refusal and no Notice. If the feed
/// never does, the Stop that later ends the binding refuses it as on arrival
/// and keeps its bytes.
#[test]
fn a_text_moment_decides_nothing_and_leaves_the_hold_to_the_feed_or_the_end() {
    // The moment's own refusal is as on main; only the host's update counts.
    let refused = |owner: &RestoreOwner| -> Vec<(i64, String)> {
        owner
            .store
            .read_with(|conn| {
                let mut statement = conn.prepare(
                    "SELECT origin_seq,reason_message FROM replication_pending_refusals \
                     WHERE origin_id=?1 ORDER BY origin_seq",
                )?;
                statement
                    .query_map([HOST], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap()
    };
    for delivered in [true, false] {
        let mut owner = restore_owner();
        let mut cache = WriterDocCache::new();
        let [edit] = host_edits(&owner, ["held across a text moment"]);
        let update = host_update(&owner, 0, &edit);
        assert_held(arrive(&mut owner, &mut cache, &update));
        apply_audit(&mut owner, 1, &digest_of(&update), 1);
        let text = owner.initial_text.clone();
        let moment = envelope(
            "moment-origin",
            0,
            "ws",
            present_text_payload(
                "moment-settled",
                "object",
                "write",
                "owner.md",
                "owner.md",
                &text,
                &owner.initial_moment,
                &text,
            ),
        );
        let applied = apply_moment_envelope(&mut owner.store, &moment, &NoFaults).unwrap();
        assert!(
            matches!(applied.primary, ApplyDisposition::Refused(_))
                && format!("{applied:?}").contains("live document binding is still active"),
            "delivered {delivered}: {applied:?}"
        );
        let before = notices(&owner);
        assert_eq!(held(&owner), [0], "delivered {delivered}: still held");
        assert_eq!(
            owner.store.table_row_count("ydoc_owner_bindings").unwrap(),
            1
        );
        assert!(refused(&owner).is_empty());
        if delivered {
            accept(&mut owner, &mut cache, edit, 1);
            assert!(held(&owner).is_empty());
            assert!(refused(&owner).is_empty());
            assert_eq!(rows_of(&owner, 0)["kept"], Value::Null);
            assert_eq!(notices(&owner), before);
        } else {
            assert!(pass_ends(&mut owner, &mut cache).is_empty());
            assert_eq!(held(&owner), [0], "the feed has not reached it");
            stop(&mut owner, 0);
            assert!(held(&owner).is_empty());
            assert_eq!(refused(&owner), [(0, LIVE_UNADMITTED_UPDATE.to_owned())]);
            assert_eq!(rows_of(&owner, 0)["kept"], json!(digest_of(&update)));
        }
    }
}

/// The drain keeps queued only a row the owner marked as it queued. A bound
/// row from the host left unmarked, whose next op is missing, fails the echo
/// check and is refused as on main, not kept; the same row marked stays held.
#[test]
fn the_drain_keeps_only_a_marked_row_and_refuses_an_unmarked_one_as_on_main() {
    for marked in [false, true] {
        let mut owner = restore_owner();
        let mut cache = WriterDocCache::new();
        let [edit] = host_edits(&owner, ["no next op"]);
        let update = host_update(&owner, 0, &edit);
        queued_for_another_reason(&mut owner, &update);
        owner
            .store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_deferred_updates SET deferred_while_bound=?1",
                    [marked],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)
            })
            .unwrap();
        let drained = crate::ydoc_apply::drain_deferred_ydoc_for_key(
            &mut owner.store,
            &mut cache,
            &key(),
            &NoFaults,
        )
        .unwrap();
        assert_eq!(
            owner.store.table_row_count("ydoc_owner_bindings").unwrap(),
            1
        );
        if marked {
            assert!(drained.refusals.is_empty());
            assert_eq!(held(&owner), [0]);
            assert!(refused(&owner).is_empty());
        } else {
            assert_eq!(drained.refusals.len(), 1);
            assert!(held(&owner).is_empty(), "not kept");
            assert_eq!(refused(&owner), [(0, LIVE_UNADMITTED_UPDATE.to_owned())]);
        }
    }
}

/// Every engine source file outside tests, named by its path under `crates/`,
/// with its numbered lines. Inline test modules end at the first closing brace
/// in column 0.
fn engine_sources() -> Vec<(String, Vec<(usize, String)>)> {
    use std::path::{Path, PathBuf};
    fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if path.is_dir() {
                if name != "tests" && !name.ends_with("_tests") {
                    sources(&path, out);
                }
            } else if name.ends_with(".rs") && name != "tests.rs" && !name.ends_with("_tests.rs") {
                out.push(path);
            }
        }
    }
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut files = Vec::new();
    for entry in std::fs::read_dir(crates).unwrap() {
        let src = entry.unwrap().path().join("src");
        if src.is_dir() {
            sources(&src, &mut files);
        }
    }
    assert!(files.len() > 100, "the scan reads the engine's sources");
    files
        .iter()
        .map(|file| {
            let text = std::fs::read_to_string(file).unwrap();
            let name = file
                .strip_prefix(crates)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let mut lines = Vec::new();
            let mut in_tests = false;
            let all: Vec<&str> = text.lines().collect();
            for (index, line) in all.iter().enumerate() {
                if !in_tests
                    && *line == "#[cfg(test)]"
                    && all
                        .get(index + 1)
                        .is_some_and(|next| next.starts_with("mod ") && next.ends_with('{'))
                {
                    in_tests = true;
                }
                if in_tests {
                    in_tests = *line != "}";
                    continue;
                }
                lines.push((index + 1, (*line).to_owned()));
            }
            (name, lines)
        })
        .collect()
}

/// Every deletion of an owner's binding row goes through
/// `unbind_owner_in_tx`, which decides what the owner holds in the same
/// transaction. A new deletion, or a call to one of the two functions that
/// delete outside it, fails here.
#[test]
fn every_binding_deletion_decides_what_the_owner_holds() {
    let mut deletions = Vec::new();
    let mut outside = Vec::new();
    for (name, lines) in engine_sources() {
        for (at, (number, line)) in lines.iter().enumerate() {
            if line.contains("DELETE FROM ydoc_owner_bindings") {
                deletions.push(name.clone());
            }
            if (line.contains("release::release_in_tx(") || line.contains("close_retired_in_tx("))
                && !line.contains("fn ")
                && !lines[at.saturating_sub(6)..=at]
                    .iter()
                    .any(|(_, line)| line.contains("unbind_owner_in_tx("))
            {
                outside.push(format!("{name}:{number}"));
            }
        }
    }
    deletions.sort();
    assert_eq!(
        deletions,
        [
            "dohc-engine-collab/src/owner_outbox/release.rs",
            "dohc-engine-collab/src/owner_outbox/retirement.rs",
        ],
        "a binding row is deleted only by Stop's release and by lineage retirement"
    );
    assert!(
        outside.is_empty(),
        "these end a binding outside unbind_owner_in_tx: {outside:?}"
    );
}

/// Deleting a row that a held update or a binding cascades from would drop
/// them with no decision. The schema has two such rows: a note's
/// `file_objects` row, whose one deletion runs only while nothing refers to
/// the note, its held updates included, and above it the workspace, which
/// nothing deletes. A new cascade, a new deletion of either, or a reference
/// check that stops counting held updates fails here.
#[test]
fn nothing_deletes_what_a_held_update_cascades_from() {
    let (_scratch, store) = test_store();
    let edges = store
        .read_with(|conn| {
            let tables: Vec<String> = conn
                .prepare("SELECT name FROM sqlite_schema WHERE type='table'")?
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
            let mut edges = std::collections::BTreeSet::new();
            for table in &tables {
                let mut statement = conn.prepare(&format!(
                    "SELECT \"table\",on_delete FROM pragma_foreign_key_list('{table}')"
                ))?;
                for edge in statement.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })? {
                    let (parent, on_delete) = edge?;
                    edges.insert((table.clone(), parent, on_delete));
                }
            }
            Ok::<_, rusqlite::Error>(edges)
        })
        .unwrap();
    let mut reached = std::collections::BTreeSet::from([
        "ydoc_deferred_updates".to_owned(),
        "ydoc_owner_bindings".to_owned(),
    ]);
    loop {
        let parents: Vec<String> = edges
            .iter()
            .filter(|(child, parent, on_delete)| {
                reached.contains(child)
                    && !reached.contains(parent)
                    && !matches!(on_delete.as_str(), "NO ACTION" | "RESTRICT")
            })
            .map(|(_, parent, _)| parent.clone())
            .collect();
        if parents.is_empty() {
            break;
        }
        reached.extend(parents);
    }
    reached.remove("ydoc_deferred_updates");
    reached.remove("ydoc_owner_bindings");
    assert_eq!(
        reached.iter().map(String::as_str).collect::<Vec<_>>(),
        ["file_objects", "versioned_workspaces"],
        "a deletion of one of these drops held updates or bindings"
    );
    let sources = engine_sources();
    let deleting = |table: &str| {
        // Not a format string: the moment-retention scan reads this file as
        // production source and fails on a deletion with a dynamic table.
        let statement = ["DELETE FROM", table].join(" ");
        let mut found = Vec::new();
        for (name, lines) in &sources {
            for (at, (_, line)) in lines.iter().enumerate() {
                if line.split(&statement).skip(1).any(|rest| {
                    !rest.starts_with(|next: char| next.is_ascii_alphanumeric() || next == '_')
                }) {
                    found.push((name.clone(), at));
                }
            }
        }
        found
    };
    assert!(
        deleting("versioned_workspaces").is_empty(),
        "nothing deletes a workspace's row"
    );
    let notes = deleting("file_objects");
    assert_eq!(
        notes
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["dohc-engine-domain/src/store/rollback.rs"],
        "a note's row is deleted only by a rollback that removes its last trace"
    );
    let (name, at) = &notes[0];
    let lines = &sources.iter().find(|(file, _)| file == name).unwrap().1;
    assert!(
        lines[at.saturating_sub(3)..*at]
            .iter()
            .any(|(_, line)| line.contains("if !object_has_references(")),
        "the rollback deletes a note's row only when nothing refers to it"
    );
    let check = lines
        .iter()
        .position(|(_, line)| line.starts_with("fn object_has_references("))
        .unwrap();
    assert!(
        lines[check..]
            .iter()
            .take_while(|(_, line)| *line != "}")
            .any(|(_, line)| line.contains("FROM ydoc_deferred_updates")),
        "a held update refers to its note"
    );
}

/// The host's audit names other bytes, or the feed accepted the audit's event
/// and the update is still no echo: either way it was not this event's
/// update, and it is refused.
#[test]
fn a_host_update_its_audit_or_feed_disowns_is_refused() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [edit] = host_edits(&owner, ["other bytes"]);
    let update = host_update(&owner, 0, &edit);
    assert_held(arrive(&mut owner, &mut cache, &update));
    apply_audit(&mut owner, 1, &"f".repeat(64), 1);
    assert_eq!(pass_ends(&mut owner, &mut cache).len(), 1);
    assert!(held(&owner).is_empty());
    assert_eq!(refused(&owner), [(0, LIVE_UNADMITTED_UPDATE.to_owned())]);

    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    // Two edits from the same start: the feed's event holds only the second.
    let [claimed] = host_edits(&owner, ["claimed"]);
    let [accepted] = host_edits(&owner, ["accepted instead"]);
    let update = host_update(&owner, 0, &claimed);
    assert_held(arrive(&mut owner, &mut cache, &update));
    apply_audit(&mut owner, 1, &digest_of(&update), 1);
    accept(&mut owner, &mut cache, accepted, 1);
    assert!(held(&owner).is_empty());
    assert_eq!(refused(&owner), [(0, LIVE_UNADMITTED_UPDATE.to_owned())]);
}

/// A hold outlives the owner's restart, and its feed's: the owner resumes
/// from the accepted state it kept, the feed delivers the event, and the
/// update leaves as an echo. Only the end of the binding refuses it.
#[test]
fn a_held_host_update_survives_a_restart_and_a_resumed_feed() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [edit] = host_edits(&owner, ["across a restart"]);
    let update = host_update(&owner, 0, &edit);
    assert_held(arrive(&mut owner, &mut cache, &update));
    apply_audit(&mut owner, 1, &digest_of(&update), 1);
    let path = engine_db_path(&owner._scratch).unwrap();
    let RestoreOwner {
        store,
        observed,
        checkpoint,
        initial_text,
        initial_moment,
        _scratch,
    } = owner;
    drop((store, cache));
    let mut owner = RestoreOwner {
        store: EngineStore::open(&path, 1_000).unwrap(),
        observed,
        checkpoint,
        initial_text,
        initial_moment,
        _scratch,
    };
    let mut cache_after = WriterDocCache::new();
    let resumed = owner
        .store
        .read_with(|conn| {
            dohc_engine_collab::owner_outbox::accepted::read_state_in(
                conn,
                &owner.observed.binding,
                "relay",
            )
        })
        .unwrap();
    assert_eq!(resumed.accepted_cursor, 0);
    assert!(pass_ends(&mut owner, &mut cache_after).is_empty());
    assert_eq!(held(&owner), [0]);
    accept(&mut owner, &mut cache_after, edit, 1);
    assert!(held(&owner).is_empty());
    assert!(refused(&owner).is_empty());
}

/// The owner's feed re-syncs to the host's state, as after a gap, instead of
/// replaying each frame: its checkpoint moves to the host cut in one step.
fn resync(owner: &mut RestoreOwner, host: &Ydoc, update: Vec<u8>, cursor: i64) {
    use dohc_engine_collab::owner_outbox::accepted::{OwnerAcceptedFrameInput, apply_sync_in_tx};
    let observed = &owner.observed;
    let vector = host.encode_state_vector();
    let dohc_engine_storage::TxnOutcome::Committed(result) = owner
        .store
        .write_with(&NoFaults, |tx| {
            apply_sync_in_tx(
                tx,
                "ws",
                &OwnerAcceptedFrameInput {
                    binding: observed.binding.clone(),
                    relay_database_namespace: "relay".into(),
                    expected_revision: observed.revision,
                    expected_native_head_sequence: observed.native_head_sequence,
                    previous_accepted_cursor: observed.accepted_cursor,
                    journal_cursor: cursor,
                    update_bytes: update,
                },
                &vector,
                10 + cursor,
            )
        })
        .unwrap()
    else {
        panic!("the re-sync must commit")
    };
    owner.observed.revision = result.revision;
    owner.observed.native_head_sequence = result.native_head_sequence;
    owner.observed.accepted_cursor = result.accepted_cursor;
}

/// A re-sync brings a held update's bytes into the owner's accepted state
/// while its cursor is still short of the audit's event: the update leaves
/// as the echo it is at the next decision. Only a refusal waits for the
/// cursor, so a re-sync can end a hold sooner and never strands one.
#[test]
fn a_held_host_update_a_resync_brought_in_leaves_as_an_echo() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let host = Ydoc::wire();
    host.apply(&owner.checkpoint).unwrap();
    let edit = host.richdoc_append_paragraph("brought in by a re-sync");
    let update = host_update(&owner, 0, &edit);
    let before = record_of(&owner, -1);
    assert_held(arrive(&mut owner, &mut cache, &update));
    apply_audit(&mut owner, 1, &digest_of(&update), 5);
    resync(&mut owner, &host, edit, 3);
    assert_eq!(owner.observed.accepted_cursor, 3);
    let decided = decide_owner_holds(&mut owner.store, &mut cache, &key(), &NoFaults).unwrap();
    assert!(decided.waiting.is_none());
    assert!(decided.refusals.is_empty());
    assert!(held(&owner).is_empty());
    assert!(refused(&owner).is_empty());
    assert_eq!(record_of(&owner, 0)["notices"], before["notices"]);
}

/// A later restore generation enrolls the owner again, and the accepted state
/// it installs already holds a held update while its cursor is still short
/// of the audit's event. The enrollment itself decides nothing; the check
/// the runtime runs once it commits (`owner_ydoc_enroll`) lets the update
/// leave as the echo it is, with no frame needed after it.
#[test]
fn a_held_host_update_an_enrollment_brought_in_leaves_as_an_echo() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let host = Ydoc::wire();
    host.apply(&owner.checkpoint).unwrap();
    let edit = host.richdoc_append_paragraph("brought in by a restore generation");
    let update = host_update(&owner, 0, &edit);
    let before = record_of(&owner, -1);
    assert_held(arrive(&mut owner, &mut cache, &update));
    apply_audit(&mut owner, 1, &digest_of(&update), 5);
    let next = dohc_engine_collab::live_object_binding::LiveObjectBinding {
        restore_fence_generation: 1,
        ..owner.observed.binding.clone()
    };
    let enrolled = enroll_restore(&mut owner.store, &next, &host, 3, &owner.observed.limits);
    assert_eq!((enrolled.binding, enrolled.accepted_cursor), (next, 3));
    assert_eq!(held(&owner), [0], "the enrollment itself decides nothing");
    crate::decide_owner_holds_after_commit(&mut owner.store, &mut cache, &key(), &NoFaults)
        .unwrap();
    assert!(held(&owner).is_empty());
    assert!(refused(&owner).is_empty());
    let after = record_of(&owner, 0);
    assert_eq!(after["rows"]["disposition"], "applied");
    assert_eq!(after["rows"]["kept"], Value::Null);
    assert_eq!(after["notices"], before["notices"]);
}

/// A later restore generation enrolls the owner at a cut, at cursor 3, that
/// leaves out a held update whose event the relay journaled at cursor 2: the
/// host never accepted it into the restored state. The re-judge refuses it
/// exactly as on arrival: the same refusal, journal disposition, kept bytes
/// and Notice.
#[test]
fn an_update_the_restored_cut_leaves_out_is_refused_at_the_re_judge_as_on_arrival() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let cut = Ydoc::wire();
    cut.apply(&owner.checkpoint).unwrap();
    let [edit] = host_edits(&owner, ["left out of the restore"]);
    let update = host_update(&owner, 0, &edit);
    assert_held(arrive(&mut owner, &mut cache, &update));
    apply_audit_at(&mut owner, 1, &digest_of(&update), 1, Some(2));
    let next = dohc_engine_collab::live_object_binding::LiveObjectBinding {
        restore_fence_generation: 1,
        ..owner.observed.binding.clone()
    };
    enroll_restore(&mut owner.store, &next, &cut, 3, &owner.observed.limits);
    assert_eq!(held(&owner), [0], "the enrollment itself decides nothing");
    crate::decide_owner_holds_after_commit(&mut owner.store, &mut cache, &key(), &NoFaults)
        .unwrap();
    assert!(held(&owner).is_empty());
    assert_eq!(refused(&owner), [(0, LIVE_UNADMITTED_UPDATE.to_owned())]);
    let decided = record_of(&owner, 0);
    let expected = refused_on_arrival(&edit);
    for field in ["refusal", "disposition", "kept"] {
        assert_eq!(decided["rows"][field], expected["rows"][field], "{field}");
    }
    assert_eq!(decided["rows"]["kept"], json!(digest_of(&update)));
    assert_eq!(decided["notices"], expected["notices"]);
    assert!(!decided["text"].as_str().unwrap().contains("left out"));
}

/// The owner's device becomes the note's own live host: the row
/// registration installs (`install_binding`), in the owner binding's
/// namespace and lineage.
fn become_host(owner: &mut RestoreOwner) {
    let binding = owner.observed.binding.clone();
    let selectors = serde_json::to_string(&binding.selector_paths).unwrap();
    owner
        .store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO live_device_application_bindings (relay_database_namespace,workspace_id,\
                 main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,\
                 restore_fence_generation,host_id,host_epoch,instance_id,connection_id,available,\
                 activation_id) VALUES ('relay','ws','main','object',?1,?2,?3,?4,'host',1,'instance',\
                 'connection',1,NULL)",
                params![
                    binding.lineage_claim_id,
                    binding.current_path,
                    selectors,
                    binding.restore_fence_generation
                ],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)
        })
        .unwrap();
}

/// Whether the host's queued update at `seq` is marked as held.
fn marked(owner: &RestoreOwner, seq: i64) -> bool {
    owner
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT deferred_while_bound FROM ydoc_deferred_updates WHERE origin_id=?1 \
                 AND origin_seq=?2",
                params![HOST, seq],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// On a device that is the note's own live host, the owner holds nothing.
/// An update the host never accepted is refused when it arrives, exactly as
/// on main: the same refusal, journal disposition, kept bytes and Notice. A
/// true echo applies as one, with no Notice. And a host update queued for
/// another reason is not marked, so it is decided as on main too.
#[test]
fn on_its_own_host_device_the_owner_holds_nothing() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    become_host(&mut owner);
    // Each from the checkpoint, so the echo needs nothing the feed lacks.
    let [refused_edit] = host_edits(&owner, ["not live"]);
    let [echoed] = host_edits(&owner, ["an echo"]);
    let [queued] = host_edits(&owner, ["queued"]);

    let update = host_update(&owner, 0, &refused_edit);
    assert!(matches!(
        arrive(&mut owner, &mut cache, &update),
        ApplyDisposition::Refused(refusal) if refusal.reason.message() == LIVE_UNADMITTED_UPDATE
    ));
    assert!(held(&owner).is_empty());
    let decided = record_of(&owner, 0);
    let expected = refused_on_arrival(&refused_edit);
    for field in ["refusal", "disposition", "kept"] {
        assert_eq!(decided["rows"][field], expected["rows"][field], "{field}");
    }
    assert_eq!(decided["rows"]["kept"], json!(digest_of(&update)));
    assert_eq!(decided["notices"], expected["notices"]);

    let before = record_of(&owner, -1);
    apply_test_owner_frame(&mut owner, echoed.clone(), 1);
    let echo = host_update(&owner, 1, &echoed);
    assert!(matches!(
        arrive(&mut owner, &mut cache, &echo),
        ApplyDisposition::Applied(result) if !result.deferred
    ));
    assert!(held(&owner).is_empty());
    assert_eq!(record_of(&owner, 1)["rows"]["refusal"], Value::Null);
    assert_eq!(record_of(&owner, 1)["notices"], before["notices"]);

    let other = host_update(&owner, 2, &queued);
    queued_for_another_reason(&mut owner, &other);
    assert!(!marked(&owner, 2), "the host device marks nothing");
}

/// The owner held the host's update before its device became the note's own
/// live host. Registration decides nothing; the first pass after it refuses
/// the update as on arrival, with its bytes kept and main's Notice, even a
/// true echo whose event the feed has not reached. When the device restarts
/// in between, the row is still marked, and the first pass decides it.
#[test]
fn a_row_held_before_registration_is_decided_at_the_next_pass_after_it() {
    for restarts in [false, true] {
        let mut owner = restore_owner();
        let mut cache = WriterDocCache::new();
        let [edit] = host_edits(&owner, ["typed before this device hosted"]);
        let update = host_update(&owner, 0, &edit);
        assert_held(arrive(&mut owner, &mut cache, &update));
        apply_audit(&mut owner, 1, &digest_of(&update), 1);
        become_host(&mut owner);
        assert_eq!(held(&owner), [0], "registration itself decides nothing");
        if restarts {
            let RestoreOwner {
                store,
                observed,
                checkpoint,
                initial_text,
                initial_moment,
                _scratch: scratch,
            } = owner;
            drop(store);
            let path = engine_db_path(&scratch).unwrap();
            owner = RestoreOwner {
                store: EngineStore::open(&path, 1_000).unwrap(),
                observed,
                checkpoint,
                initial_text,
                initial_moment,
                _scratch: scratch,
            };
            cache = WriterDocCache::new();
            assert!(marked(&owner, 0), "the row is still marked on restart");
        }
        let refusals = pass_ends(&mut owner, &mut cache);
        assert_eq!(
            refusals
                .iter()
                .map(|refusal| (refusal.origin_seq, refusal.reason.message().to_owned()))
                .collect::<Vec<_>>(),
            [(0, LIVE_UNADMITTED_UPDATE.to_owned())],
            "restarts {restarts}"
        );
        assert!(held(&owner).is_empty());
        let decided = record_of(&owner, 0);
        let expected = refused_on_arrival(&edit);
        for field in ["refusal", "disposition", "kept"] {
            assert_eq!(decided["rows"][field], expected["rows"][field], "{field}");
        }
        assert_eq!(decided["rows"]["kept"], json!(digest_of(&update)));
        assert_eq!(decided["notices"], expected["notices"]);
        assert!(
            !decided["text"]
                .as_str()
                .unwrap()
                .contains("before this device")
        );
    }
}

/// Once the device is the note's own live host, a host update that arrives
/// before the next pass does not queue behind the row held before
/// registration: it is decided on arrival, as on main. One the host never
/// accepted is refused with main's refusal, disposition and kept bytes, and a
/// true echo applies.
#[test]
fn after_registration_a_host_update_does_not_wait_behind_a_held_row() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [edit] = host_edits(&owner, ["typed before this device hosted"]);
    let update = host_update(&owner, 0, &edit);
    assert_held(arrive(&mut owner, &mut cache, &update));
    apply_audit(&mut owner, 1, &digest_of(&update), 1);
    become_host(&mut owner);

    let [refused_edit] = host_edits(&owner, ["not live"]);
    let late = host_update(&owner, 2, &refused_edit);
    assert!(matches!(
        arrive(&mut owner, &mut cache, &late),
        ApplyDisposition::Refused(refusal) if refusal.reason.message() == LIVE_UNADMITTED_UPDATE
    ));
    assert_eq!(held(&owner), [0], "nothing queues behind the held row");
    let decided = rows_of(&owner, 2);
    let expected = refused_on_arrival(&refused_edit);
    for field in ["refusal", "disposition", "kept"] {
        assert_eq!(decided[field], expected["rows"][field], "{field}");
    }
    assert_eq!(decided["kept"], json!(digest_of(&late)));

    let [echoed] = host_edits(&owner, ["an echo"]);
    apply_test_owner_frame(&mut owner, echoed.clone(), 1);
    let echo = host_update(&owner, 3, &echoed);
    assert!(matches!(
        arrive(&mut owner, &mut cache, &echo),
        ApplyDisposition::Applied(result) if !result.deferred
    ));
    assert_eq!(held(&owner), [0]);

    let refusals = pass_ends(&mut owner, &mut cache);
    assert_eq!(
        refusals
            .iter()
            .map(|refusal| refusal.origin_seq)
            .collect::<Vec<_>>(),
        [0]
    );
    assert!(held(&owner).is_empty());
}

/// The re-judge after an enrollment compares cursors too. The new cut, at
/// cursor 3, lacks the held update, whose event the relay journaled at
/// cursor 5 as the note's first: the update is not yet known to be no echo,
/// so it stays held. Comparing the cut's cursor with the event's count, 1,
/// would refuse it.
#[test]
fn the_re_judge_after_an_enrollment_waits_for_the_events_cursor() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let cut = Ydoc::wire();
    cut.apply(&owner.checkpoint).unwrap();
    let [edit] = host_edits(&owner, ["not in the new cut yet"]);
    let update = host_update(&owner, 0, &edit);
    assert_held(arrive(&mut owner, &mut cache, &update));
    apply_audit_at(&mut owner, 1, &digest_of(&update), 1, Some(5));
    let next = dohc_engine_collab::live_object_binding::LiveObjectBinding {
        restore_fence_generation: 1,
        ..owner.observed.binding.clone()
    };
    let enrolled = enroll_restore(&mut owner.store, &next, &cut, 3, &owner.observed.limits);
    assert_eq!(enrolled.accepted_cursor, 3);
    crate::decide_owner_holds_after_commit(&mut owner.store, &mut cache, &key(), &NoFaults)
        .unwrap();
    assert_eq!(
        held(&owner),
        [0],
        "the cut's cursor 3 is short of the event's 5"
    );
    assert!(refused(&owner).is_empty());
}

/// The note is renamed while the owner holds the host's update, and a
/// recovery rebinds the same feed to the new path (`recover_in_tx`), as this
/// test writes it: the note and its binding both name `renamed.md`. The held
/// update still names `owner.md`. When the feed delivers it, it leaves as the
/// echo it is: the bytes show that, whatever path it was held under.
#[test]
fn a_held_host_update_leaves_as_an_echo_after_a_rebind_to_a_new_path() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [edit] = host_edits(&owner, ["typed before the rename"]);
    let update = host_update(&owner, 0, &edit);
    let before = record_of(&owner, -1);
    assert_held(arrive(&mut owner, &mut cache, &update));
    apply_audit(&mut owner, 1, &digest_of(&update), 1);
    let renamed = dohc_engine_collab::live_object_binding::LiveObjectBinding {
        current_path: "renamed.md".into(),
        ..owner.observed.binding.clone()
    };
    let json = serde_json::to_string(&renamed).unwrap();
    owner
        .store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_docs SET path='renamed.md' WHERE workspace_id='ws' \
                 AND version_id='main' AND object_id='object'",
                [],
            )
            .and_then(|_| tx.execute("UPDATE ydoc_owner_bindings SET binding_json=?1", [&json]))
            .map_err(dohc_engine_storage::StorageError::persist_public)
        })
        .unwrap();
    owner.observed.binding = renamed;
    assert_eq!(held(&owner), [0], "the rebind itself decides nothing");
    accept(&mut owner, &mut cache, edit, 1);
    assert!(held(&owner).is_empty());
    assert!(refused(&owner).is_empty(), "a true echo is not refused");
    let after = record_of(&owner, 0);
    assert_eq!(after["rows"]["kept"], Value::Null);
    assert_eq!(after["notices"], before["notices"]);
}

/// Deleting, archiving or replacing a note retires its lineage. The check
/// that the note's queue is empty skips a held update, so retirement goes on,
/// and its unbind decides the holds. With the feed still behind, the
/// undelivered update is refused as on arrival, its bytes and a Notice are
/// kept, and the binding ends.
#[test]
fn retiring_a_lineage_decides_a_held_update_its_feed_never_reached() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [edit] = host_edits(&owner, ["held when the note is deleted"]);
    let update = host_update(&owner, 0, &edit);
    assert_held(arrive(&mut owner, &mut cache, &update));
    apply_audit(&mut owner, 1, &digest_of(&update), 1);
    let before = notices(&owner);
    assert!(
        owner
            .store
            .write_with(&NoFaults, |tx| {
                crate::ydoc_apply::ensure_ydoc_lineage_complete_in_tx(tx, &key()).map(|_| ())
            })
            .is_ok(),
        "the check that the queue is empty skips the held update"
    );
    assert!(pass_ends(&mut owner, &mut cache).is_empty());
    assert_eq!(held(&owner), [0], "undecided, the hold waits");
    assert!(matches!(
        retire(&mut owner),
        Ok(dohc_engine_storage::TxnOutcome::Committed(()))
    ));
    assert_eq!(
        owner.store.table_row_count("ydoc_owner_bindings").unwrap(),
        0
    );
    assert!(held(&owner).is_empty());
    assert_eq!(refused(&owner), [(0, LIVE_UNADMITTED_UPDATE.to_owned())]);
    let rows = rows_of(&owner, 0);
    assert_eq!(rows["disposition"], "refused");
    assert_eq!(rows["kept"], json!(digest_of(&update)));
    assert_ne!(notices(&owner), before);
}

/// The same retirement after the feed delivered the held update's bytes,
/// before anything decided the hold: the update leaves as the echo it is, and
/// retirement refuses nothing.
#[test]
fn retiring_a_lineage_lets_a_delivered_held_update_leave_as_an_echo() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [edit] = host_edits(&owner, ["delivered before the delete"]);
    let update = host_update(&owner, 0, &edit);
    assert_held(arrive(&mut owner, &mut cache, &update));
    apply_audit(&mut owner, 1, &digest_of(&update), 1);
    let before = notices(&owner);
    apply_test_owner_frame(&mut owner, edit, 1);
    assert!(matches!(
        retire(&mut owner),
        Ok(dohc_engine_storage::TxnOutcome::Committed(()))
    ));
    assert_eq!(
        owner.store.table_row_count("ydoc_owner_bindings").unwrap(),
        0
    );
    assert!(held(&owner).is_empty());
    assert!(refused(&owner).is_empty());
    let rows = rows_of(&owner, 0);
    assert_eq!(rows["disposition"], "applied");
    assert_eq!(rows["kept"], Value::Null);
    assert_eq!(notices(&owner), before);
}

/// A scene lineage stays durable when retired, so its binding does not end and
/// nothing it holds is decided. The state is built by a direct call because
/// enrollment binds only Richdoc notes; it is not reachable.
#[test]
fn a_scene_lineage_with_a_held_row_decides_nothing_and_keeps_the_binding() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [edit] = host_edits(&owner, ["held on a scene"]);
    let update = host_update(&owner, 0, &edit);
    assert_held(arrive(&mut owner, &mut cache, &update));
    apply_audit(&mut owner, 1, &digest_of(&update), 1);
    owner
        .store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_docs SET content_kind='scene' WHERE object_id='object'",
                [],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)
        })
        .unwrap();
    let before = notices(&owner);
    assert!(matches!(
        retire(&mut owner),
        Ok(dohc_engine_storage::TxnOutcome::Committed(()))
    ));
    assert_eq!(
        owner.store.table_row_count("ydoc_owner_bindings").unwrap(),
        1
    );
    assert_eq!(held(&owner), [0]);
    assert_eq!(flagged(&owner), 1);
    assert!(refused(&owner).is_empty());
    assert_eq!(notices(&owner), before);
}

/// Deleting, archiving or replacing the owner's note: each retires its
/// lineage in the transaction that removes it.
fn retire(owner: &mut RestoreOwner) -> Result<dohc_engine_storage::TxnOutcome<()>, SyncError> {
    owner.store.write_with(&NoFaults, |tx| {
        crate::retire_ydoc_lineage_in_tx(tx, "ws", "main", "object")
    })
}

/// The owner decides the host's updates in the order they arrived: one that
/// arrives behind a held update queues behind it, and each leaves only once
/// the feed reaches its own event.
#[test]
fn a_later_host_update_waits_behind_a_held_one() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [first, second] = host_edits(&owner, ["first", "second"]);
    let one = host_update(&owner, 0, &first);
    assert_held(arrive(&mut owner, &mut cache, &one));
    apply_audit(&mut owner, 1, &digest_of(&one), 1);
    let two = host_update(&owner, 2, &second);
    assert_held(arrive(&mut owner, &mut cache, &two));
    apply_audit(&mut owner, 3, &digest_of(&two), 2);
    assert!(pass_ends(&mut owner, &mut cache).is_empty());
    assert_eq!(held(&owner), [0, 2]);
    accept(&mut owner, &mut cache, first, 1);
    assert_eq!(held(&owner), [2], "the first leaves; the second waits");
    accept(&mut owner, &mut cache, second, 2);
    assert!(held(&owner).is_empty());
    assert!(refused(&owner).is_empty());
}

/// At 64 held updates for a note the next is refused on arrival, as before
/// holds, and every held update stays.
#[test]
fn a_note_holds_at_most_64_host_updates() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let paragraphs: [String; 65] = std::array::from_fn(|index| format!("edit {index}"));
    let edits = host_edits(&owner, paragraphs.each_ref().map(String::as_str));
    for (seq, edit) in edits.iter().enumerate().take(64) {
        let update = host_update(&owner, seq as i64, edit);
        assert_held(arrive(&mut owner, &mut cache, &update));
    }
    let over = host_update(&owner, 64, &edits[64]);
    assert!(matches!(
        arrive(&mut owner, &mut cache, &over),
        ApplyDisposition::Refused(refusal) if refusal.reason.message() == LIVE_UNADMITTED_UPDATE
    ));
    assert_eq!(held(&owner), (0..64).collect::<Vec<i64>>());
    assert_eq!(refused(&owner), [(64, LIVE_UNADMITTED_UPDATE.to_owned())]);
}

/// The binding ends while the owner holds the host's updates. In the same
/// transaction, one the feed already reached leaves as an echo and anything
/// else is refused as on arrival. None is left for the ordinary drain to
/// apply.
#[test]
fn ending_the_binding_decides_what_the_owner_holds() {
    let mut owner = restore_owner();
    let mut cache = WriterDocCache::new();
    let [reached, unreached] = host_edits(&owner, ["reached", "unreached"]);
    let one = host_update(&owner, 0, &reached);
    assert_held(arrive(&mut owner, &mut cache, &one));
    apply_audit(&mut owner, 1, &digest_of(&one), 1);
    let two = host_update(&owner, 2, &unreached);
    assert_held(arrive(&mut owner, &mut cache, &two));
    // The feed reaches the first event; nothing has decided the holds yet.
    apply_test_owner_frame(&mut owner, reached, 1);
    owner
        .store
        .write_with(&NoFaults, |tx| {
            unbind_owner_in_tx(
                tx,
                &key(),
                |error| error,
                |tx| {
                    dohc_engine_collab::owner_outbox::retirement::close_retired_in_tx(
                        tx,
                        &key(),
                        40,
                    )
                    .map_err(crate::ydoc_apply::map_owner_retirement_error)
                },
            )
        })
        .unwrap();
    assert_eq!(
        owner.store.table_row_count("ydoc_owner_bindings").unwrap(),
        0
    );
    assert!(held(&owner).is_empty());
    assert_eq!(refused(&owner), [(2, LIVE_UNADMITTED_UPDATE.to_owned())]);
    let record = record_of(&owner, 2);
    assert_eq!(record["rows"]["disposition"], "refused");
    assert_eq!(record["rows"]["kept"], json!(digest_of(&two)));
    assert_eq!(record_of(&owner, 0)["rows"]["disposition"], "applied");
}

/// What holds add to the owner's typing path: after each committed frame the
/// runtime reads whether the note holds any update, and with none does
/// nothing more. Each round times the same frames' commits without the read,
/// then with it, and the read alone.
#[test]
#[ignore = "manual frame-commit timing, run on Linux for the PR"]
fn owner_frame_commit_timing_with_and_without_the_hold_check() {
    use std::time::{Duration, Instant};
    fn summary(mut samples: Vec<Duration>) -> String {
        samples.sort_unstable();
        let at = |percent: usize| samples[(samples.len() - 1) * percent / 100].as_secs_f64() * 1e6;
        let mean = samples.iter().sum::<Duration>().as_secs_f64() * 1e6 / samples.len() as f64;
        format!(
            "p50_us={:.1} p95_us={:.1} mean_us={mean:.1}",
            at(50),
            at(95)
        )
    }
    const FRAMES: usize = 400;
    for round in 1..=5 {
        for check in [false, true] {
            let mut owner = restore_owner();
            let host = Ydoc::wire();
            host.apply(&owner.checkpoint).unwrap();
            let frames: Vec<Vec<u8>> = (0..FRAMES)
                .map(|index| host.richdoc_append_paragraph(&format!("typing {index}")))
                .collect();
            let mut commits = Vec::with_capacity(FRAMES);
            let mut reads = Vec::with_capacity(FRAMES);
            for (index, frame) in frames.into_iter().enumerate() {
                let started = Instant::now();
                apply_test_owner_frame(&mut owner, frame, index as i64 + 1);
                if check {
                    let read = Instant::now();
                    assert!(!crate::ydoc_apply::owner_holds_queued(&owner.store, &key()).unwrap());
                    reads.push(read.elapsed());
                }
                commits.push(started.elapsed());
            }
            let read = if check {
                format!(" read {}", summary(reads))
            } else {
                String::new()
            };
            println!(
                "== TIMING round={round} check={check} frames={FRAMES} frame {}{read}",
                summary(commits)
            );
        }
    }
}
