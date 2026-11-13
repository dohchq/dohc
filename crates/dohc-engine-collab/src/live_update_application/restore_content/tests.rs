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

fn watch_fence_writes(f: &mut Fixture) -> Arc<std::sync::atomic::AtomicUsize> {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let writes = Arc::new(AtomicUsize::new(0));
    let seen = writes.clone();
    f.store
        .hooks_with(|conn| {
            conn.authorizer(Some(move |context: AuthContext<'_>| {
                if matches!(
                    context.action,
                    AuthAction::Insert {
                        table_name: "live_restore_fences"
                    }
                ) {
                    seen.fetch_add(1, Ordering::SeqCst);
                }
                Authorization::Allow
            }))
        })
        .unwrap();
    writes
}

fn stop_watching_fence_writes(f: &mut Fixture, writes: &std::sync::atomic::AtomicUsize) {
    use rusqlite::hooks::{AuthContext, Authorization};
    f.store
        .hooks_with(|conn| conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>))
        .unwrap();
    assert_eq!(
        writes.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "a pre-fence refusal must precede even a rolled-back fence write"
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
        let writes = watch_fence_writes(&mut f);
        let result = f.owner.fence_restore(
            &mut f.store,
            None,
            operation.clone(),
            f.host.clone(),
            90,
            &NoFaults,
            |_, _| Ok(()),
        );
        stop_watching_fence_writes(&mut f, &writes);
        if let Some(saved) = saved {
            assert_eq!(result.unwrap(), saved);
        } else {
            assert_refusal(result, &operation, "binding");
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
            &NoFaults,
            |_, _| Ok(()),
        ),
        Err(ApplicationError::Conflict)
    ));
    let saved = f.freeze(f.baseline_point.clone()).fence;
    let mut collision = saved.operation.clone();
    collision.point.receipt_digest = "f".repeat(64);
    assert!(matches!(
        f.owner.fence_restore(
            &mut f.store,
            None,
            collision,
            f.host.clone(),
            51,
            &NoFaults,
            |_, _| Ok(())
        ),
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
            &NoFaults,
            |_, _| Ok(()),
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
                &NoFaults,
                |_, _| Ok(()),
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
    let result = f.owner.fence_restore(
        &mut f.store,
        f.resolver.as_ref(),
        input,
        f.host.clone(),
        50,
        &NoFaults,
        |_, _| Ok(()),
    );
    assert_refusal(result, &expected_operation, case);
    assert_eq!(
        f.store.table_row_count("live_restore_fences").unwrap(),
        0,
        "{case}"
    );
    let after: String = f.store.read_with(|conn| conn.query_row(
        "SELECT json_array(current_path,lineage_claim_id,available,restore_fence_generation,host_id,host_epoch,instance_id,connection_id,selector_paths_json) FROM live_device_application_bindings", [], |row| row.get(0))).unwrap();
    assert_eq!(before, after, "{case}");
}

#[test]
#[ignore = "the Rust gate's reader phase runs it with DOHC_ENGINE_READER_CONFIG"]
fn reader_restore_no_reader_prefix_refuses_before_fencing() {
    impossible_prefix_refuses_before_fencing("no-reader");
}

#[test]
#[ignore = "the Rust gate's reader phase runs it with DOHC_ENGINE_READER_CONFIG"]
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
#[ignore = "the Rust gate's reader phase runs it with DOHC_ENGINE_READER_CONFIG"]
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
            settlement_id: settled.settlement_id.unwrap(),
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
#[ignore = "the Rust gate's reader phase runs it with DOHC_ENGINE_READER_CONFIG"]
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
                .settlement_id
                .unwrap();
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
        Ok(audit.result(Some(id),moment.into(),written.snapshot.blob_sha256,false))
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
        let mut store = dohc_engine_testkit::open_empty_store(&dir.join("engine.db"), 0);
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
                |_, _| Ok(()),
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

/// A waiting group the relay accepted before this computer saved its receipt
/// is restored row by row under each row's own delivery id, the id the relay's
/// restore check derives. Neither side finds an acceptance under a grouped
/// row's id, so each carries none, and the relay subtracts what the group
/// delivered. The head, delivered alone, keeps its acceptance as before.
#[test]
fn a_group_accepted_before_its_receipt_was_saved_restores_row_by_row() {
    use crate::owner_outbox::draft::{ObservedOwnerBinding, OwnerDraftAppendInput};
    let mut f = Fixture::new("# Before the group\n");
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
    let typed: Vec<_> = ["head", "second", "third"]
        .iter()
        .map(|text| {
            let update = f.doc.richdoc_append_paragraph(text);
            crate::owner_outbox::draft::append_draft_cached(
                &mut f.store,
                &mut WriterDocCache::new(),
                "workspace",
                OwnerDraftAppendInput {
                    person_edit: false,
                    binding: f.binding.clone(),
                    expected_revision: 1,
                    append_key: format!("typed-{text}"),
                    update,
                    now_ms: 10,
                    agent_declaration: None,
                    agent_run_id: None,
                    automation_declaration: None,
                },
                &NoFaults,
            )
            .unwrap()
        })
        .collect();
    let accept = |f: &mut Fixture, receipt: &LiveUpdateReceipt, update: Vec<u8>| {
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
            panic!("the owner's own delivery was refused")
        };
        f.sequence = ack.local_ydoc_sequence;
        f.terminal = Some(receipt.clone());
    };
    let outbox = typed[0].outbox_id.clone();
    let pending = |f: &Fixture| {
        crate::owner_outbox::read_pending(&f.store, "workspace", &outbox)
            .unwrap()
            .entries
    };
    let mut waiting = pending(&f);
    assert_eq!(
        waiting.len(),
        2,
        "the head goes alone and the two edits behind it as one delivery"
    );
    let (group, head) = (waiting.pop().unwrap(), waiting.pop().unwrap());
    assert_ne!(group.delivery_id, typed[1].delivery_id);
    // The relay accepts both; this computer saved neither receipt.
    let head_receipt = LiveUpdateReceipt {
        delivery_id: head.delivery_id.clone(),
        update_digest: head.update_digest.clone(),
        journal_cursor: 1,
        accepting_host_epoch: 1,
    };
    accept(&mut f, &head_receipt, head.update);
    let group_receipt = LiveUpdateReceipt {
        delivery_id: group.delivery_id.clone(),
        update_digest: group.update_digest.clone(),
        journal_cursor: 2,
        accepting_host_epoch: 1,
    };
    accept(&mut f, &group_receipt, group.update);
    let input = f.freeze(f.baseline_point.clone());
    let proposal = f.prepare(input).unwrap();
    let sources = &proposal.receipt().native_sources;
    assert_eq!(
        sources
            .iter()
            .map(|source| (source.outbox_sequence, source.delivery_id.as_str()))
            .collect::<Vec<_>>(),
        typed
            .iter()
            .map(|row| (row.sequence, row.delivery_id.as_str()))
            .collect::<Vec<_>>()
    );
    for (source, row) in sources.iter().zip(&typed) {
        assert_eq!(
            source.delivery_id,
            crate::owner_outbox::delivery_id(&outbox, row.sequence, &row.update_digest)
        );
    }
    // The head is found under its own id; a grouped row is not.
    assert_eq!(sources[0].accepted_receipt.as_ref(), Some(&head_receipt));
    assert!(sources[1..]
        .iter()
        .all(|source| source.accepted_receipt.is_none()));
    let restored = Ydoc::wire();
    restored.apply(proposal.frozen_state_bytes()).unwrap();
    restored.apply(proposal.candidate_bytes()).unwrap();
    let projection = restored.project(ContentKind::Richdoc).unwrap().content;
    assert_eq!(
        restored.preserved_markdown_source(&projection).unwrap(),
        "# Before the group\n"
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
            |_, _| Ok(()),
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
            |_, _| Ok(()),
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
                |_, _| Ok(()),
            )
            .unwrap();
        assert_eq!(receipt.operation, operation);
        assert_eq!(receipt.recorded_at_ms, if committed { 50 } else { 70 });
        assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 1);
        assert_eq!(f.canonical().encode_full_state(), bytes);
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
                &NoFaults,
                |_, _| Ok(()),
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
            &NoFaults,
            |_, _| Ok(()),
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
            |_, _| Ok(()),
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
                &NoFaults,
                |_, _| Ok(()),
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
            &NoFaults,
            |_, _| Ok(()),
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
            |_, _| Ok(()),
        )
        .unwrap();
    assert_eq!(fences(&f), 1);
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
                settlement_id: restored.settlement_id.clone().unwrap(),
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
        settlement_id: settlement.settlement_id.unwrap(),
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
        settlement_id: settlement.settlement_id.unwrap(),
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
            settlement_id: settlement.settlement_id.unwrap(),
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
#[test]
#[ignore = "the Rust gate's reader phase runs it with DOHC_ENGINE_READER_CONFIG"]
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
                |_, _| Ok(()),
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
fn binding_state(f: &Fixture) -> String {
    f.store.read_with(|conn| conn.query_row("SELECT json_array(current_path,lineage_claim_id,available,restore_fence_generation,host_id,host_epoch,instance_id,connection_id,selector_paths_json) FROM live_device_application_bindings", [], |row| row.get(0))).unwrap()
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
                f.owner.fence_restore(
                    &mut f.store,
                    None,
                    operation,
                    f.host.clone(),
                    50,
                    &NoFaults,
                    |_, _| Ok(())
                ),
                Err(ApplicationError::Conflict)
            ),
            "{field}"
        );
        assert_eq!(binding_state(&f), before);
        assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 0);
    }
}
