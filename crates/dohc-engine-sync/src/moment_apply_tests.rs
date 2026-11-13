use dohc_engine_collab::live_update_application::ReleasedTails;
use dohc_engine_collab::{ContentKind as YdocContentKind, DocKey, LeaseRegistry, Regime, Ydoc};
use dohc_engine_domain::{
    MomentOp, RollbackTextFileMutation, VersionedTextStore, WriteText,
};
use dohc_engine_storage::{EngineStore, NoFaults, hex_sha256, put_binary_blob};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use crate::{
    ApplyDisposition, ApplyOutcome, NoLiveLeases, RefusalReason, ReplicationEnvelope,
    ReplicationRefusal, SyncError, apply_replication_envelope, apply_ydoc_envelope,
    read_replication_acked_seq,
};

fn test_store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let path = engine_db_path(&scratch).expect("db path");
    let mut store = EngineStore::open(&path, 1_000).expect("store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    (scratch, store)
}

fn apply_moment_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn dohc_engine_storage::FaultInjector,
) -> Result<ApplyOutcome<i64>, SyncError> {
    apply_leased(store, envelope, faults, &NoLiveLeases)
}

/// [`crate::apply_moment_envelope`] on fresh released tails: none of these
/// documents has a released window.
fn apply_leased(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn dohc_engine_storage::FaultInjector,
    leases: &dyn crate::LeaseProbe,
) -> Result<ApplyOutcome<i64>, SyncError> {
    crate::apply_moment_envelope(store, envelope, faults, leases, &ReleasedTails::default())
}

/// [`crate::apply_moment_envelope_detailed`] on fresh released tails.
fn apply_detailed(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn dohc_engine_storage::FaultInjector,
    leases: &dyn crate::LeaseProbe,
) -> Result<ApplyOutcome<crate::MomentApplyResult>, SyncError> {
    crate::apply_moment_envelope_detailed(
        store,
        envelope,
        faults,
        leases,
        &ReleasedTails::default(),
    )
}

fn envelope(origin: &str, seq: i64, workspace_id: &str, payload: Value) -> ReplicationEnvelope {
    ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: workspace_id.to_owned(),
        origin_id: origin.to_owned(),
        origin_seq: seq,
        op_kind: "moment.append".to_owned(),
        payload,
        recorded_at_ms: 2_000 + seq,
        relay_seq: None,
    }
}

fn text_sha(text: &str) -> String {
    hex_sha256(text.as_bytes())
}

#[test]
fn imported_live_moment_preserves_public_author_snapshots() {
    for mut author in [
        json!({"kind":"unattributed"}),
        json!({"kind":"human", "humanId":"recipient", "humanName":"Recipient"}),
        json!({"kind":"link", "publicPrincipalId":"public-recipient", "label":"Edit link participant"}),
    ] {
        let (_scratch, mut store) = test_store();
        hydrate_texts(&mut store, &["record fields"]);
        let payload = with_author(
            absent_text_payload("live-settlement", "record", "record.md", "record fields"),
            author.clone(),
        );
        let mut op = envelope("native-service", 0, "ws", payload);
        if author["kind"] != "unattributed" {
            op.payload.as_object_mut().unwrap().remove("authors");
            op.payload["settlementReference"] = json!({"record": {
                "settlementId": "settlement", "momentId": "live-settlement",
                "binding": {"workspaceId": "ws"}
            }});
            op.relay_seq = Some(1);
            op.settlement_admission = Some(crate::SettlementAdmission::Accepted {
                settlement_id: "settlement".into(),
            });
            op.admitted_author_snapshot = Some(json!([author]));
        }
        assert!(matches!(
            apply_moment_envelope(&mut store, &op, &NoFaults)
                .unwrap()
                .primary,
            ApplyDisposition::Applied(_)
        ));
        let actual: String = store.read_with(|conn| conn.query_row(
            "SELECT author_json FROM moments WHERE workspace_id='ws' AND moment_id='live-settlement'", [], |row| row.get(0))).unwrap();
        if author["kind"] == "human" {
            author["relayConfirmed"] = json!(true);
        }
        assert_eq!(
            serde_json::from_str::<Value>(&actual).unwrap(),
            json!([author])
        );
    }
}

#[test]
fn client_declared_human_cannot_preserve_relay_confirmation() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["local fields"]);
    let payload = with_author(
        absent_text_payload("local-settlement", "record", "record.md", "local fields"),
        json!({"kind":"human","humanId":"recipient","relayConfirmed":true}),
    );
    let op = envelope("local-device", 0, "ws", payload);
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Applied(_)
    ));
    let actual: String = store.read_with(|conn| conn.query_row(
        "SELECT author_json FROM moments WHERE workspace_id='ws' AND moment_id='local-settlement'", [], |row| row.get(0))).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&actual).unwrap(),
        json!([{"kind":"human","humanId":"recipient"}])
    );
}

#[test]
fn owner_binding_read_failure_does_not_acknowledge_moment() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["remote text"]);
    let op = envelope(
        "remote",
        0,
        "ws",
        absent_text_payload("remote-moment", "object", "owner.md", "remote text"),
    );
    store
        .read_with(|conn| {
            conn.execute_batch(
                "ALTER TABLE ydoc_owner_bindings \
                 RENAME COLUMN binding_json TO unavailable_binding_json",
            )
        })
        .unwrap();

    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults),
        Err(SyncError::Storage(_))
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "remote").unwrap(),
        -1
    );
    for table in [
        "replication_log",
        "replication_pending_refusals",
        "moments",
        "snapshots",
    ] {
        assert_eq!(store.table_row_count(table).unwrap(), 0, "{table}");
    }

    store
        .read_with(|conn| {
            conn.execute_batch(
                "ALTER TABLE ydoc_owner_bindings \
                 RENAME COLUMN unavailable_binding_json TO binding_json",
            )
        })
        .unwrap();
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).unwrap(),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "remote").unwrap(),
        0
    );
    assert_eq!(store.table_row_count("moments").unwrap(), 1);
    assert_eq!(store.table_row_count("snapshots").unwrap(), 1);
    assert_eq!(
        store
            .table_row_count("replication_pending_refusals")
            .unwrap(),
        0
    );
}

#[test]
fn moment_only_record_write_and_undo_each_keep_their_field_history() {
    let (_scratch, mut store) = test_store();
    seed_text_moment(
        &mut store,
        "schema",
        "tasks/collection.yaml",
        "fields: {}\n",
        "schema",
        None,
        true,
    );
    let initial_text = "# Task\n";
    seed_text_moment(
        &mut store,
        "record",
        "tasks/task.md",
        initial_text,
        "initial",
        None,
        true,
    );
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, "ws", "main")
        })
        .unwrap();
    let record_id: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT record_id FROM collection_records WHERE object_id='record'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    let written = format!("---\nid: {record_id}\nFinished on: 2026-10-05\n---\n# Task\n");
    let undone = format!("---\nid: {record_id}\nFinished on: null\n---\n# Task\n");
    hydrate_texts(&mut store, &[&written, &undone]);
    let write = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "written",
            "record",
            "write",
            "tasks/task.md",
            "tasks/task.md",
            initial_text,
            "initial",
            &written,
        ),
    );
    let undo = envelope(
        "peer",
        1,
        "ws",
        present_text_payload(
            "undone",
            "record",
            "write",
            "tasks/task.md",
            "tasks/task.md",
            &written,
            "written",
            &undone,
        ),
    );
    for op in [&write, &undo] {
        let result = apply_detailed(&mut store, op, &NoFaults, &NoLiveLeases).unwrap();
        let ApplyDisposition::Applied(result) = result.primary else {
            panic!("moment-only field change must apply")
        };
        let facts = result.record_facts.unwrap();
        assert_eq!(facts.source, Some(("peer".into(), op.origin_seq)));
        assert_eq!(facts.fields.len(), 1);
        assert_eq!(facts.fields[0].field_name, "Finished on");
    }
    let history = store
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT previous_value_json,next_value_json,source_origin_id,source_origin_seq \
             FROM collection_field_history WHERE record_id=?1 ORDER BY history_id",
            )?;
            stmt.query_map([&record_id], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    assert_eq!(
        history,
        vec![
            (None, Some("\"2026-10-05\"".into()), "peer".into(), 0),
            (
                Some("\"2026-10-05\"".into()),
                Some("null".into()),
                "peer".into(),
                1
            ),
        ]
    );
    assert_eq!(store.table_row_count("ydoc_updates").unwrap(), 0);
    assert_eq!(
        apply_moment_envelope(&mut store, &undo, &NoFaults).unwrap(),
        ApplyOutcome::new(ApplyDisposition::Skipped)
    );
    assert_eq!(
        store.table_row_count("collection_field_history").unwrap(),
        2
    );
}

#[test]
fn restore_settlement_imported_before_the_owner_reaches_its_generation_waits_then_materializes() {
    use dohc_engine_collab::live_object_binding::LiveObjectBinding;
    let RestoreOwner {
        _scratch,
        mut store,
        observed,
        checkpoint,
        initial_text,
        initial_moment,
    } = restore_owner();
    let (restored, restored_text) = restored_host(&checkpoint, "restored by the owner");
    let next = LiveObjectBinding {
        restore_fence_generation: 1,
        ..observed.binding.clone()
    };
    let retain_audit =
        |store: &EngineStore,
         binding: &LiveObjectBinding,
         namespace: &str,
         id: &str,
         text: &str| { retain_restore_audit(store, binding, namespace, id, text, 1) };
    let settlement = |origin: &str, id: &str, text: &str| {
        restore_settlement(origin, id, &initial_text, &initial_moment, text)
    };
    let before = snapshot(&store, "object");

    // Only an audited settlement of the owner's own document at a later
    // restore generation is a reason to wait. Anything else is still refused.
    let changed = |change: fn(&mut LiveObjectBinding)| {
        let mut binding = next.clone();
        change(&mut binding);
        binding
    };
    let same_generation = LiveObjectBinding {
        selector_paths: vec!["owner.md".into(), "other.md".into()],
        ..observed.binding.clone()
    };
    // Each payload names the restored text; only the audit differs.
    let other_text = "a restore with other content";
    let restored_audit = restored_text.as_str();
    let cases = vec![
        ("unaudited", None),
        (
            "same-generation",
            Some((same_generation, "relay", restored_audit)),
        ),
        (
            "other-path",
            Some((
                changed(|b| b.current_path = "moved.md".into()),
                "relay",
                restored_audit,
            )),
        ),
        (
            "other-lineage",
            Some((
                changed(|b| b.lineage_claim_id = "f".repeat(64)),
                "relay",
                restored_audit,
            )),
        ),
        (
            "other-workspace",
            Some((
                changed(|b| b.workspace_id = "other".into()),
                "relay",
                restored_audit,
            )),
        ),
        (
            "other-namespace",
            Some((next.clone(), "other-relay", restored_audit)),
        ),
        ("other-digest", Some((next.clone(), "relay", other_text))),
    ];
    hydrate_texts(&mut store, &[&restored_text, other_text]);
    for (index, (origin, audit)) in cases.into_iter().enumerate() {
        let id = format!("moment-ydoc-{index}{}", "1".repeat(63));
        if let Some((binding, namespace, audited)) = audit {
            retain_audit(&store, &binding, namespace, &id, audited);
        }
        assert!(
            matches!(
                apply_moment_envelope(
                    &mut store,
                    &settlement(origin, &id, &restored_text),
                    &NoFaults
                )
                .unwrap()
                .primary,
                ApplyDisposition::Refused(_)
            ),
            "{origin} must be refused"
        );
    }
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        0
    );
    assert_eq!(snapshot(&store, "object"), before);

    // Ordinary sync imports the restore's settlement before the authenticated
    // owner feed reaches generation 1. It waits instead of being refused.
    let restore_id = format!("moment-ydoc-{}", "b".repeat(64));
    retain_audit(&store, &next, "relay", &restore_id, &restored_text);
    // A settlement the host never accepted waits on the same binding.
    let forged_text = "a restore the host never accepted";
    hydrate_texts(&mut store, &[forged_text]);
    let forged_id = format!("moment-ydoc-{}", "c".repeat(64));
    retain_audit(&store, &next, "relay", &forged_id, forged_text);
    for (origin, id, text) in [
        ("host", &restore_id, restored_text.as_str()),
        ("forged", &forged_id, forged_text),
    ] {
        assert_eq!(
            apply_moment_envelope(&mut store, &settlement(origin, id, text), &NoFaults).unwrap(),
            ApplyOutcome::new(ApplyDisposition::Applied(0))
        );
    }
    let parked: Vec<String> = store
        .read_with(|conn| {
            conn.prepare("SELECT binding_json FROM owner_pending_settlements ORDER BY origin_id")?
                .query_map([], |row| row.get(0))?
                .collect()
        })
        .unwrap();
    assert_eq!(parked, vec![serde_json::to_string(&next).unwrap(); 2]);
    assert_eq!(snapshot(&store, "object"), before);
    let waiting =
        crate::moment_apply::pending::drain_to_end(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    assert!(waiting.report_id.is_none());
    assert!(waiting.changes.is_empty());
    assert_eq!(snapshot(&store, "object"), before);

    // The authenticated owner feed reaches the restore generation.
    let advanced = enroll_restore(&mut store, &next, &restored, 1, &observed.limits);
    assert_eq!(
        (advanced.binding, advanced.accepted_cursor),
        (next.clone(), 1)
    );

    // The replay repeats every check against the authenticated binding: the
    // restore reaches the file, and audit alone never authorizes content.
    let settled =
        crate::moment_apply::pending::drain_to_end(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    assert_eq!(settled.changes.len(), 1);
    assert_eq!(settled.changes[0].path, "owner.md");
    assert_eq!(
        snapshot(&store, "object").map(|(_, _, digest, moment)| (digest, moment)),
        Some((text_sha(&restored_text), restore_id.clone()))
    );
    assert_eq!(disposition(&store, "forged").as_deref(), Some("refused"));
    assert_ne!(disposition(&store, "host").as_deref(), Some("refused"));
}

#[test]
fn restore_settlement_skipped_by_a_later_generation_is_refused_and_released() {
    use dohc_engine_collab::live_object_binding::LiveObjectBinding;
    let RestoreOwner {
        _scratch,
        mut store,
        observed,
        checkpoint,
        initial_text,
        initial_moment,
    } = restore_owner();
    let generation = |restore_fence_generation| LiveObjectBinding {
        restore_fence_generation,
        ..observed.binding.clone()
    };
    let (_, skipped_text) = restored_host(&checkpoint, "restored at generation 1");
    let (latest, latest_text) = restored_host(&checkpoint, "restored at generation 2");
    hydrate_texts(&mut store, &[&skipped_text, &latest_text]);
    let skipped_id = format!("moment-ydoc-{}", "b".repeat(64));
    let latest_id = format!("moment-ydoc-{}", "c".repeat(64));
    retain_restore_audit(
        &store,
        &generation(1),
        "relay",
        &skipped_id,
        &skipped_text,
        1,
    );
    retain_restore_audit(&store, &generation(2), "relay", &latest_id, &latest_text, 2);
    let skipped = restore_settlement(
        "first-restore",
        &skipped_id,
        &initial_text,
        &initial_moment,
        &skipped_text,
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &skipped, &NoFaults).unwrap(),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        1
    );
    let before = snapshot(&store, "object");

    // The authenticated owner feed skips generation 1, so its settlement can
    // never become ready. The drain refuses it instead of writing it.
    let advanced = enroll_restore(&mut store, &generation(2), &latest, 2, &observed.limits);
    assert_eq!(
        (advanced.binding, advanced.accepted_cursor),
        (generation(2), 2)
    );
    let report =
        crate::moment_apply::pending::drain_to_end(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    assert!(report.changes.is_empty());
    assert!(report.report_id.is_some());
    assert_eq!(snapshot(&store, "object"), before);
    assert_eq!(
        disposition(&store, "first-restore").as_deref(),
        Some("refused")
    );
    assert_eq!(
        store
            .read_with(|conn| conn.query_row(
                "SELECT reason_message FROM replication_pending_refusals WHERE origin_id='first-restore'",
                [],
                |row| row.get::<_, String>(0)
            ))
            .unwrap(),
        crate::moment_apply::pending::SUPERSEDED
    );

    // Committing the report releases the queue row; the refused envelope
    // keeps its text for inspection.
    let committed = crate::commit_relay_cursor(
        &mut store,
        "ws",
        &crate::RelayCursor {
            bootstrap_complete: true,
            cursor: 1,
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            settlement_report_id: report.report_id,
            ordinary_pull: None,
        },
        &NoFaults,
        &NoLiveLeases,
        4,
    )
    .unwrap();
    assert!(matches!(
        committed,
        dohc_engine_storage::TxnOutcome::Committed(_)
    ));
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        0
    );
    assert_eq!(
        store
            .table_row_count("owner_pending_settlement_blobs")
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .read_with(|conn| conn.query_row(
                "SELECT COUNT(*) FROM replication_refused_moment_blobs \
                 WHERE origin_id='first-restore' AND role='payload-after' AND text_sha256=?1",
                [text_sha(&skipped_text)],
                |row| row.get::<_, i64>(0)
            ))
            .unwrap(),
        1
    );

    // The current generation's own settlement still applies at its exact binding.
    let latest_settlement = restore_settlement(
        "second-restore",
        &latest_id,
        &initial_text,
        &initial_moment,
        &latest_text,
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &latest_settlement, &NoFaults).unwrap(),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        snapshot(&store, "object").map(|(_, _, digest, moment)| (digest, moment)),
        Some((text_sha(&latest_text), latest_id))
    );
}

