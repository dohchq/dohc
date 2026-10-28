use super::*;
use dohc_engine_collab::markdown_write_obligations::{self as obligations, Kind};
use dohc_engine_collab::{ContentKind, DocKey, WriterDocCache, Ydoc};
use yrs::{Map, ReadTxn, Transact};

const PATH: &str = "notes/held.md";
const ORIGIN: &str = "held-peer";

fn unsafe_witness_reader(scratch: &ScratchDir) -> dohc_engine_reader::Config {
    use dohc_engine_storage::hex_sha256;
    let node = std::env::var_os("DOHC_READER_TEST_NODE").unwrap_or_else(|| "node".into());
    let output = std::process::Command::new(node).args(["-p", "JSON.stringify({path:process.execPath,version:process.versions.node,platform:process.platform,arch:process.arch,unicode:process.versions.unicode,icu:process.versions.icu})"]).output().unwrap();
    assert!(output.status.success());
    let mut runtime: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let node = std::path::PathBuf::from(
        runtime
            .as_object_mut()
            .unwrap()
            .remove("path")
            .unwrap()
            .as_str()
            .unwrap(),
    );
    runtime["sha256"] = hex_sha256(&std::fs::read(&node).unwrap()).into();
    let mut manifest = json!({"version":1,"runtime":runtime,"buildSha256":"test","parentCwd":std::env::current_dir().unwrap()});
    let script = include_str!("../../../dohc-engine-reader/src/fake.cjs")
        .replace("MANIFEST", &manifest.to_string())
        .replace("MODE", "\"witness-unsafe\"");
    let bundle = scratch.path().join("unsafe-witness-reader.cjs");
    std::fs::write(&bundle, &script).unwrap();
    manifest["bundleSha256"] = hex_sha256(script.as_bytes()).into();
    manifest["sources"] = json!([]);
    let manifest_path = scratch.path().join("reader-manifest.json");
    std::fs::write(&manifest_path, manifest.to_string()).unwrap();
    dohc_engine_reader::Config {
        node,
        bundle,
        manifest: manifest_path,
    }
}

