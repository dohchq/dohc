use super::*;
use crate::{owner_outbox::draft::open_draft_in, DocKey};
use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_test_scratch::ScratchDir;

fn fixture() -> (ScratchDir, EngineStore, ObservedOwnerBinding, Vec<u8>) {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let original: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
    fixture_with_source(&original, fixture["markdown"].as_str().unwrap(), "owner.md")
}

fn fixture_with_source(
    original: &[u8],
    markdown: &str,
    path: &str,
) -> (ScratchDir, EngineStore, ObservedOwnerBinding, Vec<u8>) {
    let dir = ScratchDir::new_named("observed-owner-draft").unwrap();
    let mut store = EngineStore::open(&dir.join("engine.db"), 0).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 0, &NoFaults)
        .unwrap();
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: path.into(),
                text: markdown.into(),
                moment_id: "original".into(),
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
    let key = DocKey::new("workspace", "main", "object").unwrap();
    crate::claim_base(
        &mut store,
        &key,
        crate::ContentKind::Richdoc,
        original,
        &NoFaults,
        2,
    )
    .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET path=?1", [path]).unwrap();
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    let (head, checkpoint) = store
        .read_with(|conn| {
            Ok::<_, OwnerOutboxError>((
                crate::read_marker_in(conn, &key)
                    .map_err(collab)?
                    .unwrap()
                    .head_update_seq,
                bounded(&crate::load_doc_in(conn, &key).map_err(collab)?)?,
            ))
        })
        .unwrap();
    let observed = ObservedOwnerBinding {
        binding: LiveObjectBinding {
            workspace_id: "workspace".into(),
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
        native_head_sequence: head,
        checkpoint_digest: hex_sha256(&checkpoint),
        limits: OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 60_000,
        },
    };
    (dir, store, observed, checkpoint)
}

fn input(
    store: &EngineStore,
    observed: &ObservedOwnerBinding,
    checkpoint: Vec<u8>,
) -> OwnerEnrollmentInput {
    let host = Ydoc::wire();
    host.apply(&checkpoint).unwrap();
    OwnerEnrollmentInput {
        binding: observed.binding.clone(),
        relay_database_namespace: "relay".into(),
        captured: store
            .read_with(|conn| capture_in(conn, &observed.binding))
            .unwrap(),
        journal_cursor: 9,
        checkpoint,
        host_vector: host.encode_state_vector(),
        recovery: false,
    }
}
fn enroll(
    store: &mut EngineStore,
    input: &OwnerEnrollmentInput,
    limits: &OwnerOutboxLimits,
) -> Result<OwnerDraftDescriptor, OwnerOutboxError> {
    match store.write_with(&NoFaults, |tx| {
        enroll_in_tx(tx, "workspace", input, limits, 10)
    })? {
        TxnOutcome::Committed(draft) => Ok(draft),
        _ => panic!("unexpected fault"),
    }
}
fn remote_changes(store: &EngineStore) -> i64 {
    store
        .read_with(|c| dohc_engine_storage::remote_changes_applied_in(c, "workspace"))
        .unwrap()
}

fn collection_fixture() -> (ScratchDir, EngineStore, ObservedOwnerBinding, Vec<u8>, Ydoc) {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let original: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
    let local = Ydoc::wire();
    local.apply(&original).unwrap();
    local
        .frontmatter_set("id", "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa")
        .unwrap();
    local.frontmatter_set("title", "Original").unwrap();
    local.frontmatter_set("status", "open").unwrap();
    let markdown = local.project(crate::ContentKind::Richdoc).unwrap().content;
    let (dir, mut store, observed, checkpoint) =
        fixture_with_source(&bounded(&local).unwrap(), &markdown, "tasks/owner.md");
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "schema".into(),
                path: "tasks/collection.yaml".into(),
                text: "fields:\n  title:\n    type: text\n  status:\n    type: text\n  priority:\n    type: text\n".into(),
                moment_id: "schema".into(),
                metadata_origin: "user".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, "workspace", "main")
        })
        .unwrap();
    let vector = local.encode_state_vector();
    local.frontmatter_set("title", "Edited title").unwrap();
    local.frontmatter_set("status", "done").unwrap();
    store
        .write_with(&NoFaults, |tx| {
            crate::record_update_in_tx(
                tx,
                &key(&observed.binding).unwrap(),
                &local.diff(&vector).unwrap(),
                Some("person"),
                None,
                3,
            )
        })
        .unwrap();
    (dir, store, observed, checkpoint, local)
}

type FieldHistoryRow = (String, Option<String>, Option<String>, Option<String>);

fn field_history(store: &EngineStore) -> Vec<FieldHistoryRow> {
    store
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT field_name,previous_value_json,next_value_json,author_origin_id \
             FROM collection_field_history WHERE workspace_id='workspace' \
               AND version_id='main' AND record_id='rec_aaaaaaaaaaaaaaaaaaaaaaaaaa' \
             ORDER BY history_id",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<Result<Vec<_>, _>>();
            rows
        })
        .unwrap()
}

