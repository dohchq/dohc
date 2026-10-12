use super::*;
use dohc_engine_collab::{DocKey, LocalAppend, WriterDocCache, Ydoc, author_coverage};
use dohc_engine_domain::{ChangeActorKind, ChangeAttribution, RollbackTextFileMutation, WriteText};

const PATH: &str = "notes/projection.txt";

struct Fixture {
    store: EngineStore,
    cache: WriterDocCache,
    key: DocKey,
    doc: Ydoc,
    base_sha: String,
    _scratch: ScratchDir,
}

fn fixture() -> Fixture {
    let (scratch, _path, mut store) = open_store();
    seed_replication_version(&mut store, "main", "main");
    let doc = Ydoc::wire();
    let base_sha = store.put_binary_blob(&doc.encode_full_state()).unwrap();
    let key = DocKey::new("ws", "main", "projection-object").unwrap();
    let base = envelope(
        "projection-peer",
        0,
        "ydoc.update",
        json!({
            "versionId":"main", "objectId":key.object_id, "path":PATH,
            "contentKind":"plaintext", "updateBlobSha256":base_sha,
            "lineageClaimId":base_sha, "isBaseState":true,
        }),
    );
    let mut cache = WriterDocCache::new();
    assert!(matches!(
        apply_ydoc_envelope(&mut store, &mut cache, &base, &NoFaults, &NoLiveLeases)
            .unwrap()
            .primary,
        ApplyDisposition::Applied(_)
    ));
    Fixture {
        store,
        cache,
        key,
        doc,
        base_sha,
        _scratch: scratch,
    }
}

fn remote(f: &mut Fixture, seq: i64, bytes: &[u8], live: bool, named: bool) {
    let sha = f.store.put_binary_blob(bytes).unwrap();
    let mut op = envelope(
        "projection-peer",
        seq,
        "ydoc.update",
        json!({
            "versionId":"main", "objectId":f.key.object_id, "path":PATH,
            "contentKind":"plaintext", "updateBlobSha256":sha,
            "lineageClaimId":f.base_sha, "isBaseState":false,
        }),
    );
    if named {
        op.payload["actorOriginId"] = json!("typist");
        op.payload["attribution"] = json!({"actorKind":"human", "depth":0});
    }
    let leases: &dyn LeaseProbe = if live { &AlwaysLive } else { &NoLiveLeases };
    assert!(matches!(
        apply_ydoc_envelope(&mut f.store, &mut f.cache, &op, &NoFaults, leases)
            .unwrap()
            .primary,
        ApplyDisposition::Applied(_)
    ));
}

#[test]
fn replayed_projection_keeps_later_interval_authors() {
    replay_keeps_authors(false);
}

#[test]
fn converged_projection_replay_keeps_later_interval_authors() {
    replay_keeps_authors(true);
}