#[tokio::test]
async fn markdown_hold_winning_lineage_keeps_the_losing_source_and_recovers_local_edits() {
    use dohc_engine_storage::hex_sha256;
    for (deferred, pending_dependency) in
        [(false, false), (true, false), (false, true), (true, true)]
    {
        let mut f = Fixture::new();
        let source = "<div>Source meaning stays in this file</div>\n";
        let source_sha = seed_text_head(&mut f.store, &f.key.object_id, PATH, source);
        std::fs::create_dir_all(f.scratch.path().join("notes")).unwrap();
        std::fs::write(f.scratch.path().join(PATH), source).unwrap();
        let modified = std::fs::metadata(f.scratch.path().join(PATH))
            .unwrap()
            .modified()
            .unwrap();
        let local = Ydoc::wire();
        local.richdoc_append_paragraph("Source meaning stays in this file");
        let wire = yrs::Doc::new();
        let meta = wire.get_or_insert_map("meta");
        let projection_sha = hex_sha256(
            local
                .project(ContentKind::Richdoc)
                .unwrap()
                .content
                .as_bytes(),
        );
        {
            let mut tx = wire.transact_mut();
            meta.insert(&mut tx, "dohcMarkdownSource", source);
            meta.insert(&mut tx, "dohcMarkdownSourceSha256", source_sha.as_str());
            meta.insert(
                &mut tx,
                "dohcMarkdownSourceProjectionSha256",
                projection_sha.as_str(),
            );
        }
        local
            .apply(
                &wire
                    .transact()
                    .encode_state_as_update_v1(&yrs::StateVector::default()),
            )
            .unwrap();
        let base = local.encode_full_state();
        dohc_engine_collab::claim_base_at_relay(
            &mut f.store,
            &f.key,
            ContentKind::Richdoc,
            &base,
            &dohc_engine_collab::BaseRelayCoordinate::new("local", 0, 20).unwrap(),
            &NoFaults,
            1000,
        )
        .unwrap();
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_docs SET path=?1,last_settled_sha=?2",
                    params![PATH, source_sha],
                )
                .map_err(SyncError::persist)
            })
            .unwrap();
        let update = local.richdoc_append_paragraph("Losing local edits need their own copy");
        f.store
            .write_with(&NoFaults, |tx| {
                dohc_engine_collab::record_update_in_tx(tx, &f.key, &update, None, None, 1001)
            })
            .unwrap();
        if pending_dependency {
            let dependency = Ydoc::wire();
            dependency.plaintext_insert(0, "Missing predecessor");
            let pending = dependency.plaintext_insert(0, "Pending dependency");
            f.store
                .write_with(&NoFaults, |tx| {
                    dohc_engine_collab::record_update_in_tx(tx, &f.key, &pending, None, None, 1002)
                })
                .unwrap();
            assert!(
                dohc_engine_collab::load_persisted(&f.store, &f.key)
                    .unwrap()
                    .unwrap()
                    .doc
                    .has_pending_dependencies()
            );
        }
        let incoming = Ydoc::wire();
        incoming.apply(&base).unwrap();
        incoming.richdoc_append_paragraph("Winning lineage text");
        let bytes = incoming.encode_full_state();
        f.claim = f.store.put_binary_blob(&bytes).unwrap();
        let resolver = std::sync::Arc::new(
            dohc_engine_collab::reader_resolver::ReaderResolver::new(std::sync::Arc::new(
                dohc_engine_reader::Reader::new(Some(unsafe_witness_reader(&f.scratch))),
            )),
        );
        f.cache.reader_resolver = Some(resolver.clone());
        let mut op = f.op(0, &bytes, true);
        op.relay_seq = Some(10);
        let leases: &dyn LeaseProbe = if deferred { &AlwaysLive } else { &NoLiveLeases };
        loop {
            let result = if deferred {
                apply_ydoc_envelope(&mut f.store, &mut f.cache, &op, &NoFaults, leases).unwrap();
                drain_deferred_ydoc_for_key(&mut f.store, &mut f.cache, &f.key, &NoFaults)
                    .map(|_| ())
            } else {
                apply_ydoc_envelope(&mut f.store, &mut f.cache, &op, &NoFaults, leases).map(|_| ())
            };
            match result {
                Ok(()) => break,
                Err(SyncError::MarkdownWitnessCheckPending { pending, .. }) => {
                    pending.resolve().await
                }
                Err(error) => panic!("{error:?}"),
            }
        }
        let saved = VersionedTextStore::new(&mut f.store)
            .read_text("ws", "main", PATH)
            .unwrap()
            .unwrap();
        assert_eq!(saved.text, source);
        assert_eq!(saved.blob_sha256, source_sha);
        assert_eq!(
            std::fs::read_to_string(f.scratch.path().join(PATH)).unwrap(),
            source
        );
        assert_eq!(
            std::fs::metadata(f.scratch.path().join(PATH))
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
        let recovered: Vec<String> = f.store.read_with(|conn| {
            let mut stmt = conn.prepare("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.path<>?1")?;
            stmt.query_map([PATH], |row| row.get(0))?.collect::<rusqlite::Result<Vec<_>>>()
        }).unwrap();
        assert!(
            recovered
                .iter()
                .any(|text| text.contains("Losing local edits need their own copy"))
        );
        assert_eq!(f.store.table_row_count("conflicts").unwrap(), 0);
        assert_eq!(
            read_replication_acked_seq(&f.store, "ws", ORIGIN).unwrap(),
            0
        );
    }
}

