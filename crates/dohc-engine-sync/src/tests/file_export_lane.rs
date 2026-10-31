use super::*;
use dohc_engine_collab::live_update_application::ReleasedTails;
use dohc_engine_collab::{ContentKind, DocKey, LocalAppend, WriterDocCache, Ydoc};
use dohc_engine_domain::WriteText;

fn owner() -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let (scratch, path, mut store) = open_store();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1, &NoFaults)
        .unwrap();
    adopt_join_identity(
        &mut store, "ws", "local", "epoch-1", "stream-1", 1, &NoFaults,
    )
    .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO sync_relay_push_state VALUES ('ws','local',-1)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    (scratch, path, store)
}

fn write(
    store: &mut EngineStore,
    object: &str,
    id: &str,
    path: &str,
    text: &str,
    origin: &str,
    now: i64,
) {
    VersionedTextStore::new(store)
        .write_text(
            &WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: object.into(),
                moment_id: id.into(),
                path: path.into(),
                text: text.into(),
                metadata_origin: origin.into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: now,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
}

fn lane(store: &mut EngineStore, object: &str) {
    store.write_with(&NoFaults,|tx| {
        tx.execute("INSERT INTO ydoc_docs(workspace_id,version_id,object_id,content_kind,regime,lineage_claim_status,updated_at_ms,file_export_lane,path) VALUES ('ws','main',?1,'plaintext','local-only','unclaimed',1,1,?2)",params![object,format!("{object}.md")]).map_err(SyncError::persist)?;
        Ok::<_,SyncError>(())
    }).unwrap();
}
fn drain(store: &mut EngineStore) {
    assert_eq!(
        store
            .write_with(&NoFaults, |tx| {
                crate::enrolment::backfill_file_versions_in_tx(tx, "ws")
            })
            .unwrap(),
        TxnOutcome::Committed(())
    );
}
fn exports(store: &EngineStore) -> Vec<ReplicationEnvelope> {
    store.read_with(|conn| {
        let mut s=conn.prepare("SELECT origin_id,origin_seq,payload_json,recorded_at_ms FROM replication_log WHERE imported=0 AND op_kind='moment.append' ORDER BY rowid")?;
        s.query_map([],|r|Ok(ReplicationEnvelope { settlement_admission: None, admitted_author_snapshot: None, workspace_id:"ws".into(),origin_id:r.get(0)?,origin_seq:r.get(1)?,op_kind:"moment.append".into(),payload:serde_json::from_str(&r.get::<_,String>(2)?).unwrap(),recorded_at_ms:r.get(3)?,relay_seq:None}))?.collect::<Result<_,_>>()
    }).unwrap()
}
fn hydrate(from: &EngineStore, to: &mut EngineStore) {
    let blobs: Vec<(String, i64, String)> = from
        .read_with(|c| {
            c.prepare("SELECT sha256,byte_length,text FROM blobs")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<_, _>>()
        })
        .unwrap();
    to.write_with(&NoFaults, |tx| {
        for (sha, len, text) in blobs {
            tx.execute(
                "INSERT OR IGNORE INTO blobs VALUES (?1,?2,?3)",
                params![sha, len, text],
            )
            .map_err(SyncError::persist)?;
        }
        Ok::<_, SyncError>(())
    })
    .unwrap();
}
fn count(store: &EngineStore, table: &str) -> i64 {
    store
        .read_with(|c| c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)))
        .unwrap()
}
fn apply(store: &mut EngineStore, op: &ReplicationEnvelope) {
    let result = apply_moment_envelope(
        store,
        op,
        &NoFaults,
        &NoLiveLeases,
        &ReleasedTails::default(),
    )
    .unwrap();
    let ApplyDisposition::Applied(result) = result.primary else {
        panic!("{result:?}")
    };
    assert_eq!(
        result, 0,
        "moment {} opened a conflict",
        op.payload["momentId"]
    );
}

