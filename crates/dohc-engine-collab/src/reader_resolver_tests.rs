use super::*;
use crate::ContentKind;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;

fn fixture() -> (Connection, DocKey, Ydoc, String, ReaderResolver) {
    let data: Value = serde_json::from_str(include_str!("../tests/reader-resolver.json")).unwrap();
    let source = data["source"].as_str().unwrap().to_owned();
    let doc = Ydoc::wire();
    doc.apply(
        &STANDARD
            .decode(data["checkpoint"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE ydoc_docs (
      workspace_id TEXT,version_id TEXT,object_id TEXT,content_kind TEXT DEFAULT 'richdoc',
      regime TEXT DEFAULT 'local-only',head_update_seq INTEGER DEFAULT 1,head_snapshot_seq INTEGER DEFAULT 0,
      lineage_claim_status TEXT DEFAULT 'exact',lineage_claim_id TEXT DEFAULT 'l',lineage_parent_claim_id TEXT,
      lineage_epoch_tag TEXT DEFAULT 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',path TEXT DEFAULT 'note.md',base_origin_id TEXT,base_origin_seq INTEGER,
      base_relay_seq INTEGER,base_relay_confirmed_absent INTEGER DEFAULT 0,file_export_lane INTEGER DEFAULT 0,last_settled_sha TEXT);
      INSERT INTO ydoc_docs(workspace_id,version_id,object_id) VALUES('w','main','fixture');
      CREATE TABLE snapshots(workspace_id TEXT,version_id TEXT,object_id TEXT,content_kind TEXT,
        blob_sha256 TEXT,latest_moment_id TEXT,path TEXT);
      CREATE TABLE blobs(sha256 TEXT,text TEXT,byte_length INTEGER);
      CREATE TABLE live_restore_fences(workspace_id TEXT,main_version_id TEXT,object_id TEXT,
        new_generation INTEGER,resume_receipt_json TEXT,cancelled_json TEXT,relay_database_namespace TEXT,
        lineage_claim_id TEXT,operation_id TEXT,input_json TEXT,receipt_json TEXT);").unwrap();
    let sha = crate::hex_sha256(source.as_bytes());
    conn.execute(
        "INSERT INTO blobs VALUES(?1,?2,?3)",
        params![sha, source, source.len() as i64],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO snapshots VALUES('w','main','fixture','text',?1,'moment','note.md')",
        [&sha],
    )
    .unwrap();
    (
        conn,
        DocKey::new("w", "main", "fixture").unwrap(),
        doc,
        source,
        ReaderResolver::new(Arc::new(Reader::new(None))),
    )
}

#[test]
fn outside_fold_round1_unclaimed_note_skips_document_load() {
    let (conn, key, _, _, _) = fixture();
    conn.execute("UPDATE ydoc_docs SET lineage_claim_id=NULL", [])
        .unwrap();
    assert!(prepare_fold(&conn, &key, "note.md", "**changed**")
        .expect("unclaimed document was loaded")
        .is_none());
}

fn canonical_fold_clears_the_reader_marker(staging: bool) {
    let (_, _, doc, _, _) = fixture();
    assert!(doc.has_reader_source());
    if staging {
        let canonical = doc.project(ContentKind::Richdoc).unwrap().content;
        let update = doc.replace_frontmatter_for_fold(&canonical).unwrap();
        doc.apply(&update).unwrap();
    } else {
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, "Canonical paragraph\n")
            .unwrap();
    }
    assert!(
        doc.markdown_source_reference().is_none(),
        "staging={staging}"
    );
    assert!(!doc.has_reader_source(), "staging={staging}");
}

#[test]
fn canonical_folds_clear_the_reader_marker_with_the_witness() {
    canonical_fold_clears_the_reader_marker(false);
}

#[test]
fn canonical_staging_clears_the_reader_marker_with_the_witness() {
    canonical_fold_clears_the_reader_marker(true);
}

#[test]
fn source_recording_cannot_silently_downgrade_a_reader_document() {
    let (_, _, doc, source, _) = fixture();
    let before = doc.encode_full_state();
    let result = doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, &source);
    assert!(matches!(
        result,
        Err(CollabError::MarkdownReaderUnavailable)
    ));
    assert_eq!(doc.encode_full_state(), before);
    assert!(doc.has_reader_source());
}

#[test]
fn frontmatter_source_recording_keeps_the_reader_marker() {
    let (_, _, doc, source, _) = fixture();
    let markdown = format!("---\ntitle: changed\n---\n{source}");
    doc.frontmatter_set_preserving_markdown_source("title", "changed", &markdown)
        .unwrap();
    assert!(doc.has_reader_source());
    assert_eq!(
        doc.markdown_source(&doc.markdown_source_reference().unwrap())
            .as_deref(),
        Some(markdown.as_str())
    );
}

#[test]
fn ordinary_source_recording_and_frontmatter_edits_do_not_create_a_reader_marker() {
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "plain paragraph")
        .unwrap();
    assert!(!doc.has_reader_source());
    doc.frontmatter_set_preserving_markdown_source(
        "title",
        "changed",
        "---\ntitle: changed\n---\nplain paragraph",
    )
    .unwrap();
    assert!(!doc.has_reader_source());
}

