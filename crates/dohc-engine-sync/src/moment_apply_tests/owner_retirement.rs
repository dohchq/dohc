//! A page retired while this computer owned it closes its owner generation.
use super::*;
use dohc_engine_collab::owner_outbox::{
    OwnerOutboxAppendResult, OwnerOutboxError, OwnerOutboxRefuseInput,
    draft::append_draft_in_tx,
    enrollment::{OwnerEnrollmentPreparation, prepare_in},
    list_restore_fenced_in,
    publication::{PublicationContentKind, PublicationProof, contains_in},
    refuse_entry_in_tx,
    release::{release_in_tx, request_in_tx},
    retirement::{RETIRED_REASON, close_stranded_in_tx, retired_in},
};
use dohc_engine_storage::{FaultAction, FaultInjector, FaultPoint, TxnOutcome};

struct CrashBeforePersist;
impl FaultInjector for CrashBeforePersist {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == FaultPoint::StorageBeforePersist {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}

fn key() -> DocKey {
    DocKey::new("ws", "main", "object").unwrap()
}

fn append(owner: &mut RestoreOwner, append_key: &str, paragraph: &str) -> OwnerOutboxAppendResult {
    let edit = Ydoc::wire();
    edit.apply(&owner.checkpoint).unwrap();
    let update = edit.richdoc_append_paragraph(paragraph);
    let observed = owner.observed.clone();
    let TxnOutcome::Committed(result) = owner
        .store
        .write_with(&NoFaults, |tx| {
            append_draft_in_tx(
                tx,
                "ws",
                &observed.binding,
                observed.revision,
                append_key.into(),
                update.clone(),
                20,
            )
        })
        .unwrap()
    else {
        panic!("draft must commit")
    };
    result
}

fn retire(store: &mut EngineStore) -> Result<(), SyncError> {
    match store.write_with(&NoFaults, |tx| {
        crate::retire_ydoc_lineage_in_tx(tx, "ws", "main", "object")
    })? {
        TxnOutcome::Committed(()) => Ok(()),
        TxnOutcome::Crashed { .. } => panic!("retirement must commit"),
    }
}

/// What a build before the closure left: the lineage gone, its owner rows kept.
fn strand(store: &mut EngineStore) {
    store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "DELETE FROM ydoc_updates WHERE object_id='object';
                 DELETE FROM ydoc_snapshots WHERE object_id='object';
                 DELETE FROM ydoc_deferred_updates WHERE object_id='object';
                 DELETE FROM ydoc_base_relay_candidates WHERE object_id='object';
                 DELETE FROM ydoc_docs WHERE object_id='object';",
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
}

/// The state a later change enforces: every owner binding left has a text
/// head at its object and its current path.
fn assert_bindings_have_text_heads(store: &EngineStore) {
    let headless: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM ydoc_owner_bindings b WHERE NOT EXISTS(SELECT 1 FROM snapshots s \
                 WHERE s.workspace_id=b.workspace_id AND s.version_id=b.main_version_id AND s.object_id=b.object_id \
                   AND s.content_kind='text' AND s.path=json_extract(b.binding_json,'$.currentPath'))",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(headless, 0, "an owner binding outlived its text head");
}

type Queue = (String, String, Option<String>, Option<String>, i64);

/// Each queue: id, state, reason, kept checkpoint, pending entries.
fn queues(store: &EngineStore) -> Vec<Queue> {
    store
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT outbox_id,state,quarantine_reason,kept_checkpoint_digest,pending_entry_count \
                 FROM owner_ydoc_outboxes ORDER BY outbox_id",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })?;
            rows.collect::<Result<Vec<Queue>, _>>()
        })
        .unwrap()
}

/// The pending edits a recovery copy reads, in order.
fn pending_digests(store: &EngineStore) -> Vec<String> {
    store
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT update_digest FROM owner_ydoc_outbox_entries WHERE pending=1 \
                 AND update_blob_digest=update_digest ORDER BY outbox_id,sequence",
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .unwrap()
}

fn count(store: &EngineStore, table: &str) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
        })
        .unwrap()
}

