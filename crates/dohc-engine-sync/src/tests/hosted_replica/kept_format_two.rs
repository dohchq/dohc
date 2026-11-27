use super::*;
use dohc_engine_collab::DocKey;
use dohc_engine_collab::ydoc::reading_body_sequence_here;
use rusqlite::OptionalExtension;

fn ydoc_row(
    feed: &HostedFeed,
    (origin, seq): (&str, i64),
    (object_id, path): (&str, &str),
    bytes: Vec<u8>,
    claim: &str,
) {
    let sha = dohc_engine_storage::hex_sha256(&bytes);
    feed.blobs.lock().unwrap().insert(sha.clone(), bytes);
    feed.append(envelope(
        origin,
        seq,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": object_id,
            "path": path,
            "contentKind": "richdoc",
            "updateBlobSha256": sha,
            "lineageClaimId": claim,
            "isBaseState": sha == claim
        }),
    ));
}

fn format_two_note(feed: &HostedFeed, seq: (i64, i64), object_id: &str, path: &str) {
    let note = dohc_engine_collab::ydoc::format_two_note_for_test("A note.\n");
    let base = note.encode_full_state();
    let claim = dohc_engine_storage::hex_sha256(&base);
    let edit = crate::moment_apply_tests::format_two_sequence_edit(&note, 7, "z");
    let (owner, writer) = seq;
    ydoc_row(feed, ("owner", owner), (object_id, path), base, &claim);
    feed.create("owner", owner + 1, object_id, path, "A note.\n");
    ydoc_row(feed, ("writer", writer), (object_id, path), edit, &claim);
}

fn kept_of(store: &EngineStore, object_id: &str) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_refused_ydoc_blobs k \
                 JOIN replication_log l USING (workspace_id, origin_id, origin_seq) \
                 WHERE json_extract(l.payload_json,'$.objectId')=?1",
                [object_id],
                |row| row.get(0),
            )
        })
        .unwrap()
}

fn replay_reading(store: &mut EngineStore) -> usize {
    reading_body_sequence_here(|| {
        crate::replay_kept_format_two(store, &mut WriterDocCache::new(), &NoFaults)
    })
    .expect("the replay goes on")
}

fn note_text(store: &EngineStore, object_id: &str) -> String {
    reading_body_sequence_here(|| {
        let key = DocKey::new("ws", "main", object_id).unwrap();
        dohc_engine_collab::load_persisted(store, &key)
            .unwrap()
            .unwrap()
            .doc
            .project(dohc_engine_collab::ContentKind::Richdoc)
            .unwrap()
            .content
    })
}

fn sequence_text(store: &EngineStore, sha: &str) -> String {
    use yrs::updates::decoder::Decode;
    use yrs::{GetString, Transact};
    let bytes = store.get_binary_blob(sha).unwrap().unwrap();
    let raw = yrs::Doc::new();
    let sequence = raw.get_or_insert_text(dohc_engine_collab::ydoc::ROOT_SEQUENCE);
    raw.transact_mut()
        .apply_update(yrs::Update::decode_v1(&bytes).unwrap())
        .unwrap();
    sequence.get_string(&raw.transact())
}

fn reading_sync(client: &RelaySyncClient<HostedFeed>, store: &mut EngineStore) {
    reading_body_sequence_here(|| {
        for _ in 0..64 {
            let outcome = pass(client, store, &NoFaults).unwrap();
            let freed = outcome.pending_cursor.as_ref().is_some_and(|pending| {
                let released = ReleasedTails::uncached();
                match client
                    .commit_hosted_cursor(store, "ws", pending, &released, &NoFaults)
                    .unwrap()
                {
                    TxnOutcome::Committed(commit) => commit.has_more,
                    TxnOutcome::Crashed { .. } => panic!("no fault was injected"),
                }
            });
            if !outcome.has_more && !freed {
                return;
            }
        }
        panic!("the hosted replica did not catch up");
    });
}