#[test]
fn construction_as_proof_refuses_body_deletions() {
    use yrs::{updates::decoder::Decode, ReadTxn, Transact, XmlFragment};
    let (_, _, live, _, _) = fixture();
    let before = live.encode_full_state();
    let clone = yrs::Doc::new();
    clone
        .transact_mut()
        .apply_update(yrs::Update::decode_v1(&before).unwrap())
        .unwrap();
    let vector = clone.transact().state_vector();
    let body = clone.get_or_insert_xml_fragment("body");
    let length = body.len(&clone.transact());
    assert!(length > 0);
    body.remove_range(&mut clone.transact_mut(), 0, length);
    let delta = clone.transact().encode_state_as_update_v1(&vector);
    assert!(!crate::replay_parity::reader_metadata_only(&before, &delta).unwrap());
    assert_eq!(live.encode_full_state(), before);
}

fn reject_native_metadata(key: &str) {
    reject_native_metadata_value(key, yrs::Any::String("unexpected".into()));
}

fn reject_native_metadata_value(key: &str, value: yrs::Any) {
    use yrs::{updates::decoder::Decode, Map, ReadTxn, Transact};
    let base = Ydoc::wire();
    base.rewrite_content_to_markdown(ContentKind::Richdoc, "Before")
        .unwrap();
    let before = base.encode_full_state();
    let raw = yrs::Doc::new();
    raw.transact_mut()
        .apply_update(yrs::Update::decode_v1(&before).unwrap())
        .unwrap();
    let vector = raw.transact().state_vector();
    raw.get_or_insert_map("meta")
        .insert(&mut raw.transact_mut(), key, value);
    let delta = raw.transact().encode_state_as_update_v1(&vector);
    assert!(base.native_fold_candidate(&delta).is_err(), "{key}");
    assert_eq!(base.encode_full_state(), before);
}

#[test]
fn native_fold_candidate_rejects_source() {
    reject_native_metadata("dohcMarkdownSource");
}
#[test]
fn native_fold_candidate_rejects_source_digest() {
    reject_native_metadata("dohcMarkdownSourceSha256");
}
#[test]
fn native_fold_candidate_rejects_source_witness() {
    reject_native_metadata("dohcMarkdownSourceProjectionSha256");
}
#[test]
fn native_fold_candidate_rejects_reader_marker() {
    reject_native_metadata("dohcMarkdownSourceReader");
}
#[test]
fn native_fold_candidate_rejects_unknown_metadata() {
    reject_native_metadata("unknown");
}

#[test]
fn native_fold_candidate_rejects_non_string_epoch_metadata() {
    reject_native_metadata_value("dohcLineageEpoch", yrs::Any::Number(7.0));
}

#[test]
fn native_fold_candidate_rejects_pending_updates() {
    let base = Ydoc::wire();
    base.rewrite_content_to_markdown(ContentKind::Richdoc, "Before")
        .unwrap();
    let missing = Ydoc::wire();
    missing.richdoc_append_paragraph("Missing dependency");
    let delta = missing.richdoc_append_paragraph("Cannot integrate");
    assert!(base.native_fold_candidate(&delta).is_err());
}

#[test]
fn construction_as_proof_cannot_change_content_or_unknown_metadata() {
    let (_, _, doc, _, _) = fixture();
    let before = doc.encode_full_state();
    let body = doc.richdoc_append_paragraph("must not be repaired by proof");
    assert!(!crate::replay_parity::reader_metadata_only(&before, &body).unwrap());
    use yrs::{updates::decoder::Decode, Map, ReadTxn, Transact, Xml, XmlFragment};
    for key in ["schemaVersion", "dohcLineageEpoch", "foreign"] {
        let raw = yrs::Doc::new();
        raw.transact_mut()
            .apply_update(yrs::Update::decode_v1(&before).unwrap())
            .unwrap();
        let vector = raw.transact().state_vector();
        raw.get_or_insert_map("meta")
            .insert(&mut raw.transact_mut(), key, "changed");
        let delta = raw.transact().encode_state_as_update_v1(&vector);
        assert!(
            !crate::replay_parity::reader_metadata_only(&before, &delta).unwrap(),
            "{key}"
        );
    }
    let raw = yrs::Doc::new();
    raw.transact_mut()
        .apply_update(yrs::Update::decode_v1(&before).unwrap())
        .unwrap();
    let vector = raw.transact().state_vector();
    let root = raw.get_or_insert_xml_fragment("body");
    let element = root.get(&raw.transact(), 0).unwrap();
    let yrs::XmlOut::Element(element) = element else {
        panic!("expected element")
    };
    element.insert_attribute(&mut raw.transact_mut(), "foreign", "value");
    let delta = raw.transact().encode_state_as_update_v1(&vector);
    assert!(!crate::replay_parity::reader_metadata_only(&before, &delta).unwrap());
    // The body edit above belongs only to this local test document. Proof
    // construction receives immutable checkpoint bytes, never that document.
    let (_, _, live, _, _) = fixture();
    let unchanged = live.encode_full_state();
    assert!(!crate::replay_parity::reader_metadata_only(&before, &delta).unwrap());
    assert_eq!(live.encode_full_state(), unchanged);
}

