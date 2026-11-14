use super::*;
use dohc_engine_collab::LiveObjectBinding;

/// Makes `doc-b`'s `base` this host's current owner activation, as a
/// service host that holds the note live has it.
fn activate_b(store: &mut EngineStore, base: &[u8]) {
    let lineage = dohc_engine_storage::hex_sha256(base);
    let binding = LiveObjectBinding {
        workspace_id: "ws".into(),
        main_version_id: "main".into(),
        object_id: "doc-b".into(),
        lineage_claim_id: lineage.clone(),
        current_path: "a.md".into(),
        selector_paths: vec!["a.md".into()],
        restore_fence_generation: 0,
    };
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_storage::put_binary_blob(tx, base).map_err(SyncError::Storage)?;
            tx.execute(
                "INSERT OR IGNORE INTO blobs(sha256,byte_length,text) VALUES (?1,8,'hosted b')",
                [text_sha("hosted b")],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO live_owner_adoptions (relay_database_namespace,adoption_id, \
                   workspace_id,main_version_id,object_id,lineage_claim_id,binding_json, \
                   source_moment_id,source_digest,source_byte_length, \
                   baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest, \
                   coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor, \
                   terminal_receipt_json,host_coordinate_json,max_pending_bytes,max_pending_age_ms) \
                 VALUES ('relay','activation','ws','main','doc-b',?1,?2,'moment-owner-1',?3,8,0,0, \
                   'e','c',0,0,0,'null','{}',1048576,86400000)",
                params![lineage, serde_json::to_string(&binding).unwrap(), text_sha("hosted b")],
            )
            .map_err(SyncError::persist)?;
            tx.execute(ACTIVATE_ADOPTION, params!["relay", "activation", None::<String>])
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

/// `doc-b`'s queued owner edits: each one's native origin and the actor it
/// names.
fn owner_queue(store: &EngineStore) -> String {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT json_group_array(json_array( \
                   json_extract(native_source_json,'$.origin.kind'), \
                   json_extract(native_source_json,'$.origin.actorOriginId'))) \
                 FROM (SELECT e.* FROM owner_ydoc_outbox_entries e \
                   JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id \
                   WHERE o.object_id='doc-b' AND e.pending=1 ORDER BY e.sequence)",
                [],
                |row| row.get(0),
            )
        })
        .unwrap()
}

/// An owner device's live edit of `doc-b`, naming the file change it came
/// from when `moment_id` is set.
fn device_edit(
    feed: &HostedFeed,
    origin: &str,
    seq: i64,
    update: Vec<u8>,
    lineage: &str,
    moment_id: Option<&str>,
) {
    let sha = dohc_engine_storage::hex_sha256(&update);
    feed.blobs.lock().unwrap().insert(sha.clone(), update);
    let mut payload = json!({
        "versionId": "main",
        "objectId": "doc-b",
        "path": "a.md",
        "contentKind": "richdoc",
        "updateBlobSha256": sha,
        "lineageClaimId": lineage,
        "actorOriginId": "laptop",
        "isBaseState": false
    });
    if let Some(moment_id) = moment_id {
        payload["momentId"] = json!(moment_id);
    }
    feed.append(envelope(origin, seq, "ydoc.update", payload));
}

/// `doc-b`'s head: its text's digest and the moment that last wrote it.
fn head_b(store: &EngineStore) -> (String, String) {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT blob_sha256,latest_moment_id FROM snapshots WHERE object_id='doc-b'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap()
}

/// The device's file change its edit came from: `peer`'s text write of
/// `doc-b` from its head here. Answers the change's moment id.
fn device_change(feed: &HostedFeed, store: &EngineStore, seq: i64, text: &str) -> String {
    let (before_sha, before_moment) = head_b(store);
    let sha = text_sha(text);
    feed.blobs
        .lock()
        .unwrap()
        .insert(sha.clone(), text.as_bytes().to_vec());
    let moment_id = format!("moment-peer-{seq}");
    feed.append(envelope(
        "peer",
        seq,
        "moment.append",
        json!({
            "momentId": moment_id,
            "versionId": "main",
            "objectId": "doc-b",
            "objectCreatedAtMs": 1,
            "path": "a.md",
            "recordedAtMs": 2_000,
            "operation": "write",
            "payloadBeforeBlobSha256": before_sha,
            "payloadBeforePath": "a.md",
            "payloadAfterBlobSha256": sha,
            "payloadAfterPath": "a.md",
            "metadata": {"origin": "sync"},
            "beforePresent": "present",
            "beforeObjectId": "doc-b",
            "beforeVersionId": "main",
            "beforePath": "a.md",
            "beforeBlobSha256": before_sha,
            "beforeContentKind": "text",
            "beforeUpdatedAtMs": 1_500,
            "beforeLatestMomentId": before_moment,
            "beforeMetadata": {"origin": "sync"}
        }),
    ));
    moment_id
}