#[test]
fn markdown_hold_winning_lineage_equal_text_needs_no_recovery_copy() {
    for deferred in [false, true] {
        let mut f = Fixture::new();
        f.store.write_with(&NoFaults, |tx| tx.execute(
            "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) VALUES ('ws','held-object',1000)",
            []).map_err(SyncError::persist)).unwrap();
        let local = Ydoc::wire();
        local.apply(&f.doc.encode_full_state()).unwrap();
        let source = local.project(ContentKind::Richdoc).unwrap().content;
        dohc_engine_collab::claim_base_at_relay(
            &mut f.store,
            &f.key,
            ContentKind::Richdoc,
            &local.encode_full_state(),
            &dohc_engine_collab::BaseRelayCoordinate::new("local", 0, 20).unwrap(),
            &NoFaults,
            1000,
        )
        .unwrap();
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE ydoc_docs SET path=?1", [PATH])
                    .map_err(SyncError::persist)
            })
            .unwrap();
        let dependency = Ydoc::wire();
        dependency.plaintext_insert(0, "Missing predecessor");
        let pending = dependency.plaintext_insert(0, "Pending dependency");
        f.store
            .write_with(&NoFaults, |tx| {
                dohc_engine_collab::record_update_in_tx(tx, &f.key, &pending, None, None, 1001)
            })
            .unwrap();
        assert!(
            dohc_engine_collab::load_persisted(&f.store, &f.key)
                .unwrap()
                .unwrap()
                .doc
                .has_pending_dependencies()
        );
        let incoming = Ydoc::wire();
        incoming.richdoc_append_paragraph("Accepted base text");
        assert_eq!(
            incoming.project(ContentKind::Richdoc).unwrap().content,
            source
        );
        let bytes = incoming.encode_full_state();
        f.claim = f.store.put_binary_blob(&bytes).unwrap();
        let mut op = f.op(0, &bytes, true);
        op.relay_seq = Some(10);
        let leases: &dyn LeaseProbe = if deferred { &AlwaysLive } else { &NoLiveLeases };
        apply_ydoc_envelope(&mut f.store, &mut f.cache, &op, &NoFaults, leases).unwrap();
        if deferred {
            assert_eq!(
                drain_deferred_ydoc_for_key(&mut f.store, &mut f.cache, &f.key, &NoFaults)
                    .unwrap()
                    .drained,
                1
            );
        }
        assert_eq!(f.store.table_row_count("snapshots").unwrap(), 0);
        assert_eq!(f.store.table_row_count("conflicts").unwrap(), 0);
        let persisted = dohc_engine_collab::load_persisted(&f.store, &f.key)
            .unwrap()
            .unwrap()
            .doc;
        assert_eq!(
            persisted.project(ContentKind::Richdoc).unwrap().content,
            source
        );
        assert_eq!(
            dohc_engine_collab::read_marker(&f.store, &f.key)
                .unwrap()
                .unwrap()
                .lineage_claim_id,
            Some(f.claim.clone())
        );
    }
}

struct Fixture {
    scratch: ScratchDir,
    db: std::path::PathBuf,
    store: EngineStore,
    cache: WriterDocCache,
    doc: Ydoc,
    key: DocKey,
    claim: String,
}

impl Fixture {
    fn new() -> Self {
        let (scratch, db, mut store) = open_store();
        seed_replication_version(&mut store, "main", "main");
        let doc = Ydoc::wire();
        doc.richdoc_append_paragraph("Accepted base text");
        // An incomplete witness is unsafe without a reader request.
        let wire = yrs::Doc::new();
        wire.get_or_insert_map("meta").insert(
            &mut wire.transact_mut(),
            "dohcMarkdownSource",
            "Source bytes have no complete witness",
        );
        doc.apply(
            &wire
                .transact()
                .encode_state_as_update_v1(&yrs::StateVector::default()),
        )
        .unwrap();
        let base = doc.encode_full_state();
        let claim = store.put_binary_blob(&base).unwrap();
        Self {
            scratch,
            db,
            store,
            cache: WriterDocCache::new(),
            doc,
            key: DocKey::new("ws", "main", "held-object").unwrap(),
            claim,
        }
    }

    fn op(&mut self, sequence: i64, bytes: &[u8], base: bool) -> ReplicationEnvelope {
        let sha = self.store.put_binary_blob(bytes).unwrap();
        envelope(
            ORIGIN,
            sequence,
            "ydoc.update",
            json!({
                "versionId":"main", "objectId":self.key.object_id, "path":PATH,
                "contentKind":"richdoc", "updateBlobSha256":sha,
                "lineageClaimId":self.claim, "isBaseState":base,
            }),
        )
    }

    fn base(&mut self) {
        let bytes = self.doc.encode_full_state();
        let op = self.op(0, &bytes, true);
        assert!(matches!(
            apply_ydoc_envelope(
                &mut self.store,
                &mut self.cache,
                &op,
                &NoFaults,
                &NoLiveLeases
            )
            .unwrap()
            .primary,
            ApplyDisposition::Applied(_)
        ));
        self.assert_absent();
    }