#[test]
#[ignore = "the Rust gate's reader phase runs it with DOHC_ENGINE_READER_CONFIG"]
fn real_reader_proves_frontmatter_source_without_rewriting_live_state() {
    let config =
        serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
    let (conn, key, doc, source, _) = fixture();
    let resolver = ReaderResolver::new(Arc::new(Reader::new(Some(config))));
    let markdown = format!("---\ntitle: changed\n---\n{source}");
    doc.frontmatter_set_preserving_markdown_source("title", "changed", &markdown)
        .unwrap();
    let sha = crate::hex_sha256(markdown.as_bytes());
    conn.execute(
        "UPDATE blobs SET sha256=?1,text=?2,byte_length=?3",
        params![sha, markdown, markdown.len() as i64],
    )
    .unwrap();
    conn.execute("UPDATE snapshots SET blob_sha256=?1", [&sha])
        .unwrap();
    let before = doc.encode_full_state();
    run(pending(lookup(&conn, &key, &doc, &resolver)).resolve());
    assert_eq!(
        lookup(&conn, &key, &doc, &resolver).unwrap(),
        Some(markdown)
    );
    assert_eq!(doc.encode_full_state(), before);
    assert!(doc.has_reader_source());
}

#[test]
fn restore_generation_sql_errors_keep_their_storage_cause() {
    let (conn, key, doc, _, resolver) = fixture();
    conn.execute("DROP TABLE live_restore_fences", []).unwrap();
    assert!(matches!(
        lookup(&conn, &key, &doc, &resolver),
        Err(CollabError::Storage(_))
    ));
}

#[test]
fn expired_proofs_must_match_the_engine_projection() {
    use std::{fs, process::Command};
    let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
    let node = std::env::var_os("DOHC_READER_TEST_NODE").unwrap_or_else(|| "node".into());
    let output = Command::new(node).args(["-p", "JSON.stringify({path:process.execPath,version:process.versions.node,platform:process.platform,arch:process.arch,unicode:process.versions.unicode,icu:process.versions.icu})"]).output().unwrap();
    assert!(output.status.success());
    let mut runtime: Value = serde_json::from_slice(&output.stdout).unwrap();
    let node = std::path::PathBuf::from(
        runtime
            .as_object_mut()
            .unwrap()
            .remove("path")
            .unwrap()
            .as_str()
            .unwrap(),
    );
    runtime["sha256"] = crate::hex_sha256(&fs::read(&node).unwrap()).into();
    let identity = serde_json::json!({"version":1,"runtime":runtime,"buildSha256":"test","parentCwd":std::env::current_dir().unwrap()});
    let script = include_str!("../../dohc-engine-reader/src/fake.cjs")
        .replace("MANIFEST", &identity.to_string())
        .replace("MODE", "\"normal\"")
        .replace("const fault = r.currentPath;", "const fault = 'expired';");
    let bundle = scratch.path().join("fake.cjs");
    fs::write(&bundle, &script).unwrap();
    let mut manifest = identity;
    manifest["bundleSha256"] = crate::hex_sha256(script.as_bytes()).into();
    manifest["sources"] = serde_json::json!([]);
    let manifest_path = scratch.path().join("manifest.json");
    fs::write(&manifest_path, manifest.to_string()).unwrap();
    let resolver = ReaderResolver::new(Arc::new(Reader::new(Some(dohc_engine_reader::Config {
        node,
        bundle,
        manifest: manifest_path,
    }))));
    let (conn, key, doc, _, _) = fixture();
    // Force prove, rather than metadata-only construction, to exercise Expired.
    use yrs::{updates::decoder::Decode, Map, ReadTxn, Transact};
    let raw = yrs::Doc::new();
    raw.transact_mut()
        .apply_update(yrs::Update::decode_v1(&doc.encode_full_state()).unwrap())
        .unwrap();
    let before = raw.transact().state_vector();
    raw.get_or_insert_map("meta").insert(
        &mut raw.transact_mut(),
        "dohcMarkdownSourceProjectionSha256",
        "0".repeat(64),
    );
    doc.apply(&raw.transact().encode_state_as_update_v1(&before))
        .unwrap();
    let proof = pending(lookup(&conn, &key, &doc, &resolver));
    run(proof.resolve());
    assert!(
        matches!(proof.result.get(), Some(Err(Failure::Unavailable))),
        "{:?}",
        proof.result.get()
    );
    drop(proof);
    // An invalid proof is not retried after a backoff.
    for _ in 0..2 {
        assert!(matches!(
            lookup(&conn, &key, &doc, &resolver),
            Err(CollabError::MarkdownReaderUnavailable)
        ));
    }
}
fn lookup(
    conn: &Connection,
    key: &DocKey,
    doc: &Ydoc,
    resolver: &ReaderResolver,
) -> Result<Option<String>, CollabError> {
    resolve(
        conn,
        key,
        doc,
        &doc.project(ContentKind::Richdoc)?.content,
        Some(resolver),
    )
}
fn pending(result: Result<Option<String>, CollabError>) -> Arc<PendingProof> {
    match result {
        Err(CollabError::MarkdownReaderPending(p)) => p,
        other => panic!("{other:?}"),
    }
}

pub(crate) fn evict_with_other_snapshot_misses(resolver: &ReaderResolver) {
    let (conn, key, doc, _, _) = fixture();
    for index in 0..MAX_ENTRIES {
        conn.execute(
            "UPDATE snapshots SET latest_moment_id=?1",
            [format!("other-workspace-{index}")],
        )
        .unwrap();
        assert!(matches!(
            lookup(&conn, &key, &doc, resolver),
            Err(CollabError::MarkdownReaderPending(_))
        ));
    }
    assert_eq!(resolver.entries.lock().unwrap().len(), MAX_ENTRIES);
}
fn prime(conn: &Connection, key: &DocKey, doc: &Ydoc, resolver: &ReaderResolver) {
    // This cache test supplies the receipt; the real-reader test below obtains it from the child.
    pending(lookup(conn, key, doc, resolver))
        .result
        .set(Ok(true))
        .unwrap();
}

