use super::*;

#[test]
fn evidence_json_precharges_raw_columns_and_bounds_escaping_without_changing_digest_bytes() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE evidence (text_value TEXT, number_value INTEGER, absent TEXT);",
    )
    .unwrap();
    let text = format!(
        "quotes\" slashes\\ unicode🦀 {}",
        (0_u8..32).map(char::from).collect::<String>()
    );
    conn.execute(
        "INSERT INTO evidence VALUES (?1,?2,NULL)",
        params![text, i64::MIN],
    )
    .unwrap();
    let expected: String = conn
        .query_row(
            "SELECT json_array(text_value,number_value,absent) FROM evidence",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let columns = &["text_value", "number_value", "absent"];
    let mut exact = Budget {
        remaining: expected.len(),
    };
    assert_eq!(
        exact
            .sql_json_array(&conn, columns, "FROM evidence", &[])
            .unwrap(),
        expected
    );
    assert_eq!(exact.remaining, 0);
    let mut escaped_refusal = Budget {
        remaining: expected.len() - 1,
    };
    assert!(matches!(
        escaped_refusal.sql_json_array(&conn, columns, "FROM evidence", &[]),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
    let mut raw_refusal = Budget {
        remaining: text.len() - 1,
    };
    let before = raw_refusal.remaining;
    assert!(matches!(
        raw_refusal.sql_json_array(&conn, columns, "FROM evidence", &[]),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
    assert_eq!(raw_refusal.remaining, before);
}
use dohc_engine_storage::{FaultAction, FaultPoint};
use dohc_test_scratch::ScratchDir;
use serde_json::json;

fn reader_fixture() -> (Fixture, String) {
    let (bytes, source) = crate::reader_resolver::tests::original_baseline_case("valid");
    let doc = Ydoc::wire();
    doc.apply(&bytes).unwrap();
    (Fixture::with_doc(doc, &source), source)
}

fn store_restore_artifact(f: &mut Fixture, source: &str) {
    dohc_engine_domain::VersionedTextStore::new(&mut f.store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: "a.md".into(),
                text: source.into(),
                moment_id: "reader-current".into(),
                metadata_origin: "sync".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 4,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
}

fn reader_result<T>(
    mut action: impl FnMut() -> Result<T, ApplicationError>,
) -> Result<T, ApplicationError> {
    for _ in 0..5 {
        match action() {
            Err(ApplicationError::Collab(CollabError::MarkdownReaderPending(p))) => {
                crate::reader_resolver::tests::run(p.resolve())
            }
            result => return result,
        }
    }
    panic!("restore proof did not converge");
}

fn assert_refusal<T: std::fmt::Debug>(
    result: Result<T, ApplicationError>,
    operation: &NativeRestoreFence,
    case: &str,
) {
    let expected = match case {
        "binding" => NativeRestoreRefusalReason::BindingChanged,
        "no-reader" => NativeRestoreRefusalReason::ReaderUnavailable,
        "missing" | "pre-rename" => NativeRestoreRefusalReason::SourceUnavailable,
        "oversized" => NativeRestoreRefusalReason::SourceTooLarge,
        "partial" => NativeRestoreRefusalReason::IncompleteWitness,
        _ => panic!("unknown refusal case: {case}"),
    };
    let Err(ApplicationError::RestoreRefused(refusal)) = result else {
        panic!("{case}: expected an identified pre-fence refusal, got {result:?}");
    };
    assert_eq!(refusal.operation, *operation);
    assert_eq!(refusal.reason, expected);
}

fn watch_fence_writes(f: &Fixture) -> Arc<[std::sync::atomic::AtomicUsize; 3]> {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let writes = Arc::new([
        AtomicUsize::new(0),
        AtomicUsize::new(0),
        AtomicUsize::new(0),
    ]);
    let seen = writes.clone();
    f.store
        .read_with(|conn| {
            conn.authorizer(Some(move |context: AuthContext<'_>| {
                if matches!(
                    context.action,
                    AuthAction::Insert {
                        table_name: "live_restore_fences"
                    }
                ) {
                    seen[0].fetch_add(1, Ordering::SeqCst);
                }
                if matches!(
                    context.action,
                    AuthAction::Insert {
                        table_name: "live_restore_refusals"
                    }
                ) {
                    seen[1].fetch_add(1, Ordering::SeqCst);
                }
                if let AuthAction::Insert { table_name }
                | AuthAction::Update { table_name, .. }
                | AuthAction::Delete { table_name } = context.action
                {
                    if table_name != "live_restore_refusals" {
                        seen[2].fetch_add(1, Ordering::SeqCst);
                    }
                }
                Authorization::Allow
            }))
        })
        .unwrap();
    writes
}

fn stop_watching_fence_writes(
    f: &Fixture,
    writes: &[std::sync::atomic::AtomicUsize; 3],
    refusals: usize,
) {
    use rusqlite::hooks::{AuthContext, Authorization};
    f.store
        .read_with(|conn| conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>))
        .unwrap();
    assert_eq!(
        writes[0].load(std::sync::atomic::Ordering::SeqCst),
        0,
        "a pre-fence refusal must precede even a rolled-back fence write"
    );
    assert_eq!(
        writes[1].load(std::sync::atomic::Ordering::SeqCst),
        refusals
    );
    assert_eq!(
        writes[2].load(std::sync::atomic::Ordering::SeqCst),
        0,
        "a refusal changes no other table"
    );
}

#[test]
fn binding_refusal_precedes_all_writes_and_saved_fences_stay_retryable() {
    for committed in [false, true] {
        let mut f = Fixture::new("original\n");
        let operation = f.fence_input();
        let saved = committed.then(|| f.freeze(f.baseline_point.clone()).fence);
        if !committed {
            damage(
                &f,
                "UPDATE live_device_application_bindings SET available=0",
            );
        }
        let before = binding_state(&f);
        let bytes = f.canonical().encode_full_state();
        let writes = watch_fence_writes(&f);
        let result = f.owner.fence_restore(
            &mut f.store,
            None,
            operation.clone(),
            f.host.clone(),
            90,
            &NoFaults,
        );
        stop_watching_fence_writes(&f, &writes, usize::from(!committed));
        if let Some(saved) = saved {
            assert_eq!(result.unwrap(), saved);
        } else {
            assert_refusal(result, &operation, "binding");
            assert_saved_refusal(&mut f, &operation, "binding");
        }
        assert_eq!(binding_state(&f), before);
        assert_eq!(f.canonical().encode_full_state(), bytes);
        assert_eq!(
            f.store.table_row_count("live_restore_fences").unwrap(),
            i64::from(committed)
        );
    }
}

#[test]
fn durable_refusal_survives_crashes_before_commit_and_before_ack() {
    for (fault, committed) in [
        (FaultPoint::StorageBeforePersist, false),
        (FaultPoint::StorageAfterCommitBeforeAck, true),
    ] {
        let mut f = Fixture::new("original\n");
        let operation = f.fence_input();
        damage(
            &f,
            "UPDATE live_device_application_bindings SET available=0",
        );
        let result = f.owner.fence_restore(
            &mut f.store,
            None,
            operation.clone(),
            f.host.clone(),
            90,
            &CrashAt(fault),
        );
        assert!(
            matches!(result, Err(ApplicationError::Interrupted)),
            "{result:?}"
        );
        f.store = EngineStore::open(&f.dir.join("engine.db"), 100).unwrap();
        f.owner = ApplicationOwner::new("workspace".into()).unwrap();
        assert_eq!(
            f.store.table_row_count("live_restore_refusals").unwrap(),
            i64::from(committed)
        );
        let result = f.owner.fence_restore_after_reconnect(
            &mut f.store,
            None,
            operation.clone(),
            f.host.clone(),
            190,
            &NoFaults,
        );
        let Err(ApplicationError::RestoreRefused(receipt)) = result else {
            panic!("{result:?}");
        };
        assert_eq!(receipt.recorded_at_ms, if committed { 90 } else { 190 });
        assert_eq!(f.store.table_row_count("live_restore_refusals").unwrap(), 1);
        assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 0);
    }
}

#[test]
fn fence_conflicts_and_operation_collisions_are_not_typed_refusals() {
    let mut f = Fixture::new("original\n");
    let mut invalid_cut = f.fence_input();
    invalid_cut.applied_sequence += 1;
    assert!(matches!(
        f.owner.fence_restore(
            &mut f.store,
            None,
            invalid_cut,
            f.host.clone(),
            50,
            &NoFaults
        ),
        Err(ApplicationError::Conflict)
    ));
    let saved = f.freeze(f.baseline_point.clone()).fence;
    let mut collision = saved.operation.clone();
    collision.point.receipt_digest = "f".repeat(64);
    assert!(matches!(
        f.owner
            .fence_restore(&mut f.store, None, collision, f.host.clone(), 51, &NoFaults),
        Err(ApplicationError::Conflict)
    ));
    let mut another_document = saved.operation.clone();
    another_document.old_binding.object_id = "another-document".into();
    assert!(matches!(
        f.owner.fence_restore(
            &mut f.store,
            None,
            another_document,
            f.host.clone(),
            51,
            &NoFaults
        ),
        Err(ApplicationError::Conflict)
    ));
    assert_eq!(
        f.owner
            .fence_restore(
                &mut f.store,
                None,
                saved.operation.clone(),
                f.host.clone(),
                52,
                &NoFaults
            )
            .unwrap(),
        saved
    );
}

fn impossible_prefix_refuses_before_fencing(case: &str) {
    let (mut reader, source) = reader_fixture();
    let mut f = Fixture::new("native original\n");
    let edit = f
        .doc
        .rewrite_richdoc_preserving_source_bounded(&source, &reader.doc, 2_000_000, Some(2123456))
        .unwrap();
    f.accept(edit, 3);
    store_restore_artifact(&mut f, &source);
    f.resolver = reader.resolver.take();
    match case {
        "partial" => {
            use yrs::{Map, Transact, ReadTxn, updates::decoder::Decode};
            let raw = yrs::Doc::with_options(yrs::Options { client_id: yrs::ClientID::new(333333), skip_gc: true, ..Default::default() });
            raw.transact_mut().apply_update(yrs::Update::decode_v1(&f.doc.encode_full_state()).unwrap()).unwrap();
            let before = raw.transact().state_vector();
            raw.get_or_insert_map("meta").remove(&mut raw.transact_mut(), "dohcMarkdownSource");
            let delta = raw.transact().encode_state_as_update_v1(&before);
            f.doc.apply(&delta).unwrap(); f.accept(delta, 4);
        },
        "no-reader" => f.resolver = None,
        "missing" => damage(&f, "DELETE FROM moments"),
        "pre-rename" => damage(&f, "UPDATE moments SET path='old.md'"),
        "oversized" => damage(&f, "UPDATE blobs SET byte_length=3000000 WHERE sha256=(SELECT blob_sha256 FROM snapshots WHERE object_id='object')"),
        _ => unreachable!(),
    }
    let before: String = f.store.read_with(|conn| conn.query_row(
        "SELECT json_array(current_path,lineage_claim_id,available,restore_fence_generation,host_id,host_epoch,instance_id,connection_id,selector_paths_json) FROM live_device_application_bindings", [], |row| row.get(0))).unwrap();
    let input = f.fence_input();
    let expected_operation = input.clone();
    let writes = watch_fence_writes(&f);
    let result = f.owner.fence_restore(
        &mut f.store,
        f.resolver.as_ref(),
        input,
        f.host.clone(),
        50,
        &NoFaults,
    );
    assert_refusal(result, &expected_operation, case);
    stop_watching_fence_writes(&f, &writes, 1);
    assert_eq!(
        f.store.table_row_count("live_restore_fences").unwrap(),
        0,
        "{case}"
    );
    let after: String = f.store.read_with(|conn| conn.query_row(
        "SELECT json_array(current_path,lineage_claim_id,available,restore_fence_generation,host_id,host_epoch,instance_id,connection_id,selector_paths_json) FROM live_device_application_bindings", [], |row| row.get(0))).unwrap();
    assert_eq!(before, after, "{case}");
    assert_saved_refusal(&mut f, &expected_operation, case);
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_restore_no_reader_prefix_refuses_before_fencing() {
    impossible_prefix_refuses_before_fencing("no-reader");
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_restore_missing_prefix_refuses_before_fencing() {
    impossible_prefix_refuses_before_fencing("missing");
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_restore_pre_rename_prefix_refuses_before_fencing() {
    impossible_prefix_refuses_before_fencing("pre-rename");
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_restore_oversized_prefix_refuses_before_fencing() {
    impossible_prefix_refuses_before_fencing("oversized");
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_restore_settlement_retries_a_verdict_evicted_between_transactions() {
    let (mut f, _) = reader_fixture();
    let prep = f.freeze(f.baseline_point.clone());
    let input = admitted_restore(&mut f, prep);
    reader_result(|| apply_restore(&mut f, input.clone(), &NoFaults)).unwrap();
    reader_result(|| {
        f.owner.with_restore_settlement(
            &mut f.store,
            f.resolver.as_ref(),
            input.clone(),
            f.host.clone(),
            2_000_000,
            100,
            |_, _| Ok::<_, ApplicationError>(()),
        )
    })
    .unwrap();
    let resolver = f.resolver.clone().unwrap();
    let mut evicted = false;
    let result = f.owner.with_restore_settlement(
        &mut f.store,
        f.resolver.as_ref(),
        input.clone(),
        f.host.clone(),
        2_000_000,
        100,
        |store, audit| {
            crate::reader_resolver::tests::evict_with_other_snapshot_misses(&resolver);
            evicted = true;
            record_test_projection(store, audit, "after-eviction")
        },
    );
    assert!(evicted, "the miss must occur after capturing the audit");
    let Err(ApplicationError::Collab(CollabError::MarkdownReaderPending(pending))) = result else {
        panic!("settlement must preserve the retryable reader miss: {result:?}");
    };
    crate::reader_resolver::tests::run(pending.resolve());
    reader_result(|| {
        f.owner.with_restore_settlement(
            &mut f.store,
            f.resolver.as_ref(),
            input.clone(),
            f.host.clone(),
            2_000_000,
            100,
            |store, audit| record_test_projection(store, audit, "after-eviction"),
        )
    })
    .unwrap();
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_restore_prepares_against_selected_history_without_changing_the_live_doc() {
    let (mut f, source) = reader_fixture();
    let edit = f.doc.richdoc_append_paragraph("later accepted body");
    f.accept(edit, 3);
    let input = f.freeze(f.baseline_point.clone());
    let before = f.canonical().canonical_content_sha256();
    let before_vector = f.canonical().encode_state_vector();
    let proposal = reader_result(|| f.prepare(input.clone())).unwrap();
    if let Ok(path) = std::env::var("DOHC_RESTORE_FIXTURE") {
        let mut value = serde_json::to_value(&proposal).unwrap();
        value["source"] = json!(source);
        value["acceptedCheckpoint"] = json!(f.canonical().encode_full_state());
        std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    assert_eq!(
        proposal.receipt().point.markdown_digest,
        hex_sha256(source.as_bytes())
    );
    assert_eq!(f.canonical().canonical_content_sha256(), before);
    assert_eq!(f.canonical().encode_state_vector(), before_vector);
    let restored = Ydoc::wire();
    restored.apply(proposal.frozen_state_bytes()).unwrap();
    restored.apply(proposal.candidate_bytes()).unwrap();
    assert!(restored.has_reader_source());
    assert_eq!(restored.project(ContentKind::Richdoc).unwrap().content, {
        let p = Ydoc::wire();
        p.apply(proposal.point_state_bytes()).unwrap();
        p.project(ContentKind::Richdoc).unwrap().content
    });
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_restore_source_proofs_refuse_forged_partial_and_stale_witnesses() {
    let (mut f, _) = reader_fixture();
    let input = f.freeze(f.baseline_point.clone());
    let held = f.handle.registration.lock().unwrap();
    for case in ["valid", "forged", "partial", "stale"] {
        let (bytes, _) = crate::reader_resolver::tests::original_baseline_case(case);
        let doc = Ydoc::wire();
        doc.apply(&bytes).unwrap();
        let canonical = doc.project(ContentKind::Richdoc).unwrap().content;
        let result = reader_result(|| {
            f.store.read_with(|conn| {
                point_source(
                    conn,
                    &held,
                    &doc,
                    &canonical,
                    &input,
                    f.resolver.as_deref(),
                    &mut Budget {
                        remaining: 2_000_000,
                    },
                )
            })
        });
        assert_eq!(result.is_ok(), case == "valid", "{case}: {result:?}");
    }
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_restore_rechecks_authority_and_artifact_after_a_cached_proof() {
    for case in [
        "binding",
        "claim",
        "fence",
        "missing",
        "self-anchor",
        "reader-unavailable",
    ] {
        let (mut f, source) = reader_fixture();
        let input = f.freeze(f.baseline_point.clone());
        reader_result(|| f.prepare(input.clone())).unwrap();
        match case {
            "binding" => damage(
                &f,
                "UPDATE live_device_application_bindings SET host_id='replacement'",
            ),
            "claim" => damage(
                &f,
                "UPDATE ydoc_docs SET lineage_claim_id=printf('%064d',0)",
            ),
            "fence" => damage(
                &f,
                "UPDATE live_restore_fences SET input_json=json_set(input_json,'$.newFence',new_generation+1)",
            ),
            "missing" => damage(&f, "DELETE FROM moments"),
            "self-anchor" => {
                damage(
                    &f,
                    "UPDATE moments SET object_id='foreign-object'; DELETE FROM snapshots",
                );
                assert_eq!(
                    f.doc
                        .markdown_source(&f.doc.markdown_source_reference().unwrap())
                        .as_deref(),
                    Some(source.as_str())
                );
                assert_eq!(f.store.table_row_count("moments").unwrap(), 2);
            }
            "reader-unavailable" => f.resolver = None,
            _ => unreachable!(),
        }
        let before = f.canonical().canonical_content_sha256();
        let error = f.prepare(input.clone()).unwrap_err();
        assert!(
            matches!(
                (&error, case),
                (ApplicationError::Conflict, "binding" | "claim" | "fence")
                    | (
                        ApplicationError::Collab(CollabError::MarkdownReaderUnavailable),
                        "missing" | "self-anchor" | "reader-unavailable"
                    )
            ),
            "{case}: {error:?}"
        );
        assert_eq!(f.canonical().canonical_content_sha256(), before, "{case}");
        assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 1);
    }
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_restore_applies_settles_and_resumes_in_both_directions() {
    for direction in [
        "reader-to-reader",
        "native-to-reader",
        "reader-to-native",
        "reader-to-native-settled",
        "expired-to-native",
        "expired-to-fresh",
        "expired-to-expired",
    ] {
        let (bytes, source) = crate::reader_resolver::tests::original_baseline_case("valid");
        let reader_point = Ydoc::wire();
        reader_point.apply(&bytes).unwrap();
        let mut f = if direction.starts_with("reader-to-native") {
            Fixture::new("native original\n")
        } else {
            Fixture::with_doc(reader_point, &source)
        };
        let expected_reader = !direction.starts_with("reader-to-native");
        let target = if direction.starts_with("expired-") {
            let edit = f.doc.richdoc_append_paragraph("expired selected point");
            f.accept(edit, 2)
        } else {
            f.baseline_point.clone()
        };
        let expected = if direction.starts_with("expired-") {
            f.doc.project(ContentKind::Richdoc).unwrap().content
        } else if expected_reader {
            source.clone()
        } else {
            "native original\n".into()
        };
        let (next, markdown) = if direction.starts_with("reader-to-native") {
            let doc = Ydoc::wire();
            doc.apply(&bytes).unwrap();
            (doc, source.clone())
        } else {
            let doc = Ydoc::wire();
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, "later native\n")
                .unwrap();
            (doc, "later native\n".into())
        };
        let edit = if direction == "expired-to-fresh" {
            let fresh = Ydoc::wire();
            fresh.apply(&bytes).unwrap();
            f.doc
                .rewrite_richdoc_preserving_source_bounded(
                    &source,
                    &fresh,
                    2_000_000,
                    Some(2123456),
                )
                .unwrap()
        } else if direction == "reader-to-reader" || direction == "expired-to-expired" {
            f.doc.richdoc_append_paragraph("later reader edit")
        } else {
            f.doc
                .rewrite_richdoc_preserving_source_bounded(
                    &markdown,
                    &next,
                    2_000_000,
                    Some(2123456),
                )
                .unwrap()
        };
        f.accept(edit, 3);
        if direction.starts_with("reader-to-native") {
            store_restore_artifact(&mut f, &source);
            let config =
                serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
            f.resolver = Some(Arc::new(crate::reader_resolver::ReaderResolver::new(
                Arc::new(dohc_engine_reader::Reader::new(Some(config))),
            )));
        }
        if direction == "reader-to-native-settled" {
            let edit = f.doc.richdoc_append_paragraph("settled body edit");
            f.accept(edit, 4);
            let canonical = f.doc.project(ContentKind::Richdoc).unwrap().content;
            let digest = hex_sha256(canonical.as_bytes());
            f.store
                .write_with(&NoFaults, |tx| -> Result<(), ApplicationError> {
                    dohc_engine_storage::text::insert(
                        tx,
                        &digest,
                        canonical.len() as i64,
                        &canonical,
                        true,
                    )
                    .map_err(write_sql)?;
                    tx.execute(
                        "UPDATE snapshots SET blob_sha256=?1 WHERE object_id='object'",
                        [&digest],
                    )
                    .map_err(write_sql)?;
                    tx.execute(
                        "UPDATE ydoc_docs SET last_settled_sha=?1 WHERE object_id='object'",
                        [&digest],
                    )
                    .map_err(write_sql)?;
                    Ok(())
                })
                .unwrap();
        }
        let prep = f.freeze(target);
        let input = admitted_restore(&mut f, prep.clone());
        if let Ok(dir) = std::env::var("DOHC_RESTORE_DIRECTION_FIXTURES") {
            let proposal = reader_result(|| f.prepare(prep.clone())).unwrap();
            let mut value = serde_json::to_value(&proposal).unwrap();
            value["source"] = json!(source);
            value["restoredMarkdown"] = json!(expected);
            value["acceptedCheckpoint"] = json!(f.canonical().encode_full_state());
            std::fs::write(
                std::path::Path::new(&dir).join(format!("{direction}.json")),
                serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
        }
        let before = f.canonical().encode_full_state();
        let receipt = reader_result(|| apply_restore(&mut f, input.clone(), &NoFaults)).unwrap();
        assert_ne!(before, f.canonical().encode_full_state());
        assert_eq!(
            receipt,
            reader_result(|| apply_restore(&mut f, input.clone(), &NoFaults)).unwrap()
        );
        let settled = reader_result(|| {
            f.owner.with_restore_settlement(
                &mut f.store,
                f.resolver.as_ref(),
                input.clone(),
                f.host.clone(),
                2_000_000,
                100,
                |store, audit| record_test_projection(store, audit, "reader-restored"),
            )
        })
        .unwrap();
        assert_eq!(
            settled.markdown_digest,
            hex_sha256(expected.as_bytes()),
            "{direction}"
        );
        let resume = NativeRestoreResume {
            application: input,
            settlement_id: settled.settlement_id,
        };
        // A fresh resolver has no persisted verdict, including after settlement.
        let config =
            serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
        f.resolver = Some(Arc::new(crate::reader_resolver::ReaderResolver::new(
            Arc::new(dohc_engine_reader::Reader::new(Some(config))),
        )));
        let resumed = reader_result(|| {
            f.owner.resume_restore(
                &mut f.store,
                f.resolver.as_ref(),
                resume.clone(),
                f.host.clone(),
                2_000_000,
                100,
                100,
                &NoFaults,
                |_, _, _, _| Ok(()),
            )
        })
        .unwrap();
        assert_eq!(resumed.binding.restore_fence_generation, 1);
        assert_eq!(
            f.canonical().has_reader_source(),
            expected_reader,
            "{direction}"
        );
    }
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_restore_application_settlement_and_resume_recheck_authority() {
    for stage in ["application", "settlement", "resume"] {
        for case in [
            "binding",
            "claim",
            "fence",
            "missing",
            "self-anchor",
            "reader-unavailable",
        ] {
            let (mut f, source) = reader_fixture();
            let prep = f.freeze(f.baseline_point.clone());
            let input = admitted_restore(&mut f, prep);
            let mut settlement_id = String::new();
            if stage != "application" {
                reader_result(|| apply_restore(&mut f, input.clone(), &NoFaults)).unwrap();
            }
            if stage == "resume" {
                settlement_id = reader_result(|| {
                    f.owner.with_restore_settlement(
                        &mut f.store,
                        f.resolver.as_ref(),
                        input.clone(),
                        f.host.clone(),
                        2_000_000,
                        100,
                        |store, audit| record_test_projection(store, audit, "reader-restored"),
                    )
                })
                .unwrap()
                .settlement_id;
            }
            match case {
                "binding" => damage(&f,"UPDATE live_device_application_bindings SET host_id='replacement'"),
                "claim" => damage(&f,"UPDATE ydoc_docs SET lineage_claim_id=printf('%064d',0)"),
                "fence" => damage(&f,"UPDATE live_restore_fences SET input_json=json_set(input_json,'$.newFence',new_generation+1)"),
                "missing" => damage(&f,"DELETE FROM moments"),
                "self-anchor" => {
                    damage(&f,"UPDATE moments SET object_id='foreign-object'; DELETE FROM snapshots");
                    assert_eq!(f.doc.markdown_source(&f.doc.markdown_source_reference().unwrap()).as_deref(),Some(source.as_str()));
                }
                "reader-unavailable" => f.resolver = None,
                _ => unreachable!(),
            }
            let before = f.canonical().canonical_content_sha256();
            let result = match stage {
                "application" => {
                    reader_result(|| apply_restore(&mut f, input.clone(), &NoFaults)).map(|_| ())
                }
                "settlement" => reader_result(|| {
                    f.owner.with_restore_settlement(
                        &mut f.store,
                        f.resolver.as_ref(),
                        input.clone(),
                        f.host.clone(),
                        2_000_000,
                        100,
                        |store, audit| record_test_projection(store, audit, "reader-restored"),
                    )
                })
                .map(|_| ()),
                _ => reader_result(|| {
                    f.owner.resume_restore(
                        &mut f.store,
                        f.resolver.as_ref(),
                        NativeRestoreResume {
                            application: input.clone(),
                            settlement_id: settlement_id.clone(),
                        },
                        f.host.clone(),
                        2_000_000,
                        100,
                        100,
                        &NoFaults,
                        |_, _, _, _| Ok(()),
                    )
                })
                .map(|_| ()),
            };
            let error = result.unwrap_err();
            assert!(
                matches!(
                    (&error, case),
                    (ApplicationError::Conflict, "binding" | "claim" | "fence")
                        | (
                            ApplicationError::Collab(CollabError::MarkdownReaderUnavailable),
                            "missing" | "self-anchor" | "reader-unavailable"
                        )
                ),
                "{stage} {case}: {error:?}"
            );
            assert_eq!(
                f.canonical().canonical_content_sha256(),
                before,
                "{stage} {case}"
            );
        }
    }
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_restore_source_rechecks_its_fence_and_budget_before_a_cached_verdict() {
    let (mut f, source) = reader_fixture();
    let input = f.freeze(f.baseline_point.clone());
    let held = f.handle.registration.lock().unwrap();
    let canonical = f.doc.project(ContentKind::Richdoc).unwrap().content;
    let prove = |limit| {
        f.store.read_with(|conn| {
            point_source(
                conn,
                &held,
                &f.doc,
                &canonical,
                &input,
                f.resolver.as_deref(),
                &mut Budget { remaining: limit },
            )
        })
    };
    assert!(matches!(
        prove(source.len() - 1),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
    damage(&f,"UPDATE live_restore_fences SET input_json=json_set(input_json,'$.newFence',new_generation+1)");
    assert!(matches!(
        prove(2_000_000),
        Err(ApplicationError::Collab(CollabError::RestoreFenced))
    ));
}

#[test]
fn restore_serialized_byte_refusals_keep_the_configured_budget_error() {
    assert!(matches!(
        Budget { remaining: 1 }.json(&"retained metadata"),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
    let doc = Ydoc::wire();
    doc.plaintext_insert(0, "retained state");
    assert!(matches!(
        Budget { remaining: 1 }.state(&doc),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
    let f = Fixture::new("valid rich document");
    let error = f
        .doc
        .rewrite_richdoc_preserving_source_bounded("valid replacement", &f.doc, 1, None)
        .unwrap_err();
    assert!(matches!(
        ApplicationError::from(error),
        ApplicationError::ConfiguredByteBudgetExceeded
    ));
}

#[test]
fn empty_bootstrap_outbox_does_not_require_owner_adoption() {
    let mut f = Fixture::new("baseline");
    let b = &f.binding;
    let outbox =
        crate::owner_outbox::outbox_id(b, &b.lineage_claim_id, &serde_json::to_string(b).unwrap());
    f.store.write_with(&NoFaults,|tx| -> Result<(),ApplicationError> {
        tx.execute("INSERT INTO owner_ydoc_outboxes (outbox_id,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,base_update_digest,base_blob_digest,base_byte_length,state,pending_bytes,oldest_entry_at_ms,next_sequence,quarantine_reason,observed_binding_json,created_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?5,?5,?9,'active',0,NULL,1,NULL,NULL,0)",
            params![outbox,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id,b.current_path,serde_json::to_string(&b.selector_paths).unwrap(),b.restore_fence_generation,f.doc.encode_full_state().len() as i64]).map_err(write_sql)?;
        Ok(())
    }).unwrap();
    let input = f.freeze(f.baseline_point.clone());
    let proposal = f.prepare(input).unwrap();
    assert!(proposal.receipt().native_sources.is_empty());
}

fn append_history_copies(f: &mut Fixture, copies: i64, bytes: Vec<u8>) -> Vec<LiveUpdateReceipt> {
    let held = f.handle.registration.lock().unwrap();
    let outcome = f
        .store
        .write_with(&NoFaults, |tx| -> Result<_, ApplicationError> {
            let start: i64 = tx
                .query_row(
                    "SELECT coalesce(max(event_count),0) FROM live_accepted_updates",
                    [],
                    |r| r.get(0),
                )
                .map_err(read_sql)?;
            let mut receipts = Vec::new();
            for ordinal in start + 1..=start + copies {
                let receipt = LiveUpdateReceipt {
                    delivery_id: format!("history-{ordinal}"),
                    update_digest: hex_sha256(&bytes),
                    journal_cursor: ordinal * 3,
                    accepting_host_epoch: 1,
                };
                let event = AdmittedLiveUpdate {
                    metadata: AdmittedLiveUpdateMetadata {
                        accepted: RelayAcceptedLiveUpdate {
                            receipt: receipt.clone(),
                            binding: f.binding.clone(),
                            authority: ServerDerivedLiveUpdateAuthority::Owner {
                                principal_id: "owner".into(),
                            },
                            received_at_ms: ordinal,
                        },
                        first_seen: vec![],
                        canonical_version: Some(2),
                        author_snapshot: Some(vec![]),
                        first_seen_deletes: Some(vec![]),
                        checkpoint_coverage: None,
                    },
                    update_bytes: bytes.clone(),
                };
                event.validate()?;
                accepted_history::append_native(tx, &held, &event, 100_000_000)?;
                if f.sequence > 0 {
                    insert_application(tx, &held, &event, f.sequence)?;
                }
                receipts.push(receipt);
            }
            Ok(receipts)
        })
        .unwrap();
    let TxnOutcome::Committed(receipts) = outcome else {
        panic!("history append interrupted")
    };
    receipts
}

#[test]
fn accepted_history_checkpoints_bound_lifetime_replay_and_keep_old_delivery_identity() {
    let mut f = Fixture::new("accepted history");
    let bytes = f.doc.encode_full_state();
    let receipts = append_history_copies(&mut f, 4098, bytes);
    let held = f.handle.registration.lock().unwrap();
    f.store
        .read_with(|conn| -> Result<(), ApplicationError> {
            let mut budget = Budget {
                remaining: 1_000_000,
            };
            let history =
                accepted_history::read(conn, &held, receipts[4097].journal_cursor, &mut budget, 3)?;
            assert_eq!(history.proof.checkpoint.event_count, 4095);
            assert_eq!(
                history.proof.checkpoint.terminal,
                Some(receipts[4094].clone())
            );
            assert_eq!(history.proof.event_count, 4098);
            assert_eq!(history.proof.suffix.len(), 3);
            assert!(crate::replay_parity::structurally_equal_v2(
                &history.doc,
                &f.doc
            )?);
            let old = accepted_history::accepted_source(
                conn,
                &held,
                &receipts[0].delivery_id,
                &mut budget,
            )?
            .unwrap();
            assert_eq!(old.accepted.receipt, receipts[0]);
            assert!(
                accepted_history::accepted_source(conn, &held, "never-accepted", &mut budget)?
                    .is_none()
            );
            assert!(accepted_history::read(
                conn,
                &held,
                receipts[4097].journal_cursor,
                &mut Budget {
                    remaining: 1_000_000
                },
                2
            )
            .is_err());
            assert!(accepted_history::read(
                conn,
                &held,
                receipts[4097].journal_cursor - 1,
                &mut Budget {
                    remaining: 1_000_000
                },
                3
            )
            .is_err());
            assert!(accepted_history::read(
                conn,
                &held,
                receipts[4097].journal_cursor,
                &mut Budget { remaining: 1 },
                3
            )
            .is_err());
            // A historical selection and its evidence are independent of the latest checkpoint.
            let point = accepted_history::read(
                conn,
                &held,
                receipts[1].journal_cursor,
                &mut Budget {
                    remaining: 1_000_000,
                },
                2,
            )?;
            assert_eq!(point.proof.event_count, 2);
            assert_eq!(point.proof.checkpoint.event_count, 0);
            Ok(())
        })
        .unwrap();
    for sql in [
        "UPDATE live_accepted_checkpoints SET terminal_json=json_set(terminal_json,'$.deliveryId','forged') WHERE event_count=4095",
        "UPDATE live_accepted_checkpoints SET evidence_digest=printf('%064d',0) WHERE event_count=4095",
        "UPDATE live_accepted_updates SET suffix_count=1 WHERE event_count=4095",
        "UPDATE live_accepted_updates SET metadata_json=json_set(metadata_json,'$.accepted.receivedAtMs',999) WHERE event_count=4098",
        "UPDATE live_device_bootstraps SET bootstrap_moment_id='changed-origin'",
        "DELETE FROM live_accepted_checkpoints WHERE event_count=4095",
    ] {
        f.store
            .write_with(&NoFaults, |tx| -> Result<(), ApplicationError> {
                tx.execute_batch("SAVEPOINT damage").map_err(write_sql)?;
                tx.execute(sql, []).map_err(write_sql)?;
                assert!(
                    accepted_history::read(
                        tx,
                        &held,
                        receipts[4097].journal_cursor,
                        &mut Budget {
                            remaining: 1_000_000
                        },
                        3
                    )
                    .is_err(),
                    "{sql}"
                );
                tx.execute_batch("ROLLBACK TO damage; RELEASE damage")
                    .map_err(write_sql)?;
                Ok(())
            })
            .unwrap();
    }
    for sql in [
        "UPDATE live_accepted_updates SET metadata_json=json_set(metadata_json,'$.accepted.receivedAtMs',999) WHERE event_count=1",
        "UPDATE live_accepted_updates SET evidence_digest=printf('%064d',0) WHERE event_count=1",
    ] {
        f.store
            .write_with(&NoFaults, |tx| -> Result<(), ApplicationError> {
                tx.execute_batch("SAVEPOINT old_source_damage")
                    .map_err(write_sql)?;
                tx.execute(sql, []).map_err(write_sql)?;
                assert!(
                    accepted_history::accepted_source(
                        tx,
                        &held,
                        &receipts[0].delivery_id,
                        &mut Budget {
                            remaining: 1_000_000
                        }
                    )
                    .is_err(),
                    "{sql}"
                );
                tx.execute_batch("ROLLBACK TO old_source_damage; RELEASE old_source_damage")
                    .map_err(write_sql)?;
                Ok(())
            })
            .unwrap();
    }
}

#[test]
fn deleted_yjs_payload_survives_accepted_checkpoint_and_restore_preparation() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/lossless-fixtures/deleted-history.json"
    ))
    .unwrap();
    let updates: Vec<Vec<u8>> = serde_json::from_value(fixture["updates"].clone()).unwrap();
    let expected: Vec<u8> = serde_json::from_value(fixture["retainedState"].clone()).unwrap();
    let doc = Ydoc::wire();
    doc.apply(&updates[0]).unwrap();
    let source = doc.project(ContentKind::Richdoc).unwrap().content;
    let mut f = Fixture::with_doc(doc, &source);
    for (index, update) in updates.iter().enumerate().skip(1) {
        f.doc.apply(update).unwrap();
        f.accept(update.clone(), index as i64);
    }
    assert_eq!(f.canonical().encode_full_state(), expected);
    let receipts = append_history_copies(&mut f, 4093, updates.last().unwrap().clone());
    f.terminal = receipts.last().cloned();
    drop(f.store);
    f.store = EngineStore::open(&f.dir.join("engine.db"), 100).unwrap();
    {
        let held = f.handle.registration.lock().unwrap();
        f.store
            .read_with(|conn| -> Result<(), ApplicationError> {
                let history = accepted_history::read(
                    conn,
                    &held,
                    f.terminal.as_ref().unwrap().journal_cursor,
                    &mut Budget {
                        remaining: 1_000_000,
                    },
                    0,
                )?;
                assert_eq!(history.proof.checkpoint.event_count, 4095);
                assert!(history.proof.suffix.is_empty());
                assert_eq!(history.doc.encode_full_state(), expected);
                assert_eq!(
                    crate::durable::binary_blob_for_gate(
                        conn,
                        &history.proof.checkpoint.state_digest
                    )?,
                    expected
                );
                assert!(matches!(
                    Budget {
                        remaining: expected.len() - 1
                    }
                    .state(&history.doc),
                    Err(ApplicationError::ConfiguredByteBudgetExceeded)
                ));
                Ok(())
            })
            .unwrap();
    }
    let input = f.freeze(f.baseline_point.clone());
    let proposal = f.prepare(input.clone()).unwrap();
    assert_eq!(proposal.frozen_state_bytes, expected);
    drop(f.store);
    f.store = EngineStore::open(&f.dir.join("engine.db"), 101).unwrap();
    let retried = f.prepare(input).unwrap();
    assert_eq!(retried.frozen_state_bytes, expected);
    assert_eq!(retried.receipt(), proposal.receipt());
}

#[test]
fn restore_preparation_uses_native_checkpoints_for_a_long_applied_history() {
    let mut f = Fixture::new("baseline");
    f.edit("accepted current", 3);
    let bytes = f.doc.encode_full_state();
    let receipts = append_history_copies(&mut f, 4097, bytes);
    let terminal = receipts.last().unwrap().clone();
    f.terminal = Some(terminal.clone());
    let selected = point(&f.doc, terminal.journal_cursor, terminal.update_digest);
    let input = f.freeze(selected);
    let proposal = f
        .owner
        .prepare_restore(
            &mut f.store,
            f.resolver.as_ref(),
            input.clone(),
            f.host.clone(),
            1_000_000,
            6,
            &NoFaults,
        )
        .unwrap();
    assert_eq!(
        proposal.receipt().accepted_history.checkpoint.event_count,
        4095
    );
    assert_eq!(proposal.receipt().accepted_history.event_count, 4098);
    assert_eq!(proposal.receipt().selected_history.suffix.len(), 3);
    let replay = f
        .owner
        .prepare_restore(
            &mut f.store,
            f.resolver.as_ref(),
            input,
            f.host.clone(),
            1_000_000,
            6,
            &NoFaults,
        )
        .unwrap();
    assert_eq!(replay.receipt(), proposal.receipt());
}

#[test]
fn ordinary_checkpoint_streams_cumulative_metadata_above_working_reserve() {
    let mut f = Fixture::new("accepted checkpoint");
    let bytes = f.doc.encode_full_state();
    // Three long legal selectors make 4095 retained records exceed the
    // supported 8 MiB allowance without changing event or byte cadence.
    let held = f.handle.registration.lock().unwrap();
    let last = f
        .store
        .write_with(&NoFaults, |tx| -> Result<_, ApplicationError> {
            let mut last = None;
            for ordinal in 1..=4096 {
                let mut binding = f.binding.clone();
                binding
                    .selector_paths
                    .extend((0..3).map(|i| format!("z{i}{}", "x".repeat(1000))));
                binding.selector_paths.sort();
                let event = AdmittedLiveUpdate {
                    metadata: AdmittedLiveUpdateMetadata {
                        accepted: RelayAcceptedLiveUpdate {
                            receipt: LiveUpdateReceipt {
                                delivery_id: format!("heavy-{ordinal}"),
                                update_digest: hex_sha256(&bytes),
                                journal_cursor: ordinal,
                                accepting_host_epoch: 1,
                            },
                            binding,
                            authority: ServerDerivedLiveUpdateAuthority::Owner {
                                principal_id: "o".repeat(512),
                            },
                            received_at_ms: ordinal,
                        },
                        first_seen: vec![],

                        canonical_version: Some(2),

                        author_snapshot: Some(vec![]),

                        first_seen_deletes: Some(vec![]),

                        checkpoint_coverage: None,
                    },
                    update_bytes: bytes.clone(),
                };
                accepted_history::append_native(tx, &held, &event, 8 * 1024 * 1024)?;
                last = Some(event.metadata.accepted.receipt);
            }
            Ok(last.unwrap())
        })
        .unwrap();
    let TxnOutcome::Committed(last) = last else {
        panic!("checkpoint did not commit")
    };
    f.store.read_with(|conn| -> Result<(),ApplicationError> {
        let total:i64=conn.query_row("SELECT sum(length(CAST(metadata_json AS BLOB))) FROM live_accepted_updates WHERE event_count<=4095",[],|r|r.get(0)).map_err(read_sql)?;
        assert!(total>8*1024*1024);
        let checkpoint:i64=conn.query_row("SELECT max(event_count) FROM live_accepted_checkpoints",[],|r|r.get(0)).map_err(read_sql)?;
        assert_eq!(checkpoint,4095);
        let doc=accepted_history::read_state(conn,&held,last.journal_cursor,NativeHistoryReconstruction { working_reserve_bytes:8*1024*1024 })?;
        assert!(crate::replay_parity::structurally_equal_v2(&doc,&f.doc)?);
        // External restore retains its cumulative proof budget boundary.
        assert!(matches!(accepted_history::read(conn,&held,last.journal_cursor,&mut Budget { remaining:4096 },4095),Err(ApplicationError::ConfiguredByteBudgetExceeded)));
        Ok(())
    }).unwrap();
}

#[test]
fn native_state_reader_refuses_metadata_application_count_and_blob_corruption() {
    for sql in [
        "UPDATE live_accepted_updates SET evidence_digest=printf('%064d',0)",
        "UPDATE live_accepted_updates SET metadata_json=json_set(metadata_json,'$.accepted.receipt.journalCursor',8)",
        "UPDATE live_accepted_updates SET metadata_json=json_set(metadata_json,'$.accepted.binding.restoreFenceGeneration',1)",
        "UPDATE live_device_update_applications SET first_seen_count=1",
        "UPDATE binary_blobs SET bytes=zeroblob(length(bytes)) WHERE sha256=(SELECT update_sha256 FROM live_accepted_updates LIMIT 1)",
        "UPDATE binary_blobs SET byte_length=byte_length+1 WHERE sha256=(SELECT update_sha256 FROM live_accepted_updates LIMIT 1)",
        "UPDATE live_accepted_updates SET event_count=2",
        "UPDATE live_accepted_updates SET suffix_count=2",
        "UPDATE live_accepted_updates SET suffix_bytes=suffix_bytes+1",
    ] {
        let mut f = Fixture::new("baseline");
        f.edit("accepted text", 7);
        damage(&f, sql);
        let held = f.handle.registration.lock().unwrap();
        assert!(
            f.store
                .read_with(|conn| accepted_history::read_state(
                    conn,
                    &held,
                    7,
                    NativeHistoryReconstruction {
                        working_reserve_bytes: 8 * 1024 * 1024
                    }
                ))
                .is_err(),
            "{sql}"
        );
    }
    let f = Fixture::new("baseline");
    let held = f.handle.registration.lock().unwrap();
    assert!(matches!(
        f.store.read_with(|conn| accepted_history::read_state(
            conn,
            &held,
            0,
            NativeHistoryReconstruction {
                working_reserve_bytes: 0
            }
        )),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
}

#[test]
fn native_resume_generation_does_not_reopen_historical_proposal_under_fixed_stage_budget() {
    let mut f = Fixture::new("baseline");
    f.edit("accepted", 7);
    restore_and_resume(&mut f);
    // JSON whitespace changes no committed association. Full historical proof
    // validation still charges this row and checks its original evidence stamp.
    damage(
        &f,
        "UPDATE live_restore_fences SET proposal_json=proposal_json||printf('%*s',20971521,'')",
    );
    let held = f.handle.registration.lock().unwrap();
    let resumed = f
        .store
        .read_with(|conn| restore_resume::generation(conn, &held))
        .unwrap()
        .unwrap();
    assert!(matches!(
        f.store.read_with(|conn| restore_resume::saved(
            conn,
            &held,
            &resumed.operation_id,
            crate::limits::MAX_YDOC_UPDATE_BYTES
        )),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
}

#[test]
fn native_resume_generation_preserves_historical_selector_scope() {
    let mut f = Fixture::new("baseline");
    f.edit("accepted", 7);
    restore_and_resume(&mut f);
    let held = f.handle.registration.lock().unwrap();
    let expected = f
        .store
        .read_with(|conn| restore_resume::generation(conn, &held))
        .unwrap()
        .unwrap();
    let mut current = Registration {
        workspace_id: held.workspace_id.clone(),
        namespace: held.namespace.clone(),
        coordinate: held.coordinate.clone(),
        binding: held.binding.clone(),
        live: held.live,
    };
    current.binding.selector_paths.push("z.md".into());
    current.binding.selector_paths.sort();
    assert_eq!(
        f.store
            .read_with(|conn| restore_resume::generation(conn, &current))
            .unwrap(),
        Some(expected)
    );
}

#[test]
fn native_resume_generation_preflights_operation_identifier_length() {
    let mut f = Fixture::new("baseline");
    f.edit("accepted", 7);
    restore_and_resume(&mut f);
    damage(
        &f,
        "UPDATE live_restore_fences SET operation_id=printf('%*s',513,'x')",
    );
    let held = f.handle.registration.lock().unwrap();
    assert!(matches!(
        f.store
            .read_with(|conn| restore_resume::generation(conn, &held)),
        Err(ApplicationError::Corrupt)
    ));
}

#[test]
fn native_resume_generation_checks_compact_receipt_checkpoint_and_settlement_association() {
    for sql in [
        "UPDATE live_restore_fences SET resume_receipt_json=json_set(resume_receipt_json,'$.localHeadSequence',99)",
        "UPDATE live_restore_fences SET resume_receipt_json=json_set(resume_receipt_json,'$.applicationReceipt.acceptingHostEpoch',99)",
        "UPDATE live_restore_fences SET resume_receipt_json=json_set(resume_receipt_json,'$.binding.restoreFenceGeneration',99)",
        "UPDATE live_restore_fences SET resume_receipt_json=json_set(resume_receipt_json,'$.momentId','wrong')",
        "UPDATE live_restore_fences SET resume_receipt_json=json_set(resume_receipt_json,'$.markdownDigest',printf('%064d',0))",
        "UPDATE live_device_settlements SET source_state_vector_digest=printf('%064d',0) WHERE settlement_kind='restore'",
        "UPDATE live_accepted_checkpoints SET state_sha256=printf('%064d',0) WHERE restore_operation_id IS NOT NULL",
    ] {
        let mut f = Fixture::new("baseline");
        f.edit("accepted", 7);
        restore_and_resume(&mut f);
        let held = f.handle.registration.lock().unwrap();
        f.store
            .read_with(|conn| restore_resume::generation(conn, &held))
            .unwrap()
            .unwrap();
        damage(&f, sql);
        assert!(
            f.store
                .read_with(|conn| restore_resume::generation(conn, &held))
                .is_err(),
            "{sql}"
        );
    }
}

#[test]
fn native_restore_checkpoint_compact_association_refuses_changed_generation_receipt_or_content() {
    for sql in [
        "UPDATE live_restore_fences SET application_delivery_id='wrong'",
        "UPDATE live_restore_fences SET application_json=json_set(application_json,'$.admitted.accepted.receipt.acceptingHostEpoch',4)",
        "UPDATE live_restore_fences SET application_json=json_set(application_json,'$.fence.operation.oldBinding.lineageClaimId',printf('%064d',0))",
        "UPDATE live_restore_fences SET input_json=json_set(input_json,'$.newFence',2)",
        "UPDATE live_restore_fences SET proposal_json=json_set(proposal_json,'$.finalContentDigest',printf('%064d',0))",
        "UPDATE live_restore_fences SET application_json=json_set(application_json,'$.admitted.firstSeen',json('[]'))",
        "UPDATE live_accepted_checkpoints SET state_sha256=printf('%064d',0) WHERE restore_operation_id IS NOT NULL",
    ] {
        let mut f = Fixture::new("baseline");
        f.edit("accepted", 7);
        restore_and_resume(&mut f);
        let cursor: i64 = f
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT max(journal_cursor) FROM live_accepted_updates",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        let held = f.handle.registration.lock().unwrap();
        f.store
            .read_with(|conn| {
                accepted_history::read_state(
                    conn,
                    &held,
                    cursor,
                    NativeHistoryReconstruction {
                        working_reserve_bytes: 8 * 1024 * 1024,
                    },
                )
            })
            .unwrap();
        damage(&f, sql);
        assert!(
            f.store
                .read_with(|conn| accepted_history::read_state(
                    conn,
                    &held,
                    cursor,
                    NativeHistoryReconstruction {
                        working_reserve_bytes: 8 * 1024 * 1024
                    }
                ))
                .is_err(),
            "{sql}"
        );
    }
}

#[test]
fn append_after_restore_avoids_historical_json_and_checkpoint_document_reads() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let mut f = Fixture::new("baseline");
    f.edit("accepted", 7);
    restore_and_resume(&mut f);
    let held = f.handle.registration.lock().unwrap();
    let cursor: i64 = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT max(journal_cursor) FROM live_accepted_updates",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let doc = f
        .store
        .read_with(|conn| {
            accepted_history::read_state(
                conn,
                &held,
                cursor,
                NativeHistoryReconstruction {
                    working_reserve_bytes: 8 * 1024 * 1024,
                },
            )
        })
        .unwrap();
    let bytes = doc
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "after restore")
        .unwrap();
    let event = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: "after-restore".into(),
                    update_digest: hex_sha256(&bytes),
                    journal_cursor: cursor + 1,
                    accepting_host_epoch: 1,
                },
                binding: held.binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                },
                received_at_ms: 101,
            },
            first_seen: vec![],
            canonical_version: Some(2),
            author_snapshot: Some(vec![]),
            first_seen_deletes: Some(vec![]),
            checkpoint_coverage: None,
        },
        update_bytes: bytes,
    };
    let result = f
        .store
        .write_with(&NoFaults, |tx| -> Result<(), ApplicationError> {
            tx.authorizer(Some(|context: AuthContext<'_>| match context.action {
                AuthAction::Read {
                    table_name: "live_restore_fences",
                    column_name: "proposal_json" | "application_json",
                }
                | AuthAction::Read {
                    table_name: "binary_blobs",
                    column_name: "bytes",
                } => Authorization::Deny,
                _ => Authorization::Allow,
            }))
            .map_err(read_sql)?;
            let appended = accepted_history::append_native(tx, &held, &event, 8 * 1024 * 1024);
            tx.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
                .map_err(read_sql)?;
            appended
        })
        .unwrap();
    assert!(matches!(result, TxnOutcome::Committed(())));
    f.store
        .read_with(|conn| {
            accepted_history::read_state(
                conn,
                &held,
                cursor + 1,
                NativeHistoryReconstruction {
                    working_reserve_bytes: 8 * 1024 * 1024,
                },
            )
        })
        .unwrap();
    damage(
        &f,
        "UPDATE live_restore_fences SET proposal_json=json_set(proposal_json,'$.finalContentDigest',printf('%064d',0))",
    );
    assert!(f
        .store
        .read_with(|conn| accepted_history::read_state(
            conn,
            &held,
            cursor + 1,
            NativeHistoryReconstruction {
                working_reserve_bytes: 8 * 1024 * 1024
            },
        ))
        .is_err());
}

#[test]
fn accepted_history_checkpoints_follow_byte_cadence_without_a_local_pending_snapshot() {
    let mut f = Fixture::new(&"a".repeat(524_288));
    let baseline = f.doc.encode_full_state();
    let due = (20_971_520_u64).div_ceil(baseline.len() as u64) as i64;
    assert!(due < 4095);
    let pending = f
        .doc
        .rewrite_content_to_markdown_preserving_source(
            ContentKind::Richdoc,
            "unaccepted native work",
        )
        .unwrap();
    let key = DocKey::new("workspace", "main", "object").unwrap();
    f.store
        .write_with(&NoFaults, |tx| {
            durable::record_update_in_tx(tx, &key, &pending, None, None, 99)
        })
        .unwrap();
    let receipts = append_history_copies(&mut f, due + 1, baseline.clone());
    let held = f.handle.registration.lock().unwrap();
    f.store
        .read_with(|conn| -> Result<(), ApplicationError> {
            let history = accepted_history::read(
                conn,
                &held,
                receipts[due as usize].journal_cursor,
                &mut Budget {
                    remaining: 40_000_000,
                },
                1,
            )?;
            assert_eq!(history.proof.checkpoint.event_count, due);
            assert_eq!(history.proof.suffix.len(), 1);
            let accepted = Ydoc::wire();
            accepted.apply(&baseline)?;
            assert!(crate::replay_parity::structurally_equal_v2(
                &history.doc,
                &accepted
            )?);
            assert!(!crate::replay_parity::structurally_equal_v2(
                &history.doc,
                &f.doc
            )?);
            assert!(crate::replay_parity::structurally_equal_v2(
                &durable::load_doc_in(conn, &key)?,
                &f.doc
            )?);
            Ok(())
        })
        .unwrap();
}

pub(in crate::live_update_application) fn record_test_projection(
    store: &mut EngineStore,
    audit: &LiveSettlementAudit,
    moment: &str,
) -> Result<LiveSettlementResult, ApplicationError> {
    let b = audit.binding();
    let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
    let doc = store.read_with(|conn| durable::load_doc_in(conn, &key))?;
    let doc = audit.accepted_prefix().unwrap_or(&doc);
    let projected = doc.project(ContentKind::Richdoc)?.content;
    let content = if doc.has_reader_source() {
        let reference = doc.markdown_source_reference().unwrap();
        if reference.projection_sha256 == hex_sha256(projected.as_bytes()) {
            doc.markdown_source(&reference).unwrap()
        } else {
            projected.clone()
        }
    } else {
        doc.preserved_markdown_source(&projected)
            .unwrap_or(projected)
    };
    let vector = hex_sha256(&doc.encode_state_vector());
    let result = store.write_with(&NoFaults,|tx| -> Result<_, ApplicationError> {
        let written = dohc_engine_domain::write_projected_text_in_tx(tx,dohc_engine_domain::ProjectedWriteText {
            workspace_id:&b.workspace_id,version_id:&b.main_version_id,object_id:&b.object_id,path:std::borrow::Cow::Borrowed(&b.current_path),text:std::borrow::Cow::Borrowed(&content),moment_id:moment,metadata_origin:"ydoc",metadata_summary:None,metadata_correlation_id:None,author_json:None,now_ms:90,request_id:None,
        }).map_err(|_|ApplicationError::Corrupt)?;
        tx.execute("UPDATE ydoc_docs SET last_settled_sha=?4 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![b.workspace_id,b.main_version_id,b.object_id,written.snapshot.blob_sha256]).map_err(write_sql)?;
        let id=audit.record_in_tx(tx,moment,&written.snapshot.blob_sha256,&vector,90)?;
        if audit.accepted_prefix().is_some() {
            crate::author_coverage::advance_accepted_prefix_in(tx,&key,false)?;
        }
        Ok(audit.result(id,moment.into(),written.snapshot.blob_sha256,false))
    })?;
    let TxnOutcome::Committed(result) = result else {
        return Err(ApplicationError::Interrupted);
    };
    Ok(result)
}

struct Fixture {
    store: EngineStore,
    owner: ApplicationOwner,
    resolver: Option<Arc<crate::reader_resolver::ReaderResolver>>,
    handle: ApplicationHandle,
    doc: Ydoc,
    binding: LiveObjectBinding,
    host: ApplicationHostCoordinate,
    terminal: Option<LiveUpdateReceipt>,
    sequence: i64,
    baseline_point: NativeRestorePoint,
    dir: ScratchDir,
}

fn point(doc: &Ydoc, cursor: i64, receipt_digest: String) -> NativeRestorePoint {
    let projection = doc.project(ContentKind::Richdoc).unwrap().content;
    let source = doc
        .preserved_markdown_source(&projection)
        .unwrap_or_else(|| projection.clone());
    NativeRestorePoint {
        journal_cursor: cursor,
        receipt_digest,
        markdown_digest: hex_sha256(source.as_bytes()),
        projection_digest: hex_sha256(projection.as_bytes()),
    }
}

impl Fixture {
    fn new(source: &str) -> Self {
        Self::with_seed(source, "rich-unicode")
    }
    fn with_seed(source: &str, seed_name: &str) -> Self {
        let doc = Ydoc::wire();
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../tests/live-bootstrap-fixtures/live-bootstrap.json"
        ))
        .unwrap();
        let seed = fixtures
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == seed_name)
            .unwrap();
        let seed_bytes: Vec<u8> = serde_json::from_value(seed["bytes"].clone()).unwrap();
        doc.apply(&seed_bytes).unwrap();
        doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
            .unwrap();
        Self::with_doc(doc, source)
    }
    fn with_doc(doc: Ydoc, source: &str) -> Self {
        Self::with_doc_at(doc, source, "a.md")
    }
    fn with_doc_at(doc: Ydoc, source: &str, path: &str) -> Self {
        let dir = ScratchDir::new_named("native-restore-proposal").unwrap();
        let mut store = EngineStore::open(&dir.join("engine.db"), 0).unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        let bytes = doc.encode_full_state();
        let binding = LiveObjectBinding {
            workspace_id: "workspace".into(),
            main_version_id: "main".into(),
            object_id: "object".into(),
            lineage_claim_id: hex_sha256(&bytes),
            current_path: path.into(),
            selector_paths: vec![path.into()],
            restore_fence_generation: 0,
        };
        let host = ApplicationHostCoordinate {
            host_id: "host".into(),
            host_epoch: 1,
            instance_id: "instance".into(),
            connection_id: "connection".into(),
        };
        let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
        let handle = owner
            .register(
                &mut store,
                "namespace".into(),
                host.clone(),
                binding.clone(),
            )
            .unwrap();
        let bootstrap = LiveApplicationBootstrap {
            bootstrap_id: "bootstrap".into(),
            bootstrap_moment_id: "baseline".into(),
            baseline_moment_relay_sequence: 1,
            baseline_registered_at_ms: 1,
            baseline_digest: binding.lineage_claim_id.clone(),
            baseline_byte_length: bytes.len() as i64,
            projected_markdown_digest: hex_sha256(source.as_bytes()),
            projected_markdown_byte_length: source.len() as i64,
        };
        let mut cache = WriterDocCache::new();
        if doc.has_reader_source() {
            let config =
                serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
            let resolver = Arc::new(crate::reader_resolver::ReaderResolver::new(Arc::new(
                dohc_engine_reader::Reader::new(Some(config)),
            )));
            cache.reader_resolver = Some(resolver.clone());
            dohc_engine_domain::VersionedTextStore::new(&mut store)
                .write_text(
                    &dohc_engine_domain::WriteText {
                        workspace_id: "workspace".into(),
                        version_id: "main".into(),
                        object_id: "object".into(),
                        path: path.into(),
                        text: source.into(),
                        moment_id: "received-file".into(),
                        metadata_origin: "sync".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 0,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
            for _ in 0..2 {
                match bootstrap_committed::<Box<dyn std::error::Error>>(
                    &mut store,
                    &mut cache,
                    &handle,
                    bootstrap.clone(),
                    bytes.clone(),
                    &NoFaults,
                    |_, _, _, _| Ok(()),
                ) {
                    Err(error) => match error.downcast::<ApplicationError>() {
                        Ok(error) => match *error {
                            ApplicationError::Collab(CollabError::MarkdownReaderPending(p)) => {
                                crate::reader_resolver::tests::run(p.resolve())
                            }
                            error => panic!("{error:?}"),
                        },
                        Err(error) => panic!("{error:?}"),
                    },
                    other => {
                        other.unwrap();
                        break;
                    }
                }
            }
        } else {
            bootstrap_committed::<Box<dyn std::error::Error>>(
                &mut store,
                &mut cache,
                &handle,
                bootstrap,
                bytes,
                &NoFaults,
                |_, _, _, _| Ok(()),
            )
            .unwrap();
        }
        let mut baseline_point = point(&doc, 0, binding.lineage_claim_id.clone());
        baseline_point.markdown_digest = hex_sha256(source.as_bytes());
        Self {
            dir,
            store,
            owner,
            resolver: cache.reader_resolver.clone(),
            handle,
            doc,
            binding,
            host,
            terminal: None,
            sequence: 0,
            baseline_point,
        }
    }
    fn edit(&mut self, source: &str, cursor: i64) -> NativeRestorePoint {
        let bytes = self
            .doc
            .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
            .unwrap();
        self.accept(bytes, cursor)
    }
    fn accept(&mut self, bytes: Vec<u8>, cursor: i64) -> NativeRestorePoint {
        self.accept_declared(bytes, cursor, None, vec![])
    }
    fn accept_declared(
        &mut self,
        bytes: Vec<u8>,
        cursor: i64,
        agent_declaration: Option<AgentDeclaration>,
        first_seen: Vec<LiveUpdateStructRange>,
    ) -> NativeRestorePoint {
        let receipt = LiveUpdateReceipt {
            delivery_id: format!("event-{cursor}"),
            update_digest: hex_sha256(&bytes),
            journal_cursor: cursor,
            accepting_host_epoch: 1,
        };
        let event = AdmittedLiveUpdate {
            metadata: AdmittedLiveUpdateMetadata {
                accepted: RelayAcceptedLiveUpdate {
                    receipt: receipt.clone(),
                    binding: self.binding.clone(),
                    authority: ServerDerivedLiveUpdateAuthority::Owner {
                        principal_id: "owner".into(),
                    },
                    received_at_ms: cursor,
                },
                first_seen,
                canonical_version: Some(2),
                author_snapshot: Some(
                    (agent_declaration)
                        .into_iter()
                        .map(crate::live_update_application::LiveAuthorEntry::from)
                        .collect(),
                ),
                first_seen_deletes: Some(vec![]),
                checkpoint_coverage: None,
            },
            update_bytes: bytes,
        };
        let result = apply_committed(
            &mut self.store,
            &mut WriterDocCache::new(),
            &self.handle,
            event,
            &NoFaults,
            100_000_000,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
        let ApplicationResult::Applied(ack, _) = result else {
            panic!("apply refused")
        };
        self.sequence = ack.local_ydoc_sequence;
        self.terminal = Some(receipt.clone());
        point(&self.doc, cursor, receipt.update_digest)
    }
    fn freeze(&mut self, point: NativeRestorePoint) -> NativeRestorePreparation {
        let mut operation = self.fence_input();
        operation.point = NativeRestoreSelection {
            journal_cursor: point.journal_cursor,
            receipt_digest: point.receipt_digest.clone(),
        };
        let fence = self
            .owner
            .fence_restore(
                &mut self.store,
                self.resolver.as_ref(),
                operation,
                self.host.clone(),
                50,
                &NoFaults,
            )
            .unwrap();
        NativeRestorePreparation { fence, point }
    }
    fn fence_input(&self) -> NativeRestoreFence {
        NativeRestoreFence {
            point: crate::live_update_application::NativeRestoreSelection {
                journal_cursor: 0,
                receipt_digest: self.binding.lineage_claim_id.clone(),
            },
            operation_id: if self.binding.restore_fence_generation == 0 {
                "restore".into()
            } else {
                format!("restore-{}", self.binding.restore_fence_generation + 1)
            },
            relay_database_namespace: "namespace".into(),
            old_binding: self.binding.clone(),
            host_id: "host".into(),
            new_fence: self.binding.restore_fence_generation + 1,
            origin: RestoreDeliveryOrigin::Bootstrap {
                id: "bootstrap".into(),
            },
            terminal: self.terminal.clone(),
            applied_sequence: self.sequence,
        }
    }
    fn prepare(
        &mut self,
        input: NativeRestorePreparation,
    ) -> Result<NativeRestoreProposal, ApplicationError> {
        self.owner.prepare_restore(
            &mut self.store,
            self.resolver.as_ref(),
            input,
            self.host.clone(),
            1_000_000,
            100,
            &NoFaults,
        )
    }
    fn canonical(&self) -> Ydoc {
        self.store
            .read_with(|conn| {
                durable::load_doc_in(conn, &DocKey::new("workspace", "main", "object").unwrap())
            })
            .unwrap()
    }
}

#[test]
fn desktop_automation_draft_without_server_declaration_can_stop_and_restore() {
    use crate::owner_outbox::draft::{ObservedOwnerBinding, OwnerDraftAppendInput};
    let mut f = Fixture::new("# Before automation\n");
    let checkpoint = f.doc.encode_full_state();
    let observed = ObservedOwnerBinding {
        binding: f.binding.clone(),
        relay_database_namespace: "namespace".into(),
        revision: 1,
        accepted_cursor: 0,
        native_head_sequence: 0,
        checkpoint_digest: hex_sha256(&checkpoint),
        limits: crate::owner_outbox::OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 1_000_000,
        },
    };
    f.store
        .write_with(&NoFaults, |tx| {
            crate::owner_outbox::draft::install_observed_binding_in_tx(
                tx,
                "workspace",
                &observed,
                &checkpoint,
            )
        })
        .unwrap();
    let update = f
        .doc
        .rewrite_content_to_markdown_preserving_source(
            ContentKind::Richdoc,
            "# Automation wrote this\n",
        )
        .unwrap();
    let append = crate::owner_outbox::draft::append_draft_cached(
        &mut f.store,
        &mut WriterDocCache::new(),
        "workspace",
        OwnerDraftAppendInput {
            person_edit: false,
            binding: f.binding.clone(),
            expected_revision: 1,
            append_key: "desktop-automation".into(),
            update: update.clone(),
            now_ms: 10,
            agent_declaration: None,
            automation_declaration: None,
        },
        &NoFaults,
    )
    .unwrap();
    let receipt = LiveUpdateReceipt {
        delivery_id: append.delivery_id,
        update_digest: append.update_digest,
        journal_cursor: 1,
        accepting_host_epoch: 1,
    };
    let event = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: receipt.clone(),
                binding: f.binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                },
                received_at_ms: 11,
            },
            first_seen: vec![],
            canonical_version: Some(2),
            author_snapshot: Some(vec![
                crate::live_update_application::LiveAuthorEntry::Human {
                    human_id: "owner".into(),
                    human_name: "Owner".into(),
                },
            ]),
            first_seen_deletes: Some(vec![]),
            checkpoint_coverage: None,
        },
        update_bytes: update,
    };
    let applied = apply_committed(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.handle,
        event,
        &NoFaults,
        100_000_000,
        |_, _, _, _| Ok(()),
    )
    .unwrap();
    let ApplicationResult::Applied(ack, _) = applied else {
        panic!("desktop automation refused")
    };
    f.sequence = ack.local_ydoc_sequence;
    f.terminal = Some(receipt);
    let input = f.freeze(f.baseline_point.clone());
    let proposal = f.prepare(input).unwrap();
    assert_eq!(proposal.receipt().native_sources.len(), 1);
    assert!(proposal.receipt().native_sources[0]
        .accepted_receipt
        .is_some());
    let restored = Ydoc::wire();
    restored.apply(proposal.frozen_state_bytes()).unwrap();
    restored.apply(proposal.candidate_bytes()).unwrap();
    let projection = restored.project(ContentKind::Richdoc).unwrap().content;
    assert_eq!(
        restored.preserved_markdown_source(&projection).unwrap(),
        "# Before automation\n"
    );
}

#[test]
fn prepares_one_forward_restore_of_an_exact_source_point_and_replays_after_restart() {
    let mut f = Fixture::new("# Baseline\n");
    let chosen = "---\ntitle: 'été 😀'\n---\n\n# Chosen 🐱\n\n**Keep** this.\n";
    let selected = f.edit(chosen, 7);
    f.edit(
        "---\ntitle: Later\nextra: yes\n---\n\nDiscard later work.\n",
        11,
    );
    let before = f.canonical().encode_full_state();
    let input = f.freeze(selected);
    let proposal = f.prepare(input.clone()).unwrap();
    assert_eq!(proposal.receipt().fence.local_head_sequence, 2);
    assert_eq!(proposal.receipt().accepted_history.suffix.len(), 2);
    assert!(!proposal.receipt().replacement_ranges.is_empty());
    assert_eq!(
        proposal
            .receipt()
            .fence
            .operation
            .old_binding
            .lineage_claim_id,
        f.binding.lineage_claim_id
    );
    let restored = Ydoc::wire();
    restored.apply(proposal.frozen_state_bytes()).unwrap();
    restored.apply(proposal.candidate_bytes()).unwrap();
    let projection = restored.project(ContentKind::Richdoc).unwrap().content;
    assert_eq!(
        restored.preserved_markdown_source(&projection).unwrap(),
        chosen
    );
    let before_doc = Ydoc::wire();
    before_doc.apply(&before).unwrap();
    assert!(crate::replay_parity::structurally_equal_v2(&before_doc, &f.canonical()).unwrap());
    assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    let expected = serde_json::to_vec(&proposal).unwrap();
    assert_eq!(
        serde_json::to_vec(&f.prepare(input.clone()).unwrap()).unwrap(),
        expected
    );
    drop(f.store);
    f.store = EngineStore::open(&f.dir.join("engine.db"), 60).unwrap();
    f.owner = ApplicationOwner::new("workspace".into()).unwrap();
    f.host.connection_id = "reconnected".into();
    f.host.host_epoch = 2;
    assert_eq!(
        serde_json::to_vec(&f.prepare(input).unwrap()).unwrap(),
        expected
    );
    assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 1);
}

/// Part 5's held fence: a restore fence trusted the binding's durable
/// `available` flag, which a released held document keeps. A hosted document
/// its scope holds but not ready refuses a new fence; a saved one replays.
#[test]
fn a_hosted_document_that_is_not_ready_refuses_a_new_restore_fence() {
    let mut f = Fixture::new("# Baseline\n");
    f.edit("# Edited\n", 7);
    let set = |f: &mut Fixture, sql: &str| {
        f.store
            .write_with(&NoFaults, |tx| tx.execute_batch(sql).map_err(write_sql))
            .unwrap();
    };
    set(
        &mut f,
        "INSERT OR IGNORE INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
           VALUES ('workspace','service-host:host','epoch','stream',1); \
         INSERT INTO hosted_replicas (workspace_id,scope_generation,created_at_ms) VALUES ('workspace',1,1); \
         INSERT INTO hosted_documents (workspace_id,object_id,path,state,held_reason,scope_generation) \
           VALUES ('workspace','object','a.md','held','hosted-backfill-work-waiting',1);",
    );
    let input = f.fence_input();
    let fence = |f: &mut Fixture| {
        f.owner.fence_restore(
            &mut f.store,
            f.resolver.as_ref(),
            input.clone(),
            f.host.clone(),
            50,
            &NoFaults,
        )
    };
    assert!(matches!(
        fence(&mut f),
        Err(ApplicationError::HostedDocumentUnready)
    ));
    assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 0);

    set(
        &mut f,
        "UPDATE hosted_documents SET state='ready',held_reason=NULL",
    );
    let receipt = fence(&mut f).unwrap();
    set(
        &mut f,
        "UPDATE hosted_documents SET state='held',held_reason='hosted-backfill-work-waiting'",
    );
    assert_eq!(fence(&mut f).unwrap(), receipt);
}

#[test]
fn same_content_point_still_prepares_a_forward_owner_operation() {
    let mut f = Fixture::new("# Same 😀\n");
    let input = f.freeze(f.baseline_point.clone());
    let proposal = f.prepare(input).unwrap();
    assert!(!proposal.receipt().replacement_ranges.is_empty());
    assert_eq!(proposal.receipt().point.journal_cursor, 0);
    assert_eq!(proposal.receipt().fence.local_head_sequence, 0);
}

#[test]
fn rejects_changed_point_host_fence_and_unclassified_native_tail_without_a_proposal() {
    for damage in [
        "point",
        "source",
        "projection",
        "host",
        "fence",
        "head",
        "tail",
    ] {
        let mut f = Fixture::new("# Original\n");
        if damage == "tail" {
            let bytes = f
                .doc
                .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "Unsent")
                .unwrap();
            let key = DocKey::new("workspace", "main", "object").unwrap();
            f.store
                .write_with(&NoFaults, |tx| {
                    durable::record_update_in_tx(tx, &key, &bytes, None, None, 2)
                })
                .unwrap();
        }
        let mut input = f.freeze(f.baseline_point.clone());
        match damage {
            "point" => input.point.journal_cursor = 5,
            "source" => input.point.markdown_digest = "f".repeat(64),
            "projection" => input.point.projection_digest = "f".repeat(64),
            "host" => f.host.host_id = "foreign".into(),
            "fence" => input.fence.operation.new_fence = 2,
            "head" => {
                f.store
                    .write_with(&NoFaults, |tx| {
                        tx.execute("UPDATE ydoc_docs SET head_update_seq=head_update_seq+1", [])
                            .unwrap();
                        Ok::<_, StorageError>(())
                    })
                    .unwrap();
            }
            _ => {}
        }
        assert!(f.prepare(input).is_err(), "{damage}");
        let present: i64 = f
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM live_restore_fences WHERE proposal_json IS NOT NULL",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(present, 0, "{damage}");
    }
}

struct CrashAt(FaultPoint);
impl FaultInjector for CrashAt {
    fn poll(&self, point: FaultPoint) -> FaultAction {
        if point == self.0 {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}

#[test]
fn interrupted_fences_replay_after_restart_instead_of_becoming_refusals() {
    for fault in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let mut f = Fixture::new("original\n");
        let operation = f.fence_input();
        let result = f.owner.fence_restore(
            &mut f.store,
            None,
            operation.clone(),
            f.host.clone(),
            50,
            &CrashAt(fault),
        );
        assert!(
            matches!(result, Err(ApplicationError::Interrupted)),
            "{result:?}"
        );
        let committed = fault == FaultPoint::StorageAfterCommitBeforeAck;
        assert_eq!(
            f.store.table_row_count("live_restore_fences").unwrap(),
            i64::from(committed)
        );
        let bytes = f.canonical().encode_full_state();
        drop(f.store);
        f.store = EngineStore::open(&f.dir.join("engine.db"), 60).unwrap();
        f.owner = ApplicationOwner::new("workspace".into()).unwrap();
        f.host.connection_id = "reconnected".into();
        f.host.host_epoch += 1;
        let receipt = f
            .owner
            .fence_restore_after_reconnect(
                &mut f.store,
                None,
                operation.clone(),
                f.host.clone(),
                70,
                &NoFaults,
            )
            .unwrap();
        assert_eq!(receipt.operation, operation);
        assert_eq!(receipt.recorded_at_ms, if committed { 50 } else { 70 });
        assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 1);
        assert_eq!(f.store.table_row_count("live_restore_refusals").unwrap(), 0);
        assert_eq!(f.canonical().encode_full_state(), bytes);
    }
}

#[test]
fn preparation_commit_boundaries_retain_exact_candidate_or_roll_back_every_reference() {
    for fault in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let mut f = Fixture::new("# Point\n");
        f.edit("# Later\n", 3);
        let input = f.freeze(f.baseline_point.clone());
        assert!(f
            .owner
            .prepare_restore(
                &mut f.store,
                f.resolver.as_ref(),
                input.clone(),
                f.host.clone(),
                1_000_000,
                100,
                &CrashAt(fault)
            )
            .is_err());
        let stored: Option<String> = f
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT proposal_candidate_sha256 FROM live_restore_fences",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(
            stored.is_some(),
            fault == FaultPoint::StorageAfterCommitBeforeAck
        );
        drop(f.store);
        f.store = EngineStore::open(&f.dir.join("engine.db"), 70).unwrap();
        let proposal = f.prepare(input).unwrap();
        if let Some(digest) = stored {
            assert_eq!(proposal.receipt().candidate_digest, digest);
        }
        assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    }
}

#[test]
fn configured_limits_and_foreign_key_retention_apply_to_preparation_and_replay() {
    let mut f = Fixture::new("# Point\n");
    f.edit("# Later\n", 3);
    let input = f.freeze(f.baseline_point.clone());
    for (bytes, events) in [(1, 100), (1_000_000, 0)] {
        assert!(f
            .owner
            .prepare_restore(
                &mut f.store,
                f.resolver.as_ref(),
                input.clone(),
                f.host.clone(),
                bytes,
                events,
                &NoFaults
            )
            .is_err());
    }
    let proposal = f.prepare(input.clone()).unwrap();
    for digest in [
        &proposal.receipt().candidate_digest,
        &proposal.receipt().frozen_state_digest,
        &proposal.receipt().point_state_digest,
    ] {
        assert!(f
            .store
            .write_with(&NoFaults, |tx| tx
                .execute("DELETE FROM binary_blobs WHERE sha256=?1", [digest])
                .map_err(write_sql))
            .is_err());
    }
    assert!(f
        .owner
        .prepare_restore(
            &mut f.store,
            f.resolver.as_ref(),
            input,
            f.host.clone(),
            1,
            100,
            &NoFaults
        )
        .is_err());
}

#[test]
fn durable_replay_rejects_modified_replacement_ranges_and_source_evidence() {
    for damage in ["ranges", "source", "vector", "content", "candidate"] {
        let mut f = Fixture::new("# Point\n");
        f.edit("# Later\n", 3);
        let input = f.freeze(f.baseline_point.clone());
        let proposal = f.prepare(input.clone()).unwrap();
        let mut receipt = serde_json::to_value(proposal.receipt()).unwrap();
        match damage {
            "ranges" => receipt["replacementRanges"][0]["endClock"] = serde_json::json!(1),
            "source" => {
                receipt["acceptedHistory"]["suffix"][0]["accepted"]["receivedAtMs"] =
                    serde_json::json!(99)
            }
            "vector" => receipt["afterStateVector"] = serde_json::json!([0]),
            "content" => receipt["finalContentDigest"] = serde_json::json!("f".repeat(64)),
            "candidate" => receipt["candidateDigest"] = serde_json::json!("f".repeat(64)),
            _ => unreachable!(),
        }
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE live_restore_fences SET proposal_json=?1",
                    [receipt.to_string()],
                )
                .map_err(write_sql)
            })
            .unwrap();
        assert!(f.prepare(input).is_err(), "{damage}");
    }
}