#[test]
fn held_settlement_current_path_recovery_is_refused_and_released() {
    held_settlement_recovery(RecoveryBinding::Renamed, false);
}

#[test]
fn held_settlement_selector_paths_recovery_is_refused_and_released() {
    held_settlement_recovery(RecoveryBinding::Selectors, false);
}

#[test]
fn held_settlement_later_generation_after_rename_is_refused_and_released() {
    held_settlement_recovery(RecoveryBinding::Renamed, true);
}

#[test]
fn held_settlement_same_binding_recovery_applies_and_releases() {
    held_settlement_recovery(RecoveryBinding::Unchanged, false);
}

#[test]
fn held_settlement_rename_away_and_back_applies_and_releases() {
    held_settlement_recovery(RecoveryBinding::RenamedBack, false);
}

#[derive(Clone, Copy)]
enum RecoveryBinding {
    Renamed,
    Selectors,
    Unchanged,
    RenamedBack,
}

fn held_settlement_recovery(case: RecoveryBinding, later_generation: bool) {
    use dohc_engine_collab::owner_outbox::{
        OwnerOutboxQuarantineInput,
        draft::append_draft_in_tx,
        enrollment::{OwnerEnrollmentInput, OwnerEnrollmentPreparation, enroll_in_tx, prepare_in},
    };
    let RestoreOwner {
        _scratch,
        mut store,
        mut observed,
        checkpoint,
        initial_text,
        initial_moment,
    } = restore_owner();
    let (host, text) = restored_host(&checkpoint, "held host settlement");
    hydrate_texts(&mut store, &[&text]);
    let id = format!("moment-ydoc-{}", "b".repeat(64));
    retain_restore_audit(&store, &observed.binding, "relay", &id, &text, 1);
    let settlement = restore_settlement("host", &id, &initial_text, &initial_moment, &text);
    assert_eq!(
        apply_moment_envelope(&mut store, &settlement, &NoFaults).unwrap(),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        1
    );
    let waiting =
        crate::moment_apply::pending::drain_to_end(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    assert!(waiting.report_id.is_none());

    // Recovery requires a quarantined delivery parent. Use the real draft,
    // quarantine and enrollment APIs rather than rewriting binding_json.
    let original_binding = observed.binding.clone();
    let mut next = original_binding.clone();
    match case {
        RecoveryBinding::Renamed | RecoveryBinding::RenamedBack => {
            next.current_path = "renamed.md".into();
        }
        RecoveryBinding::Selectors => next.selector_paths = vec!["folder".into()],
        RecoveryBinding::Unchanged => {}
    }
    let bindings = if matches!(case, RecoveryBinding::RenamedBack) {
        vec![next, original_binding]
    } else {
        vec![next]
    };
    let recovery_host = Ydoc::wire();
    recovery_host.apply(&checkpoint).unwrap();
    if !later_generation {
        recovery_host.apply(&host.encode_full_state()).unwrap();
    }
    for (step, next) in bindings.iter().enumerate() {
        let dohc_engine_storage::TxnOutcome::Committed(parent) = store
            .write_with(&NoFaults, |tx| {
                append_draft_in_tx(
                    tx,
                    "ws",
                    &observed.binding,
                    observed.revision,
                    format!("before-rebind-{step}"),
                    checkpoint.clone(),
                    3,
                )
            })
            .unwrap()
        else {
            panic!("draft must commit")
        };
        dohc_engine_collab::owner_outbox::quarantine(
            &mut store,
            "ws",
            OwnerOutboxQuarantineInput {
                outbox_id: parent.outbox_id,
                reason: "binding-changed".into(),
                observed_binding: None,
            },
            4,
        )
        .unwrap();
        store
            .read_with(|conn| conn.execute("UPDATE ydoc_docs SET path=?1", [&next.current_path]))
            .unwrap();
        let OwnerEnrollmentPreparation::Capture { captured } = store
            .read_with(|conn| prepare_in(conn, next, "relay", true))
            .unwrap()
        else {
            panic!("recovery must capture")
        };
        let input = OwnerEnrollmentInput {
            binding: next.clone(),
            relay_database_namespace: "relay".into(),
            captured,
            journal_cursor: if later_generation || step + 1 < bindings.len() {
                0
            } else {
                1
            },
            checkpoint: recovery_host.encode_full_state(),
            host_vector: recovery_host.encode_state_vector(),
            recovery: true,
        };
        let dohc_engine_storage::TxnOutcome::Committed(recovered) = store
            .write_with(&NoFaults, |tx| {
                enroll_in_tx(tx, "ws", &input, &observed.limits, 5)
            })
            .unwrap()
        else {
            panic!("recovery must commit")
        };
        assert_eq!(&recovered.binding, next);
        assert_eq!(recovered.binding.restore_fence_generation, 0);
        observed.binding = recovered.binding;
        observed.revision = recovered.revision;
    }
    let mut next = observed.binding.clone();
    if later_generation {
        let waiting =
            crate::moment_apply::pending::drain_to_end(&mut store, "ws", &NoFaults, &NoLiveLeases)
                .unwrap();
        assert!(
            waiting.report_id.is_none(),
            "rename still waits for the cursor"
        );
        next.restore_fence_generation = 1;
        let advanced = enroll_restore(&mut store, &next, &host, 0, &observed.limits);
        assert_eq!(advanced.binding, next);
    }
    let before = snapshot(&store, "object");
    let mut report =
        crate::moment_apply::pending::drain_to_end(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    assert!(
        report.report_id.is_some(),
        "a stale binding must reach a final decision"
    );
    let applies = matches!(
        case,
        RecoveryBinding::Unchanged | RecoveryBinding::RenamedBack
    );
    if applies {
        assert!(!report.changes.is_empty());
        assert_eq!(disposition(&store, "host").as_deref(), Some("applied"));
        assert_eq!(snapshot(&store, "object").unwrap().3, id);
        assert!(
            crate::list_refusal_notices(&store, "ws")
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .read_with(|conn| conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE moment_id=?1",
                    [&id],
                    |row| row.get::<_, i64>(0),
                ))
                .unwrap(),
            1
        );
        // A crash can leave an applied report to reclaim after another rename.
        let mut rebound = next.clone();
        rebound.current_path = "renamed-again.md".into();
        store
            .read_with(|conn| {
                conn.execute(
                    "UPDATE ydoc_owner_bindings SET binding_json=?1",
                    [serde_json::to_string(&rebound).unwrap()],
                )
            })
            .unwrap();
        report =
            crate::moment_apply::pending::drain_to_end(&mut store, "ws", &NoFaults, &NoLiveLeases)
                .unwrap();
        assert!(report.report_id.is_some());
        assert_eq!(disposition(&store, "host").as_deref(), Some("applied"));
        assert!(
            crate::list_refusal_notices(&store, "ws")
                .unwrap()
                .is_empty()
        );
    } else {
        assert!(report.changes.is_empty());
        assert_eq!(disposition(&store, "host").as_deref(), Some("refused"));
        let reason = store
            .read_with(|conn| {
                conn.query_row(
                "SELECT reason_message FROM replication_pending_refusals WHERE origin_id='host'",
                [],
                |row| row.get::<_, String>(0),
            )
            })
            .unwrap();
        assert_eq!(
            reason,
            if later_generation {
                crate::moment_apply::pending::SUPERSEDED
            } else {
                "This file's name, location, or sharing changed before this save arrived. Open the file to continue."
            }
        );
        assert_eq!(snapshot(&store, "object"), before);
        assert_eq!(
            store
                .read_with(|conn| conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE moment_id=?1",
                    [&id],
                    |row| row.get::<_, i64>(0),
                ))
                .unwrap(),
            0
        );
        if !later_generation {
            let notices = crate::list_refusal_notices(&store, "ws").unwrap();
            assert_eq!(
                notices[0].document.as_ref().unwrap().path.as_deref(),
                Some(next.current_path.as_str())
            );
        }
    }
    crate::commit_relay_cursor(
        &mut store,
        "ws",
        &crate::RelayCursor {
            bootstrap_complete: true,
            cursor: 1,
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            settlement_report_id: report.report_id,
            ordinary_pull: None,
        },
        &NoFaults,
        &NoLiveLeases,
        6,
    )
    .unwrap();
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        0
    );
    assert_eq!(
        store
            .table_row_count("owner_pending_settlement_blobs")
            .unwrap(),
        0
    );
    if !applies {
        assert_eq!(store.read_with(|conn| conn.query_row(
        "SELECT COUNT(*) FROM replication_refused_moment_blobs WHERE origin_id='host' AND role='payload-after' AND text_sha256=?1",
        [text_sha(&text)], |row| row.get::<_, i64>(0),
    )).unwrap(), 1);
        if !later_generation {
            let notices = crate::list_refusal_notices(&store, "ws").unwrap();
            assert_eq!(
                notices[0].document.as_ref().unwrap().path.as_deref(),
                Some(next.current_path.as_str())
            );
            next.current_path = "moved-again.md".into();
            store
                .read_with(|conn| {
                    conn.execute(
                        "UPDATE ydoc_owner_bindings SET binding_json=?1",
                        [serde_json::to_string(&next).unwrap()],
                    )
                })
                .unwrap();
            let notices = crate::list_refusal_notices(&store, "ws").unwrap();
            assert_eq!(
                notices[0].document.as_ref().unwrap().path.as_deref(),
                Some("moved-again.md")
            );
            store
                .read_with(|conn| conn.execute("DELETE FROM ydoc_owner_bindings", []))
                .unwrap();
            let notices = crate::list_refusal_notices(&store, "ws").unwrap();
            assert!(notices[0].document.as_ref().unwrap().path.is_none());
        }
    }
}

/// Sol's ruling 1 drain fixture: an owner observed at restore generation 0
/// queues the restore's settlement ("host") and one the host never accepted
/// ("later") until its feed reaches generation 1, with two more ("a-moved",
/// "z-moved") whose queued binding the owner has since left. A capture of
/// the lineage was released without adopting, its binding still the
/// owner's, so no activation is current and the lineage's first decision
/// waits for validation. The drain reads a-moved, host, later, z-moved.
struct DrainWindow {
    owner: RestoreOwner,
    restore_id: String,
    restored_text: String,
}

fn drain_window() -> DrainWindow {
    use dohc_engine_collab::live_object_binding::LiveObjectBinding;
    let mut owner = restore_owner();
    let next = LiveObjectBinding {
        restore_fence_generation: 1,
        ..owner.observed.binding.clone()
    };
    let (restored, restored_text) = restored_host(&owner.checkpoint, "restored by the owner");
    let forged_text = "a restore the host never accepted";
    hydrate_texts(&mut owner.store, &[&restored_text, forged_text]);
    let restore_id = format!("moment-ydoc-{}", "b".repeat(64));
    for (origin, digit, text) in [
        ("a-moved", "c", forged_text),
        ("host", "b", restored_text.as_str()),
        ("later", "d", forged_text),
        ("z-moved", "e", forged_text),
    ] {
        let id = format!("moment-ydoc-{}", digit.repeat(64));
        retain_restore_audit(&owner.store, &next, "relay", &id, text, 1);
        let settlement = restore_settlement(
            origin,
            &id,
            &owner.initial_text,
            &owner.initial_moment,
            text,
        );
        assert_eq!(
            apply_moment_envelope(&mut owner.store, &settlement, &NoFaults).unwrap(),
            ApplyOutcome::new(ApplyDisposition::Applied(0)),
            "{origin} waits for the restore generation"
        );
    }
    owner
        .store
        .read_with(|conn| {
            conn.execute(
                "UPDATE owner_pending_settlements \
                 SET binding_json=json_set(binding_json,'$.selectorPaths',json_array('owner.md','moved.md')) \
                 WHERE origin_id IN ('a-moved','z-moved')",
                [],
            )
        })
        .unwrap();
    enroll_restore(
        &mut owner.store,
        &next,
        &restored,
        1,
        &owner.observed.limits,
    );
    owner
        .store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO live_owner_activations (relay_database_namespace,activation_id,\
                   workspace_id,main_version_id,object_id,lineage_claim_id,binding_json,\
                   source_moment_id,source_digest,source_byte_length,host_coordinate_json,\
                   released_at_ms,released_restore_generation,released_accepted_cursor,\
                   released_boundary_json,carried_manifest_json) \
                 VALUES ('relay','capture','ws','main','object',?1,?2,?3,?4,?5,'{}',20,1,1,'null','[]')",
                params![
                    next.lineage_claim_id,
                    serde_json::to_string(&next).unwrap(),
                    owner.initial_moment,
                    text_sha(&owner.initial_text),
                    owner.initial_text.len() as i64
                ],
            )
        })
        .unwrap();
    DrainWindow {
        owner,
        restore_id,
        restored_text,
    }
}

/// Each queued settlement in drain order: its origin, whether it was
/// scheduled, whether it applied, and the report that owns it.
fn drain_queue(store: &EngineStore) -> Vec<(String, bool, bool, Option<String>)> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT origin_id,checked_sequence>0,applied,report_id FROM owner_pending_settlements \
                 ORDER BY checked_sequence,terminal_cursor,origin_id,origin_seq",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
            .collect()
        })
        .unwrap()
}

/// One attempt of the drain into `report`, on `tails`.
fn drain_once(
    store: &mut EngineStore,
    tails: &ReleasedTails,
    report: &mut crate::moment_apply::pending::PendingSettlementReport,
) -> Result<(), SyncError> {
    crate::moment_apply::pending::drain_and_claim(
        store,
        "ws",
        tails,
        report,
        &NoFaults,
        &NoLiveLeases,
    )
}

/// The drain's first attempt, which waits at the host settlement: the
/// pending validation and the report that owns a-moved.
fn drain_to_host(
    store: &mut EngineStore,
    tails: &ReleasedTails,
    report: &mut crate::moment_apply::pending::PendingSettlementReport,
) -> (
    Box<dohc_engine_collab::live_update_application::PendingValidation>,
    String,
) {
    let Err(SyncError::ValidationPending(pending)) = drain_once(store, tails, report) else {
        panic!("the host settlement's decision waits for validation");
    };
    let report_id = report.report_id.clone().expect("a-moved's report");
    (pending, report_id)
}