#[test]
fn exact_output_needs_a_snapshot_and_never_anchors_itself() {
    let (conn, key, doc, _, resolver) = fixture();
    conn.execute("DELETE FROM snapshots", []).unwrap();
    assert!(matches!(
        lookup(&conn, &key, &doc, &resolver),
        Err(CollabError::MarkdownReaderUnavailable)
    ));
    assert!(resolver.entries.lock().unwrap().is_empty());
}

#[test]
fn partial_witnesses_hold_before_dispatch() {
    use yrs::{updates::decoder::Decode, Map, ReadTxn, Transact};
    for field in [
        "dohcMarkdownSource",
        "dohcMarkdownSourceSha256",
        "dohcMarkdownSourceProjectionSha256",
    ] {
        let (conn, key, doc, _, resolver) = fixture();
        let scratch = yrs::Doc::new();
        scratch
            .transact_mut()
            .apply_update(yrs::Update::decode_v1(&doc.encode_full_state()).unwrap())
            .unwrap();
        scratch
            .get_or_insert_map("meta")
            .remove(&mut scratch.transact_mut(), field);
        let partial = Ydoc::wire();
        partial
            .apply(
                &scratch
                    .transact()
                    .encode_state_as_update_v1(&yrs::StateVector::default()),
            )
            .unwrap();
        assert!(matches!(
            lookup(&conn, &key, &partial, &resolver),
            Err(CollabError::MarkdownReaderUnavailable)
        ));
        assert!(resolver.entries.lock().unwrap().is_empty());
    }
}
#[test]
fn snapshot_digest_and_length_are_checked_before_dispatch() {
    for sql in [
        "UPDATE blobs SET text='forged'",
        "UPDATE blobs SET byte_length=0",
        "UPDATE snapshots SET blob_sha256='forged'",
    ] {
        let (conn, key, doc, _, resolver) = fixture();
        conn.execute(sql, []).unwrap();
        assert!(
            matches!(
                lookup(&conn, &key, &doc, &resolver),
                Err(CollabError::MarkdownReaderUnavailable)
            ),
            "{sql}"
        );
        assert!(resolver.entries.lock().unwrap().is_empty());
    }
}
#[test]
fn expired_source_continuation_requires_the_current_settlement_digest() {
    let (conn, key, doc, _, resolver) = fixture();
    let canonical = doc.project(ContentKind::Richdoc).unwrap().content;
    let sha = crate::hex_sha256(canonical.as_bytes());
    conn.execute(
        "UPDATE blobs SET sha256=?1,text=?2,byte_length=?3",
        params![sha, canonical, canonical.len() as i64],
    )
    .unwrap();
    conn.execute("UPDATE snapshots SET blob_sha256=?1", [&sha])
        .unwrap();
    assert!(matches!(
        lookup(&conn, &key, &doc, &resolver),
        Err(CollabError::MarkdownReaderUnavailable)
    ));
    assert!(resolver.entries.lock().unwrap().is_empty());
    conn.execute("UPDATE ydoc_docs SET last_settled_sha=?1", [&sha])
        .unwrap();
    pending(lookup(&conn, &key, &doc, &resolver))
        .result
        .set(Ok(false))
        .unwrap();
    assert_eq!(lookup(&conn, &key, &doc, &resolver).unwrap(), None);
    doc.richdoc_append_paragraph("A later edit");
    pending(lookup(&conn, &key, &doc, &resolver))
        .result
        .set(Ok(false))
        .unwrap();
    assert_eq!(lookup(&conn, &key, &doc, &resolver).unwrap(), None);
    conn.execute("UPDATE ydoc_docs SET last_settled_sha=NULL", [])
        .unwrap();
    assert!(matches!(
        lookup(&conn, &key, &doc, &resolver),
        Err(CollabError::MarkdownReaderUnavailable)
    ));
}
#[test]
fn cache_hit_rechecks_snapshot_claim_path_and_restore_fences() {
    for sql in [
        "DELETE FROM snapshots",
        "UPDATE snapshots SET path='other.md'",
        "UPDATE ydoc_docs SET lineage_claim_id='new-claim'",
        "UPDATE ydoc_docs SET lineage_epoch_tag='other-epoch'",
        "UPDATE snapshots SET latest_moment_id='new-moment'",
        "INSERT INTO live_restore_fences VALUES('w','main','fixture',1,'{}',NULL,'relay','l','restore','{}','{}')",
        "INSERT INTO live_restore_fences VALUES('w','main','fixture',1,NULL,NULL,'relay','l','restore','{}','{}')",
        "INSERT INTO live_restore_fences VALUES('w','main','fixture',1,NULL,'{}','relay','l','restore','{}','{}')",
    ] {
        let (conn, key, doc, source, resolver) = fixture();
        prime(&conn, &key, &doc, &resolver);
        assert_eq!(lookup(&conn, &key, &doc, &resolver).unwrap(), Some(source));
        conn.execute(sql, []).unwrap();
        assert!(lookup(&conn, &key, &doc, &resolver).is_err(), "{sql}");
    }
}
#[test]
fn checkpoint_changes_and_foreign_objects_cannot_reuse_a_proof() {
    let (conn, key, doc, _, resolver) = fixture();
    prime(&conn, &key, &doc, &resolver);
    doc.frontmatter_set("title", "changed").unwrap();
    pending(lookup(&conn, &key, &doc, &resolver));
    let foreign = DocKey::new("foreign", "main", "fixture").unwrap();
    assert!(lookup(&conn, &foreign, &doc, &resolver).is_err());
}