#[test]
fn verified_backup_retains_prepared_candidate_and_all_replay_evidence() {
    use dohc_engine_storage::backup::{create_verified_backup, BackupOutcome, RealFreeSpace};
    let mut f = Fixture::new("# Point\n");
    f.edit("# Later\n", 3);
    let input = f.freeze(f.baseline_point.clone());
    let proposal = f.prepare(input.clone()).unwrap();
    let BackupOutcome::Verified(record) = create_verified_backup(
        &f.store,
        &f.dir.join("recovery"),
        "proposal",
        "test",
        90,
        &RealFreeSpace,
        &NoFaults,
    )
    .unwrap() else {
        panic!("backup interrupted")
    };
    let mut restored = EngineStore::open(&record.backup_path, 100).unwrap();
    let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
    let replay = owner
        .prepare_restore(
            &mut restored,
            None,
            input,
            f.host.clone(),
            1_000_000,
            100,
            &NoFaults,
        )
        .unwrap();
    assert_eq!(
        serde_json::to_vec(&proposal).unwrap(),
        serde_json::to_vec(&replay).unwrap()
    );
}

#[test]
fn tagged_restore_preserves_the_selected_projection_after_later_tags_are_cleared() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../tests/live-bootstrap-fixtures/live-bootstrap.json"
    ))
    .unwrap();
    for row in fixtures.as_array().unwrap().iter().filter(|row| {
        row["name"].as_str().unwrap().starts_with("tagged") && row["registrationAccepted"] == true
    }) {
        for clear in [false, true] {
            let source = row["markdown"].as_str().unwrap();
            let mut f = Fixture::with_seed(source, row["name"].as_str().unwrap());
            if clear {
                f.edit("# Later untagged content\n", 7);
            }
            let before = f.canonical();
            let input = f.freeze(f.baseline_point.clone());
            let proposal = f.prepare(input.clone()).unwrap();
            let restored = Ydoc::wire();
            restored.apply(proposal.frozen_state_bytes()).unwrap();
            restored.apply(proposal.candidate_bytes()).unwrap();
            let projection = restored.project(ContentKind::Richdoc).unwrap().content;
            assert_eq!(projection, source, "{} clear={clear}", row["name"]);
            assert_eq!(
                restored.preserved_markdown_source(&projection).as_deref(),
                Some(source)
            );
            assert!(crate::replay_parity::structurally_equal_v2(&before, &f.canonical()).unwrap());
            assert_eq!(
                serde_json::to_vec(&proposal).unwrap(),
                serde_json::to_vec(&f.prepare(input).unwrap()).unwrap()
            );
        }
    }
}