fn kept_reasons(store: &EngineStore, origin: &str) -> Vec<Option<String>> {
    store
        .read_with(|conn| -> rusqlite::Result<Vec<Option<String>>> {
            conn.prepare(
                "SELECT reason FROM replication_refused_ydoc_blobs WHERE origin_id=?1 \
                 ORDER BY origin_seq",
            )?
            .query_map([origin], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()
        })
        .unwrap()
}

fn refusal_of(store: &EngineStore, origin: &str) -> Option<String> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT reason_message FROM replication_pending_refusals WHERE origin_id=?1",
                [origin],
                |row| row.get(0),
            )
            .optional()
        })
        .unwrap()
}

fn stray_edit(note: &dohc_engine_collab::Ydoc) -> Vec<u8> {
    use yrs::updates::decoder::Decode;
    use yrs::{ReadTxn, Transact, XmlFragment};
    let other = yrs::Doc::with_client_id(7);
    other
        .transact_mut()
        .apply_update(yrs::Update::decode_v1(&note.encode_full_state()).unwrap())
        .unwrap();
    let before = other.transact().state_vector();
    other
        .get_or_insert_xml_fragment(dohc_engine_collab::ydoc::ROOT_BODY)
        .insert(
            &mut other.transact_mut(),
            0,
            yrs::XmlTextPrelim::new("Typed"),
        );
    other.transact().encode_state_as_update_v1(&before)
}

fn active_claim(store: &EngineStore) -> Option<String> {
    let key = DocKey::new("ws", "main", "doc-a").unwrap();
    dohc_engine_collab::read_marker(store, &key)
        .unwrap()
        .and_then(|marker| marker.lineage_claim_id)
}

#[test]
fn a_hosted_replica_replays_the_kept_format_two_rows_of_its_documents_in_scope() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    format_two_note(&feed, (1, 0), "doc-a", "a.md");
    format_two_note(&feed, (3, 1), "doc-b", "b.md");
    feed.share("doc-a", "a.md");
    feed.share("doc-b", "b.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    assert_eq!((kept_of(&store, "doc-a"), kept_of(&store, "doc-b")), (2, 2));
    client.transport().unshare("doc-b");
    sync(&client, &mut store);
    assert_eq!(replay_reading(&mut store), 0);
    assert!(!ready(&store, "doc-a"));
    reading_body_sequence_here(|| sync(&client, &mut store));
    assert_eq!((kept_of(&store, "doc-a"), kept_of(&store, "doc-b")), (0, 2));
    assert!(ready(&store, "doc-a"));
    let text = note_text(&store, "doc-a");
    assert!(text.contains('z'), "{text}");
    let commits = store.commit_count_for_harness();
    assert_eq!(replay_reading(&mut store), 0);
    assert_eq!(store.commit_count_for_harness(), commits);
    assert!(ready(&store, "doc-a"));
}

fn archived_note_with(
    edit: impl FnOnce(&dohc_engine_collab::Ydoc) -> Vec<u8>,
) -> (
    ScratchDir,
    std::path::PathBuf,
    EngineStore,
    RelaySyncClient<HostedFeed>,
    String,
) {
    let (scratch, path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    let note = dohc_engine_collab::ydoc::format_two_note_for_test("A note.\n");
    let base = note.encode_full_state();
    let claim = dohc_engine_storage::hex_sha256(&base);
    ydoc_row(&feed, ("owner", 1), ("doc-a", "a.md"), base, &claim);
    feed.create("owner", 2, "doc-a", "a.md", "A note.\n");
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    reading_body_sequence_here(|| sync(&client, &mut store));
    let key = DocKey::new("ws", "main", "doc-a").unwrap();
    let vector = dohc_engine_storage::hex_sha256(&note.encode_state_vector());
    reading_body_sequence_here(|| {
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_collab::archive_active_lineage_in_tx(
                    tx,
                    &key,
                    &claim,
                    &vector,
                    Some(&dohc_engine_storage::hex_sha256(b"A note.\n")),
                    2,
                )
            })
            .unwrap()
    });
    let replacement = dohc_engine_collab::Ydoc::wire();
    replacement
        .rewrite_content_to_markdown(dohc_engine_collab::ContentKind::Richdoc, "Head.\n")
        .unwrap();
    let replacement = replacement.encode_full_state();
    let replacement_claim = dohc_engine_storage::hex_sha256(&replacement);
    let feed = client.transport();
    ydoc_row(
        feed,
        ("replacement", 0),
        ("doc-a", "a.md"),
        replacement,
        &replacement_claim,
    );
    ydoc_row(feed, ("writer", 0), ("doc-a", "a.md"), edit(&note), &claim);
    (scratch, path, store, client, claim)
}