#[test]
fn reloading_maps_keeps_the_proof_but_changed_attributes_at_the_same_clocks_do_not() {
    let (conn, key, doc, source, resolver) = fixture();
    prime(&conn, &key, &doc, &resolver);
    let checkpoint = doc.encode_full_state();
    for _ in 0..32 {
        let reloaded = Ydoc::wire();
        reloaded.apply(&checkpoint).unwrap();
        assert_eq!(
            lookup(&conn, &key, &reloaded, &resolver).unwrap(),
            Some(source.clone())
        );
    }
    let mut forged = checkpoint;
    let needle = b"\"href\":\"https://example.com\"";
    let offset = forged
        .windows(needle.len())
        .position(|bytes| bytes == needle)
        .unwrap();
    forged[offset + needle.len() - 4..offset + needle.len() - 1].copy_from_slice(b"net");
    let changed = Ydoc::wire();
    changed.apply(&forged).unwrap();
    assert_eq!(changed.encode_state_vector(), doc.encode_state_vector());
    pending(lookup(&conn, &key, &changed, &resolver));
}
#[test]
fn pending_entries_are_bounded_and_restart_has_no_proofs() {
    let (conn, key, doc, _, resolver) = fixture();
    let mut held = Vec::new();
    for index in 0..MAX_ENTRIES {
        conn.execute(
            "UPDATE snapshots SET latest_moment_id=?1",
            [index.to_string()],
        )
        .unwrap();
        held.push(pending(lookup(&conn, &key, &doc, &resolver)));
    }
    conn.execute("UPDATE snapshots SET latest_moment_id='overflow'", [])
        .unwrap();
    assert!(matches!(
        lookup(&conn, &key, &doc, &resolver),
        Err(CollabError::MarkdownReaderUnavailable)
    ));
    assert_eq!(resolver.entries.lock().unwrap().len(), MAX_ENTRIES);
    for proof in &held {
        proof.result.set(Ok(true)).unwrap();
    }
    assert!(matches!(
        lookup(&conn, &key, &doc, &resolver),
        Err(CollabError::MarkdownReaderUnavailable)
    ));
    drop(held);
    pending(lookup(&conn, &key, &doc, &resolver));
    let restarted = ReaderResolver::new(Arc::new(Reader::new(None)));
    pending(lookup(&conn, &key, &doc, &restarted));
}

const TRANSIENT: [Failure; 4] = [
    Failure::Crashed,
    Failure::TimedOut,
    Failure::Overloaded,
    Failure::Superseded,
];

fn fail_next_request(
    conn: &Connection,
    key: &DocKey,
    doc: &Ydoc,
    resolver: &ReaderResolver,
    failure: Failure,
) {
    pending(lookup(conn, key, doc, resolver))
        .result
        .set(Err(failure))
        .unwrap();
}

#[test]
fn exhausted_transient_proof_remains_retryable() {
    for failure in TRANSIENT {
        let (conn, key, doc, source, resolver) = fixture();
        // The first request and its immediate retry both fail.
        fail_next_request(&conn, &key, &doc, &resolver, failure);
        fail_next_request(&conn, &key, &doc, &resolver, failure);
        assert!(
            matches!(
                lookup(&conn, &key, &doc, &resolver),
                Err(CollabError::MarkdownReaderRetryable)
            ),
            "{failure:?}"
        );
        // The reader recovers before the caller's backoff ends. Nothing about
        // the note changed, and the retry still proves it.
        pending(lookup(&conn, &key, &doc, &resolver))
            .result
            .set(Ok(true))
            .unwrap();
        assert_eq!(
            lookup(&conn, &key, &doc, &resolver).unwrap(),
            Some(source),
            "{failure:?}"
        );
    }
}

#[test]
fn transient_retries_are_bounded_then_allow_a_later_action() {
    for failure in TRANSIENT {
        let (conn, key, doc, _, resolver) = fixture();
        let (mut requests, mut backoffs, mut ended) = (0, 0, false);
        for _ in 0..4 * usize::from(MAX_TRANSIENT_RETRIES) {
            match lookup(&conn, &key, &doc, &resolver) {
                Err(CollabError::MarkdownReaderPending(proof)) => {
                    requests += 1;
                    proof.result.set(Err(failure)).unwrap();
                }
                Err(CollabError::MarkdownReaderRetryable) => backoffs += 1,
                Err(CollabError::MarkdownReaderUnavailable) => {
                    ended = true;
                    break;
                }
                other => panic!("{failure:?}: {other:?}"),
            }
        }
        assert!(ended, "{failure:?} kept retrying");
        assert_eq!(
            requests,
            usize::from(MAX_TRANSIENT_RETRIES) + 1,
            "{failure:?}"
        );
        // The first retry is immediate; every later one waited for a backoff.
        assert_eq!(
            backoffs,
            usize::from(MAX_TRANSIENT_RETRIES) - 1,
            "{failure:?}"
        );
        assert!(resolver.entries.lock().unwrap().is_empty());
        // Try again, or the next edit, starts a new count.
        pending(lookup(&conn, &key, &doc, &resolver));
    }
}