fn unsynced_settle_then_ordinary_publication(operation: &str) {
    for flag in [1, 2] {
        let (_scratch, _, mut source) = owner();
        write(&mut source, "doc", "v1", "doc.md", "exported", "ydoc", 10);
        lane(&mut source, "doc");
        drain(&mut source);
        source
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE ydoc_docs SET file_export_lane=?1", [flag])
                    .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .unwrap();
        write(&mut source, "doc", "v2", "doc.md", "owner-only", "ydoc", 20);
        if operation == "delete" {
            VersionedTextStore::new(&mut source)
                .delete_text_file(
                    &DeleteTextFile {
                        workspace_id: "ws".into(),
                        version_id: "main".into(),
                        path: "doc.md".into(),
                        moment_id: "outside".into(),
                        request_id: None,
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 30,
                    },
                    &NoFaults,
                )
                .unwrap();
        } else if operation == "rename" {
            VersionedTextStore::new(&mut source)
                .rename_text_file(
                    &RenameTextFile {
                        workspace_id: "ws".into(),
                        version_id: "main".into(),
                        from_path: "doc.md".into(),
                        to_path: "renamed.md".into(),
                        moment_id: "outside".into(),
                        request_id: None,
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 30,
                    },
                    &NoFaults,
                )
                .unwrap();
        } else {
            write(
                &mut source,
                "doc",
                "outside",
                "doc.md",
                "outside edit",
                "api",
                30,
            );
        }
        source
            .write_with(&NoFaults, |tx| {
                journal_moment_append_in_tx(tx, "ws", "outside")
            })
            .unwrap();
        let all = exports(&source);
        assert_eq!(all.len(), 2, "the intermediate settle stays owner-only");
        let (_peer_scratch, _, mut peer) = open_store();
        seed_replication_version(&mut peer, "main", "main");
        adopt_join_identity(
            &mut peer,
            "ws",
            "recipient",
            "epoch-1",
            "stream-1",
            1,
            &NoFaults,
        )
        .unwrap();
        hydrate(&source, &mut peer);
        for op in &all {
            apply(&mut peer, op);
        }
        assert_eq!(count(&peer, "conflicts"), 0);
        assert_eq!(all[1].payload["beforeLatestMomentId"], "v1");
        let local_before: String = source
            .read_with(|conn| {
                conn.query_row(
                    "SELECT before_latest_moment_id FROM moments WHERE moment_id='outside'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(local_before, "v2", "owner rollback keeps the real preimage");
    }
}

#[test]
fn lane_outside_write_after_unsynced_settle_uses_the_exported_preimage() {
    unsynced_settle_then_ordinary_publication("write");
}

#[test]
fn lane_delete_after_unsynced_settle_uses_the_exported_preimage() {
    unsynced_settle_then_ordinary_publication("delete");
}

#[test]
fn lane_rename_after_unsynced_settle_uses_the_exported_preimage() {
    unsynced_settle_then_ordinary_publication("rename");
}

#[test]
fn retired_lane_restore_blocked_reopen_settle_then_write_uses_the_exported_preimage() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "v1", "doc.md", "exported", "ydoc", 10);
    lane(&mut source, "doc");
    drain(&mut source);
    VersionedTextStore::new(&mut source)
        .delete_text_file(
            &DeleteTextFile {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                path: "doc.md".into(),
                moment_id: "deleted".into(),
                request_id: None,
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 20,
            },
            &NoFaults,
        )
        .unwrap();
    source
        .write_with(&NoFaults, |tx| {
            journal_moment_append_in_tx(tx, "ws", "deleted")
        })
        .unwrap();
    VersionedTextStore::new(&mut source)
        .rollback_text_file_mutation(
            &dohc_engine_domain::RollbackTextFileMutation {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                path: "doc.md".into(),
                mutation_moment_id: "deleted".into(),
                metadata_origin: "restore".into(),
                author_json: None,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    let restored = dohc_engine_domain::rollback_compensating_moment_id("ws", "main", "deleted");
    source
        .write_with(&NoFaults, |tx| {
            journal_moment_append_in_tx(tx, "ws", &restored)
        })
        .unwrap();
    let key = DocKey::new("ws", "main", "doc").unwrap();
    fresh_seed(&mut source, &key, "exported");
    source.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO ydoc_deferred_updates(workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms) VALUES ('ws','main','doc','peer',0,30)", []).map_err(SyncError::persist)?;
        assert_eq!(originate_ydoc_base_in_tx(tx, &key, "doc.md", None, None, 30)?, BaseOrigination::NothingToDo);
        Ok::<_, SyncError>(())
    }).unwrap();
    assert_eq!(
        dohc_engine_collab::read_marker(&source, &key)
            .unwrap()
            .unwrap()
            .file_export_lane,
        dohc_engine_collab::FileExportLane::Retired
    );
    write(
        &mut source,
        "doc",
        "unexported",
        "doc.md",
        "owner-only",
        "ydoc",
        40,
    );
    write(
        &mut source,
        "doc",
        "outside",
        "doc.md",
        "outside edit",
        "api",
        50,
    );
    source
        .write_with(&NoFaults, |tx| {
            journal_moment_append_in_tx(tx, "ws", "outside")
        })
        .unwrap();
    let all = exports(&source);
    assert_eq!(all.len(), 4, "the intermediate settle stays owner-only");
    assert_eq!(
        all.last().unwrap().payload["beforeLatestMomentId"],
        restored
    );
    let (_peer_scratch, _, mut peer) = open_store();
    seed_replication_version(&mut peer, "main", "main");
    adopt_join_identity(
        &mut peer,
        "ws",
        "recipient",
        "epoch-1",
        "stream-1",
        1,
        &NoFaults,
    )
    .unwrap();
    hydrate(&source, &mut peer);
    for op in &all {
        apply(&mut peer, op);
    }
    assert_eq!(count(&peer, "conflicts"), 0);
    assert_eq!(
        all.last().unwrap().payload["beforeLatestMomentId"],
        restored
    );
    let real_before: String = source
        .read_with(|conn| {
            conn.query_row(
                "SELECT before_latest_moment_id FROM moments WHERE moment_id='outside'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(real_before, "unexported");
}

#[test]
fn lane_conflict_resolution_after_unsynced_settle_uses_the_exported_preimage() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "v1", "doc.md", "exported", "ydoc", 10);
    lane(&mut source, "doc");
    drain(&mut source);
    write(&mut source, "doc", "v2", "doc.md", "owner-only", "ydoc", 20);
    let (_peer_scratch, _, mut peer) = open_store();
    seed_replication_version(&mut peer, "main", "main");
    adopt_join_identity(
        &mut peer,
        "ws",
        "recipient",
        "epoch-1",
        "stream-1",
        1,
        &NoFaults,
    )
    .unwrap();
    hydrate(&source, &mut peer);
    apply(&mut peer, &exports(&source)[0]);
    write(
        &mut peer,
        "doc",
        "peer-edit",
        "doc.md",
        "peer version",
        "api",
        30,
    );
    peer.write_with(&NoFaults, |tx| {
        journal_moment_append_in_tx(tx, "ws", "peer-edit")
    })
    .unwrap();
    hydrate(&peer, &mut source);
    let imported = apply_moment_envelope(
        &mut source,
        &exports(&peer)[0],
        &NoFaults,
        &NoLiveLeases,
        &ReleasedTails::default(),
    )
    .unwrap();
    assert_eq!(imported.primary, ApplyDisposition::Applied(1));
    let conflicts = VersionedTextStore::new(&mut source)
        .list_text_conflicts_page("ws", Some("open"), None)
        .unwrap();
    assert_eq!(conflicts.len(), 1);
    let input = dohc_engine_domain::ResolveTextConflict {
        workspace_id: "ws".into(),
        conflict_id: conflicts[0].conflict_id.clone(),
        resolution: dohc_engine_domain::ResolveConflictKind::ApplyIncoming,
        object_id: "doc".into(),
        write_moment_id: "resolved".into(),
        delete_moment_id: "unused-delete".into(),
        metadata_origin: "api".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 40,
        request_id: None,
        conflict_answer_budget_bytes: usize::MAX,
    };
    VersionedTextStore::new(&mut source)
        .resolve_text_conflict_with(
            &input,
            &NoFaults,
            |tx, conflict, _| {
                Ok(
                    crate::conflict_resolve_v1::prepare_local_conflict_resolve_v1_in_tx(
                        tx, &input, conflict,
                    )
                    .unwrap(),
                )
            },
            |tx, result, prepared| {
                crate::conflict_resolve_v1::commit_local_conflict_resolve_v1_in_tx(
                    tx, &prepared, result,
                )
                .unwrap();
                Ok(())
            },
        )
        .unwrap();
    let ops = list_replication_ops(&source, "ws", "local", -1, 20).unwrap();
    let shadow = ops
        .iter()
        .find(|op| op.op_kind == "moment.append" && op.payload["momentId"] == "resolved")
        .unwrap();
    assert_eq!(shadow.payload["beforeLatestMomentId"], "v1");
    let real_before: String = source
        .read_with(|conn| {
            conn.query_row(
                "SELECT before_latest_moment_id FROM moments WHERE moment_id='resolved'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(real_before, "v2", "owner rollback keeps the real preimage");
    hydrate(&source, &mut peer);
    for op in ops
        .iter()
        .filter(|op| op.op_kind == "conflict.resolve" || op.payload["momentId"] == "resolved")
    {
        let result = apply_replication_envelope(
            &mut peer,
            &mut WriterDocCache::new(),
            op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(
            matches!(result.primary, ApplyDisposition::Applied(_)),
            "{result:?}"
        );
    }
    assert_eq!(count(&peer, "conflicts"), 0);
    for diverged in [false, true] {
        let (_recipient_scratch, _, mut recipient) = open_store();
        seed_replication_version(&mut recipient, "main", "main");
        adopt_join_identity(
            &mut recipient,
            "ws",
            "another-recipient",
            "epoch-1",
            "stream-1",
            1,
            &NoFaults,
        )
        .unwrap();
        hydrate(&source, &mut recipient);
        apply(&mut recipient, &exports(&source)[0]);
        if diverged {
            write(
                &mut recipient,
                "doc",
                "private-recipient",
                "doc.md",
                "unreviewed local edit",
                "api",
                35,
            );
        }
        for op in ops
            .iter()
            .filter(|op| op.op_kind == "conflict.resolve" || op.payload["momentId"] == "resolved")
        {
            let result = apply_replication_envelope(
                &mut recipient,
                &mut WriterDocCache::new(),
                op,
                &NoFaults,
                &NoLiveLeases,
            )
            .unwrap();
            assert!(
                matches!(result.primary, ApplyDisposition::Applied(_)),
                "{result:?}"
            );
        }
        assert_eq!(count(&recipient, "conflicts"), i64::from(diverged));
        let current = VersionedTextStore::new(&mut recipient)
            .read_text("ws", "main", "doc.md")
            .unwrap()
            .unwrap();
        assert_eq!(
            current.text,
            if diverged {
                "unreviewed local edit"
            } else {
                "peer version"
            }
        );
    }
    write(
        &mut peer,
        "doc",
        "continued-peer-edit",
        "doc.md",
        "peer continued",
        "api",
        50,
    );
    peer.write_with(&NoFaults, |tx| {
        journal_moment_append_in_tx(tx, "ws", "continued-peer-edit")
    })
    .unwrap();
    hydrate(&peer, &mut source);
    let continued = apply_moment_envelope(
        &mut source,
        exports(&peer).last().unwrap(),
        &NoFaults,
        &NoLiveLeases,
        &ReleasedTails::default(),
    )
    .unwrap();
    assert_eq!(continued.primary, ApplyDisposition::Applied(0));
    write(
        &mut source,
        "doc",
        "later-publication",
        "doc.md",
        "later owner version",
        "api",
        60,
    );
    source
        .write_with(&NoFaults, |tx| {
            journal_moment_append_in_tx(tx, "ws", "later-publication")?;
            let duplicate = crate::conflict_resolve_v1::durable_effect_shadow_in_tx(
                tx,
                "ws",
                "resolved",
                &input.conflict_id,
                0,
            )?;
            assert_eq!(
                duplicate, shadow.payload,
                "a later export must not change the original shadow"
            );
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let key = DocKey::new("ws", "main", "doc").unwrap();
    fresh_seed(&mut source, &key, "later owner version");
    source
        .write_with(&NoFaults, |tx| {
            assert!(matches!(
                originate_ydoc_base_in_tx(tx, &key, "doc.md", None, None, 70)?,
                BaseOrigination::Originated { .. }
            ));
            let flag: i64 = tx
                .query_row(
                    "SELECT file_export_lane FROM ydoc_docs WHERE object_id='doc'",
                    [],
                    |row| row.get(0),
                )
                .map_err(SyncError::corrupt)?;
            assert_eq!(flag, 0);
            let duplicate = crate::conflict_resolve_v1::durable_effect_shadow_in_tx(
                tx,
                "ws",
                "resolved",
                &input.conflict_id,
                0,
            )?;
            assert_eq!(
                duplicate, shadow.payload,
                "promotion must retain the signed shadow's preimage"
            );
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

#[test]
fn lane_decline_head_stays_stable_across_two_settles() {
    for flag in [1, 2] {
        let (_scratch, _, mut source) = owner();
        write(&mut source, "doc", "seed", "doc.md", "seed", "ydoc", 10);
        lane(&mut source, "doc");
        let refused = dohc_engine_storage::hex_sha256(b"seed");
        source.write_with(&NoFaults, |tx| {
            let fact = serde_json::json!({"head_sha256":refused,"constraint":"MAX_YDOC_UPDATE_BYTES","limit_bytes":20,"observed_bytes":21});
            tx.execute("UPDATE ydoc_docs SET file_export_lane=?1,sharing_declined_json=?2", params![flag,fact.to_string()]).map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        }).unwrap();
        for (id, text) in [("settle-1", "saved one"), ("settle-2", "saved two")] {
            write(&mut source, "doc", id, "doc.md", text, "ydoc", 20);
            let declines = source
                .write_with(&NoFaults, |tx| {
                    crate::ydoc_origination::current_sharing_declines_in_tx(tx, "ws")
                })
                .unwrap();
            let TxnOutcome::Committed(declines) = declines else {
                panic!("decline query crashed")
            };
            assert_eq!(declines.len(), 1);
            assert_eq!(
                declines[0].head_blob_sha256.as_deref(),
                Some(refused.as_str())
            );
        }
    }
}

#[test]
fn lane_headless_decline_is_reported_after_settles_with_a_stable_absent_head() {
    let (_scratch, _, mut source) = owner();
    let doc = Ydoc::wire();
    doc.plaintext_insert(
        0,
        &"x".repeat(dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES + 1),
    );
    doc.plaintext_delete(
        0,
        dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES as u32 + 1,
    );
    doc.plaintext_insert(0, "saved one");
    let base = doc.encode_full_state();
    assert!(base.len() > dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES);
    let blob = source.put_binary_blob(&base).unwrap();
    let key = DocKey::new("ws", "main", "doc").unwrap();
    source.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO file_objects VALUES ('ws','doc',0)", []).map_err(SyncError::persist)?;
        tx.execute("INSERT INTO ydoc_docs(workspace_id,version_id,object_id,content_kind,regime,lineage_claim_status,updated_at_ms,head_update_seq,path) VALUES ('ws','main','doc','plaintext','local-only','unclaimed',1,1,'doc.md')", []).map_err(SyncError::persist)?;
        tx.execute("INSERT INTO ydoc_updates(workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms) VALUES ('ws','main','doc',1,?1,10)", [&blob]).map_err(SyncError::persist)?;
        let BaseOrigination::Declined(declined) = originate_ydoc_base_in_tx(tx, &key, "doc.md", None, None, 10)? else { panic!("oversized base must decline") };
        assert_eq!(declined.head_blob_sha256, None);
        Ok::<_, SyncError>(())
    }).unwrap();
    for (id, text) in [("settle-1", "saved one"), ("settle-2", "saved two")] {
        let input = WriteText {
            workspace_id: "ws".into(),
            version_id: "main".into(),
            object_id: "doc".into(),
            moment_id: id.into(),
            path: "doc.md".into(),
            text: text.into(),
            metadata_origin: "ydoc".into(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 20,
            request_id: None,
        };
        source
            .write_with(&NoFaults, |tx| {
                dohc_engine_domain::write_projected_text_in_tx(tx, &input)
            })
            .unwrap();
        let TxnOutcome::Committed(declines) = source
            .write_with(&NoFaults, |tx| {
                crate::ydoc_origination::current_sharing_declines_in_tx(tx, "ws")
            })
            .unwrap()
        else {
            panic!("decline query crashed")
        };
        assert_eq!(declines.len(), 1);
        assert_eq!(declines[0].head_blob_sha256, None);
        assert_eq!(declines[0].path, "doc.md");
    }
}

#[test]
fn lane_many_settles_deliver_one_head_and_keep_owner_history() {
    let (_scratch, _, mut source) = owner();
    write(
        &mut source,
        "doc",
        "bootstrap",
        "doc.md",
        "initial",
        "ydoc",
        10,
    );
    lane(&mut source, "doc");
    for n in 0..20 {
        write(
            &mut source,
            "doc",
            &format!("settle-{n}"),
            "doc.md",
            &format!("saved {n}"),
            "ydoc",
            20 + n,
        );
    }
    drain(&mut source);
    let first = exports(&source);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].payload["momentId"], "settle-19");
    assert_eq!(first[0].payload["beforePresent"], "null");
    assert_eq!(count(&source, "moments"), 21);
    let (_peer_scratch, _, mut peer) = open_store();
    seed_replication_version(&mut peer, "main", "main");
    adopt_join_identity(
        &mut peer,
        "ws",
        "recipient",
        "epoch-1",
        "stream-1",
        1,
        &NoFaults,
    )
    .unwrap();
    hydrate(&source, &mut peer);
    apply(&mut peer, &first[0]);
    assert_eq!(count(&peer, "moments"), 1);
    write(
        &mut source,
        "doc",
        "settle-20",
        "doc.md",
        "next",
        "ydoc",
        100,
    );
    drain(&mut source);
    let second = exports(&source);
    assert_eq!(second.len(), 2);
    assert_eq!(second[1].payload["beforeLatestMomentId"], "settle-19");
    assert_ne!(
        second[1].payload["beforeLatestMomentId"],
        second[1].payload["momentId"]
    );
    hydrate(&source, &mut peer);
    apply(&mut peer, &second[1]);
    assert_eq!(
        apply_moment_envelope(
            &mut peer,
            &second[1],
            &NoFaults,
            &NoLiveLeases,
            &ReleasedTails::default(),
        )
        .unwrap()
        .primary,
        ApplyDisposition::Skipped
    );
    assert_eq!(count(&peer, "moments"), 2);
    drain(&mut source);
    assert_eq!(exports(&source).len(), 2);
}

#[test]
fn lane_prune_reenrollment_and_epoch_reset_never_leak_intermediate_settles() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "seed", "doc.md", "seed", "ydoc", 10);
    lane(&mut source, "doc");
    for n in 0..3 {
        write(
            &mut source,
            "doc",
            &format!("settle-{n}"),
            "doc.md",
            &format!("saved {n}"),
            "ydoc",
            20 + n,
        );
    }
    drain(&mut source);
    let selected = exports(&source);
    let (_scratch_peer, _, mut peer) = open_store();
    seed_replication_version(&mut peer, "main", "main");
    adopt_join_identity(
        &mut peer,
        "ws",
        "recipient",
        "epoch-1",
        "stream-1",
        1,
        &NoFaults,
    )
    .unwrap();
    hydrate(&source, &mut peer);
    apply(&mut peer, &selected[0]);
    for epoch in ["epoch-1", "epoch-reset"] {
        source
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_docs SET head_update_seq=0,head_snapshot_seq=0",
                    [],
                )
                .map_err(SyncError::persist)?;
                crate::enrolment::backfill_enrolment_window_in_tx(tx, "ws", &NoLiveLeases, 200)?;
                Ok::<_, SyncError>(())
            })
            .unwrap();
        commit_relay_cursor(
            &mut source,
            "ws",
            &RelayCursor {
                cursor: 0,
                replication_epoch: epoch.into(),
                stream_identity: "stream-1".into(),
                bootstrap_complete: true,
                settlement_report_id: None,
                ordinary_pull: None,
            },
            &NoFaults,
            &NoLiveLeases,
            201,
        )
        .unwrap();
        assert_eq!(exports(&source).len(), 1);
        assert_eq!(count(&peer, "moments"), 1);
    }
}

#[test]
fn lane_recovery_copies_unpushed_export_and_next_preimage_follows_it() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
    lane(&mut source, "doc");
    drain(&mut source);
    let shared = exports(&source);
    write(&mut source, "doc", "b", "doc.md", "B", "ydoc", 20);
    drain(&mut source);
    let recovery = RelaySyncClient::new(PagedRelay::new([(
        0,
        PullResponse {
            ops: shared.clone(),
            next_cursor: 1,
            has_more: false,
        },
    )]));
    let recovered = recovery
        .recover_origin(&mut source, "ws", "rebased", &NoFaults)
        .unwrap();
    assert_eq!(recovered.preserved_ops, 1);
    write(&mut source, "doc", "c", "doc.md", "C", "ydoc", 30);
    drain(&mut source);
    let all = exports(&source);
    assert_eq!(all.len(), 3);
    assert_eq!(all[1].origin_id, "rebased");
    assert_eq!(all[2].payload["beforeLatestMomentId"], "b");
    let (_peer_scratch, _, mut peer) = open_store();
    seed_replication_version(&mut peer, "main", "main");
    adopt_join_identity(
        &mut peer,
        "ws",
        "recipient",
        "epoch-1",
        "stream-1",
        1,
        &NoFaults,
    )
    .unwrap();
    hydrate(&source, &mut peer);
    for op in all {
        apply(&mut peer, &op);
    }
    assert_eq!(count(&peer, "moments"), 3);
    assert_eq!(count(&peer, "conflicts"), 0);
}

#[test]
fn lane_removed_export_is_never_the_next_public_preimage() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
    lane(&mut source, "doc");
    drain(&mut source);
    write(&mut source, "doc", "b", "doc.md", "B", "ydoc", 20);
    drain(&mut source);
    source
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM replication_log WHERE json_extract(payload_json,'$.momentId')='b'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    write(&mut source, "doc", "c", "doc.md", "C", "ydoc", 30);
    drain(&mut source);
    let all = exports(&source);
    assert_eq!(all.len(), 2);
    assert_eq!(all[1].payload["beforeLatestMomentId"], "a");
    assert_eq!(
        all[1].payload["payloadBeforeBlobSha256"],
        all[0].payload["payloadAfterBlobSha256"]
    );
}

fn import_peer_edit(source: &mut EngineStore, peer: &mut EngineStore) {
    seed_replication_version(peer, "main", "main");
    adopt_join_identity(peer, "ws", "recipient", "epoch-1", "stream-1", 1, &NoFaults).unwrap();
    hydrate(source, peer);
    apply(peer, &exports(source)[0]);
    write(
        peer,
        "doc",
        "peer-edit",
        "doc.md",
        "peer version",
        "api",
        20,
    );
    peer.write_with(&NoFaults, |tx| {
        journal_moment_append_in_tx(tx, "ws", "peer-edit")
    })
    .unwrap();
    hydrate(peer, source);
    apply(source, &exports(peer)[0]);
}

#[test]
fn lane_export_after_an_applied_peer_edit_uses_its_preimage_without_conflict() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
    lane(&mut source, "doc");
    drain(&mut source);
    let (_peer_scratch, _, mut peer) = open_store();
    import_peer_edit(&mut source, &mut peer);
    // A later log row can name an older local moment. Order by the moment,
    // rather than arrival or recovery's insertion order.
    let first = exports(&source)[0].payload.to_string();
    source.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES ('ws','another-peer',0,'moment.append',?1,30,1)", [&first]).map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    }).unwrap();
    write(
        &mut source,
        "doc",
        "c",
        "doc.md",
        "owner version",
        "ydoc",
        40,
    );
    drain(&mut source);
    let selected = exports(&source);
    assert_eq!(selected.len(), 2);
    assert_eq!(selected[1].payload["beforeLatestMomentId"], "peer-edit");
    hydrate(&source, &mut peer);
    apply(&mut peer, &selected[1]);
    assert_eq!(count(&peer, "conflicts"), 0);
    assert_eq!(count(&peer, "moments"), 3);
}