fn commit_settlement_report(store: &mut EngineStore, report_id: Option<String>) {
    let committed = crate::commit_relay_cursor(
        store,
        "ws",
        &crate::RelayCursor {
            bootstrap_complete: true,
            cursor: 0,
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            settlement_report_id: report_id,
            ordinary_pull: None,
        },
        &NoFaults,
        &NoLiveLeases,
        10,
    )
    .unwrap();
    assert!(matches!(
        committed,
        dohc_engine_storage::TxnOutcome::Committed(_)
    ));
}

fn refusal_message(store: &EngineStore, origin: &str) -> String {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT reason_message FROM replication_pending_refusals WHERE origin_id=?1",
                [origin],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// Sol's ruling 1: at the drain's first decision that waits for validation,
/// the waiting settlement rolls back with its scheduling, the one before it
/// commits with its report, and nothing after it is read. Once validation
/// completes the drain goes on from the settlement that waited, in the same
/// report: every row it completes, before and after the wait, carries one
/// id, and its change is reported once.
#[test]
fn a_drain_that_waits_for_validation_commits_only_the_settlements_before_it() {
    let DrainWindow {
        owner: RestoreOwner {
            _scratch,
            mut store,
            ..
        },
        restore_id,
        restored_text,
    } = drain_window();
    let before = snapshot(&store, "object");
    let tails = ReleasedTails::default().bound_to(&store);
    let mut report = crate::moment_apply::pending::PendingSettlementReport::default();
    let (pending, report_id) = drain_to_host(&mut store, &tails, &mut report);
    let owned = Some(report_id.clone());
    assert_eq!(
        drain_queue(&store),
        [
            ("host".into(), false, false, None),
            ("later".into(), false, false, None),
            ("z-moved".into(), false, false, None),
            ("a-moved".into(), true, true, owned.clone()),
        ],
        "only a-moved committed; host rolled back its scheduling"
    );
    assert_eq!(disposition(&store, "a-moved").as_deref(), Some("refused"));
    assert_eq!(
        refusal_message(&store, "a-moved"),
        crate::moment_apply::pending::BINDING_CHANGED
    );
    for origin in ["host", "later", "z-moved"] {
        assert_eq!(
            disposition(&store, origin).as_deref(),
            Some("applied"),
            "{origin} is still queued"
        );
    }
    assert_eq!(snapshot(&store, "object"), before, "host wrote nothing");
    assert!(report.changes.is_empty());
    assert_eq!(
        tails.validation_requests(),
        0,
        "nothing asked the worker yet"
    );

    pending.validate().wait().unwrap();
    drain_once(&mut store, &tails, &mut report).unwrap();
    assert_eq!(report.report_id, owned);
    assert_eq!(
        drain_queue(&store),
        [
            ("a-moved".into(), true, true, owned.clone()),
            ("host".into(), true, true, owned.clone()),
            ("later".into(), true, true, owned.clone()),
            ("z-moved".into(), true, true, owned.clone()),
        ]
    );
    assert_eq!(
        snapshot(&store, "object").map(|(_, _, digest, moment)| (digest, moment)),
        Some((text_sha(&restored_text), restore_id))
    );
    assert_eq!(report.changes.len(), 1, "{:?}", report.changes);
    assert_eq!(report.changes[0].path, "owner.md");
    assert!(!report.has_more);
    for origin in ["later", "z-moved"] {
        assert_eq!(
            disposition(&store, origin).as_deref(),
            Some("refused"),
            "{origin}"
        );
    }
    assert_eq!((tails.validation_requests(), tails.validations()), (1, 1));
    commit_settlement_report(&mut store, owned);
    assert!(
        drain_queue(&store).is_empty(),
        "the report released every row"
    );
}

/// Sol's ruling 1, the retry: a completed validation authorizes nothing by
/// itself. The owner's binding moves while the drain waits, so the
/// settlement that waited is refused when the drain goes on; and a tail input
/// that changes after validation completes makes it wait again for the
/// generation it then reads.
#[test]
fn a_drain_decides_the_settlement_that_waited_again_from_what_it_reads() {
    let DrainWindow {
        owner: RestoreOwner {
            _scratch,
            mut store,
            ..
        },
        ..
    } = drain_window();
    let tails = ReleasedTails::default().bound_to(&store);
    let mut report = crate::moment_apply::pending::PendingSettlementReport::default();
    let (pending, _) = drain_to_host(&mut store, &tails, &mut report);
    pending.validate().wait().unwrap();
    // The capture's release record changes: the generation moves past the
    // one just validated.
    store
        .read_with(|conn| {
            conn.execute(
                "UPDATE live_owner_activations SET released_at_ms=21 WHERE activation_id='capture'",
                [],
            )
        })
        .unwrap();
    let Err(SyncError::ValidationPending(again)) = drain_once(&mut store, &tails, &mut report)
    else {
        panic!("the moved generation waits for its own validation");
    };
    assert_eq!(
        drain_queue(&store)[0],
        ("host".into(), false, false, None),
        "host rolled back again"
    );
    again.validate().wait().unwrap();
    assert_eq!(tails.validation_requests(), 2);
    let before = snapshot(&store, "object");
    store
        .read_with(|conn| {
            conn.execute(
                "UPDATE ydoc_owner_bindings \
                 SET binding_json=json_set(binding_json,'$.selectorPaths',json_array('owner.md','renamed.md'))",
                [],
            )
        })
        .unwrap();
    drain_once(&mut store, &tails, &mut report).unwrap();
    assert_eq!(disposition(&store, "host").as_deref(), Some("refused"));
    assert_eq!(
        refusal_message(&store, "host"),
        crate::moment_apply::pending::BINDING_CHANGED
    );
    assert_eq!(snapshot(&store, "object"), before);
    assert!(report.changes.is_empty());
}

/// Sol's ruling 1, cancellation and crash: a request that stops waiting
/// leaves its committed prefix for the next pull, which reclaims it under a
/// report of its own. Rows a report applied stay reclaimable, with their
/// materialization, until a cursor naming that report commits: an older
/// report releases nothing.
#[test]
fn an_abandoned_drain_leaves_its_committed_prefix_and_materialization_to_the_next_pull() {
    let DrainWindow {
        owner:
            RestoreOwner {
                _scratch: scratch,
                mut store,
                ..
            },
        ..
    } = drain_window();
    let tails = ReleasedTails::default().bound_to(&store);
    let mut report = crate::moment_apply::pending::PendingSettlementReport::default();
    let (pending, abandoned) = drain_to_host(&mut store, &tails, &mut report);
    // The request is cancelled, and the engine stops before anything goes on.
    drop((pending, report));
    let path = engine_db_path(&scratch).unwrap();
    drop(store);
    let mut store = EngineStore::open(&path, 5).unwrap();
    let next =
        crate::moment_apply::pending::drain_to_end(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    let reclaimed = next.report_id.clone().expect("the next pull's report");
    assert_ne!(reclaimed, abandoned);
    assert!(
        drain_queue(&store)
            .iter()
            .all(|(_, _, applied, owner)| *applied && owner.as_deref() == Some(reclaimed.as_str())),
        "the next pull owns the abandoned prefix and the rest"
    );
    assert_eq!(next.changes.len(), 1, "{:?}", next.changes);
    // That pull is lost too, after its writes and before its cursor commits.
    drop(store);
    let mut store = EngineStore::open(&path, 6).unwrap();
    let last =
        crate::moment_apply::pending::drain_to_end(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    assert_eq!(
        last.changes, next.changes,
        "the materialization is reclaimed"
    );
    commit_settlement_report(&mut store, Some(abandoned));
    commit_settlement_report(&mut store, Some(reclaimed));
    assert_eq!(
        drain_queue(&store).len(),
        4,
        "older reports release nothing"
    );
    commit_settlement_report(&mut store, last.report_id);
    assert!(drain_queue(&store).is_empty());
}

/// Sol's ruling 1, the pass: a pull whose drain waits keeps what it fetched
/// and the drain's report. Its next run fetches nothing again and goes on
/// with the same report, so the cursor it returns owns the settlement that
/// committed before the wait, with that settlement's refusal.
#[test]
fn a_pull_whose_drain_waits_goes_on_with_the_same_report() {
    let DrainWindow {
        owner: RestoreOwner {
            _scratch,
            mut store,
            ..
        },
        ..
    } = drain_window();
    let client = crate::RelaySyncClient::new(crate::tests::FakeRelay::default());
    *client.transport().pull.lock().unwrap() = Some(crate::PullResponse {
        work_references: Vec::new(),
        next_reference_after: None,
        reference_has_more: false,
        ops: vec![],
        next_cursor: 0,
        has_more: false,
    });
    let mut cache = dohc_engine_collab::WriterDocCache::default();
    let Err(crate::RelayError::ValidationPending(pending)) =
        client.pull_chat_workspace(&mut store, &mut cache, "ws", &NoFaults, &NoLiveLeases, 7)
    else {
        panic!("the pull's drain waits");
    };
    let committed = drain_queue(&store)
        .into_iter()
        .find_map(|(origin, _, _, report)| (origin == "a-moved").then_some(report))
        .flatten()
        .expect("a-moved committed before the wait");
    // A second fetch fails the pass.
    *client.transport().pull.lock().unwrap() = None;
    pending.validate().wait().unwrap();
    let crate::SyncPassOutcome::Complete {
        pending_cursor: Some(cursor),
        changed_paths,
        refusals,
        ..
    } = client
        .pull_chat_workspace(&mut store, &mut cache, "ws", &NoFaults, &NoLiveLeases, 8)
        .unwrap()
    else {
        panic!("the pass completes");
    };
    assert_eq!(
        cursor.settlement_report_id.as_deref(),
        Some(committed.as_str())
    );
    assert_eq!(
        changed_paths
            .iter()
            .map(|change| change.path.as_str())
            .collect::<Vec<_>>(),
        ["owner.md"]
    );
    let mut refused: Vec<_> = refusals
        .iter()
        .map(|refusal| refusal.origin_id.as_str())
        .collect();
    refused.sort_unstable();
    assert_eq!(refused, ["a-moved", "later", "z-moved"]);
    crate::commit_relay_cursor(&mut store, "ws", &cursor, &NoFaults, &NoLiveLeases, 9).unwrap();
    assert!(drain_queue(&store).is_empty());
}

/// An owner observed at restore generation 0 and accepted cursor 0.
struct RestoreOwner {
    store: EngineStore,
    observed: dohc_engine_collab::owner_outbox::draft::ObservedOwnerBinding,
    checkpoint: Vec<u8>,
    initial_text: String,
    initial_moment: String,
    _scratch: ScratchDir,
}

fn restore_owner() -> RestoreOwner {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let original: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
    let initial_text = fixture["markdown"].as_str().unwrap().to_owned();
    restore_owner_from(&original, &initial_text, "owner.md")
}

fn restore_owner_from(original: &[u8], initial_text: &str, path: &str) -> RestoreOwner {
    let mut owner = unbound_restore_owner_from(original, initial_text, path);
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
        .unwrap();
    owner
}

/// `restore_owner`'s note and the binding it would install, not installed.
fn unbound_restore_owner() -> RestoreOwner {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let original: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
    unbound_restore_owner_from(&original, fixture["markdown"].as_str().unwrap(), "owner.md")
}

fn unbound_restore_owner_from(original: &[u8], initial_text: &str, path: &str) -> RestoreOwner {
    use dohc_engine_collab::live_object_binding::LiveObjectBinding;
    use dohc_engine_collab::owner_outbox::{OwnerOutboxLimits, draft::ObservedOwnerBinding};
    let (scratch, mut store) = test_store();
    crate::adopt_join_identity(&mut store, "ws", "local", "epoch", "stream", 1, &NoFaults).unwrap();
    let initial_moment = format!("moment-ydoc-{}", "a".repeat(64));
    seed_text_moment(
        &mut store,
        "object",
        path,
        initial_text,
        &initial_moment,
        None,
        true,
    );
    let key = DocKey::new("ws", "main", "object").unwrap();
    dohc_engine_collab::claim_base(
        &mut store,
        &key,
        YdocContentKind::Richdoc,
        original,
        &NoFaults,
        2,
    )
    .unwrap();
    store
        .read_with(|conn| conn.execute("UPDATE ydoc_docs SET path=?1", [path]))
        .unwrap();
    let checkpoint = store
        .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
        .unwrap()
        .encode_full_state();
    let observed = ObservedOwnerBinding {
        binding: LiveObjectBinding {
            workspace_id: "ws".into(),
            main_version_id: "main".into(),
            object_id: "object".into(),
            lineage_claim_id: hex_sha256(original),
            current_path: path.into(),
            selector_paths: vec![path.into()],
            restore_fence_generation: 0,
        },
        relay_database_namespace: "relay".into(),
        revision: 1,
        accepted_cursor: 0,
        native_head_sequence: store
            .read_with(|conn| dohc_engine_collab::read_marker_in(conn, &key))
            .unwrap()
            .unwrap()
            .head_update_seq,
        checkpoint_digest: hex_sha256(&checkpoint),
        limits: OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 60_000,
        },
    };
    RestoreOwner {
        _scratch: scratch,
        store,
        observed,
        checkpoint,
        initial_text: initial_text.into(),
        initial_moment,
    }
}

fn apply_test_owner_frame(owner: &mut RestoreOwner, update: Vec<u8>, cursor: i64) {
    use dohc_engine_collab::owner_outbox::accepted::{OwnerAcceptedFrameInput, apply_frame_in_tx};
    let observed = &owner.observed;
    let dohc_engine_storage::TxnOutcome::Committed(result) = owner
        .store
        .write_with(&NoFaults, |tx| {
            apply_frame_in_tx(
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
                10 + cursor,
            )
        })
        .unwrap()
    else {
        panic!("frame must commit")
    };
    owner.observed.revision = result.revision;
    owner.observed.native_head_sequence = result.native_head_sequence;
    owner.observed.accepted_cursor = result.accepted_cursor;
}
/// The host's state once a restore that appends `paragraph` is accepted.
fn restored_host(checkpoint: &[u8], paragraph: &str) -> (Ydoc, String) {
    let host = Ydoc::wire();
    host.apply(checkpoint).unwrap();
    let _ = host.richdoc_append_paragraph(paragraph);
    let text = host.project(YdocContentKind::Richdoc).unwrap().content;
    (host, text)
}

/// The audit parser is covered separately. Seed its committed output.
fn retain_restore_audit(
    store: &EngineStore,
    binding: &dohc_engine_collab::live_object_binding::LiveObjectBinding,
    namespace: &str,
    id: &str,
    text: &str,
    terminal_cursor: i64,
) {
    let record = format!(
        "{{\"momentId\":{},\"relayDatabaseNamespace\":{},\"binding\":{},\"previousCursor\":{terminal_cursor},\"terminalCursor\":{terminal_cursor},\"acceptedEventCount\":0,\"acceptedIntervalDigest\":\"{}\"}}",
        serde_json::to_string(id).unwrap(),
        serde_json::to_string(namespace).unwrap(),
        serde_json::to_string(binding).unwrap(),
        "0".repeat(64)
    );
    store.read_with(|conn| conn.execute("INSERT INTO live_audit_settlements(settlement_id,workspace_id,record_digest,record_json,markdown_digest) VALUES (?1,'ws',?2,?3,?4)", params![id, hex_sha256(record.as_bytes()), record, text_sha(text)])).unwrap();
}

fn restore_settlement(
    origin: &str,
    id: &str,
    initial_text: &str,
    initial_moment: &str,
    text: &str,
) -> ReplicationEnvelope {
    envelope(
        origin,
        0,
        "ws",
        present_text_payload(
            id,
            "object",
            "write",
            "owner.md",
            "owner.md",
            initial_text,
            initial_moment,
            text,
        ),
    )
}

/// The authenticated owner feed reaches `binding` at the host cut `cursor`.
fn enroll_restore(
    store: &mut EngineStore,
    binding: &dohc_engine_collab::live_object_binding::LiveObjectBinding,
    host: &Ydoc,
    cursor: i64,
    limits: &dohc_engine_collab::owner_outbox::OwnerOutboxLimits,
) -> dohc_engine_collab::owner_outbox::draft::OwnerDraftDescriptor {
    use dohc_engine_collab::owner_outbox::enrollment::{
        OwnerEnrollmentInput, OwnerEnrollmentPreparation, enroll_in_tx, prepare_in,
    };
    let captured = match store
        .read_with(|conn| prepare_in(conn, binding, "relay", false))
        .unwrap()
    {
        OwnerEnrollmentPreparation::Capture { captured } => captured,
        other => panic!("a restore generation captures, not {other:?}"),
    };
    let input = OwnerEnrollmentInput {
        binding: binding.clone(),
        relay_database_namespace: "relay".into(),
        captured,
        journal_cursor: cursor,
        checkpoint: host.encode_full_state(),
        host_vector: host.encode_state_vector(),
        recovery: false,
    };
    let advanced = store
        .write_with(&NoFaults, |tx| enroll_in_tx(tx, "ws", &input, limits, 3))
        .unwrap();
    let dohc_engine_storage::TxnOutcome::Committed(advanced) = advanced else {
        panic!("enrollment must commit")
    };
    advanced
}

fn disposition(store: &EngineStore, origin: &str) -> Option<String> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT apply_disposition FROM replication_log WHERE origin_id=?1",
                [origin],
                |row| row.get(0),
            )
        })
        .unwrap()
}