#[test]
fn a_hosted_replica_replays_a_kept_edit_onto_its_archived_note() {
    let edit = |note: &dohc_engine_collab::Ydoc| {
        crate::moment_apply_tests::format_two_sequence_edit(note, 7, "z")
    };
    let (_always_scratch, _always_path, mut always, reading, _) = archived_note_with(edit);
    reading_sync(&reading, &mut always);
    let (_scratch, _path, mut store, client, claim) = archived_note_with(edit);
    sync(&client, &mut store);
    assert_eq!(kept_of(&store, "doc-a"), 1);
    assert_eq!(replay_reading(&mut store), 0);
    reading_body_sequence_here(|| sync(&client, &mut store));
    let refused = refusal_of(&always, "writer");
    assert_eq!(refusal_of(&store, "writer"), refused);
    assert_eq!(
        kept_reasons(&store, "writer"),
        refused.into_iter().map(Some).collect::<Vec<_>>()
    );
    assert_eq!(
        count(&store, "SELECT COUNT(*) FROM ydoc_deferred_updates"),
        0
    );
    let archived: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT full_state_blob_sha256 FROM ydoc_inactive_lineages \
                 WHERE object_id='doc-a' AND lineage_claim_id=?1",
                [&claim],
                |row| row.get(0),
            )
        })
        .unwrap();
    let text = sequence_text(&store, &archived);
    assert!(text.contains('z'), "{text}");
    assert!(ready(&store, "doc-a"));
}

#[test]
fn a_kept_edit_the_archived_drain_refuses_stays_kept_on_a_hosted_replica() {
    let (_scratch, _path, mut store, client, _) = archived_note_with(stray_edit);
    sync(&client, &mut store);
    assert_eq!(kept_of(&store, "doc-a"), 1);
    replay_reading(&mut store);
    reading_sync(&client, &mut store);
    let stray = "ydoc-update-outside-format-two-roots";
    assert_eq!(kept_reasons(&store, "writer"), [Some(stray.to_owned())]);
    assert_eq!(refusal_of(&store, "writer").as_deref(), Some(stray));
}

#[test]
fn a_hosted_edit_read_before_its_kept_base_applies_once_the_base_replays() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    let note = dohc_engine_collab::ydoc::format_two_note_for_test("A note.\n");
    let base = note.encode_full_state();
    let claim = dohc_engine_storage::hex_sha256(&base);
    let edit = crate::moment_apply_tests::format_two_sequence_edit(&note, 7, "z");
    ydoc_row(&feed, ("writer", 0), ("doc-a", "a.md"), edit, &claim);
    ydoc_row(&feed, ("owner", 1), ("doc-a", "a.md"), base, &claim);
    feed.create("owner", 2, "doc-a", "a.md", "A note.\n");
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    assert_eq!(kept_of(&store, "doc-a"), 2);
    replay_reading(&mut store);
    reading_sync(&client, &mut store);
    assert_eq!(kept_of(&store, "doc-a"), 0);
    let text = note_text(&store, "doc-a");
    assert_eq!(text.matches('z').count(), 1, "{text}");
    assert!(ready(&store, "doc-a"));
}