    fn assert_absent(&mut self) {
        assert!(
            VersionedTextStore::new(&mut self.store)
                .read_text("ws", "main", PATH)
                .unwrap()
                .is_none()
        );
        assert!(!self.scratch.path().join(PATH).exists());
        assert_eq!(self.store.table_row_count("moments").unwrap(), 0);
        assert_eq!(
            self.store.table_row_count("materialization_jobs").unwrap(),
            0
        );
        assert_eq!(
            self.store
                .table_row_count("live_device_settlements")
                .unwrap(),
            0
        );
        let marker = dohc_engine_collab::read_marker(&self.store, &self.key)
            .unwrap()
            .unwrap();
        assert_eq!(
            marker.lineage_claim_id.as_deref(),
            Some(self.claim.as_str())
        );
        assert!(
            dohc_engine_collab::read_last_settled_sha(&self.store, &self.key)
                .unwrap()
                .is_none()
        );
    }

    fn pending(&self) -> Vec<obligations::Obligation> {
        self.store
            .read_with(|conn| obligations::pending_in(conn, "ws"))
            .unwrap()
    }
}

#[test]
fn markdown_hold_fresh_base_keeps_claim_acknowledgement_and_absent_file() {
    let mut f = Fixture::new();
    f.base();
    assert_eq!(
        read_replication_acked_seq(&f.store, "ws", ORIGIN).unwrap(),
        0
    );
    assert_eq!(f.pending().len(), 1);
    assert_eq!(f.pending()[0].kind, Kind::SyncProjection);
    assert!(f.pending()[0].held_head_sha256.is_none());
    drop(f.store);
    f.store = EngineStore::open(&f.db, 3000).unwrap();
    f.cache = WriterDocCache::new();
    f.assert_absent();
    assert_eq!(f.pending().len(), 1);
    let persisted = dohc_engine_collab::load_persisted(&f.store, &f.key)
        .unwrap()
        .unwrap()
        .doc;
    assert!(
        persisted
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("Accepted base text")
    );
}

#[test]
fn markdown_hold_delta_retains_edits_and_allows_the_next_safe_object() {
    let mut f = Fixture::new();
    f.base();
    let delta = f
        .doc
        .richdoc_append_paragraph("Accepted delta stays canonical");
    let op = f.op(1, &delta, false);
    let outcome =
        apply_ydoc_envelope(&mut f.store, &mut f.cache, &op, &NoFaults, &NoLiveLeases).unwrap();
    assert!(
        matches!(outcome.primary, ApplyDisposition::Refused(ReplicationRefusal {
        reason: RefusalReason::InvalidInput { ref reason }, ..
    }) if reason == "markdown-write-held")
    );
    assert_eq!(
        read_replication_acked_seq(&f.store, "ws", ORIGIN).unwrap(),
        1
    );
    f.assert_absent();
    let persisted = dohc_engine_collab::load_persisted(&f.store, &f.key)
        .unwrap()
        .unwrap()
        .doc;
    assert!(
        persisted
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("Accepted delta stays canonical")
    );
    let safe = Ydoc::wire();
    safe.plaintext_insert(0, "A safe peer still saves");
    let sha = f.store.put_binary_blob(&safe.encode_full_state()).unwrap();
    let op = envelope(
        ORIGIN,
        2,
        "ydoc.update",
        json!({
            "versionId":"main", "objectId":"safe-object", "path":"safe.txt", "contentKind":"plaintext",
            "updateBlobSha256":sha, "lineageClaimId":sha, "isBaseState":true,
        }),
    );
    assert!(matches!(
        apply_ydoc_envelope(&mut f.store, &mut f.cache, &op, &NoFaults, &NoLiveLeases)
            .unwrap()
            .primary,
        ApplyDisposition::Applied(_)
    ));
    assert_eq!(
        read_replication_acked_seq(&f.store, "ws", ORIGIN).unwrap(),
        2
    );
    assert_eq!(
        VersionedTextStore::new(&mut f.store)
            .read_text("ws", "main", "safe.txt")
            .unwrap()
            .unwrap()
            .text,
        "A safe peer still saves"
    );
}