fn assert_visible_fields(
    store: &EngineStore,
    binding: &LiveObjectBinding,
    expected: serde_json::Value,
) {
    store
        .read_with(|conn| {
            let indexed =
                dohc_engine_domain::collections::indexed_collection_record_frontmatter_in_tx(
                    conn,
                    "workspace",
                    "main",
                    "object",
                )
                .unwrap()
                .unwrap();
            assert_eq!(indexed, expected);
            let observed = super::super::draft::read_observed_in(conn, binding)?.unwrap();
            let draft = open_draft_in(conn, binding, observed.revision)?;
            let mut visible = draft.doc.frontmatter_json();
            visible.as_object_mut().unwrap().remove("id");
            assert_eq!(indexed, visible, "the index must follow the visible draft");
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
}

fn accept_field_frame(store: &mut EngineStore, binding: &LiveObjectBinding, bytes: Vec<u8>) {
    use crate::owner_outbox::accepted::{apply_frame_in_tx, OwnerAcceptedFrameInput};
    let observed = store
        .read_with(|conn| super::super::draft::read_observed_in(conn, binding))
        .unwrap()
        .unwrap();
    let input = OwnerAcceptedFrameInput {
        binding: binding.clone(),
        relay_database_namespace: "relay".into(),
        expected_revision: observed.revision,
        expected_native_head_sequence: observed.native_head_sequence,
        previous_accepted_cursor: observed.accepted_cursor,
        journal_cursor: observed.accepted_cursor + 1,
        update_bytes: bytes,
    };
    for _ in 0..2 {
        store
            .write_with(&NoFaults, |tx| {
                apply_frame_in_tx(tx, "workspace", &input, 11)
            })
            .unwrap();
    }
}

fn refuse_field_entry(
    store: &mut EngineStore,
    outbox: &str,
    entry: &super::super::OwnerOutboxEntry,
) {
    let refusal = super::super::OwnerOutboxRefuseInput {
        outbox_id: outbox.into(),
        delivery_id: entry.delivery_id.clone(),
        update_digest: entry.update_digest.clone(),
        reason: "The presser no longer has edit access.".into(),
    };
    for _ in 0..2 {
        store
            .write_with(&NoFaults, |tx| {
                super::super::refuse_entry_in_tx(tx, "workspace", &refusal, 12)
            })
            .unwrap();
    }
    store
        .read_with(|conn| {
            let reason: String = conn
                .query_row(
                    "SELECT terminal_reason FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                    [&entry.delivery_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(reason, refusal.reason);
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
}

#[test]
fn first_enrollment_own_draft_acceptance_keeps_each_field_edit_once() {
    let (_dir, mut store, observed, checkpoint, local) = collection_fixture();
    let history = field_history(&store);
    assert_eq!(history.len(), 2);
    assert!(history.iter().all(|row| row.3.as_deref() == Some("person")));
    let enrollment = input(&store, &observed, checkpoint);
    let enrolled = enroll(&mut store, &enrollment, &observed.limits).unwrap();
    assert!(enrolled.pending_bytes > 0);
    assert_eq!(field_history(&store), history);
    let pending =
        super::super::read_pending(&store, "workspace", enrolled.outbox_id.as_ref().unwrap())
            .unwrap();
    assert_eq!(pending.entries[0].update, bounded(&local).unwrap());
    accept_field_frame(
        &mut store,
        &observed.binding,
        pending.entries[0].update.clone(),
    );
    assert_eq!(
        field_history(&store),
        history,
        "an accepted own-draft echo must not duplicate History"
    );
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title", "status":"done"}),
    );
    super::super::acknowledge(
        &mut store,
        "workspace",
        &pending.outbox_id,
        &[super::super::OwnerDeliveryReceipt {
            delivery_id: pending.entries[0].delivery_id.clone(),
            update_digest: pending.entries[0].update_digest.clone(),
            journal_cursor: enrollment.journal_cursor + 1,
            accepting_host_epoch: 1,
        }],
    )
    .unwrap();
    assert_eq!(field_history(&store), history);
    accept_field_frame(
        &mut store,
        &observed.binding,
        local.frontmatter_set("status", "review").unwrap(),
    );
    let after = field_history(&store);
    assert_eq!(&after[..2], &history);
    assert_eq!(after.len(), 3);
    assert_eq!(
        after[2],
        (
            "status".into(),
            Some("\"done\"".into()),
            Some("\"review\"".into()),
            None
        )
    );
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title", "status":"review"}),
    );
}

#[test]
fn first_enrollment_refusal_reverts_fields_once_with_a_refusal_actor() {
    let (_dir, mut store, observed, checkpoint, _) = collection_fixture();
    let enrollment = input(&store, &observed, checkpoint.clone());
    let enrolled = enroll(&mut store, &enrollment, &observed.limits).unwrap();
    let pending =
        super::super::read_pending(&store, "workspace", enrolled.outbox_id.as_ref().unwrap())
            .unwrap();
    refuse_field_entry(&mut store, &pending.outbox_id, &pending.entries[0]);
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Original", "status":"open"}),
    );
    let history = field_history(&store);
    assert_eq!(history.len(), 4);
    assert_eq!(
        &history[2..],
        &[
            (
                "status".into(),
                Some("\"done\"".into()),
                Some("\"open\"".into()),
                Some("owner-draft-refusal".into())
            ),
            (
                "title".into(),
                Some("\"Edited title\"".into()),
                Some("\"Original\"".into()),
                Some("owner-draft-refusal".into())
            ),
        ]
    );
    let host = Ydoc::wire();
    host.apply(&checkpoint).unwrap();
    accept_field_frame(
        &mut store,
        &observed.binding,
        host.richdoc_append_paragraph("a later host frame"),
    );
    assert_eq!(
        field_history(&store),
        history,
        "a later frame must not silently repair the index"
    );
}

#[test]
fn first_enrollment_remote_checkpoint_records_only_the_remote_field_change() {
    let (_dir, mut store, observed, checkpoint, _) = collection_fixture();
    let host = Ydoc::wire();
    host.apply(&checkpoint).unwrap();
    host.frontmatter_set("priority", "high").unwrap();
    let enrollment = input(&store, &observed, bounded(&host).unwrap());
    let enrolled = enroll(&mut store, &enrollment, &observed.limits).unwrap();
    let history = field_history(&store);
    assert_eq!(history.len(), 3);
    assert_eq!(
        history[2],
        ("priority".into(), None, Some("\"high\"".into()), None)
    );
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title", "status":"done", "priority":"high"}),
    );
    let pending =
        super::super::read_pending(&store, "workspace", enrolled.outbox_id.as_ref().unwrap())
            .unwrap();
    accept_field_frame(
        &mut store,
        &observed.binding,
        pending.entries[0].update.clone(),
    );
    assert_eq!(field_history(&store), history);
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title", "status":"done", "priority":"high"}),
    );
}

