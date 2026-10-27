use super::*;
use dohc_engine_collab::{ContentKind, DocKey, WriterDocCache, Ydoc};
use dohc_engine_collab::markdown_write_obligations::{self as obligations, Kind};
use yrs::{Map, ReadTxn, Transact};

const PATH: &str = "notes/held.md";
const ORIGIN: &str = "held-peer";

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
        wire.get_or_insert_map("meta").insert(&mut wire.transact_mut(),
            "dohcMarkdownSource", "Source bytes have no complete witness");
        doc.apply(&wire.transact().encode_state_as_update_v1(&yrs::StateVector::default())).unwrap();
        let base = doc.encode_full_state();
        let claim = store.put_binary_blob(&base).unwrap();
        Self { scratch, db, store, cache: WriterDocCache::new(), doc,
            key: DocKey::new("ws", "main", "held-object").unwrap(), claim }
    }

    fn op(&mut self, sequence: i64, bytes: &[u8], base: bool) -> ReplicationEnvelope {
        let sha = self.store.put_binary_blob(bytes).unwrap();
        envelope(ORIGIN, sequence, "ydoc.update", json!({
            "versionId":"main", "objectId":self.key.object_id, "path":PATH,
            "contentKind":"richdoc", "updateBlobSha256":sha,
            "lineageClaimId":self.claim, "isBaseState":base,
        }))
    }

    fn base(&mut self) {
        let bytes = self.doc.encode_full_state();
        let op = self.op(0, &bytes, true);
        assert!(matches!(apply_ydoc_envelope(&mut self.store, &mut self.cache, &op,
            &NoFaults, &NoLiveLeases).unwrap().primary, ApplyDisposition::Applied(_)));
        self.assert_absent();
    }

    fn assert_absent(&mut self) {
        assert!(VersionedTextStore::new(&mut self.store).read_text("ws", "main", PATH).unwrap().is_none());
        assert!(!self.scratch.path().join(PATH).exists());
        assert_eq!(self.store.table_row_count("moments").unwrap(), 0);
        assert_eq!(self.store.table_row_count("materialization_jobs").unwrap(), 0);
        assert_eq!(self.store.table_row_count("live_device_settlements").unwrap(), 0);
        let marker = dohc_engine_collab::read_marker(&self.store, &self.key).unwrap().unwrap();
        assert_eq!(marker.lineage_claim_id.as_deref(), Some(self.claim.as_str()));
        assert!(dohc_engine_collab::read_last_settled_sha(&self.store, &self.key).unwrap().is_none());
    }

    fn pending(&self) -> Vec<obligations::Obligation> {
        self.store.read_with(|conn| obligations::pending_in(conn, "ws")).unwrap()
    }
}

#[test]
fn markdown_hold_fresh_base_keeps_claim_acknowledgement_and_absent_file() {
    let mut f = Fixture::new();
    f.base();
    assert_eq!(read_replication_acked_seq(&f.store, "ws", ORIGIN).unwrap(), 0);
    assert_eq!(f.pending().len(), 1);
    assert_eq!(f.pending()[0].kind, Kind::SyncProjection);
    assert!(f.pending()[0].held_head_sha256.is_none());
    drop(f.store);
    f.store = EngineStore::open(&f.db, 3000).unwrap();
    f.cache = WriterDocCache::new();
    f.assert_absent();
    assert_eq!(f.pending().len(), 1);
    let persisted = dohc_engine_collab::load_persisted(&f.store, &f.key).unwrap().unwrap().doc;
    assert!(persisted.project(ContentKind::Richdoc).unwrap().content.contains("Accepted base text"));
}

#[test]
fn markdown_hold_delta_retains_edits_and_allows_the_next_safe_object() {
    let mut f = Fixture::new();
    f.base();
    let delta = f.doc.richdoc_append_paragraph("Accepted delta stays canonical");
    let op = f.op(1, &delta, false);
    let outcome = apply_ydoc_envelope(&mut f.store, &mut f.cache, &op, &NoFaults, &NoLiveLeases).unwrap();
    assert!(matches!(outcome.primary, ApplyDisposition::Refused(ReplicationRefusal {
        reason: RefusalReason::InvalidInput { ref reason }, ..
    }) if reason == "markdown-write-held"));
    assert_eq!(read_replication_acked_seq(&f.store, "ws", ORIGIN).unwrap(), 1);
    f.assert_absent();
    let persisted = dohc_engine_collab::load_persisted(&f.store, &f.key).unwrap().unwrap().doc;
    assert!(persisted.project(ContentKind::Richdoc).unwrap().content.contains("Accepted delta stays canonical"));
    let safe = Ydoc::wire();
    safe.plaintext_insert(0, "A safe peer still saves");
    let sha = f.store.put_binary_blob(&safe.encode_full_state()).unwrap();
    let op = envelope(ORIGIN, 2, "ydoc.update", json!({
        "versionId":"main", "objectId":"safe-object", "path":"safe.txt", "contentKind":"plaintext",
        "updateBlobSha256":sha, "lineageClaimId":sha, "isBaseState":true,
    }));
    assert!(matches!(apply_ydoc_envelope(&mut f.store, &mut f.cache, &op, &NoFaults,
        &NoLiveLeases).unwrap().primary, ApplyDisposition::Applied(_)));
    assert_eq!(read_replication_acked_seq(&f.store, "ws", ORIGIN).unwrap(), 2);
    assert_eq!(VersionedTextStore::new(&mut f.store).read_text("ws", "main", "safe.txt")
        .unwrap().unwrap().text, "A safe peer still saves");
}

#[test]
fn markdown_hold_drain_consumes_coordinates_and_recovers_without_reapplying_edits() {
    let mut f = Fixture::new();
    f.base();
    let delta = f.doc.richdoc_append_paragraph("A parked edit survives terminal cleanup");
    let op = f.op(1, &delta, false);
    apply_ydoc_envelope(&mut f.store, &mut f.cache, &op, &NoFaults, &AlwaysLive).unwrap();
    assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 1);
    let drained = drain_deferred_ydoc_for_key(&mut f.store, &mut f.cache, &f.key, &NoFaults).unwrap();
    assert_eq!(drained.drained, 1);
    assert_eq!(f.store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
    f.assert_absent();
    let persisted = dohc_engine_collab::load_persisted(&f.store, &f.key).unwrap().unwrap().doc;
    assert!(persisted.project(ContentKind::Richdoc).unwrap().content.contains("A parked edit survives"));
    let clear = persisted.clear_markdown_source_witness();
    f.store.write_with(&NoFaults, |tx| dohc_engine_collab::record_update_in_tx(
        tx, &f.key, &clear, None, None, 3000)).unwrap();
    let before = dohc_engine_collab::read_marker(&f.store, &f.key).unwrap().unwrap().head_update_seq;
    for owed in f.pending() {
        f.store.write_with(&NoFaults, |tx| crate::retry_markdown_projection_in_tx(tx, &owed,
            None, None, 3001)).unwrap();
    }
    assert!(f.pending().is_empty());
    assert_eq!(dohc_engine_collab::read_marker(&f.store, &f.key).unwrap().unwrap().head_update_seq, before);
    assert_eq!(f.store.table_row_count("moments").unwrap(), 1);
    assert_eq!(f.store.table_row_count("materialization_jobs").unwrap(), 1);
    let saved = VersionedTextStore::new(&mut f.store).read_text("ws", "main", PATH).unwrap().unwrap();
    assert!(saved.text.contains("A parked edit survives"));
    assert_eq!(read_replication_acked_seq(&f.store, "ws", ORIGIN).unwrap(), 1);
}