#[test]
fn markdown_hold_drain_consumes_coordinates_and_recovers_without_reapplying_edits() {
    let mut f = Fixture::new();
    f.base();
    let delta = f
        .doc
        .richdoc_append_paragraph("A parked edit survives terminal cleanup");
    let op = f.op(1, &delta, false);
    apply_ydoc_envelope(&mut f.store, &mut f.cache, &op, &NoFaults, &AlwaysLive).unwrap();
    assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 1);
    let drained =
        drain_deferred_ydoc_for_key(&mut f.store, &mut f.cache, &f.key, &NoFaults).unwrap();
    assert_eq!(drained.drained, 1);
    assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
    f.assert_absent();
    let persisted = dohc_engine_collab::load_persisted(&f.store, &f.key)
        .unwrap()
        .unwrap()
        .doc;
    assert!(
        persisted
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("A parked edit survives")
    );
    let clear = persisted.clear_markdown_source_witness();
    f.store
        .write_with(&NoFaults, |tx| {
            dohc_engine_collab::record_update_in_tx(tx, &f.key, &clear, None, None, 3000)
        })
        .unwrap();
    let before = dohc_engine_collab::read_marker(&f.store, &f.key)
        .unwrap()
        .unwrap()
        .head_update_seq;
    for owed in f.pending() {
        f.store
            .write_with(&NoFaults, |tx| {
                crate::retry_markdown_projection_in_tx(tx, &owed, None, None, 3001)
            })
            .unwrap();
    }
    assert!(f.pending().is_empty());
    assert_eq!(
        dohc_engine_collab::read_marker(&f.store, &f.key)
            .unwrap()
            .unwrap()
            .head_update_seq,
        before
    );
    assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    assert_eq!(f.store.table_row_count("materialization_jobs").unwrap(), 1);
    let saved = VersionedTextStore::new(&mut f.store)
        .read_text("ws", "main", PATH)
        .unwrap()
        .unwrap();
    assert!(saved.text.contains("A parked edit survives"));
    assert_eq!(
        read_replication_acked_seq(&f.store, "ws", ORIGIN).unwrap(),
        1
    );
}

#[test]
fn markdown_hold_coalesced_recovery_does_not_credit_a_later_provisional_author() {
    let mut f = Fixture::new();
    f.base();
    let delta = f
        .doc
        .richdoc_append_paragraph("Later content has no verified author");
    let op = f.op(1, &delta, false);
    apply_ydoc_envelope(&mut f.store, &mut f.cache, &op, &NoFaults, &NoLiveLeases).unwrap();
    let pending = f.pending();
    assert_eq!(pending.len(), 2);
    assert_eq!(pending[0].retry_inputs["provisionalAuthor"], false);
    assert_eq!(pending[1].retry_inputs["provisionalAuthor"], true);
    drop(f.store);
    f.store = EngineStore::open(&f.db, 3000).unwrap();
    f.cache = WriterDocCache::new();
    let persisted = dohc_engine_collab::load_persisted(&f.store, &f.key)
        .unwrap()
        .unwrap()
        .doc;
    let clear = persisted.clear_markdown_source_witness();
    f.store
        .write_with(&NoFaults, |tx| {
            dohc_engine_collab::record_update_in_tx(tx, &f.key, &clear, None, None, 3001)
        })
        .unwrap();
    let sequence = dohc_engine_collab::read_marker(&f.store, &f.key)
        .unwrap()
        .unwrap()
        .head_update_seq;
    for owed in f.pending() {
        f.store
            .write_with(&NoFaults, |tx| {
                crate::retry_markdown_projection_in_tx(tx, &owed, None, None, 3002)
            })
            .unwrap();
    }
    assert!(f.pending().is_empty());
    assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    assert_eq!(f.store.table_row_count("materialization_jobs").unwrap(), 1);
    assert_eq!(
        dohc_engine_collab::read_marker(&f.store, &f.key)
            .unwrap()
            .unwrap()
            .head_update_seq,
        sequence
    );
    let audit_requests: i64 =
        f.store
            .read_with(|conn| {
                conn.query_row(
        "SELECT count(*) FROM engine_requests WHERE kind='sync-ydoc-provisional-author'", [],
        |row| row.get(0))
            })
            .unwrap();
    assert_eq!(audit_requests, 0);
    let saved = VersionedTextStore::new(&mut f.store)
        .read_text("ws", "main", PATH)
        .unwrap()
        .unwrap();
    assert_eq!(
        saved
            .text
            .matches("Later content has no verified author")
            .count(),
        1
    );
    assert_eq!(
        read_replication_acked_seq(&f.store, "ws", ORIGIN).unwrap(),
        1
    );
}