#[test]
fn transient_retries_stay_bounded_when_proofs_evict_each_other() {
    // One more failing proof than the cache holds, asked for in turn, so each
    // lookup evicts the proof asked for next.
    let (conn, key, doc, _, resolver) = fixture();
    let mut requests = [0; MAX_ENTRIES + 1];
    let mut backoffs = [0; MAX_ENTRIES + 1];
    let mut ended = [false; MAX_ENTRIES + 1];
    for _ in 0..8 * usize::from(MAX_TRANSIENT_RETRIES) {
        for index in 0..=MAX_ENTRIES {
            if ended[index] {
                continue;
            }
            conn.execute(
                "UPDATE snapshots SET latest_moment_id=?1",
                [index.to_string()],
            )
            .unwrap();
            match lookup(&conn, &key, &doc, &resolver) {
                Err(CollabError::MarkdownReaderPending(proof)) => {
                    requests[index] += 1;
                    proof.result.set(Err(Failure::Crashed)).unwrap();
                }
                Err(CollabError::MarkdownReaderRetryable) => backoffs[index] += 1,
                Err(CollabError::MarkdownReaderUnavailable) => ended[index] = true,
                other => panic!("proof {index}: {other:?}"),
            }
        }
    }
    assert_eq!(ended, [true; MAX_ENTRIES + 1], "a proof kept retrying");
    // The same requests and backoffs as a proof that stays in the cache.
    assert_eq!(
        requests,
        [usize::from(MAX_TRANSIENT_RETRIES) + 1; MAX_ENTRIES + 1]
    );
    assert_eq!(
        backoffs,
        [usize::from(MAX_TRANSIENT_RETRIES) - 1; MAX_ENTRIES + 1]
    );
    assert!(resolver.entries.lock().unwrap().is_empty());
    assert!(resolver.saved_retries.lock().unwrap().is_empty());
}

/// A terminal failure ends the proof at once, whether it is the first answer
/// or comes after a backoff, and the cached failure answers every later lookup
/// without asking the reader again.
fn assert_terminal(failure: Failure) {
    for after_backoff in [false, true] {
        let (conn, key, doc, _, resolver) = fixture();
        if after_backoff {
            fail_next_request(&conn, &key, &doc, &resolver, Failure::Crashed);
            fail_next_request(&conn, &key, &doc, &resolver, Failure::Crashed);
            assert!(matches!(
                lookup(&conn, &key, &doc, &resolver),
                Err(CollabError::MarkdownReaderRetryable)
            ));
        }
        fail_next_request(&conn, &key, &doc, &resolver, failure);
        let failed = Arc::as_ptr(&resolver.entries.lock().unwrap()[0].pending);
        for _ in 0..3 {
            assert!(
                matches!(
                    lookup(&conn, &key, &doc, &resolver),
                    Err(CollabError::MarkdownReaderUnavailable)
                ),
                "{failure:?} after_backoff={after_backoff}"
            );
            let entries = resolver.entries.lock().unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(Arc::as_ptr(&entries[0].pending), failed);
            assert!(
                matches!(entries[0].pending.result.get(), Some(Err(cached)) if *cached == failure)
            );
        }
    }
}

// A reader asset that changed after it was checked: process.rs `check_assets`,
// the hash cap in `file_sha`, and a runtime or bundle digest that no longer
// matches. The reader answers Unavailable and closes
// (`post_hello_asset_replacement_is_unavailable`,
// `replacement_after_hash_is_blocked_or_refused_before_spawn`,
// `identity_mismatch_stays_unavailable_without_rehashing`).
#[test]
fn changed_reader_assets_stay_terminal() {
    assert_terminal(Failure::Unavailable);
}

// `platform::open_asset` refuses an asset another user can write or a linked
// ancestor; `Worker::start` answers Unavailable
// (`writable_ancestor_is_refused_even_with_a_protected_generation`,
// `closure_rejects_untrusted_writers_before_spawn`).
#[test]
fn reader_permission_refusals_stay_terminal() {
    assert_terminal(Failure::Unavailable);
}

// A deleted runtime, bundle or manifest fails `open_asset` at start or in
// `check_assets`; the reader answers Unavailable
// (`closure_rejects_directory_and_missing_assets_before_spawn`, and the
// "runtime", "bundle" and "manifest" cases of
// `invalid_configuration_or_identity_is_unavailable`).
#[test]
fn deleted_reader_files_stay_terminal() {
    assert_terminal(Failure::Unavailable);
}

// An answer that does not prove these exact inputs becomes Unavailable in
// `PendingProof::resolve`; `expired_proofs_must_match_the_engine_projection`
// drives it through a real reader.
#[test]
fn invalid_proofs_stay_terminal() {
    assert_terminal(Failure::Unavailable);
}

#[test]
fn oversized_reader_requests_stay_terminal() {
    assert_terminal(Failure::TooLarge);
}