fn admitted_restore(
    f: &mut Fixture,
    preparation: NativeRestorePreparation,
) -> NativeRestoreApplication {
    let proposal = reader_result(|| f.prepare(preparation.clone())).unwrap();
    let mut binding = f.binding.clone();
    binding.restore_fence_generation = preparation.fence.operation.new_fence;
    NativeRestoreApplication {
        preparation,
        candidate_digest: proposal.receipt().candidate_digest.clone(),
        native_source_manifest_digest: proposal.receipt().native_source_manifest_digest.clone(),
        admitted: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: "restore-delivery".into(),
                    update_digest: proposal.receipt().candidate_digest.clone(),
                    journal_cursor: 71,
                    accepting_host_epoch: 3,
                },
                binding,
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "restoring-owner".into(),
                },
                received_at_ms: 80,
            },
            first_seen: proposal.receipt().replacement_ranges.clone(),
            canonical_version: Some(2),
            author_snapshot: Some(vec![]),
            first_seen_deletes: Some(vec![]),
            checkpoint_coverage: None,
        },
    }
}

fn apply_restore(
    f: &mut Fixture,
    input: NativeRestoreApplication,
    faults: &dyn FaultInjector,
) -> Result<NativeRestoreApplicationReceipt, ApplicationError> {
    f.owner.apply_restore(
        &mut f.store,
        f.resolver.as_ref(),
        &mut WriterDocCache::new(),
        input,
        f.host.clone(),
        2_000_000,
        100,
        90,
        faults,
        |_, _, _, _| Ok(()),
    )
}