#[test]
fn a_kept_base_of_a_returning_note_waits_while_another_spelling_holds_its_path() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    format_two_note(&feed, (1, 0), "doc-a", "a.md");
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync_parking(&client, &mut store);
    assert_eq!(kept_of(&store, "doc-a"), 2);
    let feed = client.transport();
    feed.unshare("doc-a");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-a"));
    feed.create("owner", 10, "doc-c", "A.md", "Other.\n");
    feed.share("doc-c", "A.md");
    sync_parking(&client, &mut store);
    feed.share("doc-a", "a.md");
    replay_reading(&mut store);
    reading_body_sequence_here(|| sync_parking(&client, &mut store));
    assert_eq!(kept_of(&store, "doc-a"), 2);
    assert!(hold(&store, "doc-a").is_some());
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM snapshots WHERE object_id='doc-a'"
        ),
        0
    );
    feed.unshare("doc-c");
    reading_body_sequence_here(|| sync_parking(&client, &mut store));
    reading_body_sequence_here(|| sync_parking(&client, &mut store));
    assert!(ready(&store, "doc-a"));
    assert_eq!(kept_of(&store, "doc-a"), 0);
    let text = note_text(&store, "doc-a");
    assert!(text.contains('z'), "{text}");
}

#[test]
fn a_kept_base_past_the_text_cap_refuses_its_claim_and_the_edit_after_it() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    let (base, later) = reading_body_sequence_here(|| {
        let note = dohc_engine_collab::ydoc::format_two_note_for_test("A note.\n");
        note.apply(&crate::moment_apply_tests::format_two_sequence_edit(
            &note,
            9,
            &"x".repeat(MAX_TEXT_BYTES),
        ))
        .unwrap();
        (
            note.encode_full_state(),
            crate::moment_apply_tests::format_two_sequence_edit(&note, 13, "q"),
        )
    });
    let claim = dohc_engine_storage::hex_sha256(&base);
    ydoc_row(&feed, ("owner", 1), ("doc-a", "a.md"), base, &claim);
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    assert_eq!(kept_of(&store, "doc-a"), 1);
    replay_reading(&mut store);
    reading_sync(&client, &mut store);
    let reasons = kept_reasons(&store, "owner");
    let [Some(reason)] = reasons.as_slice() else {
        panic!("{reasons:?}");
    };
    assert_ne!(reason, crate::ydoc_apply::NEWER_BODY_FORMAT);
    assert_eq!(refusal_of(&store, "owner").as_ref(), Some(reason));
    ydoc_row(
        client.transport(),
        ("writer", 0),
        ("doc-a", "a.md"),
        later,
        &claim,
    );
    reading_sync(&client, &mut store);
    assert_eq!(
        count(&store, "SELECT COUNT(*) FROM ydoc_deferred_updates"),
        0
    );
    assert_eq!(refusal_of(&store, "writer").as_ref(), Some(reason));
}

#[test]
fn a_replayed_base_of_another_document_does_not_rewind_this_one() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    let note = dohc_engine_collab::ydoc::format_two_note_for_test("A note.\n");
    let base = note.encode_full_state();
    let claim = dohc_engine_storage::hex_sha256(&base);
    let edit = crate::moment_apply_tests::format_two_sequence_edit(&note, 7, "z");
    ydoc_row(&feed, ("writer", 0), ("doc-a", "a.md"), edit, &claim);
    ydoc_row(&feed, ("owner", 1), ("doc-a", "a.md"), base.clone(), &claim);
    ydoc_row(&feed, ("other", 0), ("doc-b", "b.md"), base, &claim);
    feed.share("doc-a", "a.md");
    feed.share("doc-b", "b.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    assert_eq!((kept_of(&store, "doc-a"), kept_of(&store, "doc-b")), (2, 1));
    let retry = store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE replication_refused_ydoc_blobs SET replayed=1 WHERE origin_id='other'",
                [],
            )
            .map_err(SyncError::persist)?;
            crate::kept_replay::hosted_retry_in_tx(tx, "ws", "doc-a", 100)
        })
        .unwrap();
    let TxnOutcome::Committed(retry) = retry else {
        panic!("no fault was injected");
    };
    assert_eq!(retry, None);
}