#[test]
fn first_enrollment_accept_echo_preserves_later_draft_fields_until_refusal() {
    use crate::owner_outbox::draft::{append_draft_cached, OwnerDraftAppendInput};
    let (_dir, mut store, observed, checkpoint, local) = collection_fixture();
    let enrollment = input(&store, &observed, checkpoint);
    let enrolled = enroll(&mut store, &enrollment, &observed.limits).unwrap();
    let initial = bounded(&local).unwrap();
    let mut cache = crate::WriterDocCache::new();
    let input = OwnerDraftAppendInput {
        binding: observed.binding.clone(),
        expected_revision: enrolled.revision,
        append_key: "agent-status".into(),
        update: local.frontmatter_set("status", "blocked").unwrap(),
        now_ms: 11,
        agent_declaration: Some(dohc_engine_domain::AgentDeclaration {
            agent_id: "writer".into(),
            on_behalf_of: Some("person".into()),
            depth: 1,
        }),
        automation_declaration: None,
    };
    let entry = append_draft_cached(
        &mut store,
        &mut cache,
        "workspace",
        input.clone(),
        &NoFaults,
    )
    .unwrap();
    append_draft_cached(&mut store, &mut cache, "workspace", input, &NoFaults).unwrap();
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title", "status":"blocked"}),
    );
    let history = field_history(&store);
    assert_eq!(history.len(), 3);
    assert_eq!(
        history[2],
        (
            "status".into(),
            Some("\"done\"".into()),
            Some("\"blocked\"".into()),
            Some("writer".into())
        )
    );
    accept_field_frame(&mut store, &observed.binding, initial);
    assert_eq!(field_history(&store), history);
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title", "status":"blocked"}),
    );
    let host = store
        .read_with(|conn| crate::load_doc_in(conn, &key(&observed.binding).unwrap()))
        .unwrap();
    accept_field_frame(
        &mut store,
        &observed.binding,
        host.frontmatter_set("priority", "high").unwrap(),
    );
    let after_remote = field_history(&store);
    assert_eq!(&after_remote[..3], &history);
    assert_eq!(after_remote.len(), 4);
    assert_eq!(
        after_remote[3],
        ("priority".into(), None, Some("\"high\"".into()), None)
    );
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title", "status":"blocked", "priority":"high"}),
    );
    let pending = super::super::read_pending(&store, "workspace", &entry.outbox_id).unwrap();
    let later = pending
        .entries
        .iter()
        .find(|pending| pending.delivery_id == entry.delivery_id)
        .unwrap();
    refuse_field_entry(&mut store, &entry.outbox_id, later);
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title", "status":"done", "priority":"high"}),
    );
    let after_refusal = field_history(&store);
    assert_eq!(&after_refusal[..4], &after_remote);
    assert_eq!(after_refusal.len(), 5);
    assert_eq!(
        after_refusal[4],
        (
            "status".into(),
            Some("\"blocked\"".into()),
            Some("\"done\"".into()),
            Some("owner-draft-refusal".into())
        )
    );
}