#[test]
fn restore_publication_callback_rolls_back_with_content_and_does_not_repeat() {
    let mut f = Fixture::new("# Original\n");
    f.edit("# Later\n", 7);
    let prep = f.freeze(f.baseline_point.clone());
    let input = admitted_restore(&mut f, prep);
    let before = f.canonical();
    let before_count = f.store.table_row_count("live_accepted_updates").unwrap();
    let failed=f.owner.apply_restore(&mut f.store, f.resolver.as_ref(),&mut WriterDocCache::new(),input.clone(),f.host.clone(),2_000_000,100,90,&NoFaults,|tx,namespace,binding,count| {
        assert_eq!(namespace,"namespace");
        assert_eq!(binding.restore_fence_generation,1);
        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM live_accepted_updates WHERE relay_database_namespace=?1 AND event_count=?2)",params![namespace,count],|row|row.get(0)).unwrap();
        assert!(exists);
        Err(ApplicationError::Interrupted)
    });
    assert!(matches!(failed, Err(ApplicationError::Interrupted)));
    assert!(crate::replay_parity::structurally_equal_v2(&before, &f.canonical()).unwrap());
    assert_eq!(
        f.store.table_row_count("live_accepted_updates").unwrap(),
        before_count
    );
    let mut called = false;
    let receipt = f
        .owner
        .apply_restore(
            &mut f.store,
            f.resolver.as_ref(),
            &mut WriterDocCache::new(),
            input.clone(),
            f.host.clone(),
            2_000_000,
            100,
            91,
            &NoFaults,
            |_, _, binding, _| {
                assert_eq!(binding.restore_fence_generation, 1);
                called = true;
                Ok(())
            },
        )
        .unwrap();
    assert!(called);
    let replay = f
        .owner
        .apply_restore(
            &mut f.store,
            f.resolver.as_ref(),
            &mut WriterDocCache::new(),
            input,
            f.host.clone(),
            2_000_000,
            100,
            92,
            &NoFaults,
            |_, _, _, _| panic!("exact restore replay must not publish again"),
        )
        .unwrap();
    assert_eq!(receipt, replay);
}

#[test]
fn native_restore_apply_commits_once_and_replays_the_original_operation_after_restart() {
    let mut f = Fixture::new("# Original\n");
    let selected = f.edit("# Chosen\n", 7);
    f.edit("# Later\n", 11);
    let prep = f.freeze(selected);
    let input = admitted_restore(&mut f, prep.clone());
    let remote_changes = |store: &EngineStore| {
        store
            .read_with(|c| dohc_engine_storage::remote_changes_applied_in(c, "workspace"))
            .unwrap()
    };
    let before = remote_changes(&f.store);
    let receipt = apply_restore(&mut f, input.clone(), &NoFaults).unwrap();
    assert_eq!(
        remote_changes(&f.store),
        before + 1,
        "a restore arrives from the computer that asked for it"
    );
    assert_eq!(receipt.local_head_sequence, 3);
    assert_eq!(receipt.admitted, input.admitted);
    let projected = f.canonical().project(ContentKind::Richdoc).unwrap().content;
    assert_eq!(
        f.canonical()
            .preserved_markdown_source(&projected)
            .as_deref(),
        Some("# Chosen\n")
    );
    assert_eq!(
        receipt,
        apply_restore(&mut f, input.clone(), &NoFaults).unwrap()
    );
    assert_eq!(
        f.store
            .table_row_count("live_device_update_applications")
            .unwrap(),
        3
    );
    assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    assert_eq!(
        f.owner
            .fence_restore(
                &mut f.store,
                f.resolver.as_ref(),
                prep.fence.operation.clone(),
                f.host.clone(),
                100,
                &NoFaults
            )
            .unwrap(),
        prep.fence
    );
    let proposal = f.prepare(prep.clone()).unwrap();
    assert_eq!(proposal.receipt().candidate_digest, input.candidate_digest);
    drop(f.store);
    f.store = EngineStore::open(&f.dir.join("engine.db"), 110).unwrap();
    f.owner = ApplicationOwner::new("workspace".into()).unwrap();
    f.host.connection_id = "new-connection".into();
    f.host.host_epoch = 2;
    assert_eq!(receipt, apply_restore(&mut f, input, &NoFaults).unwrap());
    assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    assert_eq!(
        remote_changes(&f.store),
        before + 1,
        "a replayed restore counts nothing"
    );
}

#[test]
fn native_restore_apply_refuses_changed_admission_before_and_after_commit() {
    for replay in [false, true] {
        for change in 0..8 {
            let mut f = Fixture::new("# Original\n");
            f.edit("# Later\n", 7);
            let prep = f.freeze(f.baseline_point.clone());
            let mut input = admitted_restore(&mut f, prep);
            if replay {
                apply_restore(&mut f, input.clone(), &NoFaults).unwrap();
            }
            let before = f.canonical();
            let count = f
                .store
                .table_row_count("live_device_update_applications")
                .unwrap();
            match change {
                0 => input.candidate_digest = "a".repeat(64),
                1 => input.native_source_manifest_digest = "a".repeat(64),
                2 => input.admitted.accepted.binding.object_id = "foreign".into(),
                3 => input.admitted.accepted.binding.restore_fence_generation = 0,
                4 => input.admitted.accepted.receipt.journal_cursor = 7,
                5 => input.admitted.first_seen.clear(),
                6 => input.preparation.fence.operation.operation_id = "foreign".into(),
                _ => {
                    input.admitted.accepted.authority = ServerDerivedLiveUpdateAuthority::Named {
                        principal_id: "named".into(),
                        grant_id: "grant".into(),
                        grant_generation: 1,
                    }
                }
            }
            assert!(
                apply_restore(&mut f, input, &NoFaults).is_err(),
                "change {change}, replay={replay}"
            );
            assert!(crate::replay_parity::structurally_equal_v2(&before, &f.canonical()).unwrap());
            assert_eq!(
                f.store
                    .table_row_count("live_device_update_applications")
                    .unwrap(),
                count
            );
        }
    }
}

#[test]
fn native_restore_apply_commit_crashes_preserve_one_candidate_and_one_application() {
    for fault in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let mut f = Fixture::new("# Original\n");
        f.edit("# Later\n", 7);
        let prep = f.freeze(f.baseline_point.clone());
        let input = admitted_restore(&mut f, prep);
        assert!(apply_restore(&mut f, input.clone(), &CrashAt(fault)).is_err());
        let receipt = apply_restore(&mut f, input.clone(), &NoFaults).unwrap();
        assert_eq!(receipt.local_head_sequence, 2);
        assert_eq!(receipt, apply_restore(&mut f, input, &NoFaults).unwrap());
        assert_eq!(
            f.store
                .table_row_count("live_device_update_applications")
                .unwrap(),
            2
        );
        assert_eq!(f.store.table_row_count("ydoc_updates").unwrap(), 2);
        assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    }
}

#[test]
fn restore_copy_preserves_public_point_actual_rich_marks() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../tests/live-bootstrap-fixtures/live-bootstrap.json"
    ))
    .unwrap();
    let row = fixtures
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == "rich-unicode")
        .unwrap();
    let doc = Ydoc::wire();
    doc.apply(&serde_json::from_value::<Vec<u8>>(row["bytes"].clone()).unwrap())
        .unwrap();
    let projection = doc.project(ContentKind::Richdoc).unwrap().content;
    let before = doc.canonical_content();
    let point = Ydoc::wire();
    point.apply(&doc.encode_full_state()).unwrap();
    let before_vector = doc.state_vector();
    doc.rewrite_richdoc_preserving_source_bounded(&projection, &point, 8 * 1024 * 1024, None)
        .unwrap();
    assert!(doc
        .state_vector()
        .iter()
        .any(|(client, _)| before_vector.get(client) == 0));
    assert_eq!(
        doc.project(ContentKind::Richdoc).unwrap().content,
        projection
    );
    assert_eq!(doc.canonical_content()["body"], before["body"]);
}

#[test]
fn native_restore_apply_replay_refuses_damaged_saved_admission_and_application() {
    for damage in 0..9 {
        let mut f = Fixture::new("# Original\n");
        f.edit("# Later\n", 7);
        let prep = f.freeze(f.baseline_point.clone());
        let input = admitted_restore(&mut f, prep.clone());
        let receipt = apply_restore(&mut f, input.clone(), &NoFaults).unwrap();
        let before = f.canonical();
        f.store.write_with(&NoFaults, |tx| {
            let mut json = serde_json::to_value(&receipt).unwrap();
            match damage {
                0 => json["admitted"]["accepted"]["receivedAtMs"] = json!(987),
                1 => json["admitted"]["accepted"]["authority"]["principalId"] = json!("foreign-owner"),
                2 => json["localHeadSequence"] = json!(99),
                3 => json["candidateDigest"] = json!("a".repeat(64)),
                4 => json["admitted"]["firstSeen"] = json!([]),
                5 => { return tx.execute("UPDATE live_device_update_applications SET first_seen_count=999999 WHERE delivery_id='restore-delivery'", []).map_err(write_sql); }
                6 => { return tx.execute("UPDATE live_device_update_applications SET selector_paths_json=?1 WHERE delivery_id='restore-delivery'", [serde_json::to_string(&vec!["a.md"; 10_000]).unwrap()]).map_err(write_sql); }
                7 => { return tx.execute("UPDATE live_restore_fences SET application_json=NULL,application_delivery_id=NULL", []).map_err(write_sql); }
                _ => { return tx.execute("UPDATE live_restore_fences SET application_json='{}'", []).map_err(write_sql); }
            }
            tx.execute("UPDATE live_restore_fences SET application_json=?1", [json.to_string()]).map_err(write_sql)
        }).unwrap();
        assert!(
            apply_restore(&mut f, input, &NoFaults).is_err(),
            "damage {damage}"
        );
        assert!(f.prepare(prep.clone()).is_err(), "prepare damage {damage}");
        assert!(
            f.owner
                .fence_restore(
                    &mut f.store,
                    f.resolver.as_ref(),
                    prep.fence.operation,
                    f.host.clone(),
                    100,
                    &NoFaults
                )
                .is_err(),
            "fence damage {damage}"
        );
        assert!(crate::replay_parity::structurally_equal_v2(&before, &f.canonical()).unwrap());
        assert_eq!(
            f.store
                .table_row_count("live_device_update_applications")
                .unwrap(),
            2
        );
    }
}