#[test]
fn lane_reseed_from_an_applied_import_claims_without_echoing_the_head() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
    lane(&mut source, "doc");
    drain(&mut source);
    let (_peer_scratch, _, mut peer) = open_store();
    import_peer_edit(&mut source, &mut peer);
    let key = DocKey::new("ws", "main", "doc").unwrap();
    fresh_seed(&mut source, &key, "peer version");
    source
        .write_with(&NoFaults, |tx| {
            assert!(matches!(
                originate_ydoc_base_in_tx(tx, &key, "doc.md", None, None, 50)?,
                BaseOrigination::Originated { .. }
            ));
            Ok::<_, SyncError>(())
        })
        .unwrap();
    assert_eq!(
        exports(&source).len(),
        1,
        "an applied import is already exported"
    );
    assert!(
        !dohc_engine_collab::read_marker(&source, &key)
            .unwrap()
            .unwrap()
            .file_export_lane
            .is_enabled()
    );
    let ops = list_replication_ops(&source, "ws", "local", -1, 20).unwrap();
    assert_eq!(
        ops.iter().filter(|op| op.op_kind == "ydoc.update").count(),
        1
    );
}

#[test]
fn ordinary_trimmed_lineage_backfills_after_a_published_ydoc_moment() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
    source
        .write_with(&NoFaults, |tx| journal_moment_append_in_tx(tx, "ws", "a"))
        .unwrap();
    lane(&mut source, "doc");
    source
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET file_export_lane=0", [])
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    write(&mut source, "doc", "b", "doc.md", "B", "ydoc", 20);
    source
        .write_with(&NoFaults, |tx| {
            crate::enrolment::backfill_enrolment_window_in_tx(tx, "ws", &NoLiveLeases, 30)
        })
        .unwrap();
    assert_eq!(exports(&source).len(), 2);
}