#[test]
fn first_enrollment_refusal_preserves_an_independent_pending_field_edit() {
    let (_dir, mut store, observed, checkpoint, _) = collection_fixture();
    let enrollment = input(&store, &observed, checkpoint.clone());
    let enrolled = enroll(&mut store, &enrollment, &observed.limits).unwrap();
    let independent = Ydoc::wire();
    independent.apply(&checkpoint).unwrap();
    let update = independent.frontmatter_set("priority", "high").unwrap();
    store
        .write_with(&NoFaults, |tx| {
            super::super::draft::append_draft_in_tx(
                tx,
                "workspace",
                &observed.binding,
                enrolled.revision,
                "independent-priority".into(),
                update,
                11,
            )
        })
        .unwrap();
    let pending =
        super::super::read_pending(&store, "workspace", enrolled.outbox_id.as_ref().unwrap())
            .unwrap();
    assert_eq!(pending.entries.len(), 2);
    refuse_field_entry(&mut store, &pending.outbox_id, &pending.entries[0]);
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Original", "status":"open", "priority":"high"}),
    );
    let remaining = super::super::read_pending(&store, "workspace", &pending.outbox_id).unwrap();
    assert_eq!(remaining.entries.len(), 1);
    assert_eq!(
        remaining.entries[0].delivery_id,
        pending.entries[1].delivery_id
    );
    let history = field_history(&store);
    assert_eq!(history.len(), 5);
    assert_eq!(history.iter().filter(|row| row.0 == "priority").count(), 1);
    assert_eq!(
        history
            .iter()
            .filter(|row| row.3.as_deref() == Some("owner-draft-refusal"))
            .count(),
        2
    );
}