#[test]
fn public_create_author_survives_replay_but_is_not_republished_without_proof() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["---\nanswer: Lisbon\n---\n"]);
    let mut payload = absent_text_payload(
        "accepted-create",
        "response-object",
        "poll/response.md",
        "---\nanswer: Lisbon\n---\n",
    );
    let authors = json!([{"kind":"public", "principalId":"public-holder", "grantId":"grant"}]);
    payload["authors"] = authors.clone();
    let op = envelope("relay:collection-create:grant", 0, "ws", payload);
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("accept"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    apply_moment_envelope(&mut store, &op, &NoFaults).expect("idempotent replay");
    store
        .write_with(&NoFaults, |tx| {
            let count: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM moments WHERE moment_id='accepted-create'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1);
            let stored: String = tx
                .query_row(
                    "SELECT author_json FROM moments WHERE moment_id='accepted-create'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), authors);
            let (exported, _) =
                crate::outbound::moment_append_payload_in_tx(tx, "ws", "accepted-create").unwrap();
            assert!(exported.get("authors").is_none());
            assert_eq!(
                exported["attributionUnavailable"]["reason"],
                "unproven-hosted-authors"
            );
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let history = VersionedTextStore::new(&mut store)
        .get_moment("ws", "accepted-create")
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(history.author_json.as_deref().unwrap()).unwrap(),
        authors
    );
}

const NAMED_ORIGIN: &str = "relay:collection-file:grant";
const TRIP_SCHEMA: &str = "name: Trip\n";

fn named_author(grant_id: &str) -> Value {
    json!({"kind":"named", "userId":"ana", "grantId":grant_id, "grantGeneration":1})
}

fn link_author(grant_id: &str) -> Value {
    json!({"kind":"link", "grantId":grant_id, "grantGeneration":2, "principalId":"holder"})
}

/// Both authors the relay mints for a direct write.
fn direct_write_authors(grant_id: &str) -> [Value; 2] {
    [named_author(grant_id), link_author(grant_id)]
}

fn with_author(mut payload: Value, author: Value) -> Value {
    payload["authors"] = json!([author]);
    payload
}

fn refusal_reason(outcome: ApplyOutcome<i64>) -> String {
    match outcome.primary {
        ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { reason },
            ..
        }) => reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn seed_trip_collection(store: &mut EngineStore) {
    seed_text_moment(
        store,
        "trip-schema",
        "trip/collection.yaml",
        TRIP_SCHEMA,
        "trip-schema-1",
        None,
        true,
    );
    seed_text_moment(
        store,
        "trip-record",
        "trip/lisbon.md",
        "Lisbon",
        "trip-record-1",
        None,
        true,
    );
}

#[test]
fn direct_write_authors_write_a_collections_own_files_from_their_grant_origin() {
    let (_scratch, mut store) = test_store();
    seed_trip_collection(&mut store);
    let writes = [
        present_text_payload(
            "schema-edit",
            "trip-schema",
            "write",
            "trip/collection.yaml",
            "trip/collection.yaml",
            TRIP_SCHEMA,
            "trip-schema-1",
            "name: Trip plan\n",
        ),
        absent_text_payload(
            "automations-create",
            "trip-automations",
            "trip/automations.yaml",
            "version: 1\n",
        ),
        absent_text_payload("record-create", "trip-porto", "trip/porto.md", "Porto"),
        absent_text_payload(
            "new-collection",
            "food-schema",
            "trip/food/collection.yaml",
            "name: Food\n",
        ),
        absent_text_payload(
            "new-collection-record",
            "food-record",
            "trip/food/pastel.md",
            "Pastel",
        ),
    ];
    hydrate_texts(
        &mut store,
        &[
            "name: Trip plan\n",
            "version: 1\n",
            "Porto",
            "name: Food\n",
            "Pastel",
        ],
    );
    // The two authors take turns, so each writes every kind of own file.
    let author = |seq: i64| {
        if seq % 2 == 0 {
            named_author("grant")
        } else {
            link_author("grant")
        }
    };
    for (seq, payload) in (0_i64..).zip(writes) {
        let op = envelope(NAMED_ORIGIN, seq, "ws", with_author(payload, author(seq)));
        assert_eq!(
            apply_moment_envelope(&mut store, &op, &NoFaults).expect("apply"),
            ApplyOutcome::new(ApplyDisposition::Applied(0)),
            "{}",
            op.payload["path"]
        );
    }
    let authors = store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT author_json FROM moments WHERE author_json IS NOT NULL ORDER BY moment_order",
            )?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>(rows)
        })
        .expect("read authors");
    assert_eq!(authors.len(), 5);
    for (seq, stored) in (0_i64..).zip(authors) {
        assert_eq!(
            serde_json::from_str::<Value>(&stored).expect("author JSON"),
            json!([author(seq)])
        );
    }
}

#[test]
fn direct_write_author_and_collection_file_origin_travel_only_together() {
    let (_scratch, mut store) = test_store();
    seed_trip_collection(&mut store);
    hydrate_texts(&mut store, &["version: 1\n"]);
    let automations = || {
        absent_text_payload(
            "automations-create",
            "trip-automations",
            "trip/automations.yaml",
            "version: 1\n",
        )
    };
    let mut cases = vec![
        (NAMED_ORIGIN, Value::Null),
        (
            NAMED_ORIGIN,
            json!({"kind":"public", "principalId":"holder", "grantId":"grant"}),
        ),
        (
            NAMED_ORIGIN,
            json!({"kind":"agent", "agentId":"agent", "onBehalfOf":"owner"}),
        ),
    ];
    for author in direct_write_authors("grant") {
        cases.push(("device-origin", author.clone()));
        cases.push(("relay:collection-create:grant", author.clone()));
        cases.push(("relay:collection-file:other-grant", author));
    }
    cases.extend(direct_write_authors("other-grant").map(|author| (NAMED_ORIGIN, author)));
    for (origin, author) in cases {
        let seq = read_replication_acked_seq(&store, "ws", origin).expect("ack") + 1;
        let payload = if author.is_null() {
            automations()
        } else {
            with_author(automations(), author.clone())
        };
        let outcome =
            apply_moment_envelope(&mut store, &envelope(origin, seq, "ws", payload), &NoFaults)
                .expect("refusal is recorded");
        let expected = if matches!(author["kind"].as_str(), Some("public")) {
            "public moment author requires a relay collection origin"
        } else {
            "direct-write author requires its grant's relay collection-file origin"
        };
        assert_eq!(refusal_reason(outcome), expected, "{origin} {author}");
    }
    assert!(snapshot(&store, "trip-automations").is_none());
}

#[test]
fn direct_write_authors_are_refused_outside_a_collections_own_files() {
    let (_scratch, mut store) = test_store();
    seed_trip_collection(&mut store);
    seed_text_moment(
        &mut store,
        "notes-page",
        "notes/page.md",
        "Notes",
        "notes-page-1",
        None,
        true,
    );
    seed_text_moment(
        &mut store,
        "archive-page",
        "archive/2025/old.md",
        "Old",
        "archive-page-1",
        None,
        true,
    );
    seed_text_moment(
        &mut store,
        "gone-object",
        "elsewhere/gone.md",
        "Gone",
        "gone-object-1",
        None,
        false,
    );
    hydrate_texts(
        &mut store,
        &["version: 1\n", "Changed", "name: Root\n", "code"],
    );
    let refused = [
        // A record update is live editing, never a direct write.
        present_text_payload(
            "record-edit",
            "trip-record",
            "write",
            "trip/lisbon.md",
            "trip/lisbon.md",
            "Lisbon",
            "trip-record-1",
            "Changed",
        ),
        present_text_payload(
            "schema-rename",
            "trip-schema",
            "rename",
            "trip/collection.yaml",
            "trip/schema.yaml",
            TRIP_SCHEMA,
            "trip-schema-1",
            TRIP_SCHEMA,
        ),
        present_text_payload(
            "schema-delete",
            "trip-schema",
            "delete",
            "trip/collection.yaml",
            "trip/collection.yaml",
            TRIP_SCHEMA,
            "trip-schema-1",
            TRIP_SCHEMA,
        ),
        // A record moved onto the schema path, stated as a write.
        {
            let mut moved = present_text_payload(
                "record-onto-schema",
                "trip-record",
                "write",
                "trip/collection.yaml",
                "trip/collection.yaml",
                "Lisbon",
                "trip-record-1",
                "name: Root\n",
            );
            moved["payloadBeforePath"] = json!("trip/lisbon.md");
            moved["beforePath"] = json!("trip/lisbon.md");
            moved
        },
        {
            let mut binary = absent_text_payload(
                "binary-automations",
                "binary-automations",
                "trip/automations.yaml",
                "version: 1\n",
            );
            binary["payloadAfterContentKind"] = json!("binary");
            binary
        },
        absent_text_payload(
            "root-schema",
            "root-schema",
            "collection.yaml",
            "name: Root\n",
        ),
        absent_text_payload(
            "plain-automations",
            "plain-automations",
            "notes/automations.yaml",
            "version: 1\n",
        ),
        absent_text_payload("plain-record", "plain-record", "notes/new.md", "Changed"),
        absent_text_payload(
            "nested-record",
            "nested-record",
            "trip/days/one.md",
            "Changed",
        ),
        absent_text_payload("code", "code", "trip/stamp.js", "code"),
        // Another file's object, with every declared path at the schema.
        present_text_payload(
            "foreign-object-edit",
            "trip-record",
            "write",
            "trip/collection.yaml",
            "trip/collection.yaml",
            "Lisbon",
            "trip-record-1",
            "name: Root\n",
        ),
        absent_text_payload(
            "foreign-object-create",
            "trip-record",
            "trip/automations.yaml",
            "version: 1\n",
        ),
        // An object this workspace held once, now without a head.
        absent_text_payload(
            "deleted-object-create",
            "gone-object",
            "trip/automations.yaml",
            "version: 1\n",
        ),
        // A schema created in a folder that holds files, directly or below.
        absent_text_payload(
            "schema-in-used-folder",
            "notes-schema",
            "notes/collection.yaml",
            "name: Root\n",
        ),
        absent_text_payload(
            "schema-above-files",
            "archive-schema",
            "archive/collection.yaml",
            "name: Root\n",
        ),
    ];
    let cases = direct_write_authors("grant")
        .into_iter()
        .flat_map(|author| {
            refused
                .clone()
                .map(move |payload| with_author(payload, author.clone()))
        });
    for (seq, payload) in (0_i64..).zip(cases) {
        let path = payload["path"].clone();
        let op = envelope(NAMED_ORIGIN, seq, "ws", payload);
        assert_eq!(
            refusal_reason(
                apply_moment_envelope(&mut store, &op, &NoFaults).expect("refusal is recorded")
            ),
            "direct-write author may write only a Collection's own files",
            "{path} {} {}",
            op.payload["momentId"],
            op.payload["authors"][0]["kind"]
        );
    }
    assert_eq!(
        snapshot(&store, "trip-record").map(|head| (head.0, head.3)),
        Some(("trip/lisbon.md".to_owned(), "trip-record-1".to_owned()))
    );
    assert_eq!(
        snapshot(&store, "trip-schema").map(|head| head.3),
        Some("trip-schema-1".to_owned())
    );
    assert!(snapshot(&store, "notes-schema").is_none());
    assert!(snapshot(&store, "archive-schema").is_none());
}

#[test]
fn collection_file_origin_carries_only_moment_append() {
    let (_scratch, mut store) = test_store();
    for (seq, op_kind) in (0_i64..).zip(["conflict.resolve", "conflict.open", "version.create"]) {
        let op = ReplicationEnvelope {
            op_kind: op_kind.to_owned(),
            ..envelope(NAMED_ORIGIN, seq, "ws", json!({}))
        };
        let outcome = apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("refusal is recorded");
        assert!(
            matches!(
                outcome.primary,
                ApplyDisposition::Refused(ReplicationRefusal {
                    reason: RefusalReason::InvalidInput { ref reason },
                    ..
                }) if reason == "relay collection-file origin carries only moment.append"
            ),
            "{op_kind}: {outcome:?}"
        );
    }
    assert_eq!(
        read_replication_acked_seq(&store, "ws", NAMED_ORIGIN).expect("ack"),
        2
    );
}

const PERSONAL_AGENT: &str = "p-abcdefghijklmnopqrstuvwxyz";
const PERSONAL_ORIGIN: &str = "relay:personal-collection:p-abcdefghijklmnopqrstuvwxyz";

fn personal_author(agent_id: &str) -> Value {
    json!({"kind":"agent", "agentId":agent_id, "agentName":"Grok Bot", "onBehalfOf":"owner"})
}

#[test]
fn personal_collection_origin_writes_a_collections_own_files_as_its_agent() {
    let (_scratch, mut store) = test_store();
    seed_trip_collection(&mut store);
    hydrate_texts(&mut store, &["version: 1\n", "Porto"]);
    let writes = [
        absent_text_payload(
            "automations-create",
            "trip-automations",
            "trip/automations.yaml",
            "version: 1\n",
        ),
        absent_text_payload("record-create", "trip-porto", "trip/porto.md", "Porto"),
    ];
    for (seq, payload) in (0_i64..).zip(writes) {
        let op = envelope(
            PERSONAL_ORIGIN,
            seq,
            "ws",
            with_author(payload, personal_author(PERSONAL_AGENT)),
        );
        assert_eq!(
            apply_moment_envelope(&mut store, &op, &NoFaults).expect("apply"),
            ApplyOutcome::new(ApplyDisposition::Applied(0)),
            "{}",
            op.payload["path"]
        );
    }
    let authors = store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT author_json FROM moments WHERE author_json IS NOT NULL ORDER BY moment_order",
            )?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>(rows)
        })
        .expect("read authors");
    assert_eq!(authors.len(), 2);
    for stored in authors {
        assert_eq!(
            serde_json::from_str::<Value>(&stored).expect("author JSON"),
            json!([personal_author(PERSONAL_AGENT)])
        );
    }
}