#[test]
fn native_restore_fence_replay_checks_candidate_bytes_after_length_precharge() {
    let mut f = Fixture::new("# Original\n");
    f.edit("# Later\n", 7);
    let prep = f.freeze(f.baseline_point.clone());
    let input = admitted_restore(&mut f, prep.clone());
    let candidate = f.prepare(prep.clone()).unwrap().candidate_bytes().to_vec();
    apply_restore(&mut f, input.clone(), &NoFaults).unwrap();
    let before = f.canonical();
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE binary_blobs SET bytes=zeroblob(byte_length) WHERE sha256=?1",
                [&input.candidate_digest],
            )
            .map_err(write_sql)
        })
        .unwrap();
    assert!(f
        .owner
        .fence_restore(
            &mut f.store,
            f.resolver.as_ref(),
            prep.fence.operation.clone(),
            f.host.clone(),
            100,
            &NoFaults
        )
        .is_err());
    assert_eq!(
        f.store
            .table_row_count("live_device_update_applications")
            .unwrap(),
        2
    );
    assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE binary_blobs SET bytes=?2 WHERE sha256=?1",
                params![input.candidate_digest, candidate],
            )
            .map_err(write_sql)
        })
        .unwrap();
    assert_eq!(
        f.owner
            .fence_restore(
                &mut f.store,
                f.resolver.as_ref(),
                prep.fence.operation.clone(),
                f.host.clone(),
                100,
                &NoFaults
            )
            .unwrap(),
        prep.fence
    );
    assert!(crate::replay_parity::structurally_equal_v2(&before, &f.canonical()).unwrap());
}

#[test]
fn native_restore_apply_enforces_budget_on_first_apply_and_replay() {
    for replay in [false, true] {
        let mut f = Fixture::new("# Original\n");
        f.edit("# Later\n", 7);
        let prep = f.freeze(f.baseline_point.clone());
        let input = admitted_restore(&mut f, prep);
        if replay {
            apply_restore(&mut f, input.clone(), &NoFaults).unwrap();
        }
        let before = f.canonical();
        for (bytes, events) in [(1, 100), (2_000_000, 0)] {
            assert!(f
                .owner
                .apply_restore(
                    &mut f.store,
                    f.resolver.as_ref(),
                    &mut WriterDocCache::new(),
                    input.clone(),
                    f.host.clone(),
                    bytes,
                    events,
                    90,
                    &NoFaults,
                    |_, _, _, _| Ok(()),
                )
                .is_err());
            assert!(crate::replay_parity::structurally_equal_v2(&before, &f.canonical()).unwrap());
        }
        apply_restore(&mut f, input, &NoFaults).unwrap();
    }
}

#[test]
fn ordinary_settlement_starts_at_verified_restore_anchor_under_future_open_binding() {
    let mut f = Fixture::new("# Original\n");
    f.edit("# Later\n", 7);
    let prep = f.freeze(f.baseline_point.clone());
    let input = admitted_restore(&mut f, prep);
    apply_restore(&mut f, input.clone(), &NoFaults).unwrap();
    let restored = f
        .owner
        .with_restore_settlement(
            &mut f.store,
            f.resolver.as_ref(),
            input.clone(),
            f.host.clone(),
            2_000_000,
            100,
            |store, audit| record_test_projection(store, audit, "restore-moment"),
        )
        .unwrap();
    assert!(f
        .owner
        .register(
            &mut f.store,
            "namespace".into(),
            f.host.clone(),
            input.admitted.accepted.binding.clone()
        )
        .is_err());
    // Simulate only the registration state a future reopen must authenticate.
    let mut held = f.handle.registration.lock().unwrap();
    held.live = true;
    held.binding = input.admitted.accepted.binding.clone();
    f.store
        .write_with(&NoFaults, |tx| install_binding(tx, &held))
        .unwrap();
    drop(held);
    let replay = with_settlement(
        &mut f.store,
        &f.handle,
        Some(input.admitted.accepted.receipt.clone()),
        100,
        NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        },
        |store, audit| record_test_projection(store, audit, "restore-moment"),
    )
    .unwrap();
    assert_eq!(replay.settlement_id, restored.settlement_id);
    assert_eq!(replay.previous_cursor, restored.previous_cursor);
    assert_eq!(replay.application_count, restored.application_count);
    let before = f.canonical();
    let edited = Ydoc::wire();
    edited.apply(&before.encode_full_state()).unwrap();
    let bytes = edited.richdoc_append_paragraph("Fresh owner edit");
    let mut event = AdmittedLiveUpdate {
        metadata: input.admitted.clone(),
        update_bytes: bytes,
    };
    event.metadata.accepted.receipt.delivery_id = "fresh-delivery".into();
    event.metadata.accepted.receipt.journal_cursor = 82;
    event.metadata.accepted.receipt.update_digest = hex_sha256(&event.update_bytes);
    event.metadata.first_seen.clear();
    let held = f.handle.registration.lock().unwrap();
    let key = DocKey::new(
        &held.binding.workspace_id,
        &held.binding.main_version_id,
        &held.binding.object_id,
    )
    .unwrap();
    f.store
        .write_with(&NoFaults, |tx| -> Result<(), ApplicationError> {
            let (_, seq, _) = durable::append_and_index_update(
                tx,
                &key,
                ContentKind::Richdoc,
                &before,
                &event.update_bytes,
                &event.metadata.accepted.receipt.update_digest,
                true,
                None,
                None,
                None,
                100,
            )?;
            insert_application(tx, &held, &event, seq)
        })
        .unwrap();
    drop(held);
    let next = with_settlement(
        &mut f.store,
        &f.handle,
        Some(event.metadata.accepted.receipt),
        100,
        NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        },
        |store, audit| record_test_projection(store, audit, "fresh-moment"),
    )
    .unwrap();
    assert_eq!(next.previous_cursor, 71);
    assert_eq!(next.terminal_cursor, 82);
    assert_eq!(next.application_count, 1);
    assert_eq!(
        f.store.table_row_count("live_device_settlements").unwrap(),
        2
    );
}

/// The restore's settlement moment replaces the text the fenced generation last
/// settled. After durable resume its publication needs the restored after-image
/// and that replaced before-image, but no other history of the old generation.
#[test]
fn resumed_restore_settlement_moment_publishes_its_replaced_and_restored_images() {
    use crate::owner_outbox::publication::{contains_in, PublicationContentKind, PublicationProof};
    let mut f = Fixture::new("Original");
    let unsettled = f.edit("Accepted but never settled", 5);
    f.edit("Recipient continued", 7);
    let replaced = with_settlement(
        &mut f.store,
        &f.handle,
        f.terminal.clone(),
        100,
        NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        },
        |store, audit| record_test_projection(store, audit, "replaced-moment"),
    )
    .unwrap();
    let old = f.binding.clone();
    let restored = restore_and_resume(&mut f);
    let key = DocKey::new("workspace", "main", "object").unwrap();
    f.store
        .read_with(|conn| -> Result<(), ApplicationError> {
            // The moment the restore settlement journals for publication.
            let (before, after): (String, String) = conn
                .query_row(
                    "SELECT before_blob_sha256,after_blob_sha256 FROM moments WHERE moment_id='restore-moment'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!((before.as_str(), after.as_str()), (replaced.markdown_digest.as_str(), restored.markdown_digest.as_str()));
            // Its before-image is settled only under the generation the restore fenced.
            let replaced_binding: String = conn
                .query_row(
                    "SELECT binding_json FROM live_device_settlements WHERE settlement_id=?1",
                    [&replaced.settlement_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(serde_json::from_str::<LiveObjectBinding>(&replaced_binding).unwrap(), old);
            assert_eq!(f.binding.restore_fence_generation, old.restore_fence_generation + 1);
            let proof = |digest: &str| {
                contains_in(conn, &key, &f.binding.current_path, None, PublicationContentKind::Projection, digest, &mut 4_000_000)
                    .unwrap()
            };
            assert_eq!(proof(&after), PublicationProof::Contained, "restored after-image");
            assert_eq!(proof(&before), PublicationProof::Contained, "replaced before-image");
            // Neither unsettled history of the fenced generation nor unrelated text is proved.
            assert_eq!(proof(&unsettled.markdown_digest), PublicationProof::NotContained);
            assert_eq!(proof(&hex_sha256(b"unrelated private draft")), PublicationProof::NotContained);
            // Only this registration's exact namespace and resumed binding read the evidence,
            // and the evidence reads are charged to the caller's budget.
            let predecessor = |namespace: &str, binding: &LiveObjectBinding, remaining: usize| {
                crate::live_update_application::read_restore_predecessor_in(conn, &key, namespace, binding, &mut { remaining })
            };
            assert_eq!(predecessor("namespace", &f.binding, 4_000_000)?, Some(before.clone()));
            assert_eq!(predecessor("other-namespace", &f.binding, 4_000_000)?, None);
            assert_eq!(predecessor("namespace", &old, 4_000_000)?, None);
            assert!(matches!(
                predecessor("namespace", &f.binding, 64),
                Err(ApplicationError::ConfiguredByteBudgetExceeded)
            ));
            Ok(())
        })
        .unwrap();
    // Changed resume evidence no longer proves the replaced head.
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE live_restore_fences SET resume_evidence_digest=?1",
                [&"0".repeat(64)],
            )
            .map_err(write_sql)?;
            Ok::<_, ApplicationError>(())
        })
        .unwrap();
    f.store
        .read_with(|conn| -> Result<(), ApplicationError> {
            let proof = |digest: &str| {
                contains_in(
                    conn,
                    &key,
                    &f.binding.current_path,
                    None,
                    PublicationContentKind::Projection,
                    digest,
                    &mut 4_000_000,
                )
                .unwrap()
            };
            assert_eq!(
                proof(&replaced.markdown_digest),
                PublicationProof::NotContained
            );
            assert_eq!(
                proof(&restored.markdown_digest),
                PublicationProof::Contained
            );
            Ok(())
        })
        .unwrap();
}