/// Sync while this host holds `doc-b` live, as its service host does.
fn live_sync(client: &RelaySyncClient<HostedFeed>, store: &mut EngineStore) {
    for _ in 0..64 {
        let mut cache = WriterDocCache::new();
        let outcome = loop {
            match client.pull_hosted_workspace(
                store,
                &mut cache,
                "ws",
                "relay",
                &NoFaults,
                &LiveSession("doc-b"),
            ) {
                Err(RelayError::ValidationPending(pending)) => {
                    pending.validate().wait().unwrap();
                }
                pass => break pass.unwrap(),
            }
        };
        commit(client, store, &outcome);
        if !outcome.has_more {
            return;
        }
    }
    panic!("the hosted replica did not catch up");
}

/// The relay's answer to `doc-b`'s queued device edit: accepted with a
/// receipt, or refused.
fn answer_device_edit(store: &mut EngineStore, accepted: bool) {
    let answer = if accepted {
        "UPDATE owner_ydoc_outbox_entries SET pending=0,update_blob_digest=NULL, \
           accepted_receipt_json='{\"accepted\":true}' \
         WHERE pending=1 AND outbox_id IN (SELECT outbox_id FROM owner_ydoc_outboxes \
           WHERE object_id='doc-b')"
    } else {
        "UPDATE owner_ydoc_outbox_entries SET pending=0, \
           terminal_blob_digest=update_blob_digest,update_blob_digest=NULL, \
           terminal_reason='The relay refused this edit.' \
         WHERE pending=1 AND outbox_id IN (SELECT outbox_id FROM owner_ydoc_outboxes \
           WHERE object_id='doc-b')"
    };
    store
        .write_with(&NoFaults, |tx| {
            assert_eq!(tx.execute(answer, []).map_err(SyncError::persist)?, 1);
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

fn has_moment(store: &EngineStore, moment_id: &str) -> bool {
    count(
        store,
        &format!("SELECT COUNT(*) FROM moments WHERE moment_id='{moment_id}'"),
    ) == 1
}

/// The owner edits a note from a second device while this host holds it
/// live. The edit joins the note's owner queue as that device's edit, for
/// the relay to deliver as it delivers every owner edit. Nothing is held or
/// left queued here, and the feed's redelivery of the same row adds nothing.
#[test]
fn an_owner_device_edit_of_an_activated_note_joins_its_owner_queue() {
    let (_scratch, _path, mut store, client, base, _echo, lineage) = ready_bound_richdoc_b();
    activate_b(&mut store, &base);
    let device = dohc_engine_collab::Ydoc::wire();
    device.apply(&base).unwrap();
    let edit = device.richdoc_append_paragraph("from the laptop");
    device_edit(client.transport(), "peer", 1, edit, &lineage, None);

    let outcome = pass(&client, &mut store, &NoFaults).unwrap();
    assert_eq!(outcome.held, BTreeMap::new());
    assert!(outcome.refusals.is_empty());
    assert!(commit(&client, &mut store, &outcome));
    assert_eq!(hold(&store, "doc-b"), None);
    assert_eq!(queued_b(&store), "[]");
    assert_eq!(owner_queue(&store), r#"[["nativeUpdate","laptop"]]"#);

    sync(&client, &mut store);
    assert_eq!(owner_queue(&store), r#"[["nativeUpdate","laptop"]]"#);
}

/// The new path itself refuses an update from a share, a link, the relay or
/// a service host, with no route or filter in front of it: it writes nothing
/// and leaves the update to today's path. An owner device's origin passes.
#[test]
fn only_an_owner_device_origin_joins_the_owner_queue_at_the_new_path() {
    let (_scratch, _path, mut store, _client, base, _echo, lineage) = ready_bound_richdoc_b();
    activate_b(&mut store, &base);
    let device = dohc_engine_collab::Ydoc::wire();
    device.apply(&base).unwrap();
    let edit = device.richdoc_append_paragraph("from elsewhere");
    let sha = store.put_binary_blob(&edit).unwrap();
    let key = dohc_engine_collab::DocKey::new("ws", "main", "doc-b").unwrap();
    let payload = json!({
        "versionId": "main",
        "objectId": "doc-b",
        "path": "a.md",
        "contentKind": "richdoc",
        "updateBlobSha256": sha,
        "lineageClaimId": lineage,
        "isBaseState": false
    });
    let journal = "SELECT COUNT(*) FROM ydoc_updates WHERE object_id='doc-b'";
    let before = count(&store, journal);
    for origin in [
        "share:recipient",
        "shared:workspace",
        "relay:collection-create:x",
        HOST,
    ] {
        let queued = store
            .write_with(&NoFaults, |tx| {
                crate::ydoc_apply::queue_device_update_for_test(
                    tx,
                    &key,
                    payload.clone(),
                    &edit,
                    origin,
                )
            })
            .unwrap();
        assert_eq!(queued, TxnOutcome::Committed(false), "{origin}");
    }
    assert_eq!(owner_queue(&store), "[]");
    assert_eq!(count(&store, journal), before);

    let queued = store
        .write_with(&NoFaults, |tx| {
            crate::ydoc_apply::queue_device_update_for_test(
                tx,
                &key,
                payload.clone(),
                &edit,
                "peer",
            )
        })
        .unwrap();
    assert_eq!(queued, TxnOutcome::Committed(true));
    assert_eq!(owner_queue(&store), r#"[["nativeUpdate",null]]"#);
}

/// Device edits that are each valid can together bring more authors into
/// the note's live interval than one moment can name. The edit past that
/// limit takes today's path. It writes nothing and the pull goes on.
#[test]
fn a_device_edit_past_the_author_limit_takes_todays_path() {
    let (_scratch, _path, mut store, _client, base, _echo, lineage) = ready_bound_richdoc_b();
    activate_b(&mut store, &base);
    let device = dohc_engine_collab::Ydoc::wire();
    device.apply(&base).unwrap();
    let key = dohc_engine_collab::DocKey::new("ws", "main", "doc-b").unwrap();
    let journal = "SELECT COUNT(*) FROM ydoc_updates WHERE object_id='doc-b'";
    let limit = dohc_engine_collab::author_coverage::MAX_INTERVAL_AUTHORS;
    let mut refused = None;
    for author in 0..=limit {
        let edit = device.richdoc_append_paragraph("x");
        let sha = store.put_binary_blob(&edit).unwrap();
        let payload = json!({
            "versionId": "main",
            "objectId": "doc-b",
            "path": "a.md",
            "contentKind": "richdoc",
            "updateBlobSha256": sha,
            "lineageClaimId": lineage,
            "actorOriginId": format!("agent-{author}"),
            "attribution": {"actorKind": "agent", "depth": 0},
            "isBaseState": false
        });
        let before = count(&store, journal);
        let queued = store
            .write_with(&NoFaults, |tx| {
                crate::ydoc_apply::queue_device_update_for_test(tx, &key, payload, &edit, "peer")
            })
            .unwrap();
        if queued == TxnOutcome::Committed(false) {
            assert_eq!(count(&store, journal), before);
            refused = Some(author);
            break;
        }
        assert_eq!(queued, TxnOutcome::Committed(true), "{author}");
    }
    let refused = refused.expect("the interval reached its author limit");
    assert!(refused + 1 >= limit, "{refused}");
}

/// An owner device's edit that names an actor this host's local edits would
/// refuse takes today's path. It writes nothing, and the pull goes on.
#[test]
fn a_device_edit_naming_an_actor_a_local_edit_refuses_takes_todays_path() {
    let (_scratch, _path, mut store, _client, base, _echo, lineage) = ready_bound_richdoc_b();
    activate_b(&mut store, &base);
    let device = dohc_engine_collab::Ydoc::wire();
    device.apply(&base).unwrap();
    let key = dohc_engine_collab::DocKey::new("ws", "main", "doc-b").unwrap();
    let journal = "SELECT COUNT(*) FROM ydoc_updates WHERE object_id='doc-b'";
    let edit = device.richdoc_append_paragraph("x");
    let sha = store.put_binary_blob(&edit).unwrap();
    let payload = json!({
        "versionId": "main",
        "objectId": "doc-b",
        "path": "a.md",
        "contentKind": "richdoc",
        "updateBlobSha256": sha,
        "lineageClaimId": lineage,
        "actorOriginId": "agent\u{85}x",
        "attribution": {"actorKind": "agent", "depth": 0},
        "isBaseState": false
    });
    let before = count(&store, journal);
    let queued = store
        .write_with(&NoFaults, |tx| {
            crate::ydoc_apply::queue_device_update_for_test(tx, &key, payload, &edit, "peer")
        })
        .unwrap();
    assert_eq!(queued, TxnOutcome::Committed(false));
    assert_eq!(count(&store, journal), before);
}

/// An owner device's edit naming a file change the queue can't record a wait
/// for takes today's path: an id out of bounds, or one that already waits.
#[test]
fn a_device_edit_naming_a_file_change_it_cannot_wait_for_takes_todays_path() {
    let (_scratch, _path, mut store, _client, base, _echo, lineage) = ready_bound_richdoc_b();
    activate_b(&mut store, &base);
    let device = dohc_engine_collab::Ydoc::wire();
    device.apply(&base).unwrap();
    let key = dohc_engine_collab::DocKey::new("ws", "main", "doc-b").unwrap();
    let journal = "SELECT COUNT(*) FROM ydoc_updates WHERE object_id='doc-b'";
    let long = "m".repeat(513);
    for (moment_id, joins) in [
        ("moment-twice", true),
        ("moment-twice", false),
        ("", false),
        (long.as_str(), false),
    ] {
        let edit = device.richdoc_append_paragraph("x");
        let sha = store.put_binary_blob(&edit).unwrap();
        let payload = json!({
            "versionId": "main",
            "objectId": "doc-b",
            "path": "a.md",
            "contentKind": "richdoc",
            "updateBlobSha256": sha,
            "lineageClaimId": lineage,
            "momentId": moment_id,
            "isBaseState": false
        });
        let before = count(&store, journal);
        let queued = store
            .write_with(&NoFaults, |tx| {
                crate::ydoc_apply::queue_device_update_for_test(tx, &key, payload, &edit, "peer")
            })
            .unwrap();
        assert_eq!(queued, TxnOutcome::Committed(joins), "{moment_id:.20}");
        if !joins {
            assert_eq!(count(&store, journal), before, "{moment_id:.20}");
        }
    }
}

/// While a restore of the note is under way on this host, a local edit is
/// refused, and an owner device's edit takes today's path. It writes
/// nothing.
#[test]
fn a_device_edit_during_a_restore_takes_todays_path() {
    let (_scratch, _path, mut store, _client, base, _echo, lineage) = ready_bound_richdoc_b();
    activate_b(&mut store, &base);
    let point = dohc_engine_storage::hex_sha256(b"restore point");
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_storage::put_binary_blob(tx, b"restore point")
                .map_err(SyncError::Storage)?;
            tx.execute(
                "INSERT INTO live_restore_fences (workspace_id,main_version_id,object_id, \
                   relay_database_namespace,operation_id,input_json,receipt_json, \
                   proposal_json,proposal_candidate_sha256,proposal_frozen_sha256, \
                   proposal_point_sha256,application_json,application_delivery_id) \
                 VALUES ('ws','main','doc-b','relay','restore','{\"newFence\":1}','{}', \
                   '{}',?1,?1,?1,'{}','delivery')",
                [&point],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let device = dohc_engine_collab::Ydoc::wire();
    device.apply(&base).unwrap();
    let edit = device.richdoc_append_paragraph("during the restore");
    let sha = store.put_binary_blob(&edit).unwrap();
    let key = dohc_engine_collab::DocKey::new("ws", "main", "doc-b").unwrap();
    let journal = "SELECT COUNT(*) FROM ydoc_updates WHERE object_id='doc-b'";
    let before = count(&store, journal);
    let queued = store
        .write_with(&NoFaults, |tx| {
            crate::ydoc_apply::queue_device_update_for_test(
                tx,
                &key,
                json!({
                    "versionId": "main",
                    "objectId": "doc-b",
                    "path": "a.md",
                    "contentKind": "richdoc",
                    "updateBlobSha256": sha,
                    "lineageClaimId": lineage,
                    "isBaseState": false
                }),
                &edit,
                "peer",
            )
        })
        .unwrap();
    assert_eq!(queued, TxnOutcome::Committed(false));
    assert_eq!(count(&store, journal), before);
    assert_eq!(owner_queue(&store), "[]");
}

/// A device edit held before this host held the note live, as one from an
/// older build, joins the owner queue once the note is activated and its
/// queue drains, and the note is ready again.
#[test]
fn a_held_device_edit_joins_the_owner_queue_when_the_queue_drains() {
    let (_scratch, _path, mut store, client, base, _echo, lineage) = ready_bound_richdoc_b();
    let device = dohc_engine_collab::Ydoc::wire();
    device.apply(&base).unwrap();
    let edit = device.richdoc_append_paragraph("from the laptop");
    device_edit(client.transport(), "peer", 1, edit, &lineage, None);
    sync(&client, &mut store);
    assert_eq!(hold(&store, "doc-b"), Some(HostedHold::LiveEditUnadmitted));
    assert_eq!(queued_b(&store), r#"[["peer",1,"hosted","relay"]]"#);

    activate_b(&mut store, &base);
    // The runtime drains the note's queue as its live session opens.
    let key = dohc_engine_collab::DocKey::new("ws", "main", "doc-b").unwrap();
    let drained = crate::ydoc_apply::drain_deferred_ydoc_for_key(
        &mut store,
        &mut WriterDocCache::new(),
        &key,
        &NoFaults,
    )
    .unwrap();
    assert!(drained.refusals.is_empty());
    assert_eq!(queued_b(&store), "[]");
    assert_eq!(owner_queue(&store), r#"[["nativeUpdate","laptop"]]"#);
    sync(&client, &mut store);
    assert_eq!(hold(&store, "doc-b"), None);
}

/// The owner edits a live note from a second device. The file change the
/// edit came from waits, with the note still ready here, until the relay
/// accepts the edit. Then it is the note's history, and the note's own text
/// here stays as the live session settles it: no file write and no conflict.
#[test]
fn a_device_file_change_waits_for_the_relay_and_applies_as_history_once_accepted() {
    let (_scratch, _path, mut store, client, base, _echo, lineage) = ready_bound_richdoc_b();
    activate_b(&mut store, &base);
    let device = dohc_engine_collab::Ydoc::wire();
    device.apply(&base).unwrap();
    let edit = device.richdoc_append_paragraph("from the laptop");
    let feed = client.transport();
    device_edit(feed, "peer", 1, edit, &lineage, Some("moment-peer-2"));
    let moment = device_change(feed, &store, 2, "hosted b\n\nfrom the laptop\n");
    let head = head_b(&store);

    live_sync(&client, &mut store);
    assert_eq!(hold(&store, "doc-b"), None);
    assert!(ready(&store, "doc-b"));
    assert_eq!(owner_queue(&store), r#"[["nativeUpdate","laptop"]]"#);
    assert!(!has_moment(&store, &moment));
    assert_eq!(retained(&store), 1);

    answer_device_edit(&mut store, true);
    live_sync(&client, &mut store);
    assert!(has_moment(&store, &moment));
    assert_eq!(head_b(&store), head);
    assert_eq!(retained(&store), 0);
    assert_eq!(count(&store, "SELECT COUNT(*) FROM conflicts"), 0);
    assert_eq!(
        count(&store, "SELECT COUNT(*) FROM live_device_update_covers"),
        0
    );
    assert_eq!(hold(&store, "doc-b"), None);
}

/// When the relay refuses a device's live edit, the file change it came
/// from takes the ordinary path: it waits while the note is live, with the
/// note still ready, and applies once the live session ends.
#[test]
fn a_device_file_change_takes_the_ordinary_path_once_the_relay_refuses_its_edit() {
    let (_scratch, _path, mut store, client, base, _echo, lineage) = ready_bound_richdoc_b();
    activate_b(&mut store, &base);
    let device = dohc_engine_collab::Ydoc::wire();
    device.apply(&base).unwrap();
    let edit = device.richdoc_append_paragraph("from the laptop");
    let feed = client.transport();
    device_edit(feed, "peer", 1, edit, &lineage, Some("moment-peer-2"));
    let moment = device_change(feed, &store, 2, "hosted b\n\nfrom the laptop\n");

    live_sync(&client, &mut store);
    assert_eq!(hold(&store, "doc-b"), None);
    assert!(!has_moment(&store, &moment));

    answer_device_edit(&mut store, false);
    live_sync(&client, &mut store);
    assert_eq!(hold(&store, "doc-b"), None);
    assert!(!has_moment(&store, &moment));
    assert_eq!(retained(&store), 1);

    sync(&client, &mut store);
    assert!(has_moment(&store, &moment));
    assert_eq!(retained(&store), 0);
    assert_eq!(
        count(&store, "SELECT COUNT(*) FROM live_device_update_covers"),
        0
    );
}