#[test]
fn personal_collection_origin_refuses_other_paths_and_any_other_author() {
    let (_scratch, mut store) = test_store();
    seed_trip_collection(&mut store);
    hydrate_texts(&mut store, &["version: 1\n", "Notes"]);
    let automations = || {
        absent_text_payload(
            "automations-create",
            "trip-automations",
            "trip/automations.yaml",
            "version: 1\n",
        )
    };
    let wrong_author = "personal-collection origin carries only its agent's author";
    let mut unnamed = personal_author(PERSONAL_AGENT);
    unnamed.as_object_mut().expect("author").remove("agentName");
    let mut with_run = personal_author(PERSONAL_AGENT);
    with_run["agentRunId"] = json!("run");
    let cases = [
        (automations(), None, wrong_author),
        (
            automations(),
            Some(personal_author("p-zyxwvutsrqponmlkjihgfedcba")),
            wrong_author,
        ),
        (
            automations(),
            Some(json!({"kind":"agent", "agentId":PERSONAL_AGENT})),
            wrong_author,
        ),
        (automations(), Some(unnamed), wrong_author),
        (automations(), Some(with_run), wrong_author),
        (automations(), Some(named_author("grant")), wrong_author),
        (
            automations(),
            Some(json!({"kind":"human", "humanId":"owner"})),
            wrong_author,
        ),
        (
            absent_text_payload("note-create", "note", "notes/page.md", "Notes"),
            Some(personal_author(PERSONAL_AGENT)),
            "personal agent may write only a Collection's own files",
        ),
    ];
    for (seq, (payload, author, expected)) in (0_i64..).zip(cases) {
        let payload = match &author {
            Some(author) => with_author(payload, author.clone()),
            None => payload,
        };
        let outcome = apply_moment_envelope(
            &mut store,
            &envelope(PERSONAL_ORIGIN, seq, "ws", payload),
            &NoFaults,
        )
        .expect("refusal is recorded");
        assert_eq!(refusal_reason(outcome), expected, "{author:?}");
    }
    assert!(snapshot(&store, "trip-automations").is_none());
    assert!(snapshot(&store, "note").is_none());
}

#[test]
fn a_ydoc_update_cannot_name_a_personal_agent() {
    let (_scratch, mut store) = test_store();
    let doc = Ydoc::wire();
    doc.plaintext_insert(0, "base text");
    let base_sha = store
        .put_binary_blob(&doc.encode_full_state())
        .expect("Y.Doc base blob");
    let update_sha = store
        .put_binary_blob(&doc.plaintext_insert(9, " and more"))
        .expect("Y.Doc update blob");
    let agent = json!({"actorKind": "agent", "onBehalfOf": "user-1", "depth": 0});
    for (origin, actor) in [
        ("device-origin", json!(PERSONAL_AGENT)),
        (PERSONAL_AGENT, Value::Null),
    ] {
        let forged = ReplicationEnvelope {
            op_kind: "ydoc.update".to_owned(),
            payload: json!({
                "versionId": "main",
                "objectId": "agent-note",
                "path": "notes/agent.md",
                "contentKind": "plaintext",
                "updateBlobSha256": update_sha,
                "lineageClaimId": base_sha,
                "isBaseState": false,
                "actorOriginId": actor,
                "attribution": agent,
            }),
            ..envelope(origin, 0, "ws", json!({}))
        };
        let outcome = apply_ydoc_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &forged,
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("refusal is recorded");
        assert!(
            matches!(
                &outcome.primary,
                ApplyDisposition::Refused(ReplicationRefusal {
                    reason: RefusalReason::InvalidInput { reason },
                    ..
                }) if reason == "ydoc.update agent cannot be a personal agent"
            ),
            "{origin}: {:?}",
            outcome.primary
        );
    }
}

fn hydrate_texts(store: &mut EngineStore, texts: &[&str]) {
    store
        .read_with(|tx| {
            for text in texts {
                tx.execute(
                    "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                    params![text_sha(text), text.len() as i64, text],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .expect("hydrate text blobs");
}

fn seed_text_moment(
    store: &mut EngineStore,
    object_id: &str,
    path: &str,
    text: &str,
    moment_id: &str,
    before: Option<(&str, &str)>,
    materialize_head: bool,
) {
    hydrate_texts(store, &[text]);
    if let Some((_, before_text)) = before {
        hydrate_texts(store, &[before_text]);
    }
    store
        .read_with(|tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws',?1,1)",
                [object_id],
            )?;
            let order: i64 = tx.query_row(
                "SELECT COALESCE(MAX(moment_order),-1)+1 FROM moments WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )?;
            let (before_present, before_sha, before_id) = before.map_or(
                (1_i64, None, None),
                |(before_id, before_text)| {
                    (
                        2_i64,
                        Some(text_sha(before_text)),
                        Some(before_id.to_owned()),
                    )
                },
            );
            tx.execute(
                "INSERT INTO moments (
                   workspace_id,moment_order,moment_id,version_id,object_id,path,recorded_at_ms,
                   operation,after_blob_sha256,before_present,before_blob_sha256,
                   before_latest_moment_id,metadata_origin,author_json,sync_record_only,
                   after_content_kind,after_binary_sha256,before_content_kind,before_binary_sha256
                 ) VALUES ('ws',?1,?2,'main',?3,?4,?5,'write',?6,?7,?8,?9,
                           'api',NULL,NULL,'text',NULL,'text',NULL)",
                params![
                    order,
                    moment_id,
                    object_id,
                    path,
                    100 + order,
                    text_sha(text),
                    before_present,
                    before_sha,
                    before_id
                ],
            )?;
            if materialize_head {
                tx.execute(
                    "INSERT INTO snapshots (
                       workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,
                       latest_moment_id,metadata_origin,content_kind,binary_sha256
                     ) VALUES ('ws','main',?1,?2,?3,?4,?5,'api','text',NULL)
                     ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET
                       path=excluded.path,blob_sha256=excluded.blob_sha256,
                       updated_at_ms=excluded.updated_at_ms,
                       latest_moment_id=excluded.latest_moment_id,
                       metadata_origin=excluded.metadata_origin,content_kind='text',
                       binary_sha256=NULL",
                    params![object_id, path, text_sha(text), 100 + order, moment_id],
                )?;
                tx.execute(
                    "INSERT INTO path_aliases (workspace_id,version_id,path,object_id)
                     VALUES ('ws','main',?1,?2)
                     ON CONFLICT(workspace_id,version_id,path) DO UPDATE SET object_id=excluded.object_id",
                    params![path, object_id],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .expect("seed text moment");
}

fn seed_text_lineage(
    store: &mut EngineStore,
    object_id: &str,
    path: &str,
    base_text: &str,
    base_id: &str,
    head_text: &str,
    head_id: &str,
) {
    seed_text_moment(store, object_id, path, base_text, base_id, None, false);
    seed_text_moment(
        store,
        object_id,
        path,
        head_text,
        head_id,
        Some((base_id, base_text)),
        true,
    );
}
fn absent_text_payload(moment_id: &str, object_id: &str, path: &str, text: &str) -> Value {
    json!({
        "momentId": moment_id,
        "versionId": "main",
        "objectId": object_id,
        "objectCreatedAtMs": 1,
        "path": path,
        "recordedAtMs": 2_000,
        "operation": "write",
        "payloadBeforeBlobSha256": null,
        "payloadBeforePath": null,
        "payloadAfterBlobSha256": text_sha(text),
        "payloadAfterPath": path,
        "metadata": {"origin": "sync"},
        "beforePresent": "absent"
    })
}

#[allow(clippy::too_many_arguments)]
fn present_text_payload(
    moment_id: &str,
    object_id: &str,
    operation: &str,
    path: &str,
    after_path: &str,
    before_text: &str,
    before_head: &str,
    after_text: &str,
) -> Value {
    json!({
        "momentId": moment_id,
        "versionId": "main",
        "objectId": object_id,
        "objectCreatedAtMs": 1,
        "path": path,
        "recordedAtMs": 2_000,
        "operation": operation,
        "payloadBeforeBlobSha256": text_sha(before_text),
        "payloadBeforePath": path,
        "payloadAfterBlobSha256": text_sha(after_text),
        "payloadAfterPath": after_path,
        "metadata": {"origin": "sync", "summary": "peer"},
        "beforePresent": "present",
        "beforeObjectId": object_id,
        "beforeVersionId": "main",
        "beforePath": path,
        "beforeBlobSha256": text_sha(before_text),
        "beforeUpdatedAtMs": 100,
        "beforeLatestMomentId": before_head,
        "beforeMetadata": {"origin": "api"}
    })
}

fn stopped_binary_moment() -> (
    ScratchDir,
    EngineStore,
    ReplicationEnvelope,
    dohc_engine_collab::owner_outbox::OwnerOutboxAppendResult,
    Vec<u8>,
) {
    use dohc_engine_collab::live_object_binding::LiveObjectBinding;
    use dohc_engine_collab::live_update_application::{
        NativeRestoreFence, NativeRestoreFenceReceipt, RestoreDeliveryOrigin,
    };
    use dohc_engine_collab::owner_outbox::{self, OwnerOutboxAppendInput, OwnerOutboxLimits};
    let (scratch, mut store) = test_store();
    crate::adopt_join_identity(
        &mut store,
        "ws",
        "local-peer",
        "epoch",
        "stream",
        1_000,
        &NoFaults,
    )
    .expect("joined workspace identity");
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: "shared.md".into(),
                text: "current".into(),
                moment_id: "current-moment".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 100,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("real current moment");
    let binding = LiveObjectBinding {
        workspace_id: "ws".into(),
        main_version_id: "main".into(),
        object_id: "object".into(),
        lineage_claim_id: "lineage".into(),
        current_path: "shared.md".into(),
        selector_paths: vec!["shared.md".into()],
        restore_fence_generation: 0,
    };
    let bytes = vec![0xff, 0x00, 0xfe, 0x01];
    let outbox = owner_outbox::append(
        &mut store,
        "ws",
        OwnerOutboxAppendInput {
            binding: LiveObjectBinding {
                object_id: "other".into(),
                current_path: "other.md".into(),
                selector_paths: vec!["other.md".into()],
                ..binding.clone()
            },
            base_update: b"different base".to_vec(),
            append_key: "other-update".into(),
            update: bytes.clone(),
            limits: OwnerOutboxLimits {
                max_pending_bytes: 10_000,
                max_pending_age_ms: 10_000,
            },
            created_at_ms: 1_000,
        },
    )
    .expect("independent outbox owns the shared digest");
    let operation = NativeRestoreFence {
        point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
            journal_cursor: 0,
            receipt_digest: binding.lineage_claim_id.clone(),
        },
        operation_id: "restore".into(),
        relay_database_namespace: "relay".into(),
        old_binding: binding,
        host_id: "host".into(),
        new_fence: 1,
        origin: RestoreDeliveryOrigin::Bootstrap {
            id: "bootstrap".into(),
        },
        terminal: None,
        applied_sequence: 0,
    };
    let receipt = NativeRestoreFenceReceipt {
        operation: operation.clone(),
        local_head_sequence: 0,
        recorded_at_ms: 1_001,
    };
    store.read_with(|conn| conn.execute(
        "INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,input_json,receipt_json) VALUES ('ws','main','object','relay','restore',?1,?2)",
        params![serde_json::to_string(&operation).unwrap(), serde_json::to_string(&receipt).unwrap()],
    )).expect("seed the durable stopped-lineage guard");
    let mut payload = present_text_payload(
        "refused-moment",
        "object",
        "write",
        "shared.md",
        "shared.md",
        "current",
        "current-moment",
        "unused",
    );
    payload["payloadAfterBlobSha256"] = json!(hex_sha256(&bytes));
    payload["payloadAfterContentKind"] = json!("binary");
    payload["payloadAfterByteLength"] = json!(bytes.len());
    payload["authors"] =
        json!([{"kind":"agent","agentId":"original-agent","onBehalfOf":"original-owner"}]);
    (
        scratch,
        store,
        envelope("original-peer", 0, "ws", payload),
        outbox,
        bytes,
    )
}

#[test]
fn stopped_moment_retains_shared_blobs_after_outbox_ack_report_and_restart() {
    use dohc_engine_collab::owner_outbox::{self, OwnerDeliveryReceipt};
    let (_scratch, mut store, op, outbox, bytes) = stopped_binary_moment();
    let db = store.database_path().to_owned();
    let before = snapshot(&store, "object");
    let result = apply_moment_envelope(&mut store, &op, &NoFaults).unwrap();
    assert!(
        matches!(result.primary, ApplyDisposition::Refused(ReplicationRefusal {
        reason: RefusalReason::InvalidInput { ref reason }, ..
    }) if reason == "live document is stopped")
    );
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "original-peer").unwrap(),
        0
    );
    assert_eq!(snapshot(&store, "object"), before);
    let ack = owner_outbox::acknowledge(
        &mut store,
        "ws",
        &outbox.outbox_id,
        &[OwnerDeliveryReceipt {
            delivery_id: outbox.delivery_id,
            update_digest: outbox.update_digest,
            journal_cursor: 1,
            accepting_host_epoch: 1,
        }],
    )
    .expect("unrelated outbox can release its ownership");
    assert_eq!(ack.pending_bytes, 0);
    assert_eq!(
        store.get_binary_blob(&hex_sha256(&bytes)).unwrap(),
        Some(bytes.clone())
    );
    let refusals = crate::apply::read_pending_refusals(&store, "ws").unwrap();
    assert_eq!(refusals.len(), 1);
    crate::commit_relay_cursor(
        &mut store,
        "ws",
        &crate::RelayCursor {
            bootstrap_complete: true,
            cursor: 1,
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            settlement_report_id: None,
            ordinary_pull: None,
        },
        &NoFaults,
        &crate::NoLiveLeases,
        3_000,
    )
    .expect("report commit");
    drop(store);
    let mut store = EngineStore::open(&db, 4_000).unwrap();
    store.read_with(|conn| {
        let saved: (String, String, i64, i64, i64) = conn.query_row(
            "SELECT payload_json,apply_disposition,recorded_at_ms,imported,origin_seq FROM replication_log WHERE workspace_id='ws' AND origin_id='original-peer' AND origin_seq=0",
            [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
        )?;
        assert_eq!(serde_json::from_str::<Value>(&saved.0).unwrap(), op.payload);
        assert_eq!((saved.1, saved.2, saved.3, saved.4), ("refused".into(), op.recorded_at_ms, 1, 0));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM replication_pending_refusals", [], |r| r.get::<_,i64>(0))?, 1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM replication_refused_moment_blobs", [], |r| r.get::<_,i64>(0))?, 3);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM moments WHERE moment_id='refused-moment'", [], |r| r.get::<_,i64>(0))?, 0);
        assert!(conn.execute("DELETE FROM binary_blobs WHERE sha256=?1", [hex_sha256(&bytes)]).is_err());
        Ok::<_,rusqlite::Error>(())
    }).unwrap();
    assert_eq!(
        store.get_binary_blob(&hex_sha256(&bytes)).unwrap(),
        Some(bytes)
    );
    assert_eq!(snapshot(&store, "object"), before);
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Skipped
    ));
    assert_eq!(snapshot(&store, "object"), before);
}

#[test]
fn stopped_moment_retention_failure_does_not_ack_or_commit_refusal() {
    let (_scratch, mut store, op, _outbox, _bytes) = stopped_binary_moment();
    let before = snapshot(&store, "object");
    store.read_with(|conn| conn.execute_batch(
        "CREATE TEMP TRIGGER reject_retention BEFORE INSERT ON replication_refused_moment_blobs WHEN NEW.role='payload-after' BEGIN SELECT RAISE(ABORT,'retention unavailable'); END;"
    )).unwrap();
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults),
        Err(SyncError::Storage(_))
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "original-peer").unwrap(),
        -1
    );
    assert_eq!(snapshot(&store, "object"), before);
    store
        .read_with(|conn| {
            for table in [
                "replication_refused_moment_blobs",
                "replication_pending_refusals",
                "replication_log",
            ] {
                assert_eq!(
                    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                        .get::<_, i64>(0))?,
                    0
                );
            }
            conn.execute_batch("DROP TRIGGER reject_retention")?;
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "original-peer").unwrap(),
        0
    );
}

fn snapshot(store: &EngineStore, object_id: &str) -> Option<(String, String, String, String)> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT path,COALESCE(content_kind,'text'),
                        COALESCE(blob_sha256,binary_sha256),latest_moment_id
                 FROM snapshots WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                [object_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
        })
        .expect("snapshot")
}

fn aliases(store: &EngineStore, object_id: &str) -> Vec<String> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT path FROM path_aliases WHERE workspace_id='ws' AND version_id='main' \
                 AND object_id=?1 ORDER BY path",
            )?
            .query_map([object_id], |row| row.get(0))?
            .collect()
        })
        .expect("aliases")
}