fn resolution_after(
    probe: &mut EngineStore,
    claim: &str,
) -> (Vec<ReplicationEnvelope>, Vec<Vec<u8>>, String) {
    use crate::conflict_resolve_v1::{
        ConflictResolveV1, EffectContextV1, EffectKindV1, EffectV1, HeadContentKindV1, HeadV1,
        LineageTransitionV1, MetadataV1, PresentHeadV1, ResolutionV1, ResolveChoiceV1,
        SuccessorContentKindV1, SuccessorV1, build_conflict_resolve_v1,
    };
    use dohc_engine_collab::{SuccessorIdentity, SuccessorIdentityInput, fresh_successor_base};
    let hex = dohc_engine_storage::hex_sha256;
    let key = DocKey::new("ws", "main", "doc-a").unwrap();
    let created: i64 = probe
        .read_with(|conn| {
            conn.query_row(
                "SELECT created_at_ms FROM file_objects WHERE object_id='doc-a'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    let (vector, deletes) = reading_body_sequence_here(|| {
        let doc = dohc_engine_collab::load_persisted(probe, &key)
            .unwrap()
            .unwrap()
            .doc;
        (
            hex(&doc.encode_state_vector()),
            hex(&doc.encode_delete_set()),
        )
    });
    let head = dohc_engine_domain::VersionedTextStore::new(probe)
        .read_text("ws", "main", "a.md")
        .unwrap()
        .unwrap();
    let resolved = "resolved text";
    let result_sha = hex(resolved.as_bytes());
    let identity = SuccessorIdentity::derive_with_schema_version(
        SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: claim,
            predecessor_state_vector_sha256: &vector,
            artifact_op_kind: "conflict.resolve",
            artifact_id: "conflict-1",
            artifact_preimage_sha256: &head.blob_sha256,
            content_kind: dohc_engine_collab::ContentKind::Richdoc,
            result_sha256: &result_sha,
        },
        2,
    );
    let successor =
        reading_body_sequence_here(|| fresh_successor_base(&identity, resolved)).unwrap();
    let present = |moment: &str, sha: &str, length: usize, updated_at_ms| {
        HeadV1::Present(PresentHeadV1 {
            path_ref: 0,
            object_id: "doc-a".to_owned(),
            latest_moment_id: moment.to_owned(),
            content_kind: HeadContentKindV1::Text,
            blob_sha256: sha.to_owned(),
            byte_length: length as i64,
            updated_at_ms,
        })
    };
    let result = present("moment-result", &result_sha, resolved.len(), 3_000);
    let built = build_conflict_resolve_v1(ConflictResolveV1 {
        workspace_id: "ws".to_owned(),
        conflict_id: "conflict-1".to_owned(),
        chosen_from: ResolveChoiceV1::Incoming,
        resolution: ResolutionV1::AppliedIncoming,
        target_version_id: "main".to_owned(),
        source_version_id: "peer".to_owned(),
        paths: vec!["a.md".to_owned()],
        current: present(
            &head.latest_moment_id,
            &head.blob_sha256,
            head.text.len(),
            head.updated_at_ms,
        ),
        incoming: result.clone(),
        result,
        effect_context: EffectContextV1 {
            recorded_at_ms: 3_000,
            metadata: MetadataV1 {
                origin: "sync".to_owned(),
                summary: None,
                correlation_id: None,
            },
            author: None,
            current_object_created_at_ms: Some(created),
            result_object_created_at_ms: Some(created),
        },
        effects: vec![EffectV1 {
            kind: EffectKindV1::Write,
            moment_id: "moment-result".to_owned(),
            payload_sha256: String::new(),
        }],
        exported_before: None,
        lineage_transition: Some(LineageTransitionV1 {
            predecessor_claim_id: claim.to_owned(),
            predecessor_state_vector_sha256: vector,
            predecessor_delete_set_sha256: deletes,
            artifact_preimage_sha256: head.blob_sha256.clone(),
            successor: Some(SuccessorV1 {
                lineage_claim_id: successor.lineage_claim_id.clone(),
                epoch_tag: successor.epoch_tag.clone(),
                content_kind: SuccessorContentKindV1::Richdoc,
                result_sha256: result_sha,
                update_blob_sha256: hex(&successor.update),
                state_vector_blob_sha256: hex(&successor.state_vector),
            }),
        }),
    })
    .unwrap();
    let mut parent = envelope("owner", 2, "conflict.resolve", built.value.clone());
    parent.recorded_at_ms = 3_000;
    let mut child = envelope(
        "owner",
        3,
        "moment.append",
        built.validated.shadows[0].clone(),
    );
    child.recorded_at_ms = 3_000;
    let blobs = vec![
        successor.update.clone(),
        successor.state_vector.clone(),
        resolved.as_bytes().to_vec(),
        head.text.as_bytes().to_vec(),
    ];
    (vec![parent, child], blobs, successor.lineage_claim_id)
}