#[test]
fn lane_refused_import_is_never_a_public_preimage() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
    lane(&mut source, "doc");
    drain(&mut source);
    write(&mut source, "doc", "b", "doc.md", "B", "ydoc", 20);
    source.write_with(&NoFaults, |tx| {
        let (payload, _) = crate::outbound::moment_append_payload_in_tx(tx, "ws", "b")?;
        tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES ('ws','refused-peer',0,'moment.append',?1,20,1)", [payload.to_string()]).map_err(SyncError::persist)?;
        tx.execute("INSERT INTO replication_pending_refusals(workspace_id,origin_id,origin_seq,op_kind,reason_code,reason_message) VALUES ('ws','refused-peer',0,'moment.append','invalid-input','refused')", []).map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    }).unwrap();
    write(&mut source, "doc", "c", "doc.md", "C", "ydoc", 30);
    drain(&mut source);
    assert_eq!(exports(&source)[1].payload["beforeLatestMomentId"], "a");
}

#[test]
fn former_lane_delete_restore_never_backfills_intermediate_settles() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "seed", "doc.md", "seed", "ydoc", 10);
    lane(&mut source, "doc");
    write(
        &mut source,
        "doc",
        "intermediate",
        "doc.md",
        "intermediate",
        "ydoc",
        20,
    );
    write(
        &mut source,
        "doc",
        "exported",
        "doc.md",
        "exported",
        "ydoc",
        30,
    );
    drain(&mut source);
    VersionedTextStore::new(&mut source)
        .delete_text_file(
            &DeleteTextFile {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                path: "doc.md".into(),
                moment_id: "deleted".into(),
                request_id: None,
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 40,
            },
            &NoFaults,
        )
        .unwrap();
    source
        .write_with(&NoFaults, |tx| {
            journal_moment_append_in_tx(tx, "ws", "deleted")
        })
        .unwrap();
    VersionedTextStore::new(&mut source)
        .rollback_text_file_mutation(
            &dohc_engine_domain::RollbackTextFileMutation {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                path: "doc.md".into(),
                mutation_moment_id: "deleted".into(),
                metadata_origin: "restore".into(),
                author_json: None,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    let key = DocKey::new("ws", "main", "doc").unwrap();
    assert!(
        !dohc_engine_collab::read_marker(&source, &key)
            .unwrap()
            .unwrap()
            .file_export_lane
            .is_enabled()
    );
    source
        .write_with(&NoFaults, |tx| {
            crate::enrolment::backfill_enrolment_window_in_tx(tx, "ws", &NoLiveLeases, 60)
        })
        .unwrap();
    let all = exports(&source);
    assert_eq!(
        all.iter()
            .map(|op| op.payload["momentId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "exported",
            "deleted",
            &dohc_engine_domain::rollback_compensating_moment_id("ws", "main", "deleted")
        ]
    );
    assert_eq!(
        dohc_engine_collab::read_marker(&source, &key)
            .unwrap()
            .unwrap()
            .file_export_lane,
        dohc_engine_collab::FileExportLane::Retired
    );
    let (_peer_scratch, _, mut peer) = open_store();
    seed_replication_version(&mut peer, "main", "main");
    adopt_join_identity(
        &mut peer,
        "ws",
        "recipient",
        "epoch-1",
        "stream-1",
        1,
        &NoFaults,
    )
    .unwrap();
    hydrate(&source, &mut peer);
    for op in all {
        apply(&mut peer, &op);
    }
    assert_eq!(count(&peer, "moments"), 3);
    assert_eq!(count(&peer, "conflicts"), 0);
}

#[test]
fn lane_journal_transaction_survives_crash_and_offline_restart() {
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let (_scratch, path, mut source) = owner();
        write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
        lane(&mut source, "doc");
        let crash = ScriptedFaults::crash_at(point);
        assert!(matches!(
            source
                .write_with(crash.as_ref(), |tx| {
                    crate::enrolment::backfill_file_versions_in_tx(tx, "ws")
                })
                .unwrap(),
            TxnOutcome::Crashed { .. }
        ));
        drop(source);
        let mut source = EngineStore::open(&path, 100).unwrap();
        drain(&mut source);
        assert_eq!(exports(&source).len(), 1);
        write(&mut source, "doc", "b", "doc.md", "B", "ydoc", 110);
        drain(&mut source);
        assert_eq!(exports(&source)[1].payload["beforeLatestMomentId"], "a");
    }
}

#[test]
fn lane_byte_budget_admits_whole_heads_and_defers_overflow() {
    let (_scratch, _, mut source) = owner();
    for object in ["a", "b", "c"] {
        write(
            &mut source,
            object,
            object,
            &format!("{object}.md"),
            &object.repeat(9 * 1024 * 1024),
            "ydoc",
            10,
        );
        lane(&mut source, object);
    }
    drain(&mut source);
    assert_eq!(exports(&source).len(), 2);
    drain(&mut source);
    assert_eq!(exports(&source).len(), 3);
    for object in ["a", "b"] {
        write(
            &mut source,
            object,
            &format!("next-{object}"),
            &format!("{object}.md"),
            &object.to_uppercase().repeat(9 * 1024 * 1024),
            "ydoc",
            20,
        );
    }
    drain(&mut source);
    assert_eq!(exports(&source).len(), 4);
    drain(&mut source);
    assert_eq!(exports(&source).len(), 5);
}

#[test]
fn lane_uses_genuine_present_bootstrap_and_intervening_publications() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "a", "doc.md", "A", "api", 10);
    source
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM moments WHERE moment_id='a'", [])
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    write(&mut source, "doc", "b", "doc.md", "B", "ydoc", 20);
    lane(&mut source, "doc");
    drain(&mut source);
    let first = exports(&source);
    assert_eq!(first[0].payload["beforePresent"], "present");
    assert_eq!(first[0].payload["beforeLatestMomentId"], "a");
    for (id, text, origin, path) in [
        ("capture", "capture", "api", "doc.md"),
        ("rename", "capture", "api", "renamed.md"),
        ("restore", "restored", "undo", "renamed.md"),
    ] {
        if id == "rename" {
            VersionedTextStore::new(&mut source)
                .rename_text_file(
                    &RenameTextFile {
                        workspace_id: "ws".into(),
                        version_id: "main".into(),
                        from_path: "doc.md".into(),
                        to_path: path.into(),
                        moment_id: id.into(),
                        request_id: None,
                        metadata_origin: origin.into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 30,
                    },
                    &NoFaults,
                )
                .unwrap();
        } else {
            write(&mut source, "doc", id, path, text, origin, 30);
        }
        source
            .write_with(&NoFaults, |tx| journal_moment_append_in_tx(tx, "ws", id))
            .unwrap();
        write(
            &mut source,
            "doc",
            &format!("after-{id}"),
            path,
            &format!("saved after {id}"),
            "ydoc",
            40,
        );
        drain(&mut source);
        assert_eq!(
            exports(&source).last().unwrap().payload["beforeLatestMomentId"],
            id
        );
    }
}