fn indexed(store: &EngineStore, object_id: &str) -> Vec<(String, String)> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT path,text FROM engine_search_files_fts \
                 WHERE workspace_id='ws' AND version_id='main' AND object_id=?1 ORDER BY path",
            )?
            .query_map([object_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect()
        })
        .expect("search rows")
}

fn conflict_ids(store: &EngineStore) -> Vec<String> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT conflict_id FROM conflicts WHERE workspace_id='ws' ORDER BY conflict_id",
            )?
            .query_map([], |row| row.get(0))?
            .collect()
        })
        .expect("conflict ids")
}

#[test]
fn moment_delete_with_unsettled_lineage_stays_unacked() {
    let (_scratch, mut store) = test_store();
    store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','unsettled-delete-object',1)",
                [],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .expect("seed unsettled object");
    let key = DocKey::new("ws", "main", "unsettled-delete-object").expect("Y.Doc key");
    let doc = Ydoc::wire();
    let update = doc.plaintext_insert(0, "only durable draft");
    dohc_engine_collab::record_local_update(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &update,
        dohc_engine_collab::LocalAppend {
            marker: Some(dohc_engine_collab::MarkerCreation {
                path: Some("notes/unsettled.md"),
                content_kind: YdocContentKind::Plaintext,
                regime: Regime::LocalOnly,
            }),
            ..Default::default()
        },
        &NoFaults,
        1_500,
        |_tx, _outcome, _update_sha| Ok(()),
    )
    .expect("seed unsettled lineage");
    hydrate_texts(&mut store, &["remote head", ""]);
    let delete = envelope(
        "unsettled-delete-peer",
        0,
        "ws",
        present_text_payload(
            "moment-delete-unsettled",
            "unsettled-delete-object",
            "delete",
            "notes/unsettled.md",
            "notes/unsettled.md",
            "remote head",
            "remote-head",
            "",
        ),
    );

    let outcome = apply_replication_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &delete,
        &NoFaults,
        &NoLiveLeases,
    );
    assert!(
        matches!(
            outcome,
            Err(SyncError::RetryableState {
                reason: "ydoc-lineage-unsettled"
            })
        ),
        "unexpected delete outcome: {outcome:?}"
    );
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "unsettled-delete-peer").expect("ack"),
        -1
    );
    let (moments, log, updates, snapshots, deferred, docs): (i64, i64, i64, i64, i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' \
                         AND moment_id='moment-delete-unsettled'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log WHERE workspace_id='ws' \
                         AND origin_id='unsettled-delete-peer'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_updates WHERE workspace_id='ws' \
                         AND version_id='main' AND object_id='unsettled-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_snapshots WHERE workspace_id='ws' \
                         AND version_id='main' AND object_id='unsettled-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_deferred_updates WHERE workspace_id='ws' \
                         AND version_id='main' AND object_id='unsettled-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id='ws' \
                         AND version_id='main' AND object_id='unsettled-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("inspect retryable delete");
    assert_eq!((moments, log), (0, 0));
    assert_eq!(
        (updates, snapshots, deferred, docs),
        (1, 0, 0, 1),
        "the only durable draft must remain byte-for-byte reachable"
    );
}

#[test]
fn malformed_moment_append_is_refused_and_acked_before_the_origin_continues() {
    let (_scratch, mut store) = test_store();
    let malformed = envelope("malformed-moment-peer", 0, "ws", json!({}));

    assert_eq!(
        apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &malformed,
            &NoFaults,
            &crate::NoLiveLeases
        )
        .expect("malformed per-operation payload is a disposition"),
        ApplyOutcome::new(ApplyDisposition::Refused(ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "malformed-moment-peer".to_owned(),
            origin_seq: 0,
            op_kind: "moment.append".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "moment.append payload is malformed".to_owned(),
            },
        })),
        "parsing before apply_envelope_with returns a hard error and leaves seq 0 unacked"
    );
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "malformed-moment-peer").expect("refusal ack"),
        0
    );

    let next = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "ws".to_owned(),
        origin_id: "malformed-moment-peer".to_owned(),
        origin_seq: 1,
        op_kind: "chat.channel.create".to_owned(),
        payload: json!({
            "channelId": "after-malformed-moment",
            "name": "Still moving",
            "slug": "still-moving",
            "kind": "channel",
            "createdAtMs": 2_001
        }),
        recorded_at_ms: 2_001,
        relay_seq: Some(1),
    };
    assert!(matches!(
        apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &next,
            &NoFaults,
            &crate::NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let channel_rows: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM chat_channels
                 WHERE workspace_id='ws' AND channel_id='after-malformed-moment'",
                [],
                |row| row.get(0),
            )
        })
        .expect("next operation mutation");
    assert_eq!(channel_rows, 1);
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "malformed-moment-peer").expect("next ack"),
        1
    );
}

#[test]
fn moment_append_head_fast_forward_write_delete_and_rename_updates_alias_snapshot_and_search() {
    let (_scratch, mut write_store) = test_store();
    hydrate_texts(&mut write_store, &["written"]);
    let write = envelope(
        "write-peer",
        0,
        "ws",
        absent_text_payload("remote-write", "object-write", "write.md", "written"),
    );
    assert_eq!(
        apply_moment_envelope(&mut write_store, &write, &NoFaults).expect("write"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        snapshot(&write_store, "object-write"),
        Some((
            "write.md".to_owned(),
            "text".to_owned(),
            text_sha("written"),
            "remote-write".to_owned()
        ))
    );
    assert_eq!(aliases(&write_store, "object-write"), ["write.md"]);
    assert_eq!(
        indexed(&write_store, "object-write"),
        [("write.md".to_owned(), "written".to_owned())]
    );

    let (_scratch, mut delete_store) = test_store();
    seed_text_moment(
        &mut delete_store,
        "object-delete",
        "delete.md",
        "gone",
        "local-delete-head",
        None,
        true,
    );
    delete_store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO engine_search_files_fts \
                 (workspace_id,version_id,object_id,path,text) \
                 VALUES ('ws','main','object-delete','delete.md','gone')",
                [],
            )
        })
        .expect("seed search");
    let delete = envelope(
        "delete-peer",
        0,
        "ws",
        present_text_payload(
            "remote-delete",
            "object-delete",
            "delete",
            "delete.md",
            "delete.md",
            "gone",
            "local-delete-head",
            "gone",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut delete_store, &delete, &NoFaults).expect("delete"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(snapshot(&delete_store, "object-delete"), None);
    assert!(aliases(&delete_store, "object-delete").is_empty());
    assert!(indexed(&delete_store, "object-delete").is_empty());

    let (_scratch, mut rename_store) = test_store();
    seed_text_moment(
        &mut rename_store,
        "object-rename",
        "old.md",
        "same",
        "local-rename-head",
        None,
        true,
    );
    rename_store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO engine_search_files_fts \
                 (workspace_id,version_id,object_id,path,text) \
                 VALUES ('ws','main','object-rename','old.md','same')",
                [],
            )
        })
        .expect("seed search");
    let rename = envelope(
        "rename-peer",
        0,
        "ws",
        present_text_payload(
            "remote-rename",
            "object-rename",
            "rename",
            "peer-old.md",
            "new.md",
            "same",
            "local-rename-head",
            "same",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut rename_store, &rename, &NoFaults).expect("rename"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        aliases(&rename_store, "object-rename"),
        ["new.md"],
        "deleting the payloadBeforePath alias instead of the matched local head path leaves old.md behind beside the new live alias."
    );
    assert_eq!(
        snapshot(&rename_store, "object-rename").unwrap().0,
        "new.md"
    );
    assert_eq!(
        indexed(&rename_store, "object-rename"),
        [("new.md".to_owned(), "same".to_owned())]
    );
}

#[test]
fn moment_append_live_lease_blocks_all_mutations_until_it_closes() {
    for (operation, after_path, after_text) in [
        ("write", "head.md", "changed"),
        ("rename", "renamed.md", "before"),
        ("delete", "head.md", "before"),
    ] {
        let (_scratch, mut store) = test_store();
        let object_id = format!("live-{operation}-object");
        let origin_id = format!("live-{operation}-peer");
        let moment_id = format!("live-{operation}-moment");
        seed_text_moment(
            &mut store,
            &object_id,
            "head.md",
            "before",
            "local-head",
            None,
            true,
        );
        hydrate_texts(&mut store, &[after_text]);
        let key = DocKey::new("ws", "main", &object_id).expect("Y.Doc key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "before");
        dohc_engine_collab::record_local_update(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &update,
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some("head.md"),
                    content_kind: YdocContentKind::Plaintext,
                    regime: Regime::LocalOnly,
                }),
                ..Default::default()
            },
            &NoFaults,
            1_500,
            |_tx, _outcome, _update_sha| Ok(()),
        )
        .expect("seed live lineage");
        let op = envelope(
            &origin_id,
            0,
            "ws",
            present_text_payload(
                &moment_id,
                &object_id,
                operation,
                "head.md",
                after_path,
                "before",
                "local-head",
                after_text,
            ),
        );
        let before = (
            snapshot(&store, &object_id),
            aliases(&store, &object_id),
            indexed(&store, &object_id),
            store
                .read_with(|conn| {
                    Ok::<_, rusqlite::Error>((
                        conn.query_row(
                            "SELECT COUNT(*) FROM moments WHERE workspace_id='ws'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM replication_log WHERE workspace_id='ws'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM ydoc_updates WHERE workspace_id='ws' \
                             AND version_id='main' AND object_id=?1",
                            [&object_id],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id='ws' \
                             AND version_id='main' AND object_id=?1",
                            [&object_id],
                            |row| row.get::<_, i64>(0),
                        )?,
                    ))
                })
                .expect("state before live apply"),
        );
        let leases = LeaseRegistry::new();
        let held = leases.acquire(&key).expect("hold document live");

        assert!(matches!(
            apply_replication_envelope(
                &mut store,
                &mut dohc_engine_collab::WriterDocCache::new(),
                &op,
                &NoFaults,
                &leases
            ),
            Err(SyncError::RetryableState {
                reason: "ydoc-session-live"
            })
        ));
        assert_eq!(
            read_replication_acked_seq(&store, "ws", &origin_id).expect("live ack"),
            -1,
            "{operation} must remain unacknowledged while its document is live"
        );
        let after_live = (
            snapshot(&store, &object_id),
            aliases(&store, &object_id),
            indexed(&store, &object_id),
            store
                .read_with(|conn| {
                    Ok::<_, rusqlite::Error>((
                        conn.query_row(
                            "SELECT COUNT(*) FROM moments WHERE workspace_id='ws'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM replication_log WHERE workspace_id='ws'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM ydoc_updates WHERE workspace_id='ws' \
                             AND version_id='main' AND object_id=?1",
                            [&object_id],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id='ws' \
                             AND version_id='main' AND object_id=?1",
                            [&object_id],
                            |row| row.get::<_, i64>(0),
                        )?,
                    ))
                })
                .expect("state after live apply"),
        );
        assert_eq!(after_live, before, "live {operation} mutated durable state");

        drop(held);
        let closed = apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &op,
            &NoFaults,
            &leases,
        );
        if operation == "write" {
            // The write continues the head, and the lineage holds only that
            // head and never left this device, so the lineage retires.
            assert!(matches!(
                closed,
                Ok(ApplyOutcome {
                    primary: ApplyDisposition::Applied(ref applied),
                    ..
                }) if applied.conflicts_opened == 0
            ));
            assert_eq!(
                read_replication_acked_seq(&store, "ws", &origin_id).expect("write ack"),
                0,
                "the write must be acknowledged once the lease closes"
            );
            assert_eq!(snapshot(&store, &object_id).unwrap().3, moment_id);
            assert!(conflict_ids(&store).is_empty());
            assert_eq!(
                store
                    .read_with(|conn| conn.query_row(
                        "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id='ws' \
                         AND version_id='main' AND object_id=?1",
                        [&object_id],
                        |row| row.get::<_, i64>(0),
                    ))
                    .expect("lineage after write"),
                0,
                "the lineage retires"
            );
            continue;
        }
        assert!(matches!(
            closed,
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(_),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ));
        match operation {
            "delete" => assert_eq!(snapshot(&store, &object_id), None),
            "rename" => assert_eq!(snapshot(&store, &object_id).unwrap().0, "renamed.md"),
            _ => unreachable!(),
        }
    }
}

#[test]
fn open_document_covered_settlement_is_history_only_with_crash_replay() {
    assert_covered_artifact_crash_replay(true);
}

fn assert_covered_artifact_crash_replay(changed: bool) {
    use dohc_engine_storage::FaultPoint;
    use dohc_engine_testkit::ScriptedFaults;
    for advanced in [false, true] {
        for point in [
            FaultPoint::SyncBeforeApplyCommit,
            FaultPoint::StorageAfterCommitBeforeAck,
        ] {
            let (scratch, mut store) = test_store();
            let key = DocKey::new("ws", "main", "object").unwrap();
            let doc = Ydoc::wire();
            doc.plaintext_insert(0, "artifact");
            let sha = store.put_binary_blob(&doc.encode_full_state()).unwrap();
            let base = ReplicationEnvelope {
                settlement_admission: None,
                admitted_author_snapshot: None,
                workspace_id: "ws".into(),
                origin_id: "peer".into(),
                origin_seq: 0,
                op_kind: "ydoc.update".into(),
                recorded_at_ms: 1_500,
                relay_seq: Some(1),
                payload: json!({"versionId":"main","objectId":"object","path":"head.md",
                    "contentKind":"plaintext","updateBlobSha256":sha,"lineageClaimId":sha,"isBaseState":true}),
            };
            apply_ydoc_envelope(
                &mut store,
                &mut Default::default(),
                &base,
                &NoFaults,
                &NoLiveLeases,
            )
            .unwrap();
            if advanced {
                VersionedTextStore::new(&mut store)
                    .write_text(
                        &WriteText {
                            workspace_id: "ws".into(),
                            version_id: "main".into(),
                            object_id: "object".into(),
                            path: "head.md".into(),
                            text: "artifact plus peer edits".into(),
                            moment_id: "peer-edit".into(),
                            metadata_origin: "ydoc".into(),
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: None,
                            now_ms: 1_600,
                            request_id: None,
                        },
                        &NoFaults,
                    )
                    .unwrap();
                let foreign = envelope(
                    "other-lineage",
                    0,
                    "ws",
                    absent_text_payload("foreign-artifact", "object", "head.md", "artifact"),
                );
                assert!(matches!(
                    apply_detailed(&mut store, &foreign, &NoFaults, &crate::AlwaysLive),
                    Err(SyncError::RetryableState {
                        reason: "ydoc-session-live"
                    })
                ));
            }
            let disk = scratch.path().join("head.md");
            let disk_before = "artifact on disk";
            std::fs::write(&disk, disk_before).unwrap();
            let jobs = |store: &EngineStore| {
                store
                    .read_with(|conn| {
                        conn.query_row("SELECT COUNT(*) FROM materialization_jobs", [], |r| {
                            r.get::<_, i64>(0)
                        })
                    })
                    .unwrap()
            };
            let jobs_before = jobs(&store);
            let before = (
                snapshot(&store, "object"),
                aliases(&store, "object"),
                indexed(&store, "object"),
            );
            let leases = LeaseRegistry::new();
            let held = leases.acquire(&key).unwrap();
            held.bind_claim(base.payload["lineageClaimId"].as_str())
                .unwrap();
            let (seq, artifact) = if changed {
                let delta = doc.plaintext_insert(8, " settled on peer");
                let sha = store.put_binary_blob(&delta).unwrap();
                let mut update = base.clone();
                update.origin_seq = 1;
                update.payload["updateBlobSha256"] = json!(sha);
                update.payload["isBaseState"] = json!(false);
                apply_ydoc_envelope(
                    &mut store,
                    &mut Default::default(),
                    &update,
                    &NoFaults,
                    &leases,
                )
                .unwrap();
                hydrate_texts(&mut store, &["artifact settled on peer"]);
                (2, "artifact settled on peer")
            } else {
                (1, "artifact")
            };
            let op = envelope(
                "peer",
                seq,
                "ws",
                absent_text_payload(
                    "moment-ydoc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "object",
                    "head.md",
                    artifact,
                ),
            );
            let faults = ScriptedFaults::crash_at(point);
            let result = apply_detailed(&mut store, &op, faults.as_ref(), &leases).unwrap();
            assert!(matches!(result.primary, ApplyDisposition::Crashed { .. }));
            assert!(faults.fired());
            drop(store);
            let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 2_100).unwrap();
            let committed: (i64, i64, i64) = store.read_with(|conn|conn.query_row("SELECT (SELECT COUNT(*) FROM moments WHERE moment_id='moment-ydoc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), (SELECT COUNT(*) FROM replication_log WHERE origin_id='peer' AND origin_seq=?1), (SELECT COUNT(*) FROM ydoc_pending_artifacts)", [seq], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))).unwrap();
            let durable = point == FaultPoint::StorageAfterCommitBeforeAck;
            assert_eq!(
                committed,
                if durable {
                    (1, 1, i64::from(changed || advanced))
                } else {
                    (0, 0, 0)
                }
            );
            assert_eq!(
                read_replication_acked_seq(&store, "ws", "peer").unwrap(),
                if durable { seq } else { seq - 1 }
            );
            let result = apply_detailed(&mut store, &op, &NoFaults, &leases).unwrap();
            if let ApplyDisposition::Applied(applied) = result.primary {
                assert_eq!(applied.conflicts_opened, 0);
                assert!(applied.materialization_changes.is_empty());
            } else {
                assert!(matches!(result.primary, ApplyDisposition::Skipped));
            }
            assert_eq!(
                (
                    snapshot(&store, "object"),
                    aliases(&store, "object"),
                    indexed(&store, "object")
                ),
                before
            );
            assert_eq!(
                read_replication_acked_seq(&store, "ws", "peer").unwrap(),
                seq
            );
            assert!(conflict_ids(&store).is_empty());
            assert_eq!(std::fs::read_to_string(&disk).unwrap(), disk_before);
            assert_eq!(jobs(&store), jobs_before);
            let rows:i64 = store.read_with(|conn|conn.query_row(
                "SELECT COUNT(*) FROM moments WHERE moment_id='moment-ydoc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' AND sync_record_only=1", [], |r|r.get(0))).unwrap();
            assert_eq!(rows, 1);
            assert!(matches!(
                apply_detailed(&mut store, &op, &NoFaults, &leases)
                    .unwrap()
                    .primary,
                ApplyDisposition::Skipped
            ));
            let journaled: i64 = store.read_with(|conn| conn.query_row("SELECT COUNT(*) FROM replication_log WHERE origin_id='peer' AND origin_seq=?1", [seq], |r| r.get(0))).unwrap();
            assert_eq!(journaled, 1);
            assert!(
                crate::moment_apply::stored_materialization_changes(&store, &op)
                    .unwrap()
                    .is_empty()
            );
            let persisted = store
                .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
                .unwrap();
            assert_eq!(
                persisted
                    .project(YdocContentKind::Plaintext)
                    .unwrap()
                    .content,
                "artifact"
            );
        }
    }
}