/// A restore before the fenced generation ever settled replaced that generation's origin.
#[test]
fn resumed_restore_without_a_prior_settlement_replaced_its_origin() {
    let mut f = Fixture::new("Original");
    f.edit("Recipient continued", 7);
    restore_and_resume(&mut f);
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let origin = hex_sha256(b"Original");
    f.store
        .read_with(|conn| -> Result<(), ApplicationError> {
            let before: String = conn
                .query_row(
                    "SELECT before_blob_sha256 FROM moments WHERE moment_id='restore-moment'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(before, origin);
            let predecessor = |remaining: &mut usize| {
                crate::live_update_application::read_restore_predecessor_in(
                    conn,
                    &key,
                    "namespace",
                    &f.binding,
                    remaining,
                )
            };
            let mut remaining = 4_000_000;
            assert_eq!(predecessor(&mut remaining)?, Some(origin.clone()));
            // The origin read is the proof's last charge.
            let used = 4_000_000 - remaining;
            assert_eq!(predecessor(&mut { used })?, Some(origin.clone()));
            assert!(matches!(
                predecessor(&mut { used - 1 }),
                Err(ApplicationError::ConfiguredByteBudgetExceeded)
            ));
            Ok(())
        })
        .unwrap();
}

/// The fence replay inside the predecessor proof shares the caller's budget.
/// With enough for the receipts read before it, the proof refuses before
/// reading the candidate and its application record, which would fail if read.
#[test]
fn restore_predecessor_refuses_before_reading_the_restore_candidate() {
    let mut f = Fixture::new("Original");
    f.edit("Recipient continued", 7);
    restore_and_resume(&mut f);
    let key = DocKey::new("workspace", "main", "object").unwrap();
    // The resume row's receipt, settlement and evidence; the application row's
    // receipt and delivery; and the candidate.
    let (operation, receipt, application, candidate): (String, i64, i64, i64) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT f.operation_id,length(CAST(f.resume_receipt_json AS BLOB))+length(CAST(f.resume_settlement_id AS BLOB))+length(CAST(f.resume_evidence_digest AS BLOB)),length(CAST(f.application_json AS BLOB))+length(CAST(f.application_delivery_id AS BLOB)),b.byte_length FROM live_restore_fences f JOIN binary_blobs b ON b.sha256=json_extract(f.application_json,'$.candidateDigest') WHERE f.resume_receipt_json IS NOT NULL",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(read_sql)
        })
        .unwrap();
    let held = Registration {
        workspace_id: "workspace".into(),
        namespace: "namespace".into(),
        coordinate: f.host.clone(),
        binding: f.binding.clone(),
        live: false,
    };
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE live_device_update_applications SET applied_connection_id=applied_connection_id||'-changed' WHERE delivery_id=(SELECT json_extract(application_json,'$.admitted.accepted.receipt.deliveryId') FROM live_restore_fences)",
                [],
            )
            .map_err(write_sql)?;
            Ok::<_, ApplicationError>(())
        })
        .unwrap();
    let predecessor = |remaining: usize| {
        f.store.read_with(|conn| {
            crate::live_update_application::read_restore_predecessor_in(
                conn,
                &key,
                "namespace",
                &f.binding,
                &mut { remaining },
            )
        })
    };
    assert!(matches!(
        predecessor(4_000_000),
        Err(ApplicationError::Corrupt)
    ));
    // The resume row, the application row, and the replay's repeated application
    // row fit; the candidate does not.
    let before_candidate = usize::try_from(receipt + 2 * application).unwrap();
    let replaced = |remaining: usize| {
        f.store.read_with(|conn| {
            restore_resume::replaced_head(conn, &held, &operation, &mut Budget { remaining })
        })
    };
    assert!(matches!(
        replaced(4_000_000),
        Err(ApplicationError::Corrupt)
    ));
    assert!(matches!(
        replaced(before_candidate + usize::try_from(candidate).unwrap() - 1),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
}

/// The fence replay charges every first-seen child's stored workspace before
/// reading it. A damaged child grown by `extra` bytes is read, and found
/// corrupt, with exactly the grown cost; one byte less refuses before the read.
#[test]
fn fence_replay_charges_first_seen_children_before_reading_them() {
    let mut f = Fixture::new("Original");
    f.edit("Recipient continued", 7);
    restore_and_resume(&mut f);
    let held = Registration {
        workspace_id: "workspace".into(),
        namespace: "namespace".into(),
        coordinate: f.host.clone(),
        binding: f.binding.clone(),
        live: false,
    };
    let (json, children): (String, i64) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT application_json,(SELECT count(*) FROM live_device_application_first_seen c WHERE c.delivery_id=f.application_delivery_id) FROM live_restore_fences f",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(read_sql)
        })
        .unwrap();
    assert!(children > 0, "the restore candidate has first-seen ranges");
    let fence = serde_json::from_str::<NativeRestoreApplicationReceipt>(&json)
        .unwrap()
        .fence;
    let replay = |remaining: usize| {
        let mut budget = Budget { remaining };
        let result = f
            .store
            .read_with(|conn| application::fence_replay_head_in(conn, &held, &fence, &mut budget));
        (result, remaining - budget.remaining)
    };
    // Valid children, each repeating the workspace string, fit exactly what is charged.
    let (head, used) = replay(4_000_000);
    let head = head.unwrap();
    assert_eq!(replay(used).0.unwrap(), head);
    assert!(matches!(
        replay(used - 1).0,
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
    let extra = 1_000_000;
    f.store
        .read_with(|conn| {
            conn.execute_batch(&format!(
                "PRAGMA foreign_keys=OFF; UPDATE live_device_application_first_seen SET workspace_id=workspace_id||replace(hex(zeroblob({extra})),'00','x') WHERE delivery_id=(SELECT application_delivery_id FROM live_restore_fences) AND ordinal=0; PRAGMA foreign_keys=ON"
            ))
        })
        .unwrap();
    assert!(matches!(
        replay(used + extra).0,
        Err(ApplicationError::Corrupt)
    ));
    assert!(matches!(
        replay(used + extra - 1).0,
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
}

/// The bootstrap origin stamp is bounded before its row is read, charges its
/// serialized record exactly, and keeps the bytes the unbounded read hashed.
#[test]
fn bootstrap_origin_stamp_is_bounded_before_reading_and_keeps_its_bytes() {
    let f = Fixture::new("Original");
    let held = Registration {
        workspace_id: "workspace".into(),
        namespace: "namespace".into(),
        coordinate: f.host.clone(),
        binding: f.binding.clone(),
        live: false,
    };
    let stamp = |remaining: usize| {
        f.store.read_with(|conn| {
            accepted_history::origin_stamp_in(conn, &held, &mut Budget { remaining })
        })
    };
    let record = f
        .store
        .read_with(|conn| bootstrap::read_bootstrap(conn, &held))
        .unwrap()
        .unwrap();
    let bytes = serde_json::to_vec(&record).unwrap();
    // Compact stored JSON serializes larger than its raw columns, so the
    // serialization sets the cost here.
    assert!(bytes.len() > bootstrap_raw(&f));
    assert_eq!(stamp(bytes.len()).unwrap(), hex_sha256(&bytes));
    assert!(matches!(
        stamp(bytes.len() - 1),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
    // A damaged oversized binding would fail to decode once read.
    f.store
        .read_with(|conn| {
            conn.execute(
                "UPDATE live_device_bootstraps SET binding_json=json_object('padding',replace(hex(zeroblob(1000000)),'00','x'))",
                [],
            )
        })
        .unwrap();
    assert!(matches!(
        stamp(500_000),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
    assert!(matches!(
        stamp(4_000_000),
        Err(error) if !matches!(error, ApplicationError::ConfiguredByteBudgetExceeded)
    ));
}

/// The raw bytes of the bootstrap columns an origin stamp reads.
fn bootstrap_raw(f: &Fixture) -> usize {
    let length: i64 = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT length(CAST(bootstrap_id AS BLOB))+length(CAST(bootstrap_moment_id AS BLOB))+length(CAST(baseline_moment_relay_sequence AS BLOB))+length(CAST(baseline_registered_at_ms AS BLOB))+length(CAST(baseline_digest AS BLOB))+length(CAST(baseline_byte_length AS BLOB))+length(CAST(projected_markdown_digest AS BLOB))+length(CAST(projected_markdown_byte_length AS BLOB))+length(CAST(binding_json AS BLOB))+length(CAST(host_coordinate_json AS BLOB))+length(CAST(local_ydoc_sequence AS BLOB)) FROM live_device_bootstraps",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    usize::try_from(length).unwrap()
}

/// Decoding drops whitespace from stored bootstrap JSON without changing the
/// stamp. Each read still consumes the raw bytes it read, so reads sharing one
/// budget refuse at the raw boundary rather than the much smaller serialization.
#[test]
fn bootstrap_origin_stamp_consumes_raw_whitespace_padded_json() {
    let f = Fixture::new("Original");
    let held = Registration {
        workspace_id: "workspace".into(),
        namespace: "namespace".into(),
        coordinate: f.host.clone(),
        binding: f.binding.clone(),
        live: false,
    };
    let stamp = |remaining: &mut usize| {
        let mut budget = Budget {
            remaining: *remaining,
        };
        let result = f
            .store
            .read_with(|conn| accepted_history::origin_stamp_in(conn, &held, &mut budget));
        *remaining = budget.remaining;
        result
    };
    let original = stamp(&mut 4_000_000).unwrap();
    let pad = "replace(hex(zeroblob(100000)),'00',' ')";
    f.store
        .read_with(|conn| {
            conn.execute(
                &format!("UPDATE live_device_bootstraps SET binding_json={pad}||binding_json||{pad},host_coordinate_json=host_coordinate_json||char(10)||{pad}"),
                [],
            )
        })
        .unwrap();
    let raw = bootstrap_raw(&f);
    let serialized = serde_json::to_vec(
        &f.store
            .read_with(|conn| bootstrap::read_bootstrap(conn, &held))
            .unwrap()
            .unwrap(),
    )
    .unwrap()
    .len();
    assert!(
        raw > 300_000 && serialized < 10_000,
        "{raw} raw, {serialized} serialized"
    );
    let mut remaining = 4_000_000;
    assert_eq!(stamp(&mut remaining).unwrap(), original);
    assert_eq!(4_000_000 - remaining, raw);
    // Two reads fit exactly their raw cost; one byte less refuses the second.
    let mut remaining = 2 * raw;
    assert_eq!(stamp(&mut remaining).unwrap(), original);
    assert_eq!(stamp(&mut remaining).unwrap(), original);
    assert_eq!(remaining, 0);
    let mut remaining = 2 * raw - 1;
    assert_eq!(stamp(&mut remaining).unwrap(), original);
    assert!(matches!(
        stamp(&mut remaining),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
}

/// An adoption row's decoded binding scopes its source reads, but the row's
/// precharge covers only this document's sources. A damaged binding naming
/// another object is refused before it can read that object's source.
#[test]
fn adoption_origin_refuses_a_redirected_binding_before_reading_its_source() {
    let f = Fixture::new("Original");
    let held = Registration {
        workspace_id: "workspace".into(),
        namespace: "namespace".into(),
        coordinate: f.host.clone(),
        binding: f.binding.clone(),
        live: false,
    };
    let b = &f.binding;
    let text = "adopted source";
    let digest = hex_sha256(text.as_bytes());
    let binding = serde_json::to_string(b).unwrap();
    let redirected = serde_json::to_string(&LiveObjectBinding {
        object_id: "sibling".into(),
        ..b.clone()
    })
    .unwrap();
    f.store
        .read_with(|conn| -> rusqlite::Result<()> {
            conn.execute_batch("PRAGMA foreign_keys=OFF")?;
            conn.execute(
                "INSERT OR IGNORE INTO blobs(sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![digest, text.len() as i64, text],
            )?;
            // This document's real source, and a sibling's whose moment ID is a megabyte.
            for (object, moment, order) in [
                ("object", "adopted-source".to_owned(), 900_001),
                ("sibling", "m".repeat(1_000_000), 900_002),
            ] {
                conn.execute(
                    "INSERT INTO moments (workspace_id,moment_order,moment_id,version_id,object_id,path,recorded_at_ms,operation,after_blob_sha256,before_present,metadata_origin) VALUES ('workspace',?1,?2,'main',?3,?4,1,'write',?5,0,'api')",
                    params![order, moment, object, b.current_path, digest],
                )?;
                conn.execute(
                    "INSERT INTO ydoc_owner_base_sources (workspace_id,version_id,object_id,lineage_claim_id,path,source_moment_id,source_blob_sha256,source_byte_length) VALUES ('workspace','main',?1,?2,?3,?4,?5,?6)",
                    params![object, b.lineage_claim_id, b.current_path, moment, digest, text.len() as i64],
                )?;
            }
            conn.execute(
                "INSERT INTO live_owner_adoptions (relay_database_namespace,adoption_id,workspace_id,main_version_id,object_id,lineage_claim_id,binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,max_pending_bytes,max_pending_age_ms) VALUES ('namespace','adoption','workspace','main','object',?1,?2,'adopted-source',?3,?4,0,1,?3,?3,0,0,0,'null','{}',1,1)",
                params![b.lineage_claim_id, binding, digest, text.len() as i64],
            )?;
            conn.execute_batch("PRAGMA foreign_keys=ON")
        })
        .unwrap();
    let origin = |remaining: usize| {
        let mut budget = Budget { remaining };
        let result = f
            .store
            .read_with(|conn| adoption::read_origin_with(conn, &held, Some(&mut budget)));
        (result, budget.remaining)
    };
    // The row's binding, moment, digest, terminal and ID; this document's
    // source moment and digest; and the original snapshot digest.
    let cost = |binding: &str| {
        binding.len()
            + 2 * ("adopted-source".len() + digest.len())
            + "null".len()
            + "adoption".len()
            + b.lineage_claim_id.len()
    };
    let (valid, left) = origin(cost(&binding));
    assert!(matches!(valid, Ok(Some(_))));
    assert_eq!(left, 0);
    assert!(matches!(
        origin(cost(&binding) - 1).0,
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
    f.store
        .read_with(|conn| {
            conn.execute(
                "UPDATE live_owner_adoptions SET binding_json=?1",
                [&redirected],
            )
        })
        .unwrap();
    // Reading the sibling's source would have failed as a different moment.
    // Refusal comes first, having charged none of the sibling's megabyte.
    let (redirected_result, left) = origin(cost(&redirected));
    assert!(matches!(redirected_result, Err(ApplicationError::Conflict)));
    assert_eq!(left, 0);
}

/// The adoption origin stamp keeps the escaped bytes SQLite's `json_array`
/// produced, charges them exactly, and is bounded by its raw columns before
/// any column is serialized.
#[test]
fn adoption_origin_stamp_keeps_sqlite_json_bytes_and_is_bounded_before_serializing() {
    let f = Fixture::new("Original");
    let adopted = |object: &str| Registration {
        workspace_id: "workspace".into(),
        namespace: "namespace".into(),
        coordinate: f.host.clone(),
        binding: LiveObjectBinding {
            object_id: object.into(),
            ..f.binding.clone()
        },
        live: false,
    };
    let stamp = |held: &Registration, remaining: usize| {
        f.store.read_with(|conn| {
            accepted_history::origin_stamp_in(conn, held, &mut Budget { remaining })
        })
    };
    let columns = "relay_database_namespace,adoption_id,workspace_id,main_version_id,object_id,lineage_claim_id,binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,max_pending_bytes,max_pending_age_ms";
    let held = adopted("adopted");
    let binding = serde_json::to_string(&held.binding).unwrap();
    f.store
        .read_with(|conn| -> rusqlite::Result<()> {
            conn.execute_batch("PRAGMA foreign_keys=OFF")?;
            conn.execute(
                &format!("INSERT INTO live_owner_adoptions ({columns}) VALUES ('namespace',?1,'workspace','main','adopted',?2,?3,?4,?5,9007199254740991,0,1,?5,?5,2,3,4,'null',?6,1,9007199254740991)"),
                params![
                    "quote\" back\\ nl\n tab\t ctl\u{1} del\u{7f} é ☃ \u{2028}",
                    f.binding.lineage_claim_id,
                    binding,
                    "moment\r\u{c}\u{8}",
                    "0".repeat(64),
                    r#"{"hostId":"h\u0001\"x"}"#
                ],
            )?;
            conn.execute_batch("PRAGMA foreign_keys=ON")
        })
        .unwrap();
    // The stamp the removed SQLite query hashed.
    let reference: String = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT json_array(adoption_id,evidence_digest,binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,max_pending_bytes,max_pending_age_ms) FROM live_owner_adoptions WHERE object_id='adopted'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(
        reference.contains(r"\n") && reference.contains(r"\u0001") && reference.contains(r"\\")
    );
    assert_eq!(
        stamp(&held, reference.len()).unwrap(),
        hex_sha256(reference.as_bytes())
    );
    assert!(matches!(
        stamp(&held, reference.len() - 1),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
    // Its first column cannot be serialized and a later one is oversized.
    f.store
        .read_with(|conn| {
            conn.execute_batch(&format!(
                "PRAGMA foreign_keys=OFF; INSERT INTO live_owner_adoptions ({columns}) SELECT relay_database_namespace,CAST(x'ff' AS TEXT),workspace_id,main_version_id,'damaged',lineage_claim_id,binding_json,replace(hex(zeroblob(1000000)),'00','x'),source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,max_pending_bytes,max_pending_age_ms FROM live_owner_adoptions WHERE object_id='adopted'; PRAGMA foreign_keys=ON"
            ))
        })
        .unwrap();
    let damaged = adopted("damaged");
    assert!(matches!(
        stamp(&damaged, 500_000),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
    assert!(matches!(
        stamp(&damaged, 4_000_000),
        Err(ApplicationError::Corrupt)
    ));
}

/// The current interval names the agent each accepted delivery declared. A
/// delivery whose bytes deduplicate natively keeps its agent, and compaction
/// and reopen change nothing.
#[test]
fn interval_keeps_declared_agents_through_dedupe_compaction_and_reopen() {
    fn paragraph(doc: &Ydoc, text: &str) -> (Vec<u8>, Vec<LiveUpdateStructRange>) {
        let before = doc.state_vector();
        let bytes = doc.richdoc_append_paragraph(text);
        let mut ranges: Vec<_> = doc
            .state_vector()
            .iter()
            .filter_map(|(client, clock)| {
                let start = before.get(client);
                (*clock > start).then_some(LiveUpdateStructRange {
                    client_id: client.get() as i64,
                    start_clock: i64::from(start),
                    end_clock: i64::from(*clock),
                })
            })
            .collect();
        ranges.sort_by_key(|range| range.client_id);
        (bytes, ranges)
    }
    let agent = |agent_id: &str, depth| {
        Some(AgentDeclaration {
            agent_id: agent_id.into(),
            on_behalf_of: Some("owner".into()),
            depth,
        })
    };
    let declared = |f: &Fixture| {
        let key = DocKey::new("workspace", "main", "object").unwrap();
        let authors = f
            .store
            .read_with(|conn| crate::author_coverage::interval_in(conn, &key, i64::MAX))
            .unwrap();
        serde_json::from_str::<Value>(&authors.json()).unwrap()
    };
    let mut f = Fixture::new("Original");
    let (first, first_seen) = paragraph(&f.doc, "Agent edit");
    f.accept_declared(first.clone(), 3, agent("trip-agent", 0), first_seen);
    let (person, first_seen) = paragraph(&f.doc, "Person edit");
    f.accept_declared(person, 5, None, first_seen);
    f.accept_declared(first, 7, agent("review-agent", 2), vec![]);
    assert_eq!(
        f.store
            .read_with(|conn| conn.query_row(
                "SELECT count(DISTINCT local_ydoc_sequence) FROM live_device_update_applications",
                [],
                |r| r.get::<_, i64>(0)
            ))
            .unwrap(),
        2,
        "the third delivery's bytes deduplicate"
    );
    let expected = json!([
        {"kind":"agent","agentId":"review-agent","onBehalfOf":"owner","depth":2},
        {"kind":"agent","agentId":"trip-agent","onBehalfOf":"owner","depth":0},
        {"kind":"unattributed"},
    ]);
    assert_eq!(declared(&f), expected);
    let key = DocKey::new("workspace", "main", "object").unwrap();
    durable::maybe_compact(&mut f.store, &key, 0, &NoFaults, 30).unwrap();
    assert_eq!(f.store.table_row_count("ydoc_updates").unwrap(), 0);
    drop(f.store);
    f.store = EngineStore::open(&f.dir.join("engine.db"), 40).unwrap();
    assert_eq!(declared(&f), expected);
}

/// A new fence waits until the relay acknowledged this document's journaled
/// settlement moments. The last one's before-image is publishable only before
/// the fence; afterwards only the replaced head and restored image are.
#[test]
fn fence_waits_for_this_documents_settlement_moments_to_reach_the_relay() {
    use crate::owner_outbox::publication::{contains_in, PublicationContentKind, PublicationProof};
    let mut f = Fixture::new("Original");
    f.edit("First settled", 5);
    let first = with_settlement(
        &mut f.store,
        &f.handle,
        f.terminal.clone(),
        100,
        NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        },
        |store, audit| record_test_projection(store, audit, "first-moment"),
    )
    .unwrap();
    f.edit("Second settled", 7);
    let second = with_settlement(
        &mut f.store,
        &f.handle,
        f.terminal.clone(),
        100,
        NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        },
        |store, audit| record_test_projection(store, audit, "second-moment"),
    )
    .unwrap();
    // The local journal holds both settlement moments, then another object's
    // moment. The relay acknowledged only the first.
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES ('workspace','origin','epoch','stream',1)", [])
                .map_err(write_sql)?;
            for (seq, moment, object) in [(0, "first-moment", "object"), (1, "second-moment", "object"), (2, "other-moment", "other-object")] {
                tx.execute(
                    "INSERT INTO replication_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES ('workspace','origin',?1,'moment.append',json_object('momentId',?2,'versionId','main','objectId',?3),1,0)",
                    params![seq, moment, object],
                )
                .map_err(write_sql)?;
            }
            tx.execute("INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) VALUES ('workspace','origin',0)", [])
                .map_err(write_sql)?;
            Ok::<_, ApplicationError>(())
        })
        .unwrap();
    let state = |f: &Fixture| {
        f.store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT (SELECT count(*) FROM live_restore_fences),available,restore_fence_generation FROM live_device_application_bindings",
                    [],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)),
                )
                .map_err(read_sql)
            })
            .unwrap()
    };
    let publish = |f: &Fixture, pushed: i64| {
        f.store
            .read_with(|conn| {
                conn.execute("UPDATE sync_relay_push_state SET pushed_seq=?1", [pushed])
            })
            .unwrap()
    };
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let proof = |f: &Fixture, digest: &str| {
        f.store
            .read_with(|conn| {
                contains_in(
                    conn,
                    &key,
                    &f.binding.current_path,
                    None,
                    PublicationContentKind::Projection,
                    digest,
                    &mut 4_000_000,
                )
            })
            .unwrap()
    };
    let before = state(&f);
    assert_eq!(before, (0, 1, 0));
    let input = f.fence_input();
    assert!(matches!(
        f.owner.fence_restore(
            &mut f.store,
            f.resolver.as_ref(),
            input.clone(),
            f.host.clone(),
            50,
            &NoFaults
        ),
        Err(ApplicationError::PublicationPending)
    ));
    assert_eq!(state(&f), before);
    // Unfenced, the waiting moment's before-image can still be published.
    assert_eq!(
        proof(&f, &first.markdown_digest),
        PublicationProof::Contained
    );
    // Publication reached the second moment. The other object's moment does not block.
    publish(&f, 1);
    let fenced = f
        .owner
        .fence_restore(
            &mut f.store,
            f.resolver.as_ref(),
            input.clone(),
            f.host.clone(),
            50,
            &NoFaults,
        )
        .unwrap();
    // The committed fence replays without asking about publication again.
    publish(&f, 0);
    assert_eq!(
        f.owner
            .fence_restore(
                &mut f.store,
                f.resolver.as_ref(),
                input,
                f.host.clone(),
                51,
                &NoFaults
            )
            .unwrap(),
        fenced
    );
    publish(&f, 1);
    let restored = restore_and_resume(&mut f);
    assert!(![
        restored.markdown_digest.as_str(),
        second.markdown_digest.as_str(),
        hex_sha256(b"Original").as_str()
    ]
    .contains(&first.markdown_digest.as_str()));
    assert_eq!(
        proof(&f, &restored.markdown_digest),
        PublicationProof::Contained
    );
    assert_eq!(
        proof(&f, &second.markdown_digest),
        PublicationProof::Contained,
        "the head the restore replaced"
    );
    // Had the fence not waited, this before-image would have stopped the origin.
    assert_eq!(
        proof(&f, &first.markdown_digest),
        PublicationProof::NotContained
    );
}

/// Retained settlement history that enrollment export has not journaled yet
/// has the same before-images. A new fence waits for that export too, but not
/// for an export stream that already passed every settlement or another object's.
#[test]
fn fence_waits_for_retained_settlement_history_to_be_exported() {
    let mut f = Fixture::new("Original");
    f.edit("Settled before export", 5);
    let settled = with_settlement(
        &mut f.store,
        &f.handle,
        f.terminal.clone(),
        100,
        NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        },
        |store, audit| record_test_projection(store, audit, "retained-moment"),
    )
    .unwrap();
    let export = |f: &Fixture, object: &str, after: i64| {
        f.store
            .read_with(|conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO live_audit_pending_exports(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,after_event_count,after_settlement_cursor) VALUES ('namespace','workspace','main',?1,?2,0,?3)",
                    params![object, f.binding.lineage_claim_id, after],
                )
            })
            .unwrap()
    };
    let fences = |f: &Fixture| f.store.table_row_count("live_restore_fences").unwrap();
    export(&f, "other-object", -1);
    export(&f, "object", -1);
    let input = f.fence_input();
    assert!(matches!(
        f.owner.fence_restore(
            &mut f.store,
            f.resolver.as_ref(),
            input.clone(),
            f.host.clone(),
            50,
            &NoFaults
        ),
        Err(ApplicationError::PublicationPending)
    ));
    assert_eq!(fences(&f), 0);
    // Export journaled the settlement. Its stream stays open for later events.
    export(&f, "object", settled.terminal_cursor);
    f.owner
        .fence_restore(
            &mut f.store,
            f.resolver.as_ref(),
            input,
            f.host.clone(),
            50,
            &NoFaults,
        )
        .unwrap();
    assert_eq!(fences(&f), 1);
}

/// Restore at generation 1 after one prior settlement, for proof reads.
fn resumed_with_prior() -> Fixture {
    let mut f = Fixture::new("Original");
    f.edit("Recipient continued", 7);
    with_settlement(
        &mut f.store,
        &f.handle,
        f.terminal.clone(),
        100,
        NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        },
        |store, audit| record_test_projection(store, audit, "replaced-moment"),
    )
    .unwrap();
    restore_and_resume(&mut f);
    f
}

fn damage(f: &Fixture, sql: &str) {
    f.store
        .read_with(|conn| {
            conn.execute_batch(&format!(
                "PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON; {sql}; PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON"
            ))
        })
        .unwrap();
}

#[derive(Clone, Copy, Debug)]
enum ProofReader {
    Predecessor,
    Accepted,
}

fn prove(f: &Fixture, reader: ProofReader, remaining: &mut usize) -> Result<(), ApplicationError> {
    let key = DocKey::new("workspace", "main", "object").unwrap();
    f.store.read_with(|conn| match reader {
        ProofReader::Predecessor => crate::live_update_application::read_restore_predecessor_in(
            conn,
            &key,
            "namespace",
            &f.binding,
            remaining,
        )
        .map(|found| assert!(found.is_some())),
        ProofReader::Accepted => {
            crate::live_update_application::read_native_accepted_in(conn, &key, remaining)
                .map(|found| assert!(found.is_some()))
        }
    })
}

/// Each damaged row holds a megabyte of raw text that fails once read. A
/// smaller budget refuses before reading it; enough budget reaches the damage.
#[test]
fn publication_proof_charges_each_raw_row_before_reading_it() {
    use ProofReader::{Accepted, Predecessor};
    let pad = "replace(hex(zeroblob(1000000)),'00','x')";
    let cases = [
        // Registration, before anything else is read.
        (
            Predecessor,
            format!(
                "UPDATE live_device_application_bindings SET connection_id=connection_id||{pad}"
            ),
        ),
        (
            Accepted,
            format!(
                "UPDATE live_device_application_bindings SET connection_id=connection_id||{pad}"
            ),
        ),
        // The current-state marker and resumed fence registration.
        (
            Predecessor,
            format!("UPDATE ydoc_docs SET path=path||{pad}"),
        ),
        (
            Accepted,
            format!(
                "UPDATE live_restore_fences SET resume_receipt_json=json_set(resume_receipt_json,'$.padding',{pad})"
            ),
        ),
        // The resume receipt's settlement and evidence, and the saved application.
        (
            Predecessor,
            format!(
                "UPDATE live_restore_fences SET resume_evidence_digest=resume_evidence_digest||{pad}"
            ),
        ),
        (
            Predecessor,
            format!(
                "UPDATE live_restore_fences SET application_delivery_id=application_delivery_id||{pad}"
            ),
        ),
        // The replaced settlement's digests, read after the restore evidence.
        (
            Predecessor,
            format!(
                "UPDATE live_device_settlements SET interval_digest=interval_digest||{pad} WHERE moment_id='replaced-moment'"
            ),
        ),
        // The accepted checkpoint's stored digests.
        (
            Accepted,
            format!("UPDATE live_accepted_checkpoints SET evidence_digest=evidence_digest||{pad}"),
        ),
    ];
    for (reader, sql) in cases {
        let f = resumed_with_prior();
        assert!(
            prove(&f, reader, &mut 4_000_000).is_ok(),
            "{reader:?} valid rows"
        );
        damage(&f, &sql);
        assert!(
            matches!(
                prove(&f, reader, &mut 500_000),
                Err(ApplicationError::ConfiguredByteBudgetExceeded)
            ),
            "{reader:?} refuses before reading: {sql}"
        );
        assert!(
            matches!(prove(&f, reader, &mut 4_000_000), Err(error) if !matches!(error, ApplicationError::ConfiguredByteBudgetExceeded)),
            "{reader:?} reaches the damage with enough budget: {sql}"
        );
    }
}

/// A valid registration string is charged each time a proof reads it: once by
/// registration and once by the current binding check.
#[test]
fn publication_proof_charges_valid_repeated_registration_text() {
    for reader in [ProofReader::Predecessor, ProofReader::Accepted] {
        let f = resumed_with_prior();
        let used = |f: &Fixture| {
            let mut remaining = 4_000_000;
            prove(f, reader, &mut remaining).unwrap();
            4_000_000 - remaining
        };
        let before = used(&f);
        let longer = 200;
        damage(
            &f,
            &format!(
                "UPDATE live_device_application_bindings SET host_id=host_id||replace(hex(zeroblob({longer})),'00','h')"
            ),
        );
        assert_eq!(used(&f) - before, 2 * longer, "{reader:?}");
    }
}

/// Restore to the baseline, settle and durably resume, then register the resumed binding.
fn restore_and_resume(f: &mut Fixture) -> LiveSettlementResult {
    let prep = f.freeze(f.baseline_point.clone());
    let input = admitted_restore(f, prep);
    apply_restore(f, input.clone(), &NoFaults).unwrap();
    let restored = f
        .owner
        .with_restore_settlement(
            &mut f.store,
            f.resolver.as_ref(),
            input.clone(),
            f.host.clone(),
            2_000_000,
            100,
            |store, audit| record_test_projection(store, audit, "restore-moment"),
        )
        .unwrap();
    let resumed = f
        .owner
        .resume_restore(
            &mut f.store,
            f.resolver.as_ref(),
            NativeRestoreResume {
                application: input,
                settlement_id: restored.settlement_id.clone(),
            },
            f.host.clone(),
            2_000_000,
            100,
            100,
            &NoFaults,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
    f.binding = resumed.binding.clone();
    f.handle = f
        .owner
        .register(
            &mut f.store,
            "namespace".into(),
            f.host.clone(),
            f.binding.clone(),
        )
        .unwrap();
    restored
}

#[test]
fn explicit_resume_requires_settlement_and_keeps_historical_receipts_across_repeated_restore() {
    let mut f = Fixture::new("Original");
    f.edit("Later", 7);
    let prep = f.freeze(f.baseline_point.clone());
    let input = admitted_restore(&mut f, prep);
    apply_restore(&mut f, input.clone(), &NoFaults).unwrap();
    // An applied but unresumed restore keeps every generation unpublishable.
    let document = DocKey::new("workspace", "main", "object").unwrap();
    f.store
        .read_with(|conn| -> Result<(), ApplicationError> {
            for binding in [&f.binding, &input.admitted.accepted.binding] {
                assert!(
                    crate::live_update_application::require_restore_registration(
                        conn,
                        &document,
                        "namespace",
                        binding
                    )
                    .is_err()
                );
            }
            Ok(())
        })
        .unwrap();
    let missing = NativeRestoreResume {
        application: input.clone(),
        settlement_id: "missing".into(),
    };
    assert!(matches!(
        f.owner.resume_restore(
            &mut f.store,
            f.resolver.as_ref(),
            missing,
            f.host.clone(),
            2_000_000,
            100,
            100,
            &NoFaults,
            |_, _, _, _| Ok(())
        ),
        Err(ApplicationError::Conflict)
    ));
    let settlement = f
        .owner
        .with_restore_settlement(
            &mut f.store,
            f.resolver.as_ref(),
            input.clone(),
            f.host.clone(),
            2_000_000,
            100,
            |store, audit| record_test_projection(store, audit, "restore-one"),
        )
        .unwrap();
    let resume = NativeRestoreResume {
        application: input.clone(),
        settlement_id: settlement.settlement_id,
    };
    assert!(f
        .owner
        .resume_restore(
            &mut f.store,
            f.resolver.as_ref(),
            resume.clone(),
            f.host.clone(),
            2_000_000,
            100,
            100,
            &NoFaults,
            |_, _, _, _| Err(ApplicationError::Conflict)
        )
        .is_err());
    assert!(f
        .owner
        .register(
            &mut f.store,
            "namespace".into(),
            f.host.clone(),
            input.admitted.accepted.binding.clone()
        )
        .is_err());
    let first = f
        .owner
        .resume_restore(
            &mut f.store,
            f.resolver.as_ref(),
            resume.clone(),
            f.host.clone(),
            2_000_000,
            100,
            100,
            &NoFaults,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
    f.binding = first.binding.clone();
    f.doc = f.canonical();
    f.sequence = first.local_head_sequence;
    f.terminal = Some(first.application_receipt.clone());
    f.handle = f
        .owner
        .register(
            &mut f.store,
            "namespace".into(),
            f.host.clone(),
            f.binding.clone(),
        )
        .unwrap();
    let held = f.handle.registration.lock().unwrap();
    f.store
        .read_with(|conn| -> Result<(), ApplicationError> {
            let history = accepted_history::read(
                conn,
                &held,
                71,
                &mut Budget {
                    remaining: 2_000_000,
                },
                100,
            )?;
            assert_eq!(
                history.proof.checkpoint.restore_operation_id.as_deref(),
                Some("restore")
            );
            assert!(crate::replay_parity::structurally_equal_v2(
                &history.doc,
                &f.doc
            )?);
            Ok(())
        })
        .unwrap();
    drop(held);
    f.edit("After resume", 82);
    let key = DocKey::new("workspace", "main", "object").unwrap();
    f.store
        .read_with(|conn| -> Result<(), ApplicationError> {
            assert!(require_restore_open(conn, &key).is_err());
            assert!(require_restore_generation(conn, &key, None).is_err());
            require_restore_generation(conn, &key, Some(1))?;
            Ok(())
        })
        .unwrap();
    // The resumed generation publishes the restore's accepted update; the one it replaced does not.
    {
        use crate::owner_outbox::publication::{
            contains_in, PublicationContentKind, PublicationProof,
        };
        let restored = input.admitted.accepted.receipt.update_digest.clone();
        let mut stale = f.binding.clone();
        stale.restore_fence_generation -= 1;
        f.store
            .read_with(|conn| -> Result<(), ApplicationError> {
                crate::live_update_application::require_restore_registration(
                    conn,
                    &key,
                    "namespace",
                    &f.binding,
                )?;
                assert!(
                    crate::live_update_application::require_restore_registration(
                        conn,
                        &key,
                        "namespace",
                        &stale
                    )
                    .is_err()
                );
                assert_eq!(
                    contains_in(
                        conn,
                        &key,
                        &f.binding.current_path,
                        Some(&f.binding.lineage_claim_id),
                        PublicationContentKind::Ydoc,
                        &restored,
                        &mut 4_000_000,
                    )
                    .unwrap(),
                    PublicationProof::Contained
                );
                Ok(())
            })
            .unwrap();
    }
    let second_prep = f.freeze(f.baseline_point.clone());
    assert_eq!(
        first,
        f.owner
            .resume_restore(
                &mut f.store,
                f.resolver.as_ref(),
                resume.clone(),
                f.host.clone(),
                2_000_000,
                100,
                120,
                &NoFaults,
                |_, _, _, _| panic!("historical retry must not reopen")
            )
            .unwrap()
    );
    assert!(f
        .owner
        .register(
            &mut f.store,
            "namespace".into(),
            f.host.clone(),
            f.binding.clone()
        )
        .is_err());
    let mut second = admitted_restore(&mut f, second_prep);
    second.admitted.accepted.receipt.delivery_id = "restore-two".into();
    second.admitted.accepted.receipt.journal_cursor = 100;
    apply_restore(&mut f, second.clone(), &NoFaults).unwrap();
    let settlement = f
        .owner
        .with_restore_settlement(
            &mut f.store,
            f.resolver.as_ref(),
            second.clone(),
            f.host.clone(),
            2_000_000,
            100,
            |store, audit| record_test_projection(store, audit, "restore-two"),
        )
        .unwrap();
    let second_resume = NativeRestoreResume {
        application: second,
        settlement_id: settlement.settlement_id,
    };
    let result = f
        .owner
        .resume_restore(
            &mut f.store,
            f.resolver.as_ref(),
            second_resume,
            f.host.clone(),
            2_000_000,
            100,
            150,
            &NoFaults,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
    assert_eq!(result.binding.restore_fence_generation, 2);
    use dohc_engine_storage::backup::{create_verified_backup, BackupOutcome, RealFreeSpace};
    let BackupOutcome::Verified(backup) = create_verified_backup(
        &f.store,
        &f.dir.join("resumed-recovery"),
        "resume",
        "test",
        180,
        &RealFreeSpace,
        &NoFaults,
    )
    .unwrap() else {
        panic!("backup interrupted")
    };
    let db = backup.backup_path;
    drop(f.store);
    f.store = EngineStore::open(&db, 200).unwrap();
    f.owner = ApplicationOwner::new("workspace".into()).unwrap();
    assert_eq!(
        first,
        f.owner
            .resume_restore(
                &mut f.store,
                f.resolver.as_ref(),
                resume.clone(),
                f.host.clone(),
                2_000_000,
                100,
                200,
                &NoFaults,
                |_, _, _, _| panic!("historical retry")
            )
            .unwrap()
    );
    let mut forged = resume;
    forged.application.preparation.point.markdown_digest = "a".repeat(64);
    assert!(f
        .owner
        .resume_restore(
            &mut f.store,
            f.resolver.as_ref(),
            forged,
            f.host.clone(),
            2_000_000,
            100,
            200,
            &NoFaults,
            |_, _, _, _| Ok(())
        )
        .is_err());
    f.store
        .read_with(|conn| -> Result<(), ApplicationError> {
            require_restore_generation(conn, &key, Some(2))?;
            assert!(require_restore_generation(conn, &key, Some(1)).is_err());
            Ok(())
        })
        .unwrap();
}

#[test]
fn resume_commit_boundaries_leave_a_stop_or_one_historical_receipt() {
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let mut f = Fixture::new("Original");
        let prep = f.freeze(f.baseline_point.clone());
        let input = admitted_restore(&mut f, prep);
        apply_restore(&mut f, input.clone(), &NoFaults).unwrap();
        let settlement = f
            .owner
            .with_restore_settlement(
                &mut f.store,
                f.resolver.as_ref(),
                input.clone(),
                f.host.clone(),
                2_000_000,
                100,
                |store, audit| record_test_projection(store, audit, "resume-crash"),
            )
            .unwrap();
        let resume = NativeRestoreResume {
            application: input,
            settlement_id: settlement.settlement_id,
        };
        assert!(matches!(
            f.owner.resume_restore(
                &mut f.store,
                f.resolver.as_ref(),
                resume.clone(),
                f.host.clone(),
                2_000_000,
                100,
                100,
                &CrashAt(point),
                |_, _, _, _| Ok(())
            ),
            Err(ApplicationError::Interrupted)
        ));
        let committed: bool = f
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT resume_receipt_json IS NOT NULL FROM live_restore_fences",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(committed, point == FaultPoint::StorageAfterCommitBeforeAck);
        let receipt = f
            .owner
            .resume_restore(
                &mut f.store,
                f.resolver.as_ref(),
                resume.clone(),
                f.host.clone(),
                2_000_000,
                100,
                110,
                &NoFaults,
                |_, _, _, _| {
                    assert!(!committed);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(receipt.recorded_at_ms, if committed { 100 } else { 110 });
        assert_eq!(
            receipt,
            f.owner
                .resume_restore(
                    &mut f.store,
                    f.resolver.as_ref(),
                    resume,
                    f.host.clone(),
                    2_000_000,
                    100,
                    120,
                    &NoFaults,
                    |_, _, _, _| panic!("saved resume")
                )
                .unwrap()
        );
    }
}

fn observed_collection_restore_fixture() -> Fixture {
    use dohc_engine_domain::{VersionedTextStore, WriteText};
    let doc = Ydoc::wire();
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../tests/live-bootstrap-fixtures/live-bootstrap.json"
    ))
    .unwrap();
    let seed = fixtures
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == "rich-unicode")
        .unwrap();
    doc.apply(&serde_json::from_value::<Vec<u8>>(seed["bytes"].clone()).unwrap())
        .unwrap();
    doc.frontmatter_set("id", "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa")
        .unwrap();
    doc.frontmatter_set("status", "open").unwrap();
    let text = doc.project(ContentKind::Richdoc).unwrap().content;
    let mut f = Fixture::with_doc_at(doc, &text, "tasks/a.md");
    VersionedTextStore::new(&mut f.store)
        .write_text(
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "schema".into(),
                path: "tasks/collection.yaml".into(),
                text: "fields:\n  status:\n    type: text\n".into(),
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
    f.store
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, "workspace", "main")
        })
        .unwrap();
    // A device can retain its observed binding when it registers as host.
    // Seed that retained observation alongside the production bootstrap.
    f.store.write_with(&NoFaults, |tx| {
        let checkpoint = f.doc.encode_full_state();
        let digest = hex_sha256(&checkpoint);
        dohc_engine_storage::put_binary_blob_with_sha(tx, &checkpoint, &digest)?;
        tx.execute(
            "INSERT INTO ydoc_owner_bindings (workspace_id,main_version_id,object_id,lineage_claim_id,binding_json,relay_database_namespace,binding_revision,accepted_cursor,native_head_sequence,checkpoint_digest,max_pending_bytes,max_pending_age_ms) VALUES ('workspace','main','object',?1,?2,'namespace',1,0,0,?3,1000000,60000)",
            params![f.binding.lineage_claim_id, serde_json::to_string(&f.binding).unwrap(), digest],
        ).map_err(read_sql)?;
        Ok::<_, ApplicationError>(())
    }).unwrap();
    // Registration accepts the retained observation rather than clearing it.
    f.handle = f
        .owner
        .register(
            &mut f.store,
            "namespace".into(),
            f.host.clone(),
            f.binding.clone(),
        )
        .unwrap();
    f
}

#[test]
fn restore_fence_quarantines_observed_collection_drafts_with_history() {
    use crate::owner_outbox::draft;
    let mut f = observed_collection_restore_fixture();
    let pending = Ydoc::wire();
    pending.apply(&f.doc.encode_full_state()).unwrap();
    let update = pending.frontmatter_set("status", "done").unwrap();
    f.store
        .write_with(&NoFaults, |tx| {
            draft::append_draft_in_tx(
                tx,
                "workspace",
                &f.binding,
                1,
                "pending-status".into(),
                update,
                4,
            )
        })
        .unwrap();
    let operation = f.fence_input();
    for now in [50, 51] {
        f.owner
            .fence_restore(
                &mut f.store,
                f.resolver.as_ref(),
                operation.clone(),
                f.host.clone(),
                now,
                &NoFaults,
            )
            .unwrap();
    }
    f.store.read_with(|conn| {
        let indexed = dohc_engine_domain::collections::indexed_collection_record_frontmatter_in_tx(conn, "workspace", "main", "object").unwrap().unwrap();
        assert_eq!(indexed["status"], "open");
        let state: String = conn.query_row("SELECT state FROM owner_ydoc_outboxes", [], |r| r.get(0))?;
        assert_eq!(state, "quarantined");
        let mut stmt = conn.prepare("SELECT previous_value_json,next_value_json,author_origin_id FROM collection_field_history WHERE field_name='status' ORDER BY history_id")?;
        let history = stmt.query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?)))?.collect::<Result<Vec<_>, _>>()?;
        assert_eq!(history, vec![
            (Some(serde_json::json!("open").to_string()), Some(serde_json::json!("done").to_string()), None),
            (Some(serde_json::json!("done").to_string()), Some(serde_json::json!("open").to_string()), Some("owner-draft-quarantine".into())),
        ]);
        Ok::<_, rusqlite::Error>(())
    }).unwrap();
}