#[test]
fn unexplained_export_gap_does_not_block_local_write_or_push() {
    let (_scratch, _, mut source) = owner();
    write(
        &mut source,
        "doc",
        "v1",
        "doc.md",
        "first export",
        "ydoc",
        10,
    );
    lane(&mut source, "doc");
    drain(&mut source);
    write(
        &mut source,
        "doc",
        "v2",
        "doc.md",
        "second export",
        "ydoc",
        20,
    );
    drain(&mut source);
    source
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM moments WHERE moment_id='v2'", [])
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    write(&mut source, "doc", "v3", "doc.md", "owner-only", "ydoc", 30);
    let input = WriteText {
        workspace_id: "ws".into(),
        version_id: "main".into(),
        object_id: "doc".into(),
        moment_id: "outside".into(),
        path: "doc.md".into(),
        text: "outside edit".into(),
        metadata_origin: "api".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 40,
        request_id: None,
    };
    source
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::write_text_in_tx(tx, &input).map_err(SyncError::corrupt)?;
            journal_moment_append_in_tx(tx, "ws", "outside")
        })
        .expect("sync metadata must not block the local write transaction");
    assert_eq!(exports(&source)[2].payload["beforeLatestMomentId"], "v3");
    assert_eq!(
        exports(&source)[2].payload["payloadBeforeBlobSha256"],
        dohc_engine_storage::hex_sha256(b"owner-only")
    );
    write(
        &mut source,
        "doc",
        "v4",
        "doc.md",
        "next settle",
        "ydoc",
        50,
    );
    write(
        &mut source,
        "doc",
        "v5",
        "doc.md",
        "selected settle",
        "ydoc",
        55,
    );
    let client = RelaySyncClient::new(RecordingRelay::default());
    client
        .push_workspace(&mut source, "ws", &NoFaults, &NoLiveLeases, 60, 0)
        .expect("sync selection must not fail on an unexplained export gap");
    let selected = exports(&source);
    assert_eq!(selected.last().unwrap().payload["momentId"], "v5");
    assert_eq!(
        selected.last().unwrap().payload["beforeLatestMomentId"],
        "v4"
    );
    assert_eq!(
        selected.last().unwrap().payload["payloadBeforeBlobSha256"],
        dohc_engine_storage::hex_sha256(b"next settle")
    );
    let pushes = client.transport().pushes.lock().unwrap();
    assert!(pushes.iter().flat_map(|p| &p.ops).any(|op| {
        op.payload["momentId"] == "v5" && op.payload["beforeLatestMomentId"] == "v4"
    }));
}

#[test]
fn lane_divergence_uses_existing_conflict_and_never_echoes_imports() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
    lane(&mut source, "doc");
    drain(&mut source);
    let (_peer_scratch, _, mut peer) = open_store();
    seed_replication_version(&mut peer, "main", "main");
    adopt_join_identity(
        &mut peer,
        "ws",
        "recipient",
        "epoch-1",
        "stream-1",
        1,
        &NoFaults,
    )
    .unwrap();
    hydrate(&source, &mut peer);
    apply(&mut peer, &exports(&source)[0]);
    write(&mut peer, "doc", "local-edit", "doc.md", "local", "api", 15);
    write(&mut source, "doc", "b", "doc.md", "remote", "ydoc", 20);
    drain(&mut source);
    hydrate(&source, &mut peer);
    let result = apply_moment_envelope(
        &mut peer,
        &exports(&source)[1],
        &NoFaults,
        &NoLiveLeases,
        &ReleasedTails::default(),
    )
    .unwrap();
    assert!(matches!(result.primary, ApplyDisposition::Applied(1)));

    peer.write_with(&NoFaults, |tx| {
        crate::enrolment::backfill_enrolment_window_in_tx(tx, "ws", &NoLiveLeases, 110)
    })
    .unwrap();
    assert!(
        exports(&peer)
            .iter()
            .all(|op| op.payload["momentId"] != "a" && op.payload["momentId"] != "b")
    );
    let retained:String=peer.read_with(|c|c.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.object_id='doc'",[],|r|r.get(0))).unwrap();
    assert_eq!(retained, "local");
}

