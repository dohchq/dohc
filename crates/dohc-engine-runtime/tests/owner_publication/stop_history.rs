use super::*;

async fn deliver_typed(
    handle: &dohc_engine_runtime::actor::ActorLiveApplicationHandle,
    binding: &dohc_engine_collab::LiveObjectBinding,
    bytes: &[u8],
    first_seen: (Vec<LiveUpdateStructRange>, Vec<LiveUpdateStructRange>),
) -> LiveUpdateReceipt {
    let receipt = LiveUpdateReceipt {
        delivery_id: "remote-1".into(),
        update_digest: hex_sha256(bytes),
        journal_cursor: 1,
        accepting_host_epoch: 1,
    };
    let update = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: receipt.clone(),
                binding: binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                },
                received_at_ms: 21,
            },
            first_seen: first_seen.0,
            canonical_version: Some(2),
            author_snapshot: Some(vec![owner_author()]),
            first_seen_deletes: Some(first_seen.1),
            checkpoint_coverage: None,
        },
        update_bytes: bytes.to_vec(),
    };
    let result = handle
        .apply(update, Arc::new(NoFaults), 100_000_000)
        .await
        .unwrap();
    assert!(
        matches!(result, ApplicationResult::Applied(..)),
        "{result:?}"
    );
    receipt
}

fn owner_author() -> LiveAuthorEntry {
    LiveAuthorEntry::Human {
        human_id: OWNER_PERSON.into(),
        human_name: "Owner Name".into(),
    }
}