#[test]
fn markdown_hold_live_and_ended_session_drains_consume_rows_without_a_file_receipt() {
    for live in [false, true] {
        let mut f = Fixture::new();
        f.base();
        let delta = f
            .doc
            .richdoc_append_paragraph("Parked content survives the session drain");
        let op = f.op(1, &delta, false);
        apply_ydoc_envelope(&mut f.store, &mut f.cache, &op, &NoFaults, &AlwaysLive).unwrap();
        let drained = if live {
            crate::drain_deferred_ydoc_for_live_session(
                &mut f.store,
                &mut f.cache,
                &f.key,
                Some(&f.claim),
                &NoFaults,
            )
            .unwrap()
        } else {
            assert!(matches!(
                crate::ydoc_apply::drain_deferred_ydoc_for_ended_session(
                    &mut f.store,
                    &mut f.cache,
                    &f.key,
                    &AlwaysLive,
                    &NoFaults
                ),
                Err(SyncError::LiveDocumentBindingActive)
            ));
            assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 1);
            crate::ydoc_apply::drain_deferred_ydoc_for_ended_session(
                &mut f.store,
                &mut f.cache,
                &f.key,
                &NoLiveLeases,
                &NoFaults,
            )
            .unwrap()
        };
        assert_eq!(drained.drained, 1);
        assert_eq!(drained.refusals.len(), 1);
        assert!(matches!(&drained.refusals[0].reason,
            RefusalReason::InvalidInput { reason } if reason == "markdown-write-held"));
        assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
        f.assert_absent();
        let persisted = dohc_engine_collab::load_persisted(&f.store, &f.key)
            .unwrap()
            .unwrap()
            .doc;
        assert_eq!(
            persisted
                .project(ContentKind::Richdoc)
                .unwrap()
                .content
                .matches("Parked content survives the session drain")
                .count(),
            1
        );
        assert!(
            f.pending()
                .iter()
                .all(|owed| owed.kind == Kind::SyncProjection)
        );
    }
}