/// A host checkpoint holding another computer's edit replaces the native
/// state with changes this computer never had: one change from elsewhere.
#[test]
fn enrollment_onto_a_checkpoint_with_changes_from_elsewhere_counts_once() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    let remote = Ydoc::wire();
    remote.apply(&checkpoint).unwrap();
    remote.richdoc_append_paragraph("another computer's edit");
    let input = input(&store, &observed, bounded(&remote).unwrap());
    enroll(&mut store, &input, &observed.limits).unwrap();
    assert_eq!(remote_changes(&store), 1);
}
#[test]
fn converged_enrollment_reopens_without_pending_and_uncertain_retry_discovers_commit() {
    let (dir, mut store, observed, checkpoint) = fixture();
    let input = input(&store, &observed, checkpoint.clone());
    let result = enroll(&mut store, &input, &observed.limits).unwrap();
    assert_eq!(result.pending_bytes, 0);
    assert!(result.outbox_id.is_none());
    assert_eq!(remote_changes(&store), 0, "the host had nothing new");
    assert!(enroll(&mut store, &input, &observed.limits).is_err());
    drop(store);
    let store = EngineStore::open(&dir.join("engine.db"), 11).unwrap();
    assert!(matches!(
        store
            .read_with(|conn| prepare_in(conn, &observed.binding, "relay", false))
            .unwrap(),
        OwnerEnrollmentPreparation::Observed { .. }
    ));
    assert_eq!(
        store
            .read_with(|conn| bounded(&open_draft_in(conn, &observed.binding, 1)?.doc))
            .unwrap(),
        checkpoint
    );
}
#[test]
fn divergent_enrollment_retains_exact_local_state_and_replaces_only_accepted_native_state() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    let key = key(&observed.binding).unwrap();
    let local = Ydoc::wire();
    local.apply(&checkpoint).unwrap();
    let delta = local.richdoc_append_paragraph("private pending edit");
    store
        .write_with(&NoFaults, |tx| {
            crate::record_update_in_tx(tx, &key, &delta, None, None, 3)
        })
        .unwrap();
    let input = input(&store, &observed, checkpoint.clone());
    let local_bytes = bounded(&local).unwrap();
    let result = enroll(&mut store, &input, &observed.limits).unwrap();
    assert_eq!(result.pending_bytes, local_bytes.len() as i64);
    assert_eq!(
        remote_changes(&store),
        0,
        "only this computer's pending edit differs"
    );
    assert!(result.native_head_sequence > input.captured.native_head_sequence);
    store
        .read_with(|conn| {
            assert_eq!(
                bounded(&crate::load_doc_in(conn, &key).map_err(collab)?).unwrap(),
                checkpoint
            );
            assert_eq!(
                bounded(&open_draft_in(conn, &observed.binding, 1)?.doc).unwrap(),
                local_bytes
            );
            let digest: String = conn
                .query_row(
                    "SELECT update_digest FROM owner_ydoc_outbox_entries",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(bounded_blob(conn, &digest).unwrap(), local_bytes);
            let snapshots: i64 = conn
                .query_row(
                    "SELECT count(*) FROM ydoc_snapshots WHERE up_to_seq=0",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(snapshots, 1);
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
}
#[test]
fn bad_cut_capture_race_and_capacity_failure_leave_original_work_unchanged() {
    for failure in ["vector", "lineage", "capture", "capacity"] {
        let (_dir, mut store, observed, checkpoint) = fixture();
        let key = key(&observed.binding).unwrap();
        let local = Ydoc::wire();
        local.apply(&checkpoint).unwrap();
        let delta = local.richdoc_append_paragraph("must survive rejection");
        store
            .write_with(&NoFaults, |tx| {
                crate::record_update_in_tx(tx, &key, &delta, None, None, 3)
            })
            .unwrap();
        let mut input = input(&store, &observed, checkpoint);
        let mut limits = observed.limits.clone();
        match failure {
            "vector" => input.host_vector = vec![0],
            "lineage" => {
                let unrelated = Ydoc::wire();
                unrelated.richdoc_append_paragraph("unrelated");
                input.checkpoint = bounded(&unrelated).unwrap();
                input.host_vector = unrelated.encode_state_vector();
            }
            "capture" => input.captured.native_head_sequence += 1,
            "capacity" => limits.max_pending_bytes = 1,
            _ => unreachable!(),
        }
        assert!(enroll(&mut store, &input, &limits).is_err(), "{failure}");
        store
            .read_with(|conn| {
                assert_eq!(
                    bounded(&crate::load_doc_in(conn, &key).map_err(collab)?).unwrap(),
                    bounded(&local).unwrap()
                );
                assert!(super::super::draft::descriptor_for_key_in(conn, &key)?.is_none());
                let count: i64 = conn
                    .query_row("SELECT count(*) FROM owner_ydoc_outbox_entries", [], |r| {
                        r.get(0)
                    })
                    .unwrap();
                assert_eq!(count, 0);
                Ok::<_, OwnerOutboxError>(())
            })
            .unwrap();
    }
}

/// An enrolled owner with an unsent draft, and the host checkpoint of a later
/// restore generation that does not contain that draft.
fn enrolled_with_unsent_draft() -> (
    ScratchDir,
    EngineStore,
    ObservedOwnerBinding,
    Vec<u8>,
    Vec<u8>,
    Vec<u8>,
) {
    let (dir, mut store, observed, checkpoint) = fixture();
    let first = input(&store, &observed, checkpoint.clone());
    enroll(&mut store, &first, &observed.limits).unwrap();
    let draft = Ydoc::wire();
    draft.apply(&checkpoint).unwrap();
    let unsent = draft.richdoc_append_paragraph("unsent before restore");
    store
        .write_with(&NoFaults, |tx| {
            super::super::draft::append_draft_in_tx(
                tx,
                "workspace",
                &observed.binding,
                1,
                "unsent".into(),
                unsent.clone(),
                5,
            )
        })
        .unwrap();
    let host = Ydoc::wire();
    host.apply(&checkpoint).unwrap();
    host.richdoc_append_paragraph("restored on the host");
    (
        dir,
        store,
        observed,
        checkpoint,
        unsent,
        bounded(&host).unwrap(),
    )
}

#[test]
fn explicit_recovery_keeps_old_writes_refused_and_installs_only_the_host_checkpoint() {
    use super::super::draft::{append_draft_in_tx, write_states_in, OwnerDraftWrite};
    let (dir, mut store, observed, checkpoint, unsent, host) = enrolled_with_unsent_draft();
    let (outbox_id, sequence): (String, i64) = store.read_with(|conn| conn.query_row(
        "SELECT outbox_id,sequence FROM owner_ydoc_outbox_entries WHERE append_key='unsent'", [], |r| Ok((r.get(0)?,r.get(1)?)),
    )).unwrap();
    let write = OwnerDraftWrite {
        outbox_id: Some(outbox_id.clone()),
        binding: observed.binding.clone(),
        native_head_sequence: observed.native_head_sequence,
        append_key: "unsent".into(),
    };
    super::super::quarantine(
        &mut store,
        "workspace",
        OwnerOutboxQuarantineInput {
            outbox_id: outbox_id.clone(),
            reason: "stale-binding".into(),
            observed_binding: None,
        },
    )
    .unwrap();
    assert!(matches!(
        store
            .read_with(|conn| prepare_in(conn, &observed.binding, "relay", false))
            .unwrap(),
        OwnerEnrollmentPreparation::Observed { .. }
    ));
    let captured = match store
        .read_with(|conn| prepare_in(conn, &observed.binding, "relay", true))
        .unwrap()
    {
        OwnerEnrollmentPreparation::Capture { captured } => captured,
        _ => panic!("recovery needs a fresh authenticated cut"),
    };
    let accepted = Ydoc::wire();
    accepted.apply(&host).unwrap();
    let mut recovery = OwnerEnrollmentInput {
        binding: observed.binding.clone(),
        relay_database_namespace: "relay".into(),
        captured,
        journal_cursor: 12,
        checkpoint: host.clone(),
        host_vector: accepted.encode_state_vector(),
        recovery: true,
    };
    recovery.captured.native_head_sequence += 1;
    assert!(enroll(&mut store, &recovery, &observed.limits).is_err());
    assert_eq!(
        super::super::read_pending(&store, "workspace", &outbox_id)
            .unwrap()
            .entries
            .len(),
        1
    );
    recovery.captured.native_head_sequence -= 1;
    recovery.host_vector = vec![0];
    assert!(enroll(&mut store, &recovery, &observed.limits).is_err());
    recovery.host_vector = accepted.encode_state_vector();
    let draft = enroll(&mut store, &recovery, &observed.limits).unwrap();
    assert_eq!(draft.state.as_deref(), Some("active"));
    assert_eq!(draft.pending_bytes, 0);
    let restored = store
        .read_with(|conn| open_draft_in(conn, &observed.binding, draft.revision))
        .unwrap();
    assert_eq!(bounded(&restored.doc).unwrap(), host);
    assert_ne!(bounded(&restored.doc).unwrap(), checkpoint);
    assert_eq!(
        store
            .read_with(|conn| write_states_in(conn, "workspace", std::slice::from_ref(&write)))
            .unwrap(),
        ["not-accepted"]
    );
    let retained: (String, Vec<u8>) = store.read_with(|conn| {
        let (reason, digest): (String, String) = conn.query_row("SELECT terminal_reason,terminal_blob_digest FROM owner_ydoc_outbox_entries WHERE append_key='unsent'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        Ok::<_,OwnerOutboxError>((reason, bounded_blob(conn, &digest)?))
    }).unwrap();
    assert_eq!(retained, ("stale-binding".into(), unsent));
    let fresh = restored
        .doc
        .richdoc_append_paragraph("fresh after recovery");
    let appended = committed(
        store
            .write_with(&NoFaults, |tx| {
                append_draft_in_tx(
                    tx,
                    "workspace",
                    &observed.binding,
                    draft.revision,
                    "fresh".into(),
                    fresh,
                    13,
                )
            })
            .unwrap(),
    )
    .unwrap();
    assert!(appended.sequence > sequence);
    let pending = super::super::read_pending(&store, "workspace", &outbox_id).unwrap();
    assert_eq!(pending.entries.len(), 1);
    assert_eq!(pending.entries[0].append_key, "fresh");
    drop(store);
    let reopened = EngineStore::open(&dir.join("engine.db"), 14).unwrap();
    assert_eq!(
        reopened
            .read_with(|conn| write_states_in(conn, "workspace", &[write]))
            .unwrap(),
        ["not-accepted"]
    );
    assert!(
        enroll(
            &mut EngineStore::open(&dir.join("engine.db"), 15).unwrap(),
            &recovery,
            &observed.limits
        )
        .is_err(),
        "an active queue cannot silently reset"
    );
}

#[test]
fn recovery_rebinds_current_coordinates_without_rewriting_the_old_delivery_parent() {
    use super::super::draft::{append_draft_in_tx, write_states_in, OwnerDraftWrite};
    let (_dir, mut store, observed, _checkpoint, _unsent, host) = enrolled_with_unsent_draft();
    let old = store
        .read_with(|conn| find_parent_for_binding(conn, &observed.binding))
        .unwrap()
        .unwrap();
    super::super::quarantine(
        &mut store,
        "workspace",
        OwnerOutboxQuarantineInput {
            outbox_id: old.outbox_id.clone(),
            reason: "binding-changed".into(),
            observed_binding: None,
        },
    )
    .unwrap();
    let mut next = observed.binding.clone();
    next.current_path = "renamed.md".into();
    next.selector_paths = vec!["renamed.md".into()];
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET path='renamed.md'", [])
                .map_err(write_sql)?;
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    assert!(store
        .read_with(|conn| prepare_in(conn, &next, "other-relay", true))
        .is_err());
    let captured = match store
        .read_with(|conn| prepare_in(conn, &next, "relay", true))
        .unwrap()
    {
        OwnerEnrollmentPreparation::Capture { captured } => captured,
        _ => panic!("rebind captures"),
    };
    let accepted = Ydoc::wire();
    accepted.apply(&host).unwrap();
    let recovery = OwnerEnrollmentInput {
        binding: next.clone(),
        relay_database_namespace: "relay".into(),
        captured,
        journal_cursor: 12,
        checkpoint: host,
        host_vector: accepted.encode_state_vector(),
        recovery: true,
    };
    let draft = enroll(&mut store, &recovery, &observed.limits).unwrap();
    assert_eq!(draft.binding, next);
    assert!(draft.outbox_id.is_none());
    let old_after = store
        .read_with(|conn| read_parent(conn, &old.outbox_id))
        .unwrap()
        .unwrap();
    assert_eq!(old_after.binding, old.binding);
    assert_eq!(old_after.state, OwnerOutboxState::Quarantined);
    assert_eq!(old_after.pending_bytes, 0);
    let write = OwnerDraftWrite {
        outbox_id: Some(old.outbox_id.clone()),
        binding: observed.binding.clone(),
        native_head_sequence: observed.native_head_sequence,
        append_key: "unsent".into(),
    };
    assert_eq!(
        store
            .read_with(|conn| write_states_in(conn, "workspace", &[write]))
            .unwrap(),
        ["not-accepted"]
    );
    let doc = store
        .read_with(|conn| open_draft_in(conn, &next, draft.revision))
        .unwrap();
    let fresh = doc.doc.richdoc_append_paragraph("fresh renamed record");
    let appended = committed(
        store
            .write_with(&NoFaults, |tx| {
                append_draft_in_tx(
                    tx,
                    "workspace",
                    &next,
                    draft.revision,
                    "fresh-renamed".into(),
                    fresh,
                    13,
                )
            })
            .unwrap(),
    )
    .unwrap();
    assert_ne!(appended.outbox_id, old.outbox_id);
    assert_eq!(store.table_row_count("owner_ydoc_outboxes").unwrap(), 2);
    assert_eq!(
        super::super::read_pending(&store, "workspace", &appended.outbox_id)
            .unwrap()
            .binding,
        next
    );
    super::super::quarantine(
        &mut store,
        "workspace",
        OwnerOutboxQuarantineInput {
            outbox_id: appended.outbox_id,
            reason: "binding-changed".into(),
            observed_binding: None,
        },
    )
    .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET path='owner.md'", [])
                .map_err(write_sql)?;
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    let mut back = recovery.clone();
    back.binding = observed.binding.clone();
    back.captured = match store
        .read_with(|conn| prepare_in(conn, &back.binding, "relay", true))
        .unwrap()
    {
        OwnerEnrollmentPreparation::Capture { captured } => captured,
        _ => panic!("returning coordinates capture"),
    };
    let returned = enroll(&mut store, &back, &observed.limits).unwrap();
    assert_eq!(returned.outbox_id.as_deref(), Some(old.outbox_id.as_str()));
    assert_eq!(returned.state.as_deref(), Some("active"));
    assert_eq!(returned.pending_bytes, 0);
}

#[test]
fn recovery_permission_keeps_first_enrollment_and_active_preparation_ordinary() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    assert!(matches!(
        store
            .read_with(|conn| prepare_in(conn, &observed.binding, "relay", true))
            .unwrap(),
        OwnerEnrollmentPreparation::Capture { .. }
    ));
    let mut first = input(&store, &observed, checkpoint);
    first.recovery = true;
    let draft = enroll(&mut store, &first, &observed.limits).unwrap();
    assert!(matches!(
        store
            .read_with(|conn| prepare_in(conn, &observed.binding, "relay", true))
            .unwrap(),
        OwnerEnrollmentPreparation::Observed { .. }
    ));
    assert_eq!(draft.revision, 1);
}
fn next_generation(observed: &ObservedOwnerBinding) -> LiveObjectBinding {
    LiveObjectBinding {
        restore_fence_generation: observed.binding.restore_fence_generation + 1,
        ..observed.binding.clone()
    }
}
fn successor_input(
    store: &EngineStore,
    binding: &LiveObjectBinding,
    checkpoint: Vec<u8>,
) -> OwnerEnrollmentInput {
    let captured = match store
        .read_with(|conn| prepare_in(conn, binding, "relay", false))
        .unwrap()
    {
        OwnerEnrollmentPreparation::Capture { captured } => captured,
        OwnerEnrollmentPreparation::Observed { .. } => {
            panic!("a later restore generation captures before it commits")
        }
    };
    let host = Ydoc::wire();
    host.apply(&checkpoint).unwrap();
    OwnerEnrollmentInput {
        binding: binding.clone(),
        relay_database_namespace: "relay".into(),
        captured,
        journal_cursor: 12,
        checkpoint,
        host_vector: host.encode_state_vector(),
        recovery: false,
    }
}
fn old_generation_queue(conn: &Connection) -> (String, Option<String>, Option<String>, Vec<u8>) {
    let (state, reason, observed, digest): (String, Option<String>, Option<String>, String) = conn.query_row(
        "SELECT o.state,o.quarantine_reason,o.observed_binding_json,e.update_blob_digest FROM owner_ydoc_outboxes o JOIN owner_ydoc_outbox_entries e USING(outbox_id) WHERE o.restore_fence_generation=0 AND e.pending=1",
        [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
    (
        state,
        reason,
        observed,
        bounded_blob(conn, &digest).unwrap(),
    )
}

#[test]
fn later_restore_generation_installs_the_host_checkpoint_and_quarantines_unsent_work() {
    let (_dir, mut store, observed, checkpoint, unsent, host) = enrolled_with_unsent_draft();
    let key = key(&observed.binding).unwrap();
    let next = next_generation(&observed);
    let input = successor_input(&store, &next, host.clone());
    // Preparation only captured: the old generation is still the observed one.
    assert_eq!(
        store
            .read_with(|conn| super::super::draft::descriptor_for_key_in(conn, &key))
            .unwrap()
            .unwrap()
            .binding,
        observed.binding
    );
    let result = enroll(&mut store, &input, &observed.limits).unwrap();
    assert_eq!(
        (
            result.binding.clone(),
            result.revision,
            result.accepted_cursor
        ),
        (next.clone(), 2, 12)
    );
    assert_eq!((result.outbox_id, result.pending_bytes), (None, 0));
    store
        .read_with(|conn| {
            assert_eq!(
                bounded(&crate::load_doc_in(conn, &key).map_err(collab)?)?,
                host
            );
            assert_eq!(
                bounded(&open_draft_in(conn, &next, 2)?.doc)?,
                host,
                "the unsent draft is not merged into the restore"
            );
            let (state, reason, recorded, preserved) = old_generation_queue(conn);
            assert_eq!(
                (state.as_str(), reason.as_deref()),
                ("quarantined", Some("restore-fenced"))
            );
            assert_eq!(
                serde_json::from_str::<LiveObjectBinding>(&recorded.unwrap()).unwrap(),
                next
            );
            assert_eq!(preserved, unsent);
            assert_ne!(host, checkpoint);
            assert!(matches!(
                prepare_in(conn, &next, "relay", false)?,
                OwnerEnrollmentPreparation::Observed { .. }
            ));
            assert!(
                prepare_in(conn, &observed.binding, "relay", false).is_err(),
                "a generation never moves backwards"
            );
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    assert!(
        enroll(&mut store, &input, &observed.limits).is_err(),
        "the committed transition does not replay"
    );
}

#[test]
fn restore_generation_refuses_another_namespace_or_document_identity() {
    let (_dir, store, observed, ..) = enrolled_with_unsent_draft();
    let next = next_generation(&observed);
    let moved = LiveObjectBinding {
        current_path: "other.md".into(),
        selector_paths: vec!["other.md".into()],
        ..next.clone()
    };
    let same_generation = LiveObjectBinding {
        restore_fence_generation: observed.binding.restore_fence_generation,
        ..moved.clone()
    };
    store
        .read_with(|conn| {
            assert!(prepare_in(conn, &next, "other-relay", false).is_err());
            assert!(prepare_in(conn, &moved, "relay", false).is_err());
            assert!(prepare_in(conn, &same_generation, "relay", false).is_err());
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
}

#[test]
fn refused_restore_generation_leaves_the_old_generation_and_its_unsent_work() {
    for failure in ["vector", "capture", "cursor", "namespace"] {
        let (_dir, mut store, observed, checkpoint, unsent, host) = enrolled_with_unsent_draft();
        let key = key(&observed.binding).unwrap();
        let mut input = successor_input(&store, &next_generation(&observed), host);
        match failure {
            "vector" => input.host_vector = vec![0],
            "capture" => input.captured.native_head_sequence += 1,
            "cursor" => input.journal_cursor = 8,
            "namespace" => input.relay_database_namespace = "other-relay".into(),
            _ => unreachable!(),
        }
        assert!(
            enroll(&mut store, &input, &observed.limits).is_err(),
            "{failure}"
        );
        store
            .read_with(|conn| {
                let draft = super::super::draft::descriptor_for_key_in(conn, &key)?.unwrap();
                assert_eq!(
                    (draft.binding, draft.revision, draft.accepted_cursor),
                    (observed.binding.clone(), 1, 9)
                );
                assert_eq!(
                    bounded(&crate::load_doc_in(conn, &key).map_err(collab)?)?,
                    checkpoint
                );
                let (state, reason, _, preserved) = old_generation_queue(conn);
                assert_eq!((state.as_str(), reason), ("active", None));
                assert_eq!(preserved, unsent);
                Ok::<_, OwnerOutboxError>(())
            })
            .unwrap();
    }
}

#[test]
fn enrollment_folds_unsettled_authors_before_removing_native_update_rows() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    let key = key(&observed.binding).unwrap();
    let local = Ydoc::wire();
    local.apply(&checkpoint).unwrap();
    let delta = local.richdoc_append_paragraph("attributed private edit");
    let attribution = dohc_engine_domain::ChangeAttribution {
        actor_kind: dohc_engine_domain::ChangeActorKind::Agent,
        on_behalf_of: Some("person".into()),
        depth: 2,
        run: None,
    };
    store
        .write_with(&NoFaults, |tx| {
            crate::record_update_in_tx(tx, &key, &delta, Some("writer"), Some(&attribution), 3)
        })
        .unwrap();
    let before = store
        .read_with(|conn| crate::author_coverage::interval_in(conn, &key, i64::MAX))
        .unwrap()
        .json();
    assert!(before.contains("writer"));
    let enrollment = input(&store, &observed, checkpoint);
    let enrolled = enroll(&mut store, &enrollment, &observed.limits).unwrap();
    assert!(
        enrolled.pending_bytes > 0,
        "private content stays in its outbox"
    );
    let (rows, pending, attempt): (i64, String, Option<i64>) = store.read_with(|conn| {
        conn.query_row("SELECT (SELECT COUNT(*) FROM ydoc_updates),pending_authors_json,settle_prior_update_seq FROM ydoc_docs", [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(read_sql)
    }).unwrap();
    assert_eq!(rows, 0);
    assert_eq!(
        pending, before,
        "removed update authors remain available for settlement"
    );
    assert_eq!(attempt, None);
    let recovered = store
        .read_with(|conn| crate::author_coverage::recovery_in(conn, &key))
        .unwrap();
    assert!(
        recovered.json().contains("writer"),
        "History recovery includes the enrollment's folded authors"
    );
}