#[derive(Default)]
struct RecordingRelay {
    pushes: Mutex<Vec<PushRequest>>,
    pull: Mutex<Option<PullResponse>>,
    haves: Mutex<Vec<BlobHaveRequest>>,
    uploads: Mutex<Vec<BlobUploadRequest>>,
    remote: Mutex<BTreeMap<String, Vec<u8>>>,
    fail_upload: std::sync::atomic::AtomicBool,
}
impl RelayTransport for RecordingRelay {
    fn push(&self, req: PushRequest) -> Result<PushResponse, RelayError> {
        self.pushes.lock().expect("push lock").push(req.clone());
        let accepted = req.ops.len();
        let current_max_origin_seq = req.ops.last().map_or(req.after_seq, |op| op.origin_seq);
        Ok(PushResponse {
            settlement_refusals: Vec::new(),
            hosted_refusals: Vec::new(),
            redundant_recoveries: Vec::new(),
            accepted,
            inserted: accepted,
            skipped: 0,
            current_max_origin_seq,
        })
    }
    fn pull(&self, _req: PullRequest) -> Result<PullResponse, RelayError> {
        let mut page = self
            .pull
            .lock()
            .expect("pull lock")
            .clone()
            .ok_or(RelayError::InvalidResponse)?;
        assign_fixture_relay_sequences(&mut page);
        Ok(page)
    }
    fn lookup_log_coordinate(
        &self,
        _req: LogCoordinateRequest,
    ) -> Result<LogCoordinateResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn probe(&self, _req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        Ok(ProbeResponse { has_content: false })
    }
    fn claim_workspace(&self, _req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        Ok(ClaimResponse)
    }
    fn rotate_epoch(&self, _req: EpochRequest) -> Result<EpochResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn blobs_have(&self, req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError> {
        self.haves.lock().unwrap().push(req.clone());
        let remote = self.remote.lock().unwrap();
        Ok(BlobHaveResponse {
            missing: req
                .sha256s
                .into_iter()
                .filter(|sha| !remote.contains_key(sha))
                .collect(),
        })
    }
    fn upload_blob(&self, req: BlobUploadRequest) -> Result<(), RelayError> {
        self.uploads.lock().unwrap().push(req.clone());
        if self.fail_upload.swap(false, Ordering::SeqCst) {
            return Err(RelayError::BlobMissing);
        }
        self.remote.lock().unwrap().insert(req.sha256, req.bytes);
        Ok(())
    }
    fn download_blobs(
        &self,
        req: BlobDownloadBatchRequest,
    ) -> Result<BlobDownloadBatchResponse, RelayError> {
        Ok(BlobDownloadBatchResponse {
            results: req
                .blobs
                .iter()
                .map(|_| Err(RelayError::BlobMissing))
                .collect(),
        })
    }
    fn upload_key_envelope(
        &self,
        _req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        Ok(KeyEnvelopeResponse {
            etag: "etag".to_owned(),
        })
    }
    fn download_key_envelope(
        &self,
        _req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError> {
        Err(RelayError::KeyEnvelopeMissing)
    }
    fn shared_channel_pull(
        &self,
        _req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn share_log_push(&self, _req: ShareLogPushRequest) -> Result<PushResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn share_view_pull(&self, _req: ShareViewRequest) -> Result<ShareViewResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
    fn share_blob(&self, _req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError> {
        Err(RelayError::ShareUnavailable)
    }

    fn share_blob_upload(&self, _req: ShareBlobUploadRequest) -> Result<(), RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn share_proposal_submit(
        &self,
        _req: ShareProposalSubmitRequest,
    ) -> Result<ShareProposalSubmitResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }

    fn share_collection_write(
        &self,
        _req: ShareCollectionWriteRequest,
    ) -> Result<ShareCollectionWriteResponse, RelayError> {
        Err(RelayError::InvalidResponse)
    }
}

fn fresh_seed(store: &mut EngineStore, key: &DocKey, text: &str) -> Ydoc {
    let doc = Ydoc::wire();
    doc.plaintext_insert(0, text);
    let sha = dohc_engine_storage::hex_sha256(text.as_bytes());
    dohc_engine_collab::record_local_update(
        store,
        &mut WriterDocCache::new(),
        key,
        &doc.encode_full_state(),
        LocalAppend {
            is_seed: true,
            seed_source_sha256: Some(&sha),
            require_empty_lineage: true,
            ..Default::default()
        },
        &NoFaults,
        100,
        |_, _, _| Ok(()),
    )
    .unwrap();
    doc
}
#[test]
fn lane_skips_every_retry_until_a_fresh_seed_then_claims_once() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
    lane(&mut source, "doc");
    let key = DocKey::new("ws", "main", "doc").unwrap();
    // A corrupt retained update is a tripwire: an attempted encode must fail.
    let corrupt = source.put_binary_blob(b"invalid update").unwrap();
    source.write_with(&NoFaults,|tx| {
        tx.execute("UPDATE ydoc_docs SET head_update_seq=1",[]).map_err(SyncError::persist)?;
        tx.execute("INSERT INTO ydoc_updates(workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms) VALUES ('ws','main','doc',1,?1,20)",[corrupt]).map_err(SyncError::persist)?;
        for _ in 0..3 {
            assert_eq!(originate_ydoc_base_in_tx(tx,&key,"doc.md",None,None,30)?,BaseOrigination::NothingToDo);
            assert_eq!(originate_appended_ydoc_base_in_tx(tx,&key,"doc.md",None,None,false,30)?,BaseOrigination::NothingToDo);
            assert_eq!(crate::enrolment::originate_closing_ydoc_base_in_tx(tx,&key,30)?,BaseOrigination::NothingToDo);
            assert_eq!(crate::enrolment::originate_live_ydoc_base_in_tx(tx,&key,30)?,BaseOrigination::NothingToDo);
            crate::enrolment::originate_unclaimed_ydoc_bases_in_tx(tx,"ws",&NoLiveLeases,30)?;
        }
        tx.execute("DELETE FROM ydoc_updates",[]).map_err(SyncError::persist)?;tx.execute("UPDATE ydoc_docs SET head_update_seq=0",[]).map_err(SyncError::persist)?;Ok::<_,SyncError>(())
    }).unwrap();
    fresh_seed(&mut source, &key, "A");
    let marker = dohc_engine_collab::read_marker(&source, &key)
        .unwrap()
        .unwrap();
    assert_eq!(
        marker.file_export_lane,
        dohc_engine_collab::FileExportLane::Reseeded
    );
    source
        .write_with(&NoFaults, |tx| {
            assert_eq!(
                crate::enrolment::originate_live_ydoc_base_in_tx(tx, &key, 110)?,
                BaseOrigination::NothingToDo,
                "the live-session push hook must skip a reseeded lane too"
            );
            assert!(matches!(
                originate_appended_ydoc_base_in_tx(tx, &key, "doc.md", None, None, true, 110)?,
                BaseOrigination::Originated { .. }
            ));
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let marker = dohc_engine_collab::read_marker(&source, &key)
        .unwrap()
        .unwrap();
    assert!(!marker.file_export_lane.is_enabled());
}

#[test]
fn lane_promotion_orders_catchup_base_and_later_updates_without_conflict() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
    lane(&mut source, "doc");
    drain(&mut source);
    write(&mut source, "doc", "b", "doc.md", "B", "ydoc", 20);
    let key = DocKey::new("ws", "main", "doc").unwrap();
    let doc = fresh_seed(&mut source, &key, "B");
    source
        .write_with(&NoFaults, |tx| {
            originate_ydoc_base_in_tx(tx, &key, "doc.md", None, None, 110)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let ops = list_replication_ops(&source, "ws", "local", -1, 20).unwrap();
    assert_eq!(
        ops.iter().map(|op| op.op_kind.as_str()).collect::<Vec<_>>(),
        ["moment.append", "moment.append", "ydoc.update"]
    );
    assert_eq!(ops[1].payload["beforeLatestMomentId"], "a");
    let (_peer_scratch, _, mut peer) = open_store();
    seed_replication_version(&mut peer, "main", "main");
    adopt_join_identity(
        &mut peer,
        "ws",
        "recipient",
        "epoch-1",
        "stream-1",
        1,
        &NoFaults,
    )
    .unwrap();
    hydrate(&source, &mut peer);
    let mut cache = WriterDocCache::new();
    for mut op in ops {
        op.relay_seq = Some(op.origin_seq + 1);
        if op.op_kind == "moment.append" {
            apply(&mut peer, &op);
        } else {
            let sha = op.payload["updateBlobSha256"].as_str().unwrap();
            let bytes = source.get_binary_blob(sha).unwrap().unwrap();
            peer.put_binary_blob(&bytes).unwrap();
            assert!(matches!(
                apply_ydoc_envelope(&mut peer, &mut cache, &op, &NoFaults, &NoLiveLeases)
                    .unwrap()
                    .primary,
                ApplyDisposition::Applied(YdocApplyResult {
                    conflicts_opened: 0,
                    ..
                })
            ));
        }
    }
    assert_eq!(count(&peer, "moments"), 2);
    assert_eq!(count(&peer, "conflicts"), 0);
    let update = doc.plaintext_insert(1, " later");
    let sha = peer.put_binary_blob(&update).unwrap();
    let claim = dohc_engine_collab::read_marker(&source, &key)
        .unwrap()
        .unwrap()
        .lineage_claim_id
        .unwrap();
    let op = envelope(
        "local",
        3,
        "ydoc.update",
        crate::ydoc_update_payload(
            &key,
            "doc.md",
            ContentKind::Plaintext,
            &sha,
            &claim,
            None,
            None,
            false,
        ),
    );
    assert!(matches!(
        apply_ydoc_envelope(&mut peer, &mut cache, &op, &NoFaults, &NoLiveLeases)
            .unwrap()
            .primary,
        ApplyDisposition::Applied(YdocApplyResult {
            conflicts_opened: 0,
            ..
        })
    ));
    assert_eq!(
        dohc_engine_collab::load_persisted(&peer, &key)
            .unwrap()
            .unwrap()
            .doc
            .plaintext_string(),
        "B later"
    );
}

#[test]
fn lane_catchup_and_claim_roll_back_together_and_dirty_heads_wait() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
    lane(&mut source, "doc");
    drain(&mut source);
    write(&mut source, "doc", "b", "doc.md", "B", "ydoc", 20);
    let key = DocKey::new("ws", "main", "doc").unwrap();
    fresh_seed(&mut source, &key, "B");
    let result = source.write_with(&NoFaults, |tx| {
        originate_ydoc_base_in_tx(tx, &key, "doc.md", None, None, 110)?;
        Err::<(), _>(SyncError::InvalidInput {
            reason: "rollback after claim",
        })
    });
    assert!(result.is_err());
    assert_eq!(exports(&source).len(), 1);
    assert_eq!(
        dohc_engine_collab::read_marker(&source, &key)
            .unwrap()
            .unwrap()
            .lineage_claim_status,
        dohc_engine_collab::LineageClaimStatus::Unclaimed
    );
    source
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET seed_source_sha256=NULL", [])
                .map_err(SyncError::persist)?;
            assert_eq!(
                originate_ydoc_base_in_tx(tx, &key, "doc.md", None, None, 120)?,
                BaseOrigination::NothingToDo
            );
            Ok::<_, SyncError>(())
        })
        .unwrap();
    assert_eq!(exports(&source).len(), 1);
}

#[test]
fn lane_imported_claim_and_delete_stop_file_export_and_head_changes_preserve_it() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
    lane(&mut source, "doc");
    write(&mut source, "doc", "b", "doc.md", "B", "ydoc", 20);
    let key = DocKey::new("ws", "main", "doc").unwrap();
    assert!(
        dohc_engine_collab::read_marker(&source, &key)
            .unwrap()
            .unwrap()
            .file_export_lane
            .is_enabled()
    );
    let base = Ydoc::wire();
    base.plaintext_insert(0, "B");
    let base_sha = source.put_binary_blob(&base.encode_full_state()).unwrap();
    let incoming = envelope(
        "peer",
        0,
        "ydoc.update",
        crate::ydoc_update_payload(
            &key,
            "doc.md",
            ContentKind::Plaintext,
            &base_sha,
            &base_sha,
            None,
            None,
            true,
        ),
    );
    let applied = apply_ydoc_envelope(
        &mut source,
        &mut WriterDocCache::new(),
        &incoming,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    assert!(matches!(
        applied.primary,
        ApplyDisposition::Applied(YdocApplyResult {
            conflicts_opened: 0,
            ..
        })
    ));
    assert!(
        !dohc_engine_collab::read_marker(&source, &key)
            .unwrap()
            .unwrap()
            .file_export_lane
            .is_enabled()
    );
    drain(&mut source);
    assert!(exports(&source).is_empty());
    write(
        &mut source,
        "deleted",
        "delete-seed",
        "deleted.md",
        "D",
        "ydoc",
        40,
    );
    lane(&mut source, "deleted");
    VersionedTextStore::new(&mut source)
        .delete_text_file(
            &DeleteTextFile {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                path: "deleted.md".into(),
                moment_id: "delete".into(),
                request_id: None,
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 50,
            },
            &NoFaults,
        )
        .unwrap();
    assert!(
        !dohc_engine_collab::read_marker(&source, &DocKey::new("ws", "main", "deleted").unwrap())
            .unwrap()
            .unwrap()
            .file_export_lane
            .is_enabled()
    );
    drain(&mut source);
    assert!(exports(&source).is_empty());
}

#[test]
fn lane_upload_bytes_are_one_latest_blob_per_pass_including_retry() {
    const BYTES: usize = 5 * 1024 * 1024;
    let (_scratch, _, mut source) = owner();
    let client = RelaySyncClient::new(RecordingRelay::default());
    write(
        &mut source,
        "doc",
        "a",
        "doc.md",
        &"a".repeat(BYTES),
        "ydoc",
        10,
    );
    lane(&mut source, "doc");
    for pass in 0..3 {
        for settle in 0..200 {
            let text = format!(
                "{pass}{}",
                if settle % 2 == 0 { "x" } else { "y" }.repeat(BYTES - 1)
            );
            write(
                &mut source,
                "doc",
                &format!("pass-{pass}-{settle}"),
                "doc.md",
                &text,
                "ydoc",
                100 + pass * 200 + settle,
            );
        }
        let uploads_before = client.transport().uploads.lock().unwrap().len();
        let haves_before = client.transport().haves.lock().unwrap().len();
        if pass == 1 {
            client.transport().fail_upload.store(true, Ordering::SeqCst);
            assert!(
                client
                    .push_workspace(&mut source, "ws", &NoFaults, &NoLiveLeases, 1000, 0)
                    .is_err()
            );
        }
        client
            .push_workspace(&mut source, "ws", &NoFaults, &NoLiveLeases, 1000, 0)
            .unwrap();
        let uploads = client.transport().uploads.lock().unwrap();
        let uploaded = uploads[uploads_before..]
            .iter()
            .map(|r| r.bytes.len())
            .sum::<usize>();
        assert_eq!(uploaded, if pass == 1 { 2 * BYTES } else { BYTES });
        let haves = client.transport().haves.lock().unwrap();
        let requested = haves[haves_before..]
            .iter()
            .flat_map(|r| &r.sha256s)
            .count()
            * BYTES;
        assert_eq!(
            requested,
            match pass {
                0 => BYTES,
                1 => 4 * BYTES,
                _ => 2 * BYTES,
            }
        );
        println!(
            "LANE_UPLOAD pass={pass} settles=200 requested_bytes={requested} uploaded_bytes={uploaded} retries={}",
            usize::from(pass == 1)
        );
        assert_eq!(exports(&source).len(), usize::try_from(pass + 1).unwrap());
    }
    assert_eq!(count(&source, "moments"), 601);
}

#[test]
fn lane_open_recipient_retains_pending_pull_across_restart_and_local_edits_survive_close() {
    let (_source_scratch, _, mut source) = owner();
    write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
    lane(&mut source, "doc");
    drain(&mut source);
    let (_peer_scratch, path, mut peer) = open_store();
    seed_replication_version(&mut peer, "main", "main");
    adopt_join_identity(
        &mut peer,
        "ws",
        "recipient",
        "epoch-1",
        "stream-1",
        1,
        &NoFaults,
    )
    .unwrap();
    hydrate(&source, &mut peer);
    apply(&mut peer, &exports(&source)[0]);
    write(
        &mut peer,
        "doc",
        "local",
        "doc.md",
        "local edits",
        "api",
        21,
    );
    write(&mut source, "doc", "b", "doc.md", "B", "ydoc", 30);
    drain(&mut source);
    hydrate(&source, &mut peer);
    let client = RelaySyncClient::new(PagedRelay::new([
        (
            0,
            PullResponse {
                ops: vec![exports(&source)[1].clone()],
                next_cursor: 2,
                has_more: false,
            },
        ),
        (
            2,
            PullResponse {
                ops: Vec::new(),
                next_cursor: 2,
                has_more: false,
            },
        ),
    ]));
    let first = client
        .pull_chat_workspace(
            &mut peer,
            &mut WriterDocCache::new(),
            "ws",
            &NoFaults,
            &AlwaysLive,
            40,
        )
        .unwrap();
    let SyncPassOutcome::Complete {
        pending_cursor: Some(cursor),
        ..
    } = first
    else {
        panic!("{first:?}")
    };
    client
        .commit_pull_cursor(&mut peer, "ws", &cursor, &NoFaults, &AlwaysLive, 41)
        .unwrap();
    assert_eq!(count(&peer, "relay_deferred_ops"), 1);
    assert_eq!(count(&peer, "moments"), 2);
    drop(peer);
    let mut peer = EngineStore::open(&path, 50).unwrap();
    client
        .pull_chat_workspace(
            &mut peer,
            &mut WriterDocCache::new(),
            "ws",
            &NoFaults,
            &AlwaysLive,
            51,
        )
        .unwrap();
    assert_eq!(count(&peer, "relay_deferred_ops"), 1);
    let closed = client
        .pull_chat_workspace(
            &mut peer,
            &mut WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            60,
        )
        .unwrap();
    let SyncPassOutcome::Complete {
        pending_cursor: Some(cursor),
        conflicts_opened,
        ..
    } = closed
    else {
        panic!("{closed:?}")
    };
    assert_eq!(conflicts_opened, 1);
    client
        .commit_pull_cursor(&mut peer, "ws", &cursor, &NoFaults, &NoLiveLeases, 61)
        .unwrap();
    assert_eq!(count(&peer, "relay_deferred_ops"), 0);
    drop(peer);
    let peer = EngineStore::open(&path, 70).unwrap();
    let text:String=peer.read_with(|c|c.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.object_id='doc'",[],|r|r.get(0))).unwrap();
    assert_eq!(text, "local edits");
    assert_eq!(count(&peer, "conflicts"), 1);
}

#[test]
fn lane_export_lookup_uses_the_existing_object_index() {
    let (_scratch, _, source) = owner();
    let plan: Vec<String> = source
        .read_with(|c| {
            c.prepare(&format!(
                "EXPLAIN QUERY PLAN {}",
                crate::enrolment::LAST_FILE_EXPORT_SQL
            ))?
            .query_map(params!["ws", "main", "doc"], |r| r.get(3))?
            .collect::<Result<_, _>>()
        })
        .unwrap();
    assert!(
        plan.iter()
            .any(|line| line.contains("replication_log_moment_object")
                && line.matches("<expr>=?").count() == 2),
        "{plan:?}"
    );
}
#[test]
fn lane_drain_and_promotion_keep_deferred_and_owner_binding_exclusions() {
    for blocker in ["deferred", "owner", "audit"] {
        let (_scratch, _, mut source) = owner();
        write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
        lane(&mut source, "doc");
        let key = DocKey::new("ws", "main", "doc").unwrap();
        fresh_seed(&mut source, &key, "A");
        let binary = source.put_binary_blob(b"binding").unwrap();
        source.write_with(&NoFaults,|tx| {
            match blocker {
                "deferred"=>{tx.execute("INSERT INTO ydoc_deferred_updates(workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms) VALUES ('ws','main','doc','peer',0,20)",[]).map_err(SyncError::persist)?;}
                "owner"=>{tx.execute("INSERT INTO ydoc_owner_bindings VALUES ('ws','main','doc',?1,'{}','relay',1,0,0,?1,1024,1000)",[&binary]).map_err(SyncError::persist)?;}
                "audit"=>{tx.execute("INSERT INTO live_device_application_bindings VALUES ('relay','ws','main','doc','claim','doc.md','[]',0,'host',1,'instance','connection',1,NULL)",[]).map_err(SyncError::persist)?;}
                _=>unreachable!(),
            }
            crate::enrolment::backfill_file_versions_in_tx(tx,"ws")?;assert_eq!(originate_ydoc_base_in_tx(tx,&key,"doc.md",None,None,30)?,BaseOrigination::NothingToDo);Ok::<_,SyncError>(())
        }).unwrap();
        assert!(exports(&source).is_empty(), "{blocker}");
    }
}

#[test]
fn lane_successor_and_archive_remain_outside_file_delivery() {
    let (_scratch, _, mut source) = owner();
    write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
    lane(&mut source, "doc");
    let key = DocKey::new("ws", "main", "doc").unwrap();
    fresh_seed(&mut source, &key, "A");
    source
        .write_with(&NoFaults, |tx| {
            originate_ydoc_base_in_tx(tx, &key, "doc.md", None, None, 20)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let count_before = exports(&source).len();
    let predecessor = dohc_engine_collab::load_persisted(&source, &key)
        .unwrap()
        .unwrap();
    let claim = predecessor.marker.lineage_claim_id.unwrap();
    let vector = dohc_engine_storage::hex_sha256(&predecessor.doc.encode_state_vector());
    let identity =
        dohc_engine_collab::SuccessorIdentity::derive(dohc_engine_collab::SuccessorIdentityInput {
            key: &key,
            predecessor_claim_id: &claim,
            predecessor_state_vector_sha256: &vector,
            artifact_op_kind: "moment.append",
            artifact_id: "successor",
            artifact_preimage_sha256: &dohc_engine_storage::hex_sha256(b"A"),
            content_kind: ContentKind::Plaintext,
            result_sha256: &dohc_engine_storage::hex_sha256(b"successor"),
        });
    let successor = dohc_engine_collab::fresh_successor_base(&identity, "successor").unwrap();
    dohc_engine_collab::replace_lineage_with_successor(
        &mut source,
        dohc_engine_collab::SuccessorReplacement {
            key: &key,
            expected_predecessor_claim_id: &claim,
            expected_predecessor_state_vector_sha256: &vector,
            path: "doc.md",
            successor: &successor,
            scene_result: None,
            now_ms: 30,
        },
        &NoFaults,
    )
    .unwrap();
    let active = dohc_engine_collab::load_persisted(&source, &key)
        .unwrap()
        .unwrap();
    assert!(!active.marker.file_export_lane.is_enabled());
    let claim = active.marker.lineage_claim_id.unwrap();
    let vector = dohc_engine_storage::hex_sha256(&active.doc.encode_state_vector());
    drain(&mut source);
    assert_eq!(exports(&source).len(), count_before);
    source
        .write_with(&NoFaults, |tx| {
            dohc_engine_collab::archive_active_lineage_in_tx(tx, &key, &claim, &vector, None, 40)
        })
        .unwrap();
    assert!(
        dohc_engine_collab::read_marker(&source, &key)
            .unwrap()
            .is_none()
    );
    drain(&mut source);
    assert_eq!(exports(&source).len(), count_before);
}

#[test]
fn lane_cursor_does_not_queue_a_second_selection_before_the_next_push() {
    let (_scratch, _, mut source) = owner();
    let client = RelaySyncClient::new(RecordingRelay::default());
    write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
    lane(&mut source, "doc");
    client
        .push_workspace(&mut source, "ws", &NoFaults, &NoLiveLeases, 20, 0)
        .unwrap();
    write(&mut source, "doc", "b", "doc.md", "B", "ydoc", 30);
    commit_relay_cursor(
        &mut source,
        "ws",
        &RelayCursor {
            cursor: 0,
            replication_epoch: "epoch-1".into(),
            stream_identity: "stream-1".into(),
            bootstrap_complete: true,
            settlement_report_id: None,
            ordinary_pull: None,
        },
        &NoFaults,
        &NoLiveLeases,
        40,
    )
    .unwrap();
    assert_eq!(
        exports(&source).len(),
        1,
        "pull must leave the next selection to push"
    );
    write(&mut source, "doc", "c", "doc.md", "C", "ydoc", 50);
    client
        .push_workspace(&mut source, "ws", &NoFaults, &NoLiveLeases, 60, 0)
        .unwrap();
    let selected = exports(&source);
    assert_eq!(selected.len(), 2);
    assert_eq!(selected[1].payload["momentId"], "c");
    assert_eq!(selected[1].payload["beforeLatestMomentId"], "a");
    let pushes = client.transport().pushes.lock().unwrap();
    assert_eq!(pushes.last().unwrap().ops.len(), 1);
    assert_eq!(pushes.last().unwrap().ops[0].payload["momentId"], "c");
}

#[test]
fn lane_first_contact_push_selects_once_with_or_without_a_pending_origin() {
    for pending_origin in [false, true] {
        let (_scratch, _, mut source) = owner();
        write(&mut source, "doc", "a", "doc.md", "A", "ydoc", 10);
        lane(&mut source, "doc");
        write(&mut source, "doc", "b", "doc.md", "B", "ydoc", 20);
        source
            .write_with(&NoFaults, |tx| {
                tx.execute("DELETE FROM sync_relay_push_state", [])
                    .map_err(SyncError::persist)?;
                if pending_origin {
                    journal_local_op_in_tx(tx, "ws", "workspace.init", &json!({}), 1)?;
                }
                Ok::<_, SyncError>(())
            })
            .unwrap();
        let client = RelaySyncClient::new(RecordingRelay::default());
        client
            .push_workspace(&mut source, "ws", &NoFaults, &NoLiveLeases, 30, 0)
            .unwrap();
        let selected = exports(&source);
        assert_eq!(selected.len(), 1, "pending_origin={pending_origin}");
        assert_eq!(selected[0].payload["momentId"], "b");
        assert!(
            client
                .transport()
                .pushes
                .lock()
                .unwrap()
                .iter()
                .flat_map(|r| &r.ops)
                .any(|op| op.payload["momentId"] == "b")
        );
    }
}

#[test]
fn lane_first_local_export_uses_the_imported_state_as_its_bootstrap_preimage() {
    let (_owner_scratch, _, mut original) = owner();
    write(&mut original, "doc", "a", "doc.md", "A", "api", 10);
    original
        .write_with(&NoFaults, |tx| journal_moment_append_in_tx(tx, "ws", "a"))
        .unwrap();
    let (_peer_scratch, _, mut peer) = open_store();
    seed_replication_version(&mut peer, "main", "main");
    adopt_join_identity(
        &mut peer,
        "ws",
        "recipient",
        "epoch-1",
        "stream-1",
        1,
        &NoFaults,
    )
    .unwrap();
    peer.write_with(&NoFaults, |tx| {
        tx.execute(
            "INSERT INTO sync_relay_push_state VALUES ('ws','recipient',-1)",
            [],
        )
        .map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    })
    .unwrap();
    hydrate(&original, &mut peer);
    apply(&mut peer, &exports(&original)[0]);
    write(&mut peer, "doc", "b", "doc.md", "B", "ydoc", 20);
    lane(&mut peer, "doc");
    drain(&mut peer);
    let selected = exports(&peer);
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].payload["momentId"], "b");
    assert_eq!(selected[0].payload["beforePresent"], "present");
    assert_eq!(selected[0].payload["beforeLatestMomentId"], "a");
    hydrate(&peer, &mut original);
    apply(&mut original, &selected[0]);
    assert_eq!(count(&original, "conflicts"), 0);
    assert_eq!(count(&original, "moments"), 2);
}