#[test]
fn markdown_hold_delayed_drain_cleanup_survives_restart_and_keeps_the_refusal() {
    let mut f = Fixture::new();
    f.base();
    let delta = f.doc.richdoc_append_paragraph("Retained cleanup content");
    let op = f.op(1, &delta, false);
    apply_ydoc_envelope(&mut f.store, &mut f.cache, &op, &NoFaults, &AlwaysLive).unwrap();
    let (first, _unacknowledged) = crate::drain_deferred_ydoc_for_key_holding_cleanup(
        &mut f.store,
        &mut f.cache,
        &f.key,
        &NoFaults,
    )
    .unwrap();
    assert_eq!(first.drained, 1);
    assert!(first.refusals.is_empty());
    assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 1);
    let sequence = dohc_engine_collab::read_marker(&f.store, &f.key)
        .unwrap()
        .unwrap()
        .head_update_seq;
    f.assert_absent();
    drop(f.store);
    f.store = EngineStore::open(&f.db, 3000).unwrap();
    f.cache = WriterDocCache::new();
    let (second, cleanup) = crate::drain_deferred_ydoc_for_key_holding_cleanup(
        &mut f.store,
        &mut f.cache,
        &f.key,
        &NoFaults,
    )
    .unwrap();
    assert_eq!(second.drained, 1);
    assert_eq!(
        dohc_engine_collab::read_marker(&f.store, &f.key)
            .unwrap()
            .unwrap()
            .head_update_seq,
        sequence
    );
    let refusal = crate::complete_deferred_ydoc_drain_cleanup(&mut f.store, cleanup, &NoFaults)
        .unwrap()
        .expect("the terminal hold travels with delayed cleanup");
    assert!(
        matches!(refusal.reason, RefusalReason::InvalidInput { reason } if reason == "markdown-write-held")
    );
    assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
    assert_eq!(
        read_replication_acked_seq(&f.store, "ws", ORIGIN).unwrap(),
        1
    );
    f.assert_absent();
    assert!(
        !crate::list_refusal_notices(&f.store, "ws")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn markdown_hold_deferred_base_waits_for_the_recovery_lease_and_keeps_its_claim_after_drain() {
    let mut f = Fixture::new();
    f.store.write_with(&NoFaults, |tx| tx.execute(
        "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) VALUES ('ws','held-object',1000)",
        []).map_err(SyncError::persist)).unwrap();
    dohc_engine_collab::ensure_marker(
        &mut f.store,
        &f.key,
        ContentKind::Richdoc,
        dohc_engine_collab::Regime::Replicated,
        &NoFaults,
        1000,
    )
    .unwrap();
    let op = f.op(0, &f.doc.encode_full_state(), true);
    assert!(matches!(
        apply_ydoc_envelope(&mut f.store, &mut f.cache, &op, &NoFaults, &AlwaysLive)
            .unwrap()
            .primary,
        ApplyDisposition::Applied(YdocApplyResult { deferred: true, .. })
    ));
    assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 1);
    assert!(matches!(
        crate::ydoc_apply::drain_deferred_ydoc_for_ended_session(
            &mut f.store,
            &mut f.cache,
            &f.key,
            &AlwaysLive,
            &NoFaults
        ),
        Err(SyncError::LiveDocumentBindingActive)
    ));
    assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 1);
    let drained = crate::ydoc_apply::drain_deferred_ydoc_for_ended_session(
        &mut f.store,
        &mut f.cache,
        &f.key,
        &NoLiveLeases,
        &NoFaults,
    )
    .unwrap();
    assert_eq!(drained.drained, 1);
    assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
    assert_eq!(
        read_replication_acked_seq(&f.store, "ws", ORIGIN).unwrap(),
        0
    );
    f.assert_absent();
    assert_eq!(f.pending().len(), 1);
    assert_eq!(f.pending()[0].kind, Kind::SyncProjection);
    let persisted = dohc_engine_collab::load_persisted(&f.store, &f.key)
        .unwrap()
        .unwrap()
        .doc;
    assert!(persisted.has_markdown_witness());
    assert!(
        persisted
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("Accepted base text")
    );
}

#[test]
fn markdown_hold_winning_base_replacement_retains_unsafe_metadata_without_publishing_a_file() {
    for deferred in [false, true] {
        let mut f = Fixture::new();
        f.store.write_with(&NoFaults, |tx| tx.execute(
            "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) VALUES ('ws','held-object',1000)",
            []).map_err(SyncError::persist)).unwrap();
        let local = Ydoc::wire();
        local.richdoc_append_paragraph("Accepted base text");
        let local_base = local.encode_full_state();
        dohc_engine_collab::claim_base_at_relay(
            &mut f.store,
            &f.key,
            ContentKind::Richdoc,
            &local_base,
            &dohc_engine_collab::BaseRelayCoordinate::new("local", 0, 20).unwrap(),
            &NoFaults,
            1000,
        )
        .unwrap();
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE ydoc_docs SET path=?1", [PATH])
                    .map_err(SyncError::persist)
            })
            .unwrap();
        let mut op = f.op(0, &f.doc.encode_full_state(), true);
        op.relay_seq = Some(10);
        let leases: &dyn LeaseProbe = if deferred { &AlwaysLive } else { &NoLiveLeases };
        assert!(matches!(
            apply_ydoc_envelope(&mut f.store, &mut f.cache, &op, &NoFaults, leases)
                .unwrap()
                .primary,
            ApplyDisposition::Applied(_)
        ));
        if deferred {
            let drained =
                drain_deferred_ydoc_for_key(&mut f.store, &mut f.cache, &f.key, &NoFaults).unwrap();
            assert_eq!(drained.drained, 1);
            assert_eq!(drained.lineage_replacements.len(), 1);
            assert!(drained.lineage_replacements[0].recovered_paths.is_empty());
        }
        f.assert_absent();
        assert_eq!(f.store.table_row_count("conflicts").unwrap(), 0);
        assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
        assert_eq!(f.pending().len(), 1);
        assert_eq!(
            read_replication_acked_seq(&f.store, "ws", ORIGIN).unwrap(),
            0
        );
        let persisted = dohc_engine_collab::load_persisted(&f.store, &f.key)
            .unwrap()
            .unwrap()
            .doc;
        assert!(persisted.has_markdown_witness());
        assert!(
            persisted
                .project(ContentKind::Richdoc)
                .unwrap()
                .content
                .contains("Accepted base text")
        );
    }
}