fn replay_keeps_authors(converged: bool) {
    for named in [false, true] {
        let mut f = fixture();
        // As in the retained-drain FTS regression, replay an inactive version
        // so an old disk job's preimage cannot mask the coverage assertion.
        seed_replication_version(&mut f.store, "other-active", "named");
        VersionedTextStore::new(&mut f.store)
            .set_active_version("ws", "other-active", &NoFaults)
            .unwrap();
        let update = f.doc.plaintext_insert(0, "historical");
        remote(&mut f, 1, &update, true, false);
        assert_eq!(
            drain_deferred_ydoc_for_key(&mut f.store, &mut f.cache, &f.key, &NoFaults)
                .unwrap()
                .drained,
            1,
        );
        // The projection committed, but cleanup failed and retained its row.
        f.store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO ydoc_deferred_updates \
                (workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms,lineage_claim_id,relay_seq) \
                VALUES ('ws','main',?1,'projection-peer',1,2000,?2,1)",
                params![f.key.object_id,f.base_sha]).map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        }).unwrap();
        if !converged {
            VersionedTextStore::new(&mut f.store)
                .write_text(
                    &WriteText {
                        workspace_id: "ws".into(),
                        version_id: "main".into(),
                        object_id: f.key.object_id.clone(),
                        path: PATH.into(),
                        text: "captured head".into(),
                        moment_id: "later-capture".into(),
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 2001,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
        }
        let doc = dohc_engine_collab::load_persisted(&f.store, &f.key)
            .unwrap()
            .unwrap()
            .doc;
        for update in [doc.plaintext_insert(0, "x"), doc.plaintext_delete(0, 1)] {
            dohc_engine_collab::record_local_update(
                &mut f.store,
                &mut f.cache,
                &f.key,
                &update,
                LocalAppend {
                    actor_origin_id: named.then_some("typist"),
                    attribution: named
                        .then_some(ChangeAttribution {
                            actor_kind: ChangeActorKind::Human,
                            on_behalf_of: None,
                            depth: 0,
                            run: None,
                        })
                        .as_ref(),
                    ..LocalAppend::default()
                },
                &NoFaults,
                2002,
                |_, _, _| Ok(()),
            )
            .unwrap();
        }
        assert_eq!(doc.plaintext_string(), "historical");
        let before = f
            .store
            .read_with(|conn| author_coverage::interval_in(conn, &f.key, i64::MAX))
            .unwrap()
            .json();
        let expected = if named {
            json!([{"kind":"human","humanId":"typist"}])
        } else {
            json!([{"kind":"unattributed"}])
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&before).unwrap(),
            expected
        );
        let boundary: Option<i64> = f.store.read_with(|conn| conn.query_row(
            "SELECT settled_update_seq FROM ydoc_docs WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
            [&f.key.object_id], |row| row.get(0),
        )).unwrap();
        let moments: i64 = f
            .store
            .read_with(|conn| conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0)))
            .unwrap();
        assert_eq!(
            drain_deferred_ydoc_for_key(&mut f.store, &mut f.cache, &f.key, &NoFaults)
                .unwrap()
                .drained,
            1,
        );
        let after = f
            .store
            .read_with(|conn| author_coverage::interval_in(conn, &f.key, i64::MAX))
            .unwrap()
            .json();
        assert_eq!(after, before, "a replay has not recorded the later typist");
        let state: (Option<i64>, i64, i64) = f.store.read_with(|conn| Ok::<_,rusqlite::Error>((
            conn.query_row("SELECT settled_update_seq FROM ydoc_docs WHERE workspace_id='ws' AND version_id='main' AND object_id=?1", [&f.key.object_id], |row| row.get(0))?,
            conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0))?,
            conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| row.get(0))?,
        ))).unwrap();
        assert_eq!(state, (boundary, moments, 0));
    }
}

fn outstanding_audits(f: &Fixture) -> i64 {
    f.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM engine_requests WHERE kind='sync-ydoc-provisional-author'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap()
}

#[test]
fn actorless_projection_audit_requests_are_bounded_and_expire() {
    let mut f = fixture();
    for seq in 1..=64 {
        let update = f.doc.plaintext_insert(seq - 1, "x");
        remote(&mut f, seq as i64, &update, false, false);
        assert_eq!(outstanding_audits(&f), 1);
    }
    let update = f.doc.plaintext_insert(64, "named");
    remote(&mut f, 65, &update, false, true);
    assert_eq!(
        outstanding_audits(&f),
        0,
        "the next interval advanced past the provisional moment"
    );
    let update = f.doc.plaintext_insert(69, "unknown");
    remote(&mut f, 66, &update, false, false);
    assert_eq!(outstanding_audits(&f), 1);
    f.store
        .write_with(&NoFaults, |tx| author_coverage::reset_in(tx, &f.key, false))
        .unwrap();
    assert_eq!(
        outstanding_audits(&f),
        0,
        "lineage reset discards pending proof"
    );
    let update = f.doc.plaintext_insert(76, "last");
    remote(&mut f, 67, &update, false, false);
    assert_eq!(outstanding_audits(&f), 1);
    let moment_id = crate::ydoc_apply::ydoc_apply_moment_id(&f.key, PATH, "projection-peer", 67);
    VersionedTextStore::new(&mut f.store)
        .rollback_text_file_mutation(
            &RollbackTextFileMutation {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                path: PATH.into(),
                mutation_moment_id: moment_id.clone(),
                request_id: None,
                metadata_origin: "api".into(),
                author_json: None,
            },
            &NoFaults,
        )
        .unwrap();
    assert!(
        VersionedTextStore::new(&mut f.store)
            .get_moment("ws", &moment_id)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        outstanding_audits(&f),
        0,
        "pruning its moment removes the outstanding audit"
    );
}