#[test]
fn moment_append_equal_text_for_bound_owner_keeps_live_binding_checks() {
    let RestoreOwner {
        _scratch,
        mut store,
        initial_text,
        initial_moment,
        ..
    } = restore_owner();
    let key = DocKey::new("ws", "main", "object").unwrap();
    let before = snapshot(&store, "object");
    let op = envelope(
        "unaudited-peer",
        0,
        "ws",
        present_text_payload(
            "unaudited-equal-moment",
            "object",
            "write",
            "owner.md",
            "owner.md",
            &initial_text,
            &initial_moment,
            &initial_text,
        ),
    );
    let leases = LeaseRegistry::new();
    let held = leases.acquire(&key).unwrap();
    assert!(matches!(
        apply_detailed(&mut store, &op, &NoFaults, &leases),
        Err(SyncError::RetryableState {
            reason: "ydoc-session-live"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "unaudited-peer").unwrap(),
        -1
    );
    assert_eq!(store.table_row_count("moments").unwrap(), 1);

    drop(held);
    let result = apply_detailed(&mut store, &op, &NoFaults, &leases).unwrap();
    assert!(matches!(
        result.primary,
        ApplyDisposition::Refused(ReplicationRefusal {
            reason: RefusalReason::InvalidInput { ref reason },
            ..
        }) if reason == "live document binding is still active"
    ));
    assert_eq!(store.table_row_count("moments").unwrap(), 1);
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        0
    );
    assert_eq!(snapshot(&store, "object"), before);
}

/// A conflict that names the history-only predecessor as its incoming side
/// holds it only while the conflict is open. After a resolution, a successor
/// of the equal preimage adopts the local head. An unequal preimage never does.
#[test]
fn file_successor_of_a_resolved_conflicts_incoming_side_adopts_the_local_preimage() {
    for (status, before_text, adopts) in [
        ("resolved", "agreed", true),
        ("open", "agreed", false),
        ("resolved", "other", false),
    ] {
        let label = format!("status={status} before={before_text}");
        let (_scratch, mut store) = test_store();
        seed_text_moment(
            &mut store,
            "object",
            "same.md",
            "agreed",
            "local-head",
            None,
            true,
        );
        hydrate_texts(&mut store, &["next", "other"]);
        let artifact = envelope(
            "peer",
            0,
            "ws",
            absent_text_payload("remote-artifact", "object", "same.md", "agreed"),
        );
        apply_moment_envelope(&mut store, &artifact, &NoFaults).unwrap();
        store
            .read_with(|conn| {
                conn.execute(
                    "INSERT INTO conflicts (workspace_id,conflict_id,path,target_version_id,\
                     source_version_id,created_at_ms,updated_at_ms,status,chosen_from,\
                     metadata_origin,base_exists,base_path,current_exists,current_path,\
                     current_object_id,current_content_kind,current_blob_sha256,\
                     current_latest_moment_id,incoming_exists,incoming_path,incoming_object_id,\
                     incoming_content_kind,incoming_blob_sha256,incoming_latest_moment_id) \
                     VALUES ('ws','conflict-artifact','same.md','main','main',1,1,?1,'incoming',\
                     'sync',0,'same.md',1,'same.md','object','text',?2,'local-head',\
                     1,'same.md','object','text',?2,'remote-artifact')",
                    params![status, text_sha("agreed")],
                )
            })
            .unwrap();
        let next = envelope(
            "peer",
            1,
            "ws",
            present_text_payload(
                "remote-next",
                "object",
                "write",
                "same.md",
                "same.md",
                before_text,
                "remote-artifact",
                "next",
            ),
        );
        apply_moment_envelope(&mut store, &next, &NoFaults).expect(&label);
        let head = snapshot(&store, "object").unwrap().3;
        if adopts {
            assert_eq!(head, "remote-next", "{label}");
            let before: String = store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT before_latest_moment_id FROM moments \
                         WHERE moment_id='remote-next'",
                        [],
                        |r| r.get(0),
                    )
                })
                .unwrap();
            assert_eq!(before, "local-head", "{label}");
        } else {
            assert_eq!(head, "local-head", "{label}");
            assert!(
                store
                    .read_with(|conn| conn.query_row(
                        "SELECT COUNT(*) FROM conflicts WHERE status='open'",
                        [],
                        |r| r.get::<_, i64>(0)
                    ))
                    .unwrap()
                    >= 1,
                "{label}"
            );
        }
    }
}

#[test]
fn moment_append_divergence_opens_one_duplicate_envelope_skips_and_next_head_coalesces() {
    let (_scratch, mut store) = test_store();
    seed_text_lineage(
        &mut store,
        "object",
        "doc.md",
        "base",
        "base-moment",
        "local",
        "local-root",
    );
    hydrate_texts(
        &mut store,
        &["base", "payload-before", "remote-one", "remote-two"],
    );
    let mut first_payload = present_text_payload(
        "remote-root",
        "object",
        "write",
        "doc.md",
        "doc.md",
        "base",
        "base-moment",
        "remote-one",
    );
    first_payload["payloadBeforeBlobSha256"] = json!(text_sha("payload-before"));
    first_payload["payloadBeforePath"] = json!("payload-before.md");
    let first = envelope("peer", 0, "ws", first_payload);
    assert_eq!(
        apply_moment_envelope(&mut store, &first, &NoFaults).expect("first"),
        ApplyOutcome::new(ApplyDisposition::Applied(1))
    );
    store
        .read_with(|conn| {
            let base: (i64, String, Option<String>, String, Option<String>) = conn.query_row(
                "SELECT base_exists,base_path,base_object_id,base_blob_sha256,
                        base_latest_moment_id
                 FROM conflicts WHERE workspace_id='ws'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?;
            assert_eq!(
                base,
                (
                    1,
                    "doc.md".to_owned(),
                    Some("object".to_owned()),
                    text_sha("base"),
                    Some("base-moment".to_owned())
                )
            );
            Ok::<_, rusqlite::Error>(())
        })
        .expect("wire before conflict base");
    assert_eq!(
        apply_moment_envelope(&mut store, &first, &NoFaults).expect("duplicate envelope"),
        ApplyOutcome::new(ApplyDisposition::Skipped)
    );
    let second = envelope(
        "peer",
        1,
        "ws",
        present_text_payload(
            "remote-next",
            "object",
            "write",
            "doc.md",
            "doc.md",
            "remote-one",
            "remote-root",
            "remote-two",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &second, &NoFaults).expect("coalesce"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(conflict_ids(&store).len(), 1);
    let incoming: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT incoming_latest_moment_id FROM conflicts WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )
        })
        .expect("incoming head");
    assert_eq!(incoming, "remote-next");
}

#[test]
fn moment_append_after_a_shipped_fork_head_rolls_back_after_reopen() {
    let (scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["shipped", "remote edit"]);
    let shipped_sha = text_sha("shipped");
    let version = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "ws".to_owned(),
        origin_id: "version-peer".to_owned(),
        origin_seq: 0,
        op_kind: "version.create".to_owned(),
        payload: json!({
            "versionId": "feature",
            "name": "Feature",
            "kind": "named",
            "forkVersionId": "main",
            "forkMomentId": "fork-point",
            "createdAtMs": 1_500,
            "forkSnapshots": [{
                "objectId": "shipped-object",
                "objectCreatedAtMs": 1_100,
                "path": "shipped.md",
                "blobSha256": shipped_sha,
                "updatedAtMs": 1_200,
                "latestMomentId": "shipped-head",
                "metadata": {
                    "origin": "sync",
                    "summary": "shipped summary",
                    "correlationId": "shipped correlation"
                }
            }]
        }),
        recorded_at_ms: 1_500,
        relay_seq: Some(0),
    };
    apply_replication_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &version,
        &NoFaults,
        &crate::NoLiveLeases,
    )
    .expect("materialize shipped fork");

    let mut payload = present_text_payload(
        "remote-after-shipped",
        "shipped-object",
        "write",
        "shipped.md",
        "shipped.md",
        "shipped",
        "shipped-head",
        "remote edit",
    );
    payload["versionId"] = json!("feature");
    payload["beforeVersionId"] = json!("feature");
    payload["beforeUpdatedAtMs"] = json!(1_200);
    payload["beforeMetadata"] = json!({
        "origin": "sync",
        "summary": "shipped summary",
        "correlationId": "shipped correlation"
    });
    let append = envelope("moment-peer", 0, "ws", payload);
    assert_eq!(
        apply_moment_envelope(&mut store, &append, &NoFaults).expect("append after shipped head"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    type StoredPreimage = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let stored_preimage: StoredPreimage = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT before_object_id, before_version_id, before_path,
                        before_updated_at_ms, before_metadata_origin,
                        before_metadata_summary, before_metadata_correlation_id
                   FROM moments
                  WHERE workspace_id = 'ws' AND moment_id = 'remote-after-shipped'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
        })
        .expect("stored rollback preimage");
    assert_eq!(
        stored_preimage,
        (
            Some("shipped-object".to_owned()),
            Some("feature".to_owned()),
            Some("shipped.md".to_owned()),
            Some(1_200),
            Some("sync".to_owned()),
            Some("shipped summary".to_owned()),
            Some("shipped correlation".to_owned()),
        ),
        "omit any identity/metadata binding from insert_moment and the durable preimage tuple no longer matches the shipped snapshot.",
    );

    let database_path = engine_db_path(&scratch).expect("database path");
    drop(store);
    let mut reopened = EngineStore::open(&database_path, 3_000).expect("reopen");
    VersionedTextStore::new(&mut reopened)
        .rollback_text_file_mutation(
            &RollbackTextFileMutation {
                workspace_id: "ws".to_owned(),
                version_id: "feature".to_owned(),
                path: "shipped.md".to_owned(),
                mutation_moment_id: "remote-after-shipped".to_owned(),
                request_id: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            &NoFaults,
        )
        .expect("rollback after reopen");
    let versioned = VersionedTextStore::new(&mut reopened);
    let restored = versioned
        .read_text("ws", "feature", "shipped.md")
        .expect("read restored head")
        .expect("restored head");
    assert_eq!(restored.text, "shipped");
    assert!(restored.latest_moment_id.starts_with("rollback-"));
    let compensation = versioned
        .get_moment("ws", &restored.latest_moment_id)
        .expect("read compensating moment")
        .expect("compensating moment");
    assert_eq!(compensation.operation, MomentOp::Write);
    assert_eq!(
        compensation.before_latest_moment_id.as_deref(),
        Some("remote-after-shipped")
    );
    assert_eq!(restored.updated_at_ms, 1_200);
    assert_eq!(restored.metadata_origin, "restore");
    assert_eq!(restored.metadata_summary, None);
    assert_eq!(restored.metadata_correlation_id, None);
}