async fn release_and_settle(
    actor: &ActorHandle,
    f: &Fixture,
) -> Result<(), dohc_engine_collab::OwnerOutboxError> {
    stop_action_at_cursor(actor, f, "release", 1).await?;
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let state = actor
        .ydoc_open_state(
            "workspace".into(),
            43,
            false,
            Some(key.clone()),
            "main".into(),
            f.binding.current_path.clone(),
            Some(ContentKind::Richdoc),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    actor
        .ydoc_settle(
            f.root.path().to_owned(),
            key,
            f.binding.current_path.clone(),
            ContentKind::Richdoc,
            Some(f.binding.lineage_claim_id.clone()),
            state.head_blob_sha256,
            "owner-live-stop".into(),
            Arc::new(()),
            44,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .unwrap();
    Ok(())
}

async fn release_at(
    actor: &ActorHandle,
    f: &Fixture,
    now_ms: i64,
) -> Result<
    Vec<dohc_engine_collab::owner_outbox::release::OwnerLiveStop>,
    dohc_engine_collab::OwnerOutboxError,
> {
    actor
        .owner_ydoc_stop(
            "workspace".into(),
            None,
            Some(f.binding.clone()),
            None,
            Some(1),
            None,
            Some(OWNER_PERSON.into()),
            "release".into(),
            now_ms,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn a_stop_before_the_relay_history_arrives_lists_the_words_once_under_their_author() {
    stop_before_the_relay_history(true).await;
}

#[tokio::test]
async fn a_stop_whose_relay_history_never_arrives_finishes_after_the_wait() {
    stop_before_the_relay_history(false).await;
}

async fn stop_before_the_relay_history(history_arrives: bool) {
    let (mut f, supervisor, actor) = pending_release_fixture(1).await;
    let host = Fixture::new();
    let host_actor = supervisor.open(&host.db, 3).unwrap().actor;
    support::configure_witness_reader(&host_actor, &host.root).await;
    let host_owner = host_actor
        .live_application_owner("workspace".into())
        .await
        .unwrap();
    let host_handle = host.adopt(&host_owner).await;
    let (outbox, delivery, digest): (String, String, String) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id,delivery_id,update_digest FROM owner_ydoc_outbox_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
        })
        .unwrap();
    let update = f.store.get_binary_blob(&digest).unwrap().unwrap();
    let accepted = Ydoc::wire();
    accepted.apply(&host.bytes).unwrap();
    let receipt = deliver_typed(
        &host_handle,
        &host.binding,
        &update,
        first_seen_for_test(&accepted, &update),
    )
    .await;
    let saved = host.settle(&host_handle, Some(receipt)).await;
    let (revision, head): (i64, i64) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT binding_revision,native_head_sequence FROM ydoc_owner_bindings",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    actor
        .owner_ydoc_apply_accepted(
            "workspace".into(),
            dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedFrameInput {
                binding: f.binding.clone(),
                relay_database_namespace: "relay".into(),
                expected_revision: revision,
                expected_native_head_sequence: head,
                previous_accepted_cursor: 0,
                journal_cursor: 1,
                update_bytes: update,
            },
            None,
            41,
            CancellationToken::new(),
            Arc::new(()),
        )
        .await
        .unwrap()
        .unwrap();
    actor
        .owner_ydoc_outbox_acknowledge(
            "workspace".into(),
            outbox,
            vec![dohc_engine_collab::OwnerDeliveryReceipt {
                delivery_id: delivery,
                update_digest: digest,
                journal_cursor: 1,
                accepting_host_epoch: 1,
            }],
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();

    let early = release_and_settle(&actor, &f).await;
    if !history_arrives {
        let wait = dohc_engine_collab::owner_outbox::release::RELAY_HISTORY_WAIT_MS;
        let late = release_at(&actor, &f, 40 + wait - 1).await.map(|_| ());
        for stop in [early, late] {
            assert!(
                matches!(
                    stop,
                    Err(dohc_engine_collab::OwnerOutboxError::StopConflict)
                ),
                "{stop:?}"
            );
        }
        release_at(&actor, &f, 40 + wait).await.unwrap();
        let bound: i64 = f
            .store
            .read_with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM ydoc_owner_bindings", [], |r| r.get(0))
            })
            .unwrap();
        assert_eq!(bound, 0);
        host_owner.close().await.unwrap();
        supervisor.close_all().unwrap();
        return;
    }

    let mut envelope = host
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT payload_json,recorded_at_ms FROM replication_log WHERE op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?1",
                [&saved.moment_id],
                |r| {
                    Ok(dohc_engine_sync::ReplicationEnvelope {
                        workspace_id: "workspace".into(),
                        origin_id: "host".into(),
                        origin_seq: 0,
                        relay_seq: Some(1),
                        op_kind: "moment.append".into(),
                        payload: serde_json::from_str(&r.get::<_, String>(0)?).unwrap(),
                        recorded_at_ms: r.get(1)?,
                        settlement_admission: Some(dohc_engine_sync::SettlementAdmission::Accepted {
                            settlement_id: saved.settlement_id.clone().unwrap(),
                        }),
                        admitted_author_snapshot: Some(serde_json::json!([owner_author()])),
                    })
                },
            )
        })
        .unwrap();
    envelope.payload.as_object_mut().unwrap().remove("authors");
    let blobs: Vec<(String, String)> = host
        .store
        .read_with(|conn| {
            let mut stmt = conn.prepare("SELECT sha256,text FROM blobs").unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    f.store
        .write_with(&NoFaults, |tx| {
            let record = envelope.payload["settlementReference"]["record"].to_string();
            for (digest, text) in &blobs {
                tx.execute(
                    "INSERT OR IGNORE INTO blobs(sha256,byte_length,text) VALUES(?1,?2,?3)",
                    rusqlite::params![digest, text.len() as i64, text],
                )
                .unwrap();
            }
            tx.execute(
                "INSERT INTO live_audit_settlements(settlement_id,workspace_id,record_digest,record_json,markdown_digest) VALUES(?1,'workspace',?2,?3,?4)",
                rusqlite::params![
                    saved.settlement_id,
                    hex_sha256(record.as_bytes()),
                    record,
                    envelope.payload["payloadAfterBlobSha256"].as_str().unwrap()
                ],
            )
            .unwrap();
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .unwrap();
    settled_apply(
        &mut f.store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &envelope,
        &NoFaults,
        &dohc_engine_sync::NoLiveLeases,
    )
    .unwrap();
    actor
        .materialize_relay_page(
            "workspace".into(),
            f.root.path().to_owned(),
            vec![dohc_engine_sync::MomentMaterializationChange {
                version_id: "main".into(),
                path: f.binding.current_path.clone(),
                operation: "write",
                content_kind: "text",
            }],
            Arc::new(()),
            42,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    release_and_settle(&actor, &f).await.unwrap();

    let typed: Vec<Option<String>> = f
        .store
        .read_with(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT m.author_json FROM moments m
                     JOIN blobs a ON a.sha256=m.after_blob_sha256
                     LEFT JOIN blobs b ON b.sha256=m.before_blob_sha256
                     WHERE m.object_id='object' AND instr(a.text,'Pending edit 0')>0
                       AND (b.text IS NULL OR instr(b.text,'Pending edit 0')=0)",
                )
                .unwrap();
            stmt.query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    assert_eq!(typed.len(), 1, "{typed:?}");
    let authors: serde_json::Value = serde_json::from_str(typed[0].as_deref().unwrap()).unwrap();
    assert_eq!(authors[0]["humanId"], OWNER_PERSON, "{authors}");
    assert_eq!(authors.as_array().unwrap().len(), 1, "{authors}");
    assert!(
        matches!(
            early,
            Err(dohc_engine_collab::OwnerOutboxError::StopConflict)
        ),
        "{early:?}"
    );
    host_owner.close().await.unwrap();
    supervisor.close_all().unwrap();
}