// A retry proves the note's current state, never the one that failed. A note
// whose file or lineage no longer matches is refused before any request, and
// an edit is a new proof with its own count. Superseded only ever names the
// older of two requests, so it stays transient.
#[test]
fn stale_targets_stay_terminal_after_a_backoff() {
    for sql in [
        "DELETE FROM snapshots",
        "UPDATE snapshots SET path='other.md'",
        "UPDATE ydoc_docs SET lineage_epoch_tag='other-epoch'",
        "UPDATE blobs SET text='forged'",
    ] {
        let (conn, key, doc, _, resolver) = fixture();
        fail_next_request(&conn, &key, &doc, &resolver, Failure::Crashed);
        fail_next_request(&conn, &key, &doc, &resolver, Failure::Crashed);
        assert!(matches!(
            lookup(&conn, &key, &doc, &resolver),
            Err(CollabError::MarkdownReaderRetryable)
        ));
        conn.execute(sql, []).unwrap();
        for _ in 0..2 {
            assert!(
                matches!(
                    lookup(&conn, &key, &doc, &resolver),
                    Err(CollabError::MarkdownReaderUnavailable)
                ),
                "{sql}"
            );
        }
    }
    let (conn, key, doc, _, resolver) = fixture();
    fail_next_request(&conn, &key, &doc, &resolver, Failure::Superseded);
    fail_next_request(&conn, &key, &doc, &resolver, Failure::Superseded);
    assert!(matches!(
        lookup(&conn, &key, &doc, &resolver),
        Err(CollabError::MarkdownReaderRetryable)
    ));
    doc.richdoc_append_paragraph("A later edit");
    let edited = pending(lookup(&conn, &key, &doc, &resolver));
    let entries = resolver.entries.lock().unwrap();
    let current = entries
        .iter()
        .find(|entry| Arc::ptr_eq(&entry.pending, &edited))
        .unwrap();
    assert_eq!(current.retries, 0);
}

#[test]
fn externally_held_failed_proofs_stay_in_the_cache_budget() {
    let (conn, key, doc, _, resolver) = fixture();
    let first = pending(lookup(&conn, &key, &doc, &resolver));
    first.result.set(Err(Failure::Crashed)).unwrap();
    for _ in 0..MAX_ENTRIES * 2 {
        assert!(matches!(
            lookup(&conn, &key, &doc, &resolver),
            Err(CollabError::MarkdownReaderUnavailable)
        ));
        let entries = resolver.entries.lock().unwrap();
        assert_eq!(entries.len(), 1);
        assert!(Arc::ptr_eq(&entries[0].pending, &first));
    }
    drop(first);
    pending(lookup(&conn, &key, &doc, &resolver));
}

#[test]
fn native_stale_witnesses_keep_the_existing_canonical_path() {
    let native = Ydoc::wire();
    native
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "Original paragraph\n")
        .unwrap();
    native.richdoc_append_paragraph("Edit");
    assert!(!native.has_reader_source());
}

#[test]
fn dispatch_drops_the_request_even_while_the_verdict_is_retained() {
    let (conn, key, doc, _, resolver) = fixture();
    let proof = pending(lookup(&conn, &key, &doc, &resolver));
    assert!(proof.request.lock().unwrap().is_some());
    run(proof.resolve());
    assert!(proof.request.lock().unwrap().is_none());
    assert!(matches!(
        proof.result.get(),
        Some(Err(Failure::Unavailable))
    ));
    assert_eq!(resolver.entries.lock().unwrap().len(), 1);
}