#[test]
fn moment_append_refuses_non_tracked_or_noncanonical_paths_without_rows_and_acks() {
    let mut secret_after = absent_text_payload(
        "secret-after",
        "secret-after-object",
        "docs/safe.md",
        "content",
    );
    secret_after["payloadAfterPath"] = json!("app/.env");

    let mut noncanonical_path = absent_text_payload(
        "noncanonical-path",
        "noncanonical-path-object",
        "docs/safe.md",
        "content",
    );
    noncanonical_path["path"] = json!("a//b.md");

    let mut noncanonical_after = absent_text_payload(
        "noncanonical-after",
        "noncanonical-after-object",
        "docs/safe.md",
        "content",
    );
    noncanonical_after["payloadAfterPath"] = json!("a//b.md");

    let mut secret_before = absent_text_payload(
        "secret-before",
        "secret-before-object",
        "docs/new.md",
        "content",
    );
    secret_before["payloadBeforePath"] = json!("app/.env");
    secret_before["payloadBeforeBlobSha256"] = json!(text_sha("content"));

    let mut secret_before_snapshot = present_text_payload(
        "secret-before-snapshot",
        "secret-before-snapshot-object",
        "write",
        "docs/safe.md",
        "docs/safe.md",
        "content",
        "remote-base",
        "content",
    );
    secret_before_snapshot["beforePath"] = json!("app/.env");

    let mut noncanonical_before_snapshot = present_text_payload(
        "noncanonical-before-snapshot",
        "noncanonical-before-snapshot-object",
        "write",
        "docs/safe.md",
        "docs/safe.md",
        "content",
        "remote-base",
        "content",
    );
    noncanonical_before_snapshot["beforePath"] = json!("a//b.md");

    for (case, payload, object_id) in [
        (
            "secret payloadAfterPath",
            secret_after,
            "secret-after-object",
        ),
        (
            "noncanonical path",
            noncanonical_path,
            "noncanonical-path-object",
        ),
        (
            "noncanonical payloadAfterPath",
            noncanonical_after,
            "noncanonical-after-object",
        ),
        (
            "secret payloadBeforePath",
            secret_before,
            "secret-before-object",
        ),
        (
            "secret beforePath",
            secret_before_snapshot,
            "secret-before-snapshot-object",
        ),
        (
            "noncanonical beforePath",
            noncanonical_before_snapshot,
            "noncanonical-before-snapshot-object",
        ),
    ] {
        let (_scratch, mut store) = test_store();
        hydrate_texts(&mut store, &["content"]);
        let op = envelope("peer", 0, "ws", payload);
        assert!(
            matches!(
                apply_moment_envelope(&mut store, &op, &NoFaults),
                Ok(ApplyOutcome {
                    primary: ApplyDisposition::Refused(ReplicationRefusal {
                        reason: RefusalReason::InvalidInput { .. },
                        ..
                    }),
                    refusals: ref outcome_refusals,
                    sharing_declined: ref outcome_sharing_declined,
                }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
            ),
            "{case} must be refused"
        );
        let persisted: (i64, i64, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' AND object_id=?1",
                        [object_id],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' AND object_id=?1",
                        [object_id],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM path_aliases WHERE workspace_id='ws' AND object_id=?1",
                        [object_id],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("rejected path leaves no rows");
        assert_eq!(persisted, (0, 0, 0), "{case} persisted poisoned rows");
        assert_eq!(
            read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
            0,
            "{case} did not advance the peer ack"
        );
    }

    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["content"]);
    let canonical = envelope(
        "peer",
        0,
        "ws",
        absent_text_payload(
            "canonical",
            "canonical-object",
            "docs/canonical.md",
            "content",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &canonical, &NoFaults).expect("canonical tracked path"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        snapshot(&store, "canonical-object").unwrap().0,
        "docs/canonical.md"
    );
    assert_eq!(
        aliases(&store, "canonical-object"),
        ["docs/canonical.md".to_owned()]
    );

    let canonical_before = envelope(
        "canonical-before-peer",
        0,
        "ws",
        present_text_payload(
            "canonical-before",
            "canonical-before-object",
            "write",
            "docs/canonical-before.md",
            "docs/canonical-after.md",
            "content",
            "remote-base",
            "content",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &canonical_before, &NoFaults)
            .expect("canonical tracked beforePath"),
        ApplyOutcome::new(ApplyDisposition::Applied(1))
    );
}

#[test]
fn moment_append_search_index_respects_files_and_visibility_policy() {
    let (scratch, mut store) = test_store();
    std::fs::write(
        scratch.path().join(".dohc/files.toml"),
        "[[rule]]\npath = \"private/**\"\nsearchable = false\n",
    )
    .expect("files policy");
    std::fs::write(
        scratch.path().join(".dohc/visibility.toml"),
        "[[rule]]\npath = \"hidden/**\"\nvisibility = \"hidden\"\n",
    )
    .expect("visibility policy");
    hydrate_texts(
        &mut store,
        &["private needle", "hidden needle", "public needle"],
    );

    for (origin, moment_id, object_id, path, text) in [
        (
            "private-peer",
            "private-moment",
            "private-object",
            "private/doc.md",
            "private needle",
        ),
        (
            "hidden-peer",
            "hidden-moment",
            "hidden-object",
            "hidden/doc.md",
            "hidden needle",
        ),
        (
            "public-peer",
            "public-moment",
            "public-object",
            "public/doc.md",
            "public needle",
        ),
    ] {
        let op = envelope(
            origin,
            0,
            "ws",
            absent_text_payload(moment_id, object_id, path, text),
        );
        assert_eq!(
            apply_moment_envelope(&mut store, &op, &NoFaults).expect("policy-aware apply"),
            ApplyOutcome::new(ApplyDisposition::Applied(0))
        );
    }

    assert!(
        indexed(&store, "private-object").is_empty(),
        "removing or inverting either policy predicate indexes one of the excluded rows; skipping the healthy insert loses the public row."
    );
    assert!(indexed(&store, "hidden-object").is_empty());
    assert_eq!(
        indexed(&store, "public-object"),
        [("public/doc.md".to_owned(), "public needle".to_owned())]
    );

    std::fs::write(
        scratch.path().join(".dohc/files.toml"),
        "rule = \"not-an-array\"\n",
    )
    .expect("degraded files policy");
    hydrate_texts(&mut store, &["updated needle"]);
    let degraded = envelope(
        "public-peer",
        1,
        "ws",
        present_text_payload(
            "public-degraded-moment",
            "public-object",
            "write",
            "public/doc.md",
            "public/doc.md",
            "public needle",
            "public-moment",
            "updated needle",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &degraded, &NoFaults).expect("degraded-policy apply"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    // A degraded policy freezes FILE indexing: the prior row remains until a
    // healthy policy can safely decide whether to replace or remove it.
    assert_eq!(
        indexed(&store, "public-object"),
        [("public/doc.md".to_owned(), "public needle".to_owned())]
    );
}

#[test]
fn moment_append_rejects_a_poisoned_binary_blob_as_storage_corruption_before_mutation() {
    let (_scratch, mut store) = test_store();
    let claimed = hex_sha256(b"honest binary");
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO binary_blobs (sha256,byte_length,bytes) VALUES (?1,?2,?3)",
                params![claimed, b"poisoned".len() as i64, b"poisoned".as_slice()],
            )
        })
        .expect("poison binary blob");
    let payload = json!({
        "momentId": "binary-moment",
        "versionId": "main",
        "objectId": "binary-object",
        "objectCreatedAtMs": 1,
        "path": "assets/file.bin",
        "recordedAtMs": 2_000,
        "operation": "write",
        "payloadBeforeBlobSha256": null,
        "payloadBeforePath": null,
        "payloadAfterBlobSha256": claimed,
        "payloadAfterPath": "assets/file.bin",
        "payloadAfterContentKind": "binary",
        "payloadAfterByteLength": b"honest binary".len(),
        "metadata": {"origin": "sync"},
        "beforePresent": "absent"
    });
    let op = envelope("peer", 0, "ws", payload);
    let error = apply_moment_envelope(&mut store, &op, &NoFaults)
        .expect_err("poisoned binary blob must fail closed");
    assert!(
        matches!(
            error,
            SyncError::Storage(dohc_engine_storage::StorageError::BlobIntegrity { .. })
        ),
        "local blob corruption must remain a hard storage error, got {error:?}"
    );
    let persisted: (i64, i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' AND moment_id='binary-moment'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' AND object_id='binary-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases WHERE workspace_id='ws' AND object_id='binary-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("failed binary apply leaves no rows");
    assert_eq!(persisted, (0, 0, 0));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
        -1
    );
}

pub(crate) fn ended_recovery_fixture() -> (ScratchDir, EngineStore, DocKey, Ydoc, String) {
    let (scratch, mut store) = test_store();
    let key = DocKey::new("ws", "main", "object").unwrap();
    let doc = Ydoc::wire();
    doc.plaintext_insert(0, "before");
    let claim = store.put_binary_blob(&doc.encode_full_state()).unwrap();
    let mut base = envelope(
        "peer",
        0,
        "ws",
        json!({"versionId":"main","objectId":"object","path":"head.md","contentKind":"plaintext","updateBlobSha256":claim,"lineageClaimId":claim,"isBaseState":true}),
    );
    base.op_kind = "ydoc.update".into();
    base.relay_seq = Some(1);
    apply_ydoc_envelope(
        &mut store,
        &mut Default::default(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    let leases = LeaseRegistry::new();
    let held = leases.acquire(&key).unwrap();
    held.bind_claim(Some(&claim)).unwrap();
    let delta = doc.plaintext_insert(6, " remote");
    base.origin_seq = 1;
    base.relay_seq = Some(2);
    base.payload["isBaseState"] = json!(false);
    base.payload["updateBlobSha256"] = json!(store.put_binary_blob(&delta).unwrap());
    apply_ydoc_envelope(
        &mut store,
        &mut Default::default(),
        &base,
        &NoFaults,
        &leases,
    )
    .unwrap();
    hydrate_texts(&mut store, &["before remote"]);
    let moment = envelope(
        "peer",
        2,
        "ws",
        absent_text_payload(
            &format!("moment-ydoc-{}", "a".repeat(64)),
            "object",
            "head.md",
            "before remote",
        ),
    );
    apply_detailed(&mut store, &moment, &NoFaults, &leases).unwrap();
    drop(held);
    (scratch, store, key, doc, claim)
}

fn recover_ended(store: &mut EngineStore) -> Result<crate::OpenArtifactDrain, SyncError> {
    crate::drain_open_document_artifacts(
        store,
        &mut Default::default(),
        "ws",
        &NoLiveLeases,
        &NoFaults,
    )
}

/// Sol's third and Opus's first findings on 3409694c7: recovery in a pass
/// writes what the rows of a document it completes committed as drain
/// reports, in the transaction that removes them, so a later op's wait, an
/// abandoned pass or a restart still reports them once, with no recovery
/// failure. The direct recovery API answers the same results at once.
#[test]
fn recovery_in_a_pass_reports_what_it_removed_through_drain_reports() {
    type Reported = (
        Vec<(String, &'static str)>,
        Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
        i64,
    );
    fn paths(changes: &[crate::MomentMaterializationChange]) -> Vec<(String, &'static str)> {
        changes
            .iter()
            .map(|change| (change.path.clone(), change.operation))
            .collect()
    }
    fn marks(store: &EngineStore) -> (i64, i64) {
        store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT (SELECT COUNT(*) FROM replication_pending_refusals WHERE reason_code=?1), \
                       (SELECT COUNT(*) FROM ydoc_pending_artifacts)",
                    [crate::moment_apply::open_artifacts::RECOVERY_FAILURE_CODE],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .unwrap()
    }

    let (_scratch, mut store, _, _, _) = ended_recovery_fixture();
    let direct = recover_ended(&mut store).unwrap();
    assert_eq!(store.table_row_count("ydoc_drain_reports").unwrap(), 0);
    let expected: Reported = (
        paths(&direct.changes),
        direct.record_facts.clone(),
        direct.conflicts_opened,
    );
    let direct_marks = marks(&store);
    assert_eq!(direct_marks.0, 0, "no recovery failure");

    for restart in [false, true] {
        let (scratch, mut store, _, _, _) = ended_recovery_fixture();
        let recovered = crate::moment_apply::open_artifacts::drain_open_document_artifacts_durably(
            &mut store,
            &mut Default::default(),
            "ws",
            &NoLiveLeases,
            &mut Default::default(),
            &NoFaults,
        )
        .unwrap();
        assert!(recovered.waiting.is_none());
        assert!(
            recovered.changes.is_empty()
                && recovered.record_facts.is_empty()
                && recovered.conflicts_opened == 0,
            "restart={restart}: the drain reports carry them"
        );
        assert_eq!(marks(&store), direct_marks, "restart={restart}");

        // A later op of the pass waits and the pass is abandoned, or the
        // store restarts; the next pass claims the reports.
        let mut store = if restart {
            drop(store);
            EngineStore::open(&engine_db_path(&scratch).unwrap(), 3_000).unwrap()
        } else {
            store
        };
        let mut first = None;
        let claimed = crate::drain_report::claim(&mut store, "ws", &mut first, &NoFaults).unwrap();
        let reported: Reported = (
            paths(&claimed.extras.changes),
            claimed.record_facts,
            claimed.extras.conflicts_opened,
        );
        assert_eq!(reported, expected, "restart={restart}");
        let mut second = None;
        let again = crate::drain_report::claim(&mut store, "ws", &mut second, &NoFaults).unwrap();
        assert_eq!(paths(&again.extras.changes), expected.0);
        store
            .write_with(&NoFaults, |tx| {
                crate::cursor::release_settlement_report_in_tx(
                    tx,
                    "ws",
                    second.as_deref().expect("a report token"),
                )
            })
            .unwrap();
        assert_eq!(store.table_row_count("ydoc_drain_reports").unwrap(), 0);
        assert_eq!(marks(&store), direct_marks, "restart={restart}");
    }
}

#[test]
fn ended_recovery_storage_failure_propagates_without_notice_or_fingerprint() {
    let (_scratch, mut store, _, _, _) = ended_recovery_fixture();
    store.write_with(&NoFaults, |tx| {
        tx.execute_batch("CREATE TRIGGER fail_projection BEFORE INSERT ON moments WHEN NEW.moment_id GLOB 'moment-ydoc-apply-*' BEGIN SELECT RAISE(ABORT,'projection unavailable'); END;").unwrap();
        Ok::<_,SyncError>(())
    }).unwrap();
    assert!(matches!(
        recover_ended(&mut store),
        Err(SyncError::Storage(
            dohc_engine_storage::StorageError::PersistFailed { .. }
        ))
    ));
    store
        .read_with(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_refusals",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
            assert_eq!(
                conn.query_row(
                    "SELECT last_attempt_state FROM ydoc_pending_artifacts",
                    [],
                    |r| r.get::<_, Option<String>>(0)
                )
                .unwrap(),
                None
            );
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

#[test]
fn ended_recovery_retries_inserted_durable_update_blob() {
    let (_scratch, mut store, key, doc, claim) = ended_recovery_fixture();
    let (sha, bytes): (String,Vec<u8>)=store.read_with(|conn|conn.query_row("SELECT b.sha256,b.bytes FROM binary_blobs b JOIN replication_log r ON b.sha256=json_extract(r.payload_json,'$.updateBlobSha256') WHERE r.origin_seq=1", [], |r|Ok((r.get(0)?,r.get(1)?)))).unwrap();
    dohc_engine_collab::apply_remote_update(
        &mut store,
        &mut Default::default(),
        &key,
        &dohc_engine_collab::RemoteUpdate {
            origin_id: "peer".into(),
            origin_seq: 1,
            bytes: bytes.clone(),
        },
        None,
        None,
        &NoFaults,
        2000,
    )
    .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM ydoc_deferred_updates WHERE origin_seq=1", [])
                .unwrap();
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let tail = doc.plaintext_insert(13, " tail");
    let tail_sha = store.put_binary_blob(&tail).unwrap();
    let mut update = envelope(
        "peer",
        3,
        "ws",
        json!({"versionId":"main","objectId":"object","path":"head.md","contentKind":"plaintext","updateBlobSha256":tail_sha,"lineageClaimId":claim,"isBaseState":false}),
    );
    update.op_kind = "ydoc.update".into();
    update.relay_seq = Some(4);
    apply_ydoc_envelope(
        &mut store,
        &mut Default::default(),
        &update,
        &NoFaults,
        &crate::AlwaysLive,
    )
    .unwrap();
    // Model a missing durable blob while preserving the parked tail's blob.
    store
        .read_with(|conn| conn.execute_batch("PRAGMA foreign_keys=OFF"))
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM binary_blobs WHERE sha256=?1", [&sha])
                .unwrap();
            Ok::<_, SyncError>(())
        })
        .unwrap();
    recover_ended(&mut store).unwrap();
    let attempted: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT last_attempt_state FROM ydoc_pending_artifacts",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    recover_ended(&mut store).unwrap();
    assert_eq!(
        store
            .read_with(|conn| conn.query_row(
                "SELECT last_attempt_state FROM ydoc_pending_artifacts",
                [],
                |r| r.get::<_, String>(0)
            ))
            .unwrap(),
        attempted
    );
    store.put_binary_blob(&bytes).unwrap();
    store
        .read_with(|conn| conn.execute_batch("PRAGMA foreign_keys=ON"))
        .unwrap();
    recover_ended(&mut store).unwrap();
    assert_eq!(
        snapshot(&store, "object").unwrap().2,
        text_sha("before remote tail")
    );
    let remaining:i64=store.read_with(|conn|conn.query_row("SELECT (SELECT COUNT(*) FROM ydoc_pending_artifacts)+(SELECT COUNT(*) FROM ydoc_deferred_updates)+(SELECT COUNT(*) FROM replication_pending_refusals)", [], |r|r.get(0))).unwrap();
    assert_eq!(remaining, 0);
}

#[path = "moment_apply_tests/owner_retirement.rs"]
mod owner_retirement;

#[path = "moment_apply_tests/drained_admission.rs"]
mod drained_admission;
#[path = "moment_apply_tests/held_host_update.rs"]
mod held_host_update;