#[test]
fn restore_fence_keeps_host_progress_when_its_observed_checkpoint_is_stale() {
    use crate::owner_outbox::draft;
    let mut f = observed_collection_restore_fixture();
    let pending = Ydoc::wire();
    pending.apply(&f.doc.encode_full_state()).unwrap();
    f.store
        .write_with(&NoFaults, |tx| {
            draft::append_draft_in_tx(
                tx,
                "workspace",
                &f.binding,
                1,
                "pending-body".into(),
                pending.richdoc_append_paragraph("pending body"),
                4,
            )
        })
        .unwrap();
    let update = f.doc.frontmatter_set("status", "review").unwrap();
    f.accept(update, 1);
    f.store
        .read_with(|conn| {
            let (observed_head, checkpoint_digest): (i64, String) = conn.query_row(
                "SELECT native_head_sequence, checkpoint_digest FROM ydoc_owner_bindings",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let key = DocKey::new("workspace", "main", "object").unwrap();
            let marker = crate::read_marker_in(conn, &key).unwrap().unwrap();
            assert_ne!(observed_head, marker.head_update_seq);
            let checkpoint = Ydoc::wire();
            checkpoint
                .apply(
                    &dohc_engine_storage::get_binary_blob(conn, &checkpoint_digest)
                        .unwrap()
                        .unwrap(),
                )
                .unwrap();
            assert_eq!(checkpoint.frontmatter_json()["status"], "open");
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    let operation = f.fence_input();
    for now in [50, 51] {
        f.owner
            .fence_restore(
                &mut f.store,
                f.resolver.as_ref(),
                operation.clone(),
                f.host.clone(),
                now,
                &NoFaults,
            )
            .unwrap();
    }
    f.store.read_with(|conn| {
        let indexed = dohc_engine_domain::collections::indexed_collection_record_frontmatter_in_tx(conn, "workspace", "main", "object").unwrap().unwrap();
        assert_eq!(indexed["status"], "review");
        let state: String = conn.query_row("SELECT state FROM owner_ydoc_outboxes", [], |r| r.get(0))?;
        assert_eq!(state, "quarantined");
        let mut stmt = conn.prepare("SELECT previous_value_json,next_value_json,author_origin_id FROM collection_field_history WHERE field_name='status' ORDER BY history_id")?;
        let history = stmt.query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?)))?.collect::<Result<Vec<_>, _>>()?;
        assert_eq!(history, vec![
            (Some(serde_json::json!("open").to_string()), Some(serde_json::json!("review").to_string()), None),
        ]);
        Ok::<_, rusqlite::Error>(())
    }).unwrap();
}

/// A hosted pass releases a held document this way: its handle stops
/// applying, and its binding stays available, so the update it accepted
/// still proves for the host's push.
#[test]
fn a_released_registration_still_proves_the_update_it_accepted() {
    use crate::owner_outbox::publication::{contains_in, PublicationContentKind, PublicationProof};
    let mut f = Fixture::new("Original");
    let update = f
        .doc
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "Accepted")
        .unwrap();
    f.accept(update.clone(), 1);
    f.owner.release(&f.binding.object_id);
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let proof = f
        .store
        .read_with(|conn| {
            contains_in(
                conn,
                &key,
                &f.binding.current_path,
                Some(&f.binding.lineage_claim_id),
                PublicationContentKind::Ydoc,
                &hex_sha256(&update),
                &mut 4_000_000,
            )
        })
        .unwrap();
    assert_eq!(proof, PublicationProof::Contained);
    let next = f
        .doc
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "Refused")
        .unwrap();
    let event = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: "event-2".into(),
                    update_digest: hex_sha256(&next),
                    journal_cursor: 2,
                    accepting_host_epoch: 1,
                },
                binding: f.binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                },
                received_at_ms: 2,
            },
            first_seen: vec![],
            canonical_version: None,
            author_snapshot: None,
            first_seen_deletes: None,
            checkpoint_coverage: None,
        },
        update_bytes: next,
    };
    assert_eq!(
        apply_committed(
            &mut f.store,
            &mut WriterDocCache::new(),
            &f.handle,
            event,
            &NoFaults,
            100_000_000,
            |_, _, _, _| Ok(()),
        )
        .unwrap(),
        ApplicationResult::Pending(ApplicationPending::ApplicabilityUnavailable)
    );
}

/// Opus's slice 2 review: a reconnect or a close wrote `available=0`, and a
/// document held meanwhile could not register again, so the update it
/// accepted could never prove and its queued write stalled the host's push.
/// On a hosted replica both retire registrations in memory only, like a
/// release; an ordinary host still marks the binding unavailable.
#[test]
fn a_hosted_reconnect_or_close_keeps_a_held_documents_accepted_update_provable() {
    use crate::owner_outbox::publication::{contains_in, PublicationContentKind, PublicationProof};
    for (hosted, reconnect) in [(true, false), (true, true), (false, false)] {
        let mut f = Fixture::new("Original");
        let update = f
            .doc
            .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "Accepted")
            .unwrap();
        f.accept(update.clone(), 1);
        let set = |f: &mut Fixture, sql: &str| {
            f.store
                .write_with(&NoFaults, |tx| tx.execute_batch(sql).map_err(write_sql))
                .unwrap();
        };
        if hosted {
            set(
                &mut f,
                "INSERT OR IGNORE INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
                   VALUES ('workspace','service-host:host','epoch','stream',1); \
                 INSERT INTO hosted_replicas (workspace_id,scope_generation,created_at_ms) VALUES ('workspace',1,1); \
                 INSERT INTO hosted_documents (workspace_id,object_id,path,state,scope_generation) \
                   VALUES ('workspace','object','a.md','ready',1);",
            );
        }
        let held =
            "UPDATE hosted_documents SET state='held',held_reason='hosted-backfill-work-waiting'";
        let mut reconnected = f.host.clone();
        reconnected.connection_id = "reconnected".into();
        if reconnect {
            set(&mut f, held);
            assert!(matches!(
                f.owner.register(
                    &mut f.store,
                    "namespace".into(),
                    reconnected.clone(),
                    f.binding.clone()
                ),
                Err(ApplicationError::HostedDocumentUnready)
            ));
        } else {
            f.owner.invalidate(&mut f.store).unwrap();
            if hosted {
                set(&mut f, held);
                assert!(matches!(
                    f.owner.register(
                        &mut f.store,
                        "namespace".into(),
                        reconnected,
                        f.binding.clone()
                    ),
                    Err(ApplicationError::HostedDocumentUnready)
                ));
            }
        }
        let available: bool = f
            .store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT available FROM live_device_application_bindings",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(available, hosted, "hosted {hosted}, reconnect {reconnect}");
        let key = DocKey::new("workspace", "main", "object").unwrap();
        let proof = f.store.read_with(|conn| {
            contains_in(
                conn,
                &key,
                &f.binding.current_path,
                Some(&f.binding.lineage_claim_id),
                PublicationContentKind::Ydoc,
                &hex_sha256(&update),
                &mut 4_000_000,
            )
        });
        assert_eq!(
            proof.ok() == Some(PublicationProof::Contained),
            hosted,
            "hosted {hosted}, reconnect {reconnect}"
        );
    }
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_to_native_restore_without_a_reader_holds_the_current_reader_head() {
    let mut f = Fixture::new("native original\n");
    let target = f.baseline_point.clone();
    let (bytes, source) = crate::reader_resolver::tests::original_baseline_case("valid");
    let next = Ydoc::wire();
    next.apply(&bytes).unwrap();
    let edit = f
        .doc
        .rewrite_richdoc_preserving_source_bounded(&source, &next, 2_000_000, Some(2123456))
        .unwrap();
    f.accept(edit, 3);
    store_restore_artifact(&mut f, &source);
    let config =
        serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
    f.resolver = Some(Arc::new(crate::reader_resolver::ReaderResolver::new(
        Arc::new(dohc_engine_reader::Reader::new(Some(config))),
    )));
    let input = f.freeze(target);
    f.resolver = None;
    let before = (
        f.canonical().canonical_content_sha256(),
        f.canonical().encode_state_vector(),
    );
    assert!(matches!(
        f.prepare(input),
        Err(ApplicationError::Collab(
            CollabError::MarkdownReaderUnavailable
        ))
    ));
    assert_eq!(
        (
            f.canonical().canonical_content_sha256(),
            f.canonical().encode_state_vector()
        ),
        before
    );
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_to_native_restore_validates_the_prefix_artifact_and_cached_authority() {
    for case in [
        "valid",
        "stale",
        "expired",
        "edited-and-settled",
        "forged",
        "partial",
        "binding",
        "claim",
        "fence",
        "missing",
        "self-anchor",
        "budget",
    ] {
        let mut f = Fixture::new("native original\n");
        let target = f.baseline_point.clone();
        let (bytes, source) = crate::reader_resolver::tests::original_baseline_case(
            if matches!(case, "stale" | "forged" | "partial") {
                case
            } else {
                "valid"
            },
        );
        let next = Ydoc::wire();
        next.apply(&bytes).unwrap();
        let edit = f
            .doc
            .rewrite_richdoc_preserving_source_bounded(&source, &next, 2_000_000, Some(2123456))
            .unwrap();
        f.accept(edit, 3);
        if matches!(case, "expired" | "edited-and-settled") {
            let edit = f
                .doc
                .richdoc_append_paragraph("body edit expires source freshness");
            f.accept(edit, 4);
        }
        store_restore_artifact(&mut f, &source);
        if case == "edited-and-settled" {
            let canonical = f.doc.project(ContentKind::Richdoc).unwrap().content;
            let digest = hex_sha256(canonical.as_bytes());
            f.store
                .write_with(&NoFaults, |tx| -> Result<(), ApplicationError> {
                    dohc_engine_storage::text::insert(
                        tx,
                        &digest,
                        canonical.len() as i64,
                        &canonical,
                        true,
                    )
                    .map_err(write_sql)?;
                    tx.execute(
                        "UPDATE snapshots SET blob_sha256=?1 WHERE object_id='object'",
                        [&digest],
                    )
                    .map_err(write_sql)?;
                    tx.execute(
                        "UPDATE ydoc_docs SET last_settled_sha=?1 WHERE object_id='object'",
                        [&digest],
                    )
                    .map_err(write_sql)?;
                    Ok(())
                })
                .unwrap();
        }
        let config =
            serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
        f.resolver = Some(Arc::new(crate::reader_resolver::ReaderResolver::new(
            Arc::new(dohc_engine_reader::Reader::new(Some(config))),
        )));
        if case == "partial" {
            let operation = f.fence_input();
            let result = f.owner.fence_restore(
                &mut f.store,
                f.resolver.as_ref(),
                operation.clone(),
                f.host.clone(),
                50,
                &NoFaults,
            );
            assert_refusal(result, &operation, case);
            assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 0);
            continue;
        }
        let prep = f.freeze(target);
        if !matches!(case, "forged" | "partial" | "stale") {
            reader_result(|| f.prepare(prep.clone()))
                .unwrap_or_else(|error| panic!("{case}: {error:?}"));
        }
        match case {
            "binding" => damage(&f,"UPDATE live_device_application_bindings SET host_id='replacement'"),
            "claim" => damage(&f,"UPDATE ydoc_docs SET lineage_claim_id=printf('%064d',0)"),
            "fence" => damage(&f,"UPDATE live_restore_fences SET input_json=json_set(input_json,'$.newFence',new_generation+1)"),
            "missing" => damage(&f,"DELETE FROM moments WHERE moment_id='reader-current'"),
            "self-anchor" => damage(&f,"UPDATE moments SET object_id='foreign' WHERE moment_id='reader-current'"),
            "budget" => damage(&f,"UPDATE blobs SET byte_length=3000000 WHERE sha256=(SELECT blob_sha256 FROM snapshots WHERE object_id='object')"),
            _ => {},
        }
        let before = (
            f.canonical().canonical_content_sha256(),
            f.canonical().encode_state_vector(),
        );
        let result = reader_result(|| f.prepare(prep.clone()));
        if matches!(case, "valid" | "expired" | "edited-and-settled") {
            result.unwrap_or_else(|error| panic!("{case}: {error:?}"));
        } else {
            let error = result.unwrap_err();
            assert!(
                matches!(
                    (&error, case),
                    (ApplicationError::Conflict, "binding" | "claim" | "fence")
                        | (ApplicationError::ConfiguredByteBudgetExceeded, "budget")
                        | (
                            ApplicationError::Collab(CollabError::MarkdownReaderUnavailable),
                            "forged" | "stale" | "missing" | "self-anchor"
                        )
                ),
                "{case}: {error:?}"
            );
        }
        assert_eq!(
            (
                f.canonical().canonical_content_sha256(),
                f.canonical().encode_state_vector()
            ),
            before,
            "{case}"
        );
    }
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_restore_prefix_checks_the_budget_before_dispatch() {
    let (mut f, source) = reader_fixture();
    let input = f.freeze(f.baseline_point.clone());
    let held = f.handle.registration.lock().unwrap();
    let result = f.store.read_with(|conn| {
        prefix_source(
            conn,
            &held,
            &f.doc,
            &input,
            f.resolver.as_deref(),
            &mut Budget {
                remaining: source.len() - 1,
            },
        )
    });
    assert!(matches!(
        result,
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_restore_waits_for_the_authorized_history_artifact() {
    let (mut f, source) = reader_fixture();
    let edit = f.doc.richdoc_append_paragraph("later");
    f.accept(edit, 3);
    let input = f.freeze(f.baseline_point.clone());
    damage(&f, "UPDATE moments SET object_id='foreign'");
    assert!(matches!(
        f.prepare(input.clone()),
        Err(ApplicationError::Collab(
            CollabError::MarkdownReaderUnavailable
        ))
    ));
    let before = (
        f.canonical().canonical_content_sha256(),
        f.canonical().encode_state_vector(),
    );
    store_restore_artifact(&mut f, &source);
    assert!(reader_result(|| f.prepare(input.clone())).is_ok());
    assert_eq!(
        (
            f.canonical().canonical_content_sha256(),
            f.canonical().encode_state_vector()
        ),
        before
    );
}

fn ordinary_history_stays_native(caller: &str) {
    for reader in [false, true] {
        let f = if reader {
            reader_fixture().0
        } else {
            Fixture::new("native control")
        };
        let result = if caller == "publication" {
            f.store.read_with(|conn| {
                crate::live_update_application::publication::read_native_accepted_in(
                    conn,
                    &DocKey::new("workspace", "main", "object").unwrap(),
                    &mut 2_000_000,
                )
                .map(|_| ())
            })
        } else {
            read_applied_sync(
                &f.store,
                &f.handle,
                &[0],
                AppliedSyncPolicy {
                    max_client_vector_bytes: 1_000,
                    max_host_vector_bytes: 1_000,
                    max_output_bytes: 2_000_000,
                    max_read_bytes: 2_000_000,
                },
                || true,
            )
            .map(|_| ())
        };
        if reader {
            assert!(
                matches!(
                    result,
                    Err(ApplicationError::Collab(
                        CollabError::MalformedUpdate { .. }
                    ))
                ),
                "{caller}: {result:?}"
            );
        } else {
            result.unwrap();
        }
    }
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_restore_history_leaves_publication_native() {
    ordinary_history_stays_native("publication");
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_restore_history_leaves_sync_native() {
    ordinary_history_stays_native("sync");
}

fn binding_state(f: &Fixture) -> String {
    f.store.read_with(|conn| conn.query_row("SELECT json_array(current_path,lineage_claim_id,available,restore_fence_generation,host_id,host_epoch,instance_id,connection_id,selector_paths_json) FROM live_device_application_bindings", [], |row| row.get(0))).unwrap()
}

fn impossible_point_refuses(case: &str) {
    let (mut f, _) = reader_fixture();
    let mut selected = f.baseline_point.clone();
    if case == "partial" {
        use yrs::{updates::decoder::Decode, Map, ReadTxn, Transact};
        let raw = yrs::Doc::with_options(yrs::Options {
            client_id: yrs::ClientID::new(333333),
            skip_gc: true,
            ..Default::default()
        });
        raw.transact_mut()
            .apply_update(yrs::Update::decode_v1(&f.doc.encode_full_state()).unwrap())
            .unwrap();
        let before = raw.transact().state_vector();
        raw.get_or_insert_map("meta")
            .remove(&mut raw.transact_mut(), "dohcMarkdownSource");
        let update = raw.transact().encode_state_as_update_v1(&before);
        f.doc.apply(&update).unwrap();
        selected = f.accept(update, 3);
    }
    let native = Ydoc::wire();
    native
        .rewrite_content_to_markdown(ContentKind::Richdoc, "native head\n")
        .unwrap();
    let update = f
        .doc
        .rewrite_richdoc_preserving_source_bounded(
            "native head\n",
            &native,
            2_000_000,
            Some(2123456),
        )
        .unwrap();
    f.accept(update, 4);
    match case {
        "partial" => {},
        "no-reader" => f.resolver = None,
        "missing" => damage(&f, "DELETE FROM moments"),
        "pre-rename" => damage(&f, "UPDATE moments SET path='old.md'"),
        "oversized" => damage(&f, "UPDATE blobs SET byte_length=3000000 WHERE sha256=(SELECT blob_sha256 FROM snapshots WHERE object_id='object')"),
        _ => unreachable!(),
    }
    let mut operation = f.fence_input();
    operation.point = NativeRestoreSelection {
        journal_cursor: selected.journal_cursor,
        receipt_digest: selected.receipt_digest,
    };
    assert_preflight_refusal(&mut f, operation, case);
}
fn assert_preflight_refusal(f: &mut Fixture, operation: NativeRestoreFence, case: &str) {
    let config =
        serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
    let reader = Arc::new(dohc_engine_reader::Reader::new(Some(config)));
    if f.resolver.is_some() {
        f.resolver = Some(Arc::new(crate::reader_resolver::ReaderResolver::new(
            reader.clone(),
        )));
    }
    let binding = binding_state(f);
    let head = (
        f.canonical().canonical_content_sha256(),
        f.canonical().state_vector(),
    );
    let expected_operation = operation.clone();
    let writes = watch_fence_writes(f);
    let result = f.owner.fence_restore(
        &mut f.store,
        f.resolver.as_ref(),
        operation,
        f.host.clone(),
        50,
        &NoFaults,
    );
    assert_refusal(result, &expected_operation, case);
    stop_watching_fence_writes(f, &writes, 1);
    assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 0);
    assert_eq!(binding_state(f), binding);
    assert_eq!(
        (
            f.canonical().canonical_content_sha256(),
            f.canonical().state_vector()
        ),
        head
    );
    assert_eq!(reader.dispatch_count(), 0);
    assert_saved_refusal(f, &expected_operation, case);
}

fn assert_saved_refusal(f: &mut Fixture, operation: &NativeRestoreFence, case: &str) {
    let available: bool = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT available FROM live_device_application_bindings",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(f.store.table_row_count("live_restore_refusals").unwrap(), 1);
    let replay = |f: &mut Fixture, now| {
        let result = f.owner.fence_restore_after_reconnect(
            &mut f.store,
            f.resolver.as_ref(),
            operation.clone(),
            f.host.clone(),
            now,
            &NoFaults,
        );
        let Err(ApplicationError::RestoreRefused(receipt)) = result else {
            panic!("lost refusal must replay: {result:?}");
        };
        assert_refusal::<()>(
            Err(ApplicationError::RestoreRefused(receipt.clone())),
            operation,
            case,
        );
        serde_json::to_value(receipt).unwrap()
    };
    let first = replay(f, 100);
    assert_eq!(
        first["recordedAtMs"],
        if case == "binding" { 90 } else { 50 }
    );
    // Current checks now disagree: the immutable refusal must take precedence.
    damage(
        f,
        if case == "binding" {
            "UPDATE live_device_application_bindings SET available=1"
        } else {
            "UPDATE live_device_application_bindings SET available=0"
        },
    );
    let writes = watch_fence_writes(f);
    assert_eq!(replay(f, 200), first);
    stop_watching_fence_writes(f, &writes, 0);
    let mut changed = operation.clone();
    changed.point.receipt_digest = "e".repeat(64);
    assert!(matches!(
        f.owner.fence_restore_after_reconnect(
            &mut f.store,
            f.resolver.as_ref(),
            changed,
            f.host.clone(),
            300,
            &NoFaults,
        ),
        Err(ApplicationError::Conflict)
    ));
    let reopened = EngineStore::open(&f.dir.join("engine.db"), 400).unwrap();
    f.store = reopened;
    f.owner = ApplicationOwner::new("workspace".into()).unwrap();
    assert_eq!(replay(f, 500), first);
    assert_eq!(f.store.table_row_count("live_restore_refusals").unwrap(), 1);
    damage(
        f,
        if available {
            "UPDATE live_device_application_bindings SET available=1"
        } else {
            "UPDATE live_device_application_bindings SET available=0"
        },
    );
}
#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_point_no_reader_refuses_before_fencing() {
    impossible_point_refuses("no-reader");
}
#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_point_missing_refuses_before_fencing() {
    impossible_point_refuses("missing");
}
#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_point_pre_rename_refuses_before_fencing() {
    impossible_point_refuses("pre-rename");
}
#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_point_oversized_refuses_before_fencing() {
    impossible_point_refuses("oversized");
}
#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_point_partial_refuses_before_fencing() {
    impossible_point_refuses("partial");
}
#[test]
fn preparation_refuses_a_substituted_selected_point() {
    let mut f = Fixture::new("original\n");
    let point = f.baseline_point.clone();
    let other = f.edit("newer\n", 3);
    let mut input = f.freeze(point);
    input.point = other;
    let before = binding_state(&f);
    assert!(matches!(f.prepare(input), Err(ApplicationError::Conflict)));
    assert_eq!(binding_state(&f), before);
    assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 1);
}
#[test]
fn old_fence_receipts_without_the_selection_are_refused() {
    let mut f = Fixture::new("original\n");
    let prep = f.freeze(f.baseline_point.clone());
    damage(&f, "UPDATE live_restore_fences SET input_json=json_remove(input_json,'$.point'),receipt_json=json_remove(receipt_json,'$.operation.point')");
    let before = binding_state(&f);
    let head = f
        .store
        .read_with(|conn| {
            durable::load_doc_in(conn, &DocKey::new("workspace", "main", "object").unwrap())
        })
        .unwrap()
        .encode_full_state();
    assert!(matches!(
        f.owner.fence_restore(
            &mut f.store,
            None,
            prep.fence.operation.clone(),
            f.host.clone(),
            51,
            &NoFaults
        ),
        Err(ApplicationError::Conflict)
    ));
    assert!(matches!(f.prepare(prep), Err(ApplicationError::Corrupt)));
    assert_eq!(binding_state(&f), before);
    assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 1);
    assert_eq!(
        f.store
            .read_with(|conn| durable::load_doc_in(
                conn,
                &DocKey::new("workspace", "main", "object").unwrap()
            ))
            .unwrap()
            .encode_full_state(),
        head
    );
}