#[test]
fn a_kept_resolution_after_a_skipped_edit_and_its_base_installs_its_successor() {
    let note = dohc_engine_collab::ydoc::format_two_note_for_test("A note.\n");
    let base = note.encode_full_state();
    let claim = dohc_engine_storage::hex_sha256(&base);
    let edit = crate::moment_apply_tests::format_two_sequence_edit(&note, 7, "z");
    let client_with = |ops: &[ReplicationEnvelope], blobs: &[Vec<u8>]| {
        let feed = HostedFeed::new();
        feed.append(envelope("owner", 0, "workspace.init", json!({})));
        ydoc_row(
            &feed,
            ("writer", 0),
            ("doc-a", "a.md"),
            edit.clone(),
            &claim,
        );
        ydoc_row(&feed, ("owner", 1), ("doc-a", "a.md"), base.clone(), &claim);
        for bytes in blobs {
            let sha = dohc_engine_storage::hex_sha256(bytes);
            feed.blobs.lock().unwrap().insert(sha, bytes.clone());
        }
        for op in ops {
            feed.append(op.clone());
        }
        feed.share("doc-a", "a.md");
        RelaySyncClient::new(feed)
    };
    let (_probe_scratch, _probe_path, mut probe) = hosted_store();
    reading_sync(&client_with(&[], &[]), &mut probe);
    let (ops, blobs, successor) = resolution_after(&mut probe, &claim);
    let (_always_scratch, _always_path, mut always) = hosted_store();
    reading_sync(&client_with(&ops, &blobs), &mut always);
    assert_eq!(active_claim(&always), Some(successor.clone()));
    let (_scratch, _path, mut store) = hosted_store();
    let client = client_with(&ops, &blobs);
    sync(&client, &mut store);
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM replication_refused_ydoc_blobs"
        ),
        3
    );
    replay_reading(&mut store);
    reading_sync(&client, &mut store);
    assert_eq!(active_claim(&store), Some(successor));
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM replication_refused_ydoc_blobs"
        ),
        0
    );
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM ydoc_inactive_lineages WHERE disposition='conflicting-successor'"
        ),
        0
    );
}

#[test]
fn a_kept_base_of_a_renamed_note_replays_while_another_note_takes_its_old_spelling() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    format_two_note(&feed, (1, 0), "doc-a", "a.md");
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    assert_eq!(kept_of(&store, "doc-a"), 2);
    let feed = client.transport();
    feed.rename(
        "owner",
        3,
        "doc-a",
        "a.md",
        "b.md",
        "A note.\n",
        "moment-owner-2",
    );
    feed.share("doc-a", "b.md");
    sync(&client, &mut store);
    feed.create("owner", 4, "doc-c", "A.md", "Other.\n");
    feed.share("doc-c", "A.md");
    sync(&client, &mut store);
    replay_reading(&mut store);
    reading_sync(&client, &mut store);
    assert_eq!(kept_of(&store, "doc-a"), 0);
    assert!(ready(&store, "doc-a"));
    let text = note_text(&store, "doc-a");
    assert!(text.contains('z'), "{text}");
}