pub(crate) fn run(future: impl std::future::Future<Output = ()>) {
    struct Wake(std::thread::Thread);
    impl std::task::Wake for Wake {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = std::task::Waker::from(Arc::new(Wake(std::thread::current())));
    let mut context = std::task::Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    while future.as_mut().poll(&mut context).is_pending() {
        std::thread::park();
    }
}

#[test]
#[ignore = "the Rust gate's reader phase runs it with DOHC_ENGINE_READER_CONFIG"]
fn real_reader_checks_the_current_witness_and_holds_without_a_runtime() {
    let config =
        serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
    let (conn, key, doc, source, _) = fixture();
    let resolver = ReaderResolver::new(Arc::new(Reader::new(Some(config))));
    run(pending(lookup(&conn, &key, &doc, &resolver)).resolve());
    assert_eq!(
        lookup(&conn, &key, &doc, &resolver).unwrap(),
        Some(source.clone())
    );
    let data: Value = serde_json::from_str(include_str!("../tests/reader-resolver.json")).unwrap();
    let stale = Ydoc::wire();
    stale
        .apply(&STANDARD.decode(data["stale"].as_str().unwrap()).unwrap())
        .unwrap();
    run(pending(lookup(&conn, &key, &stale, &resolver)).resolve());
    assert!(matches!(
        lookup(&conn, &key, &stale, &resolver),
        Err(CollabError::MarkdownReaderUnavailable)
    ));
    let canonical = data["canonicalSource"].as_str().unwrap();
    let sha = crate::hex_sha256(canonical.as_bytes());
    conn.execute(
        "UPDATE blobs SET sha256=?1,text=?2,byte_length=?3",
        params![sha, canonical, canonical.len() as i64],
    )
    .unwrap();
    conn.execute("UPDATE snapshots SET blob_sha256=?1", [&sha])
        .unwrap();
    let stale = Ydoc::wire();
    stale
        .apply(
            &STANDARD
                .decode(data["canonicalStale"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
    run(pending(lookup(&conn, &key, &stale, &resolver)).resolve());
    assert!(matches!(
        lookup(&conn, &key, &stale, &resolver),
        Err(CollabError::MarkdownReaderUnavailable)
    ));
    let sha = crate::hex_sha256(source.as_bytes());
    conn.execute(
        "UPDATE blobs SET sha256=?1,text=?2,byte_length=?3",
        params![sha, source, source.len() as i64],
    )
    .unwrap();
    conn.execute("UPDATE snapshots SET blob_sha256=?1", [&sha])
        .unwrap();
    let absent = ReaderResolver::new(Arc::new(Reader::new(None)));
    run(pending(lookup(&conn, &key, &doc, &absent)).resolve());
    assert!(matches!(
        lookup(&conn, &key, &doc, &absent),
        Err(CollabError::MarkdownReaderUnavailable)
    ));
    doc.richdoc_append_paragraph("A body edit expires the retained source");
    run(pending(lookup(&conn, &key, &doc, &resolver)).resolve());
    assert_eq!(lookup(&conn, &key, &doc, &resolver).unwrap(), None);
    let canonical = doc.project(ContentKind::Richdoc).unwrap().content;
    let sha = crate::hex_sha256(canonical.as_bytes());
    conn.execute(
        "UPDATE blobs SET sha256=?1,text=?2,byte_length=?3",
        params![sha, canonical, canonical.len() as i64],
    )
    .unwrap();
    conn.execute("UPDATE snapshots SET blob_sha256=?1", [&sha])
        .unwrap();
    conn.execute("UPDATE ydoc_docs SET last_settled_sha=?1", [&sha])
        .unwrap();
    run(pending(lookup(&conn, &key, &doc, &resolver)).resolve());
    assert_eq!(lookup(&conn, &key, &doc, &resolver).unwrap(), None);
    doc.richdoc_append_paragraph("A second edit after canonical settlement");
    run(pending(lookup(&conn, &key, &doc, &resolver)).resolve());
    assert_eq!(lookup(&conn, &key, &doc, &resolver).unwrap(), None);
    let unavailable = ReaderResolver::new(Arc::new(Reader::new(None)));
    run(pending(lookup(&conn, &key, &doc, &unavailable)).resolve());
    assert!(matches!(
        lookup(&conn, &key, &doc, &unavailable),
        Err(CollabError::MarkdownReaderUnavailable)
    ));
}

pub(crate) fn baseline_with_meta(bytes: &[u8], key: &str) -> Vec<u8> {
    use yrs::{updates::decoder::Decode, Map, ReadTxn, StateVector, Transact};
    let raw = yrs::Doc::new();
    raw.transact_mut()
        .apply_update(yrs::Update::decode_v1(bytes).unwrap())
        .unwrap();
    raw.get_or_insert_map("meta")
        .insert(&mut raw.transact_mut(), key, "unexpected");
    let bytes = raw
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    bytes
}

/// An original imported base has no successor epoch. Keep the resolver fixture intact.
pub(crate) fn original_baseline_case(case: &str) -> (Vec<u8>, String) {
    use yrs::{updates::decoder::Decode, Map, ReadTxn, StateVector, Transact};
    let (bytes, source) = witness_case(case);
    let raw = yrs::Doc::new();
    raw.transact_mut()
        .apply_update(yrs::Update::decode_v1(&bytes).unwrap())
        .unwrap();
    raw.get_or_insert_map("meta")
        .remove(&mut raw.transact_mut(), "dohcLineageEpoch");
    let bytes = raw
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    (bytes, source)
}

#[test]
fn reader_baseline_refuses_lineage_epoch() {
    let (bytes, _) = witness_case("valid");
    let bytes = baseline_with_meta(&bytes, "dohcLineageEpoch");
    let doc = Ydoc::wire();
    doc.apply(&bytes).unwrap();
    assert!(matches!(
        doc.validate_reader_baseline(&bytes),
        Err(CollabError::MalformedUpdate { .. })
    ));
}

/// Each caller applies these wire mutations before selecting its own authority.
pub(crate) fn witness_case(case: &str) -> (Vec<u8>, String) {
    use yrs::{updates::decoder::Decode, Map, ReadTxn, StateVector, Transact};
    let data: Value = serde_json::from_str(include_str!("../tests/reader-resolver.json")).unwrap();
    let bytes = STANDARD
        .decode(
            data[if case == "stale" {
                "stale"
            } else {
                "checkpoint"
            }]
            .as_str()
            .unwrap(),
        )
        .unwrap();
    let mut source = data["source"].as_str().unwrap().to_owned();
    let raw = yrs::Doc::new();
    raw.transact_mut()
        .apply_update(yrs::Update::decode_v1(&bytes).unwrap())
        .unwrap();
    let map = raw.get_or_insert_map("meta");
    match case {
        "forged" => {
            source = "- forged body\n".into();
            let mut tx = raw.transact_mut();
            map.insert(&mut tx, "dohcMarkdownSource", source.as_str());
            map.insert(
                &mut tx,
                "dohcMarkdownSourceSha256",
                crate::hex_sha256(source.as_bytes()),
            );
        }
        "partial" => {
            map.remove(&mut raw.transact_mut(), "dohcMarkdownSourceSha256");
        }
        "valid" | "stale" => {}
        _ => panic!("unknown witness case"),
    }
    let bytes = raw
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    (bytes, source)
}