#[test]
fn fence_rechecks_selected_terminal_after_preflight() {
    recheck_selected_terminal(false);
}

#[test]
fn unknown_history_fence_rechecks_selected_terminal_after_preflight() {
    recheck_selected_terminal(true);
}

fn recheck_selected_terminal(unknown_history: bool) {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let mut f = Fixture::new("original\n");
    let point = f.edit("selected\n", 3);
    f.edit("tip\n", 4);
    let mut operation = f.fence_input();
    operation.point = NativeRestoreSelection {
        journal_cursor: point.journal_cursor,
        receipt_digest: point.receipt_digest,
    };
    if unknown_history {
        f.store
            .write_with(&NoFaults, |tx| -> Result<(), ApplicationError> {
                tx.execute("DELETE FROM live_accepted_reader_history", [])
                    .unwrap();
                Ok(())
            })
            .unwrap();
    }
    let before = binding_state(&f);
    let other = Connection::open(f.dir.join("engine.db")).unwrap();
    let replacement = f.terminal.as_ref().unwrap().update_digest.clone();
    let begins = Arc::new(AtomicUsize::new(0));
    let seen = begins.clone();
    f.store.read_with(|conn| conn.authorizer(Some(move |context: AuthContext<'_>| {
        if matches!(context.action, AuthAction::Transaction { operation: TransactionOperation::Begin })
            && seen.fetch_add(1, Ordering::SeqCst) == usize::from(unknown_history) {
            assert_eq!(other.execute("UPDATE live_accepted_updates SET update_sha256=?1 WHERE journal_cursor=3", [&replacement]).unwrap(), 1);
        }
        Authorization::Allow
    }))).unwrap();
    let result =
        f.owner
            .fence_restore(&mut f.store, None, operation, f.host.clone(), 50, &NoFaults);
    f.store
        .read_with(|conn| conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>))
        .unwrap();
    assert_eq!(
        begins.load(Ordering::SeqCst),
        1 + usize::from(unknown_history)
    );
    assert!(
        matches!(result, Err(ApplicationError::Conflict)),
        "{result:?}"
    );
    assert_eq!(binding_state(&f), before);
    assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 0);
}

#[test]
fn native_fence_does_not_rebuild_the_selected_point() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let mut f = Fixture::new("original\n");
    let point = f.edit("selected\n", 3);
    f.edit("tip\n", 4);
    let mut operation = f.fence_input();
    operation.point = NativeRestoreSelection {
        journal_cursor: point.journal_cursor,
        receipt_digest: point.receipt_digest,
    };
    let reads = Arc::new(AtomicUsize::new(0));
    let seen = reads.clone();
    f.store
        .read_with(|conn| {
            conn.authorizer(Some(move |context: AuthContext<'_>| {
                if matches!(
                    context.action,
                    AuthAction::Read {
                        table_name: "live_accepted_checkpoints",
                        column_name: "state_sha256",
                        ..
                    }
                ) {
                    seen.fetch_add(1, Ordering::SeqCst);
                }
                Authorization::Allow
            }))
        })
        .unwrap();
    f.owner
        .fence_restore(&mut f.store, None, operation, f.host.clone(), 50, &NoFaults)
        .unwrap();
    f.store
        .read_with(|conn| conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>))
        .unwrap();
    assert_eq!(reads.load(Ordering::SeqCst), 0);
}

#[test]
fn fence_rechecks_reader_history_signal_before_writing() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
    let mut f = Fixture::new("original\n");
    let operation = f.fence_input();
    let before = binding_state(&f);
    let other = Connection::open(f.dir.join("engine.db")).unwrap();
    f.store
        .read_with(|conn| {
            conn.authorizer(Some(move |context: AuthContext<'_>| {
                if matches!(
                    context.action,
                    AuthAction::Transaction {
                        operation: TransactionOperation::Begin
                    }
                ) {
                    other
                        .execute(
                            "UPDATE live_accepted_reader_history SET may_have_reader=1",
                            [],
                        )
                        .unwrap();
                }
                Authorization::Allow
            }))
        })
        .unwrap();
    let result = f.owner.fence_restore(
        &mut f.store,
        None,
        operation.clone(),
        f.host.clone(),
        50,
        &NoFaults,
    );
    f.store
        .read_with(|conn| conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>))
        .unwrap();
    assert!(
        matches!(result, Err(ApplicationError::Interrupted)),
        "{result:?}"
    );
    assert_eq!(binding_state(&f), before);
    assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 0);
    // A conservative signal only adds preflight work; an honest retry still succeeds.
    f.owner
        .fence_restore(&mut f.store, None, operation, f.host.clone(), 51, &NoFaults)
        .unwrap();
}

#[test]
fn accepted_reader_signal_is_monotonic_and_unknown_history_stays_conservative() {
    let mut f = Fixture::new("original\n");
    let signal = |f: &Fixture| {
        f.store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT may_have_reader FROM live_accepted_reader_history",
                    [],
                    |r| r.get::<_, bool>(0),
                )
            })
            .unwrap()
    };
    assert!(!signal(&f));
    damage(&f, "CREATE TABLE reader_signal_writes(value INTEGER); CREATE TRIGGER reader_signal_write AFTER UPDATE ON live_accepted_reader_history BEGIN INSERT INTO reader_signal_writes VALUES(NEW.may_have_reader); END;");
    let writes = |f: &Fixture| {
        f.store
            .read_with(|conn| {
                conn.query_row("SELECT count(*) FROM reader_signal_writes", [], |r| {
                    r.get::<_, i64>(0)
                })
            })
            .unwrap()
    };
    let baseline = f.doc.encode_full_state();
    damage(&f, "DELETE FROM live_accepted_checkpoints");
    {
        let held = f.handle.registration.lock().unwrap();
        f.store
            .write_with(&NoFaults, |tx| {
                accepted_history::initialize(tx, &held, &baseline)
            })
            .unwrap();
    }
    assert_eq!(
        writes(&f),
        0,
        "a repeated checkpoint must not rewrite its signal"
    );
    f.edit("ordinary edit\n", 3);
    assert!(!signal(&f));
    assert_eq!(writes(&f), 0, "an unchanged signal must not write its page");
    f.edit("dohcMarkdownSourceReader\n", 4);
    assert!(signal(&f));
    assert_eq!(writes(&f), 1);
    f.edit("dohcMarkdownSourceReader repeated\n", 5);
    assert_eq!(
        writes(&f),
        1,
        "a repeated marker must not rewrite its signal"
    );
    f.edit("native again\n", 6);
    assert!(signal(&f));
    assert_eq!(writes(&f), 1, "a retained signal must not rewrite its page");
    damage(&f, "DELETE FROM live_accepted_reader_history");
    let held = f.handle.registration.lock().unwrap();
    assert!(f
        .store
        .read_with(|conn| accepted_history::may_have_reader(conn, &held))
        .unwrap());
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_history_signal_keeps_expired_points_on_preflight() {
    let (mut f, _) = reader_fixture();
    let signal = |f: &Fixture| {
        f.store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT may_have_reader FROM live_accepted_reader_history",
                    [],
                    |r| r.get::<_, bool>(0),
                )
            })
            .unwrap()
    };
    assert!(signal(&f));
    f.accept(f.doc.richdoc_append_paragraph("expired"), 3);
    assert!(signal(&f));
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_post_rename_point_does_not_require_the_old_head_artifact() {
    let (mut f, source) = reader_fixture();
    damage(&f, "UPDATE moments SET path='old.md'");
    let fresh_source = source + "\n";
    let config =
        serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
    let reader = dohc_engine_reader::Reader::new(Some(config));
    let mut result = None;
    crate::reader_resolver::tests::run(async {
        result = Some(
            reader
                .request(dohc_engine_reader::Request {
                    method: dohc_engine_reader::Method::Construct,
                    document: dohc_engine_reader::Document {
                        workspace_id: "workspace".into(),
                        main_version_id: "main".into(),
                        object_id: "object".into(),
                        lineage_claim_id: f.binding.lineage_claim_id.clone(),
                    },
                    current_path: "a.md".into(),
                    source: fresh_source.as_bytes().to_vec(),
                    checkpoint: f.doc.encode_full_state(),
                })
                .await,
        );
    });
    let result = result.unwrap().unwrap();
    let dohc_engine_reader::Outcome::Constructed { delta, .. } = result else {
        panic!("{result:?}");
    };
    f.doc.apply(&delta).unwrap();
    let point = f.accept(delta, 3);
    store_restore_artifact(&mut f, &fresh_source);
    let (bytes, original_source) = crate::reader_resolver::tests::original_baseline_case("valid");
    let original = Ydoc::wire();
    original.apply(&bytes).unwrap();
    let edit = f
        .doc
        .rewrite_richdoc_preserving_source_bounded(
            &original_source,
            &original,
            2_000_000,
            Some(2123456),
        )
        .unwrap();
    f.accept(edit, 4);
    let prep = f.freeze(NativeRestorePoint {
        markdown_digest: hex_sha256(fresh_source.as_bytes()),
        ..point
    });
    let proposal = reader_result(|| f.prepare(prep.clone())).unwrap();
    assert_eq!(proposal.reader_source(), Some(fresh_source.as_str()));
}

#[test]
fn native_points_do_not_need_an_artifact() {
    let mut f = Fixture::new("native original\n");
    let target = f.baseline_point.clone();
    f.edit("native later\n", 3);
    damage(&f, "DELETE FROM moments");
    f.freeze(target);
    assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 1);
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_partial_prefix_refuses_before_fencing() {
    impossible_prefix_refuses_before_fencing("partial");
}
#[test]
fn fence_authenticates_the_selected_history_receipt() {
    for field in ["cursor", "digest"] {
        let mut f = Fixture::new("native original\n");
        f.edit("later\n", 3);
        let mut operation = f.fence_input();
        if field == "cursor" {
            operation.point.journal_cursor = 3;
        } else {
            operation.point.receipt_digest = "f".repeat(64);
        }
        let before = binding_state(&f);
        assert!(
            matches!(
                f.owner
                    .fence_restore(&mut f.store, None, operation, f.host.clone(), 50, &NoFaults),
                Err(ApplicationError::Conflict)
            ),
            "{field}"
        );
        assert_eq!(binding_state(&f), before);
        assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 0);
    }
}

#[test]
fn native_accepted_append_avoids_reader_signal_sql() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let mut f = Fixture::new("native\n");
    let signal: bool = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT may_have_reader FROM live_accepted_reader_history",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(
        !signal,
        "a new native bootstrap must establish the shortcut"
    );
    f.store
        .read_with(|conn| {
            conn.authorizer(Some(|context: AuthContext<'_>| match context.action {
                AuthAction::Read {
                    table_name: "live_accepted_reader_history",
                    ..
                }
                | AuthAction::Insert {
                    table_name: "live_accepted_reader_history",
                }
                | AuthAction::Update {
                    table_name: "live_accepted_reader_history",
                    ..
                } => Authorization::Deny,
                _ => Authorization::Allow,
            }))
        })
        .unwrap();
    f.edit("native edit\n", 3);
    f.store
        .read_with(|conn| conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>))
        .unwrap();
    let signal: bool = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT may_have_reader FROM live_accepted_reader_history",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(!signal);
}
#[test]
fn prior_accepted_rows_cannot_establish_a_native_reader_shortcut() {
    for prior in ["checkpoint", "update"] {
        let mut f = Fixture::new("original\n");
        let baseline = f.doc.encode_full_state();
        if prior == "update" {
            f.edit("accepted native\n", 3);
            damage(&f, "DELETE FROM live_accepted_checkpoints");
        } else {
            damage(
                &f,
                "UPDATE live_accepted_checkpoints SET event_count=1,journal_cursor=1",
            );
        }
        damage(&f, "DELETE FROM live_accepted_reader_history");
        let held = f.handle.registration.lock().unwrap();
        f.store
            .write_with(&NoFaults, |tx| {
                accepted_history::initialize(tx, &held, &baseline)
            })
            .unwrap();
        assert!(
            f.store
                .read_with(|conn| accepted_history::may_have_reader(conn, &held))
                .unwrap(),
            "{prior}"
        );
    }
}

#[test]
fn accepted_reader_metadata_update_sets_the_history_signal() {
    let (bytes, source) = crate::reader_resolver::tests::original_baseline_case("valid");
    let reader = Ydoc::wire();
    reader.apply(&bytes).unwrap();
    let mut f = Fixture::new("native original\n");
    let delta = f
        .doc
        .rewrite_richdoc_preserving_source_bounded(&source, &reader, 2_000_000, Some(2123456))
        .unwrap();
    f.accept(delta, 3);
    let held = f.handle.registration.lock().unwrap();
    assert!(f
        .store
        .read_with(|conn| accepted_history::may_have_reader(conn, &held))
        .unwrap());
}

#[test]
fn pre_upgrade_lineage_rebuilds_the_selected_point_before_fencing() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let mut f = Fixture::new("original\n");
    let point = f.edit("selected\n", 3);
    f.edit("tip\n", 4);
    damage(&f, "DROP TABLE live_accepted_reader_history");
    f.store
        .read_with(|conn| {
            conn.execute_batch(include_str!(
                "../../../../dohc-engine-storage/src/accepted_reader_history.sql"
            ))
        })
        .unwrap();
    assert_eq!(
        f.store
            .table_row_count("live_accepted_reader_history")
            .unwrap(),
        0
    );
    let mut operation = f.fence_input();
    operation.point = NativeRestoreSelection {
        journal_cursor: point.journal_cursor,
        receipt_digest: point.receipt_digest,
    };
    let reads = Arc::new(AtomicUsize::new(0));
    let seen = reads.clone();
    f.store
        .read_with(|conn| {
            conn.authorizer(Some(move |context: AuthContext<'_>| {
                if matches!(
                    context.action,
                    AuthAction::Read {
                        table_name: "live_accepted_checkpoints",
                        column_name: "state_sha256",
                        ..
                    }
                ) {
                    seen.fetch_add(1, Ordering::SeqCst);
                }
                Authorization::Allow
            }))
        })
        .unwrap();
    f.owner
        .fence_restore(&mut f.store, None, operation, f.host.clone(), 50, &NoFaults)
        .unwrap();
    f.store
        .read_with(|conn| conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>))
        .unwrap();
    assert!(reads.load(Ordering::SeqCst) > 0);
}