/// The closed generation is save-only, unbound, and skipped by delivery.
fn assert_retired(owner: &RestoreOwner, outbox_id: &str, checkpoint_digest: &str, pending: i64) {
    assert_eq!(count(&owner.store, "ydoc_owner_bindings"), 0);
    assert_bindings_have_text_heads(&owner.store);
    assert_eq!(count(&owner.store, "ydoc_owner_applied_frames"), 0);
    assert_eq!(
        queues(&owner.store),
        vec![(
            outbox_id.to_owned(),
            "quarantined".to_owned(),
            Some(RETIRED_REASON.to_owned()),
            Some(checkpoint_digest.to_owned()),
            pending,
        )]
    );
    let listed = owner
        .store
        .read_with(|conn| list_restore_fenced_in(conn, "ws", None, 64))
        .unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|queue| queue.outbox_id.as_str())
            .collect::<Vec<_>>(),
        vec![outbox_id]
    );
    let binding = &owner.observed.binding;
    owner
        .store
        .read_with(|conn| {
            assert_eq!(
                contains_in(
                    conn,
                    &key(),
                    &binding.current_path,
                    Some(&binding.lineage_claim_id),
                    PublicationContentKind::Projection,
                    &hex_sha256(b"next text"),
                    &mut 8,
                )?,
                PublicationProof::Unbound
            );
            assert!(retired_in(conn, binding)?);
            assert!(matches!(
                prepare_in(conn, binding, "relay", false)?,
                OwnerEnrollmentPreparation::Retired
            ));
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
}

#[test]
fn retiring_an_owner_bound_page_closes_its_generation_and_keeps_every_edit() {
    let mut owner = restore_owner();
    let refused = append(&mut owner, "refused", "refused edit");
    let unsent = append(&mut owner, "unsent", "unsent edit");
    assert_eq!(refused.outbox_id, unsent.outbox_id);
    owner
        .store
        .write_with(&NoFaults, |tx| {
            refuse_entry_in_tx(
                tx,
                "ws",
                &OwnerOutboxRefuseInput {
                    outbox_id: refused.outbox_id.clone(),
                    delivery_id: refused.delivery_id.clone(),
                    update_digest: refused.update_digest.clone(),
                    reason: "provenance-refused".into(),
                },
                21,
            )
        })
        .unwrap();
    let settlements = count(&owner.store, "owner_pending_settlements");
    let devices = count(&owner.store, "live_device_application_bindings");
    retire(&mut owner.store).unwrap();
    assert_eq!(count(&owner.store, "ydoc_docs"), 0);
    // The refused edit is pending again, so the recovery copy holds both.
    assert_eq!(
        pending_digests(&owner.store),
        vec![refused.update_digest.clone(), unsent.update_digest.clone()]
    );
    assert_retired(
        &owner,
        &unsent.outbox_id,
        &owner.observed.checkpoint_digest,
        2,
    );
    assert_eq!(
        count(&owner.store, "owner_pending_settlements"),
        settlements
    );
    assert_eq!(
        count(&owner.store, "live_device_application_bindings"),
        devices
    );
}

#[test]
fn a_restore_successor_another_lineage_or_a_revived_page_is_evaluated_again() {
    let mut owner = restore_owner();
    append(&mut owner, "unsent", "unsent edit");
    retire(&mut owner.store).unwrap();
    let binding = owner.observed.binding.clone();
    let mut successor = binding.clone();
    successor.restore_fence_generation += 1;
    let mut other = binding.clone();
    other.lineage_claim_id = "f".repeat(64);
    owner
        .store
        .read_with(|conn| {
            assert!(retired_in(conn, &binding)?);
            assert!(!retired_in(conn, &successor)?);
            assert!(!retired_in(conn, &other)?);
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    dohc_engine_collab::claim_base(
        &mut owner.store,
        &key(),
        YdocContentKind::Richdoc,
        &owner.checkpoint,
        &NoFaults,
        30,
    )
    .unwrap();
    owner
        .store
        .read_with(|conn| {
            assert!(!retired_in(conn, &binding)?);
            assert!(!matches!(
                prepare_in(conn, &binding, "relay", false),
                Ok(OwnerEnrollmentPreparation::Retired)
            ));
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
}

#[test]
fn retiring_a_page_whose_stop_was_deferred_closes_its_generation() {
    let mut owner = restore_owner();
    let unsent = append(&mut owner, "unsent", "unsent edit");
    let binding = owner.observed.binding.clone();
    let cursor = owner.observed.accepted_cursor;
    let TxnOutcome::Committed(stop) = owner
        .store
        .write_with(&NoFaults, |tx| {
            request_in_tx(tx, &key(), 21)?;
            release_in_tx(tx, &binding, Some(cursor + 1), None, 22, |_, _, _, _, _| {
                Ok(())
            })
        })
        .unwrap()
    else {
        panic!("Stop must commit")
    };
    assert!(
        stop.deferred.is_some(),
        "the Stop waits on an edit the relay has not accepted"
    );
    retire(&mut owner.store).unwrap();
    assert_eq!(count(&owner.store, "owner_live_stops"), 0);
    assert_eq!(
        pending_digests(&owner.store),
        vec![unsent.update_digest.clone()]
    );
    assert_retired(
        &owner,
        &unsent.outbox_id,
        &owner.observed.checkpoint_digest,
        1,
    );
}

/// The store a 167.1 build left after it deleted an owner-bound page: the
/// owner rows outlived the lineage. A writable open closes it once.
#[test]
fn the_open_sweep_closes_a_stranded_owner_binding_once_and_a_crash_keeps_it() {
    let mut owner = restore_owner();
    let unsent = append(&mut owner, "unsent", "unsent edit");
    let before = queues(&owner.store);
    strand(&mut owner.store);
    assert_eq!(count(&owner.store, "ydoc_owner_bindings"), 1);
    let adoptions = count(&owner.store, "live_owner_adoptions");
    let activations = count(&owner.store, "live_owner_activations");

    assert!(matches!(
        owner
            .store
            .write_with(&CrashBeforePersist, |tx| close_stranded_in_tx(tx, 40, 8))
            .unwrap(),
        TxnOutcome::Crashed { .. }
    ));
    assert_eq!(count(&owner.store, "ydoc_owner_bindings"), 1);
    assert_eq!(queues(&owner.store), before);

    let mut closed = Vec::new();
    for _ in 0..2 {
        let TxnOutcome::Committed(count) = owner
            .store
            .write_with(&NoFaults, |tx| close_stranded_in_tx(tx, 40, 8))
            .unwrap()
        else {
            panic!("the sweep must commit")
        };
        closed.push(count);
    }
    assert_eq!(closed, vec![1, 0]);
    // The prefix the relay never accepted is still whole for the recovery copy.
    assert_eq!(
        pending_digests(&owner.store),
        vec![unsent.update_digest.clone()]
    );
    assert_retired(
        &owner,
        &unsent.outbox_id,
        &owner.observed.checkpoint_digest,
        1,
    );
    assert_eq!(count(&owner.store, "live_owner_adoptions"), adoptions);
    assert_eq!(count(&owner.store, "live_owner_activations"), activations);
}

#[test]
fn the_open_sweep_leaves_bound_pages_and_scene_lineages_alone() {
    let mut owner = restore_owner();
    append(&mut owner, "unsent", "unsent edit");
    seed_text_moment(
        &mut owner.store,
        "scene",
        "scene.excalidraw",
        "{}",
        &format!("moment-ydoc-{}", "d".repeat(64)),
        None,
        true,
    );
    let scene = DocKey::new("ws", "main", "scene").unwrap();
    let base = Ydoc::wire();
    let _ = base.richdoc_append_paragraph("scene");
    dohc_engine_collab::claim_base(
        &mut owner.store,
        &scene,
        YdocContentKind::Scene,
        &base.encode_full_state(),
        &NoFaults,
        30,
    )
    .unwrap();
    let before = queues(&owner.store);
    let TxnOutcome::Committed(closed) = owner
        .store
        .write_with(&NoFaults, |tx| close_stranded_in_tx(tx, 40, 8))
        .unwrap()
    else {
        panic!("the sweep must commit")
    };
    assert_eq!(closed, 0);
    assert_eq!(count(&owner.store, "ydoc_owner_bindings"), 1);
    assert_bindings_have_text_heads(&owner.store);
    assert_eq!(count(&owner.store, "ydoc_docs"), 2);
    assert_eq!(queues(&owner.store), before);
}