#[test]
fn markdown_hold_provisional_pull_recovers_its_audit_and_base_check_after_restart() {
    let mut f = Fixture::new();
    let base = f.doc.encode_full_state();
    f.store.write_with(&NoFaults, |tx| tx.execute(
        "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) VALUES ('ws','held-object',1000)",
        []).map_err(SyncError::persist)).unwrap();
    dohc_engine_collab::claim_base_at_relay(
        &mut f.store,
        &f.key,
        ContentKind::Richdoc,
        &base,
        &dohc_engine_collab::BaseRelayCoordinate::new("base-peer", 0, 1).unwrap(),
        &NoFaults,
        1000,
    )
    .unwrap();
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET path=?1", [PATH])
                .map_err(SyncError::persist)
        })
        .unwrap();
    let delta = f
        .doc
        .richdoc_append_paragraph("A provisional visitor edit must retain its audit");
    let mut op = f.op(0, &delta, false);
    op.relay_seq = Some(2);
    let result =
        apply_ydoc_envelope(&mut f.store, &mut f.cache, &op, &NoFaults, &NoLiveLeases).unwrap();
    assert!(
        matches!(result.primary, ApplyDisposition::Refused(ReplicationRefusal {
        reason: RefusalReason::InvalidInput { ref reason }, ..
    }) if reason == "markdown-write-held")
    );
    let owed = f.pending().remove(0);
    assert_eq!(owed.retry_inputs["provisionalAuthor"], true);
    f.assert_absent();
    assert_eq!(
        read_replication_acked_seq(&f.store, "ws", ORIGIN).unwrap(),
        0
    );
    drop(f.store);
    f.store = EngineStore::open(&f.db, 3000).unwrap();
    f.cache = WriterDocCache::new();
    assert_eq!(f.pending().len(), 1);
    let doc = dohc_engine_collab::load_persisted(&f.store, &f.key)
        .unwrap()
        .unwrap()
        .doc;
    let clear = doc.clear_markdown_source_witness();
    f.store
        .write_with(&NoFaults, |tx| {
            dohc_engine_collab::record_update_in_tx(tx, &f.key, &clear, None, None, 3001)
        })
        .unwrap();
    let sequence = dohc_engine_collab::read_marker(&f.store, &f.key)
        .unwrap()
        .unwrap()
        .head_update_seq;
    assert_eq!(
        f.store
            .write_with(&NoFaults, |tx| crate::retry_markdown_projection_in_tx(
                tx, &owed, None, None, 3002
            ))
            .unwrap(),
        TxnOutcome::Committed(BaseOrigination::NothingToDo)
    );
    assert!(f.pending().is_empty());
    let moment = crate::ydoc_apply::ydoc_apply_moment_id(&f.key, PATH, ORIGIN, 0);
    let audit: (String, i64) = f.store.read_with(|conn| conn.query_row(
        "SELECT payload_hash,result_seq FROM engine_requests WHERE kind='sync-ydoc-provisional-author'", [],
        |row| Ok((row.get(0)?, row.get(1)?)))).unwrap();
    assert_eq!(audit, (moment, 0));
    assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    assert_eq!(
        dohc_engine_collab::read_marker(&f.store, &f.key)
            .unwrap()
            .unwrap()
            .head_update_seq,
        sequence
    );
    let saved = VersionedTextStore::new(&mut f.store)
        .read_text("ws", "main", PATH)
        .unwrap()
        .unwrap();
    assert_eq!(
        saved
            .text
            .matches("A provisional visitor edit must retain its audit")
            .count(),
        1
    );
    assert_eq!(
        read_replication_acked_seq(&f.store, "ws", ORIGIN).unwrap(),
        0
    );
}
